import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { PRESENT_TOOL_NAME, type PresentResult } from '../../shared/present'
import type { PresentedImageGeneration } from '../../shared/image-replay'

const parameters = Type.Object({ files: Type.Array(Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096, description: 'Existing regular file. Relative paths use the session working directory.' }),
  description: Type.Optional(Type.String({ maxLength: 1000, description: 'Brief description of the final deliverable.' }))
}), { minItems: 1, maxItems: 8 }) })

/** Declaration reads metadata only; it grants no filesystem mutation or wider
 * permissions. A completed toolResult is the durable declaration. */
export function createPresentTool(options: { cwd: string; canStart(): boolean; generatedImage?(path: string, size: number): PresentedImageGeneration | undefined | Promise<PresentedImageGeneration | undefined> }) {
  return defineTool<typeof parameters, PresentResult>({
    name: PRESENT_TOOL_NAME,
    label: 'Present files',
    description: 'Declare existing files as final deliverables for the user, especially generated documents, spreadsheets, slides, images or reports. You MUST present every successfully saved generated image, including committed files from a partially failed image call; split batches across calls when needed. For other deliverables, usually present the 1–2 most important files after checking them. This also works for files created with bash. The user opens the current source files; their contents are not copied or versioned. A parent must present child-created files itself. Prefer a normal final response when no separate file is needed.',
    parameters,
    async execute(_id, args, signal) {
      if (!options.canStart()) throw new Error('present-admission-closed')
      const files: PresentResult['files'] = []
      const seen = new Set<string>()
      for (const file of args.files) {
        signal?.throwIfAborted()
        if (!file.path.trim() || file.path.includes('\0')) throw new Error('present-invalid-path')
        const path = resolve(options.cwd, file.path)
        const info = await lstat(path)
        if (!info.isFile()) throw new Error(`Cannot present ${file.path}: expected an existing regular file, not a directory or symbolic link.`)
        const canonical = await realpath(path)
        if (!seen.has(canonical)) {
          const generation = await options.generatedImage?.(canonical, info.size)
          files.push({ path: canonical, size: info.size, ...(file.description ? { description: file.description } : {}), ...(generation ? { generation } : {}) })
          seen.add(canonical)
        }
      }
      signal?.throwIfAborted()
      if (!options.canStart()) throw new Error('present-admission-closed')
      return { content: [{ type: 'text', text: files.map(file => `Presented ${file.path}`).join('\n') }], details: { kind: 'pith-present-v1', files } }
    }
  })
}
