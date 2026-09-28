# Native subagents — implementation report

Branch `feature/native-subagents` (based on the `codex/bash-task-status-clarity` WIP snapshot `422316a`).
Design input: the two pi-web implementations (upstream `main`'s built-in subagents and the
`native-subagents` worktree's evolved fork) plus the merged review plan. The engine is a
re-implementation against pi-app's lifecycle, not a port of either codebase.

## What was built

### Main process — `src/main/pi/subagents/`

| File | Role |
|---|---|
| `protocol.ts` | Persistence + wire protocol: `pith_subagent_run` (per-run start, runId + frozen resource snapshot) and `pith_subagent_result` (per-run terminal record) custom entries, the disk reader, and the seq-guarded roster merge. Node-loadable, no Electron imports. |
| `derive.ts` | Pure derivation helpers: input-file loading/validation, inherited-context trimming, written-file extraction (edit patches + synthesized `write` patches, 64 KiB budget). Node-loadable. |
| `errors.ts` | `SubagentError` (tool-visible dispatch failures). |
| `model-spec.ts` | Pure wording for an unresolvable `model:` spec: separates a malformed spec from a missing provider/model, lists what exists (capped) and always offers "omit `model`". |
| `profiles.ts` | Profile store: Markdown + flat frontmatter, scopes `~/.pi/agent/agents/*.md` (global) < `<cwd>/.pi/agents/*.md` (project), four starter profiles written once (marker in `<userData>/subagents/subagent-defaults-v1.json`, never resurrected after deletion). |
| `runtime.ts` | The engine: `SubagentRuntime.start/resume/steer/abort/abortAll/recover`, per-parent `SubagentParentState` (roster + seq + concurrency slots), run tracking with throttled progress, turn limits, background-task drain, status derivation. |
| `notifications.ts` | `SubagentNotifications`: background-completion outbox, a structural mirror of `TaskNotifications` (steer + `triggerTurn`, never followUp; waits for the parent's `agent` toolResult; acknowledges on `message_end`; recovers after queue surgery). |
| `tools.ts` | The `agent` custom tool (`executionMode: 'parallel'`): profile enumeration in its description, foreground wait / background hand-off with guidance text, abort-signal cascade, `pi-app-subagent` result details. |
| `session-filter.ts` | Bounded-head membership test that separates subagent children from forks (both carry `parentSessionPath`) so the sidebar hides only children. |

### Manager integration — `src/main/pi/manager.ts`

- Child sessions are created through `createManagedSession(sessionManager, subagentRole)` — the same registry, disposal, event routing, bash/task ownership and shutdown budget as user sessions; the child carries `subagentChild: { parentPath, toolCeiling }`.
- **Frozen tool ceiling** (the `manager.ts` re-activation trap): dispatch computes `profile.tools ∩ parent active tools − {agent}` and applies it twice — as the `tools:` allowlist at `createAgentSessionFromServices` and as the ONLY `setActiveToolsByName` set in `initializeSession` (the normal path re-activates every built-in + extension tool and is never taken for children).
- Children: own `TodoState`/`ChangeScopes`/`TaskNotifications` (their background bash wakes the child), **no `RewindRecorder`** (children never record checkpoints), no extension loading (v1: `noExtensions` in `servicesFor` — N children would multiply MCP hosts), AGENTS.md inherited via the live `agentsFilesOverride`.
- Normal sessions gain a `SubagentParentState` + `SubagentNotifications`, the `agent` tool (setting-gated, late-bound parent session via a ref holder like bash's `canStart`), and `SUBAGENT_TOOL_NAME` in the active-tool set.
- Stop cascade: `abort()`, `clearQueue(stopping)`, `resendMessage`, `rewindRestore` and `disposeManaged` pause subagent wake delivery and abort the parent's runs suppressed (a stopped or branch-orphaned run cannot wake the session). Rewind admission: every run holds a `CheckoutCoordinator` lease (`acquire(cwd, 'subagent', parentPath)`)), so restores cannot start under live runs. `prompt()` resumes the wake path.
- `snapshotOf` carries `subagents`; roster updates ship as a sequence-free `subagents_update` `pi:event` (the `context_usage` rule); `pollContextUsage` skips non-visible children; `listSessions` hides subagent children; `recover()` rebuilds a parent's roster from disk (interrupted runs surface as cards, never auto-woken).

### IPC / shared surface

`shared/types.ts`: `SubagentRunDTO`, `SubagentWrittenFileDTO`, `SubagentRunStatus`, `SubagentActionPayload`, `SessionSnapshotDTO.subagents`, `AppInfoDTO.subagentsEnabled`. Handlers `subagents:list|action|setEnabled|setMaxConcurrent`; preload `listSubagents`, `subagentAction`, `setSubagentsEnabled`. Settings: `subagentsEnabled` (default on) and `subagentMaxConcurrent` (1–16, default 4).

### Renderer

- `PiStore`: `state.subagents` fed by snapshots and `subagents_update`.
- `SessionTasks` gains a third "Subagents" entry (same overlay geometry, dismiss/Escape rules and capped-list fade as the bash panel); `SubagentView.tsx` renders roster cards (profile · model · elapsed · tokens · tool calls, 1s ticker while running). Open-session is an entry-level link beside every row — visible while collapsed, link-styled (no surface, no frame, no transition), and holding the row's own 36px header line so the shared row rhythm is unchanged — while Stop stays inside the disclosure; opening a child goes through Workspace's `openSession` (a child is a real session and renders as a normal chat).
- `turn-written-files.ts` folds a subagent's `writtenFiles` (from the `agent` tool result details) into the parent turn's changed-files list, merged with direct edit/write.
- `agent` gets an explicit `Bot` glyph in `tool-icons.tsx` (no category entry — it renders standalone); Settings → General gains a bilingual subagents switch; all strings are in `en` + `zh-CN`.

### The three upstream defects — fixed and verified

1. **Stale-completed resume reads**: per-run start/result entries keyed by runId; the session's current state is its LAST start entry (`readDiskSubagentRuns`), so an in-flight/interrupted resume reads `interrupted`, never the previous terminal state.
2. **Errored runs marked completed**: status derivation reads the final assistant message's `stopReason` (`error` → failed) plus abort bookkeeping and the caught prompt exception; `prompt()` resolving is never sufficient.
3. **Late terminal events overwriting newer runs**: every roster DTO carries a per-parent monotonic `seq`; `applyRunToRoster` drops lower-seq writes for the same session.

The check script also caught two additional real bugs during development: parent-context truncation kept the OLDEST material (now drops whole oldest messages under the 50k budget so the newest state survives), and input-file confinement compared a literal cwd against realpath-resolved files (on macOS `/var` → `/private/var` classified every file as outside; the root is now realpath-resolved).

## Verification status

- `npm run typecheck` — clean (main + renderer).
- `npm run build` — clean.
- `node scripts/check-subagents.mjs` — passes: per-run pairing + interrupted reads, malformed-record tolerance, seq guard, written-file extraction (merge/synthesis/budget/cap), context trimming (cap/images/newest-survives), input files (confinement/budget/UTF-8/dedup), profile round-trip + scope shadowing — PLUS runtime integration checks against real SDK `SessionManager` files: persisted records read back through the runtime's own recovery paths, lease lifecycle (held for the run, released at completion), launch cancellation before creation, stopReason-driven failure status, prompt-rejection failure, awaited mid-run abort (suppressed notification, released lease), and `collectSubagentWritePaths` from a real parent branch.
- `node scripts/check-bash-tasks.mjs`, `check-bash-task-ui.mjs` (all six sections), `check-todos.mjs`, `check-transcript-order.mjs` — all pass on this branch (the UI check's startup section was broken on the base WIP; its fixture is fixed here).
- **Not run**: an end-to-end Electron session with real model calls (dispatch → child run → completion → notification → roster UI) and both-theme visual checks of the new panel.

## Round 2 — review fixes (post-`5dca68d`)

A external review of `5dca68d` found eight defects; all are fixed on this branch:

1. **Run records were unreadable by recovery** — `trackRun` persisted `parentSessionId: ''` while the reader requires it non-empty, so every real record was discarded on read-back. The runId is now generated once per start/resume and carried on the child handle; the start entry carries the real parent id; a failed start-entry write fails the dispatch instead of running untracked. Regression-tested by a real `SessionManager` write→reopen round-trip in `check-subagents.mjs`.
2. **The rewind run lease covered only creation** — now two-phase: the creation phase leases the PARENT path, the run phase (model work, background drain, cleanup) leases the CHILD path. The child-keyed lease additionally fences the parent's own checkpoint snapshots while its subagent writes. Children still get no RewindRecorder (no checkpoints by design); execution protection comes from the whole-run lease.
3. **Stop raced the launch and under-stopped children** — `start`/`resume` register an AbortController in the parent's `starting` set BEFORE any await and re-check it before prompt; `abort`/`abortAll` cancel in-flight launches too. Stopping is now complete and awaitable (`stopAll`): each child's halt pauses its TaskNotifications, clears its queues, stops its background bash and aborts the SDK run, bounded by a settle wait. rewindRestore/resend/delete await it before proceeding.
4. **Opening a finished child lost its identity** — any open path (sidebar/search/delete/recover rebuild) now detects subagent run records in the file and restores the frozen role: tool ceiling, append-prompt, model spec and thinking clamp; no RewindRecorder. `createSubagentChildSession` reuses the live managed instance instead of building a second session over the same file.
5. **Child writes were invisible to rewind coverage** — `classifyUncoveredWrites` (extracted in `coverage.ts`) classifies the child-written paths `collectSubagentWritePaths` gathers from the parent branch's successful `agent` calls and the children's persisted records; a rewind now lists them as uncovered/excluded instead of silently skipping them.
6. **Tool-row details never carried the finished files** — foreground results now embed the finished DTO (writtenFiles included); background completions' writtenFiles ride the `subagent_completion` turn notices and fold into the parent turn's changed-files list via `extractTurnWrittenFiles`'s new `completions` input. Written-file extraction reads the child's full persisted branch (compaction-proof).
7. **Model/thinking/turn-limit were not applied** — no explicit model spec resolves to the PARENT's live model spec; request/profile thinking merges into the resource and is clamped to the child model's available levels; frontmatter numbers parse as numbers (`max_turns` works).
8. **Roster staleness across chat switches** — `applySnapshot` always takes the snapshot's roster (no unchanged-cached shortcut for sequence-less data).

Also fixed: `subagentRuntime` became a lazy getter (regression-check mocks via `Object.create(PiManager.prototype)` work again), `taskIsLive` moved to a pure module so the runtime is node-loadable, and the check-bash-task-ui startup fixture was completed for the NewSession context contract (broken on the base WIP, unrelated to subagents).

## Round 3 — second review fixes

Four more P1s and four P2s from the second external review, plus a UX request, all fixed:

1. **Opened children were still promptable** — an opened subagent child is now a genuine read-only view: `prompt`/`resendMessage`/`queueAction` refuse it in main, the snapshot carries `subagentChild`, and the renderer's Composer disables typing and submit for it. (The deeper "separate execution protection" refactor stays future work; the read-only fence closes the bypass today.)
2. **Resume wrote through two session managers** — `createSubagentChildSession` now returns the LIVE AgentSession's own `sessionManager` (a fresh `SessionManager.open` shares the file but not the in-memory tree, splitting the branch), and a live child is reused only while idle (`isStreaming` ⇒ "already running"), serializing resumes.
3. **Failed runs' writes were invisible to coverage** — `collectSubagentWritePaths` now takes EVERY `agent` call after the anchor (the run's outcome never erases file side effects): persisted `writtenFiles` when a terminal record exists, otherwise extraction from the child's committed branch (interrupted/crashed runs included). A named anchor missing from the branch throws instead of silently scanning all history.
4. **Cancellation gaps** — the launch gate re-checks the abort signal inside the completion, immediately before `child.session.prompt` (a stop landing during creation yields an aborted run, never a prompt); the foreground tool signal is wired for the run's WHOLE lifetime (`haltLiveRun` on abort, unwired in the completion's finally); `stopAll` first awaits in-flight launches' cleanup before halting registered runs.
5. **Start-entry write failure leaked the lease** — `trackRun` owns the lease and child until the completion exists; a failed start-entry append releases the lease, halts and releases the child, then rethrows (regression-tested: lease count 0, halt+release each 1).
6. **Coverage passed the wrong checkpoint argument** — `navigation.after` (the entry anchor), not the scope root; combined with #3's anchor-throw this can no longer widen the scan.
7. **Background completions never reached the file pipeline** — `buildTurns` now attaches `subagent_completion` to the running turn as a notice (exactly like `bash_task_completion`), which simultaneously (a) renders it as a quiet tool row (`SubagentCompletionRow`) instead of a conversation card — the requested UX — and (b) feeds `extractTurnWrittenFiles`' completions input (chat list and Review share that single derivation). Delivery dedupe is protocol-aware: run-scoped results (`writtenFilesScope: 'run'`, the current protocol) are keyed by runId — every run contributes its own writes — while legacy cumulative results are keyed by child session, keeping only the latest; both paths share one map so a tool result and a completion of the same run never count twice.
8. **Roster snapshot-vs-event race** — the renderer merges rosters by per-session `seq` in BOTH directions (event over snapshot and snapshot over stale event); disk-recovered rows are stamped with a live seq in `recover()` so they rank correctly.

New regression tests: mid-creation cancellation (no prompt ever, aborted run, clean leases), whole-run signal abort (halt invoked), start-entry write failure cleanup, failed-delegation write diagnosis (isError parent result still yields child paths), and anchor-miss rejection.

## Round 4 — handoff-plan completion (uncommitted working tree)

Finished the interrupted round described in `docs/subagents-round3-handoff.md`. Product changes in this round (beyond what the handoff already had staged):

1. **Branch-owned resume** — `resume` verifies the child's latest run is still owned by the parent's SELECTED branch: an explicit `pith_subagent_dispatch` entry for `parentDispatch` runs, or the `agent` tool result for legacy records. A rewound-away dispatch refuses with a branch-ownership error.
2. **Terminal-persistence failure surfaces** — *(claimed here, but the append was still best-effort when this round was written; the real fix is Round 5 item 1)* a result entry that fails to append no longer reads back as silent success: the run reports `failed` with a could-not-be-persisted reason, the answer text is still delivered for triage, and the un-persisted run's committed writes still count as crash evidence (per-run branch intervals).
3. New/extended tests: mid-creation cancellation via external gate, concurrency rejection owning no launch promises, async cleanup holding its lease, child completion handoff, coordinator busy fencing (withExclusive rejects while a run lease is held — the stop path never smuggles a restore), real-`BashTaskManager` background drain (command exit → steer → woken round → run completion) and Stop silencing the wake path, real-SDK resume putting both user messages on the reloaded selected branch, one managed instance across resumes, per-run write evidence excluding previous resumes, and the failed-delegation `afterToolCall` hook (isError set, details kept, extension hooks chained).

Fixture fixes along the way (test-side, not product): the integration PiManager mock gained a collecting `notifyError` stub (the read-only refusal is asserted, not bypassed); the hook fixture's plain-JSON `parameters` failed `prepareToolCall`'s TypeBox validation (immediate-error path never reaches `afterToolCall`) and its empty `tools: []` allowlist hid the custom tool; the legacy-resume fixture parent now carries the `agent` call/result that pre-dispatch-era sessions always have.

Verification (all run on this tree): typecheck, build, `check-subagents`, `check-subagents-integration` (7 groups), `check-bash-tasks`, `check-bash-task-ui` (6/6), `check-todos`, `check-transcript-order`, `check-rewind-sdk`, `check-session-persistence`, `check-session-lifecycle`, `check-written-file-preview`, `check-rewind-ui`. **A real-model Electron E2E was NOT run.**

## Round 5 — third review fixes (this working tree)

An independent review of the finished Round-4 tree found five defects; all are fixed here, each with a regression test where the behavior is checkable without a model.

1. **A terminal record that could not be written was still reported as success.** Round 4 claimed this was fixed; it was not — `trackRun` swallowed the append failure (`catch { /* best-effort */ }`) and published the derived status. The run now reports `failed` with the persisting reason, keeps its answer text for triage, still notifies the parent, and a fault-injection test (`check-subagents`) asserts both the reported status and that a reopen reads the run as `interrupted`.
2. **`max_turns` had no terminal state.** The marker flag was assigned and never read, the runtime's own abort was indistinguishable from a user Stop, and because the delivery guard tested `status !== 'aborted'`, a background run ended by its turn limit never notified its parent (the parent waited forever, the card read "Stopped"). Status rules now live in the pure `deriveRunOutcome` (`subagents/runtime.ts`): only a user stop is `aborted`, a limit-ended run is `completed` + `limitReached` (new DTO/persisted field, shown in the panel meta and in the foreground tool payload), and the delivery guard reads `live.userAborted` instead of the status.
3. **Roster payloads carried 64 KiB diff bodies into every progress tick.** `slimRunForRoster` (`protocol.ts`) strips `writtenFiles[].patch` on both the publish and the recover path; the full row still rides the `agent` tool result and the `subagent_completion` notice — the two payloads the changed-files list and rewind coverage read — so the panel loses nothing.
4. **A deleted child file made every rewind preview of the session fail.** `collectSubagentWritePaths` threw for any missing candidate file, which surfaced as a `storage` rewind error before any diff could be shown. It now reads the PARENT branch's own records first (the `agent` tool result's and the `subagent_completion` notice's `writtenFiles`, which survive a deleted child) and skips an unreadable child instead of failing; the anchor-miss integrity error is unchanged, and a test covers both the readable and the degraded scan.
5. **Smaller fixes.** `recover()` yields to the event loop between children (it opened every child session file synchronously in one microtask); the read-only child composer refuses pasted/dropped/picked attachments instead of only blocking the send; numeric frontmatter scalars no longer drop a profile (`description: 42`); the leftover `probe-hook-tmp.mjs` scratch file is gone.

Documentation: AGENTS.md now states the restore/busy contract precisely (a live run lease refuses the restore's exclusive window before the callback, so the `stopAll` inside `rewindRestore` is defense in depth and the user-facing escape is the Subagents panel's Stop or waiting for the run) and the roster/evidence rules above.

Verification (this tree): `npm run typecheck`, `npm run build`, `node scripts/check-subagents.mjs` (now also covering `deriveRunOutcome`, roster slimming, the persisted `limitReached` marker, the bounded-head session marker and the evidence degradation), `node scripts/check-subagents-integration.mjs` (7/7), `node scripts/check-bash-tasks.mjs`, `node scripts/check-bash-task-ui.mjs`, `node scripts/check-todos.mjs`, `node scripts/check-transcript-order.mjs`, `node scripts/check-rewind-sdk.mjs`, `node scripts/check-session-persistence.mjs`, `node scripts/check-session-lifecycle.mjs`, `node scripts/check-written-file-preview.mjs`. **A real-model Electron E2E was still NOT run.**

## Round 6 — hands-on fixes (this working tree)

A hands-on pass drove the real app (isolated HOME/userData + a scratch workspace, real `deepseek-v4.1-flash`, CDP-driven UI) through seven scenarios: foreground delegation, parallel background runs, an implementer writing files, mid-run Stop, opening the child view, the error paths, and a rewind preview over child writes. The engine held up (see verification below); the pass produced three product problems, all fixed here.

### P1 — pi-web's `tool_preset` profiles were silently full-access (safety)
`~/.pi/agent/agents/*.md` is written by pi-web, which declares its tool set ONLY as a preset (`tool_preset: piweb-agent-explore`) with no `tools:` field. This app parsed neither and defaulted `tools` to `all`, so a profile named `explore` had write/bash access — reproduced live: a delegation to `piweb-explore` created `src/e.ts`, and the parent model itself noted that a read-only profile had performed a write. Tool sets now resolve as: explicit `tools:` → `tool_preset` read from pi-web's own shared `pi-web-tool-presets.json` (`allow` selections only) → conservative read-only default. An unresolvable preset (unknown id, `deny` selection, missing file) is read-only plus a warning, never `all`; a profile that omits `tools:` entirely is least privilege too, and the `agent` tool description states which reason applied.

### P2 — a marker without its files left the app with ZERO profiles
The "written once" marker lived in app userData while the profiles live in the agent dir, so a fresh HOME (or any drift) meant `ensureDefaultProfiles` returned early: the `agent` tool stayed enabled, its description said "no enabled profiles", and every dispatch failed with `Unknown or disabled subagent profile`. The marker is now written BESIDE the files it guards (`<agentDir>/agents/.pi-app-defaults-v1.json`, legacy marker kept) and an empty agent dir heals — while a marker beside an empty directory means a deliberate removal and is respected, and pruning one starter still never resurrects it.

### P3 — feel: five small things the screenshots made obvious
1. **Duplicated status**: the card/completion-row meta added a localized status next to the vendored row's own English one (`已完成Completed`, `Cancelled | 已停止`). The localized word is gone except for `interrupted`, which the vendored vocabulary cannot express.
2. **A read-only child with no explanation**: the composer was disabled with nothing telling the user why or where to continue. The snapshot now carries `subagentParentPath`, and an opened child shows a read-only banner with an "open parent session" action.
3. **A stopped round rendered as a red 错误 row** in the child view (the SDK reports aborts through `errorMessage`). `aborted` rounds now read as a neutral `chat.aborted` disclosure.
4. **The `agent` tool row said only `agent`/live**: it now names the profile and the task (`委派 · explore · summarize two modules`) and tags background runs, so concurrent delegations are distinguishable in the transcript, not only in the panel.
5. **Cards carried no time and no access hint**: the DTO now carries the run's frozen `tools` ceiling, and a card shows a read-only tag plus its creation time.

Not changed (deliberate): the panel remains a session-wide, chronological list rather than grouping cards by turn — the roster has no turn identity beyond `parentToolCallId`, and grouping is a design decision worth making together with the missing `get_subagent_result`/steer tools.

### Verification (this tree)
`npm run typecheck`, `npm run build`, `node scripts/check-subagents.mjs` (new assertions: preset resolution, `deny`/unknown presets → read-only, bare `tools:`-less profiles → read-only, the description's reason strings, and the four `ensureDefaultProfiles` cases), `node scripts/check-subagents-integration.mjs`, `node scripts/check-bash-tasks.mjs`, `node scripts/check-todos.mjs`, `node scripts/check-transcript-order.mjs`, `node scripts/check-bash-task-ui.mjs` (6/6) and `node scripts/check-written-file-preview.mjs`.

A second hands-on pass in the real app (same isolated environment, profile files deliberately emptied first) re-verified every fix: the drift healed at boot (4 starters + the marker beside them), a `piweb-explore` delegation reported `find/grep/ls/read` and could NOT create the file it was asked to write (previously it did), the panel card read `只读 · 后台 · 0 秒 · 12:53`, the transcript row read `委派 · explore · check tool row` / `委派 · explore · bg row tag | 后台`, the child view showed the read-only banner with its "open parent session" action, a stopped round rendered as a muted `已停止` instead of a red 错误, and the expanded card no longer repeated the localized status next to the vendored one.

### The unknown-model message (found in real use)
A parent model reported `Unknown subagent model "totally-fake-provider/does-not-exist-model-xyz" (expected "provider/modelId")` for a **well-formed** spec: the parenthetical named a syntax problem that did not exist, so the model (correctly) reasoned about its own syntax instead of the real cause. Wording now lives in the pure, script-checked `model-spec.ts`: a malformed spec keeps the `expected "provider/modelId"` hint, an unknown **provider** says the spec is well-formed and lists the configured providers, and an unknown **model** names the provider and lists its models (both capped at 12 with `…`). Every case ends with `Omit "model" to inherit the parent session's model.` The rejection itself is unchanged — it still happens in preflight, before any child session exists.

## Round 7 — a delegation opens beside the chat (this working tree)

Reported from real use: clicking a card's "open session" replaced the visible conversation with the child and left it there, so a glance at "what did it actually do" cost the user their place in the parent.

What changed:

- **`peekSession(path)`** (main + `pi:peekSession` + preload): one session's transcript WITHOUT activating it. A managed child returns `snapshotOf(managed)`; an unmanaged one is read from its file through `buildContextEntries()` (compaction-aware, same transcript the chat would show) with no AgentSession, extensions, task owner or notifications built for the view.
- **Rail tab `agent:<child path>`** (`SidebarPanel` + `agentTabId`/`agentPathForTab`, mirroring the `file:` tabs) with a Bot icon and a label taken from the roster (falling back to a generic "subagent session" name). `Workspace`'s `openSidePanelTabId` reveals the rail for it, and the delegation card's action now calls it instead of `openSession`.
- **`SubagentSessionPane`**: owns a `PiStore`, applies the peeked snapshot, dispatches the child's committed events (streaming deltas are withheld from non-visible sessions by design, so rows appear per finished message while the roster supplies live status/tokens), and renders the app's own `ChatView`. `ChatView`'s session-level callbacks became optional so a read-only view can omit them; the pane offers the full read-only session view via its own "open in chat" action.

Bugs found and fixed while verifying it in the app (both caught only because the pass drove the real UI):

1. **A throw in the rail tab strip unmounted the entire UI** — the strip resolved every tab id through the fixed-kind registry, so the first `agent:<path>` tab threw `Unknown sidebar tab` and React removed the whole tree (blank window; only a reload recovered). Path-keyed tabs now resolve their own label/icon before that lookup. Worth remembering: there is no error boundary between a rail tab and the app.
2. A JSX tag name cannot carry a non-null assertion (`<spec!.icon/>`), which the typecheck caught immediately — the icon component is bound to a variable instead.
3. **The pane could not scroll** (reported from use): the pane handed `ChatView` a plain block wrapper, so `MessageScroller`'s `flex-1` did nothing and its inner `h-full` viewport resolved to `auto` — a 1436px transcript sat clipped inside a 734px pane, and the app-wide invisible-scrollbar rule hides the bar that would have hinted at it. The wrapper is now a flex column; measured after the fix: the pane's scroller has `clientHeight 734` / `scrollHeight 1436`, `scrollTop` moves, and an injected 2000px block grows only `scrollHeight`.

### Verification (this tree)
`npm run typecheck`, `npm run build`, and a hands-on pass in the isolated real app (real model, CDP-driven): after a delegation completes, clicking the card's action opens the rail with exactly one `agent:` tab — the pane shows the child's own transcript (its prompt, its reasoning fold and answer) and its header reads the roster row (`pane verify | explore · deepseek/deepseek-flash · 已完成 · 5533 tokens · 2 次工具调用`) — while the main chat stays on the parent session (its own transcript untouched). Clicking the action repeatedly keeps ONE tab (no accumulation), and the pane's "open in chat" action navigates the main chat to the read-only child view as expected (the read-only banner appears). No renderer exceptions during the pass.

## Round 8 — human Guide / Continue control from the roster

The runtime and typed `subagents:action` IPC already supported Steer, Stop and Resume, but the roster exposed only Stop and open-session. The parent-session task panel now completes that human control loop:

- An expanded `running` card shows **Guide** beside Stop; every terminal card (`completed`, `failed`, `aborted`, `interrupted`) shows **Continue**.
- Both actions use one app-level beUI `SubagentActionDialog` with a multiline instruction, initial focus, focus trap, Escape/Cancel and Cmd/Ctrl+Enter submission. Pending submission disables dismissal and duplicate activation; a failed IPC keeps the draft and shows only the renderer's localized error.
- The dialog pins the opening `{sessionId, runId, action}` and resolves the latest row from the roster. If status or run identity changes, submission becomes stale and stays disabled without silently changing Guide into Continue.
- Renderer freshness is not trusted as the concurrency boundary: every panel payload carries `expectedRunId`, and main/runtime atomically compare it with the live/roster/disk run before Steer, Stop or Resume. A lagging renderer therefore cannot send an old action to a replacement run.
- Successful actions never mutate the roster optimistically. `SubagentRuntime` remains authoritative through `subagents_update`, including branch ownership, concurrency, Plan/tool-ceiling and persistence checks.
- Human control is deliberately independent of `subagentReuseEnabled` and `subagentCommsEnabled`: those settings decide what the parent model may initiate, not what the user may request from the roster.

Regression coverage lives in `check-bash-task-ui.mjs` (action availability, focus/keyboard, real pointer/Escape ownership across the portalled dialog, exact payloads, pending dedupe, localized failure, stale-state fencing, both locales and no optimistic status) and `check-subagents-integration.mjs` (typed manager routing, atomic `expectedRunId` rejection against live and resumed runs, serial Resume and branch/ceiling ownership).

## User-owned turn limits

Settings → Subagents owns `subagentMaxTurns` (1–200, blank/null means unlimited) and `subagentTurnLimitOverrideEnabled` (default off). Each new dispatch or continuation uses the user setting. Profile `max_turns` remains parseable as legacy file metadata but no longer supplies a runtime default.

Only an explicit override grant exposes `max_turns` in the parent model's `agent` schema. With the grant on, a supplied argument replaces the user default for that run; omitting it uses the user setting. With the grant off, stale or fabricated arguments are ignored in both the tool adapter and runtime. The runtime resolves the policy after asynchronous child creation and lease acquisition, before persisting its run record, so revocation during launch also reaches held calls. Continuations recompute this policy instead of inheriting an old run's override. Existing active runs keep their resolved limit.

Permission changes reload live sessions to refresh their tool schemas. User settings persist in app settings, and every run persists its effective limit in the existing resource snapshot. The established round-counting behavior remains: reaching the limit requests a wrap-up; another assistant round triggers the runtime's limit completion path.

Checks: `check-subagents.mjs` covers schema visibility, discarded overrides, user defaults and persisted continuation limits; `check-subagents-integration.mjs` covers settings persistence/validation and revocation during asynchronous launch; `check-subagent-settings.mjs` covers the beUI controls, clearing/clamping, save failures and both locales.

## Editable role defaults

Each role's detail offers **Edit defaults** for model, thinking level, inherited parent context and background execution. The two-column beUI editor saves only those four frontmatter keys, preserving the prompt, tools, custom metadata and line endings. Clearing model/thinking removes their keys; saving unchanged parser defaults does not introduce boolean choices. Missing values retain the previous behavior. Main accepts only currently listed profile paths and re-parses the edit before writing.

Explicit parent arguments override these role defaults, including `run_in_background: false` overriding a background role. Model-driven continuation uses the current role's background default when the argument is omitted; human continuation keeps its stored mode. Model, thinking and context otherwise keep the existing continuation contract. Role-specific turn-limit controls are absent: the app-wide user limit and its explicit parent override grant are the sole runtime turn policy, and any legacy profile `max_turns` remains untouched but ignored.

Checks cover surgical persistence and invalid-input rejection, current-profile admission, the four dispatch overrides, clearing defaults, save failure/retry, two-column form geometry and both locales.

## Not implemented (honest gaps)

1. **Result polling**: there is no standalone `get_subagent_result`. The parent model can wait in the foreground, receive the background completion notification, or use `agent_steer` while a child is running; the user can Guide/Continue from the roster.
2. **Restart recovery wakeups**: interrupted background runs display as `interrupted` cards and are never re-dispatched automatically (a deliberate v1 choice).
3. **The rail's child pane is read-only by design**: it has no composer and omits session-level actions (resend/edit/fork); changed files have no Review action because the rail's review pane is bound to the visible parent store. Guide/Continue belongs to the roster card, and a finished child's task strip is not reconstructed from its file.
4. **Worktree isolation**: all subagents share the parent's working tree; concurrent writers can collide. There is no per-subagent worktree, merge flow or cross-worktree rewind semantics.
5. **Rewind depth**: child-written files are display-merged into the parent turn but are not part of the parent's CAS capture. Rewind lists them as uncovered paths requiring explicit consent and restores through the generic transaction engine. A deleted child file whose interrupted run never wrote a terminal payload can leave writes that are no longer nameable; diagnostics degrade instead of blocking rewind.
6. **Per-child context ring / live transcript overlay**: a non-visible child emits no renderer stream; progress is roster-only. Opening a child shows its committed transcript.
7. **Search filtering**: child files are real sessions and remain indexed; there is no preference to hide subagent sessions from search.
8. **Real-model Electron E2E**: deterministic Node/Electron regressions cover the shared paths, while `check-subagent-e2e.mjs` remains a manual, credentialed and potentially paid check.

## Follow-ups (recommended order)

1. Extend the manual real-model E2E to exercise Guide while running and Continue after completion.
2. Add bounded `get_subagent_result` polling if model workflows still need it after completion notifications.
3. Add subagent-aware rewind provenance instead of classifying child writes as uncovered.
4. Design optional worktree isolation and its merge/rewind semantics.
