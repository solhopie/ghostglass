/**
 * Extended live demo fixture for `ghostglass watch` browser validation.
 *
 * Runs ~4 minutes of gradual, visible activity in waves so a real browser
 * can observe the viewer updating while the command is still executing:
 *   - creates/modifies/renames/deletes files one at a time
 *   - spawns child processes at visible intervals
 *   - makes localhost connection attempts (accepted + refused)
 *   - prints progress lines to stdout so the terminal shows it is alive
 *
 * No external network dependency. Cleans up after itself.
 *
 * Usage:
 *   ghostglass watch -- node test/fixtures/live-demo-long.cjs
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "live-demo-long-work");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function step(wave, n, total, msg) {
  console.log(`[demo] wave ${wave}/${totalWaves} step ${n}: ${msg}`);
}

async function connectionAttempts() {
  // Accepted connection: listen then connect.
  await new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const client = net.connect(port, "127.0.0.1", () => {
        client.end();
        server.close(() => resolve());
      });
      client.on("error", () => server.close(() => resolve()));
    });
  });
  // Refused connection: connect to a port nothing listens on.
  await new Promise((resolve) => {
    const client = net.connect(9, "127.0.0.1", () => client.end());
    client.on("error", () => resolve());
    client.on("connect", () => {
      client.end();
      resolve();
    });
    setTimeout(resolve, 500);
  });
}

const totalWaves = 10;

async function wave(w) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  step(w, 1, totalWaves, "creating files");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(dir, `wave${w}-file${i}.txt`), `wave ${w} file ${i}\n`);
    sleep(250);
  }

  step(w, 2, totalWaves, "spawning child processes");
  for (let i = 0; i < 3; i++) {
    spawnSync(process.execPath, ["-e", `console.log("child ${i} of wave ${w}")`], { stdio: "ignore" });
    sleep(400);
  }

  step(w, 3, totalWaves, "modifying files");
  for (let i = 0; i < 5; i++) {
    fs.appendFileSync(path.join(dir, `wave${w}-file${i}.txt`), "appended\n");
    sleep(200);
  }

  step(w, 4, totalWaves, "renaming a file");
  fs.renameSync(
    path.join(dir, `wave${w}-file0.txt`),
    path.join(dir, `wave${w}-renamed.txt`),
  );
  sleep(600);

  step(w, 5, totalWaves, "localhost connection attempts");
  await connectionAttempts();
  sleep(300);

  step(w, 6, totalWaves, "deleting files");
  for (let i = 1; i < 5; i++) {
    fs.unlinkSync(path.join(dir, `wave${w}-file${i}.txt`));
    sleep(250);
  }
  fs.unlinkSync(path.join(dir, `wave${w}-renamed.txt`));
  sleep(800);
}

async function main() {
  console.log("[demo] extended live demo starting (~4 min)");
  for (let w = 1; w <= totalWaves; w++) {
    await wave(w);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("[demo] done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
