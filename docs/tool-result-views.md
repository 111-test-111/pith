# Tool result views

`components/app/ToolCallView.tsx` keeps the common beUI disclosure, status,
duration, output cap and scroll fades. Successful file-tool results delegate to
`ToolFileOutput.tsx`; errors, cancelled calls and unknown tools retain escaped
plain text. Parsing, search and syntax workers mount only while the row is open.

| Tool | Expanded output |
| --- | --- |
| `grep` | Consecutive results grouped by file, file artwork, clickable line numbers, muted context, tinted match rows and marked matching substrings |
| `find` / `ls` | File artwork and preview links; directory entries use the shared Folder glyph |
| `read` | File-language syntax tokens, with clickable actual line numbers when `details.piAppRead` is available |
| `edit` / `write` | Existing committed diff view; failed and pending writes never render intent as applied changes |
| Image reads / browser screenshots / `image` | Existing shared image preview and generation views |
| Background `bash` | Existing managed task view, command header and logs |

## Result fidelity and navigation

The hidden `pi-app-search-results` extension adds `details.piAppSearchRoot` only
to successful SDK built-ins identified by their exact `builtin:<name>` source.
It records the resolved root and whether it was a file or directory, without
replacing tool definitions, content, structured results or existing details.
This distinguishes grep's single-file basename output from its directory-relative
output. Main owns the one root stat; the renderer reads no extra files to render
a search result. Extension overrides receive no local-root stamp.

Older results remain renderable. Relative file-list paths use the call's search
root. If a legacy grep basename is also the requested root's basename, the view
omits its ambiguous navigation link. Exact paths, including spaces, `#`, `?` and
colons, enter the shared `openPath` navigation adapter rather than URL parsing.

Grep parses the SDK's `path:line: text` / `path-line- text` records and pi-fff's
file headings followed by indented `line: text` / `line- text` rows. Blank file
separators preserve every group; Git and frecency tags stay visible beside the
file label without becoming part of the navigation path. pi-fff paths resolve
from the workspace, because its `path` argument is a constraint, including
filenames and globs. Unstamped auxiliary-index results outside the workspace
remain readable without guessing the index's reusable root.

Unrecognized text and limit/cursor notices remain visible. Context lines never
acquire substring marks. The shared disposable file-search worker evaluates the
pattern against source text only, respecting the SDK's literal/ignoreCase options
or pi-fff's regex auto-detection, literal fallback and smart-case/caseSensitive
options. An invalid,
unsupported or timed-out JavaScript regex leaves the matching row tinted and
its text readable; ripgrep remains authoritative for which lines matched.

Read's stamped range separates returned source lines from SDK notices; notices
are outside the syntax tokenizer. Legacy and byte-mode reads without a stamp
do not invent line numbers. Shiki uses the existing cancellable file-highlight
worker and language routing, without interpreting returned HTML.

## Bounds and verification

Successful file output starts with 100 source/list lines. Grep pages source rows,
keeping their file headings attached. A beUI Show more action adds 100 at a time;
tool notices remain visible alongside the paged body. A 64,000
character presentation limit protects against unusually large extension output
and is disclosed. The SDK's own limits still apply independently.

Run `npm run typecheck && npm run build`, then
`npm test -- --no-prepare --suite tool-results --suite tool-write-row --suite transcript-rhythm --strict-skips`.
The tool-results fixture exercises real Chromium workers, SDK and pi-fff formats
(including the grouped Git-annotated output), literal/regex/context highlighting,
smart-case, file and line navigation, read fidelity, paging, legacy output,
locales, themes and failure fallbacks. `PI_TOOL_RESULTS_SCREENSHOT_DIR` retains
its visual gallery.
