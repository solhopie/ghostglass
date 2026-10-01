import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { runsCommand, showCommand } from "./commands/show.js";
import { openCommand } from "./commands/open.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand, exportDiffCommand } from "./commands/export.js";
import { watchCommand } from "./commands/watch.js";
import { highlightsCommand } from "./commands/highlights.js";
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

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
