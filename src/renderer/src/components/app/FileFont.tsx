import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { FileText, LoaderCircle, ZoomIn, ZoomOut, type IconComponent } from '@/lib/icons'
import { formatBytes } from '@/lib/format'
import { fileExtension } from '../../../../shared/extension'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FileBrowserError } from '../../../../shared/types'
import type { FileTab } from '@/state/file-browser-store'

/**
 * Font preview. The bytes arrive over `files:fontData` and go straight into
 * `new FontFace(family, buffer)` — a URL source would be a cross-origin font
 * request, which is exactly what the media scheme refuses to serve (see
 * `main/font.ts`). The face is registered with the document for as long as the
 * tab is open and removed on unmount, so previewing a font never leaves a
 * family behind that later text could accidentally render with.
 *
 * Every control around the sample is a beUI primitive on theme tokens; the
 * sample itself is ordinary text, which is what a font preview is for.
 */

/** Zoom ladder around 1. The sizes below are multiplied by the current step. */
const STEPS = [0.75, 0.9, 1, 1.2, 1.5, 2]
/** Sample sizes in px at zoom 1, largest first. */
const SIZES = [44, 26, 18, 14]
/** The glyph run, in the order a specimen sheet sets it. */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%^&*(){}[]<>?/\\|·—…“”‘’'

let familySeq = 0

function FontNotice({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/30 p-5 text-center text-xs leading-ui text-muted-foreground">
    {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5 text-muted-foreground/60" />}{children}
  </div>
}

function ToolButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: IconComponent; onClick: () => void; disabled?: boolean }) {
  return <Tooltip content={label}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden className="size-3.5" /></Button></Tooltip>
}

export function FileFont({ tab }: { tab: FileTab }) {
  const { t } = useI18n()
  const [sample, setSample] = useState(() => t('files.font.sample'))
  const [zoom, setZoom] = useState(1)
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<FileBrowserError | null>(null)
  const [size, setSize] = useState(0)
  // A fresh family per mount: reusing a name would let a previous visit's bytes
  // answer for this one while the read is in flight.
  const family = useRef(`pith-font-${++familySeq}`).current

  useEffect(() => {
    let disposed = false
    let face: FontFace | null = null
    setStatus('loading')
    setFailure(null)
    void window.pi.fontData({ cwd: tab.cwd, path: tab.path }).then(async result => {
      setSize(result.size)
      if (result.error || !result.data) { if (!disposed) { setFailure(result.error ?? 'unreadable'); setStatus('ready') } return }
      try {
        // A copy of exactly this view's bytes, never its backing store: the IPC
        // result may be a view over a larger buffer, and `FontFace` would read
        // the whole thing.
        const bytes = result.data
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        face = new FontFace(family, buffer)
        await face.load()
        if (disposed) return
        document.fonts.add(face)
        setStatus('ready')
      } catch {
        if (!disposed) { setFailure('unreadable'); setStatus('ready') }
      }
    }).catch(() => { if (!disposed) { setFailure('unreadable'); setStatus('ready') } })
    return () => {
      disposed = true
      if (face) document.fonts.delete(face)
    }
  }, [tab.cwd, tab.path, family])

  const step = (direction: number) => {
    const index = STEPS.findIndex(value => Math.abs(value - zoom) < 0.001)
    const next = Math.min(STEPS.length - 1, Math.max(0, (index < 0 ? STEPS.indexOf(1) : index) + direction))
    setZoom(STEPS[next])
  }
  const style = useMemo(() => ({ fontFamily: `"${family}"` }), [family])

  if (failure) return <FontNotice>{t(`files.error.${failure}`)}</FontNotice>
  if (status === 'loading') return <FontNotice loading>{t('files.loading')}</FontNotice>
  const format = fileExtension(tab.path).replace('.', '').toUpperCase()
  return <div data-file-font className="flex min-h-0 flex-1 flex-col">
    <div data-file-font-toolbar className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/40 px-2 py-1">
      <Input value={sample} onChange={setSample} aria-label={t('files.font.sampleLabel')} placeholder={t('files.font.samplePlaceholder')} maxLength={400}  className="min-w-0 max-w-md flex-1" />
      <div data-file-font-zoom className="ml-auto flex shrink-0 items-center gap-0.5">
        <ToolButton label={t('imagePreview.zoomOut')} icon={ZoomOut} disabled={zoom <= STEPS[0]} onClick={() => step(-1)} />
        <span data-file-font-scale className="select-none px-0.5 text-caption leading-ui-loose tabular-nums">{Math.round(zoom * 100)}%</span>
        <ToolButton label={t('imagePreview.zoomIn')} icon={ZoomIn} disabled={zoom >= STEPS[STEPS.length - 1]} onClick={() => step(1)} />
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-card border border-border bg-background p-5 shadow-overlay">
        {SIZES.map((size, index) => <p
          key={size}
          data-font-sample={size}
          style={{ ...style, fontSize: `${Math.round(size * zoom)}px`, lineHeight: 1.3 }}
          className={cn('m-0 whitespace-pre-wrap break-words', index === 0 ? 'text-foreground' : 'text-foreground/85')}
        >{sample || t('files.font.sample')}</p>)}
        <p aria-hidden data-font-glyphs style={{ ...style, fontSize: `${Math.round(14 * zoom)}px`, lineHeight: 1.6 }} className="m-0 break-all border-t border-border/60 pt-3 text-muted-foreground">{GLYPHS}</p>
      </div>
      <p role="status" className="mx-auto mt-3 max-w-3xl px-1 text-micro tabular-nums text-muted-foreground">{t('files.font.meta', { format, size: formatBytes(size) })}</p>
    </div>
  </div>
}
