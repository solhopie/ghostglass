/**
 * Cause Chain engine — public surface.
 *
 * Deterministic, local, evidence-only execution-path reconstruction.
 * No AI, no guessing, no security verdicts.
 */
export type {
  CauseChain,
  CauseConfidence,
  CauseEdge,
  CauseEdgeKind,
  CauseNode,
  CauseNodeKind,
  CausePath,
  CauseTarget,
  AmbiguousFileTarget,
} from "./types.js";
export {
  buildCauseIndex,
  extendCauseIndex,
  rootPidOf,
  networkKey,
  type CauseIndex,
  type ProcessInfo,
} from "./causeIndex.js";
export {
  reconstructAncestry,
  processLabel,
  isRootProcess,
  type AncestryResult,
  type AncestryStep,
} from "./processAncestry.js";
export {
  buildCauseChain,
  isRootTarget,
  type ChainInput,
  type ChainResult,
} from "./buildCauseChain.js";
export { buildExplanation, renderPathSummary } from "./explain.js";
export {
  eventsForFile,
  eventsForNetwork,
  actorsForFile,
  resolveFileQuery,
  knownNetworkDestinations,
  fileEdgeKind,
} from "./eventLinks.js";
