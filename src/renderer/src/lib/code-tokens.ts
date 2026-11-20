import type { AgentCodeToken } from '@/components/agents/agent-code'

/** Slice Shiki tokens by absolute UTF-16 offsets, leaving incomplete spans plain. */
export function sliceCodeTokens(tokens: AgentCodeToken[] | undefined, from: number, to: number) {
  if (!tokens) return undefined
  let low = 0, high = tokens.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (tokens[mid].offset + tokens[mid].content.length <= from) low = mid + 1
    else high = mid
  }
  const sliced: AgentCodeToken[] = []
  let length = 0
  for (let index = low; index < tokens.length && tokens[index].offset < to; index++) {
    const token = tokens[index]
    const start = Math.max(token.offset, from), end = Math.min(token.offset + token.content.length, to)
    if (start >= end) continue
    length += end - start
    sliced.push({ ...token, content: token.content.slice(start - token.offset, end - token.offset), offset: start - from })
  }
  // A grammar may normalize input. Let the caller render the exact text if
  // its tokens do not cover the requested slice.
  return length === to - from ? sliced : undefined
}
