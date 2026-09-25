import type { Break, Paragraph, Parent } from 'mdast'

/** Jupyter Markdown commonly uses HTML's bare <br> for a line break. Convert
 * only that tag to a Markdown break; all other raw HTML remains inert. Walking
 * parsed nodes keeps escaped tags, code, and link destinations untouched. */
export function remarkSafeBreaks() {
  return (tree: Parent): void => {
    function walk(parent: Parent): void {
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index]
        if (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value)) {
          const lineBreak: Break = { type: 'break', position: node.position }
          // A standalone HTML line is a flow node. Keep the replacement a
          // flow node too so mdast-to-hast can render it between paragraphs.
          const replacement: Break | Paragraph =
            parent.type === 'root' || parent.type === 'blockquote' || parent.type === 'listItem'
              ? { type: 'paragraph', children: [lineBreak], position: node.position }
              : lineBreak
          parent.children[index] = replacement
        } else if ('children' in node) {
          walk(node as Parent)
        }
      }
    }
    walk(tree)
  }
}
