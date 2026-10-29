/**
 * The app's create/edit panel standard — one row of one form, wherever a panel
 * exists to create or edit a record (MCP server, scheduled task, model,
 * provider, subagent profile).
 *
 * The rules these tokens encode (see AGENTS.md → create/edit panels):
 *  - Layout: left/right. A panel is a `md:grid-cols-2` grid beside the panel
 *    title — never one long column — sized so every item is visible at once on
 *    a normal window (an item that needs the width takes `md:col-span-2`; the
 *    body is capped only so a short window still fits). No panel scrolls on a
 *    normal window.
 *  - Panel title: `text-base font-semibold` (FORM_PANEL_TITLE).
 *  - Field title: `text-sm font-medium text-foreground`, FLUSH with the control
 *    it names — no inset of its own, so a title starts exactly where the field
 *    box below it starts.
 *  - Title-to-control gap: 10px. Inside a field stack (beUI's `Input` root or
 *    the panels' own `flex flex-col gap-1.5`) the 6px gap is already there, so
 *    the title adds 4px (`mb-1`). A title that sits in a plain block wrapper
 *    (a `<p>` over a radio group or a key/value list) carries the whole 10px
 *    itself (`mb-2.5`).
 *  - Single-line input text and insets: the shared small interface role and
 *    padding in `input-style.ts`, matching the sessions sidebar filter.
 *    Choice controls under a field title — select triggers/items and
 *    radio/checkbox labels — take the same small role, one step under the
 *    title (`text-xs` against the title's `text-sm`; FORM_CHOICE_TEXT).
 *    Textareas retain the interface base (default 14px, `text-sm`).
 *  - Editing items: 20px apart (`space-y-5`, grid `gap-5`) — never the tight
 *    12px control gap. A panel's item stack carries `data-form-items` on the
 *    container that holds the items, so a check can measure that rhythm.
 *  - One title colour: `text-foreground`. Helper and error lines are
 *    annotations, not titles, and use derived interface sizes (default 11–12px),
 *    6px under their control.
 *
 * Exercised by `check-mcp-settings.mjs`, `check-scheduled-tasks-ui.mjs` and
 * `check-subagent-settings.mjs`.
 */

/** Panel title. */
export const FORM_PANEL_TITLE = 'text-base font-semibold text-foreground'

/**
 * A field title inside a field stack that already supplies a 6px gap (a `span`
 * or `p` above the control), including a beUI `Input` that renders its own
 * label through `classNames.label`.
 */
export const FORM_FIELD_TITLE = 'mb-1 text-sm font-medium text-foreground'

/**
 * The same title for a beUI `Input`'s own `label` prop: `px-0` cancels the
 * registry label's `px-1`, which would otherwise indent the title 4px past the
 * field box.
 */
export const FORM_INPUT_LABEL = { label: 'mb-1 px-0' } as const

/**
 * A field title as a block heading in a plain (non-stacked) wrapper, where its
 * own margin supplies the whole 10px.
 */
export const FORM_FIELD_HEADING = 'mb-2.5 text-sm font-medium text-foreground'

/**
 * A choice control's label sits one size under the field title. The vendored
 * RadioGroupItem/Checkbox paint their label in an inner span, so the size
 * arrives through a direct-child override on the item's own className.
 */
export const FORM_CHOICE_TEXT = '[&>span]:text-xs'
