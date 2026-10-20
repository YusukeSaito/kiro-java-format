'use strict';

// Opening the files of a call ahead of their turn, against the fake language
// server: what the call prints, and which documents the server holds open.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { createIsolatedEnv, listLeftovers, NO_LEFTOVERS } = require('../helpers/env');
const { resolveTestScript, runCli } = require('../helpers/cli');
const { FAKE_EXT, buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');
const lib = require('../../format-java.js');

const script = resolveTestScript();
const LOCK_CHILD = path.join(__dirname, '..', 'helpers', 'lock-child.js');

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
