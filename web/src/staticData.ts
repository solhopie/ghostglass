/**
 * Static data layer for exported HTML reports.
 *
 * The live viewer fetches JSON from the local viewer server. An exported
 * report has no server, so this module serves the same api.ts routes from
 * the JSON envelope embedded in the page (<script id="gg-export-data">).
 * All views (graph, timeline, stream, inspectors) are reused unchanged —
 * only the data source differs.
 */
import type {
  ApiGraph,
  ApiRunListItem,
  ApiTimeline,
  GhostGlassEvent,
  RunDiff,
  RunMetadata,
  RunSummary,
} from "./types.js";

interface RunPayload {
  detail: { metadata: RunMetadata; summary: RunSummary };
  graph: ApiGraph;
  timeline: ApiTimeline;
  events: GhostGlassEvent[];
}

interface DiffPayload {
  diff: RunDiff;
  timelineA: ApiTimeline;
  timelineB: ApiTimeline;
}

interface StaticEnvelope {
  format: string;
  type: "run" | "diff";
  route: { kind: string; runId?: string; runA?: string; runB?: string };
  data: RunPayload | DiffPayload;
}

const MAX_PAGE_LIMIT = 5000;

let loaded = false;
const exact = new Map<string, unknown>();
let runEvents: { runId: string; events: GhostGlassEvent[] } | null = null;

function toListItem(metadata: RunMetadata, eventCount: number): ApiRunListItem {
  return {
    runId: metadata.runId,
    commandLine: metadata.commandLine,
    startTime: metadata.startTime,
    durationMs: metadata.durationMs,
    exitCode: metadata.exitCode,
    signal: metadata.signal,
    interrupted: metadata.interrupted,
    eventCount,
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const tag = document.getElementById("gg-export-data");
    if (!tag || !tag.textContent) return;
    const env = JSON.parse(tag.textContent) as StaticEnvelope;
    if (env.format !== "ghostglass-html" || !env.data) return;
    if (env.type === "run") {
      const d = env.data as RunPayload;
      const runId = env.route.runId ?? d.detail.metadata.runId;
      const enc = encodeURIComponent(runId);
      exact.set("/api/runs", { runs: [toListItem(d.detail.metadata, d.events.length)] });
      exact.set(`/api/runs/${enc}`, d.detail);
      exact.set(`/api/runs/${enc}/graph`, d.graph);
      exact.set(`/api/runs/${enc}/timeline`, d.timeline);
      runEvents = { runId, events: d.events };
    } else {
      const d = env.data as DiffPayload;
      const a = encodeURIComponent(env.route.runA ?? "");
      const b = encodeURIComponent(env.route.runB ?? "");
      exact.set(`/api/diff/${a}/${b}`, d.diff);
      exact.set(`/api/runs/${a}/timeline`, d.timelineA);
      exact.set(`/api/runs/${b}/timeline`, d.timelineB);
      exact.set("/api/runs", {
        runs: [
          toListItem(d.diff.runA, d.timelineA.timestamps.length),
          toListItem(d.diff.runB, d.timelineB.timestamps.length),
        ],
      });
    }
  } catch {
    // Not a static report (or corrupt envelope): fall through to fetch.
  }
}

function eventsPage(path: string): unknown | undefined {
  if (!runEvents) return undefined;
  const prefix = `/api/runs/${encodeURIComponent(runEvents.runId)}/events`;
  const qIndex = path.indexOf("?");
  const base = qIndex >= 0 ? path.slice(0, qIndex) : path;
  if (base !== prefix) return undefined;
  const params = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : "");
  const total = runEvents.events.length;
  const offset = Math.max(0, Number(params.get("offset") ?? "0") || 0);
  const limit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, Number(params.get("limit") ?? "1000") || 1000),
  );
  return {
    total,
    offset,
    limit,
    events: runEvents.events.slice(offset, offset + limit),
  };
}

export interface StaticResponse {
  found: boolean;
  value?: unknown;
}

/**
 * Serve an api.ts path from the embedded envelope when this page is a
 * static export. Returns { found: false } for the live viewer (or for
 * unknown paths), in which case api.ts falls back to fetch().
 */
export function getStaticResponse(path: string): StaticResponse {
  load();
  const hit = exact.get(path);
  if (hit !== undefined) return { found: true, value: hit };
  const page = eventsPage(path);
  if (page !== undefined) return { found: true, value: page };
  return { found: false };
}
