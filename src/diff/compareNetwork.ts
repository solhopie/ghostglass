/**
 * Network comparison across two runs.
 *
 * Destinations are matched by exact ip:port. Hostnames are never invented —
 * matching uses only what was actually captured. A destination seen in both
 * runs with the same attempt count is `shared`; a different count makes it
 * `changed`.
 */
import type { GhostGlassEvent } from "../events/types.js";
import { networkFingerprint } from "./fingerprints.js";
import type { DiffStatus, NetworkDiffEntity, NetworkSideStats } from "./types.js";

interface NetAcc {
  attempts: number;
  firstSeen: number;
  lastSeen: number;
  pids: Map<number, number>;
}

export interface RunNetworkIndex {
  byFingerprint: Map<string, NetAcc>;
  /** pid -> executable, for process labels */
  exeByPid: Map<number, string | null>;
}

/** Single pass over a run's events. O(n). */
export function indexRunNetwork(
  events: Iterable<GhostGlassEvent>,
  startTimeMs: number,
  exeByPid: Map<number, string | null>,
): RunNetworkIndex {
  const byFingerprint = new Map<string, NetAcc>();
  for (const e of events) {
    if (e.type !== "network" || e.action !== "connect" || e.ip == null || e.port == null) continue;
    const seen = Math.max(0, e.timestamp - startTimeMs);
    const fp = networkFingerprint(e.ip, e.port);
    let n = byFingerprint.get(fp);
    if (!n) {
      n = { attempts: 0, firstSeen: seen, lastSeen: seen, pids: new Map() };
      byFingerprint.set(fp, n);
    }
    n.attempts += 1;
    n.pids.set(e.pid, (n.pids.get(e.pid) ?? 0) + 1);
    if (seen < n.firstSeen) n.firstSeen = seen;
    if (seen > n.lastSeen) n.lastSeen = seen;
  }
  return { byFingerprint, exeByPid };
}

const PROCESSES_CAP = 8;

function toStats(n: NetAcc, exeByPid: Map<number, string | null>): NetworkSideStats {
  const processes = [...n.pids.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, PROCESSES_CAP)
    .map(([pid, count]) => ({ pid, executable: exeByPid.get(pid) ?? null, count }));
  return {
    attempts: n.attempts,
    firstSeenMs: n.firstSeen,
    lastSeenMs: n.lastSeen,
    processes,
  };
}

export function compareNetwork(a: RunNetworkIndex, b: RunNetworkIndex): NetworkDiffEntity[] {
  const fps = new Set<string>([...a.byFingerprint.keys(), ...b.byFingerprint.keys()]);
  const out: NetworkDiffEntity[] = [];
  for (const fp of fps) {
    const na = a.byFingerprint.get(fp);
    const nb = b.byFingerprint.get(fp);
    const aStats = na ? toStats(na, a.exeByPid) : null;
    const bStats = nb ? toStats(nb, b.exeByPid) : null;
    let status: DiffStatus;
    if (!aStats) status = "only-b";
    else if (!bStats) status = "only-a";
    else status = aStats.attempts === bStats.attempts ? "shared" : "changed";
    out.push({
      kind: "network",
      fingerprint: fp,
      status,
      endpoint: fp,
      label: fp,
      a: aStats,
      b: bStats,
    });
  }
  out.sort((x, y) => {
    const xa = (x.a?.attempts ?? 0) + (x.b?.attempts ?? 0);
    const xb = (y.a?.attempts ?? 0) + (y.b?.attempts ?? 0);
    return xb - xa;
  });
  return out;
}
