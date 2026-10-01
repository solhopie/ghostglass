/**
 * Central state for the replay UI: loaded run data, replay clock, filters,
 * and selection. Views subscribe to topics and render; the store never
 * touches the DOM.
 */
import type {
  ApiGraph,
  GhostGlassEvent,
  GraphNode,
  Highlight,
  HighlightCategory,
  HighlightSeverity,
  RunMetadata,
  RunSummary,
} from "./types.js";
import type { CauseChain } from "./cause/index.js";
import { eventIndexAt } from "./format.js";

export type Selection =
  | { kind: "node"; nodeId: string }
  | { kind: "event"; index: number }
  | { kind: "highlight"; highlightId: string }
  | null;

export type Topic = "data" | "events" | "replay" | "selection" | "filters" | "graph" | "highlights" | "causechain";

export interface HighlightFilters {
  category: "all" | HighlightCategory;
  severity: "all" | HighlightSeverity;
}

export class Store {
  readonly runId: string;
  metadata: RunMetadata | null = null;
  summary: RunSummary | null = null;
  graph: ApiGraph | null = null;
  startTimeMs = 0;
  durationMs = 0;

  /** Absolute epoch ms per event index, ascending. */
  timestamps: number[] = [];
  /** Events loaded so far, in trace order. */
  events: GhostGlassEvent[] = [];
  eventsTotal = 0;
  eventsDone = false;

  // replay clock
  playing = false;
  speed = 1;
  tMs = 0;

  // graph filters
  showFiles = true;
  showNetwork = true;

  selection: Selection = null;
  /** Node ids to visually emphasize (event click → related nodes). */
  spotlight: string[] = [];
  follow = true;

  // highlights
  highlights: Highlight[] = [];
  highlightFilters: HighlightFilters = { category: "all", severity: "all" };
  showHighlights = true;

  // cause chain (Run 7)
  causeChain: CauseChain | null = null;
  causePathIndex = 0;
  causeLoading = false;
  causeError: string | null = null;
  /**
   * Live mode only: while true the UI reduces expensive animation
   * (no node pulses, slower graph emits). Saved runs never set this.
   */
  highActivity = false;

  readonly nodeById = new Map<string, GraphNode>();
  private readonly pidLabels = new Map<number, string>();
  private readonly listeners = new Map<Topic, Set<() => void>>();
  private raf = 0;
  private lastTick = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  on(topic: Topic, fn: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit(topic: Topic): void {
    for (const fn of this.listeners.get(topic) ?? []) fn();
  }

  setRunData(metadata: RunMetadata, summary: RunSummary, graph: ApiGraph): void {
    this.metadata = metadata;
    this.summary = summary;
    this.graph = graph;
    this.startTimeMs = Date.parse(metadata.startTime);
    this.durationMs = metadata.durationMs;
    this.nodeById.clear();
    this.pidLabels.clear();
    for (const n of graph.nodes) {
      this.nodeById.set(n.id, n);
      if (n.kind === "process" && n.pid != null) this.pidLabels.set(n.pid, n.label);
    }
    this.emit("data");
    this.emit("graph");
  }

  setTimeline(startTimeMs: number, timestamps: number[]): void {
    this.startTimeMs = startTimeMs;
    this.timestamps = timestamps;
    this.eventsTotal = timestamps.length;
    this.emit("events");
  }

  appendEvents(events: GhostGlassEvent[], done: boolean): void {
    this.events.push(...events);
    this.eventsDone = done;
    this.emit("events");
  }

  pidLabel(pid: number): string {
    return this.pidLabels.get(pid) ?? `PID ${pid}`;
  }

  /** Index of the last event at or before the playhead. */
  currentIndex(): number {
    if (this.timestamps.length === 0) return -1;
    return eventIndexAt(this.timestamps, this.startTimeMs + this.tMs);
  }

  currentEvent(): GhostGlassEvent | null {
    const i = this.currentIndex();
    return i >= 0 && i < this.events.length ? (this.events[i] as GhostGlassEvent) : null;
  }

  /** Graph node ids related to an event (process, file, network). */
  nodeIdsForEvent(e: GhostGlassEvent): string[] {
    const ids: string[] = [];
    const p = `p:${e.pid}`;
    if (this.nodeById.has(p)) ids.push(p);
    if (e.path) {
      const f = `f:${e.path}`;
      if (this.nodeById.has(f)) ids.push(f);
    }
    if (e.ip != null && e.port != null) {
      const n = `n:${e.ip}:${e.port}`;
      if (this.nodeById.has(n)) ids.push(n);
    }
    return ids;
  }

  play(): void {
    if (this.playing) return;
    if (this.tMs >= this.durationMs && this.durationMs > 0) this.tMs = 0;
    this.playing = true;
    this.lastTick = performance.now();
    this.emit("replay");
    const step = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = now - this.lastTick;
      this.lastTick = now;
      this.tMs = Math.min(this.durationMs, this.tMs + dt * this.speed);
      if (this.tMs >= this.durationMs) {
        this.playing = false;
        this.emit("replay");
        return;
      }
      this.emit("replay");
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit("replay");
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(tMs: number): void {
    this.tMs = Math.max(0, Math.min(this.durationMs, tMs));
    this.emit("replay");
  }

  jumpToStart(): void {
    this.seek(0);
  }

  jumpToEnd(): void {
    this.seek(this.durationMs);
  }

  cycleSpeed(): void {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
    this.emit("replay");
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.spotlight = sel?.kind === "node" ? [sel.nodeId] : [];
    this.emit("selection");
  }

  setGraphFilters(showFiles: boolean, showNetwork: boolean): void {
    this.showFiles = showFiles;
    this.showNetwork = showNetwork;
    this.emit("graph");
  }

  /** Select an event: pause, jump the playhead to it, highlight its nodes. */
  selectEvent(index: number): void {
    this.pause();
    const ts = this.timestamps[index];
    if (ts != null) this.tMs = Math.max(0, Math.min(this.durationMs, ts - this.startTimeMs));
    const ev = this.events[index];
    this.spotlight = ev ? this.nodeIdsForEvent(ev) : [];
    this.selection = { kind: "event", index };
    this.emit("replay");
    this.emit("selection");
  }

  setHighlights(highlights: Highlight[]): void {
    this.highlights = [...highlights].sort((a, b) => a.startTimestamp - b.startTimestamp);
    this.emit("highlights");
  }

  appendHighlights(highlights: Highlight[]): void {
    if (highlights.length === 0) return;
    const seen = new Set(this.highlights.map((h) => h.id));
    for (const h of highlights) {
      if (!seen.has(h.id)) {
        seen.add(h.id);
        this.highlights.push(h);
      }
    }
    this.highlights.sort((a, b) => a.startTimestamp - b.startTimestamp);
    this.emit("highlights");
  }

  setHighlightFilters(f: HighlightFilters): void {
    this.highlightFilters = f;
    this.emit("highlights");
  }

  setShowHighlights(show: boolean): void {
    this.showHighlights = show;
    this.emit("highlights");
    this.emit("graph");
  }

  filteredHighlights(): Highlight[] {
    const f = this.highlightFilters;
    return this.highlights.filter(
      (h) =>
        (f.category === "all" || highlightCategory(h) === f.category) &&
        (f.severity === "all" || h.severity === f.severity),
    );
  }

  /** Select a highlight: seek to it, spotlight related graph nodes, open inspector. */
  selectHighlight(id: string): void {
    const h = this.highlights.find((x) => x.id === id);
    if (!h) return;
    this.pause();
    this.tMs = Math.max(0, Math.min(this.durationMs, h.startTimestamp - this.startTimeMs));
    this.spotlight = this.nodeIdsForHighlight(h);
    this.selection = { kind: "highlight", highlightId: id };
    this.emit("replay");
    this.emit("selection");
    this.emit("highlights");
  }

  /** Show a cause chain (focused view); null returns to the full graph. */
  setCauseChain(chain: CauseChain | null): void {
    this.causeChain = chain;
    this.causePathIndex = 0;
    this.causeError = null;
    this.emit("causechain");
  }

  setCausePathIndex(i: number): void {
    if (!this.causeChain) return;
    const n = this.causeChain.paths.length;
    this.causePathIndex = ((i % n) + n) % n;
    this.emit("causechain");
  }

  /** Seek the replay clock to a cause-chain node's timestamp. */
  seekToCauseNode(timestampMs: number): void {
    this.pause();
    this.tMs = Math.max(0, Math.min(this.durationMs, timestampMs - this.startTimeMs));
    this.emit("replay");
  }

  /** Graph node ids related to a highlight (process + file/network from related events). */
  nodeIdsForHighlight(h: Highlight): string[] {
    const ids = new Set<string>();
    if (h.pid !== undefined) {
      const p = `p:${h.pid}`;
      if (this.nodeById.has(p)) ids.add(p);
    }
    const byId = new Map(this.events.map((e) => [e.id, e]));
    for (const eid of h.relatedEventIds.slice(0, 50)) {
      const e = byId.get(eid);
      if (!e) continue;
      for (const nid of this.nodeIdsForEvent(e)) ids.add(nid);
    }
    return [...ids];
  }
}

/** Category derived from rule (mirrors backend HIGHLIGHT_RULE_CATEGORY). */
export function highlightCategory(h: Highlight): HighlightCategory {
  switch (h.rule) {
    case "high-file-activity":
    case "high-delete-activity":
    case "rapid-file-churn":
      return "file";
    case "high-process-activity":
      return "process";
    case "high-network-activity":
      return "network";
    case "outside-working-directory":
    case "create-then-execute":
      return "path";
  }
}
