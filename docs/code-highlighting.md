# Code highlighting

Settings → Appearance → Code highlighting selects separate light and dark
palettes from the installed Shiki theme catalog. Button dropdowns use upstream
theme names and mode metadata, with bounded scrolling lists. Light and dark
previews appear side by side with their color modes fixed independently of the
interface. Restoring defaults selects the original GitHub high-contrast pair.

`lib/code-themes.ts` owns the catalog, defaults, validation and cache identity.
`lib/code-theme-settings.ts` persists this renderer appearance preference in
localStorage alongside fonts and interface style, publishes live changes, and
receives storage updates in auxiliary windows. Unknown themes and themes in the
wrong light/dark slot fall back independently to the defaults at startup.

Chat and Markdown code blocks, notebook source, tool code output and highlighted
diffs use `AgentCode`. File source and read-tool previews tokenize in a disposable
worker with the same theme snapshot. Both token caches include the entire theme
pair; switching while highlighting is in flight cannot publish the old palette
into the new selection. Themes load on demand and remain available offline in
the packaged app.

Streaming blocks and large or intentionally plain previews retain their existing
highlighting limits. Changed-file hover previews snapshot only warm tokens and
discard the old snapshot when the theme changes. Code surfaces keep their
app-owned backgrounds, frames and diff addition/deletion colors; inline code
and terminal ANSI colors keep their separate rendering rules.

The `code-themes` UI suite checks button selection, both preview modes, actual rendered colors
across main-thread and worker surfaces, rapid switches, window synchronization,
reload persistence, invalid stored choices and all supported locales. Adjacent
checks are listed in the [test catalog](../scripts/tests/manifest.mjs).
