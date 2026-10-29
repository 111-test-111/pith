# Technical documentation

Start with [README](../README.md) for the product, setup and development commands, [AGENTS.md](../AGENTS.md) for contributor constraints and regression checks, [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for in-tree third-party attribution, and [LICENSE](../LICENSE) for first-party licensing. This directory keeps current implementation contracts and reproducible verification instructions, without historical plans, handoffs or machine-specific acceptance reports.

## Architecture

- `src/main/`: Electron main process, Pi SDK, files/processes, sandbox and persistence; `src/main/pi/manager.ts` coordinates session lifecycle.
- `src/shared/types.ts`: IPC DTO entry point; `src/preload/index.ts` exposes the typed `window.pi` bridge.
- `src/renderer/src/`: React, beUI, theme tokens and English/Simplified Chinese i18n; `state/pi-store.ts` projects snapshots/events into UI state.
- `scripts/check-*.mjs`: isolated SDK, filesystem, protocol and Electron/CDP regressions. Source code is authoritative for behavior.

## Sessions and execution

| Document | Contract |
| --- | --- |
| [Plan Mode](plan-mode-implementation.md) | Read-only planning, sealed submissions, approval and recovery |
| [Session goals](goals-implementation.md) | Composer activation, live definition edits, criterion proofs, shared parent/child/Jev quotas and process recovery |
| [Goals next steps](goals-next-steps.md) | Implemented evidence/recovery/Fork/owned-work billing; next bounded diagnostics and quality evaluation |
| [Rewind](rewind-implementation.md) | Before-turn checkpoints, raw-byte transactions, partial/single-file restore |
| [Git workbench](git-workbench.md) | Repository status, safe staging/discard, commits, branches, history, multi-branch graph and remote operations |
| [Subagents](subagents-implementation.md) | Role grants, persisted runs, notifications and recovery |
| [Native MCP / codemode](native-mcp-codemode.md) | SDK MCP configuration, scripts and result contracts |
| [DAP debug](debug-implementation.md) | Target ownership, stopped references, native/core inspection |
| [Embedded browser](architecture/embedded-browser.md) | webview/CDP hosting, tools, trust boundaries and cleanup |
| [Image generation](image-generation.md) | OpenRouter protocols, atomic image files, billing, generated delivery and private retries |
| [Jev integration](jev-integration.md) | Judgment tools, optional workflow and evidence |
| [Jev tool reference](jev-tool-reference.md) | Native parameters/examples used by the Pi skill bridge |

## Context, diagnostics and UI

| Document | Contract |
| --- | --- |
| [Context budget](context-budget-implementation.md) | Request-copy budgets and image safety |
| [Context compaction](context-compaction.md) | Queued manual summaries, completed tool boundaries, process visualization and cancellation |
| [Context statistics](context-statistics-implementation.md) | Billing, selected-branch projections and observed request composition |
| [Resource usage](resource-usage.md) | CPU and resident-memory sampling, process-tree scope and exact local storage measurements |
| [System prompt](system-prompt.md) | Concise runtime guidance and on-demand tool instructions |
| [Delivery / trajectory](present-trajectory-implementation.md) | File delivery, recorded requests, paging and exports |
| [Library](library-implementation.md) | Conversation resources, local copies, projects, archive quota and recovery |
| [Session replay](session-replay-implementation.md) | Offline SDK/provider-boundary replay |
| [Long-session benchmark](long-session-benchmarks.md) | Reproducible performance measurement and interpretation |
| [Sidebar panes](sidebar-pane-layout.md) | Container layouts and state preservation |
| [File previews](file-preview.md) | Bounded archive/data readers, structured trees, automatic text decoding, cached diffs and worker lifetimes |
| [Session sidebar](session-sidebar.md) | Projects, custom groups, timeline, archive and presentation preferences |
| [Floating surface motion](overlay-motion.md) | Shared picker, menu, tooltip and dialog entrances, exits and reduced motion |
| [Typography](typography.md) | Independent interface/content/code sizes, text ownership, line metrics and persistence |
| [Code highlighting](code-highlighting.md) | Shared light/dark palettes, searchable theme choices, live updates and cache identity |
| [Tool result views](tool-result-views.md) | Search highlighting, file-list artwork, source tokens, navigation and bounded expanded output |
| [File icons](file-icons.md) | Native/square Pierre artwork, document/media additions, Sass overrides, offline assets, themes and upstream snapshots |
| [Wheel gestures](wheel-gestures.md) | Free two-dimensional scrolling and input normalization |
| [Math assets](math-assets.md) | Offline math fonts and distribution assets |
| [Markdown rendering](markdown-rendering.md) | Syntax support, file line breaks, safe inline tags, alerts and footnote navigation |
| [Debug fixtures](debug-fixtures.md) | Debugging comparison fixtures and usage |

## Verification

The [Windows development guide](windows-development.md) covers guest-local dependencies, ARM64 prerequisites and desktop launch in Parallels.

The [testing guide](testing.md) describes the unified commands, catalog, reports, CI lanes, prerequisites and rules for keeping only useful coverage. `npm test` prepares and runs standard suites; `npm run test:core`, `test:ui`, `test:native` and `test:performance` select layers. `npm run test:list` lists behavior and ownership without executing.

After changes, run `npm run typecheck && npm run build`, then affected suites with `npm test -- --no-prepare --suite <id>`. Offline fixtures do not prove real-model behavior or every platform/adapter. An adapter SKIP is not a runtime pass; disclose failed or unrun checks when delivering work.

Maintained technical documentation lives in `docs/`. Root README, AGENTS, THIRD_PARTY_NOTICES and LICENSE are project entry points. Third-party distribution licenses and test fixtures remain in their runtime/test asset locations; complete texts for ported code are in `LICENSES/`.
