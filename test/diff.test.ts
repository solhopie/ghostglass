/**
 * Diff engine tests: fingerprints, entity matching, summary deltas, stream
 * generation, graph wiring, and large-trace performance.
 *
 * Covers the spec's engine cases: identical runs, different commands,
 * PID-independent process matching, only-a/only-b entities, changed
 * counts, durations, exit codes, interrupted status, fingerprint
 * stability, ambiguous matching, and 10k+ event performance.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { RunSummary } from "../src/summary/summarize.js";
import { fileFingerprint, networkFingerprint, processFingerprint } from "../src/diff/fingerprints.js";
import { compareRuns, type RunData } from "../src/diff/compareRuns.js";
import { formatDiffText } from "../src/cli/commands/diff.js";

const BASE = 1_750_000_000_000;
let seq = 0;

function ev(
  partial: Partial<GhostGlassEvent> & {
    action: GhostGlassEvent["action"];
    type: GhostGlassEvent["type"];
  },
): GhostGlassEvent {
  seq += 1;
  return {
    id: `t-${String(seq).padStart(6, "0")}`,
    runId: "gg_20260930_900",
    timestamp: BASE + seq * 10,
    pid: 100,
    ...partial,
  };
}

function execEv(pid: number, executable: string, argv: string[], parentPid?: number): GhostGlassEvent {
  const partial: Partial<GhostGlassEvent> & {
    action: GhostGlassEvent["action"];
    type: GhostGlassEvent["type"];
  } = {
    action: "exec",
    type: "process",
    pid,
    executable,
    metadata: { syscall: "execve", argv },
  };
  if (parentPid !== undefined) partial.parentPid = parentPid;
  return ev(partial);
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "gg_20260930_900",
    command: ["node", "demo"],
    commandLine: "node demo",
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    processCount: 1,
    execCount: 1,
    eventCount: 0,
    filesystem: { total: 0, read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
    network: { attempts: 0, destinations: [] },
    ...overrides,
  };
}

function runData(
  runId: string,
  events: GhostGlassEvent[],
  meta: Record<string, unknown> = {},
  sum: Partial<RunSummary> = {},
): RunData {
  const metadata = {
    ghostglassVersion: "0.3.0",
    runId,
    command: ["node", "demo"],
    commandLine: "node demo",
    startTime: new Date(BASE).toISOString(),
    endTime: new Date(BASE + 1000).toISOString(),
    durationMs: 1000,
    os: { platform: "linux", arch: "x64", release: "test" },
    exitCode: 0,
    signal: null,
    interrupted: false,
    backend: "strace",
    eventCount: events.length,
    parseStats: { totalLines: events.length, events: events.length, skipped: 0, malformed: 0 },
    ...meta,
  } as RunData["metadata"];
  const s = summary({ runId, eventCount: events.length, ...sum });
  return { metadata, summary: s, events };
}

function findProcess(diff: ReturnType<typeof compareRuns>, label: string) {
  return diff.processes.find((p) => p.label === label);
}

describe("diff engine", () => {
  it("identical runs: everything shared, empty difference stream", () => {
    const events = [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/x.txt" }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
    ];
    const a = runData("gg_20260930_901", events);
    const b = runData("gg_20260930_902", events.map((e) => ({ ...e, id: e.id + "b" })));
    const diff = compareRuns(a, b);
    assert.ok(diff.processes.length > 0);
    assert.ok(diff.processes.every((p) => p.status === "shared"));
    assert.ok(diff.files.every((f) => f.status === "shared"));
    assert.ok(diff.network.every((n) => n.status === "shared"));
    assert.ok(diff.stream.every((i) => i.itemKind === "changed") === false || diff.stream.length === 0);
    assert.equal(diff.stream.length, 0);
    assert.equal(diff.summary.durationMs.delta, 0);
    assert.equal(diff.summary.exitCode.changed, false);
  });

  it("different commands: root processes are only-a / only-b", () => {
    const a = runData("gg_20260930_901", [execEv(100, "/usr/bin/node", ["node", "a.cjs"])]);
    const b = runData("gg_20260930_902", [execEv(100, "/usr/bin/node", ["node", "b.cjs"])]);
    const diff = compareRuns(a, b);
    assert.equal(diff.processes.filter((p) => p.status === "only-a").length, 1);
    assert.equal(diff.processes.filter((p) => p.status === "only-b").length, 1);
    assert.equal(diff.processes.filter((p) => p.status === "shared").length, 0);
  });

  it("matches equivalent processes across different PIDs", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      execEv(1201, "/usr/bin/worker", ["worker", "--fast"]),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      execEv(8912, "/usr/bin/worker", ["worker", "--fast"]),
    ]);
    const diff = compareRuns(a, b);
    const worker = findProcess(diff, "worker");
    assert.ok(worker);
    assert.equal(worker.status, "shared");
    assert.deepEqual(worker.a?.pids, [1201]);
    assert.deepEqual(worker.b?.pids, [8912]);
    assert.equal(worker.ambiguous, false);
  });

  it("process only in A / only in B", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      execEv(101, "/bin/only-a", ["only-a"]),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      execEv(102, "/bin/only-b", ["only-b"]),
    ]);
    const diff = compareRuns(a, b);
    assert.equal(findProcess(diff, "only-a")?.status, "only-a");
    assert.equal(findProcess(diff, "only-b")?.status, "only-b");
    assert.equal(findProcess(diff, "app")?.status, "shared");
  });

  it("file only in A / only in B", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/only-a.txt" }),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/only-b.txt" }),
    ]);
    const diff = compareRuns(a, b);
    const fa = diff.files.find((f) => f.path === "/tmp/only-a.txt");
    const fb = diff.files.find((f) => f.path === "/tmp/only-b.txt");
    assert.equal(fa?.status, "only-a");
    assert.equal(fb?.status, "only-b");
    // only-a file events land in the difference stream
    const streamPaths = diff.stream
      .filter((i) => i.itemKind === "event" && i.entityKind === "file")
      .map((i) => (i.itemKind === "event" ? i.event.path : null));
    assert.ok(streamPaths.includes("/tmp/only-a.txt"));
    assert.ok(streamPaths.includes("/tmp/only-b.txt"));
  });

  it("shared file with changed counts", () => {
    const readsA = Array.from({ length: 3 }, () =>
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
    );
    const readsB = Array.from({ length: 5 }, () =>
      ev({ action: "read", type: "file", pid: 100, path: "/tmp/shared.txt" }),
    );
    const a = runData("gg_20260930_901", [execEv(100, "/bin/app", ["app"]), ...readsA]);
    const b = runData("gg_20260930_902", [execEv(100, "/bin/app", ["app"]), ...readsB]);
    const diff = compareRuns(a, b);
    const f = diff.files.find((x) => x.path === "/tmp/shared.txt");
    assert.ok(f);
    assert.equal(f.status, "changed");
    assert.equal(f.a?.read, 3);
    assert.equal(f.b?.read, 5);
    // changed entities get a summary row in the stream
    const changed = diff.stream.find(
      (i) => i.itemKind === "changed" && i.entityKind === "file" && i.label === "shared.txt",
    );
    assert.ok(changed);
  });

  it("network only in A / only in B, and changed counts", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "connect", type: "network", pid: 100, ip: "10.0.0.1", port: 80 }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
      ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "connect", type: "network", pid: 100, ip: "10.0.0.2", port: 80 }),
      ...Array.from({ length: 7 }, () =>
        ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 443 }),
      ),
    ]);
    const diff = compareRuns(a, b);
    assert.equal(diff.network.find((n) => n.endpoint === "10.0.0.1:80")?.status, "only-a");
    assert.equal(diff.network.find((n) => n.endpoint === "10.0.0.2:80")?.status, "only-b");
    const changed = diff.network.find((n) => n.endpoint === "1.2.3.4:443");
    assert.equal(changed?.status, "changed");
    assert.equal(changed?.a?.attempts, 2);
    assert.equal(changed?.b?.attempts, 7);
  });

  it("summary deltas: durations, counts, exit codes, interrupted", () => {
    const a = runData(
      "gg_20260930_901",
      [execEv(100, "/bin/app", ["app"])],
      { durationMs: 4230, exitCode: 0, interrupted: false },
      { durationMs: 4230, processCount: 12, eventCount: 4901, network: { attempts: 17, destinations: [] } },
    );
    const b = runData(
      "gg_20260930_902",
      [execEv(100, "/bin/app", ["app"])],
      { durationMs: 6810, exitCode: 1, interrupted: true },
      { durationMs: 6810, processCount: 17, eventCount: 6211, network: { attempts: 24, destinations: [] } },
    );
    const diff = compareRuns(a, b);
    assert.equal(diff.summary.durationMs.delta, 2580);
    assert.equal(diff.summary.processCount.delta, 5);
    assert.equal(diff.summary.eventCount.delta, 1310);
    assert.equal(diff.summary.networkAttempts.delta, 7);
    assert.equal(diff.summary.exitCode.changed, true);
    assert.deepEqual([diff.summary.exitCode.a, diff.summary.exitCode.b], [0, 1]);
    assert.equal(diff.summary.interrupted.changed, true);
    assert.deepEqual([diff.summary.interrupted.a, diff.summary.interrupted.b], [false, true]);
  });

  it("fingerprint stability: same input, same fingerprint", () => {
    const fp1 = processFingerprint("/usr/bin/node", ["node", "a.cjs"], "/bin/bash");
    const fp2 = processFingerprint("/usr/bin/node", ["node", "a.cjs"], "/bin/bash");
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, processFingerprint("/usr/bin/node", ["node", "b.cjs"], "/bin/bash"));
    assert.notEqual(fp1, processFingerprint("/usr/bin/node", ["node", "a.cjs"], "/bin/sh"));
    assert.notEqual(fp1, processFingerprint("/usr/bin/node", null, "/bin/bash"));
    assert.equal(fileFingerprint("/tmp/x.txt"), "/tmp/x.txt");
    // temp files with random names never merge
    assert.notEqual(fileFingerprint("/tmp/foo-a1b2/x"), fileFingerprint("/tmp/foo-c3d4/x"));
    assert.equal(networkFingerprint("1.2.3.4", 443), "1.2.3.4:443");
  });

  it("ambiguous process matching is flagged, not invented", () => {
    // 3 identical workers in A, 2 in B: same fingerprint, aggregated, flagged.
    const workersA = [101, 102, 103].map((pid) => execEv(pid, "/usr/bin/worker", ["worker"]));
    const workersB = [201, 202].map((pid) => execEv(pid, "/usr/bin/worker", ["worker"]));
    const a = runData("gg_20260930_901", [execEv(100, "/bin/app", ["app"]), ...workersA]);
    const b = runData("gg_20260930_902", [execEv(100, "/bin/app", ["app"]), ...workersB]);
    const diff = compareRuns(a, b);
    const worker = findProcess(diff, "worker");
    assert.ok(worker);
    assert.equal(worker.ambiguous, true);
    assert.equal(worker.a?.pids.length, 3);
    assert.equal(worker.b?.pids.length, 2);
    // one entity, not 3x2 invented pairs
    assert.equal(diff.processes.filter((p) => p.label === "worker").length, 1);
  });

  it("parent executable disambiguates identical workers", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/launcher-a", ["launcher-a"]),
      { ...ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }) },
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/launcher-b", ["launcher-b"]),
      { ...ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }) },
    ]);
    void a;
    void b;
    // direct fingerprint check: same exe+argv, different parent -> different fp
    const fpA = processFingerprint("/usr/bin/worker", ["worker"], "/bin/launcher-a");
    const fpB = processFingerprint("/usr/bin/worker", ["worker"], "/bin/launcher-b");
    assert.notEqual(fpA, fpB);
  });

  it("combined graph wires spawn/access/connect edges across sides", () => {
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }),
      execEv(101, "/bin/child", ["child"]),
      ev({ action: "read", type: "file", pid: 101, path: "/tmp/data.txt" }),
      ev({ action: "connect", type: "network", pid: 100, ip: "9.9.9.9", port: 53 }),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      ev({ action: "spawn", type: "process", pid: 101, parentPid: 100 }),
      execEv(101, "/bin/child", ["child"]),
      ev({ action: "read", type: "file", pid: 101, path: "/tmp/data.txt" }),
    ]);
    const diff = compareRuns(a, b);
    const byId = new Map(diff.graph.nodes.map((n) => [n.id, n]));
    const spawn = diff.graph.edges.find((e) => e.kind === "spawn");
    assert.ok(spawn, "spawn edge present");
    assert.equal(spawn.status, "shared");
    assert.equal(byId.get(spawn.from)?.kind, "process");
    assert.equal(byId.get(spawn.to)?.kind, "process");
    const access = diff.graph.edges.find((e) => e.kind === "access");
    assert.ok(access);
    assert.equal(byId.get(access.to)?.kind, "file");
    const connect = diff.graph.edges.find((e) => e.kind === "connect");
    assert.ok(connect, "connect edge present");
    assert.equal(connect.status, "only-a");
    assert.equal(byId.get(connect.to)?.kind, "network");
    // every edge references a real node
    for (const e of diff.graph.edges) {
      assert.ok(byId.has(e.from), `edge from ${e.from} resolves`);
      assert.ok(byId.has(e.to), `edge to ${e.to} resolves`);
    }
  });

  it("unknown-identity processes never merge across runs", () => {
    // No exec events: executable and argv are both unknown (e.g. threads,
    // or children whose execve the parser skipped as unfinished/resumed).
    const mkUnknowns = (pids: number[]) =>
      pids.map((pid) => ev({ action: "read", type: "file", pid, path: "/tmp/x.txt" }));
    const a = runData("gg_20260930_901", [
      execEv(100, "/bin/app", ["app"]),
      ...mkUnknowns([201, 202, 203]),
    ]);
    const b = runData("gg_20260930_902", [
      execEv(100, "/bin/app", ["app"]),
      ...mkUnknowns([301, 302]),
    ]);
    const diff = compareRuns(a, b);
    const unknowns = diff.processes.filter((p) => p.label.startsWith("Unknown ("));
    // one aggregated entity per side, never a cross-run merge
    assert.equal(unknowns.length, 2);
    assert.ok(unknowns.some((u) => u.status === "only-a" && u.a?.pids.length === 3));
    assert.ok(unknowns.some((u) => u.status === "only-b" && u.b?.pids.length === 2));
    // and they still wire into the graph
    const nodeIds = new Set(diff.graph.nodes.map((n) => n.id));
    for (const u of unknowns) {
      const node = diff.graph.nodes.find((n) => n.fingerprint === u.fingerprint);
      assert.ok(node, "unknown entity has a graph node");
      assert.ok(nodeIds.has(node.id));
    }
  });

  it("large traces compare in practical time (10k+ events per run)", () => {
    const big = (seedPid: number): GhostGlassEvent[] => {
      const events: GhostGlassEvent[] = [execEv(seedPid, "/bin/app", ["app"])];
      for (let i = 0; i < 12000; i++) {
        const kind = i % 3;
        if (kind === 0) {
          events.push(ev({ action: "read", type: "file", pid: seedPid, path: `/tmp/f${i % 400}.dat` }));
        } else if (kind === 1) {
          events.push(ev({ action: "write", type: "file", pid: seedPid, path: `/tmp/g${i % 400}.dat` }));
        } else {
          events.push(
            ev({ action: "connect", type: "network", pid: seedPid, ip: "10.0.0.1", port: 8000 + (i % 10) }),
          );
        }
      }
      return events;
    };
    const a = runData("gg_20260930_901", big(100));
    const b = runData("gg_20260930_902", big(5000));
    const t0 = Date.now();
    const diff = compareRuns(a, b);
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `compareRuns took ${ms}ms for 24k events`);
    assert.ok(diff.files.length > 0);
    assert.ok(diff.network.length > 0);
    assert.equal(diff.streamTruncated, false);
  });

  it("CLI text shows compact A/B/Δ summary", () => {
    const a = runData(
      "gg_20260930_901",
      [execEv(100, "/bin/app", ["app"])],
      { commandLine: "npm install express", durationMs: 4230, exitCode: 0 },
      { durationMs: 4230, processCount: 12 },
    );
    const b = runData(
      "gg_20260930_902",
      [execEv(100, "/bin/app", ["app"])],
      { commandLine: "npm install fastify", durationMs: 6810, exitCode: 0 },
      { durationMs: 6810, processCount: 17 },
    );
    const text = formatDiffText(compareRuns(a, b));
    assert.ok(text.includes("GhostGlass Diff"));
    assert.ok(text.includes("npm install express"));
    assert.ok(text.includes("npm install fastify"));
    assert.ok(text.includes("Δ"));
    assert.ok(text.includes("Viewer") === false, "formatDiffText has no viewer URL; the command adds it");
  });
});
