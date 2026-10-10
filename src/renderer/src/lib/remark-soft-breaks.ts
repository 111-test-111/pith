import type { Parent } from 'mdast'

/** File previews preserve prose line endings like an editor's reading view.
 * Only text nodes change: code, raw markup and math keep their original bytes.
 * A newline beside an explicit break is layout whitespace, not a second break. */
export function remarkSoftBreaks() {
  return (tree: Parent): void => {
    function walk(parent: Parent): void {
      const output: Parent['children'] = []
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index]
        if (node.type === 'text' && /[\r\n]/.test(node.value)) {
          const previous = parent.children[index - 1]
          const next = parent.children[index + 1]
          let value = node.value
          if (previous?.type === 'break') value = value.replace(/^(?:\r\n|[\r\n])/, '')
          if (next?.type === 'break') value = value.replace(/(?:\r\n|[\r\n])$/, '')
          const lines = value.split(/\r\n|[\r\n]/)
          lines.forEach((line, lineIndex) => {
            if (lineIndex) output.push({ type: 'break' })
            if (line) output.push({ type: 'text', value: line })
          })
        } else {
          if ('children' in node) walk(node as Parent)
          output.push(node)
        }
      }
      parent.children = output
    }
    walk(tree)
  }
}
