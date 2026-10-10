import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight, ExternalLink, ZoomIn, ZoomOut } from '@/lib/icons'
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

/** An image the preview can show. `src` is a browser-loadable URL, including
 * the app's local media scheme; callers resolve workspace paths first. */
export interface PreviewImage {
  src: string
  /** Stable identity inside a group, including repeated sources. */
  id?: string
  /** Caption and accessible name (alt text, file name). */
  label?: string
  /** Absolute local path when the image lives in the workspace: enables
   * "open in default app". Browser-picked uploads have none. */
  path?: string
}

/** Opens the overlay for one image; an image without a `src` is ignored. */
type OpenImage = (image: PreviewImage) => void

const EMPTY_IMAGES: readonly PreviewImage[] = []
const subscribeNothing = () => () => {}
const emptyImages = () => EMPTY_IMAGES
type LoadPreviewPage = () => Promise<readonly PreviewImage[]>

function findPreviewImage(images: readonly PreviewImage[], selected?: PreviewImage): number {
  if (!selected) return -1
  const byId = selected.id ? images.findIndex(image => image.id === selected.id) : -1
  if (byId >= 0) return byId
  const sameSource = (image: PreviewImage) => image.src === selected.src && image.path === selected.path
  const byLabel = images.findIndex(image => sameSource(image) && image.label === selected.label)
  return byLabel >= 0 ? byLabel : images.findIndex(sameSource)
}

/** Explicit collections include offscreen images. Other groups register their
 * thumbnails, ordered by their actual content order rather than load timing. */
function createImageGroup() {
  let supplied: readonly PreviewImage[] | undefined
  let loadMore: LoadPreviewPage | undefined
  let snapshot: readonly PreviewImage[] = EMPTY_IMAGES
  const thumbnails = new Map<string, { image: PreviewImage; element: HTMLElement }>()
  const listeners = new Set<() => void>()
  const publish = () => {
    const images = supplied ?? [...thumbnails.values()].sort((a, b) => {
      const position = a.element.compareDocumentPosition(b.element)
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0
    }).map(item => item.image)
    const next = images.filter(image => image.src)
    if (next.length === snapshot.length && next.every((image, index) => {
      const previous = snapshot[index]
      return image.id === previous.id && image.src === previous.src && image.label === previous.label && image.path === previous.path
    })) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get loadMore() { return loadMore },
    setLoadMore: (next: LoadPreviewPage | undefined) => {
      if (loadMore === next) return
      loadMore = next
      snapshot = [...snapshot]
      listeners.forEach(listener => listener())
    },
    setImages: (images: readonly PreviewImage[] | undefined) => { supplied = images; publish() },
    register: (id: string, image: PreviewImage, element: HTMLElement) => { thumbnails.set(id, { image, element }); publish() },
    unregister: (id: string) => { thumbnails.delete(id); publish() }
  }
}
type ImageGroup = ReturnType<typeof createImageGroup>
const ImageGroupContext = createContext<ImageGroup | null>(null)

function useImageGroup(images?: readonly PreviewImage[], loadMore?: LoadPreviewPage, scope?: string) {
  const group = useMemo(createImageGroup, [scope])
  // Reordering mounted thumbnails also changes content order, without changing
  // any individual thumbnail's props or registration.
  useLayoutEffect(() => { group.setImages(images) })
  useLayoutEffect(() => { group.setLoadMore(loadMore) }, [group, loadMore])
  useLayoutEffect(() => () => { group.setImages(EMPTY_IMAGES); group.setLoadMore(undefined) }, [group])
  return group
}

/** One content-owned image collection; nested groups always stay independent. */
export function ImagePreviewGroup({ images, children }: { images?: readonly PreviewImage[]; children: ReactNode }) {
  const group = useImageGroup(images)
  return <ImageGroupContext.Provider value={group}>{children}</ImageGroupContext.Provider>
}

interface PreviewRequest { id: number; image: PreviewImage; group: ImageGroup | null }
const ImagePreviewContext = createContext<((image: PreviewImage, group: ImageGroup | null) => void) | null>(null)

/** Opens the image preview from anywhere in the app. */
export function useImagePreview(): OpenImage {
  const open = useContext(ImagePreviewContext)
  const group = useContext(ImageGroupContext)
  if (!open) throw new Error('useImagePreview must be used within <ImagePreviewProvider>')
  return useCallback((image: PreviewImage) => open(image, group), [open, group])
}

/** Register either a thumbnail or a toolbar button in its content-owned
 * gallery. The image can have an independent interaction surface. */
export function useImagePreviewTrigger(image: Omit<PreviewImage, 'id'> | null) {
  const openImage = useImagePreview()
  const group = useContext(ImageGroupContext)
  const id = useId()
  const ref = useRef<HTMLButtonElement>(null)
  const src = image?.src, label = image?.label, path = image?.path
  useLayoutEffect(() => {
    if (!group || !ref.current || !src) return
    group.register(id, { id, src, label, path }, ref.current)
    return () => group.unregister(id)
  }, [group, id, src, label, path])
  const open = useCallback(() => { if (src) openImage({ id, src, label, path }) }, [openImage, id, src, label, path])
  return { ref, open }
}

/** Model-owned galleries retain offscreen items and load another bounded page
 * when navigation reaches the end of the current collection. */
export function useImagePreviewCollection(images: readonly PreviewImage[], { loadMore, scope }: { loadMore?: LoadPreviewPage; scope?: string } = {}): OpenImage {
  const open = useContext(ImagePreviewContext)
  const group = useImageGroup(images, loadMore, scope)
  if (!open) throw new Error('useImagePreviewCollection must be used within <ImagePreviewProvider>')
  return useCallback((image: PreviewImage) => open(image, group), [open, group])
}

/** Mounted once near the app root: provides `useImagePreview` and hosts the one
 * overlay instance every image on screen opens. */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PreviewRequest | null>(null)
  const sequence = useRef(0)
  const origin = useRef<HTMLElement | null>(null)
  const open = useCallback((image: PreviewImage, group: ImageGroup | null) => {
    if (!image?.src) return
    // The id remounts the viewer — a reopened image always starts at fit, at a
    // fresh centre, instead of inheriting the previous zoom/pan.
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const collection = group?.getSnapshot() ?? EMPTY_IMAGES
    setRequest({ id: ++sequence.current, image: collection[findPreviewImage(collection, image)] ?? image, group })
  }, [])
  const close = useCallback(() => {
    setRequest(null)
    const trigger = origin.current
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
  }, [])

  return (
    <ImagePreviewContext.Provider value={open}>
      {children}
      {/* While the overlay exits, AnimatePresence keeps rendering the element it
          was given, so clearing `request` here cannot blank the closing image. */}
      <ImagePreviewHost request={request} onClose={close} />
    </ImagePreviewContext.Provider>
  )
}

function ImagePreviewHost({
  request,
  onClose
}: {
  request: PreviewRequest | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const images = useSyncExternalStore(request?.group?.subscribe ?? subscribeNothing, request?.group?.getSnapshot ?? emptyImages)
  const viewportRef = useRef<HTMLDivElement>(null)
  const currentRequest = useRef(request)
  currentRequest.current = request
  const navigationVersion = useRef(0)
  const loadingRequest = useRef<number | null>(null)
  const [loadingNext, setLoadingNext] = useState<number | null>(null)
  const [selection, setSelection] = useState<{ requestId: number; image: PreviewImage } | null>(null)
  const selected = selection?.requestId === request?.id ? selection?.image : request?.image
  const index = findPreviewImage(images, selected)
  const image = images[index] ?? selected
  const navigate = (direction: -1 | 1) => {
    if (!request || index < 0) return
    const next = images[index + direction]
    if (!next && loadingRequest.current === request.id) return
    const version = ++navigationVersion.current
    if (next) { setSelection({ requestId: request.id, image: next }); return }
    const group = request.group
    if (direction !== 1 || !group?.loadMore || loadingRequest.current === request.id) return
    const requestId = request.id
    loadingRequest.current = requestId; setLoadingNext(requestId)
    void group.loadMore().then(latest => {
      if (currentRequest.current?.id !== requestId || navigationVersion.current !== version) return
      // The source's React state may commit after its request resolves. Publish
      // its returned page before selecting the next image, without timing waits.
      if (!group.getSnapshot().length) return
      group.setImages(latest)
      const current = findPreviewImage(latest, image)
      if (current >= 0 && latest[current + 1]) setSelection({ requestId, image: latest[current + 1] })
    }).finally(() => {
      if (loadingRequest.current === requestId) { loadingRequest.current = null; setLoadingNext(null) }
    }).catch(() => {})
  }
  const changeOpen = useCallback((open: boolean) => { if (!open) onClose() }, [onClose])
  return (
    <CenterMorphModal
      open={request !== null}
      onOpenChange={changeOpen}
    >
      {/* Open-frame panel: beUI still owns the frame (border, radius, motion),
          but the surface itself paints nothing — the blank area around the image
          shows the dimmed page behind instead of a white fill. The caption and
          control bars carry their own `bg-background`, so the panel reads as a
          window onto the image rather than a white card. `pr-14` on the caption
          keeps it clear of the modal's own close control. */}
      <CenterMorphModalContent
        initialFocusRef={viewportRef}
        ariaLabel={image?.label || t('imagePreview.dialogLabel')}
        closeButtonLabel={t('imagePreview.close')}
        className="h-[min(78vh,48rem)] max-w-[min(92vw,72rem)] bg-transparent"
      >
        {request && image ? <ImageZoom key={request.id} image={image} viewportRef={viewportRef}
          navigation={index >= 0 && (images.length > 1 || request.group?.loadMore) ? {
            index, total: images.length, hasMore: Boolean(request.group?.loadMore), loading: loadingNext === request.id, navigate
          } : undefined} /> : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}

function ImageZoom({ image, viewportRef, navigation }: { image: PreviewImage; viewportRef: RefObject<HTMLDivElement | null>; navigation?: {
  index: number; total: number; hasMore: boolean; loading: boolean; navigate: (direction: -1 | 1) => void
} }) {
  const { t } = useI18n()
  const reduce = useReducedMotion() ?? false
  const imgRef = useRef<HTMLImageElement>(null)
  const vector = /^data:image\/svg\+xml[;,]/i.test(image.src)
  const vectorFitRef = useRef<{ width: number; height: number } | null>(null)
  const [vectorFit, setVectorFit] = useState<{ width: number; height: number } | null>(null)
  const getVectorFit = useCallback(() => vectorFitRef.current, [])
  // The overlay owns the window, so its zoom shortcuts are global.
  const { view, dragging, zoomed, pannable, zoomAt, reset, handlers } = useImageZoom({ viewportRef, imageRef: imgRef,
    getFitSize: vector ? getVectorFit : undefined,
    resetKey: `${image.id ?? ''}:${image.src}`, onNavigate: navigation?.navigate })
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const size = loaded?.src === image.src ? loaded : null
  const failed = failedSrc === image.src
  useLayoutEffect(() => {
    vectorFitRef.current = null
    setVectorFit(null)
    const viewport = viewportRef.current
    if (!vector || !size || !viewport) return
    const fit = () => {
      const scale = Math.min(1, viewport.clientWidth / size.width, viewport.clientHeight / size.height)
      const next = { width: size.width * scale, height: size.height * scale }
      vectorFitRef.current = next
      setVectorFit(previous => previous?.width === next.width && previous.height === next.height ? previous : next)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [vector, size, viewportRef])

  const imageProps = {
    ref: imgRef, src: image.src, alt: image.label ?? '', draggable: false as const,
    onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => {
      setFailedSrc(null)
      setLoaded({ src: image.src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
    },
    onError: () => setFailedSrc(image.src)
  }

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
        {navigation ? <div data-image-preview-navigation className="flex shrink-0 items-center gap-1">
          <Tooltip side="bottom" content={t('imagePreview.previous')}>
            <Button variant="ghost" size="icon" aria-label={t('imagePreview.previous')} disabled={navigation.index === 0}
              onClick={() => navigation.navigate(-1)}><ChevronLeft className="size-4" aria-hidden="true" /></Button>
          </Tooltip>
          <span aria-live="polite" aria-label={t('imagePreview.position', { current: navigation.index + 1, total: navigation.total })}
            className="px-1 text-xs tabular-nums text-muted-foreground">{navigation.index + 1}/{navigation.total}</span>
          <Tooltip side="bottom" content={t('imagePreview.next')}>
            <Button variant="ghost" size="icon" aria-label={t('imagePreview.next')}
              disabled={navigation.index === navigation.total - 1 && (!navigation.hasMore || navigation.loading)}
              onClick={() => navigation.navigate(1)}><ChevronRight className="size-4" aria-hidden="true" /></Button>
          </Tooltip>
        </div> : null}
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
        {vector ? <img
          {...imageProps}
          key={image.src}
          data-vector-preview
          // Resizing makes Chromium paint glyphs at the CURRENT pixel size.
          // Transform-scaling a promoted image layer magnified its fit raster,
          // making Chinese labels soft even though the source was an SVG.
          style={{ width: vectorFit ? vectorFit.width * view.scale : undefined,
            height: vectorFit ? vectorFit.height * view.scale : undefined,
            visibility: vectorFit ? undefined : 'hidden',
            transform: `translate(${Math.round(view.x * devicePixelRatio) / devicePixelRatio}px,${Math.round(view.y * devicePixelRatio) / devicePixelRatio}px)` }}
          className="max-h-none max-w-none shrink-0 select-none rounded-window"
        /> : <motion.img
          {...imageProps}
          key={image.src}
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
        />}
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
  const { t } = useI18n()
  const name = alt ?? ''
  const { ref, open } = useImagePreviewTrigger({ src, label: name, path })
  return (
    <button
      ref={ref}
      type="button"
      data-attachment-frame={framed ? '' : undefined}
      onClick={open}
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
