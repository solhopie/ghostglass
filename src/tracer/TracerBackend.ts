/**
 * Tracer backend contract.
 *
 * A backend observes a command's execution and produces a raw trace artifact
 * (e.g. an strace log file). Parsing that artifact into normalized
 * GhostGlass events is a separate step (see src/parser), so backends stay
 * focused on observation only. The optional `streamLive` variant parses
 * incrementally with the shared stream parser while the command runs —
 * still through src/parser, never a duplicated implementation.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { TraceParseStats } from "../parser/straceParser.js";

export interface TraceRunOptions {
  /** Working directory the traced command runs in. */
  cwd: string;
  /** Absolute path where the backend should write its raw trace output. */
  rawTracePath: string;
  /**
   * Run ID, allocated before tracing starts. Used by live streaming to
   * stamp stable event IDs as events are parsed; optional for `run`.
   */
  runId?: string | undefined;
}

export interface TraceResult {
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  /**
   * Exit code of the traced command, as observed by the backend wrapper.
   * May be refined later from the parsed trace (e.g. strace "exited with").
   */
  exitCode: number | null;
  /** Signal that terminated the traced command, if any (e.g. "SIGINT"). */
  signal: string | null;
  /**
   * Signal GhostGlass itself received and forwarded to the traced process
   * group (e.g. user pressed Ctrl+C). Null when the run completed on its own.
   */
  forwardedSignal: string | null;
  rawTracePath: string;
  /**
   * Parser counters, populated by streaming backends that parse
   * incrementally (undefined for plain `run`, which parses afterwards).
   */
  parseStats?: TraceParseStats | undefined;
}

export interface BackendAvailability {
  available: boolean;
  /** Human-readable detail: version string, or install instructions. */
  detail: string;
}

export interface TracerBackend {
  /** Backend identifier, stored in run metadata (e.g. "strace"). */
  readonly name: string;
  /** Check that the backend's prerequisites exist on this machine. */
  checkAvailable(): Promise<BackendAvailability>;
  /**
   * Run `command` under observation.
   *
   * Must forward signals (SIGINT/SIGTERM/...) to the traced process tree,
   * preserve the command's exit code semantics, and clean up tracing
   * resources even when GhostGlass itself is interrupted.
   */
  run(command: string[], options: TraceRunOptions): Promise<TraceResult>;
  /**
   * Optional live variant of `run`: normalized events are yielded through
   * the async iterator while the command is still executing, and `done()`
   * resolves with the final TraceResult once it exits.
   *
   * Implementations that cannot stream may leave this undefined; callers
   * then fall back to `run` plus post-hoc parsing.
   */
  streamLive?(command: string[], options: TraceRunOptions): TraceStream;
}

/**
 * A live trace: an async iterator of normalized events plus a promise for
 * the final result.
 *
 * The iterator completes when the traced command (and the tracer) finish;
 * `done()` resolves with exit code / signal information. Events are never
 * duplicated and arrive in trace order.
 */
export interface TraceStream extends AsyncIterable<GhostGlassEvent> {
  done(): Promise<TraceResult>;
}
