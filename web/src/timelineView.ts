/**
 * Timeline replay: density overview of the trace with a scrubbable playhead,
 * transport controls, and speed selection.
 */
import type { Store } from "./store.js";
import { el, formatDuration, formatOffset } from "./format.js";

const BUCKETS = 240;

export class TimelineView {
  private canvas: HTMLCanvasElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private speedBtn: HTMLButtonElement | null = null;
  private readout: HTMLElement | null = null;
  private buckets: number[] = [];
  private scrubbing = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
  ) {
    store.on("events", () => this.rebuildBuckets());
    store.on("replay", () => this.draw());
    store.on("highlights", () => this.draw());
    store.on("query", () => this.draw());
  }

  render(): void {
    this.host.innerHTML = "";
    const bar = el("div", "timeline-bar");

    const controls = el("div", "timeline-controls");
    const mkBtn = (label: string, title: string, fn: () => void, cls = "") => {
      const b = document.createElement("button");
      b.className = `tl-btn ${cls}`;
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      controls.appendChild(b);
      return b;
    };
    mkBtn("⏮", "Jump to beginning", () => {
      this.store.pause();
      this.store.jumpToStart();
    });
    this.playBtn = mkBtn("▶", "Play / pause (space)", () => this.store.toggle(), "tl-play");
    mkBtn("⏭", "Jump to end", () => {
      this.store.pause();
      this.store.jumpToEnd();
    });
    this.speedBtn = mkBtn("1x", "Replay speed", () => this.store.cycleSpeed(), "tl-speed");

    const readout = el("div", "timeline-readout");
    this.readout = readout;

    bar.appendChild(controls);
    const track = el("div", "timeline-track");
    const canvas = document.createElement("canvas");
    canvas.className = "timeline-canvas";
    track.appendChild(canvas);
    bar.appendChild(track);
    bar.appendChild(readout);
    this.host.appendChild(bar);
    this.canvas = canvas;

    canvas.addEventListener("pointerdown", (e) => {
      // Clicking a highlight marker selects the highlight instead of scrubbing.
      if (this.clickMarker(e)) return;
      this.scrubbing = true;
      // Synthetic or already-released pointers make setPointerCapture throw;
      // capture is an enhancement, never let it break scrubbing.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.store.pause();
      this.scrubTo(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.scrubbing) this.scrubTo(e);
    });
    const end = () => {
      this.scrubbing = false;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && (e.target as HTMLElement).tagName !== "INPUT") {
        e.preventDefault();
        this.store.toggle();
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.draw()).observe(track);
    }
    this.rebuildBuckets();
  }

  private scrubTo(e: PointerEvent): void {
    const canvas = this.canvas;
    if (!canvas || this.store.durationMs <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.store.seek(frac * this.store.durationMs);
  }

  /** X positions of highlight markers, for hit-testing and drawing. */
  private markerPositions(w: number): { x: number; id: string; title: string }[] {
    const s = this.store;
    if (!s.showHighlights || s.durationMs <= 0) return [];
    const out: { x: number; id: string; title: string }[] = [];
    for (const h of s.filteredHighlights()) {
      const frac = (h.startTimestamp - s.startTimeMs) / s.durationMs;
      if (frac < 0 || frac > 1) continue;
      out.push({ x: frac * w, id: h.id, title: h.title });
    }
    return out;
  }

  /** If the pointer is on a highlight marker, select it and return true. */
  private clickMarker(e: PointerEvent): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Markers live in the top strip of the track.
    if (y > 18) return false;
    for (const m of this.markerPositions(w)) {
      if (Math.abs(m.x - x) <= 8) {
        this.store.selectHighlight(m.id);
        return true;
      }
    }
    return false;
  }

  private rebuildBuckets(): void {
    const ts = this.store.timestamps;
    this.buckets = new Array(BUCKETS).fill(0);
    if (ts.length === 0 || this.store.durationMs <= 0) {
      this.draw();
      return;
    }
    const start = this.store.startTimeMs;
    for (const t of ts) {
      const frac = (t - start) / this.store.durationMs;
      const b = Math.max(0, Math.min(BUCKETS - 1, Math.floor(frac * BUCKETS)));
      (this.buckets[b] as number) += 1;
    }
    this.draw();
  }

  draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const labelH = 16;
    const trackH = h - labelH - 6;
    const max = Math.max(1, ...this.buckets);
    const bw = w / BUCKETS;
    for (let i = 0; i < BUCKETS; i++) {
      const v = (this.buckets[i] as number) / max;
      if (v <= 0) continue;
      const bh = Math.max(2, v * trackH);
      const grad = ctx.createLinearGradient(0, trackH - bh, 0, trackH);
      grad.addColorStop(0, "rgba(34, 211, 238, 0.85)");
      grad.addColorStop(1, "rgba(167, 139, 250, 0.35)");
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw + 0.5, trackH - bh, Math.max(1, bw - 1), bh);
    }

    // highlight markers (triangles along the top edge)
    const s = this.store;
    if (s.showHighlights) {
      for (const h of s.filteredHighlights()) {
        const frac = s.durationMs > 0 ? (h.startTimestamp - s.startTimeMs) / s.durationMs : 0;
        if (frac < 0 || frac > 1) continue;
        const x = frac * w;
        const selected =
          s.selection?.kind === "highlight" && s.selection.highlightId === h.id;
        ctx.fillStyle =
          h.severity === "high"
            ? "#f472b6"
            : h.severity === "notice"
              ? "#fbbf24"
              : "#38bdf8";
        ctx.beginPath();
        ctx.moveTo(x, 2);
        ctx.lineTo(x - 5, 12);
        ctx.lineTo(x + 5, 12);
        ctx.closePath();
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // query match markers (small ticks along the bottom edge)
    if (s.query !== null && s.durationMs > 0) {
      ctx.fillStyle = "rgba(52, 211, 153, 0.9)";
      const cap = 20000; // marker drawing is capped; count is exact in the query bar
      const matches = s.queryMatches;
      const n = Math.min(matches.length, cap);
      for (let i = 0; i < n; i++) {
        const ev = s.events[matches[i] as number];
        if (!ev) continue;
        const frac = (ev.timestamp - s.startTimeMs) / s.durationMs;
        if (frac < 0 || frac > 1) continue;
        const x = frac * w;
        ctx.fillRect(x, trackH - 5, 2, 5);
      }
    }

    // playhead
    const frac = this.store.durationMs > 0 ? this.store.tMs / this.store.durationMs : 0;
    const px = frac * w;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, trackH);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(px, 4, 4, 0, Math.PI * 2);
    ctx.fill();

    // time labels
    ctx.fillStyle = "rgba(139, 148, 158, 0.9)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "top";
    const marks = [0, 0.25, 0.5, 0.75, 1];
    for (const m of marks) {
      const label = formatDuration(m * this.store.durationMs);
      const x = m * w;
      ctx.fillText(label, m === 1 ? x - ctx.measureText(label).width : x + 2, trackH + 4);
    }

    if (this.playBtn) this.playBtn.textContent = this.store.playing ? "⏸" : "▶";
    if (this.speedBtn) this.speedBtn.textContent = `${this.store.speed}x`;
    if (this.readout) {
      const idx = this.store.currentIndex();
      const total = this.store.timestamps.length;
      this.readout.textContent =
        `${formatOffset(this.store.tMs)} / ${formatOffset(this.store.durationMs)}` +
        (total > 0 ? ` · event ${idx + 1} of ${total}` : "");
    }
  }
}
