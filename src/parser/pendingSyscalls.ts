/**
 * Per-PID pending state for strace <unfinished ...> / <... resumed> pairs.
 *
 * strace -f may split a single syscall across two output lines when the call
 * blocks: the start line ends with `<unfinished ...>` and the completion line
 * begins with `<... <syscall> resumed>`. Other PIDs' lines may interleave
 * between the two fragments, so pending state is keyed by PID, never global.
 *
 * This store only holds fragments. Pairing and canonical reconstruction live
 * in syscallReconstructor.ts.
 */

/** A syscall start fragment waiting for its resumed completion. */
export interface PendingSyscall {
  /** PID that issued the syscall. */
  pid: number;
  /** Syscall name, e.g. "clone". Must match the resumed fragment. */
  syscall: string;
  /** Raw "HH:MM:SS.ffffff" timestamp from the unfinished line (syscall start). */
  timeStr: string;
  /** The unfinished line's syscall text with the `<unfinished ...>` marker removed. */
  prefix: string;
  /** The raw unfinished line, kept for debug metadata. */
  rawStart: string;
}

/** Parser-health counters for split-syscall handling. Not behavior data. */
export interface ReconstructionDiagnostics {
  /** Fragments deterministically paired and reconstructed. */
  reconstructed: number;
  /** Unfinished fragments never paired (abandoned, replaced, or left at EOF). */
  unresolved: number;
  /** Resumed fragments with no matching unfinished start. */
  orphanResumed: number;
  /** Resumed fragments whose syscall name did not match the pending start. */
  mismatched: number;
}

/** Upper bound on pending entries; prevents unbounded growth on malformed input. */
export const MAX_PENDING_SYSCALLS = 10000;

/**
 * Per-PID store of unfinished syscall fragments.
 *
 * Rules:
 * - At most one pending fragment per PID (strace emits strictly nested
 *   unfinished/resumed pairs per traced thread; a second unfinished start
 *   for the same PID means the first can never resolve — it is marked
 *   abandoned and replaced, never merged).
 * - Resolved entries are removed immediately on pairing.
 * - Entries are dropped when their process exits (see noteExit) and when
 *   parsing completes (see drainUnresolved).
 */
export class PendingSyscallStore {
  private readonly pending = new Map<number, PendingSyscall>();
  private readonly diagnostics: ReconstructionDiagnostics = {
    reconstructed: 0,
    unresolved: 0,
    orphanResumed: 0,
    mismatched: 0,
  };

  /** Number of currently held pending fragments. */
  get size(): number {
    return this.pending.size;
  }

  /** Snapshot of parser-health counters. */
  getDiagnostics(): ReconstructionDiagnostics {
    return { ...this.diagnostics };
  }

  /**
   * Record an unfinished fragment. If the PID already has a pending fragment,
   * the old one is marked abandoned (counted as unresolved) and replaced —
   * strace never resumes the older one after a newer start for the same PID.
   */
  add(entry: PendingSyscall): void {
    const existing = this.pending.get(entry.pid);
    if (existing !== undefined) {
      this.diagnostics.unresolved++;
    }
    this.pending.set(entry.pid, entry);
    // Bound memory on hostile/malformed input: evict the oldest entries.
    if (this.pending.size > MAX_PENDING_SYSCALLS) {
      const overflow = this.pending.size - MAX_PENDING_SYSCALLS;
      let dropped = 0;
      for (const pid of this.pending.keys()) {
        if (dropped >= overflow) break;
        // Never evict the entry just added.
        if (pid === entry.pid) continue;
        this.pending.delete(pid);
        this.diagnostics.unresolved++;
        dropped++;
      }
    }
  }

  /** Look up the pending fragment for a PID without removing it. */
  peek(pid: number): PendingSyscall | undefined {
    return this.pending.get(pid);
  }

  /**
   * Remove and return the pending fragment for a PID. Counts a successful
   * deterministic pairing.
   */
  take(pid: number): PendingSyscall | undefined {
    const entry = this.pending.get(pid);
    if (entry === undefined) return undefined;
    this.pending.delete(pid);
    this.diagnostics.reconstructed++;
    return entry;
  }

  /** Record a resumed fragment that matched no pending start. */
  recordOrphanResumed(): void {
    this.diagnostics.orphanResumed++;
  }

  /** Record a resumed fragment whose syscall name mismatched the pending start. */
  recordMismatched(): void {
    this.diagnostics.mismatched++;
  }

  /**
   * Drop pending state for a PID whose process has exited. Guards against
   * pairing fragments across PID reuse in long traces.
   */
  noteExit(pid: number): void {
    const entry = this.pending.get(pid);
    if (entry !== undefined) {
      this.pending.delete(pid);
      this.diagnostics.unresolved++;
    }
  }

  /**
   * End of trace: count every still-pending fragment as unresolved and clear
   * the store. Unresolved fragments never become events.
   */
  drainUnresolved(): void {
    this.diagnostics.unresolved += this.pending.size;
    this.pending.clear();
  }
}
