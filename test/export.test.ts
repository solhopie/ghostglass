/**
 * Run 4 — portable HTML/JSON export tests.
 *
 * Covers the export spec: run/diff HTML + JSON export, latest/previous
 * resolution, output paths, --force semantics, format validation, run ID
 * validation, traversal rejection, all four redaction flags with
 * source-level verification, injection/malformed-Unicode hardening, zero
 * external network dependencies, graph/timeline/inspector data presence,
 * diff classifications, large-trace export, deterministic structure,
 * filename sanitization, and JSON schema correctness.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { RunMetadata } from "../src/storage/runStore.js";
import type { RunSummary } from "../src/summary/summarize.js";
import { buildRunExportModel } from "../src/export/exportRun.js";
import { buildDiffExportModel } from "../src/export/exportDiff.js";
import { buildDiffExportHtml, buildRunExportHtml, PRINT_CSS } from "../src/export/htmlBuilder.js";
import { buildDiffJsonExport, buildRunJsonExport } from "../src/export/jsonExport.js";
import { loadExportAssets } from "../src/export/assetBundler.js";
import {
  defaultDiffFileName,
  defaultRunFileName,
  exportCommand,
  exportDiffCommand,
  formatBytes,
  resolveExportFormat,
} from "../src/cli/commands/export.js";
import {
  escapeForScriptJson,
  escapeHtml,
  safeFileName,
  sanitizeLoneSurrogates,
} from "../src/export/sanitize.js";
import { scrubInlineScript } from "../src/export/htmlBuilder.js";

const BASE = 1_750_000_000_000;
const RUN_A = "gg_20260930_910";
const RUN_B = "gg_20260930_911";
let seq = 0;
let tmpRoot = "";

function ev(
  partial: Partial<GhostGlassEvent> & { action: GhostGlassEvent["action"]; type: GhostGlassEvent["type"] },
  runId = RUN_A,
): GhostGlassEvent {
  seq += 1;
  return {
    id: `${runId}-${String(seq).padStart(6, "0")}`,
    runId,
    timestamp: BASE + seq * 10,
    pid: 100,
    ...partial,
  };
}

function execEv(pid: number, executable: string, argv: string[], runId = RUN_A): GhostGlassEvent {
  return ev(
    { action: "exec", type: "process", pid, executable, metadata: { syscall: "execve", argv } },
    runId,
  );
}

function fileEv(
  action: "read" | "write" | "create",
  path: string,
  pid = 100,
  runId = RUN_A,
): GhostGlassEvent {
  return ev({ action, type: "file", pid, path }, runId);
}

function netEv(ip: string, port: number, pid = 100, runId = RUN_A): GhostGlassEvent {
  return ev({ action: "connect", type: "network", pid, ip, port }, runId);
}

function metadata(runId: string, command: string[] = ["node", "demo"]): RunMetadata {
  return {
    ghostglassVersion: "0.4.0",
    runId,
    command,
    commandLine: command.join(" "),
    startTime: new Date(BASE).toISOString(),
    endTime: new Date(BASE + 1000).toISOString(),
    durationMs: 1000,
    os: { platform: "linux", arch: "x64", release: "test" },
    exitCode: 0,
    signal: null,
    interrupted: false,
    backend: "strace",
    eventCount: 0,
    parseStats: { totalLines: 0, events: 0, skipped: 0, malformed: 0 },
  };
}

function summary(runId: string, command: string[] = ["node", "demo"]): RunSummary {
  return {
    runId,
    command,
    commandLine: command.join(" "),
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    processCount: 1,
    execCount: 1,
    eventCount: 0,
    filesystem: { total: 0, read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
    network: { attempts: 0, destinations: [] },
  };
}

function writeRun(cwd: string, runId: string, events: GhostGlassEvent[], command = ["node", "demo"]): void {
  const dir = join(cwd, ".ghostglass", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const md = metadata(runId, command);
  md.eventCount = events.length;
  const sm = summary(runId, command);
  sm.eventCount = events.length;
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(md));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(sm));
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function readDiskEvents(cwd: string, runId: string): string {
  return readFileSync(join(cwd, ".ghostglass", "runs", runId, "events.jsonl"), "utf8");
}

/** Extract and parse the embedded data envelope from exported HTML. */
function extractEnvelope(html: string): {
  format: string;
  formatVersion: number;
  type: string;
  ghostglassVersion: string;
  exportedAt: string;
  route: unknown;
  data: {
    detail?: { metadata: { runId: string; command: string[]; commandLine: string } };
    graph: {
      nodes: { id: string; kind: string; label?: string; stats?: { filesRead?: number } }[];
      edges: { from: string; to: string }[];
    };
    timeline: { timestamps: number[] };
    timelineA?: { timestamps: number[] };
    timelineB?: { timestamps: number[] };
    events: GhostGlassEvent[];
    diff?: {
      runA: { runId: string };
      runB: { runId: string };
      processes: { status: string }[];
      files: { status: string; path?: string }[];
      network: { status: string }[];
      stream: unknown[];
    };
  };
} {
  const marker = '<script type="application/json" id="gg-export-data">';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "data block present");
  const after = html.slice(start + marker.length);
  const end = after.indexOf("</script>");
  assert.ok(end >= 0, "data block closed");
  return JSON.parse(after.slice(0, end));
}

/** HTML with the embedded data block removed (for template-only assertions). */
function stripDataBlock(html: string): string {
  return html.replace(
    /<script type="application\/json" id="gg-export-data">[\s\S]*?<\/script>/,
    "<!--DATA-->",
  );
}

let assets: { js: string; css: string };
let workdir: string;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "gg-export-test-"));
  assets = await loadExportAssets();
  workdir = join(tmpRoot, "ws");
  mkdirSync(workdir, { recursive: true });
  writeRun(workdir, RUN_A, [
    execEv(100, "/usr/bin/node", ["node", "demo"]),
    fileEv("read", "/home/testuser/app/index.js"),
    fileEv("write", "/home/testuser/app/out.log"),
    netEv("192.168.1.24", 443),
  ]);
  writeRun(workdir, RUN_B, [
    execEv(100, "/usr/bin/node", ["node", "demo", "--extra"], RUN_B),
    fileEv("read", "/home/testuser/app/index.js", 100, RUN_B),
    fileEv("create", "/home/testuser/app/new.txt", 100, RUN_B),
  ]);
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("run HTML export", () => {
  it("embeds the envelope with format metadata", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const html = buildRunExportHtml(model, assets, "2026-09-30T00:00:00.000Z");
    const env = extractEnvelope(html);
    assert.equal(env.format, "ghostglass-html");
    assert.equal(env.formatVersion, 1);
    assert.equal(env.type, "run");
    assert.equal(env.ghostglassVersion, "0.4.0");
    assert.equal(env.exportedAt, "2026-09-30T00:00:00.000Z");
    assert.deepEqual(env.route, { kind: "run", runId: RUN_A });
    assert.ok(html.includes(`<title>GhostGlass — ${RUN_A}`));
  });

  it("contains graph data with valid edges", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const env = extractEnvelope(buildRunExportHtml(model, assets));
    const nodes = env.data.graph.nodes as { id: string }[];
    const ids = new Set(nodes.map((n) => n.id));
    assert.ok(nodes.length > 3, `expected nodes, got ${nodes.length}`);
    for (const e of env.data.graph.edges as { from: string; to: string }[]) {
      assert.ok(ids.has(e.from), `edge from unknown node ${e.from}`);
      assert.ok(ids.has(e.to), `edge to unknown node ${e.to}`);
    }
  });

  it("contains a sorted timeline covering every event", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const env = extractEnvelope(buildRunExportHtml(model, assets));
    const ts = env.data.timeline.timestamps as number[];
    assert.equal(ts.length, model.events.length);
    const sorted = [...ts].sort((a, b) => a - b);
    assert.deepEqual(ts, sorted);
  });

  it("embeds inspector-usable event data (process/file/network)", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const env = extractEnvelope(buildRunExportHtml(model, assets));
    const actions = new Set((env.data.events as GhostGlassEvent[]).map((e) => e.action));
    assert.ok(actions.has("exec"));
    assert.ok(actions.has("read"));
    assert.ok(actions.has("write"));
    assert.ok(actions.has("connect"));
    // process node carries inspector stats
    const proc = env.data.graph.nodes.find((n) => n.kind === "process");
    assert.ok(proc?.stats && (proc.stats.filesRead ?? 0) >= 1, "process node has file stats");
  });

  it("includes CSP, print CSS, and the privacy notice", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const html = buildRunExportHtml(model, assets);
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("@media print"));
    assert.ok(html.includes("gg-export-notice"));
    assert.ok(html.includes("local paths, command arguments"));
    assert.ok(html.includes('<link rel="icon" href="data:,">'));
    void PRINT_CSS;
  });
});

describe("diff HTML export", () => {
  it("embeds the diff envelope with both runs", async () => {
    const model = await buildDiffExportModel(workdir, RUN_A, RUN_B);
    const html = buildDiffExportHtml(model, assets, "2026-09-30T00:00:00.000Z");
    const env = extractEnvelope(html);
    assert.equal(env.format, "ghostglass-html");
    assert.equal(env.type, "diff");
    assert.deepEqual(env.route, { kind: "diff", runA: RUN_A, runB: RUN_B });
    assert.ok(html.includes(`${RUN_A} vs ${RUN_B}`));
  });

  it("classifies entities into shared/only-a/only-b/changed", async () => {
    const model = await buildDiffExportModel(workdir, RUN_A, RUN_B);
    const env = extractEnvelope(buildDiffExportHtml(model, assets));
    const diff = env.data.diff;
    assert.ok(diff, "diff model present");
    const files = diff.files;
    const byStatus = new Map<string, number>();
    for (const f of files) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
    // /home/testuser/app/index.js is in both runs -> shared or changed
    assert.ok((byStatus.get("shared") ?? 0) + (byStatus.get("changed") ?? 0) >= 1);
    // new.txt only in B
    assert.ok((byStatus.get("only-b") ?? 0) >= 1, JSON.stringify([...byStatus]));
    // out.log only in A
    assert.ok((byStatus.get("only-a") ?? 0) >= 1, JSON.stringify([...byStatus]));
    const procs = diff.processes;
    assert.ok(procs.length > 0);
  });

  it("embeds both replay timelines", async () => {
    const model = await buildDiffExportModel(workdir, RUN_A, RUN_B);
    const env = extractEnvelope(buildDiffExportHtml(model, assets));
    assert.ok(env.data.timelineA, "timelineA present");
    assert.ok(env.data.timelineB, "timelineB present");
    assert.ok(env.data.timelineA.timestamps.length > 0);
    assert.ok(env.data.timelineB.timestamps.length > 0);
  });
});

describe("JSON export", () => {
  it("run JSON export has the correct schema", async () => {
    const json = await buildRunJsonExport(workdir, RUN_A, {}, "2026-09-30T00:00:00.000Z");
    assert.equal(json.format, "ghostglass-json");
    assert.equal(json.formatVersion, 1);
    assert.equal(json.type, "run");
    assert.equal(json.ghostglassVersion, "0.4.0");
    assert.equal(json.exportedAt, "2026-09-30T00:00:00.000Z");
    assert.equal(json.metadata.runId, RUN_A);
    assert.ok(Array.isArray(json.events) && json.events.length > 0);
    assert.equal(typeof json.summary.processCount, "number");
  });

  it("diff JSON export carries the structured diff model", async () => {
    const json = await buildDiffJsonExport(workdir, RUN_A, RUN_B);
    assert.equal(json.format, "ghostglass-json");
    assert.equal(json.type, "diff");
    assert.ok(Array.isArray(json.diff.processes));
    assert.ok(Array.isArray(json.diff.files));
    assert.ok(Array.isArray(json.diff.network));
    assert.ok(Array.isArray(json.diff.stream));
    assert.ok(json.timelineA.timestamps.length > 0);
    assert.ok(json.timelineB.timestamps.length > 0);
  });
});

describe("CLI resolution and output handling", () => {
  it("resolves 'latest' and writes the default filename", async () => {
    const dir = join(tmpRoot, "cli-latest");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [execEv(1, "/bin/true", ["true"])]);
    await exportCommand("latest", { cwd: dir, output: join(dir, "out.html") });
    assert.ok(existsSync(join(dir, "out.html")));
  });

  it("export-diff resolves previous/latest", async () => {
    const dir = join(tmpRoot, "cli-diff");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [execEv(1, "/bin/true", ["true"])]);
    writeRun(dir, RUN_B, [execEv(1, "/bin/false", ["false"], RUN_B)]);
    await exportDiffCommand("previous", "latest", { cwd: dir, output: join(dir, "d.html") });
    assert.ok(existsSync(join(dir, "d.html")));
  });

  it("writes a custom output path, creating parent dirs", async () => {
    const dir = join(tmpRoot, "cli-custom");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [execEv(1, "/bin/true", ["true"])]);
    const out = join(dir, "artifacts", "nested", "trace.html");
    await exportCommand(RUN_A, { cwd: dir, output: out });
    assert.ok(existsSync(out));
  });

  it("refuses to overwrite without --force, overwrites with it", async () => {
    const dir = join(tmpRoot, "cli-force");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [execEv(1, "/bin/true", ["true"])]);
    const out = join(dir, "trace.html");
    writeFileSync(out, "existing");
    await assert.rejects(
      () => exportCommand(RUN_A, { cwd: dir, output: out }),
      /Refusing to overwrite/,
    );
    assert.equal(readFileSync(out, "utf8"), "existing");
    await exportCommand(RUN_A, { cwd: dir, output: out, force: true });
    assert.ok(readFileSync(out, "utf8").includes("<!DOCTYPE html>"));
  });

  it("rejects unknown formats", () => {
    assert.equal(resolveExportFormat(undefined), "html");
    assert.equal(resolveExportFormat("json"), "json");
    assert.throws(() => resolveExportFormat("xml"), /Invalid format/);
  });

  it("rejects invalid run IDs and traversal attempts", async () => {
    const dir = join(tmpRoot, "cli-invalid");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(() => exportCommand("bogus", { cwd: dir }), /Invalid run ID/);
    await assert.rejects(() => exportCommand("../../etc", { cwd: dir }), /Invalid run ID/);
    await assert.rejects(
      () => exportDiffCommand(RUN_A, "../other", { cwd: dir }),
      /Invalid run ID/,
    );
  });

  it("errors cleanly for a missing run", async () => {
    const dir = join(tmpRoot, "cli-missing");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(() => exportCommand("gg_20260930_999", { cwd: dir }), /Run not found/);
  });

  it("formats byte sizes", () => {
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });
});

describe("redaction", () => {
  const HOME = "/home/testuser";
  it("redacts the home directory prefix", async () => {
    const model = await buildRunExportModel(workdir, RUN_A, { homeDir: HOME });
    const paths = model.events.map((e) => e.path).filter(Boolean) as string[];
    assert.ok(paths.length > 0);
    assert.ok(paths.every((p) => !p.includes(HOME)), paths.join(","));
    assert.ok(paths.every((p) => p.startsWith("<HOME>")), paths.join(","));
  });

  it("redacts the cwd prefix (longest prefix wins)", async () => {
    const dir = join(tmpRoot, "redact-cwd");
    mkdirSync(dir, { recursive: true });
    const cwdPath = join(dir, "proj", "src", "app.ts");
    writeRun(dir, RUN_A, [
      execEv(1, "/bin/true", ["true"]),
      fileEv("read", cwdPath),
      fileEv("read", join(HOME_TMP(), "other.txt")),
    ]);
    const model = await buildRunExportModel(dir, RUN_A, { homeDir: HOME_TMP(), cwd: dir });
    const paths = model.events.map((e) => e.path).filter(Boolean) as string[];
    assert.ok(paths.some((p) => p.startsWith("<CWD>/proj")), paths.join(","));
    assert.ok(paths.some((p) => p.startsWith("<HOME>/other.txt")), paths.join(","));
  });

  it("redacts network IPs but keeps ports", async () => {
    const model = await buildRunExportModel(workdir, RUN_A, { network: true });
    const nets = model.events.filter((e) => e.type === "network");
    assert.ok(nets.length > 0);
    for (const n of nets) {
      assert.equal(n.ip, "<NETWORK>");
      assert.equal(n.port, 443);
    }
    const graphNet = model.graph.nodes.find((n) => n.kind === "network");
    assert.ok(graphNet?.label.includes("<NETWORK>"), graphNet?.label);
  });

  it("redacts args but keeps the executable", async () => {
    const model = await buildRunExportModel(workdir, RUN_B, { args: true });
    assert.deepEqual(model.metadata.command, ["node", "<ARGS REDACTED>"]);
    assert.equal(model.metadata.commandLine, "node <ARGS REDACTED>");
    const exec = model.events.find((e) => e.action === "exec");
    assert.deepEqual((exec?.metadata as { argv?: unknown } | undefined)?.argv, ["node", "<ARGS REDACTED>"]);
  });

  it("redacted values appear nowhere in the HTML source", async () => {
    const dir = join(tmpRoot, "redact-src");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [
      execEv(100, "/usr/bin/curl", ["curl", "https://private.example/token/abc"]),
      fileEv("read", "/home/testuser/private/secret.txt"),
      netEv("10.9.8.7", 8443),
    ], ["curl", "https://private.example/token/abc"]);
    const model = await buildRunExportModel(dir, RUN_A, {
      homeDir: "/home/testuser",
      network: true,
      args: true,
    });
    const html = buildRunExportHtml(model, assets);
    assert.ok(!html.includes("/home/testuser"), "home path leaked");
    assert.ok(!html.includes("10.9.8.7"), "IP leaked");
    assert.ok(!html.includes("private.example/token/abc"), "arg leaked");
    // redacted tokens are present (in escaped form inside the data block)
    const env = extractEnvelope(html);
    const paths = (env.data.events as GhostGlassEvent[])
      .map((e) => e.path)
      .filter(Boolean) as string[];
    assert.ok(paths.some((p) => p.startsWith("<HOME>/private/secret.txt")), paths.join(","));
    const exec = (env.data.events as GhostGlassEvent[]).find((e) => e.action === "exec");
    assert.deepEqual((exec?.metadata as { argv?: unknown } | undefined)?.argv, ["curl", "<ARGS REDACTED>"]);
    // original trace untouched on disk
    const disk = readDiskEvents(dir, RUN_A);
    assert.ok(disk.includes("/home/testuser/private/secret.txt"));
    assert.ok(disk.includes("10.9.8.7"));
  });
});

function HOME_TMP(): string {
  return "/home/testuser";
}

describe("injection hardening", () => {
  const PAYLOAD = "</script><script>alert(1)</script>";
  async function hostileHtml(): Promise<string> {
    const dir = join(tmpRoot, "hostile");
    mkdirSync(dir, { recursive: true });
    writeRun(dir, RUN_A, [
      execEv(100, "/usr/bin/evil", ["evil", PAYLOAD]),
      fileEv("read", `/tmp/${PAYLOAD}/x`),
      {
        ...ev({ action: "connect", type: "network", pid: 100, ip: "1.2.3.4", port: 80 }),
        host: `<img src=x onerror=alert(1)>`,
      } as GhostGlassEvent,
    ], ["evil", PAYLOAD]);
    const model = await buildRunExportModel(dir, RUN_A);
    return buildRunExportHtml(model, assets);
  }

  it("neutralizes </script> breakouts", async () => {
    const html = await hostileHtml();
    assert.ok(!html.includes(PAYLOAD), "raw payload must not appear");
    // the data block carries it only in escaped form (< escaped, > stays)…
    assert.ok(html.includes("\\u003c/script>"), "escaped form present");
    // …and it round-trips back to the original string when parsed
    const env = extractEnvelope(html);
    const joined = JSON.stringify(env.data.events);
    assert.ok(joined.includes(PAYLOAD), "data round-trips intact");
  });

  it("neutralizes HTML/JS injection payloads", async () => {
    const html = await hostileHtml();
    const template = stripDataBlock(html);
    assert.ok(!template.includes("<img src=x"), "payload in template");
    assert.ok(!template.includes("<script>alert"), "payload in template");
  });

  it("keeps malformed Unicode inert and parseable", async () => {
    const dir = join(tmpRoot, "unicode");
    mkdirSync(dir, { recursive: true });
    const rawPath = `/tmp/${"ok\uD800bad"}/f`;
    writeRun(dir, RUN_A, [fileEv("read", rawPath)]);
    const model = await buildRunExportModel(dir, RUN_A);
    const html = buildRunExportHtml(model, assets);
    // no raw lone surrogates anywhere in the HTML source
    // (the JSON escape sequence \ud800 is plain ASCII and safe)
    assert.ok(!html.includes("\uD800"), "raw high surrogate in HTML source");
    assert.ok(!html.includes("\uDC00"), "raw low surrogate in HTML source");
    const env = extractEnvelope(html); // must parse cleanly
    const path = (env.data.events as GhostGlassEvent[]).find((e) => e.path)?.path ?? "";
    assert.equal(path, rawPath, "data round-trips intact");
    // escapeHtml (used for template interpolation) normalizes to U+FFFD
    assert.equal(escapeHtml("a\uD800b"), "a�b");
  });

  it("scrubs inline scripts and escapes HTML text", () => {
    assert.equal(scrubInlineScript("a</script>b"), "a<\\/script>b");
    assert.equal(scrubInlineScript("x<!--y"), "x<\\!--y");
    assert.equal(escapeHtml('<b>"&"'), "&lt;b&gt;&quot;&amp;&quot;");
    assert.equal(sanitizeLoneSurrogates("a\uD800b"), "a�b");
    const json = escapeForScriptJson({ x: "</script>" });
    assert.ok(!json.includes("</script>"));
    assert.deepEqual(JSON.parse(json), { x: "</script>" });
  });
});

describe("zero external network dependencies", () => {
  it("the template references no external resources", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const template = stripDataBlock(buildRunExportHtml(model, assets));
    const urls = template.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    const unexpected = urls.filter((u) => u !== "http://www.w3.org/2000/svg");
    assert.deepEqual(unexpected, [], `unexpected URLs: ${unexpected.join(", ")}`);
    assert.ok(!template.includes("<script src="), "external script");
    assert.ok(!/<link[^>]+href="http/.test(template), "external stylesheet");
    assert.ok(!template.includes("@import"), "css import");
    assert.ok(!/url\(\s*http/.test(template), "css url()");
  });
});

describe("filenames and determinism", () => {
  it("generates safe default filenames", () => {
    assert.equal(defaultRunFileName(RUN_A, "html"), `ghostglass-${RUN_A}.html`);
    assert.equal(defaultRunFileName(RUN_A, "json"), `ghostglass-${RUN_A}.json`);
    assert.equal(
      defaultDiffFileName(RUN_A, RUN_B, "html"),
      `ghostglass-diff-${RUN_A}-vs-${RUN_B}.html`,
    );
  });

  it("sanitizes hostile filename input", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("a/b\\c:d"), "c_d"); // basename, then unsafe chars
    assert.equal(safeFileName("my report: final?.html"), "my_report__final_.html");
    assert.ok(!safeFileName("x").includes("/"));
  });

  it("is byte-deterministic for identical input", async () => {
    const model = await buildRunExportModel(workdir, RUN_A);
    const at = "2026-09-30T12:00:00.000Z";
    const a = buildRunExportHtml(model, assets, at);
    const b = buildRunExportHtml(model, assets, at);
    assert.equal(a, b);
  });
});

describe("large trace export", () => {
  it("handles 12,000 events quickly", async () => {
    const dir = join(tmpRoot, "large");
    mkdirSync(dir, { recursive: true });
    const events: GhostGlassEvent[] = [execEv(100, "/usr/bin/node", ["node", "big"])];
    for (let i = 0; i < 11_999; i++) {
      events.push(
        ev(
          {
            action: i % 2 === 0 ? "read" : "write",
            type: "file",
            pid: 100 + (i % 5),
            path: `/data/file-${i % 500}.txt`,
          },
        ),
      );
    }
    writeRun(dir, RUN_A, events);
    const t0 = Date.now();
    const model = await buildRunExportModel(dir, RUN_A);
    const html = buildRunExportHtml(model, assets);
    const ms = Date.now() - t0;
    assert.equal(model.events.length, 12_000);
    assert.ok(html.length > 1_000_000, `html size ${html.length}`);
    assert.ok(ms < 30_000, `took ${ms}ms`);
    const env = extractEnvelope(html);
    assert.equal((env.data.events as unknown[]).length, 12_000);
  });
});
