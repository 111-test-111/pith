# DAP debugging

`src/main/debug/manager.ts` owns all debug targets; renderer and app-owned `debug` tool share its action registry. Settings enables model exposure without freezing registration, so existing sessions can apply live changes.

## Ownership and lifecycle

Every action addresses an explicit `debugId` belonging to its session; implicit model selection rejects ambiguity. Renderer inspection/control additionally carries `stopId`, incremented at each stop/reference invalidation. Parent and sibling agents cannot use another child's debugger. Human panes may show roster-owned child targets while preserving their actual owner path.

Startup registers ownership before asynchronous discovery and rechecks cancellation/admission through transport/handshake. Checkout process leases cover both workspace and debuggee cwd until adapter, child target and owned terminal cleanup finishes. Unproven cleanup retains the fence. Switching chats keeps targets; Stop/delete/Rewind disposal/shutdown closes them. Attach detaches, launch asks to terminate the debuggee.

There are at most 16 live targets per chat / 32 app-wide. Ten newest cleaned targets retain bounded console history (65,536 UTF-16 units), not live processes; restart never reconnects them. js-debug reverse `startDebugging` creates socket-only child targets on the same server; root teardown closes that target tree.

A subagent profile grants the debugger through its ordinary tool set: `tools: all`, or an explicit `debug` entry. The parent's live debug availability remains the ceiling either way. Dispatch freezes the parent/profile ceiling; resume only narrows and starts without a live debugger. Completion cleans the child's targets even while its transcript is visible.

## Action registry and compatibility

`action-registry.ts` owns TypeBox schemas, handlers, read/execute, stopped/core/capability policies. `result-schema.ts` defines structured results. The tool uses `{debugId?, stopId?, request:{action,...}, sandbox_permissions?, justification?}`; legacy flat calls normalize in public SDK `prepareArguments` and direct execution. Mixed/invalid envelopes reject. No generic DAP escape hatch exists.

`help` exposes input/result schemas and action-specific usage, including adapter caveats. Pass `topic` with an action name for one focused entry; omit it for the full action list. Detailed recipes live in `usage.ts` and load through help rather than every system prompt; the always-present guidelines retain target/reference, wait, condition and permission boundaries. Start/restart/stop use `data.session`, stack uses `data.frames`, registers uses `data.scopes`; positive variable references may require multiple paged expansions, bounded with a visited set. Known target/stop errors use stable codes; schema/permission/capability/adapter failures may reject instead. See [script result boundaries](native-mcp-codemode.md#script-results-and-completeness).

`wait` passively observes one named target, with `afterRevision`, `until: stopped|changed`, and 0–60,000-ms `waitMs`. `changed` compares revision, `settled` describes a loaded stop or terminal state, and `timedOut` describes the condition deadline; timeout and settled can both be true. Terminal targets return immediately. Omit `afterRevision` when the current stop suffices. Use passive wait after control returns `settled:false`; do not resend the step. Control itself accepts 500–120,000 ms, never zero. Pause is `action: control, control: pause`.

Model actions that may execute code—including discovery, evaluate and conditional breakpoints—require execution-capable sandbox mode and recheck after permission awaits. Plan rejects debug. Human pane actions are direct user actions. DAP watch context is not a guarantee of side-effect-free evaluation.

## Source identity and native inspection

`DebugSourceDTO` distinguishes disk files from adapter sources. Positive `sourceReference` always wins over a path and uses typed `debug:source`, never file IO. Frames keep opaque instruction addresses/module IDs; variables retain `memoryReference`; scopes retain register hints. Addresses remain strings; arithmetic uses BigInt.

Virtual-source caches are separate from disk previews, keyed by target/reference/version and invalidated by stop/resume/termination/source events. Each target caches up to eight documents of at most 1,048,576 UTF-16 units; larger adapter replies are refetched, and IPC still returns bounded pages. Async replies recheck stop, frame and source version. Source/Assembly/Memory/Modules panes select native inspection when local source is absent.

| Action | Bound/contract |
| --- | --- |
| source | At most 32,768 UTF-16 units / 100 lines per page, with offset/continuation metadata |
| disassemble | Opaque memory reference; byte/instruction offsets distinct; at most 200 instructions |
| memory.read | At most 4096 bytes; actual/unreadable counts and short-read flag, never zero-filled gaps |
| registers | Register scopes expanded using ordinary paged variables |
| modules | At most 100 rows, detecting ignored adapter paging |
| control | Statement/line/instruction granularity only when supported |
| function/instruction breakpoints | Complete sets up to 256, serialized and stop-fenced |

Instruction addresses clear on every restart because ASLR can move them; named/source intent survives. Panel update actions merge within main's write queue, retaining conditions and other writers' entries. Controls wait for admitted breakpoint writes. Restart reserves ownership through native/fallback startup and transfers watches/selection by replacement identity.

## Core and protocol invariants

LLDB core uses DAP `attach` with `coreFile` and optional `program`. It permits supported stack/scopes/variables/registers/source/disassembly/read-only memory/modules. Execution, restart, evaluate and breakpoint writes are denied, as are adapter-command overrides. Captured pages, symbols and binary compatibility determine what is readable.

Send launch/attach before configuration, but await its response only after initialized, initial breakpoints and supported configurationDone. LLDB/debugpy use stdio; built-in Delve/js-debug use loopback TCP. Validate local launch entries against the actual debuggee cwd, retaining Python module and explicit remote semantics.

Each stop invalidates variable/frame state. Paging detects adapters that ignore start/count; cycle expansion is bounded. Stale top-frame fill cannot settle a later continue. Output retains the terminal event's final burst. `runInTerminal` validates the owning window, cancellation and argv/env construction before command delivery; late cancelled terminals close without launch, and target cleanup owns successful terminals.

DAP verified confirms breakpoint binding, not condition compilation. LLDB condition diagnostics may arrive after the stop and publish separately. Preserve raw substituted errors, mark unvalidated/error conditions, and never silently rewrite or execute expressions again to validate them.

## Verification

```sh
node scripts/check-debug-actions.mjs
node scripts/check-debug-protocol.mjs
node scripts/check-debug-regressions.mjs
node scripts/check-debug-adapters.mjs
node scripts/check-debug-ui.mjs
node scripts/check-debug-native.mjs
node scripts/check-debug-native-ui.mjs
node scripts/check-debug-conditions.mjs
node scripts/check-debug-sessions.mjs
node scripts/check-debug.mjs
```

UI/native-UI checks require a build. Native checks use temporary binaries/core dumps and installed adapters; missing adapters are SKIP, not runtime coverage. Protocol construction checks do not prove another operating system's runtime. These scripts do not install adapters. Also run terminal and subagent role/settings checks for ownership changes. Fixture usage is in [debug fixtures](debug-fixtures.md).
