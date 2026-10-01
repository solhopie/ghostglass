/**
 * Per-run cause indexes.
 *
 * Built ONCE per run (saved, live, or export) and reused for every "Why?"
 * lookup, so cause-chain generation stays interactive on 50k+ event traces.
 * Never rescans the full event list per query.
 */
import type { GhostGlassEvent } from "../events/types.js";

/** What we know about one process, derived from spawn/exec events. */
export interface ProcessInfo {
  pid: number;
  /** PID that created this process (from spawn events). */
  parentPid?: number | undefined;
  /** Executable path (from exec/spawn events). */
  executable?: string | undefined;
  /** First timestamp this PID was observed. */
  firstSeen: number;
  /** Event id of the spawn/exec that introduced this PID, if any. */
  originEventId?: string | undefined;
}

export interface CauseIndex {
  runId: string;
  runStartMs: number;
  /** event id -> event */
  eventById: Map<string, GhostGlassEvent>;
  /** pid -> process info */
  processByPid: Map<number, ProcessInfo>;
  /** pid -> parent pid (only when a spawn event recorded it) */
  parentByPid: Map<number, number>;
  /** pid -> events performed by that pid (in timestamp order) */
  eventsByPid: Map<number, GhostGlassEvent[]>;
  /** normalized file path -> file events touching it (timestamp order) */
  eventsByFile: Map<string, GhostGlassEvent[]>;
  /** "ip:port" or "host:port" -> connect events (timestamp order) */
  eventsByNetwork: Map<string, GhostGlassEvent[]>;
  /** All events in timestamp order (for fallback scans). */
  ordered: GhostGlassEvent[];
  /** PIDs with no recorded parent — candidates for the traced root. */
  rootCandidates: number[];
}

export function networkKey(e: GhostGlassEvent): string | null {
  const host = e.host ?? e.ip;
  if (!host) return null;
  return `${host}:${e.port ?? "?"}`;
}

/**
 * Build all cause indexes from a complete event list. O(n).
 * Events are normalized into timestamp order (stable for ties).
 */
export function buildCauseIndex(
  events: readonly GhostGlassEvent[],
  runId: string,
  runStartMs: number,
): CauseIndex {
  const maps: IndexMaps = {
    eventById: new Map(),
    processByPid: new Map(),
    parentByPid: new Map(),
    eventsByPid: new Map(),
    eventsByFile: new Map(),
    eventsByNetwork: new Map(),
    ordered: [],
  };
  // Ingest in timestamp order (stable for ties) so per-PID/file lists
  // stay ordered even for live sessions that append incrementally.
  const sorted = [...events].sort(
    (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const e of sorted) ingestEvent(maps, e);

  const index: CauseIndex = {
    runId,
    runStartMs,
    eventById: maps.eventById,
    processByPid: maps.processByPid,
    parentByPid: maps.parentByPid,
    eventsByPid: maps.eventsByPid,
    eventsByFile: maps.eventsByFile,
    eventsByNetwork: maps.eventsByNetwork,
    ordered: maps.ordered,
    rootCandidates: [],
  };
  refreshRootCandidates(index);
  return index;
}

/**
 * Incrementally extend an existing index with new events (Live Glass).
 * O(k) for k new events — never rescans the whole trace.
 */
export function extendCauseIndex(index: CauseIndex, events: readonly GhostGlassEvent[]): void {
  const maps: IndexMaps = {
    eventById: index.eventById,
    processByPid: index.processByPid,
    parentByPid: index.parentByPid,
    eventsByPid: index.eventsByPid,
    eventsByFile: index.eventsByFile,
    eventsByNetwork: index.eventsByNetwork,
    ordered: index.ordered,
  };
  for (const e of events) ingestEvent(maps, e);
  refreshRootCandidates(index);
}

interface IndexMaps {
  eventById: Map<string, GhostGlassEvent>;
  processByPid: Map<number, ProcessInfo>;
  parentByPid: Map<number, number>;
  eventsByPid: Map<number, GhostGlassEvent[]>;
  eventsByFile: Map<string, GhostGlassEvent[]>;
  eventsByNetwork: Map<string, GhostGlassEvent[]>;
  ordered: GhostGlassEvent[];
}

function touchProcess(maps: IndexMaps, pid: number, ts: number): ProcessInfo {
  let info = maps.processByPid.get(pid);
  if (!info) {
    info = { pid, firstSeen: ts };
    maps.processByPid.set(pid, info);
  } else if (ts < info.firstSeen) {
    info.firstSeen = ts;
  }
  return info;
}

/** Ingest one event into the indexes. Idempotent; shared by batch + live. */
function ingestEvent(maps: IndexMaps, e: GhostGlassEvent): void {
  if (maps.eventById.has(e.id)) return; // never double-count
  maps.eventById.set(e.id, e);
  maps.ordered.push(e);

  const info = touchProcess(maps, e.pid, e.timestamp);
  const byPid = maps.eventsByPid.get(e.pid);
  if (byPid) byPid.push(e);
  else maps.eventsByPid.set(e.pid, [e]);

  if (e.action === "spawn" && e.parentPid !== undefined) {
    // Spawn semantics (see straceParser): e.pid is the CHILD's pid
    // (clone's return value); e.parentPid is the spawner.
    maps.parentByPid.set(e.pid, e.parentPid);
    info.parentPid = e.parentPid;
    if (!info.originEventId) info.originEventId = e.id;
    touchProcess(maps, e.parentPid, e.timestamp);
  }
  if (e.action === "exec" && e.executable) {
    info.executable = e.executable;
    if (!info.originEventId) info.originEventId = e.id;
  }

  if (e.type === "file" && e.path) {
    const list = maps.eventsByFile.get(e.path);
    if (list) list.push(e);
    else maps.eventsByFile.set(e.path, [e]);
  }
  if (e.type === "network" && e.action === "connect") {
    const key = networkKey(e);
    if (key) {
      const list = maps.eventsByNetwork.get(key);
      if (list) list.push(e);
      else maps.eventsByNetwork.set(key, [e]);
    }
  }
}

function refreshRootCandidates(index: CauseIndex): void {
  const childPids = new Set(index.parentByPid.keys());
  index.rootCandidates = [...index.processByPid.keys()]
    .filter((pid) => !childPids.has(pid))
    .sort(
      (a, b) =>
        (index.processByPid.get(a)?.firstSeen ?? 0) - (index.processByPid.get(b)?.firstSeen ?? 0),
    );
}

/** The traced root: earliest PID with no recorded parent. */
export function rootPidOf(index: CauseIndex): number | undefined {
  return index.rootCandidates[0];
}
