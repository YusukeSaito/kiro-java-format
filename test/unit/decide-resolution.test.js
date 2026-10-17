'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { decideResolution, selectEntryAfterRequest, ServerSession } = require('../../format-java.js');

const OPENED = 1000;
const CAP = 60000;
const SETTLE = 2000;
const indexing = { kind: 'indexing' };
const completeAt = (completedAtMs, completionCount = 1) => ({ kind: 'complete', completionCount, completedAtMs });

function decide(overrides) {
  return decideResolution({
    entry: null,
    indexPhase: indexing,
    isPersistentUserdir: false,
    completionCountAtOpen: 0,
    freshRequest: null,
    openedAtMs: OPENED,
    nowMs: OPENED,
    capMs: CAP,
    settleMs: SETTLE,
    ...overrides,
  });
}

const pendingUntil = (wakeAtMs) => ({ kind: 'pending', wakeAtMs, shouldRequestFreshDiagnostics: false });

test('errors before indexing completes are pending until the limit', () => {
  const entry = { errorCount: 3, arrivedAtMs: 2000 };
  assert.deepStrictEqual(decide({ entry, nowMs: 9000 }), pendingUntil(OPENED + CAP));
});

test('no diagnostics yet is pending', () => {
  assert.deepStrictEqual(decide({ nowMs: 5000 }), pendingUntil(OPENED + CAP));
  assert.deepStrictEqual(decide({ indexPhase: completeAt(3000), nowMs: 5000 }), pendingUntil(OPENED + CAP));
});

test('no errors resolves at once, before or after indexing', () => {
  assert.deepStrictEqual(decide({ entry: { errorCount: 0, arrivedAtMs: 2000 }, nowMs: 2000 }), { kind: 'resolved' });
  assert.deepStrictEqual(
    decide({ entry: { errorCount: 0, arrivedAtMs: 4000 }, indexPhase: completeAt(3000), nowMs: 4000 }),
    { kind: 'resolved' }
  );
});

test('errors that arrived after completion and stay for the settle time do not resolve', () => {
  const entry = { errorCount: 1, arrivedAtMs: 5000 };
  const indexPhase = completeAt(4000);
  assert.deepStrictEqual(decide({ entry, indexPhase, nowMs: 5000 }), pendingUntil(5000 + SETTLE));
  assert.deepStrictEqual(decide({ entry, indexPhase, nowMs: 6999 }), pendingUntil(5000 + SETTLE));
  assert.deepStrictEqual(decide({ entry, indexPhase, nowMs: 7000 }), { kind: 'unresolved', reason: 'errors after indexing' });
});

test('errors that arrived before completion only stay pending, however long after completion', () => {
  const entry = { errorCount: 2, arrivedAtMs: 3000 };
  const indexPhase = completeAt(4000);
  assert.deepStrictEqual(decide({ entry, indexPhase, nowMs: 4000 + SETTLE + 5000 }), pendingUntil(OPENED + CAP));
  // An entry that arrives exactly at completion counts as after it.
  assert.deepStrictEqual(
    decide({ entry: { errorCount: 2, arrivedAtMs: 4000 }, indexPhase, nowMs: 6000 }),
    { kind: 'unresolved', reason: 'errors after indexing' }
  );
});

test('indexing again stops the settle clock; the next completion starts it over', () => {
  const entry = { errorCount: 1, arrivedAtMs: 5000 };
  assert.deepStrictEqual(decide({ entry, indexPhase: indexing, nowMs: 8000 }), pendingUntil(OPENED + CAP));
  // Completed again at 9000: the entry from 5000 is now from before completion.
  assert.deepStrictEqual(decide({ entry, indexPhase: completeAt(9000, 2), nowMs: 12000 }), pendingUntil(OPENED + CAP));
  const later = { errorCount: 1, arrivedAtMs: 9500 };
  assert.deepStrictEqual(decide({ entry: later, indexPhase: completeAt(9000, 2), nowMs: 11500 }), {
    kind: 'unresolved',
    reason: 'errors after indexing',
  });
});

test('at the limit the latest result decides', () => {
  const nowMs = OPENED + CAP;
  assert.deepStrictEqual(decide({ entry: { errorCount: 0, arrivedAtMs: 2000 }, nowMs }), { kind: 'resolved' });
  assert.deepStrictEqual(decide({ entry: { errorCount: 4, arrivedAtMs: 2000 }, nowMs }), {
    kind: 'unresolved',
    reason: 'wait limit',
  });
  assert.deepStrictEqual(decide({ nowMs }), { kind: 'unresolved', reason: 'wait limit' });
  assert.deepStrictEqual(decide({ capMs: NaN }), { kind: 'unresolved', reason: 'wait limit' });
});

const requestFresh = { kind: 'pending', wakeAtMs: OPENED + CAP, shouldRequestFreshDiagnostics: true };

test('with a cached index, no errors before indexing completes is still pending', () => {
  const entry = { errorCount: 0, arrivedAtMs: 2000 };
  assert.deepStrictEqual(decide({ isPersistentUserdir: true, entry, nowMs: 2000 }), pendingUntil(OPENED + CAP));
});

test('with a cached index, a document opened after the latest completion decides at once', () => {
  const indexPhase = completeAt(500, 1);
  const base = { isPersistentUserdir: true, indexPhase, completionCountAtOpen: 1 };
  assert.deepStrictEqual(decide({ ...base, entry: { errorCount: 0, arrivedAtMs: 1500 }, nowMs: 1500 }), { kind: 'resolved' });
  assert.deepStrictEqual(decide({ ...base, entry: { errorCount: 1, arrivedAtMs: 1500 }, nowMs: 3500 }), {
    kind: 'unresolved',
    reason: 'errors after indexing',
  });
});

test('with a cached index, a document opened before completion asks for fresh diagnostics and decides on them', () => {
  const indexPhase = completeAt(8000, 1);
  const base = { isPersistentUserdir: true, indexPhase, completionCountAtOpen: 0 };
  // An entry from before completion (from the stale index) does not decide.
  const stale = { errorCount: 0, arrivedAtMs: 3000 };
  assert.deepStrictEqual(decide({ ...base, entry: stale, nowMs: 8000 }), requestFresh);
  const freshRequest = { completionCount: 1, requestedAtMs: 8000 };
  assert.deepStrictEqual(decide({ ...base, entry: stale, freshRequest, nowMs: 8100 }), pendingUntil(OPENED + CAP));
  // The first result after the request waits for the settle time, then decides.
  const fresh = { errorCount: 0, arrivedAtMs: 8600 };
  assert.deepStrictEqual(decide({ ...base, entry: fresh, freshRequest, nowMs: 8600 }), pendingUntil(8600 + SETTLE));
  assert.deepStrictEqual(decide({ ...base, entry: fresh, freshRequest, nowMs: 10600 }), { kind: 'resolved' });
  const broken = { errorCount: 2, arrivedAtMs: 8600 };
  assert.deepStrictEqual(decide({ ...base, entry: broken, freshRequest, nowMs: 10600 }), {
    kind: 'unresolved',
    reason: 'errors after indexing',
  });
});

test('with a cached index, a new completion asks for fresh diagnostics again', () => {
  const freshRequest = { completionCount: 1, requestedAtMs: 8000 };
  const entry = { errorCount: 0, arrivedAtMs: 8600 };
  const base = { isPersistentUserdir: true, completionCountAtOpen: 0, entry, freshRequest };
  assert.deepStrictEqual(decide({ ...base, indexPhase: indexing, nowMs: 11000 }), pendingUntil(OPENED + CAP));
  assert.deepStrictEqual(decide({ ...base, indexPhase: completeAt(12000, 2), nowMs: 12000 }), requestFresh);
});

test('with a cached index, the limit decides on the latest result', () => {
  const nowMs = OPENED + CAP;
  assert.deepStrictEqual(decide({ isPersistentUserdir: true, entry: { errorCount: 0, arrivedAtMs: 2000 }, nowMs }), {
    kind: 'resolved',
  });
  assert.deepStrictEqual(decide({ isPersistentUserdir: true, entry: { errorCount: 1, arrivedAtMs: 2000 }, nowMs }), {
    kind: 'unresolved',
    reason: 'wait limit',
  });
});

test('selectEntryAfterRequest takes only an entry that arrived after the request', () => {
  const entry = { errorCount: 0, arrivedAtMs: 5000 };
  assert.strictEqual(selectEntryAfterRequest(entry, null), null);
  assert.strictEqual(selectEntryAfterRequest(null, { completionCount: 1, requestedAtMs: 1000 }), null);
  assert.strictEqual(selectEntryAfterRequest(entry, { completionCount: 1, requestedAtMs: 6000 }), null);
  assert.strictEqual(selectEntryAfterRequest(entry, { completionCount: 1, requestedAtMs: 5000 }), entry);
});

function createSession() {
  return new ServerSession(new EventEmitter());
}

test('indexing completes only with the scan signal and no progress running', () => {
  const s = createSession();
  s.handleProgress({ token: 1, value: { kind: 'begin', title: 'Collecting workspace projects...' } });
  s.handleProgress({ token: 1, value: { kind: 'end' } });
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' }, 'an end without the signal does not complete');
  s.handleProgress({ token: 'scan', value: { kind: 'begin', title: 'Background scan' } });
  s.handleShowMessage({ type: 3, message: 'Indexing completed.\n' });
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' }, 'the scan progress is still running');
  s.handleProgress({ token: 'scan', value: { kind: 'end' } });
  assert.strictEqual(s.indexPhase.kind, 'complete');
  assert.strictEqual(s.indexPhase.completionCount, 1);
  assert.strictEqual(s.completionCount, 1);
});

test('a progress after completion returns to indexing; its end completes again', () => {
  const s = createSession();
  s.handleShowMessage({ type: 3, message: 'Indexing completed.' });
  assert.strictEqual(s.indexPhase.kind, 'complete');
  s.handleProgress({ token: 7, value: { kind: 'begin' } });
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' });
  s.handleProgress({ token: 7, value: { kind: 'report' } });
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' });
  s.handleProgress({ token: '7', value: { kind: 'end' } });
  assert.strictEqual(s.indexPhase.kind, 'complete');
  assert.strictEqual(s.completionCount, 2);
});

test('other messages are not the scan signal', () => {
  const s = createSession();
  s.handleShowMessage({ type: 3, message: 'Indexing completed in 3s' });
  s.handleShowMessage({ type: 1, message: 'Something failed' });
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' });
});

function attachClient(s, reply) {
  const sent = [];
  s.client = {
    request: (method, params) => {
      sent.push(method);
      return reply();
    },
  };
  return sent;
}

test('a successful workspace/symbol reply is the scan signal; it is sent once, after the first diagnostics', async () => {
  const s = createSession();
  const sent = attachClient(s, () => Promise.resolve([]));
  assert.deepStrictEqual(sent, []);
  s.handleDiagnostics({ uri: 'file:///p/A.java', diagnostics: [] });
  s.handleDiagnostics({ uri: 'file:///p/B.java', diagnostics: [] });
  assert.deepStrictEqual(sent, ['workspace/symbol']);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.hasScanFinishedSignal, true);
  assert.strictEqual(s.indexPhase.kind, 'complete');
});

test('a failed or timed-out workspace/symbol is not the scan signal', async () => {
  const s = createSession();
  attachClient(s, () => Promise.reject(new Error('Timed out after 120s')));
  s.handleDiagnostics({ uri: 'file:///p/A.java', diagnostics: [] });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.hasScanFinishedSignal, false);
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' });
});

test('the workspace/symbol signal still waits for running progress to end', async () => {
  const s = createSession();
  attachClient(s, () => Promise.resolve([]));
  s.handleProgress({ token: 'scan', value: { kind: 'begin' } });
  s.handleDiagnostics({ uri: 'file:///p/A.java', diagnostics: [] });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(s.indexPhase, { kind: 'indexing' });
  s.handleProgress({ token: 'scan', value: { kind: 'end' } });
  assert.strictEqual(s.indexPhase.kind, 'complete');
});

test('requestFreshDiagnostics replaces the first character with itself, or adds and removes a newline', () => {
  const s = createSession();
  const notes = [];
  s.client = { notify: (method, params) => notes.push(params) };
  const doc = { uri: 'file:///p/A.java', version: 3, serverText: 'class A {}\n' };
  s.requestFreshDiagnostics(doc);
  assert.strictEqual(doc.version, 4);
  assert.deepStrictEqual(notes[0].contentChanges, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: 'c' },
  ]);
  const empty = { uri: 'file:///p/E.java', version: 1, serverText: '' };
  s.requestFreshDiagnostics(empty);
  assert.strictEqual(empty.version, 3);
  assert.deepStrictEqual(
    notes.slice(1).map((n) => n.contentChanges[0]),
    [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '\n' },
      { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: '' },
    ]
  );
});

test('a diagnostics entry from before the document was opened is ignored', () => {
  const s = createSession();
  s.handleDiagnostics({ uri: 'file:///p/A.java', diagnostics: [{ severity: 1 }, { severity: 2 }] });
  const entry = s.findDiagnosticEntry('file:///p/A.java', 0);
  assert.strictEqual(entry.errorCount, 1);
  assert.strictEqual(s.findDiagnosticEntry('file:///p/A.java', entry.arrivedAtMs + 1), null);
  assert.strictEqual(s.findDiagnosticEntry('file:///p/B.java', 0), null);
});
