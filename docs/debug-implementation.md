# DAP debugging: ownership and P2 boundaries

`debug` is an app-owned custom tool. Settings → General enables exposure; it is
registered independently of that switch so existing sessions can apply the live
setting. The right-rail pane and file gutter use the same main-process manager.

## Ownership

- A chat owns up to 16 live targets (32 app-wide), each with a unique `debugId`.
  `debug({action: "sessions"})` lists only the calling chat's targets. An explicit
  id is always checked against the owning `sessionPath`; it cannot address a
  parent or sibling agent's debugger. Calls without an id reject ambiguity.
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
  cannot cancel the SIGKILL deadline. Failed cleanup retains the lease and reports
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
source-less debugging investigation and proposed tool schema evolution.

## Core dump inspection

```json
{"action":"start","adapter":"lldb-dap","kind":"core","coreFile":"/absolute/path/app.core","program":"/absolute/path/app"}
```

This uses LLDB's DAP `attach` request with `coreFile`, corresponding to `lldb -c`.
`program` is optional and supplies the executable/symbols when needed. The core
exposes threads, stack, scopes and variables. Execution control, restart,
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
| `node scripts/check-debug-protocol.mjs` | Production client/manager, deterministic stdio/TCP peers: handshake, silent import, child targets, ownership, cancellation, crash cleanup with a SIGTERM-resistant child, terminal cleanup leases, read-only discovery/evaluate denial, replacement ids, stale fills, paged/unpaged 1/50/51/105-item lists, structured errors, bounded output, JSONC and POSIX/Windows command construction |
| `node scripts/check-debug-regressions.mjs` | Cross-checkout leases through cancellation/restart/cleanup, launch-tree breakpoint retention and isolation, imported Python module requests; real LLDB external-cwd restore fences, debugpy module debugging and js-debug native restart/clear |
| `node scripts/check-debug-ui.mjs` | Real Electron/beUI pane: parent/subagent selection, roster/missed-event recovery, owner-scoped controls and file gutter, restart watch transfer, explicit-selection preservation, both locales/themes, keyboard variables/gutter, 20px bounded source rows, condition diagnostics, repeated stops, frame-specific watches, source lines, final console tail, core controls |
| `node scripts/check-debug-conditions.mjs` | Real LLDB raw strcmp error diagnostics and recovery, correctly typed function condition, non-function condition, and unconditional breakpoints |
| `node scripts/check-debug-sessions.mjs` | Real LLDB launch/attach/control, variables, conditional/log breakpoints, restart, TCP, JSONC, and generating/loading an actual core dump |
| `node scripts/check-debug.mjs` | Adapter doctor using production detection/manager; available adapters run real fixture programs, missing adapters print SKIP |
| `node scripts/check-subagents.mjs` | Role flag persistence, dispatch grant, parent ceiling and resume narrowing with real SDK session files |
| `node scripts/check-subagent-settings.mjs` | Per-role checkbox, independent defaults, failed save, normal tool editor, both locales and form geometry |
| `node scripts/check-terminal.mjs` | Real PTY ownership and tree exit, main-initiated debug cleanup/exit page, output accounting, resize, colors, shutdown and renderer reload |

On the macOS host (2026-09-27), real launch, breakpoint, stack, scopes, variables,
evaluate and disconnect pass for **all four** adapters: Apple LLDB 21.0.0,
debugpy 1.8.21, Delve 1.27.2 and js-debug 1.140.0. Actual LLDB core dump inspection
also passes. At the user's request, debugpy was installed in the current Python
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
