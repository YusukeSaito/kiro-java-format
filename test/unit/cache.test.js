'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveCacheRoot } = require('../../format-java.js');

test('KIRO_JAVA_FORMAT_CACHE overrides the cache location on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const root = resolveCacheRoot({ env: { KIRO_JAVA_FORMAT_CACHE: '/tmp/kjf-cache' }, platform, homedir: '/home/u' });
    assert.strictEqual(root, path.resolve('/tmp/kjf-cache'));
  }
});

test('an empty KIRO_JAVA_FORMAT_CACHE is ignored', () => {
  const root = resolveCacheRoot({ env: { KIRO_JAVA_FORMAT_CACHE: '' }, platform: 'darwin', homedir: '/Users/u' });
  assert.strictEqual(root, '/Users/u/Library/Caches/kiro-java-format');
});

test('macOS uses ~/Library/Caches', () => {
  assert.strictEqual(
    resolveCacheRoot({ env: {}, platform: 'darwin', homedir: '/Users/u' }),
    '/Users/u/Library/Caches/kiro-java-format'
  );
});

test('Windows uses %LOCALAPPDATA%, else ~/AppData/Local', () => {
  assert.strictEqual(
    resolveCacheRoot({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Local\\kiro-java-format'
  );
  assert.strictEqual(
    resolveCacheRoot({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Local\\kiro-java-format'
  );
});

test('Linux uses an absolute XDG_CACHE_HOME, else ~/.cache', () => {
  assert.strictEqual(
    resolveCacheRoot({ env: { XDG_CACHE_HOME: '/var/cache/u' }, platform: 'linux', homedir: '/home/u' }),
    '/var/cache/u/kiro-java-format'
  );
  assert.strictEqual(
    resolveCacheRoot({ env: { XDG_CACHE_HOME: 'relative/cache' }, platform: 'linux', homedir: '/home/u' }),
    '/home/u/.cache/kiro-java-format'
  );
  assert.strictEqual(resolveCacheRoot({ env: {}, platform: 'linux', homedir: '/home/u' }), '/home/u/.cache/kiro-java-format');
});
