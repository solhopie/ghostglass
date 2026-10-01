/**
 * Vendor the trace query engine into web/src for the browser bundle.
 *
 * src/query is the single source of truth (pure logic, zero runtime deps;
 * external imports are type-only). The web build (tsc -p web, esbuild)
 * cannot import outside web/src due to rootDir, so this script copies the
 * engine into web/src/query/ and rewrites the type-only import to web's
 * local types.ts.
 *
 * The vendored copy is a build artifact (gitignored) — never edit it.
 */
const { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "query");
const DEST = join(ROOT, "web", "src", "query");

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

for (const file of readdirSync(SRC)) {
  if (!file.endsWith(".ts")) continue;
  let text = readFileSync(join(SRC, file), "utf8");
  text = text.replace(/from "\.\.\/events\/types\.js"/g, 'from "../types.js"');
  writeFileSync(join(DEST, file), text);
}
console.log(`vendored query engine -> web/src/query (${readdirSync(DEST).length} files)`);
