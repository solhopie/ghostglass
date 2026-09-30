/**
 * GhostGlass diff demo — Run A.
 *
 * Deterministic on purpose: fixed file names under a stable temp dir,
 * fixed localhost destination, synchronous children. Pair with demo-b.cjs:
 *
 *   ghostglass run -- node test/fixtures/demo-a.cjs
 *   ghostglass run -- node test/fixtures/demo-b.cjs
 *   ghostglass diff previous latest
 *
 * Run A: creates alpha.txt, reads config.json, spawns 2 identical
 * children, makes 1 localhost connection.
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

  // Create alpha.txt (only Run A has this file).
  fs.writeFileSync(path.join(DIR, "alpha.txt"), "alpha from demo A\n");

  // Read config.json a few times.
  for (let i = 0; i < 3; i++) {
    fs.readFileSync(CONFIG, "utf8");
  }

  // Spawn 2 identical children.
  for (let i = 0; i < 2; i++) {
    spawnSync("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  }

  // One localhost connection attempt (recorded even if refused).
  await new Promise((resolve) => {
    const sock = net.connect(41230, "127.0.0.1", () => {
      sock.destroy();
      resolve();
    });
    sock.on("error", () => resolve());
    setTimeout(resolve, 500);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
