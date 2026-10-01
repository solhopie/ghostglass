/**
 * HighlightPanel: dedicated "Highlights N" panel listing behavior highlights
 * in time order. Clicking an item seeks to it, spotlights related graph
 * nodes, and opens the highlight inspector. Filters by category and
 * severity; "High" means behavioral magnitude, not danger.
 */
import { el, text, formatOffset } from "./format.js";
import type { Store, HighlightFilters } from "./store.js";
import { highlightCategory } from "./store.js";
import type { Highlight, HighlightCategory, HighlightSeverity } from "./types.js";

const CATEGORY_OPTIONS: { value: "all" | HighlightCategory; label: string }[] = [
  { value: "all", label: "ALL" },
  { value: "file", label: "FILE" },
  { value: "process", label: "PROCESS" },
  { value: "network", label: "NETWORK" },
  { value: "path", label: "PATH" },
];

const SEVERITY_OPTIONS: { value: "all" | HighlightSeverity; label: string }[] = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "notice", label: "Notice" },
  { value: "high", label: "High" },
];

function severityClass(s: HighlightSeverity): string {
  return s === "high" ? "hl-sev-high" : s === "notice" ? "hl-sev-notice" : "hl-sev-info";
}

function detailLine(h: Highlight): string {
  const m = h.metadata as Record<string, unknown>;
  switch (h.rule) {
    case "high-file-activity":
      return `${Number(m.eventCount ?? 0).toLocaleString()} events / ${m.windowSecs}s`;
    case "high-process-activity":
      return `${m.spawnCount} child processes / ${m.windowSecs}s`;
    case "high-network-activity":
      return `${m.attemptCount} attempts / ${m.windowSecs}s`;
    case "high-delete-activity":
      return `${m.deleteCount} deleted / ${m.windowSecs}s`;
    case "outside-working-directory":
      return `${m.fileCount ?? 0} files under ${String(m.directory ?? "")}`;
    case "create-then-execute":
      return `${String(m.path ?? "")}`;
    case "rapid-file-churn":
      return `${m.operationCount} ops / ${m.windowSecs}s`;
    default:
      return "";
  }
}

function subLine(h: Highlight): string {
  const m = h.metadata as Record<string, unknown>;
  const exe = m.executable ?? m.parentExecutable ?? m.createdByExecutable;
  if (typeof exe === "string" && exe) return exe.split("/").pop() ?? exe;
  if (h.pid !== undefined) return `PID ${h.pid}`;
  return highlightCategory(h).toUpperCase();
}

export class HighlightPanel {
  private readonly host: HTMLElement;
  private readonly store: Store;
  private selectedId: string | null = null;

  constructor(host: HTMLElement, store: Store) {
    this.host = host;
    this.store = store;
    store.on("highlights", () => this.render());
    store.on("selection", () => {
      const sel = store.selection;
      this.selectedId = sel?.kind === "highlight" ? sel.highlightId : null;
      this.render();
    });
  }

  render(): void {
    const s = this.store;
    this.host.innerHTML = "";
    const panel = el("div", "hl-panel");

    const head = el("div", "hl-head");
    const title = el("div", "hl-title");
    text(title, `Highlights  ${s.highlights.length}`);
    head.appendChild(title);
    const note = el("div", "hl-note");
    text(note, "Observed behavior — not a security verdict");
    head.appendChild(note);
    panel.appendChild(head);

    // Filters.
    const filters = el("div", "hl-filters");
    const catSel = document.createElement("select");
    catSel.className = "hl-filter";
    catSel.setAttribute("aria-label", "Filter highlights by category");
    for (const o of CATEGORY_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = o.value;
      text(opt, o.label);
      if (s.highlightFilters.category === o.value) opt.selected = true;
      catSel.appendChild(opt);
    }
    catSel.addEventListener("change", () => {
      const v = catSel.value as HighlightFilters["category"];
      s.setHighlightFilters({ ...s.highlightFilters, category: v });
    });
    const sevSel = document.createElement("select");
    sevSel.className = "hl-filter";
    sevSel.setAttribute("aria-label", "Filter highlights by severity");
    for (const o of SEVERITY_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = o.value;
      text(opt, o.label);
      if (s.highlightFilters.severity === o.value) opt.selected = true;
      sevSel.appendChild(opt);
    }
    sevSel.addEventListener("change", () => {
      const v = sevSel.value as HighlightFilters["severity"];
      s.setHighlightFilters({ ...s.highlightFilters, severity: v });
    });
    filters.appendChild(catSel);
    filters.appendChild(sevSel);
    panel.appendChild(filters);

    const list = el("div", "hl-list");
    const items = s.filteredHighlights();
    if (items.length === 0) {
      const empty = el("div", "hl-empty");
      text(
        empty,
        s.highlights.length === 0
          ? "No highlights — nothing crossed the activity thresholds."
          : "No highlights match the current filters.",
      );
      list.appendChild(empty);
    }
    for (const h of items) {
      list.appendChild(this.renderItem(h));
    }
    panel.appendChild(list);
    this.host.appendChild(panel);
  }

  private renderItem(h: Highlight): HTMLElement {
    const s = this.store;
    const item = el(
      "button",
      "hl-item" + (this.selectedId === h.id ? " hl-item-selected" : ""),
    );
    item.type = "button";
    item.addEventListener("click", () => s.selectHighlight(h.id));

    const when = el("div", "hl-when");
    text(when, `+${formatOffset(h.startTimestamp - s.startTimeMs)}`);
    const sev = el("span", `hl-sev ${severityClass(h.severity)}`);
    text(sev, h.severity.toUpperCase());
    when.appendChild(sev);
    item.appendChild(when);

    const title = el("div", "hl-item-title");
    text(title, h.title);
    item.appendChild(title);

    const sub = el("div", "hl-item-sub");
    text(sub, `${subLine(h)} · ${detailLine(h)}`);
    item.appendChild(sub);
    return item;
  }
}
