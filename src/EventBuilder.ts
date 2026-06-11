import { JsonValue, LogEventItem, LogLevel } from './types';

export type EventEnqueuer = (event: LogEventItem) => void;

export class EventBuilder {

  private _enqueue: EventEnqueuer;
  private _type: string;
  private _level: LogLevel = 'info';
  private _message: string = '';
  private _duration?: number;
  private _error?: { message: string; type?: string; stack?: string };
  private _params?: Record<string, JsonValue>;

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

  withParam(key: string, value: JsonValue): this {
    if (!this._params) this._params = {};
    this._params[key] = value;
    return this;
  }

  withParams(params: Record<string, JsonValue>): this {
    if (!this._params) this._params = {};
    Object.assign(this._params, params);
    return this;
  }

  withError(err: any): this {
    if (err instanceof Error) {
      this._error = { message: withCode(err.message, (err as any).code) };
      if (err.name) this._error.type = err.name;
      if (err.stack) this._error.stack = err.stack;
    } else if (typeof err === 'string') {
      this._error = { message: err };
    } else if (err != null) {
      // Error-like plain objects (e.g. ShareDB op errors: {code, message}).
      // String(err) would yield the useless '[object Object]'.
      const message = typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : safeJson(err);
      this._error = { message: withCode(message, err.code) };
      if (typeof err.name === 'string' && err.name.length > 0) {
        this._error.type = err.name;
      }
      if (typeof err.stack === 'string') this._error.stack = err.stack;
    }
    return this;
  }

  withDuration(ms: number): this {
    this._duration = ms;
    return this;
  }

  send(): void {
    const event: LogEventItem = {
      type: this._type,
      timestamp: Date.now(),
      level: this._level,
      message: this._message,
    };
    if (this._duration !== undefined) event.duration = this._duration;
    if (this._error) event.error = this._error;
    if (this._params) event.params = this._params;
    this._enqueue(event);
  }
}

// Append an error code (ShareDB and Node errors carry one) to the message.
function withCode(message: string, code: unknown): string {
  if (typeof code === 'string' || typeof code === 'number') {
    return `${message} (code: ${code})`;
  }
  return message;
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
