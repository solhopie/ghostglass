import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { GhostGlassEvent } from "../events/types.js";

export const GHOSTGLASS_DIR = ".ghostglass";
export const RUNS_DIR = "runs";

/** Contents of <run-dir>/metadata.json */
export interface RunMetadata {
  ghostglassVersion: string;
  runId: string;
  /** Command as argv array. */
  command: string[];
  /** Shell-style rendering of the command (for display only). */
  commandLine: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  durationMs: number;
  os: { platform: string; arch: string; release: string };
  exitCode: number | null;
  signal: string | null;
  /** True when GhostGlass was interrupted (Ctrl+C) before natural completion. */
  interrupted: boolean;
  /** Tracing backend used, e.g. "strace". */
  backend: string;
  eventCount: number;
  /** Parser counters: lines seen / events produced / skipped / malformed. */
  parseStats: { totalLines: number; events: number; skipped: number; malformed: number };
}

export interface RunListEntry {
  runId: string;
  runDir: string;
  metadata: RunMetadata;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Quote an argv element for display if it contains whitespace. */
export function shellQuote(arg: string): string {
  return /[\s"'\\]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

export function commandLineString(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function runsRoot(cwd: string): string {
  return join(cwd, GHOSTGLASS_DIR, RUNS_DIR);
}

/**
 * Allocate the next run ID for today: gg_YYYYMMDD_NNN.
 * Scans existing run directories so IDs stay unique per day.
 */
export async function allocateRun(cwd: string, now = new Date()): Promise<{
  runId: string;
  runDir: string;
}> {
  const stamp = dateStamp(now);
  const root = runsRoot(cwd);
  await mkdir(root, { recursive: true });
  let maxSeq = 0;
  try {
    for (const entry of await readdir(root)) {
      const m = entry.match(new RegExp(`^gg_${stamp}_(\\d{3,})$`));
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1] as string, 10));
    }
  } catch {
    // Fresh runs directory.
  }
  const runId = `gg_${stamp}_${pad(maxSeq + 1, 3)}`;
  const runDir = join(root, runId);
  await mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

/** Stream events to JSONL so large traces never sit fully in memory here. */
export async function writeEventsJsonl(
  path: string,
  events: GhostGlassEvent[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path, { encoding: "utf8" });
    stream.on("error", reject);
    stream.on("finish", resolve);
    for (const event of events) {
      stream.write(JSON.stringify(event) + "\n");
    }
    stream.end();
  });
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function runDirExists(cwd: string, runId: string): Promise<boolean> {
  try {
    const s = await stat(join(runsRoot(cwd), runId));
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** All runs with readable metadata, newest first. */
export async function listRuns(cwd: string): Promise<RunListEntry[]> {
  const root = runsRoot(cwd);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const runs: RunListEntry[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("gg_")) continue;
    const runDir = join(root, entry);
    try {
      const metadata = await readJsonFile<RunMetadata>(join(runDir, "metadata.json"));
      runs.push({ runId: metadata.runId, runDir, metadata });
    } catch {
      // Incomplete run directory (e.g. interrupted before metadata was
      // written); skip rather than crash the listing.
    }
  }
  runs.sort((a, b) => b.metadata.startTime.localeCompare(a.metadata.startTime));
  return runs;
}
