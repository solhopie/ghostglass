/**
 * Cause Chain view (Run 7): focused execution-path display.
 *
 * Activated from the inspector's "Show Cause Chain" button. Shows one
 * contributing path at a time as a vertical chain; the rest of the graph
 * is dimmed behind this overlay. Clicking a step seeks the replay
 * timeline to that moment.
 *
 * All trace strings are rendered via textContent — never as HTML.
 */
import type { Store } from "./store.js";
import type { WhyTarget } from "./api.js";
import { getCauseChain } from "./api.js";
import type { CauseChain, CauseNode } from "./cause/index.js";
import { el, text, formatOffset } from "./format.js";

const KIND_CLASS: Record<string, string> = {
  "root-command": "cc-root",
  process: "cc-process",
  event: "cc-event",
  file: "cc-file",
  network: "cc-network",
  highlight: "cc-highlight",
};

/** Serialize a WhyTarget for a ?why= deep link (e.g. ?why=file%3A%2Ftmp%2Fx). */
export function serializeWhyTarget(target: WhyTarget): string {
  switch (target.target) {
    case "event":
      return `event:${target.eventId}`;
    case "pid":
      return `pid:${target.pid}`;
    case "file":
      return `file:${target.path}`;
    case "network":
      return `network:${target.destination}`;
    case "highlight":
      return `highlight:${target.highlightId}`;
  }
}

/** Parse a ?why= deep link back into a WhyTarget; null when malformed. */
export function parseWhyTarget(raw: string | null): WhyTarget | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const kind = raw.slice(0, i);
  const value = raw.slice(i + 1);
  if (!value) return null;
  switch (kind) {
    case "event":
      return { target: "event", eventId: value };
    case "pid": {
      const pid = Number(value);
      return Number.isInteger(pid) && pid >= 0 ? { target: "pid", pid } : null;
    }
    case "file":
      return { target: "file", path: value };
    case "network":
      return { target: "network", destination: value };
    case "highlight":
      return { target: "highlight", highlightId: value };
    default:
      return null;
  }
}

export class CauseChainView {
  private root: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("causechain", () => this.render());
  }

  /** Fetch a chain for a target in the given run and display it. */
  async showFor(runId: string, target: WhyTarget): Promise<void> {
    this.store.causeLoading = true;
    this.store.causeError = null;
    this.store.emit("causechain");
    try {
      const res = await getCauseChain(runId, target);
      this.store.causeLoading = false;
      this.store.setCauseChain(res.chain);
    } catch (err) {
      this.store.causeLoading = false;
      // The API returns { error } JSON on 4xx; surface it honestly.
      let message = "Could not build a cause chain for this target.";
      if (err instanceof Error && err.message) {
        try {
          const parsed = JSON.parse(err.message) as { error?: string; ambiguous?: { matches?: string[] } };
          if (parsed.error) {
            message = parsed.error;
            if (parsed.ambiguous?.matches) {
              message += " Matches: " + parsed.ambiguous.matches.join(", ");
            }
          }
        } catch {
          message = err.message;
        }
      }
      this.store.causeError = message;
      this.store.emit("causechain");
    }
  }

  hide(): void {
    this.store.setCauseChain(null);
  }

  render(): void {
    this.host.innerHTML = "";
    this.root = null;
    const loading = this.store.causeLoading;
    const err = this.store.causeError;
    const chain = this.store.causeChain;
    if (!loading && !err && !chain) return;

    const overlay = el("div", "cc-overlay");
    const panel = el("div", "cc-panel");
    overlay.appendChild(panel);

    const header = el("div", "cc-header");
    const title = el("div", "cc-title");
    text(title, "Cause Chain");
    header.appendChild(title);
    const sub = el("div", "cc-subtitle");
    text(sub, "Execution path leading to this event — recorded relationships only, no intent inferred.");
    header.appendChild(sub);
    const close = el("button", "cc-close");
    text(close, "Back to Full Graph");
    close.addEventListener("click", () => this.hide());
    header.appendChild(close);
    panel.appendChild(header);

    if (loading) {
      const l = el("div", "cc-loading");
      text(l, "Building cause chain…");
      panel.appendChild(l);
    } else if (err) {
      const e = el("div", "cc-error");
      text(e, err);
      panel.appendChild(e);
    } else if (chain) {
      this.renderChain(panel, chain);
    }

    // Clicking the dimmed backdrop closes the overlay.
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) this.hide();
    });
    this.host.appendChild(overlay);
    this.root = overlay;
  }

  private renderChain(panel: HTMLElement, chain: CauseChain): void {
    const idx = this.store.causePathIndex;
    const path = chain.paths[idx];
    if (!path) return;

    // Target + confidence row.
    const meta = el("div", "cc-meta");
    const targetLine = el("div", "cc-target");
    text(targetLine, `Target: ${chain.targetLabel}`);
    meta.appendChild(targetLine);
    const conf = el("span", `cc-confidence cc-${chain.confidence}`);
    text(conf, chain.confidence.toUpperCase());
    meta.appendChild(conf);
    panel.appendChild(meta);

    // Path navigation for multiple contributing paths.
    if (chain.paths.length > 1) {
      const nav = el("div", "cc-nav");
      const prev = el("button", "cc-navbtn");
      text(prev, "‹ Previous Cause");
      prev.addEventListener("click", () => this.store.setCausePathIndex(idx - 1));
      const label = el("span", "cc-navlabel");
      text(label, `Cause ${idx + 1} of ${chain.paths.length}: ${path.label}`);
      const next = el("button", "cc-navbtn");
      text(next, "Next Cause ›");
      next.addEventListener("click", () => this.store.setCausePathIndex(idx + 1));
      nav.appendChild(prev);
      nav.appendChild(label);
      nav.appendChild(next);
      panel.appendChild(nav);
    }

    // The focused chain: vertical node list.
    const list = el("div", "cc-list");
    path.nodes.forEach((node, i) => {
      if (i > 0) {
        const edge = path.edges.find((e) => e.to === node.id);
        const conn = el("div", "cc-connector");
        const arrow = el("div", "cc-arrow");
        text(arrow, "▼");
        conn.appendChild(arrow);
        if (edge) {
          const kind = el("div", "cc-edgekind");
          text(kind, edge.kind);
          conn.appendChild(kind);
          if (edge.evidence) {
            const ev = el("div", "cc-edge-evidence");
            text(ev, edge.evidence);
            conn.appendChild(ev);
          }
        }
        list.appendChild(conn);
      }
      list.appendChild(this.renderNode(node));
    });
    panel.appendChild(list);

    const fit = el("button", "cc-fit");
    text(fit, "Fit Chain");
    fit.addEventListener("click", () => {
      list.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    panel.appendChild(fit);

    // Explanation.
    const explHead = el("div", "cc-section-head");
    text(explHead, "Explanation");
    panel.appendChild(explHead);
    const expl = el("div", "cc-expl");
    text(expl, chain.explanation);
    panel.appendChild(expl);

    // Evidence panel.
    const evHead = el("div", "cc-section-head");
    text(evHead, "Evidence");
    panel.appendChild(evHead);
    const evList = el("div", "cc-evidence");
    for (const line of chain.evidence) {
      const row = el("div", "cc-evidence-row");
      text(row, line);
      evList.appendChild(row);
    }
    panel.appendChild(evList);
  }

  private renderNode(node: CauseNode): HTMLElement {
    const wrap = el("button", `cc-node ${KIND_CLASS[node.kind] ?? ""}`);
    const kind = el("div", "cc-node-kind");
    text(kind, node.kind.toUpperCase().replace("-", " "));
    wrap.appendChild(kind);
    const label = el("div", "cc-node-label");
    text(label, node.label);
    wrap.appendChild(label);
    if (node.detail) {
      const detail = el("div", "cc-node-detail");
      text(detail, node.detail);
      wrap.appendChild(detail);
    }
    if (node.timestamp !== undefined) {
      const ts = el("div", "cc-node-ts");
      text(ts, `+${formatOffset(node.timestamp - this.store.startTimeMs)} — click to seek`);
      wrap.appendChild(ts);
      wrap.addEventListener("click", () => {
        if (node.timestamp !== undefined) this.store.seekToCauseNode(node.timestamp);
      });
    } else {
      wrap.setAttribute("disabled", "");
    }
    return wrap;
  }
}
