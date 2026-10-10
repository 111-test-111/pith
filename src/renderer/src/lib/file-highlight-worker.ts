import { createHighlighter } from 'shiki'
import type { AgentCodeLanguage, AgentCodeTokenLines } from '@/components/agents/agent-code'
import { normalizeCodeThemes, type CodeThemes } from './code-themes'

/** Source files tokenize off the UI thread. The pane owns and terminates
 * this worker, so navigating away cancels both computation and its buffers. */
self.onmessage = async (event: MessageEvent<{ code: string; language: AgentCodeLanguage; themes: CodeThemes }>) => {
  const { code, language } = event.data
  const themes = normalizeCodeThemes(event.data.themes)
  let highlighter: Awaited<ReturnType<typeof createHighlighter>> | undefined
  try {
    highlighter = await createHighlighter({ themes: [themes.light, themes.dark], langs: language === 'text' ? [] : [language] })
    const lines: AgentCodeTokenLines = highlighter.codeToTokensWithThemes(code, {
      lang: language, themes: { ...themes }
    }).map(line => line.map(token => ({ content: token.content, offset: token.offset, light: token.variants.light.color, dark: token.variants.dark.color })))
    self.postMessage(lines)
  } catch { self.postMessage(null) }
  finally { highlighter?.dispose() }
}
