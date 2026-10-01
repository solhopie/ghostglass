/**
 * create-execute: a file created during the run is later executed.
 *
 * Only fires when the trace proves the sequence: an explicit `create`
 * event for path P, followed by an `exec` event whose executable is P.
 * A plain `write` does not prove creation (it may append to an existing
 * file). No inference from similar names — the paths must match exactly
 * after normalization.
 */
import type { GhostGlassEvent } from "../../events/types.js";
import type { Highlight, HighlightRuleImpl, RuleContext } from "../types.js";
import { assertNoVerdictWords } from "../types.js";
import { normalizeTracePath } from "./outsideCwd.js";

interface Creation {
  eventId: string;
  timestamp: number;
  pid: number;
  creatorExecutable: string | undefined;
}

export class CreateExecuteRule implements HighlightRuleImpl {
  readonly rule = "create-then-execute" as const;
  private ctx!: RuleContext;
  /** normalized path -> creation record */
  private created = new Map<string, Creation>();
  private emitted = new Set<string>();

  reset(ctx: RuleContext): void {
    this.ctx = ctx;
    this.created.clear();
    this.emitted.clear();
  }

  processEvent(event: GhostGlassEvent, emit: (h: Highlight) => void): void {
    // Only explicit `create` events prove creation. A plain `write` may be
    // appending to an existing file, so it cannot establish the
    // created-then-executed sequence.
    if (event.type === "file" && event.action === "create" && event.path) {
      const n = normalizeTracePath(event.path);
      // First creation wins; later writes to the same path don't reset it.
      if (!this.created.has(n)) {
        this.created.set(n, {
          eventId: event.id,
          timestamp: event.timestamp,
          pid: event.pid,
          creatorExecutable: event.executable,
        });
      }
      return;
    }
    if (event.type === "process" && event.action === "exec" && event.executable) {
      const n = normalizeTracePath(event.executable);
      const creation = this.created.get(n);
      if (!creation) return;
      const id = `${this.ctx.runId}-create-then-execute-${n}`;
      if (this.emitted.has(id)) return;
      this.emitted.add(id);

      const delayMs = event.timestamp - creation.timestamp;
      const title = "Created then executed";
      const explanation =
        `${n} was created during this run and then executed ${delayMs} ms later. ` +
        `GhostGlass observed both the file creation and the later exec of the same path. ` +
        `This is descriptive: build tools and installers do this routinely.`;
      assertNoVerdictWords(title + " " + explanation);

      emit({
        id,
        runId: this.ctx.runId,
        rule: this.rule,
        severity: "notice",
        title,
        explanation,
        startTimestamp: creation.timestamp,
        endTimestamp: event.timestamp,
        pid: event.pid,
        relatedEventIds: [creation.eventId, event.id],
        metadata: {
          path: n,
          createdByPid: creation.pid,
          createdByExecutable: creation.creatorExecutable,
          executedByPid: event.pid,
          delayMs,
        },
      });
    }
  }

  finish(_emit: (h: Highlight) => void): void {}
}
