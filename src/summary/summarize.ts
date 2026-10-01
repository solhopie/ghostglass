import type { GhostGlassEvent } from "../events/types.js";

/** Contents of <run-dir>/summary.json */
export interface FilesystemStats {
  total: number;
  read: number;
  write: number;
  create: number;
  delete: number;
  rename: number;
  mkdir: number;
}

export interface NetworkStats {
  /** Outbound connection attempts (successful or not). */
  attempts: number;
  /** Unique "ip:port" destinations, sorted. */
  destinations: string[];
}

export interface RunSummary {
  runId: string;
  command: string[];
  commandLine: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  /** Distinct PIDs observed across all events. */
  processCount: number;
  /** exec events (program images launched). */
  execCount: number;
  eventCount: number;
  filesystem: FilesystemStats;
  network: NetworkStats;
  /** Parser health (optional; present for runs traced with Run 8+). */
  parseStats?: {
    totalLines: number;
    events: number;
    skipped: number;
    malformed: number;
    reconstruction?: {
      reconstructed: number;
      unresolved: number;
      orphanResumed: number;
      mismatched: number;
    };
  };
}

const EMPTY_FS: FilesystemStats = {
  total: 0,
  read: 0,
  write: 0,
  create: 0,
  delete: 0,
  rename: 0,
  mkdir: 0,
};

/**
 * Aggregate normalized events into summary statistics.
 * Pure function: the same events always produce the same summary.
 */
export function buildSummary(
  runId: string,
  command: string[],
  commandLine: string,
  events: GhostGlassEvent[],
  durationMs: number,
  exitCode: number | null,
  signal: string | null,
): RunSummary {
  const pids = new Set<number>();
  const filesystem: FilesystemStats = { ...EMPTY_FS };
  const destinations = new Set<string>();
  let execCount = 0;
  let networkAttempts = 0;

  for (const event of events) {
    pids.add(event.pid);
    if (event.type === "process" && event.action === "exec") execCount++;
    if (event.type === "file") {
      filesystem.total++;
      switch (event.action) {
        case "read":
          filesystem.read++;
          break;
        case "write":
          filesystem.write++;
          break;
        case "create":
          filesystem.create++;
          break;
        case "delete":
          filesystem.delete++;
          break;
        case "rename":
          filesystem.rename++;
          break;
        case "mkdir":
          filesystem.mkdir++;
          break;
      }
    }
    if (event.type === "network" && event.action === "connect") {
      networkAttempts++;
      if (event.ip !== undefined && event.port !== undefined) {
        destinations.add(`${event.ip}:${event.port}`);
      }
    }
  }

  return {
    runId,
    command,
    commandLine,
    durationMs,
    exitCode,
    signal,
    processCount: pids.size,
    execCount,
    eventCount: events.length,
    filesystem,
    network: {
      attempts: networkAttempts,
      destinations: [...destinations].sort(),
    },
  };
}
