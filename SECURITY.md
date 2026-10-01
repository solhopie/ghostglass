# Security

## Local-first threat model

GhostGlass is a local-first tool. There are no accounts, no cloud
sync, no telemetry, and no AI. The security surface is deliberately small:

- **The trace itself** — stored on your machine, may contain sensitive data.
- **The viewer** — binds to `127.0.0.1` by default, serves only GhostGlass run data.
- **Portable exports** — self-contained HTML you explicitly create and share.

There is no authentication because there is no remote surface: the viewer
is reachable only from your machine. If you need to expose a viewer to
others, run it behind your own authenticated reverse proxy — GhostGlass
does not provide one.

## Trace sensitivity

Traces record what your machine actually did. They can contain:

- file paths (including home directory structure)
- command arguments (flags, filenames, URLs, connection strings you typed)
- process names and executable paths
- network destinations (IPs, ports)

**Do not paste unredacted traces into issue reports, chat channels, or
bug reports** — even private ones. The `--redact-home`, `--redact-cwd`,
`--redact-network`, and `--redact-args` export flags exist for this. The
saved trace on disk is never modified by redaction — only the exported
copy.

Environment variable *values* are never written into a trace: `execve`
lines record only the argument vector, never the environment.

## Viewer network model

- The viewer binds to `127.0.0.1` by default. `--host 0.0.0.0` is
  available but exposes run data to your network — use it only where you
  mean to.
- The viewer serves only files from `.ghostglass/runs/` (run data) and
  its own bundled frontend assets. It does not serve arbitrary files.
- Exported HTML opens from `file://` with CSP `connect-src 'none'` —
  zero network requests, verified in tests.
- Trace strings are rendered as inert text in the viewer (tested with
  hostile payloads), but any bug in that handling should be reported as a
  vulnerability.

## No remote fetching

GhostGlass makes no network requests of its own: no update checks, no
telemetry, no AI, no DNS resolution of traced hostnames (IPs are
recorded as captured), and no automatic uploads. The only sockets it
opens are the local viewer port and, during `watch`, the SSE stream from
your own machine to your own browser.

## Scope

- Local command tracing via the `strace` backend
- The local replay viewer and its API
- Trace parsing and run storage

Out of scope: the security of `strace` itself, the operating system, or
third-party commands that a user chooses to trace.

## Responsible disclosure

If you find a security issue, please use the repository's private
vulnerability reporting (Security tab → "Report a vulnerability") once
the repository is public and the feature is enabled. Until then, do not
open a public issue for a suspected vulnerability, and do not include
unredacted traces in any report.
