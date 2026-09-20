# Pith

The desktop client for **pi-agent**: the **Pi SDK** kernel ([@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)) running in Electron's main process, with a fully **beUI**-built interface in the renderer.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 44 (ESM main/preload, contextIsolation, no nodeIntegration) |
| Kernel | `@earendil-works/pi-coding-agent` 0.85 — `createAgentSession` + `ModelRuntime` (pi-ai) |
| UI | beUI components (chat-app bundle: message, message-scroller, prompt-input, tool-result, file-diff, code-block, agent-activity, ai-sidebar, animated-sidebar, morphing-modal, theme-toggle, combobox, …) |
| Icons | Hugeicons Stroke Rounded through a shared typed adapter; provider brands use bundled static Lobe SVGs |
| Markdown | `react-markdown` + `remark-gfm` (tables, nested lists, task lists) — code fences render through beUI's `CodeBlock`, all other elements styled with beUI theme tokens |
| Renderer build | Vite 7 + React 19 + Tailwind CSS 4 |
| Theming | next-themes (light/dark/system) + 7 accent presets via CSS variables |

## Features

- **Interface style** — the interface ships in two styles chosen in Settings → Appearance: **square** (the default — hard-edged controls, cards and floating surfaces) and **squircle** (the restored native Chromium superellipse corners across controls, cards, conversation bubbles and floating surfaces, with the shared semantic radius scale). The icon pack follows the choice (the style is one preference, so geometry and artwork cannot disagree), and switching applies live with no reload. In the squircle style, panels, `--app-radius-capsule` surfaces and other genuinely circular affordances keep their true geometry. Dialog/popover animations preserve the native silhouette throughout entry and exit, including reduced-motion and instant-preview paths. `node scripts/check-corners.mjs` pins **both** presets — every radius token value plus the capsule sites — on the actual beUI components in isolated Electron without opening real sessions.

- **Terminal panel** — real interactive login shells in the right sidebar, with compact beUI segment tabs distinct from the top-level underline tabs. An exited terminal page shows only its exit status and releases its emulator and scrollback. Opening Terminal creates one shell; new terminals use the current session's directory (home for projectless chats). Switching panes or collapsing the sidebar preserves running shells and scrollback; closing the last terminal closes its panel tab. The terminal follows the configured monospace font and light/dark background. Its dedicated ANSI palette preserves color meanings across all UI accents, with contrast-checked colors, selection and cursor. Supporting TUIs can query colors through OSC 10/11 and subscribe to live light/dark changes through mode 2031. xterm.js uses WebGL for the visible terminal, a 10,000-line scrollback, and smooth scrolling. Resizing retains the last rendered frame until the new canvas is painted, so dragging the sidebar does not flash blank. A separate Electron utility process hosts node-pty; batched output and parser acknowledgments bound the pipeline during heavy output. Close/reload/quit releases owned PTYs. `node scripts/check-terminal.mjs` verifies real shells, lifecycle, resizing and output performance in an isolated Electron profile after a build.

- **Embedded browser** — a right-rail browser panel whose pages are native `<webview>` guests driven by a main-process service over the app's own debugging endpoint: multi-page tabs with URL bar, zoom, in-page find, print, history, recents, session restore, device emulation, clear-data and an annotate mode that lifts a picked element into the composer draft; chat http(s) links open in it by preference. The 13 `browser_*` agent tools (aria snapshots + ref interaction) drive the same guest the user sees — the agent works on the visible page and hands it back — behind a one-time consent for the shared persistent login partition and a Settings → Browser toggle. Guest downloads save to ~/Downloads with a toolbar indicator. `node scripts/check-browser.mjs` and, after a build, `node scripts/check-browser-ui.mjs` verify the logic and the real Electron flows, including the measured webview/playwright constraints.

- **Managed bash tasks** — the model chooses blocking or background execution. Blocking commands automatically move to the background after the configured limit (Settings → General → Shell tasks, default 10 seconds, range 0.1–60 seconds). `bash_task` lists tasks, reads incremental output, checks status or stops the process tree. Completed background commands immediately enter the owning session's steering queue at the next model/tool boundary; an idle session wakes to handle the result. Background rows and a compact task list remain distinct from agent activity. Stop/Esc cancels the current session's commands and suppresses completion wakeups. Switching chats or reloading extensions preserves tasks; deleting/rewinding a session or quitting terminates them. Startup restores records as interrupted, never re-executes commands or takes ownership of saved PIDs.
- **Task lists** — built-in `todo_write` tracks multi-step work using full-list replacements with stable task IDs and pending, in-progress, completed and cancelled states. The latest successful result on the complete selected branch restores the list after compaction, reopening, retries and forks, including older pi-web lists. Task list and Background tasks share the strip above the conversation: each opens its own beUI panel, switching panels never moves the transcript, and Escape closes the panel before stopping the run. Paused sessions keep their saved task progress with a stationary indicator. Context reminders cover ordinary requests and background completion continuations without adding messages to history or starting maintenance turns. Cancelled tasks remain distinct from completed work. Task lists keep their entry and remain clickable even if the model clears them before marking every item finished. The panel shows the last list as history with its original statuses; reopening the session restores it without reactivating unfinished tasks.
- **Plan Mode** — turn it on from the composer's `+` menu (or send an exact `/plan` to toggle without starting a turn); while it is on a plan chip takes the permission picker's place, and its exit mark is one hover away. A mode chosen before the session's tools are ready is queued and applied when initialization ends. Plan restricts managed model tools to local file investigation and keeps your original permissions unchanged. The model submits a versioned plan card in the conversation; revise it through the composer, copy/export Markdown, or explicitly start execution in the same chat. Approval binds the current version and never upgrades permissions. The approved plan is handed to the model as a synthetic user turn that stays **out of the transcript** — the card and the execution read as one continuous exchange — and the card then offers **Review changes**, which opens that execution turn in the Review pane (its files included). Shell requires full DSH read-only enforcement; there is no unsandboxed fallback. Network access, arbitrary plugin host code, user terminals and other sessions are outside this local-file constraint. See [implementation, recovery and verification](docs/plan-mode-implementation.md).
- **Complete agent loop** — prompt → streaming text/thinking → tool calls (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) → results → next turn, with abort and steering support. Sessions persist through pi's `SessionManager` (JSONL under `~/.pi/agent/sessions`).
- **Integrated window layout** — native window controls share a single themed title row with the project/session breadcrumb and app actions. macOS keeps its traffic lights; Windows/Linux use the native controls overlay. The sidebar and conversation start below this row, and Settings/startup use the same control-safe layout. Title-row gaps drag the window; buttons stay interactive, and modal dialogs temporarily own the backdrop. Long session titles fade, while full project paths remain available on hover.
- **New session page** — a centered content column with a left-aligned greeting, compact project context, composer and three editable starting points. Project sessions offer code exploration, feature planning and change review; projectless chats offer idea planning, small tools and concept explanations. Suggestions fill the draft without sending and preserve existing text and attachments. The layout follows the conversation pane's width and keeps the same composer mounted when the first turn begins.
- **Responsive session startup** — opening or creating a chat restores the conversation without waiting for extension startup. The composer accepts drafts while tools prepare and enables sending when they are ready. pi-fff 0.10.6 registers its tools immediately and initializes its native file index on the first search, so ordinary messages do not wait for an eager scan. Other extensions retain their required startup lifecycle.
- **Multi-folder session sidebar** — sessions grouped by working directory; new chat, open folder, paginated "show more", and delete session / delete whole project (moved to the OS trash, with a confirm dialog). Opened folders are remembered across launches (`<userData>/app-settings.json`). Projects are fixed containers: drag, keyboard and menu moves only reorder sessions within the same project/section. Session menus offer pin/unpin in a dedicated pinned section; pins and manual ordering persist locally across restarts. The list has no bottom padding — its last row ends on the panel's bottom line — and a row the bottom edge cuts fades out through the app's shared 12px ramp instead of ending in a hard chop.
- **Session search** — A sidebar search button opens a dedicated BeUI CenterMorphModal with unified title-and-message search, highlighted excerpts and paginated results across all projects. The compact panel lists all existing conversations by project when the query is empty, showing titles only; entering a query adds matching excerpts. Larger collapsible folder headings and indented rows make the hierarchy clear in both views; overflowing session titles fade at the right edge. Results are grouped by the full project-folder path; folders and conversations are ordered by latest activity before pagination. Space-separated terms must all match; double quotes keep a phrase together. Literal matching supports Chinese (including one/two characters), Unicode normalization, case-insensitive English, code and paths. Full text searches conversation prose, compaction summaries and saved branch history by default. The optional “Include tools, files and thinking” scope adds tool calls/results, attachment bodies and thinking. Excerpts preserve their source and prefer user/assistant prose over tool echoes of other conversations; phrases never cross content blocks. Image bytes and hidden extension metadata are excluded. A worker-owned SQLite FTS5 character/bigram index persists at `<userData>/session-search.sqlite`; metadata scans re-index only changed files, and visible searches refresh automatically. Malformed files are skipped quietly without repeated parsing; a file change retries them. Indexing, search and open-failure diagnostics stay out of the panel; transient search failures retry automatically while keeping successful results. First use builds the local index without blocking the agent or UI.
- **Providers & models** — provider discovery, availability from real auth status, per-session model switching, thinking-level control (`off`→`max`), API-key and OAuth (browser/device-code) login bridged into the UI (keys land in `~/.pi/agent/auth.json`).
- **Spinner verbs** — the turn-in-progress row plays a Claude Code style status sentence beside a beUI `peeek` Loader sized like the transcript's tool glyphs, in body text size; loader and sentence both wear the theme accent, and the sentence runs beUI's native `TextShimmer` (a gradient sweep, 2s a pass, with the component's own reduced-motion reset). The sentence is picked from the pool matching the frontier step — reasoning, or the kind of tool call that is running (reading, searching, running a command, editing …) — and rotates on a shared 10-second wall-clock cadence rather than following each step: switching tools mid-slot never swaps the sentence, and re-renders or a session switch keep the one already on screen (and never restart its sweep). English and Chinese sentences ship in the table and follow the interface language. Settings → General turns the mode off, which restores the plain spinner. `node scripts/check-spinner-verbs.mjs` verifies the table and its pools, step targeting, rotation and per-slot latching, the peeek wheel, the native shimmer (its keyframes and reduced-motion reset, and its phase surviving a rotation), both locales and the frame budget.
- **Streaming render** — thinking disclosures (`AgentActivity`), tool disclosures (`ToolResult`), unified-diff surfaces (`FileDiff`), syntax-highlighted code (`CodeBlock`), markdown responses, token/cost footers, optimistic user echo, queued-steer notices, retry/compaction notices.
- **Image attachments** — file picker, drag & drop, and clipboard paste; previews in the composer and in the sent bubble; delivered to the model as base64 `ImageContent` (front-end read → IPC → pi `prompt({ images })`).
- **Local file references** — `@` mention picker over an indexed workspace tree (skips `node_modules`, `.git`, …); referenced files are read in the main process and inlined as `<file path>` blocks; chips render in the composer and restored history.
- **Files sidebar** — native beUI file tree with lazy directory reads, React Symbols file-type icons and a shared-background text preview. Every file owns a top-level sidebar tab named after the file, with its own tree toggle and preview mode, source search, copy and external-open actions. Markdown has source/preview/diff views; code and Markdown source use Shiki, with all uncached source highlighting in a worker and windowed source rows. Underline controls switch views. One shared routing table (`shared/preview.ts`) decides what a path is, so each previewable family gets its own reader and body: Markdown and tables render (CSV/TSV and XLSX spreadsheets), as do patch files (per-file diff sections), Jupyter notebooks (cells plus their outputs), subtitle cues (SRT/VTT) and fonts (a specimen rendered in the loaded face). Media and PDFs take the pane whole — images with zoom/pan, video and audio played by Chromium over a seekable custom scheme, and PDFs through pdf.js reading byte ranges on demand. Deep paths load concurrently and reveal immediately; bounded source/directory/token caches keep tab switches quick while source reads revalidate on each visit. Git views compare HEAD to the working file (including staged and unstaged changes); plain directories have no diff tab. Conversation file links and attachment chips open the sidebar, resolve relative paths and support line anchors. File/view/scroll state survives panel switching, collapse and session navigation. Text reads are capped at 512 KiB with an explicit truncation notice (a notebook gets a larger cap, since its outputs are inline); binary files show a text-only notice.
- **Message navigation rail** — one tick per user turn; the hover preview pairs the user message with that turn's final reply. Ticks and previews are built from message data (not DOM scraping) via `railItems` + `data-rail-id`.
- **Context details** — clicking the composer's context ring opens a right-rail statistics tab: session name, provider/model/thinking, context window and live usage, cumulative input/output/reasoning/cache tokens and cost as exact numbers, message/tool-call counts and creation/last-activity times, plus a per-role context breakdown bar whose four segments add up to the ring's own total (the residue is the system prompt, tool schemas and estimation error, labelled as such). Two notes keep it honest: the cumulative values cover the whole session file, branches left by resends and retries included, and the breakdown is an estimate. The readout re-reads on open, on session switch, at every turn boundary and on each 2s ring update, so it never shows a snapshot of a session that has moved on; a failed refresh keeps the last good numbers under an inline notice.
- **Rewind** — one checkpoint before each user turn, with file-only, conversation-only or combined restore and persistent Undo/Redo of the latest operation. Previews share Review's file headers, diff rows and collapse/expand controls; only nearby file bodies load, and long diffs render a bounded row window. Replacing current changes requires an explicit warning confirmation, preserves a verified backup first, and never bypasses stale-preview or recovery checks. Raw files and the Git index are backed up independently without moving HEAD. Settings → General controls automatic capture. See [correctness boundaries, retention and verification](docs/rewind-implementation.md).
- **Resend / retry / fork** — copy & resend under every user message, retry & fork under every assistant turn (including stopped/errored runs, plus the error banner). Resend/retry rewind the session through the SDK's `navigateTree` (the abandoned branch stays in the session file's tree) and re-prompt with the original text and images; fork writes a branched copy up to that message via `createBranchedSession` on a separate SDK manager, preserving the original session's file and branch, then opens it and titles it "Fork of …".
- **Settings page** — vertical-tab shell with four sections: General (storage paths, version, project link, the shell-task and auto-close timeouts, and the provider **response timeout** — an unanswered model request fails as a timeout and is retried, applied to sessions in memory so the app never rewrites pi's global settings file), Prompt (global append system prompt `~/.pi/agent/APPEND_SYSTEM.md`, plus a toggle for AGENTS.md/CLAUDE.md context files), Appearance (theme, accent, language) and Providers (sign in / out). Adding a section is one entry in the `SECTIONS` registry.
- **Themes & i18n** — a header button cycles light/dark/system (beUI View-Transition reveal) plus 7 accent presets (indigo, blue, violet, emerald, amber, rose, cyan); the interface ships in English and 简体中文 and switches immediately. Both persist to localStorage.

## Develop

```bash
npm install          # deps + electron binary (postinstall)
npm run dev          # electron-vite dev (HMR)
npm run typecheck    # tsc for main + renderer
npm run build        # production build to out/
node scripts/check-icons.mjs # icon coverage, SVG props, animation, themes and brand assets
node scripts/check-corners.mjs # native corner geometry, animations, themes and focus
node scripts/check-file-browser.mjs # real file/Git IO, Workspace links, views, large files, themes and packaged highlighting
node scripts/check-window-chrome.mjs # isolated native window, themes, layouts and control hit targets (after build)
node scripts/check-sidebar-list.mjs # session list: flush bottom edge and the 12px fade at the edge that cuts a row (after build)
node scripts/check-select-panel-padding.mjs # dropdown panels: symmetric inner padding, nothing clipped (Select/Combobox/MultiSelect)
node scripts/check-session-search.mjs # search correctness + 1,000-session benchmark (after build)
node scripts/check-session-persistence.mjs # session header + fork/delete/continue regression checks
node scripts/check-bash-tasks.mjs # real processes + SDK steering/queue/cleanup regressions
node scripts/check-session-lifecycle.mjs # responsive navigation, extension ownership, shutdown and native quit
node scripts/check-extension-startup.mjs # FFF startup adapter; PI_FFF_EXTENSION_PATH adds real native search/reload
node scripts/check-bash-task-ui.mjs # isolated Electron task rows, output, stop and settings
node scripts/check-plan-mode.mjs # Plan protocol, tool boundaries, approval faults and real SDK lifecycle
node scripts/check-plan-mode-ui.mjs # Plan beUI cards and production preload/IPC in isolated Electron (after build)
node scripts/check-todos.mjs # real SDK todo state, restoration, reminders and renderer reconciliation
node scripts/check-rewind.mjs # raw files/index, failure injection, crashes, recovery and GC
node scripts/check-rewind-sdk.mjs # real SDK turn anchors, conversation transactions and cold recovery
node scripts/check-rewind-ui.mjs # one-row controls, totals, warnings, focus and large diff frame checks
node scripts/check-rewind-preview-cache.mjs # prioritized requests, exact stats and bounded preview cache
node scripts/check-rewind-performance.mjs # isolated 10,000-file corpus; PI_REWIND_PERF_FILES overrides size
node scripts/check-spinner-verbs.mjs # waiting-row sentences: pools, targeting, wall-clock rotation, locales, geometry
node scripts/check-context-detail.mjs # context detail: buckets, reasoning, stats identical to the SDK, real session files
node scripts/check-context-detail-ui.mjs # context pane in isolated Electron: precision grid, breakdown bar, live following, locales
npm run preview      # run the built app
```

## Layout

```
src/
  shared/types.ts        # IPC DTOs shared by both processes
  main/                  # Electron main = Pi SDK host
    index.ts             # window + lifecycle
    ipc.ts               # ipcMain handlers
    settings.ts          # app settings (active cwd + known folders)
    pi/manager.ts        # createAgentSession, ModelRuntime, auth bridge, snapshots
    pi/files.ts          # workspace file index, @mention search, attachment reads
  preload/index.ts       # contextBridge API (window.pi)
  renderer/
    index.html
    src/
      App.tsx            # boot: settings → init → Welcome/Workspace; accent + i18n providers
      i18n/              # locale context + dictionaries (en is source of truth, zh-CN)
      state/pi-store.ts  # event-driven conversation store (useSyncExternalStore)
      lib/               # markdown, unified-diff, user-message, format, hooks
      components/
        agents/          # beUI agent components
        motion/          # beUI motion components
        previews/        # beUI registry previews (not shipped)
        app/             # Workspace, ChatView, Composer, FileMention, MessageItems,
                          # ToolCallView, ModelPicker, ThemeButton, AuthBridge,
                          # Welcome, ConfirmDialog, ProviderIcon
        app/settings/    # SettingsPage shell + General/Prompt/Appearance/Providers sections
```

## Notes

- Terminal colors are defined alongside beUI tokens in `styles.css`. The 16 ANSI colors adapt to light/dark mode; the standard 256-color cube and application-supplied RGB colors keep their semantics. Bold changes weight rather than silently selecting another ANSI color. The default text and cursor exceed 7:1 contrast, chromatic ANSI text and selection text meet 4.5:1, and selection fills contrast with the terminal background by at least 3:1. Black/white ANSI slots remain literal for TUI backgrounds; xterm’s 4.5:1 text adjustment handles low-contrast combinations.
- Applications that choose their own RGB colors need a matching theme. In Claude Code, select **Auto** in `/theme` (or choose the appropriate light/dark ANSI preset to use the terminal palette). Pith reports background changes, but does not rewrite application output or modify `~/.claude` preferences. See [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config#match-the-color-theme). Run `TERMINAL_CLAUDE_BIN=/path/to/claude node scripts/check-terminal.mjs` to include the real Claude Auto-theme check with temporary configuration, a dummy key, a loopback API endpoint and no submitted prompts.

- Auth uses the local pi installation's credentials (`~/.pi/agent/auth.json`, env vars, `models.json` custom providers) — configure once, shared with the `pi` CLI.
- The app can start without choosing a project. The global New chat action uses a stable internal workspace (`<userData>/workspace`); its path stays hidden in sidebar, header and search. Open folder adds an explicit project, and each project’s + creates a session in that project. File indexing, sessions and bash still use the session’s actual cwd.
- beUI components under `components/motion|agents/` are vendored. A few carry deliberate, clearly-marked `// local patch (pi-app)` edits (theme reveal helper, sidebar drag image, app-driven nav rail, fenced-code framing); everything else is untouched registry code.

## Pith branding & packaging

The app is named **Pith**, positioned as the **pi-agent desktop client** (设置 → 通用 → 关于: “pi-agent 桌面端”). The SDK, CLI and `~/.pi` paths retain their upstream names. Existing app settings and browser preferences keep using the `pi-app` user-data directory and storage keys, so the rename preserves local state.

The icon master is `resources/pith.svg`: a charcoal P around an amber core on a light gray rounded tile, with transparent margins (832px artwork on a 1024px canvas to match neighboring Dock icons). It is shared by the welcome screen and empty conversation; About uses text only. No fonts are needed to reproduce it.

```bash
npm run icons        # regenerate all assets from the SVG, on any platform
npm run pack         # unpacked app for the current OS, in dist/
npm run dist:mac     # Pith.app → DMG + ZIP
npm run dist:win     # Pith.exe → NSIS installer
npm run dist:linux   # AppImage + deb
```

`electron-builder.yml` sets the product name, application ID, installed shortcuts and native icons: multi-resolution `.icns` (macOS, including Retina), `.ico` (Windows, 16–256px), and PNGs (Linux, 16–1024px). Generated assets are checked in, so normal development/builds need no icon tooling. Electron uses the same artwork for development windows and the macOS Dock; packaged executables use the native resources. Build release artifacts on their target OS; signing/notarization credentials must be supplied by the distributor.

## Managed bash tool contract

```ts
bash({ command: "npm run build", mode: "blocking", waitMs: 1000, timeout: 600 })
bash({ command: "npm run dev", mode: "background" })
bash_task({ action: "list" })
bash_task({ action: "status", taskId: "…" })
bash_task({ action: "output", taskId: "…", cursor: 1234 })
bash_task({ action: "stop", taskId: "…" })
```

`mode` defaults to `blocking`. `waitMs` is an optional initial wait in milliseconds, capped by the app setting; reaching it returns a task ID without restarting the process. `timeout` is an optional total runtime in seconds and terminates the entire process tree, including after the call has returned. A running task is not a successful result. Commands have no interactive stdin: use the interactive terminal for interactive applications. Do not use `&`, `nohup`, `disown`, `setsid` or self-daemonization to bypass task ownership.

Completion notifications carry status and recent output automatically. Continue independent work while a task runs; if only its result remains, report that it is pending and end the response. Completion wakes the session to finish the request. Use `bash_task status/output` for a specific progress or readiness decision. Do not start a separate `sleep`, delayed `tail`, or polling command to wait for a managed task: that wait can become another background task with its own redundant notification. Run real work directly with `mode: "background"` when immediate return is wanted.

Task metadata and logs live under `<userData>/bash-tasks`. Each task keeps a 64 Ki-character output tail and the first 8 MiB of raw output on disk; truncation and output cursor gaps are reported explicitly. At most 16 commands run at once. The latest 200 completed records are retained, with pending notifications protected until delivery. Completion messages are typed tool output (`bash_task_completion`), separate from user drafts and their attachment queue; session search includes their output only with the tool/details scope enabled. The app does not resume processes or automatically replay pending notifications after a restart.

Task notifications stay inside the current process fold; user steering opens a new fold. Changed files accumulate across all these groups and appear once, only when the model settles. A running server does not hold the list open. Its completion or the user's per-task Stop action wakes the model, hides the previous list before the notice arrives, and restores the combined changes after the continuation settles—even when that continuation changes no files. Model-requested task stops and the session-wide Stop/Esc remain quiet. Hidden session entries preserve cumulative change ownership across reloads without adding model context; the Review pane uses the same ownership as the transcript.
