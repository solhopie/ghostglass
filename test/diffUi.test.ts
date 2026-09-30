/**
 * Diff frontend tests (jsdom + built web/dist modules):
 * graph modes, entity toggles, stream filters, search, timeline
 * normalization, inspector rendering, and XSS-safe text rendering.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import type { GhostGlassEvent } from "../src/events/types.js";
import { ViewerServer } from "../src/viewer/server.js";

const BASE = 1_750_000_000_000;
const RUN_A = "gg_20260930_900";
const RUN_B = "gg_20260930_901";
const webDist = join(process.cwd(), "web", "dist");

let seq = 0;
function ev(partial: Partial<GhostGlassEvent> & { action: GhostGlassEvent["action"]; type: GhostGlassEvent["type"] }): GhostGlassEvent {
  seq += 1;
  return { id: `t-${seq}`, runId: RUN_A, timestamp: BASE + seq * 10, pid: 100, ...partial };
}

function writeRun(cwd: string, runId: string, events: GhostGlassEvent[], durationMs = 2000): void {
  const dir = join(cwd, ".ghostglass", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify({
      ghostglassVersion: "0.3.0",
      runId,
      command: ["node", "demo"],
      commandLine: "node demo",
      startTime: new Date(BASE).toISOString(),
      endTime: new Date(BASE + durationMs).toISOString(),
      durationMs,
      os: { platform: "linux", arch: "x64", release: "test" },
      exitCode: 0,
      signal: null,
      interrupted: false,
      backend: "strace",
      eventCount: events.length,
      parseStats: { totalLines: events.length, events: events.length, skipped: 0, malformed: 0 },
    }),
  );
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      runId,
      command: ["node", "demo"],
      commandLine: "node demo",
      durationMs,
      exitCode: 0,
      signal: null,
      processCount: 1,
      execCount: 1,
      eventCount: events.length,
      filesystem: { total: events.length, read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
      network: { attempts: 0, destinations: [] },
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("diff frontend", () => {
  let cwd: string;
  let server: ViewerServer;
  let serverUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let views: Record<string, any>;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "gg-diff-ui-"));
    const evA = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app", metadata: { syscall: "execve", argv: ["app"] } }),
      ev({ action: "exec", type: "process", pid: 200, parentPid: 100, executable: "/bin/worker", metadata: { syscall: "execve", argv: ["worker"] } }),
      ev({ action: "read", type: "file", pid: 200, path: "/tmp/worker.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/only-a.txt" }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
      // hostile trace string: must be rendered as text, never as HTML
      ev({ action: "read", type: "file", pid: 100, path: "<img src=x onerror=alert(1)>" }),
    ];
    const evB = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app", metadata: { syscall: "execve", argv: ["app"] } }),
      ev({ action: "exec", type: "process", pid: 200, parentPid: 100, executable: "/bin/worker", metadata: { syscall: "execve", argv: ["worker"] } }),
      ev({ action: "read", type: "file", pid: 200, path: "/tmp/worker.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/only-b.txt" }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
    ];
    writeRun(cwd, RUN_A, evA, 2000);
    writeRun(cwd, RUN_B, evB, 8000);

    server = new ViewerServer({ cwd, port: 0 });
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
    const origFetch = g["fetch"] as typeof fetch;
    g["fetch"] = (url: string | URL, init?: RequestInit) => origFetch(new URL(String(url), serverUrl), init);

    const mod = <T>(p: string): Promise<T> => import(pathToFileURL(join(webDist, p)).href) as Promise<T>;
    const StoreMod = await mod<{ DiffStore: new (a: string, b: string) => unknown }>("diffStore.js");
    const api = await mod<{ getDiff(a: string, b: string): Promise<unknown> }>("api.js");
    views = {
      DiffHeaderView: (await mod<{ DiffHeaderView: new (h: HTMLElement, s: unknown) => unknown }>("diffHeaderView.js")).DiffHeaderView,
      DiffGraphView: (await mod<{ DiffGraphView: new (h: HTMLElement, s: unknown) => unknown }>("diffGraphView.js")).DiffGraphView,
      DiffTimelineView: (await mod<{ DiffTimelineView: new (h: HTMLElement, s: unknown) => unknown }>("diffTimelineView.js")).DiffTimelineView,
      DiffStreamView: (await mod<{ DiffStreamView: new (h: HTMLElement, s: unknown) => unknown }>("diffStreamView.js")).DiffStreamView,
      DiffInspectorView: (await mod<{ DiffInspectorView: new (h: HTMLElement, s: unknown) => unknown }>("diffInspectorView.js")).DiffInspectorView,
    };
    store = new StoreMod.DiffStore(RUN_A, RUN_B);
    const diff = await api.getDiff(RUN_A, RUN_B);
    store.setDiff(diff);
  });

  after(async () => {
    await server.stop().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["window"];
    delete g["document"];
    delete g["fetch"];
  });

  function host(): HTMLElement {
    const d = document.createElement("div");
    document.getElementById("app")!.appendChild(d);
    return d as HTMLElement;
  }

  it("Differences Only hides shared nodes; All shows them", () => {
    const h = host();
    const view = new views.DiffGraphView(h, store);
    view.render();
    const diffOnly = h.querySelectorAll(".dnode").length;
    const sharedInDiffOnly = h.querySelectorAll(".dnode.dst-shared").length;
    assert.equal(sharedInDiffOnly, 0, "Differences Only shows no shared nodes");
    assert.ok(diffOnly > 0, "some difference nodes render");

    store.setGraphMode("all");
    view.render();
    const allNodes = h.querySelectorAll(".dnode").length;
    const sharedInAll = h.querySelectorAll(".dnode.dst-shared").length;
    assert.ok(allNodes > diffOnly, "All mode shows more nodes");
    assert.ok(sharedInAll > 0, "All mode includes shared nodes");
    store.setGraphMode("differences");
  });

  it("entity-type toggles hide that layer", () => {
    const h = host();
    const view = new views.DiffGraphView(h, store);
    store.setGraphMode("all");
    view.render();
    const filesBefore = h.querySelectorAll(".dnode-file").length;
    assert.ok(filesBefore > 0);
    store.setKindVisible("file", false);
    view.render();
    assert.equal(h.querySelectorAll(".dnode-file").length, 0);
    store.setKindVisible("file", true);
    store.setGraphMode("differences");
  });

  it("stream filters: side filter + search narrow the rows", () => {
    const h = host();
    const view = new views.DiffStreamView(h, store);
    view.render();
    const rows = () => h.querySelectorAll(".diff-stream-row").length;
    const total = rows();
    assert.ok(total > 0);

    store.setStreamFilter("only-a");
    view.render();
    const onlyA = rows();
    assert.ok(onlyA < total, "only-a filter narrows the stream");
    assert.ok(h.textContent!.includes("only-a.txt") || onlyA > 0);

    store.setStreamFilter("all");
    store.setSearch("only-b.txt");
    view.render();
    assert.ok(rows() < total, "search narrows the stream");
    store.setSearch("");
    store.setStreamFilter("all");
  });

  it("timeline normalization maps both bars to 100%", () => {
    // Run A = 2000ms, Run B = 8000ms (from the diff payload durations).
    const h = host();
    const view = new views.DiffTimelineView(h, store);
    view.render();
    const fills = () => [...h.querySelectorAll<HTMLElement>(".diff-timeline-fill")].map((e) => e.style.width);
    const [wA, wB] = fills();
    assert.ok(Math.abs(parseFloat(wB!) - 100) < 0.01);
    assert.ok(parseFloat(wA!) < 100, `real mode: shorter run narrower (${wA})`);

    store.setTimelineMode("normalized");
    view.render();
    const [nA, nB] = fills();
    assert.ok(Math.abs(parseFloat(nA!) - 100) < 0.01);
    assert.ok(Math.abs(parseFloat(nB!) - 100) < 0.01);
    store.setTimelineMode("real");
  });

  it("inspector renders A/B/Δ rows for a selected node", () => {
    const h = host();
    const view = new views.DiffInspectorView(h, store);
    const nodeId = store.nodeIdForEntity("network", "1.2.3.4:443");
    assert.ok(nodeId, "network node exists");
    store.select(nodeId);
    view.render();
    const txt = h.textContent ?? "";
    assert.ok(txt.includes("Network Difference"));
    assert.ok(txt.includes("Run A") && txt.includes("Run B"));
    store.select(null);
  });

  it("header renders run cards and the summary comparison", () => {
    const h = host();
    const view = new views.DiffHeaderView(h, store);
    view.render();
    const txt = h.textContent ?? "";
    assert.ok(txt.includes("GhostGlass Diff"));
    assert.ok(txt.includes("Run A") && txt.includes("Run B"));
    assert.ok(txt.includes("Duration"));
    assert.ok(h.querySelector("table.diff-summary"));
  });

  it("hostile trace strings are inert text, not HTML", () => {
    const h = host();
    const view = new views.DiffGraphView(h, store);
    store.setGraphMode("all");
    view.render();
    assert.equal(h.querySelectorAll("img").length, 0);
    assert.ok(h.innerHTML.includes("&lt;img"), "hostile path is escaped");
    store.setGraphMode("differences");
  });
});
