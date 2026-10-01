/**
 * Tests for the GhostGlass Trace Query Engine (Run 9).
 *
 * Deterministic structured queries shared by the CLI, viewer, Live Glass,
 * portable exports, and diff filtering. No AI, no inference, no external
 * services, no eval/SQL/regex-execution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhostGlassEvent } from "../src/events/types.js";
import { parseQuery, validateQuery, parseDurationMs } from "../src/query/parser.js";
import {
  compileQuery,
  buildQueryContext,
  matchProcess,
  matchFile,
  matchGlob,
} from "../src/query/matcher.js";
import {
  assignSequences,
  executeQuery,
  openQuerySession,
} from "../src/query/executeQuery.js";
import { buildIndexes, planCandidates } from "../src/query/indexes.js";
import {
  describeQuery,
  formatEventRow,
  formatQueryText,
  processLabel,
  QUERY_PRESETS,
} from "../src/query/format.js";
import { QueryError, type TraceQuery } from "../src/query/types.js";

const T0 = new Date(2026, 9, 1, 10, 0, 0, 0).getTime();
let n = 0;

function ev(partial: Partial<GhostGlassEvent>): GhostGlassEvent {
  n += 1;
  return {
    id: `run1-${String(n).padStart(6, "0")}`,
    runId: "run1",
    timestamp: T0,
    sequence: n,
    type: "file",
    action: "read",
    pid: 1000,
    ...partial,
  };
}

function execEvent(pid: number, executable: string, ts = T0): GhostGlassEvent {
  n += 1;
  return {
    id: `run1-${String(n).padStart(6, "0")}`,
    runId: "run1",
    timestamp: ts,
    sequence: n,
    type: "process",
    action: "exec",
    pid,
    executable,
  };
}

/** A small deterministic fixture trace. */
function fixture(): GhostGlassEvent[] {
  n = 0;
  const events: GhostGlassEvent[] = [
    execEvent(100, "/usr/bin/node", T0),
    ev({ type: "file", action: "read", pid: 100, path: "/etc/hostname", timestamp: T0 + 1000 }),
    ev({ type: "file", action: "write", pid: 100, path: "/tmp/out/package.json", timestamp: T0 + 2000 }),
    ev({ type: "file", action: "create", pid: 100, path: "/var/log/app.log", timestamp: T0 + 3000 }),
    ev({ type: "file", action: "delete", pid: 100, path: "/tmp/stale.tmp", timestamp: T0 + 4000 }),
    execEvent(200, "/usr/bin/python3", T0 + 5000),
    ev({ type: "network", action: "connect", pid: 100, ip: "127.0.0.1", port: 5432, timestamp: T0 + 6000 }),
    ev({ type: "network", action: "connect", pid: 200, ip: "93.184.216.34", port: 443, host: "example.com", timestamp: T0 + 7000 }),
    ev({ type: "process", action: "spawn", pid: 100, parentPid: 1, executable: "/usr/bin/node", timestamp: T0 + 8000 }),
    ev({ type: "process", action: "exit", pid: 200, timestamp: T0 + 9000 }),
  ];
  // A reconstructed event: syscall-start timestamp earlier than emission.
  const recon = ev({
    type: "file",
    action: "write",
    pid: 100,
    path: "/tmp/out/recon.dat",
    timestamp: T0 + 2500,
    metadata: { reconstructed: true },
  });
  recon.sequence = n + 1;
  n += 1;
  events.push(recon);
  return events;
}

const q = (text: string): TraceQuery => parseQuery(text).query;
const exec = (events: GhostGlassEvent[], query: TraceQuery) =>
  executeQuery("run1", events, query, { defaultLimit: 0 });

describe("query parser: compact key:value syntax", () => {
  it("parses a single clause", () => {
    assert.deepEqual(q("process:node"), { process: "node" });
  });
  it("parses multiple clauses (AND)", () => {
    assert.deepEqual(q("process:node action:write"), { process: "node", actions: ["write"] });
  });
  it("repeated action clauses use OR", () => {
    assert.deepEqual(q("action:write action:create"), { actions: ["write", "create"] });
  });
  it("repeated type clauses use OR", () => {
    assert.deepEqual(q("type:file type:network"), { types: ["file", "network"] });
  });
  it("bare network token enables the network flag", () => {
    assert.deepEqual(q("network"), { network: true });
  });
  it("bare reconstructed token sets the flag", () => {
    assert.deepEqual(q("reconstructed"), { reconstructed: true });
  });
  it("quoted values keep spaces", () => {
    assert.deepEqual(q('path:"/tmp/my dir/f.txt"'), { path: "/tmp/my dir/f.txt" });
  });
  it("single-quoted values keep spaces", () => {
    assert.deepEqual(q("text:'hello world'"), { text: "hello world" });
  });
  it("escaped quotes inside quoted values", () => {
    assert.deepEqual(q('path:"a\\"b"'), { path: 'a"b' });
  });
  it("unescapes backslash escapes inside quotes; backslash is literal outside quotes", () => {
    assert.deepEqual(q('path:"a\\\\b"'), { path: "a\\b" });
    assert.deepEqual(q("path:a\\\\b"), { path: "a\\\\b" });
  });
  it("parses pid and port as integers", () => {
    assert.deepEqual(q("pid:123 port:8080"), { pid: 123, port: 8080 });
  });
  it("parses limit and order", () => {
    assert.deepEqual(q("limit:5 order:sequence"), { limit: 5, order: "sequence" });
  });
  it("parses absolute times into query.since/until", () => {
    const parsed = q("since:2026-10-01T10:00:02Z until:2026-10-01T10:00:05Z");
    assert.equal(parsed.since, Date.parse("2026-10-01T10:00:02Z"));
    assert.equal(parsed.until, Date.parse("2026-10-01T10:00:05Z"));
  });
  it("bare durations default to seconds and stay trace-relative", () => {
    const parsed = parseQuery("since:30");
    assert.equal(parsed.relativeTimes.since, 30_000);
    assert.equal(parsed.query.since, undefined);
  });
  it("parses relative durations into ParsedQuery.relativeTimes", () => {
    const parsed = parseQuery("since:+30s until:+2m");
    assert.equal(parsed.relativeTimes.since, 30_000);
    assert.equal(parsed.relativeTimes.until, 120_000);
    assert.equal(parsed.query.since, undefined);
    assert.equal(parsed.query.until, undefined);
  });
  it("parseDurationMs supports ms, s, m, min", () => {
    assert.equal(parseDurationMs("500ms"), 500);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("2m"), 120_000);
    assert.equal(parseDurationMs("3min"), 180_000);
  });
  it("highlight clause parses as a rule name", () => {
    assert.deepEqual(q("highlight:write-burst"), { highlight: "write-burst" });
  });
  it("rejects unknown fields", () => {
    assert.throws(() => q("frobnicate:x"), (e) => e instanceof QueryError && /unknown query field/i.test(e.message));
  });
  it("rejects unknown actions", () => {
    assert.throws(() => q("action:frobnicate"), (e) => e instanceof QueryError && /unknown action/i.test(e.message));
  });
  it("rejects unknown types", () => {
    assert.throws(() => q("type:banana"), (e) => e instanceof QueryError && /unknown type/i.test(e.message));
  });
  it("rejects malformed pids", () => {
    assert.throws(() => q("pid:abc"), QueryError);
    assert.throws(() => q("pid:-5"), QueryError);
    assert.throws(() => q("pid:1.5"), QueryError);
  });
  it("rejects malformed ports", () => {
    assert.throws(() => q("port:abc"), QueryError);
    assert.throws(() => q("port:99999"), QueryError);
  });
  it("rejects malformed times", () => {
    assert.throws(() => q("since:not-a-time"), QueryError);
    assert.throws(() => q("until:+10x"), QueryError);
  });
  it("rejects empty values", () => {
    assert.throws(() => q("process:"), QueryError);
    assert.throws(() => q("action"), (e) => e instanceof QueryError);
  });
  it("rejects bad limit and order", () => {
    assert.throws(() => q("limit:-1"), QueryError);
    assert.throws(() => q("order:sideways"), QueryError);
  });
  it("rejects unbalanced quotes", () => {
    assert.throws(() => q('path:"/tmp/x'), QueryError);
  });
  it("rejects a dangling escape inside quotes", () => {
    assert.throws(() => q('path:"abc\\'), QueryError);
  });
  it("treats a mid-word apostrophe as literal", () => {
    assert.deepEqual(q("text:don't"), { text: "don't" });
  });
  it("hostile strings do not throw anything but QueryError", () => {
    const hostile = [
      'path:"${HOME}"', "text:$(whoami)", "path:`id`", "process:../../etc/passwd",
      "action:write;DROP TABLE", "pid:0x10", "since:99999999999999999999",
      "text:\u0000", "process:\u202e",
    ];
    for (const h of hostile) {
      assert.doesNotThrow(() => {
        try {
          q(h);
        } catch (e) {
          assert.ok(e instanceof QueryError, `expected QueryError for ${h}`);
        }
      }, `hostile input ${JSON.stringify(h)}`);
    }
  });
});

describe("query matcher", () => {
  it("matches process by exact path, basename, or suffix", () => {
    assert.ok(matchProcess("/usr/bin/node", "/usr/bin/node"));
    assert.ok(matchProcess("node", "/usr/bin/node"));
    assert.ok(matchProcess("bin/node", "/usr/bin/node"));
    assert.ok(!matchProcess("python", "/usr/bin/node"));
  });
  it("matchGlob supports * and ?", () => {
    assert.ok(matchGlob("*package*", "/tmp/out/package.json"));
    assert.ok(matchGlob("/tmp/*.log", "/tmp/a.log"));
    assert.ok(matchGlob("?.log", "a.log"));
    assert.ok(matchGlob("/tmp/*.log", "/tmp/a/b.log"), "* crosses / by design");
    assert.ok(!matchGlob("/tmp/*.log", "/tmp/a.log/b.txt"), "tail must still match");
    assert.ok(!matchGlob("/tmp/*.log", "/var/a.log"));
    assert.ok(!matchGlob("abc", "abcd"));
  });
  it("matchFile matches exact path, basename, or suffix (no globs)", () => {
    assert.ok(matchFile("/etc/hostname", "/etc/hostname"));
    assert.ok(matchFile("hostname", "/etc/hostname"));
    assert.ok(matchFile("etc/hostname", "/etc/hostname"));
    assert.ok(!matchFile("other/hostname", "/etc/hostname"));
    assert.ok(!matchFile("/tmp/*", "/tmp/out/package.json"));
  });
  it("process matching falls back to the pid→executable context", () => {
    const events = fixture();
    const ctx = buildQueryContext(events);
    const pred = compileQuery({ process: "node" }, ctx);
    const writeEv = events.find((e) => e.action === "write" && e.path === "/tmp/out/package.json")!;
    assert.ok(pred(writeEv), "file event on pid 100 should inherit /usr/bin/node");
    const pyNet = events.find((e) => e.pid === 200 && e.type === "network")!;
    assert.ok(!pred(pyNet));
  });
  it("a PID that re-execs keeps the right identity per event", () => {
    n = 0;
    const events = [
      execEvent(7, "/usr/bin/node", T0),
      ev({ type: "file", action: "write", pid: 7, path: "/tmp/a.txt", timestamp: T0 + 1000 }),
      execEvent(7, "/usr/bin/python3", T0 + 2000),
      ev({ type: "file", action: "write", pid: 7, path: "/tmp/b.txt", timestamp: T0 + 3000 }),
    ];
    for (let i = 0; i < events.length; i++) events[i]!.sequence = i + 1;
    const ctx = buildQueryContext(events);
    // Identity at sequence 2 is node; at sequence 4 it is python3.
    assert.equal(ctx.executableForPid(7, 2), "/usr/bin/node");
    assert.equal(ctx.executableForPid(7, 4), "/usr/bin/python3");
    assert.equal(ctx.executableForPid(7), "/usr/bin/python3");
    const nodePred = compileQuery({ process: "node" }, ctx);
    const pyPred = compileQuery({ process: "python3" }, ctx);
    assert.ok(nodePred(events[1]!), "pre-exec event matches node");
    assert.ok(!nodePred(events[3]!), "post-exec event does not match node");
    assert.ok(pyPred(events[3]!), "post-exec event matches python3");
    assert.ok(!pyPred(events[1]!), "pre-exec event does not match python3");
    // The byProcess index agrees with the temporal predicate.
    const session = openQuerySession(events);
    const r = executeQuery("run1", events, { process: "node" }, {
      indexes: session.indexes,
      context: session.context,
      defaultLimit: 0,
    });
    assert.deepEqual(r.events.map((e) => e.path ?? e.executable), ["/usr/bin/node", "/tmp/a.txt"]);
  });
});

describe("query execution: selectors", () => {
  it("filters by process", () => {
    const r = exec(fixture(), { process: "node" });
    assert.ok(r.totalMatches > 0);
    assert.ok(r.events.every((e) => e.pid === 100));
  });
  it("filters by pid", () => {
    const r = exec(fixture(), { pid: 200 });
    assert.ok(r.events.length > 0);
    assert.ok(r.events.every((e) => e.pid === 200));
  });
  it("filters by single action", () => {
    const r = exec(fixture(), { actions: ["write"] });
    assert.equal(r.totalMatches, 2);
  });
  it("ORs repeated actions", () => {
    const r = exec(fixture(), { actions: ["write", "create"] });
    assert.equal(r.totalMatches, 3);
  });
  it("ORs repeated types", () => {
    const r = exec(fixture(), { types: ["process"] });
    assert.equal(r.totalMatches, 4); // exec node, exec python3, spawn, exit
  });
  it("ANDs different fields", () => {
    const r = exec(fixture(), { process: "node", actions: ["write"] });
    assert.equal(r.totalMatches, 2);
    assert.ok(r.events.every((e) => e.pid === 100 && e.action === "write"));
  });
  it("filters by file glob", () => {
    const r = exec(fixture(), { path: "/tmp/*" });
    assert.equal(r.totalMatches, 3);
  });
  it("filters by path suffix", () => {
    const r = exec(fixture(), { file: "app.log" });
    assert.equal(r.totalMatches, 1);
  });
  it("filters network events by ip", () => {
    const r = exec(fixture(), { ip: "127.0.0.1" });
    assert.equal(r.totalMatches, 1);
  });
  it("filters network events by port", () => {
    const r = exec(fixture(), { port: 443 });
    assert.equal(r.totalMatches, 1);
    assert.equal(r.events[0]?.ip, "93.184.216.34");
  });
  it("network flag selects only network events", () => {
    const r = exec(fixture(), { network: true });
    assert.equal(r.totalMatches, 2);
    assert.ok(r.events.every((e) => e.type === "network"));
  });
  it("host matches", () => {
    const r = exec(fixture(), { host: "example.com" });
    assert.equal(r.totalMatches, 1);
  });
  it("text search is case-insensitive across executable and path", () => {
    const r = exec(fixture(), { text: "PACKAGE" });
    assert.equal(r.totalMatches, 1);
    const r2 = exec(fixture(), { text: "Node" });
    assert.ok(r2.events.some((e) => e.executable === "/usr/bin/node"));
  });
  it("reconstructed selects only reconstructed events", () => {
    const r = exec(fixture(), { reconstructed: true });
    assert.equal(r.totalMatches, 1);
    assert.equal(r.events[0]?.path, "/tmp/out/recon.dat");
  });
  it("not-reconstructed excludes reconstructed events", () => {
    const r = exec(fixture(), { actions: ["write"], reconstructed: false });
    assert.equal(r.totalMatches, 1);
    assert.equal(r.events[0]?.path, "/tmp/out/package.json");
  });
  it("absolute time bounds are inclusive", () => {
    const r = exec(fixture(), { since: T0 + 2000, until: T0 + 2000 });
    assert.equal(r.totalMatches, 1);
    assert.equal(r.events[0]?.action, "write");
  });
  it("absolute time range filters", () => {
    const r = exec(fixture(), { since: T0 + 5000, until: T0 + 7000 });
    assert.equal(r.totalMatches, 3);
  });
});

describe("query execution: ordering", () => {
  it("default order is timestamp then sequence", () => {
    const events = fixture();
    const r = executeQuery("run1", events, {}, { defaultLimit: 0 });
    for (let i = 1; i < r.events.length; i++) {
      const a = r.events[i - 1]!;
      const b = r.events[i]!;
      assert.ok(
        a.timestamp < b.timestamp || (a.timestamp === b.timestamp && (a.sequence ?? 0) <= (b.sequence ?? 0)),
        "default order must be (timestamp, sequence)",
      );
    }
    // The reconstructed event carries T0+2500 but was emitted last:
    // default time order places it among the T0+2500 events, not at the end.
    const idx = r.events.findIndex((e) => e.path === "/tmp/out/recon.dat");
    const before = r.events[idx - 1];
    assert.ok(before && before.timestamp <= T0 + 2500);
  });
  it("sequence order is ingestion order", () => {
    const events = fixture();
    const r = executeQuery("run1", events, { order: "sequence" }, { defaultLimit: 0 });
    for (let i = 1; i < r.events.length; i++) {
      assert.ok((r.events[i - 1]!.sequence ?? 0) <= (r.events[i]!.sequence ?? 0));
    }
    // Reconstructed event sorts last: it was emitted last.
    assert.equal(r.events[r.events.length - 1]?.path, "/tmp/out/recon.dat");
  });
  it("timestamp ties break by sequence", () => {
    n = 0;
    const a = ev({ timestamp: T0, sequence: 5 });
    const b = ev({ timestamp: T0, sequence: 2 });
    const r = executeQuery("run1", [a, b], {}, { defaultLimit: 0 });
    assert.equal(r.events[0]?.sequence, 2);
    assert.equal(r.events[1]?.sequence, 5);
  });
});

describe("query execution: limits", () => {
  it("reports total matches even when limited", () => {
    const events = fixture();
    const r = executeQuery("run1", events, { limit: 2 }, { defaultLimit: 0 });
    assert.equal(r.returned, 2);
    assert.ok(r.totalMatches > 2);
    assert.ok(r.truncated);
  });
  it("limit 0 means unlimited", () => {
    const events = fixture();
    const r = executeQuery("run1", events, { limit: 0 }, { defaultLimit: 0 });
    assert.equal(r.returned, r.totalMatches);
    assert.ok(!r.truncated);
  });
  it("defaultLimit applies when the query has no limit", () => {
    const events = fixture();
    const r = executeQuery("run1", events, {}, { defaultLimit: 3 });
    assert.equal(r.returned, 3);
    assert.ok(r.truncated);
  });
});

describe("assignSequences: old-run fallback", () => {
  it("derives sequences from array order for events lacking them", () => {
    n = 0;
    const events = [ev({}), ev({}), ev({})];
    for (const e of events) delete e.sequence;
    assignSequences(events);
    assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3]);
  });
  it("never overwrites existing sequences", () => {
    n = 0;
    const events = [ev({ sequence: 42 }), ev({})];
    delete events[1]!.sequence;
    assignSequences(events);
    assert.equal(events[0]!.sequence, 42);
    assert.equal(events[1]!.sequence, 2);
  });
  it("does not mutate other fields", () => {
    n = 0;
    const events = [ev({ action: "write" })];
    delete events[0]!.sequence;
    const before = JSON.stringify({ ...events[0], sequence: undefined });
    assignSequences(events);
    assert.equal(JSON.stringify({ ...events[0], sequence: undefined }), before);
  });
});

describe("indexes and planner", () => {
  it("planCandidates selects a small indexed set for pid queries", () => {
    const events = fixture();
    const idx = buildIndexes(events, buildQueryContext(events));
    const c = planCandidates({ pid: 200 }, idx);
    assert.ok(c);
    assert.equal(c.length, 3); // exec python3, network connect, exit
  });
  it("OR unions never duplicate positions", () => {
    const events = fixture();
    const idx = buildIndexes(events, buildQueryContext(events));
    const c = planCandidates({ actions: ["write", "create", "delete"] }, idx);
    assert.ok(c);
    assert.equal(new Set(c).size, c.length);
    assert.equal(c.length, 4); // 2 writes (incl. reconstructed) + create + delete
  });
  it("falls back to full scan when no index applies", () => {
    const events = fixture();
    const idx = buildIndexes(events, buildQueryContext(events));
    assert.equal(planCandidates({ text: "zzz" }, idx), null);
  });
  it("indexed and full-scan results agree", () => {
    const events = fixture();
    const session = openQuerySession(events);
    for (const text of ["process:node", "action:write action:create", "type:file", "pid:200", "port:443", "text:tmp"]) {
      const query = q(text);
      const withIdx = executeQuery("run1", events, query, {
        indexes: session.indexes,
        context: session.context,
        defaultLimit: 0,
      });
      const noIdx = executeQuery("run1", events, query, { defaultLimit: 0 });
      assert.deepEqual(
        withIdx.events.map((e) => e.id),
        noIdx.events.map((e) => e.id),
        `indexed vs full-scan mismatch for "${text}"`,
      );
    }
  });
});

describe("query format", () => {
  it("describeQuery renders a human summary", () => {
    const d = describeQuery({ process: "node", actions: ["write", "create"] });
    assert.ok(/node/.test(d));
    assert.ok(/write/.test(d));
  });
  it("formatEventRow marks reconstructed events", () => {
    const events = fixture();
    const recon = events.find((e) => e.path === "/tmp/out/recon.dat")!;
    assert.ok(formatEventRow(recon, T0).includes("⟲"));
  });
  it("formatQueryText reports total and truncation", () => {
    const events = fixture();
    const r = executeQuery("run1", events, { limit: 2 }, { defaultLimit: 0 });
    const textOut = formatQueryText(r, T0);
    assert.ok(textOut.includes(String(r.totalMatches)));
    assert.ok(/showing first 2/i.test(textOut));
  });
  it("presets parse and match", () => {
    assert.ok(QUERY_PRESETS.length > 0);
    const events = fixture();
    for (const p of QUERY_PRESETS) {
      const parsed = parseQuery(p.query);
      const r = executeQuery("run1", events, parsed.query, { defaultLimit: 0 });
      assert.ok(r.totalMatches >= 0, `preset ${p.name}`);
    }
    const names = QUERY_PRESETS.map((p) => p.name.toLowerCase());
    assert.ok(names.some((x) => x.includes("write")));
    assert.ok(names.some((x) => x.includes("network")));
  });
  it("processLabel falls back to pid when no executable is known", () => {
    n = 0;
    assert.equal(processLabel(ev({ pid: 42 })), "pid:42");
    assert.equal(processLabel(ev({ executable: "/usr/bin/node" })), "node");
  });
});

describe("incremental matching (Live Glass model)", () => {
  it("a compiled predicate matches only new events", () => {
    const events = fixture();
    const ctx = buildQueryContext(events);
    const pred = compileQuery({ actions: ["write"] }, ctx);
    const matched: string[] = [];
    for (const e of events) if (pred(e)) matched.push(e.id);
    assert.equal(matched.length, 2);
    // A late-arriving write matches without re-scanning the batch.
    n += 1;
    const late = ev({ type: "file", action: "write", pid: 100, path: "/tmp/late.txt", timestamp: T0 + 99999 });
    assert.ok(pred(late));
    assert.equal(matched.length, 2, "earlier matches are untouched");
  });
  it("validateQuery rejects unknown fields on structured queries", () => {
    assert.throws(() => validateQuery({ bogus: 1 } as unknown as TraceQuery), QueryError);
    assert.throws(() => validateQuery({ since: 10, until: 5 }), QueryError);
  });
});

describe("query performance", () => {
  it("handles 100k events: index build + common queries are fast", { timeout: 60_000 }, () => {
    if (process.env.GG_SKIP_PERF === "1") return;
    n = 0;
    const N = 100_000;
    const events: GhostGlassEvent[] = new Array(N);
    const actions = ["read", "write", "create", "delete", "connect"] as const;
    for (let i = 0; i < N; i++) {
      const pid = 100 + (i % 50);
      const isNet = i % 7 === 0;
      const partial: Partial<GhostGlassEvent> = {
        type: isNet ? "network" : "file",
        action: actions[i % actions.length]!,
        pid,
        path: `/tmp/dir${i % 100}/file${i}.dat`,
        timestamp: T0 + i,
      };
      if (isNet) {
        partial.ip = "10.0.0.1";
        partial.port = 8080;
      }
      events[i] = ev(partial);
    }
    const t0 = Date.now();
    const session = openQuerySession(events);
    const indexMs = Date.now() - t0;
    assert.ok(indexMs < 5000, `index build took ${indexMs}ms`);

    const bench = (query: TraceQuery, budgetMs: number, label: string) => {
      const start = Date.now();
      const r = executeQuery("run1", events, query, {
        indexes: session.indexes,
        context: session.context,
        defaultLimit: 0,
      });
      const ms = Date.now() - start;
      assert.ok(ms < budgetMs, `${label} took ${ms}ms for ${r.totalMatches} matches`);
      return r;
    };

    bench({ pid: 101 }, 500, "pid query");
    bench({ actions: ["write"] }, 500, "action query");
    bench({ types: ["network"] }, 500, "type query");
    bench({ actions: ["write", "read"], pid: 102 }, 1000, "compound query");
    bench({ file: "/tmp/dir5/*" }, 1000, "glob query");

    // Incremental matching overhead per event stays tiny.
    const pred = compileQuery({ actions: ["write"] }, session.context);
    const t1 = process.hrtime.bigint();
    let hits = 0;
    for (const e of events) if (pred(e)) hits++;
    const perEventNs = Number(process.hrtime.bigint() - t1) / N;
    assert.ok(perEventNs < 5000, `predicate costs ${perEventNs.toFixed(0)}ns/event`);
    assert.equal(hits, 20_000);
  });
});

describe("query planner: large unions", () => {
  it("large OR unions do not blow the call stack", () => {
    // 300k events forces planCandidates' OR-merge past the spread-arg limit.
    const big: GhostGlassEvent[] = [];
    for (let i = 0; i < 300_000; i++) {
      big.push(
        ev({
          type: i % 2 === 0 ? "file" : "network",
          action: "read",
          pid: 1,
          path: "/tmp/x",
          timestamp: T0 + i,
        }),
      );
    }
    assignSequences(big);
    const session = openQuerySession(big);
    const r = executeQuery("run1", big, { types: ["file", "network"] }, {
      indexes: session.indexes,
      context: session.context,
      defaultLimit: 10,
    });
    assert.equal(r.totalMatches, 300_000);
    assert.equal(r.returned, 10);
  });
});
