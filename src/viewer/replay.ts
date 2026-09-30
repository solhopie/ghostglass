/**
 * Pure helpers for the execution replay: timeline seeking, event filtering,
 * and human-readable event descriptions.
 *
 * These are intentionally dependency-free so the browser UI can carry an
 * identical copy (see web/src/format.ts). Behavior is pinned by tests here.
 */
import { basename } from "node:path";
import type { GhostGlassEvent, GhostGlassEventType } from "../events/types.js";

/**
 * Index of the last event with timestamp <= tMs, or -1 when none qualifies.
 * `timestamps` must be ascending (as produced by the trace).
 */
export function eventIndexAt(timestamps: readonly number[], tMs: number): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const ts = timestamps[mid] as number;
    if (ts <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export interface EventFilter {
  /** Null = all kinds. */
  kinds: Set<GhostGlassEventType> | null;
  /** Null = all actions. */
  actions: Set<string> | null;
  /** Case-insensitive substring match over the searchable text. */
  query: string;
}

export function eventSearchText(e: GhostGlassEvent, pidLabel: (pid: number) => string): string {
  return [
    e.type,
    e.action,
    String(e.pid),
    pidLabel(e.pid),
    e.executable ?? "",
    e.path ?? "",
    typeof e.metadata?.["newPath"] === "string" ? (e.metadata["newPath"] as string) : "",
    e.ip ?? "",
    e.port != null ? String(e.port) : "",
    e.id,
  ]
    .join(" ")
    .toLowerCase();
}

export function filterEvents(
  events: readonly GhostGlassEvent[],
  filter: EventFilter,
  pidLabel: (pid: number) => string = (pid) => `PID ${pid}`,
): GhostGlassEvent[] {
  const q = filter.query.trim().toLowerCase();
  return events.filter((e) => {
    if (filter.kinds && !filter.kinds.has(e.type)) return false;
    if (filter.actions && !filter.actions.has(e.action)) return false;
    if (q && !eventSearchText(e, pidLabel).includes(q)) return false;
    return true;
  });
}

/**
 * One-line human description, e.g. "npm → node", "READ package.json",
 * "NETWORK node → 198.19.0.1:3128".
 */
export function describeEvent(
  e: GhostGlassEvent,
  pidLabel: (pid: number) => string = (pid) => `PID ${pid}`,
): string {
  const label = pidLabel(e.pid);
  switch (e.action) {
    case "exec":
      return `${label} started`;
    case "spawn":
      return typeof e.parentPid === "number"
        ? `${pidLabel(e.parentPid)} → ${label}`
        : `${label} spawned a child`;
    case "exit": {
      const code = e.metadata?.["code"];
      return typeof code === "number" ? `${label} exited (code ${code})` : `${label} exited`;
    }
    case "read":
      return `READ ${shortPath(e.path)}`;
    case "write":
      return `WRITE ${shortPath(e.path)}`;
    case "create":
      return `CREATE ${shortPath(e.path)}`;
    case "delete":
      return `DELETE ${shortPath(e.path)}`;
    case "rename": {
      const np = e.metadata?.["newPath"];
      return typeof np === "string" ? `RENAME ${shortPath(e.path)} → ${shortPath(np)}` : `RENAME ${shortPath(e.path)}`;
    }
    case "mkdir":
      return `MKDIR ${shortPath(e.path)}`;
    case "connect":
      return `NETWORK ${label} → ${e.ip ?? "?"}:${e.port ?? "?"}`;
    default:
      return `${e.type}:${e.action}`;
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return "?";
  const base = basename(p);
  return base || p;
}

/** "00:00.004" style offset for the event stream and timeline readout. */
export function formatOffset(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const millis = Math.floor(clamped % 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/** Compact duration, e.g. "12.44s" / "1m 03.20s". */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(2).padStart(5, "0")}s`;
}
