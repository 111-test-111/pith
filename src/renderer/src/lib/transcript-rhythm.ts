/**
 * Transcript geometry lives in styles.css: a 24px content row plus a 24px
 * roomy / 4px compact gap, owned by each sibling boundary (no additive flex
 * gap). Prose and waiting rows stay roomy. A process divider always leads
 * content by 24px; completion buttons follow their content by 12px, matching
 * a normal text reply. The same rules apply at every nesting depth.
 *
 * Outside a transcript, keep the task panels' 36px row. A disclosure trigger
 * owns its height; never centre a trigger together with its growing body.
 */
export const TRANSCRIPT_ROW = 'transcript-row flex flex-col justify-center'

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
