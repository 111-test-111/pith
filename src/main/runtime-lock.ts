import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { app } from 'electron'

/** Keep one runtime owner per data folder before opening settings and sessions. */
export async function acquireRuntimeLock(): Promise<() => Promise<void>> {
  const directory = app.getPath('userData')
  mkdirSync(directory, { recursive: true })
  let release: () => void
  try {
    release = lockSync(directory, {
      lockfilePath: join(directory, '.runtime.lock'),
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: 0
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
      throw new Error('This Pith data folder is already open in another client. Close that client before opening this one.')
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    // Synchronous removal also works in Electron's final quit event, after
    // the ordinary bounded runtime cleanup has completed.
    release()
  }
}
