/**
 * `ghostglass query <run-id> [selectors] [--json]`
 *
 * Deterministic structured search over a saved trace. No AI, no
 * natural-language inference, no external services — the same query
 * engine (src/query) that powers the viewer, Live Glass, and exports.
 *
 * Selectors combine with AND across fields; repeated --action/--type
 * combine with OR within the field.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { readJsonFile, type RunMetadata } from "../../storage/runStore.js";
import type { GhostGlassEvent } from "../../events/types.js";
import {
  assignSequences,
  executeQuery,
  openQuerySession,
} from "../../query/executeQuery.js";
import { formatQueryText } from "../../query/format.js";
import { parseTimeBound, validateQuery } from "../../query/parser.js";
import { QueryError, type TraceQuery } from "../../query/types.js";
import { resolveRunId } from "./open.js";

const DEFAULT_LIMIT = 100;

async function readEventsJsonl(path: string): Promise<GhostGlassEvent[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GhostGlassEvent);
}

export interface QueryCommandOptions {
  cwd: string;
  process?: string;
  pid?: string;
  action?: string[];
  type?: string[];
  file?: string;
  path?: string;
  network?: boolean;
  ip?: string;
  port?: string;
  since?: string;
  until?: string;
  text?: string;
  reconstructed?: boolean;
  notReconstructed?: boolean;
  limit?: string;
  order?: string;
  json?: boolean;
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function buildTraceQuery(opts: QueryCommandOptions, runStartMs: number): TraceQuery {
  const q: TraceQuery = {};
  try {
    if (opts.process !== undefined) q.process = opts.process;
    if (opts.pid !== undefined) {
      if (!/^\d+$/.test(opts.pid)) fail(`Invalid pid: "${opts.pid}" (expected a non-negative integer)`);
      q.pid = parseInt(opts.pid, 10);
    }
    if (opts.action && opts.action.length > 0) q.actions = opts.action;
    if (opts.type && opts.type.length > 0) q.types = opts.type;
    if (opts.file !== undefined) q.file = opts.file;
    if (opts.path !== undefined) q.path = opts.path;
    if (opts.network === true) q.network = true;
    if (opts.ip !== undefined) q.ip = opts.ip;
    if (opts.port !== undefined) {
      if (!/^\d+$/.test(opts.port)) fail(`Invalid port: "${opts.port}" (expected an integer 0-65535)`);
      const p = parseInt(opts.port, 10);
      if (p > 65535) fail(`Invalid port: "${opts.port}" (expected an integer 0-65535)`);
      q.port = p;
    }
    if (opts.since !== undefined) {
      const bound = parseTimeBound(opts.since);
      q.since = bound.absoluteMs ?? runStartMs + (bound.relativeMs as number);
    }
    if (opts.until !== undefined) {
      const bound = parseTimeBound(opts.until);
      q.until = bound.absoluteMs ?? runStartMs + (bound.relativeMs as number);
    }
    if (opts.text !== undefined) q.text = opts.text;
    if (opts.reconstructed === true) q.reconstructed = true;
    if (opts.notReconstructed === true) q.reconstructed = false;
    if (opts.limit !== undefined) {
      if (!/^\d+$/.test(opts.limit)) fail(`Invalid limit: "${opts.limit}" (expected a non-negative integer)`);
      q.limit = parseInt(opts.limit, 10);
    }
    if (opts.order !== undefined) {
      const o = opts.order.toLowerCase();
      if (o !== "time" && o !== "sequence") {
        fail(`Invalid order: "${opts.order}" (expected "time" or "sequence")`);
      }
      q.order = o as "time" | "sequence";
    }
    // Validate actions/types/pid/port ranges up front for clean errors.
    validateQuery(q);
  } catch (err) {
    if (err instanceof QueryError) fail(err.message);
    throw err;
  }
  return q;
}

export async function queryCommand(
  runIdArg: string | undefined,
  opts: QueryCommandOptions,
): Promise<void> {
  let runId: string;
  try {
    runId = await resolveRunId(opts.cwd, runIdArg ?? "latest");
  } catch (err) {
    fail((err as Error).message);
  }
  const runDir = join(opts.cwd, ".ghostglass", "runs", runId);
  let metadata: RunMetadata;
  try {
    metadata = await readJsonFile<RunMetadata>(join(runDir, "metadata.json"));
  } catch {
    fail(`No saved trace found for run ID "${runId}".`);
  }
  const events = assignSequences(await readEventsJsonl(join(runDir, "events.jsonl")));
  const runStartMs = Date.parse(metadata.startTime);
  const query = await buildTraceQuery(opts, runStartMs);
  const session = openQuerySession(events);

  let result;
  try {
    result = executeQuery(runId, events, query, {
      context: session.context,
      indexes: session.indexes,
      defaultLimit: DEFAULT_LIMIT,
    });
  } catch (err) {
    if (err instanceof QueryError) fail(err.message);
    throw err;
  }

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          query: result.query,
          totalMatches: result.totalMatches,
          returned: result.returned,
          truncated: result.truncated,
          events: result.events,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    formatQueryText(result, runStartMs, (pid, seq) => session.context.executableForPid(pid, seq)),
  );
}
