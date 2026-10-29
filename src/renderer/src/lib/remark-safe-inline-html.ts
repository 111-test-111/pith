import type { Data, Parent, PhrasingContent } from 'mdast'

const TAG = /^<(\/?)(sup|sub|mark|kbd|ins|del|u|s)[ \t]*>$/i
type InlineTag = 'sup' | 'sub' | 'mark' | 'kbd' | 'ins' | 'del' | 'u' | 's'

interface SafeInline extends Parent {
  type: 'safeInline'
  children: PhrasingContent[]
  data: Data & { hName: InlineTag }
}

declare module 'mdast' {
  interface PhrasingContentMap { safeInline: SafeInline }
  interface RootContentMap { safeInline: SafeInline }
}

/** Interpret balanced, attribute-free inline tags as typed Markdown nodes.
 * No HTML parser, attributes or executable markup enter the rendered tree.
 * Parsed code and escaped tags cannot be mistaken for HTML nodes. */
export function remarkSafeInlineHtml() {
  return (tree: Parent): void => {
    function walk(parent: Parent): void {
      for (const child of parent.children) if ('children' in child) walk(child as Parent)
      if (!['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(parent.type)) return

      const children = parent.children as PhrasingContent[]
      const stack: { tag: InlineTag; start: number }[] = []
      const pairs = new Map<number, { tag: InlineTag; end: number }>()
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index]
        if (node.type !== 'html') continue
        const match = TAG.exec(node.value)
        if (!match) continue
        const tag = match[2].toLowerCase() as InlineTag
        if (!match[1]) stack.push({ tag, start: index })
        else if (stack.at(-1)?.tag === tag) {
          const opened = stack.pop()!
          pairs.set(opened.start, { tag, end: index })
        } else stack.length = 0
      }
      if (!pairs.size) return

      const output: PhrasingContent[] = []
      const containers = [output]
      const ends: number[] = []
      for (let index = 0; index < children.length; index += 1) {
        const pair = pairs.get(index)
        if (pair) {
          const node: SafeInline = { type: 'safeInline', data: { hName: pair.tag }, children: [] }
          const start = children[index].position?.start
          const end = children[pair.end].position?.end
          if (start && end) node.position = { start, end }
          containers.at(-1)!.push(node)
          containers.push(node.children)
          ends.push(pair.end)
        } else if (ends.at(-1) === index) {
          containers.pop()
          ends.pop()
        } else containers.at(-1)!.push(children[index])
      }
      parent.children = output
    }
    walk(tree)
  }
}
