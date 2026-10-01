/**
 * The highlight engine: runs detection rules over GhostGlass events.
 *
 * Two modes:
 * - Batch: `detectHighlights(events, ctx)` — for saved runs, exports, CLI.
 * - Incremental: `createLiveDetector(ctx, onHighlight)` — for Live Glass;
 *   feed events in timestamp order, highlights are emitted as soon as a
 *   rule's threshold is crossed. Never rescans the whole trace per event.
 *
 * Both modes share the same rule implementations, so saved replay and
 * Live Glass always agree.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type {
  Highlight,
  HighlightRule,
  HighlightRuleImpl,
  ResolvedHighlightConfig,
  RuleContext,
} from "./types.js";
import { HIGHLIGHT_RULE_CATEGORY } from "./types.js";
import { FileBurstRule } from "./rules/fileBurst.js";
import { ProcessBurstRule } from "./rules/processBurst.js";
import { NetworkBurstRule } from "./rules/networkBurst.js";
import { DeleteBurstRule } from "./rules/deleteBurst.js";
import { OutsideCwdRule } from "./rules/outsideCwd.js";
import { CreateExecuteRule } from "./rules/createExecute.js";
import { RapidFileChurnRule } from "./rules/rapidFileChurn.js";

export function createRules(): HighlightRuleImpl[] {
  return [
    new FileBurstRule(),
    new ProcessBurstRule(),
    new NetworkBurstRule(),
    new DeleteBurstRule(),
    new OutsideCwdRule(),
    new CreateExecuteRule(),
    new RapidFileChurnRule(),
  ];
}

export interface DetectorContext {
  runId: string;
  workingDirectory: string | undefined;
  config: ResolvedHighlightConfig;
}

function toRuleContext(ctx: DetectorContext): RuleContext {
  return { runId: ctx.runId, workingDirectory: ctx.workingDirectory, config: ctx.config };
}

/**
 * Batch detection over a complete event list. Events are processed in
 * timestamp order (stable for equal timestamps). Returns highlights ordered
 * by startTimestamp, then rule name, then id — deterministic.
 */
export function detectHighlights(
  events: readonly GhostGlassEvent[],
  ctx: DetectorContext,
): Highlight[] {
  const collected: Highlight[] = [];
  const detector = createLiveDetector(ctx, (h) => collected.push(h));
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  for (const event of ordered) detector.ingest(event);
  return detector.finish();
}

export interface LiveDetector {
  ingest(event: GhostGlassEvent): void;
  finish(): Highlight[];
}

function sortHighlights(list: Highlight[]): Highlight[] {
  return [...list].sort(
    (a, b) =>
      a.startTimestamp - b.startTimestamp ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * Incremental detector for Live Glass. Rules keep rolling state; each
 * ingested event is O(1) amortized per rule. Highlights are emitted via
 * onHighlight as soon as they are detected — never wait for completion.
 * Duplicate prevention: the detector drops any highlight whose stable id
 * was already emitted.
 */
export function createLiveDetector(
  ctx: DetectorContext,
  onHighlight: (h: Highlight) => void,
): LiveDetector {
  const ruleCtx = toRuleContext(ctx);
  const enabled = createRules().filter((r) => ctx.config.rules[r.rule].enabled);
  for (const r of enabled) r.reset(ruleCtx);
  const seen = new Set<string>();
  const all: Highlight[] = [];

  const emit = (h: Highlight): void => {
    if (seen.has(h.id)) return;
    seen.add(h.id);
    // Tag category for frontend filtering (derived, not stored per rule).
    const categorized: Highlight = {
      ...h,
      metadata: { ...h.metadata, category: HIGHLIGHT_RULE_CATEGORY[h.rule as HighlightRule] },
    };
    all.push(categorized);
    onHighlight(categorized);
  };

  return {
    ingest(event: GhostGlassEvent): void {
      for (const r of enabled) r.processEvent(event, emit);
    },
    finish(): Highlight[] {
      for (const r of enabled) r.finish(emit);
      return sortHighlights(all);
    },
  };
}
