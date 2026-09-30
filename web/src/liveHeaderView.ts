/**
 * Live session header: status pill, ticking counters, command line, run id.
 * Renders on every "data" emit (250ms tick + throttled batch updates).
 * All trace-derived strings go through text() — never innerHTML.
 */
import type { LiveStore, LiveStatus } from "./liveStore.js";
import { el, formatCount, formatDuration, text } from "./format.js";

function pillText(status: LiveStatus, exitCode: number | null): string {
  switch (status) {
    case "running":
      return "● RUNNING";
    case "complete":
      return "● COMPLETE";
    case "interrupted":
      return "● INTERRUPTED";
    case "exited":
      return exitCode == null ? "● EXITED" : `● EXITED ${exitCode}`;
  }
}

export class LiveHeaderView {
  constructor(
    private readonly host: HTMLElement,
    private readonly store: LiveStore,
  ) {
    store.on("data", () => this.render());
  }

  render(): void {
    const s = this.store;
    this.host.innerHTML = "";

    const left = el("div", "header-left");
    const brand = el("div", "brand");
    const mark = el("span", "brand-mark");
    const name = el("span", "brand-name");
    text(name, "GhostGlass");
    brand.appendChild(mark);
    brand.appendChild(name);
    const pill = el("span", `live-pill ${s.liveStatus}`);
    text(pill, pillText(s.liveStatus, s.exitCode));
    brand.appendChild(pill);
    left.appendChild(brand);

    const cmd = el("div", "header-cmd");
    text(cmd, s.commandLine || "Connecting to live session…");
    left.appendChild(cmd);
    this.host.appendChild(left);

    const stats = el("div", "header-stats");
    const c = s.counters;
    const stat = (v: string, l: string) => {
      const d = el("div", "hstat");
      const vv = el("div", "hstat-v");
      text(vv, v);
      const ll = el("div", "hstat-l");
      text(ll, l);
      d.appendChild(vv);
      d.appendChild(ll);
      stats.appendChild(d);
    };
    stat(formatDuration(s.durationMs), "duration");
    stat(formatCount(c.processes), "processes");
    stat(formatCount(c.files), "files");
    stat(formatCount(c.fileEvents), "file events");
    stat(formatCount(c.networkAttempts), "network");
    stat(formatCount(c.totalEvents), "events");
    this.host.appendChild(stats);

    const meta = el("div", "header-meta");
    const parts = [`Run ${s.runId}`];
    if (s.startTimeMs > 0) parts.push(`started ${new Date(s.startTimeMs).toLocaleString()}`);
    parts.push("live · local only");
    if (s.followLive && s.liveStatus === "running") parts.push("following live");
    text(meta, parts.join(" · "));
    this.host.appendChild(meta);

    if (s.highActivity) {
      const banner = el("div", "live-high-activity");
      text(banner, "High activity — visualization batching enabled. All events are still recorded.");
      this.host.appendChild(banner);
    }
  }
}
