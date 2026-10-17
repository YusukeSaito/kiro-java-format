'use strict';

// A call over files of two sibling projects must not leave the cached index of
// the first project knowing the second one: the next call over the first
// project alone has to match a fresh server. Also: the first call of a project
// measures it in a temporary userdir; only a large one gets a cached index.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldSkipIntegration } = require('../helpers/integration');
const { createIsolatedEnv, markRecordedProjectsLarge } = require('../helpers/env');
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
    const times = [];
    // The cache is keyed by the project's path, so every call works on the
    // same copy, refilled from the fixture.
    const copy = path.join(env.dir, 'project');
    const run = async (label, rels, expectedLog) => {
      fs.rmSync(copy, { recursive: true, force: true });
      copyFixture('cross-project', copy);
      const r = await runCli(script, ['-v', ...rels.map((f) => path.join(copy, f))], { cwd: copy, env: env.buildEnv() });
      assert.match(r.stderr, expectedLog, label);
      problems.push(...compare(label, expectedForCall(golden, rels), { ...r, stderr: '' }, copy));
      times.push(`${label} ${r.elapsedMs}ms`);
    };
    try {
      // a indexes fast: the first call measures it in a temporary userdir.
      await run('[a/X] first', [X], /indexing time not measured yet; using a temporary one/);
      // Make a look large, so it uses a cached index from now on.
      markRecordedProjectsLarge(env);
      await run('[a/X] cached, cold', [X], /userdir \(cached\):/);
      // A call over both projects must not use (and so cannot teach b to) a's cached index.
      await run('[a/X, b/Y]', [X, Y], /more than one project root; using a temporary userdir/);
      await run('[a/X] cached, warm', [X], /userdir \(cached\):/);
      t.diagnostic(times.join(', '));
    } finally {
      const left = await waitForNoProcessesWithToken(env.dir, 15000);
      killOwnPids(left.map((p) => p.pid));
      env.cleanup();
    }
    assert.deepStrictEqual(problems, []);
  });
});
