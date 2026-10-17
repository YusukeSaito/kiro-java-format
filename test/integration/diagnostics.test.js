'use strict';

// The diagnostics wait on a small Maven project: a file that resolves is
// organized as before; a file that does not is given up on soon after
// indexing, instead of after a minute, with the same result.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { shouldSkipIntegration } = require('../helpers/integration');
const { createIsolatedEnv } = require('../helpers/env');
const { FIXTURES, copyFixture, hashTree } = require('../helpers/fixtures');
const { resolveTestScript, runCli, normalizeOutput } = require('../helpers/cli');
const { buildGolden, expectedForCall, describeMismatch } = require('../helpers/golden');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const FILES = ['A', 'B', 'C', 'D', 'E'].map((n) => `src/main/java/demo/${n}.java`);
const A = FILES[0];
const E = FILES[4];
const skip = shouldSkipIntegration();
const script = resolveTestScript();

const goldens = new Map();
function getGolden(flags) {
  const key = JSON.stringify(flags);
  if (!goldens.has(key)) {
    goldens.set(
      key,
      buildGolden({
        id: 'minimal-maven',
        prepareCopy: (dst) => copyFixture('minimal-maven', dst),
        contentKey: hashTree(path.join(FIXTURES, 'minimal-maven')),
        files: FILES,
        flags,
      })
    );
  }
  return goldens.get(key);
}

function compareWithGolden(label, expected, r, copy, { isVerbose = false } = {}) {
  const problems = [];
  const stdout = normalizeOutput(r.stdout, [copy]);
  if (stdout !== expected.stdout) problems.push(`${label}: stdout differs\n${describeMismatch(expected.stdout, stdout)}`);
  if (!isVerbose && normalizeOutput(r.stderr, [copy]) !== expected.stderr) problems.push(`${label}: stderr differs\n${r.stderr}`);
  if (r.code !== expected.code) problems.push(`${label}: exit ${r.code}, expected ${expected.code}`);
  for (const [rel, want] of expected.contents) {
    const got = fs.readFileSync(path.join(copy, rel), 'utf8');
    if (got !== want) problems.push(`${label}: ${rel} differs from golden\n${describeMismatch(want, got)}`);
  }
  return problems;
}

/** The -v lines that record the indexing and diagnostics timeline. */
function extractTimeline(stderr) {
  return stderr
    .split('\n')
    .filter((l) => /^\[kjf\] \+\d+ms /.test(l))
    .join('\n');
}

async function finishEnv(env) {
  const left = await waitForNoProcessesWithToken(env.dir, 15000);
  killOwnPids(left.map((p) => p.pid));
  env.cleanup();
  assert.deepStrictEqual(left, [], 'no process of the run is left');
}

describe('diagnostics', { skip }, () => {
  it('a resolving file matches the golden; a broken one is given up on soon after indexing', async (t) => {
    const golden = await getGolden([]);
    const env = createIsolatedEnv();
    try {
      const copy = copyFixture('minimal-maven', path.join(env.dir, 'project'));
      const r = await runCli(script, [A, E].map((f) => path.join(copy, f)), { cwd: copy, env: env.buildEnv() });
      assert.deepStrictEqual(compareWithGolden('[A, E]', expectedForCall(golden, [A, E]), r, copy), []);

      const copy2 = copyFixture('minimal-maven', path.join(env.dir, 'project2'));
      const v = await runCli(script, ['-v', path.join(copy2, E)], { cwd: copy2, env: env.buildEnv() });
      assert.deepStrictEqual(compareWithGolden('-v [E]', expectedForCall(golden, [E]), v, copy2, { isVerbose: true }), []);
      const timeline = extractTimeline(v.stderr);
      t.diagnostic(`-v [E] took ${v.elapsedMs}ms\n${normalizeOutput(timeline, [copy2])}`);
      const m = timeline.match(/E\.java: errors after indexing after (\d+)ms/);
      assert.ok(m, `E was not given up on after indexing:\n${timeline}`);
      assert.ok(Number(m[1]) < 10000, `E waited ${m[1]}ms`);
    } finally {
      await finishEnv(env);
    }
  });
});
