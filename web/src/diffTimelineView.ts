/**
 * Dual-run timeline comparison.
 *
 * Two modes:
 * - Real Time: bar widths are proportional to actual durations, so a
 *   longer run visibly extends past the shorter one.
 * - Normalized: both runs map 0% → 100%, useful for comparing execution
 *   structure regardless of duration.
 */
import type { DiffStore, TimelineMode } from "./diffStore.js";
import { el, formatDuration, text } from "./format.js";

export class DiffTimelineView {
  constructor(
    private readonly host: HTMLElement,
    private readonly store: DiffStore,
  ) {
    store.on("data", () => this.render());
    store.on("filters", () => this.render());
  }

  render(): void {
    const diff = this.store.diff;
    this.host.innerHTML = "";
    const title = el("h2", "diff-section-title");
    text(title, "Timeline Comparison");
    this.host.appendChild(title);

    if (!diff) {
      const loading = el("div", "diff-loading");
      text(loading, "Loading timelines…");
      this.host.appendChild(loading);
      return;
    }

    const bar = el("div", "diff-timeline-bar");
    const mkToggle = (mode: TimelineMode, label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "tool-btn tool-toggle" + (this.store.timelineMode === mode ? " on" : "");
      text(b, label);
      b.addEventListener("click", () => this.store.setTimelineMode(mode));
      return b;
    };
    bar.appendChild(mkToggle("real", "Real Time"));
    bar.appendChild(mkToggle("normalized", "Normalized"));
    this.host.appendChild(bar);

    const durA = diff.runA.durationMs;
    const durB = diff.runB.durationMs;
    const maxDur = Math.max(durA, durB, 1);
    const widthA = this.store.timelineMode === "normalized" ? 100 : (durA / maxDur) * 100;
    const widthB = this.store.timelineMode === "normalized" ? 100 : (durB / maxDur) * 100;

    this.host.appendChild(this.timelineRow("RUN A", widthA, durA, "diff-tl-a"));
    this.host.appendChild(this.timelineRow("RUN B", widthB, durB, "diff-tl-b"));

    const note = el("div", "diff-timeline-note");
    text(
      note,
      this.store.timelineMode === "normalized"
        ? "Normalized: both runs scaled 0% → 100% for structural comparison."
        : `Real time: bar lengths proportional to duration (longest = ${formatDuration(maxDur)}).`,
    );
    this.host.appendChild(note);
  }

  private timelineRow(tag: string, widthPct: number, durationMs: number, cls: string): HTMLElement {
    const row = el("div", "diff-timeline-row");
    const t = el("div", "diff-timeline-tag");
    text(t, tag);
    row.appendChild(t);
    const track = el("div", "diff-timeline-track");
    const fill = el("div", `diff-timeline-fill ${cls}`);
    fill.style.width = `${widthPct.toFixed(2)}%`;
    track.appendChild(fill);
    for (const pct of [25, 50, 75]) {
      const tick = el("div", "diff-timeline-tick");
      tick.style.left = `${pct}%`;
      track.appendChild(tick);
    }
    row.appendChild(track);
    const dur = el("div", "diff-timeline-dur");
    text(dur, formatDuration(durationMs));
    row.appendChild(dur);
    return row;
  }
}
