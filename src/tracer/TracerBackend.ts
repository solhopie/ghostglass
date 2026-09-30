/**
 * Tracer backend contract.
 *
 * A backend observes a command's execution and produces a raw trace artifact
 * (e.g. an strace log file). Parsing that artifact into normalized
 * GhostGlass events is a separate step (see src/parser), so backends stay
 * focused on observation only.
 */

export interface TraceRunOptions {
  /** Working directory the traced command runs in. */
  cwd: string;
  /** Absolute path where the backend should write its raw trace output. */
  rawTracePath: string;
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
}
