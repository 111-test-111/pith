import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { DebugStore } from '@/state/debug-store'
import type { PiShellState } from '@/state/pi-store'

/** The panel and source gutter share one human selection across the chat's
 * current roster. A roster change removes old children immediately; fetching a
 * child's DTOs never opens or activates its agent session. */
export function useDebugTargets(debug: DebugStore, shell: Pick<PiShellState, 'sessionPath' | 'subagents'>) {
  const { sessionPath } = shell
  const snapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot)
  // Progress updates replace roster rows frequently; only membership triggers IO.
  const pathsKey = JSON.stringify([...new Set(shell.subagents.map(run => run.sessionPath))].sort())
  const childPaths = useMemo(() => JSON.parse(pathsKey) as string[], [pathsKey])
  const session = debug.selectedFor(sessionPath, childPaths)
  useEffect(() => {
    if (!sessionPath) return
    for (const path of new Set([sessionPath, ...childPaths])) void debug.refresh(path)
  }, [debug, sessionPath, childPaths])
  useEffect(() => {
    if (sessionPath) debug.retainSelection(sessionPath, childPaths)
  }, [debug, sessionPath, childPaths, session?.id])
  return {
    session,
    sessions: debug.forView(sessionPath, childPaths),
    revision: snapshot.revision,
    select: (id: string) => { if (sessionPath) debug.select(sessionPath, id, childPaths) }
  }
}
