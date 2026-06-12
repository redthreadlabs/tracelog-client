// ---- JSON value type (any valid JSON) ----

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---- Log levels ----

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---- Wire format: POST /logs request body ----

export interface LogBatch {
  client: ClientInfo;
  user_id?: string;
  session_ref?: string;
  device_id?: string;
  events: LogEventItem[];
  timers: TimerItem[];
}

// ---- Individual event item ----

export interface LogEventItem {
  /** Event category, e.g. 'auth', 'billing', 'startup'. Default: 'client-log' */
  type: string;
  /** Epoch milliseconds */
  timestamp: number;
  level: LogLevel;
  message: string;
  /** Duration in milliseconds (for timed events that aren't span-shaped) */
  duration?: number;
  /** Serialized error info. `code` is the structured error code (ShareDB,
   *  Node `err.code`, etc.) — facetable downstream, unlike a code folded
   *  into the message text. */
  error?: { message: string; type?: string; code?: string; stack?: string };
  /** Arbitrary key-value event data */
  params?: Record<string, JsonValue>;
}

// ---- Perf timer item (span-shaped) ----

export interface TimerItem {
  /** 16-char hex ID, generated client-side */
  id: string;
  /** 32-char hex trace ID, shared by parent + children */
  trace_id: string;
  /** ID of the root timer in this trace (for transaction_id on spans) */
  root_id: string;
  /** 16-char hex ID of parent timer (absent for root timers) */
  parent_id?: string;
  /** Operation name, e.g. 'content-store-startup' */
  name: string;
  /** Timer category. Default: 'client-perf' */
  type: string;
  /** Start time, epoch milliseconds */
  timestamp: number;
  /** Duration in milliseconds */
  duration: number;
  outcome: 'success' | 'failure' | 'unknown';
  context?: {
    tags?: Record<string, JsonValue>;
  };
}

// ---- Client / device info (sent once per batch) ----

export interface ClientInfo {
  /** Application name, e.g. 'duiduidui-app' */
  name: string;
  /** Application version */
  version: string;
  os: { name: string; version: string };
  device: { model?: string; brand?: string; type: string };
  runtime: { name: string; version: string };
  screen?: { width: number; height: number; pixel_ratio: number };
  locale?: string;
  timezone?: string;
  device_year_class?: number;
}

// ---- Timer token (returned by startTimer) ----

export interface TimerToken {
  /** 16-char hex ID for this timer */
  id: string;
  /** 32-char hex trace ID (shared across the entire timer tree) */
  trace_id: string;
  /** ID of the root timer in this trace */
  root_id: string;
  /** Key/name of the operation being timed */
  key: string;
}

// ---- LogClient configuration ----

export interface LogClientOptions {
  /** Server endpoint URL for log submission */
  endpoint: string;
  /** Returns auth headers (e.g. { Authorization: 'Bearer ...' }) */
  getAuthHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  /** Static client/device info, sent once per batch */
  client: ClientInfo;
  /** Returns current user ID, if logged in */
  getUserId?: () => string | undefined;
  /** Returns current session reference */
  getSessionRef?: () => string | undefined;
  /** Returns native device identifier */
  getDeviceId?: () => string | undefined;
  /** Flush interval in ms. Default: 5000 */
  flushIntervalMs?: number;
  /** Max events buffered before forced flush. Default: 100 */
  maxBufferSize?: number;
  /** Max events per HTTP request. Default: 50 */
  maxChunkSize?: number;
  /** Max bytes per HTTP request. Default: 524288 (512KB) */
  maxChunkBytes?: number;
  /** Persist pending logs (e.g. to AsyncStorage). Called with JSON string. */
  persistLogs?: (data: string) => Promise<void>;
  /** Load previously persisted logs. Returns JSON string or null. */
  loadPersistedLogs?: () => Promise<string | null>;
}
