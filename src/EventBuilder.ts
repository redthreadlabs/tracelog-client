import { LogEventItem, LogLevel } from './types';

export type EventEnqueuer = (event: LogEventItem) => void;

export class EventBuilder {

  private _enqueue: EventEnqueuer;
  private _type: string;
  private _level: LogLevel = 'info';
  private _message: string = '';
  private _duration?: number;
  private _params?: Record<string, string | number | boolean>;

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

  withParam(key: string, value: string | number | boolean): this {
    if (!this._params) this._params = {};
    this._params[key] = value;
    return this;
  }

  withParams(params: Record<string, string | number | boolean>): this {
    if (!this._params) this._params = {};
    Object.assign(this._params, params);
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
    if (this._params) event.params = this._params;
    this._enqueue(event);
  }
}
