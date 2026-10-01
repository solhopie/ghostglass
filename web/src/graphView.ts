/**
 * Interactive execution graph: COMMAND → PROCESSES → FILES / NETWORK.
 *
 * Hand-rolled SVG (no graph library): the data is a shallow layered DAG,
 * which suits a column layout, and zero dependencies keeps the viewer
 * fully offline — important for a local-first tool. Supports zoom, pan,
 * node drag, fit-to-screen, neighbor highlighting, kind filtering, and
 * replay-driven activation.
 */
import type { Store } from "./store.js";
import type { GraphEdge, GraphNode } from "./types.js";
import { formatCount, svgEl, svgText } from "./format.js";

const NODE_W = 232;
const NODE_H = 46;
const X_ROOT = 24;
const X_PROC = 320;
const X_ENT = 640;
const PROC_STEP = 112;
const ENT_STEP = 66;
const BAND_GAP = 48;

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class GraphView {
  private svg: SVGSVGElement | null = null;
  private viewport: SVGGElement | null = null;
  private placed: Placed[] = [];
  private placedById = new Map<string, Placed>();
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls: { edge: GraphEdge; el: SVGPathElement }[] = [];
  private edgesByNode = new Map<string, Set<string>>();
  private sortedNodes: GraphNode[] = [];
  private tx = 24;
  private ty = 24;
  private k = 1;
  private lastActiveCount = -1;
  private lastPulseIndex = -1;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("data", () => this.render());
    store.on("graph", () => this.render());
    store.on("replay", () => this.updateReplay());
    store.on("selection", () => {
      this.updateSelection();
      // Pulse the related nodes when a highlight is selected.
      const sel = store.selection;
      if (sel?.kind === "highlight" && store.showHighlights) {
        const h = store.highlights.find((x) => x.id === sel.highlightId);
        if (h) this.pulseNodes(store.nodeIdsForHighlight(h));
      }
    });
    store.on("highlights", () => {
      this.updateHighlightBadges();
      // Pulse newly arrived highlights' nodes (live mode).
      const latest = store.highlights[store.highlights.length - 1];
      if (latest && store.showHighlights) {
        this.pulseNodes(store.nodeIdsForHighlight(latest));
      }
    });
  }

  render(): void {
    const graph = this.store.graph;
    // Preserve the user's pan/zoom across live re-renders; only apply the
    // default view on the very first render.
    const firstRender = this.svg === null;
    const keepK = this.k;
    const keepTx = this.tx;
    const keepTy = this.ty;
    this.host.innerHTML = "";
    this.nodeEls.clear();
    this.edgeEls = [];
    this.edgesByNode.clear();
    this.placed = [];
    this.placedById.clear();
    this.lastActiveCount = -1;
    this.lastPulseIndex = -1;

    const toolbar = this.buildToolbar();
    this.host.appendChild(toolbar);

    const wrap = document.createElement("div");
    wrap.className = "graph-canvas";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("graph-svg");
    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g") as unknown as SVGGElement;
    svg.appendChild(viewport);
    wrap.appendChild(svg);
    this.host.appendChild(wrap);
    this.svg = svg;
    this.viewport = viewport;

    if (!graph || graph.nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "graph-empty";
      empty.textContent = "No trace data loaded.";
      wrap.appendChild(empty);
      return;
    }

    this.layout(graph.nodes, graph.edges);
    this.drawEdges(graph.edges);
    this.drawNodes();
    this.bindPanZoom(svg);
    if (firstRender) {
      this.resetView(false);
    } else {
      this.k = keepK;
      this.tx = keepTx;
      this.ty = keepTy;
      this.applyTransform();
    }
    this.updateReplay();
    this.updateSelection();
    this.updateHighlightBadges();

    if (graph.truncatedFiles > 0) {
      const note = document.createElement("div");
      note.className = "graph-note";
      note.textContent =
        `Showing top ${formatCount(graph.nodeCap)} of ${formatCount(graph.totalUniqueFiles)} files by activity ` +
        `(${formatCount(graph.truncatedFiles)} hidden). Use event search to find a specific path.`;
      this.host.appendChild(note);
    }
  }

  // ---------- layout ----------

  private visibleNodes(all: GraphNode[]): GraphNode[] {
    return all.filter((n) => {
      if (n.kind === "file" && !this.store.showFiles) return false;
      if (n.kind === "network" && !this.store.showNetwork) return false;
      return true;
    });
  }

  private layout(allNodes: GraphNode[], allEdges: GraphEdge[]): void {
    const nodes = this.visibleNodes(allNodes);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter((e) => ids.has(e.from) && ids.has(e.to));

    const procs = nodes
      .filter((n) => n.kind === "process")
      .sort((a, b) => a.firstSeenMs - b.firstSeenMs);
    const root = nodes.find((n) => n.kind === "root");

    // process tree from spawn edges
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (e.kind !== "spawn") continue;
      let list = children.get(e.from);
      if (!list) {
        list = [];
        children.set(e.from, list);
      }
      list.push(e.to);
      hasParent.add(e.to);
    }
    for (const list of children.values()) {
      list.sort((a, b) => {
        const na = this.store.nodeById.get(a);
        const nb = this.store.nodeById.get(b);
        return (na?.firstSeenMs ?? 0) - (nb?.firstSeenMs ?? 0);
      });
    }
    const roots = procs.filter((p) => !hasParent.has(p.id));
    const ordered: GraphNode[] = [];
    const seen = new Set<string>();
    const visit = (n: GraphNode) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      ordered.push(n);
      for (const c of children.get(n.id) ?? []) {
        const cn = this.store.nodeById.get(c);
        if (cn && ids.has(c)) visit(cn);
      }
    };
    for (const r of roots) visit(r);
    for (const p of procs) if (!seen.has(p.id)) visit(p); // orphan safety

    ordered.forEach((n, i) => {
      this.place(n, X_PROC, i * PROC_STEP);
    });
    const procBandH = ordered.length * PROC_STEP;

    // entities grouped under their process, hottest first
    const entByProc = new Map<string, GraphNode[]>();
    for (const e of edges) {
      if (e.kind !== "access" && e.kind !== "connect") continue;
      const target = this.store.nodeById.get(e.to);
      if (!target || !ids.has(target.id)) continue;
      let list = entByProc.get(e.from);
      if (!list) {
        list = [];
        entByProc.set(e.from, list);
      }
      if (!list.some((n) => n.id === target.id)) list.push(target);
    }
    let ey = procBandH + BAND_GAP;
    for (const p of ordered) {
      const list = (entByProc.get(p.id) ?? []).sort((a, b) => b.eventCount - a.eventCount);
      for (const n of list) {
        this.place(n, X_ENT, ey);
        ey += ENT_STEP;
      }
    }

    if (root) {
      const midY = ordered.length > 0 ? ((ordered.length - 1) * PROC_STEP) / 2 : 0;
      this.place(root, X_ROOT, Math.max(0, midY));
    }

    this.sortedNodes = [...nodes].sort((a, b) => a.firstSeenMs - b.firstSeenMs);
  }

  private place(n: GraphNode, x: number, y: number): void {
    const p: Placed = { node: n, x, y };
    this.placed.push(p);
    this.placedById.set(n.id, p);
  }

  // ---------- drawing ----------

  private edgePath(e: GraphEdge): string {
    const a = this.placedById.get(e.from);
    const b = this.placedById.get(e.to);
    if (!a || !b) return "";
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (e.kind === "spawn") {
      // bow left within the process column
      const bx = Math.min(a.x, b.x) - 42;
      return `M ${x1 - NODE_W} ${y1} C ${bx} ${y1}, ${bx} ${y2}, ${x2 - NODE_W} ${y2}`;
    }
    const dx = Math.max(48, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  private drawEdges(edges: GraphEdge[]): void {
    const vp = this.viewport as unknown as SVGElement;
    for (const e of edges) {
      const path = svgEl("path", { d: this.edgePath(e), class: `edge edge-${e.kind}` });
      (path as SVGPathElement).dataset.edge = "1";
      vp.appendChild(path);
      this.edgeEls.push({ edge: e, el: path as SVGPathElement });
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
      g.setAttribute("class", `node node-${n.kind}`);
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      g.dataset.nodeId = n.id;

      const rect = svgEl("rect", {
        width: String(NODE_W),
        height: String(NODE_H),
        rx: "9",
        class: "node-box",
      });
      g.appendChild(rect);

      const dot = svgEl("circle", { cx: "16", cy: String(NODE_H / 2), r: "5", class: "node-dot" });
      g.appendChild(dot);

      const label = svgText(g, truncate(n.label, 28), { x: "30", y: "20", class: "node-label" });
      label.setAttribute("title", n.label);
      svgText(g, truncate(n.sublabel, 34), { x: "30", y: "35", class: "node-sub" });
      const count = svgText(g, formatCount(n.eventCount), { x: String(NODE_W - 10), y: "20", class: "node-count" });
      count.setAttribute("text-anchor", "end");

      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.store.select({ kind: "node", nodeId: n.id });
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
    const bar = document.createElement("div");
    bar.className = "graph-toolbar";

    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "tool-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    mkBtn("+", "Zoom in", () => this.zoomBy(1.25));
    mkBtn("−", "Zoom out", () => this.zoomBy(1 / 1.25));
    mkBtn("Fit", "Fit graph to screen", () => this.fitView());
    mkBtn("Reset", "Reset pan and zoom", () => this.resetView(true));

    const sep = document.createElement("span");
    sep.className = "tool-sep";
    bar.appendChild(sep);

    const mkToggle = (label: string, on: boolean, fn: (v: boolean) => void) => {
      const b = document.createElement("button");
      b.className = "tool-btn tool-toggle" + (on ? " on" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        const next = !b.classList.contains("on");
        b.classList.toggle("on", next);
        fn(next);
      });
      bar.appendChild(b);
      return b;
    };
    mkToggle("Files", this.store.showFiles, (v) =>
      this.store.setGraphFilters(v, this.store.showNetwork),
    );
    mkToggle("Network", this.store.showNetwork, (v) =>
      this.store.setGraphFilters(this.store.showFiles, v),
    );
    mkToggle("Highlights", this.store.showHighlights, (v) => this.store.setShowHighlights(v));

    const legend = document.createElement("span");
    legend.className = "graph-legend";
    for (const [kind, name] of [
      ["root", "command"],
      ["process", "process"],
      ["file", "file"],
      ["network", "network"],
    ] as const) {
      const item = document.createElement("span");
      item.className = `legend-item legend-${kind}`;
      item.textContent = name;
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
      if ((e.target as Element).closest(".node")) return;
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
    const end = () => {
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
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / this.k;
      const dy = (ev.clientY - startY) / this.k;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      p.x = origX + dx;
      p.y = origY + dy;
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
      this.refreshEdges(p.node.id);
    };
    const up = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      if (moved) {
        // suppress the click that follows a drag
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
      y0 = Math.min(y0, p.y);
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
    const k = Math.max(0.15, Math.min(1.5, Math.min(rect.width / (bb.w + 80), rect.height / (bb.h + 80))));
    this.k = k;
    this.tx = (rect.width - bb.w * k) / 2 - bb.x * k;
    this.ty = (rect.height - bb.h * k) / 2 - bb.y * k;
    this.applyTransform();
  }

  resetView(apply: boolean): void {
    this.k = 1;
    this.tx = 24;
    this.ty = 24;
    if (apply) this.applyTransform();
    else this.applyTransform();
  }

  // ---------- highlight / selection / replay ----------

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
    const sel = this.store.selection;
    const spot = new Set(this.store.spotlight);
    for (const [nid, g] of this.nodeEls) {
      g.classList.toggle("selected", sel?.kind === "node" && sel.nodeId === nid);
      g.classList.toggle("spotlight", spot.has(nid));
    }
  }

  /** Badge nodes involved in highlights; called on highlights/data/graph topics. */
  updateHighlightBadges(): void {
    const s = this.store;
    if (!s.showHighlights) {
      for (const [, g] of this.nodeEls) {
        g.classList.remove("hl-badge");
        const b = g.querySelector(".hl-dot");
        b?.remove();
      }
      return;
    }
    const involved = new Set<string>();
    for (const h of s.filteredHighlights()) {
      for (const nid of s.nodeIdsForHighlight(h)) involved.add(nid);
    }
    for (const [nid, g] of this.nodeEls) {
      const has = involved.has(nid);
      g.classList.toggle("hl-badge", has);
      let dot = g.querySelector(".hl-dot");
      if (has && !dot) {
        dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("class", "hl-dot");
        dot.setAttribute("r", "6");
        dot.setAttribute("cx", String(232 - 6));
        dot.setAttribute("cy", "-6");
        g.appendChild(dot);
      } else if (!has && dot) {
        dot.remove();
      }
    }
  }

  /** Cumulative activation: nodes/edges light up once their first event passes. */
  updateReplay(): void {    const t = this.store.tMs;
    // Frontier optimization: only touch the DOM when the active set changed.
    let count = 0;
    for (const n of this.sortedNodes) {
      if (n.firstSeenMs <= t) count++;
      else break;
    }
    if (count !== this.lastActiveCount) {
      this.lastActiveCount = count;
      const active = new Set<string>();
      for (let i = 0; i < count; i++) active.add((this.sortedNodes[i] as GraphNode).id);
      for (const [nid, g] of this.nodeEls) g.classList.toggle("active", active.has(nid));
      for (const { edge, el } of this.edgeEls) {
        el.classList.toggle("active", edge.firstSeenMs <= t);
      }
    }
    // Pulse the nodes of the newest event at the playhead.
    const idx = this.store.currentIndex();
    if (idx !== this.lastPulseIndex) {
      this.lastPulseIndex = idx;
      const ev = this.store.currentEvent();
      // In high-activity live mode pulses are suppressed: the UI batches
      // instead of animating every event.
      if (ev && (this.store.playing || idx >= 0) && !this.store.highActivity) {
        this.pulseNodes(this.store.nodeIdsForEvent(ev));
      }
    }
  }

  /**
   * Briefly highlight already-rendered nodes (e.g. as live events arrive).
   * Toggles a CSS class on the existing <g> elements — no re-layout, no
   * rebuild. Ids with no rendered element are skipped.
   */
  pulseNodes(ids: readonly string[]): void {
    for (const id of ids) {
      const g = this.nodeEls.get(id);
      if (!g || g.classList.contains("pulse")) continue;
      g.classList.add("pulse");
      const cur = g;
      window.setTimeout(() => cur.classList.remove("pulse"), 650);
    }
  }
}
