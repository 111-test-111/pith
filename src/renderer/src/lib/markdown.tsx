import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/agents/code-block'

/**
 * Assistant markdown renderer: react-markdown + GFM (tables, task lists,
 * strikethrough), with output styled through beUI theme tokens. Fenced code
 * renders with beUI's CodeBlock; everything else maps to token-styled elements.
 */

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

type MarkdownComponents = ComponentPropsWithoutRef<typeof ReactMarkdown>['components']

const components: MarkdownComponents = {
  pre({ children }) {
    const { code, language } = extractCodeBlock(children)
    return <CodeBlock code={code} language={normalizeLanguage(language)} status="complete" />
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

export function Markdown({ children }: { children: string }): ReactNode {
  return (
    // `overflow-wrap: anywhere` keeps unbroken tokens (long paths, URLs) from
    // widening the bubble; code blocks opt out via their own whitespace-pre.
    <div className="space-y-3 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
