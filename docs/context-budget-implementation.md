# Request context budgets and image safety

`src/main/pi/context-budget.ts` applies a soft budget to the provider request copy. SDK history, tool output and JSONL remain complete. Normal, child and scheduled sessions use the same wrappers through `PiManager`.

## Policy

Input space is the declared model window minus the reply reserve and a 4096-token safety margin. An explicit request `maxTokens` determines the reserve; otherwise it is the smaller of the model reply limit and the SDK's model-specific compaction reserve. Recent context uses the SDK's `keepRecentTokens`. Unknown windows produce diagnostics without shortening.

Token estimates use SDK `estimateTokens`, character/schema estimates and approximate framing. They are heuristic, separate from provider usage and the composer's SDK context approximation. [Context statistics](context-statistics-implementation.md) measures the budgeted request separately from the complete session projection. SDK compaction and overflow recovery remain responsible for requests that cannot fit.

Under pressure, shorten older tool-result text only, in creation order:

- Protect the recent suffix and the current user turn's latest complete tool-call/result batch.
- Preserve users, assistant text/thinking, tool calls, images, ordering, IDs and unmatched results.
- Preserve state-bearing `todo_write`, `submit_plan`, `present` and `scheduled_task` results.
- Results over 2048 UTF-16 units retain a bounded head/tail plus an explicit omission marker. Multiple text blocks share the allowance; surrogate pairs are not split.

The inspector's `contextBudget` reports before/after estimates, omitted UTF-16 units and residual overflow. `protected-over-budget` means protected input still exceeds the estimate; no instructions or pairs are silently dropped. Diagnostics are app metadata, never billed usage or a provider payload field.

## Image safety and wrapper order

`src/main/pi/image-safety.ts` validates tool images before new persistence. An undecodable image becomes a bounded text note, preserving other blocks. Historical malformed images are repaired only in the request copy. Text-only models receive text notes instead of image blocks; valid images for image-capable models remain byte-for-byte intact.

Calls flow **Plan → text-only image guard → budget → trajectory → provider**. Install wrappers in the corresponding reverse nesting order and dispose in reverse installation order. Plan instructions count toward overhead before budgeting; trajectory records the actual transformed request. The original tool output remains available independently.

## Verification

```sh
node scripts/check-context-budget.mjs
node scripts/check-image-safety.mjs
node scripts/check-continue.mjs
node scripts/check-plan-mode.mjs
node scripts/check-todos.mjs
node scripts/check-present-trajectory.mjs
node scripts/check-session-replay.mjs
```

Checks include protected parallel batches, old batches, Todo reminders, Unicode/images, unknown windows, wrapper restoration and real SDK persistence without changing historical output.
