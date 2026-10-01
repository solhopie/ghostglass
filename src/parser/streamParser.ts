import type { GhostGlassEvent } from "../events/types.js";
import {
  createParseContext,
  parseLine,
  type ParseContext,
  type TraceParseStats,
} from "./straceParser.js";
import { SyscallReconstructor } from "./syscallReconstructor.js";
import type { ReconstructionDiagnostics } from "./pendingSyscalls.js";

/**
 * Incremental strace parser for live tracing.
 *
 * Feed raw strace output as it arrives (`push`); complete lines are parsed
 * immediately into normalized GhostGlass events. Handles partial chunks,
 * multiple lines per chunk, and lines split across chunks. `flush` parses
 * any trailing unterminated line at end of stream.
 *
 * Between line assembly and syscall parsing sits the split-syscall
 * reconstructor: strace `<unfinished ...>` / `<... resumed>` fragment pairs
 * are deterministically re-joined into canonical complete lines before
 * normal parsing, so batch and live parsing share one code path and can
 * never diverge.
 *
 * This is the same parsing logic as the batch parser (`parseLine`): the
 * batch `parseTraceFile` is implemented on top of this class, so live and
 * recorded parsing can never diverge.
 */
export class StraceStreamParser {
  private buffer = "";
  private readonly ctx: ParseContext;
  private readonly reconstructor = new SyscallReconstructor();
  private readonly stats: TraceParseStats = {
    totalLines: 0,
    events: 0,
    skipped: 0,
    malformed: 0,
  };

  constructor(runId: string, startTimeMs: number) {
    this.ctx = createParseContext(runId, startTimeMs);
  }

  /**
   * Push a chunk of raw strace output. Returns the normalized events for
   * every complete line in the chunk, in order. A trailing partial line is
   * held back until the rest arrives.
   */
  push(chunk: string): GhostGlassEvent[] {
    this.buffer += chunk;
    const events: GhostGlassEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /**
   * End of stream: parse the trailing buffer (if it holds a non-blank
   * unterminated line), finalize split-syscall reconstruction (unresolved
   * fragments are counted as diagnostics, never turned into events), and
   * return any event the trailing line yields.
   */
  flush(): GhostGlassEvent[] {
    const out: GhostGlassEvent[] = [];
    if (this.buffer.trim()) {
      const line = this.buffer;
      this.buffer = "";
      const event = this.processLine(line);
      if (event) out.push(event);
    } else {
      this.buffer = "";
    }
    this.reconstructor.finish();
    return out;
  }

  getStats(): TraceParseStats {
    return { ...this.stats, reconstruction: this.reconstructor.getDiagnostics() };
  }

  /** Parser-health counters for split-syscall reconstruction. */
  getReconstructionDiagnostics(): ReconstructionDiagnostics {
    return this.reconstructor.getDiagnostics();
  }

  get rootPid(): number | undefined {
    return this.ctx.rootPid;
  }

  get rootExitCode(): number | null | undefined {
    return this.ctx.rootExitCode;
  }

  get rootSignal(): string | null | undefined {
    return this.ctx.rootSignal;
  }

  private processLine(rawLine: string): GhostGlassEvent | null {
    if (!rawLine.trim()) return null;
    this.stats.totalLines++;

    // Split-syscall reconstruction runs before normal parsing. A "held"
    // unfinished fragment produces no event yet; a reconstructed line is
    // parsed exactly like an unsplit syscall and tagged in metadata.
    const fragment = this.reconstructor.processLine(rawLine);
    if (fragment.kind === "held" || fragment.kind === "dropped") {
      this.stats.skipped++;
      return null;
    }
    const lineToParse =
      fragment.kind === "reconstructed" ? fragment.line : rawLine;
    const event = parseLine(lineToParse, this.ctx);
    if (event) {
      if (fragment.kind === "reconstructed") {
        event.metadata = {
          ...event.metadata,
          reconstructed: true,
        };
      }
      this.stats.events++;
      return event;
    }
    // Mirror the batch parser's accounting: a well-formed trace line we
    // deliberately did not normalize counts as skipped, anything else as
    // malformed.
    if (/^\d+\s+\d{2}:\d{2}:\d{2}\.\d{6}\s+/.test(rawLine.trimEnd())) {
      this.stats.skipped++;
    } else {
      this.stats.malformed++;
    }
    return null;
  }
}
