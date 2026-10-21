'use strict';

/*
 * A stand-in for nbcode's language server, for tests that do not need Java.
 * It listens like `--start-java-language-server=listen-hash:0`, checks the
 * hash, and answers the requests the CLI sends: no code actions, no edits,
 * no errors (unless asked for below). It keeps the text of each open document
 * as the didOpen and didChange notifications leave it. It creates
 * <userdir>/lock while it runs, as NetBeans does.
 *
 * Environment:
 *   FAKE_EXIT_BEFORE_LISTEN=<code>      exit with <code> before listening
 *   FAKE_START_DELAY_MS=<ms>            wait before listening
 *   FAKE_NO_REPLY=<method>:<n>          never answer the n-th <method> request
 *   FAKE_EXIT_ON=<method>:<n>:<code>    exit with <code> on the n-th <method> request
 *   FAKE_IGNORE_SIGTERM=1               ignore SIGTERM (only SIGKILL stops it)
 *   FAKE_NO_INDEXING_MESSAGE=1          never send "Indexing completed."
 *   FAKE_DIAGNOSTICS_DELAY_MS=<ms>      publish diagnostics <ms> after didOpen/didChange (default 30)
 *   FAKE_ERROR_MARKER=<text>            report one error for a document whose text holds <text>
 *                                       (when the diagnostics are published)
 *   FAKE_INDEXING_MS=<ms>               report indexing as a `$/progress` from `initialized` until <ms>
 *                                       later; when it ends, publish the diagnostics of every open
 *                                       document again
 *   FAKE_INDEXING_AFTER_MS=<ms>         begin that indexing <ms> after `initialized` instead; past the
 *                                       "Indexing completed." message (20 ms), indexing begins again
 *   FAKE_ERROR_WHILE_INDEXING=<text>    report one error for a document whose text holds <text> while
 *                                       that indexing runs
 *   FAKE_COLLAPSE_SPACES=1              formatting replaces each run of spaces with one space
 *   FAKE_FORMATTING_DELAY_MS=<ms>       answer textDocument/formatting <ms> late
 *   FAKE_LOG=<file>                     append one line per start, per request, and per
 *                                       didOpen/didClose (`open <uri> <ms>`, `close <uri> <ms>`);
 *                                       on didOpen also `lock <uri> held|missing|other`: whether the
 *                                       client (the processId of initialize) holds the file's lock
 *                                       under KIRO_JAVA_FORMAT_CACHE; `indexed <ms>` when the
 *                                       indexing of FAKE_INDEXING_MS ends
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const argv = process.argv.slice(2);
const userdirIndex = argv.indexOf('--userdir');
const userdir = userdirIndex >= 0 ? argv[userdirIndex + 1] : null;
const env = process.env;

function log(line) {
  if (env.FAKE_LOG) fs.appendFileSync(env.FAKE_LOG, `${line}\n`);
}

function parseRule(value) {
  if (!value) return null;
  const parts = value.split(':');
  return { method: parts[0], n: parseInt(parts[1], 10), code: parts.length > 2 ? parseInt(parts[2], 10) : null };
}

const noReply = parseRule(env.FAKE_NO_REPLY);
const exitOn = parseRule(env.FAKE_EXIT_ON);
const diagnosticsDelayMs = parseInt(env.FAKE_DIAGNOSTICS_DELAY_MS || '30', 10);
const formattingDelayMs = parseInt(env.FAKE_FORMATTING_DELAY_MS || '0', 10);
const indexingAfterMs = parseInt(env.FAKE_INDEXING_AFTER_MS || '0', 10);
const lockFile = userdir ? path.join(userdir, 'lock') : null;
// Whether the indexing of FAKE_INDEXING_MS runs.
let isIndexing = false;
// The pid of the CLI, from `initialize`.
let clientPid = null;

/**
 * Whether the client holds the lock of the file at `uri`, by the CLI's rule:
 * `<cache>/locks/<sha256(realpath)[:16]>.lock` holding the CLI's pid.
 */
function inspectFileLock(uri) {
  if (!env.KIRO_JAVA_FORMAT_CACHE) return 'missing';
  let record;
  try {
    const key = crypto.createHash('sha256').update(fs.realpathSync(fileURLToPath(uri))).digest('hex').slice(0, 16);
    record = JSON.parse(fs.readFileSync(path.join(env.KIRO_JAVA_FORMAT_CACHE, 'locks', `${key}.lock`), 'utf8'));
  } catch {
    return 'missing';
  }
  return record.pid === clientPid ? 'held' : 'other';
}

function removeLock() {
  if (lockFile) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* gone */
    }
  }
}

function exit(code) {
  removeLock();
  process.exit(code);
}

if (env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => log('ignored SIGTERM'));
else process.on('SIGTERM', () => exit(143));

log(`start ${process.pid} ${userdir}`);
if (env.FAKE_EXIT_BEFORE_LISTEN) {
  process.stderr.write('fake nbcode: exiting before listen\n');
  exit(parseInt(env.FAKE_EXIT_BEFORE_LISTEN, 10));
}
if (lockFile) fs.writeFileSync(lockFile, String(process.pid));

const counts = new Map();
const hash = crypto.randomBytes(16).toString('hex');
// uri → text of the open documents. Line breaks are LF, as NBLS keeps them after didOpen.
const documents = new Map();

function findOffset(text, pos) {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

function applyContentChange(text, change) {
  if (!change.range) return change.text;
  return text.slice(0, findOffset(text, change.range.start)) + change.text + text.slice(findOffset(text, change.range.end));
}

function buildFullRange(text) {
  const lines = text.split('\n');
  return { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } };
}

function listDiagnostics(uri) {
  const text = documents.get(uri);
  if (text === undefined) return [];
  const hasMarker = (marker) => Boolean(marker) && text.includes(marker);
  const hasError = hasMarker(env.FAKE_ERROR_MARKER) || (isIndexing && hasMarker(env.FAKE_ERROR_WHILE_INDEXING));
  return hasError ? [{ range: buildFullRange(''), severity: 1, message: 'fake error' }] : [];
}

function publishDiagnostics(socket, uri) {
  send(socket, { method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: listDiagnostics(uri) } });
}

/** Run the indexing of FAKE_INDEXING_MS, then publish the diagnostics of the open documents again. */
function startIndexing(socket, durationMs) {
  const token = 'fake-indexing';
  isIndexing = true;
  send(socket, { method: '$/progress', params: { token, value: { kind: 'begin', title: 'Indexing' } } });
  setTimeout(() => {
    isIndexing = false;
    log(`indexed ${Date.now()}`);
    send(socket, { method: '$/progress', params: { token, value: { kind: 'end' } } });
    for (const uri of documents.keys()) publishDiagnostics(socket, uri);
  }, durationMs);
}

function buildFormattingEdits(uri) {
  const text = documents.get(uri);
  if (env.FAKE_COLLAPSE_SPACES !== '1' || text === undefined) return [];
  const formatted = text.replace(/ {2,}/g, ' ');
  return formatted === text ? [] : [{ range: buildFullRange(text), newText: formatted }];
}

function updateDocuments(msg) {
  const uri = msg.params.textDocument.uri;
  if (msg.method === 'textDocument/didOpen') documents.set(uri, msg.params.textDocument.text.replace(/\r\n?/g, '\n'));
  if (msg.method === 'textDocument/didChange' && documents.has(uri)) {
    documents.set(uri, msg.params.contentChanges.reduce(applyContentChange, documents.get(uri)));
  }
  if (msg.method === 'textDocument/didClose') documents.delete(uri);
}

function send(socket, msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function handle(socket, msg) {
  if (!msg.method) return;
  const isRequest = msg.id !== undefined;
  if (isRequest) {
    const n = (counts.get(msg.method) || 0) + 1;
    counts.set(msg.method, n);
    log(`request ${msg.method} ${n}`);
    if (exitOn && exitOn.method === msg.method && exitOn.n === n) exit(exitOn.code);
    if (noReply && noReply.method === msg.method && noReply.n === n) return;
  }
  if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didClose') {
    const kind = msg.method === 'textDocument/didOpen' ? 'open' : 'close';
    const uri = msg.params.textDocument.uri;
    log(`${kind} ${uri} ${Date.now()}`);
    if (kind === 'open' && env.FAKE_LOG) log(`lock ${uri} ${inspectFileLock(uri)}`);
  }
  if (/^textDocument\/did(Open|Change|Close)$/.test(msg.method)) updateDocuments(msg);
  switch (msg.method) {
    case 'initialize':
      clientPid = msg.params.processId;
      send(socket, { id: msg.id, result: { capabilities: { documentFormattingProvider: true } } });
      return;
    case 'initialized':
      if (env.FAKE_INDEXING_MS) {
        const durationMs = parseInt(env.FAKE_INDEXING_MS, 10);
        if (indexingAfterMs > 0) setTimeout(() => startIndexing(socket, durationMs), indexingAfterMs);
        else startIndexing(socket, durationMs);
      }
      if (env.FAKE_NO_INDEXING_MESSAGE !== '1') {
        const params = { type: 3, message: 'Indexing completed.' };
        setTimeout(() => send(socket, { method: 'window/showMessage', params }), 20);
      }
      return;
    case 'textDocument/didOpen':
    case 'textDocument/didChange':
      setTimeout(() => publishDiagnostics(socket, msg.params.textDocument.uri), diagnosticsDelayMs);
      return;
    case 'textDocument/formatting': {
      const reply = { id: msg.id, result: buildFormattingEdits(msg.params.textDocument.uri) };
      if (formattingDelayMs > 0) setTimeout(() => send(socket, reply), formattingDelayMs);
      else send(socket, reply);
      return;
    }
    case 'shutdown':
      send(socket, { id: msg.id, result: null });
      return;
    case 'exit':
      exit(0);
      return;
    default:
      if (isRequest) {
        send(socket, { id: msg.id, result: msg.method === 'textDocument/codeAction' ? [] : null });
      }
  }
}

function start() {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let isAuthenticated = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!isAuthenticated) {
        if (buffer.length < hash.length) return;
        if (buffer.slice(0, hash.length).toString('ascii') !== hash) {
          socket.destroy();
          return;
        }
        isAuthenticated = true;
        buffer = buffer.slice(hash.length);
      }
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const m = buffer.slice(0, headerEnd).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        const len = m ? parseInt(m[1], 10) : 0;
        if (buffer.length < headerEnd + 4 + len) return;
        const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
        buffer = buffer.slice(headerEnd + 4 + len);
        handle(socket, JSON.parse(body));
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`Java Language Server listening at port ${server.address().port} with hash ${hash}\n`);
  });
}

setTimeout(start, parseInt(env.FAKE_START_DELAY_MS || '0', 10));
