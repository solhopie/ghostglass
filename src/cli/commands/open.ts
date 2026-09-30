/**
 * `ghostglass open <run-id>` — launch the local visual replay viewer.
 *
 * Starts the viewer HTTP server bound to 127.0.0.1, prints the URL, opens
 * the user's browser (unless --no-browser), and blocks until Ctrl+C.
 */
import { spawn } from "node:child_process";
import { listRuns, runDirExists } from "../../storage/runStore.js";
import { RUN_ID_RE, VIEWER_HOST, ViewerServer } from "../../viewer/server.js";

export interface OpenOptions {
  cwd: string;
  port?: number | undefined;
  noBrowser?: boolean | undefined;
}

export async function resolveRunId(cwd: string, idOrLatest: string): Promise<string> {
  if (idOrLatest === "latest") {
    const runs = await listRuns(cwd);
    if (runs.length === 0) {
      throw new Error("No saved GhostGlass runs here. Record one first: ghostglass run -- <command>");
    }
    return (runs[0] as { runId: string }).runId;
  }
  if (!RUN_ID_RE.test(idOrLatest)) {
    throw new Error(`Invalid run ID "${idOrLatest}". Expected e.g. gg_20260930_001, or "latest".`);
  }
  if (!(await runDirExists(cwd, idOrLatest))) {
    throw new Error(`Run not found: ${idOrLatest}`);
  }
  return idOrLatest;
}

/** Best-effort cross-platform browser launch; never throws. */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {
      // No browser available (headless server, etc.) — the URL is printed anyway.
    });
  } catch {
    // ignore
  }
}

export async function openCommand(runIdOrLatest: string, opts: OpenOptions): Promise<void> {
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    throw new Error(`invalid port "${String(opts.port)}": must be an integer from 1 to 65535`);
  }
  const runId = await resolveRunId(opts.cwd, runIdOrLatest);
  const server = new ViewerServer({ cwd: opts.cwd, host: VIEWER_HOST, port: opts.port });
  const { url, port } = await server.start();
  const runUrl = `${url}/runs/${runId}`;
  console.log("GhostGlass Viewer started:");
  console.log(runUrl);
  if (port !== (opts.port ?? 7777)) {
    console.log(`(port ${opts.port ?? 7777} was busy; using ${port})`);
  }
  console.log("Press Ctrl+C to stop.");
  if (!opts.noBrowser) openBrowser(runUrl);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await server.stop();
  console.log("GhostGlass Viewer stopped.");
}
