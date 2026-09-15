# beUI refresh + DSH sandbox — handoff

Work-in-progress handoff for `experiment/beui-refresh`. Written at the end of the
first session; every claim below was run, not assumed. Read this together with
`AGENTS.md` (which this branch has **not** fully caught up with — see "Docs debt").

## 1. Where things stand

- Branch: `experiment/beui-refresh`, working tree clean.
- Base/rollback: `0d9f6b8` ("WIP: snapshot before beUI refresh").
  - tag `backup/pre-beui-20260916-0631`
  - branch `backup/native-subagents-wip-20260916-0631`
  - off-repo copies in `~/githubs/pi-app-backups/` (`*.bundle` verified complete,
    `*-src.tar.gz` source snapshot). No git remote exists — the bundle **is** the
    off-machine-capable history.
- `feature/native-subagents` still points at `0d9f6b8`.

Commits, oldest first:

| Commit | What it does | Verified by |
|---|---|---|
| `f3ebf9a` | Lucide icon layer + first refresh wave (number / animated-badge / toast) | typecheck, build, check-icons, check-written-file-preview, check-file-browser, check-terminal, check-corners, check-bash-task-ui |
| `8bf2ab4` | DSH file sandbox port + ⌘K command palette | typecheck, build, check-sandbox, check-command-palette, check-bash-tasks |
| `8b0482e` | Context menu on file-tree rows | typecheck, build, check-file-browser |
| `dfba2d7` | Per-session sandbox mode + composer switcher | typecheck, build, check-sandbox, check-file-browser |
| `95f60e6` | Manual compaction from the palette (the app's `/compact`) | typecheck, build, check-command-palette, check-sandbox |
| `c298814` | Compaction acknowledged in the transcript | typecheck, build, check-bash-task-ui, check-sandbox |
| `c2973bf` | One-shot escalation + beUI approval card | typecheck, build, check-sandbox, check-file-browser |
| `f7ccb51` | Context menu on right-rail tabs | typecheck, build, check-file-browser |

## 2. How to verify anything here

```bash
npm run typecheck && npm run build        # always, both projects
node scripts/check-sandbox.mjs            # real Seatbelt; no Electron, fast
node scripts/check-command-palette.mjs    # ⌘K, locale-pinned fixture
node scripts/check-file-browser.mjs       # full Workspace: tree/tabs/escalation
node scripts/check-bash-task-ui.mjs       # task panels, turn notices, compaction row
node scripts/check-bash-tasks.mjs         # managed bash + SDK steering (main side)
node scripts/check-icons.mjs              # icon layer (run after build)
```

The other 35-odd `scripts/check-*.mjs` are the repo's existing suite; the ones
above are the set this work touches. Checks that mount the real `Workspace` must
mount the same providers `App.tsx` does (`I18nProvider`, `ThemeProvider`,
`ImagePreviewProvider`, `ToastProvider`) — two fixtures already had to be taught
`ToastProvider`.

## 3. What landed (behaviour, not file lists)

**Icons (owner decision "B").** Lucide is the pack again. `lib/icons.tsx` is
generated from `lucide-react` keeping all 131 export names; ten of them
deliberately differ from Lucide's current spelling and are listed in AGENTS.md.
`lib/animated-icons.tsx` extracts its geometry from Lucide and renders each node
by tag (the completion mark is a circle plus a path). `@hugeicons/*` is gone;
`check-icons.mjs` now guards against *that* pack instead. `scripts/beui-add.mjs`
is the additive registry installer (it never overwrites a file carrying a
`local patch (pi-app)` marker).

**DSH sandbox** (`src/main/sandbox/`). Three modes; canonical workspace; writable
roots = workspace + `/tmp` + `os.tmpdir()`; symlink-safe resolution over the
deepest existing ancestor; runner chain in DSH order (seatbelt → bubblewrap →
Landlock → Windows ACL → `dependencies-missing`). The optional native helpers are
resolved through a **computed specifier** so no other platform's bundle tries to
statically resolve them. Bash is confined *before* a task record exists, so a
confined mode with no usable runner can never become a "running" task that ran on
the host. `edit`/`write` are app-owned tools over the SDK's
`EditOperations`/`WriteOperations`, checked per side effect.

**Mode is per session.** It is a custom branch entry (`pith_sandbox_mode`), folded
with newest-wins; `AppSettings.sandboxMode` is only the default a new chat starts
from. Tools read the live value, so a switch applies from the next tool call —
including on a steered turn already running.

**Escalation.** `sandbox_permissions` + `justification` on `bash`/`edit`/`write`;
a pending queue in main; published as a **sequence-free** `pi:event` metadata ping
(the `context_usage` rule); answered from beUI's `ToolApproval` above the
composer, offering only a one-shot "Allow once" — deliberately no standing grant.

**Compaction.** The palette gained a manual compact (`AgentSession.compact()`),
refused while a turn is live (the SDK's manual path aborts the run and never
retries it). A settled compaction leaves a quiet UI-only notice row with the token
change — **not** a custom message, because injecting one would put the notice into
model context, which is what compaction just paid to shrink.

## 4. Remaining work, in order

### 4a. Context menus on transcript messages and the terminal

Follow the shape already proven twice (file tree, rail tabs): **one
`ContextMenu` per surface**, resolving the target from the DOM, never one trigger
per row.

- **Transcript rows**: actions already exist on the hover row —
  `components/app/MessageActions.tsx` exports `MessageActions`, `MessageAction`
  (icon button) and `CopyAction` (copy + transient check). The rows are
  `UserItem` / `AssistantGroup` in `components/app/MessageItems.tsx`; retry/fork
  arrive as `onResend` / `onFork` / `retryFrom` / `forkAt` props. **Read the
  turn-folding rules in AGENTS.md before editing** — a settled turn folds its
  process blocks behind `AgentActivity`, and the changed-files list plus the
  retry/fork row are rendered *outside* that fold. Attach `onContextMenu` to the
  row wrapper the app already owns; do not restructure the folding.
- **Terminal**: `components/app/TerminalPane.tsx` owns the xterm host div
  (`data-terminal-surface`), so no vendored patch is needed. Copy / paste / clear
  are the useful items; paste must go through the existing `terminal:*` IPC, never
  Pi events or React state.

### 4b. Wave 3 (visual)

- `shader-background` on `Welcome.tsx` and the new-chat landing block. New npm
  dependency (`@paper-design/shaders-react`) — check the reduced-motion freeze
  behaviour, the app already honours reduced motion everywhere.
- `expandable-control` for quiet chips (attachments, tool categories).
- `adaptive-stepper` for `bashMaxWaitMs` / `subagentMaxConcurrent` (Settings →
  General currently uses a raw `Input type=number`).
- `multi-select` for the provider model discovery list (today: a Checkbox list).
- Replace the 371-line hand-rolled heatmap in
  `components/app/settings/usage/TokenActivityPanel.tsx` with beUI's
  `heat-calendar`. Keep the bilingual tooltips, the daily/weekly switch and the
  existing `usage-view` data pipeline; `UsageTrendsPanel` has no beUI equivalent
  and stays.

### 4c. Wave 4

`combobox` for long model lists (ModelPicker / provider lists).

## 5. Invariants a new session must not re-break

- **Shell slice equality.** `PiStore.set()` rebuilds the shell slice by shallow-
  comparing `shellOf()`'s output. It used to compare a **hand-maintained field
  list**, so a new shell field could silently stop reaching the UI — the
  escalation card existed in state and never rendered. Add fields to
  `PiState`/`PiShellState`/`shellOf` and the comparison takes care of itself.
- **"The menu" is the portal that is not hidden.** The vendored `ContextMenu`
  keeps every portal in the document (`aria-hidden` + `inert` +
  `pointer-events: none` while closed). With two menus mounted, a bare
  `querySelector('[data-context-menu-portal]')` returns whichever renders first.
  Reads, clicks and the Escape dispatch must all pick the open one — and Escape
  must be dispatched *inside* the menu (its handler is the container's own React
  `onKeyDown`).
- **Destructive check assertions go last** in the section whose state they
  destroy, and before any section that navigates the page away
  (`check-file-browser.mjs` ends by navigating to a packaged-worker fixture where
  `files` does not exist).
- **Locale in isolated fixtures**: pin `localStorage['pi-app:locale']` **only when
  unset**, otherwise the zh-CN assertion can never take effect (the page reloads).
- **Vendored beUI edits** need a `// local patch (pi-app):` comment. Currently:
  `file-tree.tsx` (`data-tree-value` on the row, so the app can resolve a
  right-clicked row) and the pre-existing patches listed in AGENTS.md.
- **A library swap stays inside the adapter.** Never import icons directly in app
  code; `lib/icons.tsx` is the one door.

## 6. Docs debt (do this when the remaining waves land)

`AGENTS.md` documents the icon change only. It still needs sections for: the DSH
sandbox (modes, runner chain, bash fail-closed, file-tool seams, per-session mode
fold, escalation + the no-standing-grant decision), the manual compaction command
and its completion row, the context-menu surfaces and their DOM-resolution rule,
and `scripts/beui-add.mjs`. Until then a new session reading only AGENTS.md will
not know any of this exists.

## 7. Deliberate deviations from pi-web (recorded so they are not "fixed" later)

- pi-web persists the mode per session branch; pi-app does too now, but keeps an
  app-level **default** for new chats (`AppSettings.sandboxMode`).
- pi-web's broker owns child processes; pi-app already has exactly one owner
  (`main/bash/manager.ts`), so the broker supplies only the confined argv, the
  scrubbed environment and the exit classification. No second process registry.
- pi-web appends the escalation hint to tool descriptions and ships a
  `reason` string; pi-app sends data only and composes prose in the renderer,
  per the repo's IPC rule.
- Escalation has **no** "always allow": a standing grant would outlive the
  question being answered. `check-file-browser.mjs` asserts its absence.
