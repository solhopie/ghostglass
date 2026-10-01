/**
 * Live Glass frontend tests (jsdom).
 *
 * - LiveGraph: incremental accumulation, node-id scheme parity with the
 *   server indexer, folding, dedupe-friendly ordering, 600-file cap,
 *   process liveness.
 * - LiveStore: connect() wiring over a fake EventSource, batch application,
 *   dedupe by event id, counters, status transitions, replay-after-complete,
 *   high-activity mode.
 * - LiveHeaderView: XSS-safe rendering of hostile streamed strings.
 * - Real SSE endpoint: a real ViewerServer with a stub LiveSessionLike —
 *   hello / events chunking / status / ping frames, ?since= replay, and
 *   Last-Event-ID header behavior are asserted by parsing the raw stream.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { ViewerServer } from "../src/viewer/server.js";
import type { GhostGlassEvent } from "../src/events/types.js";
import type {
  LiveSessionLike,
  LiveStatusPayload,
  LiveSubscriber,
} from "../src/live/liveSession.js";
import type { Highlight } from "../src/highlights/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // dist/test -> repo root
const webDist = join(repoRoot, "web", "dist");

const BASE = 1_750_000_000_000;
const RUN_ID = "gg_20260930_042";
let seq = 0;
function ev(
  partial: Partial<GhostGlassEvent> & {
    action: GhostGlassEvent["action"];
    type: GhostGlassEvent["type"];
  },
): GhostGlassEvent {
  seq += 1;
  return {
    id: `${RUN_ID}-${String(seq).padStart(6, "0")}`,
    runId: RUN_ID,
    timestamp: BASE + seq * 25,
    pid: 100,
    ...partial,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const mod = <T>(p: string): Promise<T> =>
  import(pathToFileURL(join(webDist, p)).href) as Promise<T>;

interface TestLiveGraph {
  apply(events: GhostGlassEvent[]): string[];
  toGraph(): TestApiGraph;
  readonly counters: { processes: number; files: number; fileEvents: number; networkAttempts: number; totalEvents: number };
}

interface TestApiGraph {
  nodes: { id: string; kind: string; label: string; sublabel: string; live?: { status: string; code?: number | null } }[];
  edges: { from: string; to: string; kind: string }[];
  totalUniqueFiles: number;
  truncatedFiles: number;
  nodeCap: number;
}

interface TestLiveStore {
  liveStatus: string;
  followLive: boolean;
  highActivity: boolean;
  commandLine: string;
  startTimeMs: number;
  durationMs: number;
  tMs: number;
  playing: boolean;
  events: GhostGlassEvent[];
  graph: TestApiGraph | null;
  counters: TestLiveGraph["counters"];
  lastPulseIds: string[];
  connect(): Promise<void>;
  disconnect(): void;
  applyBatch(events: GhostGlassEvent[]): void;
  setFollowLive(v: boolean): void;
  seek(t: number): void;
  play(): void;
  pause(): void;
  select(sel: unknown): void;
  on(topic: string, fn: () => void): () => void;
}

function statusPayload(over: Partial<LiveStatusPayload> = {}): LiveStatusPayload {
  return {
    runId: RUN_ID,
    status: "running",
    commandLine: "npm install express",
    startTimeMs: BASE,
    durationMs: 1234,
    exitCode: null,
    signal: null,
    interrupted: false,
    eventCount: 0,
    ...over,
  };
}

/** Minimal EventSource stand-in: the store only needs constructor, addEventListener, close. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, ((ev: { data: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(fn);
  }

  emit(type: string, data: unknown): void {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    for (const fn of this.listeners.get(type) ?? []) fn({ data: raw });
  }

  close(): void {
    this.closed = true;
  }
}

describe("live frontend", () => {
  let LiveGraph: new (runId: string, commandLine: string, startTimeMs: number) => TestLiveGraph;
  let LiveStore: new (runId: string) => TestLiveStore;
  let LiveHeaderView: new (host: HTMLElement, store: TestLiveStore) => { render(): void };
  let GraphView: new (host: HTMLElement, store: TestLiveStore) => { render(): void; pulseNodes(ids: readonly string[]): void };
  let StreamView: new (host: HTMLElement, store: TestLiveStore) => { render(): void };
  let InspectorView: new (host: HTMLElement, store: TestLiveStore) => { render(): void };
  let savedFetch: unknown;

  before(async () => {
    const g0 = globalThis as unknown as Record<string, unknown>;
    savedFetch = g0["fetch"];
    const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
      url: "http://127.0.0.1:7777/",
      pretendToBeVisual: true,
    });
    const g = globalThis as unknown as Record<string, unknown>;
    g["window"] = dom.window;
    g["document"] = dom.window.document;
    g["HTMLElement"] = dom.window.HTMLElement;
    g["SVGElement"] = dom.window.SVGElement;
    g["Element"] = dom.window.Element;
    g["Node"] = dom.window.Node;
    g["Event"] = dom.window.Event;
    g["MouseEvent"] = dom.window.MouseEvent;
    g["requestAnimationFrame"] = dom.window.requestAnimationFrame.bind(dom.window);
    g["cancelAnimationFrame"] = dom.window.cancelAnimationFrame.bind(dom.window);
    g["EventSource"] = FakeEventSource;

    LiveGraph = (await mod<{ LiveGraph: typeof LiveGraph }>("liveGraph.js")).LiveGraph;
    LiveStore = (await mod<{ LiveStore: typeof LiveStore }>("liveStore.js")).LiveStore;
    LiveHeaderView = (await mod<{ LiveHeaderView: typeof LiveHeaderView }>("liveHeaderView.js")).LiveHeaderView;
    GraphView = (await mod<{ GraphView: typeof GraphView }>("graphView.js")).GraphView;
    StreamView = (await mod<{ StreamView: typeof StreamView }>("streamView.js")).StreamView;
    InspectorView = (await mod<{ InspectorView: typeof InspectorView }>("inspectorView.js")).InspectorView;
  });

  after(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["window"];
    delete g["document"];
    delete g["HTMLElement"];
    delete g["SVGElement"];
    delete g["Element"];
    delete g["Node"];
    delete g["Event"];
    delete g["MouseEvent"];
    delete g["requestAnimationFrame"];
    delete g["cancelAnimationFrame"];
    delete g["EventSource"];
    // Restore the real fetch that connectedStore() mocked.
    if (savedFetch === undefined) delete g["fetch"];
    else g["fetch"] = savedFetch;
  });

  function container(): HTMLElement {
    const d = document.createElement("div");
    document.getElementById("app")!.appendChild(d);
    return d as HTMLElement;
  }

  /** A connected LiveStore whose network is fully stubbed; caller must disconnect(). */
  async function connectedStore(history: GhostGlassEvent[] = []): Promise<{ store: TestLiveStore; src: FakeEventSource }> {
    FakeEventSource.instances = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g["fetch"] = async (url: string | URL) => {
      const u = new URL(String(url), "http://x");
      if (u.pathname === `/api/live/${RUN_ID}/status`) {
        return new Response(JSON.stringify(statusPayload({ eventCount: history.length })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.pathname === `/api/runs/${RUN_ID}/events`) {
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const limit = Number(u.searchParams.get("limit") ?? 5000);
        const slice = history.slice(offset, offset + limit);
        return new Response(JSON.stringify({ total: history.length, offset, limit, events: slice }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${u.pathname}`);
    };
    const store = new LiveStore(RUN_ID);
    await store.connect();
    assert.equal(FakeEventSource.instances.length, 1, "expected one EventSource");
    return { store, src: FakeEventSource.instances[0] as FakeEventSource };
  }

  it("LiveGraph accumulates entities incrementally with the server node-id scheme", () => {
    const g = new LiveGraph(RUN_ID, "npm install express", BASE);
    const e1 = ev({ action: "exec", type: "process", pid: 100, executable: "/usr/bin/npm" });
    g.apply([e1]);
    let graph = g.toGraph();
    const ids = new Set(graph.nodes.map((n) => n.id));
    assert.ok(ids.has("root"), "root node");
    assert.ok(ids.has("p:100"), "process node uses p:<pid>");
    assert.ok(graph.edges.some((e) => e.kind === "exec" && e.from === "root" && e.to === "p:100"));

    const e2 = ev({ action: "spawn", type: "process", pid: 101, parentPid: 100, executable: "/usr/bin/node" });
    const e3 = ev({ action: "read", type: "file", pid: 101, path: "/tmp/package.json" });
    const e4 = ev({ action: "connect", type: "network", pid: 101, ip: "127.0.0.1", port: 8080 });
    const active = g.apply([e2, e3, e4]);
    graph = g.toGraph();
    const ids2 = new Set(graph.nodes.map((n) => n.id));
    for (const want of ["p:101", "f:/tmp/package.json", "n:127.0.0.1:8080"]) {
      assert.ok(ids2.has(want), `missing node ${want}`);
    }
    assert.ok(graph.edges.some((e) => e.kind === "spawn" && e.from === "p:100" && e.to === "p:101"));
    assert.ok(graph.edges.some((e) => e.kind === "access" && e.from === "p:101" && e.to === "f:/tmp/package.json"));
    assert.ok(graph.edges.some((e) => e.kind === "connect" && e.from === "p:101" && e.to === "n:127.0.0.1:8080"));
    // recently-active ids cover process, file, network, and the spawn parent
    for (const want of ["p:101", "f:/tmp/package.json", "n:127.0.0.1:8080", "p:100"]) {
      assert.ok(active.includes(want), `recently active missing ${want}`);
    }
    assert.deepEqual(g.counters, {
      processes: 2,
      files: 1,
      fileEvents: 1,
      networkAttempts: 1,
      totalEvents: 4,
    });
  });

  it("LiveGraph folds repeated file activity into one node (no duplicates)", () => {
    const g = new LiveGraph(RUN_ID, "cmd", BASE);
    const batch: GhostGlassEvent[] = [ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" })];
    for (let i = 0; i < 50; i++) batch.push(ev({ action: "read", type: "file", pid: 100, path: "/tmp/a.txt" }));
    for (let i = 0; i < 10; i++) batch.push(ev({ action: "write", type: "file", pid: 100, path: "/tmp/a.txt" }));
    g.apply(batch);
    const graph = g.toGraph();
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    assert.equal(fileNodes.length, 1, "one node per unique path");
    assert.equal(fileNodes[0]!.id, "f:/tmp/a.txt");
    assert.equal(g.counters.files, 1);
    assert.equal(g.counters.fileEvents, 60);
  });

  it("LiveGraph tracks process liveness from exit events", () => {
    const g = new LiveGraph(RUN_ID, "cmd", BASE);
    g.apply([
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }),
      ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }),
    ]);
    let p101 = g.toGraph().nodes.find((n) => n.id === "p:101");
    assert.equal(p101?.live?.status, "running");
    g.apply([ev({ action: "exit", type: "process", pid: 101, metadata: { code: 1 } })]);
    p101 = g.toGraph().nodes.find((n) => n.id === "p:101");
    assert.equal(p101?.live?.status, "exited");
    assert.equal(p101?.live?.code, 1);
    const p100 = g.toGraph().nodes.find((n) => n.id === "p:100");
    assert.equal(p100?.live?.status, "running", "other processes stay running");
  });

  it("LiveGraph caps visible file nodes at 600 and reports the hidden count", () => {
    const g = new LiveGraph(RUN_ID, "cmd", BASE);
    const batch: GhostGlassEvent[] = [ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" })];
    for (let i = 0; i < 700; i++) {
      batch.push(ev({ action: "read", type: "file", pid: 100, path: `/tmp/f${i}.txt` }));
    }
    g.apply(batch);
    const graph = g.toGraph();
    assert.equal(graph.nodes.filter((n) => n.kind === "file").length, 600);
    assert.equal(graph.totalUniqueFiles, 700);
    assert.equal(graph.truncatedFiles, 100);
    assert.equal(graph.nodeCap, 600);
    assert.equal(g.counters.files, 700, "counters keep the full data");
  });

  it("LiveStore connects, pages history, and applies SSE batches with counters", async () => {
    const history = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/usr/bin/npm" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/package.json" }),
    ];
    const { store, src } = await connectedStore(history);
    try {
      assert.equal(store.liveStatus, "running");
      assert.equal(store.commandLine, "npm install express");
      assert.equal(store.startTimeMs, BASE);
      assert.equal(store.events.length, 2, "history paged before SSE");
      assert.ok(src.url.includes(`/api/live/${RUN_ID}/stream?since=`), `sse url: ${src.url}`);
      assert.ok(src.url.endsWith(`since=${encodeURIComponent(history[1]!.id)}`), `since=last id: ${src.url}`);

      src.emit("events", {
        events: [
          ev({ action: "spawn", type: "process", pid: 101, parentPid: 100, executable: "/usr/bin/node" }),
          ev({ action: "connect", type: "network", pid: 101, ip: "127.0.0.1", port: 8080 }),
        ],
      });
      assert.equal(store.events.length, 4);
      assert.deepEqual(
        { ...store.counters },
        { processes: 2, files: 1, fileEvents: 1, networkAttempts: 1, totalEvents: 4 },
      );
      await sleep(250); // throttle window: graph emit fires
      const ids = new Set((store.graph?.nodes ?? []).map((n) => n.id));
      assert.ok(ids.has("p:101") && ids.has("n:127.0.0.1:8080"), "graph grew from the SSE batch");
    } finally {
      store.disconnect();
    }
  });

  it("LiveStore dedupes events by id (reconnect overlap never duplicates)", async () => {
    const { store, src } = await connectedStore();
    try {
      const batch = [
        ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }),
        ev({ action: "read", type: "file", pid: 100, path: "/tmp/a.txt" }),
      ];
      src.emit("events", { events: batch });
      src.emit("events", { events: batch }); // reconnect replay overlap
      src.emit("events", { events: [batch[0]] }); // partial overlap
      assert.equal(store.events.length, 2, "no duplicate events stored");
      assert.deepEqual({ ...store.counters }, { processes: 1, files: 1, fileEvents: 1, networkAttempts: 0, totalEvents: 2 });
      const ids = store.events.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length);
    } finally {
      store.disconnect();
    }
  });

  it("status transition to complete finalizes: stream closes, replay works with no reload", async () => {
    const { store, src } = await connectedStore();
    try {
      src.emit("events", {
        events: [
          ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }),
          ev({ action: "read", type: "file", pid: 100, path: "/tmp/a.txt" }),
        ],
      });
      src.emit("status", statusPayload({ status: "complete", durationMs: 2500, exitCode: 0, eventCount: 2 }));
      assert.equal(store.liveStatus, "complete");
      assert.ok(src.closed, "EventSource closed on terminal status");
      assert.equal(store.durationMs, 2500);

      // Same page is now a normal replay: play/pause/scrub/speed.
      store.play();
      assert.equal(store.playing, true);
      store.pause();
      assert.equal(store.playing, false);
      store.seek(1000);
      assert.equal(store.tMs, 1000);
      store.seek(store.durationMs);
      assert.equal(store.tMs, 2500);

      // Inspector shows the final state.
      const ic = container();
      new InspectorView(ic, store).render();
      store.select({ kind: "node", nodeId: "p:100" });
      assert.ok(ic.textContent!.includes("PROCESS"), `inspector: ${ic.textContent!.slice(0, 120)}`);
      store.select(null);
    } finally {
      store.disconnect();
    }
  });

  it("nonzero exit and interrupt statuses surface descriptively", async () => {
    const { store, src } = await connectedStore();
    try {
      src.emit("status", statusPayload({ status: "exited", durationMs: 900, exitCode: 1 }));
      assert.equal(store.liveStatus, "exited");
      const hc = container();
      new LiveHeaderView(hc, store).render();
      assert.ok(hc.textContent!.includes("EXITED 1"), `pill: ${hc.textContent!.slice(0, 120)}`);
      assert.ok(!/malicious|dangerous/i.test(hc.textContent!), "no verdict language");
    } finally {
      store.disconnect();
    }
    const { store: s2, src: src2 } = await connectedStore();
    try {
      src2.emit("status", statusPayload({ status: "interrupted", durationMs: 500, interrupted: true }));
      assert.equal(s2.liveStatus, "interrupted");
      const hc = container();
      new LiveHeaderView(hc, s2).render();
      assert.ok(hc.textContent!.includes("INTERRUPTED"));
    } finally {
      s2.disconnect();
    }
  });

  it("high-activity mode toggles on throughput and clears when it subsides", async () => {
    const { store } = await connectedStore();
    try {
      assert.equal(store.highActivity, false);
      const burst: GhostGlassEvent[] = [];
      for (let i = 0; i < 2000; i++) {
        burst.push(ev({ action: "read", type: "file", pid: 100, path: `/tmp/b${i % 50}.txt` }));
      }
      store.applyBatch(burst);
      assert.equal(store.highActivity, true, "2000 events in one batch exceeds 1500/sec");
      const hc = container();
      new LiveHeaderView(hc, store).render();
      assert.ok(hc.textContent!.includes("batching enabled"), "banner shown");
      await sleep(1100);
      store.applyBatch([ev({ action: "read", type: "file", pid: 100, path: "/tmp/q.txt" })]);
      assert.equal(store.highActivity, false, "quiet period clears the flag");
    } finally {
      store.disconnect();
    }
  });

  it("live header renders hostile streamed strings as inert text", async () => {
    const { store, src } = await connectedStore();
    try {
      src.emit("hello", {
        runId: RUN_ID,
        status: "running",
        commandLine: "<script>alert(1)</script> --flag",
        startTimeMs: BASE,
      });
      src.emit("status", statusPayload({ commandLine: "<img src=x onerror=alert(1)>" }));
      const hc = container();
      new LiveHeaderView(hc, store).render();
      assert.equal(hc.querySelectorAll("script").length, 0);
      assert.equal(hc.querySelectorAll("img").length, 0);
      assert.ok(hc.textContent!.includes("<img src=x onerror=alert(1)>"), "hostile text preserved as text");
    } finally {
      store.disconnect();
    }
  });

  it("graph and stream render hostile live paths as inert text", async () => {
    const { store, src } = await connectedStore();
    try {
      src.emit("events", {
        events: [
          ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }),
          ev({ action: "read", type: "file", pid: 100, path: "<img src=x onerror=alert(1)>" }),
          ev({ action: "read", type: "file", pid: 100, path: "\u2028\u00adunicode\ufffe/\u2029path" }),
        ],
      });
      await sleep(250);
      const gc = container();
      new GraphView(gc, store).render();
      assert.equal(gc.querySelectorAll("img").length, 0, "no img from hostile path in graph");
      const sc = container();
      new StreamView(sc, store).render();
      const input = sc.querySelector(".stream-search") as HTMLInputElement;
      input.value = "img src";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(400);
      const rows = sc.querySelectorAll(".stream-row");
      assert.ok(rows.length > 0);
      assert.equal(sc.querySelectorAll("img").length, 0, "no img from hostile path in stream");
      assert.ok(rows[0]!.textContent!.includes("<img src=x onerror=alert(1)>"));
    } finally {
      store.disconnect();
    }
  });

  it("scrubbing during live turns follow-live off; Follow Live re-enables it", async () => {
    const { store } = await connectedStore();
    try {
      assert.equal(store.followLive, true);
      store.seek(10);
      assert.equal(store.followLive, false, "scrub disables head tracking");
      store.setFollowLive(true);
      assert.equal(store.followLive, true);
      assert.equal(store.tMs, store.durationMs, "re-enable snaps to the head");
    } finally {
      store.disconnect();
    }
  });

  it("graph pan/zoom survives live re-renders", async () => {
    const { store, src } = await connectedStore();
    try {
      src.emit("events", {
        events: [
          ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }),
          ev({ action: "read", type: "file", pid: 100, path: "/tmp/a.txt" }),
        ],
      });
      await sleep(250);
      const gc = container();
      const view = new GraphView(gc, store);
      view.render();
      const svg = gc.querySelector("svg.graph-svg") as SVGSVGElement;
      assert.ok(svg, "graph svg rendered");
      // Zoom in via a wheel event, then pan is implicitly covered by the same
      // preserved tx/ty/k state.
      const wheel = new (globalThis as { window: typeof window }).window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -100,
        clientX: 50,
        clientY: 50,
      });
      svg.dispatchEvent(wheel);
      const zoomed = (svg.querySelector("g") as SVGGElement).getAttribute("transform");
      assert.ok(zoomed && zoomed.includes("scale(1.12)"), `expected zoomed transform, got ${zoomed}`);
      // More live events arrive -> the view re-renders via the store "data"
      // subscription. The user's zoom must survive.
      src.emit("events", {
        events: [ev({ action: "write", type: "file", pid: 100, path: "/tmp/b.txt" })],
      });
      await sleep(250);
      const svg2 = gc.querySelector("svg.graph-svg") as SVGSVGElement;
      const after = (svg2.querySelector("g") as SVGGElement).getAttribute("transform");
      assert.equal(after, zoomed, "pan/zoom preserved across live re-render");
    } finally {
      store.disconnect();
    }
  });
});

describe("live boot", () => {
  it("sets the live document title and falls back to saved replay when the live session is gone", async () => {
    // Boot /live/<id> in a fresh jsdom where the live session is already gone
    // (404) but the completed run was saved. main.ts boots on import.
    const runId = "gg_20260930_911";
    const dom = new JSDOM(
      `<!doctype html><html><head><title>old title</title></head><body><div id="app"></div></body></html>`,
      { url: `http://127.0.0.1:7777/live/${runId}`, pretendToBeVisual: true },
    );
    const g = globalThis as unknown as Record<string, unknown>;
    const prev: Record<string, unknown> = {};
    const keys = [
      "window", "document", "HTMLElement", "SVGElement", "Element", "Node",
      "Event", "MouseEvent", "requestAnimationFrame", "cancelAnimationFrame",
      "EventSource", "fetch",
    ];
    for (const k of keys) prev[k] = g[k];
    try {
      g["window"] = dom.window;
      g["document"] = dom.window.document;
      g["HTMLElement"] = dom.window.HTMLElement;
      g["SVGElement"] = dom.window.SVGElement;
      g["Element"] = dom.window.Element;
      g["Node"] = dom.window.Node;
      g["Event"] = dom.window.Event;
      g["MouseEvent"] = dom.window.MouseEvent;
      g["requestAnimationFrame"] = dom.window.requestAnimationFrame.bind(dom.window);
      g["cancelAnimationFrame"] = dom.window.cancelAnimationFrame.bind(dom.window);
      g["EventSource"] = FakeEventSource;
      const fetched: string[] = [];
      g["fetch"] = async (url: string | URL) => {
        const u = new URL(String(url), "http://x");
        fetched.push(u.pathname);
        if (u.pathname === `/api/live/${runId}/status`) {
          return new Response(JSON.stringify({ error: "no live session" }), { status: 404 });
        }
        if (u.pathname === `/api/runs/${runId}`) {
          return new Response(
            JSON.stringify({
              metadata: { runId, commandLine: "node x.js", startTimeMs: BASE, durationMs: 1000, exitCode: 0 },
              summary: { runId, eventCount: 10 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${u.pathname}`);
      };

      await mod("main.js");

      // Title is set synchronously at the top of bootLive.
      assert.equal(
        dom.window.document.title,
        `GhostGlass Live — ${runId}`,
        "live document title",
      );
      // The async fallback: live session gone (404) -> saved run check.
      // jsdom cannot navigate, so location.replace is unobservable; instead
      // verify the fallback ran its saved-run check and did NOT render the
      // boot-error overlay (which is the other branch of the catch).
      const deadline = Date.now() + 5000;
      while (!fetched.includes(`/api/runs/${runId}`) && Date.now() < deadline) await sleep(50);
      assert.ok(
        fetched.includes(`/api/runs/${runId}`),
        `expected saved-run check, fetched: ${fetched.join(", ")}`,
      );
      await sleep(200);
      assert.equal(
        dom.window.document.querySelectorAll(".boot-error").length,
        0,
        "no boot error: fallback redirect branch was taken",
      );
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete g[k];
        else g[k] = prev[k];
      }
    }
  });
});

interface SseFrame {
  event: string | null;
  id: string | null;
  data: string;
}

function parseSseFrame(raw: string): SseFrame {
  let event: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { event, id, data: dataLines.join("\n") };
}

/** Read SSE frames from a URL until `done` returns true or the timeout hits. */
async function readSse(
  url: string,
  headers: Record<string, string>,
  done: (frames: SseFrame[]) => boolean,
  timeoutMs: number,
): Promise<SseFrame[]> {
  const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers } });
  assert.equal(res.status, 200, `SSE status for ${url}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: SseFrame[] = [];
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for SSE frames on ${url}`);
      const { done: dr, value } = await reader.read();
      if (dr) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        frames.push(parseSseFrame(buf.slice(0, idx)));
        buf = buf.slice(idx + 2);
        if (done(frames)) return frames;
      }
    }
    return frames;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("live SSE endpoint", () => {
  let server: ViewerServer;
  let serverUrl: string;
  const sessionEvents: GhostGlassEvent[] = [];

  class StubLiveSession implements LiveSessionLike {
    readonly runId = RUN_ID;
    getStatus(): LiveStatusPayload {
      return statusPayload({ eventCount: sessionEvents.length });
    }
    eventsAfter(sinceId: string | null): { events: GhostGlassEvent[] } {
      if (sinceId == null || sinceId === "") return { events: [...sessionEvents] };
      const idx = sessionEvents.findIndex((e) => e.id === sinceId);
      return { events: idx === -1 ? [...sessionEvents] : sessionEvents.slice(idx + 1) };
    }
    eventsSlice(offset: number, limit: number): { total: number; events: GhostGlassEvent[] } {
      return { total: sessionEvents.length, events: sessionEvents.slice(offset, offset + limit) };
    }
    subscribe(sub: LiveSubscriber, sinceId?: string | null): () => void {
      const missed = this.eventsAfter(sinceId ?? null).events;
      if (missed.length > 0) sub.onEvents(missed);
      sub.onStatus(this.getStatus());
      return () => undefined;
    }
    getHighlights(): Highlight[] {
      return [];
    }
  }

  before(async () => {
    // 2500 events: exercises the server's ≤2000-event replay chunking.
    for (let i = 0; i < 2500; i++) {
      sessionEvents.push(
        ev({ action: "read", type: "file", pid: 100, path: `/tmp/chunk${i}.txt` }),
      );
    }
    sessionEvents.unshift(ev({ action: "exec", type: "process", pid: 100, executable: "/bin/x" }));
    server = new ViewerServer({ cwd: "/tmp" });
    server.registerLiveSession(new StubLiveSession());
    serverUrl = (await server.start()).url;
  });

  after(async () => {
    await server.stop().catch(() => undefined);
  });

  const streamUrl = (q = ""): string =>
    `${serverUrl}/api/live/${RUN_ID}/stream${q}`;

  it("status endpoint returns the live status payload (404 for unknown runs)", async () => {
    const res = await fetch(`${serverUrl}/api/live/${RUN_ID}/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as LiveStatusPayload;
    assert.equal(body.runId, RUN_ID);
    assert.equal(body.status, "running");
    assert.equal(body.commandLine, "npm install express");
    assert.equal(body.startTimeMs, BASE);
    assert.equal(typeof body.durationMs, "number");
    assert.equal(body.eventCount, sessionEvents.length);

    const missing = await fetch(`${serverUrl}/api/live/gg_20000101_999/status`);
    assert.equal(missing.status, 404);
  });

  it("stream sends hello, chunked events with ids, then status", async () => {
    const frames = await readSse(
      streamUrl(),
      {},
      (f) => f.some((x) => x.event === "status"),
      5000,
    );
    const hello = frames.find((f) => f.event === "hello");
    assert.ok(hello, "hello frame");
    const helloData = JSON.parse(hello.data) as { runId: string; status: string; commandLine: string; startTimeMs: number };
    assert.equal(helloData.runId, RUN_ID);
    assert.equal(helloData.status, "running");
    assert.equal(helloData.commandLine, "npm install express");
    assert.equal(helloData.startTimeMs, BASE);

    const eventFrames = frames.filter((f) => f.event === "events");
    assert.ok(eventFrames.length >= 2, `2500 events must arrive in ≥2 chunks, got ${eventFrames.length}`);
    const seen: GhostGlassEvent[] = [];
    for (const fr of eventFrames) {
      const payload = JSON.parse(fr.data) as { events: GhostGlassEvent[] };
      assert.ok(payload.events.length > 0 && payload.events.length <= 2000, `chunk size ${payload.events.length}`);
      const last = payload.events[payload.events.length - 1] as GhostGlassEvent;
      assert.equal(fr.id, last.id, "SSE id = last event id in the chunk");
      seen.push(...payload.events);
    }
    assert.equal(seen.length, sessionEvents.length, "all events replayed");
    assert.deepEqual(
      seen.map((e) => e.id),
      sessionEvents.map((e) => e.id),
      "replay is ordered with no duplicates",
    );

    const status = frames.find((f) => f.event === "status");
    assert.ok(status, "status frame");
    assert.equal((JSON.parse(status.data) as LiveStatusPayload).status, "running");
  });

  it("?since= replays only events after the given id", async () => {
    const sinceId = sessionEvents[1]!.id;
    const frames = await readSse(
      streamUrl(`?since=${encodeURIComponent(sinceId)}`),
      {},
      (f) => f.some((x) => x.event === "status"),
      5000,
    );
    const seen: string[] = [];
    for (const fr of frames.filter((f) => f.event === "events")) {
      seen.push(...(JSON.parse(fr.data) as { events: GhostGlassEvent[] }).events.map((e) => e.id));
    }
    assert.deepEqual(
      seen,
      sessionEvents.slice(2).map((e) => e.id),
      "?since= replays exactly the missed tail",
    );
  });

  it("Last-Event-ID header behaves like ?since=", async () => {
    const sinceId = sessionEvents[10]!.id;
    const frames = await readSse(
      streamUrl(),
      { "Last-Event-ID": sinceId },
      (f) => f.some((x) => x.event === "status"),
      5000,
    );
    const seen: string[] = [];
    for (const fr of frames.filter((f) => f.event === "events")) {
      seen.push(...(JSON.parse(fr.data) as { events: GhostGlassEvent[] }).events.map((e) => e.id));
    }
    assert.deepEqual(
      seen,
      sessionEvents.slice(11).map((e) => e.id),
      "Last-Event-ID replays exactly the missed tail",
    );
  });

  it("stream sends periodic ping keep-alives", async () => {
    const frames = await readSse(
      streamUrl(),
      {},
      (f) => f.some((x) => x.event === "ping"),
      20_000,
    );
    const ping = frames.find((f) => f.event === "ping");
    assert.ok(ping, "ping frame arrived");
    assert.equal(ping.data, "{}");
  });
});

describe("live SSE backpressure", () => {
  let server: ViewerServer;
  let serverUrl: string;
  const liveSubs: LiveSubscriber[] = [];

  class BulkLiveSession implements LiveSessionLike {
    readonly runId = RUN_ID;
    getStatus(): LiveStatusPayload {
      return statusPayload({ status: "running", eventCount: 0 });
    }
    eventsAfter(): { events: GhostGlassEvent[] } {
      return { events: [] };
    }
    eventsSlice(): { total: number; events: GhostGlassEvent[] } {
      return { total: 0, events: [] };
    }
    subscribe(sub: LiveSubscriber, sinceId?: string | null): () => void {
      void sinceId;
      liveSubs.push(sub);
      return () => {
        const i = liveSubs.indexOf(sub);
        if (i >= 0) liveSubs.splice(i, 1);
      };
    }
    getHighlights(): Highlight[] {
      return [];
    }
  }

  /** Push a batch of live events to every connected SSE client. */
  function pushLive(count: number): void {
    const batch: GhostGlassEvent[] = [];
    for (let i = 0; i < count; i++) {
      batch.push(ev({ action: "write", type: "file", pid: 100, path: `/tmp/bulk-${i}.txt` }));
    }
    for (const sub of [...liveSubs]) sub.onEvents(batch);
  }

  before(async () => {
    server = new ViewerServer({ cwd: "/tmp" });
    server.registerLiveSession(new BulkLiveSession());
    serverUrl = (await server.start()).url;
  });

  after(async () => {
    await server.stop().catch(() => undefined);
  });

  it("a healthy client that keeps up is never disconnected, past 2MB total", async () => {
    // Regression test: the old cumulative byte counter tripped the
    // slow-reader disconnect for healthy clients once the *total* streamed
    // bytes passed the ceiling. Backpressure must be measured from the
    // live socket buffer instead.
    const TARGET = 12_000;
    let done = false;
    const readPromise = readSse(
      `${serverUrl}/api/live/${RUN_ID}/stream`,
      {},
      (f) => {
        let n = 0;
        for (const x of f) {
          if (x.event === "events") {
            n += (JSON.parse(x.data) as { events: GhostGlassEvent[] }).events.length;
          }
        }
        return n >= TARGET;
      },
      30_000,
    );
    // Feed the stream while the client reads; the reader drains the socket
    // so backpressure must stay low no matter how much total data flows.
    // Keep pushing until the reader has enough (it may connect late).
    const feed = (async () => {
      while (!done) {
        pushLive(2000);
        await sleep(50);
      }
    })();
    const frames = await readPromise;
    done = true;
    await feed;
    let seen = 0;
    for (const x of frames) {
      if (x.event === "events") {
        seen += (JSON.parse(x.data) as { events: GhostGlassEvent[] }).events.length;
      }
    }
    assert.ok(seen >= TARGET, `healthy client received ${seen} events`);
    assert.ok(
      !frames.some((x) => x.event === "error"),
      "healthy client must not receive a slow-reader error",
    );
  });

  it("a slow reader is disconnected with a resync error instead of ballooning server memory", async () => {
    // A client that reads much slower than the producer: the socket buffer
    // must fill, trip the 2MB slow-reader guard, and get disconnected with a
    // resync error frame. (A client that literally never reads can wedge TCP
    // flow control so the server's FIN is never observed; reading slowly is
    // the realistic slow-reader shape and lets the disconnect be observed.)
    const { get } = await import("node:http");
    let sawErrorFrame = false;
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("slow reader was not disconnected")), 20_000);
      const req = get(`${serverUrl}/api/live/${RUN_ID}/stream`, (res) => {
        assert.equal(res.statusCode, 200);
        // Don't read during the burst: the socket buffer fills and trips the
        // guard. Start reading after 2s (all pushes are done by then) to
        // observe the error frame and the disconnect.
        setTimeout(() => {
          res.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("slow reader")) sawErrorFrame = true;
          });
        }, 2000);
        res.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      req.on("error", () => {
        // Connection destroyed server-side counts as a disconnect too.
        clearTimeout(timer);
        resolve();
      });
    });
    // Wait for the server to register the slow subscriber, then push well
    // past the 2MB ceiling.
    const subscribedAt = Date.now();
    while (liveSubs.length === 0 && Date.now() - subscribedAt < 10_000) {
      await sleep(50);
    }
    assert.ok(liveSubs.length > 0, "client subscribed");
    for (let i = 0; i < 20; i++) {
      pushLive(2000);
      await sleep(20);
    }
    await closed;
    // The server destroyed the connection instead of buffering forever, and
    // told the client to resync.
    assert.ok(sawErrorFrame, "slow client should receive the resync error frame");
  });
});
