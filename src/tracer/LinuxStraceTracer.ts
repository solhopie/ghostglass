import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { GhostGlassEvent } from "../events/types.js";
import { StraceStreamParser } from "../parser/streamParser.js";
import type {
  BackendAvailability,
  TraceResult,
  TraceRunOptions,
  TraceStream,
  TracerBackend,
} from "./TracerBackend.js";

/**
 * Syscalls traced by the strace backend. Kept explicit (rather than using
 * strace's %classes) so the observed surface is deterministic and reviewable.
 *
 * - process: exec/spawn/exit observation
 * - file: open/read/write/create/delete/rename/mkdir observation
 * - network: outbound connection attempts
 */
const TRACE_SYSCALLS = [
  // process lifecycle
  "clone",
  "clone3",
  "fork",
  "vfork",
  "execve",
  "execveat",
  "exit",
  "exit_group",
  // filesystem activity
  "open",
  "openat",
  "openat2",
  "creat",
  "read",
  "write",
  "unlink",
  "unlinkat",
  "rename",
  "renameat",
  "renameat2",
  "mkdir",
  "mkdirat",
  // network
  "connect",
].join(",");

const INSTALL_HINT = [
  "strace was not found on this system.",
  "",
  "GhostGlass Run 1 uses strace as its Linux tracing backend. Install it with:",
  "  Debian/Ubuntu:  sudo apt install strace",
  "  Fedora/RHEL:     sudo dnf install strace",
  "  Arch:           sudo pacman -S strace",
  "  Alpine:         sudo apk add strace",
].join("\n");

/**
 * Backpressure bounds for the live event queue. The consumer (persistence +
 * broadcast) normally drains far faster than the tracer produces, so these
 * only engage on pathological bursts; pausing the trace-file tail never
 * loses data — strace keeps appending and we resume from our read offset.
 */
const QUEUE_PAUSE_AT = 50_000;
const QUEUE_RESUME_AT = 10_000;

/** How often the live tailer polls the raw trace file for new bytes. */
const TAIL_POLL_MS = 30;

/** Async FIFO queue feeding the TraceStream iterator, with pause/resume. */
class EventQueue {
  private items: GhostGlassEvent[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  onHighWater: (() => void) | null = null;
  onDrained: (() => void) | null = null;

  pushBatch(events: GhostGlassEvent[]): void {
    if (events.length === 0 || this.closed) return;
    this.items.push(...events);
    if (this.items.length >= QUEUE_PAUSE_AT && this.onHighWater) {
      this.onHighWater();
    }
    if (this.notify) {
      const n = this.notify;
      this.notify = null;
      n();
    }
  }

  close(): void {
    this.closed = true;
    if (this.notify) {
      const n = this.notify;
      this.notify = null;
      n();
    }
  }

  get size(): number {
    return this.items.length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<GhostGlassEvent, void, void> {
    while (true) {
      while (this.items.length > 0) {
        const batch = this.items.splice(0, Math.min(this.items.length, 1000));
        if (this.items.length <= QUEUE_RESUME_AT && this.onDrained) {
          this.onDrained();
        }
        for (const e of batch) yield e;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}

interface SpawnedTrace {
  child: ChildProcess;
  /** Installs SIGINT/SIGTERM forwarding; returns a cleanup function. */
  forwardSignals: () => { forwarded: () => NodeJS.Signals | null; cleanup: () => void };
  /** Resolves when the child fully exits; rejects on spawn failure. */
  waitClosed: () => Promise<{ code: number | null; sig: NodeJS.Signals | null }>;
  /** Kills the whole process group if still alive (last-resort cleanup). */
  killGroup: () => void;
}

/**
 * Linux tracing backend built on strace.
 *
 * Runs `strace -f` as the parent of the target command so the whole process
 * tree is observed. The traced command's stdio is inherited untouched, so it
 * behaves exactly as if GhostGlass were not there.
 */
export class LinuxStraceTracer implements TracerBackend {
  readonly name = "strace";

  async checkAvailable(): Promise<BackendAvailability> {
    try {
      const result = spawnSync("strace", ["-V"], { encoding: "utf8" });
      if (result.error) {
        return { available: false, detail: INSTALL_HINT };
      }
      if (result.status !== 0) {
        return { available: false, detail: INSTALL_HINT };
      }
      const firstLine = String(result.stdout || result.stderr || "")
        .split("\n")[0]
        ?.trim();
      return {
        available: true,
        detail: firstLine || "strace is available",
      };
    } catch {
      return { available: false, detail: INSTALL_HINT };
    }
  }

  private buildArgs(command: string[], output: string): string[] {
    return [
      "-f", // follow forks: trace the whole process tree
      "-tt", // absolute timestamps (microsecond resolution)
      "-T", // time spent inside each syscall
      "-y", // annotate file descriptors with their paths
      "-s",
      "1024", // cap captured string length (paths, buffers)
      "-e",
      `trace=${TRACE_SYSCALLS}`,
      "-o",
      output,
      "--",
      ...command,
    ];
  }

  /**
   * Spawn strace around `command`. Detached so strace + the traced tree form
   * their own process group: terminal Ctrl+C reaches GhostGlass only, and we
   * forward the signal to the traced group ourselves.
   */
  private spawnTraced(
    command: string[],
    options: TraceRunOptions,
    output: string,
  ): SpawnedTrace {
    const child: ChildProcess = spawn("strace", this.buildArgs(command, output), {
      cwd: options.cwd,
      stdio: "inherit",
      detached: true,
    });

    let forwardedSignal: NodeJS.Signals | null = null;
    const forward = (signal: NodeJS.Signals): void => {
      forwardedSignal = signal;
      try {
        if (child.pid !== undefined) {
          // Negative PID targets the whole process group (strace + tracee).
          process.kill(-child.pid, signal);
        }
      } catch {
        // The group may already be gone; nothing to forward to.
      }
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");

    const forwardSignals = () => {
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return {
        forwarded: () => forwardedSignal,
        cleanup: () => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
        },
      };
    };

    const waitClosed = (): Promise<{ code: number | null; sig: NodeJS.Signals | null }> =>
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, sig) => resolve({ code, sig: sig ?? null }));
      });

    const killGroup = (): void => {
      try {
        if (child.pid !== undefined && child.exitCode === null) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Already exited.
      }
    };

    return { child, forwardSignals, waitClosed, killGroup };
  }

  async run(command: string[], options: TraceRunOptions): Promise<TraceResult> {
    const startTimeMs = Date.now();
    const spawned = this.spawnTraced(command, options, options.rawTracePath);
    const signals = spawned.forwardSignals();

    let exitCode: number | null = null;
    let signal: string | null = null;
    try {
      const outcome = await spawned.waitClosed();
      exitCode = outcome.code;
      // strace is killed by the same signal it forwards to its child group,
      // so a forwarded SIGINT/SIGTERM surfaces here as the close signal.
      signal = outcome.sig ?? signals.forwarded();
    } finally {
      signals.cleanup();
      // Last-resort cleanup: never leave a traced process tree behind.
      spawned.killGroup();
    }

    const endTimeMs = Date.now();
    return {
      startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - startTimeMs,
      exitCode,
      signal,
      forwardedSignal: signals.forwarded(),
      rawTracePath: options.rawTracePath,
    };
  }

  /**
   * Live variant of `run`: strace writes to a pipe (fd 3) instead of a file,
   * chunks are parsed incrementally with the shared stream parser, and
   * normalized events flow through the async iterator while the command
   * runs. The raw trace is still persisted to `options.rawTracePath`, and
   * `done()` resolves with the same TraceResult shape as `run()`.
   *
   * The traced command's stdio is inherited untouched, exactly like `run`.
   */
  streamLive(command: string[], options: TraceRunOptions): TraceStream {
    const startTimeMs = Date.now();
    const runId = options.runId ?? "gg_unknown";
    const queue = new EventQueue();
    const parser = new StraceStreamParser(runId, startTimeMs);
    // strace writes its raw trace to the run's trace.log; we tail that
    // file incrementally. (A pipe via `-o /dev/fd/N` does not work here:
    // Node's extra stdio pipes are sockets, which cannot be reopened
    // through /dev/fd — strace fails with ENXIO.)
    const spawned = this.spawnTraced(command, options, options.rawTracePath);
    const signals = spawned.forwardSignals();

    // Incremental tail of the raw trace file. strace appends; we poll for
    // new bytes and push them through the shared stream parser. Our read
    // offset is independent of strace's file position, so pausing the tail
    // under backpressure never loses data — we simply resume where we left
    // off. A StringDecoder keeps multibyte characters intact when a chunk
    // boundary splits them; the parser itself handles split lines.
    const decoder = new StringDecoder("utf8");
    let traceFd: number | null = null;
    let fileOffset = 0;
    let tailTimer: NodeJS.Timeout | null = null;
    let tailPaused = false;

    const openTraceFile = (): boolean => {
      if (traceFd !== null) return true;
      try {
        traceFd = openSync(options.rawTracePath, "r");
        return true;
      } catch {
        return false; // strace hasn't created the file yet
      }
    };

    const readNewBytes = (): void => {
      if (!openTraceFile() || traceFd === null) return;
      const buf = Buffer.alloc(256 * 1024);
      let bytesRead = 0;
      try {
        bytesRead = readSync(traceFd, buf, 0, buf.length, fileOffset);
      } catch {
        return;
      }
      if (bytesRead > 0) {
        fileOffset += bytesRead;
        const text = decoder.write(buf.subarray(0, bytesRead));
        queue.pushBatch(parser.push(text));
      }
    };

    const startTail = (): void => {
      if (tailTimer) return;
      readNewBytes();
      tailTimer = setInterval(() => {
        if (!tailPaused) readNewBytes();
      }, TAIL_POLL_MS);
      tailTimer.unref?.();
    };

    let finished = false;
    const finishTrace = (): void => {
      if (finished) return;
      finished = true;
      if (tailTimer) {
        clearInterval(tailTimer);
        tailTimer = null;
      }
      // Final drain: strace has exited, so no more bytes will arrive.
      // The traced command may inherit strace's output fd, but it never
      // writes trace data itself, so everything strace wrote is visible.
      readNewBytes();
      queue.pushBatch(parser.push(decoder.end()));
      queue.pushBatch(parser.flush());
      queue.close();
      if (traceFd !== null) {
        try {
          closeSync(traceFd);
        } catch {
          // ignore
        }
        traceFd = null;
      }
    };

    queue.onHighWater = () => {
      tailPaused = true;
    };
    queue.onDrained = () => {
      tailPaused = false;
    };
    startTail();

    let donePromise: Promise<TraceResult> | null = null;
    const done = (): Promise<TraceResult> => {
      if (donePromise) return donePromise;
      donePromise = (async (): Promise<TraceResult> => {
        let spawnError: unknown = null;
        const outcome = await spawned.waitClosed().catch((err: unknown) => {
          spawnError = err;
          return {
            code: null as number | null,
            sig: null as NodeJS.Signals | null,
          };
        });
        // strace has exited, so the trace file holds its final bytes.
        // We deliberately do NOT drain the queue here: the caller's async
        // iterator owns consumption, and stealing events would lose them.
        // done() resolves once no more events can arrive; the caller drains
        // the remainder.
        finishTrace();
        signals.cleanup();
        // Last-resort cleanup: never leave a traced process tree behind.
        spawned.killGroup();
        if (spawnError) throw spawnError;
        const endTimeMs = Date.now();
        const forwardedSignal = signals.forwarded();
        return {
          startTimeMs,
          endTimeMs,
          durationMs: endTimeMs - startTimeMs,
          exitCode: outcome.code,
          // strace is killed by the same signal it forwards to its child
          // group, so a forwarded SIGINT/SIGTERM surfaces here as the close
          // signal.
          signal: outcome.sig ?? forwardedSignal,
          forwardedSignal,
          rawTracePath: options.rawTracePath,
          parseStats: parser.getStats(),
        };
      })();
      return donePromise;
    };

    // Start the completion machinery immediately: even if the caller
    // abandons the iterator, the raw log is finalized and the process
    // group is cleaned up.
    void done().catch(() => {
      // Surfacing happens through the caller's own done() call.
    });

    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      done,
    };
  }
}
