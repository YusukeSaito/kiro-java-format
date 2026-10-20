'use strict';

/*
 * Reproduces the corruption seen when several files go through one language
 * server, or several CLIs run at once, and checks every result against the
 * golden (main, one file at a time).
 *
 * KJF_REPRO_ROUNDS (default 3), KJF_REPRO_PARALLEL (default 6) and
 * KJF_REPRO_STRESS=1 (busy loops on every core while the runs go) raise the
 * pressure when the race does not show up.
 */

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
const { waitForNoProcessesWithToken, killOwnPids, startBusyLoops } = require('../helpers/processes');

const FILES = ['Alpha.java', 'Beta.java', 'Gamma.java', 'Delta.java', 'Epsilon.java', 'Zeta.java'];
const DUPLICATES = ['Alpha.java', 'Beta.java', 'Alpha.java', 'Gamma.java', 'Alpha.java'];
const ROUNDS = parseInt(process.env.KJF_REPRO_ROUNDS || '3', 10);
const PARALLEL = parseInt(process.env.KJF_REPRO_PARALLEL || '6', 10);
const IS_STRESS = process.env.KJF_REPRO_STRESS === '1';
const RUN_TIMEOUT_MS = 300000;
const REAL_CACHE = path.join(os.homedir(), 'Library', 'Caches', 'kiro-java-format');
const HAD_REAL_CACHE = fs.existsSync(REAL_CACHE);

const skip = shouldSkipIntegration();
const script = resolveTestScript();

const goldens = new Map();
function getGolden(files, flags) {
  const key = JSON.stringify([files, flags]);
  if (!goldens.has(key)) {
    goldens.set(
      key,
      buildGolden({
        id: 'corruption',
        prepareCopy: (dst) => copyFixture('corruption', dst, { gitMarker: true }),
        contentKey: hashTree(path.join(FIXTURES, 'corruption')),
        files,
        flags,
      })
    );
  }
  return goldens.get(key);
}

function compareOutput(label, expected, result, copy) {
  const problems = [];
  const stdout = normalizeOutput(result.stdout, [copy]);
  const stderr = normalizeOutput(result.stderr, [copy]);
  if (stdout !== expected.stdout) problems.push(`${label}: stdout differs\n${describeMismatch(expected.stdout, stdout)}`);
  if (stderr !== expected.stderr) problems.push(`${label}: stderr differs\n${describeMismatch(expected.stderr, stderr)}`);
  if (result.code !== expected.code) {
    problems.push(`${label}: exit ${result.code} (signal ${result.signal}), expected ${expected.code}`);
  }
  return problems;
}

function compareContents(label, contents, copy) {
  const problems = [];
  for (const [rel, want] of contents) {
    const got = fs.readFileSync(path.join(copy, rel), 'utf8');
    if (got !== want) problems.push(`${label}: ${rel} differs from golden\n${describeMismatch(want, got)}`);
  }
  return problems;
}

/** Run `fn` with every core loaded when KJF_REPRO_STRESS=1. */
async function runUnderStress(fn) {
  const pids = IS_STRESS ? startBusyLoops(os.availableParallelism ? os.availableParallelism() : os.cpus().length) : [];
  try {
    return await fn();
  } finally {
    killOwnPids(pids);
  }
}

async function finishEnv(t, env) {
  const left = await waitForNoProcessesWithToken(env.dir, 20000);
  if (left.length > 0) t.diagnostic(`killed ${left.length} leftover process(es) of ${env.dir}`);
  killOwnPids(left.map((p) => p.pid));
  env.cleanup();
  if (!HAD_REAL_CACHE) assert.ok(!fs.existsSync(REAL_CACHE), 'the real user cache must not be created by tests');
}

/** Counts runs, and the runs that did not match the golden. */
function createTally() {
  return {
    runs: 0,
    failedRuns: 0,
    problems: [],
    record(problems) {
      this.runs++;
      if (problems.length > 0) this.failedRuns++;
      this.problems.push(...problems);
    },
  };
}

function report(t, name, tally) {
  t.diagnostic(`${name}: ${tally.failedRuns} of ${tally.runs} run(s) did not match the golden (${script})`);
  assert.strictEqual(tally.problems.length, 0, tally.problems.join('\n\n'));
}

describe('corruption', { skip }, () => {
  it('batch', async (t) => {
    const golden = await getGolden(FILES, []);
    const expected = expectedForCall(golden, FILES);
    const env = createIsolatedEnv();
    const tally = createTally();
    try {
      await runUnderStress(async () => {
        for (let round = 0; round < ROUNDS; round++) {
          const copy = copyFixture('corruption', path.join(env.dir, `batch-${round}`), { gitMarker: true });
          const r = await runCli(script, FILES.map((f) => path.join(copy, f)), {
            cwd: copy,
            env: env.buildEnv(),
            timeoutMs: RUN_TIMEOUT_MS,
          });
          tally.record([
            ...compareOutput(`round ${round}`, expected, r, copy),
            ...compareContents(`round ${round}`, expected.contents, copy),
          ]);
        }
      });
    } finally {
      await finishEnv(t, env);
    }
    report(t, 'batch', tally);
  });

  it('parallel-distinct', async (t) => {
    const golden = await getGolden(FILES, []);
    const env = createIsolatedEnv();
    const tally = createTally();
    try {
      await runUnderStress(async () => {
        for (let round = 0; round < ROUNDS; round++) {
          const copies = [];
          for (let c = 0; c * FILES.length < PARALLEL; c++) {
            copies.push(copyFixture('corruption', path.join(env.dir, `par-${round}-${c}`), { gitMarker: true }));
          }
          const launches = [];
          for (let i = 0; i < PARALLEL; i++) {
            const copy = copies[Math.floor(i / FILES.length)];
            const rel = FILES[i % FILES.length];
            launches.push(
              runCli(script, [path.join(copy, rel)], { cwd: copy, env: env.buildEnv(), timeoutMs: RUN_TIMEOUT_MS }).then(
                (r) => ({ r, copy, rel })
              )
            );
          }
          for (const { r, copy, rel } of await Promise.all(launches)) {
            const expected = expectedForCall(golden, [rel]);
            tally.record([
              ...compareOutput(`round ${round} ${rel}`, expected, r, copy),
              ...compareContents(`round ${round}`, expected.contents, copy),
            ]);
          }
        }
      });
    } finally {
      await finishEnv(t, env);
    }
    report(t, 'parallel-distinct', tally);
  });

  it('parallel-overlap', async (t) => {
    const golden = await getGolden(FILES, []);
    const expected = expectedForCall(golden, FILES);
    const env = createIsolatedEnv();
    const tally = createTally();
    try {
      await runUnderStress(async () => {
        const problems = [];
        const copy = copyFixture('corruption', path.join(env.dir, 'overlap'), { gitMarker: true });
        const orders = [FILES, [...FILES].reverse()];
        const results = await Promise.all(
          orders.map((files) =>
            runCli(script, files.map((f) => path.join(copy, f)), {
              cwd: copy,
              env: env.buildEnv(),
              timeoutMs: RUN_TIMEOUT_MS,
            })
          )
        );
        results.forEach((r, i) => {
          if (r.code !== 0) problems.push(`call ${i}: exit ${r.code} (signal ${r.signal})`);
          if (r.stderr !== '') problems.push(`call ${i}: stderr not empty\n${r.stderr}`);
        });
        // Serialized, one call formats a file and the other then finds it
        // done: the golden line for the first, `unchanged` for the second.
        const lines = results.flatMap((r) => normalizeOutput(r.stdout, [copy]).split('\n').filter(Boolean));
        for (const rel of FILES) {
          const want = golden.perFile.find((e) => e.file === rel).stdout.split('\n').filter(Boolean);
          const second = want.map((l) => l.replace(/^formatted: /, 'unchanged: '));
          const expectedLines = [...want, ...second].sort();
          const target = `<ROOT>/${rel}`;
          const got = lines.filter((l) => l.endsWith(target)).sort();
          if (JSON.stringify(got) !== JSON.stringify(expectedLines)) {
            problems.push(`${rel}: lines ${JSON.stringify(got)}, expected ${JSON.stringify(expectedLines)}`);
          }
        }
        problems.push(...compareContents('overlap', expected.contents, copy));
        tally.record(problems);
      });
    } finally {
      await finishEnv(t, env);
    }
    report(t, 'parallel-overlap', tally);
  });

  // [A, B] and [B, A] at once on one copy: each call meets the other's first
  // file. Neither may wait for the other until --timeout (a lock wait that
  // reaches it makes the call last at least that long), and the two must
  // print and leave what one call after the other would.
  it('parallel-swapped-pair', async (t) => {
    const golden = await getGolden(FILES, []);
    const pair = FILES.slice(0, 2);
    const expected = expectedForCall(golden, pair);
    const timeoutSec = 60;
    const env = createIsolatedEnv();
    const tally = createTally();
    try {
      await runUnderStress(async () => {
        for (let round = 0; round < ROUNDS; round++) {
          const problems = [];
          const copy = copyFixture('corruption', path.join(env.dir, `swap-${round}`), { gitMarker: true });
          const results = await Promise.all(
            [pair, [...pair].reverse()].map((files) =>
              runCli(script, ['--timeout', String(timeoutSec), ...files.map((f) => path.join(copy, f))], {
                cwd: copy,
                env: env.buildEnv(),
                timeoutMs: RUN_TIMEOUT_MS,
              })
            )
          );
          results.forEach((r, i) => {
            t.diagnostic(`round ${round} call ${i}: ${r.elapsedMs} ms`);
            const label = `round ${round} call ${i}`;
            if (r.code !== 0) problems.push(`${label}: exit ${r.code} (signal ${r.signal})`);
            if (r.stderr !== '') problems.push(`${label}: stderr not empty\n${r.stderr}`);
            if (r.elapsedMs >= timeoutSec * 1000) problems.push(`${label}: took ${r.elapsedMs} ms, --timeout or more`);
          });
          const lines = results.flatMap((r) => normalizeOutput(r.stdout, [copy]).split('\n').filter(Boolean));
          for (const rel of pair) {
            const want = golden.perFile.find((e) => e.file === rel).stdout.split('\n').filter(Boolean);
            const second = want.map((l) => l.replace(/^formatted: /, 'unchanged: '));
            const expectedLines = [...want, ...second].sort();
            const got = lines.filter((l) => l.endsWith(`<ROOT>/${rel}`)).sort();
            if (JSON.stringify(got) !== JSON.stringify(expectedLines)) {
              problems.push(`round ${round} ${rel}: lines ${JSON.stringify(got)}, expected ${JSON.stringify(expectedLines)}`);
            }
          }
          problems.push(...compareContents(`round ${round}`, expected.contents, copy));
          tally.record(problems);
        }
      });
    } finally {
      await finishEnv(t, env);
    }
    report(t, 'parallel-swapped-pair', tally);
  });

  it('duplicates', async (t) => {
    const goldenWrite = await getGolden(DUPLICATES, []);
    const goldenCheck = await getGolden(DUPLICATES, ['--check']);
    const env = createIsolatedEnv();
    const tally = createTally();
    try {
      await runUnderStress(async () => {
        for (let round = 0; round < ROUNDS; round++) {
          for (const [flags, golden] of [
            [[], goldenWrite],
            [['--check'], goldenCheck],
          ]) {
            const label = `round ${round} ${flags.join(' ') || 'write'}`;
            const expected = expectedForCall(golden, DUPLICATES);
            const copy = copyFixture('corruption', path.join(env.dir, `dup-${round}-${flags.length}`), { gitMarker: true });
            const r = await runCli(script, [...flags, ...DUPLICATES.map((f) => path.join(copy, f))], {
              cwd: copy,
              env: env.buildEnv(),
              timeoutMs: RUN_TIMEOUT_MS,
            });
            tally.record([
              ...compareOutput(label, expected, r, copy),
              ...compareContents(label, expected.contents, copy),
            ]);
          }
        }
      });
    } finally {
      await finishEnv(t, env);
    }
    report(t, 'duplicates', tally);
  });
});
