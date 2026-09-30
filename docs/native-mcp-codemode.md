# Native MCP and codemode in pi-app

pi-app loads the Pi SDK 0.99.1 built-in MCP, codemode, and tool_search extensions for each normal session. It excludes `pi-mcp-adapter` from the desktop session loader even if that package remains in the user's global Pi package list. The adapter is therefore unnecessary for this app. Removing the global package is a separate Pi CLI change and is not required to use this branch.

## What changes

| Area | pi-mcp-adapter | Native Pi MCP in pi-app |
| --- | --- | --- |
| Runtime | Third-party extension and its own connection/cache/status system | SDK extension; one connection owner per managed session |
| Config | Adapter-specific options and aliases may be accepted | `~/.pi/agent/mcp.json` and trusted `<cwd>/.pi/mcp.json`, using `mcpServers` |
| Tools | Adapter `mcp`, `mcpScript`, and server proxies | `mcp__<server>__<tool>`, resource tools, and separate `codemode` / `tool_search` |
| Exposure | Adapter-specific proxy/script choices | `codemode` (default), `codemode-deferred`, `deferred`, `direct`, `hidden`; per-tool `toolExposure` |
| Status | Adapter cache and event snapshots | Config plus tools registered in the SDK session; connection state remains `configured` because registration can outlive a disconnect |

Native MCP supports stdio and streamable HTTP. HTTP servers can use headers or native OAuth. The desktop SDK runs extensions in print mode, so interactive OAuth sign-in currently uses `pi mcp login <server>` with Pi CLI 0.99 or later. In a source checkout, `./node_modules/.bin/pi mcp login <server>` uses the matching SDK version even if the global `pi` command is older. After sign-in, reload the session or use Settings → MCP to save/reload the configuration. Settings shows registered tools but does not claim the transport is currently connected.

Within a `codemode` script, `ALL_TOOLS` is the complete list of callable nested tools. `await searchTools(query, { limit })` ranks that same list by relevance and returns at most `limit` matches; it returns a Promise, so using `.map()` or `JSON.stringify()` before awaiting it gives misleading results. `await describeTool(name)` looks up one callable tool. The separate model-facing `tool_search` tool searches only tools with `codemode` or `deferred` exposure that are not currently declared to the model, then declares matches for a later model call. Its result set is therefore intentionally different from `ALL_TOOLS`.

## Migration

1. Build the app with the native MCP integration. The desktop loader ignores the old adapter; no global uninstall is needed.
2. Open Settings → MCP. Check the global and project config tabs and any compatibility issues. Existing `mcpServers` entries with `command`/`args` or `url`/`headers` continue to work. Native Pi uses `enabled: false` instead of `disabled: true`; the visual editor writes the native form. Change `mcp-servers` to `mcpServers` if the issue list reports it. Unsupported adapter-only fields remain in the file until deliberately edited; the app does not silently discard them.
3. Choose exposure per server. Keep the default `codemode` for broad tool collections. Use `direct` only for a small set that should be declared in every model request; `deferred` uses tool_search. A `toolExposure` map can override individual tools.
4. For OAuth servers, run a Pi 0.99+ CLI `pi mcp login <server>` in a terminal and reopen or reload the app session. Verify that Settings → MCP lists registered tools, then invoke one through codemode to confirm the connection.
5. Review subagent profiles. Native MCP tools are individual permissions; grant `codemode` alongside MCP tools when the child should use script access. `tools: all` inherits currently callable MCP tools under the parent's frozen ceiling.

The global Pi CLI may still load `pi-mcp-adapter` while it remains configured. After adopting the new branch everywhere, remove that package from Pi's global package list if native MCP should own CLI sessions too. Preserve the prior settings/package as a rollback path until the new app is accepted.

## Execution boundaries

SDK `ctx.executeTool()` calls from codemode pass through the app's Plan admission, child tool ceiling, and Rewind leases. Successful nested writes are recorded as coverage evidence even if the outer script fails. Nested bash completion waits for the outer committed tool result. App tools whose behavior depends on their own committed tool-result receipt (`present`, todo, ask-user, plan submission, scheduling, Jev workflow, and subagent orchestration) use `model-only` exposure and remain top-level model tools.

Image blocks from codemode and other tools are checked with the SDK image decoder before they enter a new transcript. For older sessions containing an undecodable image, only the model request copy replaces it with a short note; the saved conversation is unchanged, so Continue can proceed. Valid images remain intact, and text-only models receive a note in place of image blocks.

Verify with `npm run typecheck`, `npm run build`, `node scripts/check-native-mcp-codemode.mjs`, `node scripts/check-image-safety.mjs`, `node scripts/check-tool-duration.mjs`, `node scripts/check-continue.mjs`, `node scripts/check-sdk-tool-boundary.mjs`, `node scripts/check-mcp-main.mjs`, `node scripts/check-mcp-settings.mjs`, and the Plan/Rewind/subagent checks.
