/**
 * Unit tests for run storage (IDs, JSONL round-trip, run listing)
 * and the summary builder. No strace needed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  allocateRun,
  writeEventsJsonl,
  writeJsonFile,
  readJsonFile,
  listRuns,
  commandLineString,
} from "../src/storage/runStore.js";
import { buildSummary } from "../src/summary/summarize.js";
import type { GhostGlassEvent } from "../src/events/types.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "gg-storage-test-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function sampleEvent(id: string, over: Partial<GhostGlassEvent> = {}): GhostGlassEvent {
  return {
    id,
    runId: "gg_20260930_001",
    timestamp: 1000,
    type: "file",
    action: "read",
    pid: 100,
    ...over,
  };
}

describe("run allocation", () => {
  it("allocates gg_YYYYMMDD_NNN ids and increments the sequence", async () => {
    const a = await allocateRun(workdir, new Date(2026, 8, 30, 1, 0, 0));
    const b = await allocateRun(workdir, new Date(2026, 8, 30, 2, 0, 0));
    assert.equal(a.runId, "gg_20260930_001");
    assert.equal(b.runId, "gg_20260930_002");
    assert.ok(a.runDir.endsWith(join(".ghostglass", "runs", "gg_20260930_001")));
  });

  it("restarts the sequence on a new day", async () => {
    const a = await allocateRun(workdir, new Date(2026, 8, 30));
    const b = await allocateRun(workdir, new Date(2026, 9, 1));
    assert.equal(a.runId, "gg_20260930_001");
    assert.equal(b.runId, "gg_20261001_001");
  });
});

describe("JSONL event storage", () => {
  it("round-trips events in chronological order", async () => {
    const { runDir } = await allocateRun(workdir);
    const events = [
      sampleEvent("e1", { timestamp: 1000 }),
      sampleEvent("e2", { timestamp: 2000 }),
      sampleEvent("e3", { timestamp: 1500 }),
    ];
    const path = join(runDir, "events.jsonl");
    await writeEventsJsonl(path, events);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l) as GhostGlassEvent);
    assert.deepEqual(
      parsed.map((e) => e.id),
      ["e1", "e2", "e3"],
    );
  });

  it("reads and writes metadata JSON", async () => {
    const { runDir } = await allocateRun(workdir);
    const path = join(runDir, "metadata.json");
    await writeJsonFile(path, { runId: "x", exitCode: 0 });
    assert.deepEqual(await readJsonFile(path), { runId: "x", exitCode: 0 });
  });
});

describe("run listing", () => {
  it("lists runs newest-first and skips incomplete dirs", async () => {
    const a = await allocateRun(workdir, new Date(2026, 8, 30, 1));
    const b = await allocateRun(workdir, new Date(2026, 8, 30, 2));
    await writeJsonFile(join(a.runDir, "metadata.json"), {
      runId: a.runId,
      commandLine: "echo a",
      startTime: "2026-09-30T01:00:00.000Z",
      durationMs: 10,
      exitCode: 0,
    });
    await writeJsonFile(join(b.runDir, "metadata.json"), {
      runId: b.runId,
      commandLine: "echo b",
      startTime: "2026-09-30T02:00:00.000Z",
      durationMs: 20,
      exitCode: 0,
    });
    // Incomplete run dir: no metadata.json — must not break the listing.
    await allocateRun(workdir, new Date(2026, 8, 30, 3));

    const runs = await listRuns(workdir);
    assert.deepEqual(
      runs.map((r) => r.runId),
      [b.runId, a.runId],
    );
  });

  it("returns an empty list when no runs exist", async () => {
    assert.deepEqual(await listRuns(workdir), []);
  });
});

describe("command line rendering", () => {
  it("quotes arguments containing spaces", () => {
    assert.equal(
      commandLineString(["node", "-e", "console.log(1)", "hello world"]),
      "node -e console.log(1) 'hello world'",
    );
  });
});

describe("summary builder", () => {
  it("aggregates filesystem, network, and process counts", () => {
    const events: GhostGlassEvent[] = [
      sampleEvent("e1", { type: "process", action: "exec", pid: 100, executable: "/bin/sh" }),
      sampleEvent("e2", { type: "process", action: "spawn", pid: 101, parentPid: 100 }),
      sampleEvent("e3", { type: "file", action: "read", pid: 100, path: "/a" }),
      sampleEvent("e4", { type: "file", action: "read", pid: 101, path: "/b" }),
      sampleEvent("e5", { type: "file", action: "write", pid: 100, path: "/c" }),
      sampleEvent("e6", { type: "file", action: "create", pid: 100, path: "/d" }),
      sampleEvent("e7", { type: "file", action: "delete", pid: 101, path: "/e" }),
      sampleEvent("e8", { type: "file", action: "rename", pid: 100, path: "/f" }),
      sampleEvent("e9", { type: "file", action: "mkdir", pid: 100, path: "/g" }),
      sampleEvent("e10", { type: "network", action: "connect", pid: 101, ip: "93.184.216.34", port: 443 }),
      sampleEvent("e11", { type: "network", action: "connect", pid: 101, ip: "93.184.216.34", port: 443 }),
      sampleEvent("e12", { type: "network", action: "connect", pid: 100, ip: "127.0.0.1", port: 9999 }),
    ];
    const s = buildSummary("gg_1", ["ls"], "ls", events, 4380, 0, null);
    assert.equal(s.processCount, 2);
    assert.equal(s.execCount, 1);
    assert.equal(s.eventCount, 12);
    assert.deepEqual(s.filesystem, {
      total: 7, read: 2, write: 1, create: 1, delete: 1, rename: 1, mkdir: 1,
    });
    assert.equal(s.network.attempts, 3);
    assert.deepEqual(s.network.destinations, ["127.0.0.1:9999", "93.184.216.34:443"]);
    assert.equal(s.durationMs, 4380);
    assert.equal(s.exitCode, 0);
  });
});
