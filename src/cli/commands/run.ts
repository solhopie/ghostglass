import { join } from "node:path";
import chalk from "chalk";
import { selectBackend } from "../../tracer/index.js";
import { parseTraceFile } from "../../parser/index.js";
import {
  allocateRun,
  commandLineString,
  writeEventsJsonl,
  writeJsonFile,
  type RunMetadata,
} from "../../storage/runStore.js";
import { buildSummary } from "../../summary/summarize.js";
import { formatSummaryText } from "../format.js";
import { readPackageVersion } from "../version.js";

const SIGNAL_EXIT_OFFSET = 128;
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function exitCodeForSignal(signal: string): number {
  return SIGNAL_EXIT_OFFSET + (SIGNAL_NUMBERS[signal] ?? 0);
}

/**
 * `ghostglass run -- <command...>`
 *
 * Trace the command, normalize the raw trace into GhostGlass events, persist
 * the run, print the summary, and exit with the traced command's exit code.
 */
export async function runCommand(
  command: string[],
  options: { cwd: string },
): Promise<void> {
  if (command.length === 0) {
    console.error(
      chalk.red("No command provided.\n\nUsage:\n  ghostglass run -- <command> [args...]"),
    );
    process.exit(2);
  }

  const tracer = selectBackend();
  const availability = await tracer.checkAvailable();
  if (!availability.available) {
    console.error(chalk.red(availability.detail));
    process.exit(1);
  }

  const { runId, runDir } = await allocateRun(options.cwd);
  const commandLine = commandLineString(command);
  console.log(chalk.dim(`Tracing: ${commandLine}`));
  console.log(chalk.dim(`Run ID:  ${runId}`));

  const rawTracePath = join(runDir, "trace.log");
  const result = await tracer.run(command, {
    cwd: options.cwd,
    rawTracePath,
  });

  const parsed = await parseTraceFile(rawTracePath, runId, result.startTimeMs);

  if (parsed.rootPid === undefined) {
    // strace never observed the command's execve: it likely does not exist
    // or could not be started. Say so plainly instead of writing an empty run.
    console.error(
      chalk.red(
        `\nGhostGlass captured no process activity for: ${commandLine}\n` +
          "The command may not exist or could not be started " +
          "(check that it is on your PATH). No trace was saved.",
      ),
    );
    process.exit(1);
  }

  // Prefer the exit code observed inside the trace ("+++ exited with N +++");
  // fall back to the wrapper's observation.
  const exitCode = parsed.rootExitCode ?? result.exitCode ?? null;
  const signal = parsed.rootSignal ?? result.signal;
  const interrupted = result.forwardedSignal !== null;

  const summary = buildSummary(
    runId,
    command,
    commandLine,
    parsed.events,
    result.durationMs,
    exitCode,
    signal,
  );

  const metadata: RunMetadata = {
    ghostglassVersion: readPackageVersion(),
    runId,
    command,
    commandLine,
    startTime: new Date(result.startTimeMs).toISOString(),
    endTime: new Date(result.endTimeMs).toISOString(),
    durationMs: result.durationMs,
    os: {
      platform: process.platform,
      arch: process.arch,
      release: process.release?.name ?? "node",
    },
    exitCode,
    signal,
    interrupted,
    backend: tracer.name,
    eventCount: parsed.events.length,
    parseStats: { ...parsed.stats },
  };

  // Never dump the user's environment into the trace: execve lines only ever
  // carry the env pointer ("/* 42 vars */"), never values, and we do not
  // record process.env anywhere.
  await writeEventsJsonl(join(runDir, "events.jsonl"), parsed.events);
  await writeJsonFile(join(runDir, "summary.json"), summary);
  await writeJsonFile(join(runDir, "metadata.json"), metadata);

  console.log("");
  console.log(formatSummaryText(metadata, summary));

  // Preserve the target command's exit semantics.
  if (signal !== null && signal !== undefined) {
    process.exit(exitCodeForSignal(signal));
  }
  process.exit(exitCode ?? 1);
}
