# Responsive sidebar panes

`src/renderer/src/sidebar-pane-layout.css` owns the shared layout standard.
`SidebarPanel` establishes the named `sidebar-pane` inline-size container on
its content area. A pane that is also rendered alone can establish that same
container on its root with `sidebar-pane-container`.

Use the pane's available width, rather than viewport media queries or a
fullscreen prop. A large app window can still have a 260px docked rail, and
fullscreen can be narrow on a small window. CSS queries also follow the
workspace's direct width writes during dragging without React renders.

- Below 36rem (576px), controls wrap into short rows. Statistics use one
  column below 20rem (320px), otherwise two. Navigation and details stack.
- At 36rem, selectors and search can share a row; statistics use three columns.
- At 48rem (768px), navigation and details sit side by side. Navigation takes
  30% of the width, bounded to 18–24rem; detail takes the remaining space.
  Statistics use four columns, and the trajectory toolbar fits a single row.
- At 72rem (1152px), statistics use six columns. Structured data is capped at
  72rem with `pane-data`; prose and conversation content use the transcript's
  48rem measure with `pane-readable`. Keep a conversation's composer aligned
  to that same measure. Compact pickers use `pane-picker` (28rem).

`pane-workspace` owns a bounded master/inspector viewport. In a narrow pane,
its two rows allocate 40% to navigation and 60% to inspection; in a wide pane
both fill the available height. Each trajectory column scrolls independently
through `FadeScroll`. The shared resize strip runs horizontally in a narrow
pane and vertically at 48rem and above. Pointer and arrow-key adjustments keep
at least 8rem/10rem for narrow navigation/detail and 14rem/20rem for wide
navigation/detail. Each orientation retains its own size while the pane changes
width, and the last positions are restored from local storage when the tab is
reopened; the current pane bounds still clamp them. The trajectory's timing overview spans the whole pane
above both columns, so the records and inspector share their top edge. Its
fixed type colors and localized legend distinguish requests, tools and
message/event markers; deeper request segments still represent the first-output
wait. The timeline uses recorded turn IDs (or user boundaries for older history),
collapses inter-turn idle time into fixed-width separators, and keeps short blocks
at least 24px wide with gaps. Only genuinely overlapping intervals share extra
rows. Track membership follows recorded time overlaps and stays fixed during
zoom, so the overview's height and the columns below it never jump with scale.
Each timeline block uses the app's beUI tooltip for its localized description,
with a wrapped bubble and no native `title` tooltip.
Each category label is centered over its allocated tracks; parallel tools do
not leave an apparent extra gap before the messages/events label.
Vertical wheel zoom anchors within the pointed turn; horizontal gestures
and Shift + wheel pan through the shared horizontal scroll fade. Zoom buttons
and keyboard +/−/0, arrows, Home and End provide the same controls. Run summaries
remain in the ledger but do not paint a timeline lane or legend. Record and
document choices paint a persistent selected fill using
`aria-pressed`, since beUI action variants have transparent resting fills.
List rows add one plain-text excerpt beneath their label: message/request
output, or a tool command/path/query and its useful arguments. The SQLite worker
stores at most 512 characters per record and lazily backfills old captures from
bounded scalar prefixes and selected Merkle children. Rows never fetch complete
documents for this preview. A clipped excerpt uses the shared 12px horizontal
fade; excerpts that fit remain crisp. Bash command excerpts use the shared
monospace font. Content/tool glyphs lead each row; the transcript's shared status
ring follows its duration at the right. The localized status remains available
to screen readers and on hover. Selecting a row still opens its full inspector.
Model outputs containing tool calls are labeled as model tool calls and replace
the excerpt with one wrench action per call. These sibling beUI buttons occupy
the same 16px second line; hover changes only the glyph color. Long call lists
scroll horizontally through the shared fade without widening or raising the
row. The worker keeps call identities separate from arguments, and a jump
resolves the originating request and exact call ID on the selected branch,
clears conflicting filters and reveals a bounded page around the tool. A target
already visible in the page selects in place, keeping the surrounding records.
Older SDK logs use the assistant's descendant tool results, stopping at the
next model/user record. Their assistant outputs share the model-request label,
glyph, timeline lane, legend color and filter with captured requests. A
half-strength theme rule separates entries; selected
buttons still have only a background fill. Scalar node detail uses the same
muted fill and 4px/6px padding as a hovered field row, with no border. Document
tabs remain interactive and opaque during node reads, so their title and byte
count do not flash when entering or leaving a field. The inspector keeps the
current parameter list visible until its destination node loads, then replaces
the breadcrumb and content together without an empty or dimmed frame. A record
selection loads the next inspector before replacing the previous one, so the
parameter area remains mounted during list navigation.
`pane-columns` provides the same horizontal proportions
for sections that share one scroll viewport, such as debug information.
Changing width must preserve selection, expanded fields, input drafts and DOM
identity; do not branch into two copies of a pane or re-fetch on resize.

Source, diffs/review, terminal, browser, tables and media are work surfaces and
retain their available width. Markdown file previews and side chat use the
reading measure; subagent and scheduled transcripts already inherit it from
`ChatView`. Do not cap a canvas merely because its parent is fullscreen.

Compose app layouts with existing beUI controls, theme tokens and the shared
scroll fade. Content surfaces have no elevation. Labels remain in i18n.

Verification: `check-trajectory-timeline.mjs` checks deterministic time geometry;
`check-present-trajectory-ui.mjs`, `check-context-detail-ui.mjs`
and `check-debug-ui.mjs` measure real Electron geometry through 260px, default
docked widths, both sides of breakpoints and fullscreen widths, in both
languages, themes and corner presets. They verify no horizontal overflow or
resize-induced state loss. `PI_PANE_SCREENSHOT_DIR` retains trajectory images;
`PI_DEBUG_SCREENSHOT_DIR` retains debugger images. Also run the file-browser,
written-file-preview, window-chrome, rail-tabs and terminal regressions after
changing the shared rail container.
