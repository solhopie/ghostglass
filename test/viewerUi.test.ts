/**
 * Viewer frontend tests (jsdom): header, graph, stream, timeline, inspector,
 * replay seeking, filters, search, and XSS-safe rendering — driven against a
 * real ViewerServer serving a synthetic run.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { ViewerServer } from "../src/viewer/server.js";
import type { GhostGlassEvent } from "../src/events/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // dist/test -> repo root
const webDist = join(repoRoot, "web", "dist");

const BASE = 1_750_000_000_000;
const RUN_ID = "gg_20260930_910";
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

describe("viewer frontend", () => {
  let cwd: string;
  let server: ViewerServer;
  let serverUrl: string;

  interface TestGraphNode {
    id: string;
    kind: string;
  }
  interface TestGraph {
    nodes: TestGraphNode[];
    edges: { kind: string; from: string; to: string }[];
  }
  interface TestStore {
    graph: TestGraph | null;
    events: GhostGlassEvent[];
    playing: boolean;
    tMs: number;
    durationMs: number;
    selection: { kind: string; nodeId?: string; index?: number } | null;
    setRunData(metadata: unknown, summary: unknown, graph: TestGraph): void;
    setTimeline(startTimeMs: number, timestamps: number[]): void;
    appendEvents(events: GhostGlassEvent[], done: boolean): void;
    setGraphFilters(showFiles: boolean, showNetwork: boolean): void;
    seek(tMs: number): void;
    play(): void;
    select(sel: { kind: string; nodeId?: string; index?: number } | null): void;
  }
  interface ViewClass {
    new (host: HTMLElement, store: TestStore): { render(): void };
  }
  interface TestApi {
    getRunDetail(runId: string): Promise<{ metadata: unknown; summary: unknown }>;
    getGraph(runId: string): Promise<TestGraph>;
    getTimeline(runId: string): Promise<{ startTimeMs: number; timestamps: number[] }>;
    getEventsPage(
      runId: string,
      offset: number,
      limit: number,
    ): Promise<{ events: GhostGlassEvent[]; total: number }>;
  }

  let store: TestStore;
  let api: TestApi;
  let views: Record<"HeaderView" | "GraphView" | "TimelineView" | "StreamView" | "InspectorView", ViewClass>;
  let totalEvents = 0;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "gg-viewer-ui-"));
    const events: GhostGlassEvent[] = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app" }),
      ev({ action: "spawn", type: "process", pid: 101, parentPid: 100, executable: "/bin/worker" }),
    ];
    for (let i = 0; i < 120; i++) events.push(ev({ action: "read", type: "file", pid: 100, path: "/tmp/a.txt" }));
    for (let i = 0; i < 30; i++) events.push(ev({ action: "write", type: "file", pid: 101, path: "/tmp/b.txt" }));
    events.push(ev({ action: "create", type: "file", pid: 100, path: "/tmp/c.txt" }));
    events.push(ev({ action: "delete", type: "file", pid: 100, path: "/tmp/old.txt" }));
    events.push(ev({ action: "connect", type: "network", pid: 100, ip: "127.0.0.1", port: 8080 }));
    // hostile trace string: must be rendered as text, never as HTML
    events.push(ev({ action: "read", type: "file", pid: 100, path: "<img src=x onerror=alert(1)>" }));
    events.push(ev({ action: "exit", type: "process", pid: 101 }));
    totalEvents = events.length; // 157

    const dir = join(cwd, ".ghostglass", "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    const metadata = {
      ghostglassVersion: "0.2.0",
      runId: RUN_ID,
      command: ["node", "demo"],
      commandLine: "node demo --flag",
      startTime: new Date(BASE).toISOString(),
      endTime: new Date(BASE + 5000).toISOString(),
      durationMs: 5000,
      os: { platform: "linux", arch: "x64", release: "test" },
      exitCode: 0,
      signal: null,
      interrupted: false,
      backend: "strace",
      eventCount: events.length,
      parseStats: { totalLines: events.length, events: events.length, skipped: 0, malformed: 0 },
    };
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify({
        runId: RUN_ID,
        processCount: 2,
        filesystem: { total: 154, read: 121, write: 30, create: 1, delete: 1, rename: 0, mkdir: 0 },
        network: { attempts: 1 },
      }),
    );
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    server = new ViewerServer({ cwd });
    serverUrl = (await server.start()).url;

    const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
      url: serverUrl + "/",
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
    // route relative /api/* fetches to the test server
    const origFetch = g["fetch"] as typeof fetch;
    g["fetch"] = (url: string | URL, init?: RequestInit) => origFetch(new URL(String(url), serverUrl), init);

    const mod = <T>(p: string): Promise<T> => import(pathToFileURL(join(webDist, p)).href) as Promise<T>;
    const StoreMod = await mod<{ Store: new (runId: string) => TestStore }>("store.js");
    api = await mod<TestApi>("api.js");
    views = {
      HeaderView: (await mod<{ HeaderView: ViewClass }>("headerView.js")).HeaderView,
      GraphView: (await mod<{ GraphView: ViewClass }>("graphView.js")).GraphView,
      TimelineView: (await mod<{ TimelineView: ViewClass }>("timelineView.js")).TimelineView,
      StreamView: (await mod<{ StreamView: ViewClass }>("streamView.js")).StreamView,
      InspectorView: (await mod<{ InspectorView: ViewClass }>("inspectorView.js")).InspectorView,
    };
    store = new StoreMod.Store(RUN_ID);

    const detail = await api.getRunDetail(RUN_ID);
    const graph = await api.getGraph(RUN_ID);
    const timeline = await api.getTimeline(RUN_ID);
    store.setRunData(detail.metadata, detail.summary, graph);
    store.setTimeline(timeline.startTimeMs, timeline.timestamps);
    let offset = 0;
    for (;;) {
      const page = await api.getEventsPage(RUN_ID, offset, 5000);
      if (page.events.length === 0) break;
      offset += page.events.length;
      store.appendEvents(page.events, offset >= page.total);
      if (offset >= page.total) break;
    }
    assert.equal(store.events.length, totalEvents);
  });

  after(async () => {
    await server.stop().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["window"];
    delete g["document"];
    delete g["fetch"];
  });

  function container(): HTMLElement {
    const d = document.createElement("div");
    document.getElementById("app")!.appendChild(d);
    return d as HTMLElement;
  }

  function click(el: Element): void {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("header renders the run summary", () => {
    const c = container();
    new views.HeaderView(c, store).render();
    const cmd = c.querySelector(".header-cmd")!.textContent!;
    assert.ok(cmd.includes("node demo --flag"), `cmd: ${cmd}`);
    const stats = [...c.querySelectorAll(".hstat")].map((s) => s.textContent);
    assert.ok(stats.some((t) => t!.includes("154")), `stats: ${stats.join("|")}`);
    assert.ok(stats.some((t) => t!.includes("processes")), `stats: ${stats.join("|")}`);
  });

  it("graph renders one element per visible node and edge", () => {
    const c = container();
    new views.GraphView(c, store).render();
    const graph = store.graph;
    assert.ok(graph, "graph should be loaded");
    assert.equal(c.querySelectorAll(".node").length, graph.nodes.length);
    assert.equal(c.querySelectorAll(".edge").length, graph.edges.length);
    for (const kind of ["root", "process", "file", "network"]) {
      assert.ok(c.querySelector(`.node.node-${kind}`), `missing ${kind} node`);
    }
  });

  it("graph filters hide file and network nodes", () => {
    const c = container();
    new views.GraphView(c, store).render();
    const all = c.querySelectorAll(".node").length;
    store.setGraphFilters(false, true);
    assert.equal(c.querySelectorAll(".node.node-file").length, 0);
    assert.ok(c.querySelectorAll(".node").length < all);
    store.setGraphFilters(true, false);
    assert.equal(c.querySelectorAll(".node.node-network").length, 0);
    store.setGraphFilters(true, true);
    assert.equal(c.querySelectorAll(".node").length, all);
  });

  it("clicking a graph node selects it and shows the inspector", () => {
    const gc = container();
    const ic = container();
    new views.GraphView(gc, store).render();
    new views.InspectorView(ic, store).render();
    const fileNode = gc.querySelector(".node.node-file") as HTMLElement;
    assert.ok(fileNode);
    click(fileNode);
    assert.equal(store.selection?.kind, "node");
    const panel = ic.querySelector(".inspector-panel")!;
    assert.ok(panel.textContent!.includes("FILE"), `panel: ${panel.textContent!.slice(0, 80)}`);
    store.select(null);
  });

  it("replay seek activates graph nodes up to the cursor", () => {
    const c = container();
    new views.GraphView(c, store).render();
    store.seek(0);
    const activeAtStart = c.querySelectorAll(".node.active").length;
    store.seek(store.durationMs);
    const activeAtEnd = c.querySelectorAll(".node.active").length;
    assert.ok(activeAtEnd >= activeAtStart, `${activeAtStart} -> ${activeAtEnd}`);
    assert.ok(activeAtEnd > 0);
    store.seek(0);
  });

  it("stream renders rows, filters by action, and searches", async () => {
    const c = container();
    new views.StreamView(c, store).render();
    const rows = c.querySelectorAll(".stream-row").length;
    assert.ok(rows > 0 && rows < totalEvents, `rows: ${rows}`);
    // action filter via the real chips: every visible row must be a WRITE
    const writeBtn = [...c.querySelectorAll(".filter-btn")].find((b) => b.textContent === "WRITE") as HTMLElement;
    assert.ok(writeBtn);
    click(writeBtn);
    const writeRows = [...c.querySelectorAll(".stream-row")];
    assert.ok(writeRows.length > 0, "expected some write rows");
    assert.ok(
      writeRows.every((r) => (r.textContent ?? "").includes("WRITE b.tx")),
      `non-write row shown: ${writeRows.map((r) => r.textContent!.slice(0, 24)).join(" | ")}`,
    );
    click(writeBtn); // toggle the chip back off
    // search via the real input (debounced)
    const input = c.querySelector(".stream-search") as HTMLInputElement;
    input.value = "b.txt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    const searchRows = [...c.querySelectorAll(".stream-row")];
    assert.ok(searchRows.length > 0, "expected search hits");
    assert.ok(
      searchRows.every((r) => (r.textContent ?? "").includes("b.txt")),
      "every row should match the search query",
    );
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
  });

  it("clicking a stream row pauses and seeks the replay", () => {
    const c = container();
    new views.StreamView(c, store).render();
    store.play();
    assert.equal(store.playing, true);
    const row = c.querySelector(".stream-row") as HTMLElement;
    click(row);
    assert.equal(store.playing, false);
    assert.equal(store.selection?.kind, "event");
    store.select(null);
    store.seek(0);
  });

  it("timeline renders controls and a canvas", () => {
    const c = container();
    new views.TimelineView(c, store).render();
    const labels = [...c.querySelectorAll("button")].map((b) => b.textContent);
    for (const want of ["▶", "⏮", "⏭", "1x"]) {
      assert.ok(labels.includes(want), `missing control ${want}; got: ${labels.join(",")}`);
    }
    assert.ok(c.querySelector("canvas.timeline-canvas"));
  });

  it("timeline jump buttons seek the replay", () => {
    const c = container();
    new views.TimelineView(c, store).render();
    const btn = (t: string): HTMLElement => {
      const b = [...c.querySelectorAll("button")].find((x) => x.textContent === t) as HTMLElement;
      assert.ok(b, `missing button ${t}`);
      return b;
    };
    store.seek(0);
    click(btn("⏭"));
    assert.equal(store.tMs, store.durationMs);
    click(btn("⏮"));
    assert.equal(store.tMs, 0);
  });

  it("renders hostile trace strings as inert text", async () => {
    const c = container();
    new views.StreamView(c, store).render();
    const input = c.querySelector(".stream-search") as HTMLInputElement;
    input.value = "img src";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    const rows = c.querySelectorAll(".stream-row");
    assert.ok(rows.length > 0);
    assert.equal(c.querySelectorAll("img").length, 0, "no img element may be created from trace data");
    assert.ok(rows[0]!.textContent!.includes("<img src=x onerror=alert(1)>"));
    const gc = container();
    new views.GraphView(gc, store).render();
    assert.equal(gc.querySelectorAll("img").length, 0);
  });
});
