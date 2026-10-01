/**
 * Human-readable formatting for query results. Pure functions; the CLI
 * and viewer share these so output stays consistent.
 */
import type { GhostGlassEvent } from "../events/types.js";
import { basename } from "./matcher.js";
import type { QueryResult, TraceQuery } from "./types.js";

/** Canonical one-line description of a query, e.g. "process=node action=write path=*package*". */
export function describeQuery(q: TraceQuery): string {
  const parts: string[] = [];
  if (q.process !== undefined) parts.push(`process=${q.process}`);
  if (q.pid !== undefined) parts.push(`pid=${q.pid}`);
  if (q.actions) for (const a of q.actions) parts.push(`action=${a}`);
  if (q.types) for (const t of q.types) parts.push(`type=${t}`);
  if (q.file !== undefined) parts.push(`file=${q.file}`);
  if (q.path !== undefined) parts.push(`path=${q.path}`);
  if (q.network === true) parts.push(`network`);
  if (q.network === false) parts.push(`network=false`);
  if (q.host !== undefined) parts.push(`host=${q.host}`);
  if (q.ip !== undefined) parts.push(`ip=${q.ip}`);
  if (q.port !== undefined) parts.push(`port=${q.port}`);
  if (q.text !== undefined) parts.push(`text=${q.text}`);
  if (q.reconstructed === true) parts.push(`reconstructed`);
  if (q.reconstructed === false) parts.push(`not-reconstructed`);
  if (q.since !== undefined) parts.push(`since=${q.since}ms`);
  if (q.until !== undefined) parts.push(`until=${q.until}ms`);
  if (q.highlight !== undefined) parts.push(`highlight=${q.highlight}`);
  if (q.order !== undefined) parts.push(`order=${q.order}`);
  if (q.limit !== undefined) parts.push(`limit=${q.limit}`);
  return parts.join(" ") || "(all events)";
}

/** Relative offset like "+0.422s". */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

/** Primary human target for a row: path, network destination, or executable. */
export function eventTarget(e: GhostGlassEvent): string {
  if (e.path) return e.path;
  if (e.type === "network") {
    const host = e.host ?? e.ip ?? "?";
    return e.port !== undefined ? `${host}:${e.port}` : host;
  }
  if (e.executable) return e.executable;
  return "";
}

export type ExeResolver = (pid: number, atSequence?: number) => string | undefined;

export function processLabel(e: GhostGlassEvent, resolveExe?: ExeResolver): string {
  const exe = e.executable ?? resolveExe?.(e.pid, e.sequence);
  return exe ? basename(exe) : `pid:${e.pid}`;
}

/** One result row: "+0.422s  WRITE   node  package.json". */
export function formatEventRow(
  e: GhostGlassEvent,
  runStartMs: number,
  resolveExe?: ExeResolver,
): string {
  const off = formatOffset(e.timestamp - runStartMs);
  const action = e.action.toUpperCase().padEnd(7);
  const proc = processLabel(e, resolveExe).slice(0, 18).padEnd(18);
  const target = eventTarget(e);
  const recon = e.metadata?.["reconstructed"] === true ? " ⟲" : "";
  return `${off}  ${action}  ${proc}  ${target}${recon}`;
}

export function formatQueryText(
  result: QueryResult,
  runStartMs: number,
  resolveExe?: ExeResolver,
): string {
  const lines: string[] = [];
  lines.push("GhostGlass Query");
  lines.push("────────────────────────────────");
  lines.push(`Run:    ${result.runId}`);
  lines.push(`Query:  ${describeQuery(result.query)}`);
  const matchLine =
    result.truncated
      ? `Matches: ${result.totalMatches} (showing first ${result.returned})`
      : `Matches: ${result.totalMatches}`;
  lines.push(matchLine);
  lines.push("");
  for (const e of result.events) {
    lines.push(formatEventRow(e, runStartMs, resolveExe));
  }
  if (result.events.length === 0) {
    lines.push("(no matching events)");
  }
  return lines.join("\n");
}

/** Query presets: named shortcuts that translate into normal query strings. */
export const QUERY_PRESETS: { name: string; query: string }[] = [
  { name: "File writes", query: "action:write" },
  { name: "File deletes", query: "action:delete" },
  { name: "Network connections", query: "type:network" },
  { name: "Process spawns", query: "action:spawn" },
  { name: "Reconstructed syscalls", query: "reconstructed" },
];
