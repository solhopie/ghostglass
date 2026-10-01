/**
 * Cause Chain tests (Run 7).
 *
 * 40 test cases covering the cause engine: direct/structural/incomplete
 * confidence, process ancestry, file/network/pid/event/highlight targets,
 * multiple paths, ambiguity, determinism, performance, and edge cases.
 * All use synthetic events — no strace, no network, no filesystem access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhostGlassEvent } from "../src/events/types.js";
import type { Highlight } from "../src/highlights/types.js";
import {
  buildCauseIndex,
  extendCauseIndex,
  buildCauseChain,
  reconstructAncestry,
  processLabel,
  networkKey,
  resolveFileQuery,
  type CauseIndex,
  type ChainInput,
} from "../src/cause/index.js";

let eventSeq = 0;
function makeEvent(
  overrides: Partial<GhostGlassEvent> & { type: GhostGlassEvent["type"]; action: string },
): GhostGlassEvent {
  eventSeq++;
  return {
    id: `cause-test-${eventSeq}`,
    runId: "cause-run",
    timestamp: 1000000 + eventSeq * 100,
    pid: 100,
    ...overrides,
  } as GhostGlassEvent;
}

/**
 * Build a canonical scenario:
 *   root(100, /bin/sh) --spawn--> npm(101) --spawn--> node(102)
 *   node(102) writes /work/package-lock.json, connects 10.0.0.1:443
 */
function scenario(): { index: CauseIndex; input: ChainInput; events: GhostGlassEvent[] } {
  const events: GhostGlassEvent[] = [];
  const t0 = 1000000;
  events.push(
    makeEvent({ id: "e-exec-root", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: t0 }),
    makeEvent({ id: "e-spawn-npm", type: "process", action: "spawn", pid: 101, parentPid: 100, timestamp: t0 + 100 }),
    makeEvent({ id: "e-exec-npm", type: "process", action: "exec", pid: 101, executable: "/usr/bin/npm", timestamp: t0 + 110 }),
    makeEvent({ id: "e-spawn-node", type: "process", action: "spawn", pid: 102, parentPid: 101, timestamp: t0 + 200 }),
    makeEvent({ id: "e-exec-node", type: "process", action: "exec", pid: 102, executable: "/usr/bin/node", timestamp: t0 + 210 }),
    makeEvent({ id: "e-write", type: "file", action: "write", pid: 102, path: "/work/package-lock.json", timestamp: t0 + 300 }),
    makeEvent({ id: "e-connect", type: "network", action: "connect", pid: 102, ip: "10.0.0.1", port: 443, timestamp: t0 + 400 }),
  );
  const index = buildCauseIndex(events, "cause-run", t0);
  const input: ChainInput = { index, commandLine: "npm install express" };
  return { index, input, events };
}

function makeHighlight(overrides: Partial<Highlight>): Highlight {
  return {
    id: "hl-1",
    runId: "cause-run",
    rule: "high-file-activity",
    severity: "notice",
    title: "File activity burst",
    explanation: "test",
    startTimestamp: 1000300,
    relatedEventIds: ["e-write"],
    metadata: {},
    ...overrides,
  };
}

describe("cause chain: file targets", () => {
  it("1. direct file-write cause resolves the full ancestry path", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "file", path: "/work/package-lock.json" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const path = r.chain.paths[0];
    assert.ok(path);
    const labels = path.nodes.map((n) => n.label);
    assert.ok(labels.includes("npm install express"));
    assert.ok(labels.includes("npm"));
    assert.ok(labels.includes("node"));
    assert.ok(labels.includes("/work/package-lock.json"));
  });

  it("2. file-read cause links read events", () => {
    const { index, input } = scenario();
    const read = makeEvent({ id: "e-read", type: "file", action: "read", pid: 101, path: "/work/package.json", timestamp: 1000500 });
    extendCauseIndex(index, [read]);
    const r = buildCauseChain(input, { kind: "file", path: "/work/package.json" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.paths.length, 1);
    const edge = r.chain.paths[0]?.edges.find((e) => e.kind === "read");
    assert.ok(edge, "expected a read edge");
  });

  it("8. multiple file actors produce separate paths, never merged", () => {
    const { index, input } = scenario();
    const other = makeEvent({ id: "e-write2", type: "file", action: "write", pid: 101, path: "/work/package-lock.json", timestamp: 1000600 });
    extendCauseIndex(index, [other]);
    const r = buildCauseChain(input, { kind: "file", path: "/work/package-lock.json" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.paths.length, 2);
    // Each path ends at the same file node but via a different process.
    const pids = r.chain.paths.map((p) => p.nodes[p.nodes.length - 2]?.pid).sort();
    assert.deepEqual(pids, [101, 102]);
  });

  it("9. ambiguous file query lists matches without choosing", () => {
    const { index, input } = scenario();
    extendCauseIndex(index, [
      makeEvent({ id: "e-a", type: "file", action: "write", pid: 102, path: "/project/a/config.json", timestamp: 1000700 }),
      makeEvent({ id: "e-b", type: "file", action: "write", pid: 102, path: "/project/b/config.json", timestamp: 1000800 }),
    ]);
    const r = buildCauseChain(input, { kind: "file", path: "config.json" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.ambiguous);
    assert.deepEqual(r.ambiguous.matches, ["/project/a/config.json", "/project/b/config.json"]);
  });

  it("10. exact file query resolves even with similar paths present", () => {
    const { index, input } = scenario();
    extendCauseIndex(index, [
      makeEvent({ id: "e-a", type: "file", action: "write", pid: 102, path: "/project/a/config.json", timestamp: 1000700 }),
    ]);
    const r = buildCauseChain(input, { kind: "file", path: "/project/a/config.json" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.targetLabel, "/project/a/config.json");
  });

  it("35. empty run reports no events for file target", () => {
    const index = buildCauseIndex([], "empty", 1000000);
    const r = buildCauseChain({ index, commandLine: "true" }, { kind: "file", path: "/x" });
    assert.equal(r.ok, false);
  });
});

describe("cause chain: network targets", () => {
  it("3. network cause shows responsible pid, ancestry, and destination", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "network", destination: "10.0.0.1:443" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.targetLabel, "10.0.0.1:443");
    const path = r.chain.paths[0];
    assert.ok(path);
    const netNode = path.nodes[path.nodes.length - 1];
    assert.equal(netNode?.kind, "network");
    assert.equal(netNode?.pid, 102);
    const labels = path.nodes.map((n) => n.label);
    assert.ok(labels.includes("node"));
    assert.ok(labels.includes("npm"));
  });

  it("11. network lookup tolerates host-only query", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "network", destination: "10.0.0.1" });
    assert.equal(r.ok, true);
  });

  it("networkKey prefers captured host over ip, never invents", () => {
    const e = makeEvent({ type: "network", action: "connect", ip: "1.2.3.4", port: 80 });
    assert.equal(networkKey(e), "1.2.3.4:80");
    const withHost = makeEvent({ type: "network", action: "connect", ip: "1.2.3.4", host: "example.com", port: 80 });
    assert.equal(networkKey(withHost), "example.com:80");
  });
});

describe("cause chain: process ancestry", () => {
  it("4. child-process ancestry walks to the traced root", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "pid", pid: 102 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const labels = r.chain.paths[0]?.nodes.map((n) => n.label) ?? [];
    assert.deepEqual(labels.slice(0, 4), ["npm install express", "sh", "npm", "node"]);
  });

  it("5. deep ancestry (5 levels) resolves in order", () => {
    const events: GhostGlassEvent[] = [];
    const t0 = 2000000;
    events.push(makeEvent({ id: "d0", type: "process", action: "exec", pid: 1, executable: "/init", timestamp: t0 }));
    for (let i = 2; i <= 6; i++) {
      events.push(makeEvent({ id: `d-spawn-${i}`, type: "process", action: "spawn", pid: i, parentPid: i - 1, timestamp: t0 + i * 10 }));
      events.push(makeEvent({ id: `d-exec-${i}`, type: "process", action: "exec", pid: i, executable: `/bin/p${i}`, timestamp: t0 + i * 10 + 1 }));
    }
    const index = buildCauseIndex(events, "deep", t0);
    const res = reconstructAncestry(index, 6);
    assert.equal(res.chain.length, 6);
    assert.equal(res.incomplete, false);
    assert.deepEqual(res.chain.map((s) => s.pid), [1, 2, 3, 4, 5, 6]);
  });

  it("6. root process chain is just the root command", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "pid", pid: 100 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const nodes = r.chain.paths[0]?.nodes ?? [];
    assert.equal(nodes[0]?.kind, "root-command");
    assert.equal(r.chain.incomplete, false);
  });

  it("7. missing parent is labeled incomplete, never manufactured", () => {
    const events = [
      makeEvent({ id: "m1", type: "file", action: "write", pid: 999, path: "/x", timestamp: 1000000 }),
    ];
    const index = buildCauseIndex(events, "missing", 1000000);
    const res = reconstructAncestry(index, 999);
    // PID observed but no spawn recorded: chain has the pid itself, marked
    // as a root candidate — but the parent link is absent.
    assert.equal(res.chain.length, 1);
    const r = buildCauseChain({ index, commandLine: "cmd" }, { kind: "pid", pid: 999 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(
      r.chain.explanation.includes("no recorded parent"),
      "explanation must say the parent was not recorded",
    );
  });

  it("12. pid lookup for unknown pid fails cleanly", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "pid", pid: 424242 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.error.includes("424242"));
  });

  it("36. malformed ancestry (self-parent) does not loop", () => {
    const events = [
      makeEvent({ id: "c1", type: "process", action: "spawn", pid: 50, parentPid: 50, timestamp: 1000000 }),
    ];
    const index = buildCauseIndex(events, "cycle", 1000000);
    const res = reconstructAncestry(index, 50);
    assert.equal(res.cycleBroken, true);
    assert.ok(res.chain.length < 10000);
  });

  it("37. process cycles are prevented", () => {
    const events = [
      makeEvent({ id: "c1", type: "process", action: "spawn", pid: 51, parentPid: 52, timestamp: 1000000 }),
      makeEvent({ id: "c2", type: "process", action: "spawn", pid: 52, parentPid: 51, timestamp: 1000001 }),
    ];
    const index = buildCauseIndex(events, "cycle2", 1000000);
    const res = reconstructAncestry(index, 51);
    assert.equal(res.cycleBroken, true);
  });

  it("processLabel falls back to PID when no executable", () => {
    assert.equal(processLabel({ pid: 7, firstSeen: 0 }), "PID 7");
    assert.equal(processLabel({ pid: 7, firstSeen: 0, executable: "/usr/bin/node" }), "node");
  });
});

describe("cause chain: event targets", () => {
  it("13. event lookup resolves the performing process path", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "e-write" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.confidence, "direct");
    const labels = r.chain.paths[0]?.nodes.map((n) => n.label) ?? [];
    assert.ok(labels.includes("WRITE /work/package-lock.json"));
  });

  it("event lookup for unknown id fails cleanly", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "nope" });
    assert.equal(r.ok, false);
  });

  it("14. highlight cause traces related events to their processes", () => {
    const { input } = scenario();
    input.highlights = [makeHighlight({})];
    const r = buildCauseChain(input, { kind: "highlight", highlightId: "hl-1" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const labels = r.chain.paths[0]?.nodes.map((n) => n.label) ?? [];
    assert.ok(labels.includes("node"));
    assert.ok(labels.includes("File activity burst"));
    assert.ok(r.chain.explanation.includes("observed behavior, not a verdict"));
  });

  it("highlight with no related events fails honestly", () => {
    const { input } = scenario();
    input.highlights = [makeHighlight({ relatedEventIds: ["missing"] })];
    const r = buildCauseChain(input, { kind: "highlight", highlightId: "hl-1" });
    assert.equal(r.ok, false);
  });
});

describe("cause chain: confidence model", () => {
  it("15. direct confidence for explicitly recorded target events", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "e-connect" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.confidence, "direct");
  });

  it("16. structural confidence for pid ancestry without a target event", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "pid", pid: 102 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.confidence, "structural");
  });

  it("17. incomplete confidence when ancestry links are missing", () => {
    // Child spawned by a parent that was never observed: the spawn event
    // records parentPid 500, but pid 500 has no events of its own.
    const events = [
      makeEvent({ id: "i1", type: "process", action: "spawn", pid: 501, parentPid: 500, timestamp: 1000000 }),
      makeEvent({ id: "i2", type: "file", action: "write", pid: 501, path: "/y", timestamp: 1000100 }),
    ];
    const index = buildCauseIndex(events, "incomplete", 1000000);
    // Note: touchProcess creates a ProcessInfo for the parent (500) from the
    // spawn event, so ancestry is technically complete here. Force true
    // incompleteness by deleting the parent info.
    index.processByPid.delete(500);
    const r = buildCauseChain({ index, commandLine: "cmd" }, { kind: "event", eventId: "i2" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.chain.confidence, "incomplete");
    assert.equal(r.chain.incomplete, true);
  });

  it("confidence never uses percentages", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "e-write" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(!/%/.test(r.chain.explanation));
    assert.ok(["direct", "structural", "incomplete"].includes(r.chain.confidence));
  });
});

describe("cause chain: explanations and evidence", () => {
  it("18. deterministic explanation: same input, same text", () => {
    const a = scenario();
    const b = scenario();
    const ra = buildCauseChain(a.input, { kind: "file", path: "/work/package-lock.json" });
    const rb = buildCauseChain(b.input, { kind: "file", path: "/work/package-lock.json" });
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    if (!ra.ok || !rb.ok) return;
    assert.equal(ra.chain.explanation, rb.chain.explanation);
  });

  it("19. evidence list grounds every step in trace events", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "e-write" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.chain.evidence.length >= 2);
    assert.ok(r.chain.evidence.some((e) => e.includes("PROCESS SPAWN")));
    assert.ok(r.chain.evidence.some((e) => e.includes("PID 102")));
  });

  it("explanations never use forbidden verdict words or intent language", () => {
    const { input } = scenario();
    const targets = [
      { kind: "event", eventId: "e-write" },
      { kind: "pid", pid: 102 },
      { kind: "file", path: "/work/package-lock.json" },
      { kind: "network", destination: "10.0.0.1:443" },
    ] as const;
    const forbidden = ["safe", "unsafe", "malicious", "virus", "threat", "clean", "dangerous", "attack", "exploit", "intended", "wanted"];
    for (const t of targets) {
      const r = buildCauseChain(input, t);
      assert.equal(r.ok, true);
      if (!r.ok) continue;
      const text = r.chain.explanation.toLowerCase();
      for (const w of forbidden) {
        assert.ok(!text.includes(w), `explanation must not contain "${w}"`);
      }
    }
  });

  it("20. timeline seek data: nodes carry timestamps and event ids", () => {
    const { input } = scenario();
    const r = buildCauseChain(input, { kind: "event", eventId: "e-write" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const nodes = r.chain.paths[0]?.nodes ?? [];
    for (const n of nodes) {
      assert.ok(typeof n.timestamp === "number", `node ${n.id} needs a timestamp for seeking`);
    }
    const eventNode = nodes.find((n) => n.kind === "event");
    assert.equal(eventNode?.eventId, "e-write");
    // Offsets are derivable from runStartMs.
    assert.ok((eventNode?.timestamp ?? 0) - r.chain.runStartMs === 300);
  });
});

describe("cause chain: live incremental", () => {
  it("23. live Glass incremental cause: chain works mid-run and updates", () => {
    const t0 = 3000000;
    const index = buildCauseIndex([], "live", t0);
    const input: ChainInput = { index, commandLine: "npm install express" };
    // Early: only the root is known.
    extendCauseIndex(index, [
      makeEvent({ id: "l0", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: t0 }),
    ]);
    let r = buildCauseChain(input, { kind: "pid", pid: 100 });
    assert.equal(r.ok, true);
    // Later: child spawns and writes; the chain updates without rebuild.
    extendCauseIndex(index, [
      makeEvent({ id: "l1", type: "process", action: "spawn", pid: 101, parentPid: 100, timestamp: t0 + 100 }),
      makeEvent({ id: "l2", type: "file", action: "write", pid: 101, path: "/work/out.txt", timestamp: t0 + 200 }),
    ]);
    r = buildCauseChain(input, { kind: "file", path: "/work/out.txt" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const labels = r.chain.paths[0]?.nodes.map((n) => n.label) ?? [];
    assert.ok(labels.includes("sh"));
    assert.ok(labels.includes("/work/out.txt"));
  });

  it("extendCauseIndex is idempotent for duplicate events", () => {
    const { index } = scenario();
    const before = index.ordered.length;
    const dup = index.eventById.get("e-write");
    assert.ok(dup);
    extendCauseIndex(index, [dup]);
    assert.equal(index.ordered.length, before);
  });
});

describe("cause chain: edge cases", () => {
  it("34. interrupted run: partial trace still yields chains", () => {
    const events = [
      makeEvent({ id: "p1", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: 1000000 }),
      makeEvent({ id: "p2", type: "process", action: "spawn", pid: 101, parentPid: 100, timestamp: 1000100 }),
      // Trace cuts off: no exec for 101, no further events.
    ];
    const index = buildCauseIndex(events, "partial", 1000000);
    const r = buildCauseChain({ index, commandLine: "cmd" }, { kind: "pid", pid: 101 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const labels = r.chain.paths[0]?.nodes.map((n) => n.label) ?? [];
    assert.ok(labels.includes("PID 101")); // fallback label, not invented exe
  });

  it("resolveFileQuery returns none for unknown paths", () => {
    const { index } = scenario();
    assert.deepEqual(resolveFileQuery(index, "/does/not/exist"), { kind: "none" });
  });

  it("file with only read events still chains", () => {
    const { index, input } = scenario();
    extendCauseIndex(index, [
      makeEvent({ id: "r1", type: "file", action: "read", pid: 100, path: "/etc/hosts", timestamp: 1000900 }),
    ]);
    const r = buildCauseChain(input, { kind: "file", path: "/etc/hosts" });
    assert.equal(r.ok, true);
  });
});

describe("cause chain: performance", () => {
  it("32. 50k-event indexing completes quickly", () => {
    const events: GhostGlassEvent[] = [];
    const t0 = 4000000;
    const n = 50000;
    for (let i = 0; i < n; i++) {
      const pid = 100 + (i % 50);
      events.push(
        makeEvent({
          id: `perf-${i}`,
          type: "file",
          action: "write",
          pid,
          path: `/work/file-${i % 500}.txt`,
          timestamp: t0 + i,
        }),
      );
    }
    // Add a small process tree on top.
    for (let p = 101; p <= 150; p++) {
      events.push(
        makeEvent({ id: `perf-spawn-${p}`, type: "process", action: "spawn", pid: p, parentPid: 100, timestamp: t0 - 1000 + p }),
      );
    }
    const start = Date.now();
    const index = buildCauseIndex(events, "perf", t0);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `indexing 50k events took ${elapsed}ms`);
    assert.equal(index.ordered.length, n + 50);
  });

  it("33. repeated lookups stay fast after one index build", () => {
    const events: GhostGlassEvent[] = [];
    const t0 = 5000000;
    for (let i = 0; i < 20000; i++) {
      events.push(
        makeEvent({
          id: `rep-${i}`,
          type: "file",
          action: "write",
          pid: 102,
          path: `/work/rep-${i % 100}.txt`,
          timestamp: t0 + i,
        }),
      );
    }
    events.push(makeEvent({ id: "rep-spawn", type: "process", action: "spawn", pid: 102, parentPid: 100, timestamp: t0 - 10 }));
    events.push(makeEvent({ id: "rep-exec", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: t0 - 20 }));
    const index = buildCauseIndex(events, "rep", t0);
    const input: ChainInput = { index, commandLine: "cmd" };
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      const r = buildCauseChain(input, { kind: "file", path: `/work/rep-${i % 100}.txt` });
      assert.equal(r.ok, true);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `100 lookups took ${elapsed}ms`);
  });
});

describe("orphan processes (Run 7 fix)", () => {
  function orphanScenario(): { index: CauseIndex; input: ChainInput } {
    const t0 = 9000000;
    const events: GhostGlassEvent[] = [
      makeEvent({ id: "o-exec-root", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: t0 }),
      // PID 200 is observed (writes a file) but its spawn was never captured:
      // no parent link, not the root.
      makeEvent({ id: "o-write", type: "file", action: "write", pid: 200, path: "/work/orphan.txt", timestamp: t0 + 50 }),
    ];
    const index = buildCauseIndex(events, "orphan-run", t0);
    return { index, input: { index, commandLine: "sh" } };
  }

  it("37. orphan ancestry is marked incomplete (not silently rooted)", () => {
    const { index } = orphanScenario();
    const r = reconstructAncestry(index, 200);
    assert.equal(r.incomplete, true);
    assert.equal(r.missingParentOf, 200);
  });

  it("38. orphan process node appears in the chain (no dangling edge)", () => {
    const { input } = orphanScenario();
    const r = buildCauseChain(input, { kind: "file", path: "/work/orphan.txt" });
    assert.equal(r.ok, true);
    const path = r.chain.paths[0]!;
    const procNode = path.nodes.find((n) => n.id === "process:200");
    assert.ok(procNode, "process:200 must be a node in the path");
    assert.match(procNode.detail ?? "", /parent not captured/);
    // Every edge endpoint must be a node in the path.
    const ids = new Set(path.nodes.map((n) => n.id));
    for (const e of path.edges) {
      assert.ok(ids.has(e.from), `edge from ${e.from} dangles`);
      assert.ok(ids.has(e.to), `edge to ${e.to} dangles`);
    }
  });

  it("39. orphan chain confidence is INCOMPLETE", () => {
    const { input } = orphanScenario();
    const r = buildCauseChain(input, { kind: "file", path: "/work/orphan.txt" });
    assert.equal(r.ok, true);
    assert.equal(r.chain.confidence, "incomplete");
    assert.match(r.chain.explanation, /not captured/);
  });

  it("40. rooted process ancestry is still complete (no false incomplete)", () => {
    const { index } = scenario();
    const r = reconstructAncestry(index, 102);
    assert.equal(r.incomplete, false);
    assert.deepEqual(r.chain.map((s) => s.pid), [100, 101, 102]);
  });

  it("41. file chain with one orphan and one rooted actor keeps paths separate", () => {
    const t0 = 9100000;
    const events: GhostGlassEvent[] = [
      makeEvent({ id: "m-exec-root", type: "process", action: "exec", pid: 100, executable: "/bin/sh", timestamp: t0 }),
      makeEvent({ id: "m-spawn", type: "process", action: "spawn", pid: 101, parentPid: 100, timestamp: t0 + 10 }),
      makeEvent({ id: "m-write-rooted", type: "file", action: "write", pid: 101, path: "/work/shared.txt", timestamp: t0 + 20 }),
      makeEvent({ id: "m-write-orphan", type: "file", action: "write", pid: 200, path: "/work/shared.txt", timestamp: t0 + 30 }),
    ];
    const index = buildCauseIndex(events, "mixed-run", t0);
    const r = buildCauseChain({ index, commandLine: "sh" }, { kind: "file", path: "/work/shared.txt" });
    assert.equal(r.ok, true);
    assert.equal(r.chain.paths.length, 2);
    // Paths are not merged: each names its own actor.
    const labels = r.chain.paths.map((p) => p.label).join(" | ");
    assert.match(labels, /101/);
    assert.match(labels, /200/);
  });
});
