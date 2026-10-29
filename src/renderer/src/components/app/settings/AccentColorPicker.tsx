import { useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'

/**
 * The custom accent's color well + picker, in Settings → Appearance. beUI
 * ships no color picker (verified against the registry), and the platform's
 * own color panel reads foreign next to the interface, so this is app glue in
 * the DateTimeField mold: a vendored MorphPopover whose surface is composed
 * from Button/Input and theme tokens — the saturation/value area and the hue
 * strip are plain drag tracks, not hand-rolled primitives.
 *
 * Picking is a DRAFT until confirmed: dragging the tracks or typing a hex
 * value only moves the preview, the accent changes solely on Apply. Closing
 * the popover any other way (Cancel, Escape, outside pointer) discards the
 * draft, and the next open re-seeds it from the remembered pick.
 */

interface Hsv {
  /** 0–360 */
  h: number
  /** 0–1 */
  s: number
  /** 0–1 */
  v: number
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function hexToHsv(hex: string): Hsv {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6)
    else if (max === g) h = 60 * ((b - r) / delta + 2)
    else h = 60 * ((r - g) / delta + 4)
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max, v: max }
}

function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x]
  const channel = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0')
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`
}

/** Shared drag tracking for the two tracks: applies the press position, then
 * follows the pointer under capture until release. The capture is guarded —
 * the synthetic pointer events the CDP checks dispatch own no active pointer. */
function dragTrack(event: ReactPointerEvent<HTMLElement>, apply: (clientX: number, clientY: number, rect: DOMRect) => void): void {
  event.preventDefault()
  const track = event.currentTarget
  const run = (clientX: number, clientY: number) => apply(clientX, clientY, track.getBoundingClientRect())
  run(event.clientX, event.clientY)
  try {
    track.setPointerCapture(event.pointerId)
  } catch {
    /* untrusted events carry no pointer to capture; the press still applied */
  }
  const move = (next: PointerEvent) => run(next.clientX, next.clientY)
  const end = () => {
    track.removeEventListener('pointermove', move)
    track.removeEventListener('pointerup', end)
    track.removeEventListener('pointercancel', end)
  }
  track.addEventListener('pointermove', move)
  track.addEventListener('pointerup', end)
  track.addEventListener('pointercancel', end)
}

/** The ring thumb both tracks share: white edge over the color under it, a
 * hairline so it survives a white pick, and slider semantics with arrows. */
function TrackThumb({
  label,
  valueText,
  valueNow,
  valueMax,
  onStep,
  style,
  className
}: {
  label: string
  valueText: string
  valueNow: number
  valueMax: number
  onStep: (delta: number) => void
  style: React.CSSProperties
  className?: string
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      onStep(-step)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      onStep(step)
    }
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={valueText}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      onKeyDown={onKeyDown}
      className={`pointer-events-none absolute size-3.5 rounded-full border-2 border-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? ''}`}
      style={{ boxShadow: '0 0 0 1px rgb(0 0 0 / 0.35), 0 1px 4px rgb(0 0 0 / 0.35)', ...style }}
    />
  )
}

export function AccentColorPicker({
  color,
  active,
  onApply
}: {
  /** The remembered custom pick (the last applied color, or the default fill). */
  color: string
  /** Whether the custom accent is the active one — the well wears the pick. */
  active: boolean
  /** Called ONLY when the pick is confirmed inside the popover. */
  onApply: (hex: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Hsv>(() => hexToHsv(color))
  const [hexText, setHexText] = useState(color)

  const draftHex = hsvToHex(draft)
  const pureHue = hsvToHex({ h: draft.h, s: 1, v: 1 })
  const hexValid = HEX_PATTERN.test(hexText)

  /** Track/keyboard edits keep the hex field in step; hex edits flow back. */
  const setDraftFrom = (next: Hsv) => {
    setDraft(next)
    setHexText(hsvToHex(next))
  }
  const editHex = (raw: string) => {
    setHexText(raw)
    if (HEX_PATTERN.test(raw)) setDraft(hexToHsv(raw))
  }

  const apply = () => {
    if (!hexValid) return
    onApply(draftHex)
    setOpen(false)
  }

  return (
    <MorphPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Every open starts from the remembered pick — a discarded draft never
        // leaks into the next session of the popover.
        if (next) {
          setDraft(hexToHsv(color))
          setHexText(color)
        }
      }}
    >
      <MorphPopoverTrigger>
        {/* Idle, the well is the hue wheel over the remembered pick (the
         * universal custom-color glyph); while the custom accent runs it
         * wears the pick with the same active dot as the presets. */}
        <button
          type="button"
          aria-label={t('settings.accentCustom')}
          data-accent-custom-well=""
          className="relative grid size-6 cursor-pointer place-items-center rounded-capsule transition-[filter] hover:brightness-110"
          style={
            active
              ? { background: color }
              : {
                  backgroundColor: color,
                  backgroundImage:
                    'conic-gradient(in oklch longer hue, oklch(0.72 0.14 0), oklch(0.72 0.14 360))'
                }
          }
        >
          {active ? <span className="pointer-events-none size-2 rounded-full bg-white/90" /> : null}
        </button>
      </MorphPopoverTrigger>
      {/* side=top: the accent group sits low on the Settings page, where a
       * downward panel lands off-viewport and forces a scroll to reach. */}
      <MorphPopoverContent side="top" align="start" radius="var(--app-radius-card)" className="w-64 p-3">
        <div className="space-y-2.5" data-accent-picker="">
          <div
            className="relative h-36 w-full cursor-crosshair overflow-hidden rounded-control"
            style={{ backgroundColor: pureHue }}
            onPointerDown={(event) =>
              dragTrack(event, (clientX, clientY, rect) => {
                const s = clamp01((clientX - rect.left) / rect.width)
                const v = clamp01(1 - (clientY - rect.top) / rect.height)
                setDraftFrom({ h: draft.h, s, v })
              })
            }
            data-accent-picker-area=""
          >
            <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(to right, #ffffff, transparent)' }} />
            <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(to top, #000000, transparent)' }} />
            <TrackThumb
              label={t('settings.accentCustomArea')}
              valueText={`${Math.round(draft.s * 100)}% / ${Math.round(draft.v * 100)}%`}
              valueNow={Math.round(draft.v * 100)}
              valueMax={100}
              onStep={(delta) => setDraftFrom({ ...draft, s: clamp01(draft.s + delta / 100) })}
              className="-translate-x-1/2 -translate-y-1/2"
              style={{ left: `${draft.s * 100}%`, top: `${(1 - draft.v) * 100}%`, backgroundColor: draftHex }}
            />
          </div>

          <div
            className="relative h-3.5 w-full cursor-pointer rounded-control"
            style={{
              background:
                'linear-gradient(to right, #ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, #00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)'
            }}
            onPointerDown={(event) =>
              dragTrack(event, (clientX, _clientY, rect) => {
                const h = clamp01((clientX - rect.left) / rect.width) * 360
                setDraftFrom({ ...draft, h: h >= 360 ? 0 : h })
              })
            }
            data-accent-picker-hue=""
          >
            <TrackThumb
              label={t('settings.accentCustomHue')}
              valueText={`${Math.round(draft.h)}°`}
              valueNow={Math.round(draft.h)}
              valueMax={360}
              onStep={(delta) => setDraftFrom({ ...draft, h: (draft.h + delta + 360) % 360 })}
              className="top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${(draft.h / 360) * 100}%`, backgroundColor: pureHue }}
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Current pick on the left, live draft on the right. */}
            <div className="flex h-6 w-12 shrink-0 overflow-hidden rounded-control border border-border/60" aria-hidden="true">
              <span className="h-full w-1/2" style={{ backgroundColor: color }} />
              <span className="h-full w-1/2" style={{ backgroundColor: draftHex }} data-accent-picker-preview="" />
            </div>
            <Input
              value={hexText}
              onChange={editHex}
              aria-label={t('settings.accentCustom')}
              spellCheck={false}
              autoComplete="off"
              classNames={{ root: 'min-w-0 flex-1', input: 'font-mono' }}
            />
          </div>

          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setOpen(false)} data-accent-picker-cancel="">
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!hexValid} onClick={apply} data-accent-picker-apply="">
              {t('settings.accentCustomApply')}
            </Button>
          </div>
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  )
}
