# Plan Mode implementation

Plan Mode constrains managed model tools to local file investigation, stores a complete versioned Markdown plan in the conversation, and starts implementation in the same session only after the user approves a specific submission. The composer offers Normal / Plan; an exact `/plan` toggles without sending a message. Arguments make it ordinary text; attachments on the toggle are rejected without clearing the draft.

The plan card remains outside the tool/thinking fold even when the assistant sends no final prose. Revise focuses the composer without sending. Once feedback is sent, the previous submission becomes ineligible for execution and the card shows that a revised plan is pending; only a complete new `submit_plan` result ends that state. The model receives the previous document as reference data for the revision. Jev's implementation workflow is disabled during Plan Mode, so its action route cannot tell the model to start coding while the plan awaits approval. Copy and Export remain available for historical submissions on the selected branch. Start execution names the exact current submission and shows the original permissions that execution will use. Returning to Normal with the bottom-row Plan control does not approve or execute a plan.

## Boundaries

- The guarantee concerns **local file writes through managed model tools**. App-owned session/task logs and trusted caches still write, as does a user-confirmed Save As export.
- DSH does **not isolate the network**. Guidance prohibits remote mutations, but shell access is not a hard read-only guarantee for a remote API or database.
- Tool filtering does **not sandbox arbitrary plugin host code**, extension factories, lifecycle hooks or a plugin's own network/model calls.
- User terminals, other sessions in the same directory, and external editors are outside this session's Plan restriction.
- Plan shell requires DSH enforcement `full`. `partial` or `unavailable` removes bash and rejects held execute references before process creation; there is no host-shell fallback or escalation.
- Approval does not upgrade permissions: a read-only session remains read-only for execution. Mode and the configured `SandboxMode` are separate facts.

## Ownership and modules

| Module | Responsibility |
| --- | --- |
| `shared/plan.ts` (re-exported from `shared/types.ts`) | DTOs, submission identity, blockers, 128 KiB limit |
| `main/pi/plan-protocol.ts` | Fold the complete selected branch, validate result identity/hash/revision |
| `main/pi/plan-storage.ts` | Append/fsync, latch persistence failures including SDK message append failures |
| `main/pi/plan-mode.ts` | Session transition lock, work reservations, facts, restriction, submission seal, metadata clock |
| `main/pi/plan-gate.ts` | Public setter adapter, effective tool set, call-time checks, submission stop hooks |
| `main/pi/plan-context.ts` | Per-request hidden instructions and summary stream overlay |
| `main/pi/plan-submission.ts` | App-owned `submit_plan`, canonical body and SHA-256 |
| `main/pi/plan-approval.ts`, `plan-approval-access.ts` | Durable approval and main-only opening ownership |
| `main/pi/plan-export.ts`, `plan-ipc.ts` | Authoritative export snapshot and six IPC routes |
| `main/pi/manager.ts` | Lifecycle wiring, committed message projection, branch restore, session facts |
| `renderer/state/pi-store.ts` | Per-session monotonic Plan metadata, independent of transcript sequence |
| `Composer.tsx`, `prompt-input.tsx` | Plus-menu mode entry, bottom-row active exit control, permission display and exact slash interception |
| `PlanCard.tsx`, `lib/plan-submissions.ts` | Verified document loading, actions and restored-card identity |
| `MessageItems.tsx`, `ChatView.tsx`, `lib/tool-runs.ts` | Submission reply boundaries, grouping barriers and compaction recovery |

All visible renderer strings are bilingual i18n entries. Controls compose beUI; no vendored component or SDK dependency is modified. `PlanPresentationContext` carries live metadata through memoized assistant groups, so an existing card loses its execution action immediately when mode changes.

## Branch protocol

Protocol version 1 uses existing JSONL entries; there is no plan file by default.

```ts
// customType: pith_plan_mode
{ version: 1, mode: 'plan', planId, via: 'toggle' | 'recovery' }
{ version: 1, mode: 'normal', planId?, via?: 'approve', approvalId? }

// Successful submit_plan toolResult.details
{ kind: 'pi-app-plan-submission', version: 1,
  planId, revision, planningTurnEntryId, plan, hash }

// customType: pith_plan_approval
{ version: 1, approvalId, ref,
  status: 'requested' | 'started' | 'failed' | 'interrupted',
  executionEntryId?, errorCode? }
```

The app generates identities. The model supplies only `plan`; the schema rejects extra properties. Normalize CRLF/CR to LF, trim, reject an empty document or more than 128 KiB **UTF-8 bytes**, then hash the canonical body. Never truncate a submitted document. Revisions increase within a planning cycle. A new user turn invalidates the previous submission's approval eligibility even before a revision arrives.

`PlanSubmissionRef` includes `planId`, `revision`, `submissionEntryId`, `hash`, `planningTurnEntryId`, and `submittedAt`. The immutable submission entry on the selected branch is authoritative. Fold from `SessionManager.getBranch()`, not compacted `session.messages`. `revisionPending` is derived from a later user entry after the latest submission; it survives reopen, compaction and branch changes without a separate mutable flag. Unknown mode/approval protocol versions lock work and cannot be approved. Failed results, invalid hashes and unpersisted results cannot become cards or current plans.

On a successful tool result, an awaited subscriber verifies the SDK already appended that exact message, fsyncs, rechecks canonical body/hash/turn/revision, then publishes and seals. All later tools and background wakes are refused for that planning turn. A genuinely admitted user opening or explicit mode transition lifts the seal. Queued steer/follow-up messages remain queued and block approval.

## Admission and tools

Mode change and approval take a synchronous session lock before the first await. User/background/branch work reserves admission before asynchronous preparation; release belongs in `finally`. Prompt preparation, compaction, reload, fork and Rewind cannot race a mode transition. Busy facts include SDK idle state, initialization, processes, starting/running subagents, delivery outboxes, questions, escalation requests and user queues. No transition clears those queues or stops tasks to manufacture an idle state.

Tool provenance is by **definition identity**, never by the reported source string, path basename or name prefix:

- `read`, `grep`, `find`, `ls` become the SDK's full `createReadOnlyTools(cwd)` definitions, including their schemas and argument preparation.
- Reviewed app-owned tools include read-only bash/task management, questions, Todo, constrained delegation/communication and root-only `submit_plan`.
- `REVIEWED_EXTENSION_TOOLS` is intentionally empty. Unproven web search/fetch, MCP, browser actions and arbitrary execution tools stay unavailable. Effective-tool guidance reports this actual set.
- Write/edit and other unapproved definitions are filtered and rejected at execution. Existing execute references recheck current admission/provenance; a retained object is not a bypass.
- `[submit_plan, other_tool]` in either order rejects the whole batch before execution.

The setter adapter retains the app's configured active set separately from the filtered view. SDK lazy registration and reload cannot accidentally re-enable a disabled app tool or permanently lose Normal-mode tools.

A child receives its frozen tool ceiling and `planRestricted` flag in persisted run metadata. Restrictions combine that frozen flag with the parent's current mode. Resume intersects the old ceiling with the parent's current effective tools and can never widen it. Plan children cannot delegate recursively or submit the parent's plan. Their background tasks and undelivered results keep the parent from submitting/approving prematurely.

## Approval and recovery

1. Validate current branch, plan identity, revision, submission entry/hash, turn and all live blockers under the transition lock.
2. Append/fsync `requested`; hold background wake owners; acquire the main-only opening capability.
3. Append/fsync the Normal mode transition, retaining configured file permissions, then materialize execution tool schemas.
4. Call the same session's `prompt()` with the authoritative full document and prompt-template expansion disabled. This reuses normal Rewind checkpoint capture.
5. At the opening user message's awaited `message_end`, verify its exact persisted entry and append/fsync `started` with `executionEntryId` **before any model request/tool execution**. Only then report approval accepted.

Repeated approval of a durably accepted opening returns the same result without sending another user message. Storage/version locks are checked before this idempotent return. Version mismatches, different branches, old revisions and pending work are refused by the host even if the UI is stale.

Input handled before acceptance returns a failure and allows an explicit retry. Stop during asynchronous input cancels the private capability until that input promise unwinds, preventing a late opening. A persistence failure locks further work; no successful rollback is fabricated. After acceptance, a model error or user Stop does not erase the accepted opening or automatically retry it.

A reopened `requested` approval, or `started` without its linked user entry, becomes `interrupted`; it never replays. Return to planning creates a fresh cycle and requires a fresh plan submission. Reopening a valid `started` opening restores it without re-execution. Reload, resend and Rewind branch movement re-fold both mode and approval recovery. Undo/Redo restores the selected branch's facts, not a stale in-memory mode.

## IPC and presentation

The production routes are registered by `registerPlanIpc` and exposed through the real preload:

| Channel | API |
| --- | --- |
| `plan:setMode` | `setSessionMode({sessionPath, mode})` |
| `plan:state` | `getPlanState(sessionPath)` |
| `plan:document` | `readPlanDocument({sessionPath, planId, revision, submissionEntryId})` |
| `plan:approve` | `approvePlan(sameRefRequest)` |
| `plan:resetApproval` | `resetPlanApproval(sameRefRequest)` |
| `plan:export` | `exportPlan(sameRefRequest)` |

Mutations/document reads return `{ok:true,value}` or `{ok:false,code,blockers}`. Blockers cover initialization/closing/child/recovery, transition/busy, tasks/subagents/deliveries/questions/escalations/queues, storage/version, and mode/submission eligibility. Invalid requests use `invalid-mode`, `no-session`, `stale-submission`; failed openings use `approval-start-failed`. Export cancellation is successful with `cancelled:true`. Renderer text comes from `planErrorKey` and i18n, with a generic fallback for unknown codes.

`plan_state_update` is sequence-free with respect to `eventSequence` and carries its own per-path `seq`. Store merge happens before stale-snapshot early returns and parked-event limits. Rebuilding a managed session continues its clock.

Main stamps successful persisted transcript results with `planSubmission`. Compaction recovery renders only the current `latest` card absent from visible stamped messages, positioned by submission time; a late original result removes the recovery copy. No artificial SDK message role is introduced.

Card loading is keyed by session path, entry and hash. The renderer recomputes SHA-256, checks the returned reference, and discards late responses from another session. Copy uses only this verified body. Export reads the host's authoritative immutable document **before** Save As; cancelling does not change the branch, and a subsequent branch change does not alter the chosen export snapshot. Neither model nor renderer supplies an export body or destination path to this API.

`PlanStateDTO.executionTurnId` links the approved plan back to the transcript turn that executes it. The review pane groups a turn by its **first assistant message timestamp**, while an approval records only the opening user entry id, so `planExecutionTurnId` maps one to the other from the selected branch. It is computed inside `PlanController.build()` against the **live** branch, not cached in the folded state: the assistant message it needs lands after the approval entry, so a fold performed at approval time could never see it. Rewind/resend take the entry off the branch and compaction folds the turn away; both report `null`.

Presentation follows from those facts:

- While the approval is `started`, the plan card offers **Review changes** — but only when `executionTurnId` is present *and* `extractReviewTurns` actually lists that turn (it changed files), so the pane never falls back to an unrelated turn. The action routes through the same `onReview` path as the transcript's changed-files card, opening the review rail on that turn.
- The approved plan reaches the model as a synthetic user message. That message carries the plan body, not a user's words, so while its approval is the started one the transcript renders **no row for it and no rail tick** (matched exactly by `UserMsg.sessionEntryId === approval.executionEntryId`), and the review switcher suppresses its prompt label instead of quoting protocol text. The message itself stays in the branch and in the session file.
- The card body keeps the plan readable (taller scroll cap) while its action strip stays a thin one-line footer; both are asserted in `check-plan-mode-ui.mjs`.

## SDK 0.85.1 upgrade assumptions

These adapters use public SDK surfaces. Re-run the Plan checks on every SDK upgrade:

- Dynamic registration/reload ends at `session.setActiveToolsByName`; there is no invented registry-change event. Its filtered prior view is not the app's configured base.
- Agent tool hooks are chained with Rewind/extensions, including a second admission check after an awaited hook.
- SDK session listeners see `message_end` **before** append. The later awaited `agent.subscribe` listener sees the persisted message and blocks the loop while fsync/approval association completes. `PlanStorage` also guards `appendMessage`, because a thrown SDK write has already changed its in-memory tree.
- `shouldStopAfterTurn` stops the agent's inner loop, but **AgentSession's outer post-run loop may still drain queues via `agent.continue()`**. The public continuation adapter declines that drain while sealed, preserving queued user input. This behavior was reproduced with real steer/follow-up queues.
- `context` covers ordinary requests/retries/custom wakes; summaries bypass it. The public `agent.streamFunction` overlay appends only the Plan mode fact and preserves the summary task. It does not claim to intercept a plugin's independent LLM client.
- `agent_settled` ends SDK activity; managed task and notification lifetimes remain separate.

## Verification

Acceptance on 2026-09-20: **19/19 commands exited 0**, comprising typecheck, build, the 16 regression scripts in Task 9, and the icon check. Failures found during acceptance were fixed and rerun; no required command was skipped. The settings/lifecycle fixtures now externalize Playwright instead of bundling optional BiDi dependencies, supply the current session ownership fields, and wait for actual background completion where the old tests assumed fixed timing. Two pre-existing tool-settings copy assertions were aligned with the existing bilingual strings.

`node scripts/check-plan-mode.mjs` exercises real SDK sessions in temporary profiles with an offline fake provider. It covers protocol/storage, permission overlays and provenance, admission races, shell confinement, submit/revise/seal/queues, subagent restrictions, durable approval and injected fsync failures, Stop during input, accepted model errors, cold reconstruction, real compaction, fork and Rewind/Undo/Redo. It also checks export bytes and renderer metadata/identity derivations.

After building, `node scripts/check-plan-mode-ui.mjs` covers real beUI controls/cards in isolated Electron, both languages, both corner styles, light/dark themes, exact slash behavior, drafts, blockers, copy/export actions, compaction recovery and late document responses. Its appended transport check uses the **production preload and IPC routes with real PiManager**, verifying mode/document/approval/reset and Save As cancellation/success. Only the native Save As choice and provider response are replaced. Set `PI_PLAN_SCREENSHOT_DIR` to retain the UI matrix.

Final acceptance also runs the existing sandbox, Todo, ask-user/UI, subagent/extension-tools, lifecycle/persistence, queue-panel, bash-task, Rewind SDK/UI, transcript-order, tool-settings and icon checks, after `npm run typecheck && npm run build`.

The acceptance host is macOS with Seatbelt. Partial/unavailable enforcement is tested as an injected capability, not a claim of native Linux/Windows execution. Native Linux DSH and Windows behavior require their own platform runs.
