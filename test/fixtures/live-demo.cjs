/**
 * Deterministic live demo fixture for `ghostglass watch`.
 *
 * Runs ~8 seconds of deliberately gradual, visible activity:
 *   1. creates files one at a time
 *   2. spawns child processes at visible intervals
 *   3. modifies files
 *   4. renames a file
 *   5. makes localhost connection attempts (accepted + refused)
 *   6. deletes a file
 *
 * No external network dependency — everything targets 127.0.0.1 or the
 * local filesystem. Progress lines go to stdout so the terminal shows the
 * command is alive while the viewer shows what it is doing.
 *
 * Usage:
 *   ghostglass watch -- node test/fixtures/live-demo.cjs
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "live-demo-work");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function step(n, msg) {
  console.log(`[demo ${n}/6] ${msg}`);
}

// Localhost connection attempts: accepted ones, then a refused one
// (refused attempts are still recorded — the program tried).
// NOTE: each client reads the greeting before ending. Ending a socket
// immediately on connect without reading hangs the event loop on Node 24
// (observed 2026-09-30: 'close' never fires, process never exits).
async function connectionAttempts() {
  const server = net.createServer((socket) => socket.end("hi\n"));
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("data", () => s.end());
      s.on("close", resolve);
      s.on("error", resolve);
    });
    sleep(200);
  }
  await new Promise((resolve) => server.close(resolve));
  // Closed port: ECONNREFUSED, still a recorded attempt.
  await new Promise((resolve) => {
    const refused = net.connect(port, "127.0.0.1");
    refused.on("error", () => {});
    refused.on("close", resolve);
  });
}

async function main() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 1. Create files gradually — each appears in the live graph one by one.
  step(1, "creating files gradually");
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(dir, `file-${i}.txt`), `demo content ${i}\n`);
    sleep(700);
  }

  // 2. Spawn child processes at visible intervals.
  step(2, "spawning child processes");
  for (let i = 1; i <= 3; i++) {
    spawnSync(process.execPath, ["-e", `console.log("child ${i} reporting")`], {
      stdio: "inherit",
    });
    sleep(800);
  }

  // 3. Modify files.
  step(3, "modifying files");
  for (let i = 1; i <= 3; i++) {
    fs.appendFileSync(path.join(dir, `file-${i}.txt`), `appended line ${i}\n`);
    sleep(500);
  }

  // 4. Rename a file.
  step(4, "renaming a file");
  fs.renameSync(path.join(dir, "file-4.txt"), path.join(dir, "renamed.txt"));
  sleep(700);

  // 5. Localhost connection attempts.
  step(5, "localhost connection attempts");
  await connectionAttempts();

  // 6. Delete a file.
  step(6, "deleting a file");
  fs.unlinkSync(path.join(dir, "file-5.txt"));
  sleep(500);

  console.log("[demo] done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
