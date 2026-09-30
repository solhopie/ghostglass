import { LinuxStraceTracer } from "./LinuxStraceTracer.js";
import type { TracerBackend } from "./TracerBackend.js";

/**
 * Select the tracing backend for this platform.
 *
 * Run 1 supports Linux via strace only. The TracerBackend interface keeps
 * the door open for an eBPF backend (or macOS support) without touching
 * the CLI, parser, storage, or summary layers.
 */
export function selectBackend(): TracerBackend {
  if (process.platform === "linux") {
    return new LinuxStraceTracer();
  }
  throw new Error(
    `GhostGlass Run 1 supports Linux only (current platform: ${process.platform}). ` +
      `macOS support is on the roadmap.`,
  );
}

export { LinuxStraceTracer } from "./LinuxStraceTracer.js";
export type {
  BackendAvailability,
  TraceResult,
  TraceRunOptions,
  TraceStream,
  TracerBackend,
} from "./TracerBackend.js";
