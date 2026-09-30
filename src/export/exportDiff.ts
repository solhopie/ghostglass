/**
 * Diff export model.
 *
 * Gathers everything the static diff report needs: the Run 3 diff model
 * (computed by the same compareRuns engine the live viewer uses) plus the
 * replay timelines for both runs. Redaction is applied to each run's
 * in-memory copy before comparison, so the diff is computed over redacted
 * data and redacted values can never leak through the other side's labels.
 */
import { loadRunData, runDataExists } from "../diff/loadRuns.js";
import { compareRuns, type RunData } from "../diff/compareRuns.js";
import type { RunDiff } from "../diff/types.js";
import type { ApiTimeline } from "../viewer/protocol.js";
import { redactRunData, type RedactOptions } from "./redact.js";
import { buildTimeline } from "./exportRun.js";

export interface DiffExportModel {
  diff: RunDiff;
  timelineA: ApiTimeline;
  timelineB: ApiTimeline;
}

export async function buildDiffExportModel(
  cwd: string,
  runA: string,
  runB: string,
  redact: RedactOptions = {},
): Promise<DiffExportModel> {
  for (const id of [runA, runB]) {
    if (!(await runDataExists(cwd, id))) {
      throw new Error(`Run not found: ${id}`);
    }
  }
  const [dataA, dataB]: [RunData, RunData] = await Promise.all([
    loadRunData(cwd, runA),
    loadRunData(cwd, runB),
  ]);
  redactRunData(dataA, redact);
  redactRunData(dataB, redact);
  const diff = compareRuns(dataA, dataB);
  return {
    diff,
    timelineA: buildTimeline(dataA.metadata, dataA.events),
    timelineB: buildTimeline(dataB.metadata, dataB.events),
  };
}
