'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A private TMPDIR and cache for one test.
 *
 * Every CLI the tests start runs with this environment, so the language
 * server's userdir, the index cache and the lock files all land under `dir`.
 * Nothing is written to the real user cache, and the directory name doubles as
 * the token that identifies the processes the test started.
 */
function createIsolatedEnv(prefix = 'kjf-t-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cache = path.join(dir, 'cache');
  return {
    dir,
    TMPDIR: dir,
    KIRO_JAVA_FORMAT_CACHE: cache,
    buildEnv(extra = {}) {
      return { ...process.env, TMPDIR: dir, KIRO_JAVA_FORMAT_CACHE: cache, ...extra };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * What a finished run must not leave in the environment: temporary userdirs,
 * owner locks, NetBeans locks in cached userdirs, and file locks.
 */
function listLeftovers(env) {
  const temporaryUserdirs = fs.readdirSync(env.dir).filter((n) => n.startsWith('kiro-java-format-userdir-'));
  const ownerLocks = [];
  const netbeansLocks = [];
  let fileLocks = [];
  const cache = env.KIRO_JAVA_FORMAT_CACHE;
  if (fs.existsSync(cache) && fs.statSync(cache).isDirectory()) {
    for (const name of fs.readdirSync(cache)) {
      if (name === 'locks') {
        fileLocks = fs.readdirSync(path.join(cache, name));
        continue;
      }
      if (fs.existsSync(path.join(cache, name, 'owner.lock'))) ownerLocks.push(name);
      if (fs.existsSync(path.join(cache, name, 'userdir', 'lock'))) netbeansLocks.push(name);
    }
  }
  return { temporaryUserdirs, ownerLocks, netbeansLocks, fileLocks };
}

const NO_LEFTOVERS = { temporaryUserdirs: [], ownerLocks: [], netbeansLocks: [], fileLocks: [] };

/** The project records (project.json) in the environment's cache: [{ key, record }]. */
function listProjectRecords(env) {
  const cache = env.KIRO_JAVA_FORMAT_CACHE;
  if (!fs.existsSync(cache)) return [];
  return fs
    .readdirSync(cache)
    .filter((key) => fs.existsSync(path.join(cache, key, 'project.json')))
    .map((key) => ({ key, record: JSON.parse(fs.readFileSync(path.join(cache, key, 'project.json'), 'utf8')) }));
}

/**
 * Make every project recorded in the cache look large, so the next run uses
 * the cached index. Tests of the cached path need this: the fixtures index in
 * a few seconds and would otherwise always use a temporary userdir.
 */
function markRecordedProjectsLarge(env) {
  const records = listProjectRecords(env);
  if (records.length === 0) throw new Error('no project has been recorded yet');
  for (const { key, record } of records) {
    const file = path.join(env.KIRO_JAVA_FORMAT_CACHE, key, 'project.json');
    fs.writeFileSync(file, JSON.stringify({ ...record, coldIndexing: { kind: 'complete', durationMs: 60000 } }));
  }
}

module.exports = { createIsolatedEnv, listLeftovers, NO_LEFTOVERS, listProjectRecords, markRecordedProjectsLarge };
