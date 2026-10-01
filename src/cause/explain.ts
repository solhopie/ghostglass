/**
 * Deterministic cause-chain explanations.
 *
 * Template-generated from recorded evidence only. No AI, no intent
 * inference, no security verdicts. Wording rule: "Execution path leading
 * to this event" — never "the reason the developer wanted this".
 */
import type { ChainInput } from "./buildCauseChain.js";
import { processLabel } from "./processAncestry.js";
import type {
  CauseConfidence,
  CausePath,
  CauseTarget,
} from "./types.js";

/** Render a path as "npm → node → WRITE → package-lock.json". */
export function renderPathSummary(path: CausePath): string {
  return path.nodes.map((n) => n.label).join(" → ");
}

function ancestrySentence(input: ChainInput, path: CausePath): string {
  const procs = path.nodes.filter((n) => n.kind === "process" || n.kind === "root-command");
  if (procs.length <= 1) return "";
  const names = procs.map((n) => n.label);
  return ` The recorded execution path is ${names.join(" → ")}.`;
}

export function buildExplanation(
  input: ChainInput,
  target: CauseTarget,
  targetLabel: string,
  paths: CausePath[],
  confidence: CauseConfidence,
  incomplete: boolean,
): string {
  const { index } = input;
  const parts: string[] = [];

  const confidenceNote =
    confidence === "direct"
      ? "This relationship is directly recorded in the trace."
      : confidence === "structural"
        ? "This path combines recorded process ancestry with a directly recorded event."
        : "Part of the execution path was not captured in this trace.";

  switch (target.kind) {
    case "event": {
      const e = index.eventById.get(target.eventId);
      if (e) {
        const info = index.processByPid.get(e.pid);
        const who = info ? processLabel(info) : `PID ${e.pid}`;
        const exe = info?.executable ? ` (${info.executable})` : "";
        parts.push(
          `This ${e.action} was performed by ${who}${exe}, PID ${e.pid}.`,
        );
      }
      break;
    }
    case "pid": {
      const info = index.processByPid.get(target.pid);
      const who = info ? processLabel(info) : `PID ${target.pid}`;
      const parentPid = index.parentByPid.get(target.pid);
      if (parentPid !== undefined) {
        const pInfo = index.processByPid.get(parentPid);
        const pWho = pInfo ? processLabel(pInfo) : `PID ${parentPid}`;
        parts.push(
          `${who} (PID ${target.pid}) was spawned by ${pWho} (PID ${parentPid}), as recorded in the trace.`,
        );
      } else {
        parts.push(
          `${who} (PID ${target.pid}) has no recorded parent in this trace; it is treated as part of the traced command.`,
        );
      }
      break;
    }
    case "file": {
      const actorCount = paths.length;
      if (actorCount === 1) {
        const label = (paths[0] as CausePath).label;
        parts.push(`"${targetLabel}" was touched by ${label}, as recorded in the trace.`);
      } else {
        parts.push(
          `"${targetLabel}" was touched by ${actorCount} processes in this trace; each recorded path is shown separately.`,
        );
      }
      break;
    }
    case "network": {
      const actorCount = paths.length;
      if (actorCount === 1) {
        parts.push(
          `The connection to ${targetLabel} was attempted by ${(paths[0] as CausePath).label}, as recorded in the trace.`,
        );
      } else {
        parts.push(
          `Connections to ${targetLabel} were attempted by ${actorCount} processes in this trace; each recorded path is shown separately.`,
        );
      }
      parts.push(" Hostnames are shown only when captured; none are invented.");
      break;
    }
    case "highlight": {
      parts.push(
        `Behavior highlight "${targetLabel}": the execution path below shows the recorded process and event chain that produced the observed activity.`,
      );
      parts.push(" This describes observed behavior, not a verdict.");
      break;
    }
  }

  if (paths.length > 0) {
    parts.push(ancestrySentence(input, paths[0] as CausePath));
  }
  if (paths.length > 1) {
    parts.push(
      ` ${paths.length - 1} additional contributing path${paths.length - 1 === 1 ? " is" : "s are"} listed separately.`,
    );
  }
  parts.push(` ${confidenceNote}`);
  if (incomplete) {
    parts.push(" Missing links are labeled, not guessed.");
  }
  parts.push(" Cause Chain reports recorded execution relationships; it does not infer intent.");

  return parts.join("").replace(/\s+/g, " ").trim();
}
