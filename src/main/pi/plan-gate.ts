/**
 * Plan Mode's runtime tool ceiling: the app-owned adapter that decides which
 * tools the model can actually call and which implementation answers a call.
 *
 * Three facts make this module worth its own file:
 *
 * - **Identity, not names.** `appDefinitions` is the exact `ToolDefinition[]`
 *   handed to the SDK as `customTools`. A registry entry is only `app`-owned
 *   when `session.getToolDefinition(name) === that definition`, so an extension
 *   that wins a name cannot be laundered into the Plan allow-list, and the
 *   execute wrapper calls the implementation object captured at materialization
 *   time — never a fresh same-name lookup.
 * - **Whole objects, not names.** For `read`/`grep`/`find`/`ls` Plan installs
 *   the app's own `createReadOnlyTools` objects (schema, description,
 *   prepareArguments and execute together), so a same-name extension override
 *   cannot keep its implementation by name.
 * - **Fail closed.** Provenance that is not `safe-read`, a captured app
 *   definition, or an explicitly reviewed extension definition is
 *   `unreviewed`, and an `unreviewed` tool never passes Plan. The reviewed
 *   registry starts empty on purpose: an unaudited `web_search`/`web_fetch` is
 *   absent, not silently trusted.
 *
 * The ceiling is enforced at three points, all reading live state:
 * the public agent-state tools accessor (what the model can see), `beforeToolCall` (what may
 * start, including after an awaited hook), and the wrapped `execute` (a
 * re-activated or old-schema reference). It is not a prompt or a name filter.
 */
import type { AgentSession, ExtensionActions, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent'
import { createAppReadTool } from './read-tool'
import { APP_BASH_TOOL_NAMES } from './bash-tools'
import { TODO_TOOL_NAME } from './todo-protocol'
import { JEV_TOOL_NAME } from './jev/protocol'
import { AGENT_STEER_TOOL_NAME, MESSAGE_PARENT_TOOL_NAME, SUBAGENT_TOOL_NAME } from './subagents/protocol'
import { ASK_USER_TOOL_NAME } from '../../shared/ask-user'
import { PRESENT_TOOL_NAME } from '../../shared/present'
import { IMAGE_TOOL_NAME } from '../../shared/image'
import { SCHEDULED_TASK_TOOL_NAME } from './scheduled-tasks/tool'
import { hasPlanOpening, cancelledPlanOpening } from './plan-approval-access'
import type { PlanController } from './plan-mode'
import { PLAN_ESCALATION_REFUSED, PLAN_SHELL_UNAVAILABLE } from '../sandbox/escalation'

/** The SDK's own read-only tool objects; the only trusted read implementations. */
export type PlanTool = ReturnType<typeof createReadOnlyTools>[number]

/**
 * Why a tool is in the effective view. `unreviewed` is the explicit "we did not
 * audit this implementation" bucket (SDK built-ins in normal mode, extension,
 * MCP, browser and code-execution tools); it is normal-mode-only by
 * construction, because Plan never admits it.
 */
export type PlanToolProvenance = 'safe-read' | 'app' | 'reviewed-extension' | 'unreviewed'

export interface EffectivePlanTool {
  name: string
  tool: PlanTool
  definition?: ToolDefinition
  provenance: PlanToolProvenance
}

export interface PlanGateOptions {
  session: AgentSession
  cwd: string
  controller: PlanController
  /** The app-owned definitions registered as the session's `customTools`. */
  appDefinitions: readonly ToolDefinition[]
  /** Frozen role ceiling (subagent children); undefined means no ceiling. */
  roleCeiling: () => readonly string[] | undefined
}

export interface PlanGate {
  /** Recompute the effective view from the CURRENT registry and live mode. */
  refresh(): void
  /**
   * Replace the app-AUTHORITATIVE active set (settings / role ceiling). Used by
   * the manager instead of the raw setter, so the SDK's own registry walk —
   * which feeds the FILTERED effective names back as "previous active" — can
   * never narrow the base that leaving Plan restores.
   */
  setAppActiveTools(names: readonly string[]): void
  /** Normal-mode selection, before Plan materializes its restricted view. */
  activeToolNames(): string[]
  /** Bind explicit extension selection separately from SDK registry refreshes. */
  bindExtensionRuntime(runtime: Pick<ExtensionActions, 'getActiveTools' | 'setActiveTools'>): void
  /** The last materialized effective view (catalog / capability readout). */
  tools(): readonly EffectivePlanTool[]
  /** Admit an SDK `ctx.executeTool()` call against the live definition and role ceiling. */
  admitNested(name: string, params: unknown, definition: ToolDefinition | undefined): string | null
  /** Restore the session's own setter and hook chain. */
  dispose(): void
}

/**
 * The reviewed-extension registry. Entries are exact `ToolDefinition`
 * identities audited in this repository — an extension's `source === 'sdk'`, a
 * file basename or a tool-name prefix is not evidence, and nothing here is
 * trusted by name. It is intentionally EMPTY: until a concrete adapter is
 * reviewed, `web_search`/`web_fetch` (and every other extension tool) stay
 * absent from Plan rather than being labelled reviewed.
 */
export const REVIEWED_EXTENSION_TOOLS: readonly ToolDefinition[] = []

/**
 * The names Plan substitutes with the app's own read-only implementations. The
 * replacement is keyed on the `createReadOnlyTools` objects, not on these
 * strings: a same-name extension definition never survives the swap.
 */
const SAFE_READ_NAMES = ['read', 'grep', 'find', 'ls'] as const

/** Derived from the SDK's own session type (pi-agent-core is not a direct dep). */
type BeforeHook = NonNullable<AgentSession['agent']['beforeToolCall']>
type BeforeContext = Parameters<BeforeHook>[0]
type BeforeResult = Awaited<ReturnType<BeforeHook>>

/** App tools the Plan ceiling may expose, by name, once identity is proven. */
const PLAN_APP_TOOLS: ReadonlySet<string> = new Set([
  'get_goal',
  ...APP_BASH_TOOL_NAMES,
  ASK_USER_TOOL_NAME,
  TODO_TOOL_NAME,
  JEV_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  AGENT_STEER_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
  // Only the root's app-owned submission definition is admitted.
  'submit_plan'
])

/** A child may investigate and report, never re-dispatch or submit a parent plan. */
const CHILD_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'get_goal', 'update_goal',
  SUBAGENT_TOOL_NAME,
  AGENT_STEER_TOOL_NAME,
  'submit_plan'
])

/** These app tools depend on a committed top-level result or orchestration
 * receipt. The SDK persists only a summary of nested calls, so running one
 * through ctx.executeTool would lose that state transition.
 *
 * `image` belongs here for the same reason: it writes its bytes to disk and its
 * deliverable is the returned preview, which a nested call would flatten into a
 * script result. */
const MODEL_ONLY_APP_TOOLS: ReadonlySet<string> = new Set([
  'update_goal',
  PRESENT_TOOL_NAME,
  IMAGE_TOOL_NAME,
  TODO_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  'submit_plan',
  SCHEDULED_TASK_TOOL_NAME,
  JEV_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  AGENT_STEER_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME
])

/** Escalation inputs must be refused in Plan, whether or not they are valid. */
function requestsEscalation(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false
  const record = params as Record<string, unknown>
  return record.sandbox_permissions !== undefined || record.justification !== undefined
}

const installed = new WeakMap<AgentSession, PlanGate>()

/**
 * Install (once per session) the tool ceiling on a root or child session. Must
 * run after the rewind recorder and the subagent result hook and before
 * `bindExtensions`, so the lazy `session_start` registrations are filtered by
 * the same rule as the initial set.
 */
export function installPlanGate(options: PlanGateOptions): PlanGate {
  const existing = installed.get(options.session)
  if (existing) return existing
  const gate = createGate(options)
  installed.set(options.session, gate)
  return gate
}

function createGate(options: PlanGateOptions): PlanGate {
  const { session, controller } = options
  const safeReads = new Map(
    createReadOnlyTools(options.cwd)
      .filter((tool) => (SAFE_READ_NAMES as readonly string[]).includes(tool.name as string))
      .map((tool) => [tool.name as string, tool])
  )
  // Use the same structured/paged read contract in both modes. This is a new
  // app-owned definition, never a same-name extension supplied by the model.
  const read = createAppReadTool(options.cwd)
  safeReads.set('read', { ...read, execute: (id, args, signal, update) =>
    read.execute(id, args as never, signal, update, undefined as never) })
  const appDefinitions = new Map<string, ToolDefinition>()
  for (const definition of options.appDefinitions) {
    if (definition && typeof definition.name === 'string') appDefinitions.set(definition.name, definition)
  }

  const originalSet = session.setActiveToolsByName
  // Pi 1.0 also replaces tools internally during registration, reload and
  // request preparation. All of those paths write the public AgentState
  // accessor, even when they do not call setActiveToolsByName(). Preserve its
  // copy-on-assignment semantics and avoid depending on private SDK methods.
  const toolsDescriptor = Object.getOwnPropertyDescriptor(session.agent.state, 'tools')
  if (!toolsDescriptor?.get || !toolsDescriptor.set || !toolsDescriptor.configurable) {
    throw new Error('Review Pi SDK AgentState.tools before installing the Plan gate')
  }
  const writeTools = (tools: AgentSession['agent']['state']['tools']): void => {
    toolsDescriptor.set!.call(session.agent.state, tools)
  }
  const previousFinish = session.agent.finishTurn
  const previousPrompt = session.agent.prompt
  const promptRun: typeof previousPrompt = async (...args) => {
    if (cancelledPlanOpening(controller)) throw new Error('plan-opening-aborted')
    if (!hasPlanOpening(controller)) controller.checkWorkAdmission()
    const messages = Array.isArray(args[0]) ? args[0] : [args[0]]
    const userOpening = messages.some(m => typeof m === 'string' || m.role === 'user')
    if (controller.submissionLocked && !userOpening) throw new Error('plan-already-submitted')
    // Pi 1.0's prompt is a prototype method, not a bound callback. Preserve
    // its Agent receiver as well as either overload's original arguments.
    return Reflect.apply(previousPrompt, session.agent, args)
  }
  session.agent.prompt = promptRun
  const previousContinue = session.agent.continue
  const previousHasQueued = session.agent.hasQueuedMessages
  // finishTurn ends the low-level loop, but AgentSession's outer post-run
  // loop still probes this method and would call continue repeatedly while a
  // submitted plan has queued user input. Keep the queue intact for the next
  // admitted turn while making this sealed run settle.
  const hasQueued: typeof previousHasQueued = () => !controller.submissionLocked && previousHasQueued.call(session.agent)
  session.agent.hasQueuedMessages = hasQueued
  // AgentSession also drains queues in _handlePostAgentRun AFTER finishTurn.
  // A sealed loop must leave those queues intact. The
  // public continuation adapter also stops explicit agent_before_settle
  // continuations: those can request work even when both queues are empty.
  const continueRun: typeof previousContinue = async (...args) => {
    if (controller.submissionLocked) {
      // abort marks the outer run synchronously and preserves pending queues.
      // Do not await: its idle promise is fulfilled only after this hook exits.
      void session.abort()
      return
    }
    controller.checkWorkAdmission()
    return previousContinue.apply(session.agent, args)
  }
  session.agent.continue = continueRun
  const previousBefore = session.agent.beforeToolCall
  /** The app's authoritative active set (settings / role ceiling). */
  let appNames: string[] = dedupe(session.getActiveToolNames())
  /**
   * Tools the SDK activated that the app did not list (lazy registrations).
   * They are NOT app-owned names. Preserve them across app re-application so
   * a dynamically registered extension tool survives a Plan round trip; its
   * definition still has to pass provenance checks in the restricted view.
   */
  let extras: string[] = []
  let effective: EffectivePlanTool[] = []
  let disposed = false
  let unbindExtensionRuntime: (() => void) | undefined

  /**
   * Identity-based provenance. `unreviewed` is a real answer, not a placeholder:
   * it is what keeps an unaudited definition out of Plan.
   */
  const classify = (name: string): PlanToolProvenance => {
    const definition = session.getToolDefinition(name)
    if (!definition) return 'unreviewed'
    if (appDefinitions.get(name) === definition) return 'app'
    if (REVIEWED_EXTENSION_TOOLS.includes(definition)) return 'reviewed-extension'
    return 'unreviewed'
  }

  const child = (): boolean => options.roleCeiling() !== undefined

  /** May this name run in the current restricted state? */
  const allowedInPlan = (name: string, provenance: PlanToolProvenance): boolean => {
    if (provenance === 'safe-read') return true
    if (provenance === 'unreviewed') return false
    if (provenance === 'app') {
      if (!PLAN_APP_TOOLS.has(name)) return false
      if (child() && CHILD_FORBIDDEN_TOOLS.has(name)) return false
    }
    if (name === 'bash' && (controller.snapshot.shellEnforcement ?? 'unavailable') !== 'full') return false
    return true
  }

  /**
   * Deny a specific call right now: admission (lock/closing), the submission
   * seal, and — under Plan — the name/provenance ceiling plus escalation
   * parameters (refused before any approval exists).
   */
  const checkCall = (name: string, params: unknown, provenance: PlanToolProvenance): string | null => {
    try {
      controller.checkWorkAdmission()
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    if (controller.submissionLocked) {
      return 'This planning turn is already sealed by a plan submission; no further tools run until the user sends a new message.'
    }
    if (name === 'submit_plan' && (!controller.restricted || child())) return 'submit_plan requires a root planning session.'
    if (!controller.restricted) return null
    if (!allowedInPlan(name, provenance)) {
      return name === 'bash'
        ? PLAN_SHELL_UNAVAILABLE
        : `[plan: the "${name}" tool is not available] Keep investigating with the read-only tools, or submit a complete plan for the user to approve.`
    }
    if (requestsEscalation(params)) return PLAN_ESCALATION_REFUSED
    return null
  }

  /** Call-time provenance must reflect the effective view, not the raw registry. */
  const provenanceForCall = (name: string): PlanToolProvenance => {
    if (controller.restricted && safeReads.has(name)) return 'safe-read'
    return classify(name)
  }

  /** Wrap the captured implementation so a stale reference still rechecks. */
  const wrapped = (tool: PlanTool, provenance: PlanToolProvenance): PlanTool => {
    // The registry's AgentTool carries the extension context as a 5th argument
    // that its declared type omits; keep it so app/extension tools still run
    // with their own context.
    // SAFETY: the registry's AgentTool declares four parameters while the
    // runtime passes a fifth (the extension context). The narrowed signature
    // only re-states that wider reality; `execute` is invoked with exactly
    // those arguments below, so width is preserved in both directions.
    const execute = tool.execute as unknown as (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown
    ) => Promise<unknown>
    const wrappedExecute = async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown
    ): Promise<unknown> => {
      const denial = checkCall(tool.name, params, provenance)
      if (denial) throw new Error(denial)
      return execute(toolCallId, params, signal, onUpdate, ctx)
    }
    // SAFETY: the only replaced field is `execute`, whose wrapper accepts and
    // forwards the same five arguments as the captured implementation, so the
    // result is still a `PlanTool` — the assertion cannot mask a shape drift.
    return { ...tool, execute: wrappedExecute } as unknown as PlanTool
  }

  const materialize = (registry = session.agent.state.tools): void => {
    const ceiling = options.roleCeiling()
    const restricted = controller.restricted
    const next: EffectivePlanTool[] = []
    const seen = new Set<string>()
    for (const tool of registry) {
      const name = tool.name
      if (name === 'submit_plan' && (!restricted || child())) continue
      if (seen.has(name)) continue
      if (ceiling && !ceiling.includes(name)) continue
      const isSafeRead = restricted && safeReads.has(name)
      const provenance: PlanToolProvenance = isSafeRead ? 'safe-read' : classify(name)
      // An internal SDK refresh may activate its registered custom tools by
      // default. Owned service toggles are authoritative in every mode.
      if (provenance === 'app' && !appNames.includes(name)) continue
      const definition = isSafeRead ? undefined : session.getToolDefinition(name)
      if (restricted) {
        if (!allowedInPlan(name, provenance)) continue
        if (isSafeRead) {
          seen.add(name)
          next.push({ name, tool: wrapped(safeReads.get(name)!, provenance), provenance })
          continue
        }
      }
      seen.add(name)
      // SDK registration snapshots descriptions. Jev capability
      // switches also affect live turns; refresh only this owned definition's
      // metadata, preserving the captured implementation and provenance gate.
      const current = name === JEV_TOOL_NAME && provenance === 'app' && definition
        ? { ...tool, description: definition.description } : tool
      next.push({ name, tool: wrapped(current, provenance), ...(definition ? { definition } : {}), provenance })
    }
    effective = next
    writeTools(next.map((entry) => entry.tool))
  }

  const activeToolNames = (): string[] => {
    const present = new Set(session.getAllTools().map((tool) => tool.name))
    return dedupe([...appNames, ...extras]).filter((name) => present.has(name))
  }

  const apply = (): void => {
    if (disposed) return
    originalSet.call(session, activeToolNames())
  }

  /**
   * The SDK's own setter. Its `previousActiveToolNames` comes from
   * `getActiveToolNames()`, i.e. the materialized (possibly Plan-filtered)
   * view, so its list must never replace the app's base: only the names it
   * genuinely ADDS are remembered, and the base is rebuilt from `appNames`.
   */
  const rememberSdkTools = (names: string[]): void => {
    const previous = new Set(effective.map((entry) => entry.name))
    for (const name of names) {
      if (typeof name !== 'string') continue
      if (previous.has(name) || appNames.includes(name) || extras.includes(name)) continue
      // Only non-app definitions are remembered here: an app tool (edit/write,
      // browser_*) is governed solely by the app list, so a reload walk that
      // re-activates a disabled one can never smuggle it back into the base.
      if (classify(name) === 'app' || safeReads.has(name)) continue
      extras.push(name)
    }
  }
  const setter = (names: string[]): void => {
    if (disposed) return
    rememberSdkTools(names)
    apply()
  }
  const setTools = (tools: AgentSession['agent']['state']['tools']): void => {
    if (disposed) { writeTools(tools); return }
    rememberSdkTools(tools.map(tool => tool.name))
    // This is an already prepared SDK loadout. Filter it directly; invoking
    // the session setter here would run prepareLoadout hooks a second time.
    materialize(tools)
  }
  Object.defineProperty(session.agent.state, 'tools', { ...toolsDescriptor, set: setTools })
  session.setActiveToolsByName = setter

  const beforeToolCall = async (context: BeforeContext, signal?: AbortSignal): Promise<BeforeResult> => {
    const batch = context.assistantMessage.content.filter(b => b.type === 'toolCall')
    if (batch.length > 1 && batch.some(b => b.name === 'submit_plan')) return { block: true, reason: 'submit_plan must be the only tool in its batch.' }
    const name = context.toolCall.name
    const first = checkCall(name, context.args, provenanceForCall(name))
    if (first) return { block: true, reason: first }
    const result = await previousBefore?.(context, signal)
    if (result?.block) return result
    // An awaited hook is exactly the window a mode change can enter: re-check
    // live state before the tool is prepared for execution.
    const changed = checkCall(name, context.args, provenanceForCall(name))
    return changed ? { block: true, reason: changed } : result
  }
  session.agent.beforeToolCall = beforeToolCall
  const finish: typeof previousFinish = async (context, signal) => controller.submissionLocked
    ? { action: 'end' } : (await previousFinish?.(context, signal)) || undefined
  session.agent.finishTurn = finish

  // Materialize immediately: a session reopened in Plan must never expose the
  // registry's full set even for the first few ms before bindExtensions.
  materialize()

  return {
    refresh: () => apply(),
    setAppActiveTools: (names: readonly string[]) => {
      if (disposed) return
      appNames = dedupe(names)
      // `extras` is deliberately NOT cleared: it holds only non-app definitions
      // the SDK activated on its own (lazy registrations the loader does not
      // list), and those must survive an app re-apply. App-owned names can
      // never be in it, so a settings change still takes full effect.
      apply()
    },
    activeToolNames,
    bindExtensionRuntime: runtime => {
      unbindExtensionRuntime?.()
      if (disposed) return
      const originalGet = runtime.getActiveTools
      const originalExtensionSet = runtime.setActiveTools
      // An extension's read/modify/write selection operates on the Normal
      // base. Reading the Plan-filtered view would accidentally discard every
      // masked extension tool when it only meant to remove obsolete aliases.
      const get = () => activeToolNames()
      const set = (names: string[]) => {
        if (disposed) return
        const selected = new Set(names)
        const extensionNames = new Set(session.getAllTools().filter(tool =>
          tool.sourceInfo.source !== 'builtin' && tool.sourceInfo.source !== 'sdk' &&
          classify(tool.name) !== 'app' && !safeReads.has(tool.name)).map(tool => tool.name))
        const keep = (name: string) => !extensionNames.has(name) || selected.has(name)
        appNames = appNames.filter(keep)
        extras = extras.filter(keep)
        // Explicit removals are authoritative for extension tools. SDK
        // refreshes still use the additive setter above to preserve the base
        // when their previous-active snapshot came from the Plan view.
        setter(names)
      }
      runtime.getActiveTools = get
      runtime.setActiveTools = set
      unbindExtensionRuntime = () => {
        if (runtime.getActiveTools === get) runtime.getActiveTools = originalGet
        if (runtime.setActiveTools === set) runtime.setActiveTools = originalExtensionSet
      }
    },
    tools: () => effective,
    admitNested: (name, params, definition) => {
      // The SDK resolves nested calls from its raw registry, bypassing both
      // agent.beforeToolCall and the materialized Plan replacement tools.
      // Requiring the exact current definition also rejects a call prepared
      // across an extension reload or a same-name implementation swap.
      if (!definition || session.getToolDefinition(name) !== definition) return `The "${name}" tool changed before execution.`
      if (appDefinitions.get(name) === definition && MODEL_ONLY_APP_TOOLS.has(name)) return `The "${name}" tool requires a direct model call.`
      if (!session.getCallableToolNames().includes(name)) return `The "${name}" tool is not callable in this session.`
      const ceiling = options.roleCeiling()
      if (ceiling && !ceiling.includes(name)) return `The "${name}" tool is outside this subagent's tool permissions.`
      if (appDefinitions.get(name) === definition && !appNames.includes(name)) return `The "${name}" tool is disabled in this session.`
      // Only the substituted createReadOnlyTools implementations may run in
      // Plan. Nested calls resolve a raw registry object instead, so even a
      // same-name read must use the ordinary model path in that mode.
      if (controller.restricted && safeReads.has(name)) return `[plan: the "${name}" tool is not available through nested execution]`
      return checkCall(name, params, classify(name))
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      unbindExtensionRuntime?.()
      if (session.setActiveToolsByName === setter) session.setActiveToolsByName = originalSet
      if (Object.getOwnPropertyDescriptor(session.agent.state, 'tools')?.set === setTools) {
        Object.defineProperty(session.agent.state, 'tools', toolsDescriptor)
      }
      if (session.agent.beforeToolCall === beforeToolCall) session.agent.beforeToolCall = previousBefore
      if (session.agent.finishTurn === finish) session.agent.finishTurn = previousFinish
      if (session.agent.prompt === promptRun) session.agent.prompt = previousPrompt
      if (session.agent.continue === continueRun) session.agent.continue = previousContinue
      if (session.agent.hasQueuedMessages === hasQueued) session.agent.hasQueuedMessages = previousHasQueued
      installed.delete(session)
    }
  }
}

function dedupe(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
