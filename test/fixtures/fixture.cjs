/**
 * Fixture program for GhostGlass integration tests.
 *
 * Exercises the activity a real trace must capture:
 *  - creates a file
 *  - modifies it
 *  - spawns a child process
 *  - performs a harmless localhost TCP connection
 *  - deletes the temporary file
 *
 * Run under GhostGlass, e.g.:
 *   ghostglass run -- node test/fixtures/fixture.js
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawnSync } = require("node:child_process");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostglass-fixture-"));
  const file = path.join(dir, "fixture-data.txt");

  // create
  fs.writeFileSync(file, "hello\n");
  // modify
  fs.appendFileSync(file, "world\n");

  // spawn a child process
  spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });

  // harmless localhost TCP round-trip (no internet needed)
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end("ok"));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const client = net.connect(port, "127.0.0.1");
      client.on("error", reject);
      client.on("close", () => server.close(() => resolve()));
      client.resume();
    });
  });

  // delete
  fs.unlinkSync(file);
  fs.rmdirSync(dir);

  console.log("fixture done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
