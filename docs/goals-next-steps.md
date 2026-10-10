# Session goals: next implementation

Keep one current goal per ordinary conversation and the existing Todo/continuation/task-panel ownership. The next release should strengthen completion evidence and recovery before expanding to multiple goals or scheduling.

## 1. Acceptance criteria and evidence — implemented

Stable criterion IDs/revisions, panel editing, per-row committed provenance and file-version bindings now ship in the native Goal implementation. Todo remains the work list and a structural completion gate; the existing Jev workflow reviews the explicit criteria and exact evidence revision. Stop, Plan, compaction, Rewind and reopening retain their ownership/accounting guarantees. See [implementation and validation](goals-implementation.md).

Deterministic real-SDK fixtures include a deliberately failing check and a plausible false completion claim. They verify application refusal, not real-model task quality. Real-provider evaluation with these adversarial cases remains part of section 4; external Jev/provider calls are opt-in and are not asserted as covered by offline regressions.

Next prioritize the process-kill recovery matrix below, then shared owned-work billing. Keep one goal per ordinary conversation while these guarantees mature.

## 2. Process-kill recovery matrix

Extend the current deferred-barrier and ledger-reconciliation tests with a separate OS process. Kill it after goal-definition fsync, dispatch claim, user-entry commit, usage commit, verification receipt and final-state fsync. Repeat around Plan entry, Stop and Rewind journal commitment, including disk-write failure and stale storage locks.

Persist a bounded pending-input receipt for attachments not yet accepted as the initial user turn. Validate image bytes before storage, retain the captured cwd and immutable attachment references, and distinguish pending input from a committed user message. Only explicit Resume may create a new dispatch; accepted prompts and old claims are never replayed. Define fork behavior explicitly so copied branch facts cannot create fresh zero-usage allowance.

Acceptance: restart always pauses unfinished goals, each committed charge is billed once, used allowance never decreases, and recovery preserves the exact Rewind endpoints. An interrupted preflight exposes enough input state for the user to resume without silently losing an attachment. Missing/corrupt accounting continues to fail closed.

## 3. Budget across owned work

Add run-scoped attribution for independent child SDK and Jev-service billing. Retain source IDs and report parent, child and review usage separately before presenting a combined cap. Include actual reported cache/summary/tool billing without nested duplication. Check the shared allowance before admitting new owned work; requests already in flight retain the documented possible overshoot.

Acceptance: child/review charges survive Stop, Resume, Rewind, deletion and restart without duplicate billing. Unavailable attribution is explicit and cannot be converted into a zero charge. Adding or increasing a limit never changes the consumed amount.

## 4. Inspectable progress and evaluation

Expose a bounded read-only history of dispatches, pause reasons, verification revisions and quota deltas in the existing panel. Keep it independent of transcript event sequence and redact credentials/payloads. Evaluate completed, blocked, stalled, interrupted and user-corrected tasks against concrete expected files/check results, including real-model runs.

Acceptance: a user can explain why the goal continued or paused and trace a charge to its originating run. Quality evaluation distinguishes model claims from independently checked outcomes. Expand into multiple goals or scheduler-owned work only after these lifecycle and accounting checks pass.
