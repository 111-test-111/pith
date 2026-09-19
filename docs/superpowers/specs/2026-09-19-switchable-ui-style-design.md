# Switchable UI style: square ⇄ squircle, with a matching icon pack

- **Status:** awaiting review (no code written yet)
- **Branch:** `experiment/ui-style-presets`, based on `f51fd61` (`experiment/square-carbon-style`)
- **Owner decisions already taken:** the preference is **global** (app-wide, like accent/theme, not per project or per session); the `@hugeicons` guard in `check-icons.mjs` is **overturned** deliberately.

## 1. Summary

One renderer preference, `uiStyle: 'square' | 'squircle'`, chosen in **Settings → Appearance**. It drives two things that can never desync because both are derived from it:

1. **Geometry** — the corner-radius scale (and the affordances that are capsule/circular by design) through CSS custom properties on `documentElement`.
2. **Icon pack** — `square` → Remix Icon (already in place), `squircle` → HugeIcons.

Both apply immediately, with no reload and no restart. The default stays `square`, so landing this changes nothing visually until someone switches.

The square look stays the current branch's look; the squircle look is a *restored* look, recovered from `397f6ed^` (the parent of the commit that squared everything).

## 2. Goals and non-goals

**Goals**

- A user-selectable UI style covering radius scale, capsule-by-design affordances, selection-control marks, and the icon pack.
- A mechanism that does not fork every call site: a geometry change must be a token/preset change, as it already is.
- Both styles pinned by the existing checks, so neither rots.
- Fix the geometry-policy debt that a second preset would otherwise encode: literal radii in `pdf-viewer.css`, and `guard()`'s blind spot for CSS-form literals.

**Non-goals (explicit)**

- Restoring the vendored `Switch`: every on/off control stays the `mark`-based checkbox in both styles (there are zero `Switch` call sites).
- Restoring the vendored 20px box with the 9px check glyph. **Owner decision:** the squircle mark is a *fully circular point*, not the check glyph, and the square style keeps its square point (see §4.4).
- Per-project or per-session style.
- The native window's own corner radius (`roundedCorners`) — untouched.
- `components/previews/**` (not shipped).
- Message-body typography, colors, and everything else that is not geometry or icon artwork.

## 3. Current state (measured)

| Fact | Evidence |
| --- | --- |
| The corner scale is already 7 custom properties | `styles.css:35-43` (`detail/inner/item/control/icon/card/window`) |
| Tailwind's scale resolves through them at runtime | `styles.css:229` is `@theme inline`; `--radius-xs…4xl` all `var(--app-radius-*)` (`styles.css:250-264`) |
| Runtime token changes already work in every surface | `check-corners.mjs:316` sets `--app-radius-control/window/inner` at runtime and asserts all corners, a portal-mounted modal and the moving tab indicator follow |
| Accent is the exact precedent for a global visual preference | `App.tsx:13-44` (localStorage + `dataset.accent`), `styles.css:163-215` (`[data-accent=…]`), `AppearanceSection.tsx:145` |
| The glass/sound/verb prefs are the precedent for a subscribable store | `lib/sidebar-glass.ts` (`useSyncExternalStore` + localStorage), default-on pattern |
| The squircle values are recoverable verbatim | `git show 397f6ed^:src/renderer/src/styles.css` → `detail 4px, inner 10px, item 14px, card 20px, window 28px` |
| `rounded-full` is a fixed circle in both presets | `styles.css:288` (`--app-radius-full: 9999px`, `!important` + `corner-shape: round`) |
| The icon layer is one funnel, already on Remix | `lib/icons.tsx`, 153 exports, all through `createIcon()`; **no file imports an icon package any more** (only comments mention `lucide-react`) |
| A complete HugeIcons mapping already exists in history | `codex/hugeicons-stroke-rounded:src/renderer/src/lib/icons.tsx` — 116 of today's 153 names mapped, `@hugeicons/react` + `@hugeicons/core-free-icons ^4.3.2 / ^1.1.10` |
| HugeIcons is currently forbidden by a check | `check-icons.mjs:27` (any source file) and `:31` (`package-lock.json`) assert `@hugeicons` absent |
| `lucide-react` is now a dead dependency | `package.json` still lists `^1.46.0`; nothing imports it |
| The animated marks use a third geometry source | `lib/animated-icons.tsx:5-31` — Lucide `d` strings hardcoded, so they do not follow the adapter today |

## 4. Design — geometry

### 4.1 Token layer

`styles.css` keeps the square values in `:root` and adds one preset block:

```css
/* restored squircle style — values recovered from 397f6ed^ */
[data-corners='squircle'] {
  --app-radius-detail: 4px;
  --app-radius-inner: 10px;
  --app-radius-item: 14px;
  --app-radius-card: 20px;
  --app-radius-window: 28px;
  --app-radius-capsule: 9999px;
}
```

Plus one new token in `:root`:

```css
--app-radius-capsule: 0px;   /* square: the affordance's shape collapses */
```

`--app-corner-shape: squircle` stays as it is in both presets: at radius 0 it is a no-op, so right angles are right angles either way.

**Source order is load-bearing.** The preset block has the same specificity as `:root` (0,1,0), so it wins only by coming later in the file — exactly how the existing `[data-accent=…]` blocks already work (`:root` at line 29, presets from line 163). A future reorder above `:root` would silently disable the whole preset; the parameterized `check-corners` run is what would catch it.

### 4.2 `rounded-capsule` — the mechanism that avoids forking call sites

New utility next to `rounded-full` (`styles.css:288`), with the same `!important` rationale documented there:

```css
@utility rounded-capsule {
  border-radius: var(--app-radius-capsule) !important;
  corner-shape: round !important;
}
```

**The equivalence that makes this safe:** in the square preset `--app-radius-capsule` is `0px`, which is *exactly* what `rounded-control`/`rounded-item` resolve to today. So landing the changes in §4.3 is pixel-identical in the default style; the difference only appears once the user picks the squircle style. This is the same property `check-corners.mjs:316` already relies on.

Two rules, and they are the whole policy:

- `rounded-full` = **always** a true circle (status/legend dots, activity indicators, loader artwork, ripples, favicon avatars).
- `rounded-capsule` = **the shape follows the style** (avatars, icon-size controls, chips, badges, pill tabs, attachment/remove badges, and the selection-control marks in §4.4).

### 4.3 The three classes of de-capsuled surfaces

`397f6ed` changed 23 component files. They split three ways; only the first is work.

**Class A — the shape follows the style (16 files, mechanical `rounded-*` → `rounded-capsule`):**

| File | Site |
| --- | --- |
| `agents/approval-card/index.tsx` | size-5 icon control |
| `agents/code-block.tsx` | size-7 copy control |
| `agents/message.tsx` | size-7 avatar |
| `agents/prompt-input.tsx` | size-8 ×2 (send/add controls) |
| `app/AuthBridge.tsx` | size-5 step badge |
| `app/Composer.tsx` | size-5 attachment-remove badge |
| `app/ContextRing.tsx` | size-8 ring trigger |
| `app/EditMessageDialog.tsx` | size-5 remove badge, size-4 dismiss |
| `app/settings/AppearanceSection.tsx` | size-8 accent swatch |
| `app/settings/ExtensionsSection.tsx` | size-4 remove control |
| `app/settings/usage/TokenActivityPanel.tsx` | **stale entry — do not use.** Its radius classes moved to the vendored `charts/heat-calendar/grid.tsx` in `5c66d8f`, and the file carries no radius class at all now |
| `motion/animated-badge.tsx` | badge capsule + inner `rounded-inherit` |
| `motion/animated-toast-stack.tsx` | icon tile, action pill, dismiss |
| `motion/button/metallic.tsx` | `size === 'icon'` |
| `motion/expandable-control.tsx` | chip (h-11/h-10), action (w-8) |
| `motion/tabs.tsx` | `pill` variant (list + indicator) |

The vendored files keep their `// local patch (pi-app):` markers, updated to say the shape now comes from the preset.

Every site must be re-read from the **current** file before editing, not from the diff: later commits have touched several of these files.

**Pinned during execution:** the activity cells' live site is `charts/heat-calendar/grid.tsx` (cell hit area + cell visual), not the `TokenActivityPanel.tsx` row above. Evidence for the shape choice: at `397f6ed^` the panel's OWN cells were `rounded-full` — circles were the live squircle look — while the vendored grid has carried `rounded-detail` since it landed. So `rounded-capsule` restores the panel's own pre-square look; 4px squares in the squircle style stay a one-word alternative if they read better with data on screen.

**Class B — already preset-correct, no change (2 files):** `agents/ai-sidebar.tsx` (2px drop strips) and `motion/loader.tsx` (progress bar). `rounded-detail` and a full circle clamp to the same 1–2px on a 1–2px-tall element, so these two read identically in both styles.

**Class C — icon import source only, geometry untouched (5 files):** `motion/adaptive-stepper.tsx`, `motion/command-palette.tsx`, `motion/context-menu.tsx`, `motion/multi-select/list.tsx`, `motion/multi-select/trigger.tsx`.

### 4.4 Selection-control marks

**Owner decision (asked and answered):** the circular point is **only** for the squircle style; the square style keeps today's square point.

So the on-state point joins the style dimension through the same token, with no per-style conditionals:

| Site | Today | After |
| --- | --- | --- |
| `motion/checkbox.tsx:99` — the `mark="square"` point | `className="size-1.5 bg-primary"` (no radius class, deliberately) | `className="size-1.5 rounded-capsule bg-primary"` |
| `motion/radio.tsx:140` — the radio point | `className="size-1.5 rounded-control bg-primary"` | `className="size-1.5 rounded-capsule bg-primary"` |

Consequences to verify on the screenshot pass rather than assume:

- **The frames are a separate question.** Both controls' boxes are `size-3.5` (14px) with `rounded-control`; under the squircle preset `--app-radius-control` is 14px, which on a 14×14 box renders a **full circle** — so the squircle checkbox becomes a circle-frame-with-dot and the radio likewise. That is not a restoration (the pre-square control was a 20px box with a 10px radius, a *rounded square*), so the screenshot pass decides explicitly between (a) accepting the circle and (b) pinning the frames to `rounded-inner`/`rounded-item` so they stay rounded squares. Record the outcome in the plan's follow-up notes; do not let it happen silently.
- **`data-checkbox-square` becomes a lie in one style.** It is currently the check's hook for the mark. Rename it to `data-checkbox-mark` and update every reference (`check-corners.mjs`, `check-tools-settings`-family checks, `check-ask-user-ui`) in the same commit, so the hook stops naming a shape.
- The square style must remain pixel-identical: `rounded-capsule` is `0px` there, which is exactly what "no radius class" and `rounded-control` resolve to today.

### 4.5 Literal radii in `pdf-viewer.css`

`pdf-viewer.css` is the only CSS in the app with literal radii and it is also invisible to `guard()`:

- Map the three `border-radius:2px` rules (annotation text/choice/checkbox hover & focus, lines 375/382/395) to `var(--app-radius-detail)`.
- Leave the two `border-radius:50%` rules (PDF radio widgets, 353/432): those draw a *document's* form control, not app chrome.
- Extend `guard()` in `check-corners.mjs` to also reject CSS-form literals (`border-radius:\s*[1-9]`), which is what let these survive in the first place.

### 4.6 State and wiring

New `src/renderer/src/lib/ui-style.ts`, modelled on `lib/sidebar-glass.ts` (subscribable store + localStorage, lazily initialized so import never touches storage):

```ts
export type UiStyle = 'square' | 'squircle'
const STORAGE_KEY = 'pi-app:ui-style'
export function useUiStyle(): [UiStyle, (next: UiStyle) => void]
export function applyUiStyle(style: UiStyle): void  // sets BOTH derived attributes
```

`applyUiStyle` is the only place the two dimensions are resolved, and it writes the two derived DOM attributes:

- `document.documentElement.dataset.corners` = the style (`square` default, so an unset attribute and `'square'` mean the same thing)
- `document.documentElement.dataset.iconPack` = `'remix' | 'hugeicons'` (derived, never stored separately)

Wiring, mirroring accent exactly:

- `App.tsx:43` gets a sibling effect: `useEffect(() => applyUiStyle(uiStyle), [uiStyle])`, next to `applyAccent`.
- The icon pack additionally needs to reach every glyph in the tree (Welcome/boot phase included, portals included), so `App.tsx` wraps its subtree in an `IconPackProvider` fed by the same store — see §5.3. Prop-drilling is deliberately not used for that half.
- `Workspace` → `SettingsPage` → `AppearanceSection` receive `uiStyle`/`onUiStyleChange` the same way `accent` does (`App.tsx:113`, `Workspace.tsx:126/169`, `SettingsPage.tsx:23/59`).

### 4.7 Settings UI and i18n

A new `SettingsGroup` in `AppearanceSection`, using the same control family the theme/locale rows use (`RadioGroup` + `RadioGroupItem`, hard-edged per the corner policy), two options:

- 直角 (square) — current style
- 超椭圆 (squircle) — restored style

New keys in **both** `i18n/locales/en.ts` and `zh-CN.ts` (the `Messages` type makes a missing key a typecheck error): group title, description, and the two option labels.

## 5. Design — icons

### 5.1 One setting, two derived dimensions

The icon pack is **not** a second preference: it is a function of `uiStyle`, so the pack can never disagree with the geometry. The alternative (two independent knobs) was rejected: it allows a mismatched combination that nobody asked for and doubles the setting surface.

### 5.2 Dependencies

- Add `@hugeicons/core-free-icons@^4.3.2` and `@hugeicons/react@^1.1.10` (the versions the old branch pinned).
- Remove `lucide-react` (verified: no imports anywhere, only comments).

### 5.3 `lib/icons.tsx` becomes a two-pack table

The file stays the single funnel and keeps its 153 semantic export names, so **no call site changes**:

```tsx
const GLYPHS = {
  AlertCircle: { remix: RiAlertLine, huge: AlertCircleIcon },
  …
} satisfies Record<string, { remix: RemixGlyph; huge: HugeGlyph }>

export const AlertCircle = createIcon('AlertCircle')
```

`createIcon(name)` renders the glyph selected by the icon-pack context. The wrapper keeps the existing contract (`IconProps`, `data-app-icon`, decorative-by-default `aria-hidden`, ref forwarding) and becomes pack-aware for the one prop the packs disagree about:

- Remix (fill artwork): `strokeWidth`/`absoluteStrokeWidth` accepted and dropped — today's behaviour.
- HugeIcons (stroke artwork): `strokeWidth` is applied (default 1.5) and `size` is passed through.

Switching the context value re-renders the consumers once, so the pack flips live; there is no reload path and no `location.reload()`.

### 5.4 The mapping

Recovered from `codex/hugeicons-stroke-rounded:src/renderer/src/lib/icons.tsx` (116 of today's 153 names already mapped, hand-checked there). The 37 to add, which must be mapped by meaning (and verified by the check that every name renders in both packs):

`ArrowDownUp, Bell, BookDownload, BookSearch, Camera, Chart, Chat01, ChevronUp, CommandLine, Dashboard, Database, FolderPlus, History, InstallingUpdates, Keyboard, Layers, ListChecks, Minus, MoreVertical, MousePointer2, MousePointerClick, MusicNote, Printer, Rewind, ScanText, Send, Smartphone, SourceCode, SquareArrowOutUpRight, Stethoscope, Subtitle, TextFont, Timer, Type, Upload, WrapText, XSquare`

Same rules as the current file's comment block: names that only ever had a nearest-neighbour stay mapped by hand and documented in the file, and the semantic export names never change.

### 5.5 Animated marks follow the pack too

`lib/animated-icons.tsx` hardcodes Lucide geometry for `check/minus/cancel/complete/spinner`. If it is left alone, the squircle style shows Remix/HugeIcons line art beside Lucide-derived marks. Change it to a per-pack geometry map (`{ square: {...}, squircle: {...} }`) sourced from each pack's own glyph data, keeping `IconPaths`/`AnimatedIcon`'s motion ownership, tag-per-node rendering, and reduced-motion behaviour unchanged.

### 5.6 Bundle size is a gate, not an assumption

Two icon packs in the renderer bundle is the one real unknown, and HugeIcons' free package is large. The work must **measure** `npm run build` renderer chunk bytes before and after and record the delta in the PR/commit message. If tree-shaking does not hold the cost within a reasonable budget, the fallback (decided in the plan, not here) is to keep HugeIcons out of the main chunk via a lazy boundary around the adapter's huge branch. "It's a bit bigger" is not acceptable as an unmeasured claim.

## 6. Verification

Both styles must be pinned, or the style nobody uses rots. Per repo convention, in addition to `npm run typecheck && npm run build`:

- **`check-corners.mjs`** — parameterize over both presets: square asserts `0px` everywhere in the scale, squircle asserts the recovered values on the same selectors; the existing live-token, portal, animation-frame, geometry and a11y assertions run under both; the selection-control hard-edge assertion holds in both (they are `rounded-control`, not capsule). Add a `rounded-capsule` assertion per preset (square → 0px, squircle → capsule) over a capsule site (the composer send control is the natural one) **and** over the selection marks of §4.4 (square style → `0px`, squircle → a point whose radius is half its box; the frame's geometry is asserted separately once §4.4's screenshot decision is made). Extend `guard()` per §4.5.
- **`check-icons.mjs`** — remove the two `@hugeicons` assertions; assert **every** export renders in **both** packs (24×24, real geometry, no `NaN`, decorative/labelled a11y, ref forwarding), that stroke props are dropped for Remix and applied for HugeIcons, and that switching the pack flips the rendered artwork live.
- **Shared-path regressions** required by AGENTS.md whenever global geometry changes: `check-window-chrome.mjs`, `check-bash-task-ui.mjs`, `check-written-file-preview.mjs`, `check-terminal.mjs`, plus `check-usage-heatmap.mjs` (the activity cells are Class A).
- **Docs, in the same change:** `AGENTS.md`'s corner-scale paragraph (`:38`) and `README.md:19` are already stale against the square values; rewrite them to describe the preset model, the `rounded-capsule` rule, and the icon-pack switch. `check-icons`' "no HugeIcons" guard is removed *because* the owner overturned it, and that reasoning belongs in `AGENTS.md` so nobody restores the guard by reflex.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| HugeIcons bundle growth | §5.6 measured gate |
| Check assertions that hardcode `0px` (e.g. send control "hard-edged") fail in squircle | parameterize by preset; the failure is the point, not a nuisance |
| A Class A site has drifted since `397f6ed` | re-read each site from the current file before editing |
| The squircle preset is *restored*, not designed — nobody has looked at it since `397f6ed` | manual pass with screenshots in both themes after the token layer lands, before the icon work |
| Vendored `local patch` markers multiply | keep the marker text one line, pointing at the preset rule |
| Two packs in one file hides a missing mapping | the all-names × both-packs check in §6 |

## 8. Suggested commit sequence

Steps 1–3 (the geometry half) are independently shippable and independently verifiable. If step 4's bundle measurement in §5.6 fails, the style preset still lands with the square style's icon pack in both modes — the feature degrades, it does not block.

1. `refactor(geometry): rounded-capsule token + Class A call sites` — pixel-identical in the default style; checks still green.
2. `feat(settings): uiStyle preference (data-corners preset + Appearance row + i18n)` — squircle reachable for the first time; screenshots.
3. `feat(controls): selection marks follow the style (circular point in squircle only)` + `test(corners): guard() covers CSS literals; pdf-viewer literal radii mapped`.
4. `feat(icons): two-pack adapter + HugeIcons mapping + animated marks` — includes the bundle measurement and the `lucide-react` removal.
5. `test(icons): both packs asserted; @hugeicons guard removed` + `docs: AGENTS.md/README geometry rewrite`.
