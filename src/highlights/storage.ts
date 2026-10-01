/**
 * Highlight persistence: highlights.json lives next to events.jsonl.
 *
 * events.jsonl remains the source of truth. highlights.json is a cache:
 * - written on run finalization (run + watch)
 * - regenerated deterministically on demand when missing or stale
 * - old runs without highlights.json (e.g. v0.4.0) get highlights computed
 *   on first read — backward compatible
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GhostGlassEvent } from "../events/types.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { Highlight } from "./types.js";
import { detectHighlights, type DetectorContext } from "./engine.js";
import { defaultHighlightConfig } from "./config.js";
import type { ResolvedHighlightConfig } from "./types.js";

export const HIGHLIGHTS_FILE = "highlights.json";

export interface StoredHighlights {
  version: 1;
  runId: string;
  /** Epoch ms when highlights were computed. */
  computedAt: number;
  /** Resolved config used — regeneration uses this, not current defaults. */
  config: ResolvedHighlightConfig;
  highlights: Highlight[];
}

function detectorContext(
  runId: string,
  metadata: Pick<RunMetadata, "workingDirectory">,
  config: ResolvedHighlightConfig,
): DetectorContext {
  return {
    runId,
    workingDirectory: metadata.workingDirectory,
    config,
  };
}

/**
 * Compute highlights for a complete event list. Pure and deterministic:
 * same events + same config + same working directory => same highlights.
 */
export function computeHighlights(
  events: readonly GhostGlassEvent[],
  runId: string,
  metadata: Pick<RunMetadata, "workingDirectory">,
  config: ResolvedHighlightConfig = defaultHighlightConfig(),
): Highlight[] {
  return detectHighlights(events, detectorContext(runId, metadata, config));
}

/** Write highlights.json into a run directory. */
export async function writeHighlights(
  runDir: string,
  runId: string,
  highlights: Highlight[],
  config: ResolvedHighlightConfig = defaultHighlightConfig(),
): Promise<void> {
  const stored: StoredHighlights = {
    version: 1,
    runId,
    computedAt: Date.now(),
    config,
    highlights,
  };
  await writeFile(join(runDir, HIGHLIGHTS_FILE), JSON.stringify(stored, null, 2) + "\n", "utf8");
}

/**
 * Read highlights for a run, computing them on demand when the cache is
 * missing. `loadEvents` is only called when regeneration is needed.
 * Regeneration uses the stored config when available, falling back to
 * the provided default config.
 */
export async function readHighlights(
  runDir: string,
  runId: string,
  metadata: Pick<RunMetadata, "workingDirectory">,
  loadEvents: () => Promise<GhostGlassEvent[]>,
  defaultConfig: ResolvedHighlightConfig = defaultHighlightConfig(),
): Promise<Highlight[]> {
  let storedConfig: ResolvedHighlightConfig | undefined;
  try {
    const text = await readFile(join(runDir, HIGHLIGHTS_FILE), "utf8");
    const stored = JSON.parse(text) as StoredHighlights;
    if (stored.version === 1 && stored.runId === runId && Array.isArray(stored.highlights)) {
      return stored.highlights;
    }
    // Version mismatch or corrupt — try to salvage the config.
    if (stored.config && typeof stored.config === "object") {
      storedConfig = stored.config;
    }
  } catch {
    // Missing or corrupt cache — regenerate below.
  }
  const events = await loadEvents();
  const config = storedConfig ?? defaultConfig;
  const highlights = computeHighlights(events, runId, metadata, config);
  // Best-effort cache write; a failure here must not break reads.
  await writeHighlights(runDir, runId, highlights, config).catch(() => undefined);
  return highlights;
}

/** True when a run directory already has a highlights cache. */
export async function hasHighlightsCache(runDir: string): Promise<boolean> {
  try {
    await stat(join(runDir, HIGHLIGHTS_FILE));
    return true;
  } catch {
    return false;
  }
}
