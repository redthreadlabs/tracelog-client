import { LogEventItem } from './types';
export type EventEnqueuer = (event: LogEventItem) => void;
export declare class EventBuilder {
    private _enqueue;
    private _type;
    private _level;
    private _message;
    private _duration?;
    private _params?;
    constructor(enqueue: EventEnqueuer, type: string);
    info(message: string): this;
    warn(message: string): this;
    error(message: string): this;
    debug(message: string): this;
    withParam(key: string, value: string | number | boolean): this;
    withParams(params: Record<string, string | number | boolean>): this;
    withDuration(ms: number): this;
    send(): void;
}
