#!/usr/bin/env node
'use strict';

/*
 * kiro-java-format
 *
 * Copyright (c) 2026 SAITO Yusuke, Mirai-souzou inc.
 * Licensed under the Apache License, Version 2.0.
 *
 * Formats Java files from the command line by driving the language server
 * bundled inside the installed Oracle Java extension (oracle.oracle-java).
 *
 * It launches `nbcode` as a Java Language Server (the exact same backend the
 * VS Code / Kiro extension uses), connects over the local socket, opens each
 * file, organizes its imports (the `source.organizeImports` code action), asks
 * the server to format it (textDocument/formatting) and writes the result back
 * to disk.
 *
 * No external npm dependencies. Node 16+.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    files: [],
    root: null,
    jdkHome: process.env.KIRO_JAVA_JDKHOME || null,
    tabSize: 4,
    insertSpaces: true,
    check: false,
    organizeImports: true,
    timeoutMs: 120000,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--root':
        opts.root = argv[++i];
        break;
      case '--jdkhome':
        opts.jdkHome = argv[++i];
        break;
      case '--tab-size':
        opts.tabSize = parseInt(argv[++i], 10);
        break;
      case '--use-tabs':
        opts.insertSpaces = false;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--no-organize-imports':
        opts.organizeImports = false;
        break;
      case '--timeout':
        opts.timeoutMs = parseInt(argv[++i], 10) * 1000;
        break;
      case '-v':
      case '--verbose':
        opts.verbose = true;
        break;
      default:
        if (a.startsWith('-')) {
          fail(`Unknown option: ${a}`);
        }
        opts.files.push(path.resolve(a));
    }
  }
  return opts;
}

function printHelp() {
  console.log(`kiro-java-format - format Java files using the Oracle Java extension's formatter

Usage:
  kiro-java-format [options] <file.java> [<file2.java> ...]

Imports are organized before formatting, the same way the editor's
"Organize Imports" does. Both steps read the project's code style
(nb-configuration.xml for Maven projects).

Options:
  --root <dir>              Project root to open (default: nearest pom.xml/build.gradle, else file's dir)
  --jdkhome <dir>           JDK 17+ home used to run the language server (auto-detected if omitted)
  --tab-size <n>            Indent size hint sent to the formatter (default: 4)
  --use-tabs                Indent with tabs instead of spaces
  --check                   Do not write; exit 1 if any file is not already formatted
  --no-organize-imports     Only format; leave the import block alone
  --timeout <sec>           Max seconds to wait for the server (default: 120)
  -v, --verbose             Print server / protocol diagnostics
  -h, --help                Show this help

Environment:
  KIRO_JAVA_EXT       Override path to the extension directory (the one containing nbcode/)
  KIRO_JAVA_JDKHOME   Override JDK home (same as --jdkhome)
  KIRO_JAVA_FORMAT_CACHE  Cache directory for the language server's index (default: per-OS user cache dir)

Exit codes:
  0  success (formatted, or already formatted in --check mode)
  1  a file changed (in --check mode), a file failed, or a runtime error occurred

A file that fails is reported and skipped; the remaining files still run.
`);
}

function fail(msg) {
  console.error(`kiro-java-format: ${msg}`);
  process.exit(1);
}

let VERBOSE = false;
function vlog(...args) {
  if (VERBOSE) console.error('[kjf]', ...args);
}

/**
 * How long to wait for the server to report that a file resolves, before
 * organizing its imports. The first file pays for the project load; later files
 * are answered immediately.
 */
const RESOLVE_WAIT_MS = 60000;
/**
 * Once indexing has completed, a file whose errors stay unchanged for this
 * long does not resolve, and waiting longer would not change that.
 */
const POST_INDEX_SETTLE_MS = 2000;
/** How long a normal exit waits for the server to acknowledge `shutdown`. */
const SHUTDOWN_WAIT_MS = 2000;

/** Pause between retries of a lock (or another poll that has no event to wait for). */
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True once `deadlineMs` is reached. A NaN deadline (from `--timeout abc`)
 * counts as reached, so no wait loop can spin forever on it.
 */
function hasDeadlinePassed(deadlineMs) {
  return !(Date.now() < deadlineMs);
}

const LOCK_RETRY_MS = 50;
/** A lock younger than this cannot belong to a recycled pid, so the command line is not checked. */
const LOCK_PID_CHECK_AGE_MS = 2000;
/** A lock file that cannot be parsed is a leftover once it is this old. */
const LOCK_UNPARSABLE_STALE_MS = 5000;
/** A `.break` marker this old was left by a process that died while breaking a lock. */
const LOCK_BREAK_STALE_MS = 10000;

// ---------------------------------------------------------------------------
// Locate the installed Oracle Java extension (contains nbcode/)
// ---------------------------------------------------------------------------
function findExtension() {
  if (process.env.KIRO_JAVA_EXT) {
    const p = process.env.KIRO_JAVA_EXT;
    if (fs.existsSync(path.join(p, 'nbcode', 'bin'))) return p;
    fail(`KIRO_JAVA_EXT does not contain nbcode/bin: ${p}`);
  }
  const home = os.homedir();
  const roots = [
    path.join(home, '.kiro', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-oss', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
  ];
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/^oracle\.oracle-java-/.test(name)) {
        const dir = path.join(root, name);
        if (fs.existsSync(path.join(dir, 'nbcode', 'bin'))) {
          candidates.push(dir);
        }
      }
    }
  }
  if (candidates.length === 0) {
    fail(
      'Could not find the Oracle Java extension (oracle.oracle-java) with a bundled nbcode.\n' +
        '  Install it in Kiro/VS Code, or set KIRO_JAVA_EXT to its directory.'
    );
  }
  // Prefer the highest version.
  candidates.sort((a, b) => versionOf(b).localeCompare(versionOf(a), undefined, { numeric: true }));
  vlog('extension:', candidates[0]);
  return candidates[0];
}

function versionOf(dir) {
  const m = path.basename(dir).match(/oracle-java-(.+)$/);
  return m ? m[1] : '0';
}

function findNbcode(extPath) {
  let bin;
  if (process.platform === 'win32') {
    bin = process.arch === 'x64' || process.arch === 'arm64' ? 'nbcode64.exe' : 'nbcode.exe';
  } else {
    bin = 'nbcode.sh';
  }
  const p = path.join(extPath, 'nbcode', 'bin', bin);
  if (!fs.existsSync(p)) fail(`nbcode launcher not found: ${p}`);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(p, 0o744);
      fs.chmodSync(path.join(extPath, 'nbcode', 'platform', 'lib', 'nbexec.sh'), 0o744);
    } catch {
      /* ignore */
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Locate a JDK 17+
// ---------------------------------------------------------------------------
function findJdkHome(explicit) {
  const tryHome = (h) => (h && fs.existsSync(path.join(h, 'bin', javaExe())) ? h : null);
  let h = tryHome(explicit) || tryHome(process.env.JDK_HOME) || tryHome(process.env.JAVA_HOME);
  if (!h && process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' }).trim();
      h = tryHome(out);
    } catch {
      /* ignore */
    }
  }
  if (!h) {
    try {
      const javaPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['java'], {
        encoding: 'utf8',
      })
        .split(/\r?\n/)[0]
        .trim();
      if (javaPath) {
        const real = fs.realpathSync(javaPath);
        h = tryHome(path.dirname(path.dirname(real)));
      }
    } catch {
      /* ignore */
    }
  }
  vlog('jdkhome:', h || '(let nbcode auto-detect)');
  return h;
}

function javaExe() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------
function detectRoot(file, explicit) {
  if (explicit) return path.resolve(explicit);
  const markers = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', '.git'];
  let cur = path.dirname(file);
  while (true) {
    for (const m of markers) {
      if (fs.existsSync(path.join(cur, m))) return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.dirname(file);
}

// ---------------------------------------------------------------------------
// Waiting with a limit
// ---------------------------------------------------------------------------

/** A wait on the language server took longer than --timeout. */
class TimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Timed out after ${timeoutMs / 1000}s waiting for the language server. Try --timeout or --verbose.`);
    this.name = 'TimeoutError';
  }
}

/** The language server went away while it still had work. `code` is its exit code (null after a signal). */
class ServerExitedError extends Error {
  constructor(code) {
    super(`language server exited (code ${code})`);
    this.name = 'ServerExitedError';
    this.code = code;
  }
}

/**
 * Settle like `promise`, or reject with TimeoutError after `ms`. The limit is
 * passed to setTimeout as given, so a NaN limit (`--timeout abc`) fires at
 * once, as it always has.
 */
function awaitWithTimeout(promise, ms) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Minimal LSP client over a socket
// ---------------------------------------------------------------------------
class LspClient {
  /**
   * `onClose` runs when the connection drops. Without it, pending requests
   * are failed with ServerExitedError right away.
   */
  constructor(socket, { onClose } = {}) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
    // Set once the connection is gone; later requests fail with it at once.
    this.closedError = null;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => vlog('socket error:', err.message));
    socket.on('close', () => {
      if (onClose) onClose();
      else this.rejectAll(new ServerExitedError(null));
    });
  }

  /** Fail every pending request with `err`, and every later one too. */
  rejectAll(err) {
    if (!this.closedError) this.closedError = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.slice(start, start + len).toString('utf8');
      this.buffer = this.buffer.slice(start + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        vlog('failed to parse message', e.message);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // A reply to a request that already timed out has no entry and is dropped.
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      const handler = this.requestHandlers.get(msg.method);
      const result = handler ? handler(msg.params) : null;
      this._send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
      return;
    }
    if (msg.method) {
      vlog('notif <-', msg.method);
      const h = this.notificationHandlers.get(msg.method);
      if (h) h(msg.params);
    }
  }

  _send(obj) {
    if (this.closedError || this.socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    this.socket.write(Buffer.concat([header, payload]));
  }

  /**
   * Send a request. With `timeoutMs`, the request fails with TimeoutError when
   * no reply comes in time; the reply, if it comes later, is dropped.
   */
  request(method, params, timeoutMs) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    this._send({ jsonrpc: '2.0', id, method, params });
    vlog('req ->', method, id);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          vlog('timed out <-', method, id);
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
    vlog('notify ->', method);
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
/**
 * Spawn nbcode as a language server. Returns the process right away, and
 * `listening`, which resolves to `{ port, hash }` once the server says where
 * it listens. Its output is read for as long as it runs, so the server never
 * blocks on a full pipe.
 */
function startServer(nbcodePath, jdkHome, userdir) {
  const args = [];
  if (jdkHome) args.push('--jdkhome', jdkHome);
  args.push('--userdir', userdir);
  args.push('-J-XX:PerfMaxStringConstLength=10240');
  args.push('--start-java-language-server=listen-hash:0');
  args.push('-J--add-exports=jdk.compiler/com.sun.tools.javac.resources=ALL-UNNAMED');

  vlog('spawn', nbcodePath, args.join(' '));
  // On POSIX the launcher leads a process group of its own (pgid = its pid),
  // so the JVM it runs as a child can be stopped with it, and a Ctrl-C in the
  // terminal reaches only this CLI, which then stops the server itself.
  const proc = spawn(nbcodePath, args, {
    cwd: userdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const listening = new Promise((resolve, reject) => {
    let started = false;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      vlog('server stdout:', text.trimEnd());
      if (!started) {
        const info = text.match(/Java Language Server listening at port (\d+) with hash (\S+)/);
        if (info) {
          started = true;
          resolve({ port: parseInt(info[1], 10), hash: info[2] });
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      if (!started) stderr += chunk.toString();
      vlog('server stderr:', chunk.toString().trimEnd());
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (!started) reject(new Error(`nbcode exited (code ${code}) before starting the LSP server.\n${stderr}`));
    });
  });
  return { proc, listening };
}

function connect(port, hash) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(hash);
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Apply LSP TextEdits to a string
// ---------------------------------------------------------------------------
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function posToOffset(starts, text, pos) {
  if (pos.line >= starts.length) return text.length;
  return Math.min(starts[pos.line] + pos.character, text.length);
}

function applyEdits(text, edits) {
  const starts = lineStarts(text);
  const resolved = edits.map((e) => ({
    start: posToOffset(starts, text, e.range.start),
    end: posToOffset(starts, text, e.range.end),
    newText: e.newText,
  }));
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of resolved) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

/** The whole document, as an LSP range. */
function fullRange(text) {
  const starts = lineStarts(text);
  const lastLine = starts.length - 1;
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: text.length - starts[lastLine] },
  };
}

/**
 * Collect the TextEdits a WorkspaceEdit targets at one document.
 *
 * A WorkspaceEdit can carry either shape. When it carries both, LSP says
 * `documentChanges` wins, so only that one is read; reading both would apply
 * the same edit twice. Edits for other documents are dropped: organizing one
 * file's imports must not rewrite its neighbours, and the caller only ever
 * holds the one file's text.
 */
function editsForUri(workspaceEdit, uri) {
  if (!workspaceEdit) return [];
  const out = [];
  if (Array.isArray(workspaceEdit.documentChanges)) {
    for (const change of workspaceEdit.documentChanges) {
      const target = change && change.textDocument ? change.textDocument.uri : null;
      if (target && sameUri(target, uri) && Array.isArray(change.edits)) out.push(...change.edits);
    }
    return out;
  }
  const changes = workspaceEdit.changes;
  if (changes) {
    for (const key of Object.keys(changes)) {
      if (sameUri(key, uri) && Array.isArray(changes[key])) out.push(...changes[key]);
    }
  }
  return out;
}

/**
 * The text as the server holds it after didOpen: NBLS turns CRLF and lone CR
 * into LF when it opens a document, but takes didChange text as it comes.
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

class EditsMismatchError extends Error {
  constructor() {
    super('the language server returned edits that do not match the file; not written');
    this.name = 'EditsMismatchError';
  }
}

/**
 * Throw EditsMismatchError unless every edit lies inside `text`.
 *
 * A position is inside when its line exists and its character is at most that
 * line's length (the `\n` is not counted, a `\r` is). The position just past
 * the last line, `{ line: lineCount, character: 0 }`, is the end of the text
 * and allowed. An edit outside the text means the server computed it against
 * a different document than ours, and applying it would corrupt the file.
 */
function validateEditsWithinText(text, edits) {
  if (!Array.isArray(edits)) return;
  const starts = lineStarts(text);
  const lineCount = starts.length;
  const isInside = (pos) => {
    if (!pos || !Number.isInteger(pos.line) || !Number.isInteger(pos.character)) return false;
    if (pos.line < 0 || pos.character < 0) return false;
    if (pos.line === lineCount) return pos.character === 0;
    if (pos.line > lineCount) return false;
    const lineEnd = pos.line + 1 < lineCount ? starts[pos.line + 1] - 1 : text.length;
    return pos.character <= lineEnd - starts[pos.line];
  };
  for (const e of edits) {
    if (!e || !e.range || !isInside(e.range.start) || !isInside(e.range.end)) {
      vlog('edit outside the text:', JSON.stringify(e));
      throw new EditsMismatchError();
    }
  }
}

/**
 * Compare two file URIs.
 *
 * The server may percent-encode differently than pathToFileURL does, so the
 * decoded form is compared as well. Comparing the raw strings only would
 * silently drop the edits for paths holding spaces or non-ASCII characters.
 */
function sameUri(a, b) {
  if (a === b) return true;
  const decode = (u) => {
    try {
      return decodeURI(u);
    } catch {
      return u;
    }
  };
  return decode(a) === decode(b);
}

// ---------------------------------------------------------------------------
// Cache location
// ---------------------------------------------------------------------------

/**
 * The per-user cache directory of this tool (it holds the lock files, and the
 * language server's index per project). KIRO_JAVA_FORMAT_CACHE overrides it.
 */
function resolveCacheRoot({ env, platform, homedir }) {
  if (env.KIRO_JAVA_FORMAT_CACHE) return path.resolve(env.KIRO_JAVA_FORMAT_CACHE);
  if (platform === 'darwin') return path.posix.join(homedir, 'Library', 'Caches', 'kiro-java-format');
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(base, 'kiro-java-format');
  }
  const xdg = env.XDG_CACHE_HOME && path.posix.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : null;
  return path.posix.join(xdg || path.posix.join(homedir, '.cache'), 'kiro-java-format');
}

function resolveCurrentCacheRoot() {
  return resolveCacheRoot({ env: process.env, platform: process.platform, homedir: os.homedir() });
}

/** Create `dir` (and its parents) readable by this user only. Throws when it cannot. */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ---------------------------------------------------------------------------
// Is a process one of ours, and alive?
// ---------------------------------------------------------------------------

/** Whether this platform has the means to look at other processes' command lines. */
function isProcessInspectionAvailable() {
  if (process.platform === 'linux') return fs.existsSync('/proc/self/stat');
  if (process.platform === 'win32') return fs.existsSync(findPowerShell());
  return fs.existsSync('/bin/ps');
}

function findPowerShell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Run a command; resolves to { code, stdout } or rejects when it cannot be started. */
function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && typeof err.code !== 'number') {
        reject(err);
        return;
      }
      resolve({ code: err ? err.code : 0, stdout });
    });
  });
}

/** True when a command line runs this tool (an argument named format-java.js). */
function hasToolScriptArgument(commandLine) {
  return /(^|[\s/\\"])format-java\.js(["\s]|$)/i.test(commandLine);
}

/**
 * Whether `pid` is alive and, when asked, still runs this tool.
 *
 * Returns `{ isAvailable: false, reason }` when it cannot be told, otherwise
 * `{ isAvailable: true, isAlive }`. The command line is checked only when
 * `shouldVerifyCommandLine` is set: a pid in a lock older than a moment may
 * have been recycled for an unrelated process.
 */
async function inspectToolProcess(pid, { shouldVerifyCommandLine }) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH' || err.code === 'EPERM') return { isAvailable: true, isAlive: false };
    return { isAvailable: false, reason: err.message };
  }
  if (!shouldVerifyCommandLine) return { isAvailable: true, isAlive: true };
  try {
    if (process.platform === 'linux') {
      let raw;
      try {
        raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ESRCH') return { isAvailable: true, isAlive: false };
        return { isAvailable: false, reason: err.message };
      }
      const argv = raw.split('\0').filter(Boolean);
      return { isAvailable: true, isAlive: argv.some((a) => path.basename(a) === 'format-java.js') };
    }
    if (process.platform === 'win32') {
      const r = await runCommand(findPowerShell(), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -ExpandProperty CommandLine`,
      ]);
      if (r.code !== 0) return { isAvailable: false, reason: `powershell exited ${r.code}` };
      return { isAvailable: true, isAlive: hasToolScriptArgument(r.stdout.trim()) };
    }
    const r = await runCommand('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
    if (r.code === 1 && r.stdout.trim() === '') return { isAvailable: true, isAlive: false };
    if (r.code !== 0) return { isAvailable: false, reason: `ps exited ${r.code}` };
    return { isAvailable: true, isAlive: hasToolScriptArgument(r.stdout.trim()) };
  } catch (err) {
    return { isAvailable: false, reason: err.message };
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a command line (as `ps` or Windows reports it) passes exactly
 * `userdir` to nbcode: `--userdir <userdir>` or `-Dnetbeans.user=<userdir>`,
 * plain or in double quotes, followed by a space or the end. A longer path
 * that merely starts with `userdir` does not count.
 */
function hasUserdirToken(commandLine, userdir, { isCaseInsensitive = false } = {}) {
  const u = escapeRegExp(userdir);
  const patterns = [
    `(^|\\s)--userdir\\s+${u}(?=\\s|$)`,
    `(^|\\s)--userdir\\s+"${u}"(?=[\\s"]|$)`,
    `(^|\\s)-Dnetbeans\\.user=${u}(?=\\s|$)`,
    `(^|\\s)"-Dnetbeans\\.user=${u}"(?=[\\s"]|$)`,
  ];
  return patterns.some((p) => new RegExp(p, isCaseInsensitive ? 'i' : '').test(commandLine));
}

/** The same check on an argument vector (Linux /proc/<pid>/cmdline). */
function hasUserdirTokenInArgv(argv, userdir) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--userdir' && argv[i + 1] === userdir) return true;
    if (argv[i] === `-Dnetbeans.user=${userdir}`) return true;
  }
  return false;
}

/**
 * The pid and process group of a /proc/<pid>/stat line. The command name in
 * parentheses may itself hold spaces and parentheses, so fields are counted
 * from the last `)`.
 */
function parseProcStat(line) {
  const close = line.lastIndexOf(')');
  const pid = parseInt(line.slice(0, line.indexOf('(')).trim(), 10);
  const fields = line.slice(close + 1).trim().split(/\s+/);
  return { pid, pgid: parseInt(fields[2], 10) };
}

/**
 * The processes started with `userdir` (the nbcode launcher and its JVM).
 * Returns `{ isAvailable: false, reason }` when processes cannot be listed,
 * otherwise `{ isAvailable: true, processes: [{ pid, pgid }] }` (pgid is
 * missing on Windows).
 */
async function findProcessesUsingUserdir(userdir) {
  try {
    if (process.platform === 'linux') {
      let names;
      try {
        names = fs.readdirSync('/proc');
      } catch (err) {
        return { isAvailable: false, reason: err.message };
      }
      const processes = [];
      for (const name of names) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        try {
          const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
          if (!hasUserdirTokenInArgv(argv, userdir)) continue;
          processes.push(parseProcStat(fs.readFileSync(`/proc/${name}/stat`, 'utf8')));
        } catch {
          /* gone, or not ours to read */
        }
      }
      return { isAvailable: true, processes };
    }
    if (process.platform === 'win32') {
      const r = await runCommand(findPowerShell(), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ]);
      if (r.code !== 0) return { isAvailable: false, reason: `powershell exited ${r.code}` };
      const list = [].concat(JSON.parse(r.stdout || '[]'));
      const processes = list
        .filter((p) => p && p.CommandLine && hasUserdirToken(p.CommandLine, userdir, { isCaseInsensitive: true }))
        .map((p) => ({ pid: p.ProcessId }));
      return { isAvailable: true, processes };
    }
    const r = await runCommand('ps', ['-ww', '-axo', 'pid=,pgid=,command=']);
    if (r.code !== 0) return { isAvailable: false, reason: `ps exited ${r.code}` };
    const processes = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || Number(m[1]) === process.pid) continue;
      if (hasUserdirToken(m[3], userdir)) processes.push({ pid: Number(m[1]), pgid: Number(m[2]) });
    }
    return { isAvailable: true, processes };
  } catch (err) {
    return { isAvailable: false, reason: err.message };
  }
}

function runTaskkill(args) {
  return runCommand(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), args).catch(
    () => ({ code: -1, stdout: '' })
  );
}

/**
 * Signal the language server this process spawned, with its whole process
 * group (the launcher runs the JVM as a child). Only while Node has not
 * reaped the launcher: until then its pid, which is the group id, cannot have
 * been reused.
 */
function signalOwnServer(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      runTaskkill(['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (err) {
    vlog('could not signal the language server:', err.message);
  }
}

/** How long a language server gets to exit after SIGTERM before it is killed. */
const JVM_EXIT_GRACE_MS = 10000;

/**
 * Stop the language server started with `userdir` and confirm it is gone.
 * Returns `{ isTerminated }`; false means it could not be confirmed, and the
 * caller must then leave the userdir and its locks in place.
 *
 * Only processes carrying `userdir` on their command line are signalled. The
 * whole group is signalled only when every such process is in the group the
 * launcher leads; on Windows the tree is killed only when the launcher itself
 * is among them, since a recycled pid would take an unrelated tree with it.
 * `deps` replaces the process queries and signals in tests.
 */
async function terminateServerProcesses({ pgid, launcherPid, userdir }, graceMs, deps = {}) {
  const find = deps.find || findProcessesUsingUserdir;
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal));
  const taskkill = deps.taskkill || runTaskkill;
  const platform = deps.platform || process.platform;
  const wait = deps.wait || waitMs;
  const isAlive = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const trySignal = (pid, signal) => {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  };

  const first = await find(userdir);
  if (!first.isAvailable) {
    vlog('cannot list processes:', first.reason);
    if (platform !== 'win32' && Number.isInteger(pgid) && pgid > 1 && isAlive(launcherPid)) {
      trySignal(-pgid, 'SIGTERM');
      await wait(graceMs);
      if (isAlive(launcherPid)) trySignal(-pgid, 'SIGKILL');
    }
    return { isTerminated: false };
  }
  if (first.processes.length === 0) return { isTerminated: true };

  const sendAll = async (processes, signal) => {
    if (platform === 'win32') {
      if (processes.some((p) => p.pid === launcherPid)) {
        await taskkill(['/PID', String(launcherPid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]);
      } else {
        for (const p of processes) await taskkill(['/PID', String(p.pid), '/F']);
      }
      return;
    }
    const isOwnGroup =
      Number.isInteger(pgid) && pgid > 1 && pgid === launcherPid && processes.every((p) => p.pgid === pgid);
    if (isOwnGroup) trySignal(-pgid, signal);
    else for (const p of processes) trySignal(p.pid, signal);
  };
  const waitUntilGone = async (limitMs) => {
    const deadline = Date.now() + limitMs;
    for (;;) {
      await wait(100);
      const r = await find(userdir);
      if (!r.isAvailable) return null;
      if (r.processes.length === 0 || hasDeadlinePassed(deadline)) return r.processes;
    }
  };

  await sendAll(first.processes, 'SIGTERM');
  let left = await waitUntilGone(graceMs);
  if (left && left.length > 0) {
    await sendAll(left, 'SIGKILL');
    left = await waitUntilGone(2000);
  }
  return { isTerminated: Array.isArray(left) && left.length === 0 };
}

// ---------------------------------------------------------------------------
// Cleaning up after a language server, even when this process dies
// ---------------------------------------------------------------------------

/**
 * Stop the server described by `config` and remove what it leaves behind:
 * NetBeans' lock in the userdir, the userdir itself when it is temporary, and
 * the owner lock. Nothing is removed unless the server is confirmed gone.
 */
async function cleanUpAfterServer(config) {
  const { isTerminated } = await terminateServerProcesses(config, JVM_EXIT_GRACE_MS);
  if (!isTerminated) return false;
  removeFileQuietly(path.join(config.userdir, 'lock'));
  if (config.isTemporaryUserdir) {
    try {
      fs.rmSync(config.userdir, { recursive: true, force: true });
    } catch {
      /* the OS cleans its temporary directory eventually */
    }
  }
  if (config.ownerLockPath) releaseLockFile(config.ownerLockPath, config.lockNonce);
  return true;
}

/**
 * Start the watchdog of a language server just spawned: a detached node
 * process that waits for this process to end, then runs cleanUpAfterServer.
 * It learns of the end from its stdin reaching EOF, which the OS delivers
 * however this process ends (normal exit, exception, signal, SIGKILL), so
 * shutting the JVM down and deleting the userdir never delays the user.
 * Returns null when it cannot be started; the caller then cleans up itself.
 */
function spawnServerWatchdog(config, onFailure) {
  try {
    const child = spawn(process.execPath, [__filename, '--internal-watchdog', JSON.stringify(config)], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', (err) => {
      vlog('the watchdog failed:', err.message);
      onFailure();
    });
    child.stdin.on('error', () => {});
    child.unref();
    child.stdin.unref();
    return child;
  } catch (err) {
    vlog('could not start the watchdog:', err.message);
    return null;
  }
}

function runWatchdog(config) {
  let isDone = false;
  const onOwnerGone = async () => {
    if (isDone) return;
    isDone = true;
    try {
      await cleanUpAfterServer(config);
    } finally {
      process.exit(0);
    }
  };
  process.stdin.on('data', () => {});
  process.stdin.on('end', onOwnerGone);
  process.stdin.on('close', onOwnerGone);
  process.stdin.on('error', onOwnerGone);
  process.stdin.resume();
}

/** The language servers this process started, for the exit paths. */
const startedServers = new Set();

function releaseHeldFileLocks() {
  for (const [lockPath, nonce] of heldFileLocks) releaseLockFile(lockPath, nonce);
  heldFileLocks.clear();
}

/**
 * Get ready to exit. File locks are released. On an abnormal exit (fatal
 * error, signal) every server still running is sent SIGTERM; after a normal
 * run they were already told to exit. A server whose watchdog could not be
 * started is cleaned up here and now.
 */
async function prepareForExit({ isAbnormal }) {
  releaseHeldFileLocks();
  for (const server of startedServers) {
    server.markOwnerLockReleasing();
    if (isAbnormal) signalOwnServer(server.proc, 'SIGTERM');
  }
  for (const server of startedServers) {
    if (!server.watchdog) await cleanUpAfterServer(server.watchdogConfig);
  }
}

/** Exit once what was written to stdout and stderr has been handed to the OS. */
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

function installExitHandlers() {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = async (signal) => {
    for (const s of signals) process.removeListener(s, onSignal);
    await prepareForExit({ isAbnormal: true });
    // Die of the same signal, so the shell sees what it would have seen.
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  const onFatal = async (err) => {
    await prepareForExit({ isAbnormal: true });
    fail(err && err.message ? err.message : String(err));
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
}

// ---------------------------------------------------------------------------
// Lock files
// ---------------------------------------------------------------------------

/**
 * Read a lock file: `{ kind: 'missing' }`, `{ kind: 'unparsable', mtimeMs }`
 * or `{ kind: 'parsed', record, mtimeMs }`.
 */
function readLockRecord(lockPath) {
  let text;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  try {
    const record = JSON.parse(text);
    if (record && Number.isInteger(record.pid) && typeof record.nonce === 'string') {
      return { kind: 'parsed', record, mtimeMs };
    }
  } catch {
    /* fall through */
  }
  return { kind: 'unparsable', mtimeMs };
}

function writePrivateTempFile(lockPath, content) {
  const tmp = `${lockPath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  return tmp;
}

function removeFileQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Try once to create `lockPath` holding `{ pid, nonce, createdAt, ...fields }`.
 *
 * The content is written to a temporary file first and hard-linked into place,
 * so the lock appears complete or not at all. Returns
 * `{ kind: 'acquired', nonce }`, `{ kind: 'busy' }` when another holder has it,
 * or `{ kind: 'unusable', reason }` when no lock can be made here (no hard
 * links on this file system, no permission, ...).
 */
function acquireLockFile(lockPath, fields) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const content = JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now(), ...fields });
  let tmp;
  try {
    tmp = writePrivateTempFile(lockPath, content);
  } catch (err) {
    return { kind: 'unusable', reason: err.message };
  }
  try {
    fs.linkSync(tmp, lockPath);
    return { kind: 'acquired', nonce };
  } catch (err) {
    if (err.code === 'EEXIST') return { kind: 'busy' };
    return { kind: 'unusable', reason: err.message };
  } finally {
    removeFileQuietly(tmp);
  }
}

/**
 * Whether the lock read by readLockRecord is left over and may be broken.
 *
 * Its holder (and, for an owner lock, the holder's watchdog) must be known to
 * be dead. When that cannot be told, the lock is not stale: every wait on a
 * lock has its own limit, so nothing waits forever on it.
 */
async function isLockStale(read, nowMs, { inspect = inspectToolProcess } = {}) {
  if (read.kind === 'missing') return false;
  if (read.kind === 'unparsable') return nowMs - read.mtimeMs > LOCK_UNPARSABLE_STALE_MS;
  const { record } = read;
  const shouldVerifyCommandLine = !(nowMs - record.createdAt < LOCK_PID_CHECK_AGE_MS);
  const pids = [record.pid];
  if (record.server && Number.isInteger(record.server.watchdogPid)) pids.push(record.server.watchdogPid);
  for (const pid of pids) {
    const r = await inspect(pid, { shouldVerifyCommandLine });
    if (!r.isAvailable || r.isAlive) return false;
  }
  return true;
}

/**
 * Remove a stale lock, unless someone replaced it since it was read.
 *
 * Breakers take `<lockPath>.break` first, so of two processes that both judged
 * the same lock stale only one removes it; the other then finds a different
 * lock (or none) and leaves it alone.
 */
function breakStaleLock(lockPath, read) {
  const breakPath = `${lockPath}.break`;
  const takeBreakMarker = () => {
    try {
      fs.closeSync(fs.openSync(breakPath, 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - fs.statSync(breakPath).mtimeMs <= LOCK_BREAK_STALE_MS) return false;
      fs.unlinkSync(breakPath);
      fs.closeSync(fs.openSync(breakPath, 'wx'));
      return true;
    } catch {
      return false;
    }
  };
  if (!takeBreakMarker()) return false;
  try {
    const now = readLockRecord(lockPath);
    const isSameLock =
      (read.kind === 'parsed' && now.kind === 'parsed' && now.record.nonce === read.record.nonce) ||
      (read.kind === 'unparsable' && now.kind === 'unparsable' && now.mtimeMs === read.mtimeMs);
    if (!isSameLock) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    removeFileQuietly(breakPath);
  }
}

/** Remove the lock if it is still ours. */
function releaseLockFile(lockPath, nonce) {
  try {
    const read = readLockRecord(lockPath);
    if (read.kind !== 'parsed' || read.record.nonce !== nonce) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Merge `fields` into the lock if it is still ours (written whole, then renamed into place). */
function updateLockFile(lockPath, nonce, fields) {
  try {
    const read = readLockRecord(lockPath);
    if (read.kind !== 'parsed' || read.record.nonce !== nonce) return false;
    const tmp = writePrivateTempFile(lockPath, JSON.stringify({ ...read.record, ...fields }));
    try {
      fs.renameSync(tmp, lockPath);
    } catch (err) {
      removeFileQuietly(tmp);
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading and writing a file under a lock
// ---------------------------------------------------------------------------

class ChangedOnDiskError extends Error {
  constructor() {
    super('changed on disk while formatting; not written');
    this.name = 'ChangedOnDiskError';
  }
}

/**
 * Overwrite `file` with `text`, unless its content is no longer `originalText`.
 *
 * The file is rewritten in place exactly as fs.writeFileSync(file) does, so
 * its inode, owner, mode, extended attributes and hard links stay as they
 * are, and a symlink is written through. Returns the fstat taken right after
 * the write. Throws ChangedOnDiskError when someone else changed the file
 * since it was read: writing then would throw their change away.
 */
function writeFileIfUnchanged(file, text, originalText) {
  if (fs.readFileSync(file, 'utf8') !== originalText) throw new ChangedOnDiskError();
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    return fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveLockDir(cacheRoot) {
  return path.join(cacheRoot, 'locks');
}

/** The file locks this process holds (lock path → nonce), so a signal handler can release them. */
const heldFileLocks = new Map();

/**
 * Take the lock for one file, waiting up to `timeoutMs` for another run of
 * this tool to finish with it. Returns `{ lockPath, nonce }`, or null when the
 * file is to be processed without a lock: the wait hit its limit, or no lock
 * can be made. Either way the write is still guarded by writeFileIfUnchanged.
 */
async function acquireFileLock(file, timeoutMs) {
  let lockPath;
  try {
    const lockDir = ensurePrivateDir(resolveLockDir(resolveCurrentCacheRoot()));
    const key = crypto.createHash('sha256').update(fs.realpathSync(file)).digest('hex').slice(0, 16);
    lockPath = path.join(lockDir, `${key}.lock`);
  } catch (err) {
    vlog(`no lock for ${file} (${err.message}); continuing without the lock`);
    return null;
  }
  const deadlineMs = Date.now() + timeoutMs;
  for (;;) {
    const r = acquireLockFile(lockPath, {});
    if (r.kind === 'acquired') {
      heldFileLocks.set(lockPath, r.nonce);
      return { lockPath, nonce: r.nonce };
    }
    if (r.kind === 'unusable') {
      vlog(`no lock for ${file} (${r.reason}); continuing without the lock`);
      return null;
    }
    let read;
    try {
      read = readLockRecord(lockPath);
    } catch (err) {
      vlog(`no lock for ${file} (${err.message}); continuing without the lock`);
      return null;
    }
    if ((await isLockStale(read, Date.now())) && breakStaleLock(lockPath, read)) continue;
    if (hasDeadlinePassed(deadlineMs)) {
      vlog(`lock wait limit reached for ${file}; continuing without the lock`);
      return null;
    }
    await waitMs(LOCK_RETRY_MS);
  }
}

function releaseFileLock(lock) {
  releaseLockFile(lock.lockPath, lock.nonce);
  heldFileLocks.delete(lock.lockPath);
}

/**
 * Run `fn` while holding the lock for `file` (by real path, so a symlink and
 * its target share one lock). Two runs of this tool on the same file then
 * take turns, and the second finds the first one's result.
 */
async function runWithFileLock(file, timeoutMs, fn) {
  const lock = await acquireFileLock(file, timeoutMs);
  try {
    return await fn();
  } finally {
    if (lock) releaseFileLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Keeping the language server's index per project
// ---------------------------------------------------------------------------

function resolveRealPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The cache key of a project: its root, the extension (whose directory name
 * carries its version) and the JDK. A different extension or JDK gets an
 * index of its own.
 */
function computeProjectKey(rootDir, extPath, jdkHome) {
  const parts = [resolveRealPath(rootDir), resolveRealPath(extPath), jdkHome ? resolveRealPath(jdkHome) : null];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * Whether the files come from more than one project root (by the same rule
 * as the root itself). Such a call runs in a temporary userdir: the server
 * would open the other roots' projects too, and remember them in a cached
 * index, so later runs of this root could resolve differently.
 */
function hasMixedProjectRoots(files, explicitRoot) {
  if (explicitRoot) return false;
  const root = detectRoot(files[0], null);
  return files.some((f) => detectRoot(f, null) !== root);
}

function createTemporaryUserdir() {
  return { kind: 'temporary', userdir: fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-java-format-userdir-')) };
}

/**
 * A project whose index takes at least this long to build from scratch uses
 * the cached index. Below it the cache saves nothing: building a small index
 * is fast, and a cached index costs a wait for indexing to complete before a
 * file can be decided (see decideResolution).
 */
const MIN_COLD_INDEXING_MS_FOR_CACHE = 10000;

/**
 * Whether a project should use its cached index, from the indexing time
 * measured on a fresh index (`coldIndexing` of project.json, or null when
 * there is none): `{ kind: 'complete', durationMs }` when indexing completed
 * in that run, `{ kind: 'incomplete', minimumMs }` when the run ended first.
 */
function shouldUseCachedIndex(coldIndexing) {
  if (coldIndexing === null) return false;
  const ms = coldIndexing.kind === 'complete' ? coldIndexing.durationMs : coldIndexing.minimumMs;
  return ms >= MIN_COLD_INDEXING_MS_FOR_CACHE;
}

/**
 * The `coldIndexing` to keep after a run on a fresh index measured
 * `observation`. A completed measurement replaces the previous one. A run that
 * ended before indexing completed only says indexing takes longer than the
 * run; it is kept only when that alone shows the project is large and the
 * previous record does not already say so.
 */
function resolveColdIndexingRecord(previous, observation) {
  if (observation.kind === 'complete') return observation;
  if (shouldUseCachedIndex(observation) && !shouldUseCachedIndex(previous)) return observation;
  return previous;
}

function isValidColdIndexing(value) {
  if (!value || typeof value !== 'object') return false;
  const ms = value.kind === 'complete' ? value.durationMs : value.kind === 'incomplete' ? value.minimumMs : NaN;
  return Number.isFinite(ms) && ms >= 0;
}

/**
 * The project record (`<cache>/<key>/project.json`), or null when there is
 * none or it cannot be read. A `coldIndexing` that is not valid reads as null,
 * so a damaged record is treated like a project seen for the first time.
 */
function readProjectRecord(dir) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return { ...record, coldIndexing: isValidColdIndexing(record.coldIndexing) ? record.coldIndexing : null };
}

/**
 * Store what a run on a fresh index measured in the project record, written
 * whole and renamed into place. The record is kept even for a project that
 * does not use the cached index, so the next run can decide.
 */
function saveColdIndexingRecord(key, { root, extPath, jdkHome }, observation) {
  try {
    const dir = ensurePrivateDir(path.join(resolveCurrentCacheRoot(), key));
    const previous = readProjectRecord(dir);
    const coldIndexing = resolveColdIndexingRecord(previous ? previous.coldIndexing : null, observation);
    vlog(`project record: indexing ${JSON.stringify(observation)} on a fresh index; keeping ${JSON.stringify(coldIndexing)}`);
    const record = {
      root,
      extPath,
      jdkHome,
      createdAt: previous && Number.isFinite(previous.createdAt) ? previous.createdAt : Date.now(),
      coldIndexing,
    };
    const file = path.join(dir, 'project.json');
    const tmp = writePrivateTempFile(file, JSON.stringify(record, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      removeFileQuietly(tmp);
      throw err;
    }
  } catch (err) {
    vlog('project record: not saved:', err.message);
  }
}

/** How often to look again while a previous run of this project shuts its server down. */
const OWNER_POLL_MS = 100;

/**
 * Make a cached userdir safe to start nbcode in. Only when there is a trace of
 * a run that did not end cleanly (its owner lock was stale, or NetBeans' lock
 * file is still there) are processes looked at: a leftover server of ours on
 * this userdir is stopped and the NetBeans lock removed. Returns
 * `{ isReady: false }` when that cannot be done or confirmed.
 */
async function prepareUserdirForStart(userdir, { hasStaleOwner }, deps = {}) {
  const find = deps.find || findProcessesUsingUserdir;
  const netbeansLock = path.join(userdir, 'lock');
  if (!hasStaleOwner && !fs.existsSync(netbeansLock)) return { isReady: true };
  const found = await find(userdir);
  if (!found.isAvailable) {
    vlog('userdir: cannot list processes:', found.reason);
    return { isReady: false };
  }
  if (found.processes.length > 0) {
    vlog(`userdir: stopping ${found.processes.length} leftover process(es)`);
    const { isTerminated } = await terminateServerProcesses(
      { pgid: null, launcherPid: null, userdir },
      JVM_EXIT_GRACE_MS,
      { find }
    );
    if (!isTerminated) return { isReady: false };
  }
  removeFileQuietly(netbeansLock);
  return { isReady: true };
}

/**
 * Get the userdir for this project's server: the cached one when the project
 * is large enough to gain from it (shouldUseCachedIndex) and this run can own
 * it, else a new temporary one. Returns
 * `{ kind: 'persistent', userdir, ownerLock: { path, nonce } }` or
 * `{ kind: 'temporary', userdir }`. A project not measured yet (no record, or
 * one that cannot be read) gets a temporary userdir, whose run measures it.
 *
 * A cached userdir has one owner at a time (owner.lock): two servers on one
 * userdir fight over its documents and index. Another run that is still
 * working means a temporary userdir at once; one that is shutting its server
 * down is waited for, up to `timeoutMs`.
 */
async function acquireUserdir(key, timeoutMs, deps = {}) {
  const isInspectionAvailable = deps.isInspectionAvailable || isProcessInspectionAvailable;
  if (!isInspectionAvailable()) {
    vlog('userdir: cannot inspect processes; using a temporary one');
    return createTemporaryUserdir();
  }
  let dir;
  let userdir;
  try {
    dir = ensurePrivateDir(path.join(resolveCurrentCacheRoot(), key));
    const record = readProjectRecord(dir);
    if (!shouldUseCachedIndex(record ? record.coldIndexing : null)) {
      vlog(
        record && record.coldIndexing
          ? `userdir: the index is small (${JSON.stringify(record.coldIndexing)}); using a temporary one`
          : 'userdir: indexing time not measured yet; using a temporary one'
      );
      return createTemporaryUserdir();
    }
    userdir = ensurePrivateDir(path.join(dir, 'userdir'));
  } catch (err) {
    vlog(`userdir: no cache (${err.message}); using a temporary one`);
    return createTemporaryUserdir();
  }
  const lockPath = path.join(dir, 'owner.lock');
  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutMs;
  let hasStaleOwner = false;
  for (;;) {
    const r = acquireLockFile(lockPath, { state: 'running' });
    if (r.kind === 'unusable') {
      vlog(`userdir: no owner lock (${r.reason}); using a temporary one`);
      return createTemporaryUserdir();
    }
    if (r.kind === 'acquired') {
      vlog(`userdir: waited ${Date.now() - startedAt}ms for the previous server`);
      const { isReady } = await prepareUserdirForStart(userdir, { hasStaleOwner });
      if (!isReady) {
        releaseLockFile(lockPath, r.nonce);
        vlog('userdir: a leftover server could not be stopped; using a temporary one');
        return createTemporaryUserdir();
      }
      vlog('userdir (cached):', userdir);
      return { kind: 'persistent', userdir, ownerLock: { path: lockPath, nonce: r.nonce } };
    }

    let read;
    try {
      read = readLockRecord(lockPath);
    } catch (err) {
      vlog(`userdir: cannot read the owner lock (${err.message}); using a temporary one`);
      return createTemporaryUserdir();
    }
    if (read.kind === 'missing') continue;
    if (read.kind === 'parsed') {
      const record = read.record;
      const shouldVerifyCommandLine = !(Date.now() - record.createdAt < LOCK_PID_CHECK_AGE_MS);
      const isAliveOrUnknown = async (pid) => {
        if (!Number.isInteger(pid)) return false;
        const p = await inspectToolProcess(pid, { shouldVerifyCommandLine });
        return !p.isAvailable || p.isAlive;
      };
      const isOwnerAlive = await isAliveOrUnknown(record.pid);
      if (isOwnerAlive && record.state === 'running') {
        vlog('userdir: in use by another run; using a temporary one');
        return createTemporaryUserdir();
      }
      const isWatchdogAlive = await isAliveOrUnknown(record.server && record.server.watchdogPid);
      if (!isOwnerAlive && !isWatchdogAlive && breakStaleLock(lockPath, read)) {
        hasStaleOwner = true;
        continue;
      }
    } else if ((await isLockStale(read, Date.now())) && breakStaleLock(lockPath, read)) {
      hasStaleOwner = true;
      continue;
    }
    // The previous run is shutting its server down.
    if (hasDeadlinePassed(deadlineMs)) {
      vlog('userdir: the previous server did not finish in time; using a temporary one');
      return createTemporaryUserdir();
    }
    await waitMs(OWNER_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Deciding whether a file resolves
// ---------------------------------------------------------------------------

/**
 * The diagnostics entry that answers a request for fresh diagnostics: only
 * one that arrived after the request was sent, else null.
 */
function selectEntryAfterRequest(entry, freshRequest) {
  if (freshRequest === null || entry === null) return null;
  return entry.arrivedAtMs >= freshRequest.requestedAtMs ? entry : null;
}

/**
 * Whether an open document resolves (organizing its imports is safe), does
 * not, or cannot be told yet. Pure; every input is passed in.
 *
 * - `entry`: the latest diagnostics for the document since it was opened
 *   (`{ errorCount, arrivedAtMs }`), or null
 * - `indexPhase`: `{ kind: 'indexing' }` or `{ kind: 'complete', completionCount, completedAtMs }`
 * - `capMs`: the longest wait, counted from `openedAtMs`
 * - `settleMs`: how long errors must stay unchanged after indexing
 *
 * Returns `{ kind: 'resolved' }`, `{ kind: 'unresolved', reason }` (reason
 * 'errors after indexing' or 'wait limit'), or `{ kind: 'pending', wakeAtMs,
 * shouldRequestFreshDiagnostics }`, where `wakeAtMs` is when the answer can
 * change with time alone (the limit, when nothing earlier).
 */
function decideResolution({
  entry,
  indexPhase,
  isPersistentUserdir,
  completionCountAtOpen,
  freshRequest,
  openedAtMs,
  nowMs,
  capMs,
  settleMs,
}) {
  const capAtMs = openedAtMs + capMs;
  const pending = (wakeAtMs = capAtMs) => ({ kind: 'pending', wakeAtMs, shouldRequestFreshDiagnostics: false });

  // At the limit, the latest result decides. (A NaN limit counts as reached.)
  if (!(nowMs < capAtMs)) {
    return entry !== null && entry.errorCount === 0 ? { kind: 'resolved' } : { kind: 'unresolved', reason: 'wait limit' };
  }

  // With a cached index, a result computed before indexing completes may come
  // from the stale index, so nothing is decided while indexing runs.
  if (isPersistentUserdir && indexPhase.kind === 'indexing') return pending();
  // A document opened before the latest completion has results computed
  // before it: ask for fresh diagnostics once per completion, then decide on
  // the first result that arrived after asking, once it stops changing.
  const isOpenedBeforeCompletion =
    isPersistentUserdir && indexPhase.kind === 'complete' && completionCountAtOpen !== indexPhase.completionCount;
  if (isOpenedBeforeCompletion) {
    if (freshRequest === null || freshRequest.completionCount !== indexPhase.completionCount) {
      return { kind: 'pending', wakeAtMs: capAtMs, shouldRequestFreshDiagnostics: true };
    }
    const fresh = selectEntryAfterRequest(entry, freshRequest);
    if (fresh === null) return pending();
    const settledAtMs = fresh.arrivedAtMs + settleMs;
    if (nowMs < settledAtMs) return pending(settledAtMs);
    return fresh.errorCount === 0 ? { kind: 'resolved' } : { kind: 'unresolved', reason: 'errors after indexing' };
  }

  // No errors: resolved, even before indexing completes (a fresh index has
  // nothing stale to report).
  if (entry !== null && entry.errorCount === 0) return { kind: 'resolved' };
  // Errors reported after indexing completed, and unchanged for settleMs: the
  // file does not resolve, and waiting longer would not change that.
  if (entry !== null && indexPhase.kind === 'complete') {
    // Errors from before completion are recomputed after it; wait for that.
    if (entry.arrivedAtMs < indexPhase.completedAtMs) return pending();
    const settledAtMs = entry.arrivedAtMs + settleMs;
    return nowMs >= settledAtMs ? { kind: 'unresolved', reason: 'errors after indexing' } : pending(settledAtMs);
  }
  return pending();
}

// ---------------------------------------------------------------------------
// One running language server and the documents open in it
// ---------------------------------------------------------------------------

/**
 * A running language server and what this tool knows about its documents.
 *
 * Every open, change and close of a document goes through this class, so the
 * text the server holds is always known (`doc.serverText`). Formatting edits
 * are computed against that text; applying them to any other text corrupts
 * the file.
 */
class ServerSession {
  constructor(proc) {
    this.proc = proc;
    this.socket = null;
    this.client = null;
    this.startedAtMs = Date.now();
    // Set when the server process exits: `{ code }`.
    this.exitInfo = null;
    // Organizing imports rewrites the whole import block from the types the
    // compiler can resolve. Before the project's classpath is ready nothing
    // resolves, so the server would drop every import it cannot see. Track
    // diagnostics (uri → { errorCount, arrivedAtMs }, latest only) and only
    // organize once the file compiles clean.
    this.diagnostics = new Map();
    // Indexing state, from `$/progress` and the scan-finished signals
    // ("Indexing completed.", or the reply to the workspace/symbol probe).
    this.activeProgressTokens = new Set();
    this.hasScanFinishedSignal = false;
    this.hasSentScanProbe = false;
    // The per-wait limit (--timeout), for requests the session sends itself.
    this.timeoutMs = undefined;
    this.completionCount = 0;
    this.indexPhase = { kind: 'indexing' };
    // When the workspace was opened, and when indexing first completed (null: not yet).
    this.initializedAtMs = this.startedAtMs;
    this.firstIndexCompletedAtMs = null;
    // A reused (cached) index can report a file clean before the index is
    // brought up to date, so with one only results after indexing count.
    this.isPersistentUserdir = false;
    // `{ path, nonce }` of the cached userdir's owner lock, when this server uses one.
    this.ownerLock = null;
    // 'diagnostics' (uri), 'indexPhase', 'exit'
    this.events = new EventEmitter();
    // Some code actions push their result instead of returning it. Keep the
    // last pushed edit so the organize-imports step can pick it up.
    this.pushedEdit = null;
    proc.on('exit', (code) => {
      this.exitInfo = { code };
      vlog('server exited, code', code);
      if (this.client) this.client.rejectAll(new ServerExitedError(code));
      this.events.emit('exit');
    });
  }

  /**
   * Start nbcode, connect to it and initialize the workspace at rootDir. Each
   * of the three waits may take up to `timeoutMs`; past that, TimeoutError.
   *
   * The watchdog is started in the same tick as nbcode, so there is no
   * moment in which this process could die and leave the server unwatched.
   */
  static async start({ nbcodePath, jdkHome, rootDir, timeoutMs, lease }) {
    const { userdir } = lease;
    const ownerLock = lease.kind === 'persistent' ? lease.ownerLock : null;
    const { proc, listening } = startServer(nbcodePath, jdkHome, userdir);
    const session = new ServerSession(proc);
    session.timeoutMs = timeoutMs;
    session.isPersistentUserdir = lease.kind === 'persistent';
    session.ownerLock = ownerLock;
    const isPosix = process.platform !== 'win32';
    session.watchdogConfig = {
      pgid: isPosix ? proc.pid : null,
      launcherPid: proc.pid,
      userdir,
      isTemporaryUserdir: lease.kind === 'temporary',
      ownerLockPath: ownerLock ? ownerLock.path : null,
      lockNonce: ownerLock ? ownerLock.nonce : null,
    };
    session.watchdog = spawnServerWatchdog(session.watchdogConfig, () => {
      session.watchdog = null;
    });
    startedServers.add(session);
    if (ownerLock) {
      updateLockFile(ownerLock.path, ownerLock.nonce, {
        server: {
          pgid: session.watchdogConfig.pgid,
          launcherPid: proc.pid,
          watchdogPid: session.watchdog ? session.watchdog.pid : null,
        },
      });
    }
    try {
      const { port, hash } = await awaitWithTimeout(listening, timeoutMs);
      session.socket = await awaitWithTimeout(connect(port, hash), timeoutMs);
      session.client = new LspClient(session.socket, { onClose: () => session.failPendingAfterExit() });
      session.registerHandlers();
      await session.initialize(rootDir, timeoutMs);
      return session;
    } catch (err) {
      signalOwnServer(proc, 'SIGTERM');
      throw err;
    }
  }

  /**
   * The connection dropped. Fail what is pending with the exit code once the
   * process is gone (the exit usually follows within moments).
   */
  failPendingAfterExit() {
    if (this.exitInfo) {
      this.client.rejectAll(new ServerExitedError(this.exitInfo.code));
      return;
    }
    const timer = setTimeout(() => this.client.rejectAll(new ServerExitedError(null)), SHUTDOWN_WAIT_MS);
    this.proc.once('exit', () => clearTimeout(timer));
  }

  registerHandlers() {
    const client = this.client;
    // Reply to server-initiated requests so it never blocks waiting on us.
    client.onRequest('workspace/configuration', (params) => {
      if (process.env.KJF_DUMP) console.error('CONFIG?', JSON.stringify(params));
      return (params && params.items ? params.items : []).map(() => null);
    });
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('client/unregisterCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);
    client.onRequest('window/showMessageRequest', () => null);

    // Report a pushed edit as applied because we do apply it, just to our own
    // copy of the text.
    client.onRequest('workspace/applyEdit', (params) => {
      if (params && params.edit) {
        this.pushedEdit = params.edit;
        return { applied: true };
      }
      return { applied: false };
    });

    client.onNotification('textDocument/publishDiagnostics', (params) => this.handleDiagnostics(params));
    client.onNotification('$/progress', (params) => this.handleProgress(params));
    client.onNotification('window/showMessage', (params) => this.handleShowMessage(params));
  }

  async initialize(rootDir, timeoutMs) {
    const client = this.client;
    const rootUri = pathToFileURL(rootDir).href;
    const initResult = await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'kiro-java-format', version: '1.1.0' },
      locale: 'en',
      rootPath: rootDir,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true },
          formatting: { dynamicRegistration: true },
          // resolveSupport / dataSupport put the server on the lazy path: the
          // code action comes back without an edit and we ask for it with
          // codeAction/resolve. Without them the server has no way to hand the
          // edit to a client that cannot apply workspace edits itself.
          codeAction: {
            dynamicRegistration: true,
            isPreferredSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ['edit'] },
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['', 'source', 'source.organizeImports'] },
            },
          },
          // Asked for so the server reports whether the file resolves. Organize
          // imports is only safe once it does.
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: {
          applyEdit: true,
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: true },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions: {
        nbcodeCapabilities: {
          statusBarMessageSupport: false,
          testResultsSupport: false,
          showHtmlPageSupport: false,
          wantsJavaSupport: true,
          wantsGroovySupport: false,
          wantsTelemetryEnabled: false,
          commandPrefix: 'jdk',
          configurationPrefix: 'jdk.',
          altConfigurationPrefix: 'jdk.',
          wantsNotebookSupport: false,
        },
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(rootDir) }],
    }, timeoutMs);
    if (process.env.KJF_DUMP) console.error('SERVER CAPS', JSON.stringify(initResult));
    client.notify('initialized', {});
    this.initializedAtMs = Date.now();
  }

  /** Milliseconds since this session started, for -v. */
  measureElapsedMs() {
    return Date.now() - this.startedAtMs;
  }

  /**
   * How long indexing took, counted from the moment the workspace was opened
   * (`initialized`): `{ kind: 'complete', durationMs }`, or, when it had not
   * completed by `nowMs`, `{ kind: 'incomplete', minimumMs }`.
   */
  measureIndexingTime(nowMs) {
    const from = this.initializedAtMs;
    if (this.firstIndexCompletedAtMs !== null) {
      return { kind: 'complete', durationMs: Math.max(0, this.firstIndexCompletedAtMs - from) };
    }
    return { kind: 'incomplete', minimumMs: Math.max(0, nowMs - from) };
  }

  handleProgress(params) {
    if (!params || params.token === undefined || !params.value) return;
    const token = String(params.token);
    if (params.value.kind === 'begin') {
      this.activeProgressTokens.add(token);
      vlog(`+${this.measureElapsedMs()}ms progress begin ${token}: ${params.value.title || ''}`);
      if (this.indexPhase.kind === 'complete') {
        this.indexPhase = { kind: 'indexing' };
        this.events.emit('indexPhase');
      }
    } else if (params.value.kind === 'end') {
      this.activeProgressTokens.delete(token);
      vlog(`+${this.measureElapsedMs()}ms progress end ${token}`);
      this.updateIndexPhase();
    }
  }

  handleShowMessage(params) {
    if (!params || typeof params.message !== 'string') return;
    if (params.message.trim() !== 'Indexing completed.') return;
    this.acceptScanFinishedSignal('Indexing completed.');
  }

  /**
   * The second way to learn the initial scan finished: NBLS answers
   * workspace/symbol only once the scan is done, whatever the message
   * language. Sent once, after the first diagnostics (by then the projects
   * are open). Only a successful reply counts; an error or a timeout is not
   * a signal.
   */
  sendScanProbe() {
    if (this.hasSentScanProbe || !this.client) return;
    this.hasSentScanProbe = true;
    this.client.request('workspace/symbol', { query: 'KjfScanFinishedProbe' }, this.timeoutMs).then(
      () => this.acceptScanFinishedSignal('workspace/symbol reply'),
      (err) => vlog(`+${this.measureElapsedMs()}ms workspace/symbol failed, not a scan signal: ${err.message}`)
    );
  }

  acceptScanFinishedSignal(source) {
    vlog(`+${this.measureElapsedMs()}ms scan finished signal: ${source}`);
    this.hasScanFinishedSignal = true;
    this.updateIndexPhase();
  }

  handleDiagnostics(params) {
    if (!params || !params.uri) return;
    const list = params.diagnostics || [];
    const errorCount = list.filter((d) => d.severity === 1).length;
    this.diagnostics.set(params.uri, { errorCount, arrivedAtMs: Date.now() });
    vlog(`+${this.measureElapsedMs()}ms diagnostics ${params.uri}: ${errorCount} error(s)`);
    if (process.env.KJF_DUMP) {
      const errors = list.filter((d) => d.severity === 1);
      console.error(
        `DIAG ${new Date().toISOString()} ${params.uri} total=${list.length} errors=${errors.length}`,
        errors.length > 0 ? JSON.stringify(errors.slice(0, 3)) : ''
      );
    }
    this.events.emit('diagnostics', params.uri);
    this.sendScanProbe();
  }

  /**
   * Indexing is complete when the scan has signalled it finished and no
   * progress is running. A progress that ends without the signal (the
   * "Collecting workspace projects" step comes first) does not complete it.
   */
  updateIndexPhase() {
    if (!this.hasScanFinishedSignal || this.activeProgressTokens.size > 0) return;
    if (this.indexPhase.kind === 'complete') return;
    this.completionCount += 1;
    this.indexPhase = { kind: 'complete', completionCount: this.completionCount, completedAtMs: Date.now() };
    if (this.firstIndexCompletedAtMs === null) this.firstIndexCompletedAtMs = this.indexPhase.completedAtMs;
    vlog(`+${this.measureElapsedMs()}ms indexing complete (${this.completionCount})`);
    this.events.emit('indexPhase');
  }

  /** The latest diagnostics entry for `uri` that arrived at or after `sinceMs`, or null. */
  findDiagnosticEntry(uri, sinceMs) {
    for (const [key, entry] of this.diagnostics) {
      if (sameUri(key, uri)) return entry.arrivedAtMs >= sinceMs ? entry : null;
    }
    return null;
  }

  /**
   * Wait until it is clear whether the open document resolves; resolves to
   * `{ isResolved, reason }`.
   *
   * This is the gate for organizing imports. The server rebuilds the import
   * block from the types it can resolve, so running it while the classpath is
   * still loading deletes every import it cannot see. The decision itself is
   * decideResolution; this re-evaluates it whenever diagnostics for the
   * document arrive, the indexing state changes, or the time it named passes.
   */
  waitForResolution(doc, capMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const stop = () => {
        clearTimeout(timer);
        this.events.removeListener('diagnostics', onDiagnostics);
        this.events.removeListener('indexPhase', evaluate);
        this.events.removeListener('exit', evaluate);
      };
      const evaluate = () => {
        if (this.exitInfo) {
          stop();
          reject(new ServerExitedError(this.exitInfo.code));
          return;
        }
        const nowMs = Date.now();
        const decision = decideResolution({
          entry: this.findDiagnosticEntry(doc.uri, doc.openedAtMs),
          indexPhase: this.indexPhase,
          isPersistentUserdir: this.isPersistentUserdir,
          completionCountAtOpen: doc.completionCountAtOpen,
          freshRequest: doc.freshRequest,
          openedAtMs: doc.openedAtMs,
          nowMs,
          capMs,
          settleMs: POST_INDEX_SETTLE_MS,
        });
        if (decision.kind === 'pending' && decision.shouldRequestFreshDiagnostics) {
          this.requestFreshDiagnostics(doc);
          doc.freshRequest = { completionCount: this.completionCount, requestedAtMs: Date.now() };
          evaluate();
          return;
        }
        if (decision.kind === 'pending') {
          clearTimeout(timer);
          timer = setTimeout(evaluate, Math.max(0, decision.wakeAtMs - nowMs));
          return;
        }
        stop();
        const reason = decision.kind === 'resolved' ? 'resolves' : decision.reason;
        vlog(`+${this.measureElapsedMs()}ms ${doc.uri}: ${reason} after ${nowMs - doc.openedAtMs}ms`);
        resolve({ isResolved: decision.kind === 'resolved', reason: decision.kind === 'resolved' ? null : decision.reason });
      };
      const onDiagnostics = (uri) => {
        if (sameUri(uri, doc.uri)) evaluate();
      };
      this.events.on('diagnostics', onDiagnostics);
      this.events.on('indexPhase', evaluate);
      this.events.on('exit', evaluate);
      evaluate();
    });
  }

  /**
   * Open `uri` with `text` and return the document.
   *
   * What the server said about this path earlier is dropped first, so the
   * resolve gate reads the result for this open, not an earlier one.
   */
  openDocument(uri, text) {
    for (const key of [...this.diagnostics.keys()]) {
      if (sameUri(key, uri)) this.diagnostics.delete(key);
    }
    const doc = {
      uri,
      version: 1,
      serverText: normalizeLineEndings(text),
      openedAtMs: Date.now(),
      completionCountAtOpen: this.completionCount,
      freshRequest: null,
    };
    this.client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'java', version: doc.version, text },
    });
    return doc;
  }

  /**
   * Replace the whole content of an open document with `text` (already
   * normalized), in place.
   *
   * The document stays open. Closing and reopening the URI instead races the
   * server's asynchronous close: the server can end up holding the old text,
   * and formatting edits computed against it land at the wrong offsets.
   */
  changeDocument(doc, text) {
    doc.version += 1;
    this.client.notify('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ range: fullRange(doc.serverText), text }],
    });
    doc.serverText = text;
  }

  /**
   * Make the server compute the document's diagnostics again, without
   * changing its content: a didChange that replaces the first character with
   * itself (for an empty document, a newline inserted and removed again).
   */
  requestFreshDiagnostics(doc) {
    const send = (range, text) => {
      doc.version += 1;
      this.client.notify('textDocument/didChange', {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ range, text }],
      });
    };
    const at = (line, character) => ({ line, character });
    if (doc.serverText.length > 0) {
      send({ start: at(0, 0), end: at(0, 1) }, doc.serverText[0]);
    } else {
      send({ start: at(0, 0), end: at(0, 0) }, '\n');
      send({ start: at(0, 0), end: at(1, 0) }, '');
    }
    vlog(`+${this.measureElapsedMs()}ms requested fresh diagnostics for ${doc.uri}`);
  }

  closeDocument(doc) {
    this.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  takePushedEdit() {
    const edit = this.pushedEdit;
    this.pushedEdit = null;
    return edit;
  }

  /**
   * Run the editor's "Organize Imports" on the open document.
   *
   * Returns the resulting text, or the input unchanged when the server has
   * nothing to do. Formatting runs afterwards, so this only has to get the
   * import block right — not its indentation.
   */
  async organizeImports(doc, text, timeoutMs) {
    const client = this.client;
    const uri = doc.uri;
    // An edit pushed while an earlier file was organized must not be taken
    // for this one.
    this.pushedEdit = null;
    let actions;
    try {
      actions = await client.request(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range: fullRange(text),
          context: { diagnostics: [], only: ['source.organizeImports'] },
        },
        timeoutMs
      );
    } catch (err) {
      if (isServerUnusable(err)) throw err;
      // Leave the imports rather than the whole file: formatting still works.
      vlog('textDocument/codeAction failed:', err.message);
      return text;
    }
    if (process.env.KJF_DUMP) console.error('ACTIONS', JSON.stringify(actions));
    // Only take the organize-imports action. Asking with `only` should give
    // nothing else, but a Command (no `kind`) would be a different operation
    // and running it blindly could change code, not imports.
    const action = Array.isArray(actions)
      ? actions.find((a) => a && a.kind === 'source.organizeImports')
      : null;
    if (!action) {
      vlog('organize imports not offered, leaving imports as they are');
      return text;
    }

    // The action arrives without an edit; the server computes it on resolve.
    let resolved = action;
    if (!resolved.edit) {
      try {
        resolved = await client.request('codeAction/resolve', action, timeoutMs);
      } catch (err) {
        if (isServerUnusable(err)) throw err;
        vlog('codeAction/resolve failed:', err.message);
        return text;
      }
    }
    const edit = (resolved && resolved.edit) || this.takePushedEdit();
    const edits = editsForUri(edit, uri);
    if (process.env.KJF_DUMP) console.error('IMPORT EDITS', JSON.stringify(edits));
    if (edits.length === 0) return text;
    validateEditsWithinText(text, edits);
    return applyEdits(text, edits);
  }

  formatDocument(doc, { tabSize, insertSpaces }, timeoutMs) {
    return this.client.request(
      'textDocument/formatting',
      { textDocument: { uri: doc.uri }, options: { tabSize, insertSpaces } },
      timeoutMs
    );
  }

  /** Ask the server to shut down and close the connection. */
  async close() {
    try {
      await this.client.request('shutdown', null, SHUTDOWN_WAIT_MS);
      this.client.notify('exit', null);
    } catch {
      /* ignore */
    }
    this.markOwnerLockReleasing();
    this.socket.end();
  }

  /**
   * Tell the next run that this server is on its way out (it then waits for
   * the watchdog instead of taking a temporary userdir).
   */
  markOwnerLockReleasing() {
    if (this.ownerLock) updateLockFile(this.ownerLock.path, this.ownerLock.nonce, { state: 'releasing' });
  }
}

/**
 * Errors after which the server cannot be asked anything more for this file:
 * it did not answer in time, or it is gone. Other error replies leave the
 * imports as they are and formatting goes on.
 */
function isServerUnusable(err) {
  return err instanceof TimeoutError || err instanceof ServerExitedError;
}

// ---------------------------------------------------------------------------
// Formatting files
// ---------------------------------------------------------------------------

/**
 * Organize, format and write one file. Returns this file's exit code: 1 when
 * it would be reformatted (--check) or failed, otherwise 0.
 *
 * One bad file must not abandon the rest: a run over a whole tree would then
 * leave some files formatted and the remainder untouched, with no way to tell
 * where it stopped. So failures are reported here and not thrown.
 *
 * The file is read, formatted and written under its lock, so another run of
 * this tool on the same file waits instead of reading a half-written file.
 */
function formatOneFile(session, file, opts) {
  return runWithFileLock(file, opts.timeoutMs, () => formatLockedFile(session, file, opts));
}

async function formatLockedFile(session, file, opts) {
  const uri = pathToFileURL(file).href;
  const original = fs.readFileSync(file, 'utf8');
  let current = original;
  let doc = null;
  try {
    doc = session.openDocument(uri, current);

    if (opts.organizeImports) {
      const resolution = await session.waitForResolution(doc, Math.min(RESOLVE_WAIT_MS, opts.timeoutMs));
      if (resolution.isResolved) {
        const organized = await session.organizeImports(doc, current, opts.timeoutMs);
        if (organized !== current) {
          current = organized;
          // Hand the server what we hold, so the formatting edits line up
          // with our text.
          session.changeDocument(doc, normalizeLineEndings(current));
        }
      } else {
        // Organizing now would drop the imports of everything that does not
        // resolve. Formatting is still safe, so carry on with it.
        console.log(`imports skipped (file does not resolve): ${file}`);
      }
    }

    const edits = await session.formatDocument(
      doc,
      { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces },
      opts.timeoutMs
    );

    session.closeDocument(doc);
    doc = null;

    if (process.env.KJF_DUMP) console.error('EDITS', JSON.stringify(edits));
    validateEditsWithinText(current, edits);
    const result = edits && edits.length > 0 ? applyEdits(current, edits) : current;
    if (result === original) {
      console.log(`unchanged: ${file}`);
      return 0;
    }
    if (opts.check) {
      console.log(`would reformat: ${file}`);
      return 1;
    }
    writeFileIfUnchanged(file, result, original);
    console.log(`formatted: ${file}`);
    return 0;
  } catch (err) {
    // Close so the server does not keep holding a document we abandoned.
    if (doc) {
      try {
        session.closeDocument(doc);
      } catch {
        /* ignore */
      }
    }
    console.error(`error: ${file}: ${err && err.message ? err.message : String(err)}`);
    // Without a server nothing else can be formatted; formatFiles reports the rest.
    if (err instanceof ServerExitedError) throw err;
    return 1;
  }
}

/**
 * Split the file arguments so that no part holds the same file twice.
 *
 * A new part starts whenever a file (by real path) is already in the current
 * one: `[A, B, A]` becomes `[[A, B], [A]]`. Each part gets its own language
 * server, so no server ever reopens a URI it has closed. Reopening a closed
 * URI races the server's asynchronous close the same way reopening after
 * organize did.
 */
function splitIntoSegments(files) {
  const segments = [];
  let current = [];
  let seen = new Set();
  for (const file of files) {
    const key = fs.realpathSync(file);
    if (seen.has(key)) {
      segments.push(current);
      current = [];
      seen = new Set();
    }
    current.push(file);
    seen.add(key);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Format `files` in order and return the exit code. Each segment (see
 * splitIntoSegments) runs in its own language server. Throws when a server
 * cannot be started; failures of single files are reported by formatOneFile.
 *
 * When a server exits in the middle, every file it did not get to is
 * reported with the same error at once, and no further server is started.
 */
async function formatFiles(files, context) {
  const { opts, extPath, jdkHome, rootDir } = context;
  const notStarted = [...files];
  const isCacheAllowed = !hasMixedProjectRoots(files, opts.root);
  if (!isCacheAllowed) vlog('files from more than one project root; using a temporary userdir');
  const projectKey = computeProjectKey(rootDir, extPath, jdkHome);
  let exitCode = 0;
  try {
    const segments = splitIntoSegments(files);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      // Only the first segment can use the cached index: the others exist to
      // give a repeated file a fresh server (see splitIntoSegments).
      const lease = i === 0 && isCacheAllowed ? await acquireUserdir(projectKey, opts.timeoutMs) : createTemporaryUserdir();
      let indexing = null;
      await runWithServerSession(context, lease, async (session) => {
        for (const file of segment) {
          notStarted.shift();
          exitCode = Math.max(exitCode, await formatOneFile(session, file, context.opts));
        }
        indexing = session.measureIndexingTime(Date.now());
      });
      // A temporary userdir starts from an empty index, so its run tells how
      // long this project takes to index. A cached one does not: it starts
      // warm. Files from other roots are indexed too, so such a run does not
      // count either.
      if (lease.kind === 'temporary' && isCacheAllowed) {
        saveColdIndexingRecord(projectKey, { root: rootDir, extPath, jdkHome }, indexing);
      }
    }
  } catch (err) {
    if (!(err instanceof ServerExitedError)) throw err;
    for (const file of notStarted) console.error(`error: ${file}: ${err.message}`);
    return 1;
  }
  return exitCode;
}

/**
 * Start a language server in the userdir of `lease`, run `fn` with it, then
 * ask it to exit. Waiting for the JVM to go, deleting a temporary userdir and
 * releasing the owner lock are left to its watchdog.
 */
async function runWithServerSession({ opts, nbcodePath, jdkHome, rootDir }, lease, fn) {
  const session = await ServerSession.start({ nbcodePath, jdkHome, rootDir, timeoutMs: opts.timeoutMs, lease });
  await fn(session);
  await session.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (process.argv[2] === '--internal-watchdog') {
    runWatchdog(JSON.parse(process.argv[3]));
    return;
  }
  installExitHandlers();
  const opts = parseArgs(process.argv.slice(2));
  VERBOSE = opts.verbose;

  if (opts.files.length === 0) {
    printHelp();
    process.exit(1);
  }
  for (const f of opts.files) {
    if (!fs.existsSync(f)) fail(`No such file: ${f}`);
    if (!f.endsWith('.java')) fail(`Not a .java file: ${f}`);
  }

  const extPath = findExtension();
  const nbcodePath = findNbcode(extPath);
  const jdkHome = findJdkHome(opts.jdkHome);

  const rootDir = detectRoot(opts.files[0], opts.root);
  vlog('root:', rootDir);

  let exitCode = 0;
  try {
    exitCode = await formatFiles(opts.files, { opts, extPath, nbcodePath, jdkHome, rootDir });
  } catch (err) {
    await prepareForExit({ isAbnormal: true });
    fail(err && err.message ? err.message : String(err));
  }

  await prepareForExit({ isAbnormal: false });
  exitAfterFlush(exitCode);
}

if (require.main === module) main();

module.exports = {
  applyEdits,
  fullRange,
  editsForUri,
  sameUri,
  lineStarts,
  detectRoot,
  normalizeLineEndings,
  validateEditsWithinText,
  EditsMismatchError,
  splitIntoSegments,
  resolveCacheRoot,
  ensurePrivateDir,
  isProcessInspectionAvailable,
  inspectToolProcess,
  readLockRecord,
  acquireLockFile,
  isLockStale,
  breakStaleLock,
  releaseLockFile,
  updateLockFile,
  LOCK_PID_CHECK_AGE_MS,
  LOCK_UNPARSABLE_STALE_MS,
  ChangedOnDiskError,
  writeFileIfUnchanged,
  resolveLockDir,
  runWithFileLock,
  TimeoutError,
  ServerExitedError,
  awaitWithTimeout,
  LspClient,
  hasUserdirToken,
  hasUserdirTokenInArgv,
  parseProcStat,
  findProcessesUsingUserdir,
  terminateServerProcesses,
  decideResolution,
  selectEntryAfterRequest,
  ServerSession,
  POST_INDEX_SETTLE_MS,
  computeProjectKey,
  hasMixedProjectRoots,
  acquireUserdir,
  prepareUserdirForStart,
  MIN_COLD_INDEXING_MS_FOR_CACHE,
  shouldUseCachedIndex,
  resolveColdIndexingRecord,
  readProjectRecord,
  saveColdIndexingRecord,
};
