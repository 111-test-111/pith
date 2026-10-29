import { stat } from 'node:fs/promises'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { resolveFilePath } from '../file-path'
import type { ToolSearchRootDTO } from '../../shared/types'

/** Add navigation metadata without replacing SDK definitions, content,
 * structured results or extension overrides. No per-result file reads. */
export function createSearchResultExtension(): InlineExtension {
  return { name: 'pi-app-search-results', hidden: true, factory: pi => {
    pi.on('tool_result', async (event, ctx) => {
      if (event.isError || !['grep', 'find', 'ls'].includes(event.toolName)) return
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      if (tool?.sourceInfo.path !== `builtin:${event.toolName}`) return
      try {
        // Match the SDK's leading @ and Unicode-space path normalization.
        const raw = typeof event.input.path === 'string' && event.input.path ? event.input.path : '.'
        const path = resolveFilePath({ cwd: ctx.cwd, path: raw.replace(/^@/, '').replace(/[\u00a0\u202f]/g, ' ') })
        const info = await stat(path)
        if (!info.isDirectory() && !info.isFile()) return
        const root: ToolSearchRootDTO = { path, kind: info.isDirectory() ? 'directory' : 'file' }
        if (event.details !== undefined && (!event.details || typeof event.details !== 'object' || Array.isArray(event.details))) return
        return { details: { ...(event.details as Record<string, unknown> | undefined), piAppSearchRoot: root } }
      } catch { /* Navigation metadata must never turn a successful search into a failure. */ }
    })
  } }
}
