/** Thin fetch client for the local viewer API. Same-origin, no auth. */
import { getStaticResponse } from "./staticData.js";
import type {
  ApiGraph,
  ApiRunListItem,
  ApiTimeline,
  GhostGlassEvent,
  RunDiff,
  RunMetadata,
  RunSummary,
} from "./types.js";

async function getJson<T>(path: string): Promise<T> {
  // In a static export the data is embedded in the page; serve it from
  // memory so every view works unchanged with no server.
  const staticRes = getStaticResponse(path);
  if (staticRes.found) return staticRes.value as T;
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  return (await res.json()) as T;
}

export function getRuns(): Promise<{ runs: ApiRunListItem[] }> {
  return getJson("/api/runs");
}

export function getRunDetail(runId: string): Promise<{ metadata: RunMetadata; summary: RunSummary }> {
  return getJson(`/api/runs/${encodeURIComponent(runId)}`);
}

export function getGraph(runId: string): Promise<ApiGraph> {
  return getJson(`/api/runs/${encodeURIComponent(runId)}/graph`);
}

export function getTimeline(runId: string): Promise<ApiTimeline> {
  return getJson(`/api/runs/${encodeURIComponent(runId)}/timeline`);
}

export interface EventsPage {
  total: number;
  offset: number;
  limit: number;
  events: GhostGlassEvent[];
}

export function getEventsPage(runId: string, offset: number, limit: number): Promise<EventsPage> {
  const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return getJson(`/api/runs/${encodeURIComponent(runId)}/events?${q.toString()}`);
}

export function getDiff(runA: string, runB: string): Promise<RunDiff> {
  return getJson(
    `/api/diff/${encodeURIComponent(runA)}/${encodeURIComponent(runB)}`,
  );
}

/** Live session status, served by the backend while (and just after) a watched command runs. */
export interface LiveStatusPayload {
  runId: string;
  status: "running" | "complete" | "interrupted" | "exited";
  commandLine: string;
  startTimeMs: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  eventCount: number;
}

export function getLiveStatus(runId: string): Promise<LiveStatusPayload> {
  return getJson(`/api/live/${encodeURIComponent(runId)}/status`);
}
