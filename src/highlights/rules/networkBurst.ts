/**
 * network-burst: concentrated outbound connection activity.
 *
 * Sliding window per PID over connect events: when `events` connection
 * attempts happen within `windowMs`, emit one highlight summarizing the
 * distinct destinations. No reputation lookups, no DNS guessing — only
 * destinations the trace itself observed.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";

interface WindowEntry {
  timestamp: number;
  id: string;
  dest: string;
}

interface NetWindow {
  entries: WindowEntry[];
  head: number;
  /** Destination -> count of entries in the current window. */
  destCounts: Map<string, number>;
  executable: string | undefined;
}

function destKey(e: GhostGlassEvent): string {
  if (e.host) return `${e.host}:${e.port ?? "?"}`;
  if (e.ip) return `${e.ip}:${e.port ?? "?"}`;
  return "(unknown destination)";
}

export class NetworkBurstRule implements HighlightRuleImpl {
  readonly rule = "high-network-activity" as const;
  private ctx!: RuleContext;
  private perPid = new Map<number, NetWindow>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.perPid.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    if (event.type !== "network" || event.action !== "connect") return;
    const threshold = this.ctx.config.rules["high-network-activity"].events;
    const windowMs = this.ctx.config.rules["high-network-activity"].windowMs;

    let w = this.perPid.get(event.pid);
    if (!w) {
      w = { entries: [], head: 0, destCounts: new Map(), executable: undefined };
      this.perPid.set(event.pid, w);
    }
    if (event.executable) w.executable = event.executable;
    const dest = destKey(event);
    w.entries.push({ timestamp: event.timestamp, id: event.id, dest });
    w.destCounts.set(dest, (w.destCounts.get(dest) ?? 0) + 1);

    const cutoff = event.timestamp - windowMs;
    while (w.head < w.entries.length && w.entries[w.head]!.timestamp < cutoff) {
      const evicted = w.entries[w.head]!;
      w.head++;
      const c = (w.destCounts.get(evicted.dest) ?? 1) - 1;
      if (c <= 0) w.destCounts.delete(evicted.dest);
      else w.destCounts.set(evicted.dest, c);
    }
    if (w.head > 1024 && w.head * 2 > w.entries.length) {
      w.entries.splice(0, w.head);
      w.head = 0;
    }

    const inWindow = w.entries.length - w.head;
    if (inWindow < threshold) return;

    const windowStart = w.entries[w.head]!.timestamp;
    const id = `${this.ctx.runId}-high-network-activity-${event.pid}-${windowStart}`;
    if (this.emitted.has(id)) return;
    this.emitted.add(id);

    const windowSecs = ((event.timestamp - windowStart) / 1000).toFixed(1);
    const distinctDests = w.destCounts.size;
    const topDests = [...w.destCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d, c]) => `${d} (${c})`);
    const title = "Network activity burst";
    const explanation =
      `${inWindow} connection attempts to ${distinctDests} distinct destination${distinctDests === 1 ? "" : "s"} ` +
      `within ${windowSecs} seconds, exceeding GhostGlass's threshold of ${threshold} attempts / ${(windowMs / 1000).toFixed(1)} seconds. ` +
      `Destinations are listed as observed; GhostGlass does not judge them.`;
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
      pid: event.pid,
      relatedEventIds,
      metadata: {
        attemptCount: inWindow,
        distinctDestinations: distinctDests,
        topDestinations: topDests,
        windowMs,
        windowSecs: Number(windowSecs),
        executable: w.executable,
      },
    });

    w.head = w.entries.length;
    w.destCounts.clear();
  }

  finish(_emit: (h: Highlight) => void): void {}
}
