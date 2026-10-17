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

module.exports = { createIsolatedEnv };
