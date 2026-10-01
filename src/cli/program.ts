import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { runsCommand, showCommand } from "./commands/show.js";
import { openCommand } from "./commands/open.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand, exportDiffCommand } from "./commands/export.js";
import { watchCommand } from "./commands/watch.js";
import { whyCommand } from "./commands/why.js";
import { highlightsCommand } from "./commands/highlights.js";
import { queryCommand } from "./commands/query.js";
import { readPackageVersion } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ghostglass")
    .description(
      "A local system activity recorder for terminal commands.\n" +
        "See what your commands are doing when you're not looking.",
    )
    .version(readPackageVersion(), "--version", "Print the GhostGlass version");

  program
    .command("run")
    .description("Trace a command and record its system activity")
    .argument("<command...>", "command to trace, e.g. npm install express")
    .action(async (command: string[]) => {
      await runCommand(command, { cwd: process.cwd() });
    });

  program
    .command("runs")
    .description("List recent traces")
    .option("--json", "Print the run list as JSON")
    .action(async (options: { json?: boolean }) => {
      await runsCommand({ cwd: process.cwd(), json: options.json === true });
    });

  program
    .command("show")
    .description("Show a saved trace summary")
    .argument("<run-id>", "run ID, e.g. gg_20260930_001")
    .action(async (runId: string) => {
      await showCommand(runId, { cwd: process.cwd() });
    });

  program
    .command("open")
    .description("Open a saved trace in the local visual replay viewer")
    .argument("<run-id>", 'run ID, e.g. gg_20260930_001, or "latest"')
    .option("--no-browser", "Print the viewer URL without opening a browser")
    .option("--port <number>", "Local port to listen on (default 7777)", (v: string) =>
      parseInt(v, 10),
    )
    .action(async (runId: string, options: { browser?: boolean; port?: number }) => {
      await openCommand(runId, {
        cwd: process.cwd(),
        noBrowser: options.browser === false,
        port: options.port,
      });
    });

  program
    .command("diff")
    .description("Compare two saved traces in the local visual diff viewer")
    .argument("<run-a>", 'run ID, e.g. gg_20260930_001, or "latest"')
    .argument("<run-b>", 'run ID, e.g. gg_20260930_002, or "previous"')
    .option("--no-browser", "Print the viewer URL without opening a browser")
    .option("--port <number>", "Local port to listen on (default 7777)", (v: string) =>
      parseInt(v, 10),
    )
    .action(async (runA: string, runB: string, options: { browser?: boolean; port?: number }) => {
      await diffCommand(runA, runB, {
        cwd: process.cwd(),
        noBrowser: options.browser === false,
        port: options.port,
      });
    });

  program
    .command("watch")
    .description("Trace a command with live visualization in the local viewer")
    .argument("<command...>", "command to trace, e.g. npm install express")
    .option("--no-browser", "Stream without opening a browser (prints live summary)")
    .option("--port <number>", "Local port to listen on (default 7777)", (v: string) =>
      parseInt(v, 10),
    )
    .action(async (command: string[], options: { browser?: boolean; port?: number }) => {
      await watchCommand(command, {
        cwd: process.cwd(),
        noBrowser: options.browser === false,
        port: options.port,
      });
    });

  function addExportOptions(cmd: Command): void {
    cmd
      .option("-o, --output <path>", "Output file path")
      .option("--force", "Overwrite the output file if it exists")
      .option("--format <format>", "Output format: html or json (default html)", "html")
      .option("--redact-home", "Replace the home directory prefix with <HOME>")
      .option("--redact-cwd", "Replace the working directory prefix with <CWD>")
      .option("--redact-network", "Replace destination IPs with <NETWORK>, keeping ports")
      .option("--redact-args", "Keep the executable, redact command arguments");
  }

  const exportCmd = program
    .command("export")
    .description("Generate a self-contained portable HTML report from a saved trace")
    .argument("<run-id>", 'run ID, e.g. gg_20260930_001, or "latest"');
  addExportOptions(exportCmd);
  exportCmd.action(
    async (
      runId: string,
      options: {
        output?: string;
        force?: boolean;
        format?: string;
        redactHome?: boolean;
        redactCwd?: boolean;
        redactNetwork?: boolean;
        redactArgs?: boolean;
      },
    ) => {
      await exportCommand(runId, {
        cwd: process.cwd(),
        output: options.output,
        force: options.force,
        format: options.format,
        redactHome: options.redactHome,
        redactCwd: options.redactCwd,
        redactNetwork: options.redactNetwork,
        redactArgs: options.redactArgs,
      });
    },
  );

  const exportDiffCmd = program
    .command("export-diff")
    .description("Generate a self-contained portable HTML report comparing two saved traces")
    .argument("<run-a>", 'run ID, e.g. gg_20260930_001, or "latest"')
    .argument("<run-b>", 'run ID, e.g. gg_20260930_002, or "previous"');
  addExportOptions(exportDiffCmd);
  exportDiffCmd.action(
    async (
      runA: string,
      runB: string,
      options: {
        output?: string;
        force?: boolean;
        format?: string;
        redactHome?: boolean;
        redactCwd?: boolean;
        redactNetwork?: boolean;
        redactArgs?: boolean;
      },
    ) => {
      await exportDiffCommand(runA, runB, {
        cwd: process.cwd(),
        output: options.output,
        force: options.force,
        format: options.format,
        redactHome: options.redactHome,
        redactCwd: options.redactCwd,
        redactNetwork: options.redactNetwork,
        redactArgs: options.redactArgs,
      });
    },
  );

  program
    .command("highlights")
    .description("Show behavior highlights for a saved trace (observed behavior, not verdicts)")
    .argument("[run-id]", 'run ID, e.g. gg_20260930_001, or "latest" (default)')
    .option("--json", "Output highlights as JSON for automation")
    .action(async (runId: string | undefined, options: { json?: boolean }) => {
      await highlightsCommand(runId, { cwd: process.cwd(), json: options.json });
    });

  program
    .command("why")
    .description("Show the recorded execution path that led to a file, process, network destination, event, or highlight")
    .argument("[run-id]", 'run ID, e.g. gg_20260930_001, or "latest" (default)')
    .option("--event <id>", "Target a specific event by ID")
    .option("--pid <n>", "Target a process by PID")
    .option("--file <path>", "Target a file (exact path or unique suffix)")
    .option("--network <host:port>", "Target a network destination")
    .option("--highlight <id>", "Target a behavior highlight by ID")
    .option("--json", "Output the cause chain as JSON for automation")
    .action(
      async (
        runId: string | undefined,
        options: {
          json?: boolean;
          event?: string;
          pid?: string;
          file?: string;
          network?: string;
          highlight?: string;
        },
      ) => {
        await whyCommand(runId, {
          cwd: process.cwd(),
          json: options.json,
          event: options.event,
          pid: options.pid,
          file: options.file,
          network: options.network,
          highlight: options.highlight,
        });
      },
    );

  program
    .command("query")
    .description("Deterministically search a saved trace (no AI, structured filters only)")
    .argument("[run-id]", 'run ID, e.g. gg_20260930_001, or "latest" (default)')
    .option("--process <name>", "Match executable basename, path, or path suffix")
    .option("--pid <n>", "Match an exact process ID")
    .option("--action <action>", "Match an action (repeatable: OR semantics)", collect, [] as string[])
    .option("--type <type>", "Match an event type: process, file, network (repeatable: OR)", collect, [] as string[])
    .option("--file <path>", "Match a file by basename or path suffix")
    .option("--path <pattern>", "Match event paths with a * / ? glob")
    .option("--network", "Only network events")
    .option("--ip <ip>", "Match a destination IP exactly")
    .option("--port <port>", "Match a destination port exactly")
    .option("--since <time>", "Events at or after this time: trace-relative (e.g. +1.5s, 500ms) or absolute (2026-10-01T10:00:02Z)")
    .option("--until <time>", "Events at or before this time: trace-relative or absolute")
    .option("--text <text>", "Case-insensitive substring over displayable event fields")
    .option("--reconstructed", "Only events from reconstructed split syscalls")
    .option("--not-reconstructed", "Exclude reconstructed events")
    .option("--limit <n>", "Max events to show (default 100, 0 = unlimited)")
    .option("--order <order>", 'Result order: "time" (default) or "sequence"')
    .option("--json", "Output the result as JSON for automation")
    .action(
      async (
        runId: string | undefined,
        options: {
          process?: string;
          pid?: string;
          action?: string[];
          type?: string[];
          file?: string;
          path?: string;
          network?: boolean;
          ip?: string;
          port?: string;
          since?: string;
          until?: string;
          text?: string;
          reconstructed?: boolean;
          notReconstructed?: boolean;
          limit?: string;
          order?: string;
          json?: boolean;
        },
      ) => {
        await queryCommand(runId, { cwd: process.cwd(), ...options });
      },
    );

  function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
  }

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
