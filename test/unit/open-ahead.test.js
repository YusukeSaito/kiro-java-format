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

/** The `lock` lines of the fake server's log: for each didOpen, whether the call held the file's lock. */
function readLockStates(logFile) {
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.match(/^lock (\S+) (\S+)$/))
    .filter(Boolean)
    .map((m) => ({ uri: m[1], state: m[2] }));
}

/** Assert that every document in the fake server's log was opened while its call held the file's lock. */
function assertOpenedUnderLock(logFile) {
  const states = readLockStates(logFile);
  const opens = readDocumentEvents(logFile).filter((e) => e.kind === 'open');
  assert.strictEqual(states.length, opens.length, 'every didOpen is checked');
  assert.deepStrictEqual(
    states.filter((s) => s.state !== 'held'),
    [],
    'every document is opened while its lock is held'
  );
}

test('a file whose lock another run holds stops the window, and is waited for at its turn', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  const paths = writeJavaFiles(env.dir, 3);
  const holdMs = 5000;
  const held = holdFileLock(env, paths[1], holdMs);
  await waitForFileLocks(env, 1);
  const r = await runCli(script, paths, { cwd: env.dir, env: buildFakeEnv(env, { FAKE_LOG: log }), timeoutMs: 60000 });
  // The holder lets go no earlier than this.
  const heldUntilMs = (await held).enteredAt + holdMs;
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, paths.map((p) => `unchanged: ${p}\n`).join(''));
  const events = readDocumentEvents(log);
  const at = (kind, file) => events.find((e) => e.kind === kind && e.uri === pathToFileURL(file).href).atMs;
  assert.ok(at('close', paths[0]) < heldUntilMs, 'the first file is done while the second one is held');
  assert.ok(at('open', paths[1]) >= heldUntilMs, 'the held file is opened once its lock is free');
  assert.ok(at('open', paths[2]) >= at('open', paths[1]), 'the file after the held one is not opened before it');
  assertOpenedUnderLock(log);
});

// Past --timeout the wait for a lock gives up and the file is formatted
// without it, as v1.2.0 does: only a file opened at its turn can be open
// without its lock.
test('a file whose lock another run holds past --timeout is formatted without it at its turn', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  const paths = writeJavaFiles(env.dir, 3);
  const timeoutMs = 2000;
  const holdMs = 8000;
  const held = holdFileLock(env, paths[1], holdMs);
  await waitForFileLocks(env, 1);
  const r = await runCli(script, ['--timeout', String(timeoutMs / 1000), ...paths], {
    cwd: env.dir,
    env: buildFakeEnv(env, { FAKE_LOG: log }),
    timeoutMs: 60000,
  });
  const heldUntilMs = (await held).enteredAt + holdMs;
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, paths.map((p) => `unchanged: ${p}\n`).join(''));
  const events = readDocumentEvents(log);
  const at = (kind, file) => events.find((e) => e.kind === kind && e.uri === pathToFileURL(file).href).atMs;
  const waitedMs = at('open', paths[1]) - at('close', paths[0]);
  assert.ok(waitedMs >= timeoutMs / 2, `the held file is waited for at its turn (${waitedMs} ms)`);
  assert.ok(at('open', paths[1]) < heldUntilMs, 'the held file is opened before its lock is free');
  assert.deepStrictEqual(
    readLockStates(log).map((s) => s.state),
    ['held', 'other', 'held'],
    'only the held file is opened without its lock'
  );
  const locksDir = path.join(env.KIRO_JAVA_FORMAT_CACHE, 'locks');
  assert.deepStrictEqual(fs.readdirSync(locksDir), [], 'no lock is left');
});

// v1.2.0 opens a file at its turn, so its wait limit for whether the file
// resolves counts from the turn. Here indexing outlasts the limit
// (--timeout 3), and the files have errors until it ends: F0, whose turn comes
// first, reaches the limit with errors, and its imports are skipped; F1's turn
// comes when F0's limit runs out, and indexing ends within F1's own limit, so
// it resolves; F2 and F3 resolve once indexing ends. Opened ahead with F0,
// they must not spend their limits before their turns.
test('a file opened ahead counts its wait limit from its turn, as v1.2.0 does from the open', async (t) => {
  const env = setUpEnv(t);
  const contents = {};
  for (let i = 0; i < 4; i++) contents[`F${i}.java`] = `class F${i} {} // NEEDS_INDEX\n`;
  const paths = writeFiles(env.dir, contents);
  const fake = { FAKE_INDEXING_MS: '4500', FAKE_ERROR_WHILE_INDEXING: 'NEEDS_INDEX' };
  const r = await runCli(script, ['--timeout', '3', ...paths], {
    cwd: env.dir,
    env: buildFakeEnv(env, fake),
    timeoutMs: 60000,
  });
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(
    r.stdout,
    `imports skipped (file does not resolve): ${paths[0]}\n${paths.map((p) => `unchanged: ${p}\n`).join('')}`
  );
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
    t.diagnostic(label);
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

// A writer that does not take the lock (an editor, say) can change a file
// while it is open, as in v1.2.0; the window only makes that time longer. The
// write of the formatted text is then refused, and the file keeps their text.
test('a file written by someone else after it was opened ahead is left as they wrote it', async (t) => {
  const env = setUpEnv(t);
  const log = path.join(env.dir, 'fake.log');
  // F0 does not resolve, so its turn lasts POST_INDEX_SETTLE_MS: time to
  // change F1, opened ahead, before its turn.
  const paths = writeFiles(env.dir, {
    'F0.java': 'class F0 {} // BROKEN\n',
    'F1.java': 'class   F1 {}\n',
    'F2.java': 'class F2 {}\n',
  });
  const fake = { FAKE_ERROR_MARKER: 'BROKEN', FAKE_COLLAPSE_SPACES: '1', FAKE_LOG: log };
  const run = startCli(script, paths, { cwd: env.dir, env: buildFakeEnv(env, fake) });
  await waitForOpen(log, paths[1]);
  const outside = 'class F1 {} // written outside\n';
  fs.writeFileSync(paths[1], outside);
  const changedAtMs = Date.now();
  const r = await run.done;
  const f0Closed = readDocumentEvents(log).find((e) => e.kind === 'close' && e.uri === pathToFileURL(paths[0]).href);
  assert.ok(f0Closed.atMs > changedAtMs, 'F1 changed before its turn');
  assert.strictEqual(
    r.stdout,
    `imports skipped (file does not resolve): ${paths[0]}\nunchanged: ${paths[0]}\nunchanged: ${paths[2]}\n`
  );
  assert.strictEqual(r.stderr, `error: ${paths[1]}: changed on disk while formatting; not written\n`);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(fs.readFileSync(paths[1], 'utf8'), outside);
});

/** Run one call over `paths`, with the fake server collapsing runs of spaces when it formats. */
function runOnPaths(env, paths) {
  return runCli(script, paths, { cwd: env.dir, env: buildFakeEnv(env, { FAKE_COLLAPSE_SPACES: '1' }), timeoutMs: 60000 });
}

test('a file given again under a hard link is read after the first path is written, as in v1.2.0', async (t) => {
  const env = setUpEnv(t);
  const [first] = writeFiles(env.dir, { 'H1.java': 'class   H {}\n' });
  const second = path.join(env.dir, 'H2.java');
  fs.linkSync(first, second);
  const r = await runOnPaths(env, [first, second]);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout, `formatted: ${first}\nunchanged: ${second}\n`);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'class H {}\n');
});

test('a file given again in another letter case is read after the first path is written, as in v1.2.0', async (t) => {
  const env = setUpEnv(t);
  const [first] = writeFiles(env.dir, { 'Cv.java': 'class   Cv {}\n' });
  const second = path.join(env.dir, 'CV.java');
  if (!fs.existsSync(second)) {
    t.skip('this file system tells letter case apart');
    return;
  }
  const r = await runOnPaths(env, [first, second]);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout, `formatted: ${first}\nunchanged: ${second}\n`);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'class Cv {}\n');
});

test('a call waits for a file that another call opened ahead about as long as that call takes for its window', async (t) => {
  const env = setUpEnv(t);
  const formattingMs = 200;
  const fake = { FAKE_COLLAPSE_SPACES: '1', FAKE_FORMATTING_DELAY_MS: String(formattingMs) };
  const contents = {};
  for (let i = 0; i < 40; i++) contents[`F${i}.java`] = `class   F${i} {}\n`;
  const paths = writeFiles(env.dir, contents);
  const target = paths[20];
  const logA = path.join(env.dir, 'a.log');
  const logB = path.join(env.dir, 'b.log');
  const a = startCli(script, paths, { cwd: env.dir, env: buildFakeEnv(env, { ...fake, FAKE_LOG: logA }) });
  // A opens the target ahead of its turn, and holds its lock from then on.
  await waitForOpen(logA, target);
  const bStartedAtMs = Date.now();
  const b = startCli(script, ['--timeout', '30', target], {
    cwd: env.dir,
    env: buildFakeEnv(env, { ...fake, FAKE_LOG: logB }),
  });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.strictEqual(ra.stderr, '');
  assert.strictEqual(ra.code, 0);
  assert.strictEqual(ra.stdout, paths.map((p) => `formatted: ${p}\n`).join(''));
  assert.strictEqual(rb.stderr, '');
  assert.strictEqual(rb.code, 0);
  assert.strictEqual(rb.stdout, `unchanged: ${target}\n`);
  const at = (logFile, kind) =>
    readDocumentEvents(logFile).find((e) => e.kind === kind && e.uri === pathToFileURL(target).href).atMs;
  assert.ok(at(logB, 'open') >= at(logA, 'close'), 'B opens the target once A is done with it');
  const waitedMs = at(logB, 'open') - bStartedAtMs;
  const boundMs = (lib.OPEN_AHEAD_MAX + 1) * formattingMs + 3000;
  t.diagnostic(`B opened the target ${waitedMs} ms after it started (bound ${boundMs} ms)`);
  assert.ok(waitedMs <= boundMs, `B waited ${waitedMs} ms`);
  assertOpenedUnderLock(logA);
  assertOpenedUnderLock(logB);
});

test('two calls over the same files in opposite orders open every document under its lock', async (t) => {
  const env = setUpEnv(t);
  const contents = {};
  for (let i = 0; i < 20; i++) contents[`F${i}.java`] = `class   F${i} {}\n`;
  const paths = writeFiles(env.dir, contents);
  const logs = [path.join(env.dir, 'x.log'), path.join(env.dir, 'y.log')];
  const orders = [paths, [...paths].reverse()];
  const results = await Promise.all(
    orders.map((order, i) =>
      runCli(script, order, {
        cwd: env.dir,
        env: buildFakeEnv(env, { FAKE_COLLAPSE_SPACES: '1', FAKE_DIAGNOSTICS_DELAY_MS: '300', FAKE_LOG: logs[i] }),
        timeoutMs: 60000,
      })
    )
  );
  for (const r of results) {
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(r.code, 0);
  }
  // One call formats each file, and the other then finds it done.
  const lines = results.flatMap((r) => r.stdout.split('\n').filter(Boolean));
  for (const p of paths) {
    assert.deepStrictEqual(lines.filter((l) => l.endsWith(` ${p}`)).sort(), [`formatted: ${p}`, `unchanged: ${p}`]);
  }
  for (const log of logs) assertOpenedUnderLock(log);
});
