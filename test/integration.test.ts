/**
 * End-to-end tests: drive the real built CLI through actual strace runs.
 *
 * Covers: command execution, exit-code preservation, process/filesystem/
 * network event capture, run metadata creation, JSONL storage, interrupted
 * commands, and arguments containing spaces.
 *
 * The whole file is skipped when strace is unavailable (parser unit tests
 * in parser.test.ts cover the normalization logic without strace).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { RunMetadata } from "../src/storage/runStore.js";
import type { RunSummary } from "../src/summary/summarize.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_JS = join(here, "..", "src", "cli.js");
const FIXTURE = join(here, "fixtures", "fixture.cjs");
const EXIT_CODE_FIXTURE = join(here, "fixtures", "exit-code.cjs");

function hasStrace(): boolean {
  try {
    return spawnSync("strace", ["-V"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const STRACE_AVAILABLE = hasStrace();

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
}

function readJsonl(path: string): GhostGlassEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GhostGlassEvent);
}

function runsRoot(cwd: string): string {
  return join(cwd, ".ghostglass", "runs");
}

function findRunByCommand(cwd: string, needle: string): string {
  for (const id of readdirSync(runsRoot(cwd))) {
    const meta = JSON.parse(
      readFileSync(join(runsRoot(cwd), id, "metadata.json"), "utf8"),
    ) as RunMetadata;
    if (meta.commandLine.includes(needle)) return id;
  }
  throw new Error(`no run found containing: ${needle}`);
}

describe("ghostglass CLI basics", () => {
  it("--version prints the package version", () => {
    const r = runCli(tmpdir(), ["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("--help lists the run, runs, and show commands", () => {
    const r = runCli(tmpdir(), ["--help"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("run"));
    assert.ok(r.stdout.includes("runs"));
    assert.ok(r.stdout.includes("show"));
  });

  it("run with no command prints usage and exits non-zero", () => {
    const r = runCli(tmpdir(), ["run"]);
    assert.notEqual(r.status, 0);
  });

  it("show with an unknown run id fails clearly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gg-show-test-"));
    try {
      const r = runCli(dir, ["show", "gg_20990101_999"]);
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes("No saved trace"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ghostglass end-to-end tracing", { skip: !STRACE_AVAILABLE }, () => {
  let workdir: string;

  before(() => {
    workdir = mkdtempSync(join(tmpdir(), "gg-e2e-"));
  });

  after(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("executes the command and records real activity", () => {
    const r = runCli(workdir, ["run", "--", process.execPath, FIXTURE]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("fixture done"), "traced command output passes through");

    const runId = findRunByCommand(workdir, "fixture.cjs");
    const runDir = join(runsRoot(workdir), runId);
    for (const f of ["metadata.json", "events.jsonl", "summary.json", "trace.log"]) {
      assert.ok(existsSync(join(runDir, f)), `${f} was written`);
    }

    const metadata = JSON.parse(
      readFileSync(join(runDir, "metadata.json"), "utf8"),
    ) as RunMetadata;
    assert.equal(metadata.runId, runId);
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.backend, "strace");
    assert.equal(metadata.interrupted, false);
    assert.ok(metadata.durationMs >= 0);
    assert.ok(metadata.startTime < metadata.endTime);
    // No environment secrets in the trace metadata.
    assert.ok(!("env" in metadata));
    assert.ok(!JSON.stringify(metadata).includes("PATH="));

    const events = readJsonl(join(runDir, "events.jsonl"));
    assert.ok(events.length > 50, `expected a rich trace, got ${events.length} events`);
    // Chronological order.
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        (events[i] as GhostGlassEvent).timestamp >= (events[i - 1] as GhostGlassEvent).timestamp,
        "events.jsonl is chronological",
      );
    }
    // The fixture's file lifecycle appears in the trace.
    assert.ok(
      events.some((e) => e.action === "create" && e.path?.endsWith("fixture-data.txt")),
      "file create captured",
    );
    assert.ok(
      events.some((e) => e.action === "write" && e.path?.endsWith("fixture-data.txt")),
      "file modify captured",
    );
    assert.ok(
      events.some((e) => e.action === "delete" && e.path?.endsWith("fixture-data.txt")),
      "file delete captured",
    );
    // The spawned child process appears with its parent link.
    const spawn = events.find((e) => e.action === "spawn");
    assert.ok(spawn, "child process spawn captured");
    assert.ok(spawn.parentPid !== undefined && spawn.parentPid > 0);
    // The localhost TCP connection appears as a network event.
    const conn = events.find(
      (e) => e.type === "network" && e.action === "connect" && e.ip === "127.0.0.1",
    );
    assert.ok(conn, "localhost connect captured");
    assert.ok(conn.port !== undefined && conn.port > 0);
    // Hostnames are never invented.
    assert.ok(events.every((e) => e.host === undefined));

    const summary = JSON.parse(
      readFileSync(join(runDir, "summary.json"), "utf8"),
    ) as RunSummary;
    assert.ok(summary.filesystem.create >= 1);
    assert.ok(summary.filesystem.delete >= 1);
    assert.ok(summary.network.attempts >= 1);
    assert.ok(summary.network.destinations.some((d) => d.startsWith("127.0.0.1:")));
    assert.ok(summary.processCount >= 2);
    assert.equal(summary.exitCode, 0);
  });

  it("preserves the traced command's exit code", () => {
    const r = runCli(workdir, ["run", "--", process.execPath, EXIT_CODE_FIXTURE]);
    assert.equal(r.status, 42);
    const runId = findRunByCommand(workdir, "exit-code.cjs");
    const metadata = JSON.parse(
      readFileSync(join(runsRoot(workdir), runId, "metadata.json"), "utf8"),
    ) as RunMetadata;
    assert.equal(metadata.exitCode, 42);
  });

  it("handles commands with arguments and spaces", () => {
    const r = runCli(workdir, [
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log(process.argv.slice(1).join('|'))",
      "hello world",
      "a  b",
    ]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("hello world|a  b"));
    const runId = findRunByCommand(workdir, "hello world");
    const metadata = JSON.parse(
      readFileSync(join(runsRoot(workdir), runId, "metadata.json"), "utf8"),
    ) as RunMetadata;
    assert.deepEqual(metadata.command.slice(-2), ["hello world", "a  b"]);
  });

  it("handles Ctrl+C gracefully and keeps a partial trace", async () => {
    const child: ChildProcess = spawn(
      process.execPath,
      [CLI_JS, "run", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { cwd: workdir, stdio: "pipe" },
    );
    // Let strace attach and the command start.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    child.kill("SIGINT");
    const closeInfo = await new Promise<{ code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ code }));
    });
    // 128 + SIGINT(2): conventional exit status for Ctrl+C.
    assert.equal(closeInfo.code, 130);

    const ids = readdirSync(runsRoot(workdir)).sort().reverse();
    const runId = ids[0] as string;
    const metadata = JSON.parse(
      readFileSync(join(runsRoot(workdir), runId, "metadata.json"), "utf8"),
    ) as RunMetadata;
    assert.equal(metadata.interrupted, true);
    assert.equal(metadata.signal, "SIGINT");
    assert.ok(existsSync(join(runsRoot(workdir), runId, "events.jsonl")));
  });

  it("runs lists recorded traces", () => {
    const r = runCli(workdir, ["runs"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("RUN ID"));
    assert.match(r.stdout, /gg_\d{8}_\d{3}/);
  });

  it("show displays a saved run summary", () => {
    const runId = findRunByCommand(workdir, "fixture.cjs");
    const r = runCli(workdir, ["show", runId]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(runId));
    assert.ok(r.stdout.includes("Exit Code"));
    assert.ok(r.stdout.includes("Filesystem"));
  });
});
