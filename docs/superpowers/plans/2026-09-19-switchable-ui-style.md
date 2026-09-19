# Switchable UI Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one global renderer preference (`uiStyle: 'square' | 'squircle'`) that drives the corner-radius scale, the capsule-by-design surfaces, the selection-control marks, and the icon pack (Remix Icon for square, HugeIcons for squircle), switchable live in Settings → Appearance with no reload.

**Architecture:** Geometry switches through CSS custom properties (`data-corners` on `documentElement`) exactly as the existing `data-accent` presets do — proven live-switchable by `check-corners.mjs:316`. A new `--app-radius-capsule` token plus a `rounded-capsule` utility lets every capsule-by-design surface follow the style with **no per-site conditionals**, because its square value (`0px`) is what those sites render today. The icon pack is derived from the same preference (never stored separately) and dispatched through the existing single-funnel adapter `lib/icons.tsx` by a React context, so no call site changes.

**Tech Stack:** Electron + electron-vite, React 19, Tailwind v4 (`@theme inline` + `@utility`), `@remixicon/react`, `@hugeicons/core-free-icons`; verification through the repo's CDP-driven `scripts/check-*.mjs` Electron checks (there is no unit-test framework).

**Spec:** `docs/superpowers/specs/2026-09-19-switchable-ui-style-design.md` — the plan argues from it; read both.

## Global Constraints

- **The preference is global** (app-wide `localStorage`, like accent/theme), never per project or session.
- **Default is `square`** and landing this changes nothing visually until the user switches.
- **One preference drives both dimensions.** The icon pack is a pure function of `uiStyle`; it is never stored separately and can never disagree with the geometry.
- **No reload path.** Switching must not call `location.reload()`, remount the app, or require an Electron restart.
- **`rounded-full` stays `9999px` in both styles** (`styles.css:288`) and means *always* a true circle: status/legend dots, activity indicators, loader artwork, ripples, favicon avatars. Never repurpose it for a style-dependent shape.
- **`rounded-capsule` is the only style-dependent shape token**: `0px` in square, `9999px` in squircle, always with `corner-shape: round`.
- **No literal radii and no numeric `radius` props** anywhere in `src/renderer/src` (`AGENTS.md` corner policy). Radii come from the token scale; percentages remain allowed only for genuine circles.
- **Every user-visible string goes through i18n**: add keys to **both** `src/renderer/src/i18n/locales/en.ts` and `zh-CN.ts` (the `Messages` type makes an omission a typecheck error).
- **Vendored-file edits carry `// local patch (pi-app):`** and stay minimal. Files under `components/motion|agents/` are vendored; `components/app/` is app glue.
- **Never edit `components/previews/**`** (not shipped).
- **Verification is the repo's checks**, not a new framework: `npm run typecheck && npm run build` plus the named `node scripts/check-*.mjs` per task.
- **The `@hugeicons` guard in `check-icons.mjs` is deliberately overturned by the owner.** Do not restore it, and record why in `AGENTS.md`.
- Work on branch `experiment/ui-style-presets`.

---

## Task 1: `rounded-capsule` token, utility, and the capsule-by-design call sites

The mechanical half. It must be **pixel-identical in the square style**, because `--app-radius-capsule: 0px` equals what these sites resolve to today — that property is what makes the whole design safe, so the task proves it with a check before and after.

**Files:**
- Modify: `src/renderer/src/styles.css` (token in `:root` near line 42; utility after `@utility rounded-full` near line 289)
- Modify (16 files, one class swap each — see the table in Step 3)
- Test: `scripts/check-corners.mjs` (the composer send control's assertion at ~line 227, plus a new capsule-site assertion)
- Docs: `AGENTS.md` (the corner-policy bullet list, ~line 40)

**Interfaces:**
- Consumes: nothing.
- Produces: the CSS token `--app-radius-capsule` and the Tailwind utility class `rounded-capsule`. Every later task and all future work uses `rounded-capsule` for "the shape follows the style" and `rounded-full` for "always a circle". No TypeScript interface.

- [ ] **Step 1: Write the failing assertion**

In `scripts/check-corners.mjs`, the existing send-control assertion (~line 227) hardcodes the square style's `superellipse(2)` corner shape:

```js
assert.equal(await evaluate(`(()=>{const e=document.querySelector('[aria-label="Send prompt"]'),s=getComputedStyle(e),r=e.getBoundingClientRect();return s.cornerShape==='superellipse(2)'&&parseFloat(s.borderTopLeftRadius)===0&&r.height>0})()`), true, 'composer send control is hard-edged')
```

Replace it with the capsule-aware pair (the send control becomes a capsule site in Step 3, so its corner shape becomes `superellipse(1)` while the square style's *painted* result is still zero radius):

```js
      // The composer's send control is capsule-by-design: the shape token
      // collapses to 0px in the square style, so it stays hard-edged while
      // carrying the round corner shape that the squircle style needs.
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('[aria-label="Send prompt"]'),s=getComputedStyle(e),r=e.getBoundingClientRect();return s.cornerShape==='superellipse(1)'&&parseFloat(s.borderTopLeftRadius)===0&&r.height>0})()`), true, 'composer send control collapses to a hard edge')
      assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--app-radius-capsule").trim()'), '0px', '--app-radius-capsule collapses in the square style')
```

- [ ] **Step 2: Run the check to verify it fails**

Run: `node scripts/check-corners.mjs`
Expected: FAIL — `--app-radius-capsule` is the empty string (the token does not exist yet) and/or the send control is still `superellipse(2)`.

- [ ] **Step 3: Add the token and the utility**

In `src/renderer/src/styles.css`, in `:root` immediately after `--app-radius-window: 0px;` (line 41) and before `--app-radius-full`:

```css
  /* Capsule-by-design surfaces (avatars, icon controls, chips, badges, pill
   * tabs, selection marks) take their shape from the UI style: collapsed to a
   * right angle in the square style, a true capsule in the squircle style.
   * `rounded-full` remains the always-circular token. */
  --app-radius-capsule: 0px;
```

Then, immediately after the `@utility rounded-full { … }` block (line 288-291):

```css
@utility rounded-capsule {
  border-radius: var(--app-radius-capsule) !important;
  corner-shape: round !important;
}
```

`!important` is required for the same reason documented above `rounded-full`: Tailwind emits custom `@utility` rules before its own sorted radius scale, so a control that also carries a semantic radius would otherwise win back that radius and lose the capsule.

- [ ] **Step 4: Swap the 16 call sites**

Each entry is the **current** string (verify it against the file before editing — later commits have touched several of these files) and its replacement. Swap only the radius class.

| File | Current class string | Replace |
| --- | --- | --- |
| `components/agents/approval-card/index.tsx` | `grid size-5 shrink-0 place-items-center rounded-control text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring` | `rounded-control` → `rounded-capsule` |
| `components/agents/code-block.tsx` | `grid size-7 shrink-0 place-items-center rounded-control text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring` | `rounded-control` → `rounded-capsule` |
| `components/agents/message.tsx` | `grid size-7 shrink-0 place-items-center overflow-hidden rounded-control bg-muted text-xs font-medium text-muted-foreground [&_img]:size-full [&_img]:object-cover [&_svg]:size-3.5` | `rounded-control` → `rounded-capsule` |
| `components/agents/prompt-input.tsx` | `size-8 rounded-control` (two occurrences) | `rounded-control` → `rounded-capsule` |
| `components/app/AuthBridge.tsx` | `grid size-5 shrink-0 place-items-center rounded-control border border-border text-[10px] text-muted-foreground` | `rounded-control` → `rounded-capsule` |
| `components/app/Composer.tsx` | `absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-control bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100` | `rounded-control` → `rounded-capsule` |
| `components/app/ContextRing.tsx` | `grid size-8 cursor-default place-items-center rounded-control transition-colors hover:bg-muted` | `rounded-control` → `rounded-capsule` |
| `components/app/EditMessageDialog.tsx` | the `absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-control …` badge, and `grid size-4 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground` | `rounded-control` → `rounded-capsule` (both) |
| `components/app/settings/AppearanceSection.tsx` | `grid size-8 place-items-center rounded-control transition-transform hover:scale-110` | `rounded-control` → `rounded-capsule` |
| `components/app/settings/ExtensionsSection.tsx` | `grid size-4 shrink-0 place-items-center rounded-control transition-colors hover:bg-destructive/10` | `rounded-control` → `rounded-capsule` |
| `components/charts/heat-calendar/grid.tsx` (the plan named `settings/usage/TokenActivityPanel.tsx`, which no longer carries these — see the spec's note) | the cell hit area `absolute -inset-0.5 block rounded-detail outline-none …`, and the cell visual `pointer-events-none absolute inset-0.5 block rounded-detail` | `rounded-detail` → `rounded-capsule` (both) |
| `components/motion/animated-badge.tsx` | `relative inline-flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-item border font-medium tabular-nums` | `rounded-item` → `rounded-capsule` |
| `components/motion/animated-toast-stack.tsx` | `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control` (icon tile), `mt-2 inline-flex h-7 items-center rounded-control bg-primary/[0.06] px-3 text-xs font-medium text-foreground transition-colors hover:bg-primary/[0.1]` (action), `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-primary/[0.06] hover:text-foreground` (dismiss) | `rounded-control` → `rounded-capsule` (all three) |
| `components/motion/button/metallic.tsx` | `size === "icon" && "rounded-icon"` | `"rounded-icon"` → `"rounded-capsule"` |
| `components/motion/expandable-control.tsx` | the h-11 `min-w-11` chip, the h-10 chip, and the `h-full w-8` action — all currently `rounded-control` | `rounded-control` → `rounded-capsule` (all three) |
| `components/motion/tabs.tsx` | `pill: "inline-flex items-center gap-1 rounded-control bg-card p-1"` and `const radius = variant === "pill" ? "rounded-control" : "rounded-md";` | `rounded-control` → `rounded-capsule` (both) |

For each vendored file (`components/motion/**`, `components/agents/**`) keep the existing `// local patch (pi-app):` comment and extend it in one line, e.g.:

```tsx
// local patch (pi-app): capsule-by-design, so the shape token follows the
// UI style (see --app-radius-capsule in styles.css).
```

`components/app/**` files need no marker (they are app glue).

- [ ] **Step 5: Run the checks to verify they pass**

Run: `node scripts/check-corners.mjs`
Expected: PASS — `native corners, circular exceptions, pseudo-elements, inherited layers, live tokens, animation frames, themes and focus.`

Run: `node scripts/check-usage-heatmap.mjs`
Expected: PASS — the activity panel's cells are a Class A capsule site, so the heatmap check is the one that sees this change.

- [ ] **Step 6: Prove the square style did not move**

⚠️ **Superseded during execution — the `cmp` method below does not work on this fixture.** Measured: two runs of *identical* code differ by ~525,000 pixels in the dark galleries, because the fixture screenshots while the light→dark `transition-colors` is still running and the Loader dots animate forever. `cmp` therefore cannot attribute a difference to a code change. Use this method instead:

```bash
# Baseline on a clean tree, BEFORE any edit (or from an isolated tree):
git worktree add --detach /tmp/pi-clean HEAD
ln -s "$PWD/node_modules" /tmp/pi-clean/node_modules
( cd /tmp/pi-clean && node scripts/check-corners.mjs )      # must PASS
# …make the edits here, then:
node scripts/check-corners.mjs                               # must PASS
```

Compare with two controls in place, and accept the result only if the control also shows variance:

1. Temporarily add a settle (`await pause(800)`) after each theme toggle in the screenshot path, run both trees, and revert the temporary edit afterwards (`git diff scripts/check-corners.mjs` must show only the Step 1 assertion change).
2. Mask the Loader's animating region and require **0 differing pixels** everywhere else; a clean-vs-clean run of the two states is the noise floor to compare against.

Acceptance: 0 differing pixels outside the animating Loader, and the composer send-control crop byte-identical. Record the numbers (including the noise floor) in the commit message. Raw `cmp` output on this fixture is not evidence either way.

The check's own assertions (Step 1 and Step 5) remain the primary gate; the screenshots only pin the parts no assertion covers.

- [ ] **Step 7: Update the corner policy in `AGENTS.md`**

Replace the `rounded-full` bullet's "Reserve it for avatars, status/legend dots, …" sentence with the two-rule policy:

```
`rounded-full` means an **always**-true circle (status/legend dots, activity indicators, loader artwork, ripples, favicon avatars); `rounded-capsule` means **the shape follows the UI style** (avatars, icon-size controls, chips, badges, pill tabs, attachment/remove badges, selection marks) — `0px` in the square style, a true capsule in the squircle style. Both are `!important` for the same reason as above.
```

- [ ] **Step 8: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add -A
git commit -m "refactor(geometry): rounded-capsule token + capsule-by-design call sites

The new --app-radius-capsule token resolves to 0px in the square style,
which is exactly what these 16 sites render today, so this commit is
pixel-identical until the squircle preset lands. Verified with
check-corners plus a screenshot comparison of both themes."
```

---

## Task 2: The style preference — preset, store, wiring, Settings row, parameterized check

**Files:**
- Modify: `src/renderer/src/styles.css` (the `[data-corners='squircle']` block)
- Create: `src/renderer/src/lib/ui-style.ts`
- Modify: `src/renderer/src/App.tsx` (import, state, layout effect, prop threading at line 113)
- Modify: `src/renderer/src/components/app/Workspace.tsx` (props interface ~line 126, signature ~line 169)
- Modify: `src/renderer/src/components/app/settings/SettingsPage.tsx` (props ~line 23, `AppearanceSection` call ~line 59)
- Modify: `src/renderer/src/components/app/settings/AppearanceSection.tsx` (props, new `SettingsGroup`)
- Modify: `src/renderer/src/i18n/locales/en.ts` and `zh-CN.ts` (four keys)
- Test: `scripts/check-corners.mjs` (preset sweep)
- Docs: `AGENTS.md` (the corner-scale paragraph, line 38) and `README.md` (line 19)

**Interfaces:**
- Consumes: `--app-radius-capsule` and `rounded-capsule` from Task 1.
- Produces, consumed by Tasks 3 and 5:
  - `type UiStyle = 'square' | 'squircle'`
  - `useUiStyle(): [UiStyle, (next: UiStyle) => void]`
  - `applyUiStyle(style: UiStyle): void` — writes **both** `document.documentElement.dataset.corners` (the style) and `.dataset.iconPack` (`'remix' | 'hugeicons'`)
  - `iconPackOf(style: UiStyle): 'remix' | 'hugeicons'`
  - localStorage key `pi-app:ui-style`; a missing/invalid value means `'square'`

- [ ] **Step 1: Write the failing preset sweep**

At the end of the `for (const reduced of [false, true])` loop body in `scripts/check-corners.mjs` (after the live-token block, before the loop closes), add:

```js
    // The style preset must be a pure token swap: both presets pinned, and the
    // capsule site must actually change shape between them.
    const CORNER_PRESETS = {
      square: { detail: '0px', inner: '0px', item: '0px', card: '0px', window: '0px', capsule: '0px' },
      squircle: { detail: '4px', inner: '10px', item: '14px', card: '20px', window: '28px', capsule: '9999px' }
    }
    for (const [preset, expected] of Object.entries(CORNER_PRESETS)) {
      await evaluate(`document.documentElement.dataset.corners = ${JSON.stringify(preset)}`)
      await pause(150)
      for (const [token, value] of Object.entries(expected)) {
        assert.equal(
          await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--app-radius-${token}").trim()`),
          value,
          preset + ': --app-radius-' + token
        )
      }
      const sendRadius = parseFloat(await style('[aria-label="Send prompt"]', 'border-top-left-radius'))
      assert.ok(
        preset === 'square' ? sendRadius === 0 : sendRadius >= 16,
        preset + ': the capsule site ' + (preset === 'square' ? 'stays a right angle' : 'is a full capsule') + ' (got ' + sendRadius + ')'
      )
      assert.equal(await style('[aria-label="Send prompt"]', 'corner-shape'), 'superellipse(1)', preset + ': the capsule keeps a round corner shape')
    }
    await evaluate('delete document.documentElement.dataset.corners')
    await pause(150)
```

- [ ] **Step 2: Run the check to verify it fails**

Run: `node scripts/check-corners.mjs`
Expected: FAIL on the first squircle assertion — `--app-radius-detail` reports `0px` because the preset block does not exist yet.

- [ ] **Step 3: Add the preset block to `styles.css`**

Immediately after the `:root` block's closing brace (after line 43's `--radius: var(--app-radius-detail);` and the rest of `:root`), add:

```css
/* Restored continuous-corner style (Superellipse UI). Values recovered from
 * 397f6ed^ — the commit that squared the branch. The block must stay BELOW
 * `:root`: it has the same specificity (0,1,0) and wins on source order alone,
 * exactly like the [data-accent='…'] presets further down. */
[data-corners='squircle'] {
  --app-radius-detail: 4px;
  --app-radius-inner: 10px;
  --app-radius-item: 14px;
  --app-radius-card: 20px;
  --app-radius-window: 28px;
  --app-radius-capsule: 9999px;
}
```

- [ ] **Step 4: Create `lib/ui-style.ts`**

```ts
import { useSyncExternalStore } from 'react'

/**
 * Interface style — Settings → Appearance. ONE global preference that drives
 * two dimensions so they can never disagree: the corner/radius preset
 * (`data-corners`) and the icon pack (`data-icon-pack`).
 *
 * The squircle values are recovered from 397f6ed^ (the parent of the commit
 * that squared the branch); the square style is the default and the two token
 * values that matter read `--app-radius-capsule: 0px`, which is what every
 * capsule-by-design site rendered before the token existed.
 *
 * A renderer preference like accent/locale/typefaces: localStorage plus a
 * subscribable store, so choosing it in Settings re-renders the interface with
 * no session involvement and no reload. No boot hook is needed in main.tsx —
 * the first read resolves the stored value and App applies it in a layout
 * effect so the first paint is already correct.
 */

const STORAGE_KEY = 'pi-app:ui-style'
export const UI_STYLES = ['square', 'squircle'] as const
export type UiStyle = (typeof UI_STYLES)[number]
export type IconPack = 'remix' | 'hugeicons'
const DEFAULT: UiStyle = 'square'

function isStyle(value: string | null): value is UiStyle {
  return value === 'square' || value === 'squircle'
}

/** The icon pack is derived, never stored: one preference, two dimensions. */
export function iconPackOf(style: UiStyle): IconPack {
  return style === 'squircle' ? 'hugeicons' : 'remix'
}

/** Write both derived attributes. Idempotent; safe to call on every change. */
export function applyUiStyle(style: UiStyle): void {
  const root = document.documentElement
  root.dataset.corners = style
  root.dataset.iconPack = iconPackOf(style)
}

function read(): UiStyle {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isStyle(stored) ? stored : DEFAULT
  } catch {
    return DEFAULT
  }
}

let current: UiStyle = DEFAULT
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): UiStyle {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(next: UiStyle): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of listeners) listener()
}

/** Subscribable interface-style preference shared by the app shell and Settings. */
export function useUiStyle(): [UiStyle, (next: UiStyle) => void] {
  const style = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [style, set]
}
```

- [ ] **Step 5: Wire it in `App.tsx`**

Add to the imports (next to `import { I18nProvider, useI18n } from './i18n'`):

```tsx
import { applyUiStyle, useUiStyle } from './lib/ui-style'
```

In `AppInner`, immediately after the accent state/effect block (`useEffect(() => { applyAccent(accent) }, [accent])`), add:

```tsx
  const [uiStyle, setUiStyle] = useUiStyle()
  // A layout effect (not an effect) so the preset is on <html> before the
  // first paint: an effect would flash the square style on a squircle boot.
  useLayoutEffect(() => {
    applyUiStyle(uiStyle)
  }, [uiStyle])
```

Change the `react` import on line 1 to include `useLayoutEffect`:

```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
```

Thread it to Workspace (line 113):

```tsx
      <Workspace
        store={store}
        accent={accent}
        onAccentChange={setAccent}
        uiStyle={uiStyle}
        onUiStyleChange={setUiStyle}
      />
```

- [ ] **Step 6: Thread the props through Workspace and SettingsPage**

`components/app/Workspace.tsx`: add to `WorkspaceProps` (after `onAccentChange: (accent: string) => void`) and destructure in the signature (line 169):

```tsx
  uiStyle: UiStyle
  onUiStyleChange: (style: UiStyle) => void
```

with `import type { UiStyle } from '@/lib/ui-style'`, and pass both to `<SettingsPage … />` alongside `accent`/`onAccentChange`.

`components/app/settings/SettingsPage.tsx`: add the same two props to its props interface (line 23) and pass them at the `AppearanceSection` call (line 59):

```tsx
      <AppearanceSection
        accent={props.accent}
        onAccentChange={props.onAccentChange}
        uiStyle={props.uiStyle}
        onUiStyleChange={props.onUiStyleChange}
      />
```

- [ ] **Step 7: Add the Settings row**

In `AppearanceSection.tsx`, extend the props and add a group. Place it **after the theme group and before the fonts group**, so the visual-identity choices (theme → style → accent) read together:

```tsx
/** Interface style: the corner/radius preset and the icon pack that matches it.
 * They are one choice on purpose — the two dimensions can never disagree. */
export const UI_STYLE_OPTIONS = [
  { id: 'square', labelKey: 'settings.uiStyleSquare' },
  { id: 'squircle', labelKey: 'settings.uiStyleSquircle' }
] as const
```

```tsx
      <SettingsGroup title={t('settings.uiStyle')} description={t('settings.uiStyleDesc')}>
        <div className="px-4 py-3.5">
          <RadioGroup
            orientation="horizontal"
            value={uiStyle}
            onValueChange={(next) => onUiStyleChange(next as UiStyle)}
            className="gap-6"
          >
            {UI_STYLE_OPTIONS.map((option) => (
              <RadioGroupItem key={option.id} value={option.id} label={t(option.labelKey)} />
            ))}
          </RadioGroup>
        </div>
      </SettingsGroup>
```

with `import type { UiStyle } from '@/lib/ui-style'` added to the imports.

- [ ] **Step 8: Add the i18n keys to both locales**

`src/renderer/src/i18n/locales/en.ts`, next to `'settings.theme'`:

```ts
  'settings.uiStyle': 'Interface style',
  'settings.uiStyleDesc': 'Edge and icon style for the whole app',
  'settings.uiStyleSquare': 'Square',
  'settings.uiStyleSquircle': 'Squircle',
```

`src/renderer/src/i18n/locales/zh-CN.ts`, at the same place in the dictionary:

```ts
  'settings.uiStyle': '界面风格',
  'settings.uiStyleDesc': '整个应用的边角与图标风格',
  'settings.uiStyleSquare': '直角',
  'settings.uiStyleSquircle': '超椭圆',
```

- [ ] **Step 9: Run the check and the manual pass**

Run: `node scripts/check-corners.mjs`
Expected: PASS, including the new preset sweep for both `square` and `squircle` (both themes, both motion settings).

Then the spec's required manual pass (§7 of the spec, because the squircle style is *restored*, not designed — nobody has looked at it since `397f6ed`):

```bash
PI_CORNERS_SCREENSHOT_DIR=/tmp/corners-squircle node scripts/check-corners.mjs
npm run dev
```

In the running app, switch to 超椭圆 and screenshot light + dark; look for surfaces that read wrong (the pre-square branch was never re-reviewed after the squaring commit). Use Task 1 Step 6's corrected comparison method (settle the theme transition, mask the Loader, compare against a noise floor) — a raw `cmp` of two runs is not evidence. Specifically confirm the two sites Task 1 had to re-target: the heat-calendar activity cells (circles in the squircle style, per the pre-square app; if squares read better, that is a one-word change and a deliberate decision) and the composer send/attach controls. Record findings in the commit message. Do not silently "fix" anything outside this plan's scope — file it as a follow-up.

- [ ] **Step 10: Rewrite the stale geometry docs**

`AGENTS.md` line 38 still documents the old `4px/10px/14px/20px/28px` scale as if the tokens were those values. Replace that sentence with the preset model (square is `:root`'s all-zero scale; `[data-corners='squircle']` carries the recovered values; the preset block must stay below `:root`; `styles.css` owns the scale, `lib/ui-style.ts` owns the preference, `data-corners`/`data-icon-pack` are written together by `applyUiStyle`).

`README.md` line 19 ("Continuous corners …") describes the pre-square behaviour. Rewrite it to say the interface style is a user choice in Settings → Appearance (square edges by default, squircle corners optionally), that the icon pack follows the choice, and that `scripts/check-corners.mjs` pins both.

- [ ] **Step 11: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
node scripts/check-corners.mjs
git add -A
git commit -m "feat(settings): interface style (square / squircle), one preference

[data-corners] selects the radius preset and derives the icon pack from it,
so geometry and artwork can never disagree. Applied in a layout effect so a
squircle boot has no flash of the square style. check-corners now pins both
presets, and the geometry docs describe the preset model instead of the old
fixed scale."
```

---

## Task 3: Selection-control marks

**Owner decision:** the fully circular point is for the **squircle style only**; the square style keeps today's square point.

**Files:**
- Modify: `src/renderer/src/components/motion/checkbox.tsx` (the `mark="square"` point, ~line 99, plus its `data-checkbox-square` hook)
- Modify: `src/renderer/src/components/motion/radio.tsx` (the point, line 140)
- Test: `scripts/check-corners.mjs` (the selection-control assertions, ~lines 216-220), `scripts/check-notification-sounds.mjs:193` (hook rename)
- Docs: `AGENTS.md` (the selection-control sentence in the `rounded-full` bullet)

**Interfaces:**
- Consumes: `--app-radius-capsule` (Task 1) and the presets (Task 2).
- Produces: the `data-checkbox-mark` attribute, replacing `data-checkbox-square` (a stable hook that no longer names a shape). Follow-up tasks and checks query `[data-checkbox-mark]`.

- [ ] **Step 1: Write the failing assertion**

In `scripts/check-corners.mjs`, the current block (~lines 216-220) asserts both the frames and the marks are hard-edged:

```js
      for (const selector of ['[role="checkbox"]', '[role="checkbox"] > span', '[role="radio"]', '[role="radio"] > span']) {
        assert.equal(await style(selector, 'corner-shape'), 'superellipse(2)', selector + ': continuous selection control')
        assert.equal(await style(selector, 'border-top-left-radius'), '0px', selector + ': hard edge')
      }
```

Replace it with a mark-aware version (the frames stay scale-driven; the marks take the capsule token):

```js
      // Selection controls: the frames stay on the radius scale (hard-edged in
      // the square style), while the on-state MARK is capsule-by-design — a
      // square point in the square style, a fully circular point in the
      // squircle style.
      for (const selector of ['[role="checkbox"]', '[role="radio"]']) {
        assert.equal(await style(selector, 'corner-shape'), 'superellipse(2)', selector + ': continuous selection frame')
        assert.equal(await style(selector, 'border-top-left-radius'), '0px', selector + ': hard-edged frame')
      }
      for (const selector of ['[data-checkbox-mark]', '[role="radio"] > span']) {
        assert.equal(await style(selector, 'corner-shape'), 'superellipse(1)', selector + ': the mark carries the round corner shape')
        const markRadius = parseFloat(await style(selector, 'border-top-left-radius'))
        const markBox = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return Math.min(r.width,r.height)})()`)
        assert.ok(
          preset === 'square' ? markRadius === 0 : markRadius >= markBox / 2,
          selector + ': ' + (preset === 'square' ? 'square point' : 'fully circular point') + ' (radius ' + markRadius + ', box ' + markBox + ')'
        )
      }
```

`preset` is the loop variable introduced in Task 2's sweep — so this block moves **inside** that sweep loop (or the sweep is hoisted into a helper both blocks call). Simplest: move the selection-control block into the preset sweep loop, immediately after the capsule-site assertion.

Also update `scripts/check-notification-sounds.mjs:193`:

```js
  const mark = box.querySelector('[data-checkbox-mark]')
```

- [ ] **Step 2: Run the checks to verify they fail**

```bash
node scripts/check-corners.mjs
node scripts/check-notification-sounds.mjs
```
Expected: check-corners FAILs on `[data-checkbox-mark]` (no such element yet); check-notification-sounds FAILs because its selector is the new one.

- [ ] **Step 3: Swap the two marks**

`components/motion/checkbox.tsx` (~line 85-104): rename the hook and add the capsule class, updating the local-patch comment to explain the new rule:

```tsx
              <motion.span
                key="square"
                data-checkbox-mark
                // local patch (pi-app): the point-selection mark takes the
                // capsule token, so it is a square point in the square style
                // and a fully circular point in the squircle style (see
                // --app-radius-capsule in styles.css).
                className="size-1.5 rounded-capsule bg-primary"
```

`components/motion/radio.tsx:140`:

```tsx
            className="size-1.5 rounded-capsule bg-primary"
```

Both files keep the `size-1.5` geometry, the 14px box, and the `mark` prop's meaning — only the shape token changes.

- [ ] **Step 4: Run the checks to verify they pass**

```bash
node scripts/check-corners.mjs
node scripts/check-notification-sounds.mjs
```
Expected: both PASS.

- [ ] **Step 5: Decide the frame question on screen — do not assume**

The frames are `size-3.5` (14px) with `rounded-control`; under the squircle preset that is a 14px radius on a 14×14 box, i.e. the frame itself becomes (near-)circular, and the checkbox reads ⊙. That is **not** a restoration: the pre-square control was a 20px box with a 10px radius (a rounded square).

Screenshot a checkbox, a radio, the session-search filter row and a Settings row in both styles and decide explicitly:

- **(a) Accept the circle** — the squircle style's selection controls are round. Nothing to do.
- **(b) Keep a rounded square frame** — pin the frames to the inner/control token instead of `rounded-control` (e.g. `rounded-inner`, 10px in squircle, 0 in square) so only the *point* becomes circular.

Record which was chosen in the commit message: either `Frame decision: (a) accepted the circular frame` or `Frame decision: (b) pinned the frames to rounded-inner`. If (b), apply it to both `checkbox.tsx` and `radio.tsx` in this same commit and re-run Step 4.

- [ ] **Step 6: Update `AGENTS.md`**

The `rounded-full` bullet's selection-control sentence currently reads "radios and their dot, checkboxes … are hard-edged (…), because the user asked for square selection controls on this branch". Rewrite it to the current truth: the frames are hard-edged, the **mark** is capsule-by-design (square point in the square style, fully circular point in the squircle style), the marks stay text-sized (14px box, `size-1.5` point), the vendored `Switch` is still unrendered in both styles, and the check hook is `data-checkbox-mark`.

- [ ] **Step 7: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add -A
git commit -m "feat(controls): selection marks follow the interface style

The on-state point takes the capsule token: a square point in the square
style (unchanged), a fully circular point in the squircle style. The
data-checkbox-square hook is renamed data-checkbox-mark because it no
longer names a shape.

Frame decision: <write (a) or (b) here with one sentence of reasoning>."
```

---

## Task 4: Kill the literal radii `guard()` cannot see

**Files:**
- Modify: `src/renderer/src/components/app/pdf-viewer.css` (three `border-radius:2px` rules)
- Test: `scripts/check-corners.mjs` (`guard()`)

**Interfaces:**
- Consumes: nothing (independent of Tasks 1-3, but runs after them so the check edits stack cleanly).
- Produces: a `guard()` that rejects CSS-form literal radii, which is the only thing that can keep them from coming back (the current check misses them entirely — `border-radius:2px` is not `borderRadius: 2`).

- [ ] **Step 1: Extend `guard()` and watch it fail**

In `scripts/check-corners.mjs`'s `guard()`, after the existing camelCase radius assertion (line 32), add:

```js
    assert.doesNotMatch(text, /border-radius:\s*[1-9][\d.]*(?:px|rem)/, path + ': literal CSS radius')
```

Percentages stay allowed on purpose: a `50%` radius is a genuine circle (PDF form radios, `rounded-full`'s fallback), not a scale value.

Run: `node scripts/check-corners.mjs`
Expected: FAIL with `pdf-viewer.css: literal CSS radius` at three lines.

- [ ] **Step 2: Map the three rules to the token**

In `src/renderer/src/components/app/pdf-viewer.css`, change the `border-radius:2px` declarations to the detail token in all three rules:

```css
    border-radius:var(--app-radius-detail);
```

(lines 375, 382, 395 — the annotation text/choice/checkbox hover and focus rules). Leave the two `border-radius:50%` rules alone (lines 353, 432): those draw a *document's* own radio widgets, not app chrome.

- [ ] **Step 3: Run the check to verify it passes**

Run: `node scripts/check-corners.mjs`
Expected: PASS.

- [ ] **Step 4: Run the PDF regression**

Run: `node scripts/check-pdf-preview.mjs`
Expected: PASS (the subset stylesheet still lays out page, canvas and text layer identically).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(geometry): pdf form-field radii take the token, guard() sees CSS literals

guard() only matched the camelCase form, so pdf-viewer.css's literal 2px
radii were invisible to it. The three annotation hover/focus rules now take
--app-radius-detail and the guard rejects length-unit literals outright;
the two 50% rules stay because they draw a PDF's own radio widgets."
```

---

## Task 5: The icon pack (HugeIcons for squircle)

The largest task, and the only one whose scope depends on discovery: the HugeIcons glyph *names* for 37 of the 153 exports do not exist in this repo yet, so the task installs the package, recovers the 116 already-mapped names from history, then completes the table and proves every name renders in both packs.

**Files:**
- Modify: `package.json` (add `@hugeicons/core-free-icons@^4.3.2`; remove `lucide-react`)
- Create: `src/renderer/src/lib/icon-pack.tsx`
- Modify: `src/renderer/src/lib/icons.tsx` (the whole file: a two-pack table + a pack-aware `createIcon`)
- Modify: `src/renderer/src/lib/animated-icons.tsx` (per-pack geometry)
- Modify: `src/renderer/src/App.tsx` (mount `IconPackProvider` around `AppInner`)
- Test: `scripts/check-icons.mjs` (guard removal + both-packs + stroke semantics)
- Docs: `AGENTS.md` (the icon rule, including why the guard was overturned)

**Interfaces:**
- Consumes: `UiStyle`, `iconPackOf` (Task 2).
- Produces:
  - `type IconPack = 'remix' | 'hugeicons'` (also re-exported from `lib/ui-style.ts` for `applyUiStyle`)
  - `IconPackProvider({ pack, children })`, `useIconPack(): IconPack` — default `'remix'` when no provider is mounted, so isolated fixtures keep working
  - `lib/icons.tsx` keeps **all 153 existing export names** and the `IconComponent`/`IconProps` types unchanged: no call site changes
  - `lib/animated-icons.tsx`'s `IconPaths`/`AnimatedIcon` keep their props and gain pack-aware geometry

- [ ] **Step 1: Install and discover the data shape**

```bash
npm i @hugeicons/core-free-icons@^4.3.2
node -e "import('@hugeicons/core-free-icons').then(m=>{const k=Object.keys(m).filter(k=>k.endsWith('Icon'));console.log('exports:',k.length);const sample=m[k[0]];console.log('sample key:',k[0]);console.log(JSON.stringify(sample).slice(0,300))})"
```

Expected: a large export list and a sample that is an array of `[tagName, attributes]` tuples (e.g. `[["path",{"d":"…"}]]`). **Decision rule:** if the shape is that tuple array, use the renderer in Step 4 as written. If it wraps differently, adapt the renderer to the observed shape and let Step 6's both-packs assertions (which iterate every export name in both packs) be the proof — nothing else in this task depends on the exact wrapper.

Do **not** install `@hugeicons/react`: rendering the tuples ourselves keeps ref forwarding, the a11y contract and prop passthrough in this repo's control, which is what `check-icons.mjs` asserts (`window.iconRef.current === document.querySelector('#props-icon')`).

- [ ] **Step 2: Create `lib/icon-pack.tsx`**

```tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { IconPack } from './ui-style'

/**
 * Which pack `lib/icons.tsx` renders. The adapter is the single funnel for
 * every glyph in the app, so a pack switch is a context change and one
 * re-render — no reload, no remount, and no per-call-site conditionals.
 *
 * Defaults to the square style's pack so an isolated render (a check fixture,
 * a preview) never needs the provider.
 */
const IconPackContext = createContext<IconPack>('remix')

export function IconPackProvider({ pack, children }: { pack: IconPack; children: ReactNode }) {
  return <IconPackContext.Provider value={pack}>{children}</IconPackContext.Provider>
}

export function useIconPack(): IconPack {
  return useContext(IconPackContext)
}
```

- [ ] **Step 3: Recover the existing 116 mappings**

```bash
git show codex/hugeicons-stroke-rounded:src/renderer/src/lib/icons.tsx > /tmp/hugeicons-adapter.tsx
```

That file is a complete working HugeIcons adapter (255 lines) covering 116 of today's 153 export names, with the same semantic names. Mine its import list and name→glyph pairs; where it imported `HugeiconsIcon`/`IconSvgElement` from `@hugeicons/react`, keep only the glyph identifiers and use the local tuple type from Step 4 instead.

- [ ] **Step 4: Rewrite `lib/icons.tsx` as a two-pack table**

Keep the file's head comment (semantic names at call sites, artwork only here) and update it to name both packs. Replace `createIcon(name, glyph)` with a table lookup and a pack-aware renderer:

```tsx
import { forwardRef, createElement, type ForwardRefExoticComponent, type ReactElement, type RefAttributes, type SVGProps } from 'react'
import {
  RiAddLine, RiAlertLine, /* …the existing 153 Remix imports, unchanged… */
} from '@remixicon/react'
import {
  Alert01Icon, /* …the HugeIcons imports recovered in Step 3 + the 37 new ones… */
} from '@hugeicons/core-free-icons'
import { useIconPack } from './icon-pack'

/** One HugeIcons glyph: an SVG element name and its attributes, in document
 * order. Pinned here rather than imported from the package's React binding so
 * this adapter keeps ref forwarding, the a11y default and prop passthrough. */
type HugeGlyph = ReadonlyArray<readonly [string, Record<string, string | number>]>
type RemixGlyph = (props: Record<string, unknown>) => ReactElement

/** The pack table: exactly one glyph per pack per semantic name. Adding a name
 * means adding a row here and nothing else. */
const GLYPHS = {
  AlertCircle: { remix: RiAlertLine, huge: AlertCircleIcon },
  /* …one row per export, 153 rows… */
} satisfies Record<string, { remix: unknown; huge: HugeGlyph }>

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: string | number
  /** Lucide-era call-site compat: accepted; applied only by stroke artwork. */
  absoluteStrokeWidth?: boolean
}
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

const HUGE_STROKE = 1.5

function createIcon(name: keyof typeof GLYPHS): IconComponent {
  const pair = GLYPHS[name]
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const pack = useIconPack()
    const { strokeWidth, size, className, ...rest } = props
    const a11y = rest['aria-label'] || rest['aria-labelledby'] ? undefined : true
    if (pack === 'hugeicons') {
      // Stroke artwork: strokeWidth is applied (the pack's own default is 1.5).
      const huge = pair.huge as HugeGlyph
      return createElement(
        'svg',
        {
          ref,
          'data-app-icon': name,
          'aria-hidden': a11y,
          focusable: 'false',
          width: size ?? 24,
          height: size ?? 24,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: strokeWidth ?? HUGE_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          ...rest
        },
        huge.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))
      )
    }
    // Fill artwork: stroke-only props are accepted for call-site compat and
    // dropped, because there is no stroke geometry to scale.
    const Glyph = pair.remix as RemixGlyph
    return createElement(Glyph, {
      ref,
      'data-app-icon': name,
      'aria-hidden': a11y,
      focusable: 'false',
      width: size ?? 24,
      height: size ?? 24,
      className,
      ...rest
    })
  })
  Component.displayName = name
  return Component as IconComponent
}

// Keep semantic component names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle')
/* …the remaining 152 exports, same names, same order… */
```

Special cases that must survive the rewrite verbatim from the current file:

- The `MoreVertical` wrapper (Remix packs no vertical ellipsis, so it rotates the horizontal glyph a quarter turn). Give it a `GLYPHS` row too so it is a circle/ellipsis in both packs, and keep the `rotate-90` class merge.
- `absoluteStrokeWidth` stays accepted and ignored for Remix; for HugeIcons, treat a truthy `absoluteStrokeWidth` as "use the stroke as given" (no relative scaling), matching the pre-Lucide behaviour call sites expect.

Because the table is 153 rows, generate it mechanically rather than hand-typing it: every current `createIcon('X', RiYLine)` becomes a `X: { remix: RiYLine, huge: … }` row. This plan deliberately does not reproduce the 153 recovered rows — they already exist verbatim in the file being rewritten, and re-typing them here would only invite a transcription bug; the mechanical rule plus the both-packs check in Step 6 is what guarantees completeness. Completeness is that check's job, not a human's eye. The 37 names with no history mapping — map each to its nearest HugeIcons glyph by meaning and note the nearest-neighbour decisions in the head comment, exactly as the current file does for `BookDownload`, `Diff`, `Monitor`, `ListTodo`, and `MoreVertical`:

`ArrowDownUp, Bell, BookDownload, BookSearch, Camera, Chart, Chat01, ChevronUp, CommandLine, Dashboard, Database, FolderPlus, History, InstallingUpdates, Keyboard, Layers, ListChecks, Minus, MoreVertical, MousePointer2, MousePointerClick, MusicNote, Printer, Rewind, ScanText, Send, Smartphone, SourceCode, SquareArrowOutUpRight, Stethoscope, Subtitle, TextFont, Timer, Type, Upload, WrapText, XSquare`

- [ ] **Step 5: Make the animated marks follow the pack**

`lib/animated-icons.tsx` currently hardcodes Lucide geometry for `check/minus/cancel/complete/spinner`, so the squircle style would show HugeIcons line art beside Lucide marks. Restructure `artwork` into a per-pack map and select it with `useIconPack()` inside `IconPaths`:

```tsx
const artwork = {
  remix: { check: [/* existing geometry */], /* …minus, cancel, complete, spinner… */ },
  hugeicons: { check: [/* HugeIcons check geometry */], /* … */ }
} satisfies Record<IconPack, Record<string, Node[]>>
```

Keep the `Node` union (`path` with `d`, `circle` with `cx/cy/r`), `MOTION_TAGS`, `IconPaths`, and `AnimatedIcon`'s props and motion ownership exactly as they are — this task changes *which* geometry is drawn, never how it animates. Reduced-motion and the `data-todo-progress` hook must both still hold.

- [ ] **Step 6: Rewrite `check-icons.mjs`**

Three changes:

1. **Delete the two guard assertions** (lines 27 and 31: the `@hugeicons` source scan and the `package-lock.json` scan). The owner overturned them; the reason belongs in `AGENTS.md`, not in a comment here.
2. **Assert both packs for every name.** Parameterize the fixture over the pack: render the full export set twice, once with `pack="remix"` and once with `pack="hugeicons"` (mount `IconPackProvider` in the fixture), and for each pass assert every name renders with `viewBox === '0 0 24 24'`, non-zero geometry, no `NaN`/`null` in any attribute, the decorative-vs-labelled `aria-hidden` default, and ref forwarding — i.e. reuse the existing per-icon assertion loop (line 109) inside a `for (const pack of ['remix', 'hugeicons'])` loop with `pack` in every failure message.
3. **Assert the stroke semantics per pack.** Replace the single "Stroke-only props are dropped" assertion (line 112) with: Remix → no `stroke-width` attribute is rendered; HugeIcons → `stroke-width` is the requested value (and `1.5` by default), with `stroke="currentColor"` and `strokeLinecap="round"`.

Also assert a **live switch**: re-render with the same provider while flipping `pack` and assert the rendered artwork changed identity (e.g. a path `d` differs), which is what proves the context switch works without a reload.

- [ ] **Step 7: Run the icon check**

Run: `node scripts/check-icons.mjs`
Expected: PASS — every one of the 153 names renders in both packs, with the per-pack stroke semantics and the live switch. The failure messages name the missing glyph, which is the checklist for Step 4.

- [ ] **Step 8: Mount the provider and measure the bundle**

In `App.tsx`'s default export:

```tsx
export default function App() {
  const [uiStyle] = useUiStyle()
  return (
    <I18nProvider>
      <ToastProvider>
        <IconPackProvider pack={iconPackOf(uiStyle)}>
          <AppInner />
        </IconPackProvider>
      </ToastProvider>
    </I18nProvider>
  )
}
```

(the `useUiStyle` subscription here is separate from `AppInner`'s on purpose: the pack must wrap every consumer, including the boot/Welcome phase.)

**The bundle gate is a measurement, not a claim.** Record the delta:

```bash
git stash && npm run build && du -sk out/renderer/assets | tail -1 && git stash pop
npm run build && du -sk out/renderer/assets | tail -1
```

Also record the single largest renderer chunk's byte size before and after. Expected: ~100–150 KB for 153 HugeIcons glyphs. **Hard gate:** if the renderer's total asset bytes grow by more than 300 KB, the `GLYPHS` table's `huge` column must move behind a dynamic import resolved lazily when the pack first becomes `hugeicons`, so the square style never ships or parses artwork it cannot render — and in that case add an assertion to `check-icons.mjs` (CDP `Network` events, already used in other checks) that the square style fetches no hugeicons chunk. Record the measured numbers in the commit message either way.

- [ ] **Step 9: Remove the dead dependency**

```bash
grep -rn "lucide-react" src scripts || echo "no lucide-react imports remain"
npm rm lucide-react
```

Expected: only comments mention it (there is at least one in `components/motion/adaptive-stepper.tsx`) — those comments say "instead of native lucide-react" and should be reworded to "instead of the pack's own import path" so they stop naming a dependency that no longer exists. Then `npm run typecheck`.

- [ ] **Step 10: Update `AGENTS.md`'s icon rule**

The icon bullet still says the adapter maps names "onto Lucide artwork" and warns against `@lobehub/icons-static-svg`'s React package. Rewrite it to state: the adapter is `lib/icons.tsx` with a per-pack table (Remix Icon for the square style, HugeIcons for the squircle style), one glyph per pack per semantic name, call sites never change, the pack comes from `lib/icon-pack.tsx`'s context fed by `iconPackOf(uiStyle)`, `lib/animated-icons.tsx` carries per-pack geometry of its own, and **the `@hugeicons` guard was deliberately removed by the owner** (record the decision so nobody restores it by reflex). Keep the existing `@lobehub/icons-static-svg` / `@iconify-json/vscode-icons` / `lib/file-icons.ts` paragraphs as they are.

- [ ] **Step 11: Full verification and commit**

```bash
npm run typecheck && npm run build
node scripts/check-icons.mjs
node scripts/check-corners.mjs
node scripts/check-window-chrome.mjs
node scripts/check-bash-task-ui.mjs
node scripts/check-written-file-preview.mjs
node scripts/check-terminal.mjs
node scripts/check-usage-heatmap.mjs
git add -A
git commit -m "feat(icons): HugeIcons for the squircle style, Remix for square

The adapter keeps all 153 semantic names and becomes a two-pack table
dispatched by a context, so switching is one re-render and no call site
changes. The 116 existing mappings are recovered from
codex/hugeicons-stroke-rounded; 37 are new. Animated marks carry per-pack
geometry so the drawing follows the pack. check-icons now asserts every
name in both packs and drops the @hugeicons guard by owner decision
(recorded in AGENTS.md)."
```

Substitute the two measured bundle numbers into the message before committing (the `du -sk` output from Step 8, plus the largest-chunk sizes). A commit message that says "a bit bigger" instead of the numbers fails this task.
```

---

## Follow-up notes (not tasks in this plan)

- **The squircle style is restored, not designed.** Task 2's screenshot pass is the first look at it since `397f6ed`. Anything it surfaces beyond a token value belongs in its own change.
- **`Switch` stays unrendered** in both styles. If the squircle style should bring the vendored `Switch` back as the on/off control, that is a separate plan: it spans Settings rows, the composer and the transcript.
- **Task 3's frame decision** (circle vs rounded-square frames) must be recorded in the commit message; if it was (b), also note it in `AGENTS.md`'s corner policy.
- **Open, needs the owner's eye (Task 2 reported it):** the heat-calendar activity cells are circles in the squircle style (Task 1's choice, faithful to `397f6ed^`'s live panel look) while the vendored grid's own design used 4px squares (`rounded-detail` already equals 4px in the squircle preset). The Task 2 visual pass could not judge it — the profile had no token activity, so the calendar never painted. Flipping back is `rounded-capsule` → `rounded-detail` in `grid.tsx:109,113`, and it is a square-style no-op either way.
- **Fixture-only curiosity, no app impact:** `#pseudo` in the corners fixture paints a square although `data-[drop=before]:before:rounded-full` applies — `corner-shape` becomes `superellipse(1)` (the check asserts exactly that and passes) but the radius does not paint. No app call site uses a pseudo-element full-round utility, so nothing on screen is affected; worth ten minutes one day, and it means `AGENTS.md`'s "including Tailwind pseudo-element variants" claim is not actually pinned by an assertion.
- **Pre-existing, unrelated to this feature (Task 2 hit it):** the built output carries no `resources/icons` — nothing copies it, and `electron-builder.yml`'s `extraResources` only covers the packaged app — so launching the built app resolves `out/main/resources/icons/512x512.png`, fails in `createWindow`, and never shows a window. `npm run preview` is affected.
- **Native window corners** (`roundedCorners`) remain untouched; the macOS window keeps its own system radius in both styles.
