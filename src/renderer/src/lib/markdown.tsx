import {
  Component,
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode
} from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { CodeBlock } from '@/components/agents/code-block'
import { PreviewThumb } from '@/components/app/ImagePreview'
import { MarkdownMath } from '@/components/app/MarkdownMath'
import { REMARK_PLUGINS } from '@/lib/markdown-plugins'
import { splitMarkdownBlocks } from '@/lib/markdown-blocks'
import { normalizeQuotedMath } from '@/lib/markdown-quoted-math'
import { localFileTarget, useFileNavigation } from '@/lib/file-navigation'
import { codeLanguage } from '@/lib/file-language'
import { getOpenLinksInBrowserPref, requestBrowserOpenLink } from '@/lib/browser/open-link'

/**
 * Assistant markdown renderer: react-markdown + GFM (tables, task lists,
 * strikethrough), math and the CJK emphasis/autolink fixes in `markdown-plugins`,
 * with output styled through beUI theme tokens. Fenced code
 * renders with beUI's CodeBlock; everything else maps to token-styled elements.
 *
 * While `streaming`, the text is split at blank-line boundaries OUTSIDE code
 * and math fences into stable leading blocks plus a live tail: blocks render through a
 * memoized component, so each delta only re-parses the trailing block, and
 * fenced code skips shiki highlighting until the turn completes. Block-level
 * structures that legitimately span a blank line (loose lists, link
 * reference definitions) may render split while streaming; the completed
 * message always re-parses the full text in one piece.
 */

/** True while the surrounding Markdown is streaming — CodeBlock renders its
 * streaming state (no highlighting, "Writing" chip) instead of "complete". */
const StreamingMarkdownContext = createContext(false)

/**
 * Markdown image sources are usually WORKSPACE paths (`output/cat.png`), not
 * browser URLs: the renderer is served from its own origin (dev server, or the
 * packaged `file://` page), so a raw `src` resolves next to the renderer bundle
 * and 404s. Resolve them through the main process the same way @mentions are
 * resolved (relative to the active workspace, absolute paths as-is) and hand
 * the image a data URL — plus its absolute path, so the preview overlay can
 * offer "open in default app".
 *
 * Only successful reads are cached (10s TTL, bounded) so a streaming turn that
 * references a file a later tool call still has to write can retry, and a
 * regenerated file under the same name is not served from a stale cache.
 */
const IMAGE_SRC_TTL_MS = 10_000
const IMAGE_SRC_CACHE_MAX = 32
interface ResolvedImage {
  url: string
  /** Absolute local path, when the source was a workspace file. */
  path?: string
}
const imageSrcCache = new Map<string, { image: ResolvedImage; at: number }>()
const imageSrcPending = new Map<string, Promise<ResolvedImage | null>>()

/** `data:`/`blob:`/`http(s):` sources the browser can load on its own. */
function inlineImageSrc(src: string): string | null {
  return /^(data:|blob:|https?:)/i.test(src) ? src : null
}

/** Local path behind a source — a plain path, or the pathname of a `file:` URL. */
function filePathOf(src: string): string | null {
  if (!/^file:/i.test(src)) return src
  try {
    return decodeURIComponent(new URL(src).pathname)
  } catch {
    return null
  }
}

function resolveImage(src: string): Promise<ResolvedImage | null> {
  const cached = imageSrcCache.get(src)
  if (cached && Date.now() - cached.at < IMAGE_SRC_TTL_MS) return Promise.resolve(cached.image)
  const pending = imageSrcPending.get(src)
  if (pending) return pending
  const localPath = filePathOf(src)
  if (!localPath) return Promise.resolve(null)
  const promise = window.pi
    .readFile(localPath)
    .then((preview) => {
      if (!preview.base64 || !preview.mimeType) return null
      const image: ResolvedImage = {
        url: `data:${preview.mimeType};base64,${preview.base64}`,
        path: preview.path
      }
      imageSrcCache.set(src, { image, at: Date.now() })
      if (imageSrcCache.size > IMAGE_SRC_CACHE_MAX) {
        // Map iterates in insertion order — drop the oldest entry.
        const oldest = imageSrcCache.keys().next().value
        if (oldest) imageSrcCache.delete(oldest)
      }
      return image
    })
    .catch(() => null)
    .finally(() => {
      imageSrcPending.delete(src)
    })
  imageSrcPending.set(src, promise)
  return promise
}

function MarkdownImage({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
  const navigation = useFileNavigation()
  const source = typeof src === 'string' && !inlineImageSrc(src) && navigation.cwd ? localFileTarget(src, navigation.cwd)?.path ?? src : src
  const streaming = useContext(StreamingMarkdownContext)
  const direct = typeof src === 'string' ? inlineImageSrc(src) : null
  const [resolved, setResolved] = useState<ResolvedImage | null>(direct ? { url: direct } : null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (typeof src !== 'string' || !src) {
      setResolved(null)
      setFailed(false)
      return
    }
    const inline = inlineImageSrc(src)
    if (inline) {
      setResolved({ url: inline })
      setFailed(false)
      return
    }
    let cancelled = false
    void resolveImage(typeof source === 'string' ? source : src).then((image) => {
      if (cancelled) return
      setResolved(image)
      setFailed(!image)
    })
    return () => {
      cancelled = true
    }
    // `streaming` is a dependency on purpose: a reference that cannot be read
    // mid-turn (the file appears later in the same turn) is retried once the
    // completed message re-renders with `streaming: false`.
  }, [src, source, streaming])

  if (resolved) {
    return (
      <PreviewThumb
        src={resolved.url}
        alt={alt ?? ''}
        title={title}
        path={resolved.path}
        className="rounded-xl"
        imageClassName="max-h-72 max-w-full object-contain"
      />
    )
  }
  // Unreadable source: show its alt text instead of Chromium's broken-image
  // glyph. Nothing while a read is merely in flight (no placeholder flash).
  return failed && alt ? <span className="text-muted-foreground">{alt}</span> : null
}

export const normalizeLanguage = codeLanguage

function extractCodeBlock(children: ReactNode): { code: string; language?: string } {
  const child = (Array.isArray(children) ? children[0] : children) as
    | { props?: { className?: string; children?: ReactNode } }
    | undefined
  const props = child?.props ?? {}
  const match = /language-([\w-]+)/.exec(props.className ?? '')
  const code = typeof props.children === 'string' ? props.children : ''
  return { code: code.replace(/\n$/, ''), language: match?.[1] }
}

/** Route ordinary unmodified HTTP(S) clicks from every Markdown surface into the embedded browser when enabled. Preserve modifier-key intent and other schemes (files use FileNavigationProvider, others open externally). Read the preference synchronously outside hook context. */
function isBrowserOpenLinkClick(href: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (!/^https?:\/\//i.test(href)) return false
  return getOpenLinksInBrowserPref()
}

type MarkdownComponents = ComponentPropsWithoutRef<typeof ReactMarkdown>['components']

const components: MarkdownComponents = {
  span({ node, children }) {
    const props = node?.properties
    if (props?.['data-math']) return <MarkdownMath
      source={String(props['data-math-source'] ?? '')}
      raw={String(props['data-math-raw'] ?? '')}
      display={props['data-math'] === 'display'}
      incomplete={props['data-math-incomplete'] === true}
    />
    return <span>{children}</span>
  },
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
      <code className="rounded-detail bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
        {children}
      </code>
    )
  },
  a({ href, title, children }) {
    const navigation = useFileNavigation()
    return (
      <a
        href={href}
        title={title}
        onClick={(event) => {
          if (!href) return
          event.preventDefault()
          if (href.startsWith('#')) {
            const page = event.currentTarget.closest<HTMLElement>('[data-file-markdown]')
            let anchor = href.slice(1)
            try { anchor = decodeURIComponent(anchor) } catch { /* literal fragment */ }
            const heading = [...(page?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? [])].find(element =>
              element.textContent?.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-') === anchor)
            if (page && heading) page.scrollTop += heading.getBoundingClientRect().top - page.getBoundingClientRect().top
          } else if (isBrowserOpenLinkClick(href, event)) {
            // Queue and dispatch pith:browser-open-link. Mounted panes drain immediately; otherwise Workspace opens the pane and mount drains. preventDefault already ran above.
            requestBrowserOpenLink(href)
          } else navigation.open(href)
        }}
        className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      // Wide tables scroll horizontally inside the frame instead of squeezing
      // every column into the message width: the cell min-widths below are what
      // let the table outgrow the frame. Scrollbars stay hidden per the app's
      // chrome-less policy — trackpad swipe / Shift+wheel scroll the frame.
      <div className="w-full overflow-x-auto overscroll-x-contain rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    )
  },
  thead({ children }) {
    return <thead className="bg-muted/60">{children}</thead>
  },
  th({ children, style }) {
    return (
      // Headers stay on one line; the min-width floor keeps a many-column table
      // from wrapping into unreadable slivers.
      <th style={{ textAlign: style?.textAlign }} className="min-w-20 whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold text-foreground">
        {children}
      </th>
    )
  },
  td({ children, style }) {
    // `break-word` replaces the transcript's inherited `overflow-wrap:anywhere`
    // so words break at natural points, and the max-width cap keeps one long
    // text column from stretching the whole table.
    return <td style={{ textAlign: style?.textAlign }} className="min-w-20 max-w-80 border-b border-border/60 px-3 py-2 align-top [overflow-wrap:break-word]">{children}</td>
  },
  tr({ children }) {
    return <tr className="last:[&>td]:border-b-0">{children}</tr>
  },
  ul({ children }) {
    return <ul className="ml-5 list-disc space-y-1 marker:text-muted-foreground">{children}</ul>
  },
  ol({ children, start }) {
    return <ol start={start} className="ml-5 list-decimal space-y-1 marker:text-muted-foreground">{children}</ol>
  },
  li({ children, className }) {
    return <li className={`pl-1 [>&]:min-w-0${className?.split(' ').includes('task-list-item') ? ' list-none' : ''}`}>{children}</li>
  },
  h1({ children }) {
    return <h1 className="text-base font-bold text-foreground">{children}</h1>
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
      <blockquote className="border-l border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    )
  },
  hr() {
    return <hr className="border-border" />
  },
  img: MarkdownImage
}

function markdownUrlTransform(url: string): string {
  return /^file:/i.test(url) || /^[a-z]:[\\/]/i.test(url) || /^[^?#:]+\.[\w-]+:\d+(?::\d+)?(?:-\d+)?$/.test(url) ? url : defaultUrlTransform(url)
}

/** A parser/component/chunk failure belongs to this block, never the app.
 * Preserve readable source and retry on the next edit or streaming delta,
 * without remounting healthy blocks (and their formula/code caches). */
class MarkdownBlockBoundary extends Component<{ source: string; children: ReactNode }, { source: string; failed: boolean }> {
  state = { source: this.props.source, failed: false }

  static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
    return props.source !== state.source ? { source: props.source, failed: false } : null
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed
      ? <div data-markdown-fallback className="whitespace-pre-wrap">{this.props.source}</div>
      : this.props.children
  }
}

function ParsedMarkdown({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={markdownUrlTransform}>
      {normalizeQuotedMath(source)}
    </ReactMarkdown>
  )
}

/** One already-final markdown block — memoized so stable blocks never
 * re-parse while the tail streams. */
const MarkdownBlock = memo(function MarkdownBlock({ children }: { children: string }) {
  return <MarkdownBlockBoundary source={children}><ParsedMarkdown source={children} /></MarkdownBlockBoundary>
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
          <MarkdownBlock>{children}</MarkdownBlock>
        )}
      </div>
    </StreamingMarkdownContext.Provider>
  )
})
