/**
 * Portable structured JSON export (--format json).
 *
 * A machine-readable GhostGlass report: metadata, summary, and normalized
 * events for a run, or the structured Run 3 diff model for a comparison.
 * Useful for developers, CI artifacts, and future tooling.
 */
import { readPackageVersion } from "../cli/version.js";
import { buildDiffExportModel, type DiffExportModel } from "./exportDiff.js";
import { buildRunExportModel, type RunExportModel } from "./exportRun.js";
import type { RedactOptions } from "./redact.js";

export const EXPORT_FORMAT_VERSION = 1;

export interface JsonExportEnvelope {
  format: "ghostglass-json";
  formatVersion: number;
  ghostglassVersion: string;
  exportedAt: string;
  type: "run" | "diff";
}

export interface RunJsonExport extends JsonExportEnvelope {
  type: "run";
  metadata: RunExportModel["metadata"];
  summary: RunExportModel["summary"];
  events: RunExportModel["events"];
}

export interface DiffJsonExport extends JsonExportEnvelope {
  type: "diff";
  diff: DiffExportModel["diff"];
  timelineA: DiffExportModel["timelineA"];
  timelineB: DiffExportModel["timelineB"];
}

function envelope<T extends "run" | "diff">(
  type: T,
  exportedAt?: string,
): JsonExportEnvelope & { type: T } {
  return {
    format: "ghostglass-json",
    formatVersion: EXPORT_FORMAT_VERSION,
    ghostglassVersion: readPackageVersion(),
    exportedAt: exportedAt ?? new Date().toISOString(),
    type,
  };
}

export async function buildRunJsonExport(
  cwd: string,
  runId: string,
  redact: RedactOptions = {},
  exportedAt?: string,
): Promise<RunJsonExport> {
  const model = await buildRunExportModel(cwd, runId, redact);
  return {
    ...envelope("run", exportedAt),
    metadata: model.metadata,
    summary: model.summary,
    events: model.events,
  };
}

export async function buildDiffJsonExport(
  cwd: string,
  runA: string,
  runB: string,
  redact: RedactOptions = {},
  exportedAt?: string,
): Promise<DiffJsonExport> {
  const model = await buildDiffExportModel(cwd, runA, runB, redact);
  return {
    ...envelope("diff", exportedAt),
    diff: model.diff,
    timelineA: model.timelineA,
    timelineB: model.timelineB,
  };
}
