'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createIsolatedEnv } = require('../helpers/env');
const { splitIntoSegments } = require('../../format-java.js');

function withFiles(names, fn) {
  const env = createIsolatedEnv();
  try {
    const paths = {};
    for (const n of names) {
      paths[n] = path.join(env.dir, `${n}.java`);
      fs.writeFileSync(paths[n], `class ${n} {}\n`);
    }
    fn(paths, env.dir);
  } finally {
    env.cleanup();
  }
}

test('splitIntoSegments keeps a list without repeats in one segment', () => {
  assert.deepStrictEqual(splitIntoSegments([]), []);
  withFiles(['A', 'B', 'C'], ({ A, B, C }) => {
    assert.deepStrictEqual(splitIntoSegments([A, B, C]), [[A, B, C]]);
  });
});

test('splitIntoSegments starts a new segment at each repeated file', () => {
  withFiles(['A', 'B'], ({ A, B }) => {
    assert.deepStrictEqual(splitIntoSegments([A, A]), [[A], [A]]);
    assert.deepStrictEqual(splitIntoSegments([A, B, A, B]), [
      [A, B],
      [A, B],
    ]);
    assert.deepStrictEqual(splitIntoSegments([A, A, A]), [[A], [A], [A]]);
    assert.deepStrictEqual(splitIntoSegments([A, B, A]), [[A, B], [A]]);
  });
});

test('splitIntoSegments treats a symlink and its target as the same file', () => {
  withFiles(['A'], ({ A }, dir) => {
    const link = path.join(dir, 'Link.java');
    fs.symlinkSync(A, link);
    assert.deepStrictEqual(splitIntoSegments([A, link]), [[A], [link]]);
  });
});
