/**
 * GhostGlass diff demo — Run B.
 *
 * Deliberately differs from demo-a.cjs: creates beta.txt instead of
 * alpha.txt, writes config.json more often, spawns 4 children (2 shared
 * with A, 2 unique), and makes 3 localhost connections instead of 1.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DIR = path.join(os.tmpdir(), "gg-diff-demo");
const CONFIG = path.join(DIR, "config.json");

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(CONFIG)) {
    fs.writeFileSync(CONFIG, JSON.stringify({ demo: true, version: 1 }));
  }

  // Create beta.txt (only Run B has this file).
  fs.writeFileSync(path.join(DIR, "beta.txt"), "beta from demo B\n");

  // Touch config.json more often than Run A: 5 writes + 2 reads.
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(CONFIG, JSON.stringify({ demo: true, version: 1, write: i }));
  }
  for (let i = 0; i < 2; i++) {
    fs.readFileSync(CONFIG, "utf8");
  }

  // Spawn 4 children: 2 identical to Run A's, 2 unique to Run B.
  for (let i = 0; i < 2; i++) {
    spawnSync("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  }
  for (let i = 0; i < 2; i++) {
    spawnSync("node", ["-e", "console.log('b-worker')"], { stdio: "ignore" });
  }

  // Three localhost connection attempts.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      const sock = net.connect(41230, "127.0.0.1", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => resolve());
      setTimeout(resolve, 500);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
