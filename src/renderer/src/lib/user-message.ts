import type { ImageContent, UserContent } from '../../../shared/types'

export interface UserDisplay {
  text: string
  files: string[]
  images: ImageContent[]
}

const FILE_BLOCK = /<file path="([^"]+)">[\s\S]*?<\/file>/g
const IMAGE_DIMENSION_NOTE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/
const IMAGE_CONVERSION_NOTE = /^\[Image converted from [a-z0-9.+/-]+ to [a-z0-9.+/-]+\.\]$/
const IMAGE_HINTS_SUFFIX = /(?:\r?\n){2}(\[Image(?::| )[^\r\n]*\](?:\r?\n\[Image(?::| )[^\r\n]*\])*)[ \t\r\n]*$/

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
  // Pi appends resize/conversion hints as a final paragraph for the model.
  // Hide only that metadata beside attached images; keep failed-image notes,
  // quoted descriptions and the persisted/resend content intact.
  if (images.length) text = text.replace(IMAGE_HINTS_SUFFIX, (_suffix, hints: string) => {
    const remaining = hints.split(/\r?\n/).filter(line => !IMAGE_DIMENSION_NOTE.test(line) && !IMAGE_CONVERSION_NOTE.test(line))
    return remaining.length ? `\n\n${remaining.join('\n')}` : ''
  })
  const files: string[] = []
  text = text.replace(FILE_BLOCK, (_match, path: string) => {
    files.push(path)
    return ''
  })
  return { text: text.trim(), files, images }
}
