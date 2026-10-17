'use strict';

// Acceptance on a copy of a real Lombok project (KJF_REAL_PROJECT=<dir>; the
// original is only read). 20 files whose Lombok members never resolve under
// nbcode, so organizing is always skipped and only formatting applies.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldSkipIntegration } = require('../helpers/integration');
const { createIsolatedEnv } = require('../helpers/env');
const { resolveTestScript, runCli, normalizeOutput } = require('../helpers/cli');
const { buildGolden, expectedForCall, describeMismatch } = require('../helpers/golden');
const { prepareRealProjectBase, hashRealProjectBase, selectRealProjectFiles } = require('../helpers/real-project');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const PROJECT = process.env.KJF_REAL_PROJECT;
const skip = shouldSkipIntegration() || (PROJECT ? false : 'set KJF_REAL_PROJECT to a copy-able real project');
const script = resolveTestScript();
const BASE = path.join(os.tmpdir(), 'kjf-real', 'base');
const RUN_TIMEOUT_MS = 1200000;

let files;
let golden;

function copyBase(dst) {
  fs.cpSync(BASE, dst, { recursive: true });
  return dst;
}

/** What --check prints for the golden write run: main's branches, file by file. */
function deriveCheckExpectation(base, rels) {
  const write = expectedForCall(golden, rels);
  let stdout = '';
  let code = 0;
  for (const rel of rels) {
    const entry = golden.perFile.find((e) => e.file === rel);
    const original = fs.readFileSync(path.join(base, rel), 'utf8');
    const lines = entry.stdout.split('\n').filter(Boolean);
    const isChanged = entry.contentAfter !== original;
    if (isChanged) code = 1;
    stdout += lines
      .map((l) => l.replace(/^(formatted|unchanged): /, isChanged ? 'would reformat: ' : 'unchanged: '))
      .map((l) => `${l}\n`)
      .join('');
  }
  const contents = new Map(rels.map((rel) => [rel, fs.readFileSync(path.join(base, rel), 'utf8')]));
  return { stdout, stderr: write.stderr, code, contents };
}

function compare(label, expected, r, copy) {
  const problems = [];
  const stdout = normalizeOutput(r.stdout, [copy]);
  if (stdout !== expected.stdout) problems.push(`${label}: stdout differs\n${describeMismatch(expected.stdout, stdout)}`);
  if (normalizeOutput(r.stderr, [copy]) !== expected.stderr) {
    problems.push(`${label}: stderr differs\n${r.stderr.slice(0, 2000)}`);
  }
  if (r.code !== expected.code) problems.push(`${label}: exit ${r.code}, expected ${expected.code}`);
  for (const [rel, want] of expected.contents) {
    const got = fs.readFileSync(path.join(copy, rel), 'utf8');
    if (got !== want) problems.push(`${label}: ${rel} differs from golden\n${describeMismatch(want, got)}`);
  }
  return problems;
}

describe('real project', { skip }, () => {
  before(async () => {
    if (!fs.existsSync(BASE)) prepareRealProjectBase(PROJECT, BASE);
    files = selectRealProjectFiles(BASE);
    golden = await buildGolden({
      id: 'real-project',
      prepareCopy: copyBase,
      contentKey: hashRealProjectBase(BASE, files),
      files,
      flags: [],
      isParallelBuild: true,
    });
  });

  it('20 files: one call, 4 parallel calls, 2 overlapping calls, and --check match the golden', async (t) => {
    const env = createIsolatedEnv();
    const problems = [];
    const times = [];
    try {
      const batch = copyBase(path.join(env.dir, 'batch'));
      const runIn = (dir, rels, flags = []) =>
        runCli(script, [...flags, ...rels.map((f) => path.join(dir, f))], {
          cwd: dir,
          env: env.buildEnv(),
          timeoutMs: RUN_TIMEOUT_MS,
        });
      const r = await runIn(batch, files);
      times.push(`batch ${r.elapsedMs}`);
      assert.ok(!/Timed out/.test(r.stderr), 'the 20-file call does not time out');
      problems.push(...compare('batch', expectedForCall(golden, files), r, batch));

      const par = copyBase(path.join(env.dir, 'parallel'));
      const groups = [0, 1, 2, 3].map((g) => files.slice(g * 5, g * 5 + 5));
      const results = await Promise.all(groups.map((g) => runIn(par, g)));
      results.forEach((x, i) => {
        times.push(`parallel[${i}] ${x.elapsedMs}`);
        problems.push(...compare(`parallel ${i}`, expectedForCall(golden, groups[i]), x, par));
      });

      const overlap = copyBase(path.join(env.dir, 'overlap'));
      const both = await Promise.all([files, [...files].reverse()].map((order) => runIn(overlap, order)));
      both.forEach((x, i) => {
        times.push(`overlap[${i}] ${x.elapsedMs}`);
        if (x.code !== 0) problems.push(`overlap ${i}: exit ${x.code}`);
        if (x.stderr !== '') problems.push(`overlap ${i}: stderr ${x.stderr.slice(0, 2000)}`);
      });
      const lines = both.flatMap((x) => normalizeOutput(x.stdout, [overlap]).split('\n').filter(Boolean));
      for (const rel of files) {
        const want = golden.perFile.find((e) => e.file === rel).stdout.split('\n').filter(Boolean);
        const expected = [...want, ...want.map((l) => l.replace(/^formatted: /, 'unchanged: '))].sort();
        const got = lines.filter((l) => l.endsWith(`<ROOT>/${rel}`)).sort();
        if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`overlap ${rel}: ${JSON.stringify(got)}`);
      }
      for (const [rel, want] of expectedForCall(golden, files).contents) {
        if (fs.readFileSync(path.join(overlap, rel), 'utf8') !== want) problems.push(`overlap: ${rel} differs from golden`);
      }

      const check = copyBase(path.join(env.dir, 'check'));
      const c = await runIn(check, files, ['--check']);
      times.push(`check ${c.elapsedMs}`);
      problems.push(...compare('--check', deriveCheckExpectation(BASE, files), c, check));
      t.diagnostic(`times (ms): ${times.join(', ')}`);
    } finally {
      const left = await waitForNoProcessesWithToken(env.dir, 20000);
      killOwnPids(left.map((p) => p.pid));
      env.cleanup();
    }
    assert.deepStrictEqual(problems, []);
  });
});
