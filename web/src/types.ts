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
}
