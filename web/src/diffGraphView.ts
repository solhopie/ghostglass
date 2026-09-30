/**
 * Combined comparison graph: one node per matched entity, styled by
 * DiffStatus. Status is never color-alone: each node carries a text badge
 * (SHARED / CHANGED / ONLY A / ONLY B) and a distinct border style
 * (solid / thick / dashed / dotted), explained in the legend.
 *
 * Same interaction language as the replay graph: pan, zoom, node drag,
 * fit, reset, neighbor highlighting, and click-to-inspect.
 */
import type { DiffStore, GraphMode } from "./diffStore.js";
import { statusBadge } from "./diffStore.js";
import type { DiffGraphEdge, DiffGraphNode, DiffStatus } from "./types.js";
import { el, formatCount, svgEl, svgText, text } from "./format.js";

const NODE_W = 248;
const NODE_H = 58;
const X_PROC = 24;
const X_FILE = 320;
const X_NET = 624;
const PROC_STEP = 118;
const ENT_STEP = 72;

interface Placed {
  node: DiffGraphNode;
  x: number;
  y: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function countText(n: DiffGraphNode): string {
  const a = n.a?.eventCount ?? 0;
  const b = n.b?.eventCount ?? 0;
  if (n.status === "only-a") return formatCount(a);
  if (n.status === "only-b") return formatCount(b);
  return `${formatCount(a)} / ${formatCount(b)}`;
}

export class DiffGraphView {
  private svg: SVGSVGElement | null = null;
  private viewport: SVGGElement | null = null;
  private placed: Placed[] = [];
  private placedById = new Map<string, Placed>();
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls: { edge: DiffGraphEdge; el: SVGPathElement }[] = [];
  private edgesByNode = new Map<string, Set<string>>();
  private tx = 24;
  private ty = 24;
  private k = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: DiffStore,
  ) {
    store.on("data", () => this.render());
    store.on("filters", () => this.render());
    store.on("selection", () => this.updateSelection());
  }

  render(): void {
    const diff = this.store.diff;
    this.host.innerHTML = "";
    this.nodeEls.clear();
    this.edgeEls = [];
    this.edgesByNode.clear();
    this.placed = [];
    this.placedById.clear();

    const title = el("h2", "diff-section-title");
    text(title, "Combined Execution Graph");
    this.host.appendChild(title);
    this.host.appendChild(this.buildToolbar());

    const wrap = el("div", "graph-canvas");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("graph-svg");
    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g") as unknown as SVGGElement;
    svg.appendChild(viewport);
    wrap.appendChild(svg);
    this.host.appendChild(wrap);
    this.svg = svg;
    this.viewport = viewport;

    if (!diff || diff.graph.nodes.length === 0) {
      const empty = el("div", "graph-empty");
      text(empty, diff ? "No entities match the current filters." : "Loading comparison…");
      wrap.appendChild(empty);
      return;
    }

    const nodes = this.store.visibleNodes();
    const ids = new Set(nodes.map((n) => n.id));
    const edges = diff.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));

    this.layout(nodes);
    this.drawEdges(edges);
    this.drawNodes();
    this.bindPanZoom(svg);
    this.fitView();
    this.updateSelection();

    if (diff.graph.truncated) {
      const note = el("div", "graph-note");
      text(
        note,
        `Showing ${formatCount(nodes.filter((n) => n.kind === "file").length)} of ` +
          `${formatCount(diff.graph.totalFileEntities)} file entities (capped for rendering).`,
      );
      this.host.appendChild(note);
    }
  }

  // ---------- layout ----------

  private firstSeen(n: DiffGraphNode): number {
    return Math.min(n.a?.firstSeenMs ?? Infinity, n.b?.firstSeenMs ?? Infinity);
  }

  private layout(nodes: DiffGraphNode[]): void {
    const rank = (s: DiffStatus): number =>
      s === "changed" ? 0 : s === "only-a" ? 1 : s === "only-b" ? 2 : 3;

    // process tree from spawn edges (shared topology where it exists)
    const graph = this.store.diff?.graph;
    const spawnChildren = new Map<string, string[]>();
    const hasParent = new Set<string>();
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of graph?.edges ?? []) {
      if (e.kind !== "spawn" || !ids.has(e.from) || !ids.has(e.to)) continue;
      let list = spawnChildren.get(e.from);
      if (!list) {
        list = [];
        spawnChildren.set(e.from, list);
      }
      if (!list.includes(e.to)) list.push(e.to);
      hasParent.add(e.to);
    }
    const procs = nodes
      .filter((n) => n.kind === "process")
      .sort((a, b) => this.firstSeen(a) - this.firstSeen(b));
    const roots = procs.filter((p) => !hasParent.has(p.id));
    const ordered: DiffGraphNode[] = [];
    const seen = new Set<string>();
    const visit = (n: DiffGraphNode): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      ordered.push(n);
      for (const c of spawnChildren.get(n.id) ?? []) {
        const cn = this.store.nodeById.get(c);
        if (cn && ids.has(c)) visit(cn);
      }
    };
    for (const r of roots) visit(r);
    for (const p of procs) if (!seen.has(p.id)) visit(p);

    ordered.forEach((n, i) => this.place(n, X_PROC, i * PROC_STEP));

    const files = nodes
      .filter((n) => n.kind === "file")
      .sort((a, b) => rank(a.status) - rank(b.status) || this.firstSeen(a) - this.firstSeen(b));
    files.forEach((n, i) => this.place(n, X_FILE, i * ENT_STEP));

    const nets = nodes
      .filter((n) => n.kind === "network")
      .sort((a, b) => rank(a.status) - rank(b.status) || this.firstSeen(a) - this.firstSeen(b));
    nets.forEach((n, i) => this.place(n, X_NET, i * ENT_STEP));

    // column captions
    this.caption(X_PROC, "PROCESSES", ordered.length);
    this.caption(X_FILE, "FILES", files.length);
    this.caption(X_NET, "NETWORK", nets.length);
  }

  private caption(x: number, label: string, count: number): void {
    const vp = this.viewport as unknown as SVGElement;
    const t = svgText(vp, `${label} · ${count}`, {
      x: String(x + 4),
      y: "-14",
      class: "graph-col-caption",
    });
    void t;
  }

  private place(n: DiffGraphNode, x: number, y: number): void {
    const p: Placed = { node: n, x, y };
    this.placed.push(p);
    this.placedById.set(n.id, p);
  }

  // ---------- drawing ----------

  private edgePath(e: DiffGraphEdge): string {
    const a = this.placedById.get(e.from);
    const b = this.placedById.get(e.to);
    if (!a || !b) return "";
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (e.kind === "spawn") {
      const bx = Math.min(a.x, b.x) - 42;
      return `M ${a.x} ${y1} C ${bx} ${y1}, ${bx} ${y2}, ${b.x} ${y2}`;
    }
    const dx = Math.max(48, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  private drawEdges(edges: DiffGraphEdge[]): void {
    const vp = this.viewport as unknown as SVGElement;
    for (const e of edges) {
      const path = svgEl("path", {
        d: this.edgePath(e),
        class: `dedge dedge-${e.status}`,
      }) as SVGPathElement;
      vp.appendChild(path);
      this.edgeEls.push({ edge: e, el: path });
      for (const id of [e.from, e.to]) {
        let set = this.edgesByNode.get(id);
        if (!set) {
          set = new Set();
          this.edgesByNode.set(id, set);
        }
        set.add(e.from === id ? e.to : e.from);
      }
    }
  }

  private drawNodes(): void {
    const vp = this.viewport as unknown as SVGElement;
    for (const p of this.placed) {
      const n = p.node;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g") as unknown as SVGGElement;
      g.setAttribute("class", `dnode dnode-${n.kind} dst-${n.status}`);
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      g.dataset.nodeId = n.id;

      const rect = svgEl("rect", {
        width: String(NODE_W),
        height: String(NODE_H),
        rx: "9",
        class: "dnode-box",
      });
      g.appendChild(rect);

      // status badge: text label, never color alone
      const badge = statusBadge(n.status);
      const bw = badge.length * 7 + 14;
      const badgeRect = svgEl("rect", {
        x: String(NODE_W - bw - 8),
        y: "6",
        width: String(bw),
        height: "18",
        rx: "9",
        class: `dbadge dbadge-${n.status}`,
      });
      g.appendChild(badgeRect);
      const badgeText = svgText(g, badge, {
        x: String(NODE_W - bw / 2 - 8),
        y: "19",
        class: "dbadge-text",
      });
      badgeText.setAttribute("text-anchor", "middle");

      const label = svgText(g, truncate(n.label, 26), { x: "14", y: "24", class: "node-label" });
      label.setAttribute("title", n.label);
      svgText(g, truncate(n.sublabel, 32), { x: "14", y: "40", class: "node-sub" });
      const count = svgText(g, countText(n), {
        x: String(NODE_W - 12),
        y: "50",
        class: "node-count",
      });
      count.setAttribute("text-anchor", "end");

      if (n.ambiguous) {
        const amb = svgText(g, "≈ ambiguous match", { x: "14", y: "52", class: "node-amb" });
        void amb;
      }

      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.store.select(this.store.selection === n.id ? null : n.id);
      });
      g.addEventListener("mouseenter", () => this.highlightNeighbors(n.id));
      g.addEventListener("mouseleave", () => this.clearHighlight());
      g.addEventListener("pointerdown", (ev) => this.startNodeDrag(ev, p, g));

      vp.appendChild(g);
      this.nodeEls.set(n.id, g);
    }
  }

  // ---------- toolbar ----------

  private buildToolbar(): HTMLElement {
    const bar = el("div", "graph-toolbar");

    const mkBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "tool-btn";
      text(b, label);
      b.title = title;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    mkBtn("+", "Zoom in", () => this.zoomBy(1.25));
    mkBtn("−", "Zoom out", () => this.zoomBy(1 / 1.25));
    mkBtn("Fit", "Fit graph to screen", () => this.fitView());
    mkBtn("Reset", "Reset pan and zoom", () => this.resetView());

    const sep = el("span", "tool-sep");
    bar.appendChild(sep);

    const modes: [GraphMode, string][] = [
      ["differences", "Differences Only"],
      ["all", "All"],
      ["only-a", "Only A"],
      ["only-b", "Only B"],
      ["shared", "Shared"],
    ];
    for (const [mode, label] of modes) {
      const b = document.createElement("button");
      b.className = "tool-btn tool-toggle" + (this.store.graphMode === mode ? " on" : "");
      b.dataset.mode = mode;
      text(b, label);
      b.title = mode === "differences" ? "Hide shared noise; show only what differs" : `Show ${label.toLowerCase()} entities`;
      b.addEventListener("click", () => {
        this.store.setGraphMode(mode);
        for (const btn of Array.from(bar.querySelectorAll<HTMLButtonElement>("[data-mode]"))) {
          btn.classList.toggle("on", btn.dataset.mode === mode);
        }
      });
      bar.appendChild(b);
    }

    const sep2 = el("span", "tool-sep");
    bar.appendChild(sep2);

    const mkKind = (
      label: string,
      on: boolean,
      fn: (v: boolean) => void,
    ): void => {
      const b = document.createElement("button");
      b.className = "tool-btn tool-toggle" + (on ? " on" : "");
      text(b, label);
      b.addEventListener("click", () => {
        const next = !b.classList.contains("on");
        b.classList.toggle("on", next);
        fn(next);
      });
      bar.appendChild(b);
    };
    mkKind("Processes", this.store.showProcesses, (v) => this.store.setKindVisible("process", v));
    mkKind("Files", this.store.showFiles, (v) => this.store.setKindVisible("file", v));
    mkKind("Network", this.store.showNetwork, (v) => this.store.setKindVisible("network", v));

    const legend = el("span", "graph-legend");
    const entries: [DiffStatus, string][] = [
      ["shared", "Shared (solid)"],
      ["changed", "Changed (thick)"],
      ["only-a", "Only A (dashed)"],
      ["only-b", "Only B (dotted)"],
    ];
    for (const [status, name] of entries) {
      const item = el("span", `dlegend-item dlegend-${status}`);
      text(item, name);
      legend.appendChild(item);
    }
    bar.appendChild(legend);
    return bar;
  }

  // ---------- pan / zoom / drag ----------

  private applyTransform(): void {
    this.viewport?.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.k})`);
  }

  private zoomBy(factor: number, cx?: number, cy?: number): void {
    const svg = this.svg;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const k2 = Math.max(0.15, Math.min(3, this.k * factor));
    this.tx = px - ((px - this.tx) / this.k) * k2;
    this.ty = py - ((py - this.ty) / this.k) * k2;
    this.k = k2;
    this.applyTransform();
  }

  private bindPanZoom(svg: SVGSVGElement): void {
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    let panning = false;
    let sx = 0;
    let sy = 0;
    svg.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest(".dnode")) return;
      panning = true;
      sx = e.clientX;
      sy = e.clientY;
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture is best-effort; panning works without it */
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!panning) return;
      this.tx += e.clientX - sx;
      this.ty += e.clientY - sy;
      sx = e.clientX;
      sy = e.clientY;
      this.applyTransform();
    });
    const end = (): void => {
      panning = false;
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  }

  private startNodeDrag(e: PointerEvent, p: Placed, g: SVGGElement): void {
    e.stopPropagation();
    const svg = this.svg;
    if (!svg) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = p.x;
    const origY = p.y;
    let moved = false;
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startX) / this.k;
      const dy = (ev.clientY - startY) / this.k;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      p.x = origX + dx;
      p.y = origY + dy;
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      this.refreshEdges(p.node.id);
    };
    const up = (): void => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      if (moved) {
        g.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { capture: true, once: true });
      }
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  }

  private refreshEdges(nodeId: string): void {
    for (const { edge, el } of this.edgeEls) {
      if (edge.from === nodeId || edge.to === nodeId) {
        el.setAttribute("d", this.edgePath(edge));
      }
    }
  }

  private contentBBox(): { x: number; y: number; w: number; h: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of this.placed) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y - 30);
      x1 = Math.max(x1, p.x + NODE_W);
      y1 = Math.max(y1, p.y + NODE_H);
    }
    if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  fitView(): void {
    const svg = this.svg;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const bb = this.contentBBox();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const k = Math.max(0.15, Math.min(1.5, Math.min(w / (bb.w + 80), h / (bb.h + 80))));
    this.k = k;
    this.tx = (w - bb.w * k) / 2 - bb.x * k;
    this.ty = (h - bb.h * k) / 2 - bb.y * k;
    this.applyTransform();
  }

  private resetView(): void {
    this.k = 1;
    this.tx = 24;
    this.ty = 24;
    this.applyTransform();
  }

  // ---------- highlight / selection ----------

  private highlightNeighbors(id: string): void {
    const keep = new Set<string>([id, ...(this.edgesByNode.get(id) ?? [])]);
    for (const [nid, g] of this.nodeEls) g.classList.toggle("faded", !keep.has(nid));
    for (const { edge, el } of this.edgeEls) {
      el.classList.toggle("faded", edge.from !== id && edge.to !== id);
    }
  }

  private clearHighlight(): void {
    for (const g of this.nodeEls.values()) g.classList.remove("faded");
    for (const { el } of this.edgeEls) el.classList.remove("faded");
  }

  private updateSelection(): void {
    for (const [nid, g] of this.nodeEls) {
      g.classList.toggle("selected", this.store.selection === nid);
    }
  }
}
