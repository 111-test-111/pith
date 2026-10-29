import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { BashTaskDTO } from '../../../shared/types'

const SessionContext = createContext<string | null>(null)
const sessions = new Map<string, readonly BashTaskDTO[]>()
const loaded = new Set<string>()
const listeners = new Set<() => void>()
const EMPTY: readonly BashTaskDTO[] = []
let unsubscribe: (() => void) | undefined
let owners = 0

export const bashTaskLive = (task: BashTaskDTO) => task.status === 'running' || task.status === 'stopping'
export const bashTaskStatus = (task: BashTaskDTO) => bashTaskLive(task) ? 'running' as const
  : task.status === 'succeeded' ? 'success' as const
    : task.status === 'cancelled' || task.status === 'interrupted' ? 'cancelled' as const : 'error' as const

function update(task: BashTaskDTO): void {
  const current = sessions.get(task.sessionPath) ?? EMPTY
  const old = current.find((item) => item.id === task.id)
  if (old && old.revision >= task.revision) return
  const next = old ? current.map((item) => item.id === task.id ? task : item) : [...current, task]
  sessions.set(task.sessionPath, next)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Task updates bypass transcript React state; only rows that read them repaint. */
export function BashTasksProvider({ sessionPath, children }: { sessionPath: string | null; children: ReactNode }) {
  useEffect(() => {
    if (owners++ === 0) unsubscribe = window.pi.onBashTask(update)
    return () => { if (--owners === 0) { unsubscribe?.(); unsubscribe = undefined } }
  }, [])
  useEffect(() => {
    if (!sessionPath) return
    let active = true
    const before = new Map((sessions.get(sessionPath) ?? EMPTY).map((task) => [task.id, task]))
    void window.pi.listBashTasks(sessionPath).then((tasks) => {
      if (!active) return
      // Reconcile retention with the authoritative snapshot, while preserving
      // task events that arrived after this read began.
      const next = new Map(tasks.map((task) => [task.id, task]))
      for (const task of sessions.get(sessionPath) ?? EMPTY) {
        if (before.get(task.id) !== task && (!next.has(task.id) || task.revision > next.get(task.id)!.revision)) next.set(task.id, task)
      }
      sessions.set(sessionPath, [...next.values()])
      loaded.add(sessionPath)
      for (const listener of listeners) listener()
    }).catch(() => {})
    return () => { active = false }
  }, [sessionPath])
  return <SessionContext.Provider value={sessionPath}>{children}</SessionContext.Provider>
}

export function useBashTaskAvailable(id: string): boolean {
  const path = useContext(SessionContext)
  return useSyncExternalStore(subscribe, () => !path || !loaded.has(path) || Boolean(sessions.get(path)?.some((task) => task.id === id)))
}

export function useBashTasks(): readonly BashTaskDTO[] {
  const path = useContext(SessionContext)
  return useSyncExternalStore(subscribe, () => path ? sessions.get(path) ?? EMPTY : EMPTY)
}

export function useBashTask(toolCallId?: string, fallback?: BashTaskDTO): BashTaskDTO | undefined {
  const path = useContext(SessionContext)
  return useSyncExternalStore(subscribe, () => {
    const tasks = path ? sessions.get(path) : undefined
    const task = tasks?.slice().reverse().find((task) => fallback ? task.id === fallback.id : task.toolCallId === toolCallId)
    return task && (!fallback || task.revision >= fallback.revision) ? task : fallback
  })
}
