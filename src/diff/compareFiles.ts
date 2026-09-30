/**
 * File comparison across two runs.
 *
 * Files are matched by exact path. A path seen in both runs with identical
 * activity counts is `shared`; any difference in read/write/create/delete/
 * rename/mkdir counts makes it `changed`. Temp files with random names are
 * never merged — they surface as only-a / only-b.
 */
import { basename } from "node:path";
import type { GhostGlassEvent, GhostGlassEventAction } from "../events/types.js";
import { fileFingerprint } from "./fingerprints.js";
import type { DiffStatus, FileDiffEntity, FileSideStats } from "./types.js";

interface FileAcc {
  counts: Record<"read" | "write" | "create" | "delete" | "rename" | "mkdir", number>;
  eventCount: number;
  firstSeen: number;
  lastSeen: number;
  pids: Map<number, number>;
}

export interface RunFileIndex {
  byFingerprint: Map<string, FileAcc>;
  /** pid -> executable, for touchedBy labels */
  exeByPid: Map<number, string | null>;
}

const FILE_ACTIONS = new Set<GhostGlassEventAction>([
  "read",
  "write",
  "create",
  "delete",
  "rename",
  "mkdir",
]);

/** Single pass over a run's events. O(n). */
export function indexRunFiles(
  events: Iterable<GhostGlassEvent>,
  startTimeMs: number,
  exeByPid: Map<number, string | null>,
): RunFileIndex {
  const byFingerprint = new Map<string, FileAcc>();
  for (const e of events) {
    if (e.type !== "file" || !e.path || !FILE_ACTIONS.has(e.action)) continue;
    const seen = Math.max(0, e.timestamp - startTimeMs);
    const fp = fileFingerprint(e.path);
    let f = byFingerprint.get(fp);
    if (!f) {
      f = {
        counts: { read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
        eventCount: 0,
        firstSeen: seen,
        lastSeen: seen,
        pids: new Map(),
      };
      byFingerprint.set(fp, f);
    }
    f.counts[e.action as keyof FileAcc["counts"]] += 1;
    f.eventCount += 1;
    f.pids.set(e.pid, (f.pids.get(e.pid) ?? 0) + 1);
    if (seen < f.firstSeen) f.firstSeen = seen;
    if (seen > f.lastSeen) f.lastSeen = seen;
  }
  return { byFingerprint, exeByPid };
}

const TOUCHED_BY_CAP = 8;

function toStats(fp: string, f: FileAcc, exeByPid: Map<number, string | null>): FileSideStats {
  const touchedBy = [...f.pids.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, TOUCHED_BY_CAP)
    .map(([pid, count]) => ({ pid, executable: exeByPid.get(pid) ?? null, count }));
  return {
    read: f.counts.read,
    write: f.counts.write,
    create: f.counts.create,
    delete: f.counts.delete,
    rename: f.counts.rename,
    mkdir: f.counts.mkdir,
    eventCount: f.eventCount,
    firstSeenMs: f.firstSeen,
    lastSeenMs: f.lastSeen,
    touchedBy,
  };
}

function countsEqual(a: FileSideStats, b: FileSideStats): boolean {
  return (
    a.read === b.read &&
    a.write === b.write &&
    a.create === b.create &&
    a.delete === b.delete &&
    a.rename === b.rename &&
    a.mkdir === b.mkdir
  );
}

export function compareFiles(a: RunFileIndex, b: RunFileIndex): FileDiffEntity[] {
  const fps = new Set<string>([...a.byFingerprint.keys(), ...b.byFingerprint.keys()]);
  const out: FileDiffEntity[] = [];
  for (const fp of fps) {
    const fa = a.byFingerprint.get(fp);
    const fb = b.byFingerprint.get(fp);
    const aStats = fa ? toStats(fp, fa, a.exeByPid) : null;
    const bStats = fb ? toStats(fp, fb, b.exeByPid) : null;
    let status: DiffStatus;
    if (!aStats) status = "only-b";
    else if (!bStats) status = "only-a";
    else status = countsEqual(aStats, bStats) ? "shared" : "changed";
    out.push({
      kind: "file",
      fingerprint: fp,
      status,
      path: fp,
      label: basename(fp) || fp,
      a: aStats,
      b: bStats,
    });
  }
  out.sort((x, y) => {
    const xe = (x.a?.eventCount ?? 0) + (x.b?.eventCount ?? 0);
    const ye = (y.a?.eventCount ?? 0) + (y.b?.eventCount ?? 0);
    return ye - xe;
  });
  return out;
}
