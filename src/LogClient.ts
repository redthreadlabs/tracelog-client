import { EventBuilder } from './EventBuilder';
import { tzOffsetMinutes } from './util';
import {
  JsonValue,
  LogBatch,
  LogClientOptions,
  LogEventItem,
  LogPerfItem,
  PerfToken,
} from './types';

interface ActivePerf {
  token: PerfToken;
  startTime: number;
  /** minutes east of UTC at the perf's start (see tz_offset on the record) */
  tzOffset: number;
  parentToken?: PerfToken;
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

export class LogClient {

  private _opts: Required<Pick<LogClientOptions, 'endpoint' | 'client'>> & LogClientOptions;
  private _eventBuffer: LogEventItem[] = [];
  private _perfBuffer: LogPerfItem[] = [];
  private _activePerfs: Map<string, ActivePerf> = new Map();
  private _flushHandle: ReturnType<typeof setInterval> | null = null;
  private _persistHandle: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;
  private _flushing = false;

  constructor(opts: LogClientOptions) {
    this._opts = opts;
    this._loadPersistedLogs();
    this._flushHandle = setInterval(() => this.flush(), opts.flushCadenceMs ?? DEFAULT_FLUSH_CADENCE_MS);
  }

  // ---- Fluent event builder ----

  event(type: string = 'client-log'): EventBuilder {
    return new EventBuilder((evt) => this._enqueueEvent(evt), type);
  }

  // ---- Perf timing ----

  startPerf(name: string, parent?: PerfToken): PerfToken {
    const id = randomHex(16);
    const trace_id = parent ? parent.trace_id : randomHex(32);
    const root_id = parent ? parent.root_id : id;

    const token: PerfToken = { id, trace_id, root_id, name };
    const active: ActivePerf = {
      token,
      startTime: now(),
      tzOffset: tzOffsetMinutes(),
      parentToken: parent,
      children: [],
    };

    this._activePerfs.set(id, active);

    // Register as child of parent
    if (parent) {
      const parentActive = this._activePerfs.get(parent.id);
      if (parentActive) {
        parentActive.children.push(id);
      }
    }

    return token;
  }

  endPerf(token: PerfToken, context?: Record<string, JsonValue>): void {
    const active = this._activePerfs.get(token.id);
    if (!active) return;

    const duration = now() - active.startTime;

    // Auto-close children that haven't been ended yet
    for (const childId of active.children) {
      const childActive = this._activePerfs.get(childId);
      if (childActive) {
        this.endPerf(childActive.token);
      }
    }

    const perf: LogPerfItem = {
      id: token.id,
      trace_id: token.trace_id,
      root_id: token.root_id,
      name: token.name,
      type: 'client-perf',
      timestamp: Math.round(active.startTime),
      duration: Math.round(duration),
      outcome: 'success',
      tz_offset: active.tzOffset,
    };

    if (active.parentToken) {
      perf.parent_id = active.parentToken.id;
    }

    if (context && Object.keys(context).length > 0) {
      perf.context = { tags: context };
    }

    this._perfBuffer.push(perf);
    this._activePerfs.delete(token.id);
    this._schedulePersist();

    // Force flush if buffer is getting large
    if (this._perfBuffer.length + this._eventBuffer.length >= (this._opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE)) {
      this.flush();
    }
  }

  // ---- Transport ----

  async flush(): Promise<void> {
    if (this._disposed || this._flushing) return;
    if (this._eventBuffer.length === 0 && this._perfBuffer.length === 0) return;

    this._flushing = true;

    try {
      const events = this._eventBuffer.splice(0);
      const perfs = this._perfBuffer.splice(0);
      await this._sendInChunks(events, perfs);
    } finally {
      this._flushing = false;
      this._schedulePersist();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._flushHandle) {
      clearInterval(this._flushHandle);
      this._flushHandle = null;
    }
    if (this._persistHandle) {
      clearTimeout(this._persistHandle);
      this._persistHandle = null;
    }

    // Persist anything remaining
    this._persistNow();
  }

  // ---- Internal: event buffering ----

  private _enqueueEvent(event: LogEventItem): void {
    if (this._disposed) return;
    this._eventBuffer.push(event);
    this._schedulePersist();

    if (this._eventBuffer.length >= (this._opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE)) {
      this.flush();
    }
  }

  // ---- Internal: chunked sending ----

  private async _sendInChunks(events: LogEventItem[], perfs: LogPerfItem[]): Promise<void> {
    const maxChunkSize = this._opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const maxChunkBytes = this._opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;

    // Combine events and perfs into chunks that respect size limits
    let eventIdx = 0;
    let perfIdx = 0;
    let isFirstChunk = true;

    while (eventIdx < events.length || perfIdx < perfs.length) {
      if (!isFirstChunk) {
        await delay(INTER_CHUNK_DELAY_MS);
      }
      isFirstChunk = false;

      const chunkEvents: LogEventItem[] = [];
      const chunkPerfs: LogPerfItem[] = [];
      let estimatedBytes = 200; // base overhead for batch envelope

      // Fill chunk with events
      while (eventIdx < events.length && chunkEvents.length + chunkPerfs.length < maxChunkSize) {
        const itemBytes = estimateJsonSize(events[eventIdx]);
        if (estimatedBytes + itemBytes > maxChunkBytes && chunkEvents.length > 0) break;
        chunkEvents.push(events[eventIdx]);
        estimatedBytes += itemBytes;
        eventIdx++;
      }

      // Fill chunk with perfs
      while (perfIdx < perfs.length && chunkEvents.length + chunkPerfs.length < maxChunkSize) {
        const itemBytes = estimateJsonSize(perfs[perfIdx]);
        if (estimatedBytes + itemBytes > maxChunkBytes && (chunkEvents.length + chunkPerfs.length) > 0) break;
        chunkPerfs.push(perfs[perfIdx]);
        estimatedBytes += itemBytes;
        perfIdx++;
      }

      if (chunkEvents.length === 0 && chunkPerfs.length === 0) break;

      await this._sendChunkWithRetry(chunkEvents, chunkPerfs);
    }
  }

  private async _sendChunkWithRetry(events: LogEventItem[], perfs: LogPerfItem[]): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this._sendChunk(events, perfs);
        return;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
        } else {
          // Max retries exceeded — put items back for persistence
          this._eventBuffer.push(...events);
          this._perfBuffer.push(...perfs);
          this._schedulePersist();
        }
      }
    }
  }

  private async _sendChunk(events: LogEventItem[], perfs: LogPerfItem[]): Promise<void> {
    const batch: LogBatch = {
      client: this._opts.client,
      events,
      perfs,
    };

    const userId = this._opts.getUserId?.();
    const sessionRef = this._opts.getSessionRef?.();
    const deviceId = this._opts.getDeviceId?.();

    if (userId) batch.user_id = userId;
    if (sessionRef) batch.session_ref = sessionRef;
    if (deviceId) batch.device_id = deviceId;

    const headers = await Promise.resolve(this._opts.getAuthHeaders());

    const response = await fetch(this._opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
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
    if (this._eventBuffer.length === 0 && this._perfBuffer.length === 0) {
      this._opts.persistLogs('').catch(() => {});
      return;
    }
    const data = JSON.stringify({
      events: this._eventBuffer,
      perfs: this._perfBuffer,
    });
    this._opts.persistLogs(data).catch(() => {});
  }

  private async _loadPersistedLogs(): Promise<void> {
    if (!this._opts.loadPersistedLogs) return;
    try {
      const data = await this._opts.loadPersistedLogs();
      if (!data) return;
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed.events)) {
        this._eventBuffer.push(...parsed.events);
      }
      if (Array.isArray(parsed.perfs)) {
        this._perfBuffer.push(...parsed.perfs);
      }
      // Clear persisted data now that it's loaded
      this._opts.persistLogs?.('').catch(() => {});
    } catch {
      // Ignore parse errors from corrupted persisted data
    }
  }
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
    // Use performance.now() for high-res timing, but we need wall-clock for timestamps
    // Store the offset on first call
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
  // Fast estimate — avoid full serialization during chunking
  return JSON.stringify(obj).length;
}
