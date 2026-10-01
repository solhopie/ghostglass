/**
 * Query bar: compact `key:value` syntax input shared by the saved-run
 * viewer and Live Glass. Uses the same parser and matcher as the CLI —
 * the syntax here and `ghostglass query --help` describe one language.
 *
 * Syntax: whitespace-separated key:value clauses (AND), repeated
 * action:/type: for OR, "quoted values" for paths with spaces.
 * Keys: process, pid, action, type, file, path, network, host, ip, port,
 * since, until, text, reconstructed, limit, order, highlight.
 */
import type { Store } from "./store.js";
import { el, text } from "./format.js";
import { QUERY_PRESETS } from "./query/format.js";

const HISTORY_KEY = "gg.queryHistory";
const HISTORY_MAX = 8;

function loadHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(q: string): void {
  try {
    const hist = [q, ...loadHistory().filter((h) => h !== q)].slice(0, HISTORY_MAX);
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* session storage unavailable — history is best-effort */
  }
}

export class QueryBar {
  private input: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private recentEl: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("query", () => this.updateStatus());
  }

  render(): void {
    this.host.innerHTML = "";
    const bar = el("div", "qbar");

    const input = document.createElement("input");
    input.className = "qbar-input";
    input.placeholder = "Query trace…  e.g. process:node action:write path:*package*";
    input.setAttribute("aria-label", "Query trace");
    input.spellcheck = false;
    input.value = this.store.queryText;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.apply();
      if (e.key === "Escape") this.clear();
    });
    this.input = input;
    bar.appendChild(input);

    const applyBtn = document.createElement("button");
    applyBtn.className = "qbar-btn";
    applyBtn.textContent = "Query";
    applyBtn.title = "Apply the query (Enter)";
    applyBtn.addEventListener("click", () => this.apply());
    bar.appendChild(applyBtn);

    const clearBtn = document.createElement("button");
    clearBtn.className = "qbar-btn qbar-clear";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Clear the query (Esc)";
    clearBtn.addEventListener("click", () => this.clear());
    this.clearBtn = clearBtn;
    bar.appendChild(clearBtn);

    const presets = document.createElement("select");
    presets.className = "qbar-presets";
    presets.title = "Query presets";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Presets…";
    presets.appendChild(placeholder);
    for (const p of QUERY_PRESETS) {
      const opt = document.createElement("option");
      opt.value = p.query;
      opt.textContent = p.name;
      presets.appendChild(opt);
    }
    presets.addEventListener("change", () => {
      if (presets.value) {
        input.value = presets.value;
        this.apply();
        presets.value = "";
      }
    });
    bar.appendChild(presets);

    const status = el("div", "qbar-status");
    this.statusEl = status;
    bar.appendChild(status);

    const recent = el("div", "qbar-recent");
    this.recentEl = recent;
    bar.appendChild(recent);

    const help = el("div", "qbar-help");
    text(
      help,
      "keys: process pid action type file path network host ip port since until text reconstructed highlight · " +
        "space = AND · action:write action:create = OR · \"quoted values\" for spaces",
    );
    bar.appendChild(help);

    this.host.appendChild(bar);
    this.renderRecent();
    this.updateStatus();
  }

  private apply(): void {
    if (!this.input) return;
    const q = this.input.value;
    this.store.setQuery(q);
    if (!this.store.queryError && q.trim().length > 0) {
      saveHistory(q.trim());
      this.renderRecent();
    }
    this.syncUrl();
  }

  private clear(): void {
    if (this.input) this.input.value = "";
    this.store.clearQuery();
    this.syncUrl();
  }

  private syncUrl(): void {
    try {
      const url = new URL(window.location.href);
      const q = this.store.queryText.trim();
      if (q) url.searchParams.set("q", q);
      else url.searchParams.delete("q");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* file:// or sandboxed — URL state is best-effort */
    }
  }

  private updateStatus(): void {
    const s = this.store;
    if (!this.statusEl || !this.clearBtn) return;
    this.statusEl.innerHTML = "";
    if (s.queryError) {
      const err = el("span", "qbar-error");
      text(err, s.queryError);
      this.statusEl.appendChild(err);
    } else if (s.hasQuery()) {
      const count = el("span", "qbar-count");
      const n = s.queryMatches.length;
      const hl = s.queryHighlightRule ? ` · highlight:${s.queryHighlightRule}` : "";
      text(count, `${n.toLocaleString()} match${n === 1 ? "" : "es"}${hl}`);
      this.statusEl.appendChild(count);
    }
    this.clearBtn.style.display = s.hasQuery() || s.queryText ? "" : "none";
  }

  private renderRecent(): void {
    if (!this.recentEl) return;
    this.recentEl.innerHTML = "";
    const hist = loadHistory();
    if (hist.length === 0) return;
    const label = el("span", "qbar-recent-label");
    text(label, "Recent:");
    this.recentEl.appendChild(label);
    for (const h of hist) {
      const b = document.createElement("button");
      b.className = "qbar-recent-chip";
      b.textContent = h.length > 40 ? h.slice(0, 37) + "…" : h;
      b.title = h;
      b.addEventListener("click", () => {
        if (this.input) this.input.value = h;
        this.apply();
      });
      this.recentEl.appendChild(b);
    }
  }
}
