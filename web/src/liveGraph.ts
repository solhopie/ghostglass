/**
 * Incremental graph accumulator for live mode.
 *
 * Mirrors src/viewer/indexer.ts semantics exactly (same node-id scheme
 * `root` / `p:<pid>` / `f:<path>` / `n:<ip>:<port>`, same edge kinds
 * `exec|spawn|access|connect`, same folding of repeated events into node
 * counts, same top-600 file cap) but applies events one batch at a time so
 * the graph can grow while the command is still running. Nothing is
 * invented: every node and edge comes from a real event.
 *
 * Additionally tracks per-process liveness from `exit` events so the live
 * inspector can show RUNNING / EXITED.
 */
import type {
  ApiGraph,
  GhostGlassEvent,
  GhostGlassEventAction,
  GraphEdge,
  GraphNode,
} from "./types.js";

/** Cap on visible file nodes, mirroring the server indexer's MAX_FILE_NODES. */
export const MAX_LIVE_FILE_NODES = 600;

/** Cap on node ids returned as "recently active" per batch (DOM pulse budget). */
const MAX_PULSE_IDS = 500;

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

interface ProcAcc {
  pid: number;
  executable?: string;
  parentPid?: number;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  live: "running" | "exited";
  exitCode: number | null;
  stats: {
    filesRead: number;
    filesWritten: number;
    filesCreated: number;
    filesDeleted: number;
    filesRenamed: number;
    dirsCreated: number;
    networkConnects: number;
    childProcesses: number;
  };
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

const FILE_ACTIONS = new Set<GhostGlassEventAction>([
  "read",
  "write",
  "create",
  "delete",
  "rename",
  "mkdir",
]);

export interface LiveCounters {
  processes: number;
  files: number;
  fileEvents: number;
  networkAttempts: number;
  totalEvents: number;
}

export class LiveGraph {
  private readonly procs = new Map<number, ProcAcc>();
  private readonly files = new Map<string, FileAcc>();
  private readonly nets = new Map<string, NetAcc>();
  /** pid -> child pid -> { eventCount, firstSeen } */
  private readonly spawns = new Map<number, Map<number, { eventCount: number; firstSeen: number }>>();
  /** "pid\0path" -> aggregated access edge info */
  private readonly access = new Map<string, { eventCount: number; actions: Record<string, number>; firstSeen: number }>();
  private rootPid: number | undefined;
  private earliestExecSeen = Number.POSITIVE_INFINITY;
  private totalEvents = 0;

  constructor(
    private readonly runId: string,
    private readonly commandLine: string,
    private readonly startTimeMs: number,
  ) {}

  private offsetMs(timestamp: number): number {
    return Math.max(0, timestamp - this.startTimeMs);
  }

  private proc(pid: number, seen: number): ProcAcc {
    let p = this.procs.get(pid);
    if (!p) {
      p = {
        pid,
        firstSeen: seen,
        lastSeen: seen,
        eventCount: 0,
        live: "running",
        exitCode: null,
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
      this.procs.set(pid, p);
    }
    return p;
  }

  private procLabel(pid: number): string {
    const p = this.procs.get(pid);
    return p?.executable ? basename(p.executable) : `PID ${pid}`;
  }

  /**
   * Apply one ordered batch of events. Returns the node ids touched by the
   * batch (for pulse animation), deduped and capped.
   */
  apply(events: readonly GhostGlassEvent[]): string[] {
    const active = new Set<string>();
    const touch = (id: string): void => {
      if (active.size < MAX_PULSE_IDS) active.add(id);
    };

    for (const e of events) {
      const seen = this.offsetMs(e.timestamp);
      this.totalEvents += 1;
      const p = this.proc(e.pid, seen);
      p.eventCount += 1;
      if (seen < p.firstSeen) p.firstSeen = seen;
      if (seen > p.lastSeen) p.lastSeen = seen;
      const pId = `p:${e.pid}`;
      touch(pId);

      if (e.action === "exec") {
        if (e.executable) p.executable = e.executable;
        if (seen < this.earliestExecSeen) {
          this.earliestExecSeen = seen;
          this.rootPid = e.pid;
        }
      } else if (e.action === "exit") {
        p.live = "exited";
        const code = e.metadata?.["code"];
        p.exitCode = typeof code === "number" ? code : null;
      } else if (e.action === "spawn") {
        // Parser semantics (straceParser.ts): e.pid is the spawned child,
        // e.parentPid is the process that created it.
        const childPid = e.pid;
        const parentPid = e.parentPid;
        if (typeof childPid === "number" && typeof parentPid === "number") {
          const child = this.proc(childPid, seen);
          if (child.parentPid === undefined) child.parentPid = parentPid;
          if (e.executable && !child.executable) child.executable = e.executable;
          let m = this.spawns.get(parentPid);
          if (!m) {
            m = new Map();
            this.spawns.set(parentPid, m);
          }
          const s = m.get(childPid);
          if (s) s.eventCount += 1;
          else m.set(childPid, { eventCount: 1, firstSeen: seen });
          touch(`p:${parentPid}`);
        }
      } else if (e.type === "file" && e.path && FILE_ACTIONS.has(e.action)) {
        const key = e.path;
        let f = this.files.get(key);
        if (!f) {
          f = {
            path: key,
            firstSeen: seen,
            lastSeen: seen,
            eventCount: 0,
            counts: { read: 0, write: 0, create: 0, delete: 0, rename: 0, mkdir: 0 },
            pids: new Map(),
          };
          this.files.set(key, f);
        }
        f.eventCount += 1;
        f.counts[e.action as keyof FileAcc["counts"]] += 1;
        f.pids.set(e.pid, (f.pids.get(e.pid) ?? 0) + 1);
        if (seen < f.firstSeen) f.firstSeen = seen;
        if (seen > f.lastSeen) f.lastSeen = seen;
        const akey = `${e.pid}\u0000${key}`;
        let acc = this.access.get(akey);
        if (!acc) {
          acc = { eventCount: 0, actions: {}, firstSeen: seen };
          this.access.set(akey, acc);
        }
        acc.eventCount += 1;
        acc.actions[e.action] = (acc.actions[e.action] ?? 0) + 1;
        if (seen < acc.firstSeen) acc.firstSeen = seen;
        touch(`f:${key}`);
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
        let n = this.nets.get(key);
        if (!n) {
          n = { key, ip: e.ip, port: e.port, firstSeen: seen, lastSeen: seen, attempts: 0, pids: new Map() };
          this.nets.set(key, n);
        }
        n.attempts += 1;
        n.pids.set(e.pid, (n.pids.get(e.pid) ?? 0) + 1);
        if (seen < n.firstSeen) n.firstSeen = seen;
        if (seen > n.lastSeen) n.lastSeen = seen;
        p.stats.networkConnects += 1;
        touch(`n:${key}`);
      }
    }

    return [...active];
  }

  get counters(): LiveCounters {
    let fileEvents = 0;
    for (const f of this.files.values()) fileEvents += f.eventCount;
    let networkAttempts = 0;
    for (const n of this.nets.values()) networkAttempts += n.attempts;
    return {
      processes: this.procs.size,
      files: this.files.size,
      fileEvents,
      networkAttempts,
      totalEvents: this.totalEvents,
    };
  }

  /** Full graph projection, same shape the server indexer produces. */
  toGraph(): ApiGraph {
    // childProcesses counts distinct children (spawn edges), not raw events.
    for (const [parentPid, children] of this.spawns) {
      const parent = this.procs.get(parentPid);
      if (parent) parent.stats.childProcesses = children.size;
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeId = (kind: "p" | "f" | "n", v: string): string => `${kind}:${v}`;

    nodes.push({
      id: "root",
      kind: "root",
      label: this.commandLine,
      sublabel: "traced command",
      eventCount: this.procs.size,
      firstSeenMs: 0,
      lastSeenMs: 0,
      stats: { kind: "root" },
    });

    if (this.rootPid !== undefined && this.procs.has(this.rootPid)) {
      edges.push({
        from: "root",
        to: nodeId("p", String(this.rootPid)),
        kind: "exec",
        eventCount: 1,
        actions: { exec: 1 },
        firstSeenMs: this.earliestExecSeen === Number.POSITIVE_INFINITY ? 0 : this.earliestExecSeen,
      });
    }

    const sortedPids = [...this.procs.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    for (const p of sortedPids) {
      nodes.push({
        id: nodeId("p", String(p.pid)),
        kind: "process",
        label: p.executable ? basename(p.executable) : `PID ${p.pid}`,
        sublabel: p.executable ?? `pid ${p.pid}`,
        pid: p.pid,
        parentPid: p.parentPid,
        executable: p.executable,
        eventCount: p.eventCount,
        firstSeenMs: p.firstSeen,
        lastSeenMs: p.lastSeen,
        stats: { kind: "process", ...p.stats },
        live: { status: p.live, code: p.exitCode },
      });
    }

    for (const [parentPid, children] of this.spawns) {
      if (!this.procs.has(parentPid)) continue;
      for (const [childPid, s] of children) {
        if (!this.procs.has(childPid)) continue;
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

    const sortedFiles = [...this.files.values()].sort((a, b) => b.eventCount - a.eventCount);
    const totalUniqueFiles = sortedFiles.length;
    const keptFiles = sortedFiles.slice(0, MAX_LIVE_FILE_NODES);
    const truncatedFiles = Math.max(0, totalUniqueFiles - keptFiles.length);

    for (const f of keptFiles) {
      const touchedBy = [...f.pids.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([pid]) => ({ pid, label: this.procLabel(pid) }));
      nodes.push({
        id: nodeId("f", f.path),
        kind: "file",
        label: basename(f.path) || f.path,
        sublabel: f.path,
        eventCount: f.eventCount,
        firstSeenMs: f.firstSeen,
        lastSeenMs: f.lastSeen,
        stats: {
          kind: "file",
          read: f.counts.read,
          write: f.counts.write,
          create: f.counts.create,
          delete: f.counts.delete,
          rename: f.counts.rename,
          mkdir: f.counts.mkdir,
          touchedBy,
        },
      });
    }

    // process -> file edges, aggregated per (pid, path), only for kept nodes
    const keptPaths = new Set(keptFiles.map((f) => f.path));
    for (const [akey, acc] of this.access) {
      const sep = akey.indexOf("\u0000");
      const pid = Number(akey.slice(0, sep));
      const fpath = akey.slice(sep + 1);
      if (!this.procs.has(pid) || !keptPaths.has(fpath)) continue;
      edges.push({
        from: nodeId("p", String(pid)),
        to: nodeId("f", fpath),
        kind: "access",
        eventCount: acc.eventCount,
        actions: acc.actions,
        firstSeenMs: acc.firstSeen,
      });
    }

    for (const n of [...this.nets.values()].sort((a, b) => a.firstSeen - b.firstSeen)) {
      const processes = [...n.pids.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([pid]) => ({ pid, label: this.procLabel(pid) }));
      nodes.push({
        id: nodeId("n", n.key),
        kind: "network",
        label: n.key,
        sublabel: "network destination",
        eventCount: n.attempts,
        firstSeenMs: n.firstSeen,
        lastSeenMs: n.lastSeen,
        stats: { kind: "network", attempts: n.attempts, processes },
      });
      for (const [pid, count] of n.pids) {
        if (!this.procs.has(pid)) continue;
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
      runId: this.runId,
      nodes,
      edges,
      totalUniqueFiles,
      truncatedFiles,
      nodeCap: MAX_LIVE_FILE_NODES,
    };
  }
}
