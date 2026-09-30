/**
 * GhostGlass visual-replay demo fixture.
 *
 * Deterministic and offline: spawns child processes, creates/reads/
 * modifies/renames/deletes files, and makes localhost TCP connection
 * attempts. Produces an attractive little execution graph for screenshots
 * and README demonstrations.
 *
 * Usage: ghostglass run -- node test/fixtures/demo.cjs
 */
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostglass-demo-"));

  // --- files: create + read ---
  const appJs = path.join(dir, "app.js");
  const configJson = path.join(dir, "config.json");
  fs.writeFileSync(appJs, 'console.log("demo app");\n');
  fs.writeFileSync(configJson, JSON.stringify({ name: "demo", version: 1 }) + "\n");
  fs.readFileSync(appJs, "utf8");
  fs.readFileSync(configJson, "utf8");

  // --- modify ---
  fs.appendFileSync(appJs, "// touched by the demo\n");
  fs.readFileSync(appJs, "utf8");

  // --- rename ---
  const settingsJson = path.join(dir, "settings.json");
  fs.renameSync(configJson, settingsJson);
  fs.readFileSync(settingsJson, "utf8");

  // --- child processes ---
  spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });

  // --- grandchild: a child that creates a file ---
  const childJs = path.join(dir, "worker.js");
  const childOut = path.join(dir, "worker-output.txt");
  fs.writeFileSync(
    childJs,
    `require("node:fs").writeFileSync(${JSON.stringify(childOut)}, "from worker\\n");\n`,
  );
  spawnSync(process.execPath, [childJs], { stdio: "ignore" });
  fs.readFileSync(childOut, "utf8");

  // --- localhost TCP: one server, two client connection attempts ---
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end("ok"));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      let pending = 2;
      for (let i = 0; i < 2; i++) {
        const client = net.connect(port, "127.0.0.1", () => {
          client.write("ping");
        });
        client.on("data", () => {
          client.end();
          if (--pending === 0) server.close(() => resolve());
        });
        client.on("error", () => {
          if (--pending === 0) server.close(() => resolve());
        });
      }
    });
  });

  // --- delete + mkdir ---
  const scratch = path.join(dir, "scratch.txt");
  fs.writeFileSync(scratch, "temporary\n");
  fs.unlinkSync(scratch);
  fs.mkdirSync(path.join(dir, "dist"));

  console.log(`demo done: ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
