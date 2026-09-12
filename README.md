# Pith

The desktop client for **pi-agent**: the **Pi SDK** kernel ([@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)) running in Electron's main process, with a fully **beUI**-built interface in the renderer.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 44 (ESM main/preload, contextIsolation, no nodeIntegration) |
| Kernel | `@earendil-works/pi-coding-agent` 0.85 — `createAgentSession` + `ModelRuntime` (pi-ai) |
| UI | beUI components (chat-app bundle: message, message-scroller, prompt-input, tool-result, file-diff, code-block, agent-activity, ai-sidebar, animated-sidebar, morphing-modal, theme-toggle, combobox, …) |
| Markdown | `react-markdown` + `remark-gfm` (tables, nested lists, task lists) — code fences render through beUI's `CodeBlock`, all other elements styled with beUI theme tokens |
| Renderer build | Vite 7 + React 19 + Tailwind CSS 4 |
| Theming | next-themes (light/dark/system) + 7 accent presets via CSS variables |

## Features

- **Complete agent loop** — prompt → streaming text/thinking → tool calls (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) → results → next turn, with abort and steering support. Sessions persist through pi's `SessionManager` (JSONL under `~/.pi/agent/sessions`).
- **Multi-folder session sidebar** — sessions grouped by working directory; new chat, open folder, paginated "show more", and delete session / delete whole project (moved to the OS trash, with a confirm dialog). Opened folders are remembered across launches (`<userData>/app-settings.json`).
- **Providers & models** — provider discovery, availability from real auth status, per-session model switching, thinking-level control (`off`→`max`), API-key and OAuth (browser/device-code) login bridged into the UI (keys land in `~/.pi/agent/auth.json`).
- **Streaming render** — thinking disclosures (`AgentActivity`), tool disclosures (`ToolResult`), unified-diff surfaces (`FileDiff`), syntax-highlighted code (`CodeBlock`), markdown responses, token/cost footers, optimistic user echo, queued-steer notices, retry/compaction notices.
- **Image attachments** — file picker, drag & drop, and clipboard paste; previews in the composer and in the sent bubble; delivered to the model as base64 `ImageContent` (front-end read → IPC → pi `prompt({ images })`).
- **Local file references** — `@` mention picker over an indexed workspace tree (skips `node_modules`, `.git`, …); referenced files are read in the main process and inlined as `<file path>` blocks; chips render in the composer and restored history.
- **Message navigation rail** — one tick per user turn; the hover preview pairs the user message with that turn's final reply. Ticks and previews are built from message data (not DOM scraping) via `railItems` + `data-rail-id`.
- **Resend / retry / fork** — copy & resend under every user message, retry & fork under every assistant turn (including stopped/errored runs, plus the error banner). Resend/retry rewind the session through the SDK's `navigateTree` (the abandoned branch stays in the session file's tree) and re-prompt with the original text and images; fork writes a branched copy up to that message via `createBranchedSession`, opens it and titles it "Fork of …".
- **Settings page** — vertical-tab shell with four sections: General (storage paths, version, project link), Prompt (global append system prompt `~/.pi/agent/APPEND_SYSTEM.md`, plus a toggle for AGENTS.md/CLAUDE.md context files), Appearance (theme, accent, language) and Providers (sign in / out). Adding a section is one entry in the `SECTIONS` registry.
- **Themes & i18n** — a header button cycles light/dark/system (beUI View-Transition reveal) plus 7 accent presets (indigo, blue, violet, emerald, amber, rose, cyan); the interface ships in English and 简体中文 and switches immediately. Both persist to localStorage.

## Develop

```bash
npm install          # deps + electron binary (postinstall)
npm run dev          # electron-vite dev (HMR)
npm run typecheck    # tsc for main + renderer
npm run build        # production build to out/
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

- Auth uses the local pi installation's credentials (`~/.pi/agent/auth.json`, env vars, `models.json` custom providers) — configure once, shared with the `pi` CLI.
- The first launch asks for a working directory; everything (file index, sessions, bash cwd) is scoped to it and it can be changed from the sidebar at any time.
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
