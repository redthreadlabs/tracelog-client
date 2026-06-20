import type { JsonValue, LogLevel, RecordOrigin } from '@redthreadlabs/tracelog-schema';

// The wire-format types are the shared contract — re-exported from
// @redthreadlabs/tracelog-schema so the client, the server's /logs endpoint,
// and the viewer all share one definition.
export type {
  JsonValue,
  LogLevel,
  RecordBatch,
  EventRecord,
  TransactionRecord,
  SpanRecord,
  RecordContext,
  RecordOrigin,
  RecordKind,
} from '@redthreadlabs/tracelog-schema';

// ---- Client-only types (the SDK surface, not part of the wire contract) ----

export type Outcome = 'success' | 'failure' | 'unknown';

/** Options when starting a live transaction or span. */
export interface StartOptions {
  /** Span/transaction type, e.g. 'db', 'app'. Default: 'app'. */
  type?: string;
}

/** Options when ending a live transaction or span. */
export interface EndOptions {
  labels?: Record<string, JsonValue>;
  outcome?: Outcome;
}

/** Options when recording a pre-measured transaction or span in one call. */
export interface RecordOptions {
  type?: string;
  labels?: Record<string, JsonValue>;
  outcome?: Outcome;
  /** Drop the record if its duration is below this (ms). */
  minDurationMs?: number;
}

// ---- LogClient configuration ----

export interface LogClientOptions {
  /** Server endpoint URL for log submission */
  endpoint: string;
  /** Returns auth headers (e.g. { Authorization: 'Bearer ...' }) */
  getAuthHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  /**
   * The current RecordOrigin (service + environment). The SDK sends it as a
   * `metadata` record on the first batch of this lifetime and again whenever it
   * changes; it fills in `lifetime_id`.
   */
  getOrigin: () => RecordOrigin;
  /** Returns current user ID, if logged in (→ batch.user_id). */
  getUserId?: () => string | undefined;
  /** Returns the UI locale at event time; stamped onto each event. */
  getLocale?: () => string | undefined;
  /**
   * Returns the minimum level to emit. Events whose level ranks below this
   * (debug < info < warn < error) are dropped before buffering — they never
   * persist or ship. Called once per event, so keep it cheap and synchronous.
   * Omit to emit every level (default). Transactions/spans are unaffected.
   */
  getMinLevel?: () => LogLevel;
  /** Flush cadence in ms. Default: 5000 */
  flushCadenceMs?: number;
  /** Max records buffered before forced flush. Default: 100 */
  maxBufferSize?: number;
  /** Max records per HTTP request. Default: 50 */
  maxChunkSize?: number;
  /** Max bytes per HTTP request. Default: 524288 (512KB) */
  maxChunkBytes?: number;
  /** Persist pending records (e.g. to AsyncStorage). Called with JSON string. */
  persistLogs?: (data: string) => Promise<void>;
  /** Load previously persisted records. Returns JSON string or null. */
  loadPersistedLogs?: () => Promise<string | null>;
}
