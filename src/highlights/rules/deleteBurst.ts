/**
 * delete-burst: many files deleted in a short period.
 *
 * Sliding window per PID over delete events. Descriptive only — a developer
 * may intentionally be running `npm clean` or another cleanup command.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";

interface WindowEntry {
  timestamp: number;
  id: string;
  path: string | undefined;
}

interface DelWindow {
  entries: WindowEntry[];
  head: number;
  executable: string | undefined;
}

export class DeleteBurstRule implements HighlightRuleImpl {
  readonly rule = "high-delete-activity" as const;
  private ctx!: RuleContext;
  private perPid = new Map<number, DelWindow>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.perPid.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    if (event.type !== "file" || event.action !== "delete") return;
    const threshold = this.ctx.config.rules["high-delete-activity"].events;
    const windowMs = this.ctx.config.rules["high-delete-activity"].windowMs;

    let w = this.perPid.get(event.pid);
    if (!w) {
      w = { entries: [], head: 0, executable: undefined };
      this.perPid.set(event.pid, w);
    }
    if (event.executable) w.executable = event.executable;
    w.entries.push({ timestamp: event.timestamp, id: event.id, path: event.path });

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
    const id = `${this.ctx.runId}-high-delete-activity-${event.pid}-${windowStart}`;
    if (this.emitted.has(id)) return;
    this.emitted.add(id);

    const windowSecs = ((event.timestamp - windowStart) / 1000).toFixed(1);
    const title = "Delete burst";
    const explanation =
      `${inWindow} files deleted within ${windowSecs} seconds, ` +
      `exceeding GhostGlass's threshold of ${threshold} deletes / ${(windowMs / 1000).toFixed(1)} seconds. ` +
      `This is descriptive: cleanup commands delete many files on purpose.`;
    assertNoVerdictWords(title + " " + explanation);

    const inWindowEntries = w.entries.slice(w.head);
    const samplePaths = inWindowEntries
      .map((e) => e.path)
      .filter((p): p is string => typeof p === "string")
      .slice(0, 5);
    emit({
      id,
      runId: this.ctx.runId,
      rule: this.rule,
      severity: "notice",
      title,
      explanation,
      startTimestamp: windowStart,
      endTimestamp: event.timestamp,
      pid: event.pid,
      relatedEventIds: inWindowEntries.map((e) => e.id),
      metadata: {
        deleteCount: inWindow,
        windowMs,
        windowSecs: Number(windowSecs),
        executable: w.executable,
        samplePaths,
      },
    });

    w.head = w.entries.length;
  }

  finish(_emit: (h: Highlight) => void): void {}
}
