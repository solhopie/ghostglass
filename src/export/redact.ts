/**
 * Export-time redaction.
 *
 * Redaction transforms the in-memory export copy of a run (metadata,
 * summary, events) BEFORE the graph/timeline/diff are derived from it, so
 * every derived view (graph labels, stream, inspectors, diff entities)
 * is consistent automatically. The saved run on disk is never modified.
 *
 * Supported redactions:
 *  - home:    replace the user's home directory prefix with <HOME>
 *  - cwd:     replace the export-time working directory prefix with <CWD>
 *  - network: replace destination IPs with <NETWORK>, keeping ports
 *  - args:    keep the executable, replace argv with <ARGS REDACTED>
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { RunSummary } from "../summary/summarize.js";

export interface RedactOptions {
  homeDir?: string | undefined;
  cwd?: string | undefined;
  network?: boolean | undefined;
  args?: boolean | undefined;
}

export interface RedactableRunData {
  metadata: RunMetadata;
  summary: RunSummary;
  events: GhostGlassEvent[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace a path prefix only when it is a real path boundary
 * (followed by "/" or end of string), so /home/alex2 is untouched when
 * redacting /home/alex.
 */
function prefixReplacer(prefix: string, token: string): (s: string) => string {
  const re = new RegExp(`${escapeRegExp(prefix)}(?=/|$)`, "g");
  return (s: string) => s.replace(re, token);
}

function deepMapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepMapStrings(v, fn);
    return out;
  }
  return value;
}

function redactPathPrefixes(data: RedactableRunData, prefixes: { prefix: string; token: string }[]): void {
  // Longest prefix first so a cwd inside $HOME redacts to <CWD>, not <HOME>/...
  const sorted = [...prefixes].sort((a, b) => b.prefix.length - a.prefix.length);
  const fns = sorted.map((p) => prefixReplacer(p.prefix, p.token));
  const apply = (s: string): string => {
    let out = s;
    for (const fn of fns) out = fn(out);
    return out;
  };
  data.metadata = deepMapStrings(data.metadata, apply) as RunMetadata;
  data.summary = deepMapStrings(data.summary, apply) as RunSummary;
  data.events = deepMapStrings(data.events, apply) as GhostGlassEvent[];
}

function redactNetworkAddrs(data: RedactableRunData): void {
  for (const e of data.events) {
    if (e.type === "network") {
      if (typeof e.ip === "string" && e.ip.length > 0) e.ip = "<NETWORK>";
      if (typeof e.host === "string" && e.host.length > 0) e.host = "<NETWORK>";
    }
  }
}

const ARGS_REDACTED = "<ARGS REDACTED>";

function redactArgs(data: RedactableRunData): void {
  for (const e of data.events) {
    const md = e.metadata as Record<string, unknown> | undefined;
    if (!md) continue;
    const argv = md["argv"];
    if (Array.isArray(argv) && argv.length > 1) {
      md["argv"] = [argv[0], ARGS_REDACTED];
    } else if (Array.isArray(argv) && argv.length === 1) {
      md["argv"] = [argv[0]];
    }
  }
  for (const holder of [data.metadata, data.summary] as { command: string[]; commandLine: string }[]) {
    if (Array.isArray(holder.command) && holder.command.length > 0) {
      const exe = holder.command[0] as string;
      holder.command = holder.command.length > 1 ? [exe, ARGS_REDACTED] : [exe];
      holder.commandLine = holder.command.length > 1 ? `${exe} ${ARGS_REDACTED}` : exe;
    }
  }
}

/**
 * Apply the requested redactions to an in-memory run copy.
 * The input objects are mutated (they are freshly loaded from disk by the
 * caller); nothing is written back to the run store.
 */
export function redactRunData(data: RedactableRunData, opts: RedactOptions): RedactableRunData {
  const prefixes: { prefix: string; token: string }[] = [];
  if (opts.cwd) prefixes.push({ prefix: opts.cwd, token: "<CWD>" });
  if (opts.homeDir) prefixes.push({ prefix: opts.homeDir, token: "<HOME>" });
  if (prefixes.length > 0) redactPathPrefixes(data, prefixes);
  if (opts.network) redactNetworkAddrs(data);
  if (opts.args) redactArgs(data);
  return data;
}
