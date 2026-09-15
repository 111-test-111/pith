import { useEffect, useState } from 'react'
import { getCachedAgentCodeTokens, type AgentCodeLanguage, type AgentCodeTokenLines } from '@/components/agents/agent-code'

const CACHE_BYTES = 8 * 1024 * 1024
const cache = new Map<string, { tokens: AgentCodeTokenLines; bytes: number }>()
let cacheBytes = 0

function cached(code: string, language: AgentCodeLanguage) {
  return cache.get(`${language}\0${code}`)?.tokens ?? getCachedAgentCodeTokens(code, language)
}

/** Cold Shiki/WASM and grammar initialization must never block the opening rail,
 * even for small files. The bounded cache makes warm visits synchronous; an
 * uncached visit paints plain source first and owns its cancellable worker. */
export function useFileTokens(code: string, language: AgentCodeLanguage) {
  const [result, setResult] = useState<{ code: string; language: string; tokens: AgentCodeTokenLines | null } | null>(null)
  const ready = language === 'text' ? null : cached(code, language)
  useEffect(() => {
    if (language === 'text' || ready) return
    const worker = new Worker(new URL('../file-highlight-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<AgentCodeTokenLines | null>) => {
      const tokens = event.data
      if (tokens) {
        const key = `${language}\0${code}`
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
      setResult({ code, language, tokens })
      worker.terminate()
    }
    worker.onerror = () => worker.terminate()
    worker.postMessage({ code, language })
    return () => worker.terminate()
  }, [code, language, ready])
  return ready ?? (result?.code === code && result.language === language ? result.tokens : null)
}
