import { Type } from 'typebox'
import type { AgentSessionEvent, InlineExtension, SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TodoSnapshotDTO } from '../../shared/types'
import { identifyTodos, normalizeTodoItems, parseTodoResult, reconstructTodos, retainClearedTodos, TODO_KIND, TODO_MAX_ITEMS, TODO_TOOL_NAME, todoText, unfinishedTodos } from './todo-protocol'

/** Session-owned projection of committed results. No sidecar files or automatic turns. */
export class TodoState {
  snapshot: TodoSnapshotDTO | null = null
  private activity = 0
  private modelVisibleActivity = 0
  private stale = false
  private due = true
  private synced = false

  constructor(private manager: SessionManager) { this.restore() }

  restore(): void {
    const next = reconstructTodos(this.manager.getBranch())
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) this.snapshot = next
    this.activity = this.modelVisibleActivity = 0
    this.synced = false
    this.stale = true // A restored snapshot may predate unfinished work or a crash.
    this.due = true
  }

  activityOccurred(): void {
    this.activity++
    this.stale = this.due = true
    this.synced = false
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_start') this.restore() // Includes idle custom-message wakeups.
    if (event.type !== 'message_end') return
    const message = event.message
    const next = parseTodoResult(message)
    if (next) {
      this.snapshot = retainClearedTodos(next, this.snapshot)
      // A todo emitted with other tools cannot acknowledge results the model
      // has not seen, regardless of callback ordering within that batch.
      this.synced = this.activity <= this.modelVisibleActivity
      this.stale = this.due = !this.synced
    } else if (message.role === 'custom') {
      this.activityOccurred() // Bash completion is new evidence, including during steering.
    } else if (message.role === 'assistant' && !this.synced && message.content.some((block) => block.type === 'text' && block.text.trim())) {
      this.stale = true
    }
  }

  extension(): InlineExtension {
    return { name: 'pi-app-todo-context', hidden: true, factory: (pi) => {
      pi.on('session_start', () => this.restore())
      pi.on('session_tree', () => this.restore())
      pi.on('before_agent_start', () => this.restore()) // Covers the app's manual leaf rewind.
      pi.on('session_compact', () => { this.due = true })
      pi.on('tool_result', (event) => { if (event.toolName !== TODO_TOOL_NAME) this.activityOccurred() })
      pi.on('context', (event) => {
        this.modelVisibleActivity = this.activity
        if (!this.due || !this.snapshot || !unfinishedTodos(this.snapshot.items)) return
        // The SDK gives extensions a clone before convertToLlm. An ephemeral
        // user message also works after custom/summary/assistant tails without
        // mutating their content or separating calls from pending tool results.
        // The wording is directive and never asks for a verdict: a comparison
        // request used to be answered in visible prose ("the list is
        // accurate, continuing…") on every round. The list still ships so a
        // full update stays exact, and the pressure to update stays on.
        const instruction = this.stale
          ? 'If the latest results changed a task\'s status or scope, call todo_write with the full corrected list; if nothing changed, leave the list untouched.'
          : 'Mark an item in_progress when you start it and completed only after verification.'
        const reminder = `<system-reminder>\nCurrent task list:\n${todoText(this.snapshot.items)}\n${instruction}\nTask state is written only through todo_write and is already shown in the UI. Never restate, summarize or acknowledge this list or its statuses in your reply; do not announce that it is accurate, unchanged or up to date. Talk about the work itself.\nA background command is unfinished until its result is known and verified. Preserve IDs when updating tasks. Mark abandoned work cancelled, never completed. Do not mention this reminder to the user.\n</system-reminder>`
        this.due = false
        return { messages: [...event.messages, { role: 'user', content: reminder, timestamp: Date.now() }] }
      })
    } }
  }
}

const parameters = Type.Object({ todos: Type.Array(Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Preserve the ID returned for existing tasks, including when renaming or reordering. Omit for new tasks.' })),
  content: Type.String({ minLength: 1, maxLength: 1000, description: 'Concise, self-contained task description.' }),
  status: Type.Union(['pending', 'in_progress', 'completed', 'cancelled'].map((status) => Type.Literal(status))),
  activeForm: Type.Optional(Type.String({ maxLength: 1000, description: 'Short present-progressive description, e.g. Running tests.' }))
}), { maxItems: TODO_MAX_ITEMS, description: 'The entire updated list; an empty list clears active tracking while the previous list remains available for UI review.' }) })

export function createTodoTool(state: TodoState, canStart: () => boolean): ToolDefinition<typeof parameters> {
  return {
    name: TODO_TOOL_NAME, label: 'Todo', parameters, executionMode: 'sequential',
    description: 'Maintain a structured task list for this conversation. Each call replaces the entire list. Use for complex multi-step work or explicit task tracking; skip trivial tasks. Preserve returned IDs across updates.',
    promptSnippet: 'Track multi-step work with a persistent, structured task list.',
    promptGuidelines: [
      'Use todo_write for 3+ steps or requested tracking. Replace the full list, preserving IDs and completed/cancelled items; update only when scope/status changes, including before the final reply.',
      'Keep at most one item in_progress; complete only after verification, cancel abandoned work, and keep background dependencies unfinished. Task state is already in the UI: do not repeat or acknowledge the list in prose.'
    ],
    async execute(_id, args, signal) {
      if (signal?.aborted || !canStart()) throw new Error('Task update cancelled')
      const input = normalizeTodoItems(args.todos)
      if (!input) throw new Error('Invalid todos: provide at most 100 tasks with non-empty content, valid status, and unique IDs.')
      if (input.filter((item) => item.status === 'in_progress').length > 1) throw new Error('At most one item may be in_progress. Keep other tasks pending, completed or cancelled.')
      const todos = identifyTodos(input, state.snapshot?.items ?? [])
      return { content: [{ type: 'text', text: `Task list replaced. Preserve these IDs in future updates. Mark tasks completed only after verification.\n${todoText(todos)}` }],
        details: { kind: TODO_KIND, version: 1, todos } }
    }
  }
}
