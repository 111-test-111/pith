# Explicit delivery and execution diagnostics

`present` is an app-owned tool with 1–8 file references per call. It resolves relative paths against the session cwd, verifies regular files, rejects directories/missing files/final symlinks, reads size metadata and deduplicates canonical paths. Admission and cancellation are checked before and after asynchronous work. It does not read, copy or change file contents and remains outside the Plan tool ceiling.

Only a successful matching `present` call/tool result declares delivery. Its typed `pith-present-v1` details live in the ordinary SDK session log. The renderer validates these details (including POSIX, Windows drive and UNC absolute paths) and composes beUI file cards at the settled change scope's final group, so steering cannot duplicate intermediate cards. Reopening, compaction, fork and rewind use the selected transcript/scope. Shell-created files work without synthesizing a write result. Child delivery is separate: the parent must present a child's file itself. The filename is plain text; the card's bottom-right Preview button opens the existing sidebar file navigator. Open uses the system handler, and Save As uses the existing native full-file copy route. Files are current references, not immutable snapshots.

## Capture boundary and durability

`TrajectoryRecorder` wraps the SDK's public `agent.streamFunction`, inside the Plan system-prompt overlay. The stream sees transformed SDK context; recorded tools project the public `name`, `description`, `parameters` and optional `constrainedSampling` fields, excluding execution closures so worker structured cloning retains the context and options; the recorder delegates the original `onPayload` before saving its final replacement. Each payload attempt has its own request record, linked together to the committed assistant entry for branch filtering. `onResponse` records status and a bounded family of diagnostic headers (request IDs, rate limits, content type, server timing and retry-after); credentials and cookies are not captured. Output is the SDK's final assistant message, including reasoning/tool calls, usage and stop reason. This is not a network packet capture: retries or headers a provider never exposes cannot be invented.

The wrapper forwards stream events unchanged and does not retain deltas. The first nonempty text/thinking/tool-argument delta supplies the first-output time; `.result()` consumers without deltas have no first-output metric. Durations use the recorded start/end; output rate uses reported output tokens over the interval from first output to completion. SDK options include effective public timeout/transport/retry defaults; provider-specific normalized options remain inspectable in the actual payload. Authentication and ambient options are excluded. Known credential property names are redacted recursively in diagnostic bodies.

Run completion follows `agent_settled`, including continuations. Cancellation follows the captured run signal even when the final message is a tool result. Tool execution records contain actual start arguments, returned data and committed results. User/assistant/tool/custom message linkage happens in a separate awaited agent subscription after SDK persistence. Captured assistant replies occupy their request record and are not duplicated as historical messages. Compaction/retry events have separate records; runs aggregate reported request usage.

The app profile owns `trajectory.sqlite` (mode 0600). SQLite WAL and hashing run in a lazy worker. Unchanged prompts, schemas, messages and image data share SHA-256-addressed immutable JSON nodes. Request records only reference document roots. Diagnostics stay outside model history, SDK events and transcript state. A storage failure does not fail agent execution; a later successful metadata write flags incomplete capture. Worker failure backs off for 30 seconds. A restart marks unfinished records interrupted.

## Branches and historical sessions

The worker incrementally scans complete JSONL lines by byte offset (LF/CRLF and partial appends) and stores only entry parent links and historical messages in SQLite. Main sends the live leaf ID, not the complete branch or log. Recursive indexed queries follow the full selected branch, including compacted ancestors. Cold reads use the persisted tail leaf. Forks can reuse captures from their recorded parent session without duplicating reconstructed entries. Rewound-away records cannot authorize body reads/exports on the current branch. Every node request verifies both record access and every direct ancestry edge.

Older messages are reconstructed only when the inspector opens. They explicitly lack original provider payloads and execution timing. Diagnostic content is retained in the app profile; no automatic history eviction silently removes requests. Very large or malformed data exceeding worker/schema limits can leave an explicitly incomplete capture.

## Resource bounds

- One lazy worker, no idle polling, no stream-chunk writes. V8 limits are 96 MiB old generation / 16 MiB young generation; these are heap limits, not a total process RSS guarantee.
- At most eight posted jobs, FIFO admission and producer backpressure. Long JSONL indexing yields every 16 entries; exports yield at bounded field/text chunks and admit capture writes before continuing. No second worker/SQLite connection is needed for export.
- SQLite page cache: 4 MiB, mmap disabled; at most 48 reusable prepared statements. The worker keeps no decoded document cache or resident session logs. Historical JSONL lines over 16 MiB retain only their bounded SDK envelope/ancestry; complete bodies are available when they were captured live.
- Timeline: 80 summaries per page, chronological time/sequence cursors, metadata search and filters. Both ledger and timing overview have bounded DOMs. Switching/folding the pane unmounts its subscriptions, including when the browser keeps the rail alive.
- Inspector: one selected record, 40 fields or 16,384 Unicode characters per fragment, at most 96 ancestry levels, with bounded field-name previews. Full bodies never cross IPC. Text uses plain preformatted rendering, without Markdown/highlighter work over raw request data.
- Capture notifications coalesce at 250 ms; mounted UI refreshes at most once per second from notifications, with one in-flight page read. Search debounces 250 ms. File statistics and request statistics do not subscribe to streaming text.
- Export walks immutable disk nodes and writes bounded fragments directly to the chosen native path. It does not reconstruct a request in main/renderer memory.

## Verification

Run `npm run typecheck && npm run build`, then:

```sh
node scripts/check-present-trajectory.mjs
node scripts/check-present-trajectory-ui.mjs
```

The offline tests cover file validation/admission, successful delivery projection, real SDK persistence and callbacks, Unicode fragment/export fidelity, credentials, pagination, branch isolation/fork inheritance, interrupted recovery, FIFO settlement under pressure and capture during export. The UI check uses real Electron, the built preload, IPC, PiManager and SQLite worker over 120 SDK turns; it checks bounded rows/fields, page/search actions, both corner presets, both languages, exact paths and native export/cancellation. `PI_TRAJECTORY_SCREENSHOT` optionally retains a UI screenshot.

The storage stress fixture repeats a request with approximately 3 MB of Unicode content 500 times. On the development machine it takes about 5 seconds, stores about 7.2 MiB including WAL, and adds approximately 66 MiB to the test process RSS (including its export/reconstruction assertions). The actual worker separately processes 120 large structured clones under its configured heap/queue limits. These are reproducible fixture measurements, not a universal production memory ceiling.
