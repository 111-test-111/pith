import type { AgentSession, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { RewindRecorder } from '../rewind/recorder'
import type { PlanGate } from './plan-gate'

/**
 * SDK 0.99's ctx.executeTool() runs its own tool pipeline. It emits extension
 * events with parentToolCallId, but deliberately does not call the public
 * agent.beforeToolCall/afterToolCall hooks wrapped by PlanGate and Rewind.
 * Bind those app owners to the session manager used by this extension context;
 * cwd is insufficient because several live sessions can share one checkout.
 */
interface Boundary {
  session: AgentSession
  gate: PlanGate
  rewind?: RewindRecorder
  roots: Map<string, string>
  leased: Set<string>
  successfulWrites: Map<string, Set<string>>
  nestedBashCalls: Map<string, Set<string>>
  dispose(): void
}

const boundaries = new WeakMap<object, Boundary>()
const NESTED_WRITES_DETAIL = 'piAppNestedWrites'
const NESTED_BASH_CALLS_DETAIL = 'piAppNestedBashCalls'

function recordWrite(boundary: Boundary, toolCallId: string, name: string, input: unknown): void {
  if (name !== 'edit' && name !== 'write') return
  if (!input || typeof input !== 'object' || typeof (input as { path?: unknown }).path !== 'string') return
  const root = boundary.roots.get(toolCallId)
  if (!root) return
  let paths = boundary.successfulWrites.get(root)
  if (!paths) boundary.successfulWrites.set(root, paths = new Set())
  paths.add((input as { path: string }).path)
}

/** Called once after PlanGate is installed, before extension startup. */
export function bindToolCallBoundary(session: AgentSession, gate: PlanGate, rewind?: RewindRecorder): () => void {
  const key = session.sessionManager as object
  boundaries.get(key)?.dispose()
  const boundary: Boundary = {
    session, gate, rewind,
    roots: new Map(), leased: new Set(), successfulWrites: new Map(), nestedBashCalls: new Map(),
    dispose: () => {
      for (const id of boundary.leased) rewind?.endNestedToolCall(id)
      boundary.leased.clear()
      boundary.roots.clear()
      boundary.successfulWrites.clear()
      boundary.nestedBashCalls.clear()
      unsubscribe()
      if (boundaries.get(key) === boundary) boundaries.delete(key)
    }
  }
  // The SDK adds nestedCalls to message_start before notifying agent
  // subscribers, and persists at message_end. Keep exact successful file
  // paths even when its bounded summary omits arguments or calls.
  const unsubscribe = session.agent.subscribe(event => {
    if (event.type !== 'message_start' || event.message.role !== 'toolResult') return
    const paths = boundary.successfulWrites.get(event.message.toolCallId)
    const bashCalls = boundary.nestedBashCalls.get(event.message.toolCallId)
    if (!paths?.size && !bashCalls?.size) return
    const details = event.message.details
    const existing = details && typeof details === 'object' && !Array.isArray(details)
      ? details as Record<string, unknown> : { originalDetails: details }
    event.message.details = {
      ...existing,
      ...(paths?.size ? { [NESTED_WRITES_DETAIL]: { version: 1, paths: [...paths] } } : {}),
      ...(bashCalls?.size ? { [NESTED_BASH_CALLS_DETAIL]: { version: 1, ids: [...bashCalls] } } : {})
    }
    boundary.successfulWrites.delete(event.message.toolCallId)
    boundary.nestedBashCalls.delete(event.message.toolCallId)
  })
  boundaries.set(key, boundary)
  return boundary.dispose
}

export function createToolCallBoundaryExtension(): InlineExtension {
  return { name: 'pi-app-tool-call-boundary', hidden: true, factory: pi => {
    pi.on('tool_execution_start', (event, ctx) => {
      if (!event.parentToolCallId) return
      const boundary = boundaries.get(ctx.sessionManager as object)
      if (!boundary) return
      const root = boundary.roots.get(event.parentToolCallId) ?? event.parentToolCallId
      boundary.roots.set(event.toolCallId, root)
      if (event.toolName === 'bash') {
        let calls = boundary.nestedBashCalls.get(root)
        if (!calls) boundary.nestedBashCalls.set(root, calls = new Set())
        calls.add(event.toolCallId)
      }
    })
    pi.on('tool_call', async (event, ctx) => {
      if (event.parentToolCallId === undefined) return
      const boundary = boundaries.get(ctx.sessionManager as object)
      if (!boundary) return { block: true, reason: 'Nested tool execution is unavailable before the session boundary is ready.' }
      const definition = boundary.session.getToolDefinition(event.toolName)
      const first = boundary.gate.admitNested(event.toolName, event.input, definition)
      if (first) return { block: true, reason: first }
      try {
        await boundary.rewind?.beginNestedToolCall(event.toolCallId, ctx.signal)
        if (boundary.rewind) boundary.leased.add(event.toolCallId)
        // Snapshot acquisition can await another checkout's in-flight capture.
        // Recheck the live Plan state and exact definition after that await.
        const changed = boundary.gate.admitNested(event.toolName, event.input, definition)
        if (changed) {
          boundary.rewind?.endNestedToolCall(event.toolCallId)
          boundary.leased.delete(event.toolCallId)
          return { block: true, reason: changed }
        }
      } catch (error) {
        boundary.rewind?.endNestedToolCall(event.toolCallId)
        boundary.leased.delete(event.toolCallId)
        return { block: true, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    pi.on('tool_result', (event, ctx) => {
      if (!event.parentToolCallId || event.isError) return
      const boundary = boundaries.get(ctx.sessionManager as object)
      if (boundary) recordWrite(boundary, event.toolCallId, event.toolName, event.input)
    })
    pi.on('tool_execution_end', (event, ctx) => {
      if (!event.parentToolCallId) return
      const boundary = boundaries.get(ctx.sessionManager as object)
      if (!boundary) return
      boundary.rewind?.endNestedToolCall(event.toolCallId)
      boundary.leased.delete(event.toolCallId)
      boundary.roots.delete(event.toolCallId)
    })
    pi.on('agent_settled', (_event, ctx) => {
      const boundary = boundaries.get(ctx.sessionManager as object)
      if (!boundary) return
      for (const id of boundary.leased) boundary.rewind?.endNestedToolCall(id)
      boundary.leased.clear()
      boundary.roots.clear()
      boundary.successfulWrites.clear()
      boundary.nestedBashCalls.clear()
    })
  } }
}
