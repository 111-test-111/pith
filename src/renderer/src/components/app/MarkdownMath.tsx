import { lazy, memo, Suspense } from 'react'

// The engine, its CSS and font are fetched once, only if math is encountered.
const MathContent = lazy(() => import('@/lib/math-renderer'))

export interface MarkdownMathProps {
  source: string
  raw: string
  display: boolean
  incomplete?: boolean
}

export const MarkdownMath = memo(function MarkdownMath(props: MarkdownMathProps) {
  const fallback = <span data-math-fallback className={props.display ? 'block whitespace-pre-wrap font-mono text-xs' : 'font-mono text-xs'}>{props.raw}</span>
  if (props.incomplete || props.source.length > 16_384) return fallback
  return <Suspense fallback={fallback}><MathContent {...props} /></Suspense>
})
