'use strict';

// A call over files of two sibling projects must not leave the cached index of
// the first project knowing the second one: the next call over the first
// project alone has to match a fresh server.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldSkipIntegration } = require('../helpers/integration');
const { createIsolatedEnv } = require('../helpers/env');
const { FIXTURES, copyFixture, hashTree } = require('../helpers/fixtures');
const { resolveTestScript, runCli, normalizeOutput } = require('../helpers/cli');
const { buildGolden, expectedForCall, describeMismatch } = require('../helpers/golden');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const X = 'a/src/main/java/a/X.java';
const Y = 'b/src/main/java/b/Y.java';
const B_IN_M2 = path.join(os.homedir(), '.m2', 'repository', 'kjf', 'test', 'kjf-b');
const skip =
  shouldSkipIntegration() || (fs.existsSync(B_IN_M2) ? 'kjf.test:kjf-b is in ~/.m2, so b would resolve from the jar' : false);
const script = resolveTestScript();

function compare(label, expected, r, copy) {
  const problems = [];
  const stdout = normalizeOutput(r.stdout, [copy]);
  if (stdout !== expected.stdout) problems.push(`${label}: stdout differs\n${describeMismatch(expected.stdout, stdout)}`);
  if (normalizeOutput(r.stderr, [copy]) !== expected.stderr) problems.push(`${label}: stderr differs\n${r.stderr}`);
  if (r.code !== expected.code) problems.push(`${label}: exit ${r.code}, expected ${expected.code}`);
  for (const [rel, want] of expected.contents) {
    const got = fs.readFileSync(path.join(copy, rel), 'utf8');
    if (got !== want) problems.push(`${label}: ${rel} differs from golden\n${describeMismatch(want, got)}`);
  }
  return problems;
}

describe('userdir', { skip }, () => {
  it('[a/X, b/Y] then [a/X] both match the golden', async (t) => {
    // The root of a call is the first file's (a), so the golden runs each
    // file on its own with that root.
    const golden = await buildGolden({
      id: 'cross-project',
      prepareCopy: (dst) => copyFixture('cross-project', dst),
      contentKey: hashTree(path.join(FIXTURES, 'cross-project')),
      files: [X, Y],
      flags: ['--root', '{COPY}/a'],
    });
    const env = createIsolatedEnv();
    const problems = [];
    try {
      const first = copyFixture('cross-project', path.join(env.dir, 'first'));
      const r1 = await runCli(script, ['-v', ...[X, Y].map((f) => path.join(first, f))], { cwd: first, env: env.buildEnv() });
      assert.match(r1.stderr, /more than one project root; using a temporary userdir/);
      problems.push(...compare('[a/X, b/Y]', expectedForCall(golden, [X, Y]), { ...r1, stderr: '' }, first));

      const second = copyFixture('cross-project', path.join(env.dir, 'second'));
      const r2 = await runCli(script, ['-v', path.join(second, X)], { cwd: second, env: env.buildEnv() });
      assert.match(r2.stderr, /userdir \(cached\):/, 'the second call uses the cached userdir');
      problems.push(...compare('[a/X]', expectedForCall(golden, [X]), { ...r2, stderr: '' }, second));

      // And the cached userdir, now warm, still gives the same result.
      const third = copyFixture('cross-project', path.join(env.dir, 'third'));
      const r3 = await runCli(script, [path.join(third, X)], { cwd: third, env: env.buildEnv() });
      problems.push(...compare('[a/X] warm', expectedForCall(golden, [X]), r3, third));
      t.diagnostic(`${r1.elapsedMs}ms, ${r2.elapsedMs}ms, ${r3.elapsedMs}ms`);
    } finally {
      const left = await waitForNoProcessesWithToken(env.dir, 15000);
      killOwnPids(left.map((p) => p.pid));
      env.cleanup();
    }
    assert.deepStrictEqual(problems, []);
  });
});
