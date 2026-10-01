/**
 * Event linking: resolve the entities an event touches.
 *
 * Pure helpers over the cause index — no scanning, no guessing.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { CauseIndex } from "./causeIndex.js";
import { networkKey } from "./causeIndex.js";
import type { CauseEdgeKind } from "./types.js";

/** Map a file event action to its cause-edge kind. */
export function fileEdgeKind(action: GhostGlassEvent["action"]): CauseEdgeKind | null {
  switch (action) {
    case "read":
      return "read";
    case "write":
      return "wrote";
    case "create":
      return "created";
    case "delete":
      return "deleted";
    case "rename":
      return "renamed";
    default:
      return null;
  }
}

/** All events touching a file path, in timestamp order. */
export function eventsForFile(index: CauseIndex, path: string): GhostGlassEvent[] {
  return index.eventsByFile.get(path) ?? [];
}

/**
 * Resolve a file query to concrete paths.
 * - Exact path match wins.
 * - Otherwise, unique suffix match (path ends with the query).
 * - Multiple matches: return all for the caller to disambiguate.
 */
export function resolveFileQuery(
  index: CauseIndex,
  query: string,
): { kind: "none" } | { kind: "exact"; path: string } | { kind: "ambiguous"; matches: string[] } {
  if (index.eventsByFile.has(query)) return { kind: "exact", path: query };
  const matches = [...index.eventsByFile.keys()].filter(
    (p) => p.endsWith(query) && p !== query,
  );
  if (matches.length === 1) return { kind: "exact", path: matches[0] as string };
  if (matches.length > 1) {
    matches.sort();
    return { kind: "ambiguous", matches };
  }
  return { kind: "none" };
}

/** All connect events for a network destination key ("ip:port" / "host:port"). */
export function eventsForNetwork(index: CauseIndex, destination: string): GhostGlassEvent[] {
  const direct = index.eventsByNetwork.get(destination);
  if (direct) return direct;
  // Tolerate queries without the port: match any "host:*" key.
  const matches: GhostGlassEvent[] = [];
  for (const [key, events] of index.eventsByNetwork) {
    if (key === destination || key.startsWith(destination + ":")) {
      matches.push(...events);
    }
  }
  matches.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  return matches;
}

/** All known network destinations (for "not found" guidance). */
export function knownNetworkDestinations(index: CauseIndex): string[] {
  return [...index.eventsByNetwork.keys()].sort();
}

/** Distinct PIDs that touched a file, with per-PID event counts. */
export function actorsForFile(
  index: CauseIndex,
  path: string,
): { pid: number; eventCount: number; writes: number; reads: number }[] {
  const events = eventsForFile(index, path);
  const byPid = new Map<number, { eventCount: number; writes: number; reads: number }>();
  for (const e of events) {
    let acc = byPid.get(e.pid);
    if (!acc) {
      acc = { eventCount: 0, writes: 0, reads: 0 };
      byPid.set(e.pid, acc);
    }
    acc.eventCount++;
    if (e.action === "write" || e.action === "create") acc.writes++;
    if (e.action === "read") acc.reads++;
  }
  return [...byPid.entries()]
    .map(([pid, counts]) => ({ pid, ...counts }))
    .sort((a, b) => b.eventCount - a.eventCount || a.pid - b.pid);
}

/** The connect events behind a network destination, for evidence. */
export function describeNetworkEvent(e: GhostGlassEvent): string {
  const dest = networkKey(e) ?? "?";
  return `connect ${dest}`;
}
