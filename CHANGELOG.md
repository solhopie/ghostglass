# Changelog

All notable changes to GhostGlass are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-09-30

Run 2: the visual execution replay.

### Added

- `ghostglass open <run-id> | latest`: replay a saved trace in a local web
  viewer (dependency-free TypeScript frontend, no build step for users).
  `ghostglass open <run-id> --no-browser` prints the URL without launching a
  browser; `--port <n>` overrides the default `127.0.0.1:7777` (valid ports
  are 1–65535; the server falls through to the next free port on collision).
- Process/file/network graph: one root node, one node per process, one per
  unique file path (top 600 by activity), one per IP:port; spawn/access/
  connect edges derived from the trace with parent→child direction verified
  against raw events.
- Replay engine: play/pause, 1x/2x/4x, jump to start/end, forward and reverse
  timeline scrubbing with binary-search event indexing; graph nodes activate
  as the playhead reaches their events.
- Virtualized event stream with kind filters, action chips, and free-text
  search; clicking a row pauses and seeks the replay to that event.
- Node and event inspectors (PID/parent PID/executable, file access counts,
  endpoints, timestamps, run metadata).
- Graph pan/zoom/node-drag/fit/reset, file and network layer toggles.
- Run picker at `/` listing all saved traces; interrupted traces badged.
- Trace strings are rendered as inert text throughout (XSS-safe); run IDs
  are strictly validated; the static server pins all file serving inside the
  bundled web build; the API exposes only GhostGlass run data.
- 34 new tests (76 total): real-trace viewer API tests, `open` CLI tests
  (latest resolution, SIGINT lifecycle, port validation), and jsdom frontend
  tests (header, graph, filters, search, timeline, inspector, hostile-string
  rendering).

### Fixed

- Timeline endpoint returns timestamps in ascending order even when events
  arrive out of order.
- Spawn descriptions now read parent → child (were reversed).
- A null byte in a static-asset path now returns 400 instead of hanging the
  connection.
- The inspector panel never rendered: `InspectorView.render()` was not
  called on boot, so clicking graph nodes or event rows showed nothing
  (found by automated browser validation; now fixed and covered).
- Added an inline empty favicon so browsers no longer log a 404 for
  `/favicon.ico`.

### Documented limitations

- Viewer graph shows the top 600 files by activity; the full event list is
  always available in the stream.
- Event pages are capped at 5,000 per API request (the frontend paginates).

## [0.1.0] - 2026-09-30

Run 1: the solid tracing foundation.

### Added

- `ghostglass run -- <command>`: execute a command under `strace -f`
  observation and record system activity (Linux-first).
- Normalized `GhostGlassEvent` model (`process` / `file` / `network`
  types; `exec`, `spawn`, `exit`, `read`, `write`, `create`, `delete`,
  `rename`, `mkdir`, `connect` actions) shared by all future backends.
- `TracerBackend` interface (`LinuxStraceTracer` implementation) so an
  eBPF backend can be added later without rewriting the application.
- Per-run local storage under `.ghostglass/runs/<run-id>/`:
  `metadata.json`, `events.jsonl` (chronological), `summary.json`, plus the
  raw `trace.log`.
- `ghostglass runs`: list recent traces. `ghostglass show <run-id>`:
  re-display a saved summary.
- Terminal summary with process count, filesystem breakdown
  (reads/writes/creates/deletes/renames/mkdirs), and outbound connection
  attempts with destination IP:port.
- Clear error + install instructions when `strace` is missing.
- Signal handling: Ctrl+C / SIGTERM are forwarded to the traced process
  group, tracing processes are cleaned up, the partial trace is saved and
  marked interrupted.
- Exit-code preservation: GhostGlass exits with the traced command's exit
  code (or 128+signal when terminated by a signal).
- 40 tests: parser unit tests (incl. malformed lines), storage/summary
  unit tests, and end-to-end tests tracing a real fixture program
  (file create/modify/delete, child spawn, localhost TCP, exit codes,
  Ctrl+C, spaced arguments).

### Documented limitations

- Hostnames are not resolved (IP:port only, never guessed); AF_UNIX
  sockets skipped; only successful syscalls become file/process events;
  `<unfinished>`/`<... resumed>` fragments skipped; no live streaming yet;
  tracing adds 2–10x overhead to syscall-heavy commands. See README.
