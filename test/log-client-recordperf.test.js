'use strict';

// Tests for LogClient.recordPerf — the one-shot perf primitive. Runs against
// compiled dist/ — `npm run build` first, which `npm test` does via pretest.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LogClient } = require('../dist/LogClient');

function makeClient(opts = {}) {
  return new LogClient({
    endpoint: 'http://localhost/never-called',
    getAuthHeaders: () => ({}),
    client: { name: 'test', version: '0.0.0', os: { name: 'test', version: '0' }, device: { type: 'phone' }, runtime: { name: 'node', version: '0' } },
    flushCadenceMs: 1_000_000,
    ...opts,
  });
}

test('recordPerf buffers a root, parent-less client-perf (→ transaction)', () => {
  const client = makeClient();
  try {
    client.recordPerf('sqlite-query', 42, { table: 'records' });
    assert.equal(client._perfBuffer.length, 1);
    const p = client._perfBuffer[0];
    assert.equal(p.name, 'sqlite-query');
    assert.equal(p.duration, 42);
    assert.equal(p.type, 'client-perf');
    assert.equal(p.outcome, 'success');
    assert.equal(p.root_id, p.id, 'root_id === id ⇒ server maps to a transaction');
    assert.equal(p.parent_id, undefined, 'no parent_id ⇒ not a span');
    assert.equal(p.id.length, 16);
    assert.equal(p.trace_id.length, 32);
    assert.deepEqual(p.context, { tags: { table: 'records' } });
    assert.equal(typeof p.tz_offset, 'number');
  } finally {
    client.dispose();
  }
});

test('recordPerf back-computes timestamp = end − duration', () => {
  const client = makeClient();
  try {
    const before = Date.now();
    client.recordPerf('op', 100);
    const after = Date.now();
    const p = client._perfBuffer[0];
    // start ≈ now − 100ms; allow generous slack for clock/exec.
    assert.ok(p.timestamp >= before - 100 - 50 && p.timestamp <= after - 100 + 50,
      `timestamp ${p.timestamp} should be ~100ms before now [${before},${after}]`);
  } finally {
    client.dispose();
  }
});

test('recordPerf accepts an outcome and clamps bad durations', () => {
  const client = makeClient();
  try {
    client.recordPerf('failed-op', -5, undefined, 'failure');
    const p = client._perfBuffer[0];
    assert.equal(p.duration, 0, 'negative duration clamped to 0');
    assert.equal(p.outcome, 'failure');
    assert.equal(p.context, undefined, 'no context ⇒ no tags');
  } finally {
    client.dispose();
  }
});

test('recordPerf is a no-op after dispose', () => {
  const client = makeClient();
  client.dispose();
  client.recordPerf('late', 10);
  assert.equal(client._perfBuffer.length, 0);
});
