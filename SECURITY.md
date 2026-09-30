# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in GhostGlass, please report it
through **GitHub's private vulnerability reporting** feature on the
repository (Security tab → "Report a vulnerability"). This keeps the details
private while the issue is triaged and fixed.

Please do not open a public issue for a suspected vulnerability.

## What to know

GhostGlass processes potentially sensitive local system traces: a trace can
contain file paths, command lines, process relationships, and network
destinations from the machine it was recorded on. When sharing traces for
debugging — even in private reports — redact anything sensitive first
(usernames in paths, internal hostnames and IPs, credentials or tokens in
arguments).

The replay viewer (`ghostglass open`) is a local-only HTTP server that
binds to `127.0.0.1` by default and serves only GhostGlass run data. Do not
expose it to a network you do not trust, and treat trace strings as
untrusted input: the viewer renders them as inert text, but any bug in that
handling should be reported as a vulnerability.

## Scope

- Local command tracing via the `strace` backend
- The local replay viewer and its API
- Trace parsing and run storage

Out of scope: the security of `strace` itself, the operating system, or
third-party commands that a user chooses to trace.
