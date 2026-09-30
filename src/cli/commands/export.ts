/**
 * `ghostglass export <run-id>` and `ghostglass export-diff <run-a> <run-b>`.
 *
 * Generate a single self-contained HTML report (or a portable structured
 * JSON file) from saved runs. Everything is generated locally — GhostGlass
 * never uploads reports anywhere. The resulting file belongs to the user.
 *
 * Non-interactive and CI-friendly: no browser is opened, no confirmation
 * prompts; failures exit nonzero via the top-level error handler.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { resolveRunId } from "./open.js";
import { resolveDiffRunIds } from "./diff.js";
import { loadExportAssets } from "../../export/assetBundler.js";
import { buildDiffExportHtml, buildRunExportHtml } from "../../export/htmlBuilder.js";
import { buildDiffExportModel } from "../../export/exportDiff.js";
import { buildRunExportModel } from "../../export/exportRun.js";
import { buildDiffJsonExport, buildRunJsonExport } from "../../export/jsonExport.js";
import type { RedactOptions } from "../../export/redact.js";
import { safeFileName } from "../../export/sanitize.js";

export type ExportFormat = "html" | "json";

export interface ExportOptions {
  cwd: string;
  output?: string | undefined;
  force?: boolean | undefined;
  format?: string | undefined;
  redactHome?: boolean | undefined;
  redactCwd?: boolean | undefined;
  redactNetwork?: boolean | undefined;
  redactArgs?: boolean | undefined;
}

export const PRIVACY_NOTE =
  "Note: GhostGlass reports may contain local paths, command arguments, and network destinations.";

export function resolveExportFormat(format: string | undefined): ExportFormat {
  const f = format ?? "html";
  if (f !== "html" && f !== "json") {
    throw new Error(
      `Invalid format "${f}". Supported formats: html, json.`,
    );
  }
  return f;
}

export function defaultRunFileName(runId: string, format: ExportFormat): string {
  return safeFileName(`ghostglass-${runId}.${format}`);
}

export function defaultDiffFileName(runA: string, runB: string, format: ExportFormat): string {
  return safeFileName(`ghostglass-diff-${runA}-vs-${runB}.${format}`);
}

function redactOptions(cwd: string, opts: ExportOptions): RedactOptions {
  return {
    homeDir: opts.redactHome ? homedir() : undefined,
    cwd: opts.redactCwd ? cwd : undefined,
    network: opts.redactNetwork ? true : undefined,
    args: opts.redactArgs ? true : undefined,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Resolve the output path, refusing to silently overwrite an existing
 * file unless --force was given. Creates missing parent directories so
 * `--output artifacts/trace.html` works in CI.
 */
export async function resolveOutputPath(
  cwd: string,
  requested: string | undefined,
  defaultName: string,
  force: boolean | undefined,
): Promise<string> {
  const outPath = requested ? resolve(cwd, requested) : join(cwd, defaultName);
  if (existsSync(outPath) && !force) {
    throw new Error(
      `Refusing to overwrite existing file: ${outPath}\nUse --force to overwrite it.`,
    );
  }
  await mkdir(dirname(outPath), { recursive: true });
  return outPath;
}

async function writeExportFile(outPath: string, content: string): Promise<number> {
  await writeFile(outPath, content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

function printResult(kind: string, idLine: string, outPath: string, size: number): void {
  console.log(chalk.bold.cyan("GhostGlass Export"));
  console.log(chalk.dim("────────────────────────────────"));
  console.log(`${chalk.bold(kind)} ${idLine}`);
  console.log(`${chalk.bold("Output:")} ${outPath}`);
  console.log(`${chalk.bold("Size:")}   ${formatBytes(size)}`);
}

/** `ghostglass export <run-id> [--output path] [--force] [--format html|json] [--redact-*]` */
export async function exportCommand(
  runIdOrLatest: string,
  opts: ExportOptions,
): Promise<void> {
  const format = resolveExportFormat(opts.format);
  const runId = await resolveRunId(opts.cwd, runIdOrLatest);
  console.log(chalk.dim(PRIVACY_NOTE));
  const redact = redactOptions(opts.cwd, opts);
  const outPath = await resolveOutputPath(
    opts.cwd,
    opts.output,
    defaultRunFileName(runId, format),
    opts.force,
  );
  let size: number;
  if (format === "html") {
    const [model, assets] = await Promise.all([
      buildRunExportModel(opts.cwd, runId, redact),
      loadExportAssets(),
    ]);
    size = await writeExportFile(outPath, buildRunExportHtml(model, assets));
  } else {
    const json = await buildRunJsonExport(opts.cwd, runId, redact);
    size = await writeExportFile(outPath, JSON.stringify(json));
  }
  printResult("Run:", runId, outPath, size);
}

/** `ghostglass export-diff <run-a> <run-b> [options]` */
export async function exportDiffCommand(
  a: string,
  b: string,
  opts: ExportOptions,
): Promise<void> {
  const format = resolveExportFormat(opts.format);
  const [runA, runB] = await resolveDiffRunIds(opts.cwd, a, b);
  console.log(chalk.dim(PRIVACY_NOTE));
  const redact = redactOptions(opts.cwd, opts);
  const outPath = await resolveOutputPath(
    opts.cwd,
    opts.output,
    defaultDiffFileName(runA, runB, format),
    opts.force,
  );
  let size: number;
  if (format === "html") {
    const [model, assets] = await Promise.all([
      buildDiffExportModel(opts.cwd, runA, runB, redact),
      loadExportAssets(),
    ]);
    size = await writeExportFile(outPath, buildDiffExportHtml(model, assets));
  } else {
    const json = await buildDiffJsonExport(opts.cwd, runA, runB, redact);
    size = await writeExportFile(outPath, JSON.stringify(json));
  }
  printResult("Diff:", `${runA} vs ${runB}`, outPath, size);
}
