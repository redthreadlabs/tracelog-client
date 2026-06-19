'use strict';

// Tests for EventBuilder error serialization (runs against the compiled
// dist/ — `npm run build` first, which `npm test` does via pretest).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EventBuilder } = require('../dist/EventBuilder');

function capture() {
  const sent = [];
  return { sent, enqueue: (e) => sent.push(e) };
}

test('withError on an Error instance sets structured code', () => {
  const { sent, enqueue } = capture();
  const err = new Error('connection refused');
  err.code = 'ECONNREFUSED';

  new EventBuilder(enqueue, 'net').error('request failed').withError(err).send();

  const e = sent[0].error;
  assert.equal(e.message, 'connection refused');
  assert.equal(e.type, 'Error');
  assert.equal(e.code, 'ECONNREFUSED');
  assert.ok(e.stack);
  assert.ok(!e.message.includes('(code:'), 'code no longer folded into message');
});

test('withError on an error-like plain object sets structured code', () => {
  const { sent, enqueue } = capture();

  new EventBuilder(enqueue, 'sharedb')
    .error('op failed')
    .withError({ code: 4017, message: 'doc not found' })
    .send();

  const e = sent[0].error;
  assert.equal(e.message, 'doc not found');
  assert.equal(e.code, '4017', 'numeric code stringified');
  assert.ok(!e.message.includes('(code:'), 'code no longer folded into message');
});

test('withError on a message-less object falls back to bounded JSON', () => {
  const { sent, enqueue } = capture();

  new EventBuilder(enqueue, 'sharedb').error('x').withError({ code: 4017 }).send();

  const e = sent[0].error;
  assert.equal(e.message, '{"code":4017}');
  assert.equal(e.code, '4017');
});

test('withError on a string keeps it as the message, no code', () => {
  const { sent, enqueue } = capture();

  new EventBuilder(enqueue, 'app').error('x').withError('plain failure').send();

  const e = sent[0].error;
  assert.equal(e.message, 'plain failure');
  assert.equal(e.code, undefined);
});

test('withError without a code emits no code field', () => {
  const { sent, enqueue } = capture();

  new EventBuilder(enqueue, 'app').error('x').withError(new Error('boom')).send();

  assert.equal(sent[0].error.code, undefined);
});

test('send() stamps a numeric per-event tz_offset', () => {
  const { sent, enqueue } = capture();
  new EventBuilder(enqueue, 'app').info('hi').send();
  const e = sent[0];
  assert.equal(typeof e.tz_offset, 'number', 'tz_offset present and numeric');
  // minutes east of UTC: within the real-world range
  assert.ok(e.tz_offset >= -720 && e.tz_offset <= 840, 'plausible UTC offset');
  assert.equal(e.tz_offset, -new Date().getTimezoneOffset(), 'matches the conventional sign');
});

test('withLabel/withLabels populate context.labels', () => {
  const { sent, enqueue } = capture();
  new EventBuilder(enqueue, 'app').info('hi').withLabel('a', 1).withLabels({ b: 'two' }).send();
  assert.deepEqual(sent[0].context, { labels: { a: 1, b: 'two' } });
});

test('send() with no labels has no context', () => {
  const { sent, enqueue } = capture();
  new EventBuilder(enqueue, 'app').info('hi').send();
  assert.equal(sent[0].context, undefined);
});

test('send() stamps an epoch-microsecond timestamp', () => {
  const { sent, enqueue } = capture();
  const before = Date.now() * 1000;
  new EventBuilder(enqueue, 'app').info('hi').send();
  const after = Date.now() * 1000;
  assert.ok(sent[0].timestamp >= before - 5000 && sent[0].timestamp <= after + 5000, 'µs-scale timestamp');
});
