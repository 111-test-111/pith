# Native subagents

`src/main/pi/subagents/` implements app-owned delegation using ordinary managed Pi sessions. Children share the parent's checkout; there is no per-child worktree or automatic merge. Independent writers can collide.

## Profiles and permissions

Global `<agentDir>/agents/*.md` profiles are shadowed by `<cwd>/.pi/agents/*.md` of the same name. Flat frontmatter supplies description, tools and optional model/thinking/context/background defaults. Explicit `tools` wins; supported `tool_preset` allow selections come next; missing/unresolved permissions fall back to read-only. Unknown presets never become full access.

Four starters are written once. The marker beside the global files prevents deleted starters from returning; legacy userData marker drift may heal a fresh directory. Settings edits only owned frontmatter fields, preserving prompt/custom metadata/line endings and validating the result.

Dispatch freezes `profile tools ∩ parent available tools`, removing excluded orchestration tools. Explicit tool identities preserve SDK casing, including normalized MCP server/tool names; only the `all` / `none` keywords are case-insensitive. Native callable MCP/resource tools can be granted even when deferred from the model declaration; `codemode` must also be granted for script use. `tools: all` still follows the parent's ceiling. The debugger rides the same tools list — `all`, or an explicit `debug` entry — and the parent's live debug availability remains the ceiling either way. Enabled parent communication is injected before freezing.

Children load extensions only if their frozen ceiling needs them and they are not Plan-restricted; ordinary read-only children remain extension-free. Dispatch persists model, thinking, append prompt, tool ceiling, extension-loading decision and Plan restriction. Resume intersects the old ceiling with current parent access and can only narrow it; enabling a feature later cannot widen an old run.

User settings own the effective turn limit (1–200 or unlimited). Legacy profile `max_turns` is parseable but supplies no runtime default. A model override is accepted only under the explicit user grant, rechecked after asynchronous launch; continuation recomputes the policy. Existing active runs retain their resolved limit.

## Runtime and persistence

`runtime.ts` registers launch cancellation before awaits. Creation and whole-run checkout leases fence parent snapshots/restores through child work, background drain and cleanup. Stop is awaitable: cancel launches, silence deliveries, clear child queues, stop bash/debug and await SDK settlement before releasing ownership.

Children use the same manager/registry/task/shutdown lifecycle, own Todo/change/task state, and have no Rewind recorder. Live instances and their own SessionManager are reused for resume; never open a second writer over a live session file. Human chat views are read-only; normal prompt/resend/queue APIs reject child mutation.

`protocol.ts` records per-run `pith_subagent_run` and terminal `pith_subagent_result`, keyed by run ID. Parent dispatch ownership must remain on the selected branch for resume. Status follows final stop reason, caught failure and explicit abort; prompt resolution alone is not completion. Limit completion is `completed + limitReached`, while user Stop is `aborted`. Terminal persistence failure reports failed; reopen shows an unpaired start as interrupted. Interrupted work is never auto-dispatched.

Roster snapshots/events use monotonic per-parent sequence values in both merge directions. `subagents_update` never carries transcript `eventSequence`. Roster rows omit patch bodies; complete run evidence lives in tool/completion results. Recovery yields between child reads.

## Notifications and file evidence

Background completion uses a durable-aware outbox, steering plus `triggerTurn`, not follow-up queues. Delivery waits for the parent's committed dispatch result and acknowledges on committed receipt. Stopped/orphaned runs cannot wake the parent. Child background bash wakes the child; the run settles only after owned background work drains.

Written files are derived from the child's complete selected branch and limited to the run interval. Foreground `agent` results and background `subagent_completion` notices fold into the parent's changed-file projection. Generated-image receipts retain their classification through persistence and roster snapshots: Rewind keeps their write evidence, while code-review lists omit them. Current run-scoped evidence deduplicates by run ID; legacy cumulative evidence by child session. Failed runs do not erase successful writes.

Rewind collects known child writes from parent records, falling back to readable child files. It applies the parent's saved workspace/exclusion coverage; in-scope originals can already be in the parent's before-turn backup, while excluded/outside paths require explicit partial consent. Missing child files degrade evidence rather than invent originals or block every preview. Live run leases prohibit restore until work stops.

## Human controls and views

Roster Guide/Stop/Continue payloads pin `expectedRunId`; main compares atomically, so a stale action cannot target a replacement run. Successful IPC waits for authoritative roster events instead of optimistic status changes. Human controls do not depend on model reuse/communication toggles.

`peekSession` reads committed child history without activation. `agent:<path>` rail tabs reuse `ChatView`; a non-visible child has roster progress without a streaming transcript overlay. The rail has no composer/session mutation actions. The full child chat offers an explicit return-to-parent action. Completed child debug targets are cleaned even when viewed.

## Verification

```sh
node scripts/check-subagents.mjs
node scripts/check-subagents-integration.mjs
node scripts/check-subagent-extension-tools.mjs
node scripts/check-subagent-settings.mjs
node scripts/check-bash-task-ui.mjs
node scripts/check-rewind-sdk.mjs
```

Checks cover profile scope/defaults, grants, real SDK disk recovery, cancellation/leases, resume/branch ownership, notifications, run-scoped files, settings revocation and bilingual forms. Also run task, lifecycle/persistence, transcript-order and debug checks when their shared paths change.
