# Changelog

All notable changes to GhostGlass are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] - Unreleased

Run 5: live glass — watch what your command is doing while it is doing it.

### Added

- `ghostglass watch -- <command> [--no-browser] [--port N]`: traces the
  command exactly like `ghostglass run`, but streams normalized events to a
  live browser view as they happen (server-sent events on a 127.0.0.1-only
  server). The graph grows, the event stream scrolls, and counters tick up
  in real time; follow mode auto-scrolls until you scroll up to inspect.
- Live viewer at `/live/<run-id>`: reconnects (refresh, dropped
  connection) replay missed events with no duplicates, then resume live;
  when the command exits the view transitions to the full replay without a
  reload. Completed live runs are saved in the standard format, so `open`,
  `diff`, and `export` all work on them.
- Incremental tracing backend: strace output is tailed and parsed in
  chunks while the command runs (split lines, split multibyte characters,
  and malformed lines handled); target stdout/stderr stay inherited and
  visible. Backpressure pauses the tail at 50,000 queued events and resumes
  at 10,000 — pausing never loses data.
- Live session persistence: `events.jsonl` is appended incrementally, so a
  viewer failure or closed browser never loses the trace; finalization
  still writes the standard `summary.json` / `metadata.json`.
- Slow-reader protection on the event stream: a client that falls more
  than ~2 MB behind is asked to reconnect with `?since=<lastEventId>`
  instead of ballooning server memory.

### Fixed

- Live subscribers can no longer receive a replayed event twice: the
  broadcast buffer is flushed to existing subscribers before a new
  subscriber's replay is drawn from history.
- SSE slow-reader guard measured cumulative bytes ever sent instead of the
  real socket buffer, so a healthy long-running client would be disconnected
  after ~2 MB of total traffic. It now trips only when `write()` reports
  backpressure and the actual pending socket buffer exceeds 2 MB.
- The live graph reset the user's pan/zoom on every incremental re-render;
  the viewport transform is now preserved across live updates.
- Refreshing `/live/<run-id>` after the run finished showed a dead live view;
  it now redirects to the saved run's replay page.
- The slow-reader disconnect now ends the response gracefully so the client
  reliably receives the resync error frame before the connection closes.

## [0.4.0] - 2026-09-30

Run 4: portable reports — export any trace as a single self-contained HTML
file that opens from `file://` with no install, no server, no internet.

### Added

- `ghostglass export <run-id> | latest [--format html|json] [-o <path>]
  [--force]`: writes a single-file HTML report (default) or machine-readable
  JSON. The HTML reuses the full Run 2/3 viewer — execution graph, replay
  timeline, virtualized event stream, inspectors — booted from an embedded
  data envelope instead of the live API, so the report works offline from a
  plain file URL. Filenames default to `ghostglass-<run-id>.html`;
  `--force` is required to overwrite; parent directories are created.
- `ghostglass export-diff <run-a> <run-b> | previous latest [...]`: same
  treatment for comparisons — the full diff viewer (status-coded graph,
  mode filters, dual timelines, difference stream) in one file, default
  `ghostglass-diff-<a>-vs-<b>.html`.
- Redaction flags, applied to an in-memory copy before the graph/diff are
  derived (saved traces are never modified): `--redact-home`,
  `--redact-cwd`, `--redact-network` (IP masked, port kept),
  `--redact-args` (argv beyond the executable replaced). Redacted values
  appear nowhere in the HTML source — verified by tests that grep the raw
  output for every original secret.
- Security hardening for untrusted trace data: `<` escaped as `\u003c` in
  the embedded JSON, `</script>`/`<!--` sequences neutralized in inline
  scripts, lone UTF-16 surrogates sanitized, all trace strings rendered as
  inert text, and a real Content-Security-Policy
  (`default-src 'none'; connect-src 'none'; …`) that still permits the
  static report to run. Print stylesheet included.
- Privacy by default: the CLI prints a warning on every export and the
  report carries one; export is always explicit, entirely local, and never
  uploads — no telemetry, no accounts, no network requests (verified zero
  in a real browser).
- 32 new tests (137 total): run/diff HTML+JSON export, latest/previous
  resolution, custom output, --force semantics, overwrite refusal, invalid
  format/ID/traversal rejection, all four redaction flags with
  source-level absence checks, `</script>`/HTML/JS injection payloads,
  malformed Unicode, zero-external-dependency scan of the template,
  graph/timeline/inspector data presence, diff classifications, 12,000-event
  export, byte-determinism, filename sanitization, JSON schema checks.

### Measured (55,000-event trace)

- HTML export: 566 ms, 11.1 MB. JSON export: 467 ms, 9.8 MB.
- Real Chromium via file://: full render in 2.5 s (2,028 graph nodes),
  10 MB JS heap, virtualized stream (18 rows), timeline scrub 13 ms,
  zero console errors, zero network requests.

### Fixed

- `setPointerCapture` in the timeline and both graph views threw an
  uncaught DOMException on synthetic pointer events (found by the new
  browser interaction suite); pointer capture is now best-effort and can no
  longer break scrubbing, panning, or dragging.
- Compiled CLI reported `0.0.0-dev` because the version lookup resolved the
  wrong `package.json` from `dist/`; it now walks up to the owning
  `ghostglass` package (reports `0.4.0`).

## [0.3.0] - 2026-09-30

Run 3: the diff — compare two traces side by side.

### Added

- `ghostglass diff <run-a> <run-b>`: interactive comparison of two saved
  traces in the local web viewer. `latest`/`previous` aliases resolve to the
  two most recent traces; `--no-browser` prints the URL without launching a
  browser; `--port <n>` overrides the default `127.0.0.1:7777`. The terminal
  prints a compact A/B/Δ summary before the browser opens.
- Diff engine (`src/diff/`): processes matched by executable + captured argv
  + parent executable (PID-independent, so equivalent runs match despite
  different PIDs), files by normalized path, network endpoints by IP:port.
  Every entity is classified shared / changed / only-a / only-b; repeated
  identical processes are aggregated and flagged ambiguous rather than
  paired arbitrarily. Map/set-based indexing — no O(n²) entity comparison.
- Viewer API `GET /api/diff/<run-a>/<run-b>` and page `/diff/<run-a>/<run-b>`,
  with the same strict run-ID validation and inert-text rendering as the
  single-run viewer. Diffs are computed on demand from the saved runs and
  never persisted; no extra storage, no accounts, no network.
- Visual diff: combined execution graph (status-coded borders and badges,
  never color alone) with Differences Only / All / Only A / Only B / Shared
  modes and process/file/network layer toggles; dual run timeline with real
  and normalized modes; difference stream with side/kind filters and search;
  comparative inspectors showing Run A / Run B / Δ per node.
- Deterministic demo fixtures `test/fixtures/demo-a.cjs` / `demo-b.cjs`
  (local-only, no internet) for trying the diff out:
  `ghostglass run -- node test/fixtures/demo-a.cjs`,
  `ghostglass run -- node test/fixtures/demo-b.cjs`,
  `ghostglass diff previous latest`.
- 29 new tests (105 total): diff engine (matching, classification, summary
  deltas, fingerprints, ambiguity, unknown-process separation, 24k-event
  performance), diff CLI (latest/previous resolution, invalid-ID and
  traversal rejection), viewer diff API (shape, 400/404 handling, localhost
  binding, shutdown), and jsdom frontend tests (graph modes, layer toggles,
  stream filters, search, timeline normalization, inspectors, hostile-string
  rendering).

### Documented limitations

- Diff graphs cap file nodes at 600 for rendering (noted in the UI); the
  difference stream is capped at 5,000 rows (noted in the UI).
- Argv differences make two processes different entities by design; temp
  files with random names are never merged.
- Processes whose executable and argv were never captured (threads, or
  children whose execve arrived as an unfinished/resumed fragment the
  tracer skips per its documented Run 1 limitation) are aggregated per run
  as "Unknown (N processes)" and never matched across runs.

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
