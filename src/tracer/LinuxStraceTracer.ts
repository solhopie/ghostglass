import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  BackendAvailability,
  TraceResult,
  TraceRunOptions,
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

  async run(command: string[], options: TraceRunOptions): Promise<TraceResult> {
    const startTimeMs = Date.now();
    const args = [
      "-f", // follow forks: trace the whole process tree
      "-tt", // absolute timestamps (microsecond resolution)
      "-T", // time spent inside each syscall
      "-y", // annotate file descriptors with their paths
      "-s",
      "1024", // cap captured string length (paths, buffers)
      "-e",
      `trace=${TRACE_SYSCALLS}`,
      "-o",
      options.rawTracePath,
      "--",
      ...command,
    ];

    // Detached so strace + the traced tree form their own process group.
    // Terminal Ctrl+C then reaches GhostGlass only, and we forward the
    // signal to the traced group ourselves.
    const child: ChildProcess = spawn("strace", args, {
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
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    let exitCode: number | null = null;
    let signal: string | null = null;
    try {
      const outcome = await new Promise<{
        code: number | null;
        sig: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, sig) =>
          resolve({ code, sig: sig ?? null }),
        );
      });
      exitCode = outcome.code;
      // strace is killed by the same signal it forwards to its child group,
      // so a forwarded SIGINT/SIGTERM surfaces here as the close signal.
      signal = outcome.sig ?? forwardedSignal;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      // Last-resort cleanup: never leave a traced process tree behind.
      try {
        if (child.pid !== undefined && child.exitCode === null) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Already exited.
      }
    }

    const endTimeMs = Date.now();
    return {
      startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - startTimeMs,
      exitCode,
      signal,
      forwardedSignal,
      rawTracePath: options.rawTracePath,
    };
  }
}
