/**
 * Central state for the diff viewer: the computed RunDiff, per-run
 * timelines, graph visibility modes, stream filters, search, and selection.
 * Views subscribe to topics and render; the store never touches the DOM.
 */
import type {
  ApiTimeline,
  DiffEntity,
  DiffGraphNode,
  DiffSide,
  DiffStatus,
  DiffStreamItem,
  GhostGlassEvent,
  RunDiff,
} from "./types.js";
import { buildQueryContext, compileQuery, type EventPredicate } from "./query/matcher.js";
import { parseQuery } from "./query/parser.js";
import { QueryError } from "./query/types.js";

export type GraphMode = "all" | "differences" | "only-a" | "only-b" | "shared";
export type StreamFilter =
  | "all"
  | "only-a"
  | "only-b"
  | "changed"
  | "process"
  | "file"
  | "network";
export type TimelineMode = "real" | "normalized";
export type DiffTopic = "data" | "filters" | "selection";

export class DiffStore {
  readonly runA: string;
  readonly runB: string;
  diff: RunDiff | null = null;
  timelineA: ApiTimeline | null = null;
  timelineB: ApiTimeline | null = null;

  graphMode: GraphMode = "differences";
  showProcesses = true;
  showFiles = true;
  showNetwork = true;

  streamFilter: StreamFilter = "all";
  search = "";

  /**
   * Per-side trace queries (Run 9): the same `key:value` syntax as the
   * run viewer, applied independently to each side's event items with
   * identical semantics. `changed` rows are unaffected.
   */
  sideQueryA = "";
  sideQueryB = "";
  sideQueryErrorA: string | null = null;
  sideQueryErrorB: string | null = null;
  private sidePredA: EventPredicate | null = null;
  private sidePredB: EventPredicate | null = null;

  selection: string | null = null;
  timelineMode: TimelineMode = "real";

  readonly nodeById = new Map<string, DiffGraphNode>();
  private readonly entityByFp = new Map<string, DiffEntity>();
  private readonly nodeIdByEntity = new Map<string, string>();
  private readonly listeners = new Map<DiffTopic, Set<() => void>>();

  constructor(runA: string, runB: string) {
    this.runA = runA;
    this.runB = runB;
  }

  on(topic: DiffTopic, fn: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit(topic: DiffTopic): void {
    for (const fn of this.listeners.get(topic) ?? []) fn();
  }

  setDiff(diff: RunDiff): void {
    this.diff = diff;
    this.nodeById.clear();
    this.entityByFp.clear();
    this.nodeIdByEntity.clear();
    for (const e of diff.processes) this.entityByFp.set(`process${e.fingerprint}`, e);
    for (const e of diff.files) this.entityByFp.set(`file${e.fingerprint}`, e);
    for (const e of diff.network) this.entityByFp.set(`network${e.fingerprint}`, e);
    for (const n of diff.graph.nodes) {
      this.nodeById.set(n.id, n);
      this.nodeIdByEntity.set(`${n.kind}${n.fingerprint}`, n.id);
    }
    this.emit("data");
  }

  entityFor(kind: "process" | "file" | "network", fingerprint: string): DiffEntity | undefined {
    return this.entityByFp.get(`${kind}${fingerprint}`);
  }

  nodeIdForEntity(kind: "process" | "file" | "network", fingerprint: string): string | undefined {
    return this.nodeIdByEntity.get(`${kind}${fingerprint}`);
  }

  setTimelines(a: ApiTimeline, b: ApiTimeline): void {
    this.timelineA = a;
    this.timelineB = b;
    this.emit("data");
  }

  setGraphMode(mode: GraphMode): void {
    this.graphMode = mode;
    this.emit("filters");
  }

  setKindVisible(kind: "process" | "file" | "network", visible: boolean): void {
    if (kind === "process") this.showProcesses = visible;
    else if (kind === "file") this.showFiles = visible;
    else this.showNetwork = visible;
    this.emit("filters");
  }

  setStreamFilter(f: StreamFilter): void {
    this.streamFilter = f;
    this.emit("filters");
  }

  setSearch(q: string): void {
    this.search = q;
    this.emit("filters");
  }

  /**
   * Set the trace query for one diff side. The predicate runs against
   * that side's event items only; `changed` rows always pass.
   */
  setSideQuery(side: DiffSide, text: string): void {
    const trimmed = text.trim();
    let pred: EventPredicate | null = null;
    let error: string | null = null;
    if (trimmed.length > 0 && this.diff) {
      try {
        const { query, relativeTimes } = parseQuery(trimmed);
        // Relative bounds resolve against this side's own trace start, so
        // side A and side B keep identical query semantics.
        const startMs =
          side === "a" ? this.timelineA?.startTimeMs : this.timelineB?.startTimeMs;
        if (relativeTimes.since !== undefined) {
          if (startMs === undefined) {
            throw new QueryError(
              "no-trace-start",
              "Relative time needs this side's trace start, which is not loaded yet",
            );
          }
          query.since = startMs + relativeTimes.since;
        }
        if (relativeTimes.until !== undefined) {
          if (startMs === undefined) {
            throw new QueryError(
              "no-trace-start",
              "Relative time needs this side's trace start, which is not loaded yet",
            );
          }
          query.until = startMs + relativeTimes.until;
        }
        const sideEvents: GhostGlassEvent[] = [];
        for (const item of this.diff.stream) {
          if (item.itemKind === "event" && item.side === side) sideEvents.push(item.event);
        }
        pred = compileQuery(query, buildQueryContext(sideEvents));
      } catch (err) {
        error = err instanceof QueryError ? err.message : String(err);
      }
    }
    if (side === "a") {
      this.sideQueryA = text;
      this.sidePredA = pred;
      this.sideQueryErrorA = error;
    } else {
      this.sideQueryB = text;
      this.sidePredB = pred;
      this.sideQueryErrorB = error;
    }
    this.emit("filters");
  }

  setTimelineMode(mode: TimelineMode): void {
    this.timelineMode = mode;
    this.emit("filters");
  }

  select(nodeId: string | null): void {
    this.selection = nodeId;
    this.emit("selection");
  }

  /** Nodes passing the current graph mode + kind toggles. */
  visibleNodes(): DiffGraphNode[] {
    const diff = this.diff;
    if (!diff) return [];
    return diff.graph.nodes.filter((n) => {
      if (n.kind === "process" && !this.showProcesses) return false;
      if (n.kind === "file" && !this.showFiles) return false;
      if (n.kind === "network" && !this.showNetwork) return false;
      return modeMatches(this.graphMode, n.status);
    });
  }

  /** Stream items passing the current filter + search + per-side queries. */
  filteredStream(): DiffStreamItem[] {
    const diff = this.diff;
    if (!diff) return [];
    const q = this.search.trim().toLowerCase();
    return diff.stream.filter((item) => {
      if (!streamFilterMatches(this.streamFilter, item)) return false;
      if (q && !streamSearchText(item).includes(q)) return false;
      if (item.itemKind === "event") {
        const pred = item.side === "a" ? this.sidePredA : this.sidePredB;
        if (pred && !pred(item.event)) return false;
      }
      return true;
    });
  }
}

export function modeMatches(mode: GraphMode, status: DiffStatus): boolean {
  switch (mode) {
    case "all":
      return true;
    case "differences":
      return status !== "shared";
    case "only-a":
      return status === "only-a";
    case "only-b":
      return status === "only-b";
    case "shared":
      return status === "shared";
  }
}

function streamFilterMatches(f: StreamFilter, item: DiffStreamItem): boolean {
  switch (f) {
    case "all":
      return true;
    case "changed":
      return item.itemKind === "changed";
    case "only-a":
      return item.itemKind === "event" && item.side === "a";
    case "only-b":
      return item.itemKind === "event" && item.side === "b";
    case "process":
    case "file":
    case "network":
      return item.entityKind === f;
  }
}

/** Lowercased haystack for stream search. Inert text only — never HTML. */
export function streamSearchText(item: DiffStreamItem): string {
  if (item.itemKind === "changed") {
    return `${item.entityKind} ${item.label} ${item.sublabel}`.toLowerCase();
  }
  const e = item.event;
  const bits = [
    item.entityKind,
    item.entityLabel,
    e.action,
    e.path ?? "",
    e.executable ?? "",
    e.ip ? `${e.ip}:${e.port ?? ""}` : "",
    item.side === "a" ? "run a" : "run b",
  ];
  return bits.join(" ").toLowerCase();
}

/** Human label for a DiffStatus, also used as the node badge text. */
export function statusBadge(status: DiffStatus): string {
  switch (status) {
    case "shared":
      return "SHARED";
    case "changed":
      return "CHANGED";
    case "only-a":
      return "ONLY A";
    case "only-b":
      return "ONLY B";
  }
}
