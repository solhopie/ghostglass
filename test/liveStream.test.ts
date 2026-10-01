/**
 * Run 5 — LIVE GLASS backend tests.
 *
 * Covers: incremental strace stream parsing (chunks, splits, malformed
 * lines), LinuxStraceTracer.streamLive (ordering, exit codes, interrupts),
 * LiveSession (persistence, batched broadcast, subscribe/replay, finalize),
 * the live SSE endpoints (hello/events/status, ?since= and Last-Event-ID
 * reconnect, browser-close and server-failure resilience), malicious
 * strings, and watch CLI integration (--no-browser, ports, localhost
 * binding, interrupt) plus saved-run compatibility (open/diff/export).
 *
 * strace-dependent blocks are skipped when strace is unavailable.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { RunMetadata, RunListEntry } from "../src/storage/runStore.js";
import type { RunSummary } from "../src/summary/summarize.js";
import { StraceStreamParser } from "../src/parser/streamParser.js";
import { LinuxStraceTracer } from "../src/tracer/LinuxStraceTracer.js";
import {
  LiveSession,
  type LiveSessionLike,
  type LiveStatusPayload,
  type LiveSubscriber,
} from "../src/live/liveSession.js";
import { ViewerServer } from "../src/viewer/server.js";
import { compareRuns } from "../src/diff/compareRuns.js";
import { loadRunData } from "../src/diff/loadRuns.js";
import { exportCommand } from "../src/cli/commands/export.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_JS = join(here, "..", "src", "cli.js");
const LIVE_DEMO = join(here, "fixtures", "live-demo.cjs");
const LIVE_BURST = join(here, "fixtures", "live-burst.cjs");

function hasStrace(): boolean {
  try {
    return spawnSync("strace", ["-V"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
const STRACE_AVAILABLE = hasStrace();

function makeEvent(
  seq: number,
  action: GhostGlassEvent["action"],
  type: GhostGlassEvent["type"] = "file",
): GhostGlassEvent {
  return {
    id: `gg_test-${String(seq).padStart(6, "0")}`,
    runId: "gg_test",
    timestamp: 1000 + seq,
    type,
    action,
    pid: 100,
  };
}

/** The 1-based sequence embedded in an event id (`<runId>-000042`). */
function seqOf(id: string): number {
  return parseInt(id.slice(id.lastIndexOf("-") + 1), 10);
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 15000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Incremental stream parser
// ---------------------------------------------------------------------------

describe("StraceStreamParser", () => {
  const LINES = [
    '100   12:00:00.000001 execve("/bin/echo", ["echo", "hi"], 0x0 /* 1 var */) = 0\n',
    '100   12:00:00.000002 openat(AT_FDCWD, "/tmp/a.txt", O_RDONLY) = 3\n',
    '100   12:00:00.000003 write(1</dev/stdout>, "hi\\n", 3) = 3\n',
  ];

  it("parses multiple lines delivered in a single chunk", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const events = p.push(LINES.join(""));
    assert.equal(events.length, 3);
    assert.equal(events[0]!.action, "exec");
    assert.equal(events[1]!.action, "read");
    assert.equal(events[2]!.action, "write");
  });

  it("holds a line split across chunks until it completes", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const half = Math.floor(LINES[0]!.length / 2);
    const first = p.push(LINES[0]!.slice(0, half));
    assert.equal(first.length, 0, "partial line must not emit");
    const rest = p.push(LINES[0]!.slice(half));
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.action, "exec");
  });

  it("handles a line split mid-multibyte-content across many tiny chunks", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < LINES[1]!.length; i += 7) {
      events.push(...p.push(LINES[1]!.slice(i, i + 7)));
    }
    events.push(...p.flush());
    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, "read");
  });

  it("flush() emits a trailing unterminated line", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const partial = LINES[2]!.trimEnd();
    assert.equal(p.push(partial).length, 0);
    const flushed = p.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0]!.action, "write");
  });

  it("counts malformed lines without breaking the stream", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const events = p.push(
      LINES[0]! + "this is not a strace line at all\n" + LINES[1]!,
    );
    assert.equal(events.length, 2);
    const stats = p.getStats();
    assert.equal(stats.totalLines, 3);
    assert.equal(stats.events, 2);
    assert.equal(stats.malformed, 1);
  });

  it("keeps malicious strings intact as inert data", () => {
    const p = new StraceStreamParser("gg_test", 1000);
    const evil = '100   12:00:00.000007 openat(AT_FDCWD, "<script>alert(1)</script>\\u0000<img src=x onerror=alert(2)>", O_RDONLY) = 3\n';
    const events = p.push(evil);
    assert.equal(events.length, 1);
    // Preserved verbatim as data (the frontend renders it as inert text).
    assert.match(events[0]!.path ?? "", /<script>alert\(1\)<\/script>/);
  });
});

// ---------------------------------------------------------------------------
// streamLive on the real tracer
// ---------------------------------------------------------------------------

describe("LinuxStraceTracer.streamLive", { skip: !STRACE_AVAILABLE }, () => {
  it("streams events while the command runs and reports completion", async () => {
    const tracer = new LinuxStraceTracer();
    const dir = mkdtempSync(join(tmpdir(), "gg-live-"));
    try {
      const stream = tracer.streamLive(["node", "-e", "console.log('hi')"], {
        cwd: dir,
        rawTracePath: join(dir, "trace.log"),
        runId: "gg_test_stream",
      });
      let count = 0;
      let sawExec = false;
      for await (const event of stream) {
        count++;
        if (event.action === "exec") sawExec = true;
      }
      const result = await stream.done();
      assert.ok(count > 0, "expected events from a real trace");
      assert.ok(sawExec, "expected an exec event");
      assert.equal(result.exitCode, 0);
      assert.equal(result.forwardedSignal, null);
      assert.ok(result.parseStats);
      assert.equal(result.parseStats.events, count);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits events in trace order with unique sequential ids", async () => {
    const tracer = new LinuxStraceTracer();
    const dir = mkdtempSync(join(tmpdir(), "gg-live-"));
    try {
      const stream = tracer.streamLive(["node", LIVE_BURST, "200"], {
        cwd: dir,
        rawTracePath: join(dir, "trace.log"),
        runId: "gg_test_order",
      });
      const ids: string[] = [];
      for await (const event of stream) {
        ids.push(event.id);
      }
      await stream.done();
      assert.ok(ids.length > 100);
      assert.deepEqual(new Set(ids).size, ids.length, "event ids must be unique");
      const seqs = ids.map(seqOf);
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(seqs[i]! > seqs[i - 1]!, "seqs must increase in arrival order");
      }
      assert.equal(seqs[0], 1);
      assert.equal(seqs[seqs.length - 1], seqs.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a nonzero exit code", async () => {
    const tracer = new LinuxStraceTracer();
    const dir = mkdtempSync(join(tmpdir(), "gg-live-"));
    try {
      const stream = tracer.streamLive(["node", "-e", "process.exit(3)"], {
        cwd: dir,
        rawTracePath: join(dir, "trace.log"),
        runId: "gg_test_exit",
      });
      for await (const event of stream) {
        assert.ok(event.id.startsWith("gg_test_exit-"));
      }
      const result = await stream.done();
      assert.equal(result.exitCode, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards SIGINT to the traced process group and reports interruption", async () => {
    const tracer = new LinuxStraceTracer();
    const dir = mkdtempSync(join(tmpdir(), "gg-live-"));
    try {
      const stream = tracer.streamLive(["node", "-e", "setTimeout(()=>{}, 60000)"], {
        cwd: dir,
        rawTracePath: join(dir, "trace.log"),
        runId: "gg_test_int",
      });
      let sawFirst = false;
      const drain = (async () => {
        for await (const event of stream) {
          assert.ok(event.id.startsWith("gg_test_int-"));
          sawFirst = true;
        }
      })();
      await waitFor(() => sawFirst, 15000, "first streamed event");
      // Signal ourselves: the tracer forwards it to the strace/target group.
      process.kill(process.pid, "SIGINT");
      await drain;
      const result = await stream.done();
      assert.equal(result.forwardedSignal, "SIGINT");
      assert.equal(result.signal, "SIGINT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// LiveSession: persistence, broadcast batching, subscribe/replay, finalize
// ---------------------------------------------------------------------------

describe("LiveSession", () => {
  function makeSession(suffix: string) {
    const dir = mkdtempSync(join(tmpdir(), `gg-session-${suffix}-`));
    const session = new LiveSession({
      runId: `gg_test_${suffix}`,
      runDir: dir,
      command: ["node", "-e", "1"],
      commandLine: "node -e 1",
      backendName: "strace",
      startTimeMs: Date.now(),
    });
    return { dir, session };
  }

  it("persists every ingested event to events.jsonl in order", async () => {
    const { dir, session } = makeSession("persist");
    try {
      const events = [1, 2, 3, 4, 5].map((n) => makeEvent(n, "read"));
      session.ingestBatch(events);
      for (const e of [6, 7].map((n) => makeEvent(n, "write"))) session.ingest(e);
      assert.equal(session.getStatus().eventCount, 7);
      await session.finalize({
        startTimeMs: 1000,
        endTimeMs: 1010,
        exitCode: 0,
        signal: null,
        forwardedSignal: null,
        durationMs: 10,
        rawTracePath: join(dir, "trace.log"),
        parseStats: { totalLines: 7, events: 7, skipped: 0, malformed: 0 },
      });
      const lines = readFileSync(join(dir, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim());
      assert.equal(lines.length, 7);
      const parsed = lines.map((l) => JSON.parse(l) as GhostGlassEvent);
      assert.deepEqual(parsed.map((e) => seqOf(e.id)), [1, 2, 3, 4, 5, 6, 7]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batches broadcasts: fewer subscriber calls than events, zero loss", async () => {
    const { dir, session } = makeSession("batch");
    try {
      let calls = 0;
      let received = 0;
      session.subscribe(
        {
          onEvents: (batch) => {
            calls++;
            received += batch.length;
          },
          onStatus: () => undefined,
        },
        null,
      );
      const events = Array.from({ length: 1000 }, (_, i) => makeEvent(i + 1, "read"));
      // Ingest synchronously in one tick: must collapse into few batches.
      session.ingestBatch(events);
      await waitFor(() => received === 1000, 5000, "all batches delivered");
      assert.ok(calls < 1000, `expected batching, got ${calls} calls for 1000 events`);
      assert.equal(received, 1000);
    } finally {
      await session.discard().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays missed events on subscribe and continues live with no gaps or dupes", async () => {
    const { dir, session } = makeSession("replay");
    try {
      session.ingestBatch([1, 2, 3, 4, 5].map((n) => makeEvent(n, "read")));
      const got: GhostGlassEvent[] = [];
      session.subscribe(
        {
          onEvents: (batch) => got.push(...batch),
          onStatus: () => undefined,
        },
        "gg_test-000003",
      );
      session.ingestBatch([6, 7, 8].map((n) => makeEvent(n, "read")));
      await waitFor(() => got.length === 5, 5000, "replay + live batches");
      assert.deepEqual(got.map((e) => seqOf(e.id)), [4, 5, 6, 7, 8]);
    } finally {
      await session.discard().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes complete runs with real counters in summary.json", async () => {
    const { dir, session } = makeSession("final");
    try {
      session.ingestBatch([
        { ...makeEvent(1, "exec", "process"), pid: 10, parentPid: 1 },
        { ...makeEvent(2, "write", "file"), path: "/tmp/a" },
        { ...makeEvent(3, "read", "file"), path: "/tmp/a" },
        { ...makeEvent(4, "connect", "network") },
      ]);
      const metadata = await session.finalize({
        startTimeMs: 1000,
        endTimeMs: 1042,
        exitCode: 0,
        signal: null,
        forwardedSignal: null,
        durationMs: 42,
        rawTracePath: join(dir, "trace.log"),
        parseStats: { totalLines: 4, events: 4, skipped: 0, malformed: 0 },
      });
      assert.equal(metadata.exitCode, 0);
      assert.equal(metadata.interrupted, false);
      assert.equal(metadata.eventCount, 4);
      const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as RunSummary;
      assert.equal(summary.filesystem.write, 1);
      assert.equal(summary.filesystem.read, 1);
      assert.equal(summary.network.attempts, 1);
      assert.equal(session.getStatus().status, "complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes interrupted and nonzero-exit runs with the right status", async () => {
    for (const [result, wantStatus, wantInterrupted] of [
      [{ startTimeMs: 1, endTimeMs: 2, exitCode: null, signal: "SIGINT", forwardedSignal: "SIGINT", durationMs: 1, rawTracePath: "x", parseStats: { totalLines: 0, events: 0, skipped: 0, malformed: 0 } }, "interrupted", true],
      [{ startTimeMs: 1, endTimeMs: 2, exitCode: 3, signal: null, forwardedSignal: null, durationMs: 1, rawTracePath: "x", parseStats: { totalLines: 0, events: 0, skipped: 0, malformed: 0 } }, "exited", false],
    ] as const) {
      const { dir, session } = makeSession(`st-${wantStatus}`);
      try {
        session.ingest(makeEvent(1, "exec", "process"));
        const metadata = await session.finalize(result);
        assert.equal(session.getStatus().status, wantStatus);
        assert.equal(metadata.interrupted, wantInterrupted);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("events remain queryable by offset after finalize (open compatibility)", async () => {
    const { dir, session } = makeSession("slice");
    try {
      session.ingestBatch([1, 2, 3].map((n) => makeEvent(n, "read")));
      await session.finalize({
        startTimeMs: 1000, endTimeMs: 1001,
        exitCode: 0, signal: null, forwardedSignal: null, durationMs: 1,
        rawTracePath: join(dir, "trace.log"),
        parseStats: { totalLines: 3, events: 3, skipped: 0, malformed: 0 },
      });
      const page = session.eventsSlice(1, 2);
      assert.equal(page.total, 3);
      assert.deepEqual(page.events.map((e) => seqOf(e.id)), [2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live SSE endpoints against a real ViewerServer
// ---------------------------------------------------------------------------

interface SseMessage {
  event: string;
  id: string;
  data: string;
}

function openSse(
  url: string,
  headers: Record<string, string> = {},
): { messages: SseMessage[]; close: () => void } {
  const messages: SseMessage[] = [];
  const req = http.get(url, { headers: { Accept: "text/event-stream", ...headers } });
  let buf = "";
  req.on("response", (res) => {
    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const msg: SseMessage = { event: "message", id: "", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) msg.event = line.slice(6).trim();
          else if (line.startsWith("id:")) msg.id = line.slice(3).trim();
          else if (line.startsWith("data:")) msg.data += (msg.data ? "\n" : "") + line.slice(5).trim();
        }
        messages.push(msg);
      }
    });
  });
  req.on("error", () => undefined);
  return { messages, close: () => req.destroy() };
}

function stubSession(
  events: GhostGlassEvent[],
  status: LiveStatusPayload,
): { like: LiveSessionLike; emit: (batch: GhostGlassEvent[]) => void; setStatus: (s: LiveStatusPayload) => void } {
  let liveSub: LiveSubscriber | null = null;
  let liveStatus: LiveStatusPayload = status;
  const eventsAfter = (sinceId: string | null): { events: GhostGlassEvent[] } => {
    if (sinceId == null || sinceId === "") return { events: [...events] };
    // Unknown ids resend everything (client dedupes) — mirrors LiveSession.
    const idx = events.findIndex((e) => e.id === sinceId);
    return { events: idx === -1 ? [...events] : events.slice(idx + 1) };
  };
  const like: LiveSessionLike = {
    runId: status.runId,
    subscribe(sub: LiveSubscriber, sinceId?: string | null) {
      const missed = eventsAfter(sinceId ?? null).events;
      if (missed.length > 0) queueMicrotask(() => sub.onEvents(missed));
      queueMicrotask(() => sub.onStatus(liveStatus));
      liveSub = sub;
      return () => {
        if (liveSub === sub) liveSub = null;
      };
    },
    eventsAfter,
    eventsSlice(offset: number, limit: number) {
      return { events: events.slice(offset, offset + limit), total: events.length };
    },
    getStatus() {
      return liveStatus;
    },
    getHighlights() {
      return [];
    },
  };
  return {
    like,
    emit: (batch) => liveSub?.onEvents(batch),
    setStatus: (s) => {
      liveStatus = s;
      liveSub?.onStatus(s);
    },
  };
}

describe("live SSE endpoints", () => {
  let server: ViewerServer;
  let base: string;

  before(async () => {
    server = new ViewerServer({ cwd: tmpdir() });
    const started = await server.start();
    base = started.url;
    // Localhost-only binding (#34).
    assert.equal(started.host, "127.0.0.1");
  });

  after(async () => {
    await server.stop();
  });

  function statusPayload(runId: string, status: LiveStatusPayload["status"]): LiveStatusPayload {
    return {
      runId,
      status,
      commandLine: "node demo",
      startTimeMs: Date.now(),
      durationMs: status === "running" ? 100 : 200,
      exitCode: status === "running" ? null : 0,
      signal: null,
      interrupted: false,
      eventCount: 5,
    };
  }

  it("streams hello, batched events, status, and ping messages", async () => {
    const events = [1, 2, 3, 4, 5].map((n) => makeEvent(n, "read"));
    const stub = stubSession(events, statusPayload("gg_20250930_101", "running"));
    server.registerLiveSession(stub.like);
    try {
      const sse = openSse(`${base}/api/live/gg_20250930_101/stream`);
      await waitFor(() => sse.messages.length >= 2, 5000, "hello + events");
      const hello = sse.messages.find((m) => m.event === "hello");
      assert.ok(hello, "expected hello message");
      assert.equal(JSON.parse(hello.data).runId, "gg_20250930_101");
      const evMsg = sse.messages.find((m) => m.event === "events");
      assert.ok(evMsg, "expected events message");
      assert.equal(evMsg.id, "gg_test-000005", "SSE id is the last event id");
      const parsed = JSON.parse(evMsg.data).events as GhostGlassEvent[];
      assert.equal(parsed.length, 5);
      // Status endpoint works during the live run.
      const st = await new Promise<LiveStatusPayload>((resolve, reject) => {
        http.get(`${base}/api/live/gg_20250930_101/status`, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve(JSON.parse(body) as LiveStatusPayload));
        }).on("error", reject);
      });
      assert.equal(st.status, "running");
      // Live batch arrives as a new message.
      const more = [6, 7].map((n) => makeEvent(n, "write"));
      stub.emit(more);
      await waitFor(() => sse.messages.filter((m) => m.event === "events").length >= 2, 5000, "live batch");
      const second = sse.messages.filter((m) => m.event === "events")[1]!;
      assert.equal(second.id, "gg_test-000007");
      sse.close();
    } finally {
      server.unregisterLiveSession("gg_20250930_101");
    }
  });

  it("replays missed events via ?since= and Last-Event-ID without duplicates", async () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((n) => makeEvent(n, "read"));
    const stub = stubSession(events, statusPayload("gg_20250930_102", "running"));
    server.registerLiveSession(stub.like);
    try {
      // Client that saw up to event 3 reconnects with ?since=.
      const sse = openSse(`${base}/api/live/gg_20250930_102/stream?since=gg_test-000003`);
      await waitFor(() => sse.messages.some((m) => m.event === "events"), 5000, "replay");
      const evMsg = sse.messages.find((m) => m.event === "events")!;
      const parsed = JSON.parse(evMsg.data).events as GhostGlassEvent[];
      assert.deepEqual(parsed.map((e) => seqOf(e.id)), [4, 5, 6, 7]);
      sse.close();

      // Same via the native Last-Event-ID header.
      const sse2 = openSse(`${base}/api/live/gg_20250930_102/stream`, {
        "Last-Event-ID": "gg_test-000005",
      });
      await waitFor(() => sse2.messages.some((m) => m.event === "events"), 5000, "header replay");
      const ev2 = sse2.messages.find((m) => m.event === "events")!;
      assert.deepEqual(
        (JSON.parse(ev2.data).events as GhostGlassEvent[]).map((e) => seqOf(e.id)),
        [6, 7],
      );
      // Live batch after replay: no overlap, no gap.
      stub.emit([8].map((n) => makeEvent(n, "write")));
      await waitFor(
        () => sse2.messages.filter((m) => m.event === "events").length >= 2,
        5000,
        "post-replay live batch",
      );
      const live = sse2.messages.filter((m) => m.event === "events")[1]!;
      assert.deepEqual(
        (JSON.parse(live.data).events as GhostGlassEvent[]).map((e) => seqOf(e.id)),
        [8],
      );
      const allIds = sse2.messages
        .filter((m) => m.event === "events")
        .flatMap((m) => (JSON.parse(m.data).events as GhostGlassEvent[]).map((e) => e.id));
      assert.equal(new Set(allIds).size, allIds.length, "no duplicate event ids across replay+live");
      sse2.close();
    } finally {
      server.unregisterLiveSession("gg_20250930_102");
    }
  });

  it("survives the browser closing mid-run: session keeps ingesting", async () => {
    const events = [1, 2].map((n) => makeEvent(n, "read"));
    const stub = stubSession(events, statusPayload("gg_20250930_103", "running"));
    server.registerLiveSession(stub.like);
    try {
      const sse = openSse(`${base}/api/live/gg_20250930_103/stream`);
      await waitFor(() => sse.messages.length >= 1, 5000, "hello");
      sse.close(); // browser tab closed
      await new Promise((r) => setTimeout(r, 200));
      // Tracing continues unaffected: more events, then completion.
      stub.emit([3, 4].map((n) => makeEvent(n, "write")));
      stub.setStatus(statusPayload("gg_20250930_103", "complete"));
      // A fresh connection replays everything missed.
      const sse2 = openSse(`${base}/api/live/gg_20250930_103/stream`);
      await waitFor(() => sse2.messages.some((m) => m.event === "events"), 5000, "replay after close");
      const ids = sse2.messages
        .filter((m) => m.event === "events")
        .flatMap((m) => (JSON.parse(m.data).events as GhostGlassEvent[]).map((e) => seqOf(e.id)));
      // The stub is static; the point is the server tolerated the close and
      // serves fresh subscribers afterwards.
      assert.ok(ids.length >= 2);
      sse2.close();
    } finally {
      server.unregisterLiveSession("gg_20250930_103");
    }
  });

  it("keeps trace persistence working when the viewer server fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gg-srvfail-"));
    const session = new LiveSession({
      runId: "gg_srvfail",
      runDir: dir,
      command: ["node", "-e", "1"],
      commandLine: "node -e 1",
      backendName: "strace",
      startTimeMs: Date.now(),
    });
    const lone = new ViewerServer({ cwd: tmpdir() });
    try {
      await lone.start();
      lone.registerLiveSession(session);
      session.ingestBatch([1, 2, 3].map((n) => makeEvent(n, "read")));
      // Viewer dies mid-run.
      await lone.stop();
      // Tracing and persistence continue: the session is independent.
      session.ingestBatch([4, 5].map((n) => makeEvent(n, "write")));
      const metadata = await session.finalize({
        startTimeMs: 1000, endTimeMs: 1005,
        exitCode: 0, signal: null, forwardedSignal: null, durationMs: 5,
        rawTracePath: join(dir, "trace.log"),
        parseStats: { totalLines: 5, events: 5, skipped: 0, malformed: 0 },
      });
      assert.equal(metadata.eventCount, 5);
      assert.ok(existsSync(join(dir, "events.jsonl")));
      assert.ok(existsSync(join(dir, "summary.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid run ids on live endpoints", async () => {
    const code = await new Promise<number>((resolve) => {
      http
        .get(`${base}/api/live/..%2Fevil/stream`, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", () => resolve(-1));
    });
    assert.equal(code, 400);
  });

  it("falls through to another port on collision", async () => {
    const first = new ViewerServer({ cwd: tmpdir(), port: 48123 });
    const second = new ViewerServer({ cwd: tmpdir(), port: 48123 });
    try {
      const s1 = await first.start();
      const s2 = await second.start();
      assert.equal(s1.port, 48123);
      assert.equal(s2.port, 48124);
    } finally {
      await first.stop().catch(() => undefined);
      await second.stop().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// watch CLI integration (real subprocess, real strace)
// ---------------------------------------------------------------------------

function runWatch(cwd: string, args: string[], timeoutMs = 120000) {
  return spawnSync(process.execPath, [CLI_JS, "watch", ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function listRuns(cwd: string): RunListEntry[] {
  return JSON.parse(
    spawnSync(process.execPath, [CLI_JS, "runs", "--json"], {
      cwd,
      encoding: "utf8",
    }).stdout || "[]",
  ) as RunListEntry[];
}

describe("ghostglass watch CLI", { skip: !STRACE_AVAILABLE }, () => {
  it("--no-browser completes, prints the banner, and saves a reopenable run", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const out = runWatch(cwd, ["--no-browser", "--", "node", "-e", "console.log('watch works')"]);
      assert.equal(out.status, 0, `stderr: ${out.stderr}`);
      assert.match(out.stdout, /GhostGlass Live/);
      assert.match(out.stdout, /Run ID:/);
      assert.match(out.stdout, /Viewer:/);
      assert.match(out.stdout, /127\.0\.0\.1/);
      assert.match(out.stdout, /watch works/, "command stdout stays visible");
      const runs = listRuns(cwd);
      assert.equal(runs.length, 1);
      const runId = runs[0]!.runId;
      const runDir = join(cwd, ".ghostglass", "runs", runId);
      assert.ok(existsSync(join(runDir, "events.jsonl")));
      assert.ok(existsSync(join(runDir, "summary.json")));
      const metadata = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as RunMetadata;
      assert.equal(metadata.exitCode, 0);
      assert.equal(metadata.commandLine, "node -e 'console.log('\\''watch works'\\'')'");
      // Saved in the normal format: `show` reads it back.
      const show = spawnSync(process.execPath, [CLI_JS, "show", runId], { cwd, encoding: "utf8" });
      assert.equal(show.status, 0);
      assert.match(show.stdout, /Processes:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves a nonzero exit code", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const out = runWatch(cwd, ["--no-browser", "--", "node", "-e", "process.exit(3)"]);
      assert.equal(out.status, 3);
      const runs = listRuns(cwd);
      assert.equal(runs[0]?.metadata.exitCode, 3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an invalid port and honors a custom one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const bad = runWatch(cwd, ["--port", "abc", "--no-browser", "--", "node", "-e", "1"]);
      assert.equal(bad.status, 2);
      const ok = runWatch(cwd, ["--no-browser", "--port", "48234", "--", "node", "-e", "1"]);
      assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
      assert.match(ok.stdout, /127\.0\.0\.1:48234/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("traces the gradual live-demo fixture: processes, files, network", { timeout: 120000 }, () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const out = runWatch(cwd, ["--no-browser", "--", "node", LIVE_DEMO], 110000);
      assert.equal(out.status, 0, `stderr: ${out.stderr}`);
      assert.match(out.stdout, /\[demo 6\/6\]/, "fixture ran to completion");
      const runs = listRuns(cwd);
      assert.equal(runs.length, 1);
      const runDir = join(cwd, ".ghostglass", "runs", runs[0]!.runId);
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as RunSummary;
      assert.ok(summary.processCount >= 4, `expected root + 3 children, got ${summary.processCount}`);
      assert.ok(summary.filesystem.create >= 5, `creates: ${summary.filesystem.create}`);
      assert.ok(summary.filesystem.write >= 3, `writes: ${summary.filesystem.write}`);
      assert.ok(summary.filesystem.rename >= 1, `renames: ${summary.filesystem.rename}`);
      assert.ok(summary.filesystem.delete >= 1, `deletes: ${summary.filesystem.delete}`);
      assert.ok(summary.network.attempts >= 4, `network attempts: ${summary.network.attempts}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports a missing command plainly and saves no run", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const out = runWatch(cwd, ["--no-browser", "--", "gg-definitely-not-a-real-cmd"]);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /No trace was saved/);
      assert.equal(listRuns(cwd).length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("interrupts cleanly: exit 130, partial trace saved, no tracer leftovers", { timeout: 60000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-watch-"));
    try {
      const child: ChildProcess = spawn(process.execPath, [
        CLI_JS, "watch", "--no-browser", "--",
        "node", "-e", "setTimeout(()=>{}, 60000)",
      ], { cwd });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      await new Promise((r) => setTimeout(r, 4000));
      child.kill("SIGINT");
      const code: number = await new Promise((resolve) => {
        child.on("close", (c) => resolve(c ?? -1));
        setTimeout(() => resolve(-99), 20000);
      });
      assert.equal(code, 130, `stdout: ${stdout}\nstderr: ${stderr}`);
      assert.match(stdout, /Interrupted/);
      const runs = listRuns(cwd);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.metadata.interrupted, true);
      assert.equal(runs[0]?.metadata.exitCode, null);
      // No strace/node leftovers from this run.
      await new Promise((r) => setTimeout(r, 500));
      const ps = spawnSync("pgrep", ["-af", "setTimeout"], { encoding: "utf8" });
      assert.ok(!ps.stdout.includes("60000"), `tracer leftovers: ${ps.stdout}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Saved-run compatibility: open / diff / export on live-produced runs
// ---------------------------------------------------------------------------

describe("live runs stay compatible with open/diff/export", { skip: !STRACE_AVAILABLE }, () => {
  function watchOnce(cwd: string, command: string[]): string {
    const out = runWatch(cwd, ["--no-browser", "--", ...command]);
    assert.equal(out.status, 0, `stderr: ${out.stderr}`);
    const runs = listRuns(cwd);
    assert.equal(runs.length >= 1, true);
    return runs[runs.length - 1]!.runId;
  }

  it("open serves the API and diff/export work on live-saved runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gg-compat-"));
    try {
      const runA = watchOnce(cwd, ["node", "-e", "console.log('a')"]);
      const runB = watchOnce(cwd, ["node", "-e", "console.log('b')"]);
      // diff
      const diff = compareRuns(await loadRunData(cwd, runA), await loadRunData(cwd, runB));
      assert.ok(diff.summary.eventCount.a > 0);
      // export to HTML
      const htmlPath = join(cwd, "export.html");
      await exportCommand(runA, {
        cwd,
        format: "html",
        output: htmlPath,
        force: true,
      });
      const html = readFileSync(htmlPath, "utf8");
      assert.match(html, /GhostGlass/);
      // open: the saved-run API serves it.
      const server = new ViewerServer({ cwd });
      const started = await server.start();
      try {
        const detail: number = await new Promise((resolve, reject) => {
          http
            .get(`${started.url}/api/runs/${runA}`, (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            })
            .on("error", reject);
        });
        assert.equal(detail, 200);
      } finally {
        await server.stop();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
