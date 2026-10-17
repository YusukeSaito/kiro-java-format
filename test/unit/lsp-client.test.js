'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { LspClient, TimeoutError, ServerExitedError, awaitWithTimeout } = require('../../format-java.js');

/** A connected socket pair: `client` for LspClient, `peer` playing the server. */
function connectPair() {
  return new Promise((resolve) => {
    const server = net.createServer((peer) => resolve({ client, peer, server }));
    let client;
    server.listen(0, '127.0.0.1', () => {
      client = net.connect(server.address().port, '127.0.0.1');
    });
  });
}

function readMessages(peer, onMessage) {
  let buffer = Buffer.alloc(0);
  peer.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = parseInt(buffer.slice(0, end).toString().match(/Content-Length:\s*(\d+)/)[1], 10);
      if (buffer.length < end + 4 + len) return;
      onMessage(JSON.parse(buffer.slice(end + 4, end + 4 + len).toString()));
      buffer = buffer.slice(end + 4 + len);
    }
  });
}

function reply(peer, id, result) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
  peer.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

test('a request without a reply fails with TimeoutError at its limit and leaves nothing pending', async () => {
  const { client, peer, server } = await connectPair();
  try {
    const lsp = new LspClient(client);
    const startedAt = Date.now();
    await assert.rejects(lsp.request('textDocument/formatting', {}, 150), (err) => {
      assert.ok(err instanceof TimeoutError);
      assert.strictEqual(err.message, 'Timed out after 0.15s waiting for the language server. Try --timeout or --verbose.');
      return true;
    });
    assert.ok(Date.now() - startedAt >= 140);
    assert.strictEqual(lsp.pending.size, 0);
  } finally {
    client.destroy();
    peer.destroy();
    server.close();
  }
});

test('a reply that arrives after the limit is dropped', async () => {
  const { client, peer, server } = await connectPair();
  try {
    const lsp = new LspClient(client);
    const ids = [];
    readMessages(peer, (msg) => ids.push(msg.id));
    await assert.rejects(lsp.request('slow', {}, 50), TimeoutError);
    reply(peer, ids[0], 'late');
    const next = lsp.request('fast', {}, 1000);
    await new Promise((r) => setTimeout(r, 50));
    reply(peer, ids[1], 'ok');
    assert.strictEqual(await next, 'ok');
    assert.strictEqual(lsp.pending.size, 0);
  } finally {
    client.destroy();
    peer.destroy();
    server.close();
  }
});

test('a dropped connection fails pending and later requests with ServerExitedError', async () => {
  const { client, peer, server } = await connectPair();
  try {
    const lsp = new LspClient(client);
    const pending = lsp.request('textDocument/formatting', {}, 5000);
    peer.destroy();
    await assert.rejects(pending, ServerExitedError);
    await assert.rejects(lsp.request('shutdown', null, 5000), ServerExitedError);
    assert.strictEqual(lsp.pending.size, 0);
  } finally {
    client.destroy();
    server.close();
  }
});

test('rejectAll passes the exit code on', async () => {
  const { client, peer, server } = await connectPair();
  try {
    const lsp = new LspClient(client, { onClose: () => {} });
    const pending = lsp.request('x', {});
    lsp.rejectAll(new ServerExitedError(7));
    await assert.rejects(
      pending,
      (err) => err instanceof ServerExitedError && err.message === 'language server exited (code 7)'
    );
  } finally {
    client.destroy();
    peer.destroy();
    server.close();
  }
});

test('awaitWithTimeout settles with the promise, or with TimeoutError at the limit', async () => {
  assert.strictEqual(await awaitWithTimeout(Promise.resolve(3), 1000), 3);
  await assert.rejects(awaitWithTimeout(new Promise(() => {}), 20), TimeoutError);
  await assert.rejects(awaitWithTimeout(new Promise(() => {}), NaN), /Timed out after NaNs/);
});
