'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  createIsolatedEnv,
  listLeftovers,
  NO_LEFTOVERS,
  listProjectRecords,
  markRecordedProjectsLarge,
} = require('../helpers/env');
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

/** One normal run (it records the project), then the record is made to say the index is large. */
async function recordAsLarge(env, files) {
  const r = await startCli(script, files, { cwd: env.dir, env: buildFakeEnv(env) }).done;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  markRecordedProjectsLarge(env);
}

async function killMidRun(t, extraEnv, { isLarge = false } = {}) {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 1);
  if (isLarge) await recordAsLarge(env, files);
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
  const { env, during } = await killMidRun(t, () => ({}), { isLarge: true });
  assert.strictEqual(during.ownerLocks.length, 1, 'the run owned the cached userdir');
  assert.strictEqual(during.netbeansLocks.length, 1, 'the server held its lock');
  assert.deepStrictEqual(listLeftovers(env), { ...NO_LEFTOVERS, fileLocks: during.fileLocks });
  assert.strictEqual(listCachedUserdirs(env).length, 1, 'the cached userdir itself stays');
});

test('after SIGKILL of the CLI, the watchdog removes a temporary userdir', async (t) => {
  const { env, during } = await killMidRun(t, () => ({}));
  assert.strictEqual(during.temporaryUserdirs.length, 1);
  assert.deepStrictEqual(listLeftovers(env).temporaryUserdirs, []);
  assert.deepStrictEqual(listCachedUserdirs(env), []);
});

test('a small project runs in a temporary userdir, is recorded, and leaves no cached userdir', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 2);
  for (const round of [1, 2]) {
    const r = await startCli(script, ['-v', ...files], { cwd: env.dir, env: buildFakeEnv(env) }).done;
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, round === 1 ? /indexing time not measured yet/ : /the index is small/);
    assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
    assert.deepStrictEqual(listLeftovers(env), NO_LEFTOVERS);
    assert.deepStrictEqual(listCachedUserdirs(env), []);
    const records = listProjectRecords(env);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].record.coldIndexing.kind, 'complete');
    assert.ok(records[0].record.coldIndexing.durationMs < 10000);
  }
});

test('a large project: after a normal run the watchdog releases the cached userdir once the server is gone', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 2);
  await recordAsLarge(env, files);
  const r = await startCli(script, ['-v', ...files], { cwd: env.dir, env: buildFakeEnv(env) }).done;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /userdir \(cached\):/);
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  assert.deepStrictEqual(listLeftovers(env), NO_LEFTOVERS);
  assert.strictEqual(listCachedUserdirs(env).length, 1);
  const { coldIndexing } = listProjectRecords(env)[0].record;
  assert.deepStrictEqual(coldIndexing, { kind: 'complete', durationMs: 60000 }, 'a cached run does not record');
});

test('with a repeated file, the cached userdir is released while the later segment still runs', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  const files = writeJavaFiles(env.dir, 2);
  await recordAsLarge(env, files);
  // Each server waits 4 s before listening, so the second segment (a
  // temporary userdir) runs long enough to look at the first one's lock.
  const run = startCli(script, [files[0], files[1], files[0]], {
    cwd: env.dir,
    env: buildFakeEnv(env, { FAKE_START_DELAY_MS: '4000' }),
  });
  let isReleasedDuringRun = false;
  for (let i = 0; i < 300 && run.child.exitCode === null; i++) {
    const left = listLeftovers(env);
    if (left.temporaryUserdirs.length === 1 && left.ownerLocks.length === 0) {
      isReleasedDuringRun = run.child.exitCode === null;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await run.done;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(isReleasedDuringRun, 'the owner lock was released before the CLI exited');
  assert.deepStrictEqual(await waitForNoProcessesWithToken(env.dir, SETTLE_MS), []);
  assert.deepStrictEqual(listLeftovers(env), NO_LEFTOVERS);
});
