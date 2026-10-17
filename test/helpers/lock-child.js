'use strict';

// A child process for the lock tests. Prints one JSON line with its result.
//   node lock-child.js break-and-acquire <lockPath> <startAtMs>
//       wait until startAtMs, break the stale lock if it is one, try to acquire once
//   node lock-child.js hold-file <file> <timeoutMs> <holdMs>
//       run runWithFileLock(file) and stay inside it for holdMs

const lib = require('../../format-java.js');

async function main() {
  const [mode, target, a, b] = process.argv.slice(2);
  if (mode === 'break-and-acquire') {
    const startAt = Number(a);
    while (Date.now() < startAt) {
      /* spin so both children act at the same moment */
    }
    const read = lib.readLockRecord(target);
    const isStale = await lib.isLockStale(read, Date.now());
    const didBreak = isStale ? lib.breakStaleLock(target, read) : false;
    const result = lib.acquireLockFile(target, {});
    console.log(JSON.stringify({ pid: process.pid, isStale, didBreak, kind: result.kind }));
    // Stay alive while the parent looks at the lock.
    setTimeout(() => {}, 1500);
    return;
  }
  if (mode === 'hold-file') {
    const holdMs = Number(b);
    const enteredAt = await lib.runWithFileLock(target, Number(a), async () => {
      const at = Date.now();
      await new Promise((r) => setTimeout(r, holdMs));
      return at;
    });
    console.log(JSON.stringify({ pid: process.pid, enteredAt, leftAt: Date.now() }));
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
