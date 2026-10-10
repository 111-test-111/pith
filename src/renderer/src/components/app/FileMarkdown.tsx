import { useMemo } from 'react'
import { Markdown } from '@/lib/markdown'
import { splitFileMarkdown } from '@/lib/file-markdown'

/** File-only formatting for YAML frontmatter and standalone XML-like blocks. */
export function FileMarkdown({ text }: { text: string }) {
  const { frontmatter, sections } = useMemo(() => splitFileMarkdown(text), [text])
  return <div className="space-y-4">
    {frontmatter !== null ? <pre data-file-frontmatter className="rounded-card bg-muted/60 px-4 py-3 font-mono text-code text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]">{frontmatter}</pre> : null}
    {sections.map((section, index) => section.kind === 'tag-block'
      ? <pre key={index} data-file-tag-block className="font-sans text-content text-foreground whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]">{section.text}</pre>
      : <Markdown key={index} preserveLineBreaks>{section.text}</Markdown>)}
  </div>
}
