/**
 * Cause Chain: deterministic execution-path reconstruction.
 *
 * Answers "what chain of execution caused this?" for a file, network
 * destination, process, event, or behavior highlight — using ONLY recorded
 * GhostGlass evidence. No AI, no guessing, no intent inference.
 *
 * Confidence model:
 * - DIRECT: the target relationship is explicitly represented by an event
 *   (e.g. "PID 4182 issued WRITE on package-lock.json").
 * - STRUCTURAL: the path combines recorded process ancestry with a direct
 *   target event (e.g. npm spawned node, and node wrote the file).
 * - INCOMPLETE: part of the parent chain was not captured in the trace.
 *
 * Wording rule: "Execution path leading to this event" — never
 * "the reason the developer wanted this".
 */

export type CauseNodeKind =
  | "root-command"
  | "process"
  | "event"
  | "file"
  | "network"
  | "highlight";

export type CauseEdgeKind =
  | "spawned"
  | "read"
  | "wrote"
  | "created"
  | "deleted"
  | "renamed"
  | "connected"
  | "triggered";

export type CauseConfidence = "direct" | "structural" | "incomplete";

export interface CauseNode {
  /** Stable id, e.g. "process:4182", "file:/x/package-lock.json", "event:gg_1-42". */
  id: string;
  kind: CauseNodeKind;
  /** Human label, trace-derived (redaction applied by callers when exporting). */
  label: string;
  /** Epoch ms when this node entered the chain (for timeline display). */
  timestamp?: number | undefined;
  /** Optional detail lines for the evidence panel. */
  detail?: string | undefined;
  /** Event id backing this node, when applicable (for timeline seek). */
  eventId?: string | undefined;
  /** PID backing this node, when applicable. */
  pid?: number | undefined;
}

export interface CauseEdge {
  from: string;
  to: string;
  kind: CauseEdgeKind;
  /** Epoch ms of the underlying event (for timeline ordering). */
  timestamp?: number | undefined;
  /** Backing event id, when the edge is a direct event. */
  eventId?: string | undefined;
  /** One-line evidence, e.g. "npm PID 4101 → node PID 4182". */
  evidence?: string | undefined;
}

export type CauseTarget =
  | { kind: "event"; eventId: string }
  | { kind: "pid"; pid: number }
  | { kind: "file"; path: string }
  | { kind: "network"; destination: string }
  | { kind: "highlight"; highlightId: string };

export interface CausePath {
  /** One contributing path (multiple when several processes touched the target). */
  label: string;
  nodes: CauseNode[];
  edges: CauseEdge[];
}

export interface CauseChain {
  target: CauseTarget;
  /** Human-readable target label, e.g. "package-lock.json". */
  targetLabel: string;
  /** One path per contributing process; never merge unrelated paths. */
  paths: CausePath[];
  confidence: CauseConfidence;
  /** Deterministic template-generated explanation (no AI). */
  explanation: string;
  /** Grounded evidence lines, each traceable to a real event. */
  evidence: string[];
  /** True when part of the ancestry was not captured. */
  incomplete: boolean;
  /** Epoch ms of the traced command start (for +offset display). */
  runStartMs: number;
}

/** A file query that matched more than one path. */
export interface AmbiguousFileTarget {
  ambiguous: true;
  query: string;
  matches: string[];
}
