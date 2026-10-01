/**
 * Process ancestry reconstruction.
 *
 * Walks parentPid links from the cause index to rebuild the chain from the
 * traced root command down to any PID. Handles:
 * - missing parents (PID observed but never spawned in-trace)
 * - processes observed after startup
 * - exited parents (links persist; exit doesn't erase ancestry)
 * - incomplete data (labels honestly, never manufactures processes)
 * - cycles (impossible in real traces, but guarded anyway)
 */
import type { CauseIndex, ProcessInfo } from "./causeIndex.js";
import { rootPidOf } from "./causeIndex.js";

export interface AncestryStep {
  pid: number;
  info: ProcessInfo;
  /** The spawn event linking this step to its parent, if recorded. */
  spawnEventId?: string | undefined;
}

export interface AncestryResult {
  /** Root-first chain: [root, ..., parent, pid]. */
  chain: AncestryStep[];
  /** True when the chain stops before reaching a parentless root. */
  incomplete: boolean;
  /** PID whose parent link is missing, when incomplete. */
  missingParentOf?: number | undefined;
  /** True if a cycle was detected and broken (defensive; shouldn't happen). */
  cycleBroken: boolean;
}

const MAX_DEPTH = 10000;

/**
 * Reconstruct ancestry for a PID, root-first.
 * Returns the chain even when incomplete — callers label it honestly.
 */
export function reconstructAncestry(index: CauseIndex, pid: number): AncestryResult {
  const chain: AncestryStep[] = [];
  const seen = new Set<number>();
  let cycleBroken = false;
  let current: number | undefined = pid;

  // Walk up first (child -> parent), collecting steps.
  const up: AncestryStep[] = [];
  let depth = 0;
  while (current !== undefined && depth < MAX_DEPTH) {
    if (seen.has(current)) {
      cycleBroken = true;
      break;
    }
    seen.add(current);
    const info = index.processByPid.get(current);
    if (!info) break; // PID not observed at all
    up.push({ pid: current, info, spawnEventId: info.originEventId });
    const parent = index.parentByPid.get(current);
    current = parent;
    depth++;
  }

  // Reverse to root-first order.
  for (let i = up.length - 1; i >= 0; i--) {
    chain.push(up[i] as AncestryStep);
  }

  // Incomplete when the top of the chain still has a recorded parent link
  // we couldn't follow (parent PID not in processByPid), or when the
  // original pid was never observed, or when the top has no parent link
  // but isn't the recorded root (orphan: its spawn wasn't captured).
  let incomplete = false;
  let missingParentOf: number | undefined;
  if (up.length === 0) {
    incomplete = true;
  } else {
    const top = up[up.length - 1] as AncestryStep;
    const topParent = index.parentByPid.get(top.pid);
    if (topParent !== undefined && !index.processByPid.has(topParent)) {
      incomplete = true;
      missingParentOf = top.pid;
    } else if (topParent === undefined) {
      const rootPid = index.rootCandidates[0];
      if (rootPid !== undefined && top.pid !== rootPid) {
        incomplete = true;
        missingParentOf = top.pid;
      }
    }
  }

  return { chain, incomplete, missingParentOf, cycleBroken };
}

/** Short display name for a process: basename of executable or "PID n". */
export function processLabel(info: ProcessInfo): string {
  if (info.executable) {
    const base = info.executable.split("/").pop() ?? info.executable;
    return base || `PID ${info.pid}`;
  }
  return `PID ${info.pid}`;
}

/**
 * Is this PID the traced root (no recorded parent and earliest seen)?
 * Falls back to "no parent link" when the index has no candidates.
 */
export function isRootProcess(index: CauseIndex, pid: number): boolean {
  const root = rootPidOf(index);
  if (root !== undefined) return pid === root;
  return !index.parentByPid.has(pid);
}
