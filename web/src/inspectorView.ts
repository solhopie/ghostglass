/**
 * Inspector panel: details for the selected graph node or event.
 * All trace strings are rendered via textContent — never as HTML.
 */
import type { Store } from "./store.js";
import type { GhostGlassEvent, GraphNode, Highlight } from "./types.js";
import type { WhyTarget } from "./api.js";
import { describeEvent, el, formatCount, formatDuration, formatOffset, text } from "./format.js";

export class InspectorView {
  private body: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
    private readonly onWhy?: ((target: WhyTarget) => void) | undefined,
  ) {
    store.on("selection", () => this.update());
    store.on("data", () => this.update());
  }

  /** "Show Cause Chain" button; no-op when no handler is wired. */
  private whyButton(body: HTMLElement, target: WhyTarget): void {
    if (!this.onWhy) return;
    const btn = el("button", "why-btn");
    text(btn, "Show Cause Chain");
    btn.addEventListener("click", () => this.onWhy?.(target));
    body.appendChild(btn);
  }

  render(): void {
    this.host.innerHTML = "";
    const panel = el("div", "inspector-panel");
    const title = el("div", "panel-title");
    text(title, "Inspector");
    panel.appendChild(title);
    this.body = el("div", "inspector-body");
    panel.appendChild(this.body);
    this.host.appendChild(panel);
    this.update();
  }

  update(): void {
    const body = this.body;
    if (!body) return;
    body.innerHTML = "";
    const sel = this.store.selection;
    if (sel?.kind === "node") {
      const node = this.store.nodeById.get(sel.nodeId);
      if (node) this.renderNode(body, node);
      else this.renderEmpty(body);
    } else if (sel?.kind === "event") {
      const e = this.store.events[sel.index];
      if (e) this.renderEvent(body, e);
      else this.renderEmpty(body);
    } else if (sel?.kind === "highlight") {
      const h = this.store.highlights.find((x) => x.id === sel.highlightId);
      if (h) this.renderHighlight(body, h);
      else this.renderEmpty(body);
    } else {
      this.renderEmpty(body);
    }
  }

  private renderEmpty(body: HTMLElement): void {
    const hint = el("div", "inspector-hint");
    text(hint, "Select a node in the graph or an event in the stream to inspect it.");
    body.appendChild(hint);
    const s = this.store.summary;
    if (s) {
      body.appendChild(this.kv("Events recorded", formatCount(this.store.eventsTotal)));
      body.appendChild(this.kv("Replay position", formatOffset(this.store.tMs)));
    }
  }

  private kv(k: string, v: string): HTMLElement {
    const row = el("div", "kv");
    const key = el("span", "kv-k");
    text(key, k);
    const val = el("span", "kv-v");
    text(val, v);
    row.appendChild(key);
    row.appendChild(val);
    return row;
  }

  private heading(body: HTMLElement, kind: string, title: string): void {
    const h = el("div", "inspector-head");
    const badge = el("span", `kind-badge kind-${kind}`);
    text(badge, kind.toUpperCase());
    const t = el("span", "inspector-title");
    text(t, title);
    h.appendChild(badge);
    h.appendChild(t);
    body.appendChild(h);
  }

  private num(stats: Record<string, unknown>, key: string): number {
    const v = stats[key];
    return typeof v === "number" ? v : 0;
  }

  private renderNode(body: HTMLElement, node: GraphNode): void {
    if (node.kind === "root") {
      const m = this.store.metadata;
      this.heading(body, "command", node.label);
      if (m) {
        body.appendChild(this.kv("Run ID", m.runId));
        body.appendChild(this.kv("Duration", formatDuration(m.durationMs)));
        body.appendChild(this.kv("Exit code", m.exitCode == null ? `signal ${m.signal ?? "?"}` : String(m.exitCode)));
        body.appendChild(this.kv("Backend", m.backend));
        if (m.interrupted) body.appendChild(this.kv("Status", "interrupted (partial trace)"));
      }
      body.appendChild(this.kv("Processes", formatCount(this.store.graph?.nodes.filter((n) => n.kind === "process").length ?? 0)));
      return;
    }
    if (node.kind === "process") {
      this.heading(body, "process", node.label);
      if (node.executable) body.appendChild(this.kv("Executable", node.executable));
      if (node.pid != null) body.appendChild(this.kv("PID", String(node.pid)));
      if (node.parentPid != null) {
        body.appendChild(this.kv("Parent PID", `${node.parentPid} (${this.store.pidLabel(node.parentPid)})`));
      }
      if (node.live) {
        const st =
          node.live.status === "running"
            ? "RUNNING"
            : node.live.code != null
              ? `EXITED (code ${node.live.code})`
              : "EXITED";
        body.appendChild(this.kv("Status", st));
      }
      body.appendChild(this.kv("Started", `+${formatOffset(node.firstSeenMs)}`));
      const s = node.stats;
      body.appendChild(this.kv("Files read", formatCount(this.num(s, "filesRead"))));
      body.appendChild(this.kv("Files written", formatCount(this.num(s, "filesWritten"))));
      body.appendChild(this.kv("Files created", formatCount(this.num(s, "filesCreated"))));
      body.appendChild(this.kv("Files deleted", formatCount(this.num(s, "filesDeleted"))));
      body.appendChild(this.kv("Network connects", formatCount(this.num(s, "networkConnects"))));
      body.appendChild(this.kv("Child processes", formatCount(this.num(s, "childProcesses"))));
      body.appendChild(this.kv("Total events", formatCount(node.eventCount)));
      if (node.pid != null) this.whyButton(body, { target: "pid", pid: node.pid });
      return;
    }
    if (node.kind === "file") {
      this.heading(body, "file", node.label);
      body.appendChild(this.kv("Path", node.sublabel));
      const s = node.stats;
      body.appendChild(this.kv("Read", formatCount(this.num(s, "read"))));
      body.appendChild(this.kv("Write", formatCount(this.num(s, "write"))));
      body.appendChild(this.kv("Create", formatCount(this.num(s, "create"))));
      body.appendChild(this.kv("Delete", formatCount(this.num(s, "delete"))));
      body.appendChild(this.kv("First activity", `+${formatOffset(node.firstSeenMs)}`));
      body.appendChild(this.kv("Last activity", `+${formatOffset(node.lastSeenMs)}`));
      const touched = s["touchedBy"];
      if (Array.isArray(touched) && touched.length > 0) {
        const h = el("div", "kv-section");
        text(h, "Touched by");
        body.appendChild(h);
        for (const t of touched as { pid: number; label: string }[]) {
          body.appendChild(this.kv(t.label, `PID ${t.pid}`));
        }
      }
      this.whyButton(body, { target: "file", path: node.sublabel });
      return;
    }
    // network
    this.heading(body, "network", node.label);
    body.appendChild(this.kv("Destination", node.label));
    const s = node.stats;
    body.appendChild(this.kv("Connection attempts", formatCount(this.num(s, "attempts"))));
    body.appendChild(this.kv("First connection", `+${formatOffset(node.firstSeenMs)}`));
    const procs = s["processes"];
    if (Array.isArray(procs) && procs.length > 0) {
      const h = el("div", "kv-section");
      text(h, "Processes");
      body.appendChild(h);
      for (const p of procs as { pid: number; label: string }[]) {
        body.appendChild(this.kv(p.label, `PID ${p.pid}`));
      }
    }
    const note = el("div", "inspector-note");
    text(note, "Hostnames are never guessed — only the observed IP and port are shown.");
    body.appendChild(note);
    this.whyButton(body, { target: "network", destination: node.label });
  }

  private renderHighlight(body: HTMLElement, h: Highlight): void {
    this.heading(body, "highlight", h.title);
    this.whyButton(body, { target: "highlight", highlightId: h.id });
    body.appendChild(this.kv("Severity", `${h.severity} (behavioral magnitude, not risk)`));
    body.appendChild(this.kv("Rule", h.rule));
    body.appendChild(this.kv("At", `+${formatOffset(h.startTimestamp - this.store.startTimeMs)}`));
    if (h.endTimestamp !== undefined) {
      body.appendChild(this.kv("Window", `${((h.endTimestamp - h.startTimestamp) / 1000).toFixed(1)}s`));
    }
    if (h.pid !== undefined) {
      body.appendChild(this.kv("Process", `${this.store.pidLabel(h.pid)} (PID ${h.pid})`));
    }
    const why = el("div", "kv-section");
    text(why, "Why this highlight exists");
    body.appendChild(why);
    const expl = el("div", "inspector-expl");
    text(expl, h.explanation);
    body.appendChild(expl);
    body.appendChild(this.kv("Related events", String(h.relatedEventIds.length)));
    const meta = h.metadata;
    const keys = Object.keys(meta).filter((k) => k !== "category");
    if (keys.length > 0) {
      const det = el("div", "kv-section");
      text(det, "Details");
      body.appendChild(det);
      for (const k of keys) {
        const v = meta[k];
        if (v === undefined || v === null) continue;
        body.appendChild(this.kv(k, typeof v === "object" ? JSON.stringify(v) : String(v)));
      }
    }
  }

  private renderEvent(body: HTMLElement, e: GhostGlassEvent): void {
    this.heading(body, e.type, describeEvent(e, (pid) => this.store.pidLabel(pid)));
    this.whyButton(body, { target: "event", eventId: e.id });
    body.appendChild(this.kv("Event", e.id));
    body.appendChild(this.kv("Action", e.action));
    body.appendChild(this.kv("Process", `${this.store.pidLabel(e.pid)} (PID ${e.pid})`));
    body.appendChild(this.kv("At", `+${formatOffset(e.timestamp - this.store.startTimeMs)}`));
    if (e.executable) body.appendChild(this.kv("Executable", e.executable));
    if (e.path) body.appendChild(this.kv("Path", e.path));
    const newPath = e.metadata?.["newPath"];
    if (typeof newPath === "string") body.appendChild(this.kv("New path", newPath));
    if (e.ip) body.appendChild(this.kv("Destination", `${e.ip}:${e.port ?? "?"}`));
    const code = e.metadata?.["code"];
    if (typeof code === "number") body.appendChild(this.kv("Exit code", String(code)));

    const meta = e.metadata;
    if (meta && Object.keys(meta).length > 0) {
      const h = el("div", "kv-section");
      text(h, "Raw details");
      body.appendChild(h);
      const pre = el("pre", "inspector-meta");
      const shown: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(meta)) {
        if (k === "newPath" || k === "code") continue;
        shown[k] = v;
      }
      text(pre, JSON.stringify(shown, null, 2));
      body.appendChild(pre);
    }
  }
}
