import { cn } from '@/lib/utils'

/**
 * GPT-family reasoning summaries arrive as space-separated `**topic**` runs
 * grouped into paragraphs. Split one paragraph into those runs (markers
 * stripped) plus any prose between them; whitespace-only fragments are dropped
 * so a run followed by a space never produces an empty line.
 */
function splitSegments(paragraph: string): string[] {
  const pattern = /\*\*([\s\S]+?)\*\*/g
  const segments: string[] = []
  let cursor = 0
  for (const match of paragraph.matchAll(pattern)) {
    const start = match.index ?? 0
    const plain = paragraph.slice(cursor, start).trim()
    if (plain) segments.push(plain)
    const topic = match[1].trim()
    if (topic) segments.push(topic)
    cursor = start + match[0].length
  }
  const rest = paragraph.slice(cursor).trim()
  if (rest) segments.push(rest)
  return segments.length ? segments : [paragraph.trim()]
}

/**
 * Reasoning body renderer: each `**topic**` gets its own line, lines inside a
 * paragraph stay tightly spaced (like a natural line wrap) and paragraphs are
 * separated by a wider gap. Markers are stripped and the text keeps the regular
 * weight/color of the surrounding reasoning block. Text without markers falls
 * through unchanged.
 */
export function ReasoningText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  if (!paragraphs.length) return null

  return (
    <div className={cn('space-y-2', className)}>
      {paragraphs.map((paragraph, paragraphIndex) => (
        <div key={paragraphIndex} className="space-y-0.5">
          {splitSegments(paragraph).map((segment, segmentIndex) => (
            <p key={segmentIndex} className="whitespace-pre-wrap">
              {segment}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}
