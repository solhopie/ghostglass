/**
 * Regression test for the reported summary discrepancy ("421 writes" in a
 * terminal report vs "1,219 writes" supposedly actual).
 *
 * Both the terminal summary and summary.json are produced from the single
 * authoritative aggregation (buildSummary). This test locks that in:
 * every number rendered by formatSummaryText must equal the summary object
 * it was rendered from, and a real CLI run's stdout must match its
 * summary.json.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSummary } from "../src/summary/summarize.js";
import { formatSummaryText } from "../src/cli/format.js";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { RunMetadata } from "../src/storage/runStore.js";
import type { RunSummary } from "../src/summary/summarize.js";

function parseCount(text: string, label: string): number {
  // Handles both "1,219 writes" and "Processes:  2" renderings.
  // NOTE: literal single space (not \s+) so a trailing digit on the previous
  // line ("Exit Code: 0") cannot match across the newline.
  const after = text.match(new RegExp(`([\\d,]+) ${label}`));
  const before = text.match(new RegExp(`${label}:\\s*([\\d,]+)`));
  const m = after ?? before;
  assert.ok(m, `expected "${label}" in summary text`);
  return parseInt((m[1] as string).replace(/,/g, ""), 10);
}

describe("summary consistency (terminal vs summary.json)", () => {
  it("formatSummaryText renders exactly the summary's numbers", () => {
    const events: GhostGlassEvent[] = [];
    let n = 0;
    const push = (over: Partial<GhostGlassEvent>) =>
      events.push({
        id: `e${n++}`,
        runId: "gg_20260930_001",
        timestamp: 1000 + n,
        type: "file",
        action: "read",
        pid: 100,
        ...over,
      });
    for (let i = 0; i < 1219; i++) push({ action: "write", path: `/w${i}` });
    for (let i = 0; i < 638; i++) push({ action: "read", path: `/r${i}` });
    for (let i = 0; i < 173; i++) push({ action: "create", path: `/c${i}` });
    for (let i = 0; i < 15; i++) push({ action: "delete", path: `/d${i}` });
    for (let i = 0; i < 6; i++)
      push({ type: "network", action: "connect", pid: 100, ip: "93.184.216.34", port: 443 });
    push({ type: "process", action: "exec", pid: 100, executable: "/bin/sh" });
    push({ type: "process", action: "spawn", pid: 101, parentPid: 100 });

    const summary = buildSummary("gg_20260930_001", ["npm", "install", "express"], "npm install express", events, 4380, 0, null);
    const metadata = {
      ghostglassVersion: "0.1.0",
      runId: "gg_20260930_001",
      command: ["npm", "install", "express"],
      commandLine: "npm install express",
      startTime: "2026-09-30T00:00:00.000Z",
      endTime: "2026-09-30T00:00:04.380Z",
      durationMs: 4380,
      os: { platform: "linux", arch: "x64", release: "node" },
      exitCode: 0,
      signal: null,
      interrupted: false,
      backend: "strace",
      eventCount: events.length,
      parseStats: { totalLines: 0, events: 0, skipped: 0, malformed: 0 },
    } satisfies RunMetadata;

    const text = formatSummaryText(metadata, summary);
    assert.equal(parseCount(text, "reads"), summary.filesystem.read);
    assert.equal(parseCount(text, "writes"), summary.filesystem.write);
    assert.equal(parseCount(text, "creates"), summary.filesystem.create);
    assert.equal(parseCount(text, "deletes"), summary.filesystem.delete);
    assert.equal(parseCount(text, "connection attempts"), summary.network.attempts);
    assert.equal(parseCount(text, "Processes"), summary.processCount);
    // The previously misreported figure must render as the true count.
    assert.equal(summary.filesystem.write, 1219);
    assert.ok(text.includes("1,219 writes"));
  });

  it("a real CLI run's stdout matches its summary.json (strace)", () => {
    let straceOk = false;
    try {
      straceOk = spawnSync("strace", ["-V"]).status === 0;
    } catch {
      straceOk = false;
    }
    if (!straceOk) return; // covered by parser/storage unit tests otherwise

    const here = dirname(fileURLToPath(import.meta.url));
    const cli = join(here, "..", "src", "cli.js");
    const workdir = mkdtempSync(join(tmpdir(), "gg-sumcheck-"));
    try {
      const r = spawnSync(process.execPath, [cli, "run", "--", process.execPath, "-e", "1"], {
        cwd: workdir,
        encoding: "utf8",
      });
      assert.equal(r.status, 0);
      const runId = readdirSync(join(workdir, ".ghostglass", "runs"))[0] as string;
      const saved = JSON.parse(
        readFileSync(join(workdir, ".ghostglass", "runs", runId, "summary.json"), "utf8"),
      ) as RunSummary;
      assert.equal(parseCount(r.stdout, "reads"), saved.filesystem.read);
      assert.equal(parseCount(r.stdout, "writes"), saved.filesystem.write);
      assert.equal(parseCount(r.stdout, "creates"), saved.filesystem.create);
      assert.equal(parseCount(r.stdout, "deletes"), saved.filesystem.delete);
      assert.equal(parseCount(r.stdout, "Processes"), saved.processCount);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
