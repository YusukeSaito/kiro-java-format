'use strict';

// Opening the files of a call ahead of their turn, against the fake language
// server: what the call prints, and which documents the server holds open.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { createIsolatedEnv, listLeftovers, NO_LEFTOVERS } = require('../helpers/env');
const { WT, resolveTestScript, startCli, runCli, normalizeOutput } = require('../helpers/cli');
const { FAKE_EXT, buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');
const lib = require('../../format-java.js');

const script = resolveTestScript();
const LOCK_CHILD = path.join(__dirname, '..', 'helpers', 'lock-child.js');
/** v1.2.0, which opens one file at a time: the reference for what a call prints and writes. */
const RELEASED_COMMIT = '08aa8c3';

/**
 * Write v1.2.0's format-java.js into `dir` and return its path. The basename
 * stays format-java.js: the lock code recognizes the tool's processes by it.
 */
function extractReleasedScript(dir) {
  const file = path.join(dir, 'format-java.js');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, execFileSync('git', ['-C', WT, 'show', `${RELEASED_COMMIT}:format-java.js`]));
  return file;
}

/** Write `contents` (name → text) into `dir` and return the paths, in the order given. */
function writeFiles(dir, contents) {
  fs.mkdirSync(dir, { recursive: true });
  return Object.entries(contents).map(([name, text]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  });
}

/** stderr without the -v lines. */
function removeVerboseLines(stderr) {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('[kjf]'))
    .join('\n');
}

/** A private environment for one test; afterwards nothing of it may be left. */
function setUpEnv(t) {
  const env = createIsolatedEnv();
  t.after(async () => {
    const left = await waitForNoProcessesWithToken(env.dir, 15000);
    killOwnPids(left.map((p) => p.pid));
    const leftovers = listLeftovers(env);
    env.cleanup();
    assert.deepStrictEqual(left, [], 'no process of the run is left');
    assert.deepStrictEqual(leftovers, NO_LEFTOVERS, 'no userdir or lock is left');
  });
  return env;
}

/** The didOpen and didClose lines of the fake server's log, in the order it got them: [{ kind, uri, atMs }]. */
function readDocumentEvents(logFile) {
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.match(/^(open|close) (\S+) (\d+)$/))
    .filter(Boolean)
    .map((m) => ({ kind: m[1], uri: m[2], atMs: Number(m[3]) }));
}

/** The most documents the server held open at the same time. */
function countMaxOpenDocuments(events) {
  let open = 0;
  let max = 0;
  for (const e of events) {
    open += e.kind === 'open' ? 1 : -1;
    max = Math.max(max, open);
  }
  return max;
}

test('a call waits on more than ten files at once, prints nothing more, and keeps the argument order', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  // Node warns once more than 10 listeners wait on one event; each file waiting
  // for its diagnostics adds one.
  const paths = writeJavaFiles(env.dir, 12);
  const r = await runCli(script, paths, {
    cwd: env.dir,
    env: buildFakeEnv(env, { FAKE_DIAGNOSTICS_DELAY_MS: '1000', FAKE_LOG: log }),
    timeoutMs: 60000,
  });
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, paths.map((p) => `unchanged: ${p}\n`).join(''));
  assert.strictEqual(countMaxOpenDocuments(readDocumentEvents(log)), 12, 'all 12 files are open at once');
});

test('no more than OPEN_AHEAD_MAX files are open at once', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  const paths = writeJavaFiles(env.dir, lib.OPEN_AHEAD_MAX + 4);
  const r = await runCli(script, paths, {
    cwd: env.dir,
    env: buildFakeEnv(env, { FAKE_DIAGNOSTICS_DELAY_MS: '500', FAKE_LOG: log }),
    timeoutMs: 60000,
  });
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, paths.map((p) => `unchanged: ${p}\n`).join(''));
  const events = readDocumentEvents(log);
  assert.strictEqual(events.filter((e) => e.kind === 'open').length, paths.length, 'every file is opened once');
  assert.strictEqual(countMaxOpenDocuments(events), lib.OPEN_AHEAD_MAX);
});

/** Wait until `count` file locks exist in the environment's cache. */
async function waitForFileLocks(env, count) {
  const dir = path.join(env.KIRO_JAVA_FORMAT_CACHE, 'locks');
  const deadline = Date.now() + 10000;
  while (!(fs.existsSync(dir) && fs.readdirSync(dir).filter((n) => n.endsWith('.lock')).length >= count)) {
    if (Date.now() > deadline) throw new Error(`no ${count} lock(s) in ${dir}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Hold the lock of `file` for `holdMs` in another process; resolves to
 * `{ enteredAt, leftAt }`. The trailing `format-java.js` argument makes the
 * holder pass for a run of this tool: after LOCK_PID_CHECK_AGE_MS the lock of
 * any other process counts as left over by a recycled pid, and is broken.
 */
function holdFileLock(env, file, holdMs) {
  const child = spawn(process.execPath, [LOCK_CHILD, 'hold-file', file, '0', String(holdMs), 'format-java.js'], {
    env: env.buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err))));
  });
}

test('a file whose lock another run holds is not waited for ahead of its turn', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  const paths = writeJavaFiles(env.dir, 3);
  const held = holdFileLock(env, paths[1], 5000);
  await waitForFileLocks(env, 1);
  const r = await runCli(script, paths, { cwd: env.dir, env: buildFakeEnv(env, { FAKE_LOG: log }), timeoutMs: 60000 });
  const { leftAt } = await held;
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, paths.map((p) => `unchanged: ${p}\n`).join(''));
  const events = readDocumentEvents(log);
  const at = (kind, file) => events.find((e) => e.kind === kind && e.uri === pathToFileURL(file).href).atMs;
  assert.ok(at('close', paths[0]) < leftAt, 'the first file is done while the second one is still held');
  assert.ok(at('open', paths[2]) < leftAt, 'the third file is opened ahead while the second one is still held');
  assert.ok(at('open', paths[1]) >= leftAt, 'the held file is opened at its turn, once the lock is free');
});

test('when the server exits, the files opened ahead are closed and their locks released', async (t) => {
  const env = setUpEnv(t);
  const paths = writeJavaFiles(env.dir, 5);
  // Run in this process, so the locks can be looked at before it exits (on
  // exit every lock is released anyway). The server exits on the first
  // formatting request: the first file's.
  const overrides = {
    KIRO_JAVA_FORMAT_CACHE: env.KIRO_JAVA_FORMAT_CACHE,
    FAKE_NODE: process.execPath,
    FAKE_EXIT_ON: 'textDocument/formatting:1:7',
  };
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const userdir = fs.mkdtempSync(path.join(env.dir, 'kiro-java-format-userdir-'));
  const session = await lib.ServerSession.start({
    nbcodePath: path.join(FAKE_EXT, 'nbcode', 'bin', 'nbcode.sh'),
    jdkHome: null,
    rootDir: env.dir,
    timeoutMs: 20000,
    lease: { kind: 'temporary', userdir, isCacheInUse: false },
  });
  const printed = [];
  t.mock.method(console, 'log', (...args) => printed.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => printed.push(args.join(' ')));
  const started = [];
  const opts = { organizeImports: true, timeoutMs: 20000, tabSize: 4, insertSpaces: true, check: false };
  try {
    await assert.rejects(
      lib.formatSegmentAhead(session, paths, opts, (file) => started.push(file)),
      lib.ServerExitedError
    );
    assert.deepStrictEqual(fs.readdirSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, 'locks')), [], 'no lock is left');
  } finally {
    t.mock.restoreAll();
    await session.close();
  }
  assert.deepStrictEqual(started, [paths[0]]);
  assert.deepStrictEqual(printed, [`error: ${paths[0]}: language server exited (code 7)`]);
});

/**
 * Three calls on the same files, in the order that made two of them wait for
 * each other until --timeout while a call held the locks of the files it had
 * opened ahead: Z holds Q for a second; Y = [S, Q, P] starts meanwhile, and X =
 * [T, P, Q] once Z has let go. Returns Y's and X's results.
 */
async function runThreeOverlappingCalls(env, scriptPath, dir) {
  const [S, T, P, Q] = writeFiles(dir, {
    'S.java': 'class S {}\n',
    'T.java': 'class T {}\n',
    'P.java': 'class P {}\n',
    'Q.java': 'class Q {}\n',
  });
  const fakeEnv = buildFakeEnv(env, { FAKE_DIAGNOSTICS_DELAY_MS: '2000' });
  const held = holdFileLock(env, Q, 1000);
  await waitForFileLocks(env, 1);
  const y = startCli(scriptPath, ['-v', '--timeout', '8', S, Q, P], { cwd: dir, env: fakeEnv, timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  const x = startCli(scriptPath, ['-v', '--timeout', '8', T, P, Q], { cwd: dir, env: fakeEnv, timeoutMs: 60000 });
  const results = await Promise.all([y.done, x.done]);
  await held;
  return results;
}

test('overlapping calls on the same files do not wait for each other until --timeout', async (t) => {
  const env = setUpEnv(t);
  const releasedDir = path.join(env.dir, 'released');
  const released = await runThreeOverlappingCalls(env, extractReleasedScript(path.join(env.dir, 'v120')), releasedDir);
  const currentDir = path.join(env.dir, 'current');
  const current = await runThreeOverlappingCalls(env, script, currentDir);
  ['Y', 'X'].forEach((name, i) => {
    const [want, got] = [released[i], current[i]];
    const label = `${name}: ${got.elapsedMs} ms (v1.2.0 ${want.elapsedMs} ms)`;
    assert.ok(!/lock wait limit reached/.test(got.stderr), `${label}\n${got.stderr}`);
    assert.ok(got.elapsedMs <= want.elapsedMs + 3000, label);
    assert.strictEqual(normalizeOutput(got.stdout, [currentDir]), normalizeOutput(want.stdout, [releasedDir]), label);
    assert.strictEqual(removeVerboseLines(got.stderr), removeVerboseLines(want.stderr), label);
    assert.strictEqual(got.code, want.code, label);
  });
});

/** Wait until the fake server's log says it opened `file`. */
async function waitForOpen(logFile, file) {
  const line = `open ${pathToFileURL(file).href} `;
  const deadline = Date.now() + 20000;
  while (!(fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes(line))) {
    if (Date.now() > deadline) throw new Error(`${file} was not opened`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a file that changes after it was opened ahead is handled as v1.2.0 handles its new content', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  const fake = { FAKE_ERROR_MARKER: 'BROKEN', FAKE_COLLAPSE_SPACES: '1' };
  // F0 does not resolve, so its turn lasts POST_INDEX_SETTLE_MS: time to change
  // F1, which resolved when it was opened ahead, into a file that does not
  // resolve and has formatting to do.
  const before = { 'F0.java': 'class F0 {} // BROKEN\n', 'F1.java': 'class F1 {}\n', 'F2.java': 'class   F2 {}\n' };
  const after = { ...before, 'F1.java': 'class   F1 {} // BROKEN\n' };
  const currentDir = path.join(env.dir, 'current');
  const paths = writeFiles(currentDir, before);
  const run = startCli(script, paths, { cwd: currentDir, env: buildFakeEnv(env, { ...fake, FAKE_LOG: log }) });
  await waitForOpen(log, paths[1]);
  fs.writeFileSync(paths[1], after['F1.java']);
  const changedAtMs = Date.now();
  const got = await run.done;

  const releasedDir = path.join(env.dir, 'released');
  const releasedPaths = writeFiles(releasedDir, after);
  const releasedScript = extractReleasedScript(path.join(env.dir, 'v120'));
  const want = await runCli(releasedScript, releasedPaths, { cwd: releasedDir, env: buildFakeEnv(env, fake) });

  const events = readDocumentEvents(log);
  const f0Closed = events.find((e) => e.kind === 'close' && e.uri === pathToFileURL(paths[0]).href);
  assert.ok(f0Closed.atMs > changedAtMs, 'F1 changed before its turn');
  const f1Opens = events.filter((e) => e.kind === 'open' && e.uri === pathToFileURL(paths[1]).href);
  assert.strictEqual(f1Opens.length, 1, 'F1 is opened once');
  assert.strictEqual(normalizeOutput(got.stdout, [currentDir]), normalizeOutput(want.stdout, [releasedDir]));
  assert.strictEqual(normalizeOutput(got.stderr, [currentDir]), normalizeOutput(want.stderr, [releasedDir]));
  assert.strictEqual(got.code, want.code);
  for (const name of Object.keys(after)) {
    const content = fs.readFileSync(path.join(currentDir, name), 'utf8');
    assert.strictEqual(content, fs.readFileSync(path.join(releasedDir, name), 'utf8'), name);
  }
});
