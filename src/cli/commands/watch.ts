import { join } from "node:path";
import { rm } from "node:fs/promises";
import chalk from "chalk";
import { selectBackend } from "../../tracer/index.js";
import {
  allocateRun,
  commandLineString,
  readJsonFile,
} from "../../storage/runStore.js";
import type { RunSummary } from "../../summary/summarize.js";
import { LiveSession } from "../../live/liveSession.js";
import { RUN_ID_RE, VIEWER_HOST, ViewerServer } from "../../viewer/server.js";
import { formatDuration, formatSummaryText } from "../format.js";
import { openBrowser } from "./open.js";

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

export interface WatchOptions {
  cwd: string;
  port?: number | undefined;
  noBrowser?: boolean | undefined;
}

/**
 * `ghostglass watch -- <command...>`
 *
 * Live execution visualization: starts the local viewer, opens the browser,
 * runs the command under streaming tracing, and broadcasts normalized
 * events to the viewer as they happen. The completed trace is saved in the
 * normal GhostGlass run format and can be reopened with `ghostglass open`.
 *
 * The traced command's stdio is inherited untouched — normal terminal
 * output is never swallowed. Closing the browser does not stop the trace;
 * if the viewer server fails, tracing and persistence continue.
 */
export async function watchCommand(
  command: string[],
  options: WatchOptions,
): Promise<void> {
  if (command.length === 0) {
    console.error(
      chalk.red("No command provided.\n\nUsage:\n  ghostglass watch -- <command> [args...]"),
    );
    process.exit(2);
  }
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
  ) {
    console.error(
      chalk.red(`invalid port "${String(options.port)}": must be an integer from 1 to 65535`),
    );
    process.exit(2);
  }

  const tracer = selectBackend();
  const availability = await tracer.checkAvailable();
  if (!availability.available) {
    console.error(chalk.red(availability.detail));
    process.exit(1);
  }
  if (typeof tracer.streamLive !== "function") {
    console.error(
      chalk.red(
        `The "${tracer.name}" backend does not support live streaming on this machine.\n` +
          "Use `ghostglass run` for post-hoc tracing instead.",
      ),
    );
    process.exit(1);
  }

  const { runId, runDir } = await allocateRun(options.cwd);
  if (!RUN_ID_RE.test(runId)) throw new Error(`allocated invalid run id: ${runId}`);
  const commandLine = commandLineString(command);
  const startTimeMs = Date.now();

  const session = new LiveSession({
    runId,
    runDir,
    command,
    commandLine,
    backendName: tracer.name,
    startTimeMs,
  });

  // Start the viewer first so the browser can connect before events flow.
  // A viewer failure must not kill the trace: report it and continue
  // headless (the run is still persisted to disk).
  const server = new ViewerServer({ cwd: options.cwd, host: VIEWER_HOST, port: options.port });
  let viewerUrl: string | null = null;
  try {
    const started = await server.start();
    server.registerLiveSession(session);
    viewerUrl = `${started.url}/live/${runId}`;
  } catch (err) {
    console.error(
      chalk.yellow(
        `GhostGlass viewer failed to start (${err instanceof Error ? err.message : String(err)}). ` +
          "Continuing the trace without live visualization.",
      ),
    );
  }

  console.log(chalk.bold.cyan("GhostGlass Live"));
  console.log(chalk.dim("────────────────────────────────"));
  console.log(chalk.bold("Command:"));
  console.log(commandLine);
  console.log(chalk.bold("Run ID:"));
  console.log(runId);
  console.log(chalk.bold("Viewer:"));
  console.log(viewerUrl ?? chalk.dim("(viewer unavailable — tracing headless)"));
  console.log(chalk.dim(`Tracing backend:\n${tracer.name}`));
  console.log(chalk.bold("Status:"));
  console.log(chalk.green("● RUNNING"));
  console.log("");

  if (viewerUrl && !options.noBrowser) {
    openBrowser(viewerUrl);
  }

  // Live terminal ticker for --no-browser / headless runs. The command's
  // own output stays untouched; this is one dim line every few seconds.
  let ticker: NodeJS.Timeout | null = null;
  if (options.noBrowser || !viewerUrl) {
    ticker = setInterval(() => {
      const s = session.getStatus();
      process.stderr.write(
        chalk.dim(
          `\r[live] ${formatDuration(s.durationMs)} · ${s.eventCount.toLocaleString()} events · RUNNING`,
        ),
      );
    }, 3000);
    ticker.unref?.();
  }

  const rawTracePath = join(runDir, "trace.log");
  const stream = tracer.streamLive(command, {
    cwd: options.cwd,
    rawTracePath,
    runId,
  });

  // The iterator owns consumption; done() only signals completion.
  const ingestDone = (async (): Promise<void> => {
    for await (const event of stream) {
      session.ingest(event);
    }
  })();
  const result = await stream.done();
  await ingestDone;
  if (ticker) {
    clearInterval(ticker);
    process.stderr.write("\n");
  }

  // strace never observed the command's execve: it likely does not exist or
  // could not be started. Say so plainly instead of saving an empty run —
  // mirroring `ghostglass run`.
  if (!session.sawExec) {
    await session.discard();
    await server.stop().catch(() => undefined);
    await rm(runDir, { recursive: true, force: true });
    console.error(
      chalk.red(
        `\nGhostGlass captured no process activity for: ${commandLine}\n` +
          "The command may not exist or could not be started " +
          "(check that it is on your PATH). No trace was saved.",
      ),
    );
    process.exit(1);
  }

  const metadata = await session.finalize(result);
  server.unregisterLiveSession(runId);
  const summary = await readJsonFile<RunSummary>(join(runDir, "summary.json"));

  console.log("");
  console.log(formatSummaryText(metadata, summary));
  console.log(chalk.dim(`Replay: ghostglass open ${runId}`));

  // Preserve the target command's exit semantics.
  const signal = metadata.signal;
  const exitCode = metadata.exitCode;
  const finalExit =
    signal !== null && signal !== undefined
      ? exitCodeForSignal(signal)
      : (exitCode ?? 1);

  if (options.noBrowser || !viewerUrl) {
    await server.stop().catch(() => undefined);
    process.exit(finalExit);
  }

  // Keep the viewer up so the finished run is immediately replayable in the
  // already-open browser tab — no reload needed.
  console.log(chalk.dim(`Viewer still running at ${viewerUrl} — press Ctrl+C to stop.`));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await server.stop().catch(() => undefined);
  console.log("GhostGlass Viewer stopped.");
  process.exit(finalExit);
}
