/**
 * Run comparison orchestration.
 *
 * compareRuns() is the single entry point used by both the CLI and the
 * visual viewer. Each run is indexed once (one pass per entity kind, all
 * O(n) with map lookups — no O(n²) pairwise comparisons), entities are
 * matched by fingerprint, and the result bundles:
 *
 *   - summary: numeric deltas (durations, counts, exit codes)
 *   - processes / files / network: matched entity lists
 *   - graph: combined comparison graph for the viewer
 *   - stream: only-a / only-b events plus changed-entity rows
 */
import { basename } from "node:path";
import type { GhostGlassEvent } from "../events/types.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { RunSummary } from "../summary/summarize.js";
import type { GraphNodeStats } from "../viewer/protocol.js";
import { fileFingerprint, networkFingerprint } from "./fingerprints.js";
import { compareFiles, indexRunFiles } from "./compareFiles.js";
import { compareNetwork, indexRunNetwork } from "./compareNetwork.js";
import { compareProcesses, indexRunProcesses } from "./compareProcesses.js";
import type {
  DiffGraph,
  DiffGraphEdge,
  DiffGraphNode,
  DiffStatus,
  DiffStreamItem,
  FileDiffEntity,
  NetworkDiffEntity,
  ProcessDiffEntity,
  RunDiff,
  SummaryDiff,
} from "./types.js";

export interface RunData {
  metadata: RunMetadata;
  summary: RunSummary;
  events: GhostGlassEvent[];
}

/** Cap on file nodes in the combined graph (renderability). */
export const MAX_DIFF_FILE_NODES = 600;
/** Global cap on difference stream items. */
export const MAX_DIFF_STREAM_ITEMS = 5000;
/** Per-entity cap on only-a/only-b stream events. */
const MAX_STREAM_EVENTS_PER_ENTITY = 200;

function startMs(metadata: RunMetadata): number {
  return Date.parse(metadata.startTime);
}

function delta(a: number, b: number): { a: number; b: number; delta: number } {
  return { a, b, delta: b - a };
}

function buildSummary(a: RunData, b: RunData): SummaryDiff {
  return {
    durationMs: delta(a.metadata.durationMs, b.metadata.durationMs),
    processCount: delta(a.summary.processCount, b.summary.processCount),
    eventCount: delta(a.summary.eventCount, b.summary.eventCount),
    exitCode: {
      a: a.metadata.exitCode,
      b: b.metadata.exitCode,
      changed: a.metadata.exitCode !== b.metadata.exitCode,
    },
    interrupted: {
      a: a.metadata.interrupted,
      b: b.metadata.interrupted,
      changed: a.metadata.interrupted !== b.metadata.interrupted,
    },
    filesystem: {
      total: delta(a.summary.filesystem.total, b.summary.filesystem.total),
      read: delta(a.summary.filesystem.read, b.summary.filesystem.read),
      write: delta(a.summary.filesystem.write, b.summary.filesystem.write),
      create: delta(a.summary.filesystem.create, b.summary.filesystem.create),
      delete: delta(a.summary.filesystem.delete, b.summary.filesystem.delete),
      rename: delta(a.summary.filesystem.rename, b.summary.filesystem.rename),
      mkdir: delta(a.summary.filesystem.mkdir, b.summary.filesystem.mkdir),
    },
    networkAttempts: delta(a.summary.network.attempts, b.summary.network.attempts),
  };
}

function procLabel(pid: number, executable: string | null): string {
  return executable ? basename(executable) : `PID ${pid}`;
}

function processNodeStats(e: ProcessDiffEntity, side: "a" | "b"): GraphNodeStats {
  const s = side === "a" ? e.a : e.b;
  if (!s) throw new Error("processNodeStats: missing side");
  return {
    kind: "process",
    filesRead: s.filesRead,
    filesWritten: s.filesWritten,
    filesCreated: s.filesCreated,
    filesDeleted: s.filesDeleted,
    filesRenamed: s.filesRenamed,
    dirsCreated: s.dirsCreated,
    networkConnects: s.networkConnects,
    childProcesses: s.children,
  };
}

function fileNodeStats(e: FileDiffEntity, side: "a" | "b"): GraphNodeStats {
  const s = side === "a" ? e.a : e.b;
  if (!s) throw new Error("fileNodeStats: missing side");
  return {
    kind: "file",
    read: s.read,
    write: s.write,
    create: s.create,
    delete: s.delete,
    rename: s.rename,
    mkdir: s.mkdir,
    touchedBy: s.touchedBy.map((t) => ({ pid: t.pid, label: procLabel(t.pid, t.executable) })),
  };
}

function networkNodeStats(e: NetworkDiffEntity, side: "a" | "b"): GraphNodeStats {
  const s = side === "a" ? e.a : e.b;
  if (!s) throw new Error("networkNodeStats: missing side");
  return {
    kind: "network",
    attempts: s.attempts,
    processes: s.processes.map((p) => ({ pid: p.pid, label: procLabel(p.pid, p.executable) })),
  };
}

function statusRank(s: DiffStatus): number {
  // Changed entities first: they are the interesting part of a diff.
  return s === "changed" ? 0 : s === "only-a" ? 1 : s === "only-b" ? 2 : 3;
}

interface GraphBuild {
  graph: DiffGraph;
  /** "p\0<fp>" / "f\0<fp>" / "n\0<fp>" -> node id */
  nodeIdFor: Map<string, string>;
}

function buildGraph(
  processes: ProcessDiffEntity[],
  files: FileDiffEntity[],
  network: NetworkDiffEntity[],
): GraphBuild {
  const nodes: DiffGraphNode[] = [];
  const nodeIdFor = new Map<string, string>();
  const seq = { process: 0, file: 0, network: 0 };
  const prefix: Record<"process" | "file" | "network", string> = {
    process: "dp",
    file: "df",
    network: "dn",
  };
  const addNode = (
    kind: "process" | "file" | "network",
    fp: string,
    node: Omit<DiffGraphNode, "id" | "kind" | "fingerprint">,
  ): void => {
    const id = `${prefix[kind]}${seq[kind]++}`;
    nodes.push({ ...node, id, kind, fingerprint: fp });
    nodeIdFor.set(`${kind[0] as string}${fp}`, id);
  };

  for (const e of processes) {
    addNode("process", e.fingerprint, {
      label: e.label,
      sublabel:
        (e.a?.argv ?? e.b?.argv)?.join(" ") ??
        e.executable ??
        (e.ambiguous ? "several matched processes" : e.label),
      status: e.status,
      ambiguous: e.ambiguous,
      a: e.a
        ? {
            firstSeenMs: e.a.firstSeenMs,
            lastSeenMs: e.a.lastSeenMs,
            eventCount: e.a.eventCount,
            stats: processNodeStats(e, "a"),
          }
        : null,
      b: e.b
        ? {
            firstSeenMs: e.b.firstSeenMs,
            lastSeenMs: e.b.lastSeenMs,
            eventCount: e.b.eventCount,
            stats: processNodeStats(e, "b"),
          }
        : null,
    });
  }

  const sortedFiles = [...files].sort((x, y) => statusRank(x.status) - statusRank(y.status));
  const keptFiles = sortedFiles.slice(0, MAX_DIFF_FILE_NODES);
  for (const e of keptFiles) {
    addNode("file", e.fingerprint, {
      label: e.label,
      sublabel: e.path,
      status: e.status,
      ambiguous: false,
      a: e.a
        ? {
            firstSeenMs: e.a.firstSeenMs,
            lastSeenMs: e.a.lastSeenMs,
            eventCount: e.a.eventCount,
            stats: fileNodeStats(e, "a"),
          }
        : null,
      b: e.b
        ? {
            firstSeenMs: e.b.firstSeenMs,
            lastSeenMs: e.b.lastSeenMs,
            eventCount: e.b.eventCount,
            stats: fileNodeStats(e, "b"),
          }
        : null,
    });
  }

  for (const e of network) {
    addNode("network", e.fingerprint, {
      label: e.label,
      sublabel: "network destination",
      status: e.status,
      ambiguous: false,
      a: e.a
        ? {
            firstSeenMs: e.a.firstSeenMs,
            lastSeenMs: e.a.lastSeenMs,
            eventCount: e.a.attempts,
            stats: networkNodeStats(e, "a"),
          }
        : null,
      b: e.b
        ? {
            firstSeenMs: e.b.firstSeenMs,
            lastSeenMs: e.b.lastSeenMs,
            eventCount: e.b.attempts,
            stats: networkNodeStats(e, "b"),
          }
        : null,
    });
  }

  return {
    graph: {
      nodes,
      edges: [],
      truncated: sortedFiles.length > keptFiles.length,
      totalFileEntities: files.length,
    },
    nodeIdFor,
  };
}

/** pid -> process fingerprint, for edge and stream wiring. */
function pidFingerprintMap(
  events: GhostGlassEvent[],
  startTimeMs: number,
  salt: string,
): Map<number, string> {
  const idx = indexRunProcesses(events, startTimeMs, salt);
  const out = new Map<number, string>();
  for (const [fp, pids] of idx.byFingerprint) {
    for (const pid of pids) out.set(pid, fp);
  }
  return out;
}

function wireEdges(
  run: RunData,
  start: number,
  side: "a" | "b",
  pidFp: Map<number, string>,
  nodeIdFor: Map<string, string>,
  edgeMap: Map<string, DiffGraphEdge>,
): void {
  for (const e of run.events) {
    const seen = Math.max(0, e.timestamp - start);
    const pfp = pidFp.get(e.pid);
    let fromFp: string | undefined;
    let toFp: string | undefined;
    let kind: DiffGraphEdge["kind"] | undefined;
    if (e.action === "spawn" && typeof e.parentPid === "number") {
      fromFp = pidFp.get(e.parentPid);
      toFp = pfp;
      kind = "spawn";
    } else if (e.type === "file" && e.path) {
      fromFp = pfp;
      toFp = fileFingerprint(e.path);
      kind = "access";
    } else if (e.type === "network" && e.action === "connect" && e.ip != null && e.port != null) {
      fromFp = pfp;
      toFp = networkFingerprint(e.ip, e.port);
      kind = "connect";
    }
    if (!fromFp || !toFp || !kind) continue;
    // fromFp is always a process fingerprint; toFp is process (spawn),
    // file, or network depending on kind.
    const from = nodeIdFor.get(`p${fromFp}`);
    const toKey = kind === "spawn" ? `p${toFp}` : kind === "access" ? `f${toFp}` : `n${toFp}`;
    const to = nodeIdFor.get(toKey);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}|${kind}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, kind, status: "shared", eventCountA: 0, eventCountB: 0, firstSeenMs: seen };
      edgeMap.set(key, edge);
    }
    if (side === "a") edge.eventCountA += 1;
    else edge.eventCountB += 1;
    if (seen < edge.firstSeenMs) edge.firstSeenMs = seen;
  }
}

export function compareRuns(a: RunData, b: RunData): RunDiff {
  const startA = startMs(a.metadata);
  const startB = startMs(b.metadata);

  // Per-run single-pass indexes (all O(n)). The salts keep unknown-identity
  // processes from merging across runs (see indexRunProcesses).
  const saltA = `run:${a.metadata.runId}`;
  const saltB = `run:${b.metadata.runId}`;
  const procA = indexRunProcesses(a.events, startA, saltA);
  const procB = indexRunProcesses(b.events, startB, saltB);
  const exeA = new Map<number, string | null>();
  const exeB = new Map<number, string | null>();
  for (const [pid, acc] of procA.byPid) exeA.set(pid, acc.executable);
  for (const [pid, acc] of procB.byPid) exeB.set(pid, acc.executable);

  const processes = compareProcesses(procA, procB);
  const files = compareFiles(
    indexRunFiles(a.events, startA, exeA),
    indexRunFiles(b.events, startB, exeB),
  );
  const network = compareNetwork(
    indexRunNetwork(a.events, startA, exeA),
    indexRunNetwork(b.events, startB, exeB),
  );

  const { graph, nodeIdFor } = buildGraph(processes, files, network);

  // Combined edges: one pass per run over events, mapping runtime PIDs to
  // fingerprint node ids. Edge present in both runs -> shared.
  const edgeMap = new Map<string, DiffGraphEdge>();
  wireEdges(a, startA, "a", pidFingerprintMap(a.events, startA, saltA), nodeIdFor, edgeMap);
  wireEdges(b, startB, "b", pidFingerprintMap(b.events, startB, saltB), nodeIdFor, edgeMap);
  const edges: DiffGraphEdge[] = [];
  for (const e of edgeMap.values()) {
    e.status = e.eventCountA > 0 && e.eventCountB > 0 ? "shared" : e.eventCountA > 0 ? "only-a" : "only-b";
    edges.push(e);
  }
  edges.sort((x, y) => x.firstSeenMs - y.firstSeenMs);
  graph.edges = edges;

  // Difference stream: changed-entity rows first, then only-a/only-b events
  // in per-run chronological order.
  type ChangedRow = Extract<DiffStreamItem, { itemKind: "changed" }>;
  type EventRow = Extract<DiffStreamItem, { itemKind: "event" }>;
  const changedRows: ChangedRow[] = [];
  const pushChanged = (
    entityKind: "process" | "file" | "network",
    fingerprint: string,
    label: string,
    sublabel: string,
  ): void => {
    changedRows.push({ itemKind: "changed", entityKind, fingerprint, label, sublabel });
  };
  for (const e of processes) {
    if (e.status === "changed") pushChanged("process", e.fingerprint, e.label, e.executable ?? e.label);
  }
  for (const e of files) {
    if (e.status === "changed") pushChanged("file", e.fingerprint, e.label, e.path);
  }
  for (const e of network) {
    if (e.status === "changed") pushChanged("network", e.fingerprint, e.label, "network destination");
  }
  changedRows.sort((x, y) =>
    x.entityKind === y.entityKind
      ? x.label.localeCompare(y.label)
      : x.entityKind.localeCompare(y.entityKind),
  );

  const statusByFp = new Map<string, DiffStatus>();
  for (const e of processes) statusByFp.set(`p${e.fingerprint}`, e.status);
  for (const e of files) statusByFp.set(`f${e.fingerprint}`, e.status);
  for (const e of network) statusByFp.set(`n${e.fingerprint}`, e.status);

  const entityEventCounts = new Map<string, number>();
  const eventItems: EventRow[] = [];
  const wireStream = (
    run: RunData,
    start: number,
    side: "a" | "b",
    pidFp: Map<number, string>,
  ): void => {
    for (const e of run.events) {
      let entityKind: "process" | "file" | "network" | null = null;
      let key: string | null = null;
      let fingerprint: string | null = null;
      let label = "";
      if (e.action === "exec" || e.action === "spawn" || e.action === "exit") {
        const fp = pidFp.get(e.pid);
        if (!fp) continue;
        entityKind = "process";
        fingerprint = fp;
        key = `p${fp}`;
        label = procLabel(e.pid, null);
      } else if (e.type === "file" && e.path) {
        entityKind = "file";
        fingerprint = fileFingerprint(e.path);
        key = `f${fingerprint}`;
        label = basename(e.path) || e.path;
      } else if (e.type === "network" && e.action === "connect" && e.ip != null && e.port != null) {
        entityKind = "network";
        fingerprint = networkFingerprint(e.ip, e.port);
        key = `n${fingerprint}`;
        label = fingerprint;
      }
      if (!entityKind || !key || !fingerprint) continue;
      const status = statusByFp.get(key);
      const want = side === "a" ? status === "only-a" : status === "only-b";
      if (!want) continue;
      const capKey = `${side}${key}`;
      const used = entityEventCounts.get(capKey) ?? 0;
      if (used >= MAX_STREAM_EVENTS_PER_ENTITY) continue;
      entityEventCounts.set(capKey, used + 1);
      eventItems.push({
        itemKind: "event",
        side,
        entityKind,
        fingerprint,
        entityLabel: label,
        offsetMs: Math.max(0, e.timestamp - start),
        event: e,
      });
    }
  };
  wireStream(a, startA, "a", pidFingerprintMap(a.events, startA, saltA));
  wireStream(b, startB, "b", pidFingerprintMap(b.events, startB, saltB));
  eventItems.sort((x, y) =>
    x.offsetMs === y.offsetMs
      ? x.side === y.side
        ? 0
        : x.side === "a"
          ? -1
          : 1
      : x.offsetMs - y.offsetMs,
  );

  const allItems = [...changedRows, ...eventItems];
  const streamTruncated = allItems.length > MAX_DIFF_STREAM_ITEMS;

  return {
    runA: a.metadata,
    runB: b.metadata,
    summary: buildSummary(a, b),
    processes,
    files,
    network,
    graph,
    stream: allItems.slice(0, MAX_DIFF_STREAM_ITEMS),
    streamTruncated,
  };
}
