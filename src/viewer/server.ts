/**
 * Local-only viewer server.
 *
 * Serves the GhostGlass visual replay UI and a small JSON API over saved
 * runs. Binds to 127.0.0.1 by default — trace data can contain sensitive
 * local paths, so it must never listen on a public interface unless the
 * caller explicitly overrides the host.
 *
 * Security posture: trace data is treated as untrusted input.
 *  - Run IDs are strictly validated (no path traversal).
 *  - The API only reads metadata.json / summary.json / events.jsonl inside
 *    .ghostglass/runs/<run-id>/ — never arbitrary filesystem paths.
 *  - Static files are served only from the bundled web/dist directory.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GHOSTGLASS_DIR,
  RUNS_DIR,
  listRuns,
  readJsonFile,
  runDirExists,
  type RunMetadata,
} from "../storage/runStore.js";
import type { GhostGlassEvent } from "../events/types.js";
import type { RunSummary } from "../summary/summarize.js";
import { buildGraphFromEvents } from "./indexer.js";
import { buildTimelinePayload } from "./replay.js";
import type { ApiEventsPage, ApiGraph, ApiRunDetail, ApiRunListItem } from "./protocol.js";
import { compareRuns } from "../diff/compareRuns.js";
import { loadRunData } from "../diff/loadRuns.js";
import type { RunDiff } from "../diff/types.js";
import type { LiveSessionLike, LiveSubscriber } from "../live/liveSession.js";
import type { Highlight } from "../highlights/types.js";
import { readHighlights } from "../highlights/storage.js";
import { loadHighlightConfig } from "../highlights/config.js";
import {
  buildCauseIndex,
  buildCauseChain,
  extendCauseIndex,
  type CauseIndex,
  type CauseTarget,
} from "../cause/index.js";

export const DEFAULT_VIEWER_PORT = 7777;
export const VIEWER_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 10;
const MAX_PAGE_LIMIT = 5000;
/** Max events per SSE replay message; larger histories are chunked. */
const SSE_REPLAY_CHUNK = 2000;
/** SSE ping interval, keeping idle connections (and proxies) alive. */
const SSE_PING_MS = 15_000;
/** Per-connection buffered-bytes ceiling before we ask the client to resync. */
const SSE_MAX_BUFFERED = 2 * 1024 * 1024;

const WEB_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "web",
  "dist",
);

/** Strict run-ID shape, e.g. gg_20260930_001. Rejects traversal outright. */
export const RUN_ID_RE = /^gg_[0-9]{8}_[0-9]{3,}$/;
export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

interface CachedRun {
  metadata: RunMetadata;
  summary: RunSummary;
  events: GhostGlassEvent[];
  graph: ApiGraph | null;
  causeIndex: CauseIndex | null;
}

export interface ViewerServerOptions {
  cwd: string;
  host?: string | undefined;
  port?: number | undefined;
}

export class ViewerServer {
  private server: Server | null = null;
  private cache = new Map<string, CachedRun>();
  private diffCache = new Map<string, RunDiff>();
  private liveSessions = new Map<string, LiveSessionLike>();
  /** Incremental cause indexes for live sessions (extended per batch). */
  private liveCauseIndexes = new Map<string, CauseIndex>();
  private readonly cwd: string;
  private readonly host: string;
  private readonly preferredPort: number;
  private boundPort: number | null = null;

  constructor(opts: ViewerServerOptions) {
    this.cwd = opts.cwd;
    this.host = opts.host ?? VIEWER_HOST;
    this.preferredPort = opts.port ?? DEFAULT_VIEWER_PORT;
  }

  /** Register a live session so its SSE/status endpoints become available. */
  registerLiveSession(session: LiveSessionLike): void {
    this.liveSessions.set(session.runId, session);
  }

  /** Remove a live session (after finalization); drops cached run data. */
  unregisterLiveSession(runId: string): void {
    this.liveSessions.delete(runId);
    this.liveCauseIndexes.delete(runId);
    this.cache.delete(runId);
  }

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) throw new Error("Viewer server already started");
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
        void err;
      });
    });
    let port = this.preferredPort;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, this.host, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") throw err;
        port += 1;
      }
    }
    if (lastErr) throw lastErr;
    this.server = server;
    const addr = server.address();
    const bound = typeof addr === "object" && addr !== null ? addr.port : port;
    this.boundPort = bound;
    return { host: this.host, port: bound, url: `http://${this.host}:${bound}` };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private runDir(runId: string): string {
    return join(this.cwd, GHOSTGLASS_DIR, RUNS_DIR, runId);
  }

  private async loadRun(runId: string): Promise<CachedRun | null> {
    const cached = this.cache.get(runId);
    if (cached) return cached;
    if (!(await runDirExists(this.cwd, runId))) return null;
    const dir = this.runDir(runId);
    let metadata: RunMetadata;
    let summary: RunSummary;
    try {
      [metadata, summary] = await Promise.all([
        readJsonFile<RunMetadata>(join(dir, "metadata.json")),
        readJsonFile<RunSummary>(join(dir, "summary.json")),
      ]);
    } catch {
      // Incomplete run directory (e.g. a live run that has not finalized
      // yet, or an interrupted write); not loadable as a saved run.
      return null;
    }
    const events: GhostGlassEvent[] = [];
    const rl = createInterface({ input: createReadStream(join(dir, "events.jsonl")), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t) as GhostGlassEvent);
      } catch {
        // skip malformed lines, mirroring the tracer's leniency
      }
    }
    const entry: CachedRun = { metadata, summary, events, graph: null, causeIndex: null };
    this.cache.set(runId, entry);
    return entry;
  }

  /**
   * Cause index for a run, built once and cached. For live sessions the
   * index is extended incrementally as new events arrive — never rebuilt
   * from scratch per query.
   */
  private getCauseIndex(runId: string, run: CachedRun): CauseIndex {
    if (!run.causeIndex) {
      run.causeIndex = buildCauseIndex(
        run.events,
        runId,
        Date.parse(run.metadata.startTime),
      );
    }
    return run.causeIndex;
  }

  /**
   * Cause index for a live session: extended incrementally with events
   * that arrived since the last query.
   */
  private getLiveCauseIndex(session: LiveSessionLike, startTimeMs: number): CauseIndex {
    let index = this.liveCauseIndexes.get(session.runId);
    if (!index) {
      index = buildCauseIndex([], session.runId, startTimeMs);
      this.liveCauseIndexes.set(session.runId, index);
    }
    const total = session.eventsSlice(0, 0).total;
    if (index.ordered.length < total) {
      const missing = session.eventsSlice(index.ordered.length, total - index.ordered.length);
      extendCauseIndex(index, missing.events);
    }
    return index;
  }

  private async getGraph(runId: string): Promise<ApiGraph | null> {
    const run = await this.loadRun(runId);
    if (!run) return null;
    if (!run.graph) {
      run.graph = buildGraphFromEvents(run.events, {
        runId,
        commandLine: run.metadata.commandLine,
        startTimeMs: Date.parse(run.metadata.startTime),
      });
    }
    return run.graph;
  }

  /**
   * Highlights for a saved run: read the highlights.json cache, computing
   * it deterministically from events.jsonl when missing (old runs).
   */
  private async getHighlights(
    runId: string,
    run: { metadata: RunMetadata; events: GhostGlassEvent[] },
  ): Promise<Highlight[]> {
    const { config } = await loadHighlightConfig(this.cwd);
    return readHighlights(this.runDir(runId), runId, run.metadata, async () => run.events, config);
  }

  private async getDiff(runA: string, runB: string): Promise<RunDiff | null> {
    const key = `${runA}<${runB}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    let a, b;
    try {
      [a, b] = await Promise.all([
        loadRunData(this.cwd, runA),
        loadRunData(this.cwd, runB),
      ]);
    } catch {
      return null;
    }
    const diff = compareRuns(a, b);
    this.diffCache.set(key, diff);
    return diff;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  /**
   * Server-Sent Events endpoint for one live run.
   *
   * Wire format:
   *   event: hello   — {"runId","status","commandLine","startTimeMs"}
   *   event: events  — {"events":[...]} with an `id:` of the last event
   *                    (drives Last-Event-ID reconnects)
   *   event: status  — LiveStatusPayload on every status transition
   *   event: ping    — keep-alive every SSE_PING_MS
   *
   * The client passes ?since=<eventId> (or the browser sends Last-Event-ID
   * automatically on reconnect); missed events are replayed first, in
   * chunks, then live batches follow. SSE was chosen over WebSocket because
   * the traffic is strictly server → browser and EventSource gives us
   * native reconnect with Last-Event-ID for free.
   */
  private handleLiveStream(
    req: IncomingMessage,
    res: ServerResponse,
    session: LiveSessionLike,
    url: URL,
  ): void {
    const since =
      url.searchParams.get("since") ??
      (typeof req.headers["last-event-id"] === "string"
        ? (req.headers["last-event-id"] as string)
        : null);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Flush headers immediately so the browser's EventSource connects.
    res.flushHeaders?.();

    let dead = false;
    const send = (event: string, id: string | null, data: string): void => {
      if (dead || res.destroyed) return;
      let chunk = "";
      if (id) chunk += `id: ${id}\n`;
      chunk += `event: ${event}\ndata: ${data}\n\n`;
      const ok = res.write(chunk);
      // Measure real backpressure from the socket buffer, not a cumulative
      // counter: a healthy client that keeps up must never trip this.
      const pending = res.writableLength;
      if (!ok && pending > SSE_MAX_BUFFERED) {
        // Chronically slow reader: ask it to resync instead of ballooning
        // server memory. end() (not destroy()) so the error frame flushes
        // before the FIN; dead=true already stops further sends.
        dead = true;
        try {
          res.end(`event: error\ndata: ${JSON.stringify({ error: "slow reader; please reconnect with ?since=<lastEventId>" })}\n\n`);
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
        return;
      }
    };

    const hello = session.getStatus();
    send(
      "hello",
      null,
      JSON.stringify({
        runId: hello.runId,
        status: hello.status,
        commandLine: hello.commandLine,
        startTimeMs: hello.startTimeMs,
      }),
    );

    const sub: LiveSubscriber = {
      onEvents: (events: GhostGlassEvent[]) => {
        // Chunk large replays so one message never carries the whole run.
        for (let i = 0; i < events.length; i += SSE_REPLAY_CHUNK) {
          const slice = events.slice(i, i + SSE_REPLAY_CHUNK);
          const last = slice[slice.length - 1] as GhostGlassEvent;
          send("events", last.id, JSON.stringify({ events: slice }));
          if (dead) return;
        }
      },
      onStatus: (status) => {
        send("status", null, JSON.stringify(status));
      },
      onHighlights: (highlights) => {
        send("highlights", null, JSON.stringify({ highlights }));
      },
    };
    const unsubscribe = session.subscribe(sub, since);

    const ping = setInterval(() => {
      if (!res.destroyed) send("ping", null, "{}");
    }, SSE_PING_MS);
    ping.unref?.();

    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api/runs") {
      const runs = await listRuns(this.cwd);
      const items: ApiRunListItem[] = [];
      for (const r of runs) {
        const run = await this.loadRun(r.runId);
        items.push({
          runId: r.runId,
          commandLine: r.metadata.commandLine,
          startTime: r.metadata.startTime,
          durationMs: r.metadata.durationMs,
          exitCode: r.metadata.exitCode,
          signal: r.metadata.signal,
          interrupted: run?.metadata.interrupted ?? false,
          eventCount: run?.events.length ?? 0,
        });
      }
      this.json(res, 200, { runs: items });
      return;
    }

    const liveStatusMatch = path.match(/^\/api\/live\/([^/]+)\/status$/);
    if (liveStatusMatch) {
      const rawId = decodeURIComponent(liveStatusMatch[1] as string);
      if (!isValidRunId(rawId)) {
        this.json(res, 400, { error: "invalid run id" });
        return;
      }
      const session = this.liveSessions.get(rawId);
      if (!session) {
        this.json(res, 404, { error: "no live session for run" });
        return;
      }
      this.json(res, 200, session.getStatus());
      return;
    }

    const liveStreamMatch = path.match(/^\/api\/live\/([^/]+)\/stream$/);
    if (liveStreamMatch) {
      const rawId = decodeURIComponent(liveStreamMatch[1] as string);
      if (!isValidRunId(rawId)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid run id");
        return;
      }
      const session = this.liveSessions.get(rawId);
      if (!session) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no live session for run");
        return;
      }
      this.handleLiveStream(req, res, session, url);
      return;
    }

    const diffMatch = path.match(/^\/api\/diff\/([^/]+)\/([^/]+)$/);
    if (diffMatch) {
      const idA = decodeURIComponent(diffMatch[1] as string);
      const idB = decodeURIComponent(diffMatch[2] as string);
      if (!isValidRunId(idA) || !isValidRunId(idB)) {
        this.json(res, 400, { error: "invalid run id" });
        return;
      }
      const diff = await this.getDiff(idA, idB);
      if (!diff) {
        this.json(res, 404, { error: "run not found" });
        return;
      }
      this.json(res, 200, diff);
      return;
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/graph|\/timeline|\/events|\/highlights|\/why)?$/);
    if (runMatch) {
      const rawId = decodeURIComponent(runMatch[1] as string);
      const suffix = runMatch[2] as string | undefined;
      if (!isValidRunId(rawId)) {
        this.json(res, 400, { error: "invalid run id" });
        return;
      }
      if (!suffix) {
        const run = await this.loadRun(rawId);
        if (!run) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        const detail: ApiRunDetail = { metadata: run.metadata, summary: run.summary };
        this.json(res, 200, detail);
        return;
      }
      if (suffix === "/graph") {
        const graph = await this.getGraph(rawId);
        if (!graph) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        this.json(res, 200, graph);
        return;
      }
      if (suffix === "/timeline") {
        const run = await this.loadRun(rawId);
        if (!run) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        const startTimeMs = Date.parse(run.metadata.startTime);
        this.json(res, 200, buildTimelinePayload(startTimeMs, run.events));
        return;
      }
      if (suffix === "/highlights") {
        // Live sessions serve in-memory highlights; saved runs serve the
        // highlights.json cache (regenerated deterministically on demand).
        const live = this.liveSessions.get(rawId);
        if (live) {
          this.json(res, 200, { runId: rawId, highlights: live.getHighlights() });
          return;
        }
        const run = await this.loadRun(rawId);
        if (!run) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        const highlights = await this.getHighlights(rawId, run);
        this.json(res, 200, { runId: rawId, highlights });
        return;
      }
      if (suffix === "/why") {
        // Cause chain for one target. Query params:
        //   target=event&eventId=... | target=pid&pid=123
        //   target=file&path=... | target=network&destination=ip:port
        //   target=highlight&highlightId=...
        // Live sessions resolve against their incremental in-memory index;
        // saved runs use the cached per-run index.
        const targetKind = url.searchParams.get("target");
        let target: CauseTarget | null = null;
        if (targetKind === "event" && url.searchParams.get("eventId")) {
          target = { kind: "event", eventId: url.searchParams.get("eventId") as string };
        } else if (targetKind === "pid" && url.searchParams.get("pid")) {
          const pid = Number(url.searchParams.get("pid"));
          if (Number.isInteger(pid) && pid >= 0) target = { kind: "pid", pid };
        } else if (targetKind === "file" && url.searchParams.get("path")) {
          target = { kind: "file", path: url.searchParams.get("path") as string };
        } else if (targetKind === "network" && url.searchParams.get("destination")) {
          target = { kind: "network", destination: url.searchParams.get("destination") as string };
        } else if (targetKind === "highlight" && url.searchParams.get("highlightId")) {
          target = { kind: "highlight", highlightId: url.searchParams.get("highlightId") as string };
        }
        if (!target) {
          this.json(res, 400, { error: "invalid or missing target parameters" });
          return;
        }
        const live = this.liveSessions.get(rawId);
        if (live) {
          const status = live.getStatus();
          const index = this.getLiveCauseIndex(live, status.startTimeMs);
          const result = buildCauseChain(
            { index, commandLine: status.commandLine, highlights: live.getHighlights() },
            target,
          );
          if (!result.ok) {
            this.json(res, result.ambiguous ? 409 : 404, {
              error: result.error,
              ambiguous: result.ambiguous ?? undefined,
            });
            return;
          }
          this.json(res, 200, { runId: rawId, live: true, chain: result.chain });
          return;
        }
        const run = await this.loadRun(rawId);
        if (!run) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        const index = this.getCauseIndex(rawId, run);
        const highlights =
          target.kind === "highlight" ? await this.getHighlights(rawId, run) : undefined;
        const result = buildCauseChain(
          { index, commandLine: run.metadata.commandLine, highlights },
          target,
        );
        if (!result.ok) {
          this.json(res, result.ambiguous ? 409 : 404, {
            error: result.error,
            ambiguous: result.ambiguous ?? undefined,
          });
          return;
        }
        this.json(res, 200, { runId: rawId, chain: result.chain });
        return;
      }
      if (suffix === "/events") {
        // A live session serves its in-memory events so a refreshing
        // browser can reload history mid-run (metadata.json only exists
        // after finalization).
        const live = this.liveSessions.get(rawId);
        if (live) {
          const total = live.eventsSlice(0, 0).total;
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
          const limit = Math.min(
            MAX_PAGE_LIMIT,
            Math.max(1, Number(url.searchParams.get("limit") ?? "1000") || 1000),
          );
          const page: ApiEventsPage = {
            total,
            offset,
            limit,
            events: live.eventsSlice(offset, limit).events,
          };
          this.json(res, 200, page);
          return;
        }
        const run = await this.loadRun(rawId);
        if (!run) {
          this.json(res, 404, { error: "run not found" });
          return;
        }
        const total = run.events.length;
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
        const limit = Math.min(
          MAX_PAGE_LIMIT,
          Math.max(1, Number(url.searchParams.get("limit") ?? "1000") || 1000),
        );
        const page: ApiEventsPage = {
          total,
          offset,
          limit,
          events: run.events.slice(offset, offset + limit),
        };
        this.json(res, 200, page);
        return;
      }
    }

    // Viewer page routes: "/" (run picker), "/runs/<id>", "/live/<id>",
    // and "/diff/<a>/<b>".
    if (
      path === "/" ||
      /^\/runs\/[^/]+$/.test(path) ||
      /^\/live\/[^/]+$/.test(path) ||
      /^\/diff\/[^/]+\/[^/]+$/.test(path)
    ) {
      if (path !== "/") {
        const parts = path.slice(1).split("/");
        for (const rawId of parts.slice(1)) {
          if (!isValidRunId(decodeURIComponent(rawId))) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
            return;
          }
        }
      }
      await this.serveStatic(res, join(WEB_DIST, "index.html"), ".html");
      return;
    }

    // Static assets from the bundled web build only.
    const rel = path.startsWith("/") ? path.slice(1) : path;
    let filePath: string | null = null;
    try {
      const decoded = decodeURIComponent(rel);
      if (decoded.includes("\u0000")) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request");
        return;
      }
      const candidate = normalize(join(WEB_DIST, decoded));
      if (candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep)) filePath = candidate;
    } catch {
      filePath = null;
    }
    if (!filePath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    await this.serveStatic(res, filePath, extname(filePath).toLowerCase());
  }

  private async serveStatic(res: ServerResponse, filePath: string, ext: string): Promise<void> {
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": data.length,
        "cache-control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }
}
