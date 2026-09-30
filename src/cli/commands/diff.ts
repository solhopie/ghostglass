/**
 * `ghostglass diff <run-a> <run-b>` — compare two saved runs.
 *
 * Prints a compact terminal diff, then starts the local visual comparison
 * viewer on 127.0.0.1. Accepts "latest" and "previous" as aliases for the
 * newest and second-newest runs.
 */
import chalk from "chalk";
import { listRuns, runDirExists } from "../../storage/runStore.js";
import { RUN_ID_RE, VIEWER_HOST, ViewerServer } from "../../viewer/server.js";
import { compareRuns } from "../../diff/compareRuns.js";
import { loadRunData } from "../../diff/loadRuns.js";
import type { RunDiff } from "../../diff/types.js";
import { openBrowser } from "./open.js";
import { formatDuration } from "../format.js";

export interface DiffOptions {
  cwd: string;
  port?: number | undefined;
  noBrowser?: boolean | undefined;
}

type Alias = "latest" | "previous";

function isAlias(s: string): s is Alias {
  return s === "latest" || s === "previous";
}

/**
 * Resolve "latest"/"previous"/run-id arguments to concrete run IDs.
 * Throws a clean, actionable error when the store has too few runs.
 */
export async function resolveDiffRunIds(
  cwd: string,
  a: string,
  b: string,
): Promise<[string, string]> {
  const runs = await listRuns(cwd);
  const resolveOne = (s: string): string => {
    if (isAlias(s)) {
      const idx = s === "latest" ? 0 : 1;
      const run = runs[idx];
      if (!run) {
        throw new Error(
          `Cannot resolve "${s}": only ${runs.length} saved run${runs.length === 1 ? "" : "s"} here. ` +
            "Record two runs first: ghostglass run -- <command>",
        );
      }
      return run.runId;
    }
    if (!RUN_ID_RE.test(s)) {
      throw new Error(`Invalid run ID "${s}". Expected e.g. gg_20260930_001, "latest", or "previous".`);
    }
    return s;
  };
  const idA = resolveOne(a);
  const idB = resolveOne(b);
  for (const id of [idA, idB]) {
    if (!(await runDirExists(cwd, id))) {
      throw new Error(`Run not found: ${id}`);
    }
  }
  return [idA, idB];
}

function fmtDelta(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toLocaleString("en-US")}`;
}

function fmtDeltaDuration(ms: number): string {
  if (ms === 0) return "±0";
  const sign = ms > 0 ? "+" : "−";
  const abs = Math.abs(ms);
  const body = abs < 1000 ? `${Math.round(abs)}ms` : `${(abs / 1000).toFixed(2)}s`;
  return `${sign}${body}`;
}

/** Compact terminal diff, printed before the browser opens. */
export function formatDiffText(diff: RunDiff): string {
  const lines: string[] = [];
  const s = diff.summary;
  const countStatus = (arr: { status: string }[], status: string): number =>
    arr.filter((e) => e.status === status).length;
  const both = (arr: { status: string }[]): number =>
    arr.filter((e) => e.status === "shared" || e.status === "changed").length;

  lines.push(chalk.bold.cyan("GhostGlass Diff"));
  lines.push(chalk.dim("────────────────────────────────"));
  lines.push(`A: ${diff.runA.commandLine}`);
  lines.push(`B: ${diff.runB.commandLine}`);
  lines.push(`A: ${diff.runA.runId}`);
  lines.push(`B: ${diff.runB.runId}`);

  lines.push(chalk.bold("Duration"));
  lines.push(`A  ${formatDuration(s.durationMs.a)}`);
  lines.push(`B  ${formatDuration(s.durationMs.b)}`);
  lines.push(`Δ ${fmtDeltaDuration(s.durationMs.delta)}`);

  lines.push(chalk.bold("Processes"));
  lines.push(`A  ${s.processCount.a.toLocaleString("en-US")}`);
  lines.push(`B  ${s.processCount.b.toLocaleString("en-US")}`);
  lines.push(`Δ ${fmtDelta(s.processCount.delta)}`);

  const filesShared = both(diff.files);
  const filesChanged = countStatus(diff.files, "changed");
  lines.push(chalk.bold("Files"));
  lines.push(
    `Shared      ${filesShared.toLocaleString("en-US")}` +
      (filesChanged > 0 ? chalk.dim(` (${filesChanged.toLocaleString("en-US")} changed)`) : ""),
  );
  lines.push(`Only A      ${countStatus(diff.files, "only-a").toLocaleString("en-US")}`);
  lines.push(`Only B      ${countStatus(diff.files, "only-b").toLocaleString("en-US")}`);

  const netShared = both(diff.network);
  const netChanged = countStatus(diff.network, "changed");
  lines.push(chalk.bold("Network"));
  lines.push(
    `Shared        ${netShared.toLocaleString("en-US")}` +
      (netChanged > 0 ? chalk.dim(` (${netChanged.toLocaleString("en-US")} changed)`) : ""),
  );
  lines.push(`Only A        ${countStatus(diff.network, "only-a").toLocaleString("en-US")}`);
  lines.push(`Only B        ${countStatus(diff.network, "only-b").toLocaleString("en-US")}`);

  if (s.exitCode.changed) {
    lines.push(
      chalk.yellow(
        `Exit code changed: A=${s.exitCode.a ?? "?"} B=${s.exitCode.b ?? "?"}`,
      ),
    );
  }
  if (s.interrupted.changed) {
    lines.push(
      chalk.yellow(
        `Interrupted: A=${s.interrupted.a ? "yes" : "no"} B=${s.interrupted.b ? "yes" : "no"}`,
      ),
    );
  }
  return lines.join("\n");
}

export async function diffCommand(a: string, b: string, opts: DiffOptions): Promise<void> {
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    throw new Error(`invalid port "${String(opts.port)}": must be an integer from 1 to 65535`);
  }
  const [idA, idB] = await resolveDiffRunIds(opts.cwd, a, b);
  const [runA, runB] = await Promise.all([
    loadRunData(opts.cwd, idA),
    loadRunData(opts.cwd, idB),
  ]);
  const diff = compareRuns(runA, runB);
  console.log(formatDiffText(diff));

  const server = new ViewerServer({ cwd: opts.cwd, host: VIEWER_HOST, port: opts.port });
  const { url, port } = await server.start();
  const diffUrl = `${url}/diff/${idA}/${idB}`;
  console.log(`Viewer:\n${diffUrl}`);
  if (port !== (opts.port ?? 7777)) {
    console.log(`(port ${opts.port ?? 7777} was busy; using ${port})`);
  }
  console.log("Press Ctrl+C to stop.");
  if (!opts.noBrowser) openBrowser(diffUrl);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await server.stop();
  console.log("GhostGlass Diff viewer stopped.");
}
