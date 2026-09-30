/**
 * Load a saved run's data (metadata + summary + events) for diffing.
 *
 * Runs remain the source of truth: the diff is always computed from the
 * run store on demand. Diffs are never persisted — only derived in memory.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { GHOSTGLASS_DIR, RUNS_DIR, readJsonFile } from "../storage/runStore.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { GhostGlassEvent } from "../events/types.js";
import type { RunSummary } from "../summary/summarize.js";
import type { RunData } from "./compareRuns.js";

export async function loadRunData(cwd: string, runId: string): Promise<RunData> {
  const dir = join(cwd, GHOSTGLASS_DIR, RUNS_DIR, runId);
  const [metadata, summary] = await Promise.all([
    readJsonFile<RunMetadata>(join(dir, "metadata.json")),
    readJsonFile<RunSummary>(join(dir, "summary.json")),
  ]);
  const events: GhostGlassEvent[] = [];
  const rl = createInterface({
    input: createReadStream(join(dir, "events.jsonl")),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as GhostGlassEvent);
    } catch {
      // skip malformed lines, mirroring the tracer's leniency
    }
  }
  return { metadata, summary, events };
}

/** True when the on-disk file exists (used for a friendlier 404 path). */
export async function runDataExists(cwd: string, runId: string): Promise<boolean> {
  try {
    await readFile(join(cwd, GHOSTGLASS_DIR, RUNS_DIR, runId, "metadata.json"));
    return true;
  } catch {
    return false;
  }
}
