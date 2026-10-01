/**
 * Live Glass streaming verification for Run 8.
 * Simulates the tracer's incremental tail: the real split trace is fed in
 * small arbitrary chunks; verifies:
 * 1. No event is emitted for an unfinished fragment alone (held, not faked).
 * 2. Each reconstructed pair emits exactly one event, on the resumed chunk.
 * 3. No duplicate events (unique IDs).
 * 4. Streamed count equals batch-parsed count.
 */
import { readFileSync } from "node:fs";
import { StraceStreamParser } from "../dist/src/parser/streamParser.js";

const trace = readFileSync("/tmp/split-trace.log", "utf8");
const start = new Date(2026, 8, 30, 1, 0, 0, 0).getTime();

// --- 1 & 2: unfinished alone emits nothing; resume emits exactly one ---
{
  const p = new StraceStreamParser("gg_live_1", start);
  const e1 = p.push("100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n");
  console.log(`after unfinished chunk: ${e1.length} events (expect 0)`);
  if (e1.length !== 0) {
    console.log("FAIL: premature event from unfinished fragment");
    process.exit(1);
  }
  const e2 = p.push("100 01:00:01.000050 <... clone resumed>) = 200\n");
  console.log(`after resumed chunk: ${e2.length} events (expect 1)`);
  if (e2.length !== 1 || e2[0].action !== "spawn") {
    console.log("FAIL: resumed chunk did not emit exactly one spawn");
    process.exit(1);
  }
  p.flush();
}

// --- 3 & 4: chunked streaming of the real trace ---
{
  const p = new StraceStreamParser("gg_live_2", start);
  const streamed = [];
  // Arbitrary 37-byte chunks, like a tail reader under backpressure.
  for (let i = 0; i < trace.length; i += 37) {
    streamed.push(...p.push(trace.slice(i, i + 37)));
  }
  streamed.push(...p.flush());

  const ids = new Set(streamed.map((e) => e.id));
  console.log(`streamed: ${streamed.length} events, ${ids.size} unique ids`);
  if (ids.size !== streamed.length) {
    console.log("FAIL: duplicate events streamed");
    process.exit(1);
  }

  // Batch comparison.
  const q = new StraceStreamParser("gg_live_3", start);
  const batched = [];
  for (const line of trace.split("\n")) {
    if (line.trim()) batched.push(...q.push(line + "\n"));
  }
  batched.push(...q.flush());
  console.log(`batched: ${batched.length} events`);
  if (streamed.length !== batched.length) {
    console.log("FAIL: streamed count != batched count");
    process.exit(1);
  }
  const d = p.getReconstructionDiagnostics();
  console.log("streaming diagnostics:", JSON.stringify(d));
  if (d.reconstructed !== 134) {
    console.log("FAIL: expected 134 reconstructions in streaming mode");
    process.exit(1);
  }
}

console.log("LIVE STREAMING VERIFICATION: PASS");
