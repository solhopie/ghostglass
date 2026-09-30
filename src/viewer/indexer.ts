/**
 * Derives the visual execution graph from raw GhostGlass events.
 *
 * The graph is a *deduplicated* view of the trace: one node per process,
 * one node per unique file path, one node per unique network destination.
 * Repeated events fold into nodes as counts — the inspector surfaces them.
 * Nothing is invented: every node and edge comes from a real event.
 *
 * events.jsonl stays the source of truth; the graph is a derived,
 * in-memory (and per-server cached) projection.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import type { GhostGlassEvent, GhostGlassEventAction } from "../events/types.js";
import type {
  ApiGraph,
  FileNodeStats,
  GraphEdge,
  GraphNode,
  NetworkNodeStats,
  ProcessNodeStats,
} from "./protocol.js";

/** Cap on file nodes so traces with thousands of paths stay renderable. */
export const MAX_FILE_NODES = 600;

export interface IndexerInput {
  runId: string;
  commandLine: string;
  /** Absolute epoch ms of run start; node times are stored as offsets. */
  startTimeMs: number;
}

interface ProcAcc {
  pid: number;
  executable?: string;
  parentPid?: number;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  stats: ProcessNodeStats;
}

interface FileAcc {
  path: string;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  counts: Record<"read" | "write" | "create" | "delete" | "rename" | "mkdir", number>;
  pids: Map<number, number>;
}

interface NetAcc {
  key: string;
  ip: string;
  port: number;
  firstSeen: number;
  lastSeen: number;
  attempts: number;
  pids: Map<number, number>;
}

function offsetMs(input: IndexerInput, timestamp: number): number {
  return Math.max(0, timestamp - input.startTimeMs);
}

function procLabel(acc: ProcAcc): string {
  return acc.executable ? basename(acc.executable) : `PID ${acc.pid}`;
}

function newProc(pid: number, seen: number): ProcAcc {
  return {
    pid,
    firstSeen: seen,
    lastSeen: seen,
    eventCount: 0,
    stats: {
      filesRead: 0,
      filesWritten: 0,
      filesCreated: 0,
      filesDeleted: 0,
      filesRenamed: 0,
      dirsCreated: 0,
      networkConnects: 0,
      childProcesses: 0,
    },
  };
}

const FILE_ACTIONS = new Set<GhostGlassEventAction>([
  "read",
  "write",
  "create",
  "delete",
  "rename",
  "mkdir",
]);

export function buildGraphFromEvents(
  events: Iterable<GhostGlassEvent>,
  input: IndexerInput,
): ApiGraph {
  const procs = new Map<number, ProcAcc>();
  const files = new Map<string, FileAcc>();
  const nets = new Map<string, NetAcc>();
  // pid -> child pid -> { eventCount, firstSeen }
  const spawns = new Map<number, Map<number, { eventCount: number; firstSeen: number }>>();
  // "pid\0path" -> aggregated access edge info
  const access = new Map<string, { eventCount: number; actions: Record<string, number>; firstSeen: number }>();
  let rootPid: number | undefined;
  let earliestExecSeen = Number.POSITIVE_INFINITY;

  const proc = (pid: number, seen: number): ProcAcc => {
    let p = procs.get(pid);
    if (!p) {
      p = newProc(pid, seen);
      procs.set(pid, p);
    }
    return p;
  };

  for (const e of events) {
    const seen = offsetMs(input, e.timestamp);
    const p = proc(e.pid, seen);
    p.eventCount += 1;
    if (seen < p.firstSeen) p.firstSeen = seen;
    if (seen > p.lastSeen) p.lastSeen = seen;

    if (e.action === "exec") {
      if (e.executable) p.executable = e.executable;
      if (seen < earliestExecSeen) {
        earliestExecSeen = seen;
        rootPid = e.pid;
      }
    } else if (e.action === "spawn") {
      // Parser semantics (straceParser.ts): e.pid is the spawned child,
      // e.parentPid is the process that created it.
      const childPid = e.pid;
      const parentPid = e.parentPid;
      if (typeof childPid === "number" && typeof parentPid === "number") {
        const child = proc(childPid, seen);
        if (child.parentPid === undefined) child.parentPid = parentPid;
        if (e.executable && !child.executable) child.executable = e.executable;
        let m = spawns.get(parentPid);
        if (!m) {
          m = new Map();
          spawns.set(parentPid, m);
        }
        const s = m.get(childPid);
        if (s) s.eventCount += 1;
        else m.set(childPid, { eventCount: 1, firstSeen: seen });
      }
    } else if (e.type === "file" && e.path && FILE_ACTIONS.has(e.action)) {
      const key = e.path;
      let f = files.get(key);
      if (!f) {
        f = {
          path: key,
          firstSeen: seen,
          lastSeen: seen,
          eventCount: 0,
          counts: { read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
          pids: new Map(),
        };
        files.set(key, f);
      }
      f.eventCount += 1;
      f.counts[e.action as keyof FileAcc["counts"]] += 1;
      f.pids.set(e.pid, (f.pids.get(e.pid) ?? 0) + 1);
      if (seen < f.firstSeen) f.firstSeen = seen;
      if (seen > f.lastSeen) f.lastSeen = seen;
      const akey = `${e.pid}\u0000${key}`;
      let acc = access.get(akey);
      if (!acc) {
        acc = { eventCount: 0, actions: {}, firstSeen: seen };
        access.set(akey, acc);
      }
      acc.eventCount += 1;
      acc.actions[e.action] = (acc.actions[e.action] ?? 0) + 1;
      if (seen < acc.firstSeen) acc.firstSeen = seen;
      switch (e.action) {
        case "read":
          p.stats.filesRead += 1;
          break;
        case "write":
          p.stats.filesWritten += 1;
          break;
        case "create":
          p.stats.filesCreated += 1;
          break;
        case "delete":
          p.stats.filesDeleted += 1;
          break;
        case "rename":
          p.stats.filesRenamed += 1;
          break;
        case "mkdir":
          p.stats.dirsCreated += 1;
          break;
      }
    } else if (e.type === "network" && e.action === "connect" && e.ip != null && e.port != null) {
      const key = `${e.ip}:${e.port}`;
      let n = nets.get(key);
      if (!n) {
        n = { key, ip: e.ip, port: e.port, firstSeen: seen, lastSeen: seen, attempts: 0, pids: new Map() };
        nets.set(key, n);
      }
      n.attempts += 1;
      n.pids.set(e.pid, (n.pids.get(e.pid) ?? 0) + 1);
      if (seen < n.firstSeen) n.firstSeen = seen;
      if (seen > n.lastSeen) n.lastSeen = seen;
      p.stats.networkConnects += 1;
    }
  }

  // childProcesses counts distinct children (spawn edges), not raw events.
  for (const [parentPid, children] of spawns) {
    const parent = procs.get(parentPid);
    if (parent) parent.stats.childProcesses = children.size;
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeId = (kind: "p" | "f" | "n", v: string) => `${kind}:${v}`;

  nodes.push({
    id: "root",
    kind: "root",
    label: input.commandLine,
    sublabel: "traced command",
    eventCount: procs.size,
    firstSeenMs: 0,
    lastSeenMs: 0,
    stats: { kind: "root" },
  });

  if (rootPid !== undefined && procs.has(rootPid)) {
    edges.push({
      from: "root",
      to: nodeId("p", String(rootPid)),
      kind: "exec",
      eventCount: 1,
      actions: { exec: 1 },
      firstSeenMs: earliestExecSeen === Number.POSITIVE_INFINITY ? 0 : earliestExecSeen,
    });
  }

  const sortedPids = [...procs.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  for (const p of sortedPids) {
    nodes.push({
      id: nodeId("p", String(p.pid)),
      kind: "process",
      label: procLabel(p),
      sublabel: p.executable ?? `pid ${p.pid}`,
      pid: p.pid,
      parentPid: p.parentPid,
      executable: p.executable,
      eventCount: p.eventCount,
      firstSeenMs: p.firstSeen,
      lastSeenMs: p.lastSeen,
      stats: { kind: "process", ...p.stats },
    });
  }

  for (const [parentPid, children] of spawns) {
    if (!procs.has(parentPid)) continue;
    for (const [childPid, s] of children) {
      if (!procs.has(childPid)) continue;
      edges.push({
        from: nodeId("p", String(parentPid)),
        to: nodeId("p", String(childPid)),
        kind: "spawn",
        eventCount: s.eventCount,
        actions: { spawn: s.eventCount },
        firstSeenMs: s.firstSeen,
      });
    }
  }

  const sortedFiles = [...files.values()].sort((a, b) => b.eventCount - a.eventCount);
  const totalUniqueFiles = sortedFiles.length;
  const keptFiles = sortedFiles.slice(0, MAX_FILE_NODES);
  const truncatedFiles = Math.max(0, totalUniqueFiles - keptFiles.length);

  for (const f of keptFiles) {
    const touchedBy = [...f.pids.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([pid]) => ({ pid, label: procLabel(procs.get(pid) ?? newProc(pid, f.firstSeen)) }));
    const stats: { kind: "file" } & FileNodeStats = {
      kind: "file",
      read: f.counts.read,
      write: f.counts.write,
      create: f.counts.create,
      delete: f.counts.delete,
      rename: f.counts.rename,
      mkdir: f.counts.mkdir,
      touchedBy,
    };
    nodes.push({
      id: nodeId("f", f.path),
      kind: "file",
      label: basename(f.path) || f.path,
      sublabel: f.path,
      eventCount: f.eventCount,
      firstSeenMs: f.firstSeen,
      lastSeenMs: f.lastSeen,
      stats,
    });
  }

  // process -> file edges, aggregated per (pid, path), only for kept nodes
  const keptPaths = new Set(keptFiles.map((f) => f.path));
  for (const [akey, acc] of access) {
    const sep = akey.indexOf("\u0000");
    const pid = Number(akey.slice(0, sep));
    const fpath = akey.slice(sep + 1);
    if (!procs.has(pid) || !keptPaths.has(fpath)) continue;
    edges.push({
      from: nodeId("p", String(pid)),
      to: nodeId("f", fpath),
      kind: "access",
      eventCount: acc.eventCount,
      actions: acc.actions,
      firstSeenMs: acc.firstSeen,
    });
  }

  for (const n of [...nets.values()].sort((a, b) => a.firstSeen - b.firstSeen)) {
    const processes = [...n.pids.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pid]) => ({ pid, label: procLabel(procs.get(pid) ?? newProc(pid, n.firstSeen)) }));
    const stats: { kind: "network" } & NetworkNodeStats = { kind: "network", attempts: n.attempts, processes };
    nodes.push({
      id: nodeId("n", n.key),
      kind: "network",
      label: n.key,
      sublabel: "network destination",
      eventCount: n.attempts,
      firstSeenMs: n.firstSeen,
      lastSeenMs: n.lastSeen,
      stats,
    });
    for (const [pid, count] of n.pids) {
      if (!procs.has(pid)) continue;
      edges.push({
        from: nodeId("p", String(pid)),
        to: nodeId("n", n.key),
        kind: "connect",
        eventCount: count,
        actions: { connect: count },
        firstSeenMs: n.firstSeen,
      });
    }
  }

  return {
    runId: input.runId,
    nodes,
    edges,
    totalUniqueFiles,
    truncatedFiles,
    nodeCap: MAX_FILE_NODES,
  };
}

export async function buildGraphFromFile(
  eventsPath: string,
  input: IndexerInput,
): Promise<ApiGraph> {
  const events: GhostGlassEvent[] = [];
  const rl = createInterface({ input: createReadStream(eventsPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as GhostGlassEvent);
    } catch {
      // skip malformed lines, mirroring the parser's leniency
    }
  }
  return buildGraphFromEvents(events, input);
}
