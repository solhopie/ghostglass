/**
 * Frontend-owned API shapes. These mirror the JSON served by the local
 * viewer server (src/viewer/protocol.ts); the HTTP API is the contract, so
 * this file is deliberately self-contained rather than importing backend
 * sources.
 */

export type GhostGlassEventType = "process" | "file" | "network";
export type GhostGlassEventAction =
  | "exec"
  | "spawn"
  | "exit"
  | "read"
  | "write"
  | "create"
  | "delete"
  | "rename"
  | "mkdir"
  | "connect";

export interface GhostGlassEvent {
  id: string;
  runId: string;
  timestamp: number;
  /**
   * Ingestion/emission order within the run (starts at 1). Optional for
   * backward compatibility — old runs lack it; readers derive it in
   * memory from event order. Never assume timestamp order == sequence.
   */
  sequence?: number;
  type: GhostGlassEventType;
  action: GhostGlassEventAction;
  pid: number;
  parentPid?: number;
  executable?: string;
  path?: string;
  host?: string;
  ip?: string;
  port?: number;
  metadata?: Record<string, unknown>;
}

export interface RunMetadata {
  ghostglassVersion: string;
  runId: string;
  command: string[];
  commandLine: string;
  startTime: string;
  endTime?: string;
  durationMs: number;
  os: { platform: string; arch: string; release: string };
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  backend: string;
  eventCount: number;
}

export interface RunSummary {
  processCount: number;
  filesystem: { read: number; write: number; create: number; delete: number; rename: number; mkdir: number; total: number };
  network: { attempts: number; destinations: string[] };
  durationMs: number;
  exitCode: number | null;
}

export type GraphNodeKind = "root" | "process" | "file" | "network";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel: string;
  pid?: number;
  parentPid?: number | undefined;
  executable?: string | undefined;
  eventCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  stats: Record<string, unknown>;
  /**
   * Live mode only: process liveness derived from exit events. Absent for
   * saved runs and for non-process nodes.
   */
  live?: { status: "running" | "exited"; code?: number | null } | undefined;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "exec" | "spawn" | "access" | "connect";
  eventCount: number;
  actions: Record<string, number>;
  firstSeenMs: number;
}

export interface ApiGraph {
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalUniqueFiles: number;
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

export interface ApiTimeline {
  startTimeMs: number;
  endTimeMs: number;
  timestamps: number[];
  /**
   * Event indices sorted by (timestamp, sequence). Lets the client map a
   * time position back to the right emission-ordered event when timestamp
   * order and emission order differ (reconstructed split syscalls).
   * Absent in exports generated before Run 9; the client falls back to the
   * legacy sorted-timestamps index.
   */
  timeOrder?: number[];
}

/**
 * Behavior highlight shapes. Mirror of src/highlights/types.ts; highlights
 * describe observed behavior — never security verdicts.
 */
export type HighlightRule =
  | "high-file-activity"
  | "high-process-activity"
  | "high-network-activity"
  | "high-delete-activity"
  | "outside-working-directory"
  | "create-then-execute"
  | "rapid-file-churn";

export type HighlightSeverity = "info" | "notice" | "high";
export type HighlightCategory = "file" | "process" | "network" | "path";

export interface Highlight {
  id: string;
  runId: string;
  rule: HighlightRule;
  severity: HighlightSeverity;
  title: string;
  explanation: string;
  startTimestamp: number;
  endTimestamp?: number;
  pid?: number;
  relatedEventIds: string[];
  metadata: Record<string, unknown>;
}

/**
 * Diff API shapes. Mirror of src/diff/types.ts served by
 * GET /api/diff/<a>/<b>; self-contained so web/dist stays standalone.
 */

export type DiffStatus = "shared" | "changed" | "only-a" | "only-b";
export type DiffSide = "a" | "b";

export interface ProcessSideStats {
  pids: number[];
  executable: string | null;
  argv: string[] | null;
  parentExecutable: string | null;
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
  ambiguous: boolean;
  label: string;
  executable: string | null;
  a: ProcessSideStats | null;
  b: ProcessSideStats | null;
}

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
  touchedBy: { pid: number; executable: string | null; count: number }[];
}

export interface FileDiffEntity {
  kind: "file";
  fingerprint: string;
  status: DiffStatus;
  path: string;
  label: string;
  a: FileSideStats | null;
  b: FileSideStats | null;
}

export interface NetworkSideStats {
  attempts: number;
  firstSeenMs: number;
  lastSeenMs: number;
  processes: { pid: number; executable: string | null; count: number }[];
}

export interface NetworkDiffEntity {
  kind: "network";
  fingerprint: string;
  status: DiffStatus;
  endpoint: string;
  label: string;
  a: NetworkSideStats | null;
  b: NetworkSideStats | null;
}

export type DiffEntity = ProcessDiffEntity | FileDiffEntity | NetworkDiffEntity;

export interface DiffGraphNodeSide {
  firstSeenMs: number;
  lastSeenMs: number;
  eventCount: number;
  stats: Record<string, unknown>;
}

export interface DiffGraphNode {
  id: string;
  kind: "process" | "file" | "network";
  fingerprint: string;
  label: string;
  sublabel: string;
  status: DiffStatus;
  ambiguous: boolean;
  a: DiffGraphNodeSide | null;
  b: DiffGraphNodeSide | null;
}

export interface DiffGraphEdge {
  from: string;
  to: string;
  kind: "spawn" | "access" | "connect";
  status: DiffStatus;
  eventCountA: number;
  eventCountB: number;
  firstSeenMs: number;
}

export interface DiffGraph {
  nodes: DiffGraphNode[];
  edges: DiffGraphEdge[];
  truncated: boolean;
  totalFileEntities: number;
}

export type DiffStreamItem =
  | {
      itemKind: "event";
      side: DiffSide;
      entityKind: "process" | "file" | "network";
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
  streamTruncated: boolean;
  highlightsA: HighlightSummary[];
  highlightsB: HighlightSummary[];
}

export interface HighlightSummary {
  id: string;
  rule: string;
  severity: "info" | "notice" | "high";
  title: string;
  startTimestamp: number;
}

/** Cause-chain API envelope (shapes mirror the vendored cause engine). */
export interface ApiCauseChain {
  runId: string;
  live?: boolean | undefined;
  chain: import("./cause/index.js").CauseChain;
}

