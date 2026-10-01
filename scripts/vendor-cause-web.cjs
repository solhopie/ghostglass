/**
 * Vendor the cause-chain engine into web/src for the browser bundle.
 *
 * src/cause is the single source of truth (pure logic, zero runtime deps
 * outside itself; external imports are type-only). The web build (tsc -p
 * web, esbuild) cannot import outside web/src due to rootDir, so this
 * script copies the engine into web/src/cause/ and rewrites the two
 * type-only imports to web's local types.ts.
 *
 * The vendored copy is a build artifact (gitignored) — never edit it.
 */
const { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "cause");
const DEST = join(ROOT, "web", "src", "cause");

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

for (const file of readdirSync(SRC)) {
  if (!file.endsWith(".ts")) continue;
  let text = readFileSync(join(SRC, file), "utf8");
  text = text
    .replace(/from "\.\.\/events\/types\.js"/g, 'from "../types.js"')
    .replace(/from "\.\.\/highlights\/types\.js"/g, 'from "../types.js"');
  writeFileSync(join(DEST, file), text);
}
console.log(`vendored cause engine -> web/src/cause (${readdirSync(DEST).length} files)`);
