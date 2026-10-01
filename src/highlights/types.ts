/**
 * Highlight types — the shared vocabulary for behavior highlights.
 *
 * Highlights describe OBSERVED BEHAVIOR. They are not malware or security
 * verdicts. Severity describes the amount or unusualness of observed
 * behavior, never risk. The following words must never appear as automatic
 * verdicts: safe, unsafe, malicious, virus, threat, clean, dangerous,
 * attack, exploit.
 */
import type { GhostGlassEvent } from "../events/types.js";

/** Stable rule identifiers. */
export type HighlightRule =
  | "high-file-activity"
  | "high-process-activity"
  | "high-network-activity"
  | "high-delete-activity"
  | "outside-working-directory"
  | "create-then-execute"
  | "rapid-file-churn";

/** Behavioral magnitude of the observed activity — NOT a risk rating. */
export type HighlightSeverity = "info" | "notice" | "high";

/** Frontend filter groups. */
export type HighlightCategory = "file" | "process" | "network" | "path";

export const HIGHLIGHT_RULE_CATEGORY: Record<HighlightRule, HighlightCategory> = {
  "high-file-activity": "file",
  "high-process-activity": "process",
  "high-network-activity": "network",
  "high-delete-activity": "file",
  "outside-working-directory": "path",
  "create-then-execute": "path",
  "rapid-file-churn": "file",
};

export interface Highlight {
  /** Stable deterministic id, e.g. "file-burst-node-18420-1790747951461". */
  id: string;
  runId: string;
  rule: HighlightRule;
  severity: HighlightSeverity;
  /** Short human title, e.g. "File activity burst". */
  title: string;
  /** Explains exactly why this highlight exists (thresholds, counts, window). */
  explanation: string;
  startTimestamp: number;
  endTimestamp?: number;
  pid?: number;
  /** Event ids this highlight is derived from. */
  relatedEventIds: string[];
  /** Rule-specific structured detail for inspectors and exports. */
  metadata: Record<string, unknown>;
}

/** What the engine hands a rule: the event plus run-level context. */
export interface RuleContext {
  runId: string;
  /** Original working directory of the traced command, when known. */
  workingDirectory: string | undefined;
  /** Resolved highlight configuration. */
  config: ResolvedHighlightConfig;
}

/**
 * A detection rule. Rules are stateful: they support both batch processing
 * (saved runs) and incremental ingestion (live). The engine calls
 * `processEvent` for each event in order; rules emit highlights via the
 * callback exactly once per distinct occurrence (duplicate prevention is
 * the rule's responsibility, keyed by stable highlight id).
 */
export interface HighlightRuleImpl {
  readonly rule: HighlightRule;
  /** Reset internal state (called before each batch run / live session). */
  reset(ctx: RuleContext): void;
  /** Ingest one event in timestamp order; may emit 0..n highlights. */
  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void;
  /** Called after the last event (batch) or session end (live). */
  finish(emit: (h: Highlight) => void): void;
}

/** Per-rule tunable thresholds. All optional — defaults always apply. */
export interface RuleThresholds {
  enabled?: boolean;
  /** Minimum events in the window to trigger. */
  events?: number;
  /** Sliding window size in milliseconds. */
  windowMs?: number;
}

export interface HighlightConfig {
  highlights?: {
    [K in HighlightRule]?: RuleThresholds;
  };
}

export interface ResolvedHighlightConfig {
  rules: Record<HighlightRule, Required<RuleThresholds>>;
}

/** Words that must never appear as automatic highlight verdicts. */
export const FORBIDDEN_VERDICT_WORDS = [
  "safe",
  "unsafe",
  "malicious",
  "virus",
  "threat",
  "clean",
  "dangerous",
  "attack",
  "exploit",
] as const;

export function assertNoVerdictWords(text: string): void {
  for (const word of FORBIDDEN_VERDICT_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(text)) {
      throw new Error(`Highlight text must not contain verdict word "${word}": ${text}`);
    }
  }
}
