import { useEffect, useState } from 'react'
import { getCachedAgentCodeTokens, type AgentCodeLanguage, type AgentCodeTokenLines } from '@/components/agents/agent-code'
import { useCodeThemes } from '@/lib/code-theme-settings'
import { codeTokenCacheKey, type CodeThemes } from '@/lib/code-themes'

const CACHE_BYTES = 8 * 1024 * 1024
const cache = new Map<string, { tokens: AgentCodeTokenLines; bytes: number }>()
let cacheBytes = 0

function cached(code: string, language: AgentCodeLanguage, themes: CodeThemes) {
  return cache.get(codeTokenCacheKey(code, language, themes))?.tokens ?? getCachedAgentCodeTokens(code, language, themes)
}

/** Cold Shiki/WASM and grammar initialization must never block the opening rail,
 * even for small files. The bounded cache makes warm visits synchronous; an
 * uncached visit paints plain source first and owns its cancellable worker. */
export function useFileTokens(code: string, language: AgentCodeLanguage) {
  const [themes] = useCodeThemes()
  const key = codeTokenCacheKey(code, language, themes)
  const [result, setResult] = useState<{ key: string; tokens: AgentCodeTokenLines | null } | null>(null)
  const ready = language === 'text' ? null : cached(code, language, themes)
  useEffect(() => {
    if (language === 'text' || ready) return
    let cancelled = false
    const worker = new Worker(new URL('../file-highlight-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<AgentCodeTokenLines | null>) => {
      if (cancelled) return
      const tokens = event.data
      if (tokens) {
        const bytes = code.length * 2 + tokens.reduce((sum, line) => sum + line.reduce((size, token) => size + token.content.length * 2 + 64, 24), 0)
        if (bytes <= CACHE_BYTES) {
          cacheBytes -= cache.get(key)?.bytes ?? 0
          cache.delete(key); cache.set(key, { tokens, bytes }); cacheBytes += bytes
          while (cache.size > 24 || cacheBytes > CACHE_BYTES) {
            const oldest = cache.entries().next().value!
            cacheBytes -= oldest[1].bytes; cache.delete(oldest[0])
          }
        }
      }
      setResult({ key, tokens })
      worker.terminate()
    }
    worker.onerror = () => worker.terminate()
    worker.postMessage({ code, language, themes })
    return () => { cancelled = true; worker.terminate() }
  }, [code, language, key, ready, themes])
  return ready ?? (result?.key === key ? result.tokens : null)
}
