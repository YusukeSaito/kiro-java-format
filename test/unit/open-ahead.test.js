'use strict';

// Opening the files of a call ahead of their turn, against the fake language
// server: what the call prints, and which documents the server holds open.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createIsolatedEnv, listLeftovers, NO_LEFTOVERS } = require('../helpers/env');
const { resolveTestScript, runCli } = require('../helpers/cli');
const { buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const script = resolveTestScript();

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
