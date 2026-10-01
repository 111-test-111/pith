# Responsive sidebar panes

`src/renderer/src/sidebar-pane-layout.css` is the shared standard. `SidebarPanel` establishes named inline-size container `sidebar-pane`; standalone panes use `sidebar-pane-container`. Query available pane width, not viewport/fullscreen state; direct resize writes must work without remounting React trees.

| Width | Layout |
| --- | --- |
| Below 20rem | One statistics column |
| 20rem | Two statistics columns |
| 36rem | Three columns; selector/search may share a row |
| 48rem | Four columns; navigation/inspector side by side |
| 72rem | Six columns |

`pane-readable` caps prose/chat/composer at 48rem; `pane-data` structured data at 72rem; `pane-picker` empty pickers at 28rem. Source/diff/terminal/browser/table/media canvases retain available width.

`pane-workspace` bounds independent navigation/detail scrollports. Narrow panes start at 40%/60% with an adjustable horizontal handle; wide panes use a vertical handle. Keep narrow minima 8rem/10rem and wide minima 14rem/20rem. Each orientation retains its saved size and clamps to current bounds. No detail yields one master row. `pane-columns` provides similar proportions for sections sharing a scrollport.

Trajectory overview spans the pane above both columns. Stable recorded overlap tracks prevent zoom from changing height; inter-turn idle gaps collapse while short blocks remain selectable. Vertical gestures zoom at the pointed turn, horizontal/Shift gestures pan; keyboard/buttons supply equivalent controls. Use localized beUI tooltips/legend, fixed category hues and persistent selected fill.

Record excerpts and exact tool-call jumps use bounded worker metadata, not full document reads. Older historical assistant records share model-request identity/filter semantics. Preserve the old inspector until a new record/node loads; replace breadcrumb/content together. Resizing preserves drafts, selections, expansions and DOM identity; never render duplicated narrow/wide pane trees or refetch on width alone.

All controls use beUI/theme tokens/i18n. Use independent `FadeScroll` edges, invisible scrollbar chrome and focus-ring padding. Content surfaces have no hover elevation.

## Verification

```sh
node scripts/check-trajectory-timeline.mjs
node scripts/check-present-trajectory-ui.mjs
node scripts/check-context-detail-ui.mjs
node scripts/check-debug-ui.mjs
```

UI checks require a build and measure narrow/docked/breakpoint/fullscreen states in both languages/themes/corner presets. Shared rail changes also require file-browser, written-file-preview, window-chrome, corners and terminal checks.
