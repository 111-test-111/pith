import { createHash, randomUUID } from 'node:crypto'
import type { TodoItemDTO, TodoSnapshotDTO, TodoStatus } from '../../shared/types'

export const TODO_TOOL_NAME = 'todo_write'
export const TODO_KIND = 'pi-app-todo'
export const TODO_MAX_ITEMS = 100
const statuses: readonly string[] = ['pending', 'in_progress', 'completed', 'cancelled']
type InputItem = Omit<TodoItemDTO, 'id'> & { id?: string }
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): string | undefined => typeof value === 'string' ? value.trim() || undefined : undefined

/** One parser for model input and historical details; always return sanitized data. */
export function normalizeTodoItems(value: unknown): InputItem[] | null {
  if (!Array.isArray(value) || value.length > TODO_MAX_ITEMS) return null
  const items: InputItem[] = []
  const ids = new Set<string>()
  for (const valueItem of value) {
    const raw = record(valueItem)
    if (!raw) return null
    const content = text(raw.content), id = text(raw.id), activeForm = text(raw.activeForm)
    if (!content || content.length > 1000 || !statuses.includes(raw.status as string)) return null
    if (raw.id !== undefined && (!id || id.length > 80 || ids.has(id))) return null
    if (activeForm && activeForm.length > 1000) return null
    if (id) ids.add(id)
    items.push({ content, status: raw.status as TodoStatus, ...(id ? { id } : {}), ...(activeForm ? { activeForm } : {}) })
  }
  return items
}

/** Explicit IDs survive renames/reorders. Omitted IDs reuse matching task identities. */
export function identifyTodos(items: InputItem[], previous: readonly TodoItemDTO[]): TodoItemDTO[] {
  const claimed = new Set(items.flatMap((item) => item.id ? [item.id] : []))
  return items.map((item) => {
    const match = !item.id && previous.find((old) => old.content === item.content && !claimed.has(old.id))
    const id = item.id ?? (match ? match.id : randomUUID())
    claimed.add(id)
    return { ...item, id }
  })
}

/** Empty lists are real clearing snapshots. Failed/malformed/unrelated results never replace state. */
export function parseTodoResult(value: unknown): TodoSnapshotDTO | null {
  const message = record(value)
  if (message?.role !== 'toolResult' || message.toolName !== TODO_TOOL_NAME || message.isError) return null
  const details = record(message.details)
  if (!details || (details.kind !== TODO_KIND && details.kind !== 'pi-web-todo')) return null
  if (details.kind === TODO_KIND && details.version !== 1) return null
  const items = normalizeTodoItems(details.todos)
  if (!items) return null
  const occurrences = new Map<string, number>()
  return {
    toolCallId: text(message.toolCallId) ?? 'legacy',
    items: items.map((item) => {
      const count = occurrences.get(item.content) ?? 0
      occurrences.set(item.content, count + 1)
      return { ...item, id: item.id ?? `legacy:${createHash('sha256').update(item.content).digest('hex').slice(0, 24)}:${count}` }
    })
  }
}

export function reconstructTodos(entries: readonly unknown[]): TodoSnapshotDTO | null {
  let cleared: TodoSnapshotDTO | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = record(entries[i])
    if (entry?.type !== 'message') continue
    const snapshot = parseTodoResult(entry.message)
    if (!snapshot) continue
    if (!snapshot.items.length) {
      cleared ??= snapshot
      continue
    }
    // Review the latest list, including its unfinished items. Never resurrect
    // an older plan across a newer replacement or infer completion from clearing.
    return cleared ? retainClearedTodos(cleared, snapshot) : snapshot
  }
  return cleared
}

/** Clearing active work keeps its last list available for review, with its original statuses. */
export function retainClearedTodos(next: TodoSnapshotDTO, previous: TodoSnapshotDTO | null): TodoSnapshotDTO {
  if (next.items.length || !previous) return next
  const items = previous.items.length ? previous.items : previous.retainedItems
  return items?.length
    ? { ...next, retainedItems: items }
    : next
}

export const unfinishedTodos = (items: readonly TodoItemDTO[]): boolean =>
  items.some((item) => item.status === 'pending' || item.status === 'in_progress')

export function todoText(items: readonly TodoItemDTO[]): string {
  return items.length ? items.map((item) => `${item.id} [${item.status}] ${item.content}`).join('\n') : '(empty list)'
}
