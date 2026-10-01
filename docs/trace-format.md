# Trace Format

A GhostGlass run is a directory, `.ghostglass/runs/<run-id>/`, containing
four files. The format is stable and append-only; old traces keep loading.

## `metadata.json`

Describes the run. Key fields:

| Field | Meaning |
|---|---|
| `runId` | Unique run identifier (`gg_YYYYMMDD_NNN`) |
| `command` / `commandLine` | Traced argv and its rendered command line |
| `startTime` / `endTime` / `durationMs` | Wall-clock timing (includes strace overhead) |
| `os` | `{ platform, arch, release }` |
| `exitCode` / `signal` / `interrupted` | How the command ended |
| `backend` | Tracer backend used (`"strace"`) |
| `eventCount` | Total normalized events |
| `parseStats` | Line counts: total, events, skipped, malformed |
| `reconstruction` | Split-syscall diagnostics (see below) |

## `events.jsonl`

The source of truth: one JSON object per line, in ingestion order. Each
event:

| Field | Meaning |
|---|---|
| `id` | `<run-id>-<zero-padded sequence>` |
| `runId` | Owning run |
| `timestamp` | **Underlying syscall/event time** (ms since epoch) |
| `sequence` | **GhostGlass ingestion/emission order** (1-based, stable) |
| `type` | `process` \| `file` \| `network` |
| `action` | e.g. `spawn`, `exec`, `exit`, `read`, `write`, `create`, `delete`, `connect` |
| `pid` / `parentPid` | Process identity |
| `executable` | Resolved executable path when known |
| `path` | File path (file events) |
| `ip` / `port` | Network destination (network events) |
| `reconstructed` | `true` when the event came from a rejoined split syscall |

**Timestamp vs sequence.** `timestamp` is when the syscall happened;
`sequence` is the order GhostGlass ingested and emitted the event.
Reconstructed split syscalls carry the syscall *start* timestamp but are
*emitted* at resume time, so the two orders can differ on reconstructed
traces. Replay and query default to timestamp order; `order:sequence`
replays ingestion order.

**Backward compatibility.** Runs saved before sequence numbers existed
derive stable in-memory sequences from `events.jsonl` order at load
time. They diff, query, and export cleanly; the files on disk are never
rewritten.

## `summary.json`

Aggregates computed at finalize time: process count, filesystem totals
by action, network attempt count, duration, and exit info. Used by
`ghostglass show`, the run picker, and diff.

## `highlights.json`

The deterministic behavior highlights found for the run (rule id,
severity, title, detail, and the event references). Generated at
finalize; recomputed live during `watch`.

## Split-syscall reconstruction diagnostics

`metadata.json.reconstruction` reports:

| Counter | Meaning |
|---|---|
| `reconstructed` | Pairs successfully rejoined |
| `unresolved` | Unfinished syscalls with no resume seen |
| `orphanResumed` | Resume lines with no matching unfinished |
| `mismatched` | Resume whose name/PID didn't match the pending unfinished |

Unpairable fragments are dropped and counted, never guessed. Nonzero
counters are shown unobtrusively in `ghostglass show`.
