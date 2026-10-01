/**
 * GhostGlass cause-chain demo fixture (Run 7).
 *
 * Builds an obvious, deterministic execution chain:
 *
 *   root command
 *     └─ spawns writer child  →  writes data.txt
 *     └─ spawns reader child  →  reads data.txt  →  connects to 127.0.0.1:PORT
 *
 * Selecting the network destination in the viewer (or
 * `ghostglass why latest --network 127.0.0.1:PORT`) shows:
 * root → reader → data.txt → writer — every link recorded, nothing inferred.
 *
 * Usage: ghostglass run -- node test/fixtures/cause-demo.cjs
 */
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runChild(script, env) {
  const r = spawnSync(process.execPath, ["-e", script], {
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`child failed: ${script.slice(0, 40)}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostglass-cause-"));
  const dataFile = path.join(dir, "data.txt");

  // Writer child: creates data.txt.
  runChild(`require("node:fs").writeFileSync(${JSON.stringify(dataFile)}, "payload-v1\\n");`, {});

  // Start a localhost TCP server; the reader child will connect to it.
  const server = net.createServer((socket) => {
    // Close the server side immediately so server.close() never hangs.
    socket.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // Reader child: reads data.txt, then opens a TCP connection — both in the
  // single bash process ( $(<file) and /dev/tcp are bash builtins, so no
  // subprocess splits the PID; /dev/tcp connects blockingly, producing a
  // single-line connect(2) in the trace).
  // Recorded chain: root → reader → data.txt → writer.
  const reader = spawnSync(
    "bash",
    ["-c", `data=$(<${JSON.stringify(dataFile)}); echo "$data" > /dev/tcp/127.0.0.1/${port}`],
    { stdio: "ignore" },
  );
  if (reader.status !== 0) throw new Error("reader child failed");

  // Give the server a moment to accept, then shut down.
  await new Promise((resolve) => setTimeout(resolve, 300));
  server.close();

  console.log(`CAUSE_DEMO_PORT=${port}`);
  console.log(`CAUSE_DEMO_FILE=${dataFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
