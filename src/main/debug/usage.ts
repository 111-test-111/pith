import type { DebugActionName } from './action-registry'

/** Detailed recipes are returned by debug help, rather than injected into
 * every coding request. Related actions share each adapter caveat. */
const workflows: Array<{ actions: DebugActionName[]; text: string }> = [
  { actions: ['help'],
    text: 'Use {debugId?, stopId?, request: {action, ...}}. Parameters belong to their action; help lists actions, permissions and capabilities. Old flat calls remain compatible.' },
  { actions: ['source', 'disassemble', 'memory.read', 'modules'],
    text: 'Source-less workflow: stack retains instructionPointerReference/moduleId/source. source.kind=adapter MUST use source with sourceReference + sourceVersion from the session, never read its path as a file. source returns a bounded window; use startLine for a distant stop and offset for subsequent pages. disassemble takes the opaque PC as memoryReference; memory.read reads bounded bytes/gaps; registers returns register scopes to expand with variables. modules pages loaded modules and symbol status.' },
  { actions: ['breakpoints.instruction', 'breakpoints.function'],
    text: 'Native breakpoint sets: breakpoints.instruction items [{instructionReference,offset?,condition?,hitCondition?}] and breakpoints.function items [{name,condition?,hitCondition?}] replace their entire sets. Pass debugId + current stopId. Instruction addresses are cleared on restart (ASLR); re-fetch PC/disassembly. Function names persist. breakpoints.native lists their bindings; verified is not condition validation.' },
  { actions: ['control', 'disassemble', 'memory.read', 'modules', 'breakpoints.instruction'],
    text: 'Use control granularity=instruction for real instruction next/stepIn/stepOut only when supportsSteppingGranularity is true; no silent fallback to source stepping. Capability flags in each session gate disassembly, memory, native breakpoints and modules. New reference operations require debugId and stopId; opaque references are strings, never convert them to numbers.' },
  { actions: ['start'],
    text: 'Reach for the debugger when a program crashes, hangs, or corrupts state: attach or launch, set breakpoints, step, and read the real frames and variables instead of sprinkling print statements. For a short-lived target, pass initial source breakpoints [{file,items:[{line,condition?,hitCondition?,logMessage?}]}] or functionBreakpoints [{name,condition?,hitCondition?}] to start so they bind before configurationDone. Small deterministic reproducers are still faster with plain bash.' },
  { actions: ['sessions'],
    text: 'Multiple debug sessions may run in this chat. sessions includes retained ended targets for console inspection; starting/running/stopped are live, terminated/failed are ended. Pass debugId on every targeted action when more than one is live. Child agents own separate sessions: parent and siblings cannot inspect or control them.' },
  { actions: ['wait'],
    text: 'control actions (continue/next/stepIn/stepOut/pause) block until the debuggee stops again or waitMs expires (500–120000 ms). Pause is request:{action:"control",control:"pause"}. settled=false means it is running or still loading a stop. Use {debugId,request:{action:"wait",afterRevision:session.revision,waitMs:10000}} to passively await a newer stop or termination; never send another step just to wait. wait accepts 0–60000 ms, can observe any change with until="changed", is cancellable, and sends no DAP control request. Omit afterRevision to accept the current stop. settled describes target state, timedOut describes the wait: an unchanged stopped target can return both true. A terminal target returns immediately; check session.status before inspection.' },
  { actions: ['control'],
    text: 'Read stopReason, stopDescription, stopText, hitBreakpointIds, conditionError and stopDiagnostics after every control. "breakpoint" can also mean a condition failed to evaluate, especially in LLDB; inspect output before concluding a condition matched. "step" is a completed step; "entry" is process entry (macOS may stop in the dynamic linker). A continue after a breakpoint interrupted an LLDB step may first complete that step.' },
  { actions: ['scopes', 'variables', 'registers'],
    text: 'threads/stack/scopes/variables/evaluate require a stopped debuggee. Pass debugId + current stopId for scopes, variables and evaluate with frameId. stack gives frame ids, scopes give variablesReferences, variables expand one level per call (default page 50, truncated=true when more exist — page large arrays with start/count). registers returns scopes; their children may be register groups requiring further variables calls. Expand only positive references with bounded depth and a visited set; 0 is a leaf. Values are truncated server-side (256 chars per value, 2048 chars per evaluate result).' },
  { actions: ['control', 'scopes'],
    text: 'Frame ids and variablesReferences are recycled at every stop: after any control action, re-fetch stack/scopes/variables instead of reusing ids from an earlier stop.' },
  { actions: ['evaluate'],
    text: 'lldb-dap answers evaluate in REPL form — "(int) $0 = 7". The $N handle is real: reuse it in later evaluate expressions of the same stop.' },
  { actions: ['breakpoints'],
    text: 'breakpoints replaces the whole breakpoint set of one file: pass every item to keep. verified only reports binding, NOT expression validity or a true condition. conditionStatus=unvalidated remains until an adapter reports an error; never claim validation from verified=true. verified=false may be pending until a module loads. Use items:[{line,condition?,hitCondition?,logMessage?}] so each breakpoint owns its options. A condition normally stops when true but adapters may also stop on evaluation errors; hitCondition gates hit count and logMessage creates a logpoint.' },
  { actions: ['breakpoints', 'evaluate'],
    text: 'LLDB may parse C expressions as C++ and lack libc function return types. For a known int-returning function use its explicit declared type, e.g. (int)strcmp(key, "wanted") == 0. Verify the corrected expression in the stopped frame, replace the file\'s breakpoint set, then continue and inspect the actual values. Do not silently rewrite or re-evaluate arbitrary conditions: function calls can have side effects. A non-function alternative is comparing known fields/characters, but a single missed hit proves neither success nor failure. Check the bound line and preceding branches too: a condition cannot hit if an earlier return already excluded that state.' },
  { actions: ['output'],
    text: 'output pages the debug console with a cursor, like bash_task output.' },
  { actions: ['start'],
    text: 'Core inspection: start with adapter=lldb-dap, kind=core, coreFile and optional program for symbols (equivalent to lldb -c). It exposes stack/scopes/variables/registers, virtual source, disassembly, memory and modules when supported; control, restart, breakpoints and executable expressions are unavailable.' },
  { actions: ['sessions'],
    text: 'Standalone js-debug creates adapter-owned child targets. Use sessions to find the stopped child debugId for inspection/stepping; stop the root to stop the whole target tree.' },
  { actions: ['start'],
    text: 'Launching or stopping a debuggee is process control: the session sandbox mode gates it, and read-only refuses it. The debuggee itself is never file-sandboxed — a debugger needs full process-inspection rights by design.' },
  { actions: ['help'],
    text: 'When a debug session ends (stop, termination, crash), its status is terminal: start a fresh session instead of retrying control actions.' },
  { actions: ['restart'],
    text: 'restart re-runs the debuggee: native DAP restart when the adapter supports it, otherwise stop+start with the same options (the session id changes). Source/function breakpoints persist; absolute instruction breakpoints are cleared on every restart.' },
  { actions: ['configurations'],
    text: 'configurations lists .vscode/launch.json entries mapped onto adapters; start with configuration="<name>" to use one — explicit arguments override its values. Adapter-specific keys (sourceMaps, justMyCode, mode, …) pass through into the DAP request.' },
]

export function debugActionGuidance(action: DebugActionName): string[] {
  const topic = action.startsWith('breakpoints.instruction.') ? 'breakpoints.instruction'
    : action.startsWith('breakpoints.function.') ? 'breakpoints.function'
    : action.startsWith('breakpoints.') && action !== 'breakpoints.native' ? 'breakpoints' : action
  return workflows.filter(workflow => workflow.actions.includes(topic)).map(workflow => workflow.text)
}

