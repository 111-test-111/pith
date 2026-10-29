# File previews

`src/shared/preview.ts` is the routing contract for file panes, links and Library previews. `readsAsText` is the only document-read gate. Binary formats use dedicated typed readers through `window.pi`; Save As copies the complete original file.

PDF initialization, zoom and internal destinations must scroll only the PDF viewport. When a short document fits completely, pdf.js otherwise walks through non-overflowing ancestors and can scroll the clipped workspace, moving the rail tab strip and toolbars offscreen. The app override in `components/app/pdf-viewer.css` retains a minimal local scroll range so that traversal stops at the PDF viewport. `pdf-preview` exercises this with the real rail, an overflowing workspace sibling, docked/fullscreen layouts and Markdown tab switches.

## Archives and data

ZIP, TAR, TAR.GZ/TGZ and GZ have a searchable, windowed file tree. `FileTreeView` composes the same beUI collection, row geometry, labels and keyboard controls for archives and the filesystem sidebar. Navigation rows own their gray hover fill through the ordinary CSS color transition, so virtual row transforms cannot move a shared animation over a row the pointer already left. Folders only expand/collapse and never acquire persistent selection; only files open previews. Search keeps matching ancestor branches. Returning from a file preview leaves the tree unselected while restoring the keyboard anchor, expansion, query and scroll position through `FileBrowserStore`; these reading choices survive tab revisits. The archive toolbar has a fixed height through expansion and file previews. Extremely deep paths or excessive implicit directories retain their remaining path as one label within the tree's construction budget.

ZIP filenames decode from raw bytes before separator normalization. UTF-8 flags and CRC-checked Unicode Path extra fields take precedence; bounded GBK/Big5 evidence across the archive helps decode short basenames, including legacy bytes that also form valid UTF-8. Otherwise unmarked valid UTF-8 is accepted. Unlabelled short names remain ambiguous without other evidence: GBK is preferred when Chinese byte patterns explain CP437 box-drawing/Greek glyphs, otherwise CP437 is retained. The filesystem tree already uses Unicode names from native directory reads. Filename decoding never changes entry ordinals or original bytes.

Opening a file reads its bounded content directly, without extracting it. Text uses the existing source viewer, structured text uses the tree viewer, and supported images use the shared image preview. Nested binary files, encrypted entries, links and unsafe paths are not opened. Complete ZIP entry reads validate CRC. TAR traversal stops at its scan budget and reports a partial tree. GZ represents its single decoded stream; its stored size is the gzip trailer's modulo-32-bit size.

Parquet uses footer metadata and range reads with `hyparquet`, including bounded decompression. The grid requests row pages and preserves 64-bit integer strings. SQLite queries a bounded private database/WAL snapshot with a read-only connection, query-only transactions and disabled extension loading. This prevents SQLite's shared-memory sidecar handling from writing beside the original file. Snapshots have a byte ceiling in `src/main/file-preview/data.ts`; cancellation and disposal reclaim their service-owned directory. The viewer lists ordinary main tables and their visible columns, excluding views, virtual/shadow tables and generated columns. Table selection and the Data/Schema view live in `FileBrowserStore`. SQLite row totals remain unknown instead of running a full-table count. WAL fingerprints invalidate stale rows when commits change the data.

`src/shared/file-preview.ts` owns DTOs and entry, column, row, page and cell budgets. The main readers add range, metadata, decompression and traversal budgets. Worker jobs have bounded admission, memory and time; closing a pane releases its request, closing a window cancels its owned work, and quit disposes the service. A changed file produces a refresh notice rather than combining incompatible snapshots. Unsupported compression or an oversized row group yields an explicit notice.

A non-cleared rollback journal reports busy: the preview does not recover the source or display potentially uncommitted main-file pages. Live databases using in-memory/off journaling have no durable rollback evidence; this viewer targets stable files and committed WAL snapshots, not a debugger for those modes.

`src/main/file-preview/` owns filesystem work in a disposable Node worker emitted as `out/main/file-preview-worker.mjs`. Main performs path and query validation before dispatch. The renderer's bounded caches deduplicate active requests, reject released responses and keep table snapshots across pane mounts. Width changes neither replace the canvas nor trigger reads.

## Structured text and encodings

JSONC accepts comments and trailing commas. JSONL/NDJSON shows records as an array; capped reads keep complete lines and identify invalid record line numbers. YAML supports multiple documents and limits alias expansion. TOML and XML produce the same finite tree. XML DTD/entity declarations are rejected. Parsing runs in a disposable browser worker with depth/node limits and a deadline. Syntax or size failures leave Source available.

Text previews detect UTF-8, UTF-16 LE/BE, GBK/GB18030 and Big5 automatically. Detection prefers BOM/UTF-16 evidence and strict UTF-8; Chinese encoding guesses follow only when UTF-8 fails. Short or ambiguous input may remain uncertain. Source and archive text previews expose no encoding control. Delimited previews also detect the encoding for record-aligned slices. Decoding never changes the original bytes.

## Git differences

`FileBrowserCache` retains bounded diff snapshots across pane mounts and deduplicates active reads. Entering Diff validates HEAD and the working tree in the background while keeping the last snapshot visible; refresh, window focus and completed agent turns do the same. Unchanged reads retain snapshot identity. Refresh revokes older requests, and closing a tab or clearing the store drops its cached diffs so late responses cannot restore them.

The file diff scrollport publishes its attached root as the review body's layout key. This recalculates virtual rows before paint after restoring a saved scroll position, so a distant diff does not briefly show an empty viewport.

## Verification

After `npm run typecheck && npm run build`, run:

```bash
npm test -- --no-prepare --suite file-preview-data,file-preview-ui,file-browser-cache,file-browser,preview-routing,table-preview --strict-skips
```

The data suite creates real archives, Parquet row groups and SQLite/WAL databases; it checks legacy ZIP names, Unicode metadata/CRC, limits, corruption, parser failures, cancellation, encoding recovery and original-byte fidelity. The UI suite uses the production preload and main worker with real Chromium interactions. It samples painted hover-exit frames for archive/sidebar rows and ordinary/context menu actions, including transfers between rows, and checks stable geometry and cleared fills. It also covers archive tree/keyboard/search behavior, fixed toolbar geometry, 4,800-entry windowing, grid paging, localization and resize/revisit behavior. `PI_FILE_PREVIEW_SCREENSHOT_DIR` retains its screenshot gallery outside the repository.

7z/RAR and archive-contained PDF, video, audio or nested databases are outside this first batch.
