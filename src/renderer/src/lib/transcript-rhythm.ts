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
