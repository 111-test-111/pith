# DAP debugging: actions, ownership and native inspection

`debug` is an app-owned custom tool. Settings → General enables exposure; it is
registered independently of that switch so existing sessions can apply the live
setting. The right-rail pane and file gutter use the same main-process manager.

## Ownership

- A chat owns up to 16 live targets (32 app-wide), each with a unique `debugId`.
  `debug({request: {action: "sessions"}})` lists only the calling chat's targets. An explicit
  id is always checked against the owning `sessionPath`; it cannot address a
  parent or sibling agent's debugger. Calls without an id reject ambiguity.
- `sessions` includes ended targets so their console and termination diagnostics
  remain readable. Cleanup releases their processes and checkout leases; the
  manager retains the ten newest fully cleaned-up targets across chats until
  later cleanup prunes them or the app exits. This is bounded history, not ten
  live processes. Select live targets with
  `data.sessions.filter(s => ['starting', 'running', 'stopped'].includes(s.status))`;
  then choose an explicit `debugId`, rather than assuming the last row is live.
- Renderer requests always include `debugId`. The selector and gutter use the
  same selection. Inspection and controls carry `stopId`; each stopped event
  increments it, including running/stopped events batched into one render.
- Standalone js-debug has a launch connection and adapter-owned target
  connections. `startDebugging` opens another socket on the same server with
  `__pendingTargetId`. Inspect/step a stopped child target; stopping the root
  closes its target tree. This DAP target hierarchy is distinct from agent roles.
- Startup registers ownership before asynchronous discovery. Cancellation is
  checked after discovery, checkout admission, transport startup and handshake.
  All DAP event/request waiters reject on close. Adapter disposal is awaited.
- The manager holds a `CheckoutCoordinator` process lease until adapter and
  child-target and owned-terminal cleanup completes. The owning chat's
  `workspaceCwd` is independent of the debuggee's `cwd`: both canonical checkout
  identities are fenced (once when they resolve to the same checkout). A failed
  or cancelled second acquisition releases the first reservation. Restarts and
  adapter-owned children preserve the same owner. POSIX adapter groups are
  terminated even when the group leader has already crashed; a surviving child
  cannot cancel the SIGKILL deadline. A transient macOS `EPERM` while reaping
  remains a potentially live group and is retried within that deadline; only
  `ESRCH` confirms group exit. Failed cleanup retains the lease and reports
  a failed session. Windows uses `taskkill /T /F` while the owned adapter is live;
  if its root already exited, cleanup cannot prove its descendants are gone and
  retains the checkout fence instead of guessing from a dead/reused PID.
  Chat switching keeps targets alive; Stop,
  deletion, rewind disposal and app shutdown close owned targets. Attach uses
  detach semantics; launch disconnect requests debuggee termination.
- Up to ten completed sessions retain their console data in memory. Main and
  renderer console retention are bounded to 65,536 UTF-16 code units. Nothing
  reconnects to an old process or restores debug sessions after app restart.

## Subagent role control

Settings → Subagents exposes **Enable debug for this role**, stored as the
boolean `debug:` frontmatter field. It defaults to false, even with `tools: all`
or an explicit legacy `debug` entry in `tools:`. The dedicated field is the sole
profile-level grant. The parent's active tools and global debug switch remain
upper bounds. Changes apply on the next dispatch or resume, not midway through
an already dispatched run.

Each child owns fresh debug sessions under its own child session path. It never
inherits the parent's sessions and cannot address a sibling's sessions. On
completion or stop, its debugger is closed even when the child transcript is
currently open. Resume starts with no live debugger, preserves the frozen tool
ceiling and may only narrow it: disabling the role's flag removes debug on
resume; enabling it cannot widen an earlier run that lacked debug.

The human Debug pane includes targets owned by the visible chat's subagent
roster. Its selector labels the owning profile/task separately from DAP child
targets. `useDebugTargets` shares that selection with the source gutter and
refreshes lists when roster membership changes; every action uses the selected
target's own session path. This never activates a child chat or broadens a model's
tool access. Completed targets retain their bounded console, and replacement
targets carry selection/watches across a restart even in the parent's view.

See [next steps and the Oh My Pi comparison](debug-next-steps.md) for the
original investigation and Oh My Pi comparison. The registry, source identity
and LLDB native inspection described below are now implemented.

## Action registry and compatibility

`src/main/debug/action-registry.ts` owns each action's TypeBox schema, handler,
read/execute policy, stopped/target requirement, core allowance and capability
requirement. It generates the tool's nested discriminated union. The model tool
and renderer dispatcher use these same handlers; only context-dependent start,
adapters and launch-configuration discovery are supplied by the tool wrapper.
The outer schema stays at five fields: `debugId`, `stopId`, `request`,
`sandbox_permissions`, and `justification`. No generic DAP escape hatch is exposed.

Script results use the app result envelope, with action-specific schemas in
`result-schema.ts`. `data.session` always holds start/restart/stop results;
`data.frames` holds stack rows and `data.scopes` holds register scopes. Expand a
scope's positive `variablesReference` with `variables`; an adapter may return
groups (for example LLDB's General Purpose Registers) whose own positive
references need another expansion. The hierarchy depth is adapter-defined.
Page each level using `start`/`count`, inspect `truncated`, and stop expanding at
reference 0; bound traversal and track visited references to avoid cycles.
Keep `debugId` and `stopId` pinned throughout. The legacy
text presentation and IPC result shapes remain unchanged. Known state failures
carry `DEBUG_SESSION_NOT_FOUND`, `DEBUG_NOT_STOPPED`, `DEBUG_SESSION_ENDED`, or
`DEBUG_STALE_STOP`, rather than one combined stale/running error.

`wait` requires `debugId`, accepts `afterRevision`, `waitMs` (0–60,000; default
10,000) and `until` (`stopped` by default or `changed`). It subscribes to that
target's state changes without sending DAP requests; a stop is ready after its
top-frame fill. Registration cannot miss a stop that just arrived. It returns
the current session/revision, `changed`, `settled` and `timedOut`. Cancellation,
timeout and completion release listeners. Terminal targets return immediately.
Use it after a control returns `settled:false`, without re-sending the step.

The flags answer different questions:

- `changed` compares the returned revision with `afterRevision`, or with the
  revision at call admission when omitted. A revision can change while running.
- `settled` means the target is stopped with top-frame loading complete, or is
  terminal (`terminated`/`failed`). It does not mean the wait condition occurred.
- `timedOut` means the wait deadline expired before its condition was observed.
  It can be true together with `settled:true`: an already stopped target can
  remain unchanged throughout `until:"changed"`.

| Observation | `changed` | `settled` | `timedOut` |
| --- | --- | --- | --- |
| Already stopped; `until:"stopped"`, no `afterRevision` | false | true | false |
| Already stopped, no newer revision; `until:"changed"` reaches its deadline | false | true | true |
| Still running, no newer revision when the deadline expires | false | false | true |
| New running revision satisfies `until:"changed"` | true | false | false |
| New stop finishes loading before the deadline | true | true | false |

Passing `afterRevision` also requires a newer revision for `until:"stopped"`;
omit it when the current stop is sufficient. Terminal targets always return
immediately, even at the same revision, so inspect `session.status` before
requesting stack/variables. `waitMs:0` is valid for `wait` and makes one immediate
observation. `control` instead accepts 500–120,000 ms and sends a control request;
its schema rejects `waitMs:0` before resuming the target. Pause is
`request:{action:"control",control:"pause"}`, not `action:"pause"`.
Cancelling a passive wait releases only its waiter; it does not stop the target.

Known state failures and rejected validation/adapter calls intentionally have
different representations; scripts must handle both. See the
[failure boundary table](native-mcp-codemode.md#script-results-and-completeness).

Local file launches for LLDB, debugpy and js-debug validate the program against
the launch cwd before spawning. Python modules, Go packages and explicit remote
or adapter-command configurations retain their adapter semantics; Go `exec`
does validate its local binary. These checks never treat adapter source
references as disk paths.

```json
{"debugId":"target-id","stopId":3,"request":{"action":"disassemble","memoryReference":"0x100003cc","count":32}}
```

SDK `prepareArguments` normalizes existing flat calls before validation;
`execute` also normalizes direct callers. Legacy source breakpoint arrays become
`items: [{line, condition?, hitCondition?, logMessage?}]`. Mismatched parallel
arrays, extra fields from another action, and mixed old/new envelopes reject.
`help` lists action policies. This reduces parameter coupling, not the cost of
sending the complete schema to the model. OMP-style lazy discovery still needs
an SDK/provider integration; no unsupported `loadMode` property is simulated.

Execution policy still belongs to the live tool owner: discovery, start/stop,
restart, controls, evaluate and all breakpoint writes require executable sandbox
mode. Enablement/Plan admission is checked again after awaiting permission.
The panel represents direct human actions. Its reference requests require a
stop token; new model native-reference actions require `debugId` and `stopId` too.
Legacy inspection calls without stop tokens remain compatible.

## Source identity and native LLDB workflow

`DebugSourceDTO` distinguishes `{kind:"file",path}` from
`{kind:"adapter",sourceReference,path?}`. A positive reference always wins over
path, including LLDB's synthetic `binary` + backtick + `symbol` paths. Only file
sources populate the legacy `file` field. Frames and stop locations retain
`instructionPointerReference` and `moduleId`; variables/evaluate retain opaque
`memoryReference`; scopes retain `presentationHint` and child counts. Addresses
stay strings. Explicit hex comparisons/offsets use BigInt, never Number.

Virtual source uses the typed `debug:source` preload/IPC method and DAP `source`,
with main-owned raw source metadata. Its cache is per target/reference/version,
separate from disk previews, at most eight 256 Ki-character documents per target.
Stop/resume/termination and `loadedSource`/`invalidated` events invalidate content;
old responses check both stop and source version before publishing. Invalidated
frame/variable references advance the stop token even without a continued event.
Capabilities are a typed, selected snapshot and follow DAP capability updates.

The pane provides Source / Assembly / Memory / Modules tabs. Missing local source
falls back to assembly; adapter source never reaches file IO. PC is highlighted,
instruction rows toggle instruction breakpoints, addresses and variable memory
references open memory, and register scopes have a separate expandable group.
Step granularity persists per target across stops and replacement restarts.
Unsupported operations are hidden/disabled and main independently rejects them.

| Action | Contract / bound |
| --- | --- |
| `source` | `sourceReference` plus session `sourceVersion`; 256 Ki characters, explicit truncation |
| `disassemble` | Opaque `memoryReference`, distinct byte `offset` and `instructionOffset`; default 64, max 200 instructions |
| `memory.read` | Default 128, max 4096 bytes; bounded base64 + hex, actual byte count, unreadable count and short-read flag; never zero-fill gaps |
| `registers` | Selected frame's register scopes, expanded/paged with `variables`; no invented DAP register request |
| `modules` | Default 50, max 100 modules, symbol status/path; probes ignored count/start paging and bounds displayed results |
| `control` | Optional statement/line/instruction granularity, forwarded to next/stepIn/stepOut only when supported |
| `breakpoints.instruction` | Complete `items` set, max 256; serialized with source/function writes and fenced to a stop |
| `breakpoints.function` | Complete named `items` set, max 256; same permission and conditional-diagnostic rules |
| `breakpoints.native` | Current instruction/function bindings; condition binding is never evaluation validation |

Absolute instruction breakpoints are cleared before native restart and omitted
from fallback restart, because ASLR can relocate the program. Function and source
intent survives restart. Breakpoint events update native bindings/removal, and
instruction toggles resolve bound offsets without discarding another breakpoint.
Panel add/remove actions merge inside the main write queue (`breakpoints.*.update`),
so a stale renderer list cannot overwrite another writer's breakpoint or its
conditions. A control waits for previously admitted breakpoint writes before resuming.
Restart reserves the target through native execution or the fallback replacement's
complete startup, so concurrent model/panel restarts cannot launch duplicates.
Native restart rechecks live admission and cancellation after queued writes and
after clearing instruction addresses, before sending the execution request.

Core reads still depend on the dump's captured pages and matching binaries.
Missing pages produce adapter errors or explicit short reads. A symbols-bearing
core with deleted local source is covered by the real test; complete code/memory
availability for every sparse or foreign core is not promised. Data watchpoints,
memory writes and remote adapter profiles are outside this increment.

## Core dump inspection

```json
{"request":{"action":"start","adapter":"lldb-dap","kind":"core","coreFile":"/absolute/path/app.core","program":"/absolute/path/app"}}
```

This uses LLDB's DAP `attach` request with `coreFile`, corresponding to `lldb -c`.
`program` is optional and supplies the executable/symbols when needed. The core
exposes threads, stack, scopes, variables/registers, adapter sources, disassembly,
read-only memory and modules when supported. Execution control, restart,
breakpoints and executable evaluate expressions are rejected; the pane reflects
that boundary. Core mode rejects adapter command overrides from launch.json.
Symbols, source mapping and core portability still depend on the local LLDB and
the binary/library versions used to create the dump.

## Protocol and UI invariants

Launch/attach is sent before configuration, but awaited only after `initialized`,
initial breakpoints and supported `configurationDone`. This supports adapters
that defer their launch response until configuration completes. LLDB/debugpy use
stdio; built-in Delve/js-debug spawn TCP servers on allocated loopback ports.
Launch entry validation uses the adapter's final request. An imported debugpy
`module` configuration launches without `program`; supplying an explicit script
replaces that module entry. The named configuration still comes from the chat's
workspace when a tool call overrides the debuggee's working directory.

Breakpoint replacements are serialized. Gutter toggles operate on authoritative
requested definitions, retaining conditions, hit conditions and log messages.
Fallback restart installs the original requested breakpoints before configuration
completes. Its `replacesId` follows the selected target and copies watches to the
replacement, including model-initiated restarts; switching to another target while
the restart is pending keeps that selection. DAP breakpoint events update
verification, relocation and removal. The gutter composes beUI Button and supports
Tab/Enter/Space without changing the virtualized 20px source rows.
For js-debug, completed breakpoint edits also belong to the launch tree, so new
child targets recover them after native or fallback restart. Conditions, hit
conditions, log messages and intentional clears are retained; adapter binding ids
stay per target. Configuration replay and target teardown do not overwrite those
retained edits, and independent launch trees never share them.

All model actions capable of executing code—including adapter discovery (which
may run workspace Python), evaluate and conditional
breakpoints—require an execution-capable sandbox mode. Plan mode rejects the debug
tool. Watch uses DAP `context: "watch"` and the selected frame, once per stop/frame
or watch-list change; watch context is not a promise of side-effect-free execution.
Renderer actions are direct human actions, as with the interactive terminal.

Each stop remounts inspection state. Async details are fenced by stop and frame,
variable references are never reused across stops, and cyclic variable handles
cannot recurse without bound. A stale top-frame fill cannot settle a later
continue. Variable paging probes `count=1`/`start=1` to detect ignored paging, then
pages locally for those adapters; a 51-item list cannot endlessly repeat page one.
The bounded per-reference paging classification is cleared at every stop/resume.
Buttons/selectors/disclosures compose beUI controls;
source links preserve the destination line. Output fetches the full bounded tail,
including a terminal event's last burst. `runInTerminal` creates the shell first;
main validates the matching window's reply and cancellation before sending any
command. Late cancelled replies close the unused terminal. Successful replies
also transfer terminal cleanup ownership to the target; cleanup awaits the PTY
host and delivers its exit status to the renderer. POSIX env unsets precede
assignments, and all argv/assignment values are quoted. Windows uses an encoded
PowerShell ProcessStartInfo launcher with native argv quoting and per-child env
updates/removals, so cmd.exe does not interpret adapter-provided text.

## Conditional breakpoints and LLDB diagnostics

DAP `verified` confirms binding, not that a condition compiled or evaluated true.
Conditional breakpoints carry `conditionStatus: "unvalidated"`; a reported LLDB
condition error changes it to `"error"` and retains the diagnostic. Stop snapshots
preserve `stopDescription`, `stopText`, `hitBreakpointIds`, bounded
`stopDiagnostics` and `conditionError`. Important output can arrive after the stop
event, so it publishes immediately; the console remains available for later
messages. Failed responses preserve DAP `body.error.format` and substituted
variables rather than only the short error code. The pane shows the condition and
its error in both languages. No expression is silently rewritten or executed a
second time for validation.

Apple LLDB 21 reproduces the reported `strcmp` error: it binds the breakpoint,
stops on a nonmatching key with reason `breakpoint`, and emits the expression
compiler error separately. `(int)strcmp(key, "tr-d096a4e4") == 0` works when the
function's declared return type is supplied. The real regression checks raw
diagnostics, that cast, an expression without function calls, and unconditional
breakpoints against two distinct keys.

The reported settlement fixture was also replayed without editing it:
`dap-comparison/base/index.c:22` cannot observe `slot->state == 2`, because line 21
returns for every state other than 1. Its simple condition correctly never hits.
Moving the breakpoint to line 21 with
`slot->state == 2 && (int)strcmp(key, "tr-d096a4e4") == 0` stops at the expected
key with `state=2`. A single missed hit is not evidence of broken simple conditions.

## Verification and environment coverage

| Check | Coverage |
| --- | --- |
| `node scripts/check-debug-actions.mjs` | Registry and installed SDK validation; legacy normalization; shared panel routing; core/permission/capability checks; source identity/ownership/invalidation; opaque and >53-bit references; memory gaps; honored/ignored module paging; stale async replies; serialized native breakpoint writes/events and restart clearing |
| `node scripts/check-debug-native.mjs` | Real stripped binary with source deleted: virtual source → PC/disassembly → register groups/memory/modules → instruction step → instruction breakpoint hit → restart; separate symbols-without-source function breakpoint hit/retention; real generated core reads and execution rejection |
| `node scripts/check-debug-native-ui.mjs` (after build) | Real Electron + production manager/registry + built preload IPC + LLDB; stripped binary, virtual source, instruction step and breakpoint hit, memory, registers and modules |
| `node scripts/check-debug-protocol.mjs` | Production client/manager, deterministic stdio/TCP peers: handshake, silent import, child targets, ownership, cancellation, crash cleanup with a SIGTERM-resistant child, terminal cleanup leases, read-only discovery/evaluate denial, replacement ids, stale fills, paged/unpaged 1/50/51/105-item lists, structured errors, bounded output, JSONC and POSIX/Windows command construction |
| `node scripts/check-debug-regressions.mjs` | Cross-checkout leases through cancellation/restart/cleanup, launch-tree breakpoint retention and isolation, imported Python module requests; real LLDB external-cwd restore fences, debugpy module debugging and js-debug native restart/clear |
| `node scripts/check-debug-ui.mjs` | Real Electron/beUI pane: parent/subagent selection, roster/missed-event recovery, owner-scoped controls and file gutter, restart watch transfer, explicit-selection preservation, both locales/themes, keyboard variables/gutter, 20px bounded source rows, condition diagnostics, repeated stops, frame-specific watches, source lines, final console tail, core controls; native virtual-source IPC, missing-file fallback, PC, register memory, gaps, modules paging, instruction/function breakpoints, owner/stop routing at 320px in both locales/themes |
| `node scripts/check-debug-conditions.mjs` | Real LLDB raw strcmp error diagnostics and recovery, correctly typed function condition, non-function condition, and unconditional breakpoints |
| `node scripts/check-debug-sessions.mjs` | Real LLDB launch/attach/control, variables, conditional/log breakpoints, restart, TCP, JSONC, and generating/loading an actual core dump |
| `node scripts/check-debug.mjs` | Adapter doctor using production detection/manager; available adapters run real fixture programs, missing adapters print SKIP |
| `node scripts/check-subagents.mjs` | Role flag persistence, dispatch grant, parent ceiling and resume narrowing with real SDK session files |
| `node scripts/check-subagent-settings.mjs` | Per-role checkbox, independent defaults, failed save, normal tool editor, both locales and form geometry |
| `node scripts/check-terminal.mjs` | Real PTY ownership and tree exit, main-initiated debug cleanup/exit page, output accounting, resize, colors, shutdown and renderer reload |

On the macOS host (2026-09-27), real launch, breakpoint, stack, scopes, variables,
evaluate and disconnect pass for **all four** adapters: Apple LLDB 21.0.0,
debugpy 1.8.21, Delve 1.27.2 and js-debug 1.140.0. Actual LLDB core dump inspection
also passes. `PI_DEBUG_SCREENSHOT_DIR` retains native and subagent panel screenshots
for either UI suite. The new native loop passes on Apple ARM64; this does not
imply native runtime coverage on other operating systems. At the user's request, debugpy was installed in the current Python
user environment, Delve in `~/.local/bin`, and the official standalone js-debug
release in `~/.pi/agent/debug-adapters/js-debug`. The release archive's SHA-256 was
checked against its published digest. Detection now checks that standalone
location; current VS Code extension bundles may not contain `dapDebugServer.js`.
The temporary nightly VS Code extension used to check that distinction was removed.

Windows command construction is covered by protocol assertions; this macOS run
does not constitute Windows runtime coverage. A skipped adapter is never counted
as a real runtime pass. These checks themselves do not install packages.

The review repairs also cover startup waiter cleanup, deferred launch deadlocks,
Python discovery, TCP transport selection, js-debug child sessions, Rewind leases,
startup cancellation, read-only evaluate, stale variable caches, restart/gutter
breakpoint loss, breakpoint events, JSONC string preservation, env argument order,
final console paging, watch frequency/context, source-line navigation and beUI
keyboard controls.

Protocol references: [LLDB core-file attach](https://github.com/llvm/llvm-project/tree/main/lldb/tools/lldb-dap#loading-a-core-file),
[js-debug standalone server](https://github.com/microsoft/vscode-js-debug/blob/main/src/dapDebugServer.ts),
[Delve DAP usage](https://github.com/go-delve/delve/tree/master/service/dap).
