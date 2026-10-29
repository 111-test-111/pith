import { memo, useMemo, useRef } from 'react'
import temml from 'temml'
import 'temml/dist/Temml-Local.css'
import './math.css'
import type { MarkdownMathProps } from '@/components/app/MarkdownMath'
import { useScrollFade } from './hooks/use-scroll-fade'
import { createMathMacros } from './math-compat'

// Shared across chat, file tabs and remounts; bounded by count AND UTF-16
// storage. Failures are cached too, so malformed formulas are not retried on
// every streamed text delta. Macro definitions never escape one expression.
const cache = new Map<string, string | null>()
let cacheBytes = 0
const MAX_CACHE_BYTES = 1024 * 1024

export function renderMath(source: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}${source}`
  if (cache.has(key)) {
    const value = cache.get(key)!
    cache.delete(key)
    cache.set(key, value)
    return value
  }
  let value: string | null = null
  if (source.length <= 16_384) {
    try {
      value = temml.renderToString(source, {
        displayMode: display, annotate: true, throwOnError: true,
        trust: false, maxExpand: 1000, maxSize: [20, 200], macros: createMathMacros()
      })
    } catch { /* Incomplete/unsupported TeX stays readable as source. */ }
  }
  const bytes = 2 * (key.length + (value?.length ?? 0))
  if (bytes <= MAX_CACHE_BYTES) {
    while (cache.size >= 128 || cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value!
      cacheBytes -= 2 * (oldest.length + (cache.get(oldest)?.length ?? 0))
      cache.delete(oldest)
    }
    cache.set(key, value)
    cacheBytes += bytes
  }
  return value
}

export default memo(function MathContent({ source, raw, display }: MarkdownMathProps) {
  const html = useMemo(() => renderMath(source, display), [source, display])
  const viewport = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLSpanElement>(null)
  const { maskImage } = useScrollFade(viewport, { axis: 'horizontal', contentRef: content, dependsOn: html })
  return <span ref={viewport} data-math-rendered={display ? 'display' : 'inline'}
    className={`markdown-math ${display ? 'markdown-math-display' : 'markdown-math-inline'}`}
    style={{ maskImage, WebkitMaskImage: maskImage }}>
    {/* Only Temml's escaped, trust:false output is inserted, never Markdown HTML. */}
    {html === null
      ? <span ref={content} data-math-fallback className="whitespace-pre-wrap font-mono text-xs">{raw}</span>
      : <span ref={content} className="markdown-math-content" dangerouslySetInnerHTML={{ __html: html }} />}
  </span>
})
