# File-type icons

`FileTypeIcon.tsx` subscribes to the shared interface-style preference. Square
uses the application's angular Pierre adaptations; squircle uses the native
complete file-icon set from `@pierre/trees` 1.0.0-beta.4, matching the Codex
desktop file tree and review headers, with a local Sass override. Both include
application additions for document and media formats. Switching style updates existing image elements immediately, including
file trees, rail tabs, Git lists, attachment cards, sent-message file chips
and delivered files. Folders and toolbar actions use the ordinary UI glyph
adapter.

`lib/file-icons.ts` resolves the same Pierre filename/extension associations in
both styles, with compound extensions checked before shorter suffixes and a
generic fallback for unknown types. Both styles use the shared sizes from `icon-metrics.ts`.
The Pierre snapshot preserves upstream paths, native viewports and opacity;
its generated SVGs contain the upstream light/dark palette. Embedded SVG media
queries inherit the image element's color scheme, so the app's light/dark/system
theme controls their colors.

Original Pierre artwork, palette and license notices are checked in under
`resources/pierre-icons/`. Bearded artwork and its associations are retained for
rollback under `resources/bearded-icons/` and `lib/file-icons.map.json`. The
renderer imports only the association maps. Install, development and production
builds run `scripts/prepare-file-icons.mjs` offline to generate the reachable
SVGs and their notices under the ignored `src/renderer/public/file-icons/`.
Pierre assets occupy its `pierre/` and `pierre-square/` subdirectories. Relative
image URLs also work in the packaged `file://` renderer.

## Square adaptations

`resources/pierre-icons-square/` contains a complete separate set of 59 source
SVGs, covering the 53 upstream drawings and six application additions. The
artwork uses square document/tile corners, sharp folds, flat-ended lettering,
angular symbols, square nodes and media marks. Database uses a faceted top cap
and three stacked layers. Astro, Biome, Browserslist, Claude, Docker, JSON,
Python, React, Svelte, SVGO and Swift are explicit native exceptions: their
complete original SVG bytes are copied unchanged into the square set. Sass
uses a separate upright S monogram with flat ends aligned to the stems' outer
edges and right-angle bends. JavaScript, TypeScript and CSS use the same
alignment for their S lettering. PostCSS has an inset square frame.
Intrinsic diagonal shapes remain recognizable.
Six upstream drawings that already contain only
straight segments retain their native geometry. Both styles use the same
light/dark palette, associations and tree/tab/card sizes.

`scripts/generate-pierre-square-icons.mjs` owns the reviewed constructions and
regenerates the committed SVGs offline. It checks complete source coverage and
rejects curved path commands outside the native exceptions. Ordinary builds only prepare the committed SVGs;
they do not redesign artwork. Upstream refreshes leave this directory intact.
Review any changed upstream artwork before updating the square constructions.

The square directory carries the Apache-2.0 license, its modification notice,
the upstream notice and the application addition/override notice. Preparation ships
all four alongside the square SVGs. The original snapshot remains native.

## Application additions and overrides

`resources/pierre-icons-extensions/` keeps six application SVGs separately from
the upstream snapshot: PDF, documents, spreadsheets, presentations, audio and
video. They adapt Pierre's 16px document silhouette and use its palette with
40% opacity backgrounds and solid format marks. Document/Office variants use
red, blue, green and orange; audio and video use purple and indigo.

The same directory holds `sass.svg`, a separately drawn upright curved S for the
squircle interface. Both Sass variants have equal upper/lower halves with
central symmetry about the 16px canvas centre. Its pink palette matches upstream Sass, while the original
Sass source remains untouched in the Pierre snapshot. It shares the existing
Sass/SCSS associations with the angular version.

`lib/pierre-file-icons.extensions.json` owns their extension associations and
palette token selections; an icon listed in `colors` also selects its local
source SVG for squircle. These associations override the Pierre snapshot's
generic entries, including replacing the table drawing for Office/OpenDocument
spreadsheets; CSV/TSV retain the table icon. Exact filenames still take
precedence in both styles. Ambiguous source/key suffixes such as `ts`, `mts`,
`dot` and `key` are not claimed as media
or Office formats. Icon associations do not change file preview support.

Offline preparation copies the additions and overrides to the generated `pierre/`
directory and ships `EXTENSIONS-NOTICE.txt` alongside the upstream Apache-2.0
license/notices. Upstream refresh only replaces the Pierre snapshot and map;
it leaves these application sources, associations and colors intact.

## Refreshing snapshots

The maintenance commands access upstream resources; ordinary builds require no
network access or tree-library dependency:

```sh
npm run icons:file-types
node scripts/generate-pierre-file-icons.mjs
node scripts/generate-pierre-square-icons.mjs
node scripts/prepare-file-icons.mjs
```

The Pierre importer pins and verifies the published npm archive's SHA-512
integrity before extracting its file artwork, complete-set associations and
palette. It also accepts an unpacked package directory as its first argument
for an offline refresh. A version change requires reviewing the archive pin,
source format and resulting snapshot. Commit the source snapshots and lookup
maps, including upstream licenses and notices; leave generated public assets
out of version control.

The `icons` suite checks live family switching without losing mounted controls,
filename associations, decoded artwork, actual document/media/Sass theme colors, native exception fidelity, card sizes and
all packaged SVGs/licenses through local `file://` URLs. Set
`PI_ICONS_SCREENSHOT_DIR` to retain both styles' light/dark galleries for visual
review, including focused document/media galleries. Run the affected file-pane
suites as described in [testing](testing.md).
