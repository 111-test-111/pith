/**
 * The mode vocabulary lives in the shared types (both processes read it); this
 * module is the main-process entry point for it.
 */
export { DEFAULT_SANDBOX_MODE, SANDBOX_MODES, isSandboxMode } from '../../shared/types'
export type { SandboxMode } from '../../shared/types'

/** Modes that need a platform runner; `danger-full-access` runs on the host. */
export function isConfinedMode(mode: string): boolean {
  return mode !== 'danger-full-access'
}
