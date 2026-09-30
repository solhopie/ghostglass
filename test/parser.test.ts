/**
 * Unit tests for the strace line parser.
 *
 * These run without strace installed: they feed canned strace output lines
 * directly into parseLine() and assert the normalized GhostGlass events.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLine,
  createParseContext,
} from "../src/parser/straceParser.js";

function ctx() {
  // 2026-09-30 01:00:00 local time as the run start.
  const start = new Date(2026, 8, 30, 1, 0, 0, 0).getTime();
  return createParseContext("gg_20260930_001", start);
}

const parse = (line: string) => parseLine(line, ctx());

describe("process event parsing", () => {
  it("parses execve into an exec event with argv", () => {
    const e = parse(
      '18281 01:14:22.123456 execve("/usr/bin/npm", ["npm", "install", "express"], 0x7ffce1b2c3d0 /* 42 vars */) = 0 <0.000123>',
    );
    assert.ok(e);
    assert.equal(e.type, "process");
    assert.equal(e.action, "exec");
    assert.equal(e.pid, 18281);
    assert.equal(e.executable, "/usr/bin/npm");
    assert.deepEqual(e.metadata?.argv, ["npm", "install", "express"]);
    assert.equal(e.metadata?.syscall, "execve");
  });

  it("parses clone into a spawn event with parent/child PIDs", () => {
    const e = parse(
      "18282 01:14:22.125000 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f8b) = 18283 <0.000200>",
    );
    assert.ok(e);
    assert.equal(e.type, "process");
    assert.equal(e.action, "spawn");
    assert.equal(e.pid, 18283);
    assert.equal(e.parentPid, 18282);
  });

  it("parses exit_group and the 'exited with' marker", () => {
    const c = ctx();
    const e1 = parseLine("18281 01:14:22.200000 exit_group(0) = ? <0.000001>", c);
    assert.ok(e1);
    assert.equal(e1.action, "exit");
    assert.equal(e1.metadata?.code, 0);

    const e2 = parseLine("18281 01:14:22.200010 +++ exited with 0 +++", c);
    assert.ok(e2);
    assert.equal(e2.action, "exit");
    assert.equal(e2.metadata?.code, 0);
  });

  it("records the signal from a 'killed by' marker", () => {
    const c = ctx();
    const e = parseLine("18281 01:14:22.200010 +++ killed by SIGINT +++", c);
    assert.ok(e);
    assert.equal(e.action, "exit");
    assert.equal(e.metadata?.signal, "SIGINT");
  });
});

describe("filesystem event parsing", () => {
  it("normalizes openat O_RDONLY to a read event", () => {
    const e = parse(
      '18282 01:14:22.124001 openat(AT_FDCWD, "/home/u/package.json", O_RDONLY|O_CLOEXEC) = 3</home/u/package.json> <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.type, "file");
    assert.equal(e.action, "read");
    assert.equal(e.path, "/home/u/package.json");
  });

  it("normalizes openat O_CREAT to a create event", () => {
    const e = parse(
      '18282 01:14:22.124060 openat(AT_FDCWD, "/tmp/new.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4</tmp/new.txt> <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "create");
    assert.equal(e.path, "/tmp/new.txt");
  });

  it("normalizes openat O_WRONLY without O_CREAT to a write event", () => {
    const e = parse(
      '18282 01:14:22.124060 openat(AT_FDCWD, "/tmp/existing.txt", O_WRONLY|O_APPEND) = 4</tmp/existing.txt> <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "write");
    assert.equal(e.path, "/tmp/existing.txt");
  });

  it("resolves relative paths against the dirfd annotation", () => {
    const e = parse(
      '18282 01:14:22.124060 openat(3</tmp/workdir>, "sub/file.txt", O_RDONLY) = 4</tmp/workdir/sub/file.txt> <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "read");
    assert.equal(e.path, "/tmp/workdir/sub/file.txt");
  });

  it("parses read/write syscalls via the fd path annotation", () => {
    const r = parse(
      '18282 01:14:22.124050 read(3</home/u/package.json>, "{\\"name\\": \\"x\\"}", 8192) = 12 <0.000005>',
    );
    assert.ok(r);
    assert.equal(r.action, "read");
    assert.equal(r.path, "/home/u/package.json");
    assert.equal(r.metadata?.bytes, 12);

    const w = parse(
      '18282 01:14:22.124070 write(4</tmp/new.txt>, "hello", 5) = 5 <0.000005>',
    );
    assert.ok(w);
    assert.equal(w.action, "write");
    assert.equal(w.path, "/tmp/new.txt");
  });

  it("skips reads/writes on sockets and pipes (not file activity)", () => {
    assert.equal(
      parse("18282 01:14:22.124050 read(5<socket:[12345]>, \"x\", 10) = 1"),
      null,
    );
    assert.equal(
      parse("18282 01:14:22.124050 write(6<pipe:[67890]>, \"x\", 1) = 1"),
      null,
    );
  });

  it("skips noise pseudo-files like /dev/urandom", () => {
    assert.equal(
      parse("18282 01:14:22.124050 read(3</dev/urandom>, \"x\", 16) = 16"),
      null,
    );
  });

  it("parses unlinkat as delete", () => {
    const e = parse(
      '18282 01:14:22.124080 unlinkat(AT_FDCWD, "/tmp/old.txt", 0) = 0 <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "delete");
    assert.equal(e.path, "/tmp/old.txt");
  });

  it("parses renameat with old and new paths", () => {
    const e = parse(
      '18282 01:14:22.124090 renameat(AT_FDCWD, "/tmp/a.txt", AT_FDCWD, "/tmp/b.txt") = 0 <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "rename");
    assert.equal(e.path, "/tmp/a.txt");
    assert.equal(e.metadata?.newPath, "/tmp/b.txt");
  });

  it("parses mkdirat as mkdir", () => {
    const e = parse(
      '18282 01:14:22.124100 mkdirat(AT_FDCWD, "/tmp/newdir", 0777) = 0 <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "mkdir");
    assert.equal(e.path, "/tmp/newdir");
  });

  it("ignores failed syscalls (probing that found nothing)", () => {
    assert.equal(
      parse(
        '18282 01:14:22.124001 openat(AT_FDCWD, "/home/u/nope.json", O_RDONLY) = -1 ENOENT (No such file or directory) <0.000010>',
      ),
      null,
    );
  });
});

describe("network event parsing", () => {
  it("parses an IPv4 connect into ip + port", () => {
    const e = parse(
      '18283 01:14:22.130000 connect(5<socket:[12345]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("93.184.216.34")}, 16) = 0 <0.050000>',
    );
    assert.ok(e);
    assert.equal(e.type, "network");
    assert.equal(e.action, "connect");
    assert.equal(e.ip, "93.184.216.34");
    assert.equal(e.port, 443);
    assert.equal(e.host, undefined); // never guessed
  });

  it("records in-progress connects as attempts too", () => {
    const e = parse(
      '18283 01:14:22.130000 connect(5<socket:[12345]>, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("93.184.216.34")}, 16) = -1 EINPROGRESS (Operation now in progress) <0.000010>',
    );
    assert.ok(e);
    assert.equal(e.action, "connect");
    assert.equal(e.port, 80);
  });

  it("parses an IPv6 connect", () => {
    const e = parse(
      '18283 01:14:22.130010 connect(6<socket:[12346]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr), sin6_scope_id=0}, 28) = 0 <0.001000>',
    );
    assert.ok(e);
    assert.equal(e.ip, "2001:db8::1");
    assert.equal(e.port, 443);
  });

  it("skips AF_UNIX connects (not outbound IP traffic)", () => {
    assert.equal(
      parse(
        '18283 01:14:22.130000 connect(5<socket:[1]>, {sa_family=AF_UNIX, sun_path="/run/dbus/system_bus_socket"}, 32) = 0 <0.000100>',
      ),
      null,
    );
  });
});

describe("malformed and edge-case trace lines", () => {
  it("returns null for malformed lines without throwing", () => {
    const c = ctx();
    const bad = [
      "",
      "this is not a trace line",
      "strace: Process 18282 attached",
      "18281 01:14:22.123456", // truncated
      "notapid 01:14:22.123456 execve() = 0",
      "18281 <... read resumed> \"data\" ) = 5", // resumed fragment
      "18281 01:14:22.123456 read(3, <unfinished ...>",
      "18281 01:14:22.123456 --- SIGCHLD {si_signo=SIGCHLD} ---",
    ];
    for (const line of bad) {
      assert.equal(parseLine(line, c), null, `line should be skipped: ${line}`);
    }
  });

  it("skips O_PATH opens (not real I/O)", () => {
    assert.equal(
      parse(
        '18282 01:14:22.124001 openat(AT_FDCWD, "/proc/self/fd", O_RDONLY|O_PATH|O_DIRECTORY) = 3 <0.000010>',
      ),
      null,
    );
  });

  it("assigns sequential unique event ids and epoch timestamps", () => {
    const c = ctx();
    const e1 = parseLine(
      '1 01:00:00.000000 openat(AT_FDCWD, "/a", O_RDONLY) = 3 <0.000001>',
      c,
    );
    const e2 = parseLine(
      '1 01:00:01.500000 openat(AT_FDCWD, "/b", O_RDONLY) = 3 <0.000001>',
      c,
    );
    assert.ok(e1 && e2);
    assert.notEqual(e1.id, e2.id);
    assert.ok(e1.id.startsWith("gg_20260930_001-"));
    assert.equal(e2.timestamp - e1.timestamp, 1500);
  });
});
