/**
 * Reconstruction of strace <unfinished ...> / <... resumed> syscall pairs.
 *
 * When a traced syscall blocks, strace -f emits the start line with a
 * trailing `<unfinished ...>` marker and, later, a completion line beginning
 * with `<... <syscall> resumed>`. Other PIDs' lines may interleave between
 * the fragments. Without reconstruction those syscalls vanish from the
 * trace — including clone/fork, which breaks process trees.
 *
 * Pipeline position (see StraceStreamParser):
 *
 *   byte chunks → line reconstruction → [this layer] → normal syscall parsing
 *
 * Rules (conservative by design):
 * - A resumed fragment pairs only when PID matches, the syscall name
 *   matches, and an unfinished start for that PID is pending. Anything else
 *   is dropped with a diagnostic — never guessed.
 * - The reconstructed line is canonically equivalent to an unsplit syscall:
 *   `PID HH:MM:SS.ffffff name(args) = ret`. It flows through the existing
 *   parser untouched, so reconstructed syscalls behave exactly like normal
 *   complete ones (including "failed spawn creates no child").
 * - Timestamp semantics: the syscall START timestamp is used. strace prints
 *   the start time on the unfinished line; the resumed line's time is the
 *   completion. We never invent midpoint timestamps.
 * - Unfinished fragments never emit events on their own.
 * - Unresolved fragments at end of trace are counted, not turned into events.
 */
import {
  PendingSyscallStore,
  type PendingSyscall,
  type ReconstructionDiagnostics,
} from "./pendingSyscalls.js";

/**
 * `4810 21:40:14.709147 clone(child_stack=NULL, flags=... <unfinished ...>`
 * Groups: pid, HH, MM, SS, us, syscall name, args-so-far.
 */
const UNFINISHED_RE =
  /^(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{6})\s+([A-Za-z_][A-Za-z0-9_]*)\((.*)<unfinished \.\.\.>\s*$/;

/**
 * `4810 21:40:14.709147 <... clone resumed>, child_tidptr=0x...) = 4812`
 * Groups: pid, HH, MM, SS, us, syscall name, remainder after the marker.
 */
const RESUMED_RE =
  /^(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{6})\s+<\.\.\. ([A-Za-z_][A-Za-z0-9_]*) resumed>(.*)$/;

/** `4810 21:40:14.709147 +++ exited with 0 +++` / `... +++ killed by SIGTERM +++`. */
const EXIT_MARKER_RE = /^(\d+)\s+\d{2}:\d{2}:\d{2}\.\d{6}\s+\+\+\+ (exited with|killed by) /;

export type FragmentOutcome =
  /** Not a fragment line; parse normally. */
  | { kind: "passthrough" }
  /** Unfinished start stored; no event yet. */
  | { kind: "held" }
  /** Resumed completion paired; parse the reconstructed line instead. */
  | { kind: "reconstructed"; line: string; unfinishedRaw: string; resumedRaw: string }
  /** Fragment dropped (orphan/mismatched/malformed); parse nothing. */
  | { kind: "dropped" };

export class SyscallReconstructor {
  private readonly store = new PendingSyscallStore();

  /**
   * Process one complete trace line. Returns how the caller should handle it.
   * For "reconstructed", the caller parses `line` with the normal parser and
   * should tag the resulting event with reconstructed metadata.
   */
  processLine(rawLine: string): FragmentOutcome {
    const line = rawLine.trimEnd();

    // Process exit markers: the PID is gone, so its pending fragment (if any)
    // can never resolve. Clearing guards against cross-lifetime pairing on
    // PID reuse.
    const exitMarker = line.match(EXIT_MARKER_RE);
    if (exitMarker) {
      this.store.noteExit(parseInt(exitMarker[1] as string, 10));
      return { kind: "passthrough" };
    }

    const unfinished = line.match(UNFINISHED_RE);
    if (unfinished) {
      const [, pidStr, hh, mm, ss, us, syscall, argsSoFar] = unfinished as [
        string, string, string, string, string, string, string, string,
      ];
      const pid = parseInt(pidStr, 10);
      const entry: PendingSyscall = {
        pid,
        syscall,
        timeStr: `${hh}:${mm}:${ss}.${us}`,
        // Reconstructable prefix: `name(args-so-far`, without the marker.
        prefix: `${syscall}(${argsSoFar}`,
        rawStart: line,
      };
      this.store.add(entry);
      return { kind: "held" };
    }

    const resumed = line.match(RESUMED_RE);
    if (resumed) {
      const [, pidStr, , , , , syscall, remainder] = resumed as [
        string, string, string, string, string, string, string, string,
      ];
      const pid = parseInt(pidStr, 10);
      const pending = this.store.peek(pid);
      if (pending === undefined) {
        // Resume without start: do not invent the missing half.
        this.store.recordOrphanResumed();
        return { kind: "dropped" };
      }
      if (pending.syscall !== syscall) {
        // Mismatched syscall: never merge different syscalls. Keep the
        // pending start — its real completion may still arrive.
        this.store.recordMismatched();
        return { kind: "dropped" };
      }
      this.store.take(pid);
      // Canonical form: prefix + remainder, e.g.
      //   `clone(child_stack=NULL, flags=...)` + `, child_tidptr=0x...) = 4812`
      // becomes `clone(child_stack=NULL, flags=..., child_tidptr=0x...) = 4812`.
      // Start timestamp is used (see module docstring).
      const canonical = `${pid} ${pending.timeStr} ${pending.prefix}${remainder.trimStart()}`;
      return {
        kind: "reconstructed",
        line: canonical,
        unfinishedRaw: pending.rawStart,
        resumedRaw: line,
      };
    }

    return { kind: "passthrough" };
  }

  /**
   * End of trace: count still-pending fragments as unresolved and clear all
   * state, so no parser state leaks between runs.
   */
  finish(): void {
    this.store.drainUnresolved();
  }

  /** Current number of held pending fragments (for tests/monitoring). */
  get pendingCount(): number {
    return this.store.size;
  }

  getDiagnostics(): ReconstructionDiagnostics {
    return this.store.getDiagnostics();
  }
}
