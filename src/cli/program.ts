import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { runsCommand, showCommand } from "./commands/show.js";
import { openCommand } from "./commands/open.js";
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
    .action(async () => {
      await runsCommand({ cwd: process.cwd() });
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
    .action(async (runId: string, options: { noBrowser?: boolean; port?: number }) => {
      await openCommand(runId, {
        cwd: process.cwd(),
        noBrowser: options.noBrowser,
        port: options.port,
      });
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
