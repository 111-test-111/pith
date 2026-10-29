# Context statistics

The context pane distinguishes three measurements. Cumulative billing comes from SDK session statistics over every file entry, including abandoned branches, summaries, standalone usage and outer tool billing. Reported reasoning is a subset of output and is never added to the billed total. Cache hit rate divides cache reads by fresh input plus cache reads and writes; generated output is excluded.

The composer retains SDK live context usage, with an in-flight output estimate and a canonical post-compaction fallback. That fallback replays system content appends, section replacement/deletion and tool removal/addition once, then estimates the remaining projection messages. It does not sum superseded prompts or schemas. The ring is an approximation of current context, not an exact count of a provider payload.

Composition has its own estimate total. Its difference from provider usage is shown separately and is never attributed to system text. `context-composition.ts` splits folded system sections, project instruction files, skill descriptions, tool declarations, user/assistant text, visible reasoning, tool-call arguments, tool output, images, summaries and custom messages. It uses the SDK estimate per message and apportions rounding so categories and role buckets share one total. Images retain the SDK fixed estimate; opaque reasoning signatures and base64 size are excluded. Section/tool names are bounded and omitted names retain their tokens in the category total.

## Observed requests

The existing trajectory stream boundary observes every agent request after Plan, image safety, budgeting, extension context handlers and conversion to LLM messages. It retains only bounded composition metadata in main. Auxiliary compaction/tree-summary requests do not replace the last agent request. Retry attempts have separate identities; reported input includes fresh input and cache reads/writes, excluding generated output. Running or zero-usage failed requests leave reported input unknown.

Exact converted content and timestamp matches, consuming duplicate messages once each, preserve summary/custom/shell provenance. Unmatched request user content is labelled as added/edited request content of unknown origin. Replacements are counted once from the actual request, not added on top of their saved originals. This comparison does not claim which extension supplied a change.

Composition estimates describe the transformed SDK request before provider serialization. The recorder also captures the final `onPayload` value; provider serialization, callbacks and provider-specific framing can change that payload. A payload capture flag is evidence of observing the callback, not proof that category estimates equal wire tokens. The provider's reported input and its difference from the estimate remain independent.

Metadata persists alongside trajectory records. A dedicated worker query uses the same selected-branch/fork ancestry checks as body inspection, reads no request documents and returns only the latest authorized capture. Rewind excludes off-branch captures in both the live recorder and storage. Ordinary timeline pages omit composition metadata. Older logs without captures explicitly fall back to `buildSessionProjection()`, including compaction checkpoints, summaries, custom messages and context edits. Model/thinking metadata follows the selected branch, while billing keeps all branches.

Sequence-free context metadata includes an independent leaf/request revision so a capture/model/category change refreshes the pane even when usage numbers stay equal or the model window is unknown. Unknown windows retain unknown tokens/percent without hiding billing or request revisions. The pane labels the composition source and request time/model, retains independent current-projection estimates, and rejects stale asynchronous reads when switching sessions.

The pane displays current context and composition before the separate latest-request and cumulative-session sections. Named category entries and detailed estimate explanations are collapsed initially; category totals always remain visible. Instructions/tools and conversation content use independent wide-pane columns with aligned token/share fields. Expansion survives same-session polling and CSS-only resizing, and resets for a different session. See [responsive sidebar panes](sidebar-pane-layout.md) for the layout contract.

## Verification

```sh
npm run typecheck && npm run build
npm test -- --no-prepare --suite context-detail,context-estimate,context-budget,context-detail-ui,present-trajectory,present-trajectory-ui,session-replay,usage-stats --strict-skips
```

Checks use real offline SDK requests, storage restart and fork/Rewind ancestry, evolving extension transformations, budgeted request copies versus complete history, cache accounting and isolated Electron rendering in all three locales. They do not claim model-tokenizer or live-provider accuracy.
