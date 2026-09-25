import type { Parent } from 'mdast'
import type { VFile } from 'vfile'

/** Hand math to the shared React component without an HTML reparse or a
 * document-wide DOM scan. Only parser-produced math gets these properties;
 * raw HTML in Markdown stays disabled. */
export function remarkMathNodes() {
  return (tree: Parent, file: VFile): void => {
    const source = String(file)
    function walk(parent: Parent) {
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i]
        const fence = node.type === 'code' && node.lang === 'math'
        if (node.type === 'math' || node.type === 'inlineMath' || fence) {
          const start = node.position?.start.offset ?? 0
          const end = node.position?.end.offset ?? start
          const raw = source.slice(start, end)
          const display = node.type !== 'inlineMath' || raw.startsWith('$$') || raw.startsWith('\\[')
          const marker = fence ? /^(`{3,}|~{3,})/.exec(raw)?.[1] : /^\${2,}/.exec(raw)?.[0]
          const lastLine = raw.slice(raw.lastIndexOf('\n') + 1).trim().replace(/^(?:>\s*)+/, '')
          const closed = node.type === 'inlineMath' || (raw.includes('\n') && (
            marker ? new RegExp(`^${marker[0] === '$' ? '\\$' : marker[0]}{${marker.length},}\\s*$`).test(lastLine) : lastLine === '\\]'
          ))
          node.data = {
            hName: 'span',
            hProperties: {
              'data-math': display ? 'display' : 'inline',
              'data-math-source': node.value,
              'data-math-raw': raw,
              'data-math-incomplete': !closed
            },
            hChildren: []
          }
          // mdast's code handler always adds a <pre> around its result;
          // promote math fences so they cannot reach the beUI code renderer.
          if (fence) parent.children[i] = { type: 'math', value: node.value, data: node.data, position: node.position }
        } else if ('children' in node) walk(node as Parent)
      }
    }
    walk(tree)
  }
}
