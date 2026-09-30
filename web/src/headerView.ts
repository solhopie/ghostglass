/** Run summary header: the same numbers as `ghostglass show`, from summary.json. */
import type { Store } from "./store.js";
import { el, formatCount, formatDuration, text } from "./format.js";

export class HeaderView {
  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("data", () => this.render());
  }

  render(): void {
    const m = this.store.metadata;
    const s = this.store.summary;
    this.host.innerHTML = "";
    if (!m || !s) {
      const loading = el("div", "header-loading");
      text(loading, "Loading trace…");
      this.host.appendChild(loading);
      return;
    }

    const brand = el("div", "brand");
    const mark = el("span", "brand-mark");
    const name = el("span", "brand-name");
    text(name, "GhostGlass");
    brand.appendChild(mark);
    brand.appendChild(name);

    const cmd = el("div", "header-cmd");
    text(cmd, m.commandLine);

    const stats = el("div", "header-stats");
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
    stat(formatDuration(m.durationMs), "duration");
    stat(formatCount(s.processCount), "processes");
    stat(formatCount(s.filesystem.total), "filesystem events");
    stat(formatCount(s.network.attempts), "network attempts");
    stat(m.exitCode == null ? (m.signal ?? "?") : String(m.exitCode), "exit");

    const meta = el("div", "header-meta");
    const parts = [
      `Run ${m.runId}`,
      `started ${new Date(m.startTime).toLocaleString()}`,
      `backend ${m.backend}`,
      `${m.os.platform}/${m.os.arch}`,
    ];
    text(meta, parts.join(" · "));
    if (m.interrupted) {
      const badge = el("span", "interrupted-badge");
      text(badge, "INTERRUPTED — partial trace");
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(badge);
    }

    const left = el("div", "header-left");
    left.appendChild(brand);
    left.appendChild(cmd);
    this.host.appendChild(left);
    this.host.appendChild(stats);
    this.host.appendChild(meta);
  }
}
