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

Context separates current context, composition, latest-request metadata and cumulative session statistics. The four current measurements cap at four columns. Source fields cap at two columns; request metadata uses three columns/two rows from the wide-pane breakpoint. Composition has independent instruction/tool and conversation columns there, with aligned token/share columns and collapsed named entries; expanding one list does not insert gaps into the other. Billing and activity also share the wide pane. Long estimate explanations expand on demand. All layouts follow the named pane container and preserve mounted readouts and expansion state during resizing and polling.

`pane-workspace` bounds independent navigation/detail scrollports. Narrow panes start at 40%/60% with an adjustable horizontal handle; wide panes use a vertical handle. Keep narrow minima 8rem/10rem and wide minima 14rem/20rem. Each orientation retains its saved size and clamps to current bounds. No detail yields one master row. `pane-columns` provides similar proportions for sections sharing a scrollport.

Every navigation/detail boundary in a wide pane is draggable through `PanelResizeHandle`. The shared `useWidePaneSplit` hook serves Git and Debug, with 16rem/20rem floors, keyboard steps, a grid-owned CSS variable during drag and a saved preference on release. It reads handle visibility from named-container CSS, so inner padding cannot disagree with the breakpoint. Git retains a width per workspace/view; Debug retains its preferred width in local storage. Narrow layouts hide these vertical handles; fitting a smaller wide pane preserves the preference for later expansion. File trees and Trajectory retain their existing resize owners.

Trajectory uses a record list and detail inspector directly below its filters. The workspace fills the remaining pane height, with persistent selected fills on record rows and document buttons.

Record excerpts and exact tool-call jumps use bounded worker metadata, not full document reads. Older historical assistant records share model-request identity/filter semantics. Preserve the old inspector until a new record/node loads; replace breadcrumb/content together. Resizing preserves drafts, selections, expansions and DOM identity; never render duplicated narrow/wide pane trees or refetch on width alone.

All controls use beUI/theme tokens/i18n. Use independent `FadeScroll` edges, invisible scrollbar chrome and focus-ring padding. Content surfaces have no hover elevation.

Audio and video previews share beUI playback controls (Button, Range Slider and Select) over native media elements using the seekable `pith-media` stream. Their own named pane container wraps the controls as space narrows, preserving the media element, position, volume and rate during resizing and refresh. Video full screen includes the control surface; speed options stay inside that surface while full screen is active. Playback rejection is recoverable, while decode failures show the existing file notice. `media-preview` exercises these interactions with actual audio/video fixtures.

## Conversation ownership

Each conversation owns its right-rail tabs, active destination, picker and closed, docked or fullscreen mode. A session file identifies one conversation and its execution directory, so two chats in one project and two projectless chats have independent rails. A new conversation starts with the rail closed. The window keeps its preferred docked width across conversations.

Recent layouts, open file paths and views, file-tree preferences and the selected review turn are saved in renderer preferences. During a run of the app, each chat also retains its Git navigation, review file disclosures and side-chat draft and answers. File readers use the timed retention described in [file previews](file-preview.md), with independent state even when two chats open the same path. Switching conversations detaches terminal screens. A live shell keeps its process, current directory and scrollback and reattaches when its chat is selected again. Explicitly closing the Terminal tab closes that chat's shells. A restored Terminal tab can start a new shell after an app restart.

Browser hosts can keep running while their conversations are in the background. Browser links, tab popups, downloads, SSH sessions and debug-launched terminals are routed to their owning conversations. Background activity can add a tab to its owner without changing the visible conversation's pane. Closing a browser or terminal panel releases the corresponding resources for its chat. See [embedded browser](architecture/embedded-browser.md) for guest lifetime and restore behavior.

## Verification

```sh
node scripts/check-present-trajectory-ui.mjs
node scripts/check-context-detail-ui.mjs
node scripts/check-debug-ui.mjs
```

UI checks require a build and measure narrow/docked/breakpoint/fullscreen states across supported locales/themes/corner presets. `PI_PANE_SCREENSHOT_DIR` retains context and trajectory galleries. Shared rail changes also require file-browser, written-file-preview, window-chrome, corners and terminal checks.
