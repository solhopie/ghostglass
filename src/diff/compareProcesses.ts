/**
 * Process comparison across two runs.
 *
 * Each run is indexed once (O(n)): per-PID accumulators capture executable,
 * argv, parent relationship, and activity counters. PIDs are then grouped
 * by stable fingerprint; the same fingerprint in both runs is the same
 * logical process, even though PIDs differ.
 *
 * When several PIDs in one run share a fingerprint (e.g. a pool of
 * identical workers), their stats are aggregated and the entity is flagged
 * `ambiguous` — the UI shows the ambiguity instead of pretending the
 * match is exact.
 */
import { basename } from "node:path";
import type { GhostGlassEvent, GhostGlassEventAction } from "../events/types.js";
import { argvOf, processFingerprint } from "./fingerprints.js";
import type { DiffStatus, ProcessDiffEntity, ProcessSideStats } from "./types.js";

export interface ProcAcc {
  pid: number;
  executable: string | null;
  argv: string[] | null;
  parentPid: number | null;
  children: Set<number>;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  filesRead: number;
  filesWritten: number;
  filesCreated: number;
  filesDeleted: number;
  filesRenamed: number;
  dirsCreated: number;
  networkConnects: number;
}

export interface RunProcessIndex {
  byPid: Map<number, ProcAcc>;
  /** fingerprint -> pids in first-seen order */
  byFingerprint: Map<string, number[]>;
}

const FILE_ACTIONS = new Set<GhostGlassEventAction>([
  "read",
  "write",
  "create",
  "delete",
  "rename",
  "mkdir",
]);

function newAcc(pid: number, seen: number): ProcAcc {
  return {
    pid,
    executable: null,
    argv: null,
    parentPid: null,
    children: new Set(),
    firstSeen: seen,
    lastSeen: seen,
    eventCount: 0,
    filesRead: 0,
    filesWritten: 0,
    filesCreated: 0,
    filesDeleted: 0,
    filesRenamed: 0,
    dirsCreated: 0,
    networkConnects: 0,
  };
}

/** Single pass over a run's events. O(n). */
export function indexRunProcesses(
  events: Iterable<GhostGlassEvent>,
  startTimeMs: number,
  /**
   * Run-scoped salt for processes whose executable and argv are both
   * unknown (e.g. threads, or children whose execve arrived as an
   * unfinished/resumed fragment the parser skips). Unknown processes are
   * aggregated within a run but can never match across runs — merging
   * them would invent a relationship the trace does not support.
   */
  salt = "",
): RunProcessIndex {
  const byPid = new Map<number, ProcAcc>();
  const acc = (pid: number, seen: number): ProcAcc => {
    let p = byPid.get(pid);
    if (!p) {
      p = newAcc(pid, seen);
      byPid.set(pid, p);
    }
    return p;
  };

  for (const e of events) {
    const seen = Math.max(0, e.timestamp - startTimeMs);
    const p = acc(e.pid, seen);
    p.eventCount += 1;
    if (seen < p.firstSeen) p.firstSeen = seen;
    if (seen > p.lastSeen) p.lastSeen = seen;

    if (e.action === "exec") {
      if (e.executable) p.executable = e.executable;
      const argv = argvOf(e);
      if (argv) p.argv = argv;
    } else if (e.action === "spawn" && typeof e.parentPid === "number") {
      // Parser semantics: e.pid is the child, e.parentPid the creator.
      const parent = acc(e.parentPid, seen);
      parent.children.add(e.pid);
      p.parentPid = e.parentPid;
      if (e.executable && !p.executable) p.executable = e.executable;
    } else if (e.type === "file" && e.path && FILE_ACTIONS.has(e.action)) {
      switch (e.action) {
        case "read": p.filesRead += 1; break;
        case "write": p.filesWritten += 1; break;
        case "create": p.filesCreated += 1; break;
        case "delete": p.filesDeleted += 1; break;
        case "rename": p.filesRenamed += 1; break;
        case "mkdir": p.dirsCreated += 1; break;
      }
    } else if (e.type === "network" && e.action === "connect") {
      p.networkConnects += 1;
    }
  }

  const byFingerprint = new Map<string, number[]>();
  const exeOf = (pid: number): string | null => byPid.get(pid)?.executable ?? null;
  const ordered = [...byPid.values()].sort((x, y) => x.firstSeen - y.firstSeen);
  for (const p of ordered) {
    const parentExe = p.parentPid !== null ? exeOf(p.parentPid) : null;
    // Unknown identity: aggregate within this run only, never match across.
    const fp =
      p.executable === null && p.argv === null
        ? `unknown-processes\n${salt}`
        : processFingerprint(p.executable, p.argv, parentExe);
    const list = byFingerprint.get(fp);
    if (list) list.push(p.pid);
    else byFingerprint.set(fp, [p.pid]);
  }
  return { byPid, byFingerprint };
}

function aggregate(pids: number[], byPid: Map<number, ProcAcc>): ProcessSideStats {
  const accs = pids.map((pid) => byPid.get(pid) as ProcAcc);
  const children = new Set<number>();
  let executable: string | null = null;
  let argv: string[] | null = null;
  let parentExecutable: string | null = null;
  let filesRead = 0, filesWritten = 0, filesCreated = 0, filesDeleted = 0;
  let filesRenamed = 0, dirsCreated = 0, networkConnects = 0, eventCount = 0;
  let firstSeen = Number.POSITIVE_INFINITY, lastSeen = 0;
  for (const p of accs) {
    if (!executable && p.executable) executable = p.executable;
    if (!argv && p.argv) argv = p.argv;
    for (const c of p.children) children.add(c);
    filesRead += p.filesRead;
    filesWritten += p.filesWritten;
    filesCreated += p.filesCreated;
    filesDeleted += p.filesDeleted;
    filesRenamed += p.filesRenamed;
    dirsCreated += p.dirsCreated;
    networkConnects += p.networkConnects;
    eventCount += p.eventCount;
    if (p.firstSeen < firstSeen) firstSeen = p.firstSeen;
    if (p.lastSeen > lastSeen) lastSeen = p.lastSeen;
  }
  const first = accs[0] as ProcAcc;
  if (first.parentPid !== null) parentExecutable = byPid.get(first.parentPid)?.executable ?? null;
  return {
    pids,
    executable,
    argv,
    parentExecutable,
    children: children.size,
    filesRead,
    filesWritten,
    filesCreated,
    filesDeleted,
    filesRenamed,
    dirsCreated,
    networkConnects,
    eventCount,
    firstSeenMs: firstSeen === Number.POSITIVE_INFINITY ? 0 : firstSeen,
    lastSeenMs: lastSeen,
  };
}

function statsEqual(a: ProcessSideStats, b: ProcessSideStats): boolean {
  return (
    a.children === b.children &&
    a.filesRead === b.filesRead &&
    a.filesWritten === b.filesWritten &&
    a.filesCreated === b.filesCreated &&
    a.filesDeleted === b.filesDeleted &&
    a.filesRenamed === b.filesRenamed &&
    a.dirsCreated === b.dirsCreated &&
    a.networkConnects === b.networkConnects
  );
}

function labelFor(executable: string | null, pids: number[]): string {
  if (executable) return basename(executable);
  // Aggregated unknowns: the count is the honest description, not one PID.
  return pids.length > 1 ? `Unknown (${pids.length} processes)` : `PID ${pids[0] as number}`;
}

export function compareProcesses(
  a: RunProcessIndex,
  b: RunProcessIndex,
): ProcessDiffEntity[] {
  const fps = new Set<string>([...a.byFingerprint.keys(), ...b.byFingerprint.keys()]);
  const out: ProcessDiffEntity[] = [];
  for (const fp of fps) {
    const aPids = a.byFingerprint.get(fp) ?? [];
    const bPids = b.byFingerprint.get(fp) ?? [];
    const aStats = aPids.length > 0 ? aggregate(aPids, a.byPid) : null;
    const bStats = bPids.length > 0 ? aggregate(bPids, b.byPid) : null;
    let status: DiffStatus;
    if (!aStats) status = "only-b";
    else if (!bStats) status = "only-a";
    else status = statsEqual(aStats, bStats) ? "shared" : "changed";
    const executable = aStats?.executable ?? bStats?.executable ?? null;
    out.push({
      kind: "process",
      fingerprint: fp,
      status,
      ambiguous: aPids.length > 1 || bPids.length > 1,
      label: labelFor(executable, aPids.length > 0 ? aPids : bPids),
      executable,
      a: aStats,
      b: bStats,
    });
  }
  // Most-active entities first, matching the viewer graph's ordering.
  out.sort((x, y) => {
    const xe = (x.a?.eventCount ?? 0) + (x.b?.eventCount ?? 0);
    const ye = (y.a?.eventCount ?? 0) + (y.b?.eventCount ?? 0);
    return ye - xe;
  });
  return out;
}
