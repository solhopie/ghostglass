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
  Highlight,
  RunDiff,
  RunMetadata,
  RunSummary,
} from "./types.js";
import {
  buildCauseIndex,
  buildCauseChain,
  type CauseIndex,
  type CauseTarget,
} from "./cause/index.js";

interface RunPayload {
  detail: { metadata: RunMetadata; summary: RunSummary };
  graph: ApiGraph;
  timeline: ApiTimeline;
  events: GhostGlassEvent[];
  highlights: Highlight[];
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
let runMeta: { runId: string; metadata: RunMetadata; highlights: Highlight[] } | null = null;
let causeIndex: CauseIndex | null = null;

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
      exact.set(`/api/runs/${enc}/highlights`, { highlights: d.highlights ?? [] });
      runEvents = { runId, events: d.events };
      runMeta = { runId, metadata: d.detail.metadata, highlights: d.highlights ?? [] };
      causeIndex = null;
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
 * Serve a /why request from the embedded envelope: derive the cause chain
 * on demand from the embedded events (same engine as the server). This
 * keeps exported HTML fully offline without precomputing every chain.
 */
function whyResponse(path: string): unknown | undefined {
  if (!runEvents || !runMeta) return undefined;
  const prefix = `/api/runs/${encodeURIComponent(runEvents.runId)}/why`;
  const qIndex = path.indexOf("?");
  const base = qIndex >= 0 ? path.slice(0, qIndex) : path;
  if (base !== prefix) return undefined;
  const params = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : "");
  const kind = params.get("target");
  let target: CauseTarget | null = null;
  if (kind === "event" && params.get("eventId")) {
    target = { kind: "event", eventId: params.get("eventId") as string };
  } else if (kind === "pid" && params.get("pid")) {
    const pid = Number(params.get("pid"));
    if (Number.isInteger(pid) && pid >= 0) target = { kind: "pid", pid };
  } else if (kind === "file" && params.get("path")) {
    target = { kind: "file", path: params.get("path") as string };
  } else if (kind === "network" && params.get("destination")) {
    target = { kind: "network", destination: params.get("destination") as string };
  } else if (kind === "highlight" && params.get("highlightId")) {
    target = { kind: "highlight", highlightId: params.get("highlightId") as string };
  }
  if (!target) return { error: "invalid or missing target parameters" };
  if (!causeIndex) {
    causeIndex = buildCauseIndex(
      runEvents.events,
      runMeta.runId,
      Date.parse(runMeta.metadata.startTime),
    );
  }
  const result = buildCauseChain(
    {
      index: causeIndex,
      commandLine: runMeta.metadata.commandLine,
      highlights: target.kind === "highlight" ? runMeta.highlights : undefined,
    },
    target,
  );
  if (!result.ok) {
    return { error: result.error, ambiguous: result.ambiguous ?? undefined };
  }
  return { runId: runMeta.runId, chain: result.chain };
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
  const why = whyResponse(path);
  if (why !== undefined) return { found: true, value: why };
  return { found: false };
}

/** True when this page is a portable static export (file:// or embedded route shim). */
export function isStaticExport(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return true;
  return (
    (window as unknown as { __GG_STATIC_ROUTE__?: unknown }).__GG_STATIC_ROUTE__ !== undefined
  );
}
