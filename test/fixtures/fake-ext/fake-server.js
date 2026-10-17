'use strict';

/*
 * A stand-in for nbcode's language server, for tests that do not need Java.
 * It listens like `--start-java-language-server=listen-hash:0`, checks the
 * hash, and answers the requests the CLI sends: no code actions, no edits,
 * no errors. It creates <userdir>/lock while it runs, as NetBeans does.
 *
 * Environment:
 *   FAKE_EXIT_BEFORE_LISTEN=<code>      exit with <code> before listening
 *   FAKE_START_DELAY_MS=<ms>            wait before listening
 *   FAKE_NO_REPLY=<method>:<n>          never answer the n-th <method> request
 *   FAKE_EXIT_ON=<method>:<n>:<code>    exit with <code> on the n-th <method> request
 *   FAKE_IGNORE_SIGTERM=1               ignore SIGTERM (only SIGKILL stops it)
 *   FAKE_NO_INDEXING_MESSAGE=1          never send "Indexing completed."
 *   FAKE_LOG=<file>                     append one line per start and per request
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

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
const lockFile = userdir ? path.join(userdir, 'lock') : null;

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
  switch (msg.method) {
    case 'initialize':
      send(socket, { id: msg.id, result: { capabilities: { documentFormattingProvider: true } } });
      return;
    case 'initialized':
      if (env.FAKE_NO_INDEXING_MESSAGE !== '1') {
        const params = { type: 3, message: 'Indexing completed.' };
        setTimeout(() => send(socket, { method: 'window/showMessage', params }), 20);
      }
      return;
    case 'textDocument/didOpen':
    case 'textDocument/didChange':
      setTimeout(() => {
        const params = { uri: msg.params.textDocument.uri, diagnostics: [] };
        send(socket, { method: 'textDocument/publishDiagnostics', params });
      }, 30);
      return;
    case 'shutdown':
      send(socket, { id: msg.id, result: null });
      return;
    case 'exit':
      exit(0);
      return;
    default:
      if (isRequest) {
        const isList = msg.method === 'textDocument/formatting' || msg.method === 'textDocument/codeAction';
        send(socket, { id: msg.id, result: isList ? [] : null });
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
