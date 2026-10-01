/**
 * Chronological event stream: virtualized list (only visible rows render),
 * kind/action filters, and search. Clicking a row pauses the replay, jumps
 * the playhead to that event, highlights its graph nodes, and shows it in
 * the inspector.
 */
import type { Store } from "./store.js";
import type { GhostGlassEvent, GhostGlassEventType } from "./types.js";
import { describeEvent, el, filterEvents, formatCount, formatOffset, text } from "./format.js";

const ROW_H = 30;
const PAGE = 5000;

interface Row {
  event: GhostGlassEvent;
  index: number; // index into store.events
}

export class StreamView {
  private listEl: HTMLElement | null = null;
  private spacer: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private rows: Row[] = [];
  private kind: GhostGlassEventType | "all" = "all";
  private actions = new Set<string>();
  private query = "";
  private follow = true;
  /** True while the list is scrolled to the bottom (live auto-scroll gate). */
  private atBottom = true;
  private searchTimer = 0;
  private lastCur = -2;

  /** Whether this view is bound to a live (streaming) store. */
  private get isLive(): boolean {
    return "followLive" in this.store;
  }

  private setStoreFollowLive(v: boolean): void {
    (this.store as unknown as { setFollowLive?: (v: boolean) => void }).setFollowLive?.(v);
  }

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("events", () => this.recompute());
    store.on("replay", () => this.onReplay());
    store.on("query", () => this.recompute());
  }

  render(): void {
    this.host.innerHTML = "";
    const panel = el("div", "stream-panel");

    const header = el("div", "stream-header");
    const title = el("div", "panel-title");
    text(title, "Event stream");
    header.appendChild(title);
    this.countEl = el("div", "stream-count");
    header.appendChild(this.countEl);

    const followBtn = document.createElement("button");
    followBtn.className = "tool-btn tool-toggle on";
    followBtn.textContent = this.isLive ? "Follow Live" : "Follow";
    followBtn.title = this.isLive
      ? "Auto-scroll to new events as they arrive (turn off to inspect history)"
      : "Auto-scroll to the playhead during replay";
    followBtn.addEventListener("click", () => {
      this.follow = !this.follow;
      followBtn.classList.toggle("on", this.follow);
      this.setStoreFollowLive(this.follow);
      if (this.follow && this.listEl) {
        // Re-enabling follow snaps back to the live edge.
        this.atBottom = true;
        this.listEl.scrollTop = this.listEl.scrollHeight;
      }
    });
    header.appendChild(followBtn);
    panel.appendChild(header);

    const filters = el("div", "stream-filters");
    const kinds: (GhostGlassEventType | "all")[] = ["all", "process", "file", "network"];
    for (const k of kinds) {
      const b = document.createElement("button");
      b.className = "filter-btn" + (k === "all" ? " on" : "");
      b.textContent = k === "all" ? "ALL" : k.toUpperCase();
      b.addEventListener("click", () => {
        this.kind = k;
        for (const btn of Array.from(filters.querySelectorAll(".filter-btn"))) btn.classList.remove("on");
        b.classList.add("on");
        this.recompute();
      });
      filters.appendChild(b);
    }
    const actionChips = ["read", "write", "create", "delete"];
    for (const a of actionChips) {
      const b = document.createElement("button");
      b.className = "filter-btn chip";
      b.textContent = a.toUpperCase();
      b.addEventListener("click", () => {
        if (this.actions.has(a)) {
          this.actions.delete(a);
          b.classList.remove("on");
        } else {
          this.actions.add(a);
          b.classList.add("on");
        }
        this.recompute();
      });
      filters.appendChild(b);
    }
    const search = document.createElement("input");
    search.className = "stream-search";
    search.placeholder = "Search events… (path, pid, ip, command)";
    search.setAttribute("aria-label", "Search events");
    search.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.query = search.value;
        this.recompute();
      }, 120);
    });
    filters.appendChild(search);
    panel.appendChild(filters);

    const list = el("div", "stream-list");
    list.setAttribute("tabindex", "0");
    const spacer = el("div", "stream-spacer");
    list.appendChild(spacer);
    list.addEventListener("scroll", () => {
      const l = this.listEl;
      if (l) {
        // If the user scrolled up manually, never yank them back: live
        // auto-scroll only fires while they sit at the bottom.
        this.atBottom = l.scrollTop + l.clientHeight >= l.scrollHeight - ROW_H * 2;
      }
      this.renderRows();
    });
    panel.appendChild(list);
    this.listEl = list;
    this.spacer = spacer;

    this.host.appendChild(panel);
    this.recompute();
  }

  private recompute(): void {
    const filtered = filterEvents(
      this.store.events,
      {
        kinds: this.kind === "all" ? null : new Set([this.kind]),
        actions: this.actions.size > 0 ? this.actions : null,
        query: this.query,
      },
      (pid) => this.store.pidLabel(pid),
    );
    // Trace query (Run 9): when active, keep only matching events.
    // The store already ran the compiled predicate; here we select rows.
    const matchSet = this.store.query !== null ? new Set(this.store.queryMatches) : null;
    const indexOf = new Map<GhostGlassEvent, number>();
    this.store.events.forEach((e, i) => indexOf.set(e, i));
    this.rows = [];
    for (const event of filtered) {
      const index = indexOf.get(event) ?? -1;
      if (index < 0) continue;
      if (matchSet && !matchSet.has(index)) continue;
      this.rows.push({ event, index });
    }
    if (this.spacer) this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.renderRows();
    this.updateCount();
    // Live mode: follow new batches to the bottom, but only if the user is
    // already at the bottom (never yank a manual scroll-up). Saved runs keep
    // their existing behavior: replay auto-scroll is handled by onReplay.
    if (this.isLive && this.follow && this.atBottom && this.listEl) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const loaded = formatCount(this.store.events.length);
    const total = formatCount(this.store.eventsTotal);
    const shown = formatCount(this.rows.length);
    this.countEl.textContent = this.store.eventsDone
      ? `${shown} shown · ${total} events`
      : `${loaded} / ${total} loaded…`;
  }

  private renderRows(): void {
    const list = this.listEl;
    const spacer = this.spacer;
    if (!list || !spacer) return;
    const scrollTop = list.scrollTop;
    const viewH = list.clientHeight || 300;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
    const end = Math.min(this.rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);

    spacer.innerHTML = "";
    const cur = this.store.currentIndex();
    for (let i = start; i < end; i++) {
      const row = this.rows[i] as Row;
      const e = row.event;
      const div = el("div", "stream-row" + (row.index === cur ? " current" : ""));
      div.style.top = `${i * ROW_H}px`;
      div.dataset.index = String(row.index);

      const time = el("span", "row-time");
      text(time, formatOffset(e.timestamp - this.store.startTimeMs));
      const badge = el("span", `row-badge badge-${e.type}`);
      text(badge, e.action.toUpperCase());
      const desc = el("span", "row-desc");
      text(desc, describeEvent(e, (pid) => this.store.pidLabel(pid)));

      div.appendChild(time);
      div.appendChild(badge);
      div.appendChild(desc);
      div.addEventListener("click", () => {
        this.store.selectEvent(row.index);
      });
      spacer.appendChild(div);
    }
  }

  private onReplay(): void {
    const cur = this.store.currentIndex();
    if (this.follow && this.store.playing && this.listEl && cur !== this.lastCur) {
      const pos = this.rows.findIndex((r) => r.index === cur);
      if (pos >= 0) {
        const top = pos * ROW_H;
        const list = this.listEl;
        if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - ROW_H * 2) {
          list.scrollTop = Math.max(0, top - list.clientHeight / 2);
        }
      }
    }
    // Only rebuild rows when the playhead crossed into a different event.
    if (cur !== this.lastCur) {
      this.lastCur = cur;
      this.renderRows();
    }
  }

  /** Load all event pages in the background; the stream fills in progressively. */
  async loadAll(runId: string, getPage: (offset: number, limit: number) => Promise<{ events: GhostGlassEvent[]; total: number }>): Promise<void> {
    let offset = 0;
    for (;;) {
      const page = await getPage(offset, PAGE);
      const done = offset + page.events.length >= page.total;
      this.store.appendEvents(page.events, done);
      if (done || page.events.length === 0) break;
      offset += page.events.length;
    }
  }
}
