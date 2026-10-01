# Contributing to GhostGlass

Thanks for your interest in GhostGlass. This is a Linux-first open-source
project, and careful, well-tested contributions are welcome.

## Ground rules

- **Local-first, always.** No accounts, no telemetry, no cloud calls, no AI
  integrations. A PR that phones home will not be merged.
- **Never fake data.** If the tracer cannot reliably observe something, the
  code must say so (skip the event, count it in diagnostics, document the
  limitation) rather than invent it.
- **Privacy is a feature.** Do not add anything that dumps environment
  variables, credentials, or tokens into traces.
- **Keep the backend boundary clean.** Tracing logic lives in
  `src/tracer/`, normalization in `src/parser/`, presentation in `src/cli/`.
  New backends implement `TracerBackend` and emit the common
  `GhostGlassEvent` — they must not leak backend specifics into storage or
  the CLI.
- **Deterministic, not clever.** Query, highlights, and cause chains are
  rule-based and explainable. No heuristics that can't be tested, no
  probabilistic matching, no inferred intent.

## Development workflow

Linux + `strace` are required for the tracing integration tests. Everything
else — parser, storage, summary, query, and viewer tests — runs on any
platform that has Node.js 18+.

```sh
npm install
npm run typecheck  # tsc --noEmit (app + web)
npm run lint       # eslint
npm test           # build + full suite (unit + end-to-end)
npm run build      # compile to dist/
npm run demo       # trace the bundled demo fixture, print the viewer command
```

Requirements for a PR:

1. `npm test` passes (unit + real end-to-end traces via strace + viewer
   API and jsdom frontend tests + static export tests).
2. `npm run lint` and `npm run typecheck` are clean (strict TypeScript).
3. New behavior has tests. See the fixture philosophy below.
4. User-visible changes update `README.md` and `CHANGELOG.md`.
5. Viewer changes include a screenshot in the PR description.
6. Changes to the trace format keep old traces loading — see
   [docs/trace-format.md](docs/trace-format.md).

## Generated browser code

The query engine is shared between Node and the browser. `src/query/`
is the source of truth; `web/src/query/` is a **generated copy** produced
by `scripts/vendor-query-web.cjs` during `npm run build`.

**Never hand-edit `web/src/query/`** (or any `*.vendored.*` module).
Change `src/query/`, re-run the build, and commit both.

## Fixture philosophy

- **Real strace first.** End-to-end behavior is covered in
  `test/integration.test.ts` by tracing small fixture programs under
  real `strace`. If a parser change affects what real traces look like,
  it needs a fixture and an integration test.
- **Canned lines for the parser.** `test/parser.test.ts` feeds exact
  strace lines (including `<unfinished ...>` / `<... resumed>` pairs)
  to the parser for deterministic unit coverage without strace.
- **Fixtures are deterministic and offline.** No network, no package
  installs, no timing assumptions. A fixture that flakes is a bug in the
  fixture.
- **Viewer tests** use API tests (`test/viewer.test.ts`) and jsdom
  frontend tests (`test/viewerUi.test.ts`, `test/querybar-layout.test.ts`).

## Project layout

```
src/
  cli/          # commands + terminal formatting (no tracing logic here)
  tracer/       # TracerBackend interface + LinuxStraceTracer
  parser/       # raw trace output -> GhostGlassEvent (+ reconstruction)
  events/       # the shared event model
  storage/      # .ghostglass/runs/<id>/ layout
  summary/      # aggregation (pure functions)
  query/        # deterministic query engine (source of truth for web copy)
  cause/        # cause-chain engine
  highlights/   # behavior highlight rules
  diff/         # run comparison
  export/       # portable HTML/JSON export
  live/         # Live Glass streaming sessions
  viewer/       # replay API: protocol, indexer, replay engine, server
web/
  public/       # static shell: index.html, styles.css
  src/          # dependency-free TypeScript frontend
                # (no npm dependencies; trace strings rendered as text)
test/
  fixtures/     # deterministic offline fixture programs
scripts/
  vendor-query-web.cjs  # copies src/query -> web/src/query (do not hand-edit output)
```

## Reporting issues

Include: GhostGlass version (`ghostglass --version`), Linux distro,
`node --version`, `strace --version`, the command traced, expected behavior,
and actual behavior. **Do not paste secrets, credentials, or sensitive trace
information** — redact paths, IPs, and arguments before posting. See
[SECURITY.md](SECURITY.md) for reporting security vulnerabilities.
