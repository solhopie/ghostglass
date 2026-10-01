/**
 * Query execution: plan → match → order → limit.
 *
 * The engine never depends on CLI syntax. Frontends build a TraceQuery
 * (from flags, from compact `key:value` syntax, or programmatically) and
 * call executeQuery.
 *
 * Ordering: default "time" sorts by (timestamp, sequence) — timestamp is
 * when the underlying syscall/event began, sequence breaks ties in
 * ingestion order. "sequence" sorts by ingestion order only. This
 * distinction matters because reconstructed syscalls carry their
 * syscall-start timestamp but are emitted later.
 */
import type { GhostGlassEvent } from "../events/types.js";
import { buildIndexes, planCandidates, type TraceIndexes } from "./indexes.js";
import { buildQueryContext, compileQuery } from "./matcher.js";
import { validateQuery } from "./parser.js";
import type { QueryContext, QueryResult, TraceQuery } from "./types.js";

export interface ExecuteOptions {
  /** Prebuilt indexes; built on demand when omitted. */
  indexes?: TraceIndexes;
  /** Prebuilt query context; built on demand when omitted. */
  context?: QueryContext;
  /** Default display limit applied when query.limit is undefined. */
  defaultLimit?: number;
}

function seqOf(e: GhostGlassEvent, pos: number): number {
  return e.sequence ?? pos + 1;
}

/**
 * Assign stable in-memory sequence numbers to events that lack them
 * (runs recorded before Run 9). events.jsonl file order IS emission
 * order, so position-derived sequences are stable. Mutates in place;
 * never writes back to disk — old traces are not rewritten.
 */
/**
 * Fill in missing sequence numbers from array order. `offset` is the number
 * of events already assigned, so paged loads keep globally unique,
 * monotonic sequences. Never rewrites an existing sequence.
 */
export function assignSequences(events: GhostGlassEvent[], offset = 0): GhostGlassEvent[] {
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as GhostGlassEvent;
    if (e.sequence === undefined || e.sequence === null) {
      e.sequence = offset + i + 1;
    }
  }
  return events;
}

export function executeQuery(
  runId: string,
  events: readonly GhostGlassEvent[],
  query: TraceQuery,
  opts: ExecuteOptions = {},
): QueryResult {
  validateQuery(query);
  const context = opts.context ?? buildQueryContext(events);
  const indexes = opts.indexes ?? buildIndexes(events, context);
  const predicate = compileQuery(query, context);

  const candidates = planCandidates(query, indexes);
  const matched: number[] = [];
  if (candidates) {
    for (const pos of candidates) {
      if (predicate(events[pos] as GhostGlassEvent)) matched.push(pos);
    }
  } else {
    for (let i = 0; i < events.length; i++) {
      if (predicate(events[i] as GhostGlassEvent)) matched.push(i);
    }
  }

  const order = query.order ?? "time";
  if (order === "sequence") {
    matched.sort((a, b) => {
      const ea = events[a] as GhostGlassEvent;
      const eb = events[b] as GhostGlassEvent;
      return seqOf(ea, a) - seqOf(eb, b);
    });
  } else {
    matched.sort((a, b) => {
      const ea = events[a] as GhostGlassEvent;
      const eb = events[b] as GhostGlassEvent;
      return ea.timestamp - eb.timestamp || seqOf(ea, a) - seqOf(eb, b);
    });
  }

  const totalMatches = matched.length;
  const limit = query.limit ?? opts.defaultLimit ?? 0;
  const truncated = limit > 0 && matched.length > limit;
  const kept = limit > 0 ? matched.slice(0, limit) : matched;

  return {
    runId,
    query: { ...query },
    totalMatches,
    returned: kept.length,
    truncated,
    events: kept.map((pos) => events[pos] as GhostGlassEvent),
  };
}

/** Convenience: build context + indexes once, run many queries. */
export interface QuerySession {
  context: QueryContext;
  indexes: TraceIndexes;
}

export function openQuerySession(events: readonly GhostGlassEvent[]): QuerySession {
  const context = buildQueryContext(events);
  return { context, indexes: buildIndexes(events, context) };
}
