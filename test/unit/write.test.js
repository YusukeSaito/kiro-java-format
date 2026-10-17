'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createIsolatedEnv } = require('../helpers/env');
const lib = require('../../format-java.js');

const LOCK_CHILD = path.join(__dirname, '..', 'helpers', 'lock-child.js');

function startChild(args, env) {
  const child = spawn(process.execPath, [LOCK_CHILD, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
  });
  return { child, done };
}

/** Point this process's lock location at the test's cache for the duration of `fn`. */
async function withCache(env, fn) {
  const before = process.env.KIRO_JAVA_FORMAT_CACHE;
  process.env.KIRO_JAVA_FORMAT_CACHE = env.KIRO_JAVA_FORMAT_CACHE;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.KIRO_JAVA_FORMAT_CACHE;
    else process.env.KIRO_JAVA_FORMAT_CACHE = before;
  }
}

async function waitForLockFile(env) {
  const dir = lib.resolveLockDir(env.KIRO_JAVA_FORMAT_CACHE);
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.endsWith('.lock'))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the child never took the lock');
}

test('writeFileIfUnchanged keeps the inode and the mode', () => {
  const env = createIsolatedEnv();
  try {
    const file = path.join(env.dir, 'A.java');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o640);
    const before = fs.statSync(file);
    lib.writeFileIfUnchanged(file, 'new', 'old');
    const after = fs.statSync(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
    assert.strictEqual(after.ino, before.ino);
    assert.strictEqual(after.mode, before.mode);
  } finally {
    env.cleanup();
  }
});

test('writeFileIfUnchanged writes through a symlink and keeps the link', () => {
  const env = createIsolatedEnv();
  try {
    const target = path.join(env.dir, 'Target.java');
    const link = path.join(env.dir, 'Link.java');
    fs.writeFileSync(target, 'old');
    fs.symlinkSync(target, link);
    lib.writeFileIfUnchanged(link, 'new', 'old');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
  } finally {
    env.cleanup();
  }
});

test('writeFileIfUnchanged keeps hard links sharing the content', () => {
  const env = createIsolatedEnv();
  try {
    const a = path.join(env.dir, 'A.java');
    const b = path.join(env.dir, 'B.java');
    fs.writeFileSync(a, 'old');
    fs.linkSync(a, b);
    lib.writeFileIfUnchanged(a, 'new', 'old');
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'new');
    assert.strictEqual(fs.statSync(a).nlink, 2);
  } finally {
    env.cleanup();
  }
});

test('writeFileIfUnchanged writes a writable file in a read-only directory', { skip: process.getuid && process.getuid() === 0 ? 'root ignores the mode' : false }, () => {
  const env = createIsolatedEnv();
  const dir = path.join(env.dir, 'ro');
  try {
    fs.mkdirSync(dir);
    const file = path.join(dir, 'A.java');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(dir, 0o555);
    lib.writeFileIfUnchanged(file, 'new', 'old');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  } finally {
    fs.chmodSync(dir, 0o755);
    env.cleanup();
  }
});

test('writeFileIfUnchanged keeps extended attributes', { skip: fs.existsSync('/usr/bin/xattr') ? false : 'no /usr/bin/xattr' }, () => {
  const env = createIsolatedEnv();
  try {
    const file = path.join(env.dir, 'A.java');
    fs.writeFileSync(file, 'old');
    execFileSync('/usr/bin/xattr', ['-w', 'com.kjf.test', 'kept', file]);
    lib.writeFileIfUnchanged(file, 'new', 'old');
    assert.strictEqual(execFileSync('/usr/bin/xattr', ['-p', 'com.kjf.test', file], { encoding: 'utf8' }).trim(), 'kept');
  } finally {
    env.cleanup();
  }
});

test('writeFileIfUnchanged refuses to write over a change made after the read, and returns the fstat', () => {
  const env = createIsolatedEnv();
  try {
    const file = path.join(env.dir, 'A.java');
    fs.writeFileSync(file, 'theirs');
    assert.throws(() => lib.writeFileIfUnchanged(file, 'mine', 'original'), lib.ChangedOnDiskError);
    assert.throws(() => lib.writeFileIfUnchanged(file, 'mine', 'original'), /changed on disk while formatting; not written/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'theirs');
    const st = lib.writeFileIfUnchanged(file, 'mine!', 'theirs');
    const after = fs.statSync(file);
    assert.strictEqual(st.ino, after.ino);
    assert.strictEqual(st.size, after.size);
    assert.strictEqual(st.mtimeMs, after.mtimeMs);
  } finally {
    env.cleanup();
  }
});

test('runWithFileLock makes two processes on the same file take turns', async () => {
  const env = createIsolatedEnv();
  try {
    const file = path.join(env.dir, 'A.java');
    fs.writeFileSync(file, 'x');
    const runs = [
      startChild(['hold-file', file, '10000', '600'], env.buildEnv()),
      startChild(['hold-file', file, '10000', '600'], env.buildEnv()),
    ];
    const [a, b] = (await Promise.all(runs.map((r) => r.done))).sort((x, y) => x.enteredAt - y.enteredAt);
    assert.ok(b.enteredAt >= a.leftAt - 5, `overlap: ${JSON.stringify([a, b])}`);
    assert.deepStrictEqual(fs.readdirSync(lib.resolveLockDir(env.KIRO_JAVA_FORMAT_CACHE)), [], 'locks are released');
  } finally {
    env.cleanup();
  }
});

test('past the wait limit the waiter goes on without the lock; the write check still guards the file', async () => {
  const env = createIsolatedEnv();
  try {
    const file = path.join(env.dir, 'A.java');
    fs.writeFileSync(file, 'original');
    const holder = startChild(['hold-file', file, '10000', '4000'], env.buildEnv());
    await waitForLockFile(env);

    // The holder keeps the lock and also writes: the waiter must not overwrite it.
    const startedAt = Date.now();
    await withCache(env, () =>
      lib.runWithFileLock(file, 500, async () => {
        assert.ok(Date.now() - startedAt >= 450, 'waited for the limit');
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, 'holder wrote this');
        assert.throws(() => lib.writeFileIfUnchanged(file, 'formatted', original), lib.ChangedOnDiskError);
      })
    );
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'holder wrote this');

    // The holder keeps the lock but does not write (a leftover): the waiter can write.
    await withCache(env, () =>
      lib.runWithFileLock(file, 500, async () => {
        const original = fs.readFileSync(file, 'utf8');
        lib.writeFileIfUnchanged(file, 'formatted', original);
      })
    );
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'formatted');
    await holder.done;
  } finally {
    env.cleanup();
  }
});
