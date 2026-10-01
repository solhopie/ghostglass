/**
 * Compact query syntax parser.
 *
 * Syntax: whitespace-separated `key:value` clauses (AND), repeated
 * action:/type: keys (OR), double-quoted values for strings containing
 * whitespace: `path:"/home/user/My Project/*"`.
 *
 * Supported keys: process, pid, action, type, file, path, network, host,
 * ip, port, since, until, text, reconstructed, limit, order, highlight.
 *
 * Bare flags (no value): `network`, `reconstructed`.
 * Explicit false: `network:false`, `reconstructed:false`.
 *
 * Times accept a relative duration: 500ms, 1.5s, 2m. Frontends convert to
 * absolute epoch ms against their own trace start before executing.
 *
 * Escaping: inside double quotes, `\"` and `\\` are the only escapes.
 *
 * This parser never executes anything: no regex construction from user
 * input beyond a fixed duration pattern, no eval, no shell expansion.
 */
import { KNOWN_ACTIONS, KNOWN_TYPES, QueryError, type TraceQuery } from "./types.js";

const KNOWN_FIELDS = new Set([
  "process",
  "pid",
  "action",
  "type",
  "file",
  "path",
  "network",
  "host",
  "ip",
  "port",
  "since",
  "until",
  "text",
  "reconstructed",
  "limit",
  "order",
  "highlight",
]);

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min)?$/i;

export function parseDurationMs(raw: string): number {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) {
    throw new QueryError(
      "invalid-time",
      `Invalid time value: "${raw}" (expected a duration like 500ms, 1.5s, or 2m)`,
    );
  }
  const n = parseFloat(m[1] as string);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit === "m" || unit === "min") return n * 60000;
  return n * 1000;
}

/**
 * Parse a time bound. Durations ("30s", "2m", "+10s") are relative to the
 * trace start; anything else must be an absolute timestamp parseable by
 * Date.parse ("2026-10-01T10:00:02Z"). Returns either a relative duration
 * (frontends add the trace start) or an absolute epoch ms.
 */
export function parseTimeBound(raw: string): { relativeMs?: number; absoluteMs?: number } {
  const trimmed = raw.trim();
  const noPlus = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (DURATION_RE.test(noPlus)) {
    return { relativeMs: parseDurationMs(noPlus) };
  }
  const abs = Date.parse(trimmed);
  if (!Number.isNaN(abs)) {
    return { absoluteMs: abs };
  }
  throw new QueryError(
    "invalid-time",
    `Invalid time value: "${raw}" (expected a duration like +30s or an absolute time like 2026-10-01T10:00:02Z)`,
  );
}

function parsePid(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new QueryError(
      "invalid-pid",
      `Invalid pid: "${raw}" (expected a non-negative integer)`,
    );
  }
  return parseInt(raw.trim(), 10);
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new QueryError(
      "invalid-port",
      `Invalid port: "${raw}" (expected an integer 0-65535)`,
    );
  }
  const n = parseInt(raw.trim(), 10);
  if (n > 65535) {
    throw new QueryError(
      "invalid-port",
      `Invalid port: "${raw}" (expected an integer 0-65535)`,
    );
  }
  return n;
}

function parseBool(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  throw new QueryError(
    "invalid-bool",
    `Invalid value for ${field}: "${raw}" (expected true or false)`,
  );
}

function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new QueryError(
      "invalid-limit",
      `Invalid limit: "${raw}" (expected a non-negative integer)`,
    );
  }
  return parseInt(raw.trim(), 10);
}

/** Split input into clauses on whitespace, respecting single/double quotes. */
function splitClauses(input: string): string[] {
  const clauses: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (quote !== null) {
      if (c === "\\" && i + 1 < input.length) {
        const next = input[i + 1] as string;
        if (next === quote || next === "\\") {
          cur += next;
          i += 2;
          continue;
        }
        cur += c;
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quote opens a quoted value only at a value boundary (clause
      // start or right after the colon); mid-word apostrophes stay literal.
      if (cur.length === 0 || cur.endsWith(":")) {
        quote = c;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (cur.length > 0) {
        clauses.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (quote !== null) {
    throw new QueryError("invalid-syntax", "Unterminated quoted string in query");
  }
  if (cur.length > 0) clauses.push(cur);
  return clauses;
}

export interface ParsedQuery {
  /** The structured query (times still relative durations). */
  query: TraceQuery;
  /** Raw relative durations, for frontends to resolve against trace start. */
  relativeTimes: { since?: number; until?: number };
}

/**
 * Parse compact query syntax into a TraceQuery. Relative times (since/until)
 * are returned as durations in `relativeTimes`; frontends add their trace
 * start to produce absolute `query.since`/`query.until`.
 */
export function parseQuery(input: string): ParsedQuery {
  const query: TraceQuery = {};
  const relativeTimes: { since?: number; until?: number } = {};
  const actions: string[] = [];
  const types: string[] = [];

  for (const clause of splitClauses(input)) {
    const colon = clause.indexOf(":");
    let key: string;
    let value: string;
    if (colon < 0) {
      key = clause;
      value = "";
    } else {
      key = clause.slice(0, colon);
      value = clause.slice(colon + 1);
    }
    key = key.toLowerCase();
    if (!KNOWN_FIELDS.has(key)) {
      throw new QueryError("unknown-field", `Unknown query field: ${key}`);
    }
    // Bare flags (network, reconstructed) accept an empty value meaning true.
    // Every other field requires a value: an empty one is a typo, and
    // silently matching nothing would be worse than failing clearly.
    if (value === "" && key !== "network" && key !== "reconstructed") {
      throw new QueryError("empty-value", `Empty value for query field: ${key}`);
    }
    switch (key) {
      case "process":
        query.process = value;
        break;
      case "pid":
        query.pid = parsePid(value);
        break;
      case "action": {
        const a = value.toLowerCase();
        if (!(KNOWN_ACTIONS as readonly string[]).includes(a)) {
          throw new QueryError(
            "unknown-action",
            `Unknown action: "${value}" (valid: ${(KNOWN_ACTIONS as readonly string[]).join(", ")})`,
          );
        }
        actions.push(a);
        break;
      }
      case "type": {
        const t = value.toLowerCase();
        if (!(KNOWN_TYPES as readonly string[]).includes(t)) {
          throw new QueryError(
            "unknown-type",
            `Unknown type: "${value}" (valid: ${(KNOWN_TYPES as readonly string[]).join(", ")})`,
          );
        }
        types.push(t);
        break;
      }
      case "file":
        query.file = value;
        break;
      case "path":
        query.path = value;
        break;
      case "network":
        query.network = parseBool(value, "network");
        break;
      case "host":
        query.host = value;
        break;
      case "ip":
        query.ip = value;
        break;
      case "port":
        query.port = parsePort(value);
        break;
      case "since": {
        const bound = parseTimeBound(value);
        if (bound.absoluteMs !== undefined) query.since = bound.absoluteMs;
        else if (bound.relativeMs !== undefined) relativeTimes.since = bound.relativeMs;
        break;
      }
      case "until": {
        const bound = parseTimeBound(value);
        if (bound.absoluteMs !== undefined) query.until = bound.absoluteMs;
        else if (bound.relativeMs !== undefined) relativeTimes.until = bound.relativeMs;
        break;
      }
      case "text":
        query.text = value;
        break;
      case "reconstructed":
        query.reconstructed = parseBool(value, "reconstructed");
        break;
      case "limit":
        query.limit = parseLimit(value);
        break;
      case "order": {
        const o = value.toLowerCase();
        if (o !== "time" && o !== "sequence") {
          throw new QueryError(
            "invalid-order",
            `Invalid order: "${value}" (expected "time" or "sequence")`,
          );
        }
        query.order = o;
        break;
      }
      case "highlight":
        query.highlight = value;
        break;
    }
  }

  if (actions.length > 0) query.actions = actions;
  if (types.length > 0) query.types = types;
  return { query, relativeTimes };
}

/** Validate a fully-built TraceQuery (e.g. from CLI flags). */
export function validateQuery(query: TraceQuery): void {
  // TraceQuery uses plural `actions`/`types`; the syntax layer maps to them.
  const structuredFields = new Set(
    [...KNOWN_FIELDS].map((f) => (f === "action" ? "actions" : f === "type" ? "types" : f)),
  );
  for (const key of Object.keys(query)) {
    if (!structuredFields.has(key)) {
      throw new QueryError("unknown-field", `Unknown query field: ${key}`);
    }
  }
  if (query.actions) {
    for (const a of query.actions) {
      if (!(KNOWN_ACTIONS as readonly string[]).includes(a.toLowerCase())) {
        throw new QueryError(
          "unknown-action",
          `Unknown action: "${a}" (valid: ${(KNOWN_ACTIONS as readonly string[]).join(", ")})`,
        );
      }
    }
    query.actions = query.actions.map((a) => a.toLowerCase());
  }
  if (query.types) {
    for (const t of query.types) {
      if (!(KNOWN_TYPES as readonly string[]).includes(t.toLowerCase())) {
        throw new QueryError(
          "unknown-type",
          `Unknown type: "${t}" (valid: ${(KNOWN_TYPES as readonly string[]).join(", ")})`,
        );
      }
    }
    query.types = query.types.map((t) => t.toLowerCase());
  }
  if (query.pid !== undefined && (!Number.isInteger(query.pid) || query.pid < 0)) {
    throw new QueryError(
      "invalid-pid",
      `Invalid pid: "${query.pid}" (expected a non-negative integer)`,
    );
  }
  if (
    query.port !== undefined &&
    (!Number.isInteger(query.port) || query.port < 0 || query.port > 65535)
  ) {
    throw new QueryError(
      "invalid-port",
      `Invalid port: "${query.port}" (expected an integer 0-65535)`,
    );
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    throw new QueryError(
      "invalid-limit",
      `Invalid limit: "${query.limit}" (expected a non-negative integer)`,
    );
  }
  if (query.since !== undefined && query.until !== undefined && query.since > query.until) {
    throw new QueryError(
      "invalid-range",
      "Invalid time range: since is after until",
    );
  }
}
