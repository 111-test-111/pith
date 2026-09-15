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
- Stop cascade: `abort()`, `clearQueue(stopping)`, `resendMessage`, `rewindRestore` and `disposeManaged` pause subagent wake delivery and abort the parent's runs suppressed (a stopped or branch-orphaned run cannot wake the session). Rewind admission: every run holds a `CheckoutCoordinator` lease (`acquire(cwd, 'run', parentPath)`), so restores cannot start under live runs. `prompt()` resumes the wake path.
- `snapshotOf` carries `subagents`; roster updates ship as a sequence-free `subagents_update` `pi:event` (the `context_usage` rule); `pollContextUsage` skips non-visible children; `listSessions` hides subagent children; `recover()` rebuilds a parent's roster from disk (interrupted runs surface as cards, never auto-woken).

### IPC / shared surface

`shared/types.ts`: `SubagentRunDTO`, `SubagentWrittenFileDTO`, `SubagentRunStatus`, `SubagentActionPayload`, `SessionSnapshotDTO.subagents`, `AppInfoDTO.subagentsEnabled`. Handlers `subagents:list|action|setEnabled|setMaxConcurrent`; preload `listSubagents`, `subagentAction`, `setSubagentsEnabled`. Settings: `subagentsEnabled` (default on) and `subagentMaxConcurrent` (1–16, default 4).

### Renderer

- `PiStore`: `state.subagents` fed by snapshots and `subagents_update`.
- `SessionTasks` gains a third "Subagents" entry (same overlay geometry, dismiss/Escape rules and capped-list fade as the bash panel); `SubagentView.tsx` renders roster cards (profile · model · elapsed · tokens · tool calls, 1s ticker while running) with Stop and open-session actions; opening a child goes through Workspace's `openSession` (a child is a real session and renders as a normal chat).
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
- `node scripts/check-subagents.mjs` — passes: per-run pairing + interrupted reads, malformed-record tolerance, seq guard, written-file extraction (merge/synthesis/budget/cap), context trimming (cap/images/newest-survives), input files (confinement/budget/UTF-8/dedup), profile round-trip + scope shadowing.
- **Not run**: an end-to-end Electron session with real model calls (dispatch → child run → completion → notification → roster UI), the existing UI regression scripts (`check-bash-task-ui`, `check-todos`, `check-transcript-order`…), and both-theme visual checks. The engine paths above are verified only by types and pure-logic checks.

## Not implemented (honest gaps)

1. **Model-facing companion tools**: no `get_subagent_result` / `steer_subagent`. The parent model's only paths are the foreground wait, the background completion notification, and the user's panel. (Both pi-web versions ship these.)
2. **Panel resume/steer UI**: the runtime/IPC support resume and steer (`subagents:action`), but the cards expose only Stop and open-session. Resume needs a message input (or a confirmation with an editable draft) — deferred.
3. **Restart recovery wakeups**: interrupted background runs display as `interrupted` cards and are never re-dispatched automatically (both a deliberate v1 choice and a gap vs the worktree's recovery injection).
4. **Extensions in children**: children never load extensions (`noExtensions`). A profile cannot opt in. MCP tool delegation is impossible in v1.
5. **Profile management UI**: profiles are files only (no Settings editor, no per-profile tool picker). The tool description enumerates them; edits apply to sessions created afterwards (a reload re-reads the list only at session build).
6. **Worktree isolation**: all subagents share the parent's working tree; concurrent writers can collide (the tool guidance asks for file-scoped delegation instead). No per-subagent worktree, merge flow or cross-worktree rewind semantics.
7. **Rewind depth**: child-written files are display-merged into the parent turn but are NOT part of the parent's CAS coverage — a rewind lists them as uncovered paths requiring explicit consent, and restoring them relies on the generic transaction engine, not subagent-aware snapshots. `RewindRecorder` is intentionally absent on children (no checkpoints in child files).
8. **Per-child context ring / transcript stream**: a non-visible child emits no renderer stream; its progress is roster-only. Opening a child session shows its committed transcript (no live streaming overlay integration was verified).
9. **Search**: subagent child files remain fully indexed in session search (deliberate: they are real sessions; but there is no "hide subagent sessions" preference like the worktree's).
10. **E2E/regression scripts**: no `check-subagents-ui.mjs`; the shared-path scripts (bash task UI, todos, transcript order) were not re-run on this branch.

## Follow-ups (recommended order)

1. E2E script with a real model: foreground delegation, background + notification, stop cascade, resume, restart recovery reads.
2. `get_subagent_result` with bounded `wait_ms` + `steer_subagent`; panel resume/steer UI.
3. Opt-in extension loading for children (cost-bounded), profile editor in Settings.
4. Subagent-aware rewind coverage (record child writes into the parent's scope root as a distinct provenance class instead of uncovered-path warnings).
