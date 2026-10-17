'use strict';

// However the CLI ends, the nbcode it started and its temporary userdir must
// not outlive it (by more than the JVM's grace period), and nothing else may
// be touched.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { shouldSkipIntegration } = require('../helpers/integration');
const { createIsolatedEnv, listLeftovers, NO_LEFTOVERS } = require('../helpers/env');
const { copyFixture } = require('../helpers/fixtures');
const { resolveTestScript, startCli } = require('../helpers/cli');
const { listProcessesWithToken, waitForNoProcessesWithToken, killOwnPids, spawnDecoy, isAlive } = require('../helpers/processes');

const FILES = ['Alpha.java', 'Beta.java', 'Gamma.java', 'Delta.java', 'Epsilon.java', 'Zeta.java'];
// JVM_EXIT_GRACE_MS + 2 s
const SETTLE_MS = 12000;
const skip = shouldSkipIntegration();
const script = resolveTestScript();

async function waitForServerProcess(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listProcessesWithToken(token).some((p) => /nbexec|java/.test(p.command))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('nbcode never started');
}

/** Run the CLI, end it with `endWith` (a signal, or null to let it end itself), and check nothing is left. */
async function runAndEnd(t, { args = [], endWith = null }) {
  const env = createIsolatedEnv();
  const userdirLike = path.join(env.dir, 'kiro-java-format-userdir-decoy');
  const decoys = [
    spawnDecoy(['--userdir', `${userdirLike}-x`]),
    spawnDecoy(['--userdir', `${userdirLike}/sub`]),
    spawnDecoy([`-Dnetbeans.user=${userdirLike}x`]),
  ];
  try {
    const copy = copyFixture('corruption', path.join(env.dir, 'project'), { gitMarker: true });
    const run = startCli(script, [...args, ...FILES.map((f) => path.join(copy, f))], { cwd: copy, env: env.buildEnv() });
    if (endWith) {
      await waitForServerProcess(env.dir, 60000);
      await new Promise((r) => setTimeout(r, 1000));
      run.child.kill(endWith);
    }
    const result = await run.done;
    const endedAt = Date.now();
    const left = await waitForNoProcessesWithToken(env.dir, SETTLE_MS, { exceptPids: decoys.map((d) => d.pid) });
    t.diagnostic(`left after ${Date.now() - endedAt}ms: ${left.length}`);
    assert.deepStrictEqual(left, [], 'no process of the run is left');
    const leftovers = listLeftovers(env);
    // A CLI killed with SIGKILL cannot release its file lock; the next run breaks it as stale.
    if (endWith === 'SIGKILL') leftovers.fileLocks = [];
    assert.deepStrictEqual(leftovers, NO_LEFTOVERS, 'no temporary userdir or lock is left');
    for (const d of decoys) assert.ok(isAlive(d.pid), `decoy ${d.pid} is alive`);
    return result;
  } finally {
    killOwnPids(decoys.map((d) => d.pid));
    // Only processes still carrying this test's TMPDIR, i.e. our own.
    killOwnPids(listProcessesWithToken(env.dir).map((p) => p.pid));
    env.cleanup();
  }
}

describe('shutdown', { skip }, () => {
  it('startup timeout', async (t) => {
    const r = await runAndEnd(t, { args: ['--timeout', '1'] });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(
      r.stderr,
      'kiro-java-format: Timed out after 1s waiting for the language server. Try --timeout or --verbose.\n'
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`${signal} while running`, async (t) => {
      const r = await runAndEnd(t, { endWith: signal });
      assert.strictEqual(r.signal, signal);
    });
  }

  it('SIGKILL to the CLI', async (t) => {
    const r = await runAndEnd(t, { endWith: 'SIGKILL' });
    assert.strictEqual(r.signal, 'SIGKILL');
  });
});
