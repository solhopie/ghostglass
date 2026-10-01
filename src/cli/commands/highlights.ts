/**
 * `ghostglass highlights <run-id> [--json]`
 *
 * Print the behavior highlights derived from a run's trace.
 * Highlights describe observed behavior — never security verdicts.
 */
import { join } from "node:path";
import chalk from "chalk";
import { readJsonFile, type RunMetadata } from "../../storage/runStore.js";
import type { GhostGlassEvent } from "../../events/types.js";
import { readHighlights } from "../../highlights/storage.js";
import { loadHighlightConfig } from "../../highlights/config.js";
import { formatHighlightLine } from "../format.js";
import type { Highlight } from "../../highlights/types.js";
import { resolveRunId } from "./open.js";

async function readEventsJsonl(path: string): Promise<GhostGlassEvent[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GhostGlassEvent);
}

function printText(highlights: Highlight[], runId: string, runStartMs: number): void {
  if (highlights.length === 0) {
    console.log(chalk.dim(`No highlights for ${runId} — nothing crossed the activity thresholds.`));
    return;
  }
  console.log(chalk.bold(`Highlights for ${runId} (${highlights.length})`));
  console.log(chalk.dim("Notable behavior observed — not a security verdict."));
  console.log("");
  for (const h of highlights) {
    const rel = ((h.startTimestamp - runStartMs) / 1000).toFixed(2);
    console.log(chalk.dim(`+${rel}s  `) + formatHighlightLine(h).replace("\n", "\n  "));
    console.log(chalk.dim(`  ${h.explanation}`));
    console.log("");
  }
}

export async function highlightsCommand(
  runIdArg: string | undefined,
  options: { cwd: string; json: boolean | undefined },
): Promise<void> {
  let runId: string;
  try {
    runId = await resolveRunId(options.cwd, runIdArg ?? "latest");
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
  const runDir = join(options.cwd, ".ghostglass", "runs", runId);
  let metadata: RunMetadata;
  try {
    metadata = await readJsonFile<RunMetadata>(join(runDir, "metadata.json"));
  } catch {
    console.error(chalk.red(`No saved trace found for run ID "${runId}".`));
    process.exit(1);
  }
  const { config: hlConfig } = await loadHighlightConfig(options.cwd);
  const highlights = await readHighlights(
    runDir,
    runId,
    metadata,
    () => readEventsJsonl(join(runDir, "events.jsonl")),
    hlConfig,
  );

  if (options.json) {
    console.log(JSON.stringify({ runId, highlights }, null, 2));
    return;
  }
  const runStartMs = new Date(metadata.startTime).getTime();
  printText(highlights, runId, runStartMs);
}
