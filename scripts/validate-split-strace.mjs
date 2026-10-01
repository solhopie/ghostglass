/**
 * Real-strace validation for Run 8 split-syscall reconstruction.
 * Parses /tmp/split-trace.log with the new StraceStreamParser and reports:
 * - reconstruction diagnostics
 * - spawn events from reconstructed clone3 pairs (with parent/child check)
 * - comparison against the old drop-fragments behavior
 */
import { readFileSync } from "node:fs";
import { StraceStreamParser } from "../dist/src/parser/streamParser.js";
import { parseLine, createParseContext } from "../dist/src/parser/straceParser.js";

const trace = readFileSync("/tmp/split-trace.log", "utf8");
const lines = trace.split("\n").filter((l) => l.trim());

// Count raw markers.
const unfinishedCount = lines.filter((l) => l.includes("<unfinished ...>")).length;
const resumedCount = lines.filter((l) => l.includes(" resumed>")).length;
console.log(`raw trace: ${lines.length} lines, ${unfinishedCount} unfinished, ${resumedCount} resumed`);

// New parser (with reconstruction).
const start = new Date(2026, 8, 30, 1, 0, 0, 0).getTime();
const p = new StraceStreamParser("gg_real_split", start);
const events = [];
for (const line of lines) {
  events.push(...p.push(line + "\n"));
}
events.push(...p.flush());
const diag = p.getReconstructionDiagnostics();
const stats = p.getStats();
console.log(`new parser: ${events.length} events, diagnostics:`, JSON.stringify(diag));

// Old behavior: parseLine directly (fragments dropped).
const ctx = createParseContext("gg_old", start);
let oldEvents = 0;
for (const line of lines) {
  if (parseLine(line, ctx)) oldEvents++;
}
console.log(`old parser (fragments dropped): ${oldEvents} events`);

// Spawn verification: every reconstructed clone3 spawn must have parentPid
// and a child pid matching the raw resumed return value.
const spawns = events.filter((e) => e.action === "spawn");
const reconSpawns = spawns.filter((e) => e.metadata?.reconstructed === true);
console.log(`spawn events: ${spawns.length} total, ${reconSpawns.length} reconstructed`);

// Cross-check: for each unfinished clone3, find its resumed line's return pid
// and verify a spawn event exists with that parent/child.
const pending = new Map();
let verified = 0;
let missing = 0;
for (const line of lines) {
  const um = line.match(/^(\d+)\s+\S+\s+(clone3?)\(.*<unfinished \.\.\.>$/);
  if (um) {
    pending.set(parseInt(um[1], 10) + ":" + um[2], true);
    continue;
  }
  const rm = line.match(/^(\d+)\s+\S+\s+<\.\.\. (clone3?) resumed>.*\) = (\d+)/);
  if (rm) {
    const pid = parseInt(rm[1], 10);
    const child = parseInt(rm[3], 10);
    const key = pid + ":" + rm[2];
    if (pending.has(key)) {
      pending.delete(key);
      const ev = spawns.find((e) => e.pid === child && e.parentPid === pid);
      if (ev) verified++;
      else {
        missing++;
        console.log(`MISSING spawn for parent=${pid} child=${child}`);
      }
    }
  }
}
console.log(`clone spawn verification: ${verified} verified, ${missing} missing`);

// Cause-chain ancestry check: every reconstructed spawn's parent must itself
// be traceable (have an exec or spawn event) unless it's the root.
const pidsWithEvents = new Set(events.map((e) => e.pid));
let orphanSpawns = 0;
for (const s of reconSpawns) {
  if (s.parentPid !== undefined && !pidsWithEvents.has(s.parentPid)) {
    orphanSpawns++;
  }
}
console.log(`reconstructed spawns with unknown parent pid: ${orphanSpawns}`);

// Event-loss check: new parser must produce >= old parser events.
console.log(`event delta (new - old): ${events.length - oldEvents} (must be >= 0)`);
if (events.length < oldEvents) {
  console.log("FAIL: event loss!");
  process.exit(1);
}
if (missing > 0) {
  console.log("FAIL: missing spawns!");
  process.exit(1);
}
console.log("REAL STRACE VALIDATION: PASS");
