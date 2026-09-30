import type { InlineExtension } from '@earendil-works/pi-coding-agent'

/**
 * SDK 0.99 ctx.executeTool() uses the raw registry and private session hooks,
 * bypassing agent.beforeToolCall/afterToolCall and the app's execute wrappers.
 * It also persists only a bounded nestedCalls summary, not normal results.
 * Until nested calls participate in admission, Rewind leases/coverage, Todo
 * commits and notification receipts, require ordinary model tool calls.
 */
export function createToolCallBoundaryExtension(): InlineExtension {
  return { name: 'pi-app-tool-call-boundary', hidden: true, factory: pi => {
    pi.on('tool_call', event => event.parentToolCallId === undefined ? undefined : {
      block: true,
      reason: 'Nested tool execution is not supported by Pith. Ask the model to call the target tool directly so application permissions, checkpoints and task tracking apply.'
    })
  } }
}
