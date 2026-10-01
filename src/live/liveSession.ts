import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { GhostGlassEvent } from "../events/types.js";
import type { TraceParseStats } from "../parser/straceParser.js";
import type { TraceResult } from "../tracer/TracerBackend.js";
import {
  writeJsonFile,
  type RunMetadata,
} from "../storage/runStore.js";
import { buildSummary } from "../summary/summarize.js";
import { readPackageVersion } from "../cli/version.js";
import type { Highlight } from "../highlights/types.js";
import {
  createLiveDetector,
  type LiveDetector,
} from "../highlights/engine.js";
import type { ResolvedHighlightConfig } from "../highlights/types.js";
import { writeHighlights } from "../highlights/storage.js";
import { defaultHighlightConfig } from "../highlights/config.js";

/**
 * Live run status, shown prominently in the viewer.
 *
 * - running:     the command is still executing
 * - complete:    the command exited 0
 * - exited:      the command exited nonzero (descriptive only — never a
 *                verdict about the command)
 * - interrupted: GhostGlass was interrupted (Ctrl+C) or the command died
 *                from a signal before exiting
 */
export type LiveStatus = "running" | "complete" | "interrupted" | "exited";

export interface LiveStatusPayload {
  runId: string;
  status: LiveStatus;
  commandLine: string;
  startTimeMs: number;
  /** Grows while running; final once the status leaves "running". */
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  eventCount: number;
}

export interface LiveSubscriber {
  onEvents(events: GhostGlassEvent[]): void;
  onStatus(status: LiveStatusPayload): void;
  /** Live behavior highlights, emitted as soon as a rule fires. Optional. */
  onHighlights?(highlights: Highlight[]): void;
}

/**
 * Minimal surface the viewer server needs from a live session. Defined as
 * an interface so tests can stub it without running a tracer.
 */
export interface LiveSessionLike {
  readonly runId: string;
  getStatus(): LiveStatusPayload;
  /** Events after `sinceId` (exclusive). Empty when already caught up. */
  eventsAfter(sinceId: string | null): { events: GhostGlassEvent[] };
  /** Events page by numeric offset, mirroring /api/runs/:id/events. */
  eventsSlice(offset: number, limit: number): { total: number; events: GhostGlassEvent[] };
  /**
   * Subscribe to live batches and status changes. The subscriber first
   * receives every event after `sinceId` (replay, in order), then live
   * batches — atomically, so nothing is missed or duplicated. It also
   * immediately receives the current status.
   */
  subscribe(sub: LiveSubscriber, sinceId?: string | null): () => void;
  /** Highlights detected so far in this live session. */
  getHighlights(): Highlight[];
}

/** Broadcast tick: batches live events to SSE subscribers. */
const BROADCAST_MS = 30;

/**
 * Owns one live run: incremental persistence, the SSE broadcast hub, and
 * status transitions. Deliberately independent of the viewer server — if
 * the server crashes, ingestion and persistence continue untouched.
 */
export class LiveSession implements LiveSessionLike {
  readonly runId: string;
  private readonly runDir: string;
  private readonly command: string[];
  private readonly commandLine: string;
  private readonly backendName: string;
  private readonly startTimeMs: number;

  private events: GhostGlassEvent[] = [];
  private subscribers = new Set<LiveSubscriber>();
  private pending: GhostGlassEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private eventsFile: WriteStream;
  private status: LiveStatus = "running";
  private endTimeMs: number | null = null;
  private exitCode: number | null = null;
  private signal: string | null = null;
  private interrupted = false;
  private parseStats: TraceParseStats | null = null;
  private finalized = false;
  /** True once any exec event arrived (the command actually started). */
  private sawExecEvent = false;
  /** Incremental behavior-highlight detector (live highlights). */
  private highlightDetector: LiveDetector;
  private highlights: Highlight[] = [];
  private readonly workingDirectory: string | undefined;
  private readonly highlightConfig: ResolvedHighlightConfig;

  constructor(opts: {
    runId: string;
    runDir: string;
    command: string[];
    commandLine: string;
    backendName: string;
    startTimeMs: number;
    workingDirectory?: string;
    highlightConfig?: ResolvedHighlightConfig;
  }) {
    this.runId = opts.runId;
    this.runDir = opts.runDir;
    this.command = opts.command;
    this.commandLine = opts.commandLine;
    this.backendName = opts.backendName;
    this.startTimeMs = opts.startTimeMs;
    this.workingDirectory = opts.workingDirectory;
    this.highlightConfig = opts.highlightConfig ?? defaultHighlightConfig();
    this.eventsFile = createWriteStream(join(opts.runDir, "events.jsonl"), {
      encoding: "utf8",
    });
    this.eventsFile.on("error", () => {
      // Persistence trouble must not kill the traced command; the
      // in-memory stream keeps flowing to the viewer.
    });
    // Live highlight detection: the detector is incremental — each event is
    // O(1) amortized per rule, highlights broadcast as soon as they fire.
    this.highlightDetector = createLiveDetector(
      {
        runId: opts.runId,
        workingDirectory: opts.workingDirectory,
        config: this.highlightConfig,
      },
      (h) => this.broadcastHighlight(h),
    );
  }

  /** Ingest one normalized event: persist, buffer for broadcast, detect highlights. */
  ingest(event: GhostGlassEvent): void {
    this.events.push(event);
    if (event.action === "exec") this.sawExecEvent = true;
    this.eventsFile.write(JSON.stringify(event) + "\n");
    this.pending.push(event);
    this.highlightDetector.ingest(event);
    this.ensureTimer();
  }

  /** Ingest a batch (same as repeated ingest, but cheaper). */
  ingestBatch(events: GhostGlassEvent[]): void {
    if (events.length === 0) return;
    let json = "";
    for (const e of events) {
      this.events.push(e);
      if (e.action === "exec") this.sawExecEvent = true;
      json += JSON.stringify(e) + "\n";
      this.highlightDetector.ingest(e);
    }
    this.eventsFile.write(json);
    this.pending.push(...events);
    this.ensureTimer();
  }

  /** Whether the traced command's execve was ever observed. */
  get sawExec(): boolean {
    return this.sawExecEvent;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** Highlights detected so far (live or finalized). */
  getHighlights(): Highlight[] {
    return [...this.highlights];
  }

  /** Broadcast one newly-detected highlight to subscribers immediately. */
  private broadcastHighlight(h: Highlight): void {
    this.highlights.push(h);
    for (const sub of [...this.subscribers]) {
      try {
        sub.onHighlights?.([h]);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  getStatus(): LiveStatusPayload {
    return {
      runId: this.runId,
      status: this.status,
      commandLine: this.commandLine,
      startTimeMs: this.startTimeMs,
      durationMs: (this.endTimeMs ?? Date.now()) - this.startTimeMs,
      exitCode: this.exitCode,
      signal: this.signal,
      interrupted: this.interrupted,
      eventCount: this.events.length,
    };
  }

  eventsAfter(sinceId: string | null): { events: GhostGlassEvent[] } {
    if (sinceId == null || sinceId === "") return { events: [...this.events] };
    const idx = this.indexOfId(sinceId);
    if (idx === -1) {
      // Unknown ID (e.g. from an older run): resend everything rather than
      // silently dropping history. The client dedupes by event ID.
      return { events: [...this.events] };
    }
    return { events: this.events.slice(idx + 1) };
  }

  eventsSlice(offset: number, limit: number): { total: number; events: GhostGlassEvent[] } {
    const total = this.events.length;
    const start = Math.max(0, offset);
    return { total, events: this.events.slice(start, start + Math.max(0, limit)) };
  }

  subscribe(sub: LiveSubscriber, sinceId?: string | null): () => void {
    // Synchronous and atomic (single-threaded): no ingest or broadcast
    // tick can interleave, so the replay + live batches never overlap or
    // leave a gap. Flush first: anything still in `pending` goes to the
    // existing subscribers now, so the replay below (drawn from full
    // history) can never duplicate an unflushed live batch.
    this.flushBroadcast();
    this.subscribers.add(sub);
    const missed = this.eventsAfter(sinceId ?? null).events;
    if (missed.length > 0) {
      sub.onEvents(missed);
    }
    // A reconnecting subscriber also gets highlights detected so far.
    if (this.highlights.length > 0) {
      sub.onHighlights?.([...this.highlights]);
    }
    // Immediately inform the new subscriber of the current status so a
    // reconnecting browser never shows a stale pill.
    sub.onStatus(this.getStatus());
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /**
   * Discard the session without finalizing (e.g. the command never
   * started): closes the event file and stops the broadcast timer.
   */
  async discard(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await new Promise<void>((resolve) => {
      this.eventsFile.end(() => resolve());
    });
  }

  /**
   * The traced command finished. Flushes persistence, writes the normal
   * run files (summary.json, metadata.json) so the run becomes an ordinary
   * GhostGlass run, and notifies subscribers of the final status.
   */
  async finalize(result: TraceResult): Promise<RunMetadata> {
    if (this.finalized) throw new Error("LiveSession already finalized");
    this.finalized = true;

    this.endTimeMs = result.endTimeMs;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.interrupted = result.forwardedSignal !== null;
    this.parseStats = result.parseStats ?? null;

    if (this.interrupted) {
      this.status = "interrupted";
    } else if (this.signal !== null && this.signal !== undefined) {
      // Died from a signal GhostGlass did not forward (e.g. segfault).
      this.status = "interrupted";
    } else if (this.exitCode === 0) {
      this.status = "complete";
    } else {
      this.status = "exited";
    }

    // Flush any events still waiting for broadcast, then close the stream.
    this.flushBroadcast();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await new Promise<void>((resolve) => {
      this.eventsFile.end(() => resolve());
    });

    const summary = buildSummary(
      this.runId,
      this.command,
      this.commandLine,
      this.events,
      result.durationMs,
      // Prefer the exit code observed inside the trace, mirroring run.ts.
      this.exitCode,
      this.signal,
    );
    const metadata: RunMetadata = {
      ghostglassVersion: readPackageVersion(),
      runId: this.runId,
      command: this.command,
      commandLine: this.commandLine,
      startTime: new Date(result.startTimeMs).toISOString(),
      endTime: new Date(result.endTimeMs).toISOString(),
      durationMs: result.durationMs,
      os: {
        platform: process.platform,
        arch: process.arch,
        release: process.release?.name ?? "node",
      },
      exitCode: this.exitCode,
      signal: this.signal,
      interrupted: this.interrupted,
      backend: this.backendName,
      workingDirectory: this.workingDirectory,
      eventCount: this.events.length,
      parseStats: this.parseStats ?? { totalLines: 0, events: 0, skipped: 0, malformed: 0 },
    };

    // The events file was already written incrementally during the run;
    // summary.json and metadata.json now make this an ordinary saved run
    // for open/diff/export.
    await writeJsonFile(join(this.runDir, "summary.json"), summary);
    await writeJsonFile(join(this.runDir, "metadata.json"), metadata);

    // Persist the live-detected highlights (same engine as batch, so the
    // saved run and the live view agree).
    const finalHighlights = this.highlightDetector.finish();
    // finish() returns sorted; keep the broadcast order stable by id set.
    const byId = new Map(finalHighlights.map((h) => [h.id, h]));
    const ordered = this.highlights.filter((h) => byId.has(h.id));
    for (const h of finalHighlights) {
      if (!ordered.some((o) => o.id === h.id)) ordered.push(h);
    }
    await writeHighlights(this.runDir, this.runId, ordered, this.highlightConfig);

    const payload = this.getStatus();
    for (const sub of [...this.subscribers]) {
      try {
        sub.onStatus(payload);
      } catch {
        // A broken subscriber must not break finalization.
      }
    }
    return metadata;
  }

  /**
   * Locate an event by ID. Event IDs embed a 1-based sequence number
   * (`<runId>-000042`), so this is O(1) in the common case, with a linear
   * fallback that also verifies identity (never trust the number alone).
   */
  private indexOfId(id: string): number {
    const m = id.match(/-(\d+)$/);
    if (m) {
      const idx = parseInt(m[1] as string, 10) - 1;
      if (idx >= 0 && idx < this.events.length && this.events[idx]?.id === id) {
        return idx;
      }
    }
    return this.events.findIndex((e) => e.id === id);
  }

  private ensureTimer(): void {
    if (this.timer || this.status !== "running") return;
    this.timer = setInterval(() => this.flushBroadcast(), BROADCAST_MS);
    // Don't keep the process alive for broadcasting alone.
    this.timer.unref?.();
  }

  private flushBroadcast(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const sub of [...this.subscribers]) {
      try {
        sub.onEvents(batch);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }
}
