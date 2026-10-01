/**
 * Diff inspector: details for the selected comparison node.
 *
 * Process, file, and network inspectors each show Run A / Run B side
 * stats plus the Δ between them. Everything is rendered as inert text —
 * trace data is untrusted.
 */
import type { DiffStore } from "./diffStore.js";
import type {
  DiffGraphNode,
  FileDiffEntity,
  NetworkDiffEntity,
  ProcessDiffEntity,
} from "./types.js";
import type { WhyTarget } from "./api.js";
import { el, formatCount, formatOffset, text } from "./format.js";
import { serializeWhyTarget } from "./causeChainView.js";
import { isStaticExport } from "./staticData.js";

function deltaLine(a: number, b: number): string {
  const d = b - a;
  if (d === 0) return "±0";
  return `${d > 0 ? "+" : "−"}${formatCount(Math.abs(d))}`;
}

export class DiffInspectorView {
  constructor(
    private readonly host: HTMLElement,
    private readonly store: DiffStore,
  ) {
    store.on("data", () => this.render());
    store.on("selection", () => this.render());
  }

  render(): void {
    this.host.innerHTML = "";
    const sel = this.store.selection;
    const node = sel ? this.store.nodeById.get(sel) : undefined;
    if (!node) {
      const empty = el("div", "diff-inspector-empty");
      text(empty, "Select a node in the graph or a row in the changes list to inspect it.");
      this.host.appendChild(empty);
      return;
    }
    const entity = this.store.entityFor(node.kind, node.fingerprint);
    const wrap = el("div", "diff-inspector");
    const title = el("h3", "diff-inspector-title");
    if (node.kind === "process") {
      text(title, "Process Difference");
      this.processBody(wrap, node, entity as ProcessDiffEntity | undefined);
    } else if (node.kind === "file") {
      text(title, "File Difference");
      this.fileBody(wrap, node, entity as FileDiffEntity | undefined);
    } else {
      text(title, "Network Difference");
      this.networkBody(wrap, node, entity as NetworkDiffEntity | undefined);
    }
    wrap.prepend(title);
    this.host.appendChild(wrap);
  }

  private head(wrap: HTMLElement, node: DiffGraphNode, sub: string): void {
    const name = el("div", "diff-inspector-name");
    text(name, node.label);
    wrap.appendChild(name);
    const s = el("div", "diff-inspector-sub");
    text(s, sub);
    wrap.appendChild(s);
  }

  /**
   * Per-side cause-chain buttons. Each side's chain is derived only from
   * that run's own recorded events — never a cross-run inference. Opens
   * the run's replay page with the chain open.
   */
  private whyButtons(
    wrap: HTMLElement,
    targetA: WhyTarget | null,
    targetB: WhyTarget | null,
  ): void {
    // Portable static exports have no /runs/<id> route to open: the diff
    // page is a single self-contained file. Say so honestly instead of
    // opening a broken link.
    if (isStaticExport()) {
      this.note(
        wrap,
        `Cause chains open in the run view, which isn't available inside this portable file. ` +
          `Export each run separately to trace its execution paths.`,
      );
      return;
    }
    const row = el("div", "diff-why-row");
    const mk = (label: string, runId: string, target: WhyTarget | null): void => {
      const btn = el("button", "why-btn");
      text(btn, label);
      if (!target) {
        btn.setAttribute("disabled", "");
        return;
      }
      btn.addEventListener("click", () => {
        const url =
          `/runs/${encodeURIComponent(runId)}?why=${encodeURIComponent(serializeWhyTarget(target))}`;
        window.open(url, "_blank", "noopener");
      });
      row.appendChild(btn);
    };
    mk("Cause Chain — Run A", this.store.runA, targetA);
    mk("Cause Chain — Run B", this.store.runB, targetB);
    wrap.appendChild(row);
  }

  private abTable(
    wrap: HTMLElement,
    rows: [string, string, string, string][],
  ): void {
    const table = document.createElement("table");
    table.className = "diff-inspector-table";
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
    for (const [label, a, b, d] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      text(th, label);
      tr.appendChild(th);
      for (const v of [a, b, d]) {
        const td = document.createElement("td");
        text(td, v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  private note(wrap: HTMLElement, msg: string): void {
    const n = el("div", "diff-inspector-note");
    text(n, msg);
    wrap.appendChild(n);
  }

  private processBody(wrap: HTMLElement, node: DiffGraphNode, e: ProcessDiffEntity | undefined): void {
    this.head(wrap, node, e?.executable ?? node.sublabel);
    if (!e || !e.a || !e.b) {
      const side = e?.a ? "A" : "B";
      const s = (e?.a ?? e?.b);
      if (!s) return;
      this.note(wrap, `Only in Run ${side}.`);
      this.abTable(wrap, [
        ["First seen", formatOffset(s.firstSeenMs), "—", "—"],
        ["Children", formatCount(s.children), "—", "—"],
        ["Files touched", formatCount(s.filesRead + s.filesWritten), "—", "—"],
        ["Network", formatCount(s.networkConnects), "—", "—"],
      ]);
      if (s.parentExecutable) this.note(wrap, `Spawned by ${s.parentExecutable}.`);
      const onlyPid = s.pids[0];
      if (s.pids.length === 1 && onlyPid !== undefined) {
        this.whyButtons(
          wrap,
          side === "A" ? { target: "pid", pid: onlyPid } : null,
          side === "B" ? { target: "pid", pid: onlyPid } : null,
        );
      } else {
        this.note(
          wrap,
          `${s.pids.length} processes share this fingerprint on this side. ` +
            `Cause chains trace individual processes — open the run and select a specific PID.`,
        );
      }
      return;
    }
    if (e.ambiguous) {
      this.note(
        wrap,
        `Ambiguous match: ${e.a.pids.length} process${e.a.pids.length === 1 ? "" : "es"} in Run A and ` +
          `${e.b.pids.length} in Run B share this fingerprint. Stats are aggregated.`,
      );
    }
    const rows: [string, string, string, string][] = [
      ["Children", formatCount(e.a.children), formatCount(e.b.children), deltaLine(e.a.children, e.b.children)],
      ["Files read", formatCount(e.a.filesRead), formatCount(e.b.filesRead), deltaLine(e.a.filesRead, e.b.filesRead)],
      ["Files written", formatCount(e.a.filesWritten), formatCount(e.b.filesWritten), deltaLine(e.a.filesWritten, e.b.filesWritten)],
      ["Files created", formatCount(e.a.filesCreated), formatCount(e.b.filesCreated), deltaLine(e.a.filesCreated, e.b.filesCreated)],
      ["Network", formatCount(e.a.networkConnects), formatCount(e.b.networkConnects), deltaLine(e.a.networkConnects, e.b.networkConnects)],
    ];
    this.abTable(wrap, rows);
    if (e.a.argv) this.note(wrap, `argv: ${e.a.argv.join(" ")}`);
    const pidA = e.a.pids[0];
    const pidB = e.b.pids[0];
    // Ambiguous fingerprints: never silently trace the first PID. Each
    // side gets a button only when it identifies exactly one process.
    const targetA =
      !e.ambiguous && e.a.pids.length === 1 && pidA !== undefined
        ? { target: "pid" as const, pid: pidA }
        : null;
    const targetB =
      !e.ambiguous && e.b.pids.length === 1 && pidB !== undefined
        ? { target: "pid" as const, pid: pidB }
        : null;
    if (e.ambiguous || e.a.pids.length !== 1 || e.b.pids.length !== 1) {
      this.note(
        wrap,
        `Cause chains trace individual processes, not aggregates. ` +
          `Open each run and select a specific PID to see its execution path.`,
      );
    }
    this.whyButtons(wrap, targetA, targetB);
  }

  private fileBody(wrap: HTMLElement, node: DiffGraphNode, e: FileDiffEntity | undefined): void {
    this.head(wrap, node, e?.path ?? node.sublabel);
    if (!e || !e.a || !e.b) {
      const side = e?.a ? "A" : "B";
      const s = e?.a ?? e?.b;
      if (!s) return;
      this.note(wrap, `Only in Run ${side}.`);
      this.abTable(wrap, [
        ["First activity", formatOffset(s.firstSeenMs), "—", "—"],
        ["Events", formatCount(s.eventCount), "—", "—"],
      ]);
      const path = e?.path ?? node.sublabel;
      this.whyButtons(
        wrap,
        side === "A" ? { target: "file", path } : null,
        side === "B" ? { target: "file", path } : null,
      );
      return;
    }
    this.abTable(wrap, [
      ["Reads", formatCount(e.a.read), formatCount(e.b.read), deltaLine(e.a.read, e.b.read)],
      ["Writes", formatCount(e.a.write), formatCount(e.b.write), deltaLine(e.a.write, e.b.write)],
      ["Creates", formatCount(e.a.create), formatCount(e.b.create), deltaLine(e.a.create, e.b.create)],
      ["Deletes", formatCount(e.a.delete), formatCount(e.b.delete), deltaLine(e.a.delete, e.b.delete)],
      ["First activity", formatOffset(e.a.firstSeenMs), formatOffset(e.b.firstSeenMs), "—"],
      ["Last activity", formatOffset(e.a.lastSeenMs), formatOffset(e.b.lastSeenMs), "—"],
    ]);
    const actors = new Map<string, string>();
    for (const t of [...e.a.touchedBy, ...e.b.touchedBy]) {
      const label = t.executable ? t.executable : `PID ${t.pid}`;
      actors.set(label, label);
    }
    if (actors.size > 0) {
      this.note(wrap, `Responsible processes: ${[...actors.keys()].slice(0, 6).join(", ")}`);
    }
    const path = e?.path ?? node.sublabel;
    this.whyButtons(
      wrap,
      { target: "file", path },
      { target: "file", path },
    );
  }

  private networkBody(wrap: HTMLElement, node: DiffGraphNode, e: NetworkDiffEntity | undefined): void {
    this.head(wrap, node, "network destination");
    if (!e || !e.a || !e.b) {
      const side = e?.a ? "A" : "B";
      const s = e?.a ?? e?.b;
      if (!s) return;
      this.note(wrap, `Only in Run ${side}.`);
      this.abTable(wrap, [
        ["Attempts", formatCount(s.attempts), "—", "—"],
        ["First attempt", formatOffset(s.firstSeenMs), "—", "—"],
      ]);
      this.whyButtons(
        wrap,
        side === "A" ? { target: "network", destination: node.label } : null,
        side === "B" ? { target: "network", destination: node.label } : null,
      );
      return;
    }
    this.abTable(wrap, [
      ["Attempts", formatCount(e.a.attempts), formatCount(e.b.attempts), deltaLine(e.a.attempts, e.b.attempts)],
      ["First attempt", formatOffset(e.a.firstSeenMs), formatOffset(e.b.firstSeenMs), "—"],
      ["Last attempt", formatOffset(e.a.lastSeenMs), formatOffset(e.b.lastSeenMs), "—"],
    ]);
    const actors = new Map<string, string>();
    for (const p of [...e.a.processes, ...e.b.processes]) {
      const label = p.executable ? p.executable : `PID ${p.pid}`;
      actors.set(label, label);
    }
    if (actors.size > 0) {
      this.note(wrap, `Connecting processes: ${[...actors.keys()].slice(0, 6).join(", ")}`);
    }
    this.whyButtons(
      wrap,
      { target: "network", destination: node.label },
      { target: "network", destination: node.label },
    );
  }
}
