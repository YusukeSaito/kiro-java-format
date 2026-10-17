'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createIsolatedEnv } = require('../helpers/env');
const { resolveTestScript, startCli } = require('../helpers/cli');
const { buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { listProcessesWithToken, waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const script = resolveTestScript();
// JVM_EXIT_GRACE_MS + 2 s
const SETTLE_MS = 12000;

function listTemporaryUserdirs(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('kiro-java-format-userdir-'));
}

async function waitForServer(token) {
  for (let i = 0; i < 200; i++) {
    if (listProcessesWithToken(token).some((p) => p.command.includes('fake-server.js'))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the fake server never started');
}

test('after the CLI is killed with SIGKILL, its watchdog stops the server and removes the userdir', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 1);
  const run = startCli(script, files, {
    cwd: env.dir,
    env: buildFakeEnv(env, { FAKE_NO_REPLY: 'textDocument/formatting:1' }),
  });
  await waitForServer(env.dir);
  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(listTemporaryUserdirs(env.dir).length, 1);
  run.child.kill('SIGKILL');
  const r = await run.done;
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  assert.deepStrictEqual(listTemporaryUserdirs(env.dir), []);
});

test('after a normal run the watchdog removes the userdir once the server is gone', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 2);
  const r = await startCli(script, files, { cwd: env.dir, env: buildFakeEnv(env) }).done;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  assert.deepStrictEqual(listTemporaryUserdirs(env.dir), []);
});
