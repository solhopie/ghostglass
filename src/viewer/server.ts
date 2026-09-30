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
import type { ApiEventsPage, ApiGraph, ApiRunDetail, ApiRunListItem, ApiTimeline } from "./protocol.js";
import { compareRuns } from "../diff/compareRuns.js";
import { loadRunData } from "../diff/loadRuns.js";
import type { RunDiff } from "../diff/types.js";

export const DEFAULT_VIEWER_PORT = 7777;
export const VIEWER_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 10;
const MAX_PAGE_LIMIT = 5000;

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
  private readonly cwd: string;
  private readonly host: string;
  private readonly preferredPort: number;
  private boundPort: number | null = null;

  constructor(opts: ViewerServerOptions) {
    this.cwd = opts.cwd;
    this.host = opts.host ?? VIEWER_HOST;
    this.preferredPort = opts.port ?? DEFAULT_VIEWER_PORT;
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
    const [metadata, summary] = await Promise.all([
      readJsonFile<RunMetadata>(join(dir, "metadata.json")),
      readJsonFile<RunSummary>(join(dir, "summary.json")),
    ]);
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
    const entry: CachedRun = { metadata, summary, events, graph: null };
    this.cache.set(runId, entry);
    return entry;
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

    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/graph|\/timeline|\/events)?$/);
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
        const timestamps = run.events.map((e) => e.timestamp).sort((a, b) => a - b);
        const timeline: ApiTimeline = {
          startTimeMs,
          endTimeMs: timestamps.length > 0 ? (timestamps[timestamps.length - 1] as number) : startTimeMs,
          timestamps,
        };
        this.json(res, 200, timeline);
        return;
      }
      if (suffix === "/events") {
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

    // Viewer page routes: "/" (run picker), "/runs/<id>", and "/diff/<a>/<b>".
    if (path === "/" || /^\/runs\/[^/]+$/.test(path) || /^\/diff\/[^/]+\/[^/]+$/.test(path)) {
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
