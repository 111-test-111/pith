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
