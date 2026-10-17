'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createIsolatedEnv, listLeftovers, NO_LEFTOVERS } = require('../helpers/env');
const { resolveTestScript, startCli } = require('../helpers/cli');
const { buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { listProcessesWithToken, waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const script = resolveTestScript();
// JVM_EXIT_GRACE_MS + 2 s
const SETTLE_MS = 12000;

async function waitForServer(token) {
  for (let i = 0; i < 200; i++) {
    if (listProcessesWithToken(token).some((p) => p.command.includes('fake-server.js'))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the fake server never started');
}

function listCachedUserdirs(env) {
  const cache = env.KIRO_JAVA_FORMAT_CACHE;
  if (!fs.existsSync(cache)) return [];
  return fs.readdirSync(cache).filter((n) => fs.existsSync(path.join(cache, n, 'userdir')));
}

async function killMidRun(t, extraEnv) {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 1);
  const run = startCli(script, files, {
    cwd: env.dir,
    env: { ...buildFakeEnv(env, { FAKE_NO_REPLY: 'textDocument/formatting:1' }), ...extraEnv(env) },
  });
  await waitForServer(env.dir);
  await new Promise((r) => setTimeout(r, 1000));
  const during = listLeftovers(env);
  run.child.kill('SIGKILL');
  const r = await run.done;
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  return { env, during };
}

test('after SIGKILL of the CLI, the watchdog stops the server and releases the cached userdir', async (t) => {
  const { env, during } = await killMidRun(t, () => ({}));
  assert.strictEqual(during.ownerLocks.length, 1, 'the run owned the cached userdir');
  assert.strictEqual(during.netbeansLocks.length, 1, 'the server held its lock');
  assert.deepStrictEqual(listLeftovers(env), { ...NO_LEFTOVERS, fileLocks: during.fileLocks });
  assert.strictEqual(listCachedUserdirs(env).length, 1, 'the cached userdir itself stays');
});

test('after SIGKILL of the CLI, the watchdog removes a temporary userdir', async (t) => {
  // A cache path below a regular file cannot be created: the run falls back to a temporary userdir.
  const { env, during } = await killMidRun(t, (e) => {
    fs.writeFileSync(path.join(e.dir, 'not-a-dir'), '');
    return { KIRO_JAVA_FORMAT_CACHE: path.join(e.dir, 'not-a-dir', 'cache') };
  });
  assert.strictEqual(during.temporaryUserdirs.length, 1);
  assert.deepStrictEqual(listLeftovers(env).temporaryUserdirs, []);
});

test('after a normal run the watchdog releases the cached userdir once the server is gone', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 2);
  const r = await startCli(script, files, { cwd: env.dir, env: buildFakeEnv(env) }).done;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  assert.deepStrictEqual(listLeftovers(env), NO_LEFTOVERS);
  assert.strictEqual(listCachedUserdirs(env).length, 1);
});
