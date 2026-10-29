import type { Extension } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const adapted = new WeakMap<Extension, Extension>()

/** Desktop compatibility for the verified pi-fff 0.10.6 lifecycle.
 * Its session_start registers tools, then awaits an eager native index scan
 * (up to 15s, upstream fff#477). Its SDK before_agent_start fallback performs
 * the same preparation/registration without the editor or eager scan. Use
 * that preparation at startup: actual FFF tools already await ensureFinder.
 *
 * This is intentionally version-bounded. Do not detach arbitrary extension
 * startup promises: tools may register asynchronously, and shutdown would
 * invalidate contexts still used by those promises. Unknown versions retain
 * their lifecycle until their preparation contract has been verified.
 */
export function desktopExtension(extension: Extension): Extension {
  const cached = adapted.get(extension)
  if (cached) return cached
  let result = extension
  let directory = dirname(extension.resolvedPath || extension.path)
  for (let depth = 0; depth < 4; depth++) {
    let pkg: { name?: string; version?: string } | undefined
    try { pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) }
    catch { /* Entry directories need not contain package metadata. */ }
    if (pkg?.name) {
      const prepare = extension.handlers.get('before_agent_start')
      if (pkg.name === '@ff-labs/pi-fff' && pkg.version === '0.10.6' &&
          extension.handlers.get('session_start')?.length === 1 && prepare?.length === 1) {
        const handlers = new Map(extension.handlers)
        handlers.set('session_start', [(_event, ctx) => prepare[0]({
          type: 'before_agent_start', prompt: '', systemPrompt: ''
        }, ctx)])
        result = { ...extension, handlers }
      }
      break
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  adapted.set(extension, result)
  return result
}
