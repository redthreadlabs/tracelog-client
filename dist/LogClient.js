"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogClient = void 0;
const EventBuilder_1 = require("./EventBuilder");
// Default constants (matching the original AppLogRecorder)
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFER_SIZE = 100;
const DEFAULT_MAX_CHUNK_SIZE = 50;
const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
const INTER_CHUNK_DELAY_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const PERSIST_DEBOUNCE_MS = 100;
class LogClient {
    constructor(opts) {
        this._eventBuffer = [];
        this._timerBuffer = [];
        this._activeTimers = new Map();
        this._flushTimer = null;
        this._persistTimer = null;
        this._disposed = false;
        this._flushing = false;
        this._opts = opts;
        this._loadPersistedLogs();
        this._flushTimer = setInterval(() => this.flush(), opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    }
    // ---- Fluent event builder ----
    event(type = 'client-log') {
        return new EventBuilder_1.EventBuilder((evt) => this._enqueueEvent(evt), type);
    }
    // ---- Perf timing ----
    startTimer(name, parent) {
        const id = randomHex(16);
        const trace_id = parent ? parent.trace_id : randomHex(32);
        const root_id = parent ? parent.root_id : id;
        const token = { id, trace_id, root_id, key: name };
        const active = {
            token,
            startTime: now(),
            parentToken: parent,
            children: [],
        };
        this._activeTimers.set(id, active);
        // Register as child of parent
        if (parent) {
            const parentActive = this._activeTimers.get(parent.id);
            if (parentActive) {
                parentActive.children.push(id);
            }
        }
        return token;
    }
    endTimer(token, context) {
        const active = this._activeTimers.get(token.id);
        if (!active)
            return;
        const duration = now() - active.startTime;
        // Auto-close children that haven't been ended yet
        for (const childId of active.children) {
            const childActive = this._activeTimers.get(childId);
            if (childActive) {
                this.endTimer(childActive.token);
            }
        }
        const timer = {
            id: token.id,
            trace_id: token.trace_id,
            root_id: token.root_id,
            name: token.key,
            type: 'client-perf',
            timestamp: Math.round(active.startTime),
            duration: Math.round(duration),
            outcome: 'success',
        };
        if (active.parentToken) {
            timer.parent_id = active.parentToken.id;
        }
        if (context && Object.keys(context).length > 0) {
            timer.context = { tags: context };
        }
        this._timerBuffer.push(timer);
        this._activeTimers.delete(token.id);
        this._schedulePersist();
        // Force flush if buffer is getting large
        if (this._timerBuffer.length + this._eventBuffer.length >= (this._opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE)) {
            this.flush();
        }
    }
    // ---- Transport ----
    async flush() {
        if (this._disposed || this._flushing)
            return;
        if (this._eventBuffer.length === 0 && this._timerBuffer.length === 0)
            return;
        this._flushing = true;
        try {
            const events = this._eventBuffer.splice(0);
            const timers = this._timerBuffer.splice(0);
            await this._sendInChunks(events, timers);
        }
        finally {
            this._flushing = false;
            this._schedulePersist();
        }
    }
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        // Persist anything remaining
        this._persistNow();
    }
    // ---- Internal: event buffering ----
    _enqueueEvent(event) {
        if (this._disposed)
            return;
        this._eventBuffer.push(event);
        this._schedulePersist();
        if (this._eventBuffer.length >= (this._opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE)) {
            this.flush();
        }
    }
    // ---- Internal: chunked sending ----
    async _sendInChunks(events, timers) {
        const maxChunkSize = this._opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
        const maxChunkBytes = this._opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
        // Combine events and timers into chunks that respect size limits
        let eventIdx = 0;
        let timerIdx = 0;
        let isFirstChunk = true;
        while (eventIdx < events.length || timerIdx < timers.length) {
            if (!isFirstChunk) {
                await delay(INTER_CHUNK_DELAY_MS);
            }
            isFirstChunk = false;
            const chunkEvents = [];
            const chunkTimers = [];
            let estimatedBytes = 200; // base overhead for batch envelope
            // Fill chunk with events
            while (eventIdx < events.length && chunkEvents.length + chunkTimers.length < maxChunkSize) {
                const itemBytes = estimateJsonSize(events[eventIdx]);
                if (estimatedBytes + itemBytes > maxChunkBytes && chunkEvents.length > 0)
                    break;
                chunkEvents.push(events[eventIdx]);
                estimatedBytes += itemBytes;
                eventIdx++;
            }
            // Fill chunk with timers
            while (timerIdx < timers.length && chunkEvents.length + chunkTimers.length < maxChunkSize) {
                const itemBytes = estimateJsonSize(timers[timerIdx]);
                if (estimatedBytes + itemBytes > maxChunkBytes && (chunkEvents.length + chunkTimers.length) > 0)
                    break;
                chunkTimers.push(timers[timerIdx]);
                estimatedBytes += itemBytes;
                timerIdx++;
            }
            if (chunkEvents.length === 0 && chunkTimers.length === 0)
                break;
            await this._sendChunkWithRetry(chunkEvents, chunkTimers);
        }
    }
    async _sendChunkWithRetry(events, timers) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                await this._sendChunk(events, timers);
                return;
            }
            catch (err) {
                if (attempt < MAX_RETRIES) {
                    await delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
                }
                else {
                    // Max retries exceeded — put items back for persistence
                    this._eventBuffer.push(...events);
                    this._timerBuffer.push(...timers);
                    this._schedulePersist();
                }
            }
        }
    }
    async _sendChunk(events, timers) {
        const batch = {
            client: this._opts.client,
            events,
            timers,
        };
        const userId = this._opts.getUserId?.();
        const sessionRef = this._opts.getSessionRef?.();
        const deviceId = this._opts.getDeviceId?.();
        if (userId)
            batch.user_id = userId;
        if (sessionRef)
            batch.session_ref = sessionRef;
        if (deviceId)
            batch.device_id = deviceId;
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
    _schedulePersist() {
        if (this._persistTimer || !this._opts.persistLogs)
            return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persistNow();
        }, PERSIST_DEBOUNCE_MS);
    }
    _persistNow() {
        if (!this._opts.persistLogs)
            return;
        if (this._eventBuffer.length === 0 && this._timerBuffer.length === 0) {
            this._opts.persistLogs('').catch(() => { });
            return;
        }
        const data = JSON.stringify({
            events: this._eventBuffer,
            timers: this._timerBuffer,
        });
        this._opts.persistLogs(data).catch(() => { });
    }
    async _loadPersistedLogs() {
        if (!this._opts.loadPersistedLogs)
            return;
        try {
            const data = await this._opts.loadPersistedLogs();
            if (!data)
                return;
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed.events)) {
                this._eventBuffer.push(...parsed.events);
            }
            if (Array.isArray(parsed.timers)) {
                this._timerBuffer.push(...parsed.timers);
            }
            // Clear persisted data now that it's loaded
            this._opts.persistLogs?.('').catch(() => { });
        }
        catch {
            // Ignore parse errors from corrupted persisted data
        }
    }
}
exports.LogClient = LogClient;
// ---- Helpers ----
function randomHex(length) {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * 16)];
    }
    return result;
}
function now() {
    if (typeof performance !== 'undefined' && performance.now) {
        // Use performance.now() for high-res timing, but we need wall-clock for timestamps
        // Store the offset on first call
        if (!now._offset) {
            now._offset = Date.now() - performance.now();
        }
        return now._offset + performance.now();
    }
    return Date.now();
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function estimateJsonSize(obj) {
    // Fast estimate — avoid full serialization during chunking
    return JSON.stringify(obj).length;
}
