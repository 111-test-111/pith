# Pith

English | [简体中文](README.zh-CN.md)

Pith is a desktop client for pi-agent, bringing coding conversations, files, terminals and task management into one window. It supports switching between square, rounded and squircle UI styles in Settings → Appearance. Electron hosts the Pi SDK, with a beUI interface built on React and Tailwind CSS.

## Features

- **Projects and conversations**: organize sessions by folder or start a projectless chat; search history, stream responses, inspect thinking and tools, steer, stop, continue, retry and fork.
- **Files and changes**: mention files, attach inputs and preview code, Markdown, math, notebooks, images and PDFs; review turn changes and diffs, and open files delivered by the agent.
- **Git workbench**: inspect repository changes and history, stage or unstage files, review discard confirmations, commit, switch branches and fetch/pull/push from the right panel.
- **Planning and Rewind**: review a submitted plan before explicitly approving execution; capture checkpoints before user messages, restore files, conversations or both, and undo or redo the latest restore.
- **Parallel work**: task lists, managed background commands, independent subagents and scheduled tasks. Inspect, guide or continue subagent work; schedules run while the app is running and the computer is awake.
- **Work panels**: interactive terminals, an embedded browser, a DAP debugger and picture in picture. Browser agent tools require enabling them in Settings and first-use consent; debugging requires enabling it and installing the relevant adapter.
- **Remote work**: model-controlled persistent SSH terminals with password/key/agent login, keepalives and reconnect, visible in the sidebar. Remote tmux preserves jobs and shell state across disconnects; see [SSH setup](docs/ssh-implementation.md).
- **Models and extensions**: API key / OAuth sign-in, custom providers and models, thinking levels, MCP, Skills and Pi extensions; optional Jev judgments and workflow integration.
- **Run records**: inspect model requests, tool execution, context estimates, token usage and costs, and export execution records.
- **Appearance and language**: English / Simplified Chinese, light / dark / system themes, accent colors, and square / rounded / squircle interface styles.

## Run from source

You need **Node.js 22.19 or later**, npm and Git. Installation downloads dependencies and Electron. If native dependencies cannot use prebuilt binaries, install your platform's C/C++ build tools. Model requests require a configured provider account or API key.

```bash
npm ci
npm run dev
```

Install scripts apply compatibility patches for the pinned Pi SDK, prepare the terminal's native helpers and generate file-type icons. Keep these scripts enabled; do not pass `--ignore-scripts`.

After launching, sign in or configure a model under **Settings → Providers**. Open a project folder or create a projectless chat, then select a model and permission mode in the composer. The right panel contains terminals, file previews and the execution trajectory.

Pith reuses Pi's local configuration: sessions live in `~/.pi/agent/sessions/`, authentication in `~/.pi/agent/auth.json`, and custom providers and models in `~/.pi/agent/models.json`. App preferences, browser data and local indexes live in `pi-app/` under the system application-data directory. The Pith rename preserves that directory.

Permission modes primarily constrain local file operations by the app's own tools. Networking, arbitrary extensions / MCP, user terminals and debug targets have separate boundaries. Plan Mode does not provide system-wide or network isolation. See the [development documentation](docs/README.md) for details.

## Development

For Windows and Parallels guests, see the [Windows development guide](docs/windows-development.md).

```bash
npm run dev          # Development mode with HMR
npm run typecheck    # Check main, preload and renderer types
npm run build        # Production build in out/
npm run preview      # Launch the built app
npm run clean        # Remove outputs, caches and generated assets; keep dependencies
```

Run `npm test` for the unified regression suite, or `npm run test:core` / `npm run test:ui` for a specific layer. The runner prepares once, isolates fixtures and writes JSON/JUnit reports and logs to `.test-results/`. Performance and real-provider tests are explicit separate groups. See the [testing guide](docs/testing.md) for selection, prerequisites, CI and coverage limits.

After verification, `npm run clean` returns the checkout to an unbuilt state. The next development or build run regenerates the required file-type icons.

| Directory | Purpose |
| --- | --- |
| `src/main/` | Electron lifecycle, Pi SDK, tools and background services |
| `src/preload/` | Typed IPC exposed through `window.pi` |
| `src/shared/` | Cross-process DTOs and shared protocols |
| `src/renderer/src/` | React UI, state, themes and English / Chinese messages |
| `scripts/` | Asset generation, compatibility preparation and checks |
| `resources/` | Brand SVGs and native packaging icons |
| `docs/` | Architecture, feature boundaries and verification guides |

Use beUI components and place app compositions in `components/app/`. Add every new user-visible string to both the English and Simplified Chinese dictionaries. The main process owns the SDK and system capabilities; the renderer accesses them only through preload IPC. See [AGENTS.md](AGENTS.md) for the full contribution rules.

UI glyphs use Remix Icon Line in the square interface and Hugeicons Stroke Rounded in rounded and squircle interfaces, through one semantic adapter. Remix drawings favour centered, compact silhouettes and retain their native filled outlines; its Remix Icon License v1.0 ships in `src/renderer/public/licenses/remix-icons.txt`. Shortcut keycaps use a small local Lucide SVG subset without an additional dependency, with original artwork and licenses in `src/renderer/public/lucide-keycaps/`. File-type icons use app-owned square Pierre adaptations in square and native Codex Pierre Icons with a local Sass override in rounded and squircle, with local document/media additions and the same Pierre light/dark palette. Brand and provider marks retain their own SVGs. Original artwork and licenses are vendored in `resources/bearded-icons/` (GPL-3.0) and `resources/pierre-icons/` (Apache-2.0); additions and overrides live separately in `resources/pierre-icons-extensions/`, and square adaptations in `resources/pierre-icons-square/` with their own attribution notices. Selected language/brand icons retain their complete native artwork in all three styles. Bearded artwork/maps remain available for rollback. `npm ci`, development and builds prepare `src/renderer/public/file-icons/` offline, including licenses and addition notices; this generated directory stays outside version control. See [file icons](docs/file-icons.md) for exceptions and snapshot maintenance.

## Packaging

```bash
npm run pack         # Unpacked app for the current platform
npm run dist:mac     # DMG + ZIP
npm run dist:win     # NSIS installer
npm run dist:linux   # AppImage + deb
```

Packaging scripts build first and write artifacts to `dist/`. Configuration covers macOS, Windows and Linux. Validate native dependencies, terminals and sandbox behavior on the target platform before release. The distributor supplies signing and macOS notarization credentials.

`resources/pith.svg` is the native application icon master. `npm run icons` regenerates the tracked PNG, ICO and ICNS assets. `resources/pith-square.svg` provides the hard-edge tile variant. The new-chat header uses the background-free `resources/pith-mark.svg`, tinted with the live app accent in every interface style. Dock and packaging icons use the rounded master. Routine builds do not need to regenerate native icons.

## Documentation and license

[docs/README.md](docs/README.md) indexes the development documentation; [AGENTS.md](AGENTS.md) defines repository contribution rules. Pith uses the [MIT License](LICENSE). Third-party dependencies and assets retain their own licenses.
