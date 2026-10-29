import { randomUUID } from 'node:crypto'
import { link, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writableTarget } from './file-tools'
import type { SandboxMode } from '../sandbox/types'

/** Stage complete bytes, then publish atomically. A no-replace link closes the
 * check/request/write race without ever truncating another session's file. */
export async function commitImageFile(target: string, bytes: Buffer, options: {
  cwd: string
  getMode: () => SandboxMode
  overwrite: boolean
  assertAdmitted: () => void
}): Promise<string> {
  options.assertAdmitted()
  const mode = options.getMode()
  const path = writableTarget(target, options.cwd, mode)
  const staged = writableTarget(join(dirname(path), `.pith-image-${randomUUID()}.tmp`), options.cwd, mode)
  const handle = await open(staged, 'wx', 0o600)
  let closed = false
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); closed = true
    options.assertAdmitted()
    // Check both names again: the provider wait and staging are asynchronous.
    // Do not follow a changed ancestor into a different destination.
    if (writableTarget(target, options.cwd, options.getMode()) !== path ||
        writableTarget(staged, options.cwd, options.getMode()) !== staged) throw new Error('Image destination changed while saving.')
    if (options.overwrite) await rename(staged, path)
    else await link(staged, path)
    return path
  } finally {
    if (!closed) await handle.close().catch(() => {})
    // Cleanup owns only our random staging file and uses the admission policy
    // under which it was created, including after cancellation.
    try { if (writableTarget(staged, options.cwd, mode) === staged) await unlink(staged) }
    catch { /* Already published by rename, or no longer at the owned path. */ }
  }
}
