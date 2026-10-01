/**
 * The GhostGlass normalized event model.
 *
 * Every tracing backend (strace today, eBPF tomorrow) must translate its
 * raw observations into this single common format. Presentation, storage,
 * and analysis code only ever touches these types — never backend-specific
 * trace output.
 */

/** Broad category of system activity. */
export type GhostGlassEventType = "process" | "file" | "network";

/**
 * What happened, in developer-friendly terms. Raw syscall names are
 * normalized into these actions; the original syscall is preserved in
 * `metadata.syscall` when it is useful for debugging.
 */
export type GhostGlassEventAction =
  // process
  | "exec" // a process image was replaced (execve/execveat)
  | "spawn" // a child process was created (clone/fork/vfork)
  | "exit" // a process exited
  // file
  | "read" // file opened for reading, or bytes read from a file
  | "write" // file opened for writing, or bytes written to a file
  | "create" // file created (O_CREAT, creat)
  | "delete" // file removed (unlink/unlinkat)
  | "rename" // file renamed
  | "mkdir" // directory created
  // network
  | "connect"; // outbound connection attempt

export interface GhostGlassEvent {
  /** Unique within a run, e.g. "gg_20260930_001-000042". */
  id: string;
  /** The run this event belongs to. */
  runId: string;
  /** Epoch milliseconds, derived from the tracer's timestamp. */
  timestamp: number;
  /**
   * Ingestion/emission order within the run, starting at 1. This is the
   * stable GhostGlass sequence: the order events were received and emitted.
   * It is NOT the same as timestamp order — a reconstructed syscall carries
   * its syscall-start timestamp but is emitted when its resumed fragment
   * arrives, so it can legitimately follow events with later timestamps.
   *
   * Optional for backward compatibility: runs recorded before sequence
   * numbers existed have no stored value; readers derive it in memory from
   * events.jsonl file order (which is emission order).
   */
  sequence?: number;
  type: GhostGlassEventType;
  action: GhostGlassEventAction;
  /** PID of the process that performed the activity. */
  pid: number;
  /** For spawn events: the PID that created this process. */
  parentPid?: number;
  /** Executable path for exec/spawn events (from execve). */
  executable?: string;
  /** Filesystem path for file events. */
  path?: string;
  /** Destination hostname, only when reliably determined (often absent). */
  host?: string;
  /** Destination IP for network events. */
  ip?: string;
  /** Destination port for network events. */
  port?: number;
  /** Backend/debug details: original syscall, argv, return values, etc. */
  metadata?: Record<string, unknown>;
}
