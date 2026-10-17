'use strict';

const fs = require('fs');
const path = require('path');

const FAKE_EXT = path.resolve(__dirname, '..', 'fixtures', 'fake-ext');

/** The environment that makes the CLI run the fake language server instead of nbcode. */
function buildFakeEnv(isolatedEnv, extra = {}) {
  const base = isolatedEnv.buildEnv();
  for (const key of Object.keys(base)) if (key.startsWith('FAKE_')) delete base[key];
  return { ...base, KIRO_JAVA_EXT: FAKE_EXT, FAKE_NODE: process.execPath, ...extra };
}

/** Write `count` small Java files into `dir` and return their paths. */
function writeJavaFiles(dir, count) {
  const files = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `F${i}.java`);
    fs.writeFileSync(file, `class F${i} {}\n`);
    files.push(file);
  }
  return files;
}

module.exports = { FAKE_EXT, buildFakeEnv, writeJavaFiles };
