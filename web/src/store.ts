/**
 * Central state for the replay UI: loaded run data, replay clock, filters,
 * and selection. Views subscribe to topics and render; the store never
 * touches the DOM.
 */
import type {
  ApiGraph,
  GhostGlassEvent,
  GraphNode,
  RunMetadata,
  RunSummary,
} from "./types.js";
import { eventIndexAt } from "./format.js";

export type Selection =
  | { kind: "node"; nodeId: string }
  | { kind: "event"; index: number }
  | null;

export type Topic = "data" | "events" | "replay" | "selection" | "filters" | "graph";

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
}
