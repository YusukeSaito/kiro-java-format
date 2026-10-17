'use strict';

// The CLI against the fake language server: how each wait behaves at its
// --timeout limit, and what is printed when the server goes away.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createIsolatedEnv } = require('../helpers/env');
const { resolveTestScript, runCli } = require('../helpers/cli');
const { buildFakeEnv, writeJavaFiles } = require('../helpers/fake');
const { waitForNoProcessesWithToken, killOwnPids } = require('../helpers/processes');

const script = resolveTestScript();

async function runFake(t, { files = 1, args = [], fake = {} } = {}) {
  const env = createIsolatedEnv();
  t.after(async () => {
    const left = await waitForNoProcessesWithToken(env.dir, 15000);
    killOwnPids(left.map((p) => p.pid));
    const userdirs = fs.readdirSync(env.dir).filter((n) => n.startsWith('kiro-java-format-userdir-'));
    env.cleanup();
    assert.deepStrictEqual(left, [], 'no process of the run is left');
    assert.deepStrictEqual(userdirs, [], 'no temporary userdir is left');
  });
  const paths = writeJavaFiles(env.dir, files);
  const r = await runCli(script, [...args, ...paths], { cwd: env.dir, env: buildFakeEnv(env, fake), timeoutMs: 60000 });
  return { ...r, paths, env };
}

test('formats with the fake server (sanity)', async (t) => {
  const r = await runFake(t, { files: 2 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout, r.paths.map((p) => `unchanged: ${p}\n`).join(''));
  assert.strictEqual(r.stderr, '');
});

test('a server that does not start in time ends the run with the existing message', async (t) => {
  const r = await runFake(t, { args: ['--timeout', '1'], fake: { FAKE_START_DELAY_MS: '5000' } });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(
    r.stderr,
    'kiro-java-format: Timed out after 1s waiting for the language server. Try --timeout or --verbose.\n'
  );
  assert.ok(r.elapsedMs < 4000, `took ${r.elapsedMs}ms`);
});

test('a server that exits before listening is reported as before', async (t) => {
  const r = await runFake(t, { fake: { FAKE_EXIT_BEFORE_LISTEN: '3' } });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(
    r.stderr,
    'kiro-java-format: nbcode exited (code 3) before starting the LSP server.\nfake nbcode: exiting before listen\n\n'
  );
});

test('--timeout abc times out at once, as before', async (t) => {
  const r = await runFake(t, { args: ['--timeout', 'abc'] });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(
    r.stderr,
    'kiro-java-format: Timed out after NaNs waiting for the language server. Try --timeout or --verbose.\n'
  );
});

test('formatting without a reply fails that file only; the next file is processed', async (t) => {
  const r = await runFake(t, { files: 2, args: ['--timeout', '2'], fake: { FAKE_NO_REPLY: 'textDocument/formatting:1' } });
  const [first, second] = r.paths;
  assert.strictEqual(r.code, 1);
  assert.strictEqual(
    r.stderr,
    `error: ${first}: Timed out after 2s waiting for the language server. Try --timeout or --verbose.\n`
  );
  assert.strictEqual(r.stdout, `unchanged: ${second}\n`);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'class F0 {}\n');
});

test('a code action without a reply fails that file only', async (t) => {
  const r = await runFake(t, { files: 2, args: ['--timeout', '2'], fake: { FAKE_NO_REPLY: 'textDocument/codeAction:1' } });
  const [first, second] = r.paths;
  assert.strictEqual(r.code, 1);
  assert.strictEqual(
    r.stderr,
    `error: ${first}: Timed out after 2s waiting for the language server. Try --timeout or --verbose.\n`
  );
  assert.strictEqual(r.stdout, `unchanged: ${second}\n`);
});

test('a server that exits mid-run fails the current and every remaining file at once', async (t) => {
  const r = await runFake(t, { files: 3, fake: { FAKE_EXIT_ON: 'textDocument/formatting:1:7' } });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, r.paths.map((p) => `error: ${p}: language server exited (code 7)\n`).join(''));
  assert.ok(r.elapsedMs < 10000, `took ${r.elapsedMs}ms`);
});
