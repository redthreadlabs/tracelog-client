import { EventBuilder } from './EventBuilder';
import { LogClientOptions, TimerToken } from './types';
export declare class LogClient {
    private _opts;
    private _eventBuffer;
    private _timerBuffer;
    private _activeTimers;
    private _flushTimer;
    private _persistTimer;
    private _disposed;
    private _flushing;
    constructor(opts: LogClientOptions);
    event(type?: string): EventBuilder;
    startTimer(name: string, parent?: TimerToken): TimerToken;
    endTimer(token: TimerToken, context?: Record<string, string | number | boolean>): void;
    flush(): Promise<void>;
    dispose(): void;
    private _enqueueEvent;
    private _sendInChunks;
    private _sendChunkWithRetry;
    private _sendChunk;
    private _schedulePersist;
    private _persistNow;
    private _loadPersistedLogs;
}
