import chalk from "chalk";
import type { RunMetadata, RunListEntry } from "../storage/runStore.js";
import type { RunSummary } from "../summary/summarize.js";
import type { Highlight } from "../highlights/types.js";

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatExit(metadata: RunMetadata): string {
  if (metadata.exitCode !== null && metadata.exitCode !== undefined) {
    return String(metadata.exitCode);
  }
  if (metadata.signal) return `signal ${metadata.signal}`;
  return "unknown";
}

function section(title: string): string {
  return chalk.bold(title);
}

/**
 * Render the terminal summary shown after `ghostglass run` and by
 * `ghostglass show`. Every number comes from the actual trace — nothing
 * here is estimated or invented.
 */
export function formatSummaryText(
  metadata: RunMetadata,
  summary: RunSummary,
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan("GhostGlass"));
  lines.push(chalk.dim("────────────────────────────────"));
  lines.push(`${section("Command:")}    ${metadata.commandLine}`);
  lines.push(`${section("Run ID:")}     ${metadata.runId}`);
  lines.push(`${section("Duration:")}   ${formatDuration(metadata.durationMs)}`);
  lines.push(`${section("Exit Code:")}  ${formatExit(metadata)}`);
  if (metadata.interrupted) {
    lines.push(chalk.yellow("Interrupted:  yes (partial trace)"));
  }
  lines.push(`${section("Processes:")}  ${summary.processCount}`);
  const fs = summary.filesystem;
  lines.push(`${section("Filesystem:")} ${fs.total.toLocaleString()} events`);
  lines.push(chalk.dim(`  • ${fs.read.toLocaleString()} reads`));
  lines.push(chalk.dim(`  • ${fs.write.toLocaleString()} writes`));
  lines.push(chalk.dim(`  • ${fs.create.toLocaleString()} creates`));
  lines.push(chalk.dim(`  • ${fs.delete.toLocaleString()} deletes`));
  if (fs.rename > 0) lines.push(chalk.dim(`  • ${fs.rename} renames`));
  if (fs.mkdir > 0) lines.push(chalk.dim(`  • ${fs.mkdir} mkdirs`));
  const net = summary.network;
  lines.push(
    `${section("Network:")}    ${net.attempts} connection attempt${net.attempts === 1 ? "" : "s"}`,
  );
  const shown = net.destinations.slice(0, 10);
  for (const dest of shown) {
    lines.push(chalk.dim(`  • ${dest}`));
  }
  if (net.destinations.length > shown.length) {
    lines.push(chalk.dim(`  • +${net.destinations.length - shown.length} more`));
  }
  if (net.attempts === 0) {
    lines.push(chalk.dim("  • none observed"));
  }
  lines.push(`${section("Trace saved:")} .ghostglass/runs/${metadata.runId}/`);
  return lines.join("\n");
}

function truncate(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + "…" : s;
}

function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Render `ghostglass runs` as an aligned table. */
export function formatRunsTable(entries: RunListEntry[]): string {
  if (entries.length === 0) {
    return "No traces yet. Record one with:\n  ghostglass run -- <command>";
  }
  const idWidth = Math.max(
    "RUN ID".length,
    ...entries.map((e) => e.runId.length),
  );
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      `${padEnd("RUN ID", idWidth)}  ${padEnd("COMMAND", 36)}  ${padEnd("DURATION", 10)}  EXIT`,
    ),
  );
  for (const entry of entries) {
    const m = entry.metadata;
    lines.push(
      `${padEnd(entry.runId, idWidth)}  ${padEnd(truncate(m.commandLine, 36), 36)}  ` +
        `${padEnd(formatDuration(m.durationMs), 10)}  ${formatExit(m)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Compact one-line summary of a highlight for terminal display.
 * Never uses verdict language — describes observed behavior only.
 */
export function formatHighlightLine(h: Highlight): string {
  const m = h.metadata as Record<string, unknown>;
  let detail = "";
  switch (h.rule) {
    case "high-file-activity":
      detail = `${(m.eventCount as number)?.toLocaleString()} events / ${m.windowSecs}s`;
      break;
    case "high-process-activity":
      detail = `${m.spawnCount} child processes / ${m.windowSecs}s`;
      break;
    case "high-network-activity":
      detail = `${m.attemptCount} attempts / ${m.windowSecs}s`;
      break;
    case "high-delete-activity":
      detail = `${m.deleteCount} deleted / ${m.windowSecs}s`;
      break;
    case "outside-working-directory":
      detail = `${m.fileCount ?? 0} files under ${shortenHome(String(m.directory ?? ""))}`;
      break;
    case "create-then-execute":
      detail = `${shortenHome(String(m.path ?? ""))} (${m.delayMs} ms later)`;
      break;
    case "rapid-file-churn":
      detail = `${m.operationCount} ops / ${m.windowSecs}s on ${shortenHome(String(m.path ?? ""))}`;
      break;
  }
  const who = h.pid !== undefined ? `pid ${h.pid}` : "";
  return `• ${h.title}${who ? ` — ${who}` : ""}${detail ? `\n  ${detail}` : ""}`;
}

function shortenHome(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

/**
 * Terminal highlight summary shown after `ghostglass run` / `watch`.
 * Shows the most useful few; points at `ghostglass open` for the full list.
 * Returns "" when there are no highlights.
 */
export function formatHighlightsText(highlights: Highlight[], runId: string): string {
  if (highlights.length === 0) return "";
  const lines: string[] = [];
  lines.push(chalk.bold(`Highlights: ${highlights.length}`));
  lines.push(chalk.dim("Notable behavior observed — not a security verdict."));
  const shown = highlights.slice(0, 5);
  for (const h of shown) lines.push(formatHighlightLine(h));
  if (highlights.length > shown.length) {
    lines.push(chalk.dim(`…and ${highlights.length - shown.length} more.`));
  }
  lines.push(chalk.dim(`Full list: ghostglass open ${runId}`));
  return lines.join("\n");
}
