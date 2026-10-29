# Session recording and replay

The offline harness replays provider stream events into a real Pi SDK `AgentSession`. Real SDK tools, JSONL persistence, retries/cancellation, delivery projection and trajectory worker observe the execution; renderer rows are never injected as a replacement for streaming.

## Commands

```sh
node scripts/check-session-replay.mjs
node scripts/session-replay.mjs replay --fixture scripts/fixtures/session-replay/read-write-present.json
node scripts/session-replay.mjs record --scenario read-write-present --output /tmp/read-write-present.json
```

Scenarios cover ordinary turns, read/write/present, failed present, retries, streamed cancellation and retry-backoff cancellation. Recording uses a deterministic synthetic provider, requires an output path, and refuses existing baselines unless `--overwrite` is explicit. Checks never refresh fixtures. Both modes block network transports and use isolated profiles without ambient credentials/extensions/skills or real-provider fallback.

## Boundary contract

`scripts/lib/session-replay.mjs` supplies recorder/replay, normalization and equality helpers. Install the caller-supplied `streamFunction` through the public agent property. Recording requires `assertComplete()`; replay teardown must call `assertConsumed()`, including after SDK errors, because SDK can convert provider mismatch exceptions into assistant errors.

`pith-session-replay-v1` preserves ordered requests, consumed events/partials, usage/stop reason, payload replacement, safe response metadata and durable outcomes. Clone mutable partials immediately. Compare full model/system/messages and public Tool fields (`name`, `description`, `parameters`, optional `constrainedSampling`), excluding closures/runtime identities and app-only `contextBudget` diagnostics. Transformed messages remain fully checked.

Normalize only explicit workspace/profile/session roots, message timestamps and correlated tool IDs. Keep relative suffixes, order and semantic IDs/timestamps inside arguments. Reserved placeholder syntax is refused. Operational credentials are redacted; secrets in model-visible semantic data cause recording to fail instead of being masked into a misleading baseline.

Cancellation waits for the SDK's real abort signal; replay does not invent a timer abort to pass. Request, schema, argument, result and payload drift fail explicitly, as do extra/unconsumed calls and malformed terminals.

## State checks and limits

Every run creates a temporary canonical workspace and trajectory database. Real SDK read/write are confined to it, including symlink ancestors; only read/write/present are enabled. A later awaited agent subscription observes committed entries after SDK persistence.

Golden outcomes compare transcript, tool lifecycle, file bytes, delivery, request documents and run usage. Retries share one logical run until `agent_settled`; every attempt settles and cancellation during backoff settles both retry and run. Exact durations are excluded while observed-first-output presence is checked.

This corpus does not prove vendor HTTP adapters, model quality, parallel children, compaction, queue admission, browser/debug runtime or renderer geometry. Their dedicated checks remain required.
