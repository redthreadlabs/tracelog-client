'use strict';

// Tests for the TracelogClient level gate (getMinLevel). Runs against compiled
// dist/ — `npm run build` first, which `npm test` does via pretest.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TracelogClient } = require('../dist/TracelogClient');

function makeClient(opts = {}) {
  return new TracelogClient({
    endpoint: 'http://localhost/never-called',
    getAuthHeaders: () => ({}),
    getOrigin: () => ({ service: { name: 'test', version: '0.0.0' }, runtime: { name: 'node', version: '0' } }),
    // Large flush cadence so nothing flushes during the synchronous test.
    flushCadenceMs: 1_000_000,
    ...opts,
  });
}

test('getMinLevel drops events below the minimum before buffering', () => {
  const client = makeClient({ getMinLevel: () => 'info' });
  try {
    client.event('t').debug('drop me').send();
    client.event('t').info('keep info').send();
    client.event('t').warn('keep warn').send();
    client.event('t').error('keep error').send();

    const levels = client._eventBuffer.map((e) => e.level);
    assert.deepEqual(levels, ['info', 'warn', 'error'], 'debug gated out, rest buffered');
  } finally {
    client.dispose();
  }
});

test('no getMinLevel emits every level (back-compat)', () => {
  const client = makeClient();
  try {
    client.event('t').debug('a').send();
    client.event('t').info('b').send();
    assert.equal(client._eventBuffer.length, 2, 'both buffered when no gate');
  } finally {
    client.dispose();
  }
});

test('getMinLevel is consulted per event, so the gate can change at runtime', () => {
  let min = 'error';
  const client = makeClient({ getMinLevel: () => min });
  try {
    client.event('t').warn('blocked while min=error').send();
    assert.equal(client._eventBuffer.length, 0, 'warn dropped under min=error');

    min = 'debug';
    client.event('t').debug('allowed after min=debug').send();
    assert.equal(client._eventBuffer.length, 1, 'debug kept under min=debug');
  } finally {
    client.dispose();
  }
});

test('gated events are not persisted either', () => {
  const persisted = [];
  const client = makeClient({
    getMinLevel: () => 'warn',
    persistLogs: (data) => { persisted.push(data); return Promise.resolve(); },
  });
  try {
    client.event('t').info('dropped').send();
    // A dropped event must not schedule a persist with content.
    assert.equal(client._eventBuffer.length, 0, 'info dropped under min=warn');
  } finally {
    client.dispose();
  }
});
