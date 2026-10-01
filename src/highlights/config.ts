/**
 * Highlight configuration: defaults, .ghostglassrc.json loading, validation.
 *
 * Built-in defaults work without any config file. Invalid configuration
 * falls back to defaults with an understandable warning — it never crashes
 * tracing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  HighlightConfig,
  HighlightRule,
  ResolvedHighlightConfig,
  RuleThresholds,
} from "./types.js";

export const HIGHLIGHT_RULES: HighlightRule[] = [
  "high-file-activity",
  "high-process-activity",
  "high-network-activity",
  "high-delete-activity",
  "outside-working-directory",
  "create-then-execute",
  "rapid-file-churn",
];

/**
 * Default thresholds. Tuned to stay silent on ordinary activity:
 * - bursts require hundreds of events inside a few seconds
 * - churn requires dozens of ops on the same file
 * - outside-cwd and create-execute are evidence-based, not threshold-based
 */
const DEFAULTS: Record<HighlightRule, Required<RuleThresholds>> = {
  "high-file-activity": { enabled: true, events: 500, windowMs: 3000 },
  "high-process-activity": { enabled: true, events: 15, windowMs: 2000 },
  "high-network-activity": { enabled: true, events: 20, windowMs: 5000 },
  "high-delete-activity": { enabled: true, events: 50, windowMs: 3000 },
  "outside-working-directory": { enabled: true, events: 1, windowMs: 0 },
  "create-then-execute": { enabled: true, events: 1, windowMs: 0 },
  "rapid-file-churn": { enabled: true, events: 25, windowMs: 5000 },
};

export function defaultHighlightConfig(): ResolvedHighlightConfig {
  return { rules: structuredClone(DEFAULTS) };
}

export interface ConfigLoadResult {
  config: ResolvedHighlightConfig;
  /** Human-readable warnings (invalid values fell back to defaults). */
  warnings: string[];
  /** True when a config file was found and parsed. */
  fromFile: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeRuleThresholds(
  rule: HighlightRule,
  raw: unknown,
  warnings: string[],
): Required<RuleThresholds> {
  const def = DEFAULTS[rule];
  if (!isObject(raw)) {
    if (raw !== undefined) {
      warnings.push(`highlights.${rule}: expected an object, using defaults.`);
    }
    return { ...def };
  }
  const out: Required<RuleThresholds> = { ...def };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else warnings.push(`highlights.${rule}.enabled: expected boolean, using default (${def.enabled}).`);
  }
  for (const key of ["events", "windowMs"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = v;
    } else {
      warnings.push(
        `highlights.${rule}.${key}: expected a non-negative number, using default (${def[key]}).`,
      );
    }
  }
  return out;
}

/**
 * Load .ghostglassrc.json from `cwd`. Never throws: on any problem returns
 * defaults with a warning.
 */
export async function loadHighlightConfig(cwd: string): Promise<ConfigLoadResult> {
  const warnings: string[] = [];
  const rules = structuredClone(DEFAULTS);
  let fromFile = false;
  let parsed: unknown;
  try {
    const text = await readFile(join(cwd, ".ghostglassrc.json"), "utf8");
    parsed = JSON.parse(text);
    fromFile = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `.ghostglassrc.json could not be read (${(err as Error).message}); using default highlight thresholds.`,
      );
    }
    return { config: { rules }, warnings, fromFile: false };
  }
  if (!isObject(parsed)) {
    warnings.push(".ghostglassrc.json: expected a JSON object at the top level; using defaults.");
    return { config: { rules }, warnings, fromFile };
  }
  const raw = (parsed as HighlightConfig).highlights;
  if (raw === undefined) return { config: { rules }, warnings, fromFile };
  if (!isObject(raw)) {
    warnings.push('.ghostglassrc.json: "highlights" should be an object; using defaults.');
    return { config: { rules }, warnings, fromFile };
  }
  for (const rule of HIGHLIGHT_RULES) {
    rules[rule] = sanitizeRuleThresholds(rule, (raw as Record<string, unknown>)[rule], warnings);
  }
  for (const key of Object.keys(raw)) {
    if (!(HIGHLIGHT_RULES as string[]).includes(key)) {
      warnings.push(`.ghostglassrc.json: unknown highlight rule "${key}" — ignored.`);
    }
  }
  return { config: { rules }, warnings, fromFile };
}

/** Synchronous variant for contexts that already read the file. */
export function resolveHighlightConfig(parsed: unknown): ConfigLoadResult {
  const warnings: string[] = [];
  const rules = structuredClone(DEFAULTS);
  if (!isObject(parsed)) {
    return { config: { rules }, warnings, fromFile: false };
  }
  const raw = (parsed as HighlightConfig).highlights;
  if (!isObject(raw)) return { config: { rules }, warnings, fromFile: true };
  for (const rule of HIGHLIGHT_RULES) {
    rules[rule] = sanitizeRuleThresholds(rule, (raw as Record<string, unknown>)[rule], warnings);
  }
  return { config: { rules }, warnings, fromFile: true };
}
