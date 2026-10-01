/**
 * Trace query model.
 *
 * A TraceQuery is a declarative, deterministic filter over GhostGlass
 * events. It is independent of any CLI argument syntax or viewer input
 * syntax — those are just frontends that build this structure.
 *
 * Combination semantics:
 * - Different fields combine with AND.
 * - `actions` / `types` arrays combine with OR within the field.
 * - All other fields hold a single value (last one wins if a frontend
 *   supplies the same field twice).
 */
import type { GhostGlassEvent } from "../events/types.js";

/** Result ordering. */
export type QueryOrder = "time" | "sequence";

/**
 * A structured trace query. Every field is optional; an empty query
 * matches all events.
 */
export interface TraceQuery {
  /** Process identity: executable basename, full path, or path suffix. */
  process?: string;
  /** Exact process ID. */
  pid?: number;
  /** Normalized actions; matches if the event's action is any of these (OR). */
  actions?: string[];
  /** Event types ("process" | "file" | "network"); OR within the field. */
  types?: string[];
  /** File basename or path suffix, e.g. "package-lock.json". */
  file?: string;
  /** Glob pattern over the event path, e.g. "/project/src/*". */
  path?: string;
  /** True: only network events. False: exclude network events. */
  network?: boolean;
  /** Destination hostname (case-insensitive substring). */
  host?: string;
  /** Destination IP (exact). */
  ip?: string;
  /** Destination port (exact). */
  port?: number;
  /** Absolute epoch ms, inclusive lower bound on event timestamp. */
  since?: number;
  /** Absolute epoch ms, inclusive upper bound on event timestamp. */
  until?: number;
  /** Case-insensitive substring over displayable event fields. */
  text?: string;
  /** True: only reconstructed events. False: exclude reconstructed events. */
  reconstructed?: boolean;
  /** Max events to return; 0 or undefined means unlimited. */
  limit?: number;
  /** Result ordering; default "time". */
  order?: QueryOrder;
  /**
   * Highlight rule filter (e.g. "high-file-activity"). This is NOT an event
   * predicate — it selects derived highlight records, a separate result
   * category. Frontends apply it to the highlight panel, never by faking
   * highlight records as events.
   */
  highlight?: string;
}

/** Context the matcher needs beyond a single event. */
export interface QueryContext {
  /**
   * Resolve a PID to its executable path, from exec events seen in the
   * trace. When `atSequence` is given, returns the identity in effect at
   * that point in emission order (a PID that re-execs changes identity;
   * earlier events keep the earlier name). Without it, returns the latest
   * known identity. Returns undefined when the PID's identity was never
   * captured.
   */
  executableForPid: (pid: number, atSequence?: number) => string | undefined;
}

/** Machine-readable query result. */
export interface QueryResult {
  runId: string;
  /** The query as executed (normalized). */
  query: TraceQuery;
  /** Total events matching before the limit was applied. */
  totalMatches: number;
  /** Events actually returned (after limit). */
  returned: number;
  /** True when a limit truncated the result. */
  truncated: boolean;
  events: GhostGlassEvent[];
}

/** Error thrown for malformed queries. Message is safe to show to users. */
export class QueryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QueryError";
    this.code = code;
  }
}

/** Normalized actions in the GhostGlass event model. */
export const KNOWN_ACTIONS = [
  "exec",
  "spawn",
  "exit",
  "read",
  "write",
  "create",
  "delete",
  "rename",
  "mkdir",
  "connect",
] as const;

/** Event types in the GhostGlass event model. */
export const KNOWN_TYPES = ["process", "file", "network"] as const;
