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

/** Move class A to package demo.other and make B use it from there (B is left unformatted). */
function moveTypeToOtherPackage(copy) {
  const demo = path.join(copy, 'src', 'main', 'java', 'demo');
  fs.rmSync(path.join(demo, 'A.java'));
  fs.mkdirSync(path.join(demo, 'other'));
  fs.writeFileSync(
    path.join(demo, 'other', 'A.java'),
    'package demo.other;\n\npublic class A {\n    public static String hello() {\n        return "hello";\n    }\n}\n'
  );
  fs.writeFileSync(
    path.join(demo, 'B.java'),
    [
      'package demo;',
      '',
      'import java.util.Set;',
      'import demo.other.A;',
      'import org.apache.commons.lang3.StringUtils;',
      'import java.util.TreeSet;',
      'import java.util.Optional;',
      '',
      'public class B {',
      '    private final Set<String> names = new TreeSet<>();',
      '',
      '  public boolean register(String name){',
      '        String key = StringUtils.lowerCase(StringUtils.strip(name + A.hello()));',
      '      return StringUtils.isNotEmpty(key) && names.add(key);',
      '        }',
      '',
      'public int count() { return names.size(); }',
      '}',
      '',
    ].join('\n')
  );
}

let movedGolden = null;
function getMovedGolden() {
  if (!movedGolden) {
    movedGolden = buildGolden({
      id: 'minimal-maven-moved',
      prepareCopy: (dst) => {
        copyFixture('minimal-maven', dst);
        moveTypeToOtherPackage(dst);
      },
      contentKey: `${hashTree(path.join(FIXTURES, 'minimal-maven'))}:moved-v1`,
      files: [FILES[1]],
      flags: [],
    });
  }
  return movedGolden;
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

  it('a cached index that is out of date gives the same result as a fresh one', async (t) => {
    const golden = await getMovedGolden();
    const env = createIsolatedEnv();
    try {
      const copy = copyFixture('minimal-maven', path.join(env.dir, 'project'));
      const B = FILES[1];
      const first = await runCli(script, ['-v', path.join(copy, B)], { cwd: copy, env: env.buildEnv() });
      assert.strictEqual(first.code, 0, first.stderr);
      assert.match(first.stderr, /userdir \(cached\):/);

      // The cached index now knows demo.A; the project moves it to demo.other.
      moveTypeToOtherPackage(copy);
      const second = await runCli(script, ['-v', path.join(copy, B)], { cwd: copy, env: env.buildEnv() });
      const timeline = extractTimeline(second.stderr);
      t.diagnostic(`second run ${second.elapsedMs}ms\n${normalizeOutput(timeline, [copy])}`);
      assert.match(second.stderr, /userdir \(cached\):/, 'the second run reused the cached userdir');
      assert.match(second.stderr, /waited \d+ms for the previous server/);
      assert.deepStrictEqual(compareWithGolden('cached B', expectedForCall(golden, [B]), second, copy, { isVerbose: true }), []);
      const requested = timeline.search(/requested fresh diagnostics for \S*B\.java/);
      assert.ok(requested >= 0, `no fresh diagnostics were requested:\n${timeline}`);
      assert.match(timeline.slice(requested), /diagnostics \S*B\.java: \d+ error/, 'diagnostics arrived after the request');
    } finally {
      await finishEnv(env);
    }
  });

  it('a cached index of a project without a build file still sees indexing complete', async (t) => {
    const env = createIsolatedEnv();
    try {
      for (const round of [1, 2]) {
        const copy = path.join(env.dir, 'project');
        if (round === 1) copyFixture('corruption', copy, { gitMarker: true });
        const r = await runCli(script, ['-v', path.join(copy, 'Alpha.java')], { cwd: copy, env: env.buildEnv() });
        assert.strictEqual(r.code, 0, r.stderr);
        assert.match(r.stderr, /userdir \(cached\):/);
        const timeline = extractTimeline(r.stderr);
        t.diagnostic(`round ${round} ${r.elapsedMs}ms\n${normalizeOutput(timeline, [copy])}`);
        assert.match(timeline, /indexing complete \(1\)/);
      }
    } finally {
      await finishEnv(env);
    }
  });

  it('batch, parallel and --check runs match the golden', async (t) => {
    const golden = await getGolden([]);
    const goldenCheck = await getGolden(['--check']);
    const env = createIsolatedEnv();
    const problems = [];
    try {
      const batch = copyFixture('minimal-maven', path.join(env.dir, 'batch'));
      const r = await runCli(script, FILES.map((f) => path.join(batch, f)), { cwd: batch, env: env.buildEnv() });
      problems.push(...compareWithGolden('batch', expectedForCall(golden, FILES), r, batch));

      const par = copyFixture('minimal-maven', path.join(env.dir, 'parallel'));
      const results = await Promise.all(
        FILES.map((f) => runCli(script, [path.join(par, f)], { cwd: par, env: env.buildEnv() }).then((x) => [f, x]))
      );
      for (const [f, x] of results) problems.push(...compareWithGolden(`parallel ${f}`, expectedForCall(golden, [f]), x, par));

      const check = copyFixture('minimal-maven', path.join(env.dir, 'check'));
      const c = await runCli(script, ['--check', ...FILES.map((f) => path.join(check, f))], { cwd: check, env: env.buildEnv() });
      problems.push(...compareWithGolden('--check', expectedForCall(goldenCheck, FILES), c, check));
      t.diagnostic(`batch ${r.elapsedMs}ms, parallel ${results.map(([, x]) => x.elapsedMs).join('/')}ms, --check ${c.elapsedMs}ms`);
    } finally {
      await finishEnv(env);
    }
    assert.deepStrictEqual(problems, []);
  });
});
