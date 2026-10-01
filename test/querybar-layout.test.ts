/**
 * Regression test for the Run 9 query-bar layout bug: the query bar was
 * added to the saved-run/live DOM without a grid row in #app, so
 * `grid-template-rows: auto minmax(0, 1fr) auto` squeezed it to its padding
 * (8px) and it never painted. bootRun/bootLive must opt #app into the
 * four-row layout via the has-querybar class; bootDiff must not.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { ViewerServer } from "../src/viewer/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // dist/test -> repo root
const webDist = join(repoRoot, "web", "dist");

const RUN_ID = "gg_20260930_920";
const BASE = 1_750_000_000_000;

function minimalRun(dir: string): void {
  const runDir = join(dir, ".ghostglass", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const events = [
    {
      id: `${RUN_ID}-000001`,
      runId: RUN_ID,
      timestamp: BASE + 10,
      sequence: 1,
      type: "process",
      action: "exec",
      pid: 100,
      executable: "/bin/app",
    },
    {
      id: `${RUN_ID}-000002`,
      runId: RUN_ID,
      timestamp: BASE + 20,
      sequence: 2,
      type: "file",
      action: "read",
      pid: 100,
      path: "/tmp/a.txt",
    },
    {
      id: `${RUN_ID}-000003`,
      runId: RUN_ID,
      timestamp: BASE + 30,
      sequence: 3,
      type: "process",
      action: "exit",
      pid: 100,
    },
  ];
  writeFileSync(
    join(runDir, "metadata.json"),
    JSON.stringify({
      ghostglassVersion: "0.9.0",
      runId: RUN_ID,
      command: ["node", "-e", ""],
      commandLine: "node -e ''",
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
    }),
  );
  writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify({
      runId: RUN_ID,
      processCount: 1,
      filesystem: { total: 1, read: 1, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
      network: { attempts: 0 },
    }),
  );
}

async function bootAt(url: string): Promise<{ dom: JSDOM; app: HTMLElement }> {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url,
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
  g["sessionStorage"] = dom.window.sessionStorage;
  g["requestAnimationFrame"] = dom.window.requestAnimationFrame.bind(dom.window);
  g["cancelAnimationFrame"] = dom.window.cancelAnimationFrame.bind(dom.window);
  const origFetch = g["fetch"] as typeof fetch;
  const serverUrl = new URL(url).origin;
  g["fetch"] = (u: string | URL, init?: RequestInit) => origFetch(new URL(String(u), serverUrl), init);
  // Cache-bust so the module-level router in main.ts runs fresh per boot.
  await import(pathToFileURL(join(webDist, "main.js")).href + `?boot=${Date.now()}-${Math.random()}`);
  // Let the async boot sequence finish rendering.
  await new Promise((r) => setTimeout(r, 1500));
  const app = dom.window.document.getElementById("app") as unknown as HTMLElement;
  return { dom, app };
}

describe("query bar grid layout", () => {
  let cwd: string;
  let server: ViewerServer;
  let serverUrl: string;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "gg-querybar-"));
    minimalRun(cwd);
    server = new ViewerServer({ cwd });
    serverUrl = (await server.start()).url;
  });

  after(async () => {
    await server.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("bootRun opts #app into the four-row querybar layout", async () => {
    const { app } = await bootAt(`${serverUrl}/runs/${RUN_ID}`);
    assert.ok(app.classList.contains("has-querybar"), "#app must carry has-querybar on the run view");
    const bar = app.querySelector(".gg-querybar .qbar-input") as unknown as HTMLInputElement | null;
    assert.ok(bar, "the query bar input must render inside #app");
  });

  it("bootDiff leaves #app on the three-row layout", async () => {
    const { app } = await bootAt(`${serverUrl}/diff/${RUN_ID}/${RUN_ID}`);
    assert.ok(!app.classList.contains("has-querybar"), "#app must not carry has-querybar on the diff view");
  });
});
