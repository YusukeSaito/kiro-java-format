'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createIsolatedEnv } = require('../helpers/env');
const { spawnDecoy, killOwnPids } = require('../helpers/processes');
const lib = require('../../format-java.js');

const LOCK_CHILD = path.join(__dirname, '..', 'helpers', 'lock-child.js');

function exitedPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid));
  });
}

function writeRecord(lockPath, record) {
  fs.writeFileSync(lockPath, JSON.stringify(record));
}

function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LOCK_CHILD, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
  });
}

test('acquireLockFile creates the lock once; a second try is busy', () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    const first = lib.acquireLockFile(lockPath, { state: 'running' });
    assert.strictEqual(first.kind, 'acquired');
    const read = lib.readLockRecord(lockPath);
    assert.strictEqual(read.kind, 'parsed');
    assert.strictEqual(read.record.pid, process.pid);
    assert.strictEqual(read.record.nonce, first.nonce);
    assert.strictEqual(read.record.state, 'running');
    assert.strictEqual(lib.acquireLockFile(lockPath, {}).kind, 'busy');
    assert.deepStrictEqual(fs.readdirSync(env.dir), ['x.lock'], 'no temporary files are left');
  } finally {
    env.cleanup();
  }
});

test('a lock whose holder is dead is stale and can be broken', async () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    writeRecord(lockPath, { pid: await exitedPid(), nonce: 'n1', createdAt: Date.now() });
    const read = lib.readLockRecord(lockPath);
    assert.strictEqual(await lib.isLockStale(read, Date.now()), true);
    assert.strictEqual(lib.breakStaleLock(lockPath, read), true);
    assert.strictEqual(lib.acquireLockFile(lockPath, {}).kind, 'acquired');
  } finally {
    env.cleanup();
  }
});

test('a lock that cannot be parsed is stale only once it is old', async () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    fs.writeFileSync(lockPath, '{"pid": 12');
    let read = lib.readLockRecord(lockPath);
    assert.strictEqual(read.kind, 'unparsable');
    assert.strictEqual(await lib.isLockStale(read, Date.now()), false);
    const old = (Date.now() - lib.LOCK_UNPARSABLE_STALE_MS - 1000) / 1000;
    fs.utimesSync(lockPath, old, old);
    read = lib.readLockRecord(lockPath);
    assert.strictEqual(await lib.isLockStale(read, Date.now()), true);
    assert.strictEqual(lib.breakStaleLock(lockPath, read), true);
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally {
    env.cleanup();
  }
});

test('a recycled pid (alive, but not this tool) makes an old lock stale, not a fresh one', async () => {
  const env = createIsolatedEnv();
  const decoy = spawnDecoy(['--kjf-lock-decoy']);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const lockPath = path.join(env.dir, 'x.lock');
    writeRecord(lockPath, { pid: decoy.pid, nonce: 'n1', createdAt: Date.now() });
    assert.strictEqual(await lib.isLockStale(lib.readLockRecord(lockPath), Date.now()), false);
    writeRecord(lockPath, { pid: decoy.pid, nonce: 'n1', createdAt: Date.now() - lib.LOCK_PID_CHECK_AGE_MS - 1000 });
    assert.strictEqual(await lib.isLockStale(lib.readLockRecord(lockPath), Date.now()), true);
  } finally {
    killOwnPids([decoy.pid]);
    env.cleanup();
  }
});

test('an owner lock is stale only when the watchdog is dead as well', async () => {
  const env = createIsolatedEnv();
  const decoy = spawnDecoy(['format-java.js', '--kjf-watchdog-decoy']);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const lockPath = path.join(env.dir, 'owner.lock');
    const dead = await exitedPid();
    writeRecord(lockPath, { pid: dead, nonce: 'n1', createdAt: Date.now() - 5000, server: { watchdogPid: decoy.pid } });
    assert.strictEqual(await lib.isLockStale(lib.readLockRecord(lockPath), Date.now()), false);
    killOwnPids([decoy.pid]);
    await new Promise((r) => decoy.on('exit', r));
    assert.strictEqual(await lib.isLockStale(lib.readLockRecord(lockPath), Date.now()), true);
  } finally {
    killOwnPids([decoy.pid]);
    env.cleanup();
  }
});

test('a lock is not stale when the holder cannot be inspected', async () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    writeRecord(lockPath, { pid: await exitedPid(), nonce: 'n1', createdAt: 0 });
    const inspect = async () => ({ isAvailable: false, reason: 'test' });
    assert.strictEqual(await lib.isLockStale(lib.readLockRecord(lockPath), Date.now(), { inspect }), false);
  } finally {
    env.cleanup();
  }
});

test('two processes breaking the same stale lock leave exactly one holder', async () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    writeRecord(lockPath, { pid: await exitedPid(), nonce: 'stale', createdAt: Date.now() });
    const startAt = Date.now() + 700;
    const results = await Promise.all([
      runChild(['break-and-acquire', lockPath, String(startAt)], process.env),
      runChild(['break-and-acquire', lockPath, String(startAt)], process.env),
    ]);
    assert.deepStrictEqual(results.map((r) => r.kind).sort(), ['acquired', 'busy'], JSON.stringify(results));
    const holder = results.find((r) => r.kind === 'acquired');
    assert.strictEqual(lib.readLockRecord(lockPath).record.pid, holder.pid);
  } finally {
    env.cleanup();
  }
});

test('releaseLockFile and updateLockFile leave a lock with another nonce alone', () => {
  const env = createIsolatedEnv();
  try {
    const lockPath = path.join(env.dir, 'x.lock');
    const mine = lib.acquireLockFile(lockPath, { state: 'running' });
    assert.strictEqual(lib.releaseLockFile(lockPath, 'not-mine'), false);
    assert.strictEqual(lib.updateLockFile(lockPath, 'not-mine', { state: 'releasing' }), false);
    assert.strictEqual(lib.readLockRecord(lockPath).record.state, 'running');
    assert.strictEqual(lib.updateLockFile(lockPath, mine.nonce, { state: 'releasing' }), true);
    assert.strictEqual(lib.readLockRecord(lockPath).record.state, 'releasing');
    assert.strictEqual(lib.readLockRecord(lockPath).record.nonce, mine.nonce);
    assert.strictEqual(lib.releaseLockFile(lockPath, mine.nonce), true);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.deepStrictEqual(fs.readdirSync(env.dir), [], 'no temporary files are left');
  } finally {
    env.cleanup();
  }
});

test('a hard-link failure other than EEXIST makes the lock location unusable', (t) => {
  const env = createIsolatedEnv();
  const original = fs.linkSync;
  t.after(() => {
    fs.linkSync = original;
    env.cleanup();
  });
  fs.linkSync = () => {
    const err = new Error('EPERM: operation not permitted, link');
    err.code = 'EPERM';
    throw err;
  };
  const r = lib.acquireLockFile(path.join(env.dir, 'x.lock'), {});
  assert.strictEqual(r.kind, 'unusable');
  assert.match(r.reason, /EPERM/);
  assert.deepStrictEqual(fs.readdirSync(env.dir), [], 'the temporary file is removed');
});
