import type { ClientInfo } from '@redthreadlabs/tracelog-schema';

// The wire-format types are the shared contract — re-exported from
// @redthreadlabs/tracelog-schema so the client, the server's /logs endpoint,
// and the viewer all share one definition (and gain new fields like the
// per-event tz_offset without copying them around).
export type {
  JsonValue,
  LogLevel,
  LogBatch,
  LogEventItem,
  LogPerfItem,
  ClientInfo,
} from '@redthreadlabs/tracelog-schema';

// ---- Client-only types (the SDK surface, not part of the wire contract) ----

// ---- Perf token (returned by startPerf) ----

export interface PerfToken {
  /** 16-char hex ID for this perf */
  id: string;
  /** 32-char hex trace ID (shared across the entire perf tree) */
  trace_id: string;
  /** ID of the root perf in this trace */
  root_id: string;
  /** Name of the operation being measured */
  name: string;
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
  /** Flush cadence in ms. Default: 5000 */
  flushCadenceMs?: number;
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
