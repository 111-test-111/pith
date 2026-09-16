/**
 * The mode vocabulary lives in the shared types (both processes read it); this
 * module is the main-process entry point for it, plus the session fold.
 */
import { DEFAULT_SANDBOX_MODE, isSandboxMode, type SandboxMode } from '../../shared/types'

export { DEFAULT_SANDBOX_MODE, SANDBOX_MODES, isSandboxMode } from '../../shared/types'
export type { SandboxMode } from '../../shared/types'

/** Custom session entry carrying one session's mode; the newest one wins. */
export const SANDBOX_MODE_ENTRY_TYPE = 'pith_sandbox_mode'

interface BranchEntryLike {
  type?: string
  customType?: string
  data?: unknown
}

/**
 * DSH folds the mode from the session's own branch rather than from app state:
 * the newest entry wins, so reopening a session restores the mode it was left
 * in, and a fork inherits its parent's mode up to the fork point. A branch with
 * no entry at all falls back to the app-wide default for new chats.
 */
export function sandboxModeFromBranch(
  branch: readonly BranchEntryLike[],
  fallback: SandboxMode = DEFAULT_SANDBOX_MODE
): SandboxMode {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry?.type !== 'custom' || entry.customType !== SANDBOX_MODE_ENTRY_TYPE) continue
    const mode = (entry.data as { mode?: unknown } | undefined)?.mode
    if (isSandboxMode(mode)) return mode
  }
  return fallback
}
