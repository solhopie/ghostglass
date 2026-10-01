/**
 * Viewer HTTP API shapes.
 *
 * The JSON API is the contract between the local viewer server and the
 * browser UI. The browser never reads run files directly; everything flows
 * through these shapes, built by the indexer from events.jsonl.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { RunMetadata } from "../storage/runStore.js";
import type { RunSummary } from "../summary/summarize.js";

export type GraphNodeKind = "root" | "process" | "file" | "network";
export type GraphEdgeKind = "exec" | "spawn" | "access" | "connect";

export interface ProcessNodeStats {
  filesRead: number;
  filesWritten: number;
  filesCreated: number;
  filesDeleted: number;
  filesRenamed: number;
  dirsCreated: number;
  networkConnects: number;
  childProcesses: number;
}

export interface FileNodeStats {
  read: number;
  write: number;
  create: number;
  delete: number;
  rename: number;
  mkdir: number;
  /** Distinct processes that touched this file, most-active first. */
  touchedBy: { pid: number; label: string }[];
}

export interface NetworkNodeStats {
  attempts: number;
  /** Distinct processes that connected here. */
  processes: { pid: number; label: string }[];
}

export type GraphNodeStats =
  | { kind: "root" }
  | ({ kind: "process" } & ProcessNodeStats)
  | ({ kind: "file" } & FileNodeStats)
  | ({ kind: "network" } & NetworkNodeStats);

export interface GraphNode {
  /** "root" | "p:<pid>" | "f:<path>" | "n:<ip>:<port>" */
  id: string;
  kind: GraphNodeKind;
  /** Short display label (basename, "ip:port", command). */
  label: string;
  /** Secondary line: full path, executable, etc. */
  sublabel: string;
  pid?: number;
  parentPid?: number | undefined;
  executable?: string | undefined;
  /** Number of raw events folded into this node (deduplicated entities). */
  eventCount: number;
  /** Milliseconds after run start. */
  firstSeenMs: number;
  lastSeenMs: number;
  stats: GraphNodeStats;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  eventCount: number;
  actions: Record<string, number>;
  firstSeenMs: number;
}

export interface ApiGraph {
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Unique files seen in the trace (before truncation). */
  totalUniqueFiles: number;
  /** Files dropped from the graph to keep rendering fast. */
  truncatedFiles: number;
  nodeCap: number;
}

export interface ApiRunListItem {
  runId: string;
  commandLine: string;
  startTime: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  eventCount: number;
}

export interface ApiRunDetail {
  metadata: RunMetadata;
  summary: RunSummary;
}

export interface ApiEventsPage {
  total: number;
  offset: number;
  limit: number;
  events: GhostGlassEvent[];
}

export interface ApiTimeline {
  /** Absolute epoch ms of run start. */
  startTimeMs: number;
  endTimeMs: number;
  /** Sorted absolute epoch ms, one per event (histograms, duration). */
  timestamps: number[];
  /**
   * Event indices sorted by (timestamp, sequence). Lets the client map a
   * time position back to the right emission-ordered event when timestamp
   * order and emission order differ (reconstructed split syscalls).
   */
  timeOrder?: number[];
}
