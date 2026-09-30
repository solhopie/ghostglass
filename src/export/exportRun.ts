/**
 * Run export model.
 *
 * Gathers everything the static run report needs from the saved run store:
 * metadata, summary, the derived graph, the replay timeline, and the full
 * normalized event list. The same builders the live viewer server uses
 * (loadRunData, buildGraphFromEvents) produce the data, so the static
 * report and the live viewer can never disagree.
 *
 * Redaction, when requested, is applied to the in-memory copy BEFORE the
 * graph/timeline are derived, keeping every view consistent. The saved
 * run on disk is never modified.
 */
import { loadRunData, runDataExists } from "../diff/loadRuns.js";
import { compareRuns, type RunData } from "../diff/compareRuns.js";
import { buildGraphFromEvents } from "../viewer/indexer.js";
import type { ApiGraph, ApiTimeline } from "../viewer/protocol.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { RunSummary } from "../summary/summarize.js";
import type { GhostGlassEvent } from "../events/types.js";
import { redactRunData, type RedactOptions } from "./redact.js";

export interface RunExportModel {
  metadata: RunMetadata;
  summary: RunSummary;
  graph: ApiGraph;
  timeline: ApiTimeline;
  events: GhostGlassEvent[];
}

/** Build the timeline payload exactly like the live viewer's /timeline route. */
export function buildTimeline(metadata: RunMetadata, events: GhostGlassEvent[]): ApiTimeline {
  const startTimeMs = Date.parse(metadata.startTime);
  const timestamps = events.map((e) => e.timestamp).sort((a, b) => a - b);
  return {
    startTimeMs,
    endTimeMs: timestamps.length > 0 ? (timestamps[timestamps.length - 1] as number) : startTimeMs,
    timestamps,
  };
}

/**
 * Load a run and build its export model. Throws a clean error when the
 * run does not exist.
 */
export async function buildRunExportModel(
  cwd: string,
  runId: string,
  redact: RedactOptions = {},
): Promise<RunExportModel> {
  if (!(await runDataExists(cwd, runId))) {
    throw new Error(`Run not found: ${runId}`);
  }
  const data: RunData = await loadRunData(cwd, runId);
  redactRunData(data, redact);
  const graph = buildGraphFromEvents(data.events, {
    runId,
    commandLine: data.metadata.commandLine,
    startTimeMs: Date.parse(data.metadata.startTime),
  });
  const timeline = buildTimeline(data.metadata, data.events);
  return {
    metadata: data.metadata,
    summary: data.summary,
    graph,
    timeline,
    events: data.events,
  };
}

/** Re-exported for the diff export path. */
export { compareRuns };
export type { RunData };
