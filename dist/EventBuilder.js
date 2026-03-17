"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBuilder = void 0;
class EventBuilder {
    constructor(enqueue, type) {
        this._level = 'info';
        this._message = '';
        this._enqueue = enqueue;
        this._type = type;
    }
    info(message) {
        this._level = 'info';
        this._message = message;
        return this;
    }
    warn(message) {
        this._level = 'warn';
        this._message = message;
        return this;
    }
    error(message) {
        this._level = 'error';
        this._message = message;
        return this;
    }
    debug(message) {
        this._level = 'debug';
        this._message = message;
        return this;
    }
    withParam(key, value) {
        if (!this._params)
            this._params = {};
        this._params[key] = value;
        return this;
    }
    withParams(params) {
        if (!this._params)
            this._params = {};
        Object.assign(this._params, params);
        return this;
    }
    withDuration(ms) {
        this._duration = ms;
        return this;
    }
    send() {
        const event = {
            type: this._type,
            timestamp: Date.now(),
            level: this._level,
            message: this._message,
        };
        if (this._duration !== undefined)
            event.duration = this._duration;
        if (this._params)
            event.params = this._params;
        this._enqueue(event);
    }
}
exports.EventBuilder = EventBuilder;
