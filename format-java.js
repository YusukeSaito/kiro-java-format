#!/usr/bin/env node
'use strict';

/*
 * kiro-java-format
 *
 * Copyright (c) 2026 Yusuke Saito.
 * Licensed under the Apache License, Version 2.0.
 *
 * Formats Java files from the command line by driving the language server
 * bundled inside the installed Oracle Java extension (oracle.oracle-java).
 *
 * It launches `nbcode` as a Java Language Server (the exact same backend the
 * VS Code / Kiro extension uses), connects over the local socket, opens each
 * file, asks the server to format it (textDocument/formatting) and writes the
 * result back to disk.
 *
 * No external npm dependencies. Node 16+.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
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

Options:
  --root <dir>      Project root to open (default: nearest pom.xml/build.gradle, else file's dir)
  --jdkhome <dir>   JDK 17+ home used to run the language server (auto-detected if omitted)
  --tab-size <n>    Indent size hint sent to the formatter (default: 4)
  --use-tabs        Indent with tabs instead of spaces
  --check           Do not write; exit 1 if any file is not already formatted
  --timeout <sec>   Max seconds to wait for the server (default: 120)
  -v, --verbose     Print server / protocol diagnostics
  -h, --help        Show this help

Environment:
  KIRO_JAVA_EXT       Override path to the extension directory (the one containing nbcode/)
  KIRO_JAVA_JDKHOME   Override JDK home (same as --jdkhome)

Exit codes:
  0  success (formatted, or already formatted in --check mode)
  1  a file changed (in --check mode) or a runtime error occurred
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
// Minimal LSP client over a socket
// ---------------------------------------------------------------------------
class LspClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
    socket.on('data', (chunk) => this._onData(chunk));
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
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
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
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    this.socket.write(Buffer.concat([header, payload]));
  }

  request(method, params) {
    const id = this.nextId++;
    this._send({ jsonrpc: '2.0', id, method, params });
    vlog('req ->', method, id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
function startServer(nbcodePath, jdkHome, userdir) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (jdkHome) args.push('--jdkhome', jdkHome);
    args.push('--userdir', userdir);
    args.push('-J-XX:PerfMaxStringConstLength=10240');
    args.push('--start-java-language-server=listen-hash:0');
    args.push('-J--add-exports=jdk.compiler/com.sun.tools.javac.resources=ALL-UNNAMED');

    vlog('spawn', nbcodePath, args.join(' '));
    const proc = spawn(nbcodePath, args, { cwd: userdir, stdio: ['ignore', 'pipe', 'pipe'] });

    let started = false;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      vlog('server stdout:', text.trimEnd());
      if (!started) {
        const info = text.match(/Java Language Server listening at port (\d+) with hash (\S+)/);
        if (info) {
          started = true;
          resolve({ proc, port: parseInt(info[1], 10), hash: info[2] });
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      vlog('server stderr:', chunk.toString().trimEnd());
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (!started) reject(new Error(`nbcode exited (code ${code}) before starting the LSP server.\n${stderr}`));
    });
  });
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
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

  const userdir = path.join(os.tmpdir(), `kiro-java-format-userdir-${process.pid}`);
  fs.mkdirSync(userdir, { recursive: true });

  const rootDir = detectRoot(opts.files[0], opts.root);
  vlog('root:', rootDir);

  let server;
  const timeout = setTimeout(() => {
    fail(`Timed out after ${opts.timeoutMs / 1000}s waiting for the language server. Try --timeout or --verbose.`);
  }, opts.timeoutMs);

  let exitCode = 0;
  try {
    server = await startServer(nbcodePath, jdkHome, userdir);
    const socket = await connect(server.port, server.hash);
    const client = new LspClient(socket);

    // Reply to server-initiated requests so it never blocks waiting on us.
    client.onRequest('workspace/configuration', (params) => {
      if (process.env.KJF_DUMP) console.error('CONFIG?', JSON.stringify(params));
      return (params && params.items ? params.items : []).map(() => null);
    });
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('client/unregisterCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);
    client.onRequest('window/showMessageRequest', () => null);
    client.onRequest('workspace/applyEdit', () => ({ applied: false }));

    const rootUri = pathToFileURL(rootDir).href;
    await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'kiro-java-format', version: '1.0.0' },
      locale: 'en',
      rootPath: rootDir,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true },
          formatting: { dynamicRegistration: true },
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
    });
    client.notify('initialized', {});

    for (const file of opts.files) {
      const uri = pathToFileURL(file).href;
      const original = fs.readFileSync(file, 'utf8');

      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'java', version: 1, text: original },
      });

      const edits = await client.request('textDocument/formatting', {
        textDocument: { uri },
        options: { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces },
      });

      client.notify('textDocument/didClose', { textDocument: { uri } });

      if (process.env.KJF_DUMP) console.error('EDITS', JSON.stringify(edits));
      if (!edits || edits.length === 0) {
        console.log(`unchanged: ${file}`);
        continue;
      }
      const formatted = applyEdits(original, edits);
      if (formatted === original) {
        console.log(`unchanged: ${file}`);
        continue;
      }
      if (opts.check) {
        console.log(`would reformat: ${file}`);
        exitCode = 1;
      } else {
        fs.writeFileSync(file, formatted, 'utf8');
        console.log(`formatted: ${file}`);
      }
    }

    try {
      await client.request('shutdown', null);
      client.notify('exit', null);
    } catch {
      /* ignore */
    }
    socket.end();
  } catch (err) {
    clearTimeout(timeout);
    if (server && server.proc) server.proc.kill();
    cleanup(userdir);
    fail(err && err.message ? err.message : String(err));
  }

  clearTimeout(timeout);
  if (server && server.proc) server.proc.kill();
  cleanup(userdir);
  process.exit(exitCode);
}

function cleanup(userdir) {
  try {
    fs.rmSync(userdir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main();
