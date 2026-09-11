# AGENTS.md — pi-app

Desktop coding-agent app: the **Pi SDK** kernel (`@earendil-works/pi-coding-agent`) runs in the Electron main process; the renderer is a fully **beUI**-built interface. Electron (not Tauri) was chosen because the Pi SDK is a Node-only library.

## Golden rule: UI must be beUI-native

**Every UI component comes from beUI.** Do not hand-roll UI primitives (buttons, selects, modals, popovers, disclosures…) and do not introduce other component libraries (shadcn/ui, radix, headlessui, antd…).

- beUI components live in `src/renderer/src/components/motion/` and `src/renderer/src/components/agents/` (plus their `lib/` helpers). Treat them as vendored: don't rewrite them, and don't "fix" registry code in place.
- Vendored files MAY carry deliberate local patches when the registry component cannot express what the app needs. Mark every such edit with a `// local patch (pi-app):` comment explaining why, keep it minimal, and put app-level wrappers in `components/app/` when the vendored component stays untouched (e.g. [ThemeButton.tsx](src/renderer/src/components/app/ThemeButton.tsx) wraps the vendored `ThemeToggle`).
- To add a component: fetch it from the beUI MCP server (`get_component`) or the registry `https://beui.dev/r/{slug}` (JSON `files[]` → write each file to `src/renderer/src/<path>`, install its listed npm deps). Skip `type: "preview"` files (they land under `components/previews/` and are never imported by the app).
- App glue components live in `src/renderer/src/components/app/` and must be **compositions of beUI primitives** plus Tailwind classes using the theme tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`, …) defined in `src/renderer/src/styles.css`.
- Only allowed exception: `react-markdown` + `remark-gfm` in `lib/markdown.tsx` (a renderer, not a UI kit). Code fences still render through beUI's `CodeBlock`; all other markdown elements are styled via the components map with beUI tokens.

## Golden rule: every user-facing string goes through i18n

The UI ships in **English and 简体中文**; switching lives in Settings → Appearance and applies immediately. When adding or changing ANY user-visible renderer text (labels, placeholders, aria-labels, tooltips, empty/loading/error states):

1. Add the key to **both** `src/renderer/src/i18n/locales/en.ts` (source of truth) and `locales/zh-CN.ts` — the `Messages` type makes a missing/extra key a typecheck error. Keys are flat `domain.key` strings; use `{name}` placeholders for interpolation via `t(key, params)`.
2. Read strings with `const { t } = useI18n()` — never hard-code prose in JSX or template literals, including `aria-label`/`title` attributes.
3. Language names render via `LOCALE_NAMES` in their own language (never translated); add new locales by extending `Locale`, the `dictionaries` map and `LOCALE_NAMES` in `src/renderer/src/i18n/index.tsx`.
4. Known boundary: strings INSIDE vendored beUI components (e.g. ToolResult's "Completed", CodeBlock's "Ready") stay English — do not edit vendored files to translate them; pass app-level labels (`summary`, `activeLabel`, `title`, …) through `t()` instead.
5. The main process sends only data over IPC (no prose); compose any user-visible message from the rendered text in the renderer.

## Golden rule: scrollbars are invisible

**No scroll container ever shows scrollbar chrome.** Scrolling still works; the bar itself is hidden everywhere in the app. This is implemented once, app-wide, in `src/renderer/src/styles.css` (`scrollbar-width: none` on `*` plus `*::-webkit-scrollbar { display: none }`) — its single source of truth.

- Never style or re-enable scrollbars per element (no `::-webkit-scrollbar` rules, no width/thumb/track styling) and never edit a vendored beUI file to hide one. The `scrollbar-hide` utility stays only because vendored components still reference it; app code does not need it.
- Because the bar takes no layout space, a scroll container that holds focusable inputs needs its own padding (e.g. `p-1`) so focus rings are not clipped by the box edge.

## Commands

```bash
npm run dev          # electron-vite dev (HMR)
npm run typecheck    # tsc for main+preload AND renderer (always run before done)
npm run build        # production build to out/
npm run preview      # run the built app
```

No test framework. Verification is manual/CDP (see Gotchas). Always `npm run typecheck && npm run build` after changes.

## Architecture boundaries

```
src/shared/types.ts    IPC DTOs — the ONLY shared surface between processes
src/main/              Electron main = Pi SDK host (Node)
  pi/manager.ts        createAgentSession, ModelRuntime, auth bridge, snapshots,
                       SessionManager (list/open/delete → OS trash), folder list
  pi/files.ts          workspace file index (@mention search, attachment reads)
  ipc.ts               ipcMain handlers; settings.ts
  settings.ts          app-settings.json — { cwd, folders }
src/preload/index.ts   contextBridge → window.pi (the only renderer↔main channel)
src/renderer/src/
  App.tsx              boot: appInfo → init → Welcome/Workspace; wraps I18nProvider,
                       owns accent + theme (next-themes) state
  i18n/                locale context + LOCALE_NAMES; locales/{en,zh-CN}.ts
  state/pi-store.ts    event-driven store fed by 'pi:event' (useSyncExternalStore)
  lib/                 markdown, unified-diff parser, user-message parsing, format, hooks
  components/agents|motion/  beUI (vendored — only clearly-marked local patches)
  components/previews/       beUI registry previews (not shipped)
  components/app/      Workspace, ChatView, Composer, FileMention, MessageItems,
                       ToolCallView, ModelPicker, ThemeButton, AuthBridge, Welcome,
                       ConfirmDialog, ProviderIcon
  components/app/settings/   SettingsPage shell (SECTIONS registry) + sections
```

Hard rules:

- Renderer **never** imports `electron` or pi packages; it talks only through `window.pi` (typed by `src/renderer/src/env.d.ts` referencing preload).
- New IPC surface = add DTO to `shared/types.ts` + handler in `main/ipc.ts` + method in `preload/index.ts`.
- Pi events flow: `PiManager` emits `pi:event` (serialized via JSON round-trip) → `PiStore.dispatch` → React. Render from `store.messages`; `store.streaming` is the live overlay. High-frequency deltas (`message_update`, `tool_execution_update`) are coalesced in `PiManager.emitEvent` (latest wins, ~33ms flush; ordered events flush first) — keep new hot-path events on that list.
- **`agent_settled` — not `agent_end` — means the run is over.** `agent_end` fires before post-run continuations (auto-retry, auto-compaction, queued messages), so clearing streaming/busy state or the sidebar spinner there lies while work continues. Only `agent_settled` (and `pi_error`) ends a run.
- **Session-wide numbers come from the SDK, never from summing `session.messages`.** `AgentSession.getSessionStats()` aggregates every session entry (messages compacted out of context and tool-result usage included) → `sessionCost`/`cacheHitRate`; `getContextUsage()` is only the live context ring.
- **`ChatMessage` mirrors the SDK's full agent-message union** (user/assistant/toolResult plus `compactionSummary`/`branchSummary`/`bashExecution`/`custom`) — a session is written by the app, the pi CLI and extensions, so every role must have a transcript row instead of being dropped.
- **Thinking levels are model-derived**: use `AgentSession.getAvailableThinkingLevels()` (it gates `xhigh`/`max` on `thinkingLevelMap` and returns `['off']` for non-reasoning models). Never hardcode a level list.
- **Bridge SDK callbacks whole**: auth prompts/notifies (`AuthPrompt.signal`, device-code `verificationUri`, `instructions`) and `compaction_end` payloads carry data the UI needs; forward them rather than re-deriving or dropping them.
- User messages sent through the composer are mirrored optimistically (`__optimistic` flag) and replaced on the real `message_end`.
- Settings are shared through `AppSettings` (`{ cwd, folders }`): the active `cwd` is what the file index / sessions / bash run in; `folders` is the sidebar's known list. Deleting a project moves its sessions to the OS trash and forgets the folder ([deleteFolderSessions](src/main/pi/manager.ts:231)).
- Settings UI is a registry: add a section by appending one entry to `SECTIONS` in [SettingsPage.tsx](src/renderer/src/components/app/settings/SettingsPage.tsx) (label/description come from i18n keys) — the shell never changes.

## Local patches to vendored beUI

These are the only intentional edits inside `components/motion|agents/`; keep them marked with `// local patch (pi-app):` and re-apply after a registry re-fetch:

- [theme-toggle.tsx](src/renderer/src/components/motion/theme-toggle.tsx) — exports `useThemeReveal()` so the app header can cycle light→dark→system with the same View-Transition reveal the vendored `ThemeToggle` uses.
- [ai-sidebar.tsx](src/renderer/src/components/agents/ai-sidebar.tsx) — `allowNesting` prop (app groups sessions by folder, never nests) + a themed native drag image (Chromium snapshots the motion row as an opaque white square).
- [message-scroller.tsx](src/renderer/src/components/agents/message-scroller.tsx) — `railItems` prop so the nav rail is driven by app data and located via `[data-rail-id]` instead of DOM text; follow-scrolling uses instant (`auto`) scrolls while `busy` (restarting a smooth scroll per growing frame janks streaming output); the layout effect sets `positionedScrollKey` synchronously instead of only inside its rAF, which otherwise left the whole transcript `invisible` when that frame got cancelled; a programmatic scroll keeps the `following` state untouched until it settles at the bottom (the old 0ms release let a growing stream's scroll event read as a user scroll, switching follow off for good).
- [code-block.tsx](src/renderer/src/components/agents/code-block.tsx) / [message-bubble.tsx](src/renderer/src/components/agents/message-bubble.tsx) / [streaming-response.tsx](src/renderer/src/components/agents/streaming-response.tsx) — a `data-code-block-pre` marker plus `[&_pre:not([data-code-block-pre])]` selectors so raw-markdown `<pre>` framing doesn't double-box beUI's own `CodeBlock`.
- [streaming-response.tsx](src/renderer/src/components/agents/streaming-response.tsx) — `meta` slot (the turn timestamp) plus an `actions` slot (retry/fork) rendered as extra cells of the completion-actions row, before the timestamp so it stays rightmost.
- [message.tsx](src/renderer/src/components/agents/message.tsx) — the default `animate` target always includes the resting transform, so a row that mounts with `animateIn` and then flips to not-animated can't be left frozen at `scale(0)` (in layout but invisible).
- [tool-result.tsx](src/renderer/src/components/agents/tool-result.tsx) / [file-diff.tsx](src/renderer/src/components/agents/file-diff.tsx) — tool-row titles use the UI font and the muted chrome color (FileDiff's file label was `font-mono text-foreground/80`), so every tool row reads alike and stays distinct from its own output text.
- [agent-code.tsx](src/renderer/src/components/agents/agent-code.tsx) / [code-block.tsx](src/renderer/src/components/agents/code-block.tsx) — `useAgentCodeTokens(code, language, enabled)` skips shiki while `status === 'streaming'` (highlighting a growing block per delta was quadratic CPU) and `tokenCache` is bounded (`TOKEN_CACHE_MAX`); the block highlights once on completion.
- [prompt-input.tsx](src/renderer/src/components/agents/prompt-input.tsx) — `contextIndicator` prop mounts the app's `ContextRing` immediately left of the send button (the controls row's bottom-right cluster).

## Pi SDK facts (learned from the installed package, 0.85.x)

- Read types from `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts`; `pi-ai`/`pi-agent-core` are **nested** under it (`.../pi-coding-agent/node_modules/@earendil-works/`).
- `ImageContent` is `{ type: "image", data: base64, mimeType }` — the online SDK docs show an older `source`-based shape; trust the installed `.d.ts`.
- Assistant messages have no id — key rows by `role+timestamp+index`.
- Tools used: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. `edit`/`write` return unified diffs in `details.diff` (parsed in `lib/diff.ts` → beUI `FileDiff` lines).
- Credentials are shared with the `pi` CLI via `~/.pi/agent/auth.json`.
- **Resend/retry = `navigateTree(userEntryId)` + re-`prompt`** (same file; the abandoned branch stays in the session tree). Targeting a user message drops it and everything after, and returns its text as `editorText`. It THROWS while streaming, and **emits no AgentSession event** — `PiManager.resendMessage` bumps `managed.eventSequence` by hand so the returned snapshot isn't mistaken for one the renderer already has. When the user message is already the leaf (a run that died before any assistant output) `navigateTree` no-ops — rewind via `sessionManager.branch(parentId)` / `resetLeaf()` + `agent.state.messages = buildSessionContext().messages` like it does internally.
- **Fork at a message = `sessionManager.createBranchedSession(entryId)`** (read-only on the live manager; writes a new file ending at that entry, `parentSession` pointing back). Renderer messages are correlated to entries by `role+timestamp` over `buildContextEntries()` (`findMessageEntry`).

## Gotchas

- **Dependency versions are pinned by peer conflicts**: electron-vite 5 supports only vite ^5–7 (NOT vite 8); `@vitejs/plugin-react` must be ^5.2 for vite 7. Don't blindly upgrade.
- **Main entry must build to `out/main/index.mjs`**: electron-vite's lib-mode default emits `.js`. The explicit `rollupOptions.input` + `output: { format: 'es', entryFileNames: '[name].mjs' }` in `electron.vite.config.ts` is load-bearing — keep it.
- If `npm run preview` says "Electron uninstall", run `node node_modules/electron/install.js` (postinstall can be skipped).
- Running `electron out/main/index.mjs` directly uses `~/Library/Application Support/Electron` as userData instead of `pi-app` — prefer `npm run preview`. Settings live at `<userData>/app-settings.json` (`{ cwd, folders }`).
- E2E/smoke testing without screen access: launch with `--remote-debugging-port=9222`, then a small Node script over the CDP WebSocket (`Runtime.evaluate`, `Page.captureScreenshot`) — real model calls cost fractions of a cent on locally configured providers.
- beUI components rely on `@/` → `src/renderer/src` alias and on `dark:` = `.dark` class (next-themes); accents are `[data-accent=…]` presets in `styles.css`.
- Vendored beUI edits must stay marked `// local patch (pi-app)` and minimal (see above) — they are the one exception to "treat beUI as vendored".
- All process code is ESM (`"type": "module"`); preload requires `sandbox: false` in the BrowserWindow.

## Before touching sensitive areas

- Read `README.md` for the feature overview.
- Composer behavior (attachments, @mentions) spans `Composer.tsx` + `FileMention.tsx` + `main/pi/files.ts` + `PiManager.readFileBlocks` — change together.
- Message navigation rail spans [ChatView.tsx](src/renderer/src/components/app/ChatView.tsx) (builds `railItems` from turns) + [MessageItems.tsx](src/renderer/src/components/app/MessageItems.tsx) (`data-rail-id`) + the vendored `MessageScroller` `railItems` patch — change together.
- Theme tokens: `styles.css` is the single source (light/dark/accent); check both modes after edits.
