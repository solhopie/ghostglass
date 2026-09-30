import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve as resolvePath } from "node:path";
import type {
  GhostGlassEvent,
  GhostGlassEventAction,
  GhostGlassEventType,
} from "../events/types.js";

/**
 * Translates raw strace output into normalized GhostGlass events.
 *
 * Design notes:
 * - Every parsed syscall becomes at most one event. Repetitive low-level
 *   detail is collapsed into developer-friendly actions (read/write/create/
 *   delete/...); the original syscall name is kept in metadata.syscall.
 * - Only successful syscalls produce file/process events. A failed openat
 *   (ENOENT probing) is not presented as file activity. Network `connect`
 *   calls are recorded as attempts regardless of outcome, since a refused
 *   or in-progress connection is still meaningful activity.
 * - Hostnames are never guessed: a network event carries an IP and port;
 *   `host` stays undefined unless a backend can determine it reliably.
 */

export interface TraceParseStats {
  totalLines: number;
  events: number;
  /** Lines for syscalls we deliberately do not normalize (or filter out). */
  skipped: number;
  /** Lines that did not match any known strace line shape. */
  malformed: number;
}

export interface ParsedTrace {
  events: GhostGlassEvent[];
  stats: TraceParseStats;
  /** PID of the first execve: the root of the traced process tree. */
  rootPid?: number | undefined;
  /** Exit code from the root's "+++ exited with N +++", when observed. */
  rootExitCode?: number | null | undefined;
  /** Signal from the root's "+++ killed by SIGxxx +++", when observed. */
  rootSignal?: string | null | undefined;
}

interface ParseContext {
  runId: string;
  /** Local-midnight epoch ms of the run's start day (for -tt timestamps). */
  dayStartMs: number;
  seq: { n: number };
  rootPid?: number;
  rootExitCode?: number | null;
  rootSignal?: string | null;
}

const BASIC_LINE_RE = /^(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{6})\s+(.*)$/;
const EXITED_RE = /^\+\+\+ exited with (-?\d+) \+\+\+$/;
const KILLED_RE = /^\+\+\+ killed by (SIG[A-Z0-9]+) \+\+\+$/;
const SIGNAL_LINE_RE = /^--- SIG[A-Z0-9]+ \{.*\} ---$/;

/** Syscalls we know how to normalize; everything else is skipped, not faked. */
const HANDLED_SYSCALLS = new Set([
  "clone",
  "clone3",
  "fork",
  "vfork",
  "execve",
  "execveat",
  "exit",
  "exit_group",
  "open",
  "openat",
  "openat2",
  "creat",
  "read",
  "write",
  "unlink",
  "unlinkat",
  "rename",
  "renameat",
  "renameat2",
  "mkdir",
  "mkdirat",
  "connect",
]);

/** Pseudo-files whose read/write traffic is noise, not signal. */
const NOISE_PATHS = new Set(["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"]);

/** Split a syscall argument list on top-level commas (nesting/quote aware). */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let current = "";
  for (const c of args) {
    if (inStr) {
      current += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      current += c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
      current += c;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** Find the matching close paren of the call, honoring quoted strings. */
function splitCall(
  rest: string,
): { name: string; args: string; retToken: string } | null {
  const paren = rest.indexOf("(");
  if (paren === -1) return null;
  const name = rest.slice(0, paren);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = paren; i < rest.length; i++) {
    const c = rest[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const args = rest.slice(paren + 1, end);
  const after = rest.slice(end + 1).trim();
  const retMatch = after.match(/^=\s*(\?|0[xX][0-9a-fA-F]+|-?\d+)/);
  if (!retMatch) return null;
  return { name, args, retToken: retMatch[1] as string };
}

/** Parse a strace return token into a number; undefined for "?" (unavailable). */
function parseRet(token: string): number | undefined {
  if (token === "?") return undefined;
  const n = token.startsWith("0x") || token.startsWith("0X")
    ? parseInt(token, 16)
    : parseInt(token, 10);
  return Number.isNaN(n) ? undefined : n;
}

function unescapeStr(s: string): string {
  // Octal escapes first (strace prints non-printables like \040).
  const octalDecoded = s.replace(/\\([0-7]{1,3})/g, (_m, o: string) =>
    String.fromCharCode(parseInt(o, 8)),
  );
  return octalDecoded.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return c;
    }
  });
}

/** All double-quoted string literals in `s`, unescaped, in order. */
function quotedStrings(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(unescapeStr(m[1] as string));
  }
  return out;
}

/**
 * Extract the filesystem path from an fd argument like `3</etc/hosts>`.
 * Returns undefined for non-file descriptors (sockets, pipes, ...).
 */
function fdPathAnnotation(fdArg: string): string | undefined {
  const m = fdArg.match(/^\d+<([^>]*)>$/);
  if (!m) return undefined;
  const annotated = m[1] as string;
  if (annotated.startsWith("/") && !NOISE_PATHS.has(annotated)) {
    return annotated;
  }
  return undefined;
}

/**
 * Resolve a path argument against its dirfd, so `openat(3</some/dir>,
 * "sub/file", ...)` becomes "/some/dir/sub/file".
 */
function resolveDirfdPath(
  dirfdArg: string,
  pathArg: string,
): string | undefined {
  const paths = quotedStrings(pathArg);
  const rel = paths[0];
  if (rel === undefined) return undefined;
  if (rel.startsWith("/")) return rel;
  const base = fdPathAnnotation(dirfdArg.trim());
  if (base) return resolvePath(base, rel);
  return rel;
}

interface SockAddr {
  ip: string;
  port: number;
}

/** Parse an AF_INET/AF_INET6 sockaddr struct; undefined for anything else. */
function parseSockAddr(s: string): SockAddr | undefined {
  const isV6 = s.includes("sa_family=AF_INET6");
  const isV4 = !isV6 && s.includes("sa_family=AF_INET");
  if (!isV6 && !isV4) return undefined; // AF_UNIX etc.: not an outbound IP connection
  const portRe = isV6 ? /sin6_port=htons\((\d+)\)/ : /sin_port=htons\((\d+)\)/;
  const ipRe = isV6
    ? /inet_pton\(AF_INET6,\s*"([^"]+)"/
    : /sin_addr=inet_addr\("([^"]+)"\)/;
  const portM = s.match(portRe);
  const ipM = s.match(ipRe);
  if (!portM || !ipM) return undefined;
  return { ip: ipM[1] as string, port: parseInt(portM[1] as string, 10) };
}

function toEpochMs(
  ctx: ParseContext,
  hh: string,
  mm: string,
  ss: string,
  us: string,
): number {
  return (
    ctx.dayStartMs +
    parseInt(hh, 10) * 3600000 +
    parseInt(mm, 10) * 60000 +
    parseInt(ss, 10) * 1000 +
    Math.floor(parseInt(us, 10) / 1000)
  );
}

function makeEvent(
  ctx: ParseContext,
  timestamp: number,
  type: GhostGlassEventType,
  action: GhostGlassEventAction,
  pid: number,
  fields: Partial<GhostGlassEvent> = {},
): GhostGlassEvent {
  const id = `${ctx.runId}-${String(ctx.seq.n).padStart(6, "0")}`;
  ctx.seq.n++;
  return { id, runId: ctx.runId, timestamp, type, action, pid, ...fields };
}

/**
 * Parse one strace output line into a normalized event.
 * Returns null for lines that carry no event (skipped syscalls, signal
 * notifications, unfinished/resumed fragments, malformed lines).
 * Exported for unit testing.
 */
export function parseLine(
  rawLine: string,
  ctx: ParseContext,
): GhostGlassEvent | null {
  const line = rawLine.trimEnd();
  const basic = line.match(BASIC_LINE_RE);
  if (!basic) return null;
  const [, pidStr, hh, mm, ss, us, restRaw] = basic as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const pid = parseInt(pidStr, 10);
  const rest = restRaw.trim();
  const timestamp = toEpochMs(ctx, hh, mm, ss, us);

  // Process exit / termination markers.
  const exited = rest.match(EXITED_RE);
  if (exited) {
    const code = parseInt(exited[1] as string, 10);
    if (ctx.rootPid === pid) ctx.rootExitCode = code;
    return makeEvent(ctx, timestamp, "process", "exit", pid, {
      metadata: { code, marker: "exited" },
    });
  }
  const killed = rest.match(KILLED_RE);
  if (killed) {
    const sig = killed[1] as string;
    if (ctx.rootPid === pid) ctx.rootSignal = sig;
    return makeEvent(ctx, timestamp, "process", "exit", pid, {
      metadata: { signal: sig, marker: "killed" },
    });
  }
  if (SIGNAL_LINE_RE.test(rest)) return null;
  // Unfinished/resumed fragments lack complete arguments; skipping them is
  // honest — we never invent the missing half of a syscall.
  if (rest.includes("<unfinished ...>") || rest.includes(" resumed>")) {
    return null;
  }

  const call = splitCall(rest);
  if (!call) return null;
  if (!HANDLED_SYSCALLS.has(call.name)) return null;
  const ret = parseRet(call.retToken);
  const parts = splitTopLevel(call.args);
  const syscall = call.name;

  switch (syscall) {
    case "execve":
    case "execveat": {
      if (ret === undefined || ret < 0) return null;
      const pathIdx = syscall === "execve" ? 0 : 1;
      const argvIdx = syscall === "execve" ? 1 : 2;
      const exePaths = quotedStrings(parts[pathIdx] ?? "");
      const exe = exePaths[0];
      if (!exe) return null;
      if (ctx.rootPid === undefined) ctx.rootPid = pid;
      const argv = quotedStrings(parts[argvIdx] ?? "");
      return makeEvent(ctx, timestamp, "process", "exec", pid, {
        executable: exe,
        metadata: { syscall, argv },
      });
    }
    case "clone":
    case "clone3":
    case "fork":
    case "vfork": {
      // In -f output the parent's line reports the child's PID as the return.
      if (ret === undefined || ret <= 0) return null;
      return makeEvent(ctx, timestamp, "process", "spawn", ret, {
        parentPid: pid,
        metadata: { syscall },
      });
    }
    case "exit":
    case "exit_group": {
      const code = parts[0] !== undefined ? parseInt(parts[0], 10) : undefined;
      return makeEvent(ctx, timestamp, "process", "exit", pid, {
        metadata: {
          syscall,
          code: Number.isNaN(code) ? undefined : code,
        },
      });
    }
    case "open":
    case "openat":
    case "openat2":
    case "creat": {
      if (ret === undefined || ret < 0) return null;
      const isCreat = syscall === "creat";
      const pathPart = isCreat || syscall === "open" ? parts[0] : parts[1];
      const flagsPart = isCreat ? "" : (parts[syscall === "open" ? 1 : 2] ?? "");
      if (/\bO_PATH\b/.test(flagsPart)) return null; // not real I/O
      let filePath: string | undefined;
      if (syscall === "open" || isCreat) {
        filePath = quotedStrings(pathPart ?? "")[0];
      } else {
        filePath = resolveDirfdPath(parts[0] ?? "", pathPart ?? "");
      }
      if (!filePath) return null;
      const isCreate = isCreat || /\bO_CREAT\b/.test(flagsPart) || /\bO_TMPFILE\b/.test(flagsPart);
      const isWrite = /\bO_WRONLY\b/.test(flagsPart) || /\bO_RDWR\b/.test(flagsPart);
      const action: GhostGlassEventAction = isCreate
        ? "create"
        : isWrite
          ? "write"
          : "read";
      return makeEvent(ctx, timestamp, "file", action, pid, {
        path: filePath,
        metadata: { syscall, flags: flagsPart || undefined },
      });
    }
    case "read":
    case "write": {
      if (ret === undefined || ret < 0) return null;
      const filePath = fdPathAnnotation((parts[0] ?? "").trim());
      if (!filePath) return null;
      return makeEvent(ctx, timestamp, "file", syscall as "read" | "write", pid, {
        path: filePath,
        metadata: { syscall, bytes: ret },
      });
    }
    case "unlink":
    case "unlinkat": {
      if (ret === undefined || ret < 0) return null;
      const pathPart = syscall === "unlink" ? parts[0] : parts[1];
      const filePath = quotedStrings(pathPart ?? "")[0];
      if (!filePath) return null;
      return makeEvent(ctx, timestamp, "file", "delete", pid, {
        path: filePath,
        metadata: { syscall },
      });
    }
    case "rename":
    case "renameat":
    case "renameat2": {
      if (ret === undefined || ret < 0) return null;
      const oldIdx = syscall === "rename" ? 0 : 1;
      const newIdx = syscall === "rename" ? 1 : 3;
      const oldPath = quotedStrings(parts[oldIdx] ?? "")[0];
      const newPath = quotedStrings(parts[newIdx] ?? "")[0];
      if (!oldPath || !newPath) return null;
      return makeEvent(ctx, timestamp, "file", "rename", pid, {
        path: oldPath,
        metadata: { syscall, newPath },
      });
    }
    case "mkdir":
    case "mkdirat": {
      if (ret === undefined || ret < 0) return null;
      const pathPart = syscall === "mkdir" ? parts[0] : parts[1];
      const dirPath = quotedStrings(pathPart ?? "")[0];
      if (!dirPath) return null;
      return makeEvent(ctx, timestamp, "file", "mkdir", pid, {
        path: dirPath,
        metadata: { syscall },
      });
    }
    case "connect": {
      // Recorded as an attempt regardless of outcome (EINPROGRESS, ECONNREFUSED
      // still tell the developer the program tried to reach somewhere).
      const addr = parseSockAddr(parts[1] ?? "");
      if (!addr) return null;
      return makeEvent(ctx, timestamp, "network", "connect", pid, {
        ip: addr.ip,
        port: addr.port,
        metadata: { syscall, result: call.retToken },
      });
    }
    default:
      return null;
  }
}

export function createParseContext(runId: string, startTimeMs: number): ParseContext {
  const start = new Date(startTimeMs);
  start.setHours(0, 0, 0, 0);
  return { runId, dayStartMs: start.getTime(), seq: { n: 1 } };
}

/**
 * Parse a full strace log file into normalized, chronological events.
 * strace -f serializes output chronologically, so file order is event order.
 */
export async function parseTraceFile(
  rawTracePath: string,
  runId: string,
  startTimeMs: number,
): Promise<ParsedTrace> {
  const ctx = createParseContext(runId, startTimeMs);
  const events: GhostGlassEvent[] = [];
  const stats: TraceParseStats = { totalLines: 0, events: 0, skipped: 0, malformed: 0 };

  const rl = createInterface({
    input: createReadStream(rawTracePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.totalLines++;
    const event = parseLine(line, ctx);
    if (event) {
      events.push(event);
      stats.events++;
    } else if (BASIC_LINE_RE.test(line.trimEnd())) {
      // A well-formed trace line we deliberately did not normalize.
      stats.skipped++;
    } else {
      stats.malformed++;
    }
  }

  return {
    events,
    stats,
    rootPid: ctx.rootPid,
    rootExitCode: ctx.rootExitCode,
    rootSignal: ctx.rootSignal,
  };
}
