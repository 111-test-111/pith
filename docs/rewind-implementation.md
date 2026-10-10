# Rewind implementation

Rewind captures a checkpoint immediately before each user turn. `recorder.ts` awaits the SDK `message_start` barrier, then binds the checkpoint to the persisted user entry at `message_end`. Tools, open/resume and background completions never create checkpoints. Disabling checkpoints stops new capture without removing existing history.

## Restore contract

Previews describe **current → saved** state. Conversation-only restore selects the complete SDK branch and restores its Todo/change projections. Files mode restores raw working files and Git staging; combined mode coordinates both with compensation. HEAD does not move. Single-file restore extracts an immutable child plan from the reviewed preview and preserves raw staging and conversation; main and worker independently enforce files mode.

A preview token binds session, target, branch/leaf and disk identities and expires after 15 minutes. Execution rechecks all inputs; changed state requires a new reviewed preview. A force confirmation permits replacing the displayed modifications, never bypasses corruption, exclusions, active work or unresolved recovery. Overwrite and partial-restore dialogs default to Cancel and retain the parent diff/scroll/focus state.

Only the latest checkout operation supports Undo/Redo, persisted across restart. It affects the original operation's paths; later same-path changes require another review and overwrite confirmation. Unrelated later files are preserved.

## Raw-byte transaction

`src/main/rewind/engine.ts` stores SHA-256 CAS independent of Git filters and newline normalization: working bytes, symlink targets, POSIX mode, raw index/split-index dependencies and staged-only objects.

Before mutation, verify content and identities, fsync backups and checksummed journal/recovery marker, then quarantine preimages on the same filesystem. Publish with no-replace operations, remove directories only when empty, and verify journal phases. Do not replace this with Git add/checkout/reset or recursive deletion. Owned `index.lock` protects raw index restoration; missing staged-only blobs are restored from their saved bytes.

Conversation selection appends/fsyncs `pith_rewind_selection` before commitment. The sidebar reads selected-branch facts from the file tail. If a response is lost, consult the persisted transaction result rather than undoing only one half.

`CheckoutCoordinator` fences snapshots/restores against session/tool/process/subagent/terminal lifetimes. Unresolved recovery blocks external extension evaluation at startup. A terminal-host loss cannot prove commands ended, so restoration remains fenced for that app lifetime. Independent processes may still race; ambiguous preimages are retained in quarantine and reported as recovery conflicts.

## Coverage and limits

`coverage.ts` diagnoses successful committed `edit`/`write` paths and validated `image` file receipts from the complete selected branch, including recorded nested writes. Child paths are collected from parent terminal records or readable child branches and classified under the same workspace/exclusion rules. Successful writes remain evidence even when an outer script or child run fails. Never infer bash writes from prose or reconstruct missing originals from tool output.

Known outside-workspace or excluded writes are listed explicitly. Partial restore requires consent to the main-owned skip list; persist paths/reasons in the transaction and Undo/Redo history. Neither skipped files, ancestors nor intersecting index entries may be touched. Conversation-only and independent single-file actions do not authorize skipping unrelated paths.

UI image retries retain validated committed files in private `pith_image_replay_v1` branch entries. Coverage consumes settled receipts (including partial successes), never queued destinations or error text. The main-owned retry holds a checkout tool lease through provider wait/save/receipt persistence and remains cancellable during teardown.

Exclusions include ignored/dependency/build paths, oversized or dense untracked content, submodules, hardlinks and special files. Ordinary tracked files are not excluded by untracked-size thresholds. Unsaved buffers, external services, ACL/xattrs/ownership/timestamps and arbitrary outside-workspace effects are not restored. App coordination is not a system-wide atomic filesystem lock.

## Storage and UI bounds

`<userData>/rewind` is a backup store, not an encrypted vault. Worker-owned filesystem/hash/diff operations use CAS deduplication and bounded caches. Keep 50 checkpoints per session, 100 full terminal transactions per checkout, unfinished transactions, and bounded idempotence records. At most 24 previews expire after 15 minutes; unreferenced CAS maintenance has a 24-hour grace period.

Review and Rewind share `ReviewDiff.tsx`. Headers/counts load independently from capped patch text; totals include all preview files/stages and binary counts. A fixed toolbar stays outside the scrollport. Restoration mode changes execution scope, not preview visibility.

IPC prioritizes visible bodies, header statistics, adjacent prefetch, then totals in batches up to 16. The shared body cache is 64 entries / roughly 8 MiB; collapsed entries can reopen synchronously while retained. Large diff rows are windowed; remote bodies are not parsed/mounted. Nested confirmations keep the parent mounted, suspend its trap and share scroll locking.

## Verification

```sh
node scripts/check-rewind.mjs
node scripts/check-rewind-sdk.mjs
node scripts/check-rewind-ui.mjs
node scripts/check-rewind-preview-cache.mjs
node scripts/check-rewind-performance.mjs
```

Checks use temporary workspaces and cover raw bytes/index stages, failure injection, crashes/journal recovery, races, branch/lease lifecycle, missing coverage, partial/single-file restore, Undo/Redo, full statistics and bounded UI caches. UI checks require a build. Performance output is generated on demand with `PI_REWIND_PERF_OUTPUT`; historical machine-specific reports are not repository baselines. Also run affected file preview, terminal, bash, Todo, persistence and extension-startup checks.
