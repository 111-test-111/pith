/** Split only at blank lines outside fenced code AND display math. Preserve
 * the original bytes; the parser, not this streaming optimization, owns syntax.
 * Container prefixes are recognized conservatively so a list/quote's formula
 * is never split in half. Completed messages still get one full parse. */
export function splitMarkdownBlocks(text: string): { stable: string[]; tail: string } {
  const stable: string[] = []
  let fence: string | null = null
  let offset = 0
  let start = 0
  for (const line of text.split('\n')) {
    const content = line.replace(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?/, '')
    if (fence) {
      if (fence === '\\[' ? /^\\\]\s*$/.test(content) :
        new RegExp(`^${fence[0] === '$' ? '\\$' : fence[0]}{${fence.length},}\\s*$`).test(content)) fence = null
    } else {
      const open = /^(`{3,}|~{3,})/.exec(content)
      const math = /^(\${2,})[^$]*$/.exec(content)
      if (open) fence = open[1]
      else if (math) fence = math[1]
      else if (/^\\\[\s*$/.test(content)) fence = '\\['
      else if (line.trim() === '' && offset + line.length + 1 <= text.length) {
        const cut = offset + line.length + 1
        stable.push(text.slice(start, cut))
        start = cut
      }
    }
    offset += line.length + 1
  }
  return { stable, tail: text.slice(start) }
}
