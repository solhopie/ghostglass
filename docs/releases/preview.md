# GhostGlass v1 Preview (pre-release notes)

> This is **not** v1.0. It is a preview of the feature set targeting the
> first public release. The version stays at `0.9.0` until the release
> checklist in `docs/PUBLISHING.md` is complete.

## What's in

- **Tracing.** `ghostglass run -- <command>` records process, filesystem,
  and network activity via `strace -f` into a local run directory.
- **Replay.** `ghostglass open <run-id>` serves an interactive viewer:
  process/file/network graph, scrubbable timeline, virtualized event
  stream, inspector, and behavior highlights.
- **Live Glass.** `ghostglass watch -- <command>` streams trace events to
  the browser over SSE while the command runs, then transitions to full
  replay when it exits.
- **Diff.** `ghostglass diff <a> <b>` compares two runs (summary,
  processes, files, network, highlights) in the CLI and in a dedicated
  viewer page.
- **Highlights.** Seven deterministic behavior rules (bursts,
  outside-cwd access, create-then-execute, …). Observed behavior only —
  never security verdicts.
- **Cause Chain.** `ghostglass why` and the in-viewer Cause Chain walk a
  target event back through recorded process ancestry with honest
  `DIRECT` / `STRUCTURAL` / `INCOMPLETE` confidence.
- **Query.** One deterministic `key:value` engine shared by the CLI, the
  saved viewer, Live Glass, portable exports, and diff. AND across
  fields, OR across repeated fields, timestamp and sequence ordering.
- **Portable export.** `ghostglass export` produces a single
  self-contained HTML file that opens from `file://` with zero network
  requests; `export-diff` does the same for comparisons. Redaction flags
  for home, cwd, network, and args.
- **Split-syscall reconstruction.** `<unfinished>` / `<... resumed>`
  pairs are deterministically rejoined by PID + syscall name; unpairable
  fragments are counted in diagnostics, never guessed.

## Known limitations

- Linux only; no macOS/Windows tracer.
- `strace` overhead (typically 2–10x on syscall-heavy workloads).
- Split-syscall reconstruction is deterministic only; orphans are dropped
  and counted.
- Hostnames are not resolved; AF_UNIX sockets are skipped.
- Only successful syscalls become file/process events (except `connect`
  attempts).
- Timestamps assume the trace does not cross a local-midnight boundary.
- Viewer graph shows the top 600 files by activity.
- Real-browser Live Glass validation is still manually pending in this
  build environment.
- Traces can contain sensitive local information — redact before sharing.
- No cloud, no accounts, no collaboration — local-first by design.

## Before v1.0

The remaining work is release engineering, not features: README and docs
polish, CI, the `npm run demo` script, packaging review (what ships in
the npm tarball), changelog consolidation, and a final audit. No new
product features are planned before the release cut.
