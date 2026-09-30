/**
 * Diff viewer API tests: /api/diff/<a>/<b> and /diff/<a>/<b> routes,
 * ID validation, traversal rejection, and latest/previous resolution.
 *
 * Covers spec items: invalid/traversal run IDs, latest/previous aliases,
 * viewer API shape, and server shutdown.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhostGlassEvent } from "../src/events/types.js";
import { ViewerServer } from "../src/viewer/server.js";
import { resolveDiffRunIds } from "../src/cli/commands/diff.js";

const BASE = 1_750_000_000_000;
const RUN_A = "gg_20260930_900";
const RUN_B = "gg_20260930_901";
const RUN_C = "gg_20260930_902";

let seq = 0;
function ev(partial: Partial<GhostGlassEvent> & { action: GhostGlassEvent["action"]; type: GhostGlassEvent["type"] }): GhostGlassEvent {
  seq += 1;
  return { id: `t-${seq}`, runId: RUN_A, timestamp: BASE + seq * 10, pid: 100, ...partial };
}

function writeRun(cwd: string, runId: string, events: GhostGlassEvent[], startMs: number): void {
  const dir = join(cwd, ".ghostglass", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify({
      ghostglassVersion: "0.3.0",
      runId,
      command: ["node", "demo"],
      commandLine: "node demo",
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + 1000).toISOString(),
      durationMs: 1000,
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
      durationMs: 1000,
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

describe("diff viewer API", () => {
  let cwd: string;
  let server: ViewerServer;
  let port: number;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "gg-diff-api-"));
    const evA = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app", metadata: { syscall: "execve", argv: ["app"] } }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
    ];
    const evB = [
      ev({ action: "exec", type: "process", pid: 100, executable: "/bin/app", metadata: { syscall: "execve", argv: ["app"] } }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/only-b.txt" }),
    ];
    writeRun(cwd, RUN_A, evA, BASE);
    writeRun(cwd, RUN_B, evB, BASE + 60_000);
    writeRun(cwd, RUN_C, evA, BASE + 120_000);
    server = new ViewerServer({ cwd, port: 0 });
    const started = await server.start();
    port = started.port;
  });

  after(async () => {
    await server.stop().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("resolves latest/previous to the two newest runs", async () => {
    const [a, b] = await resolveDiffRunIds(cwd, "latest", "previous");
    assert.equal(a, RUN_C);
    assert.equal(b, RUN_B);
  });

  it("throws a clean error when fewer than two runs exist", async () => {
    const single = mkdtempSync(join(tmpdir(), "gg-diff-single-"));
    writeRun(single, RUN_A, [ev({ action: "exec", type: "process", pid: 100 })], BASE);
    await assert.rejects(() => resolveDiffRunIds(single, "latest", "previous"), /only 1 saved run/);
    rmSync(single, { recursive: true, force: true });
  });

  it("rejects unknown and invalid run IDs", async () => {
    await assert.rejects(() => resolveDiffRunIds(cwd, RUN_A, "gg_20200101_999"), /Run not found/);
    await assert.rejects(() => resolveDiffRunIds(cwd, "bogus-id!", RUN_A), /Invalid run ID/);
    await assert.rejects(() => resolveDiffRunIds(cwd, "../../../etc/passwd", RUN_A), /Invalid run ID/);
  });

  it("GET /api/diff/<a>/<b> returns the full diff shape", async () => {
    const { status, body } = await rawGet(port, `/api/diff/${RUN_A}/${RUN_B}`);
    assert.equal(status, 200);
    const diff = JSON.parse(body) as Record<string, unknown>;
    assert.equal((diff.runA as { runId: string }).runId, RUN_A);
    assert.equal((diff.runB as { runId: string }).runId, RUN_B);
    for (const key of ["summary", "processes", "files", "network", "graph", "stream"]) {
      assert.ok(key in diff, `diff has ${key}`);
    }
    const processes = diff.processes as { status: string }[];
    assert.ok(processes.length > 0);
    const graph = diff.graph as { nodes: { id: string; fingerprint: string }[]; edges: unknown[] };
    assert.ok(graph.nodes.every((n) => typeof n.fingerprint === "string" && n.fingerprint.length > 0));
  });

  it("GET /api/diff returns 404 for a missing run, 400 for invalid IDs", async () => {
    const missing = await rawGet(port, `/api/diff/${RUN_A}/gg_20200101_999`);
    assert.equal(missing.status, 404);
    const bad = await rawGet(port, `/api/diff/bad-id!/${RUN_A}`);
    assert.equal(bad.status, 400);
    const traversal = await rawGet(port, `/api/diff/..%2f..%2fetc%2fpasswd/${RUN_A}`);
    assert.equal(traversal.status, 400);
  });

  it("GET /diff/<a>/<b> serves the viewer page", async () => {
    const { status, body } = await rawGet(port, `/diff/${RUN_A}/${RUN_B}`);
    assert.equal(status, 200);
    assert.ok(body.includes('<div id="app"'));
    const notFound = await rawGet(port, `/diff/${RUN_A}/bad-id!`);
    assert.equal(notFound.status, 404);
  });

  it("server binds localhost only and shuts down cleanly", async () => {
    // stop() already runs in after(); here we verify a fresh server lifecycle.
    const s2 = new ViewerServer({ cwd, port: 0 });
    const { url } = await s2.start();
    assert.ok(url.startsWith("http://127.0.0.1:"));
    await s2.stop();
  });
});
