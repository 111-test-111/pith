# Plan Mode implementation

Plan Mode constrains managed model tools to local investigation, stores a versioned Markdown plan in the selected conversation branch, and starts implementation only after approval of that exact submission. The composer offers Normal / Plan; exact `/plan` toggles without sending. Ordinary text with arguments is still a message. Returning to Normal does not approve a plan.

## Ownership and boundaries

`main/pi/plan-mode.ts` owns synchronous transition locks, asynchronous work reservations and live facts. `plan-protocol.ts` folds the complete `SessionManager.getBranch()`; compacted `session.messages` is insufficient. `plan-storage.ts` owns append/fsync and storage-failure locks; `plan-gate.ts` owns definition-identity admission. Submission, approval, context, export and IPC have separate `plan-*.ts` modules. DTOs originate in `shared/plan.ts` and are re-exported by `shared/types.ts`.

Mode and configured `SandboxMode` are independent. Approval preserves the original permissions, including read-only mode. The guarantee covers local writes through managed model tools. DSH does not isolate networking or arbitrary extension host code; user terminals, sibling sessions and external editors are outside the restriction. App logs/caches and user-confirmed exports still write.

Plan bash requires DSH `full` enforcement. Partial/unavailable enforcement disables bash, rejects held calls, and never falls back to host execution or escalation.

## Admission and tools

Mode changes and approvals take the synchronous lock before any await. Prompt/background/branch preparation reserves admission and releases it in `finally`. Busy blockers include SDK work, initialization, processes, starting/running children, deliveries, questions, escalation requests and user queues. No transition discards queues to manufacture idle state.

- Replace `read` with the trusted app paged-read definition and `grep`, `find`, `ls` with complete SDK read-only definitions.
- Admit reviewed app-owned bash/task inspection, questions, Todo, Jev and constrained delegation/communication by exact definition identity; root-only `submit_plan` is special.
- `REVIEWED_EXTENSION_TOOLS` is empty. Unreviewed extensions, MCP, browser actions and write/edit stay unavailable.
- Preserve the app's active base separately from the filtered set; lazy registration/reload cannot widen Plan or erase Normal tools.
- Extension tool selection reads and updates that Normal base, while Plan still filters model declarations and execution. Explicitly inactive definitions retained for historical rendering stay inactive across app settings changes and reloads.
- Pi 1.0 refreshes tools internally without calling the public session setter. The gate also intercepts the public `AgentState.tools` accessor, preserving its copy-on-assignment semantics. Registration, request preparation and reload all materialize the same restricted view; incompatible accessor shapes fail closed at installation. Disposal restores the original descriptor and hook chain.
- Recheck held execute references after awaited work. A batch containing `submit_plan` plus another tool rejects before either executes.

`tool-call-boundary.ts` routes SDK nested calls through current admission and Rewind leases. Receipt-dependent app tools are `model-only`; nested execution cannot perform their state transitions. In Plan, nested raw read definitions are refused because they bypass the trusted replacement. Children freeze `planRestricted` and their ceiling at dispatch; resume may narrow only. Restricted children cannot recursively delegate or submit the parent's plan.

## Durable submission and approval

The model supplies only `plan`. Main normalizes line endings, trims, rejects empty or over-128-KiB UTF-8 bodies, and stamps plan ID, revision, planning turn, entry and SHA-256. Never truncate a submitted document. Successful results must match the selected persisted branch and hash before becoming eligible.

A later awaited `agent.subscribe` runs after SDK persistence, fsyncs the exact result, publishes and seals the planning turn. The seal blocks later tools and background wakes until an admitted user opening or explicit transition. Queued steer/follow-up input remains queued and blocks approval. A later user turn marks the prior submission revision-pending until a complete replacement arrives.

Approval under the lock:

1. Recheck branch, full submission reference, hash, current revision/turn and live blockers.
2. Append/fsync `pith_plan_approval: requested`; acquire a main-only opening capability.
3. Append/fsync Normal mode with unchanged permissions and materialize execution tools.
4. Prompt the same session with the authoritative body, disabling prompt-template expansion; ordinary Rewind capture still runs.
5. At the exact opening user's committed `message_end`, append/fsync `started` with its entry ID before any model request or execution.

Duplicate accepted approvals return the same result only after storage/version checks. Stop cancels an opening still in preparation. Failed persistence locks work; accepted openings are not erased or replayed on model error. Reopen marks incomplete approvals interrupted and never auto-executes them. Rewind/resend/fork/reload refold branch facts.

SDK 1.0.0's outer continuation loop can drain queues after `finishTurn`; while sealed, the public `hasQueuedMessages` and `agent.continue` adapters preserve queues and stop further requests. These public adapters require regression checks on SDK upgrades.

## IPC and presentation

`registerPlanIpc` exposes `plan:setMode`, `state`, `document`, `approve`, `resetApproval` and `export` through the real preload. Renderer sends references, never document bodies/destination paths for export; native Save As chooses the destination after main reads the immutable document.

`plan_state_update` uses its own monotonic per-path `seq`, never transcript `eventSequence`. Main stamps committed results; compaction recovery adds only a missing current card. Loading verifies entry/hash and rejects late responses from another chat; Copy uses the verified body.

`executionTurnId` derives from the live selected branch and the exact approved user entry, so it becomes null when branch movement or compaction removes the reviewable turn. Review opens only a turn listed by `extractReviewTurns`. While the approval is started, its synthetic user entry renders no transcript row/rail tick, matched by exact entry ID; the durable message remains in JSONL. The card stays outside thinking/tool folds. Revise focuses the composer; sending feedback invalidates approval eligibility.

## Verification

```sh
node scripts/check-plan-mode.mjs
node scripts/check-plan-mode-ui.mjs
node scripts/check-sdk-tool-boundary.mjs
```

The first uses real SDK/offline provider fixtures for provenance, races, seals/queues, child limits, durability faults, cancellation, compaction and branch recovery. The UI suite requires a build and exercises production preload/IPC, bilingual beUI controls, documents and Save As. Also run affected lifecycle, persistence, Todo, ask-user, bash, subagent and Rewind checks when sharing their paths.
