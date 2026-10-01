/**
 * Tests for strace <unfinished ...> / <... resumed> split-syscall
 * reconstruction (Run 8).
 *
 * Canned strace fragment lines are fed through StraceStreamParser (the same
 * path used by batch `ghostglass run` and Live Glass streaming) and the
 * resulting normalized events are asserted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StraceStreamParser } from "../src/parser/streamParser.js";
import type { GhostGlassEvent } from "../src/events/types.js";

function parser() {
  // 2026-09-30 01:00:00 local time as the run start.
  const start = new Date(2026, 8, 30, 1, 0, 0, 0).getTime();
  return new StraceStreamParser("gg_split_001", start);
}

/** Push lines (each terminated) through a fresh parser; flush at the end. */
function runLines(lines: string[]): { events: GhostGlassEvent[]; p: StraceStreamParser } {
  const p = parser();
  const events: GhostGlassEvent[] = [];
  for (const line of lines) {
    events.push(...p.push(line + "\n"));
  }
  events.push(...p.flush());
  return { events, p };
}

/** Feed raw chunks (not line-aligned) through a fresh parser. */
function runChunks(chunks: string[]): { events: GhostGlassEvent[]; p: StraceStreamParser } {
  const p = parser();
  const events: GhostGlassEvent[] = [];
  for (const chunk of chunks) {
    events.push(...p.push(chunk));
  }
  events.push(...p.flush());
  return { events, p };
}

const spawns = (events: GhostGlassEvent[]) =>
  events.filter((e) => e.action === "spawn");

describe("basic unfinished/resumed reconstruction", () => {
  it("1. pairs a basic unfinished/resumed clone into one spawn event", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD <unfinished ...>",
      "100 01:00:01.000050 <... clone resumed>, child_tidptr=0x7f8b) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
    assert.equal(p.getReconstructionDiagnostics().reconstructed, 1);
  });

  it("2. reconstructs a split clone with full flags", () => {
    const { events } = runLines([
      "4810 01:00:01.000001 clone(child_stack=NULL, flags=CLONE_VM|CLONE_VFORK|SIGCHLD <unfinished ...>",
      "4810 01:00:01.000100 <... clone resumed>) = 4812",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 4812);
    assert.equal(s[0]?.parentPid, 4810);
  });

  it("3. reconstructs a split clone3", () => {
    const { events } = runLines([
      "100 01:00:01.000001 clone3({flags=CLONE_VM|CLONE_VFORK <unfinished ...>",
      "100 01:00:01.000100 <... clone3 resumed>}, 88) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
    assert.equal(s[0]?.metadata?.syscall, "clone3");
  });

  it("4. reconstructs a split fork", () => {
    const { events } = runLines([
      "100 01:00:01.000001 fork( <unfinished ...>",
      "100 01:00:01.000100 <... fork resumed>) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
    assert.equal(s[0]?.metadata?.syscall, "fork");
  });

  it("5. reconstructs a split vfork", () => {
    const { events } = runLines([
      "100 01:00:01.000001 vfork( <unfinished ...>",
      "100 01:00:01.000100 <... vfork resumed>) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
    assert.equal(s[0]?.metadata?.syscall, "vfork");
  });

  it("6. reconstructs a split connect", () => {
    const { events } = runLines([
      '100 01:00:01.000001 connect(5, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("93.184.216.34")} <unfinished ...>',
      "100 01:00:01.000200 <... connect resumed>) = 0",
    ]);
    const nets = events.filter((e) => e.action === "connect");
    assert.equal(nets.length, 1);
    assert.equal(nets[0]?.ip, "93.184.216.34");
    assert.equal(nets[0]?.port, 80);
    assert.equal(nets[0]?.pid, 100);
  });

  it("7. reconstructs a split openat into a file event", () => {
    const { events } = runLines([
      '100 01:00:01.000001 openat(AT_FDCWD, "/tmp/data.txt", O_RDONLY <unfinished ...>',
      "100 01:00:01.000100 <... openat resumed>) = 3",
    ]);
    const reads = events.filter((e) => e.type === "file");
    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.action, "read");
    assert.equal(reads[0]?.path, "/tmp/data.txt");
  });
});

describe("interleaved PIDs", () => {
  it("8. reconstructs two interleaved PID pairs independently", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "101 01:00:01.000002 openat(AT_FDCWD, \"/a\", O_RDONLY) = 3",
      "102 01:00:01.000003 connect(5, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"1.2.3.4\")} <unfinished ...>",
      "100 01:00:01.000050 <... clone resumed>) = 200",
      "102 01:00:01.000060 <... connect resumed>) = 0",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
    const nets = events.filter((e) => e.action === "connect");
    assert.equal(nets.length, 1);
    assert.equal(nets[0]?.pid, 102);
    assert.equal(p.getReconstructionDiagnostics().reconstructed, 2);
  });

  it("9. reconstructs many interleaved PIDs", () => {
    const lines: string[] = [];
    const N = 50;
    for (let i = 0; i < N; i++) {
      const pid = 1000 + i;
      lines.push(`${pid} 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>`);
    }
    for (let i = 0; i < N; i++) {
      const pid = 1000 + i;
      lines.push(`${pid} 01:00:01.000100 <... clone resumed>) = ${2000 + i}`);
    }
    const { events, p } = runLines(lines);
    const s = spawns(events);
    assert.equal(s.length, N);
    for (let i = 0; i < N; i++) {
      const ev = s.find((e) => e.parentPid === 1000 + i);
      assert.ok(ev, `spawn for parent ${1000 + i}`);
      assert.equal(ev?.pid, 2000 + i);
    }
    assert.equal(p.getReconstructionDiagnostics().reconstructed, N);
  });

  it("35. handles a large interleaved stream without loss", () => {
    const lines: string[] = [];
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const pid = 100 + (i % 100);
      lines.push(`${pid} 01:00:01.000001 read(3, "x" <unfinished ...>`);
      lines.push(`${pid} 01:00:01.000002 <... read resumed>, 1) = 1`);
    }
    const { events, p } = runLines(lines);
    // read() on a bare fd (no path annotation) is skipped by the file parser,
    // but every pair must still reconstruct deterministically.
    assert.equal(p.getReconstructionDiagnostics().reconstructed, N);
    assert.equal(events.length, 0);
  });
});

describe("chunk splitting", () => {
  it("10. reassembles a chunk split inside the unfinished marker", () => {
    const { events } = runChunks([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfin",
      "ished ...>\n100 01:00:01.000050 <... clone resumed>) = 200\n",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
  });

  it("11. reassembles a chunk split inside the resumed marker", () => {
    const { events } = runChunks([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n",
      "100 01:00:01.000050 <... clone res",
      "umed>) = 200\n",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
  });

  it("reassembles byte-wise chunk splits across a whole pair", () => {
    const full =
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n" +
      "100 01:00:01.000050 <... clone resumed>) = 200\n";
    // Split into 7-byte chunks.
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
    const { events } = runChunks(chunks);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, 200);
    assert.equal(s[0]?.parentPid, 100);
  });
});

describe("honesty: missing and mismatched fragments", () => {
  it("12. resume without start creates no event and records a diagnostic", () => {
    const { events, p } = runLines([
      "100 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    assert.equal(spawns(events).length, 0);
    assert.equal(events.length, 0);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.orphanResumed, 1);
    assert.equal(d.reconstructed, 0);
  });

  it("13. unfinished without resume creates no event; counted unresolved at EOF", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
    ]);
    assert.equal(events.length, 0);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.unresolved, 1);
    assert.equal(d.reconstructed, 0);
  });

  it("14. mismatched syscall name is never merged", () => {
    // Manual pushes (no flush between): the mismatched resume arrives
    // mid-stream, and the pending clone start must survive it.
    const p = parser();
    const events: GhostGlassEvent[] = [];
    events.push(...p.push("100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n"));
    events.push(...p.push("100 01:00:01.000050 <... openat resumed>) = 3\n"));
    assert.equal(events.length, 0);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.mismatched, 1);
    assert.equal(d.reconstructed, 0);
    // The pending clone start is still held; its real resume can still pair.
    const more = p.push("100 01:00:01.000060 <... clone resumed>) = 200\n");
    events.push(...p.flush());
    assert.equal(spawns(more).length, 1);
    assert.equal(p.getReconstructionDiagnostics().reconstructed, 1);
  });

  it("15. failed resumed spawn creates no child process", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:01.000050 <... clone resumed>) = -1 EAGAIN (Resource temporarily unavailable)",
    ]);
    assert.equal(spawns(events).length, 0);
    // The pair still reconstructed (it was deterministic); the parser then
    // applied its normal "failed spawn => no event" rule.
    assert.equal(p.getReconstructionDiagnostics().reconstructed, 1);
  });

  it("16. duplicate resume after pairing is an orphan, not a second event", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:01.000050 <... clone resumed>) = 200",
      "100 01:00:01.000060 <... clone resumed>) = 200",
    ]);
    assert.equal(spawns(events).length, 1);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.reconstructed, 1);
    assert.equal(d.orphanResumed, 1);
  });

  it("17. second unfinished before resume abandons the first, never merges", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:01.000002 openat(AT_FDCWD, \"/x\", O_RDONLY <unfinished ...>",
      "100 01:00:01.000050 <... openat resumed>) = 3",
    ]);
    // Only the openat pair resolves; the abandoned clone never fabricates a spawn.
    assert.equal(spawns(events).length, 0);
    const files = events.filter((e) => e.type === "file");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "/x");
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.reconstructed, 1);
    assert.equal(d.unresolved, 1); // abandoned clone start
  });

  it("28. truly missing ancestry is still honest (no fabrication)", () => {
    // A spawn line for PID 200 with no clone at all: parentPid stays absent.
    const { events } = runLines([
      "100 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    assert.equal(events.length, 0);
  });
});

describe("lifecycle and cleanup", () => {
  it("18. pending state is cleared after pairing (no reuse)", () => {
    const p = parser();
    p.push("100 01:00:01.000001 clone(child_stack=NULL <unfinished ...>\n");
    const e1 = p.push("100 01:00:01.000050 <... clone resumed>) = 200\n");
    assert.equal(spawns(e1).length, 1);
    // The pending entry was consumed; a second resume is orphaned.
    const e2 = p.push("100 01:00:01.000060 <... clone resumed>) = 201\n");
    assert.equal(spawns(e2).length, 0);
    p.flush();
    assert.equal(p.getReconstructionDiagnostics().orphanResumed, 1);
  });

  it("19. EOF clears pending state; a new parser starts clean", () => {
    const p1 = parser();
    p1.push("100 01:00:01.000001 clone(child_stack=NULL <unfinished ...>\n");
    p1.flush();
    assert.equal(p1.getReconstructionDiagnostics().unresolved, 1);
    // Fresh parser: the same resumed line is now an orphan, not a spawn.
    const { events, p: p2 } = runLines([
      "100 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    assert.equal(events.length, 0);
    assert.equal(p2.getReconstructionDiagnostics().orphanResumed, 1);
  });

  it("pending state is dropped when the process exits", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL <unfinished ...>",
      "100 01:00:01.000002 +++ exited with 0 +++",
      "100 01:00:01.000003 <... clone resumed>) = 200",
    ]);
    // The clone fragment died with the process; the late resume is orphaned.
    assert.equal(spawns(events).length, 0);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.unresolved, 1);
    assert.equal(d.orphanResumed, 1);
  });
});

describe("timestamps and metadata", () => {
  it("20. reconstructed syscall uses the start timestamp", () => {
    const { events } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:05.999999 <... clone resumed>) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    // Start was 01:00:01.000001 local; resume was 5s later. The event must
    // carry the start time, not the completion or a midpoint.
    const d = new Date(s[0]!.timestamp);
    assert.equal(d.getSeconds(), 1);
    assert.equal(d.getMilliseconds(), 0);
  });

  it("21. reconstructed events carry the reconstructed metadata flag", () => {
    const { events } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.metadata?.reconstructed, true);
    assert.equal(s[0]?.metadata?.syscall, "clone");
  });

  it("21b. reconstructed event may precede interleaved events in timestamp order", () => {
    // The reconstructed event is emitted at resume time but carries the
    // start timestamp. An event emitted while the syscall was pending can
    // therefore have a later timestamp. This is the honest consequence of
    // "use syscall-start timestamp" + "emit at resume time".
    const { events } = runLines([
      "100 01:00:01.000000 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:01.050000 openat(AT_FDCWD, \"/tmp/x\", O_RDONLY) = 3",
      "100 01:00:01.100000 <... clone resumed>) = 200",
    ]);
    const s = spawns(events);
    assert.equal(s.length, 1);
    const reads = events.filter((e) => e.action === "read");
    assert.equal(reads.length, 1);
    // The spawn's start timestamp precedes the interleaved file event even
    // though it was emitted after it.
    assert.ok(s[0]!.timestamp < reads[0]!.timestamp);
    assert.equal(s[0]?.metadata?.reconstructed, true);
  });
});

describe("spawn identity", () => {
  it("22. reconstructed spawn has the correct parent PID", () => {
    const { events } = runLines([
      "4810 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "4810 01:00:01.000050 <... clone resumed>) = 4812",
    ]);
    const s = spawns(events);
    assert.equal(s[0]?.parentPid, 4810);
  });

  it("23. reconstructed spawn has the correct child PID", () => {
    const { events } = runLines([
      "4810 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "4810 01:00:01.000050 <... clone resumed>) = 4812",
    ]);
    const s = spawns(events);
    assert.equal(s[0]?.pid, 4812);
  });

  it("27. reconstructed clone yields complete ancestry for Cause Chain", () => {
    const { events } = runLines([
      "1 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "1 01:00:01.000050 <... clone resumed>) = 100",
      "100 01:00:02.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "100 01:00:02.000050 <... clone resumed>) = 200",
    ]);
    const s = spawns(events);
    const child = s.find((e) => e.pid === 200);
    const parent = s.find((e) => e.pid === 100);
    assert.ok(child && parent);
    assert.equal(child?.parentPid, 100);
    assert.equal(parent?.parentPid, 1);
  });
});

describe("malformed fragments", () => {
  it("32. malformed unfinished fragment degrades safely", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      "garbage line without shape",
      "100 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    // The garbage line is malformed; the valid pair still reconstructs.
    assert.equal(spawns(events).length, 1);
    assert.ok(p.getStats().malformed >= 1);
  });

  it("33. malformed PID is not treated as a fragment", () => {
    const { events } = runLines([
      "abc 01:00:01.000001 clone(child_stack=NULL <unfinished ...>",
      "abc 01:00:01.000050 <... clone resumed>) = 200",
    ]);
    assert.equal(events.length, 0);
  });

  it("34. malformed resume marker is not treated as a fragment", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 clone(child_stack=NULL <unfinished ...>",
      "100 01:00:01.000050 <... clone frobnicate>) = 200",
    ]);
    // Not a valid resumed marker: the pending clone stays unresolved at EOF.
    assert.equal(events.length, 0);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.unresolved, 1);
    assert.equal(d.reconstructed, 0);
  });

  it("pending store bounds memory on hostile input", () => {
    // 100 PIDs each with an unfinished start, never resumed.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`${1000 + i} 01:00:01.000001 clone(x <unfinished ...>`);
    }
    const { p } = runLines(lines);
    assert.equal(p.getReconstructionDiagnostics().unresolved, 100);
  });
});

describe("diagnostics", () => {
  it("36. diagnostics counters reflect a mixed stream", () => {
    const { p } = runLines([
      "100 01:00:01.000001 clone(a <unfinished ...>",
      "100 01:00:01.000002 <... clone resumed>) = 200",
      "101 01:00:01.000003 clone(b <unfinished ...>",
      "102 01:00:01.000004 <... clone resumed>) = 202",
      "103 01:00:01.000005 clone(c <unfinished ...>",
      "103 01:00:01.000006 <... openat resumed>) = 3",
    ]);
    const d = p.getReconstructionDiagnostics();
    assert.equal(d.reconstructed, 1); // pid 100
    assert.equal(d.orphanResumed, 1); // pid 102
    assert.equal(d.mismatched, 1); // pid 103
    // pid 101 unfinished never resumed + pid 103 pending clone held = 2
    assert.equal(d.unresolved, 2);
  });

  it("diagnostics are exposed on getStats()", () => {
    const { p } = runLines([
      "100 01:00:01.000001 clone(a <unfinished ...>",
      "100 01:00:01.000002 <... clone resumed>) = 200",
    ]);
    const stats = p.getStats();
    assert.equal(stats.reconstruction?.reconstructed, 1);
  });
});

describe("regression: ordinary parsing unchanged", () => {
  it("37. no event loss: complete syscalls around fragments parse normally", () => {
    const { events } = runLines([
      '100 01:00:01.000001 openat(AT_FDCWD, "/a", O_RDONLY) = 3',
      "100 01:00:01.000002 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>",
      '100 01:00:01.000003 openat(AT_FDCWD, "/b", O_RDONLY) = 4',
      "100 01:00:01.000004 <... clone resumed>) = 200",
      '100 01:00:01.000005 openat(AT_FDCWD, "/c", O_RDONLY) = 5',
    ]);
    const files = events.filter((e) => e.type === "file");
    assert.equal(files.length, 3);
    assert.equal(spawns(events).length, 1);
  });

  it("39. ordinary complete-syscall parsing is unchanged", () => {
    const { events } = runLines([
      "18282 01:14:22.125000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD, child_tidptr=0x7f8b) = 18283",
      '18282 01:14:22.124001 openat(AT_FDCWD, "/home/u/package.json", O_RDONLY|O_CLOEXEC) = 3',
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.metadata?.reconstructed, undefined);
  });

  it("40. normal Run 1 parsing: exit markers and signals unaffected", () => {
    const { events } = runLines([
      "18281 01:14:22.200000 exit_group(0) = ?",
      "18281 01:14:22.200010 +++ exited with 0 +++",
    ]);
    const exits = events.filter((e) => e.action === "exit");
    assert.equal(exits.length, 2);
  });

  it("unhandled syscalls split across fragments stay skipped, not fabricated", () => {
    const { events, p } = runLines([
      "100 01:00:01.000001 ioctl(3, TCGETS <unfinished ...>",
      "100 01:00:01.000002 <... ioctl resumed>) = 0",
    ]);
    assert.equal(events.length, 0);
    assert.equal(p.getReconstructionDiagnostics().reconstructed, 1);
  });
});
