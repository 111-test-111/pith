# Session sidebar

The session sidebar composes pi-app's beUI primitives and theme tokens. Its three views are projects, custom groups and a timeline. Pinned sessions remain a separate section in each view. Projectless chats never expose their internal working directory.

## Ownership

`Workspace` owns session discovery, navigation and SDK mutations. `SessionsSidebar` owns the list's filters, paging, menus and editors. `lib/session-sidebar.ts` validates and persists presentation preferences under the existing `pi-app:session-sidebar:v1` key, preserving earlier pins and manual ordering.

Preferences include view, sorting, group membership, section/project order, collapsed sections, unread marks and archived paths. They never rewrite an SDK session's cwd or history. Custom groups can contain sessions from several projects; membership changes require an explicit group action. Dragging only reorders rows within their existing section and project. Automatic date sorting and timeline rows cannot be manually dragged.

Creation times come from session headers in the main-owned listing index. Refreshes use the existing fingerprint cache and live session derivation; changing the view or a filter does not rescan session files.

## Appearance

The translucent sidebar preference defaults to on and persists separately in `lib/sidebar-glass.ts`. On macOS, `window-chrome.ts` provides an active native vibrancy material behind the window, with a transparent WebContents background from `main/index.ts`. Both the page body and Workspace's `ChatApp` shell must leave that material visible: an opaque ancestor hides it even if the sidebar panel itself is translucent. The panel adds a light veil and accent wash; the title row and conversation retain their own opaque surfaces. Disabling glass restores the sidebar's opaque surface and removes the wash. Other platforms retain the opaque page background, and the narrow-window sheet stays opaque.

## Archive and delete

Archive is a reversible presentation operation. Archived sessions leave the ordinary views and remain in the dedicated archive view, including after a restart. Opening or continuing an archived session does not implicitly restore it. Unarchive returns it to its original project and custom group, with its pin and ordering preserved. Archive remains available while a session is running and does not stop its work.

Delete retains the existing confirmation and main-process Trash operation. Removing a custom group only removes its presentation grouping. Neither operation is substituted for archive. Indexed history search continues to search archived sessions.

## Interaction and verification

The list supports title/project filtering, all/running/unread filters, updated/created/manual ordering, persistent collapse state, expand/collapse all and per-section paging. Opening a session marks it read after successful navigation. A single context-menu target resolver serves the list; row action menus use the same action definitions. Rename failures retain the previous title and report an error.

Titles remain stationary and keep their single-line right-edge fade across the available row width. Floating row actions overlay the title without reserving an empty column or shifting it on hover. The entire session row, including its icon and metadata, triggers one beUI tooltip after a short delay. Its title wraps for up to six lines, followed by message count, date and the visible project path. Projectless workspace paths remain private. Group paths also use beUI tooltips; native `title` bubbles are absent. Tooltips are portalled outside the list's clipped scrollport and suspended during editing, dragging or an open row menu without replacing the row.

`session-sidebar` covers preference migration, sorting, grouping, archive restoration and membership constraints. `sidebar-list` exercises the built renderer's views, archive/restore, group actions, filtering, persistence, keyboard navigation and scrolling. Adjacent session-list, session-search and new-session-project suites protect index and navigation boundaries.

`sidebar-glass` covers preference persistence, theme/accent changes and the narrow-window sheet. `window-chrome` captures the built workspace's composited alpha through the production native chrome settings, including the page and shell ancestors, and checks the Appearance toggle along with opaque title/conversation surfaces. Run these after `npm run typecheck && npm run build` with `npm test -- --no-prepare --suite sidebar-glass --suite window-chrome --strict-skips`.
