/**
 * Predicate compilation for trace queries.
 *
 * All matching here is deterministic and bounded:
 * - No regular expressions built from user input.
 * - Glob matching uses a linear two-pointer algorithm (no backtracking).
 * - Text search is a case-insensitive substring over a fixed set of
 *   displayable fields — never a blind stringify of metadata.
 */
import type { GhostGlassEvent } from "../events/types.js";
import { type QueryContext, type TraceQuery } from "./types.js";
import { validateQuery } from "./parser.js";

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Process identity matching. Matches when the query equals the executable
 * basename ("node" matches "/usr/bin/node"), equals the full path, or is
 * a path suffix ("/bin/node" matches "/usr/bin/node"). Case-sensitive;
 * no fuzzy matching.
 */
export function matchProcess(query: string, executable: string | undefined): boolean {
  if (!executable) return false;
  if (executable === query) return true;
  if (basename(executable) === query) return true;
  if (query.includes("/") && executable.endsWith(`/${query}`)) return true;
  return false;
}

/**
 * File matching for --file: basename or path suffix.
 * "package-lock.json" matches "/repo/package-lock.json".
 */
export function matchFile(query: string, path: string | undefined): boolean {
  if (!path) return false;
  if (path === query) return true;
  if (basename(path) === query) return true;
  if (query.includes("/") && path.endsWith(`/${query}`)) return true;
  return false;
}

/**
 * Linear-time glob match supporting `*` (any run of chars, including `/`)
 * and `?` (exactly one char, never `/`). All other characters match
 * literally. Two-pointer algorithm: O(pattern + text), no backtracking
 * explosion.
 */
export function matchGlob(pattern: string, text: string): boolean {
  let px = 0;
  let tx = 0;
  let star = -1;
  let starTx = 0;
  while (tx < text.length) {
    const pc = pattern[px];
    const tc = text[tx];
    if (px < pattern.length && (pc === tc || (pc === "?" && tc !== "/"))) {
      px++;
      tx++;
    } else if (px < pattern.length && pc === "*") {
      star = px;
      starTx = tx;
      px++;
    } else if (star !== -1) {
      px = star + 1;
      starTx++;
      tx = starTx;
    } else {
      return false;
    }
  }
  while (px < pattern.length && pattern[px] === "*") px++;
  return px === pattern.length;
}

/** Controlled displayable fields for text search. */
function textHaystack(e: GhostGlassEvent): string {
  const parts: string[] = [e.action, e.type];
  if (e.executable) {
    parts.push(e.executable, basename(e.executable));
  }
  if (e.path) {
    parts.push(e.path, basename(e.path));
  }
  if (e.host) parts.push(e.host);
  if (e.ip) parts.push(e.ip);
  if (e.port !== undefined) parts.push(String(e.port));
  const md = e.metadata;
  if (md) {
    const syscall = md["syscall"];
    if (typeof syscall === "string") parts.push(syscall);
    const argv = md["argv"];
    if (Array.isArray(argv)) {
      for (const a of argv) if (typeof a === "string") parts.push(a);
    }
    const command = md["command"];
    if (typeof command === "string") parts.push(command);
  }
  return parts.join("\n").toLowerCase();
}

export type EventPredicate = (e: GhostGlassEvent) => boolean;

/**
 * Compile a TraceQuery into a single event predicate. The predicate is
 * reusable for incremental matching (Live Glass): it closes over the
 * query and a pid→executable resolver, with no per-event allocation
 * beyond the closure.
 */
export function compileQuery(query: TraceQuery, ctx: QueryContext): EventPredicate {
  validateQuery(query);

  const processQ = query.process;
  const pid = query.pid;
  const actions = query.actions && query.actions.length > 0 ? new Set(query.actions) : null;
  const types = query.types && query.types.length > 0 ? new Set(query.types) : null;
  const fileQ = query.file;
  const pathGlob = query.path;
  const network = query.network;
  const hostQ = query.host?.toLowerCase();
  const ipQ = query.ip;
  const portQ = query.port;
  const since = query.since;
  const until = query.until;
  const textQ = query.text?.toLowerCase();
  const reconstructed = query.reconstructed;
  const exeForPid = ctx.executableForPid;

  return (e: GhostGlassEvent): boolean => {
    if (processQ !== undefined) {
      const exe = e.executable ?? exeForPid(e.pid, e.sequence);
      if (!matchProcess(processQ, exe)) return false;
    }
    if (pid !== undefined && e.pid !== pid) return false;
    if (actions && !actions.has(e.action)) return false;
    if (types && !types.has(e.type)) return false;
    if (fileQ !== undefined && !matchFile(fileQ, e.path)) return false;
    if (pathGlob !== undefined && !matchGlob(pathGlob, e.path ?? "")) return false;
    if (network !== undefined) {
      if (network !== (e.type === "network")) return false;
    }
    if (hostQ !== undefined && (e.host ?? "").toLowerCase().indexOf(hostQ) < 0) return false;
    if (ipQ !== undefined && e.ip !== ipQ) return false;
    if (portQ !== undefined && e.port !== portQ) return false;
    if (since !== undefined && e.timestamp < since) return false;
    if (until !== undefined && e.timestamp > until) return false;
    if (textQ !== undefined && textHaystack(e).indexOf(textQ) < 0) return false;
    if (reconstructed !== undefined) {
      const isRecon = e.metadata?.["reconstructed"] === true;
      if (reconstructed !== isRecon) return false;
    }
    return true;
  };
}

/**
 * Build a QueryContext from a set of events. Each PID gets a timeline of
 * (sequence, executable) from its exec events, so a PID that re-execs
 * keeps the right identity for events before and after the re-exec.
 * Timelines are sorted by sequence; lookup is a binary search.
 */
export function buildQueryContext(events: readonly GhostGlassEvent[]): QueryContext {
  const timelines = new Map<number, { seq: number; exe: string }[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as GhostGlassEvent;
    if (e.action === "exec" && e.executable) {
      const seq = e.sequence ?? i + 1;
      let tl = timelines.get(e.pid);
      if (!tl) {
        tl = [];
        timelines.set(e.pid, tl);
      }
      tl.push({ seq, exe: e.executable });
    }
  }
  for (const tl of timelines.values()) tl.sort((a, b) => a.seq - b.seq);
  return { executableForPid: executableForPid(timelines) };
}

/**
 * Build the pid→executable resolver over caller-supplied timelines.
 * Used by streaming frontends that append exec identities incrementally
 * (their timelines are already in sequence order).
 */
export function executableForPid(
  timelines: ReadonlyMap<number, { seq: number; exe: string }[]>,
): (pid: number, atSequence?: number) => string | undefined {
  return (pid: number, atSequence?: number): string | undefined => {
    const tl = timelines.get(pid);
    if (!tl || tl.length === 0) return undefined;
    if (atSequence === undefined) return tl[tl.length - 1]?.exe;
    // Last entry with seq <= atSequence.
    let lo = 0;
    let hi = tl.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = tl[mid] as { seq: number; exe: string };
      if (entry.seq <= atSequence) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? tl[best]?.exe : undefined;
  };
}

/** Throw a QueryError listing valid actions when an action is unknown. */
export function assertKnownAction(action: string): void {
  validateQuery({ actions: [action] });
}
