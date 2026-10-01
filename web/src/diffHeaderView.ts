/**
 * Diff page header: title, the two run cards, and the summary comparison
 * table (A / B / Δ for durations, counts, exit codes). Descriptive only —
 * a larger number is never presented as worse.
 */
import type { DiffStore } from "./diffStore.js";
import type { DeltaNumber, HighlightSummary, SummaryDiff } from "./types.js";
import { el, formatCount, formatDuration, text } from "./format.js";

function fmtDelta(n: number): string {
  if (n === 0) return "±0";
  const sign = n > 0 ? "+" : "−";
  return `${sign}${formatCount(Math.abs(n))}`;
}

function fmtDeltaDuration(ms: number): string {
  if (ms === 0) return "±0";
  const sign = ms > 0 ? "+" : "−";
  const abs = Math.abs(ms);
  const body = abs < 1000 ? `${Math.round(abs)}ms` : `${(abs / 1000).toFixed(2)}s`;
  return `${sign}${body}`;
}

function fmtExit(v: number | null): string {
  return v === null ? "?" : String(v);
}

export class DiffHeaderView {
  constructor(
    private readonly host: HTMLElement,
    private readonly store: DiffStore,
  ) {
    store.on("data", () => this.render());
  }

  render(): void {
    const diff = this.store.diff;
    this.host.innerHTML = "";
    const wrap = el("div", "diff-head");
    const h = el("h1", "diff-title");
    text(h, "GhostGlass Diff");
    wrap.appendChild(h);

    if (!diff) {
      const loading = el("div", "diff-loading");
      text(loading, "Computing comparison…");
      wrap.appendChild(loading);
      this.host.appendChild(wrap);
      return;
    }

    const runs = el("div", "diff-runs");
    runs.appendChild(
      this.runCard("RUN A", diff.runA.commandLine, diff.runA.runId, diff.runA),
    );
    runs.appendChild(
      this.runCard("RUN B", diff.runB.commandLine, diff.runB.runId, diff.runB),
    );
    wrap.appendChild(runs);
    wrap.appendChild(this.summaryTable(diff.summary));
    wrap.appendChild(
      this.highlightLists(diff.highlightsA ?? [], diff.highlightsB ?? []),
    );
    this.host.appendChild(wrap);
  }

  /** Independent per-run highlight lists — counts plus titles, no verdict. */
  private highlightLists(
    a: HighlightSummary[],
    b: HighlightSummary[],
  ): HTMLElement {
    const sec = el("div", "diff-hl");
    const h = el("h2", "diff-hl-title");
    text(h, `Behavior highlights — Run A: ${a.length} · Run B: ${b.length}`);
    sec.appendChild(h);
    const note = el("div", "diff-hl-note");
    text(note, "Independent lists per run. Highlights describe observed behavior; they are not a verdict.");
    sec.appendChild(note);
    const cols = el("div", "diff-hl-cols");
    cols.appendChild(this.highlightCol("Run A", a));
    cols.appendChild(this.highlightCol("Run B", b));
    sec.appendChild(cols);
    return sec;
  }

  private highlightCol(label: string, items: HighlightSummary[]): HTMLElement {
    const col = el("div", "diff-hl-col");
    const h = el("div", "diff-hl-colhead");
    text(h, `${label} (${items.length})`);
    col.appendChild(h);
    if (items.length === 0) {
      const empty = el("div", "diff-hl-empty");
      text(empty, "No highlights.");
      col.appendChild(empty);
      return col;
    }
    const ul = document.createElement("ul");
    ul.className = "diff-hl-list";
    for (const item of items.slice(0, 50)) {
      const li = document.createElement("li");
      li.className = "diff-hl-item";
      const sev = el("span", `hl-sev hl-sev-${item.severity}`);
      text(sev, item.severity.toUpperCase());
      li.appendChild(sev);
      const t = el("span", "diff-hl-t");
      text(t, ` ${item.title}`);
      li.appendChild(t);
      ul.appendChild(li);
    }
    if (items.length > 50) {
      const more = document.createElement("li");
      more.className = "diff-hl-more";
      text(more, `…and ${items.length - 50} more`);
      ul.appendChild(more);
    }
    col.appendChild(ul);
    return col;
  }

  private runCard(
    tag: string,
    commandLine: string,
    runId: string,
    meta: { durationMs: number; exitCode: number | null; interrupted: boolean },
  ): HTMLElement {
    const card = el("div", `diff-run-card ${tag === "RUN A" ? "diff-run-a" : "diff-run-b"}`);
    const t = el("div", "diff-run-tag");
    text(t, tag);
    card.appendChild(t);
    const cmd = el("div", "diff-run-cmd");
    text(cmd, commandLine);
    card.appendChild(cmd);
    const metaEl = el("div", "diff-run-meta");
    const bits = [runId, formatDuration(meta.durationMs), `exit ${fmtExit(meta.exitCode)}`];
    if (meta.interrupted) bits.push("interrupted");
    text(metaEl, bits.join(" · "));
    card.appendChild(metaEl);
    return card;
  }

  private summaryTable(s: SummaryDiff): HTMLElement {
    const table = document.createElement("table");
    table.className = "diff-summary";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const htxt of ["", "Run A", "Run B", "Δ"]) {
      const th = document.createElement("th");
      text(th, htxt);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");

    const numRow = (
      label: string,
      d: DeltaNumber,
      fmt: (n: number) => string,
      fmtD: (n: number) => string = fmtDelta,
    ) => {
      const tr = document.createElement("tr");
      const cells = [label, fmt(d.a), fmt(d.b), fmtD(d.delta)];
      cells.forEach((c, i) => {
        const td = document.createElement(i === 0 ? "th" : "td");
        text(td, c);
        if (i === 3) td.className = "diff-delta";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    };

    numRow("Duration", s.durationMs, (n) => formatDuration(n), fmtDeltaDuration);
    numRow("Processes", s.processCount, (n) => formatCount(n));
    numRow("Filesystem events", s.eventCount, (n) => formatCount(n));
    const fs = s.filesystem;
    numRow("  Reads", fs.read, (n) => formatCount(n));
    numRow("  Writes", fs.write, (n) => formatCount(n));
    numRow("  Creates", fs.create, (n) => formatCount(n));
    numRow("  Deletes", fs.delete, (n) => formatCount(n));
    numRow("  Renames", fs.rename, (n) => formatCount(n));
    numRow("  Mkdirs", fs.mkdir, (n) => formatCount(n));
    numRow("Network attempts", s.networkAttempts, (n) => formatCount(n));

    const exitRow = document.createElement("tr");
    const exitCells: [string, string][] = [
      ["th", "Exit code"],
      ["td", fmtExit(s.exitCode.a)],
      ["td", fmtExit(s.exitCode.b)],
      ["td", s.exitCode.changed ? "changed" : "same"],
    ];
    for (const [tag, c] of exitCells) {
      const td = document.createElement(tag);
      text(td, c);
      if (tag === "td" && s.exitCode.changed) td.className = "diff-delta";
      exitRow.appendChild(td);
    }
    tbody.appendChild(exitRow);

    const intRow = document.createElement("tr");
    const intCells: [string, string][] = [
      ["th", "Interrupted"],
      ["td", s.interrupted.a ? "yes" : "no"],
      ["td", s.interrupted.b ? "yes" : "no"],
      ["td", s.interrupted.changed ? "changed" : "same"],
    ];
    for (const [tag, c] of intCells) {
      const td = document.createElement(tag);
      text(td, c);
      if (tag === "td" && s.interrupted.changed) td.className = "diff-delta";
      intRow.appendChild(td);
    }
    tbody.appendChild(intRow);

    table.appendChild(tbody);
    return table;
  }
}
