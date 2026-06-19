import { JsonValue, EventRecord, LogLevel } from './types';
import { tzOffsetMinutes } from './util';

export type EventEnqueuer = (event: EventRecord) => void;

export class EventBuilder {

  private _enqueue: EventEnqueuer;
  private _type: string;
  private _level: LogLevel = 'info';
  private _message: string = '';
  private _error?: { message: string; type?: string; code?: string; stack?: string };
  private _labels?: Record<string, JsonValue>;

  constructor(enqueue: EventEnqueuer, type: string) {
    this._enqueue = enqueue;
    this._type = type;
  }

  info(message: string): this {
    this._level = 'info';
    this._message = message;
    return this;
  }

  warn(message: string): this {
    this._level = 'warn';
    this._message = message;
    return this;
  }

  error(message: string): this {
    this._level = 'error';
    this._message = message;
    return this;
  }

  debug(message: string): this {
    this._level = 'debug';
    this._message = message;
    return this;
  }

  withLabel(key: string, value: JsonValue): this {
    if (!this._labels) this._labels = {};
    this._labels[key] = value;
    return this;
  }

  withLabels(labels: Record<string, JsonValue>): this {
    if (!this._labels) this._labels = {};
    Object.assign(this._labels, labels);
    return this;
  }

  withError(err: any): this {
    if (err instanceof Error) {
      this._error = { message: err.message };
      if (err.name) this._error.type = err.name;
      const code = extractCode((err as any).code);
      if (code !== undefined) this._error.code = code;
      if (err.stack) this._error.stack = err.stack;
    } else if (typeof err === 'string') {
      this._error = { message: err };
    } else if (err != null) {
      // Error-like plain objects (e.g. ShareDB op errors: {code, message}).
      // String(err) would yield the useless '[object Object]'.
      const message = typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : safeJson(err);
      this._error = { message };
      if (typeof err.name === 'string' && err.name.length > 0) {
        this._error.type = err.name;
      }
      const code = extractCode(err.code);
      if (code !== undefined) this._error.code = code;
      if (typeof err.stack === 'string') this._error.stack = err.stack;
    }
    return this;
  }

  send(): void {
    const event: EventRecord = {
      type: this._type,
      timestamp: Date.now() * 1000, // epoch microseconds (the on-disk unit)
      level: this._level,
      message: this._message,
      tz_offset: tzOffsetMinutes(),
    };
    if (this._error) event.error = this._error;
    if (this._labels) event.context = { labels: this._labels };
    this._enqueue(event);
  }
}

// Stringify an error code (ShareDB and Node errors carry one) for the
// structured `error.code` field — a dedicated field is facetable downstream.
function extractCode(code: unknown): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return undefined;
}

// Bounded JSON fallback for objects with no usable message property.
function safeJson(obj: unknown): string {
  try {
    const json = JSON.stringify(obj);
    if (typeof json === 'string') {
      return json.length > 500 ? json.slice(0, 500) + '…' : json;
    }
  } catch {
    // Circular or otherwise unserializable
  }
  try {
    return `[unserializable error: keys=${Object.keys(obj as object).join(',')}]`;
  } catch {
    return Object.prototype.toString.call(obj);
  }
}
