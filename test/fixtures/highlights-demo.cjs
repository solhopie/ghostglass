/**
 * GhostGlass behavior-highlights demo fixture.
 *
 * Deterministic and harmless: generates normal baseline activity plus
 * obvious, threshold-crossing bursts for every highlight rule. All file
 * I/O stays inside a fresh temp directory; the one executed file is a
 * temporary shell script that prints a line and exits.
 *
 * Expected highlights (with default thresholds):
 * - file-burst: 600+ file events in <3s (notice or high)
 * - process-burst: 20 spawns in <2s (notice)
 * - network-burst: 25 localhost connects in <5s (notice)
 * - delete-burst: 60 deletes in <3s (notice)
 * - rapid-file-churn: 30 writes to one file in <5s (notice)
 * - create-execute: temp script created then executed (notice)
 * - outside-cwd: reads/writes under the temp dir, outside the repo CWD (info/notice)
 *
 * Usage: ghostglass run -- node test/fixtures/highlights-demo.cjs
 */
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostglass-highlights-"));

  // --- baseline: a little normal activity ---
  const baseline = path.join(dir, "baseline.txt");
  fs.writeFileSync(baseline, "baseline\n");
  fs.readFileSync(baseline, "utf8");

  // --- file burst: 600 rapid file events (writes + reads) ---
  for (let i = 0; i < 300; i++) {
    const f = path.join(dir, `burst-${i}.txt`);
    fs.writeFileSync(f, `burst ${i}\n`);
    fs.readFileSync(f, "utf8");
  }

  // --- process burst: 20 quick spawns (/bin/true is fast to start) ---
  for (let i = 0; i < 20; i++) {
    spawnSync("/bin/true", { stdio: "ignore" });
  }

  // --- network burst: 25 localhost connection attempts ---
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end("ok"));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      let pending = 25;
      const done = () => {
        if (--pending === 0) server.close(() => resolve());
      };
      for (let i = 0; i < 25; i++) {
        const client = net.connect(port, "127.0.0.1", () => {
          client.write("ping");
        });
        client.on("data", () => {
          client.end();
          done();
        });
        client.on("error", done);
      }
    });
  });

  // --- delete burst: 60 files deleted ---
  const doomed = [];
  for (let i = 0; i < 60; i++) {
    const f = path.join(dir, `doomed-${i}.txt`);
    fs.writeFileSync(f, "doomed\n");
    doomed.push(f);
  }
  for (const f of doomed) {
    fs.unlinkSync(f);
  }

  // --- rapid file churn: 30 writes to one file ---
  const churnFile = path.join(dir, "churn.txt");
  fs.writeFileSync(churnFile, "start\n");
  for (let i = 0; i < 30; i++) {
    fs.appendFileSync(churnFile, `churn ${i}\n`);
  }

  // --- create then execute: temp binary created and run ---
  // (copied from /bin/true so the tracer sees a direct execve of the path)
  const exePath = path.join(dir, "mytool");
  fs.copyFileSync("/bin/true", exePath);
  fs.chmodSync(exePath, 0o755);
  spawnSync(exePath, { stdio: "ignore" });

  console.log(`highlights demo done: ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
