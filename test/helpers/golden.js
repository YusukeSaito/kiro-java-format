'use strict';

/*
 * Golden results: what the released script (main, 4b32c7b) produces when it is
 * run on one file at a time, each run with a fresh TMPDIR. That is the output
 * the fixed script has to reproduce byte for byte, whatever the batching.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { WT, runCli, normalizeOutput } = require('./cli');
const { waitForNoProcessesWithToken, killOwnPids } = require('./processes');

const MAIN_COMMIT = '4b32c7b';
const GOLDEN_ROOT = path.join(os.tmpdir(), 'kjf-golden');

/**
 * Write main's format-java.js to $TMPDIR/kjf-golden/main/format-java.js.
 * The basename stays format-java.js: the lock code identifies the tool's own
 * processes by it.
 */
function extractMainScript() {
  const dir = path.join(GOLDEN_ROOT, 'main');
  const file = path.join(dir, 'format-java.js');
  const source = execFileSync('git', ['-C', WT, 'show', `${MAIN_COMMIT}:format-java.js`]);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || !fs.readFileSync(file).equals(source)) fs.writeFileSync(file, source);
  return file;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Run main once per file, in order, on one fresh copy. */
async function runMainSequence({ mainScript, prepareCopy, files, flags, timeoutMs }) {
  const work = fs.mkdtempSync(path.join(GOLDEN_ROOT, 'work-'));
  const copy = path.join(work, 'project');
  try {
    prepareCopy(copy);
    const perFile = [];
    for (const rel of files) {
      const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
      const env = { ...process.env, TMPDIR: tmp, KIRO_JAVA_FORMAT_CACHE: path.join(tmp, 'cache') };
      const r = await runCli(mainScript, [...flags, path.join(copy, rel)], { cwd: copy, env, timeoutMs });
      // main does not wait for its JVM; let it go before the next run.
      const left = await waitForNoProcessesWithToken(tmp, 15000);
      killOwnPids(left.map((p) => p.pid));
      perFile.push({
        file: rel,
        stdout: normalizeOutput(r.stdout, [copy]),
        stderr: normalizeOutput(r.stderr, [copy]),
        code: r.code,
        contentAfter: fs.readFileSync(path.join(copy, rel), 'utf8'),
      });
    }
    return perFile;
  } finally {
    const left = await waitForNoProcessesWithToken(work, 15000);
    killOwnPids(left.map((p) => p.pid));
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function isSameBuild(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build (or load from the cache) the golden result for running `files` in
 * order with `flags`.
 *
 * A golden is accepted only when two complete builds match byte for byte.
 * main itself reopens the document after organizing, so even a one-file run
 * of main can hit the race (`Internal error.`, or a corrupted file) when the
 * machine is busy. Such a build is not the reference, so up to `maxBuilds`
 * builds are made until two agree; if none do, this throws.
 * `contentKey` must change whenever what `prepareCopy` produces changes.
 */
async function buildGolden({
  id,
  prepareCopy,
  contentKey,
  files,
  flags = [],
  isParallelBuild = false,
  timeoutMs = 300000,
  maxBuilds = 4,
}) {
  const mainScript = extractMainScript();
  const key = sha256(
    JSON.stringify({ main: sha256(fs.readFileSync(mainScript)), id, contentKey, files, flags })
  );
  const cacheFile = path.join(GOLDEN_ROOT, 'cache', `${key}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const build = () => runMainSequence({ mainScript, prepareCopy, files, flags, timeoutMs });
  const builds = isParallelBuild ? await Promise.all([build(), build()]) : [await build()];
  let accepted = isParallelBuild && isSameBuild(builds[0], builds[1]) ? builds[0] : null;
  while (!accepted && builds.length < maxBuilds) {
    const next = await build();
    accepted = builds.find((b) => isSameBuild(b, next)) || null;
    builds.push(next);
  }
  if (!accepted) {
    try {
      assert.deepStrictEqual(builds[1], builds[0]);
    } catch (err) {
      throw new Error(`golden for ${id} ${JSON.stringify(flags)}: no two of ${builds.length} builds agree:\n${err.message}`);
    }
  }
  const golden = { id, files, flags, perFile: accepted, buildCount: builds.length };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(golden));
  return golden;
}

/**
 * What one call over `files` must print and leave on disk.
 *
 * Each occurrence of a file maps to its next occurrence in the golden run, so
 * a repeated argument takes the golden of the repeat. stdout and stderr are the
 * per-file outputs in order, the exit code is the largest, and the contents
 * are each file's content after its last occurrence.
 */
function expectedForCall(golden, files) {
  const used = new Map();
  let stdout = '';
  let stderr = '';
  let code = 0;
  const contents = new Map();
  for (const rel of files) {
    const nth = used.get(rel) || 0;
    used.set(rel, nth + 1);
    const entries = golden.perFile.filter((e) => e.file === rel);
    const entry = entries[nth];
    if (!entry) throw new Error(`golden has no occurrence ${nth + 1} of ${rel}`);
    stdout += entry.stdout;
    stderr += entry.stderr;
    code = Math.max(code, entry.code);
    contents.set(rel, entry.contentAfter);
  }
  return { stdout, stderr, code, contents };
}

/** The first `limit` differing lines of two texts, for a readable failure. */
function describeMismatch(expected, actual, limit = 20) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i++) {
    if (a[i] !== b[i]) out.push(`  line ${i + 1}:\n    expected: ${JSON.stringify(a[i])}\n    actual:   ${JSON.stringify(b[i])}`);
  }
  return out.join('\n');
}

module.exports = { MAIN_COMMIT, GOLDEN_ROOT, extractMainScript, buildGolden, expectedForCall, describeMismatch };
