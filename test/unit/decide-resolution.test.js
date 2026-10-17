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

test('a diagnostics entry from before the document was opened is ignored', () => {
  const s = createSession();
  s.handleDiagnostics({ uri: 'file:///p/A.java', diagnostics: [{ severity: 1 }, { severity: 2 }] });
  const entry = s.findDiagnosticEntry('file:///p/A.java', 0);
  assert.strictEqual(entry.errorCount, 1);
  assert.strictEqual(s.findDiagnosticEntry('file:///p/A.java', entry.arrivedAtMs + 1), null);
  assert.strictEqual(s.findDiagnosticEntry('file:///p/B.java', 0), null);
});
