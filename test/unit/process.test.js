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

const IS_POSIX = process.platform !== 'win32';

test('parseProcStat reads the group from after the last parenthesis', () => {
  assert.deepStrictEqual(lib.parseProcStat('4242 (my (odd) name) S 1 777 777 0 -1 4194304'), { pid: 4242, pgid: 777 });
  assert.deepStrictEqual(lib.parseProcStat('17 (java) R 9 17 17 34816'), { pid: 17, pgid: 17 });
});

test('hasUserdirToken matches the exact userdir only', () => {
  const u = '/tmp/kjf/userdir';
  assert.ok(lib.hasUserdirToken(`/bin/bash nbexec.sh --userdir ${u} --jdkhome /j`, u));
  assert.ok(lib.hasUserdirToken(`java -cp x --userdir ${u}`, u));
  assert.ok(lib.hasUserdirToken(`java -Dnetbeans.user=${u} -cp x`, u));
  assert.ok(!lib.hasUserdirToken(`java --userdir ${u}-x`, u));
  assert.ok(!lib.hasUserdirToken(`java --userdir ${u}/sub`, u));
  assert.ok(!lib.hasUserdirToken(`java -Dnetbeans.user=${u}x`, u));
  assert.ok(!lib.hasUserdirToken(`java --userdirs ${u}`, u));
});

test('hasUserdirToken handles spaces and Windows quoting', () => {
  const u = '/tmp/a b/userdir';
  assert.ok(lib.hasUserdirToken(`java --userdir ${u} -J-x`, u));
  const w = 'C:\\Users\\A B\\Temp\\userdir';
  assert.ok(lib.hasUserdirToken(`nbcode64.exe --userdir "${w}" --jdkhome x`, w, { isCaseInsensitive: true }));
  assert.ok(lib.hasUserdirToken(`java.exe "-Dnetbeans.user=${w}" -cp x`, w, { isCaseInsensitive: true }));
  assert.ok(lib.hasUserdirToken(`nbcode64.exe --userdir "${w.toLowerCase()}"`, w, { isCaseInsensitive: true }));
  assert.ok(!lib.hasUserdirToken(`nbcode64.exe --userdir "${w}-x"`, w, { isCaseInsensitive: true }));
});

test('hasUserdirTokenInArgv matches whole arguments only', () => {
  const u = '/tmp/kjf/userdir';
  assert.ok(lib.hasUserdirTokenInArgv(['bash', 'nbexec.sh', '--userdir', u], u));
  assert.ok(lib.hasUserdirTokenInArgv(['java', `-Dnetbeans.user=${u}`], u));
  assert.ok(!lib.hasUserdirTokenInArgv(['java', '--userdir', `${u}-x`], u));
  assert.ok(!lib.hasUserdirTokenInArgv(['java', `--userdir=${u}`], u));
  assert.ok(!lib.hasUserdirTokenInArgv(['java', `-Dnetbeans.user=${u}x`], u));
});

/** Start the fake server through its launcher, the way the CLI starts nbcode. */
function startFakeServer(userdir, extraEnv = {}) {
  fs.mkdirSync(userdir, { recursive: true });
  const child = spawn(path.join(FAKE_EXT, 'nbcode', 'bin', 'nbcode.sh'), ['--userdir', userdir], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, FAKE_NODE: process.execPath, ...extraEnv },
  });
  const listening = new Promise((resolve) => child.stdout.on('data', resolve));
  return { child, listening };
}

function startDecoys(userdir, env) {
  return [
    spawnDecoy(['--userdir', `${userdir}-x`]),
    spawnDecoy(['--userdir', `${userdir}/sub`]),
    spawnDecoy([`-Dnetbeans.user=${userdir}x`]),
    spawnDecoy(['--userdir', path.join(env.dir, 'workspaceStorage', 'abc123', 'Oracle.oracle-java', 'userdir')]),
  ];
}

test('findProcessesUsingUserdir finds the launcher and the server, and nothing else', { skip: !IS_POSIX }, async (t) => {
  const env = createIsolatedEnv();
  const userdir = path.join(env.dir, 'userdir');
  const decoys = startDecoys(userdir, env);
  const fake = startFakeServer(userdir);
  t.after(() => {
    killOwnPids([...decoys.map((d) => d.pid), ...listProcessesWithToken(env.dir).map((p) => p.pid)]);
    env.cleanup();
  });
  await fake.listening;
  const r = await lib.findProcessesUsingUserdir(userdir);
  assert.strictEqual(r.isAvailable, true);
  const pids = r.processes.map((p) => p.pid);
  assert.ok(pids.includes(fake.child.pid), 'the launcher is found');
  assert.strictEqual(r.processes.length, 2, JSON.stringify(r.processes));
  assert.ok(r.processes.every((p) => p.pgid === fake.child.pid), 'both are in the launcher group');
  for (const d of decoys) assert.ok(!pids.includes(d.pid));
});

test('terminateServerProcesses stops the server and spares the decoys', { skip: !IS_POSIX }, async (t) => {
  const env = createIsolatedEnv();
  const userdir = path.join(env.dir, 'userdir');
  const decoys = startDecoys(userdir, env);
  const fake = startFakeServer(userdir);
  t.after(() => {
    killOwnPids([...decoys.map((d) => d.pid), ...listProcessesWithToken(env.dir).map((p) => p.pid)]);
    env.cleanup();
  });
  await fake.listening;
  const r = await lib.terminateServerProcesses({ pgid: fake.child.pid, launcherPid: fake.child.pid, userdir }, 5000);
  assert.strictEqual(r.isTerminated, true);
  assert.deepStrictEqual((await lib.findProcessesUsingUserdir(userdir)).processes, []);
  for (const d of decoys) assert.ok(isAlive(d.pid), `decoy ${d.pid} is alive`);
});

test('terminateServerProcesses goes on to SIGKILL a server that ignores SIGTERM', { skip: !IS_POSIX }, async (t) => {
  const env = createIsolatedEnv();
  const userdir = path.join(env.dir, 'userdir');
  const fake = startFakeServer(userdir, { FAKE_IGNORE_SIGTERM: '1' });
  t.after(() => {
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  });
  await fake.listening;
  const startedAt = Date.now();
  const r = await lib.terminateServerProcesses({ pgid: fake.child.pid, launcherPid: fake.child.pid, userdir }, 500);
  assert.strictEqual(r.isTerminated, true);
  assert.ok(Date.now() - startedAt >= 500, 'waited the grace period first');
  assert.deepStrictEqual((await lib.findProcessesUsingUserdir(userdir)).processes, []);
});

test('terminateServerProcesses reports false when processes cannot be listed', async () => {
  const sent = [];
  const r = await lib.terminateServerProcesses({ pgid: 999999, launcherPid: 999999, userdir: '/x' }, 10, {
    find: async () => ({ isAvailable: false, reason: 'test' }),
    kill: (pid, signal) => {
      sent.push([pid, signal]);
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
    wait: async () => {},
  });
  assert.strictEqual(r.isTerminated, false);
  // The launcher is not alive, so its (possibly reused) group is not signalled.
  assert.deepStrictEqual(sent, [[999999, 0]]);
});

test('on Windows the tree is killed only through a launcher that was found', async () => {
  const calls = [];
  let round = 0;
  const deps = {
    platform: 'win32',
    taskkill: async (args) => calls.push(args),
    wait: async () => {},
    kill: () => {},
  };
  // Launcher among the found processes: /T on the launcher.
  await lib.terminateServerProcesses({ pgid: null, launcherPid: 10, userdir: 'C:\\u' }, 1000, {
    ...deps,
    find: async () => ({ isAvailable: true, processes: round++ === 0 ? [{ pid: 10 }, { pid: 11 }] : [] }),
  });
  assert.deepStrictEqual(calls, [['/PID', '10', '/T']]);

  // Launcher gone (its pid may be reused): each found pid with /F, no /T.
  calls.length = 0;
  round = 0;
  await lib.terminateServerProcesses({ pgid: null, launcherPid: 99, userdir: 'C:\\u' }, 1000, {
    ...deps,
    find: async () => ({ isAvailable: true, processes: round++ === 0 ? [{ pid: 10 }, { pid: 11 }] : [] }),
  });
  assert.deepStrictEqual(calls, [
    ['/PID', '10', '/F'],
    ['/PID', '11', '/F'],
  ]);
});
