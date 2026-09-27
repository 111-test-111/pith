# Session recording and replay

`node scripts/check-session-replay.mjs` runs recorded regressions without an API
key. It compares each provider request before playing recorded assistant stream
events into a real Pi SDK `AgentSession`. The SDK executes real filesystem tools,
writes its JSONL session, retries failed requests and handles cancellation. The
app's `presentedFiles` projection and `TrajectoryRecorder`/SQLite worker observe
that execution. No renderer rows are injected and no settled UI transcript is
used as a substitute for model streaming.

## Commands

```sh
# The committed corpus, including negative contract checks. Completely offline.
node scripts/check-session-replay.mjs

# One committed fixture. Completely offline.
node scripts/session-replay.mjs replay --fixture scripts/fixtures/session-replay/read-write-present.json

# Explicit recording from a deterministic synthetic provider into a real SDK.
# The output path is required and an existing baseline is refused by default.
node scripts/session-replay.mjs record --scenario read-write-present --output /tmp/read-write-present.json
```

Recording supports `ordinary-turn`, `read-write-present`, `failed-present`,
`provider-retry`, `cancelled-stream` and `cancelled-retry`. `--overwrite` is an explicit baseline
refresh; inspect the resulting diff before committing it. Checks never record
or update fixtures. There is no live-provider recording command. Both CLI modes
install a process-local network guard for fetch, WebSocket, HTTP/HTTPS and TCP/TLS
clients. The isolated SDK profile has no ambient extensions, skills, project
context files or user credentials, uses a loopback placeholder model, and never
falls back to a real provider. The driver has a bounded timeout.

## Reusable boundary

`scripts/lib/session-replay.mjs` exposes `createSessionRecorder`,
`createSessionReplay`, `createReplayNormalizer`, `loadSessionReplay`,
`saveSessionReplay` and `assertReplayEqual`. Install the returned `streamFunction`
through the SDK's public `session.agent.streamFunction` property before a turn.
The recorder requires a caller-supplied stream function; it cannot discover or
select an API provider. `assertComplete()` refuses incomplete recordings.
`assertConsumed()` is mandatory at replay teardown, including after an SDK
error: the SDK converts provider exceptions into assistant errors, so request
mismatches are latched and rethrown at teardown.

A fixture is versioned as `pith-session-replay-v1`. It contains scenario inputs,
ordered provider calls, their request contracts and exchanges, and the expected
durable outcome. Each call preserves actual consumed stream events, including
partial text/tool arguments, final usage and stop reason. Partials are cloned
immediately because providers can mutate them. Provider `onPayload` captures both
the original payload and its final value after replacement; replay invokes the
current callback and checks that final value. HTTP callbacks retain response
status and safe, redacted metadata. Error/retry settlements remain distinct.
An explicit abort exchange waits for the SDK's real `AbortSignal`; the scenario
driver cancels after an actual text delta. Replay does not cancel itself on a
timer to make the fixture pass. A missing cancellation fails within five seconds.

The provider contract preserves the complete model, system prompt, message
content/order, tool descriptions/schemas/constrained sampling, and serializable
provider options. The SDK passes `AgentLoopConfig` hooks and `AgentTool` functions
through this boundary; only runtime callbacks/identities are excluded. The
public provider Tool surface is projected as `name`, `description`, `parameters`
and optional `constrainedSampling`. App `contextBudget` diagnostics are excluded;
the model-visible messages produced by a budget transform remain fully checked.

## Normalization and secrets

Only explicitly bound workspace/profile/session-directory roots, message
timestamps and tool correlation IDs are normalized. Roots keep their relative
suffix; a different filename remains different. Rooted Windows `path` fields and
`present` path text use portable
separator spelling; arbitrary code escapes are preserved. Timestamps become zero
in comparisons, preserving array/event order without relying on wall-clock
millisecond coincidences. Replayed assistant responses receive distinct internal
timestamps for SDK correlation. Tool-call IDs bind consistently across calls,
results and execution events. An `id` or `timestamp` inside tool arguments stays
semantic. Source text containing the reserved `{{pith:…}}` syntax is refused,
rather than silently treated as a wildcard. Arbitrary text, schemas, usage,
stop reasons and argument values are never shortened or fuzzily matched.

The committed corpus is synthetic and contains no real credentials. Credential
redaction applies to scalar auth fields in explicitly operational options,
payloads and response documents. It does not erase schema properties or tool
arguments from the semantic request. Callers can supply `secretValues` to the
normalizer: an operational value is redacted, while a secret occurring in
model-visible data causes recording to fail. Such a session needs a reviewed,
synthetic scenario; it cannot be safely reproduced by masking meaningful input.

## Real-state checks

The helper creates a new temporary workspace, SDK services/session manager and
app trajectory worker for every run. Only `read`, `write` and `present` are
available; real SDK read/write implementations are confined to the canonical
temporary workspace, including symlink ancestor checks. Bash and external
plugins are unavailable. Setup/output paths are bounded to that same workspace.

Like `PiManager`, the fixture listens to non-`message_end` session events and uses
a later awaited `session.agent.subscribe` for committed `message_end` events.
The SDK persists the entry before that later subscriber runs. This is necessary
for trajectory records to bind to the real selected branch. Every fixture checks
that current records are captured, user/tool record counts match the committed
transcript, no duplicate historical assistant fallback exists, no capture error
occurred, and every request has context/options/payload/response/output documents.
The golden outcome compares the full transcript, tool execution events,
lifecycle order, delivery projection, actual output file bytes, trajectory
statuses/usage and full request documents. Exact timing durations are excluded;
whether a stream supplied an observed token remains checked.

The retry scenario fails twice before succeeding. After settlement, no record
may remain running, one logical run must own every retry request, each request's
parent/turn identity must resolve to that run, and run usage must equal the sum
of all its request usage. This catches SDK retry starts overwriting the current
run or retry record rather than silently accepting orphaned records as a baseline.
The separate backoff-cancellation scenario aborts after `auto_retry_start`, allows
only one provider call, and requires both the logical run and retry to settle as
cancelled. This covers cancellation while the last provider reply was an error.

Negative tests prove that changing a prompt, a tool schema, a real tool result or
a tool argument fails before the script can quietly continue. Extra calls,
unused recorded calls, payload replacement drift and malformed terminals also
fail explicitly. Additional scenarios can reuse the helpers without a test
framework or model credentials.

## Limits

The committed scenarios exercise one session at a time. They do not cover
parallel subagent binding, compaction, browser/debug adapters, queue admission or
renderer geometry; their existing `check-*.mjs` suites remain necessary. This
fixture format records the public SDK/provider boundary rather than raw HTTP
bytes, and does not validate the implementation of a real vendor adapter or
model quality. Its synthetic recorder is a safe way to establish baselines;
public wrappers can capture an explicitly supplied stream in another harness,
but no command in this feature enables paid API calls.
