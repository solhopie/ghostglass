/**
 * buildCauseChain: the single entry point for cause-chain generation.
 *
 * Given a target (event, pid, file, network destination, or highlight),
 * reconstruct the recorded execution path that led to it. All logic here is
 * deterministic and evidence-grounded: every node and edge traces back to
 * real events in the cause index.
 *
 * Multiple contributing processes produce multiple paths — never merged
 * into a fake single chain.
 */
import type { GhostGlassEvent } from "../events/types.js";
import type { Highlight } from "../highlights/types.js";
import type { CauseIndex, ProcessInfo } from "./causeIndex.js";
import { rootPidOf } from "./causeIndex.js";
import {
  reconstructAncestry,
  processLabel,
  isRootProcess,
} from "./processAncestry.js";
import {
  eventsForFile,
  eventsForNetwork,
  actorsForFile,
  fileEdgeKind,
  resolveFileQuery,
} from "./eventLinks.js";
import { networkKey } from "./causeIndex.js";
import { buildExplanation } from "./explain.js";
import type {
  CauseChain,
  CauseEdge,
  CauseNode,
  CausePath,
  CauseTarget,
  CauseConfidence,
  AmbiguousFileTarget,
} from "./types.js";

export interface ChainInput {
  index: CauseIndex;
  /** Traced command line for the root-command node (from run metadata). */
  commandLine: string;
  /** Lookup for highlight targets. */
  highlights?: Highlight[] | undefined;
}

export type ChainResult =
  | { ok: true; chain: CauseChain }
  | { ok: false; error: string; ambiguous?: AmbiguousFileTarget | undefined };

function procNode(info: ProcessInfo, timestamp?: number): CauseNode {
  return {
    id: `process:${info.pid}`,
    kind: "process",
    label: processLabel(info),
    timestamp,
    detail: `PID ${info.pid}${info.executable ? ` · ${info.executable}` : ""}`,
    pid: info.pid,
  };
}

function rootNode(commandLine: string, pid: number | undefined, timestamp: number): CauseNode {
  return {
    id: "root-command",
    kind: "root-command",
    label: commandLine || "traced command",
    timestamp,
    detail: pid !== undefined ? `Root process · PID ${pid}` : "Root process",
    pid,
  };
}

function eventNode(e: GhostGlassEvent): CauseNode {
  const what = e.path ?? networkKey(e) ?? e.action;
  return {
    id: `event:${e.id}`,
    kind: "event",
    label: `${e.action.toUpperCase()} ${what}`,
    timestamp: e.timestamp,
    detail: `${e.type}:${e.action} · PID ${e.pid}`,
    eventId: e.id,
    pid: e.pid,
  };
}

/**
 * Build the ancestry portion of a path: root-command -> ... -> process.
 * Returns the nodes/edges plus whether any link was missing.
 */
function ancestryPath(
  index: CauseIndex,
  pid: number,
  commandLine: string,
): { nodes: CauseNode[]; edges: CauseEdge[]; incomplete: boolean; evidence: string[] } {
  const nodes: CauseNode[] = [];
  const edges: CauseEdge[] = [];
  const evidence: string[] = [];
  const result = reconstructAncestry(index, pid);

  if (result.chain.length === 0) {
    // PID never observed: represent honestly with a placeholder process node.
    nodes.push({
      id: `process:${pid}`,
      kind: "process",
      label: `PID ${pid}`,
      detail: `PID ${pid} · not observed in this trace`,
      pid,
    });
    return { nodes, edges, incomplete: true, evidence };
  }

  const rootStep = result.chain[0] as (typeof result.chain)[number];
  const rootPid = rootPidOf(index);
  const chainIsRooted = rootPid !== undefined && rootStep.pid === rootPid;

  // Root-command node: the traced command. When the chain reaches the
  // recorded root process, the root-command node stands for it.
  const firstInfo = rootStep.info;
  nodes.push(rootNode(commandLine, chainIsRooted ? rootStep.pid : undefined, firstInfo.firstSeen));
  if (chainIsRooted) {
    nodes.push(procNode(firstInfo, firstInfo.firstSeen));
    edges.push({
      from: "root-command",
      to: `process:${firstInfo.pid}`,
      kind: "spawned",
      timestamp: firstInfo.firstSeen,
      evidence: `traced command started as PID ${firstInfo.pid}`,
    });
  } else {
    // Orphan process: observed but its parent was not captured. Show the
    // process node itself (honestly labeled) so callers never dangle an
    // edge to a missing node.
    const orphan = procNode(firstInfo, firstInfo.firstSeen);
    orphan.detail = `${orphan.detail ?? ""} · parent not captured in this trace`.trim();
    nodes.push(orphan);
  }

  for (let i = 1; i < result.chain.length; i++) {
    const step = result.chain[i] as (typeof result.chain)[number];
    const prev = result.chain[i - 1] as (typeof result.chain)[number];
    const nodeId = `process:${step.pid}`;
    nodes.push(procNode(step.info, step.info.firstSeen));
    const spawnEvent = step.spawnEventId ? index.eventById.get(step.spawnEventId) : undefined;
    const parentLabel = processLabel(prev.info);
    const childLabel = processLabel(step.info);
    const ev = `PROCESS SPAWN · ${parentLabel} PID ${prev.pid} → ${childLabel} PID ${step.pid}`;
    edges.push({
      from: `process:${prev.pid}`,
      to: nodeId,
      kind: "spawned",
      timestamp: spawnEvent?.timestamp ?? step.info.firstSeen,
      eventId: spawnEvent?.id,
      evidence: ev,
    });
    evidence.push(ev);
  }

  if (result.incomplete) {
    const topPid = result.missingParentOf ?? result.chain[result.chain.length - 1]?.pid;
    evidence.push(
      `Parent chain incomplete: PID ${topPid} was observed but its parent was not captured in this trace.`,
    );
  }

  return { nodes, edges, incomplete: result.incomplete || result.cycleBroken, evidence };
}

/** Confidence for a chain: direct target event + complete ancestry. */
function confidenceFor(hasDirectEvent: boolean, incomplete: boolean): CauseConfidence {
  if (incomplete) return "incomplete";
  return hasDirectEvent ? "direct" : "structural";
}

function finalize(
  input: ChainInput,
  target: CauseTarget,
  targetLabel: string,
  paths: CausePath[],
  evidence: string[],
  incomplete: boolean,
  hasDirectEvent: boolean,
): ChainResult {
  const confidence = confidenceFor(hasDirectEvent, incomplete);
  const chain: CauseChain = {
    target,
    targetLabel,
    paths,
    confidence,
    explanation: buildExplanation(input, target, targetLabel, paths, confidence, incomplete),
    evidence,
    incomplete,
    runStartMs: input.index.runStartMs,
  };
  return { ok: true, chain };
}

/** Cause chain for one event: execution path of the process that did it. */
function chainForEvent(input: ChainInput, e: GhostGlassEvent): ChainResult {
  const { index, commandLine } = input;
  const a = ancestryPath(index, e.pid, commandLine);
  const nodes = [...a.nodes, eventNode(e)];
  const procId = `process:${e.pid}`;
  const edgeKind: CauseEdge["kind"] =
    e.type === "network" ? "connected" : (fileEdgeKind(e.action) ?? "triggered");
  const targetDesc =
    e.type === "file" && e.path
      ? e.path
      : e.type === "network"
        ? (networkKey(e) ?? "network")
        : `${e.type}:${e.action}`;
  const ev = `${e.type.toUpperCase()} ${e.action.toUpperCase()} · ${processLabel(
    index.processByPid.get(e.pid) ?? { pid: e.pid, firstSeen: e.timestamp },
  )} PID ${e.pid} → ${targetDesc}`;
  const edges: CauseEdge[] = [
    ...a.edges,
    { from: procId, to: `event:${e.id}`, kind: edgeKind, timestamp: e.timestamp, eventId: e.id, evidence: ev },
  ];
  const evidence = [...a.evidence, ev];
  const paths: CausePath[] = [
    {
      label: `Path via PID ${e.pid}`,
      nodes,
      edges,
    },
  ];
  return finalize(
    input,
    { kind: "event", eventId: e.id },
    `${e.action.toUpperCase()} ${targetDesc}`,
    paths,
    evidence,
    a.incomplete,
    true,
  );
}

/** Cause chain for a process: why does this process exist? */
function chainForPid(input: ChainInput, pid: number): ChainResult {
  const { index, commandLine } = input;
  const info = index.processByPid.get(pid);
  if (!info) {
    return { ok: false, error: `PID ${pid} was not observed in this trace.` };
  }
  const a = ancestryPath(index, pid, commandLine);
  const label = processLabel(info);
  const paths: CausePath[] = [{ label: `Ancestry of ${label} (PID ${pid})`, nodes: a.nodes, edges: a.edges }];
  return finalize(
    input,
    { kind: "pid", pid },
    `${label} (PID ${pid})`,
    paths,
    a.evidence,
    a.incomplete,
    false,
  );
}

/** Cause chain for a file: which processes touched it, and how did they get there? */
function chainForFile(input: ChainInput, path: string): ChainResult {
  const { index, commandLine } = input;
  const events = eventsForFile(index, path);
  if (events.length === 0) {
    return { ok: false, error: `No recorded events touched "${path}" in this trace.` };
  }
  const actors = actorsForFile(index, path);
  const paths: CausePath[] = [];
  const evidence: string[] = [];
  let incomplete = false;

  for (const actor of actors) {
    const a = ancestryPath(index, actor.pid, commandLine);
    incomplete = incomplete || a.incomplete;
    const procId = `process:${actor.pid}`;
    const fileNode: CauseNode = {
      id: `file:${path}`,
      kind: "file",
      label: path,
      timestamp: events[events.length - 1]?.timestamp,
      detail: `${events.length} events · ${actor.writes} writes · ${actor.reads} reads by PID ${actor.pid}`,
    };
    // Link the process to the file via its most representative event
    // (latest write, else latest event).
    const actorEvents = events.filter((e) => e.pid === actor.pid);
    const linkEvent =
      [...actorEvents].reverse().find((e) => e.action === "write" || e.action === "create") ??
      actorEvents[actorEvents.length - 1];
    const edgeKind = linkEvent ? (fileEdgeKind(linkEvent.action) ?? "triggered") : "triggered";
    const actorLabel = processLabel(index.processByPid.get(actor.pid) ?? { pid: actor.pid, firstSeen: 0 });
    const ev = `FILE ${edgeKind.toUpperCase()} · ${actorLabel} PID ${actor.pid} → ${path} (${actor.eventCount} events)`;
    const pathEvidence = [...a.evidence, ev];
    evidence.push(...pathEvidence);
    paths.push({
      label: `${actorLabel} (PID ${actor.pid}) — ${actor.eventCount} events`,
      nodes: [...a.nodes, fileNode],
      edges: [
        ...a.edges,
        {
          from: procId,
          to: `file:${path}`,
          kind: edgeKind,
          timestamp: linkEvent?.timestamp,
          eventId: linkEvent?.id,
          evidence: ev,
        },
      ],
    });
  }

  return finalize(
    input,
    { kind: "file", path },
    path,
    paths,
    evidence,
    incomplete,
    true,
  );
}

/** Cause chain for a network destination: why was this connection attempted? */
function chainForNetwork(input: ChainInput, destination: string): ChainResult {
  const { index, commandLine } = input;
  const events = eventsForNetwork(index, destination);
  if (events.length === 0) {
    const known = [...index.eventsByNetwork.keys()].slice(0, 5);
    const hint = known.length > 0 ? ` Known destinations include: ${known.join(", ")}.` : "";
    return { ok: false, error: `No recorded connection to "${destination}" in this trace.${hint}` };
  }
  const byPid = new Map<number, GhostGlassEvent[]>();
  for (const e of events) {
    const list = byPid.get(e.pid) ?? [];
    list.push(e);
    byPid.set(e.pid, list);
  }
  const paths: CausePath[] = [];
  const evidence: string[] = [];
  let incomplete = false;
  const key = networkKey(events[0] as GhostGlassEvent) ?? destination;

  for (const [pid, pidEvents] of [...byPid.entries()].sort((a, b) => a[0] - b[0])) {
    const a = ancestryPath(index, pid, commandLine);
    incomplete = incomplete || a.incomplete;
    const first = pidEvents[0] as GhostGlassEvent;
    const actorLabel = processLabel(index.processByPid.get(pid) ?? { pid, firstSeen: 0 });
    const netNode: CauseNode = {
      id: `network:${key}`,
      kind: "network",
      label: key,
      timestamp: first.timestamp,
      detail: `${pidEvents.length} connection attempt${pidEvents.length === 1 ? "" : "s"} by PID ${pid}${
        first.host ? ` · host "${first.host}" captured` : ""
      }`,
      eventId: first.id,
      pid,
    };
    const ev = `NETWORK CONNECT · ${actorLabel} PID ${pid} → ${key}`;
    evidence.push(...a.evidence, ev);
    paths.push({
      label: `${actorLabel} (PID ${pid}) — ${pidEvents.length} attempt${pidEvents.length === 1 ? "" : "s"}`,
      nodes: [...a.nodes, netNode],
      edges: [
        ...a.edges,
        {
          from: `process:${pid}`,
          to: `network:${key}`,
          kind: "connected",
          timestamp: first.timestamp,
          eventId: first.id,
          evidence: ev,
        },
      ],
    });
  }

  return finalize(
    input,
    { kind: "network", destination: key },
    key,
    paths,
    evidence,
    incomplete,
    true,
  );
}

/** Cause chain for a behavior highlight: the process/event chain behind it. */
function chainForHighlight(input: ChainInput, highlight: Highlight): ChainResult {
  const { index, commandLine } = input;
  const related = highlight.relatedEventIds
    .map((id) => index.eventById.get(id))
    .filter((e): e is GhostGlassEvent => e !== undefined);

  if (related.length === 0 && highlight.pid === undefined) {
    return {
      ok: false,
      error: `Highlight "${highlight.id}" has no recorded events to trace in this run.`,
    };
  }

  // Group related events by PID; fall back to the highlight's pid.
  const byPid = new Map<number, GhostGlassEvent[]>();
  for (const e of related) {
    const list = byPid.get(e.pid) ?? [];
    list.push(e);
    byPid.set(e.pid, list);
  }
  if (byPid.size === 0 && highlight.pid !== undefined) {
    byPid.set(highlight.pid, []);
  }

  const paths: CausePath[] = [];
  const evidence: string[] = [];
  let incomplete = false;

  for (const [pid, pidEvents] of [...byPid.entries()].sort((a, b) => a[0] - b[0])) {
    const a = ancestryPath(index, pid, commandLine);
    incomplete = incomplete || a.incomplete;
    const actorLabel = processLabel(index.processByPid.get(pid) ?? { pid, firstSeen: 0 });
    const hlNode: CauseNode = {
      id: `highlight:${highlight.id}`,
      kind: "highlight",
      label: highlight.title,
      timestamp: highlight.startTimestamp,
      detail: `${highlight.rule} · ${pidEvents.length} related events from PID ${pid}`,
    };
    // "triggered" edge: the highlight was derived from this process's events.
    const triggerEvent = pidEvents[pidEvents.length - 1];
    const ev = `HIGHLIGHT TRIGGERED · ${pidEvents.length} events from ${actorLabel} PID ${pid} → "${highlight.title}"`;
    evidence.push(...a.evidence, ev);
    paths.push({
      label: `${actorLabel} (PID ${pid}) — ${pidEvents.length} related events`,
      nodes: [...a.nodes, hlNode],
      edges: [
        ...a.edges,
        {
          from: `process:${pid}`,
          to: `highlight:${highlight.id}`,
          kind: "triggered",
          timestamp: triggerEvent?.timestamp ?? highlight.startTimestamp,
          eventId: triggerEvent?.id,
          evidence: ev,
        },
      ],
    });
  }

  return finalize(
    input,
    { kind: "highlight", highlightId: highlight.id },
    highlight.title,
    paths,
    evidence,
    incomplete,
    related.length > 0,
  );
}

/**
 * Main entry: build a cause chain for any supported target.
 * Pure and deterministic: same index + same target => same chain.
 */
export function buildCauseChain(input: ChainInput, target: CauseTarget): ChainResult {
  const { index } = input;
  switch (target.kind) {
    case "event": {
      const e = index.eventById.get(target.eventId);
      if (!e) return { ok: false, error: `Event "${target.eventId}" not found in this trace.` };
      return chainForEvent(input, e);
    }
    case "pid":
      return chainForPid(input, target.pid);
    case "file": {
      const resolved = resolveFileQuery(index, target.path);
      if (resolved.kind === "none") {
        return { ok: false, error: `No recorded events touched "${target.path}" in this trace.` };
      }
      if (resolved.kind === "ambiguous") {
        return {
          ok: false,
          error: `Multiple matching files found for "${target.path}".`,
          ambiguous: { ambiguous: true, query: target.path, matches: resolved.matches },
        };
      }
      return chainForFile(input, resolved.path);
    }
    case "network":
      return chainForNetwork(input, target.destination);
    case "highlight": {
      const h = (input.highlights ?? []).find((x) => x.id === target.highlightId);
      if (!h) return { ok: false, error: `Highlight "${target.highlightId}" not found in this run.` };
      return chainForHighlight(input, h);
    }
  }
}

/** Convenience: check whether a PID is the traced root. */
export function isRootTarget(index: CauseIndex, pid: number): boolean {
  return isRootProcess(index, pid);
}
