/**
 * Cause Chain ancestry repair verification for Run 8.
 *
 * Scenario: npm (pid 1) spawns node (pid 100) via a SPLIT clone, then node
 * spawns git (pid 200) via a normal clone. Before Run 8, the split clone
 * was dropped, so git's ancestry showed "[Parent not captured]" / INCOMPLETE.
 * After Run 8, the chain must be complete: npm -> node -> git.
 *
 * Also verifies: when evidence is truly missing, the chain stays INCOMPLETE.
 */
import { StraceStreamParser } from "../dist/src/parser/streamParser.js";
import { buildCauseIndex } from "../dist/src/cause/causeIndex.js";
import { buildCauseChain } from "../dist/src/cause/buildCauseChain.js";

const start = new Date(2026, 8, 30, 1, 0, 0, 0).getTime();

function parseToEvents(lines) {
  const p = new StraceStreamParser("gg_cause_001", start);
  const events = [];
  for (const line of lines) events.push(...p.push(line + "\n"));
  events.push(...p.flush());
  return events;
}

// --- Repaired ancestry: split clone in the middle of the chain ---
{
  const events = parseToEvents([
    '1 01:00:01.000001 execve("/usr/bin/npm", ["npm", "run", "build"], 0x1 /* 10 vars */) = 0',
    "1 01:00:02.000001 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD <unfinished ...>",
    "1 01:00:02.000050 <... clone resumed>, child_tidptr=0x1) = 100",
    '100 01:00:02.000060 execve("/usr/bin/node", ["node", "build.js"], 0x1 /* 10 vars */) = 0',
    "100 01:00:03.000001 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD, child_tidptr=0x2) = 200",
    '200 01:00:03.000060 execve("/usr/bin/git", ["git", "status"], 0x1 /* 10 vars */) = 0',
  ]);
  const index = buildCauseIndex(events, "gg_cause_001", start);
  const result = buildCauseChain(
    { index, commandLine: "npm run build" },
    { kind: "pid", pid: 200 },
  );
  if (!result.ok) {
    console.log("FAIL: buildCauseChain error:", result.error);
    process.exit(1);
  }
  const chain = result.chain;
  console.log("repaired chain confidence:", chain.confidence);
  console.log(
    "repaired chain nodes:",
    chain.paths[0]?.nodes.map((n) => n.label).join(" -> "),
  );
  const labels = chain.paths[0]?.nodes.map((n) => n.label).join(" ") ?? "";
  // PID-target chains are "structural" when ancestry is complete (no single
  // direct event), "incomplete" when ancestry is broken. The repaired chain
  // must not be incomplete and must show no orphan labels.
  if (chain.confidence === "incomplete") {
    console.log("FAIL: repaired chain should not be incomplete");
    process.exit(1);
  }
  if (labels.includes("not captured")) {
    console.log("FAIL: chain still shows orphan after reconstruction");
    process.exit(1);
  }
  // The chain must contain npm(1) -> node(100) -> git(200).
  const pids = chain.paths[0]?.nodes.map((n) => n.pid).filter(Boolean) ?? [];
  for (const want of [1, 100, 200]) {
    if (!pids.includes(want)) {
      console.log(`FAIL: pid ${want} missing from chain`);
      process.exit(1);
    }
  }
  console.log("repaired ancestry: PASS");
}

// --- Honesty preserved: truly missing evidence stays INCOMPLETE ---
{
  const events = parseToEvents([
    // No clone at all for pid 200 — only an orphan resumed fragment.
    "1 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
    "1 01:00:01.000050 <... clone resumed>) = 100",
    '200 01:00:03.000060 execve("/usr/bin/git", ["git", "status"], 0x1 /* 10 vars */) = 0',
  ]);
  const index = buildCauseIndex(events, "gg_cause_001", start);
  const result = buildCauseChain(
    { index, commandLine: "npm run build" },
    { kind: "pid", pid: 200 },
  );
  if (!result.ok) {
    console.log("FAIL: buildCauseChain error:", result.error);
    process.exit(1);
  }
  const chain = result.chain;
  console.log("honest chain confidence:", chain.confidence);
  if (chain.confidence !== "incomplete") {
    console.log("FAIL: truly-missing ancestry must be incomplete");
    process.exit(1);
  }
  console.log("honest incompleteness: PASS");
}

console.log("CAUSE CHAIN VERIFICATION: PASS");
