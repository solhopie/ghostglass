/**
 * outside-cwd: filesystem activity outside the traced command's working directory.
 *
 * Only runs when the working directory is reliably known. Paths are
 * normalized safely (resolving `.`/`..` lexically, no filesystem access).
 *
 * To avoid flooding on ordinary runs (every Node process reads hundreds of
 * files under /usr/lib, node_modules, etc.), events are grouped by
 * (pid, parent directory): one highlight per directory, counting the files
 * touched and sampling paths. A read-only group is "info"; a group with
 * any write/create/delete/rename is "notice".
 *
 * Never exposes filesystem information beyond what the trace already contains.
 */
import { posix } from "node:path";
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";

const WRITE_LIKE = new Set(["write", "create", "delete", "rename", "mkdir"]);

/** Maximum directory groups per run — beyond this, the busiest are kept. */
const MAX_GROUPS = 50;

interface DirGroup {
  dir: string;
  pids: Set<number>;
  fileCount: number;
  writeCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  eventIds: string[];
  samplePaths: string[];
  executable: string | undefined;
}

/** Lexically normalize a path without touching the filesystem. */
export function normalizeTracePath(p: string): string {
  // Traces are Linux-only; posix normalization is correct.
  let n = posix.normalize(p);
  // Collapse a trailing "/." that normalize leaves on some inputs.
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

function isOutsideCwd(normalizedPath: string, normalizedCwd: string): boolean {
  if (normalizedPath === normalizedCwd) return false;
  return !normalizedPath.startsWith(normalizedCwd + "/");
}

export class OutsideCwdRule implements HighlightRuleImpl {
  readonly rule = "outside-working-directory" as const;
  private ctx!: RuleContext;
  private cwd: string | undefined;
  private groups = new Map<string, DirGroup>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.cwd = ctx.workingDirectory ? normalizeTracePath(ctx.workingDirectory) : undefined;
    this.groups.clear();
  }

  processEvent(event: GhostGlassEvent, _emit: (h: Highlight) => void): void {
    if (!this.cwd) return;
    if (event.type !== "file" || !event.path) return;
    const normalized = normalizeTracePath(event.path);
    if (!isOutsideCwd(normalized, this.cwd)) return;

    const dir = posix.dirname(normalized);
    const key = dir;
    let g = this.groups.get(key);
    if (!g) {
      // Cap groups: beyond MAX_GROUPS, merge into a dedicated overflow bucket
      // instead of misattributing to an existing directory.
      if (this.groups.size >= MAX_GROUPS) {
        const overflowKey = "(other directories)";
        g = this.groups.get(overflowKey);
        if (!g) {
          g = {
            dir: overflowKey,
            pids: new Set(),
            fileCount: 0,
            writeCount: 0,
            firstTimestamp: event.timestamp,
            lastTimestamp: event.timestamp,
            eventIds: [],
            samplePaths: [],
            executable: undefined,
          };
          this.groups.set(overflowKey, g);
        }
        // Fall through to update the overflow group below
      } else {
        g = {
          dir,
          pids: new Set(),
          fileCount: 0,
          writeCount: 0,
          firstTimestamp: event.timestamp,
          lastTimestamp: event.timestamp,
          eventIds: [],
          samplePaths: [],
          executable: undefined,
        };
        this.groups.set(key, g);
      }
    }
    g!.pids.add(event.pid);
    g.fileCount++;
    if (WRITE_LIKE.has(event.action)) g.writeCount++;
    g.lastTimestamp = event.timestamp;
    if (g.eventIds.length < 20) g.eventIds.push(event.id);
    if (g.samplePaths.length < 5 && !g.samplePaths.includes(normalized)) {
      g.samplePaths.push(normalized);
    }
    if (event.executable) g.executable = event.executable;
  }

  finish(emit: (h: Highlight) => void): void {
    // Highlights are emitted at finish so each directory gets one summary.
    // This keeps the CLI/UI readable: N directories, not N files.
    const sorted = [...this.groups.values()].sort((a, b) => b.fileCount - a.fileCount);
    for (const g of sorted) {
      const writeLike = g.writeCount > 0;
      const id = `${this.ctx.runId}-outside-working-directory-${g.dir}`;
      const title = "Outside working directory";
      const explanation =
        `Processes touched ${g.fileCount} file${g.fileCount === 1 ? "" : "s"} under ${g.dir}, ` +
        `outside the traced working directory ${this.cwd}. ` +
        (writeLike
          ? `${g.writeCount} of those were writes/creates/deletes, shown as notice because they change files the project may not expect.`
          : "Reads outside the working directory are common (shared libraries, caches) and shown for awareness only.");
      assertNoVerdictWords(title + " " + explanation);

      emit({
        id,
        runId: this.ctx.runId,
        rule: this.rule,
        severity: writeLike ? "notice" : "info",
        title,
        explanation,
        startTimestamp: g.firstTimestamp,
        endTimestamp: g.lastTimestamp,
        ...(g.pids.size === 1 ? { pid: [...g.pids][0] as number } : {}),
        relatedEventIds: g.eventIds,
        metadata: {
          directory: g.dir,
          fileCount: g.fileCount,
          writeCount: g.writeCount,
          pids: [...g.pids].sort((a, b) => a - b),
          pidCount: g.pids.size,
          workingDirectory: this.cwd,
          executable: g.executable,
          samplePaths: g.samplePaths,
        },
      });
    }
  }
}
