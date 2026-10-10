import type { FileKind, ImageContent } from '../../../shared/types'

/** Match persisted file chips while their bounded contents are still loading. */
export function optimisticEchoText(text: string, files: readonly string[]): string {
  const blocks = files.map(file => `<file path="${file.replace(/^\//, '')}">(pending)</file>`).join('\n\n')
  return blocks ? text ? `${text}\n\n${blocks}` : blocks : text
}

/** What a chip needs to describe a workspace document: the absolute path the
 * main process resolves at send time, plus the label the draft mentions. */
export interface AttachmentTarget {
  path: string
  relPath: string
  kind: FileKind
  size: number
}

/** An image File read into the shape both attachment lists store. */
export interface ImageAttachmentParts {
  name: string
  dataUrl: string
  image: ImageContent
}

/**
 * Resolve a File from a picker, a paste or a drop to its workspace document.
 *
 * Electron removed the non-standard `File.path` in v32, so the backing path
 * only comes through the preload's `webUtils` bridge; a File with no local
 * backing (dragged out of a browser page) falls back to a name search in the
 * workspace index. Both attachment intakes share this — the edit dialog was
 * written later without it and silently attached nothing for a pasted file.
 */
export async function resolveAttachmentFile(file: File): Promise<AttachmentTarget | null> {
  const path = window.pi.pathForFile(file)
  if (path) {
    try {
      const preview = await window.pi.readFile(path)
      return { path: preview.path, relPath: preview.relPath, kind: preview.kind, size: preview.size }
    } catch {
      // Unreadable or already deleted — the name search below may still find it.
    }
  }
  const hits = await window.pi.searchFiles(file.name)
  const hit = hits.find((candidate) => candidate.name === file.name) ?? hits[0]
  if (!hit) return null
  return { path: hit.path, relPath: hit.relPath, kind: hit.kind, size: hit.size }
}

/**
 * Read an image File into the attachment shape both intakes store. A clipboard
 * image and a picked one arrive the same way — only bytes exist, never a path —
 * so this is the whole intake for them; `null` means the read failed and the
 * file is dropped rather than attached half-read.
 */
export function readImageAttachment(file: File): Promise<ImageAttachmentParts | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve({
        name: file.name,
        dataUrl,
        image: {
          type: 'image',
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          mimeType: file.type || 'image/png'
        }
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
