/**
 * rapid-file-churn: repeated writes/renames/deletes against the same file
 * or a small file set.
 *
 * Sliding window per path: when `events` churn operations (write, rename,
 * delete) hit one path within `windowMs`, emit one highlight. Useful for
 * debugging build tools and package managers.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";
import { normalizeTracePath } from "./outsideCwd.js";

const CHURN_ACTIONS = new Set(["write", "rename", "delete"]);

interface WindowEntry {
  timestamp: number;
  id: string;
  action: string;
}

interface ChurnWindow {
  entries: WindowEntry[];
  head: number;
  counts: Record<string, number>;
  pid: number | undefined;
  executable: string | undefined;
}

export class RapidFileChurnRule implements HighlightRuleImpl {
  readonly rule = "rapid-file-churn" as const;
  private ctx!: RuleContext;
  private perPath = new Map<string, ChurnWindow>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.perPath.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    if (event.type !== "file" || !CHURN_ACTIONS.has(event.action) || !event.path) return;
    const threshold = this.ctx.config.rules["rapid-file-churn"].events;
    const windowMs = this.ctx.config.rules["rapid-file-churn"].windowMs;
    const path = normalizeTracePath(event.path);
    // Pseudo-files like /dev/null see constant writes from stdio redirection;
    // churning them is not interesting behavior.
    if (path === "/dev/null" || path === "/dev/zero" || path === "/dev/full") return;

    let w = this.perPath.get(path);
    if (!w) {
      w = { entries: [], head: 0, counts: {}, pid: undefined, executable: undefined };
      this.perPath.set(path, w);
    }
    w.pid = event.pid;
    if (event.executable) w.executable = event.executable;
    w.entries.push({ timestamp: event.timestamp, id: event.id, action: event.action });
    w.counts[event.action] = (w.counts[event.action] ?? 0) + 1;

    const cutoff = event.timestamp - windowMs;
    while (w.head < w.entries.length && w.entries[w.head]!.timestamp < cutoff) {
      const evicted = w.entries[w.head]!;
      w.head++;
      const c = (w.counts[evicted.action] ?? 1) - 1;
      if (c <= 0) delete w.counts[evicted.action];
      else w.counts[evicted.action] = c;
    }
    if (w.head > 1024 && w.head * 2 > w.entries.length) {
      w.entries.splice(0, w.head);
      w.head = 0;
    }

    const inWindow = w.entries.length - w.head;
    if (inWindow < threshold) return;

    const windowStart = w.entries[w.head]!.timestamp;
    const id = `${this.ctx.runId}-rapid-file-churn-${path}-${windowStart}`;
    if (this.emitted.has(id)) return;
    this.emitted.add(id);

    const windowSecs = ((event.timestamp - windowStart) / 1000).toFixed(1);
    const parts: string[] = [];
    if (w.counts.write) parts.push(`${w.counts.write} writes`);
    if (w.counts.rename) parts.push(`${w.counts.rename} renames`);
    if (w.counts.delete) parts.push(`${w.counts.delete} deletes`);

    const title = "Rapid file churn";
    const explanation =
      `${path} saw ${parts.join(", ")} within ${windowSecs} seconds, ` +
      `exceeding GhostGlass's threshold of ${threshold} operations / ${(windowMs / 1000).toFixed(1)} seconds. ` +
      `Repeated churn on one file is typical of build tools and package managers.`;
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
      pid: w.pid,
      relatedEventIds,
      metadata: {
        path,
        operationCount: inWindow,
        windowMs,
        windowSecs: Number(windowSecs),
        actionCounts: { ...w.counts },
        executable: w.executable,
      },
    });

    // Prevent overlapping windows: advance past this window.
    w.head = w.entries.length;
    w.counts = {};
  }

  finish(_emit: (h: Highlight) => void): void {}
}
