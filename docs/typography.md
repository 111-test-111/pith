# Typography and font sizes

`src/renderer/src/lib/typography.ts` owns the three independent text bases, limits, derived line metrics and renderer preference. `styles.css` maps them to semantic text utilities. The numeric source values live in that module; CSS provides the same defaults for a renderer that has not initialized yet.

## Ownership

| Setting | Text controlled |
| --- | --- |
| Interface | Navigation, chat lists, file trees, tabs, buttons, menus, settings/forms, tool titles, status, hints, statistics and chart labels |
| Content | User/assistant messages, the native prompt editor and message editing, reasoning, plans, Markdown/notebook prose, subtitles and formulas; compact table cells use a derived size |
| Code | Inline/fenced code, source and raw file views, line numbers, diffs, tool output, logs, debug expressions/values, assembly/memory and raw trajectory JSON |

A monospace family does not imply the code size: paths, token counts, durations and status metadata remain interface text. Code-block language/copy controls remain interface text. Terminal body text uses the code base plus a fixed offset to retain its existing density. Font families are still independently configured through `lib/fonts.ts`.

PDF pages, HTML previews, browser guests, image/media canvases and font specimens keep their own authored text or zoom. Their surrounding controls follow interface text.

## Settings and persistence

Appearance composes `FontSizesGroup` from beUI inputs and buttons. A field edits a draft; blur or Enter clamps the integer to its supported range and commits it. Empty input restores the saved value; Escape cancels the draft without closing the enclosing settings surface. Restore defaults updates all three bases.

The renderer stores one validated preference at `pi-app:font-sizes` in localStorage, alongside existing renderer appearance preferences. Invalid stored fields fall back independently; malformed JSON falls back to all defaults. `main.tsx` initializes the scale before mounting React. Storage events synchronize main and picture-in-picture renderers sharing the origin. No IPC or duplicate `AppSettings` shape is needed.

## Geometry and rendering

The root rem and Electron zoom stay fixed. UI size levels and explicit UI line utilities derive from the interface base; annotations keep a readable floor. Content and code utilities use their own line metrics. Assign a semantic role explicitly instead of adding another pixel size or using a blanket monospace selector. `lib/utils.ts` registers custom text/leading utilities with tailwind-merge so beUI overrides preserve text colors.

Source and diff virtualizers use the actual code row height for rows, spacers and navigation. Line-number gutters grow with the configured glyph width and digit count, retaining their default floor. Source wrapping measures those insets and the configured monospace glyph width, preserving a logical line/character anchor across reflow. Scrollable diffs and tables preserve the visible row when their size changes. Page-scrolled reviews window against the owning scrollport and retain the reading line. Whole-line preview caps and user-message clamps follow their corresponding metrics.

The native plaintext prompt editor remains mounted; its existing observer recalculates measured line boxes. Multiline beUI inputs size rows with `lh`. The existing terminal runtime updates xterm font options and schedules a fit, preserving emulator and PTY ownership, scrollback and mount lifetime.

All single-line fields share the sessions sidebar filter's text and insets through [`lib/input-style.ts`](../src/renderer/src/lib/input-style.ts): the small interface text role, symmetric vertical padding and horizontal padding, including numeric fields, branch creation, searches and editable pickers. Height follows the chosen text role's line box; consumers supply widths, font families, alignment and adornments while the shared style owns text size and padding. Icons reserve additional text space. Input actions fill that height, and containing toolbars can grow with enlarged interface text. Multiline fields retain their separate row, text and padding geometry.

Markdown inline code scales with its containing text using the code/content ratio, so body code keeps the code preference and heading code grows with its heading. A registered inherited cap-height metric aligns the monospace run with the surrounding type; native inline fragments retain wrapping. Fenced code and other code views retain their independent base.

Tool, diff, reasoning and waiting labels share `transcript-label`. Native text-box trimming removes asymmetric font leading before flex centring, with symmetric font-relative padding to keep CJK glyphs and Latin descenders visible when a label truncates. Metadata keeps the title baseline; row heights, leading icon canvases and body indents retain their shared geometry.

`ShortcutKeys` renders one native `kbd` per key, with plus separators outside the frames. Letters explicitly use the interface font and the keycap text role; word labels keep their compact interface size. Keyboard-only Lucide artwork comes from `src/renderer/public/lucide-keycaps/` through the shared icon adapter. Its SVG canvases use font-relative capital-height units to match letters optically as the chosen interface font or size changes, while preserving the upstream paths. Key frames and the settings recording field grow with the same text role. Original SVGs and ISC/Feather MIT notices ship with the renderer; `node scripts/generate-keycap-artwork.mjs` refreshes the drawing data offline.

## Verification

`font-sizes` exercises real production controls and Chromium-computed text sizes, independent categories, draft/commit/reset, invalid stored values, pre-mount restoration, cross-window storage events, native editor identity/selection, bounded source/diff rows and reading anchors, compact tables and the persistent terminal. Related suites cover source wrapping/find, Markdown/math, message collapse, transcript rhythm, tables, terminal IPC and settings navigation.

Run the source-owned catalog through `npm test -- --no-prepare --suite font-sizes --strict-skips`. `PI_FONT_SIZES_SCREENSHOT_DIR` optionally retains a maximum-size gallery.
