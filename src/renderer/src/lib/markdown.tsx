import { createContext, memo, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/agents/code-block'

/**
 * Assistant markdown renderer: react-markdown + GFM (tables, task lists,
 * strikethrough), with output styled through beUI theme tokens. Fenced code
 * renders with beUI's CodeBlock; everything else maps to token-styled elements.
 *
 * While `streaming`, the text is split at blank-line boundaries OUTSIDE code
 * fences into stable leading blocks plus a live tail: blocks render through a
 * memoized component, so each delta only re-parses the trailing block, and
 * fenced code skips shiki highlighting until the turn completes. Block-level
 * structures that legitimately span a blank line (loose lists, link
 * reference definitions) may render split while streaming; the completed
 * message always re-parses the full text in one piece.
 */

/** True while the surrounding Markdown is streaming — CodeBlock renders its
 * streaming state (no highlighting, "Writing" chip) instead of "complete". */
const StreamingMarkdownContext = createContext(false)

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'typescript',
  javascript: 'typescript',
  jsx: 'tsx',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'text',
  python: 'text',
  rust: 'text',
  go: 'text',
  css: 'text',
  html: 'text',
  yaml: 'text',
  toml: 'text'
}

export function normalizeLanguage(
  lang?: string
): 'bash' | 'diff' | 'json' | 'text' | 'tsx' | 'typescript' {
  const base = (lang ?? '').toLowerCase().split(/[\s:,]/)[0]
  if (!base) return 'text'
  if (['bash', 'diff', 'json', 'text', 'tsx', 'typescript'].includes(base)) {
    return base as 'bash' | 'diff' | 'json' | 'text' | 'tsx' | 'typescript'
  }
  return (LANGUAGE_ALIASES[base] as 'text') ?? 'text'
}

function extractCodeBlock(children: ReactNode): { code: string; language?: string } {
  const child = (Array.isArray(children) ? children[0] : children) as
    | { props?: { className?: string; children?: ReactNode } }
    | undefined
  const props = child?.props ?? {}
  const match = /language-([\w-]+)/.exec(props.className ?? '')
  const code = typeof props.children === 'string' ? props.children : ''
  return { code: code.replace(/\n$/, ''), language: match?.[1] }
}

function isClosingFence(line: string, fence: string): boolean {
  const match = new RegExp(`^ {0,3}(${fence[0]}{${fence.length},})\\s*$`).exec(line)
  return Boolean(match)
}

/**
 * Cut points (character offsets) where a following block starts: right after
 * each blank line that is not inside a code fence. Cut positions of a growing
 * text are append-only, so block strings stay stable across deltas.
 */
function markdownCutPoints(text: string): number[] {
  const cuts: number[] = []
  let fence: string | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    if (fence) {
      if (isClosingFence(line, fence)) fence = null
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        fence = open[1]
      } else if (line === '' && offset + 1 <= text.length) {
        cuts.push(offset + 1)
      }
    }
    offset += line.length + 1
  }
  return cuts
}

function splitMarkdownBlocks(text: string): { stable: string[]; tail: string } {
  const cuts = markdownCutPoints(text)
  const stable: string[] = []
  let start = 0
  for (const cut of cuts) {
    stable.push(text.slice(start, cut))
    start = cut
  }
  return { stable, tail: text.slice(start) }
}

type MarkdownComponents = ComponentPropsWithoutRef<typeof ReactMarkdown>['components']

const components: MarkdownComponents = {
  pre({ children }) {
    const { code, language } = extractCodeBlock(children)
    return (
      <CodeBlock
        code={code}
        language={normalizeLanguage(language)}
        status={useContext(StreamingMarkdownContext) ? 'streaming' : 'complete'}
      />
    )
  },
  code({ children }) {
    // Only inline code reaches this override — fenced code is consumed by `pre`.
    return (
      <code className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    )
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (!href) return
          event.preventDefault()
          void window.pi.openExternal(href)
        }}
        className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    )
  },
  thead({ children }) {
    return <thead className="bg-muted/60">{children}</thead>
  },
  th({ children }) {
    return (
      <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">
        {children}
      </th>
    )
  },
  td({ children }) {
    return <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  },
  tr({ children }) {
    return <tr className="last:[&>td]:border-b-0">{children}</tr>
  },
  ul({ children }) {
    return <ul className="ml-5 list-disc space-y-1 marker:text-muted-foreground">{children}</ul>
  },
  ol({ children }) {
    return <ol className="ml-5 list-decimal space-y-1 marker:text-muted-foreground">{children}</ol>
  },
  li({ children }) {
    return <li className="pl-1 [>&]:min-w-0">{children}</li>
  },
  h1({ children }) {
    return <h1 className="text-lg font-semibold text-foreground">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-base font-semibold text-foreground">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold text-foreground">{children}</h3>
  },
  h4({ children }) {
    return <h4 className="text-sm font-semibold text-foreground">{children}</h4>
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    )
  },
  hr() {
    return <hr className="border-border" />
  },
  img({ src, alt }) {
    return (
      <img
        src={typeof src === 'string' ? src : undefined}
        alt={alt ?? ''}
        className="max-h-72 max-w-full rounded-xl border border-border object-contain"
      />
    )
  }
}

/** One already-final markdown block — memoized so stable blocks never
 * re-parse while the tail streams. */
const MarkdownBlock = memo(function MarkdownBlock({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
})

export const Markdown = memo(function Markdown({
  children,
  streaming = false
}: {
  children: string
  streaming?: boolean
}) {
  const blocks = streaming ? splitMarkdownBlocks(children) : null
  return (
    <StreamingMarkdownContext.Provider value={streaming}>
      {/* `overflow-wrap: anywhere` keeps unbroken tokens (long paths, URLs)
          from widening the bubble; code blocks opt out via their own
          whitespace-pre. Stacked streaming blocks keep single-parse spacing
          through this wrapper's own `space-y-3`. */}
      <div className="space-y-3 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        {blocks ? (
          <>
            {blocks.stable.map((block, index) => (
              <MarkdownBlock key={index}>{block}</MarkdownBlock>
            ))}
            {blocks.tail ? <MarkdownBlock>{blocks.tail}</MarkdownBlock> : null}
          </>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {children}
          </ReactMarkdown>
        )}
      </div>
    </StreamingMarkdownContext.Provider>
  )
})
