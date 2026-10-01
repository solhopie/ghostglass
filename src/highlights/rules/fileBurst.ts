/**
 * file-burst: unusually concentrated filesystem activity by one process.
 *
 * Sliding window per PID: when `events` file events land within `windowMs`,
 * emit one highlight for that window. O(1) amortized per event using a
 * per-PID deque of entries.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";

const FILE_ACTIONS = new Set(["read", "write", "create", "delete", "rename", "mkdir"]);

interface WindowEntry {
  timestamp: number;
  id: string;
  action: string;
}

interface WindowState {
  /** File events in the current window (ascending timestamp). */
  entries: WindowEntry[];
  /** Index of the first entry still inside the window. */
  head: number;
  /** Counts per action for entries in the current window. */
  counts: Record<string, number>;
  executable: string | undefined;
}

function stableId(runId: string, pid: number, windowStart: number): string {
  return `${runId}-high-file-activity-${pid}-${windowStart}`;
}

export class FileBurstRule implements HighlightRuleImpl {
  readonly rule = "high-file-activity" as const;
  private ctx!: RuleContext;
  private perPid = new Map<number, WindowState>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.perPid.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    if (event.type !== "file" || !FILE_ACTIONS.has(event.action)) return;
    const threshold = this.ctx.config.rules["high-file-activity"].events;
    const windowMs = this.ctx.config.rules["high-file-activity"].windowMs;
    let st = this.perPid.get(event.pid);
    if (st === undefined) {
      st = { entries: [], head: 0, counts: {}, executable: undefined };
      this.perPid.set(event.pid, st);
    }
    if (event.executable) st.executable = event.executable;
    st.entries.push({ timestamp: event.timestamp, id: event.id, action: event.action });
    st.counts[event.action] = (st.counts[event.action] ?? 0) + 1;

    // Slide the window forward, evicting expired entries and their counts.
    const cutoff = event.timestamp - windowMs;
    while (st.head < st.entries.length && st.entries[st.head]!.timestamp < cutoff) {
      const evicted = st.entries[st.head]!;
      st.head++;
      const c = (st.counts[evicted.action] ?? 1) - 1;
      if (c <= 0) delete st.counts[evicted.action];
      else st.counts[evicted.action] = c;
    }
    // Compact occasionally so the backing array doesn't grow without bound.
    if (st.head > 1024 && st.head * 2 > st.entries.length) {
      st.entries.splice(0, st.head);
      st.head = 0;
    }

    const inWindow = st.entries.length - st.head;
    if (inWindow < threshold) return;

    const windowStart = st.entries[st.head]!.timestamp;
    const id = stableId(this.ctx.runId, event.pid, windowStart);
    if (this.emitted.has(id)) return;
    this.emitted.add(id);

    const windowSecs = ((event.timestamp - windowStart) / 1000).toFixed(1);
    const counts = st.counts;
    const parts: string[] = [];
    if (counts.write) parts.push(`Writes: ${counts.write.toLocaleString()}`);
    if (counts.create) parts.push(`Creates: ${counts.create.toLocaleString()}`);
    if (counts.delete) parts.push(`Deletes: ${counts.delete.toLocaleString()}`);
    if (counts.read) parts.push(`Reads: ${counts.read.toLocaleString()}`);
    if (counts.rename) parts.push(`Renames: ${counts.rename.toLocaleString()}`);

    const title = "File activity burst";
    const explanation =
      `The process generated ${inWindow.toLocaleString()} filesystem events in a ${windowSecs}-second window, ` +
      `exceeding GhostGlass's high-activity threshold of ${threshold.toLocaleString()} events / ${(windowMs / 1000).toFixed(1)} seconds.`;
    assertNoVerdictWords(title + " " + explanation);

    const relatedEventIds = st.entries.slice(st.head).map((e) => e.id);
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
      relatedEventIds,
      metadata: {
        executable: st.executable,
        eventCount: inWindow,
        windowMs,
        windowSecs: Number(windowSecs),
        actionCounts: { ...counts },
        breakdown: parts.join(", "),
      },
    });

    // Prevent overlapping windows from re-firing on the same activity:
    // advance the head past this window so the next burst needs fresh events.
    st.head = st.entries.length;
    st.counts = {};
  }

  finish(_emit: (h: Highlight) => void): void {
    // Bursts are emitted eagerly when the threshold is crossed; nothing to flush.
  }
}
