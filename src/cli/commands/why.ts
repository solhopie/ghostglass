/**
 * `ghostglass why <run-id> --event <id> | --pid <n> | --file <path> | --network <dest> [--json]`
 *
 * Show the recorded execution path that led to a file, network destination,
 * process, event, or behavior highlight. Deterministic, local, evidence-only:
 * no AI, no guessing, no security verdicts.
 */
import { join } from "node:path";
import chalk from "chalk";
import { readJsonFile, type RunMetadata } from "../../storage/runStore.js";
import type { GhostGlassEvent } from "../../events/types.js";
import { readHighlights } from "../../highlights/storage.js";
import { loadHighlightConfig } from "../../highlights/config.js";
import {
  buildCauseIndex,
  buildCauseChain,
  renderPathSummary,
  type CauseChain,
  type CauseTarget,
} from "../../cause/index.js";
import { resolveRunId } from "./open.js";

async function readEventsJsonl(path: string): Promise<GhostGlassEvent[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GhostGlassEvent);
}

export interface WhyOptions {
  cwd: string;
  json: boolean | undefined;
  event: string | undefined;
  pid: string | undefined;
  file: string | undefined;
  network: string | undefined;
  highlight: string | undefined;
}

function resolveTarget(opts: WhyOptions): CauseTarget | { error: string } {
  const given = [
    opts.event !== undefined ? "event" : null,
    opts.pid !== undefined ? "pid" : null,
    opts.file !== undefined ? "file" : null,
    opts.network !== undefined ? "network" : null,
    opts.highlight !== undefined ? "highlight" : null,
  ].filter((x): x is string => x !== null);
  if (given.length === 0) {
    return { error: "Specify a target: --event <id>, --pid <n>, --file <path>, --network <host:port>, or --highlight <id>." };
  }
  if (given.length > 1) {
    return { error: `Specify exactly one target (got: ${given.join(", ")}).` };
  }
  if (opts.event !== undefined) return { kind: "event", eventId: opts.event };
  if (opts.pid !== undefined) {
    const pid = Number(opts.pid);
    if (!Number.isInteger(pid) || pid < 0) return { error: `Invalid PID: "${opts.pid}".` };
    return { kind: "pid", pid };
  }
  if (opts.file !== undefined) return { kind: "file", path: opts.file };
  if (opts.network !== undefined) return { kind: "network", destination: opts.network };
  return { kind: "highlight", highlightId: opts.highlight as string };
}

function formatOffset(ms: number, runStartMs: number): string {
  return `+${((ms - runStartMs) / 1000).toFixed(3)}s`;
}

function printText(chain: CauseChain, runStartMs: number): void {
  const confColor =
    chain.confidence === "direct"
      ? chalk.green
      : chain.confidence === "structural"
        ? chalk.yellow
        : chalk.red;
  console.log(chalk.bold("CAUSE CHAIN"));
  console.log(chalk.dim(`Target: ${chain.targetLabel}`));
  console.log(`Confidence: ${confColor(chain.confidence.toUpperCase())}`);
  console.log("");
  chain.paths.forEach((path, i) => {
    if (chain.paths.length > 1) console.log(chalk.bold(`Path ${i + 1}: ${path.label}`));
    const nodes = path.nodes;
    nodes.forEach((node, j) => {
      const indent = "  ".repeat(j);
      const offset = node.timestamp !== undefined ? chalk.dim(formatOffset(node.timestamp, runStartMs)) : "";
      console.log(`${indent}${j === 0 ? "┌" : "↓"} ${chalk.cyan(node.label)} ${offset}`);
      if (node.detail) console.log(`${indent}  ${chalk.dim(node.detail)}`);
      const edge = path.edges.find((e) => e.to === node.id);
      if (edge && j > 0) {
        console.log(`${indent}  ${chalk.dim(`[${edge.kind}]`)}${edge.evidence ? ` ${chalk.dim(edge.evidence)}` : ""}`);
      }
    });
    console.log("");
  });
  console.log(chalk.bold("Explanation"));
  console.log(chain.explanation);
  console.log("");
  if (chain.evidence.length > 0) {
    console.log(chalk.bold("Evidence"));
    for (const ev of chain.evidence) console.log(chalk.dim(`  • ${ev}`));
    console.log("");
  }
  if (chain.paths.length > 1) {
    console.log(chalk.dim("Tip: each contributing path is shown separately — they are not merged."));
  }
}

export async function whyCommand(
  runIdArg: string | undefined,
  options: WhyOptions,
): Promise<void> {
  const targetOrError = resolveTarget(options);
  if ("error" in targetOrError) {
    console.error(chalk.red(targetOrError.error));
    process.exit(1);
  }
  const target = targetOrError as CauseTarget;

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

  const events = await readEventsJsonl(join(runDir, "events.jsonl"));
  const runStartMs = new Date(metadata.startTime).getTime();
  const index = buildCauseIndex(events, runId, runStartMs);

  let highlights;
  if (target.kind === "highlight") {
    const { config } = await loadHighlightConfig(options.cwd);
    highlights = await readHighlights(runDir, runId, metadata, async () => events, config);
  }

  const result = buildCauseChain({ index, commandLine: metadata.commandLine, highlights }, target);
  if (!result.ok) {
    if (result.ambiguous) {
      console.error(chalk.red(result.error));
      result.ambiguous.matches.forEach((m, i) => console.error(chalk.dim(`  ${i + 1}. ${m}`)));
      console.error(chalk.dim('Re-run with the exact path, e.g. --file "/full/path".'));
    } else {
      console.error(chalk.red(result.error));
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ runId, chain: result.chain }, null, 2));
    return;
  }
  // Show the compact path summary first for scannability.
  for (const p of result.chain.paths) {
    console.log(chalk.dim(renderPathSummary(p)));
  }
  console.log("");
  printText(result.chain, runStartMs);
}
