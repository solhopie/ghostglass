/**
 * Export asset loading.
 *
 * The static HTML export inlines the real GhostGlass viewer: the bundled
 * frontend JavaScript and the viewer stylesheet. These are produced at
 * GhostGlass build time (`npm run build:export-assets`) into
 * dist/export-assets/ so `ghostglass export` needs no build tooling,
 * no network, and no extra dependencies at export time.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExportAssets {
  /** Bundled viewer JS (IIFE, minified), safe to inline in <script>. */
  js: string;
  /** Viewer stylesheet, safe to inline in <style>. */
  css: string;
}

function assetsDir(): string {
  // From dist/src/export/assetBundler.js -> dist/export-assets/
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "export-assets");
}

export async function loadExportAssets(): Promise<ExportAssets> {
  const dir = assetsDir();
  try {
    const [js, css] = await Promise.all([
      readFile(join(dir, "viewer.js"), "utf8"),
      readFile(join(dir, "styles.css"), "utf8"),
    ]);
    return { js, css };
  } catch {
    throw new Error(
      "Export assets not found. Rebuild GhostGlass with `npm run build` before exporting.",
    );
  }
}
