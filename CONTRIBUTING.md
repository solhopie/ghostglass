# Contributing to GhostGlass

Thanks for your interest in GhostGlass. This is an early-stage, Linux-first
open-source project, and careful, well-tested contributions are welcome.

## Ground rules

- **Local-first, always.** No accounts, no telemetry, no cloud calls, no AI
  integrations. A PR that phones home will not be merged.
- **Never fake data.** If the tracer cannot reliably observe something, the
  code must say so (skip the event, document the limitation) rather than
  invent it.
- **Privacy is a feature.** Do not add anything that dumps environment
  variables, credentials, or tokens into traces.
- **Keep the backend boundary clean.** Tracing logic lives in
  `src/tracer/`, normalization in `src/parser/`, presentation in `src/cli/`.
  New backends implement `TracerBackend` and emit the common
  `GhostGlassEvent` — they must not leak backend specifics into storage or
  the CLI.

## Development workflow

Linux + `strace` are required for the tracing integration tests. Everything
else — parser, storage, summary, and viewer tests — runs on any platform
that has Node.js 18+.

```sh
npm install
npm run dev        # typecheck in watch mode
npm run build
npm test           # build + full test suite (137 tests)
npm run lint
npm run typecheck
```

Requirements for a PR:

1. `npm test` passes (137 tests: unit + real end-to-end traces via strace +
   viewer API and jsdom frontend tests + static export tests).
2. `npm run lint` and `npm run typecheck` are clean (strict TypeScript).
3. New behavior has tests. Parser changes get canned-line unit tests in
   `test/parser.test.ts`; end-to-end behavior gets coverage in
   `test/integration.test.ts` via the fixture program; viewer changes get
   API tests in `test/viewer.test.ts` and frontend tests in
   `test/viewerUi.test.ts` (jsdom).
4. User-visible changes update `README.md` and `CHANGELOG.md`.
5. Viewer changes include a screenshot in the PR description.

## Project layout

```
src/
  cli/          # commands + terminal formatting (no tracing logic here)
  tracer/       # TracerBackend interface + LinuxStraceTracer
  parser/       # raw trace output -> GhostGlassEvent
  events/       # the shared event model
  storage/      # .ghostglass/runs/<id>/ layout
  summary/      # aggregation (pure functions)
  viewer/       # replay API: protocol, indexer, replay engine, server
web/
  public/       # static shell: index.html, styles.css
  src/          # dependency-free TypeScript frontend
                # (no npm dependencies; trace strings rendered as text)
test/
  fixtures/     # fixture programs traced by integration + viewer tests
```

## Reporting issues

Include: GhostGlass version (`ghostglass --version`), Linux distro,
`node --version`, `strace --version`, the command traced, expected behavior,
and actual behavior. **Do not paste secrets, credentials, or sensitive trace
information** — redact paths, IPs, and arguments before posting. See
[SECURITY.md](SECURITY.md) for reporting security vulnerabilities.
