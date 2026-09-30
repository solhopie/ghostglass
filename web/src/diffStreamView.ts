/**
 * Event difference stream: changed-entity rows plus only-a / only-b
 * events in chronological order. Filters by side/kind, full-text search,
 * and click-to-inspect (jumps to the entity's graph node).
 */
import type { DiffStore, StreamFilter } from "./diffStore.js";
import { statusBadge } from "./diffStore.js";
import type { DiffStreamItem } from "./types.js";
import { describeEvent, el, formatOffset, text } from "./format.js";

const RENDER_STEP = 500;

export class DiffStreamView {
  private shown = RENDER_STEP;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: DiffStore,
  ) {
    store.on("data", () => {
      this.shown = RENDER_STEP;
      this.render();
    });
    store.on("filters", () => {
      this.shown = RENDER_STEP;
      this.render();
    });
  }

  render(): void {
    const diff = this.store.diff;
    this.host.innerHTML = "";
    const title = el("h2", "diff-section-title");
    text(title, "Changes");
    this.host.appendChild(title);
    this.host.appendChild(this.buildFilterBar());

    if (!diff) {
      const loading = el("div", "diff-loading");
      text(loading, "Loading changes…");
      this.host.appendChild(loading);
      return;
    }

    const items = this.store.filteredStream();
    const list = el("div", "diff-stream-list");
    for (const item of items.slice(0, this.shown)) {
      list.appendChild(this.row(item));
    }
    this.host.appendChild(list);

    const footer = el("div", "diff-stream-footer");
    if (items.length === 0) {
      text(footer, "No differences match the current filters.");
    } else {
      text(
        footer,
        `Showing ${Math.min(this.shown, items.length).toLocaleString("en-US")} of ` +
          `${items.length.toLocaleString("en-US")} difference${items.length === 1 ? "" : "s"}` +
          (diff.streamTruncated ? " (stream capped at server)" : ""),
      );
      if (items.length > this.shown) {
        const more = document.createElement("button");
        more.className = "tool-btn";
        text(more, `Show more (${(items.length - this.shown).toLocaleString("en-US")} remaining)`);
        more.addEventListener("click", () => {
          this.shown += RENDER_STEP;
          this.render();
        });
        footer.appendChild(more);
      }
    }
    this.host.appendChild(footer);
  }

  private buildFilterBar(): HTMLElement {
    const bar = el("div", "diff-stream-filters");
    const filters: [StreamFilter, string][] = [
      ["all", "All"],
      ["only-a", "Only A"],
      ["only-b", "Only B"],
      ["changed", "Changed"],
      ["process", "Process"],
      ["file", "File"],
      ["network", "Network"],
    ];
    for (const [f, label] of filters) {
      const b = document.createElement("button");
      b.className = "tool-btn tool-toggle" + (this.store.streamFilter === f ? " on" : "");
      text(b, label);
      b.addEventListener("click", () => this.store.setStreamFilter(f));
      bar.appendChild(b);
    }
    const search = document.createElement("input");
    search.className = "diff-search";
    search.placeholder = "Search differences…";
    search.value = this.store.search;
    search.setAttribute("aria-label", "Search differences");
    search.addEventListener("input", () => this.store.setSearch(search.value));
    bar.appendChild(search);
    return bar;
  }

  private row(item: DiffStreamItem): HTMLElement {
    const row = el("div", "diff-stream-row");
    if (item.itemKind === "changed") {
      row.classList.add("diff-row-changed");
      const badge = el("span", "diff-row-badge dbadge-changed");
      text(badge, statusBadge("changed"));
      row.appendChild(badge);
      const main = el("span", "diff-row-main");
      text(main, item.label);
      row.appendChild(main);
      const sub = el("span", "diff-row-sub");
      text(sub, `${item.entityKind} · ${item.sublabel}`);
      row.appendChild(sub);
      row.title = "Click to inspect";
      row.addEventListener("click", () => {
        const id = this.store.nodeIdForEntity(item.entityKind, item.fingerprint);
        this.store.select(id ?? null);
      });
      return row;
    }
    const badge = el("span", `diff-row-badge dbadge-${item.side === "a" ? "only-a" : "only-b"}`);
    text(badge, statusBadge(item.side === "a" ? "only-a" : "only-b"));
    row.appendChild(badge);
    const time = el("span", "diff-row-time");
    text(time, formatOffset(item.offsetMs));
    row.appendChild(time);
    const main = el("span", "diff-row-main");
    text(main, describeEvent(item.event, (pid) => `PID ${pid}`));
    row.appendChild(main);
    row.title = "Click to inspect";
    row.addEventListener("click", () => {
      const id = this.store.nodeIdForEntity(item.entityKind, item.fingerprint);
      this.store.select(id ?? null);
    });
    return row;
  }
}
