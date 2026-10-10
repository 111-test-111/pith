# Explicit delivery and execution diagnostics

## Delivery

`present` declares 1–8 current file references; it resolves against session cwd, verifies regular files, rejects missing/directories/final symlinks and deduplicates canonical paths. It checks admission/cancellation around asynchronous work and does not read/copy/change content. It is outside Plan's ceiling.

Only a successful matching result with validated `pith-present-v1` details creates delivery cards. Cards appear at the settled change scope's final group and reconstruct from the selected branch on reopen/compaction/fork/Rewind. A child cannot deliver for the parent: the parent presents the file itself. Preview uses the file pane, Open the OS handler and Save As the native full-file copy route. References are not immutable snapshots.

Generated `image` receipts receive app-stamped display metadata. Bottom delivery galleries reuse the image tool's pure-media view, with floating information and retry/cancel actions; the `present` tool's own disclosure keeps its original text result. Ordinary images keep the existing file cards. Exact replay parameters and UI execution receipts persist as private SDK custom entries; replays make no model request or conversation message. Standalone usage, Library extraction and Rewind coverage retain their billing and successful file effects. See [image generation](image-generation.md#generated-image-delivery-and-private-replay) for admission, persistence and renderer behavior.

## Capture boundary and durability

`TrajectoryRecorder` wraps public `agent.streamFunction` inside the Plan/image/budget transforms. It records the transformed request, serializable public Tool fields, safe options, actual provider payload after the caller's replacement callback, selected response headers and finalized assistant output/usage. It never serializes handlers, authentication or cookies. Known credential fields are redacted.

Stream events pass through unchanged without retained deltas. First-output timing requires an actual nonempty text/thinking/tool-argument delta; result-only consumers have no invented first-output metric. Output rate uses reported tokens and recorded times, not inferred provider internals.

One logical run survives retry/compaction starts until `agent_settled`; each request/retry attempt settles separately. Tool records include actual arguments/output. Message linkage uses a later awaited agent subscription after persistence. Captured assistant output is not duplicated as historical fallback.

A lazy worker owns `trajectory.sqlite` (0600), WAL, hashing and immutable SHA-256 JSON nodes. Repeated data is deduplicated. Diagnostics stay outside model history and transcript state. Capture failure does not fail execution, but is marked incomplete; worker failure backs off and restart marks unfinished records interrupted.

Bounded [context statistics](context-statistics-implementation.md) share this request capture and durability boundary. The context pane reads only metadata through a dedicated selected-branch query; ordinary trajectory pages omit composition data and keep request bodies lazy.

## Branches and resource bounds

The worker incrementally indexes complete JSONL lines and ancestry. Main supplies the live leaf, not full logs. Selected-branch queries include compacted ancestry and fork parent captures. Rewound-away records cannot authorize body/export reads. Each node read checks record access and the full direct ancestry trail.

Historical messages load only when inspection opens and explicitly lack uncaptured provider payload/timing. Retention does not silently evict old captures, though malformed/oversized inputs may leave incomplete records.

- One worker, at most eight posted jobs with FIFO backpressure; indexing/export yields to capture work.
- Worker heap limits are 96/16 MiB old/young generations; these do not bound total process RSS. SQLite uses a 4-MiB page cache and no mmap/decoded-document cache.
- Pages expose at most 80 records; inspector fragments at most 40 fields or 16,384 Unicode codepoints and 96 ancestry levels. Full bodies never cross IPC.
- Search/capture notifications are coalesced; mounted UI reads at most once per second with one in-flight page. Hidden/unmounted panes release subscriptions.
- Native export walks immutable nodes into the chosen file in bounded chunks without rebuilding a whole request in main/renderer memory.

The pane contains a record list and detail inspector below its filters. Geometry follows [sidebar layout](sidebar-pane-layout.md); tool-call links follow [wheel gestures](wheel-gestures.md).

## Verification

```sh
node scripts/check-present-trajectory.mjs
node scripts/check-present-trajectory-ui.mjs
node scripts/check-session-replay.mjs
```

Checks cover real SDK persistence/callbacks, delivery, secrets, Unicode paging/export, branch/fork authorization, interruption and capture during export. UI checks require a build and use real preload/IPC/SQLite with isolated sessions.
