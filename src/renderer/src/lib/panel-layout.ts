/**
 * Panel widths for the workspace shell: the left session sidebar and the right
 * rail. Both are user-resizable inside fixed bounds, and the transcript keeps a
 * floor of its own — the three share one budget, so widening a panel can never
 * squeeze the conversation away, and shrinking the window takes width back out
 * of the panels instead of out of the chat.
 */
export interface PanelLayout {
  left: number
  right: number
}

export const LEFT_PANEL_MIN = 180
export const LEFT_PANEL_MAX = 420
export const RIGHT_PANEL_MIN = 260
export const RIGHT_PANEL_MAX = 720
/**
 * Width the transcript keeps at any window size. It is also the drag ceiling:
 * pulling a panel past it does nothing, which is what stops a drag from
 * crushing the conversation.
 *
 * Sized from the widest fixed furniture in the column, the changed-files card
 * header (TurnWrittenFiles): 24px of header padding + a 36px glyph tile + a
 * 12px gap + the title/stats column + a 12px gap + the trailing button cluster
 * (`Show more` / `Undo` / `Review` with their icons, 260px in English).
 * Measured against the real component, the header needs 480px of card width in
 * English (440px in zh-CN) before its title/stats column has room: below that
 * the column collapses, the `+N −M` stats spill across the buttons, and the
 * composer's controls row (model picker, context ring, send) runs past the
 * panel edge. The card sits inside the transcript's `sm:px-5` viewport, which
 * is where the extra 40px comes from.
 */
export const CHAT_MIN = 560

export const DEFAULT_PANEL_LAYOUT: PanelLayout = { left: 256, right: 400 }

const STORAGE_KEY = 'pi-app:panel-layout'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function readWidth(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), min, max) : fallback
}

/** Panel widths as last left by the user, already clamped to today's bounds. */
export function loadPanelLayout(): PanelLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PANEL_LAYOUT
    const parsed = JSON.parse(raw) as Partial<PanelLayout>
    return {
      left: readWidth(parsed.left, DEFAULT_PANEL_LAYOUT.left, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
      right: readWidth(parsed.right, DEFAULT_PANEL_LAYOUT.right, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
    }
  } catch {
    return DEFAULT_PANEL_LAYOUT
  }
}

export function savePanelLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    /* a full/blocked storage must not break resizing */
  }
}

/**
 * One panel's width mid-drag: bounded by its own min/max AND by what is left of
 * the budget once the other panel and the transcript have their room. When the
 * window is too small for even that, the panel's own minimum wins — the
 * transcript is the one that gives, because a panel narrower than its minimum is
 * unusable rather than merely tight.
 */
export function clampPanelWidth(
  value: number,
  min: number,
  max: number,
  siblingWidth: number,
  viewport: number
): number {
  const ceiling = Math.max(min, Math.min(max, viewport - CHAT_MIN - siblingWidth))
  return Math.round(clamp(value, min, ceiling))
}

/**
 * Re-fit both panels after the window (or a panel's visibility) changed: any
 * shortfall is taken out of whichever panel has the most room above its floor,
 * proportionally, so neither is driven to its minimum while the other stays
 * wide.
 */
export function fitPanelLayout(
  layout: PanelLayout,
  viewport: number,
  visible: { left: boolean; right: boolean }
): PanelLayout {
  let left = clamp(Math.round(layout.left), LEFT_PANEL_MIN, LEFT_PANEL_MAX)
  let right = clamp(Math.round(layout.right), RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)

  const used = (visible.left ? left : 0) + (visible.right ? right : 0)
  const over = used + CHAT_MIN - viewport
  if (over <= 0) return { left, right }

  const leftRoom = visible.left ? left - LEFT_PANEL_MIN : 0
  const rightRoom = visible.right ? right - RIGHT_PANEL_MIN : 0
  const room = leftRoom + rightRoom
  if (room <= 0) return { left, right }

  const take = Math.min(over, room)
  const fromLeft = Math.round((take * leftRoom) / room)
  left -= fromLeft
  right -= take - fromLeft
  return { left, right }
}
