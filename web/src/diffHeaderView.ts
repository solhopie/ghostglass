/**
 * Diff page header: title, the two run cards, and the summary comparison
 * table (A / B / Δ for durations, counts, exit codes). Descriptive only —
 * a larger number is never presented as worse.
 */
import type { DiffStore } from "./diffStore.js";
import type { DeltaNumber, SummaryDiff } from "./types.js";
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
    this.host.appendChild(wrap);
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
