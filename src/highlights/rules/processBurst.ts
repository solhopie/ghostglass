/**
 * process-burst: rapid process creation.
 *
 * Sliding window per parent PID over spawn events: when `events` child
 * processes start within `windowMs` under one parent, emit one highlight.
 * O(1) amortized per event using per-parent deques.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";

interface WindowEntry {
  timestamp: number;
  id: string;
}

interface ParentWindow {
  entries: WindowEntry[];
  head: number;
  executable: string | undefined;
}

export class ProcessBurstRule implements HighlightRuleImpl {
  readonly rule = "high-process-activity" as const;
  private ctx!: RuleContext;
  private perParent = new Map<number, ParentWindow>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.perParent.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    if (event.type !== "process" || event.action !== "spawn") return;
    const threshold = this.ctx.config.rules["high-process-activity"].events;
    const windowMs = this.ctx.config.rules["high-process-activity"].windowMs;
    const parent = event.parentPid ?? event.pid;

    let w = this.perParent.get(parent);
    if (!w) {
      w = { entries: [], head: 0, executable: undefined };
      this.perParent.set(parent, w);
    }
    if (event.executable) w.executable = event.executable;
    w.entries.push({ timestamp: event.timestamp, id: event.id });

    const cutoff = event.timestamp - windowMs;
    while (w.head < w.entries.length && w.entries[w.head]!.timestamp < cutoff) {
      w.head++;
    }
    if (w.head > 1024 && w.head * 2 > w.entries.length) {
      w.entries.splice(0, w.head);
      w.head = 0;
    }

    const inWindow = w.entries.length - w.head;
    if (inWindow < threshold) return;

    const windowStart = w.entries[w.head]!.timestamp;
    const id = `${this.ctx.runId}-high-process-activity-${parent}-${windowStart}`;
    if (this.emitted.has(id)) return;
    this.emitted.add(id);

    const windowSecs = ((event.timestamp - windowStart) / 1000).toFixed(1);
    const title = "Process spawn burst";
    const explanation =
      `${inWindow} child processes started within ${windowSecs} seconds, ` +
      `exceeding GhostGlass's threshold of ${threshold} spawns / ${(windowMs / 1000).toFixed(1)} seconds.`;
    assertNoVerdictWords(title + " " + explanation);

    const relatedEventIds = w.entries.slice(w.head).map((e) => e.id);
    emit({
      id,
      runId: this.ctx.runId,
      rule: this.rule,
      severity: "notice",
      title,
      explanation,
      startTimestamp: windowStart,
      endTimestamp: event.timestamp,
      pid: parent,
      relatedEventIds,
      metadata: {
        spawnCount: inWindow,
        windowMs,
        windowSecs: Number(windowSecs),
        parentPid: parent,
        parentExecutable: w.executable,
      },
    });

    // Require fresh activity for the next burst from this parent.
    w.head = w.entries.length;
  }

  finish(_emit: (h: Highlight) => void): void {}
}
