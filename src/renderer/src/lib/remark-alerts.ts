import type { Parent } from 'mdast'
import type { VFile } from 'vfile'

export type MarkdownAlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** GitHub alerts are ordinary parsed quotes with an explicit first-line marker.
 * Keep their Markdown children (lists, links, math and nested quotes) intact. */
export function remarkAlerts() {
  return (tree: Parent, file: VFile): void => {
    const source = String(file)
    function walk(parent: Parent): void {
      if (parent.type === 'blockquote') {
        const first = parent.children[0]
        const marker = first?.type === 'paragraph' ? first.children[0] : undefined
        if (marker?.type === 'text') {
          const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i.exec(marker.value)
          const offset = marker.position?.start.offset
          if (match && offset !== undefined && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(source.slice(offset)) && first.type === 'paragraph') {
            marker.value = marker.value.slice(match[0].length)
            if (!marker.value) first.children.shift()
            if (!first.children.length) parent.children.shift()
            parent.data = {
              ...parent.data,
              hProperties: { ...parent.data?.hProperties, 'data-markdown-alert': match[1].toLowerCase() }
            }
          }
        }
      }
      for (const child of parent.children) if ('children' in child) walk(child as Parent)
    }
    walk(tree)
  }
}
