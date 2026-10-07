'use strict';

// Runs against compiled dist/ — `npm test` builds first via pretest.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA_VERSION } = require('@redthreadlabs/tracelog-schema');
const { TracelogClient } = require('../dist/TracelogClient');

test('the origin a batch carries names the schema version it was written against', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const client = new TracelogClient({
    endpoint: 'http://localhost/logs',
    getAuthHeaders: () => ({}),
    getOrigin: () => ({ service: { name: 'test', version: '0.0.0' }, runtime: { name: 'node', version: '0' } }),
    flushCadenceMs: 1_000_000,
  });
  try {
    client.recordTransaction('op', 5);
    await client.flush();
    const origin = sent.find((b) => b.origin)?.origin;
    assert.ok(origin, 'the first batch carries the origin');
    assert.equal(origin.schema, SCHEMA_VERSION);
    assert.equal(origin.schema, '0.7.0');
    assert.equal(origin.lifetime_id, client._lifetimeId);
  } finally {
    client.dispose();
    globalThis.fetch = realFetch;
  }
});
