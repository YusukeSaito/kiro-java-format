'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createIsolatedEnv } = require('../helpers/env');
const { FAKE_EXT } = require('../helpers/fake');
const { spawnDecoy, killOwnPids, isAlive, listProcessesWithToken } = require('../helpers/processes');
const lib = require('../../format-java.js');

const PROJECT = { root: '/p', extPath: '/ext', jdkHome: null };

/** Run `fn` with this process's cache pointed at the test's, cleaning up temporary userdirs it returns. */
async function withCache(t, env, fn) {
  const before = process.env.KIRO_JAVA_FORMAT_CACHE;
  process.env.KIRO_JAVA_FORMAT_CACHE = env.KIRO_JAVA_FORMAT_CACHE;
  t.after(() => {
    if (before === undefined) delete process.env.KIRO_JAVA_FORMAT_CACHE;
    else process.env.KIRO_JAVA_FORMAT_CACHE = before;
  });
  return fn();
}

function removeTemporary(lease) {
  if (lease.kind === 'temporary') fs.rmSync(lease.userdir, { recursive: true, force: true });
}

function exitedPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid));
  });
}

function ownerLockPath(env, key) {
  return path.join(env.KIRO_JAVA_FORMAT_CACHE, key, 'owner.lock');
}

const LARGE = { kind: 'complete', durationMs: 15000 };
const SMALL = { kind: 'complete', durationMs: 3000 };

function writeProjectRecord(env, key, coldIndexing) {
  const dir = path.join(env.KIRO_JAVA_FORMAT_CACHE, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...PROJECT, createdAt: 1, coldIndexing }));
}

function writeOwnerLock(env, key, record) {
  writeProjectRecord(env, key, LARGE);
  fs.mkdirSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, key, 'userdir'), { recursive: true });
  fs.writeFileSync(ownerLockPath(env, key), JSON.stringify(record));
}

test('shouldUseCachedIndex: only an index measured at the threshold or above', () => {
  const T = lib.MIN_COLD_INDEXING_MS_FOR_CACHE;
  assert.strictEqual(T, 10000);
  assert.strictEqual(lib.shouldUseCachedIndex(null), false);
  assert.strictEqual(lib.shouldUseCachedIndex({ kind: 'complete', durationMs: T - 1 }), false);
  assert.strictEqual(lib.shouldUseCachedIndex({ kind: 'complete', durationMs: T }), true);
  assert.strictEqual(lib.shouldUseCachedIndex({ kind: 'incomplete', minimumMs: T - 1 }), false);
  assert.strictEqual(lib.shouldUseCachedIndex({ kind: 'incomplete', minimumMs: T + 2000 }), true);
});

test('resolveColdIndexingRecord: a completed measurement always replaces the record', () => {
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(null, SMALL), SMALL);
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(SMALL, LARGE), LARGE, 'a project that grew starts using the cache');
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(LARGE, SMALL), SMALL);
});

test('resolveColdIndexingRecord: an unfinished measurement counts only when it alone shows a large index', () => {
  const shortRun = { kind: 'incomplete', minimumMs: 4000 };
  const longRun = { kind: 'incomplete', minimumMs: 12000 };
  assert.strictEqual(lib.resolveColdIndexingRecord(null, shortRun), null);
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(SMALL, shortRun), SMALL);
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(LARGE, shortRun), LARGE, 'a short run does not flip a large project');
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(null, longRun), longRun);
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(SMALL, longRun), longRun);
  assert.deepStrictEqual(lib.resolveColdIndexingRecord(LARGE, longRun), LARGE);
});

test('readProjectRecord: a missing or damaged record reads like none', () => {
  const env = createIsolatedEnv();
  try {
    const dir = path.join(env.dir, 'k');
    fs.mkdirSync(dir);
    assert.strictEqual(lib.readProjectRecord(dir), null);
    fs.writeFileSync(path.join(dir, 'project.json'), '{"root": "/p", "coldIn');
    assert.strictEqual(lib.readProjectRecord(dir), null);
    fs.writeFileSync(path.join(dir, 'project.json'), '[1]');
    assert.strictEqual(lib.readProjectRecord(dir), null);
    for (const bad of [{ kind: 'complete' }, { kind: 'complete', durationMs: 'x' }, { kind: 'other', durationMs: 1 }, 5]) {
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ root: '/p', coldIndexing: bad }));
      assert.strictEqual(lib.readProjectRecord(dir).coldIndexing, null, JSON.stringify(bad));
    }
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ root: '/p', coldIndexing: LARGE }));
    assert.deepStrictEqual(lib.readProjectRecord(dir).coldIndexing, LARGE);
  } finally {
    env.cleanup();
  }
});

test('saveColdIndexingRecord keeps the project fields and the first creation time', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => env.cleanup());
  await withCache(t, env, async () => {
    lib.saveColdIndexingRecord('k1', PROJECT, SMALL);
    const dir = path.join(env.KIRO_JAVA_FORMAT_CACHE, 'k1');
    const first = lib.readProjectRecord(dir);
    assert.deepStrictEqual({ ...first, createdAt: 0 }, { ...PROJECT, createdAt: 0, coldIndexing: SMALL });
    lib.saveColdIndexingRecord('k1', PROJECT, { kind: 'incomplete', minimumMs: 500 });
    assert.deepStrictEqual(lib.readProjectRecord(dir), first, 'an unfinished short run changes nothing');
    lib.saveColdIndexingRecord('k1', PROJECT, LARGE);
    assert.deepStrictEqual(lib.readProjectRecord(dir), { ...first, coldIndexing: LARGE });
    assert.deepStrictEqual(fs.readdirSync(dir), ['project.json'], 'no userdir and no temporary file');
  });
});

test('a project not measured yet, or measured small, gets a temporary userdir and no cached one', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => env.cleanup());
  const unmeasured = await withCache(t, env, () => lib.acquireUserdir('k1', 5000));
  removeTemporary(unmeasured);
  assert.strictEqual(unmeasured.kind, 'temporary');
  writeProjectRecord(env, 'k2', SMALL);
  const small = await withCache(t, env, () => lib.acquireUserdir('k2', 5000));
  removeTemporary(small);
  assert.strictEqual(small.kind, 'temporary');
  fs.writeFileSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, 'k2', 'project.json'), 'garbage');
  const damaged = await withCache(t, env, () => lib.acquireUserdir('k2', 5000));
  removeTemporary(damaged);
  assert.strictEqual(damaged.kind, 'temporary');
  for (const key of ['k1', 'k2']) {
    assert.ok(!fs.existsSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, key, 'userdir')), `${key} has no cached userdir`);
    assert.ok(!fs.existsSync(ownerLockPath(env, key)));
  }
});

test('a large project with a free cache gets a persistent userdir with an owner lock', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => env.cleanup());
  writeProjectRecord(env, 'k1', LARGE);
  const lease = await withCache(t, env, () => lib.acquireUserdir('k1', 5000));
  assert.deepStrictEqual(Object.keys(lease).sort(), ['kind', 'ownerLock', 'userdir']);
  assert.strictEqual(lease.kind, 'persistent');
  assert.strictEqual(lease.userdir, path.join(env.KIRO_JAVA_FORMAT_CACHE, 'k1', 'userdir'));
  assert.deepStrictEqual(Object.keys(lease.ownerLock).sort(), ['nonce', 'path']);
  const read = lib.readLockRecord(lease.ownerLock.path);
  assert.strictEqual(read.record.state, 'running');
  assert.strictEqual(read.record.nonce, lease.ownerLock.nonce);
  assert.strictEqual(fs.statSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, 'k1', 'userdir')).mode & 0o777, 0o700);
});

test('a cache in use by a running owner gives a temporary userdir without waiting', async (t) => {
  const env = createIsolatedEnv();
  const owner = spawnDecoy(['format-java.js', '--kjf-owner-decoy']);
  t.after(() => {
    killOwnPids([owner.pid]);
    env.cleanup();
  });
  await new Promise((r) => setTimeout(r, 200));
  writeOwnerLock(env, 'k1', { pid: owner.pid, nonce: 'n', createdAt: Date.now() - 5000, state: 'running' });
  const startedAt = Date.now();
  const lease = await withCache(t, env, () => lib.acquireUserdir('k1', 5000));
  removeTemporary(lease);
  assert.strictEqual(lease.kind, 'temporary');
  assert.deepStrictEqual(Object.keys(lease).sort(), ['kind', 'userdir']);
  assert.ok(Date.now() - startedAt < 1000);
});

test('a dead owner whose watchdog is still cleaning up is waited for', async (t) => {
  const env = createIsolatedEnv();
  const watchdog = spawnDecoy(['format-java.js', '--kjf-watchdog-decoy']);
  t.after(() => {
    killOwnPids([watchdog.pid]);
    env.cleanup();
  });
  await new Promise((r) => setTimeout(r, 200));
  const record = { pid: await exitedPid(), nonce: 'n', createdAt: Date.now() - 5000, state: 'releasing' };
  writeOwnerLock(env, 'k1', { ...record, server: { watchdogPid: watchdog.pid } });
  // The watchdog releases the lock after 700 ms.
  setTimeout(() => fs.unlinkSync(ownerLockPath(env, 'k1')), 700);
  const startedAt = Date.now();
  const lease = await withCache(t, env, () => lib.acquireUserdir('k1', 5000));
  assert.strictEqual(lease.kind, 'persistent');
  assert.ok(Date.now() - startedAt >= 650, 'waited for the release');
});

test('the wait for a shutting-down owner has a limit, then a temporary userdir', async (t) => {
  const env = createIsolatedEnv();
  const watchdog = spawnDecoy(['format-java.js', '--kjf-watchdog-decoy']);
  t.after(() => {
    killOwnPids([watchdog.pid]);
    env.cleanup();
  });
  await new Promise((r) => setTimeout(r, 200));
  writeOwnerLock(env, 'k1', {
    pid: await exitedPid(),
    nonce: 'n',
    createdAt: Date.now() - 5000,
    state: 'releasing',
    server: { watchdogPid: watchdog.pid },
  });
  const lease = await withCache(t, env, () => lib.acquireUserdir('k1', 300));
  removeTemporary(lease);
  assert.strictEqual(lease.kind, 'temporary');
});

test('a lock whose owner and watchdog are both dead is broken and the userdir taken', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => env.cleanup());
  const dead = await exitedPid();
  writeOwnerLock(env, 'k1', { pid: dead, nonce: 'n', createdAt: Date.now() - 5000, state: 'running', server: { watchdogPid: dead } });
  const lease = await withCache(t, env, () => lib.acquireUserdir('k1', 5000));
  assert.strictEqual(lease.kind, 'persistent');
  assert.notStrictEqual(lib.readLockRecord(lease.ownerLock.path).record.nonce, 'n');
});

test('without process inspection, an unusable cache, or no hard links: a temporary userdir', async (t) => {
  const env = createIsolatedEnv();
  t.after(() => env.cleanup());
  const noInspection = await withCache(t, env, () =>
    lib.acquireUserdir('k1', 5000, { isInspectionAvailable: () => false })
  );
  removeTemporary(noInspection);
  assert.strictEqual(noInspection.kind, 'temporary');

  const file = path.join(env.dir, 'not-a-dir');
  fs.writeFileSync(file, '');
  const before = process.env.KIRO_JAVA_FORMAT_CACHE;
  process.env.KIRO_JAVA_FORMAT_CACHE = path.join(file, 'cache');
  try {
    const noCache = await lib.acquireUserdir('k1', 5000);
    removeTemporary(noCache);
    assert.strictEqual(noCache.kind, 'temporary');
  } finally {
    process.env.KIRO_JAVA_FORMAT_CACHE = before;
  }

  writeProjectRecord(env, 'k2', LARGE);
  const original = fs.linkSync;
  fs.linkSync = () => {
    const err = new Error('ENOTSUP: operation not supported, link');
    err.code = 'ENOTSUP';
    throw err;
  };
  try {
    const noLink = await withCache(t, env, () => lib.acquireUserdir('k2', 5000));
    removeTemporary(noLink);
    assert.strictEqual(noLink.kind, 'temporary');
  } finally {
    fs.linkSync = original;
  }
});

test('prepareUserdirForStart looks at processes only when a previous run left a trace', async () => {
  const env = createIsolatedEnv();
  try {
    const userdir = path.join(env.dir, 'userdir');
    fs.mkdirSync(userdir);
    let calls = 0;
    const find = async () => {
      calls++;
      return { isAvailable: true, processes: [] };
    };
    assert.deepStrictEqual(await lib.prepareUserdirForStart(userdir, { hasStaleOwner: false }, { find }), { isReady: true });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(await lib.prepareUserdirForStart(userdir, { hasStaleOwner: true }, { find }), { isReady: true });
    assert.strictEqual(calls, 1);
    fs.writeFileSync(path.join(userdir, 'lock'), '');
    assert.deepStrictEqual(await lib.prepareUserdirForStart(userdir, { hasStaleOwner: false }, { find }), { isReady: true });
    assert.strictEqual(calls, 2);
    assert.strictEqual(fs.existsSync(path.join(userdir, 'lock')), false, 'the NetBeans lock is removed');
    const unavailable = async () => ({ isAvailable: false, reason: 'test' });
    assert.deepStrictEqual(await lib.prepareUserdirForStart(userdir, { hasStaleOwner: true }, { find: unavailable }), {
      isReady: false,
    });
  } finally {
    env.cleanup();
  }
});

test('prepareUserdirForStart stops a leftover server on the userdir and spares the decoys', { skip: process.platform === 'win32' }, async (t) => {
  const env = createIsolatedEnv();
  const userdir = path.join(env.dir, 'userdir');
  fs.mkdirSync(userdir);
  const decoys = [
    spawnDecoy(['--userdir', `${userdir}-x`]),
    spawnDecoy(['--userdir', `${userdir}/sub`]),
    spawnDecoy([`-Dnetbeans.user=${userdir}x`]),
  ];
  const orphan = spawn(path.join(FAKE_EXT, 'nbcode', 'bin', 'nbcode.sh'), ['--userdir', userdir], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, FAKE_NODE: process.execPath },
  });
  t.after(() => {
    killOwnPids([...decoys.map((d) => d.pid), ...listProcessesWithToken(env.dir).map((p) => p.pid)]);
    env.cleanup();
  });
  await new Promise((r) => orphan.stdout.once('data', r));
  assert.ok(fs.existsSync(path.join(userdir, 'lock')), 'the fake server holds the NetBeans lock');
  assert.deepStrictEqual(await lib.prepareUserdirForStart(userdir, { hasStaleOwner: true }), { isReady: true });
  assert.deepStrictEqual((await lib.findProcessesUsingUserdir(userdir)).processes, []);
  assert.strictEqual(fs.existsSync(path.join(userdir, 'lock')), false);
  for (const d of decoys) assert.ok(isAlive(d.pid), `decoy ${d.pid} is alive`);
});

test('hasMixedProjectRoots tells calls over one root from calls over several', () => {
  const env = createIsolatedEnv();
  try {
    for (const p of ['a', 'b']) {
      fs.mkdirSync(path.join(env.dir, p, 'src'), { recursive: true });
      fs.writeFileSync(path.join(env.dir, p, 'pom.xml'), '<project/>');
    }
    const ax = path.join(env.dir, 'a', 'src', 'X.java');
    const ay = path.join(env.dir, 'a', 'src', 'Y.java');
    const by = path.join(env.dir, 'b', 'src', 'Y.java');
    assert.strictEqual(lib.hasMixedProjectRoots([ax, ay], null), false);
    assert.strictEqual(lib.hasMixedProjectRoots([ax, by], null), true);
    assert.strictEqual(lib.hasMixedProjectRoots([ax, by], env.dir), false);
  } finally {
    env.cleanup();
  }
});

test('computeProjectKey is stable and tells extensions and JDKs apart', () => {
  const env = createIsolatedEnv();
  try {
    const key = lib.computeProjectKey(env.dir, env.dir, null);
    assert.match(key, /^[0-9a-f]{16}$/);
    assert.strictEqual(lib.computeProjectKey(env.dir, env.dir, null), key);
    assert.notStrictEqual(lib.computeProjectKey(env.dir, env.dir, '/jdk'), key);
    assert.notStrictEqual(lib.computeProjectKey(env.dir, '/other-ext', null), key);
  } finally {
    env.cleanup();
  }
});
