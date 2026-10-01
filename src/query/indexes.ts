/**
 * Reusable trace indexes for the query engine.
 *
 * Indexes point at event *positions* (indices into the events array), never
 * at duplicate event objects. Construction is O(n); each position list is
 * appended to in a single pass, plus one O(n log n) sort for time order.
 */
import type { GhostGlassEvent } from "../events/types.js";
import { basename } from "./matcher.js";
import type { QueryContext, TraceQuery } from "./types.js";

export interface TraceIndexes {
  /** Number of events indexed. */
  size: number;
  byPid: Map<number, number[]>;
  byAction: Map<string, number[]>;
  byType: Map<string, number[]>;
  /** Keyed by executable basename (exact, case-sensitive). */
  byProcess: Map<string, number[]>;
  /** Keyed by exact event path. */
  byPath: Map<string, number[]>;
  /** Positions of network events. */
  network: number[];
  /** Keyed by "ip:port". */
  byIpPort: Map<string, number[]>;
  /** Positions sorted by (timestamp, sequence). */
  timeOrder: number[];
  /** Positions sorted by sequence (emission order). */
  seqOrder: number[];
}

function push<K>(map: Map<K, number[]>, key: K, pos: number): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(pos);
}

function seqOf(e: GhostGlassEvent, pos: number): number {
  return e.sequence ?? pos + 1;
}

export function buildIndexes(
  events: readonly GhostGlassEvent[],
  ctx: QueryContext,
): TraceIndexes {
  const byPid = new Map<number, number[]>();
  const byAction = new Map<string, number[]>();
  const byType = new Map<string, number[]>();
  const byProcess = new Map<string, number[]>();
  const byPath = new Map<string, number[]>();
  const network: number[] = [];
  const byIpPort = new Map<string, number[]>();

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as GhostGlassEvent;
    push(byPid, e.pid, i);
    push(byAction, e.action, i);
    push(byType, e.type, i);
    const exe = e.executable ?? ctx.executableForPid(e.pid, e.sequence ?? i + 1);
    if (exe) push(byProcess, basename(exe), i);
    if (e.path) push(byPath, e.path, i);
    if (e.type === "network") {
      network.push(i);
      if (e.ip !== undefined && e.port !== undefined) {
        push(byIpPort, `${e.ip}:${e.port}`, i);
      }
    }
  }

  const all = events.map((_, i) => i);
  const timeOrder = [...all].sort((a, b) => {
    const ea = events[a] as GhostGlassEvent;
    const eb = events[b] as GhostGlassEvent;
    return ea.timestamp - eb.timestamp || seqOf(ea, a) - seqOf(eb, b);
  });
  const seqOrder = [...all].sort((a, b) => {
    const ea = events[a] as GhostGlassEvent;
    const eb = events[b] as GhostGlassEvent;
    return seqOf(ea, a) - seqOf(eb, b);
  });

  return {
    size: events.length,
    byPid,
    byAction,
    byType,
    byProcess,
    byPath,
    network,
    byIpPort,
    timeOrder,
    seqOrder,
  };
}

/**
 * Query planner: pick the smallest indexed candidate set that must contain
 * every match, or null when no index narrows the query (full scan).
 *
 * Selectivity sources, in preference order:
 * - exact pid
 * - exact ip:port
 * - single action
 * - single type
 * - network flag (true)
 * - exact process basename (only when the query is a bare basename)
 *
 * Union for OR fields (actions/types): merge the per-value position lists.
 */
export function planCandidates(
  query: TraceQuery,
  indexes: TraceIndexes,
): number[] | null {
  const candidates: number[][] = [];

  if (query.pid !== undefined) {
    const arr = indexes.byPid.get(query.pid);
    candidates.push(arr ?? []);
  }
  if (query.ip !== undefined && query.port !== undefined) {
    const arr = indexes.byIpPort.get(`${query.ip}:${query.port}`);
    candidates.push(arr ?? []);
  }
  if (query.actions && query.actions.length > 0) {
    const merged: number[] = [];
    for (const a of query.actions) {
      const arr = indexes.byAction.get(a);
      if (arr) for (const pos of arr) merged.push(pos);
    }
    candidates.push(merged);
  }
  if (query.types && query.types.length > 0) {
    const merged: number[] = [];
    for (const t of query.types) {
      const arr = indexes.byType.get(t);
      if (arr) for (const pos of arr) merged.push(pos);
    }
    candidates.push(merged);
  }
  if (query.network === true) {
    candidates.push(indexes.network);
  }
  if (query.process !== undefined && !query.process.includes("/")) {
    // Bare basename: the byProcess index narrows candidates. Full paths
    // and suffixes fall through to the predicate (still correct).
    const arr = indexes.byProcess.get(query.process);
    candidates.push(arr ?? []);
  }

  if (candidates.length === 0) return null;
  // Smallest candidate set wins. Duplicates from OR-unions are harmless:
  // the predicate is idempotent per event and dedupe happens on positions.
  let best = candidates[0] as number[];
  for (const c of candidates) {
    if (c.length < best.length) best = c;
  }
  return best;
}
