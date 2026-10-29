import type { ImageContent, UserContent } from '../../../shared/types'

export interface UserDisplay {
  text: string
  files: string[]
  images: ImageContent[]
}

const FILE_BLOCK = /<file path="([^"]+)">[\s\S]*?<\/file>/g

/**
 * Split a user message into display text, referenced files (inlined by the
 * main process as `<file path>` blocks) and image attachments.
 */
/**
 * Raw text and image parts of a user message exactly as persisted — file
 * blocks intact. The resend path re-sends this verbatim.
 */
export function extractUserParts(content: UserContent): { text: string; images: ImageContent[] } {
  let text = ''
  const images: ImageContent[] = []
  if (typeof content === 'string') return { text: content, images }
  for (const part of content) {
    if (part.type === 'text') text += (text ? '\n' : '') + part.text
    else if (part.type === 'image') images.push(part)
  }
  return { text, images }
}

export function extractUserDisplay(content: UserContent): UserDisplay {
  let text = ''
  const images: ImageContent[] = []
  if (typeof content === 'string') {
    text = content
  } else {
    for (const part of content) {
      if (part.type === 'text') text += (text ? '\n' : '') + part.text
      else if (part.type === 'image') images.push(part)
    }
  }
  const files: string[] = []
  text = text.replace(FILE_BLOCK, (_match, path: string) => {
    files.push(path)
    return ''
  })
  return { text: text.trim(), files, images }
}
