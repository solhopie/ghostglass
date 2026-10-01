/**
 * Live run state: extends the replay Store with streaming ingestion.
 *
 * Connects to the backend's SSE endpoint, pages any history the run
 * already accumulated, applies batches incrementally into a LiveGraph, and
 * keeps counters ticking while the command runs. When the backend reports a
 * terminal status, the same page becomes a normal replay with zero reload:
 * all events are already in place, so play/pause/scrub/speed just work.
 *
 * Reconnects are safe: EventSource resends Last-Event-ID natively, the
 * server replays missed events first, and a local seen-id set dedupes any
 * overlap.
 */
import { getEventsPage, getLiveStatus, type LiveStatusPayload } from "./api.js";
import { LiveGraph, type LiveCounters } from "./liveGraph.js";
import { Store } from "./store.js";
import type { GhostGlassEvent, Highlight } from "./types.js";

export type LiveStatus = "running" | "complete" | "interrupted" | "exited";

const HISTORY_PAGE = 5000;
/** Coalesce "events"/"data" emits to at most 5/sec during live. */
const EVENTS_EMIT_MS = 200;
/** Coalesce "graph" emits to at most 2/sec (1/sec in high-activity mode). */
const GRAPH_EMIT_MS = 500;
const GRAPH_EMIT_HIGH_ACTIVITY_MS = 1000;
/** Duration ticker + follow-live head tracking. */
const TICK_MS = 250;
/** Rolling throughput above this enters high-activity mode (UI batching). */
const HIGH_ACTIVITY_EVENTS_PER_SEC = 1500;
/** Rolling throughput below this leaves high-activity mode (hysteresis). */
const HIGH_ACTIVITY_CLEAR_PER_SEC = 750;

export class LiveStore extends Store {
  liveStatus: LiveStatus = "running";
  /** Playhead tracks the live head while true; scrubbing turns it off. */
  followLive = true;
  commandLine = "";
  exitCode: number | null = null;
  signal: string | null = null;
  interrupted = false;
  /** Node ids touched by the most recent batch (for pulse animation). */
  lastPulseIds: string[] = [];
  readonly counters: LiveCounters = {
    processes: 0,
    files: 0,
    fileEvents: 0,
    networkAttempts: 0,
    totalEvents: 0,
  };

  private acc: LiveGraph | null = null;
  private readonly seenIds = new Set<string>();
  private source: EventSource | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventsEmit = 0;
  private lastGraphEmit = 0;
  private graphDirty = false;
  private rateWindow: { t: number; n: number }[] = [];
  private connected = false;

  /** Seed from status/hello, page history, then attach the SSE stream. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const status = await getLiveStatus(this.runId);
    this.applyStatus(status);
    this.acc = new LiveGraph(this.runId, this.commandLine, this.startTimeMs);

    // History accumulated before this browser connected. Take the initial
    // total and page only that far; anything newer arrives via SSE.
    let offset = 0;
    let initialTotal = 0;
    for (;;) {
      const page = await getEventsPage(this.runId, offset, HISTORY_PAGE);
      if (offset === 0) initialTotal = page.total;
      this.applyBatch(page.events);
      offset += page.events.length;
      if (offset >= initialTotal || page.events.length === 0) break;
    }

    const lastId = this.events.length > 0 ? (this.events[this.events.length - 1] as GhostGlassEvent).id : "";
    const url = `/api/live/${encodeURIComponent(this.runId)}/stream?since=${encodeURIComponent(lastId)}`;
    const source = new EventSource(url);
    this.source = source;
    source.addEventListener("hello", (ev) => {
      try {
        this.applyHello((ev as MessageEvent).data as string);
      } catch {
        // malformed hello: ignore, status polling covers the essentials
      }
    });
    source.addEventListener("events", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data as string) as { events?: GhostGlassEvent[] };
        if (Array.isArray(data.events)) this.applyBatch(data.events);
      } catch {
        // malformed batch: skip; the next ?since= resync covers the gap
      }
    });
    source.addEventListener("status", (ev) => {
      try {
        this.applyStatus(JSON.parse((ev as MessageEvent).data as string) as LiveStatusPayload);
      } catch {
        // ignore
      }
    });
    source.addEventListener("highlights", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data as string) as {
          highlights?: Highlight[];
        };
        if (Array.isArray(data.highlights)) this.appendHighlights(data.highlights);
      } catch {
        // malformed highlight batch: skip; polling covers the gap
      }
    });
    // "ping" is keep-alive only. "error" needs no handler: EventSource
    // reconnects natively with Last-Event-ID, and the seen-id set dedupes
    // any replay overlap.
    this.startTick();
    this.flushGraph();
    this.emit("data");
    this.emit("graph");
  }

  private applyHello(data: string): void {
    const hello = JSON.parse(data) as {
      runId?: string;
      status?: LiveStatus;
      commandLine?: string;
      startTimeMs?: number;
    };
    if (typeof hello.commandLine === "string") this.commandLine = hello.commandLine;
    if (typeof hello.startTimeMs === "number") {
      this.startTimeMs = hello.startTimeMs;
      if (this.acc) this.rebuildAccumulator();
    }
    this.emit("data");
  }

  /** startTimeMs arrived after events were already applied: re-derive offsets. */
  private rebuildAccumulator(): void {
    const acc = new LiveGraph(this.runId, this.commandLine, this.startTimeMs);
    acc.apply(this.events);
    this.acc = acc;
    Object.assign(this.counters, acc.counters);
    this.refreshGraph();
  }

  private applyStatus(s: LiveStatusPayload): void {
    this.liveStatus = s.status;
    this.commandLine = s.commandLine;
    this.startTimeMs = s.startTimeMs;
    this.exitCode = s.exitCode;
    this.signal = s.signal;
    this.interrupted = s.interrupted;
    if (s.status !== "running") {
      this.durationMs = s.durationMs;
      this.tMs = s.durationMs;
      this.followLive = false;
      this.finalize();
    } else {
      this.durationMs = Math.max(this.durationMs, s.durationMs);
    }
    this.emit("data");
    this.emit("replay");
  }

  /** Apply one ordered batch: dedupe, append, fold into the graph, emit. */
  applyBatch(events: readonly GhostGlassEvent[]): void {
    if (!this.acc || events.length === 0) return;
    const fresh: GhostGlassEvent[] = [];
    for (const e of events) {
      if (!e || typeof e.id !== "string") continue;
      if (this.seenIds.has(e.id)) continue;
      this.seenIds.add(e.id);
      fresh.push(e);
    }
    if (fresh.length === 0) return;

    for (const e of fresh) {
      this.events.push(e);
      this.timestamps.push(e.timestamp);
    }
    this.eventsTotal = this.events.length;

    this.lastPulseIds = this.acc.apply(fresh);
    Object.assign(this.counters, this.acc.counters);
    this.updateActivity(fresh.length);
    // The snapshot is always current; only the view-facing "graph" event is throttled.
    this.graphDirty = true;
    this.flushGraph();

    const now = performance.now();
    if (now - this.lastEventsEmit >= EVENTS_EMIT_MS) {
      this.lastEventsEmit = now;
      this.emit("events");
      this.emit("data");
    }
    const graphMs = this.highActivity ? GRAPH_EMIT_HIGH_ACTIVITY_MS : GRAPH_EMIT_MS;
    if (now - this.lastGraphEmit >= graphMs) {
      this.lastGraphEmit = now;
      this.emit("graph");
    }
  }

  /** Rebuild the derived graph only if new batches arrived since the last build. */
  private flushGraph(): void {
    if (!this.graphDirty) return;
    this.refreshGraph();
  }

  private refreshGraph(): void {
    if (!this.acc) return;
    this.graphDirty = false;
    const graph = this.acc.toGraph();
    this.graph = graph;
    this.nodeById.clear();
    for (const n of graph.nodes) {
      this.nodeById.set(n.id, n);
    }
    this.rebuildPidLabels();
  }

  /**
   * The base Store keeps its pid→label map private, so LiveStore keeps a
   * parallel map and overrides pidLabel() to consult it first. The graph
   * already labels processes by executable, which is what stream rows and
   * the inspector need.
   */
  private readonly livePidLabels = new Map<number, string>();

  private rebuildPidLabels(): void {
    this.livePidLabels.clear();
    for (const n of this.nodeById.values()) {
      if (n.kind === "process" && n.pid != null) this.livePidLabels.set(n.pid, n.label);
    }
  }

  override pidLabel(pid: number): string {
    return this.livePidLabels.get(pid) ?? super.pidLabel(pid);
  }

  private updateActivity(n: number): void {
    const now = Date.now();
    this.rateWindow.push({ t: now, n });
    while (this.rateWindow.length > 0 && now - (this.rateWindow[0] as { t: number }).t > 1000) {
      this.rateWindow.shift();
    }
    const perSec = this.rateWindow.reduce((s, r) => s + r.n, 0);
    const was = this.highActivity;
    if (!was && perSec > HIGH_ACTIVITY_EVENTS_PER_SEC) this.highActivity = true;
    else if (was && perSec < HIGH_ACTIVITY_CLEAR_PER_SEC) this.highActivity = false;
    if (was !== this.highActivity) this.emit("data");
  }

  /** Follow-live: playhead tracks the head; scrubbing/selection disables it. */
  setFollowLive(v: boolean): void {
    this.followLive = v;
    if (v && this.liveStatus === "running") {
      this.tMs = this.durationMs;
    }
    this.emit("replay");
    this.emit("data");
  }

  override seek(tMs: number): void {
    this.followLive = false;
    super.seek(tMs);
  }

  override selectEvent(index: number): void {
    this.followLive = false;
    super.selectEvent(index);
  }

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      if (this.liveStatus !== "running") return;
      this.durationMs = Date.now() - this.startTimeMs;
      if (this.followLive && !this.playing) {
        this.tMs = this.durationMs;
      }
      this.emit("data");
      this.emit("replay");
    }, TICK_MS);
  }

  private finalize(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.highActivity = false;
    // Force a final full refresh so replay controls, inspector, and the
    // header settle on the completed state with no reload.
    this.graphDirty = true;
    this.flushGraph();
    this.emit("events");
    this.emit("data");
    this.emit("graph");
    this.emit("replay");
  }

  /** Force-close the stream (tests / teardown). */
  disconnect(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
