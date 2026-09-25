import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ExternalLink, ZoomIn, ZoomOut } from '@/lib/icons'
import { useImageZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_SPRING, ZOOM_STEP } from '@/lib/hooks/use-image-zoom'
import {
  CenterMorphModal,
  CenterMorphModalContent
} from '@/components/motion/center-morph-modal'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Full-screen image preview for every image the app renders: composer
 * attachments, images inside user bubbles and images embedded in assistant
 * markdown. The overlay is beUI's CenterMorphModal as an OPEN frame: it unfolds
 * from its own centre but paints no surface, so the image floats over the
 * dimmed page and only the caption and control bars are filled. Everything
 * inside it — zoom/pan, caption, controls — is composed from beUI primitives
 * and theme tokens.
 */

/** An image the preview can show. `src` must be browser-loadable: a `data:` or
 * blob URL, or a remote `http(s)` URL — workspace paths are resolved to data
 * URLs by their source (see `lib/markdown.tsx`). */
export interface PreviewImage {
  src: string
  /** Caption and accessible name (alt text, file name). */
  label?: string
  /** Absolute local path when the image lives in the workspace: enables
   * "open in default app". Browser-picked uploads have none. */
  path?: string
}

/** Opens the overlay for one image; an image without a `src` is ignored. */
type OpenImage = (image: PreviewImage) => void

const ImagePreviewContext = createContext<OpenImage | null>(null)

/** Opens the image preview from anywhere in the app. */
export function useImagePreview(): OpenImage {
  const open = useContext(ImagePreviewContext)
  if (!open) throw new Error('useImagePreview must be used within <ImagePreviewProvider>')
  return open
}

/** Mounted once near the app root: provides `useImagePreview` and hosts the one
 * overlay instance every image on screen opens. */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ id: number; image: PreviewImage } | null>(null)
  const open = useCallback<OpenImage>((image) => {
    if (!image?.src) return
    // The id remounts the viewer — a reopened image always starts at fit, at a
    // fresh centre, instead of inheriting the previous zoom/pan.
    setRequest((previous) => ({ id: (previous?.id ?? 0) + 1, image }))
  }, [])

  return (
    <ImagePreviewContext.Provider value={open}>
      {children}
      {/* While the overlay exits, AnimatePresence keeps rendering the element it
          was given, so clearing `request` here cannot blank the closing image. */}
      <ImagePreviewHost request={request} onClose={() => setRequest(null)} />
    </ImagePreviewContext.Provider>
  )
}

function ImagePreviewHost({
  request,
  onClose
}: {
  request: { id: number; image: PreviewImage } | null
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <CenterMorphModal
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/* Open-frame panel: beUI still owns the frame (border, radius, motion),
          but the surface itself paints nothing — the blank area around the image
          shows the dimmed page behind instead of a white fill. The caption and
          control bars carry their own `bg-background`, so the panel reads as a
          window onto the image rather than a white card. `pr-14` on the caption
          keeps it clear of the modal's own close control. */}
      <CenterMorphModalContent
        ariaLabel={request?.image.label || t('imagePreview.dialogLabel')}
        closeButtonLabel={t('imagePreview.close')}
        className="h-[min(78vh,48rem)] max-w-[min(92vw,72rem)] bg-transparent"
      >
        {request ? <ImageZoom key={request.id} image={request.image} /> : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}

function ImageZoom({ image }: { image: PreviewImage }) {
  const { t } = useI18n()
  const reduce = useReducedMotion() ?? false
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // The overlay owns the window, so its zoom shortcuts are global.
  const { view, dragging, zoomed, pannable, zoomAt, reset, handlers } = useImageZoom({ viewportRef, imageRef: imgRef })
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  const subtitle = [size ? `${size.width} × ${size.height}` : null, image.path ? basename(image.path) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* h-16 centres this row on the modal's own close control (16px inset +
          32px button = 32px centre), which a h-14 row left 4px above. */}
      <div className="flex h-16 flex-none items-center gap-3 border-b border-border bg-background px-4 pr-14">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {image.label || t('imagePreview.dialogLabel')}
        </p>
      </div>

      <div
        ref={viewportRef}
        role="group"
        tabIndex={0}
        aria-label={t('imagePreview.viewportAria')}
        {...handlers}
        className={cn(
          // No fill of its own: whatever surrounds the image is the page behind
          // the overlay, so an image is never boxed in by a white pane.
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden [touch-action:none] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          pannable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
        )}
      >
        <motion.img
          ref={imgRef}
          src={image.src}
          alt={image.label ?? ''}
          draggable={false}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
          onError={() => setFailed(true)}
          animate={{ scale: view.scale, x: view.x, y: view.y }}
          // Dragging must track the pointer 1:1; everything else springs.
          transition={dragging || reduce ? { duration: 0 } : ZOOM_SPRING}
          // The picture itself follows the interface style: `rounded-window` is the
          // app's top step (0 in the square style, 28px in the squircle style),
          // chosen so a previewed image is never LESS round than the macOS window
          // it sits in — that corner is 26pt on Tahoe, 20 on the next release and
          // 10 before those (a CSS px is a point on macOS, so 28px clears all of
          // them). The base `corner-shape` rule supplies the shape, so those
          // corners are a superellipse rather than a circular arc. A replaced
          // element is clipped by its own radius, so the element box — which the
          // fit sizing keeps equal to the painted image — is exactly what gets
          // rounded, at every zoom level.
          className="max-h-full max-w-full select-none rounded-window object-contain will-change-transform"
        />
        {failed ? (
          // The viewport has no surface of its own, so the notice brings one:
          // mid-tone text over an arbitrary blurred page would not be readable.
          <p className="absolute inset-x-6 mx-auto w-fit max-w-full rounded-control border border-border bg-background/90 px-4 py-2 text-center text-sm text-muted-foreground shadow-overlay backdrop-blur-sm">
            {t('imagePreview.failed')}
          </p>
        ) : null}
      </div>

      <div className="flex h-14 flex-none items-center justify-end gap-2 border-t border-border bg-background px-4">
        {subtitle ? (
          <p className="mr-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
        <Tooltip side="top" content={t('imagePreview.zoomOut')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('imagePreview.zoomOut')}
            disabled={view.scale <= ZOOM_MIN}
            onClick={() => zoomAt(1 / ZOOM_STEP)}
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip side="top" content={t('imagePreview.resetZoom')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('imagePreview.resetZoom')}
            disabled={!zoomed}
            onClick={reset}
            className="min-w-14 justify-center tabular-nums text-xs"
          >
            {Math.round(view.scale * 100)}%
          </Button>
        </Tooltip>
        <Tooltip side="top" content={t('imagePreview.zoomIn')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('imagePreview.zoomIn')}
            disabled={view.scale >= ZOOM_MAX}
            onClick={() => zoomAt(ZOOM_STEP)}
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </Button>
        </Tooltip>
        {image.path ? (
          <>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
            <Tooltip side="top" content={image.path} wrapperClassName="shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.pi.openPath(image.path as string)}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                {t('imagePreview.openFile')}
              </Button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * An image that opens the full-screen preview when clicked — the thumbnail
 * form for everything that is not rendered from markdown (composer
 * attachments, message-bubble images). Markdown images use this too once their
 * workspace path has been resolved to a data URL.
 *
 * The thumbnail itself carries no hover lift: the camera cursor, the focus ring
 * and the preview are the affordance, and a shadow under a picture competed
 * with the elevation family (which is for floating surfaces, not for content).
 */
export function PreviewThumb({
  src,
  alt,
  title,
  path,
  framed = false,
  className,
  imageClassName,
  onError
}: {
  src: string
  /** Image alt text — also the preview caption. */
  alt?: string
  /** Optional title supplied by Markdown. */
  title?: string
  path?: string
  /** Keep a visible frame when the thumbnail sits inside an input. */
  framed?: boolean
  /** Classes for the trigger (border/radius/size live here). */
  className?: string
  /** Classes for the `<img>` itself. */
  imageClassName?: string
  /** The bytes could not be decoded — a caller whose image is the row's whole
   * output uses this to fall back to the text that came with it. */
  onError?: () => void
}) {
  const openImage = useImagePreview()
  const { t } = useI18n()
  const name = alt ?? ''
  return (
    <button
      type="button"
      data-attachment-frame={framed ? '' : undefined}
      onClick={() => openImage({ src, label: name, path })}
      aria-label={t('imagePreview.open', { name })}
      title={title}
      className={cn(
        'group/preview relative inline-block cursor-zoom-in overflow-hidden border align-middle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        framed ? 'border-border' : 'border-transparent',
        className
      )}
    >
      <img src={src} alt={alt ?? ''} onError={onError} className={cn('block', imageClassName)} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-inherit bg-transparent transition-colors group-hover/preview:bg-primary/10" />
    </button>
  )
}
