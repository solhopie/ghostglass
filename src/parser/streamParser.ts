import type { GhostGlassEvent } from "../events/types.js";
import {
  createParseContext,
  parseLine,
  type ParseContext,
  type TraceParseStats,
} from "./straceParser.js";

/**
 * Incremental strace parser for live tracing.
 *
 * Feed raw strace output as it arrives (`push`); complete lines are parsed
 * immediately into normalized GhostGlass events. Handles partial chunks,
 * multiple lines per chunk, and lines split across chunks. `flush` parses
 * any trailing unterminated line at end of stream.
 *
 * This is the same parsing logic as the batch parser (`parseLine`): the
 * batch `parseTraceFile` is implemented on top of this class, so live and
 * recorded parsing can never diverge.
 */
export class StraceStreamParser {
  private buffer = "";
  private readonly ctx: ParseContext;
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
   * unterminated line) and return any event it yields.
   */
  flush(): GhostGlassEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    const event = this.processLine(line);
    return event ? [event] : [];
  }

  getStats(): TraceParseStats {
    return { ...this.stats };
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
    const event = parseLine(rawLine, this.ctx);
    if (event) {
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
