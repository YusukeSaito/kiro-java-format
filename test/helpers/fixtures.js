'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

/**
 * Copy test/fixtures/<name> to dstDir.
 *
 * `gitMarker` creates an empty .git directory in the copy: a fixture without a
 * build file needs one so the CLI picks the copy as the project root, and a
 * .git directory cannot be committed.
 */
function copyFixture(name, dstDir, { gitMarker = false } = {}) {
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(path.join(FIXTURES, name), dstDir, { recursive: true });
  if (gitMarker) fs.mkdirSync(path.join(dstDir, '.git'), { recursive: true });
  return dstDir;
}

/** A digest of every file under a directory (paths and contents), for cache keys. */
function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (cur) => {
    for (const name of fs.readdirSync(cur).sort()) {
      const p = path.join(cur, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        hash.update(path.relative(dir, p));
        hash.update('\0');
        hash.update(fs.readFileSync(p));
        hash.update('\0');
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

module.exports = { FIXTURES, copyFixture, hashTree };
