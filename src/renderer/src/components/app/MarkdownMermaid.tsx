import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CodeBlock } from '@/components/agents/code-block'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useImagePreviewTrigger } from './ImagePreview'
import { Check, Copy, Download, FileCode2, Maximize2, WrapText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { capturePointer, releasePointer, TOUCH_GESTURE_CLASS } from '@/lib/touch'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { useWheelScroll } from '@/lib/hooks/use-wheel-scroll'
import { MERMAID_SOURCE_LIMIT, renderMermaid, useMermaidAppearance, type MermaidImage } from '@/lib/mermaid'
import { useI18n } from '@/i18n'

/** Shared by conversation, file and notebook Markdown. Source is never rewritten. */
export const MarkdownMermaid = memo(function MarkdownMermaid({ code, streaming }: { code: string; streaming: boolean }) {
  const { t } = useI18n()
  const appearance = useMermaidAppearance()
  const [view, setView] = useState('preview')
  const [wrap, setWrap] = useState(false)
  const [rendered, setRendered] = useState<{ key: string; image?: MermaidImage; failed?: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ node: HTMLDivElement; pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const key = JSON.stringify([code, appearance])
  const current = rendered?.key === key ? rendered : null
  const tooLarge = code.length > MERMAID_SOURCE_LIMIT
  const { ref: previewButtonRef, open: openImage } = useImagePreviewTrigger(
    current?.image && !streaming && !tooLarge ? { src: current.image.src, label: t('mermaid.diagram') } : null
  )

  useEffect(() => {
    if (streaming || view !== 'preview' || tooLarge) return
    const controller = new AbortController()
    void renderMermaid(code, appearance, controller.signal).then(
      image => { if (!controller.signal.aborted) setRendered({ key, image }) },
      () => { if (!controller.signal.aborted) setRendered({ key, failed: true }) }
    )
    return () => controller.abort()
  }, [code, appearance, key, streaming, view, tooLarge])
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch { setCopied(false) }
  }
  const source = view === 'source' || streaming || tooLarge || current?.failed
  const previewKey = source ? null : current?.image?.src ?? 'loading'
  useWheelScroll(previewRef, previewKey)
  const { maskImage: horizontalFade } = useScrollFade(previewRef, { axis: 'horizontal', dependsOn: previewKey })
  const { maskImage: verticalFade } = useScrollFade(previewRef, { dependsOn: previewKey })
  const maskImage = horizontalFade && verticalFade ? `${horizontalFade}, ${verticalFade}` : horizontalFade ?? verticalFade
  useEffect(() => {
    setDragging(false)
    return () => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag) releasePointer(drag.node, drag.pointerId)
    }
  }, [previewKey])
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!current?.image || event.button !== 0 || !event.isPrimary || dragRef.current) return
    event.preventDefault()
    const node = event.currentTarget
    node.focus({ preventScroll: true })
    dragRef.current = { node, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
    capturePointer(node, event.pointerId)
    setDragging(true)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.node.scrollLeft = drag.left + drag.x - event.clientX
    drag.node.scrollTop = drag.top + drag.y - event.clientY
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    releasePointer(drag.node, drag.pointerId)
  }
  const notice = streaming ? t('mermaid.streaming') : tooLarge ? t('mermaid.tooLarge') : current?.failed ? t('mermaid.failed') : null
  const download = () => {
    if (!current?.image || streaming || tooLarge) return
    const link = document.createElement('a')
    link.href = current.image.src
    link.download = 'mermaid.svg'
    link.click()
  }
  const actionClass = 'size-7 shrink-0 hover:bg-background/70'

  return <div data-mermaid-block data-mermaid-state={streaming ? 'streaming' : tooLarge ? 'oversized' : current?.failed ? 'failed' : current?.image ? 'ready' : 'loading'}
    className="@container/mermaid w-full overflow-hidden rounded-card bg-muted/80 text-sm">
    <div className="flex h-10 items-center gap-2.5 px-3">
      <FileCode2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="sr-only min-w-0 truncate text-micro font-medium uppercase tracking-wide text-muted-foreground/55 @min-[26em]/mermaid:not-sr-only">Mermaid</span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tabs value={view} onValueChange={setView} variant="segment">
          <TabsList className="bg-transparent">
            <TabsTrigger value="preview" className="min-h-0 px-2 py-1 text-xs">{t('mermaid.preview')}</TabsTrigger>
            <TabsTrigger value="source" className="min-h-0 px-2 py-1 text-xs">{t('mermaid.source')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tooltip content={t('mermaid.openPreview')}>
          <Button ref={previewButtonRef} variant="ghost" size="icon" className={actionClass} aria-label={t('mermaid.openPreview')}
            disabled={!current?.image || streaming || tooLarge}
            onClick={openImage}>
            <Maximize2 className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('mermaid.wrap')}>
          <Button variant="ghost" size="icon" className={cn(actionClass, wrap && view === 'source' && 'bg-background/70 text-foreground')}
            aria-label={t('mermaid.wrap')} aria-pressed={wrap} disabled={view !== 'source'} onClick={() => setWrap(value => !value)}>
            <WrapText className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('mermaid.download')}>
          <Button variant="ghost" size="icon" className={actionClass} aria-label={t('mermaid.download')}
            disabled={!current?.image || streaming || tooLarge} onClick={download}>
            <Download className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={copied ? t('mermaid.copied') : t('mermaid.copy')}>
          <Button variant="ghost" size="icon" className={actionClass} aria-label={copied ? t('mermaid.copied') : t('mermaid.copy')} onClick={() => void copy()}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </Tooltip>
      </div>
    </div>
    {notice && view === 'preview' ? <p role={current?.failed ? 'status' : undefined} className="border-t border-foreground/[0.06] px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
    {source ? <CodeBlock code={code} language="mermaid" status={streaming ? 'streaming' : 'complete'} showHeader={false} wrap={wrap} onWrapChange={setWrap} copyable={false} className="rounded-inherit bg-transparent" />
      : <div ref={previewRef} data-mermaid-viewport role="region" aria-label={t('mermaid.diagram')} tabIndex={current?.image ? 0 : undefined}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        className={cn('min-h-24 max-h-[70vh] overflow-auto overscroll-contain border-t border-foreground/[0.06] bg-background p-4 outline-none',
          current?.image && [TOUCH_GESTURE_CLASS, 'touch-none', dragging ? 'cursor-grabbing' : 'cursor-grab'])}
        style={{ maskImage, maskComposite: horizontalFade && verticalFade ? 'intersect' : undefined }}>
        <div className="flex min-h-16 w-max min-w-full items-center justify-center">
          {/* Preserve the SVG's native scale: its ordinary text already uses
              the compact interface size. Fitting to width shrank it again. */}
          {current?.image ? <img src={current.image.src} alt={t('mermaid.diagram')} draggable={false}
            className="block h-auto max-w-none shrink-0 rounded-item border border-transparent" />
            : <span role="status" className="text-xs text-muted-foreground">{t('mermaid.loading')}</span>}
        </div>
      </div>}
  </div>
})
