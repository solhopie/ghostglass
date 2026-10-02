import { join } from "node:path";
import chalk from "chalk";
import {
  listRuns,
  readJsonFile,
  type RunMetadata,
} from "../../storage/runStore.js";
import type { RunSummary } from "../../summary/summarize.js";
import { formatRunsTable, formatSummaryText } from "../format.js";
import { resolveRunId } from "./open.js";

/** `ghostglass runs` — list recent traces, newest first. */
export async function runsCommand(options: { cwd: string; json?: boolean }): Promise<void> {
  const entries = await listRuns(options.cwd);
  if (options.json) {
    console.log(JSON.stringify(entries));
    return;
  }
  console.log(formatRunsTable(entries));
}

/** `ghostglass show <run-id>` — display a saved run's summary. */
export async function showCommand(
  runIdOrLatest: string,
  options: { cwd: string },
): Promise<void> {
  let runId: string;
  try {
    runId = await resolveRunId(options.cwd, runIdOrLatest);
  } catch {
    // Unknown/malformed ID: fall through to the friendly error below.
    runId = runIdOrLatest;
  }
  const runDir = join(options.cwd, ".ghostglass", "runs", runId);
  let metadata: RunMetadata;
  let summary: RunSummary;
  try {
    metadata = await readJsonFile<RunMetadata>(join(runDir, "metadata.json"));
    summary = await readJsonFile<RunSummary>(join(runDir, "summary.json"));
  } catch {
    console.error(
      chalk.red(
        `No saved trace found for run ID "${runId}".\n` +
          "List available runs with: ghostglass runs",
      ),
    );
    process.exit(1);
  }
  console.log(formatSummaryText(metadata, summary));
}
