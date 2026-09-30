/**
 * Tests for `ghostglass open`: run-ID resolution and the CLI lifecycle.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { resolveRunId } from "../src/cli/commands/open.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliJs = join(here, "..", "src", "cli.js");

function writeRunDir(cwd: string, runId: string, mtimeMs: number): void {
  const dir = join(cwd, ".ghostglass", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const meta = {
    ghostglassVersion: "0.2.0",
    runId,
    command: ["true"],
    commandLine: "true",
    startTime: new Date(mtimeMs).toISOString(),
    endTime: new Date(mtimeMs).toISOString(),
    durationMs: 1,
    os: { platform: "linux", arch: "x64", release: "test" },
    exitCode: 0,
    signal: null,
    interrupted: false,
    backend: "strace",
    eventCount: 0,
    parseStats: { totalLines: 0, events: 0, skipped: 0, malformed: 0 },
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId }));
  writeFileSync(join(dir, "events.jsonl"), "");
  const d = new Date(mtimeMs);
  utimesSync(join(dir, "metadata.json"), d, d);
}

/** Ask the OS for a currently-free TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe("ghostglass open", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "gg-open-test-"));
    const now = Date.now();
    writeRunDir(cwd, "gg_20260930_010", now - 20000);
    writeRunDir(cwd, "gg_20260930_011", now - 10000);
    writeRunDir(cwd, "gg_20260930_012", now);
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("resolveRunId: latest picks the newest run", async () => {
    assert.equal(await resolveRunId(cwd, "latest"), "gg_20260930_012");
  });

  it("resolveRunId: explicit IDs pass through", async () => {
    assert.equal(await resolveRunId(cwd, "gg_20260930_010"), "gg_20260930_010");
  });

  it("resolveRunId: rejects bad and unknown IDs", async () => {
    await assert.rejects(resolveRunId(cwd, "nope"), /Invalid run ID/);
    await assert.rejects(resolveRunId(cwd, "../../etc"), /Invalid run ID/);
    await assert.rejects(resolveRunId(cwd, "gg_20260930_099"), /Run not found/);
  });

  it("resolveRunId: errors when there are no runs", async () => {
    const empty = mkdtempSync(join(tmpdir(), "gg-open-empty-"));
    try {
      await assert.rejects(resolveRunId(empty, "latest"), /No saved GhostGlass runs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("open --no-browser starts a localhost server and stops on SIGINT", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [cliJs, "open", "latest", "--no-browser", "--port", String(port)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    try {
      // wait for the ready line
      const runPageUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for viewer to start")), 15000);
        const onData = (): void => {
          const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\S*/);
          if (m) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolve(m[0]);
          }
        };
        child.stdout.on("data", onData);
        onData();
      });
      const baseUrl = new URL(runPageUrl).origin;
      assert.ok(runPageUrl.includes(`:${port}`), `unexpected url ${runPageUrl}`);
      assert.ok(!runPageUrl.includes("0.0.0.0"), "must never bind 0.0.0.0");

      const res = await fetch(runPageUrl);
      assert.equal(res.status, 200);
      const runs = (await (await fetch(`${baseUrl}/api/runs`)).json()) as { runs: unknown[] };
      assert.equal(runs.runs.length, 3);

      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 10000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      assert.equal(code, 0, `viewer did not exit cleanly on SIGINT (code=${code})`);
      assert.ok(stdout.includes("stopped") || stderr.includes("stopped"), "expected a stop message");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("open rejects bad run IDs and bad ports cleanly", async () => {
    const cases: string[][] = [
      ["open", "nope", "--no-browser"],
      ["open", "gg_20260930_099", "--no-browser"],
      ["open", "latest", "--no-browser", "--port", "abc"],
      ["open", "latest", "--no-browser", "--port", "0"],
      ["open", "latest", "--no-browser", "--port", "-1"],
      ["open", "latest", "--no-browser", "--port", "99999"],
    ];
    for (const args of cases) {
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const c = spawn(process.execPath, [cliJs, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (out += d));
        const timer = setTimeout(() => {
          c.kill("SIGKILL");
          resolve({ code: null, out: out + "\n[TIMED OUT]" });
        }, 10000);
        c.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });
      assert.notEqual(r.code, 0, `expected failure for: ${args.join(" ")} (got: ${r.out.slice(0, 200)})`);
    }
  });
});
