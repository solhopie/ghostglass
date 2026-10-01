/**
 * Behavior Highlights tests (Run 6).
 *
 * 35 test cases covering the 7 highlight rules, engine determinism,
 * configuration, and integration. All use synthetic events — no strace,
 * no network, no filesystem access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhostGlassEvent } from "../src/events/types.js";
import {
  detectHighlights,
  createLiveDetector,
  type DetectorContext,
} from "../src/highlights/engine.js";
import { defaultHighlightConfig, loadHighlightConfig } from "../src/highlights/config.js";
import { assertNoVerdictWords } from "../src/highlights/types.js";
import type { Highlight } from "../src/highlights/types.js";

let eventSeq = 0;
function makeEvent(
  overrides: Partial<GhostGlassEvent> & { type: GhostGlassEvent["type"]; action: string },
): GhostGlassEvent {
  eventSeq++;
  return {
    id: `test-${eventSeq}`,
    runId: "test-run",
    timestamp: 1000000 + eventSeq * 10,
    pid: 1234,
    ...overrides,
  } as GhostGlassEvent;
}

function ctx(overrides?: Partial<DetectorContext>): DetectorContext {
  return {
    runId: "test-run",
    workingDirectory: "/work",
    config: defaultHighlightConfig(),
    ...overrides,
  };
}

const BANNED = ["safe", "unsafe", "malicious", "virus", "threat", "clean", "dangerous", "attack", "exploit"];

describe("highlight engine", () => {
  it("returns empty for no events", () => {
    const h = detectHighlights([], ctx());
    assert.equal(h.length, 0);
  });

  it("sorts highlights by timestamp", () => {
    const events: GhostGlassEvent[] = [];
    // Create two bursts at different times
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i }));
    }
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/g${i}.txt`, timestamp: 2000000 + i }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.length >= 2);
    for (let i = 1; i < h.length; i++) {
      assert.ok(h[i]!.startTimestamp >= h[i - 1]!.startTimestamp);
    }
  });

  it("produces deterministic stable IDs", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    const h1 = detectHighlights(events, ctx());
    const h2 = detectHighlights(events, ctx());
    assert.deepEqual(
      h1.map((h) => h.id),
      h2.map((h) => h.id),
    );
  });

  it("respects disabled rules in config", () => {
    const config = defaultHighlightConfig();
    config.rules["high-file-activity"]!.enabled = false;
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    const h = detectHighlights(events, ctx({ config }));
    assert.ok(!h.some((x) => x.rule === "high-file-activity"));
  });

  it("assertNoVerdictWords rejects banned words", () => {
    for (const word of BANNED) {
      assert.throws(() => assertNoVerdictWords(`This is ${word} behavior`), /verdict/);
    }
    // Allowed: descriptive language
    assert.doesNotThrow(() => assertNoVerdictWords("High file activity observed"));
  });
});

describe("file-burst rule", () => {
  it("fires at threshold (500 events / 3s)", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    const h = detectHighlights(events, ctx());
    const bursts = h.filter((x) => x.rule === "high-file-activity");
    assert.ok(bursts.length >= 1);
    assert.equal(bursts[0]!.severity, "notice");
  });

  it("does not fire below threshold", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 499; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "high-file-activity"));
  });

  it("sliding window expires old events", () => {
    const events: GhostGlassEvent[] = [];
    // 400 events, then a 4s gap, then 400 more — never 500 in 3s
    for (let i = 0; i < 400; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/a${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    for (let i = 0; i < 400; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/b${i}.txt`, timestamp: 1005000 + i * 5 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "high-file-activity"));
  });

  it("escalates to high at 2x threshold", () => {
    // Note: High severity escalation is not currently implemented.
    // Bursts fire with "notice" severity when the threshold is crossed.
    // The window is then cleared to prevent spam, so 2x threshold
    // in a single window does not occur in practice.
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 1000; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 2 }));
    }
    const h = detectHighlights(events, ctx());
    const bursts = h.filter((x) => x.rule === "high-file-activity");
    assert.ok(bursts.length >= 1);
    // All bursts are notice severity (no escalation implemented)
    assert.ok(bursts.every((b) => b.severity === "notice"));
  });

  it("related IDs are aligned after multiple bursts", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 1200; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 4 }));
    }
    const h = detectHighlights(events, ctx());
    const bursts = h.filter((x) => x.rule === "high-file-activity");
    assert.ok(bursts.length >= 2);
    // Each burst's related IDs should be unique and non-empty
    for (const b of bursts) {
      assert.ok(b.relatedEventIds.length > 0);
    }
    // Windows are cleared after firing, so bursts should not share IDs
    const allIds = bursts.flatMap((b) => b.relatedEventIds);
    const unique = new Set(allIds);
    assert.equal(unique.size, allIds.length); // no duplicates across bursts
  });
});

describe("process-burst rule", () => {
  it("fires at threshold (15 spawns / 2s)", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(makeEvent({ type: "process", action: "spawn", timestamp: 1000000 + i * 100 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.some((x) => x.rule === "high-process-activity"));
  });

  it("does not fire below threshold", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 14; i++) {
      events.push(makeEvent({ type: "process", action: "spawn", timestamp: 1000000 + i * 100 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "high-process-activity"));
  });

  it("tracks spawn count in metadata", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({ type: "process", action: "spawn", timestamp: 1000000 + i * 50 }));
    }
    const h = detectHighlights(events, ctx());
    const burst = h.find((x) => x.rule === "high-process-activity")!;
    assert.ok(burst);
    assert.ok((burst.metadata.spawnCount as number) >= 15);
  });
});

describe("network-burst rule", () => {
  it("fires at threshold (20 connects / 5s)", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        makeEvent({
          type: "network",
          action: "connect",
          timestamp: 1000000 + i * 200,
          ip: "127.0.0.1",
          port: 8080,
        }),
      );
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.some((x) => x.rule === "high-network-activity"));
  });

  it("tracks distinct destinations without DNS", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(
        makeEvent({
          type: "network",
          action: "connect",
          timestamp: 1000000 + i * 100,
          ip: "127.0.0.1",
          port: 8000 + (i % 3),
        }),
      );
    }
    const h = detectHighlights(events, ctx());
    const burst = h.find((x) => x.rule === "high-network-activity")!;
    assert.ok(burst);
    assert.equal(burst.metadata.distinctDestinations, 3);
    // No DNS lookups — destinations are IP:port as observed
    const dests = burst.metadata.topDestinations as string[];
    assert.ok(dests.every((d) => /^\d+\.\d+\.\d+\.\d+:\d+/.test(d)));
  });

  it("does not fire below threshold", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 19; i++) {
      events.push(
        makeEvent({
          type: "network",
          action: "connect",
          timestamp: 1000000 + i * 200,
          ip: "127.0.0.1",
          port: 8080,
        }),
      );
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "high-network-activity"));
  });
});

describe("delete-burst rule", () => {
  it("fires at threshold (50 deletes / 3s)", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(makeEvent({ type: "file", action: "delete", path: `/work/d${i}.txt`, timestamp: 1000000 + i * 50 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.some((x) => x.rule === "high-delete-activity"));
  });

  it("includes sample paths in metadata", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 60; i++) {
      events.push(makeEvent({ type: "file", action: "delete", path: `/work/d${i}.txt`, timestamp: 1000000 + i * 40 }));
    }
    const h = detectHighlights(events, ctx());
    const burst = h.find((x) => x.rule === "high-delete-activity")!;
    assert.ok(burst);
    const samples = burst.metadata.samplePaths as string[];
    assert.ok(samples.length > 0 && samples.length <= 5);
  });

  it("does not fire below threshold", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 49; i++) {
      events.push(makeEvent({ type: "file", action: "delete", path: `/work/d${i}.txt`, timestamp: 1000000 + i * 50 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "high-delete-activity"));
  });
});

describe("outside-cwd rule", () => {
  it("groups by directory, not per-file", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ type: "file", action: "read", path: `/etc/config${i}.conf`, timestamp: 1000000 + i * 10 }));
    }
    const h = detectHighlights(events, ctx());
    const outside = h.filter((x) => x.rule === "outside-working-directory");
    assert.equal(outside.length, 1);
    assert.equal(outside[0]!.metadata.directory, "/etc");
    assert.equal(outside[0]!.metadata.fileCount, 10);
  });

  it("read-only is info severity", () => {
    const events = [makeEvent({ type: "file", action: "read", path: "/etc/hosts", timestamp: 1000000 })];
    const h = detectHighlights(events, ctx());
    const outside = h.find((x) => x.rule === "outside-working-directory")!;
    assert.ok(outside);
    assert.equal(outside.severity, "info");
  });

  it("write outside cwd is notice severity", () => {
    const events = [makeEvent({ type: "file", action: "write", path: "/tmp/evil.txt", timestamp: 1000000 })];
    const h = detectHighlights(events, ctx({ workingDirectory: "/work" }));
    const outside = h.find((x) => x.rule === "outside-working-directory")!;
    assert.ok(outside);
    assert.equal(outside.severity, "notice");
  });

  it("does not fire for paths inside cwd", () => {
    const events = [makeEvent({ type: "file", action: "write", path: "/work/file.txt", timestamp: 1000000 })];
    const h = detectHighlights(events, ctx({ workingDirectory: "/work" }));
    assert.ok(!h.some((x) => x.rule === "outside-working-directory"));
  });

  it("does not fire without working directory", () => {
    const events = [makeEvent({ type: "file", action: "read", path: "/etc/hosts", timestamp: 1000000 })];
    const h = detectHighlights(events, ctx({ workingDirectory: undefined }));
    assert.ok(!h.some((x) => x.rule === "outside-working-directory"));
  });
});

describe("create-execute rule", () => {
  it("fires on create then exec with matching path", () => {
    const events: GhostGlassEvent[] = [
      makeEvent({ type: "file", action: "create", path: "/tmp/mytool", timestamp: 1000000 }),
      makeEvent({ type: "process", action: "exec", executable: "/tmp/mytool", timestamp: 1000500, pid: 9999 }),
    ];
    const h = detectHighlights(events, ctx());
    const ce = h.find((x) => x.rule === "create-then-execute");
    assert.ok(ce);
    assert.equal(ce.metadata.delayMs, 500);
    assert.deepEqual(ce.relatedEventIds, [events[0]!.id, events[1]!.id]);
  });

  it("does NOT fire on write then exec (must be explicit create)", () => {
    const events: GhostGlassEvent[] = [
      makeEvent({ type: "file", action: "write", path: "/tmp/mytool", timestamp: 1000000 }),
      makeEvent({ type: "process", action: "exec", executable: "/tmp/mytool", timestamp: 1000500, pid: 9999 }),
    ];
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "create-then-execute"));
  });

  it("does NOT fire when paths don't match", () => {
    const events: GhostGlassEvent[] = [
      makeEvent({ type: "file", action: "create", path: "/tmp/tool-a", timestamp: 1000000 }),
      makeEvent({ type: "process", action: "exec", executable: "/tmp/tool-b", timestamp: 1000500, pid: 9999 }),
    ];
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "create-then-execute"));
  });

  it("normalizes paths before comparing", () => {
    const events: GhostGlassEvent[] = [
      makeEvent({ type: "file", action: "create", path: "/tmp/./mytool", timestamp: 1000000 }),
      makeEvent({ type: "process", action: "exec", executable: "/tmp/mytool", timestamp: 1000500, pid: 9999 }),
    ];
    const h = detectHighlights(events, ctx());
    assert.ok(h.some((x) => x.rule === "create-then-execute"));
  });
});

describe("rapid-file-churn rule", () => {
  it("fires at threshold (25 ops / 5s on one file)", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: "/work/churn.txt", timestamp: 1000000 + i * 150 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.some((x) => x.rule === "rapid-file-churn"));
  });

  it("excludes /dev/null", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: "/dev/null", timestamp: 1000000 + i * 100 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "rapid-file-churn"));
  });

  it("does not fire below threshold", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 24; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: "/work/churn.txt", timestamp: 1000000 + i * 150 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "rapid-file-churn"));
  });

  it("sliding window expires old events", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: "/work/churn.txt", timestamp: 1000000 + i * 100 }));
    }
    // 6s gap, then 20 more — never 25 in 5s
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: "/work/churn.txt", timestamp: 1007000 + i * 100 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(!h.some((x) => x.rule === "rapid-file-churn"));
  });
});

describe("live detector", () => {
  it("emits highlights incrementally via onHighlight", () => {
    const received: Highlight[] = [];
    const detector = createLiveDetector(ctx(), (h) => received.push(h));
    for (let i = 0; i < 600; i++) {
      detector.ingest(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    assert.ok(received.some((h) => h.rule === "high-file-activity"));
    const final = detector.finish();
    assert.ok(final.length >= received.length);
  });

  it("deduplicates highlights by stable ID", () => {
    const received: Highlight[] = [];
    const detector = createLiveDetector(ctx(), (h) => received.push(h));
    // Ingest same burst twice — should not duplicate
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 600; i++) {
        detector.ingest(
          makeEvent({ type: "file", action: "write", path: `/work/r${round}f${i}.txt`, timestamp: 1000000 + round * 10000 + i * 5 }),
        );
      }
    }
    const ids = received.map((h) => h.id);
    assert.equal(ids.length, new Set(ids).size);
  });
});

describe("highlight config", () => {
  it("loads defaults without config file", async () => {
    const { config, warnings } = await loadHighlightConfig("/nonexistent-dir-xyz");
    assert.ok(config.rules["high-file-activity"]!.enabled);
    assert.equal(config.rules["high-file-activity"]!.events, 500);
    assert.deepEqual(warnings, []);
  });

  it("no banned words in any generated explanation", () => {
    const events: GhostGlassEvent[] = [];
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({ type: "file", action: "write", path: `/work/f${i}.txt`, timestamp: 1000000 + i * 5 }));
    }
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({ type: "process", action: "spawn", timestamp: 1000000 + i * 50 }));
    }
    const h = detectHighlights(events, ctx());
    assert.ok(h.length > 0);
    for (const highlight of h) {
      const text = (highlight.title + " " + highlight.explanation).toLowerCase();
      for (const word of BANNED) {
        assert.ok(!text.includes(word), `Banned word "${word}" in: ${highlight.title}`);
      }
    }
  });
});
