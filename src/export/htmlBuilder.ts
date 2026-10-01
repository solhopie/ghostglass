/**
 * Self-contained HTML report builder.
 *
 * Assembles a single HTML file that opens directly in a browser via
 * file:// with no server, no network, and no GhostGlass installation:
 *
 *  - viewer stylesheet inlined in <style>
 *  - the real viewer bundle inlined in <script> (same components as the
 *    live viewer — graph, timeline replay, event stream, inspectors)
 *  - the report data embedded as JSON in a clearly-delimited script tag;
 *    the frontend reads it through the same api.ts shapes the live
 *    viewer uses, served from memory instead of HTTP
 *  - a tiny route shim that boots the run or diff view directly
 *    (history.replaceState is unreliable on file:// URLs)
 *
 * Security:
 *  - trace data is untrusted; the embedded JSON is escaped so a payload
 *    like </script><script>alert(1)</script> stays inert text
 *  - the inline viewer bundle is scrubbed for </script and <!-- sequences
 *  - a restrictive Content-Security-Policy is embedded via <meta>:
 *    everything is inline (script-src/style-src 'unsafe-inline' are
 *    required for that), and connect-src 'none' guarantees the report
 *    can make zero network requests. Tradeoff: 'unsafe-inline' means the
 *    page's own scripts run unrestricted — acceptable here because the
 *    whole file is generated locally from the user's own trace and the
 *    viewer bundle they already built; the CSP's value is preventing any
 *    exfiltration or external loading, not sandboxing first-party code.
 */
import { readPackageVersion } from "../cli/version.js";
import type { ExportAssets } from "./assetBundler.js";
import type { DiffExportModel } from "./exportDiff.js";
import type { RunExportModel } from "./exportRun.js";
import { escapeForScriptJson, escapeHtml } from "./sanitize.js";

export const EXPORT_FORMAT_VERSION = 1;

export type ExportRoute =
  | { kind: "run"; runId: string }
  | { kind: "diff"; runA: string; runB: string };

export interface HtmlExportEnvelope {
  format: "ghostglass-html";
  formatVersion: number;
  ghostglassVersion: string;
  exportedAt: string;
  type: "run" | "diff";
  route: ExportRoute;
  data: unknown;
}

/** Scrub an inline <script> body so it can never break out of its element. */
export function scrubInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/** Scrub an inline <style> body so it can never break out of its element. */
export function scrubInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data:; " +
  "font-src 'none'; " +
  "connect-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

/** Print stylesheet: hide interactive controls, linearize the layout. */
export const PRINT_CSS = `
@media print {
  .gg-export-notice { border: 1px solid #999; background: #fff; color: #000; }
  .graph-toolbar, .timeline-controls, .stream-filters, .diff-stream-filters,
  .graph-legend, .tl-btn, .filter-btn { display: none !important; }
  .gg-main { display: block !important; height: auto !important; }
  .gg-graph { height: 320px !important; break-inside: avoid; }
  .gg-side { display: block !important; }
  .gg-stream, .gg-inspector { max-height: none !important; overflow: visible !important; }
  .gg-timeline { position: static !important; }
  .diff-page-bottom { display: block !important; }
  body { background: #fff !important; color: #000 !important; }
}
`;

function privacyNotice(exportedAt: string, version: string): string {
  return (
    `<div class="gg-export-notice" role="note">` +
    `<strong>GhostGlass static report.</strong> ` +
    `This file may contain local paths, command arguments, executable names, ` +
    `and network destinations from the traced machine — share it carefully. ` +
    `<span class="gg-export-notice-meta">Exported ${escapeHtml(exportedAt)} · ` +
    `GhostGlass ${escapeHtml(version)} · works offline, makes no network requests.</span>` +
    `</div>`
  );
}

const NOTICE_CSS = `
.gg-export-notice {
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 8px 14px;
  background: #2a2410;
  color: #f5d97e;
  border-bottom: 1px solid #6b5d2a;
}
.gg-export-notice-meta { opacity: 0.75; }
`;

export interface ShellOptions {
  title: string;
  type: "run" | "diff";
  route: ExportRoute;
  data: unknown;
  assets: ExportAssets;
  exportedAt?: string | undefined;
}

export function buildExportShell(opts: ShellOptions): string {
  const version = readPackageVersion();
  const exportedAt = opts.exportedAt ?? new Date().toISOString();
  const envelope: HtmlExportEnvelope = {
    format: "ghostglass-html",
    formatVersion: EXPORT_FORMAT_VERSION,
    ghostglassVersion: version,
    exportedAt,
    type: opts.type,
    route: opts.route,
    data: opts.data,
  };
  const dataJson = escapeForScriptJson(envelope);
  const routeJson = escapeForScriptJson(opts.route);
  const js = scrubInlineScript(opts.assets.js);
  const css = scrubInlineStyle(opts.assets.css);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    `<meta name="description" content="GhostGlass static trace report — opens offline, no server required.">\n` +
    `<link rel="icon" href="data:,">\n` +
    `<title>${escapeHtml(opts.title)}</title>\n` +
    `<style>\n${css}\n</style>\n` +
    `<style>\n${NOTICE_CSS}\n${PRINT_CSS}\n</style>\n` +
    `</head>\n<body>\n` +
    `${privacyNotice(exportedAt, version)}\n` +
    `<div id="app"><div class="boot"><div class="boot-mark"></div>` +
    `<div class="boot-msg">Loading report…</div></div></div>\n` +
    `<script type="application/json" id="gg-export-data">\n${dataJson}\n</script>\n` +
    `<script>\nwindow.__GG_STATIC_ROUTE__ = ${routeJson};\n</script>\n` +
    `<script>\n${js}\n</script>\n` +
    `</body>\n</html>\n`
  );
}

export function buildRunExportHtml(
  model: RunExportModel,
  assets: ExportAssets,
  exportedAt?: string,
): string {
  const data = {
    detail: { metadata: model.metadata, summary: model.summary },
    graph: model.graph,
    timeline: model.timeline,
    events: model.events,
    highlights: model.highlights,
  };
  return buildExportShell({
    title: `GhostGlass — ${model.metadata.runId} — ${model.metadata.commandLine}`,
    type: "run",
    route: { kind: "run", runId: model.metadata.runId },
    data,
    assets,
    exportedAt,
  });
}

export function buildDiffExportHtml(
  model: DiffExportModel,
  assets: ExportAssets,
  exportedAt?: string,
): string {
  const data = {
    diff: model.diff,
    timelineA: model.timelineA,
    timelineB: model.timelineB,
  };
  return buildExportShell({
    title: `GhostGlass diff — ${model.diff.runA.runId} vs ${model.diff.runB.runId}`,
    type: "diff",
    route: { kind: "diff", runA: model.diff.runA.runId, runB: model.diff.runB.runId },
    data,
    assets,
    exportedAt,
  });
}
