# beUI refresh + DSH sandbox — handoff

Working handoff for `experiment/beui-refresh`. Every claim below was run, not
assumed. Read this together with `AGENTS.md`, which is now caught up: the DSH
sandbox, manual compaction, the context-menu surfaces, `scripts/beui-add.mjs`
and the refresh wave all have sections there (see "Docs" below). Everything the
previous revision of this file listed as remaining work has landed; what is
left is a short "what a follow-up could still do" list.

## 1. Where things stand

- Branch: `experiment/beui-refresh`, working tree clean.
- Base/rollback: `0d9f6b8` ("WIP: snapshot before beUI refresh").
  - tag `backup/pre-beui-20260916-0631`
  - branch `backup/native-subagents-wip-20260916-0631`
  - off-repo copies in `~/githubs/pi-app-backups/` (`*.bundle` verified complete,
    `*-src.tar.gz` source snapshot). No git remote exists — the bundle **is** the
    off-machine-capable history.
- `feature/native-subagents` still points at `0d9f6b8`.

Commits, oldest first (the previous handoff's eight, then this session's):

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
| `b51b5ca` | Handoff document | — |
| `b82b590` | Context menu on the terminal surface (copy/paste/clear over `terminal:*` IPC) | check-terminal |
| `d1a2a9f` | Context menu on transcript message rows (copy / edit-resend / rewind / retry / fork) | check-bash-task-ui |
| `2ffbdbb` | Theme-aware shader backdrop on the landing and welcome surfaces | check-new-session-project |
| `a9bd59e` | File attachments as expandable chips | check-new-session-project |
| `5e8e2d3` | Adaptive steppers for the bash wait threshold and subagent concurrency | check-bash-task-ui |
| `b529e60` | Provider model discovery as a searchable multi-select | check-discover-multiselect |
| `33d30cb` | Token activity daily calendar rendered by beUI heat-calendar | check-usage-heatmap |
| `a8f3dbb` | Composer model picker as a searchable combobox | check-model-picker |

## 2. How to verify anything here

```bash
npm run typecheck && npm run build        # always, both projects
node scripts/check-sandbox.mjs            # real Seatbelt; no Electron, fast
node scripts/check-command-palette.mjs    # ⌘K, locale-pinned fixture
node scripts/check-file-browser.mjs       # full Workspace: tree/tabs/escalation
node scripts/check-bash-task-ui.mjs       # task panels, turn notices, compaction row, transcript menu, steppers
node scripts/check-bash-tasks.mjs         # managed bash + SDK steering (main side)
node scripts/check-terminal.mjs           # PTY, emulator, and the terminal context menu
node scripts/check-new-session-project.mjs# landing: shader backdrop + attachment chip
node scripts/check-discover-multiselect.mjs # provider discovery multi-select
node scripts/check-usage-heatmap.mjs      # token activity heat-calendar
node scripts/check-model-picker.mjs       # composer model combobox
node scripts/check-icons.mjs              # icon layer (run after build)
```

The other 40-odd `scripts/check-*.mjs` are the repo's existing suite. Checks
that mount the real `Workspace` must mount the same providers `App.tsx` does
(`I18nProvider`, `ThemeProvider`, `ImagePreviewProvider`, `ToastProvider`).
Isolated fixtures that assert a locale must pin `localStorage['pi-app:locale']`
**only when unset**, or the zh-CN assertion can never take effect (the page
reloads). Destructive assertions go last in the section whose state they
destroy.

## 3. What landed (behaviour, not file lists)

**Icons (owner decision "B").** Lucide is the pack again. `lib/icons.tsx` is
generated from `lucide-react` keeping all 131 export names; ten of them
deliberately differ from Lucide's current spelling and are listed in AGENTS.md.
`lib/animated-icons.tsx` extracts its geometry from Lucide and renders each node
by tag. `@hugeicons/*` is gone; `check-icons.mjs` now guards against *that* pack.
`scripts/beui-add.mjs` is the additive registry installer (never overwrites a
file carrying a `local patch (pi-app)` marker).

**DSH sandbox** (`src/main/sandbox/`). Three modes; canonical workspace;
writable roots = workspace + `/tmp` + `os.tmpdir()`; symlink-safe resolution
over the deepest existing ancestor; runner chain in DSH order (seatbelt →
bubblewrap → Landlock → Windows ACL → `dependencies-missing`). The optional
native helpers are resolved through a **computed specifier** so no other
platform's bundle tries to statically resolve them. Bash is confined *before* a
task record exists, so a confined mode with no usable runner can never become a
"running" task that ran on the host. `edit`/`write` are app-owned tools over the
SDK's `EditOperations`/`WriteOperations`, checked per side effect. Mode is per
session (`pith_sandbox_mode` branch entry, newest-wins); `AppSettings.sandboxMode`
is only the default a new chat starts from. Escalation is one-shot, published as
a sequence-free `pi:event` metadata ping and answered from beUI's `ToolApproval`
— deliberately no standing grant.

**Compaction.** The palette gained a manual compact (`AgentSession.compact()`),
refused while a turn is live. A settled compaction leaves a quiet UI-only notice
row with the token change — not a custom message, because injecting one would
put the notice into model context, which is what compaction just paid to shrink.

**Context menus (this session).** One `ContextMenu` per surface, the target
resolved from the DOM, never a trigger per row. Terminal: copy / paste (through
`terminal.paste()` → the emulator's `onData` → `terminal:*` IPC) / clear / select
all, with focus returned to the emulator on close. Transcript: user rows resolve
by `data-rail-id`, assistant turns by `data-assistant-group`, offering copy,
edit-resend, rewind, retry and fork from the same data the hover row uses; a
right-click that resolves no message row is `preventDefault`-ed in a capture
handler (the vendored trigger opens on the bubble pass), so no empty panel
appears.

**Wave 3 (this session).** The landing and welcome surfaces wear a theme-aware
shader backdrop; composer file attachments are expandable chips; the bash wait
threshold and a new subagent concurrency limit are adaptive steppers; provider
model discovery is a searchable multi-select; the usage panel's daily calendar
is beUI's `heat-calendar` with the existing data pipeline, localized readout and
read-only selection (the weekly view is unchanged). Wave 4: the composer model
picker is a searchable combobox (search field inside the popover so the compact
trigger keeps showing the active model; the popover stays open for the reasoning
model's thinking step).

## 4. What a follow-up could still do

- **`UsageTrendsPanel` has no beUI equivalent** and stays hand-rolled; nothing
  else in the settings usage view is a candidate.
- **The shader backdrop is one variant choice** (`mesh-gradient`). If the owner
  wants a different feel, change the `variant`/props in
  [ShaderBackdrop.tsx](src/renderer/src/components/app/ShaderBackdrop.tsx); the
  palette/theme plumbing is reusable.
- **The model picker's search input lives in the popover**, not the trigger. A
  future beUI combobox with an inline searchable trigger could move it, but the
  compact `Model · High` trigger was deliberately preserved.
- **No check drives the rewind/tool-execution paths against the new sandbox
  modes end to end.** `check-sandbox.mjs` covers the runner chain and
  confinement; a deeper matrix is possible.
- **Subagent E2E against a real model is still missing** (carried over from the
  previous handoff): `check-subagents.mjs` covers pure logic and real SDK
  session files, not a full Electron+model run.

## 5. Invariants a new session must not re-break

- **Shell slice equality.** `PiStore.set()` rebuilds the shell slice by
  shallow-comparing `shellOf()`'s output, not a hand-maintained field list; add
  fields to `PiState`/`PiShellState`/`shellOf` and the comparison follows.
- **"The menu" is the portal that is not hidden.** The vendored `ContextMenu`
  keeps every portal in the document (`aria-hidden` + `inert` +
  `pointer-events: none` while closed). With several menus mounted, a bare
  `querySelector('[data-context-menu-portal]')` returns whichever renders first.
  Reads, clicks and the Escape dispatch must all pick the open one — and Escape
  must be dispatched *inside* the menu (its handler is the container's own React
  `onKeyDown`).
- **Destructive check assertions go last** in the section whose state they
  destroy, and before any section that navigates the page away.
- **Locale in isolated fixtures**: pin `localStorage['pi-app:locale']` **only
  when unset**, or the zh-CN assertion can never take effect (the page reloads).
- **Vendored beUI edits** need a `// local patch (pi-app):` comment. Current set:
  the pre-existing ones in AGENTS.md plus `expandable-control.tsx` (token radius,
  `h-full` action wrapper) and `charts/heat-calendar/tooltip.tsx` (controlled
  `TooltipSurface` portal).
- **A library swap stays inside the adapter.** Never import icons directly in
  app code; `lib/icons.tsx` is the one door.
- **The shader color parser only accepts hex/rgb/hsl.** Theme tokens are oklch,
  so a color must pass through the 1×1-canvas sRGB conversion in
  `ShaderBackdrop.tsx` before it reaches the shader.

## 6. Docs

`AGENTS.md` now has the DSH sandbox / manual compaction / context-menu /
`beui-add.mjs` sections and a "beUI refresh wave" block, plus the two new
vendored patches. The handoff's former "Docs debt" is closed. Keep both in step
when the remaining items above land.

## 7. Deliberate deviations from pi-web (recorded so they are not "fixed" later)

- pi-web persists the mode per session branch; pi-app does too, but keeps an
  app-level **default** for new chats (`AppSettings.sandboxMode`).
- pi-web's broker owns child processes; pi-app already has exactly one owner
  (`main/bash/manager.ts`), so the broker supplies only the confined argv, the
  scrubbed environment and the exit classification. No second process registry.
- pi-web appends the escalation hint to tool descriptions and ships a `reason`
  string; pi-app sends data only and composes prose in the renderer, per the
  repo's IPC rule.
- Escalation has **no** "always allow": a standing grant would outlive the
  question being answered. `check-file-browser.mjs` asserts its absence.
