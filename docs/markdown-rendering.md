# Markdown rendering

`lib/markdown.tsx` owns the shared renderer for conversations, file previews and
notebook cells. Parsing uses CommonMark, `remark-gfm`, math and the shared
`lib/markdown-plugins.ts` stack. Renderer adapters must retain parser-produced
IDs, classes and accessibility attributes; footnote reference/return links use
unique IDs per rendered block and navigate within their own Markdown region.

## Math compatibility

`lib/math-renderer.tsx` renders parser-produced formulas through Temml, with
formula-local macros from `lib/math-compat.ts` for these common package forms:

| Syntax | Compatibility |
| --- | --- |
| `psmallmatrix`, `bsmallmatrix`, `Bsmallmatrix`, `vsmallmatrix`, `Vsmallmatrix` | Compact matrices with parentheses, brackets, braces or single/double bars |
| `smallmatrix*` and the fenced starred variants, optionally `[l]`, `[c]`, `[r]` | Compact cells with the specified column alignment |
| `cases*`, `dcases*`, `rcases*`, `drcases*` | Native case layout with a text second column, including embedded `$…$` math |
| `eqnarray`, `eqnarray*` | Three-column legacy equations adapt to native `align`/`align*`, joining the relation and right-hand side into one alignment cell |
| `\mathds{…}`, `\mathbbm{…}` | Double-struck glyphs in the configured math font; the original packages' separate font designs are not loaded |
| `\ii`, `\proj{…}` | Imaginary unit `i` and a pure-state projector `\ket{…}\!\bra{…}`; explicit definitions within the formula override these defaults |
| `\diag`, `\Diag`, `\nullity`, `\Var`, `\Cov`, `\cov`, `\Corr`, `\corr`, `\Span` | Upright operators with native operator spacing |
| `\sech`, `\csch`, inverse trigonometric/hyperbolic names, `\erfc`, `\esssup`, `\essinf` | Upright operators; essential sup/inf retain limit placement |
| `\DeclareMathOperator`, `\DeclareMathOperator*`, starred command definitions | Formula-local operator/command definitions; explicit definitions take precedence over compatibility aliases |
| `\mspace{…}` | Native math spacing |

The compatibility layer receives Temml lexer tokens, not raw Markdown or DOM
content. Escapes, comments, verbatim text, braced expressions and nested arrays
retain their own boundaries. Original source remains in the TeX annotation and
in storage, so historical messages gain support when reopened without rewriting
session files. Each expression gets fresh macros; definitions cannot leak into
another formula. Existing lazy loading, bounded caches, expansion/size limits
and `trust: false` still apply.

The renderer does not load a referenced document's preamble. Document-specific
macros need definitions in the expression unless they match a supported default;
native Temml/physics commands retain their existing meanings.

Temml remains a math-mode renderer rather than a complete LaTeX document engine.
Arbitrary document packages, TikZ, custom tensor packages and the `multlined`
environment are outside this compatibility layer. Unknown commands, malformed
environments and invalid alignment options remain readable as original source.

## Supported syntax

| Syntax | Behavior |
| --- | --- |
| CommonMark headings, lists, quotes, links, code, emphasis and rules | Shared across all Markdown surfaces |
| GFM tables, tasks, strikethrough, literal links and footnotes | Table alignment and ordered-list starts survive component adapters; footnotes keep repeated references, multiple paragraphs and math |
| `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and fenced `math` | Parsed into lazy Temml/MathML components; code and escapes remain literal |
| Fenced `mermaid` | Codex-inspired diagram/source switch, source wrapping, draggable canvas, SVG download and a header button for the shared image viewer |
| Bare `<br>`, `<br/>`, `<br />` | Converted to typed break nodes |
| Balanced inline `<sup>`, `<sub>`, `<mark>`, `<kbd>`, `<ins>`, `<del>`, `<u>`, `<s>` | Attribute-free tags become typed inline nodes; their contents can include Markdown, links and math |
| `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` | A marker on the first line of a quote produces a localized GitHub alert; nested Markdown remains intact |
| YAML frontmatter | File previews display it as metadata, outside the Markdown body |
| Standalone balanced XML-like blocks | File previews retain literal tags and indentation |

File previews preserve soft line breaks in prose, including quotes, table cells
and footnotes. An explicit `<br>` with an adjacent source newline produces one
break. Conversations and notebook cells keep CommonMark soft-break behavior;
explicit hard breaks work everywhere. Formatting changes rendering input only,
never the source file or bytes sent to the agent.

Footnotes appear below a divider at the annotation text scale. The localized
footnote heading stays available to assistive technology and is visually
hidden. Reference/return links preserve focus and scroll only their file pane.

## Local file paths

`shared/file-links.ts`, used by `lib/file-navigation.tsx` and the native runtime,
decodes local link URLs and line anchors. It preserves
a leading `~` or `~/` until main resolves the host's home directory; joining it
to a workspace or collapsing its `..` segments first changes the target.
`main/file-path.ts` shares this expansion with tool paths and serves file,
PDF, table, font, HTML and attachment readers, plus native file actions. Only
the leading home marker expands: `./~/file`, embedded tildes and `~name`
remain literal filenames. Filesystem paths from attachment metadata are encoded
before link parsing so literal `#`, `%`, `?` and `:` retain their meaning.

`FileBrowserStore` resolves home targets through typed preload IPC before
publishing absolute tab/cache/media identities. A newer open, tab selection,
close or clear invalidates pending navigation. PDF previews distinguish missing
or unreadable files from PDF parsing failures using shared localized notices.

## Remaining dialects

These are currently displayed as ordinary text/code rather than interpreted:

| Extension | Current alternative / boundary |
| --- | --- |
| `^superscript^`, `~subscript~`, `==highlight==` | Use `<sup>`, `<sub>`, `<mark>`; a single tilde already belongs to GFM strikethrough |
| Definition lists (`term` followed by `: definition`) and abbreviation definitions | Use ordinary lists or tables |
| Wiki links (`[[Page]]`), block references, heading attributes (`{#id}`) | Use Markdown links and the generated heading-text navigation in file previews |
| `[TOC]` / `[toc]` | Use an explicit linked list of headings |
| PlantUML and other diagram fences | Remain highlighted code; require a separately scoped rendering engine |
| `:::container`, Obsidian callout modifiers and other editor directives | Use the supported GitHub alert syntax |
| Arbitrary HTML, HTML tables, `<details>`, `<summary>` and tags with attributes | Remain inert source text; full HTML documents use the confined HTML preview |

The inline tag support does not enable an HTML parser or accept HTML attributes,
scripts, styles or embedded documents. Incomplete, escaped and unsupported tags
remain literal. New dialects should enter through the parsed syntax tree with
observable tests, rather than a document-wide HTML/DOM rewrite.

## Mermaid diagrams

`components/app/MarkdownMermaid.tsx` composes beUI controls and the existing
image preview. Conversation, file and notebook Markdown share this adapter.
One Codex-inspired presentation uses ELK layout, open flowchart arrowheads,
padded edge labels and dashed decision frames. There is no style picker.
Uncolored nodes use a subtle app-accent fill with neutral connectors; explicit
`classDef`/`style` colors remain authoritative. Diagram typography uses the
configured interface font and the interface's compact text size (one step
below body text). Preview and source are
presentation choices; copying always retains the Mermaid source. The header
shares the regular code-block layout, with the view switch and actions on the
right. A separate preview button opens the shared image viewer, including from
source view when rendered artwork is available. Wrapping is a source-only toggle and retains its state across view
changes. SVG download exports the displayed self-contained artwork, including
the current theme, font and corner geometry, through Electron's native download.
Streaming blocks show source until the response finishes. Invalid or oversized
diagrams show a localized notice and retain readable source.

`lib/mermaid.ts` loads the packaged official engine only for a settled diagram.
It serializes initialization/rendering to isolate Mermaid's mutable singleton,
skips cancelled queued requests, rejects stale results and bounds the image
cache, input size and edge count. A hidden measurement container is removed on
success or failure. Strict security and SVG-only labels cannot be weakened by
source directives. `mermaid-layout.ts` decorates the official public ELK loader;
`mermaid-image.ts` removes source HTML before adapting rectangular frames.
Square frames remain SVG rectangles. Squircle frames use app-created empty
CSS boxes in SVG `foreignObject`, with the app's semantic radii and native
`corner-shape`; they contain no source labels, children or event handlers.
Circles, cylinders and other semantic shapes retain their native artwork.
The generated self-contained SVG is displayed as an image,
without DOM insertion or callback bindings, and includes a theme background so
labels remain readable over the image overlay. Theme, corner and font changes
regenerate mounted previews. Inline previews retain the SVG's native scale so
ordinary labels keep the compact interface text size even in complex
diagrams. Small graphs remain centered; larger ones scroll in both axes inside
the code-block frame, with shared wheel/Shift handling, keyboard scrolling and
edge fades. The canvas caps its height at 70% of the window without scaling
the artwork. Resizing a pane changes its viewport without shrinking labels or
regenerating the artwork. Hover uses a grab cursor without a color overlay;
holding the primary pointer pans directly, with capture until release or
cancellation. Clicking the canvas does not open the viewer, and it has no
hover tooltip. Ordinary image thumbnails retain their existing interactions.
The Mermaid header button registers in the same content-owned gallery so mixed
image navigation and focus restoration remain intact.
The shared image overlay resizes SVG images at each zoom
level rather than magnifying a composited fit raster; pan limits continue
to use the fixed fit size. Raster-image zoom is unchanged.

## Verification

After typecheck/build, run `markdown-math`, `markdown-links`, `markdown-mermaid` and `file-browser`
through the unified runner with `--no-prepare --strict-skips`. The first suite
uses the packaged `file://` renderer and exercises inline tags, alerts, file
line breaks, footnote accessibility/keyboard navigation, repeated references,
multiple Markdown regions, streaming and formula isolation. Set
`PI_MATH_SCREENSHOT_DIR` to retain light/dark galleries for visual review.
Home-path changes also require `file-browser-cache` and `pdf-preview`: they
exercise URL decoding, literal tildes, navigation races, production preload
resolution and rendering a home path whose filename contains spaces.
The Mermaid suite uses packaged `file://` assets and covers source/preview,
exact copying, source-only wrapping, real SVG downloads, lazy streaming,
concurrent diagram types, invalid input,
directive confinement, narrow file panes, locales and enlarged-view focus.
Direct dragging covers both axes, cancellation, lost capture and release
outside the canvas; mixed galleries preserve ordinary image hover/click/focus.
The complex flow/sequence fixtures also cover live interface fonts, both corner
styles, accent changes with preserved explicit colors, readable displayed text
at both wide/narrow pane sizes, horizontal scrolling, and vector zoom sizing.
Set `PI_MERMAID_SCREENSHOT_DIR` to retain the light/dark square/squircle gallery.
