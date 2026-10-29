import { useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { Image, ZoomIn, ZoomOut } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { basename } from '@/lib/format'
import { useImageZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_SPRING, ZOOM_STEP } from '@/lib/hooks/use-image-zoom'
import { cn } from '@/lib/utils'
import { mediaUrl, type MediaKind } from '../../../../shared/media'
import type { FileTab } from '@/state/file-browser-store'
import { FileMediaPlayer } from './FileMediaPlayer'

/**
 * Inline preview of an image, video or audio file in the file pane. Chromium
 * does the decoding; the bytes arrive over the `pith-media` scheme
 * (`src/main/media-protocol.ts`), which serves them as a seekable Range stream
 * so nothing has to be read into memory or pushed through IPC. The native media
 * elements are the engine here, not a UI kit — the chrome around them (zoom
 * controls, panels, notices) is beUI primitives and theme tokens.
 */

function MediaNotice({ children }: { children: ReactNode }) {
  return <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/30 p-5 text-center text-xs leading-ui text-muted-foreground">
    <Image aria-hidden className="size-5 text-muted-foreground/60" />{children}
  </div>
}

function ImageView({ path }: { path: string }) {
  const { t } = useI18n()
  const reduce = useReducedMotion() ?? false
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // The pane shares the window with the composer, so the +/-/arrow shortcuts
  // are heard only while this viewport has focus (the overlay listens globally).
  const { view, dragging, zoomed, pannable, zoomAt, reset, handlers } = useImageZoom({ viewportRef, imageRef: imgRef, keyboard: 'element' })
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  if (failed) return <MediaNotice>{t('files.media.failed')}</MediaNotice>
  return <div
    ref={viewportRef}
    role="group"
    tabIndex={0}
    data-file-media="image"
    aria-label={t('files.media.viewportAria')}
    {...handlers}
    className={cn(
      'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 [touch-action:none] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
      pannable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
    )}
  >
    <motion.img
      ref={imgRef}
      src={mediaUrl(path)}
      alt={basename(path)}
      draggable={false}
      onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => setFailed(true)}
      animate={{ scale: view.scale, x: view.x, y: view.y }}
      // Dragging must track the pointer 1:1; everything else springs.
      transition={dragging || reduce ? { duration: 0 } : ZOOM_SPRING}
      // Same interface-style radius as the overlay's own view of the picture:
      // the window step (0 square, 28px squircle — never less round than the
      // macOS window corner), shape from the base corner rule.
      className="max-h-full max-w-full select-none rounded-window object-contain will-change-transform"
    />
    <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-control border border-border bg-background/90 p-0.5 pl-2 shadow-overlay backdrop-blur-sm">
      {size ? <span className="pr-1.5 text-micro tabular-nums text-muted-foreground">{size.width} × {size.height}</span> : null}
      <Tooltip content={t('imagePreview.zoomOut')}><Button variant="ghost" size="icon" className="size-7" aria-label={t('imagePreview.zoomOut')} disabled={view.scale <= ZOOM_MIN} onClick={() => zoomAt(1 / ZOOM_STEP)}><ZoomOut aria-hidden className="size-3.5" /></Button></Tooltip>
      <Tooltip content={t('imagePreview.resetZoom')}><Button variant="ghost" size="sm" className="min-w-14 justify-center tabular-nums text-xs" aria-label={t('imagePreview.resetZoom')} disabled={!zoomed} onClick={reset}>{Math.round(view.scale * 100)}%</Button></Tooltip>
      <Tooltip content={t('imagePreview.zoomIn')}><Button variant="ghost" size="icon" className="size-7" aria-label={t('imagePreview.zoomIn')} disabled={view.scale >= ZOOM_MAX} onClick={() => zoomAt(ZOOM_STEP)}><ZoomIn aria-hidden className="size-3.5" /></Button></Tooltip>
    </div>
  </div>
}

export function FileMedia({ tab, kind, refresh }: { tab: FileTab; kind: MediaKind; refresh: number }) {
  // `no-store` on the protocol response means a remount always re-reads the
  // current bytes, so the refresh counter remounts an image after the agent
  // rewrote it — while a video keeps its position, since losing playback is
  // worse than a stale frame there.
  if (kind === 'image') return <ImageView key={`${tab.path}:${refresh}`} path={tab.path} />
  return <FileMediaPlayer key={tab.path} path={tab.path} kind={kind} />
}
