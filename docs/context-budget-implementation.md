# Request context budgets

The app applies a layered, request-only soft budget before sending a model request. It reduces repeated large tool outputs in long conversations while keeping the SDK's persisted branch and compaction lifecycle intact. The implementation is in `src/main/pi/context-budget.ts`; all normal, child and scheduled sessions install it through `PiManager`.

## Layers and estimates

The request inspector's **Context → contextBudget** object reports:

- The model's declared context window.
- Estimated system-prompt and tool-definition tokens. The tool estimate covers the provider-facing name, description, parameter schema and optional constrained-sampling field, not executable handlers or app-only prompt metadata.
- An output-space target and a safety margin.
- Estimated dialogue and tool-result tokens before and after shortening.
- The recent-message target, protected suffix size, shortened-result count and per-result omissions.
- Any remaining estimated overflow after all eligible shortening.

Every token estimate is explicitly identified as `heuristic` / `sdk-chars/4+framing`. Message text, thinking, tool-call arguments and images use the SDK's public `estimateTokens`; the app adds 12 tokens per message for approximate framing. System text and serialized tool definitions use the same UTF-16 character count divided by four. Image estimates and non-Latin text can differ substantially from provider tokenization. These estimates are neither billed usage nor the composer's SDK-authoritative context-ring value; this feature does not replace either statistic.

The output-space target defaults to `min(model.maxTokens, settingsManager.getCompactionSettings(model).reserveTokens)`. An explicit request `maxTokens` becomes the target instead. The safety margin is 4096 tokens, matching Pi's provider-side output-fit margin. The resulting input target is `max(0, contextWindow - replyReserveTokens - 4096)`. Reusing the SDK's reserve and recent-context settings, including model-specific overrides, avoids a second conflicting preference. The manual compaction preflight also reads settings for the selected model, matching the SDK's own compaction path. This does **not** change `maxTokens`, reasoning budgets, provider clamping or any compaction setting; the default provider output ceiling may exceed the space target and is still fitted by Pi. A model with no positive finite context window gets diagnostics but no shortening.

Set per-model values in `~/.pi/agent/settings.json` or the workspace's `.pi/settings.json` using the SDK's exact `provider/modelId` key. For example, `"compaction": { "modelOverrides": { "openai/gpt-6.1-sol": { "reserveTokens": 32768, "keepRecentTokens": 24000 } } }` applies both values to GPT-6.1 Sol requests and compaction; other models retain the ordinary settings.

## Shortening policy

Nothing is shortened while the estimated input fits the target. Under pressure, the app visits older tool results in creation order and shortens text only until it fits or eligible results run out:

1. Keep a recent suffix up to the SDK's `keepRecentTokens` target. A message that would push an already-started suffix over that target stays outside it; the newest message is always protected.
2. Also protect the latest tool-call batch **within the latest real user turn**, including every result in a parallel batch even if it exceeds that target. The public `session.messages` user timestamp distinguishes the actual turn from Todo's ephemeral user-shaped reminder. A batch from an earlier turn gets no permanent protection when later turns contain only dialogue.
3. Leave all users, assistant text/thinking, tool calls and images untouched. Keep all tool-result messages, IDs, names and block ordering. Tool results without a matching retained call are preserved rather than guessed. State-bearing `todo_write`, `submit_plan`, `present` and `scheduled_task` outputs remain whole.
4. An eligible result with more than 2048 UTF-16 units of text retains approximately 2048 units including one explicit omission marker, with 60% of the retained content from its head and 40% from its tail. Multiple text blocks share this allowance; image blocks retain their positions. Truncation boundaries do not create lone Unicode surrogates. Small results stay whole.

The marker says the earlier result was shortened for this request and points to the execution trace's full output. The diagnostic omission count uses the explicit unit `omittedUtf16Units`; per-result diagnostic entries are capped at 256 with the remainder counted separately.

If the protected system prompt, tool schemas, dialogue, images or current batch still exceeds the target, the report says `protected-over-budget` and includes the residual estimate. The app does not silently drop instructions, tool-call pairs or the current evidence to claim success. SDK auto-compaction and overflow recovery remain enabled and own that outcome. The budget does not summarize dialogue, modify history, create an extra model request or add a persisted message.

## Three different records

The stream wrappers are installed in this order: trajectory recorder, budget wrapper, Plan overlay. Calls therefore flow **Plan overlay → budget → trajectory → provider**. Plan's complete instructions (including its summarization fallback note) count toward system overhead before budgeting or recording. Disposal restores the wrappers in reverse order.

The inspector has three distinct views:

- **Request Context:** the exact request projection after shortening, with the extra `contextBudget` diagnostic object. This metadata is an app-side Context extension; provider adapters serialize only their known request fields.
- **Provider Payload:** the provider's actual serialized payload, including shortened results and excluding `contextBudget`. Payload replacement hooks and retries continue to be handled by the recorder.
- **Tool Output / transcript / session JSONL:** the original complete tool result as returned by the tool. Budgeting never mutates these objects. “Complete” here means the tool's finalized result; existing SDK read/search caps and managed-bash log/tail caps still apply at tool execution time.

The design borrows DeepSeek Harness's separation between heuristic system/tool/message composition and authoritative provider usage (`packages/llm/token-meter/src/breakdown-projection.ts`, `estimate.ts`), without adding a second context store or replacing Pi's compaction engine.

## Verification

Run from the repository root:

```sh
npm run typecheck
npm run build
node scripts/check-context-budget.mjs
node scripts/check-plan-mode.mjs
node scripts/check-todos.mjs
```

The offline budget check exercises accounting identities, unknown model windows, oversized protected input, recent parallel batches, old batches followed by pure dialogue, Todo reminders, state-bearing results, unmatched results, multi-block images/Unicode and wrapper restoration. Its real SDK fixture performs actual Plan-gated `read` calls, then checks the provider request, context diagnostics, unchanged SDK messages/session JSONL and full tool-output export. It makes no network or credential request.
