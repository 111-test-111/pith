/**
 * One row height for the entire transcript.
 *
 * Every row of a turn — a tool row, a folded tool group, a reasoning row, prose
 * and the waiting row — is a flex item of the group's own column, and the
 * column's 12px `gap` is only HALF of the space a reader sees: the rest is the
 * empty part of each row's own box. A 36px tool row centres its 20px line with
 * 8px above and below, a 28px group row with 4px, and a 24px prose or waiting
 * row has no slack at all — so equal gaps still read as unequal spacing, which
 * is exactly what a reader reports as "the first two rows sit further apart".
 *
 * Rows therefore share ONE box height — the vendored tool/FileDiff row's own
 * `min-h-9`, which the task panels already use — and centre their own content,
 * so the distance between the text of any two consecutive rows is the same
 * `row gap + row height`, whichever pair you look at. Pass this class to any
 * row whose content is not already a full-height box.
 */
export const TRANSCRIPT_ROW = 'flex min-h-9 flex-col justify-center'

/**
 * The same row box for a row that OPENS a growing body below its own trigger —
 * a reasoning row, a folded tool group, the settled-turn fold.
 *
 * `justify-center` is only free-space arithmetic: a trigger and a zero-height
 * closed body leave 8px of slack in the 36px floor, so the trigger sits 4px
 * down. The moment the body opens taller than that slack the column has no free
 * space left and the trigger snaps to the top — during the reveal animation, so
 * the row visibly jumps up 4px on every expand, in either direction, which the
 * reader reports as "the reasoning row moves up a little when I open it". Tool
 * rows don't: their trigger IS the row.
 *
 * Giving the trigger the row's own 36px box removes the slack, so the centring
 * has nothing left to redistribute and expanding moves nothing. The trigger's
 * text keeps its exact resting position (a 36px box centres the same 18px line
 * the 28px trigger was centred in), and the click target becomes the whole row.
 */
export const TRANSCRIPT_ROW_TRIGGER = `${TRANSCRIPT_ROW} [&>*:first-child]:min-h-9`

/**
 * Every row of a turn is a flex item of the group's column, and that column
 * aligns its items to the START — so a row with `width: auto` takes its own
 * `fit-content` size, whose min-content floor is whatever the row's widest
 * unwrapped line is. A row that owns a horizontal scrollport (an expanded
 * edit/write diff: thousands of columns of `whitespace-pre`) therefore grew the
 * row AND its scrollport to the diff's full width, which left the diff with
 * `scrollWidth === clientWidth` — nothing to scroll — clipped by the column's
 * `overflow-x-clip`, and pushed the transcript column past its 768px cap.
 *
 * A row that may hold an unbroken wide line is a full-width flex item instead:
 * `w-full` gives it the column's width, and `min-w-0` drops the content-based
 * minimum so an inner `overflow-auto` keeps the overflow, where it belongs.
 */
export const TRANSCRIPT_ROW_WIDTH = 'w-full min-w-0'

/**
 * Where an EXPANDED body's content starts: exactly where the row's own title
 * text does — the 16px leading icon plus the trigger's 8px gap, i.e. 24px.
 *
 * Both beUI triggers (a tool row's icon slot, `AgentActivity`'s summary span)
 * put their icon and gap at exactly that, and the tool row's body wrapper
 * carries the same indent (`pl-6` in the vendored `tool-result`). A body that
 * starts at the row's left edge instead reads as belonging to the row above it,
 * which is what a reader reports as "the reasoning content has no indent".
 *
 * `AgentActivity` is the one body that cannot take the full indent on its
 * wrapper: its vendored rows carry their own 6px inline padding, so the wrapper
 * supplies the remaining 18px. The sum is what matters — keep it at 24px.
 */
export const ACTIVITY_BODY_INDENT = 'pl-4.5'
