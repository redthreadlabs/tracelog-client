# @redthreadlabs/tracelog-client

The client half of [tracelog](https://github.com/redthreadlabs/tracelog): a
small, dependency-free SDK that buffers structured events, transactions and
spans on a device or in a browser and ships them in batches to your own server,
which forwards them to the tracelog agent's `client` channel.

It is the same record shape end to end — the wire format is
[`@redthreadlabs/tracelog-schema`](https://github.com/redthreadlabs/tracelog-schema),
so the server stamps the few facts it owns (the authenticated user, the source
IP) and writes the records through; there is no field-by-field remapping and no
unit conversion.

Works in React Native and in browsers: no `window`, no Node built-ins. Its one
dependency is the shared schema, and that is types-only — nothing but this
SDK's own code runs at runtime.

```
npm install @redthreadlabs/tracelog-client
```

## Usage

```ts
import { TracelogClient } from '@redthreadlabs/tracelog-client';

const tracelog = new TracelogClient({
  endpoint: 'https://api.example.com/logs',
  getAuthHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  getOrigin: () => ({ service: { name: 'acme-ios', version: '2.4.1' }, environment: 'production' }),
  getUserId: () => session?.userId,
  getLocale: () => i18n.locale,
  // Drop debug noise in production without touching call sites.
  getMinLevel: () => (__DEV__ ? 'debug' : 'info'),
  // Survive a cold start: hand the SDK your key/value store.
  persistLogs: (data) => AsyncStorage.setItem('tracelog', data),
  loadPersistedLogs: () => AsyncStorage.getItem('tracelog'),
});
```

### Events

Events are free-form structured records — analytics, audit trails, or
structured log lines — built with a small chained builder:

```ts
tracelog.event('checkout').info('user completed purchase')
  .withLabels({ sku: 'abc-123', cents: 4999 })
  .send();

tracelog.event('sync').error('inbox sync failed')
  .withLabel('attempt', 3)
  .withError(err)
  .send();
```

`info`, `warn`, `error` and `debug` set the level and message; `withLabel`,
`withLabels` and `withError` add context; `send()` enqueues. Nothing is sent
synchronously.

### Transactions and spans

For timed work, either bracket it live:

```ts
const txn = tracelog.startTransaction('cold-start');
const span = tracelog.startSpan('load-dictionary', txn);
span.end();
txn.end();
```

…or record a duration you already measured:

```ts
tracelog.recordTransaction('cold-start', 842);
```

Spans nest under a transaction or another span and inherit its trace id, so a
device-side trace arrives with the same shape the agent writes server-side.

### Batching

Records buffer and flush on a cadence (5 s by default), when the buffer fills
(100 records), or when you call `await tracelog.flush()`. Batches are chunked
to stay under a size limit (50 records / 512 KB per request) and retried with
backoff. Call `dispose()` on teardown to stop the timer and flush what's left.

| Option | Default | |
|---|---|---|
| `endpoint` | — | where batches are POSTed |
| `getAuthHeaders` | — | per-request auth headers |
| `getOrigin` | — | service + environment for this lifetime |
| `getUserId` / `getLocale` / `getMinLevel` | — | stamped or gated per record |
| `flushCadenceMs` | `5000` | |
| `maxBufferSize` | `100` | records buffered before a forced flush |
| `maxChunkSize` / `maxChunkBytes` | `50` / `524288` | per HTTP request |
| `persistLogs` / `loadPersistedLogs` | — | survive process death |

## The server side

Your endpoint receives a `RecordBatch` and hands it to the agent's client
channel — roughly:

```js
const apm = require('@redthreadlabs/tracelog');
const clientChannel = apm.getChannel('client');

app.post('/logs', (req, res) => {
  const batch = req.body;
  if (batch.origin) clientChannel.writeRecordOrigin({ ...batch.origin, lifetime_id: batch.lifetime_id });
  if (batch.events?.length) clientChannel.writeClientEvents(batch.events);
  for (const t of batch.transactions ?? []) clientChannel.writeTransaction(t);
  for (const s of batch.spans ?? []) clientChannel.writeSpan(s);
  res.sendStatus(200);
});
```

Trust the batch for content, never for identity: stamp the user from your own
authenticated session rather than from anything the client claims.

## License

[BSD-2-Clause](LICENSE)
