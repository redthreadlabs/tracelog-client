import { EventBuilder } from './EventBuilder';
import { tzOffsetMinutes } from './util';
import {
  EndOptions,
  EventRecord,
  LogClientOptions,
  LogLevel,
  RecordBatch,
  RecordOrigin,
  RecordOptions,
  SpanRecord,
  StartOptions,
  TransactionRecord,
} from './types';

// Level ordering for the optional getMinLevel gate. An event is dropped when
// its level ranks below the host-supplied minimum.
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const DEFAULT_TYPE = 'app';

// A live (not-yet-ended) transaction or span. Records are built from this on end.
interface ActiveSpan {
  kind: 'transaction' | 'span';
  id: string;
  trace_id: string;
  transaction_id?: string; // spans only
  parent_id?: string;      // spans only
  name: string;
  type: string;
  startTime: number;       // ms (high-res wall clock)
  tzOffset: number;
  children: string[];
}

// Defaults (all overridable via LogClientOptions)
const DEFAULT_FLUSH_CADENCE_MS = 5000;
const DEFAULT_MAX_BUFFER_SIZE = 100;
const DEFAULT_MAX_CHUNK_SIZE = 50;
const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
const INTER_CHUNK_DELAY_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const PERSIST_DEBOUNCE_MS = 100;

export class TracelogClient {

  private _opts: LogClientOptions;
  private _eventBuffer: EventRecord[] = [];
  private _transactionBuffer: TransactionRecord[] = [];
  private _spanBuffer: SpanRecord[] = [];
  private _activeSpans: Map<string, ActiveSpan> = new Map();
  /** Per-launch id; the join key between records and this lifetime's origin. */
  private readonly _lifetimeId: string = randomHex(16);
  /** JSON of the last origin sent, to detect changes (null ⇒ not yet sent). */
  private _lastOriginJson: string | null = null;
  private _flushHandle: ReturnType<typeof setInterval> | null = null;
  private _persistHandle: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;
  private _flushing = false;

  constructor(opts: LogClientOptions) {
    this._opts = opts;
    this._loadPersistedLogs();
    this._flushHandle = setInterval(() => this.flush(), opts.flushCadenceMs ?? DEFAULT_FLUSH_CADENCE_MS);
  }

  /** This TracelogClient's lifetime id (one per launch / process run). */
  get lifetimeId(): string {
    return this._lifetimeId;
  }

  // ---- Fluent event builder ----

  event(type: string = 'client-log'): EventBuilder {
    return new EventBuilder((evt) => this._enqueueEvent(evt), type);
  }

  // ---- Live traces: transactions & spans ----

  /** Start a root timed operation (a trace root). Recorded as a transaction. */
  startTransaction(name: string, opts?: StartOptions): Transaction {
    const id = randomHex(16);
    const trace_id = randomHex(32);
    const type = opts?.type ?? DEFAULT_TYPE;
    this._activeSpans.set(id, {
      kind: 'transaction', id, trace_id, name, type,
      startTime: now(), tzOffset: tzOffsetMinutes(), children: [],
    });
    return new Transaction(this, id, trace_id, type);
  }

  /** Start a sub-operation under a transaction or span. Recorded as a span. */
  startSpan(name: string, parent: Transaction | Span, opts?: StartOptions): Span {
    const id = randomHex(16);
    const type = opts?.type ?? DEFAULT_TYPE;
    this._activeSpans.set(id, {
      kind: 'span', id,
      trace_id: parent.traceId,
      transaction_id: parent.transactionId,
      parent_id: parent.id,
      name, type,
      startTime: now(), tzOffset: tzOffsetMinutes(), children: [],
    });
    this._activeSpans.get(parent.id)?.children.push(id);
    return new Span(this, id, parent.traceId, parent.transactionId, parent.id, type);
  }

  /** Internal: end a live transaction/span by id (called by the handles). */
  _end(id: string, opts?: EndOptions): void {
    const active = this._activeSpans.get(id);
    if (!active) return;

    // Auto-close any children not yet ended, so a forgotten child can't leak.
    for (const childId of active.children) {
      if (this._activeSpans.has(childId)) this._end(childId);
    }

    const duration = Math.max(0, now() - active.startTime);
    const base = {
      id: active.id,
      trace_id: active.trace_id,
      name: active.name,
      type: active.type,
      timestamp: Math.round(active.startTime * 1000), // ms → µs
      duration: Math.round(duration),
      outcome: opts?.outcome ?? 'success',
      tz_offset: active.tzOffset,
      ...(opts?.labels && Object.keys(opts.labels).length > 0 ? { context: { labels: opts.labels } } : {}),
    };

    this._activeSpans.delete(id);

    if (active.kind === 'transaction') {
      this._enqueueTransaction(base as TransactionRecord);
    } else {
      this._enqueueSpan({ ...base, transaction_id: active.transaction_id!, parent_id: active.parent_id! } as SpanRecord);
    }
  }

  // ---- One-shot (pre-measured) traces ----

  /** Record a complete root operation timed elsewhere → a transaction. */
  recordTransaction(name: string, durationMs: number, opts?: RecordOptions): void {
    if (this._disposed || this._belowThreshold(durationMs, opts)) return;
    const id = randomHex(16);
    this._enqueueTransaction(this._buildOneShot(id, randomHex(32), name, durationMs, opts) as TransactionRecord);
  }

  /** Record a complete sub-operation timed elsewhere → a span under `parent`. */
  recordSpan(name: string, durationMs: number, parent: Transaction | Span, opts?: RecordOptions): void {
    if (this._disposed || this._belowThreshold(durationMs, opts)) return;
    const id = randomHex(16);
    const rec = this._buildOneShot(id, parent.traceId, name, durationMs, opts) as SpanRecord;
    rec.transaction_id = parent.transactionId;
    rec.parent_id = parent.id;
    this._enqueueSpan(rec);
  }

  private _belowThreshold(durationMs: number, opts?: RecordOptions): boolean {
    return opts?.minDurationMs !== undefined && durationMs < opts.minDurationMs;
  }

  private _buildOneShot(id: string, trace_id: string, name: string, durationMs: number, opts?: RecordOptions) {
    const d = isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    const rec: TransactionRecord | SpanRecord = {
      id, trace_id, name,
      type: opts?.type ?? DEFAULT_TYPE,
      // No live start, so back-compute it from the measured duration.
      timestamp: Math.round((now() - d) * 1000), // ms → µs
      duration: Math.round(d),
      outcome: opts?.outcome ?? 'success',
      tz_offset: tzOffsetMinutes(),
    } as any;
    if (opts?.labels && Object.keys(opts.labels).length > 0) rec.context = { labels: opts.labels };
    return rec;
  }

  // ---- Transport ----

  async flush(): Promise<void> {
    if (this._disposed || this._flushing) return;
    if (this._eventBuffer.length === 0 && this._transactionBuffer.length === 0 && this._spanBuffer.length === 0) return;

    this._flushing = true;
    try {
      const events = this._eventBuffer.splice(0);
      const transactions = this._transactionBuffer.splice(0);
      const spans = this._spanBuffer.splice(0);
      const origin = this._takeOriginIfChanged();
      await this._sendInChunks(events, transactions, spans, origin);
    } finally {
      this._flushing = false;
      this._schedulePersist();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._flushHandle) { clearInterval(this._flushHandle); this._flushHandle = null; }
    if (this._persistHandle) { clearTimeout(this._persistHandle); this._persistHandle = null; }
    this._persistNow();
  }

  // ---- Internal: buffering ----

  private _enqueueEvent(event: EventRecord): void {
    if (this._disposed) return;
    // Level gate: drop events below the host-supplied minimum before buffering.
    const minLevel = this._opts.getMinLevel?.();
    if (minLevel && LEVEL_RANK[event.level] < LEVEL_RANK[minLevel]) return;
    if (event.locale === undefined) {
      const locale = this._opts.getLocale?.();
      if (locale) event.locale = locale;
    }
    this._eventBuffer.push(event);
    this._afterEnqueue();
  }

  private _enqueueTransaction(rec: TransactionRecord): void {
    if (this._disposed) return;
    this._transactionBuffer.push(rec);
    this._afterEnqueue();
  }

  private _enqueueSpan(rec: SpanRecord): void {
    if (this._disposed) return;
    this._spanBuffer.push(rec);
    this._afterEnqueue();
  }

  private _afterEnqueue(): void {
    this._schedulePersist();
    const total = this._eventBuffer.length + this._transactionBuffer.length + this._spanBuffer.length;
    if (total >= (this._opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE)) this.flush();
  }

  /** The origin to attach to this flush, or undefined if unchanged since last sent. */
  private _takeOriginIfChanged(): RecordOrigin | undefined {
    let origin: RecordOrigin;
    try { origin = this._opts.getOrigin(); } catch { return undefined; }
    const oj = JSON.stringify(origin);
    if (oj === this._lastOriginJson) return undefined;
    this._lastOriginJson = oj;
    return { ...origin, lifetime_id: this._lifetimeId };
  }

  // ---- Internal: chunked sending ----

  private async _sendInChunks(
    events: EventRecord[],
    transactions: TransactionRecord[],
    spans: SpanRecord[],
    origin: RecordOrigin | undefined,
  ): Promise<void> {
    const maxChunkSize = this._opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const maxChunkBytes = this._opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;

    // One ordered work list tagged by kind; preserves order within each kind.
    type Tagged = { k: 'e' | 't' | 's'; rec: EventRecord | TransactionRecord | SpanRecord };
    const work: Tagged[] = [
      ...events.map((rec) => ({ k: 'e' as const, rec })),
      ...transactions.map((rec) => ({ k: 't' as const, rec })),
      ...spans.map((rec) => ({ k: 's' as const, rec })),
    ];

    let i = 0;
    let isFirst = true;
    while (i < work.length || (isFirst && origin)) {
      if (!isFirst) await delay(INTER_CHUNK_DELAY_MS);

      const ce: EventRecord[] = [];
      const ct: TransactionRecord[] = [];
      const cs: SpanRecord[] = [];
      let bytes = 200; // base overhead for the batch envelope
      while (i < work.length && (ce.length + ct.length + cs.length) < maxChunkSize) {
        const item = work[i];
        const itemBytes = estimateJsonSize(item.rec);
        if (bytes + itemBytes > maxChunkBytes && (ce.length + ct.length + cs.length) > 0) break;
        if (item.k === 'e') ce.push(item.rec as EventRecord);
        else if (item.k === 't') ct.push(item.rec as TransactionRecord);
        else cs.push(item.rec as SpanRecord);
        bytes += itemBytes;
        i++;
      }

      const chunkOrigin = isFirst ? origin : undefined;
      isFirst = false;
      if (ce.length === 0 && ct.length === 0 && cs.length === 0 && !chunkOrigin) break;
      await this._sendChunkWithRetry(ce, ct, cs, chunkOrigin);
    }
  }

  private async _sendChunkWithRetry(
    events: EventRecord[],
    transactions: TransactionRecord[],
    spans: SpanRecord[],
    origin: RecordOrigin | undefined,
  ): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this._sendChunk(events, transactions, spans, origin);
        return;
      } catch {
        if (attempt < MAX_RETRIES) {
          await delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
        } else {
          // Max retries exceeded — put records back for persistence/retry, and
          // re-arm the origin so it ships again on the next successful flush.
          this._eventBuffer.push(...events);
          this._transactionBuffer.push(...transactions);
          this._spanBuffer.push(...spans);
          if (origin) this._lastOriginJson = null;
          this._schedulePersist();
        }
      }
    }
  }

  private async _sendChunk(
    events: EventRecord[],
    transactions: TransactionRecord[],
    spans: SpanRecord[],
    origin: RecordOrigin | undefined,
  ): Promise<void> {
    const batch: RecordBatch = { events, transactions, spans };
    batch.lifetime_id = this._lifetimeId;

    const userId = this._opts.getUserId?.();
    const deviceId = this._opts.getDeviceId?.();
    if (userId) batch.user_id = userId;
    if (deviceId) batch.device_id = deviceId;
    if (origin) batch.origin = origin;

    const headers = await Promise.resolve(this._opts.getAuthHeaders());
    const response = await fetch(this._opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(batch),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
  }

  // ---- Internal: persistence ----

  private _schedulePersist(): void {
    if (this._persistHandle || !this._opts.persistLogs) return;
    this._persistHandle = setTimeout(() => {
      this._persistHandle = null;
      this._persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private _persistNow(): void {
    if (!this._opts.persistLogs) return;
    if (this._eventBuffer.length === 0 && this._transactionBuffer.length === 0 && this._spanBuffer.length === 0) {
      this._opts.persistLogs('').catch(() => {});
      return;
    }
    const data = JSON.stringify({
      events: this._eventBuffer,
      transactions: this._transactionBuffer,
      spans: this._spanBuffer,
    });
    this._opts.persistLogs(data).catch(() => {});
  }

  private async _loadPersistedLogs(): Promise<void> {
    if (!this._opts.loadPersistedLogs) return;
    try {
      const data = await this._opts.loadPersistedLogs();
      if (!data) return;
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed.events)) this._eventBuffer.push(...parsed.events);
      if (Array.isArray(parsed.transactions)) this._transactionBuffer.push(...parsed.transactions);
      if (Array.isArray(parsed.spans)) this._spanBuffer.push(...parsed.spans);
      this._opts.persistLogs?.('').catch(() => {});
    } catch {
      // Ignore parse errors from corrupted persisted data
    }
  }
}

// ---- Trace handles ----

/** A live root operation. Recorded as a `transaction` when ended. */
export class Transaction {
  constructor(
    private readonly _client: TracelogClient,
    readonly id: string,
    readonly traceId: string,
    readonly type: string,
  ) {}
  /** A transaction is its own trace root. */
  get transactionId(): string { return this.id; }
  startSpan(name: string, opts?: StartOptions): Span { return this._client.startSpan(name, this, opts); }
  end(opts?: EndOptions): void { this._client._end(this.id, opts); }
}

/** A live sub-operation. Recorded as a `span` when ended. */
export class Span {
  constructor(
    private readonly _client: TracelogClient,
    readonly id: string,
    readonly traceId: string,
    readonly transactionId: string,
    readonly parentId: string,
    readonly type: string,
  ) {}
  startSpan(name: string, opts?: StartOptions): Span { return this._client.startSpan(name, this, opts); }
  end(opts?: EndOptions): void { this._client._end(this.id, opts); }
}

// ---- Helpers ----

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

function now(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    if (!(now as any)._offset) {
      (now as any)._offset = Date.now() - performance.now();
    }
    return (now as any)._offset + performance.now();
  }
  return Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateJsonSize(obj: any): number {
  return JSON.stringify(obj).length;
}
