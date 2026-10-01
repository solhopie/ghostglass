/**
 * Pure presentation helpers for the replay UI. Mirrors the backend's
 * src/viewer/replay.ts semantics; behavior differences would be bugs, so
 * keep the two in step.
 */
import type { GhostGlassEvent, GhostGlassEventType } from "./types.js";

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** "00:00.004" offset for the stream and timeline readout. */
export function formatOffset(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const millis = Math.floor(clamped % 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/** Compact duration, e.g. "12.44s" / "1m 03.20s". */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(2).padStart(5, "0")}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Index of the last timestamp <= tMs, or -1. `timestamps` must be ascending.
 */
export function eventIndexAt(timestamps: readonly number[], tMs: number): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const ts = timestamps[mid] as number;
    if (ts <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Event index of the last event with timestamp <= tMs, or -1. `timeOrder`
 * holds event indices sorted by (timestamp, sequence); the result indexes
 * the emission-ordered events array. Mirrors src/viewer/replay.ts.
 * Not-yet-loaded events (paged streaming) are treated as not qualifying.
 */
export function eventIndexAtOrdered(
  events: readonly { timestamp: number }[],
  timeOrder: readonly number[],
  tMs: number,
): number {
  let lo = 0;
  let hi = timeOrder.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const ev = events[timeOrder[mid] as number];
    if (ev && ev.timestamp <= tMs) {
      ans = timeOrder[mid] as number;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function describeEvent(
  e: GhostGlassEvent,
  pidLabel: (pid: number) => string = (pid) => `PID ${pid}`,
): string {
  const label = pidLabel(e.pid);
  switch (e.action) {
    case "exec":
      return `${label} started`;
    case "spawn":
      return typeof e.parentPid === "number"
        ? `${pidLabel(e.parentPid)} → ${label}`
        : `${label} spawned a child`;
    case "exit": {
      const code = e.metadata?.["code"];
      return typeof code === "number" ? `${label} exited (code ${code})` : `${label} exited`;
    }
    case "read":
    case "write":
    case "create":
    case "delete":
    case "mkdir":
      return `${e.action.toUpperCase()} ${shortPath(e.path)}`;
    case "rename": {
      const np = e.metadata?.["newPath"];
      return typeof np === "string"
        ? `RENAME ${shortPath(e.path)} → ${shortPath(np)}`
        : `RENAME ${shortPath(e.path)}`;
    }
    case "connect":
      return `NETWORK ${label} → ${e.ip ?? "?"}:${e.port ?? "?"}`;
    default:
      return `${e.type}:${e.action}`;
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return "?";
  const base = basename(p);
  return base || p;
}

export interface StreamFilter {
  kinds: Set<GhostGlassEventType> | null;
  actions: Set<string> | null;
  query: string;
}

export function eventSearchText(e: GhostGlassEvent, pidLabel: (pid: number) => string): string {
  const newPath = e.metadata?.["newPath"];
  return [
    e.type,
    e.action,
    String(e.pid),
    pidLabel(e.pid),
    e.executable ?? "",
    e.path ?? "",
    typeof newPath === "string" ? newPath : "",
    e.ip ?? "",
    e.port != null ? String(e.port) : "",
    e.id,
  ]
    .join(" ")
    .toLowerCase();
}

export function filterEvents(
  events: readonly GhostGlassEvent[],
  filter: StreamFilter,
  pidLabel: (pid: number) => string,
): GhostGlassEvent[] {
  const q = filter.query.trim().toLowerCase();
  const out: GhostGlassEvent[] = [];
  for (const e of events) {
    if (filter.kinds && !filter.kinds.has(e.type)) continue;
    if (filter.actions && !filter.actions.has(e.action)) continue;
    if (q && !eventSearchText(e, pidLabel).includes(q)) continue;
    out.push(e);
  }
  return out;
}

/** HTML-escape via the DOM — never inject trace strings as HTML. */
export function text(el: Element, value: string): void {
  el.textContent = value;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function svgEl(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function svgText(parent: SVGElement, str: string, attrs: Record<string, string> = {}): SVGTextElement {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
  t.textContent = str; // textContent: no HTML interpretation, safe for trace data
  parent.appendChild(t);
  return t;
}
