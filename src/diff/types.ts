/**
 * Diff result model: comparing two GhostGlass runs.
 *
 * Runs have different PIDs, timestamps, event IDs, and run IDs, so entities
 * are matched by stable *fingerprints* (see fingerprints.ts), never by
 * runtime IDs alone. Every entity is classified as one of:
 *
 *   shared  — present in both runs with equivalent activity
 *   changed — present in both runs but with different activity
 *   only-a  — present only in run A
 *   only-b  — present only in run B
 *
 * Ambiguous matches (a fingerprint colliding with several processes inside
 * one run) are flagged rather than silently merged — the UI surfaces the
 * ambiguity instead of inventing certainty.
 *
 * The model is deliberately generic so it can back the CLI summary, the
 * visual viewer, and a future HTML export without change.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { GraphNodeStats } from "../viewer/protocol.js";

export type DiffStatus = "shared" | "changed" | "only-a" | "only-b";

export type DiffSide = "a" | "b";

/** Per-run view of one logical process (possibly several PIDs). */
export interface ProcessSideStats {
  /** All PIDs in this run that share the fingerprint, first-seen order. */
  pids: number[];
  executable: string | null;
  /** argv from the representative exec event, when captured. */
  argv: string[] | null;
  /** Executable of the spawning parent, when known. */
  parentExecutable: string | null;
  /** Distinct child PIDs spawned by these processes. */
  children: number;
  filesRead: number;
  filesWritten: number;
  filesCreated: number;
  filesDeleted: number;
  filesRenamed: number;
  dirsCreated: number;
  networkConnects: number;
  eventCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface ProcessDiffEntity {
  kind: "process";
  fingerprint: string;
  status: DiffStatus;
  /** True when several PIDs in one run share this fingerprint. */
  ambiguous: boolean;
  label: string;
  executable: string | null;
  a: ProcessSideStats | null;
  b: ProcessSideStats | null;
}

/** Per-run view of one file path. */
export interface FileSideStats {
  read: number;
  write: number;
  create: number;
  delete: number;
  rename: number;
  mkdir: number;
  eventCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /** pid -> event count, most active first (capped). */
  touchedBy: { pid: number; executable: string | null; count: number }[];
}

export interface FileDiffEntity {
  kind: "file";
  fingerprint: string;
  status: DiffStatus;
  /** The file path (also the fingerprint). */
  path: string;
  label: string;
  a: FileSideStats | null;
  b: FileSideStats | null;
}

/** Per-run view of one network destination. */
export interface NetworkSideStats {
  attempts: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /** pid -> attempt count, most active first (capped). */
  processes: { pid: number; executable: string | null; count: number }[];
}

export interface NetworkDiffEntity {
  kind: "network";
  fingerprint: string;
  status: DiffStatus;
  /** "ip:port" (also the fingerprint). */
  endpoint: string;
  label: string;
  a: NetworkSideStats | null;
  b: NetworkSideStats | null;
}

export type DiffEntity = ProcessDiffEntity | FileDiffEntity | NetworkDiffEntity;

/** Combined comparison graph node (one per matched entity). */
export interface DiffGraphNode {
  id: string;
  kind: "process" | "file" | "network";
  /** Opaque match key; links the node back to its entity for the inspector. */
  fingerprint: string;
  label: string;
  sublabel: string;
  status: DiffStatus;
  ambiguous: boolean;
  a: { firstSeenMs: number; lastSeenMs: number; eventCount: number; stats: GraphNodeStats } | null;
  b: { firstSeenMs: number; lastSeenMs: number; eventCount: number; stats: GraphNodeStats } | null;
}

export type DiffGraphEdgeKind = "spawn" | "access" | "connect";

export interface DiffGraphEdge {
  from: string;
  to: string;
  kind: DiffGraphEdgeKind;
  status: DiffStatus;
  eventCountA: number;
  eventCountB: number;
  firstSeenMs: number;
}

export interface DiffGraph {
  nodes: DiffGraphNode[];
  edges: DiffGraphEdge[];
  /** True when file nodes were capped for renderability. */
  truncated: boolean;
  totalFileEntities: number;
}

export type DiffStreamItem =
  | {
      itemKind: "event";
      side: DiffSide;
      entityKind: "process" | "file" | "network";
      /** Opaque match key of the entity this event belongs to. */
      fingerprint: string;
      entityLabel: string;
      offsetMs: number;
      event: GhostGlassEvent;
    }
  | {
      itemKind: "changed";
      entityKind: "process" | "file" | "network";
      fingerprint: string;
      label: string;
      sublabel: string;
    };

export interface DeltaNumber {
  a: number;
  b: number;
  delta: number;
}

export interface SummaryDiff {
  durationMs: DeltaNumber;
  processCount: DeltaNumber;
  eventCount: DeltaNumber;
  exitCode: { a: number | null; b: number | null; changed: boolean };
  interrupted: { a: boolean; b: boolean; changed: boolean };
  filesystem: {
    total: DeltaNumber;
    read: DeltaNumber;
    write: DeltaNumber;
    create: DeltaNumber;
    delete: DeltaNumber;
    rename: DeltaNumber;
    mkdir: DeltaNumber;
  };
  networkAttempts: DeltaNumber;
}

export interface RunDiff {
  runA: RunMetadata;
  runB: RunMetadata;
  summary: SummaryDiff;
  processes: ProcessDiffEntity[];
  files: FileDiffEntity[];
  network: NetworkDiffEntity[];
  graph: DiffGraph;
  stream: DiffStreamItem[];
  /** True when the stream was capped (see MAX_DIFF_STREAM_ITEMS). */
  streamTruncated: boolean;
}
