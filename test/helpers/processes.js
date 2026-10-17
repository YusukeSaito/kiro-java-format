'use strict';

const { spawn, execFileSync } = require('child_process');

/** Processes whose command line contains `token` (never this test process). */
function listProcessesWithToken(token) {
  const out = execFileSync('ps', ['-ww', '-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (pid === process.pid) continue;
    if (m[2].includes(token)) found.push({ pid, command: m[2] });
  }
  return found;
}

/** Wait until no process carries `token`; returns what is still left at the deadline. */
async function waitForNoProcessesWithToken(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = listProcessesWithToken(token);
    if (left.length === 0 || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Kill what is left of the processes a test started, by pid.
 *
 * Only processes carrying the test's own TMPDIR token are passed here, so
 * nothing else (the editor's own language server in particular) is touched.
 */
function killOwnPids(pids, signal = 'SIGKILL') {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** A long-lived node process with the given arguments on its command line. */
function spawnDecoy(args) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '--', ...args], {
    stdio: 'ignore',
  });
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Busy loops to load the machine while a race is being provoked. */
function startBusyLoops(count) {
  const pids = [];
  for (let i = 0; i < count; i++) {
    const child = spawn(process.execPath, ['-e', 'for (;;) {}', '--', 'kjf-busy-loop'], { stdio: 'ignore' });
    pids.push(child.pid);
  }
  return pids;
}

module.exports = {
  listProcessesWithToken,
  waitForNoProcessesWithToken,
  killOwnPids,
  spawnDecoy,
  isAlive,
  startBusyLoops,
};
