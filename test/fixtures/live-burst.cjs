/**
 * High-volume fixture for live-mode performance testing.
 *
 * Generates 60k+ file events as fast as the filesystem allows, so tests
 * can measure tracing throughput, broadcast batching, and event loss
 * (streamed vs persisted counts must match exactly).
 *
 * Usage:
 *   ghostglass watch -- node test/fixtures/live-burst.cjs [fileCount]
 */
const fs = require("fs");
const path = require("path");

const count = parseInt(process.argv[2] || "15000", 10);
const dir = path.join(__dirname, "live-burst-work");

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

console.log(`[burst] writing+reading ${count} files`);
const start = Date.now();
for (let i = 0; i < count; i++) {
  const p = path.join(dir, `f${i}.txt`);
  fs.writeFileSync(p, "x");
  fs.readFileSync(p);
}
const elapsed = Date.now() - start;
console.log(`[burst] done in ${elapsed}ms`);
