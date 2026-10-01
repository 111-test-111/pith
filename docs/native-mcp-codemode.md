# Native MCP and codemode

Normal sessions load Pi SDK 0.99.1's native MCP, codemode and tool_search extensions. The desktop loader excludes the historical `pi-mcp-adapter`; global Pi CLI package removal is a separate user configuration change.

## Configuration and discovery

Use `mcpServers` in `<agentDir>/mcp.json` or trusted `<cwd>/.pi/mcp.json`, with stdio `command/args` or streamable HTTP `url/headers`. Native disablement is `enabled:false`. Settings reports compatibility issues without silently dropping unknown fields. Exposure is `codemode` by default, plus `codemode-deferred`, `deferred`, `direct` and `hidden`, with per-tool `toolExposure` overrides.

Settings lists registered tools; registration may outlive transport disconnect, so it does not claim live connection state. HTTP supports native OAuth; print-mode desktop sessions use matching CLI `./node_modules/.bin/pi mcp login <server>` for interactive sign-in, then session/config reload.

Inside scripts, `ALL_TOOLS` lists callable nested definitions. Await `searchTools(query,{limit})` and `describeTool(name)` before inspecting them. Model-facing `tool_search` instead declares discoverable codemode/deferred tools absent from the current model schema, so its set intentionally differs.

Subagent roles grant individual MCP/resource permissions under the frozen parent ceiling and `codemode` for script access. Plain read-only children avoid loading extension hosts.

## Execution boundary

SDK `ctx.executeTool()` passes app Plan admission, child ceilings and Rewind leases via `tool-call-boundary.ts`. Successful nested writes retain exact coverage paths even if the outer script fails. Nested bash receipt waits for the outer committed result.

Receipt-dependent app tools (`present`, Todo, ask-user, plan submission, scheduling, Jev and subagent orchestration) are `model-only`. Scripts execute in a fresh sandbox without Node/filesystem/network/timers. Failed scripts do not commit store writes; completed tool effects are not rolled back. Image validation repairs invalid blocks before persistence and historical request copies separately.

## Script results and completeness

Default app read/bash/bash_task/browser/debug definitions advertise outputSchema. Script projection is `{ok,isError,data,content,error?}`; transcript content/details remain the existing presentation. Installed Normal-mode read overrides retain their own contract; Plan substitutes a trusted definition.

Handle both promise rejection and resolved business failures. `Promise.allSettled` fulfillment alone is not success. Native MCP CallToolResult uses `isError/content/structuredContent`; resource helpers return direct resource payloads, without requiring `ok`. Never parse Error.message as JSON.

| Boundary | Result |
| --- | --- |
| Schema, visibility, Plan/child admission | Reject before handler execution |
| Default read | File/stale-version/paging failures resolve app error envelope; invalid schema can reject |
| Foreground bash | Nonzero exit resolves failure with task/output/exit code; launch/admission may reject |
| bash_task inspection | Successful inspection is ok even when the command failed; bad ownership/ID/paging may reject |
| browser handler | Precheck/service failures resolve envelope; unmet wait is an ok observation with `data.unmet` |
| debug | Known target/stop/local-entry/wait-cursor errors resolve envelope; permission/capability/DAP may reject |
| Native MCP tool | Tool error resolves CallToolResult; protocol/transport can reject |
| MCP resource helpers | Direct payload; empty list is success, lookup/capability/transport failures reject |

A helper may await a result, throw on `isError` or `ok:false`, and otherwise return it. Catch only failures with an actual recovery path. Forward image content with `image(block)`; `text(result)` dumps base64 instead of displaying it.

Completion is explicit:

- read: `data.text` excludes notices; continue via 1-based `nextOffset` or UTF-8 `nextByteOffset`, passing `version`, until `eof`. Oversized lines use byte pages. Output remains capped at 50 KiB / line-mode 2000 lines.
- bash: running/stopping is pending even if the launch tool succeeded. Initial wait follows user configuration; later inspection follows task identity.
- bash_task output: recent tail uses UTF-16 cursors, truncated flags gaps, hasMore covers currently available output only.
- bash_task log: persistent 8-MiB prefix uses UTF-8 offsets; eof requires settled command plus retained end, and cannot erase truncation. Complete means whole settled untruncated output. Exit during read rechecks final flushed size.
- browser: use latest active-page snapshot refs; invalid syntax, absent refs and invalidated snapshots have distinct errors. Snapshot window/offset describes one capture, not a frozen page across actions.
- debug: result paths and passive wait semantics are in [debug contracts](debug-implementation.md#action-registry-and-compatibility).

`scripts/prepare-pi-sdk.mjs` applies a small pinned 0.99.1 resource-diagnostic patch during install/dev/build. It rejects version/anchor drift and leaves the SDK as sole MCP owner. Review/remove it when upgrading to equivalent upstream behavior.

## Verification

```sh
node scripts/check-native-mcp-codemode.mjs
node scripts/check-codemode-contracts.mjs
node scripts/check-mcp-resource-contracts.mjs
node scripts/check-sdk-tool-boundary.mjs
node scripts/check-mcp-main.mjs
node scripts/check-mcp-settings.mjs
```

The contract suites use real SDK/QuickJS and isolated stdio MCP fixtures. Also run image/Continue, tool-duration, Plan, Rewind and subagent checks when execution boundaries change.
