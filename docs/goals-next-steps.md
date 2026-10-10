# Session goals: next implementation

Keep one current goal per ordinary conversation and the existing Todo/continuation/task-panel ownership. The next release should strengthen completion evidence and recovery before expanding to multiple goals or scheduling.

## 1. Acceptance criteria and evidence — implemented

Stable criterion IDs/revisions, panel editing, per-row committed provenance and file-version bindings now ship in the native Goal implementation. Todo remains the work list and a structural completion gate; the existing Jev workflow reviews the explicit criteria and exact evidence revision. Stop, Plan, compaction, Rewind and reopening retain their ownership/accounting guarantees. See [implementation and validation](goals-implementation.md).

Deterministic real-SDK fixtures include a deliberately failing check and a plausible false completion claim. They verify application refusal, not real-model task quality. Real-provider evaluation with these adversarial cases remains part of section 4; external Jev/provider calls are opt-in and are not asserted as covered by offline regressions.

The process-kill recovery matrix, immutable pending input and shared Fork spending now ship. Next prioritize attribution for independent owned-work billing, then bounded diagnostics and real-provider evaluation. Keep one goal per ordinary conversation while these guarantees mature.

## 2. Process-kill recovery, pending input and Fork — implemented

`goal-recovery` uses actual SIGKILL/restart at fsynced goal, dispatch, input, billing, verification, completion/dismissal, Plan, Stop, Rewind, disk-failure, Fork and storage-lock boundaries. It verifies exact recovery endpoints, no provider calls on restart, no accepted-prompt/claim replay, once-only billing and unavailable-accounting refusal. Completed goals remain discoverable after restart until explicit End; unfinished goals require explicit Resume.

Bounded immutable file/image receipts preserve captured cwd, byte hashes, original paths and binary/long-text inspection copies. Resume validates them before charging; independent consumption tombstones and persisted branch ancestry prevent accepted attachment replay after Rewind. Forks share spent allowance through a durable original-owner alias, with independent dispatch/progress scopes and atomic last-slot admission. A fresh allowance requires explicit new-goal creation.

Live objective/criterion editing drains work under Plan's transition lock, invalidates the affected proofs and Jev review, retains Todo/usage and stays paused for explicit Resume. The panel has one acceptance view and collapsed proof/allowance details. POSIX process checks do not establish Windows behavior; live-provider quality remains unverified by these fixtures.

## 3. Budget across owned work

First add a main-owned immutable charge record keyed by originating session/run and provider entry or Jev request ID, then connect it to the goal's shared owner pool. Add run-scoped attribution for independent child SDK and Jev-service billing. Retain source IDs and report parent, child and review usage separately before presenting a combined cap. Include actual reported cache/summary/tool billing without nested duplication. Check the shared allowance before admitting new owned work; requests already in flight retain the documented possible overshoot.

Acceptance: child/review charges survive Stop, Resume, Rewind, deletion and restart without duplicate billing. Unavailable attribution is explicit and cannot be converted into a zero charge. Adding or increasing a limit never changes the consumed amount.

## 4. Inspectable progress and evaluation

Expose a bounded read-only history of dispatches, pause reasons, verification revisions and quota deltas in the existing panel. Keep it independent of transcript event sequence and redact credentials/payloads. Evaluate completed, blocked, stalled, interrupted and user-corrected tasks against concrete expected files/check results, including real-model runs.

Acceptance: a user can explain why the goal continued or paused and trace a charge to its originating run. Quality evaluation distinguishes model claims from independently checked outcomes. Expand into multiple goals or scheduler-owned work only after these lifecycle and accounting checks pass.
