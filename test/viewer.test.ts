/**
 * Viewer backend tests: API, indexer, replay helpers, and server safety.
 *
 * Covers: real-run API loading, invalid run IDs, path traversal, empty and
 * interrupted traces, large-trace indexing, graph deduplication,
 * parent/child process relationships, timeline ordering, replay seeking,
 * event filtering, file/network aggregation, pagination, and shutdown.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:http";
import { ViewerServer } from "../src/viewer/server.js";
import { buildGraphFromEvents } from "../src/viewer/indexer.js";
import { eventIndexAt, eventIndexAtOrdered, buildTimelinePayload, filterEvents, describeEvent } from "../src/viewer/replay.js";
import type { EventFilter } from "../src/viewer/replay.js";
import type { GhostGlassEvent } from "../src/events/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliJs = join(here, "..", "src", "cli.js");

const BASE = 1_750_000_000_000;
let seq = 0;

function ev(
  partial: Partial<GhostGlassEvent> & {
    action: GhostGlassEvent["action"];
    type: GhostGlassEvent["type"];
  },
): GhostGlassEvent {
  seq += 1;
  const e: GhostGlassEvent = {
    id: `gg_20260930_900-${String(seq).padStart(6, "0")}`,
    runId: "gg_20260930_900",
    timestamp: BASE + seq * 10,
    pid: 100,
    ...partial,
  };
  return e;
}

function writeRun(
  cwd: string,
  runId: string,
  events: GhostGlassEvent[],
  metaOverrides: Record<string, unknown> = {},
): void {
  const dir = join(cwd, ".ghostglass", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const start = events.length > 0 ? (events[0] as GhostGlassEvent).timestamp : BASE;
  const metadata = {
    ghostglassVersion: "0.2.0",
    runId,
    command: ["node", "demo"],
    commandLine: "node demo",
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 1000).toISOString(),
    durationMs: 1000,
    os: { platform: "linux", arch: "x64", release: "test" },
    exitCode: 0,
    signal: null,
    interrupted: false,
    backend: "strace",
    eventCount: events.length,
    parseStats: { totalLines: events.length, events: events.length, skipped: 0, malformed: 0 },
    ...metaOverrides,
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({ runId, command: ["node", "demo"], commandLine: "node demo" }),
  );
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Raw HTTP GET with an explicit (non-normalized) path. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

describe("viewer backend", () => {
  let cwd: string;
  let realRunCwd: string;
  let server: ViewerServer;
  let port: number;
  let base: string;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "gg-viewer-test-"));

    // A real traced run of the deterministic demo fixture.
    realRunCwd = mkdtempSync(join(tmpdir(), "gg-viewer-real-"));
    const r = spawnSync(
      process.execPath,
      [cliJs, "run", "--", process.execPath, join(here, "..", "..", "test", "fixtures", "demo.cjs")],
      { cwd: realRunCwd, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(r.status, 0, `real demo run failed: ${r.stderr}`);

    server = new ViewerServer({ cwd, port: 0 });
    // port 0 is rejected by the CLI but the server class accepts it for tests
  });

  after(async () => {
    await server.stop().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(realRunCwd, { recursive: true, force: true });
  });

  it("starts on 127.0.0.1 and lists runs", async () => {
    writeRun(cwd, "gg_20260930_900", [ev({ action: "exec", type: "process", executable: "/bin/x" })]);
    const started = await server.start();
    port = started.port;
    base = started.url;
    assert.ok(base.startsWith("http://127.0.0.1:"), `unexpected url ${base}`);
    const res = await fetch(`${base}/api/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: { runId: string }[] };
    assert.ok(body.runs.some((r) => r.runId === "gg_20260930_900"));
  });

  it("loads a real traced run through the API", async () => {
    const realServer = new ViewerServer({ cwd: realRunCwd });
    const { url } = await realServer.start();
    try {
      const runs = (await (await fetch(`${url}/api/runs`)).json()) as { runs: { runId: string }[] };
      assert.equal(runs.runs.length, 1);
      const runId = runs.runs[0]!.runId;

      const detail = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
        metadata: { commandLine: string; exitCode: number };
      };
      assert.ok(detail.metadata.commandLine.includes("demo.cjs"));
      assert.equal(detail.metadata.exitCode, 0);

      const graph = (await (await fetch(`${url}/api/runs/${runId}/graph`)).json()) as {
        nodes: { kind: string; id: string }[];
        edges: { kind: string; from: string; to: string }[];
        truncatedFiles: boolean;
      };
      assert.ok(graph.nodes.some((n) => n.kind === "root"));
      assert.ok(graph.nodes.some((n) => n.kind === "process"));
      assert.ok(graph.nodes.some((n) => n.kind === "file"));
      assert.ok(graph.nodes.some((n) => n.kind === "network"));
      assert.ok(graph.edges.some((e) => e.kind === "exec" && e.from === "root"));
      // every spawn edge connects two distinct process nodes
      for (const e of graph.edges.filter((x) => x.kind === "spawn")) {
        assert.notEqual(e.from, e.to);
        assert.ok(e.from.startsWith("p:") && e.to.startsWith("p:"));
      }

      const timeline = (await (await fetch(`${url}/api/runs/${runId}/timeline`)).json()) as {
        timestamps: number[];
      };
      assert.ok(timeline.timestamps.length > 100);
      for (let i = 1; i < timeline.timestamps.length; i++) {
        assert.ok(timeline.timestamps[i]! >= timeline.timestamps[i - 1]!);
      }

      const page = (await (await fetch(`${url}/api/runs/${runId}/events?offset=0&limit=10`)).json()) as {
        total: number;
        events: GhostGlassEvent[];
      };
      assert.ok(page.total > 100);
      assert.equal(page.events.length, 10);

      const html = await fetch(`${url}/runs/${runId}`);
      assert.equal(html.status, 200);
      assert.ok((html.headers.get("content-type") ?? "").includes("text/html"));
    } finally {
      await realServer.stop();
    }
  });

  it("rejects invalid run IDs and never serves traversal", async () => {
    // ".." is normalized by the URL parser to /api/etc -> static fallback 404 (safe)
    const traversal = await fetch(`${base}/api/runs/../etc`);
    assert.equal(traversal.status, 404);
    for (const bad of ["nope", "gg_2026_1", "gg_20260930_", "gg-20260930-001"]) {
      const res = await fetch(`${base}/api/runs/${bad}`);
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
    }
    const encodedTraversal = await fetch(`${base}/api/runs/%2e%2e%2fetc`);
    assert.ok([400, 404].includes(encodedTraversal.status), "encoded traversal must not succeed");
  });

  it("rejects path traversal with 400", async () => {
    const attempts = [
      "/api/runs/..%2F..%2Fetc%2Fpasswd",
      "/api/runs/gg_20260930_900%2F..%2F..%2Fetc",
      "/api/runs/%2e%2e%2f%2e%2e%2fsecret",
      "/api/runs/gg_20260930_900/graph/..%2F..%2F..%2Fetc",
    ];
    for (const p of attempts) {
      const { status } = await rawGet(port, p);
      assert.ok(status === 400 || status === 404, `expected 400/404 for ${p}, got ${status}`);
    }
    // and the traversal must not have leaked anything sensitive
    const { body } = await rawGet(port, "/api/runs/..%2F..%2Fetc%2Fpasswd");
    assert.ok(!body.includes("root:"));
  });

  it("returns 404 for a well-formed but unknown run ID", async () => {
    const res = await fetch(`${base}/api/runs/gg_20260930_999`);
    assert.equal(res.status, 404);
  });

  it("handles an empty trace", async () => {
    writeRun(cwd, "gg_20260930_901", []);
    const graph = (await (await fetch(`${base}/api/runs/gg_20260930_901/graph`)).json()) as {
      nodes: unknown[];
      edges: unknown[];
    };
    assert.equal(graph.nodes.length, 1); // just the root
    assert.equal(graph.edges.length, 0);
    const timeline = (await (await fetch(`${base}/api/runs/gg_20260930_901/timeline`)).json()) as {
      timestamps: number[];
    };
    assert.deepEqual(timeline.timestamps, []);
    const page = (await (await fetch(`${base}/api/runs/gg_20260930_901/events`)).json()) as {
      total: number;
      events: unknown[];
    };
    assert.equal(page.total, 0);
    assert.deepEqual(page.events, []);
  });

  it("surfaces interrupted runs", async () => {
    writeRun(cwd, "gg_20260930_902", [ev({ action: "exec", type: "process" })], {
      interrupted: true,
      exitCode: null,
      signal: "SIGINT",
    });
    const detail = (await (await fetch(`${base}/api/runs/gg_20260930_902`)).json()) as {
      metadata: { interrupted: boolean; exitCode: number | null; signal: string | null };
    };
    assert.equal(detail.metadata.interrupted, true);
    assert.equal(detail.metadata.exitCode, null);
    assert.equal(detail.metadata.signal, "SIGINT");
  });

  it("indexes a large trace and caps file nodes", () => {
    const events: GhostGlassEvent[] = [ev({ action: "exec", type: "process", pid: 1 })];
    for (let i = 0; i < 60000; i++) {
      const pid = 1 + (i % 50);
      if (i % 3 === 0) events.push(ev({ action: "read", type: "file", pid, path: `/tmp/f${i % 5000}` }));
      else if (i % 3 === 1) events.push(ev({ action: "write", type: "file", pid, path: `/tmp/g${i % 700}` }));
      else events.push(ev({ action: "connect", type: "network", pid, ip: "127.0.0.1", port: 8000 + (i % 7) }));
    }
    const started = Date.now();
    const graph = buildGraphFromEvents(events, {
      runId: "gg_20260930_903",
      commandLine: "big",
      startTimeMs: BASE,
    });
    const elapsed = Date.now() - started;
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    assert.ok(fileNodes.length <= 600, `file nodes ${fileNodes.length} exceed cap`);
    assert.ok(graph.truncatedFiles > 0, "expected files to be truncated");
    assert.equal(graph.totalUniqueFiles, 5700);
    assert.ok(elapsed < 15000, `indexing 60k events took ${elapsed}ms`);
  });

  it("dedupes repeated file paths into a single node", () => {
    const events = [ev({ action: "exec", type: "process", pid: 7 })];
    for (let i = 0; i < 500; i++) events.push(ev({ action: "read", type: "file", pid: 7, path: "/etc/hosts" }));
    const graph = buildGraphFromEvents(events, {
      runId: "gg_20260930_904",
      commandLine: "x",
      startTimeMs: BASE,
    });
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    assert.equal(fileNodes.length, 1);
    assert.equal(fileNodes[0]!.eventCount, 500);
    const accessEdges = graph.edges.filter((e) => e.kind === "access");
    assert.equal(accessEdges.length, 1);
    assert.equal(accessEdges[0]!.eventCount, 500);
  });

  it("builds correct parent/child process relationships", () => {
    const events = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app" }),
      ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }),
      ev({ action: "spawn", type: "process", pid: 102, parentPid: 101 }),
      ev({ action: "read", type: "file", pid: 102, path: "/tmp/a" }),
    ];
    const graph = buildGraphFromEvents(events, {
      runId: "gg_20260930_905",
      commandLine: "x",
      startTimeMs: BASE,
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("p:100")!.parentPid, undefined);
    assert.equal(byId.get("p:101")!.parentPid, 100);
    assert.equal(byId.get("p:102")!.parentPid, 101);
    const spawnEdges = graph.edges.filter((e) => e.kind === "spawn");
    assert.deepEqual(
      spawnEdges.map((e) => [e.from, e.to]).sort(),
      [["p:100", "p:101"], ["p:101", "p:102"]],
    );
    const execEdges = graph.edges.filter((e) => e.kind === "exec");
    assert.equal(execEdges.length, 1);
    assert.equal(execEdges[0]!.from, "root");
    assert.equal(execEdges[0]!.to, "p:100");
  });

  it("sorts the timeline even when events arrive shuffled", async () => {
    const events = [
      ev({ action: "read", type: "file", pid: 1, path: "/a", timestamp: BASE + 300 }),
      ev({ action: "read", type: "file", pid: 1, path: "/b", timestamp: BASE + 100 }),
      ev({ action: "read", type: "file", pid: 1, path: "/c", timestamp: BASE + 200 }),
    ];
    writeRun(cwd, "gg_20260930_906", events);
    const timeline = (await (await fetch(`${base}/api/runs/gg_20260930_906/timeline`)).json()) as {
      timestamps: number[];
    };
    assert.deepEqual(timeline.timestamps, [BASE + 100, BASE + 200, BASE + 300]);
  });

  it("eventIndexAt binary-searches replay positions", () => {
    const ts = [10, 20, 30, 40];
    assert.equal(eventIndexAt(ts, 0), -1); // nothing at or before t=0
    assert.equal(eventIndexAt(ts, 9), -1);
    assert.equal(eventIndexAt(ts, 10), 0);
    assert.equal(eventIndexAt(ts, 15), 0);
    assert.equal(eventIndexAt(ts, 20), 1);
    assert.equal(eventIndexAt(ts, 39), 2);
    assert.equal(eventIndexAt(ts, 40), 3);
    assert.equal(eventIndexAt(ts, 1000), 3);
    assert.equal(eventIndexAt([], 50), -1);
  });

  it("eventIndexAtOrdered maps time positions to emission-ordered events", () => {
    // Emission order: A(100), B(300), C(200, reconstructed: emitted late,
    // timestamp early). timeOrder must resolve t=250 to C (index 2), not B.
    const events: Parameters<typeof eventIndexAtOrdered>[0] = [
      { timestamp: 100, sequence: 1 },
      { timestamp: 300, sequence: 2 },
      { timestamp: 200, sequence: 3 },
    ] as unknown as Parameters<typeof eventIndexAtOrdered>[0];
    const payload = buildTimelinePayload(0, events);
    assert.deepEqual(payload.timestamps, [100, 200, 300]);
    assert.deepEqual(payload.timeOrder, [0, 2, 1]);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 50), -1);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 100), 0);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 250), 2);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 300), 1);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 9999), 1);
  });

  it("buildTimelinePayload falls back to array order for old runs without sequences", () => {
    const events = [{ timestamp: 300 }, { timestamp: 100 }] as unknown as Parameters<
      typeof eventIndexAtOrdered
    >[0];
    const payload = buildTimelinePayload(0, events);
    assert.deepEqual(payload.timeOrder, [1, 0]);
    assert.equal(eventIndexAtOrdered(events, payload.timeOrder, 150), 1);
  });

  it("filterEvents filters by kind, action, and search text", () => {
    const events = [
      ev({ action: "read", type: "file", pid: 1, path: "/etc/hosts" }),
      ev({ action: "write", type: "file", pid: 2, path: "/tmp/out.log" }),
      ev({ action: "connect", type: "network", pid: 1, ip: "127.0.0.1", port: 8080 }),
      ev({ action: "exec", type: "process", pid: 3, executable: "/usr/bin/curl" }),
    ];
    const F = (f: Partial<EventFilter>) =>
      filterEvents(events, { kinds: null, actions: null, query: "", ...f });
    assert.equal(F({ kinds: new Set(["network"]) }).length, 1);
    assert.equal(F({ kinds: new Set(["file"]) }).length, 2);
    assert.equal(F({ actions: new Set(["read", "write"]) }).length, 2);
    assert.equal(F({ query: "curl" }).length, 1);
    assert.equal(F({ query: "OUT.LOG" }).length, 1);
    assert.equal(F({ query: "127.0.0.1" }).length, 1);
    assert.equal(F({}).length, 4);
    assert.equal(F({ query: "no-such-string" }).length, 0);
  });

  it("aggregates file activity per path", () => {
    const events = [ev({ action: "exec", type: "process", pid: 5 })];
    for (let i = 0; i < 3; i++) events.push(ev({ action: "read", type: "file", pid: 5, path: "/tmp/x" }));
    for (let i = 0; i < 2; i++) events.push(ev({ action: "write", type: "file", pid: 5, path: "/tmp/x" }));
    events.push(ev({ action: "delete", type: "file", pid: 5, path: "/tmp/x" }));
    const graph = buildGraphFromEvents(events, {
      runId: "gg_20260930_907",
      commandLine: "x",
      startTimeMs: BASE,
    });
    const node = graph.nodes.find((n) => n.kind === "file");
    assert.ok(node);
    assert.equal(node.stats.kind, "file");
    if (node.stats.kind === "file") {
      assert.equal(node.stats.read, 3);
      assert.equal(node.stats.write, 2);
      assert.equal(node.stats.delete, 1);
    }
  });

  it("aggregates network destinations", () => {
    const events = [ev({ action: "exec", type: "process", pid: 5 })];
    for (let i = 0; i < 3; i++)
      events.push(ev({ action: "connect", type: "network", pid: 5, ip: "93.184.216.34", port: 443 }));
    events.push(ev({ action: "connect", type: "network", pid: 5, ip: "127.0.0.1", port: 3000 }));
    const graph = buildGraphFromEvents(events, {
      runId: "gg_20260930_908",
      commandLine: "x",
      startTimeMs: BASE,
    });
    const netNodes = graph.nodes.filter((n) => n.kind === "network");
    assert.equal(netNodes.length, 2);
    const main = netNodes.find((n) => n.label === "93.184.216.34:443")!;
    assert.equal(main.eventCount, 3);
    assert.equal(main.stats.kind, "network");
    if (main.stats.kind === "network") assert.equal(main.stats.attempts, 3);
  });

  it("paginates events", async () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 250; i++) events.push(ev({ action: "read", type: "file", pid: 1, path: `/f${i}` }));
    writeRun(cwd, "gg_20260930_909", events);
    const p1 = (await (await fetch(`${base}/api/runs/gg_20260930_909/events?offset=0&limit=100`)).json()) as {
      total: number;
      events: GhostGlassEvent[];
    };
    const p2 = (await (await fetch(`${base}/api/runs/gg_20260930_909/events?offset=100&limit=100`)).json()) as {
      total: number;
      events: GhostGlassEvent[];
    };
    const p3 = (await (await fetch(`${base}/api/runs/gg_20260930_909/events?offset=200&limit=100`)).json()) as {
      total: number;
      events: GhostGlassEvent[];
    };
    assert.equal(p1.total, 250);
    assert.equal(p1.events.length, 100);
    assert.equal(p2.events.length, 100);
    assert.equal(p3.events.length, 50);
    assert.equal(p1.events[0]!.id, events[0]!.id);
    assert.equal(p2.events[0]!.id, events[100]!.id);
    // negative/NaN query params are clamped, not errors
    const bad = await fetch(`${base}/api/runs/gg_20260930_909/events?offset=abc&limit=-5`);
    assert.equal(bad.status, 200);
  });

  it("describeEvent renders safe one-line summaries", () => {
    const spawn = ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 });
    // parent → child direction
    assert.equal(describeEvent(spawn), "PID 100 → PID 101");
    const read = ev({ action: "read", type: "file", pid: 1, path: "/etc/hosts" });
    assert.equal(describeEvent(read), "READ hosts"); // basename only, by design
    const conn = ev({ action: "connect", type: "network", pid: 1, ip: "10.0.0.1", port: 443 });
    assert.ok(describeEvent(conn).includes("10.0.0.1:443"));
  });

  it("stop() closes the server", async () => {
    const s = new ViewerServer({ cwd });
    const { url, port: p } = await s.start();
    assert.equal((await fetch(`${url}/api/runs`)).status, 200);
    await s.stop();
    await assert.rejects(fetch(`${url}/api/runs`), /fetch failed|ECONNREFUSED/);
    assert.ok(p > 0);
  });
});
