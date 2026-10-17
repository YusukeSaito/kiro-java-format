'use strict';

const path = require('path');
const { spawn } = require('child_process');

const WT = path.resolve(__dirname, '..', '..');

/** The script under test. Point KJF_TEST_SCRIPT at another copy to test it instead. */
function resolveTestScript() {
  return process.env.KJF_TEST_SCRIPT ? path.resolve(process.env.KJF_TEST_SCRIPT) : path.join(WT, 'format-java.js');
}

/**
 * Start the CLI and collect its output.
 *
 * Returns the child right away (for tests that signal it) together with a
 * promise of the result. A run that outlives `timeoutMs` is killed so a hung
 * test cannot wedge the suite; the result then carries `isTimedOut: true`.
 */
function startCli(scriptPath, args, { cwd, env, timeoutMs = 600000 } = {}) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: cwd || WT,
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  let isTimedOut = false;
  const timer = setTimeout(() => {
    isTimedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, isTimedOut, pid: child.pid });
    });
  });
  return { child, done };
}

function runCli(scriptPath, args, options) {
  return startCli(scriptPath, args, options).done;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace absolute paths with <ROOT> so output from two copies of a fixture
 * can be compared. macOS reports $TMPDIR both as /var/... and /private/var/...,
 * so both spellings are replaced.
 */
function normalizeOutput(text, roots) {
  let out = text;
  const spellings = [];
  for (const root of roots) {
    spellings.push(root);
    if (root.startsWith('/private/var/')) spellings.push(root.slice('/private'.length));
    else if (root.startsWith('/var/')) spellings.push('/private' + root);
  }
  // Longest first so a root never matches inside a longer spelling of itself.
  spellings.sort((a, b) => b.length - a.length);
  for (const s of spellings) out = out.replace(new RegExp(escapeRegExp(s), 'g'), '<ROOT>');
  return out;
}

module.exports = { WT, resolveTestScript, startCli, runCli, normalizeOutput };
