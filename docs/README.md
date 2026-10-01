# Technical documentation

Start with [README](../README.md) for the product, setup and development commands, [AGENTS.md](../AGENTS.md) for contributor constraints and regression checks, and [LICENSE](../LICENSE) for project licensing. This directory keeps current implementation contracts and reproducible verification instructions, without historical plans, handoffs or machine-specific acceptance reports.

## Architecture

- `src/main/`: Electron main process, Pi SDK, files/processes, sandbox and persistence; `src/main/pi/manager.ts` coordinates session lifecycle.
- `src/shared/types.ts`: IPC DTO entry point; `src/preload/index.ts` exposes the typed `window.pi` bridge.
- `src/renderer/src/`: React, beUI, theme tokens and English/Simplified Chinese i18n; `state/pi-store.ts` projects snapshots/events into UI state.
- `scripts/check-*.mjs`: isolated SDK, filesystem, protocol and Electron/CDP regressions. Source code is authoritative for behavior.

## Sessions and execution

| Document | Contract |
| --- | --- |
| [Plan Mode](plan-mode-implementation.md) | Read-only planning, sealed submissions, approval and recovery |
| [Rewind](rewind-implementation.md) | Before-turn checkpoints, raw-byte transactions, partial/single-file restore |
| [Subagents](subagents-implementation.md) | Role grants, persisted runs, notifications and recovery |
| [Native MCP / codemode](native-mcp-codemode.md) | SDK MCP configuration, scripts and result contracts |
| [DAP debug](debug-implementation.md) | Target ownership, stopped references, native/core inspection |
| [Embedded browser](architecture/embedded-browser.md) | webview/CDP hosting, tools, trust boundaries and cleanup |
| [Jev integration](jev-integration.md) | Judgment tools, optional workflow and evidence |
| [Jev tool reference](jev-tool-reference.md) | Native parameters/examples used by the Pi skill bridge |

## Context, diagnostics and UI

| Document | Contract |
| --- | --- |
| [Context budget](context-budget-implementation.md) | Request-copy budgets and image safety |
| [Delivery / trajectory](present-trajectory-implementation.md) | File delivery, recorded requests, paging and exports |
| [Session replay](session-replay-implementation.md) | Offline SDK/provider-boundary replay |
| [Long-session benchmark](long-session-benchmarks.md) | Reproducible performance measurement and interpretation |
| [Sidebar panes](sidebar-pane-layout.md) | Container layouts and state preservation |
| [Wheel gestures](wheel-gestures.md) | Whole-gesture axis/action locking |
| [Math assets](math-assets.md) | Offline math fonts and distribution assets |
| [Debug fixtures](debug-fixtures.md) | Debugging comparison fixtures and usage |

## Verification

The [testing guide](testing.md) describes the unified commands, catalog, reports, CI lanes, prerequisites and rules for keeping only useful coverage. `npm test` prepares and runs standard suites; `npm run test:core`, `test:ui`, `test:native` and `test:performance` select layers. `npm run test:list` lists behavior and ownership without executing.

After changes, run `npm run typecheck && npm run build`, then affected suites with `npm test -- --no-prepare --suite <id>`. Offline fixtures do not prove real-model behavior or every platform/adapter. An adapter SKIP is not a runtime pass; disclose failed or unrun checks when delivering work.

Maintained technical documentation lives in `docs/`. Root README, AGENTS and LICENSE are project entry points. Third-party distribution licenses and test fixtures remain in their runtime/test asset locations.
