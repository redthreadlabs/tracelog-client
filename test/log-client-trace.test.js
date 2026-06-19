'use strict';

// Tests for TracelogClient transaction/span recording (Option B). Runs against
// compiled dist/ — `npm run build` first, which `npm test` does via pretest.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TracelogClient } = require('../dist/TracelogClient');

function makeClient(opts = {}) {
  return new TracelogClient({
    endpoint: 'http://localhost/never-called',
    getAuthHeaders: () => ({}),
    getOrigin: () => ({ service: { name: 'test', version: '0.0.0' }, runtime: { name: 'node', version: '0' } }),
    flushCadenceMs: 1_000_000,
    ...opts,
  });
}

test('recordTransaction buffers a root transaction', () => {
  const client = makeClient();
  try {
    client.recordTransaction('sqlite-query', 42, { labels: { table: 'records' } });
    assert.equal(client._transactionBuffer.length, 1);
    const t = client._transactionBuffer[0];
    assert.equal(t.name, 'sqlite-query');
    assert.equal(t.duration, 42);
    assert.equal(t.type, 'app');
    assert.equal(t.outcome, 'success');
    assert.equal(t.id.length, 16);
    assert.equal(t.trace_id.length, 32);
    assert.equal(t.transaction_id, undefined, 'a transaction has no transaction_id/parent_id');
    assert.equal(t.parent_id, undefined);
    assert.deepEqual(t.context, { labels: { table: 'records' } });
    assert.equal(typeof t.tz_offset, 'number');
  } finally { client.dispose(); }
});

test('timestamp is epoch microseconds, back-computed from duration', () => {
  const client = makeClient();
  try {
    const beforeUs = (Date.now() - 100) * 1000;
    client.recordTransaction('op', 100);
    const afterUs = Date.now() * 1000;
    const t = client._transactionBuffer[0];
    assert.ok(t.timestamp >= beforeUs - 50000 && t.timestamp <= afterUs,
      `µs timestamp ${t.timestamp} should be ~100ms before now`);
  } finally { client.dispose(); }
});

test('recordTransaction accepts an outcome and clamps bad durations', () => {
  const client = makeClient();
  try {
    client.recordTransaction('failed-op', -5, { outcome: 'failure' });
    const t = client._transactionBuffer[0];
    assert.equal(t.duration, 0, 'negative duration clamped to 0');
    assert.equal(t.outcome, 'failure');
    assert.equal(t.context, undefined, 'no labels ⇒ no context');
  } finally { client.dispose(); }
});

test('minDurationMs drops sub-threshold records', () => {
  const client = makeClient();
  try {
    client.recordTransaction('fast', 5, { minDurationMs: 100 });
    assert.equal(client._transactionBuffer.length, 0, 'below threshold dropped');
    client.recordTransaction('slow', 250, { minDurationMs: 100 });
    assert.equal(client._transactionBuffer.length, 1, 'above threshold kept');
  } finally { client.dispose(); }
});

test('recordSpan links to its parent transaction', () => {
  const client = makeClient();
  try {
    const txn = client.startTransaction('req');
    client.recordSpan('db-call', 12, txn, { type: 'db' });
    assert.equal(client._spanBuffer.length, 1);
    const s = client._spanBuffer[0];
    assert.equal(s.name, 'db-call');
    assert.equal(s.type, 'db');
    assert.equal(s.trace_id, txn.traceId);
    assert.equal(s.transaction_id, txn.id);
    assert.equal(s.parent_id, txn.id);
  } finally { client.dispose(); }
});

test('start/end builds a transaction with nested spans on a shared trace', () => {
  const client = makeClient();
  try {
    const txn = client.startTransaction('search', { type: 'app' });
    const span = txn.startSpan('hanzi', { type: 'db' });
    const child = span.startSpan('row-scan');
    child.end();
    span.end({ labels: { rows: 3 } });
    txn.end({ outcome: 'success' });

    assert.equal(client._transactionBuffer.length, 1);
    assert.equal(client._spanBuffer.length, 2);
    const t = client._transactionBuffer[0];
    const [c, sp] = client._spanBuffer; // child ended first, then its parent span
    assert.equal(t.name, 'search');
    assert.equal(sp.name, 'hanzi');
    assert.deepEqual(sp.context, { labels: { rows: 3 } });
    assert.equal(sp.transaction_id, t.id, 'span belongs to the transaction');
    assert.equal(sp.parent_id, t.id, 'span parented to the transaction');
    assert.equal(c.parent_id, sp.id, 'grandchild parented to the span');
    assert.equal(c.trace_id, t.trace_id, 'the whole trace shares one trace_id');
    assert.equal(sp.trace_id, t.trace_id);
  } finally { client.dispose(); }
});

test('ending a transaction auto-closes un-ended children', () => {
  const client = makeClient();
  try {
    const txn = client.startTransaction('req');
    txn.startSpan('leaked'); // never ended explicitly
    txn.end();
    assert.equal(client._transactionBuffer.length, 1);
    assert.equal(client._spanBuffer.length, 1, 'forgotten child auto-closed on parent end');
  } finally { client.dispose(); }
});

test('recordTransaction is a no-op after dispose', () => {
  const client = makeClient();
  client.dispose();
  client.recordTransaction('late', 10);
  assert.equal(client._transactionBuffer.length, 0);
});
