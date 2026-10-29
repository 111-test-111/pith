# Third-party notices

Pith's first-party source code is licensed under the [MIT License](LICENSE), Copyright © 2026 Pith contributors. That license does not cover the upstream code and artwork described here, and this repository is not MIT-licensed as a whole. Each entry below records the upstream project, the copyright holder, the license that applies, the in-tree scope, and where the complete license text is kept.

Packaged builds include this file, [LICENSE](LICENSE) and [LICENSES/](LICENSES/) inside the application archive configured in `electron-builder.yml`. Renderer-shipped licenses under `src/renderer/public/` are copied into the built renderer output.

## Vendored and ported source code

### Pi SDK — `@earendil-works/pi-coding-agent` 1.0.0

- Upstream: https://github.com/earendil-works/pi
- Copyright © 2025 Mario Zechner
- License: MIT — [LICENSES/pi-sdk-MIT.txt](LICENSES/pi-sdk-MIT.txt)
- Scope: runtime dependency that provides the agent engine, session format, tools and native MCP. It is installed from npm rather than vendored, with local compatibility patches applied by `scripts/prepare-pi-sdk.mjs`; patched files remain subject to the upstream MIT terms.
- Pi is an upstream project. Pith is an independent client and is not endorsed by or affiliated with its authors.

### beUI — vendored component source

- Upstream: https://github.com/starc007/ui-components
- Copyright © 2026 Saurabh Chauhan
- License: MIT — [LICENSES/beui-MIT.txt](LICENSES/beui-MIT.txt)
- Scope: UI primitives copied into `src/renderer/src/components/motion/`, `src/renderer/src/components/agents/` and `src/renderer/src/components/charts/`, together with their helpers and registry samples under `src/renderer/src/components/previews/`. Files retain their `beui.dev` source markers; app-specific edits are marked `// local patch (pi-app):`. `scripts/beui-add.mjs` fetches registry components for maintenance and never overwrites existing files.

### pi-web — ported modules

- Upstream: https://github.com/agegr/pi-web
- Copyright © 2026 agegr
- License: MIT — [LICENSES/pi-web-MIT.txt](LICENSES/pi-web-MIT.txt)
- Scope: modules marked "Ported from pi-web" in their headers, including:
  - sandbox vocabulary and escalation: `src/main/sandbox/types.ts`, `src/main/sandbox/escalation.ts`
  - ask-user and tool plumbing: `src/main/pi/ask-user.ts`, `src/main/pi/file-tools.ts`
  - skills, usage and scheduling: `src/main/pi/skill-frontmatter.ts`, `src/main/pi/usage.ts`, `src/main/pi/usage-stats.ts`, `src/main/pi/scheduled-tasks/{service,store,tool}.ts`, `src/shared/scheduled-tasks.ts`, `src/shared/ask-user.ts`
  - renderer helpers and panels: `src/renderer/src/lib/{spinner-verbs,tool-schema,usage-view,usage-stats-store}.ts`, `src/renderer/src/lib/browser/{session,open-link,zoom,device}.ts`, `src/renderer/src/components/app/BrowserAnnotate.tsx`, `src/renderer/src/components/app/settings/usage/{TokenActivityPanel,UsageTrendsPanel}.tsx`

### DeepSeek Harness (DSH) — sandbox provider port

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Copyright © 2026 DeepSeek
- License: MIT — [LICENSES/deepseek-harness-MIT.txt](LICENSES/deepseek-harness-MIT.txt)
- Scope: `src/main/sandbox/local.ts` ports DSH's local sandbox provider and runner chain. The optional native helper packages `@deepseek-ai/node-addon-landlock-run` and `@deepseek-ai/dsh-sandbox-windows-acl` are installed from npm and carry their own licenses in their package metadata; the DSH MIT text does not replace those terms.

### ZCode — Git graph layout

- Upstream: https://github.com/zai-org/ZCode
- Copyright © 2026 Z.AI Co., Ltd.
- License: Apache-2.0 — full text and attribution in [src/renderer/public/licenses/zcode-git-graph.txt](src/renderer/public/licenses/zcode-git-graph.txt)
- Scope: `src/renderer/src/components/app/git/graph-layout.ts` and `graph-layout-model.ts` adapt ZCode's Git graph layout with Pith's shared DTOs and windowed path bounds.

## Artwork, icons and fonts

### Pierre file-type icons

- Upstream artwork: `@pierre/trees` 1.0.0-beta.4, https://pierre.co
- Copyright © 2025 Pierre Computer Company
- License: Apache-2.0, with the upstream headless-tree MIT notice — [resources/pierre-icons/LICENSE.txt](resources/pierre-icons/LICENSE.txt), [resources/pierre-icons/NOTICE.txt](resources/pierre-icons/NOTICE.txt), [resources/pierre-icons-square/LICENSE.txt](resources/pierre-icons-square/LICENSE.txt), [resources/pierre-icons-square/UPSTREAM-NOTICE.txt](resources/pierre-icons-square/UPSTREAM-NOTICE.txt)
- Scope: original SVGs in `resources/pierre-icons/` and `resources/pierre-icons-square/`; upstream SVG paths, viewports and opacity are retained. Pith document/media additions, artwork overrides and the square Sass override are recorded separately in [resources/pierre-icons-extensions/NOTICE.txt](resources/pierre-icons-extensions/NOTICE.txt) and [resources/pierre-icons-square/EXTENSIONS-NOTICE.txt](resources/pierre-icons-square/EXTENSIONS-NOTICE.txt). `scripts/prepare-file-icons.mjs` copies this license/notice set into generated `src/renderer/public/file-icons/pierre/` and `pierre-square/`, so packaged renderer assets carry them. Adapted artwork remains subject to the Apache-2.0 terms above; independently drawn Pith additions are first-party MIT.

### Bearded Icons — retained snapshot (GPL-3.0)

- Upstream: https://github.com/BeardedBear/bearded-icons, version 1.22.0, revision `8807eb4562da44eeaf0a6b24e028d67d4e461d7b`
- Copyright: BeardedBear (see the retained NOTICE)
- License: **GNU General Public License v3.0** — complete text in [resources/bearded-icons/LICENSE.txt](resources/bearded-icons/LICENSE.txt); provenance and scope in [resources/bearded-icons/NOTICE.txt](resources/bearded-icons/NOTICE.txt)
- Scope: `resources/bearded-icons/` holds the original SVGs, filename/extension maps and notices unchanged as a retained fallback set. `scripts/prepare-file-icons.mjs` still reads this snapshot and copies every reachable icon plus both license files into the generated `src/renderer/public/file-icons/` directory, which is included in renderer builds and packaged applications. GPL-3.0 therefore applies to those icon files and to the generated copies; they must not be redistributed under Pith's MIT license or without the accompanying GPL text. Corresponding source is this repository's `resources/bearded-icons/` directory and the upstream revision linked above.

### Lucide and Feather shortcut keycap icons

- Upstream: https://github.com/lucide-icons/lucide (via `lucide-static` 1.50.0), with Feather-derived icons from https://github.com/feathericons/feather
- Copyright © 2026 Lucide Icons and Contributors; Feather-derived icons © 2013-present Cole Bemis
- License: ISC for Lucide artwork and MIT for the listed Feather-derived icons — [src/renderer/public/lucide-keycaps/LICENSE.txt](src/renderer/public/lucide-keycaps/LICENSE.txt), provenance in [src/renderer/public/lucide-keycaps/NOTICE.txt](src/renderer/public/lucide-keycaps/NOTICE.txt)
- Scope: the shortcut-keycap SVG subset in `src/renderer/public/lucide-keycaps/`, consumed through the app's semantic icon adapter without a Lucide runtime dependency.

### Remix Icon

- Upstream: https://github.com/Remix-Design/RemixIcon
- Copyright © 2017–2026 Remix Design
- License: **Remix Icon License v1.0** — [src/renderer/public/licenses/remix-icons.txt](src/renderer/public/licenses/remix-icons.txt)
- Scope: square-interface UI glyphs loaded through `@remixicon/react`. This is a dedicated icon license, not MIT; its restrictions, including those on competing icon libraries and brand marks, continue to apply.

### TeX Gyre DejaVu Math

- Upstream: https://www.gust.org.pl/projects/e-foundry/tex-gyre-math
- Authors: Bogusław Jackowski, Piotr Strzelczyk and Piotr Pianowski; Bitstream Inc.; DejaVu changes are in the public domain
- License: GUST Font License (an instance of LPPL) plus the Bitstream/DejaVu notice — [src/renderer/public/licenses/tex-gyre-dejavu-math.txt](src/renderer/public/licenses/tex-gyre-dejavu-math.txt)
- Scope: `texgyredejavu-math.woff2` in `src/renderer/src/assets/math/`, a lossless WOFF2 re-encoding of upstream version 1.106, registered as `Pith Math` and shipped with the renderer.

## npm dependencies

Third-party packages installed from npm are not vendored in this repository and keep the licenses declared by their own distributions. Consult each package's license at install time. Notable obligations include `@resvg/resvg-js` (MPL-2.0), `elkjs` (EPL-2.0, used by `@mermaid-js/layout-elk`), and dual-licensed packages whose notices must be preserved when redistributing binaries. Nothing in Pith's root MIT license relicenses those packages.
