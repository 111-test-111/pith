# Session goals: next implementation

Keep one current goal per ordinary conversation and the existing Todo/continuation/task-panel ownership. The next release should strengthen completion evidence and recovery before expanding to multiple goals or scheduling.

## 1. Acceptance criteria and evidence — implemented

Stable criterion IDs/revisions, panel editing, per-row committed provenance and file-version bindings now ship in the native Goal implementation. Todo remains the work list and a structural completion gate; the existing Jev workflow reviews the explicit criteria and exact evidence revision. Stop, Plan, compaction, Rewind and reopening retain their ownership/accounting guarantees. See [implementation and validation](goals-implementation.md).

Deterministic real-SDK fixtures include a deliberately failing check and a plausible false completion claim. They verify application refusal, not real-model task quality. Real-provider evaluation with these adversarial cases remains part of section 4; external Jev/provider calls are opt-in and are not asserted as covered by offline regressions.

The process-kill recovery matrices, immutable pending input, shared Fork spending and independent child/Jev attribution now ship. Next prioritize bounded diagnostics and real-provider evaluation. Keep one goal per ordinary conversation while these guarantees mature.

## 2. Process-kill recovery, pending input and Fork — implemented

`goal-recovery` uses actual SIGKILL/restart at fsynced goal, dispatch, input, billing, verification, completion/dismissal, Plan, Stop, Rewind, disk-failure, Fork and storage-lock boundaries. It verifies exact recovery endpoints, no provider calls on restart, no accepted-prompt/claim replay, once-only billing and unavailable-accounting refusal. Completed goals remain discoverable after restart until explicit End; unfinished goals require explicit Resume.

Bounded immutable file/image receipts preserve captured cwd, byte hashes, original paths and binary/long-text inspection copies. Resume validates them before charging; independent consumption tombstones and persisted branch ancestry prevent accepted attachment replay after Rewind. Forks share spent allowance through a durable original-owner alias, with independent dispatch/progress scopes and atomic last-slot admission. A fresh allowance requires explicit new-goal creation.

Live objective/criterion editing drains work under Plan's transition lock, invalidates the affected proofs and Jev review, retains Todo/usage and stays paused for explicit Resume. The panel has one acceptance view and collapsed proof/allowance details. POSIX process checks do not establish Windows behavior; live-provider quality remains unverified by these fixtures.

## 3. Budget across owned work — implemented

Main-owned immutable source/charge/request records bind independent child SDK and Jev-service billing to the original shared owner pool. The allowance disclosure reports parent, child and Jev usage separately. Child primary response receipts and SDK assistant entries share one request identity; standalone, summary, cache and tool usage retain their independent SDK entry identities. Jev records reported usage before cancellation/answer validation and excludes connection probes. New attributed requests check the shared cap; in-flight work retains possible overshoot.

`goal-accounting` and `goal-accounting-recovery` verify Pause/Stop, explicit Resume, Plan, Rewind, child deletion, shared Fork limits and actual SIGKILL at ten claim/receipt/debit boundaries. Both repeated recovery and limit edits retain consumed usage. Dispatched requests with unreported usage remain explicit unresolved accounting and refuse further attributed dispatch. Offline fixtures cannot establish remote unreported charges; Windows locking and real-provider comparison remain part of section 4.

## 4. Inspectable progress and evaluation

Expose a bounded read-only history of dispatches, pause reasons, verification revisions and quota deltas in the existing panel. Keep it independent of transcript event sequence and redact credentials/payloads. Evaluate completed, blocked, stalled, interrupted and user-corrected tasks against concrete expected files/check results, including real-model runs.

Use the existing immutable accounting records as the read-only provenance source rather than copying charges into transcript events. Include child run/request and Jev tool/trace/provider IDs, explain unresolved requests and distinguish known usage from provider-unreported amounts. Retain receipts when child conversations are deleted; avoid exposing raw filesystem journals as product UI. Compare reported usage with actual provider records in opt-in evaluation before claiming external invoice accuracy.

Acceptance: a user can explain why the goal continued or paused and trace a charge to its originating run. Quality evaluation distinguishes model claims from independently checked outcomes. Expand into multiple goals or scheduler-owned work only after these lifecycle and accounting checks pass.
