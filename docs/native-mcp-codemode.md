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

## Script results and completeness

The app's default `read`, managed `bash`/`bash_task`, `browser_*` and `debug`
definitions advertise `outputSchema`. Scripts receive
`{ok, isError, data, content, error?}` through the SDK's native `structuredContent`
projection. The transcript still uses the existing text/image content and
renderer details. Installed overrides of `read` retain their own contract in
Normal mode; Plan always substitutes the app's trusted read definition.

Check both promise rejection and the returned `isError`/`ok`. A fulfilled
`Promise.allSettled` entry can carry a business failure. Native `mcp__*` tools retain
their protocol `CallToolResult` shape (`isError`, `content`, optional structured
payload); transport/admission/validation errors can reject. Never parse an
`Error.message` as JSON. This helper can be defined in a script (it is not a
built-in global):

```js
async function checked(promise) {
  const result = await promise;
  if (result?.isError || result?.ok === false) {
    throw new Error(result.error?.message || result.content
      ?.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Tool failed');
  }
  return result;
}
const shot = await checked(tools.browser_screenshot({}));
for (const block of shot.content) if (block.type === 'image') image(block);
```

Failures follow the boundary that detects them; a tool name alone does not
determine whether its promise rejects:

| Boundary / operation | Script result |
| --- | --- |
| SDK argument schema, tool visibility, Plan or child admission | Rejects before the tool handler runs. A handler's result envelope cannot catch these failures. |
| Default `read` handler | File errors (including missing files), stale versions and incompatible paging options resolve with `ok:false,isError:true,error`. Unclassified filesystem errors use `TOOL_FAILED`; invalid schema values can still reject before execution. |
| `bash` foreground command | A failed command resolves with the app error envelope and `data.task`/`data.output`. A background receipt is pending; later failure is in the task's status. Launch/admission failures may reject. |
| `bash_task` inspection | A successful status/output/log read resolves with `ok:true` even if the inspected command failed. Invalid ownership, task IDs or paging requests may reject. |
| `browser_*` handler | Target prechecks and service failures resolve with the app error envelope. An unmet wait condition is a successful observation with `data.unmet`. SDK schema failures still reject. |
| `debug` | Known target, stop-token, local-program and wait-cursor errors resolve with the app error envelope. Argument validation, permission/capability checks and adapter/DAP failures may reject. |
| Native `mcp__*` calls | MCP tool errors resolve with `isError:true` in `CallToolResult`; protocol/transport failures reject. |
| `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | Success resolves directly with `{resources,...}`, `{resourceTemplates,...}` or `{server,uri,contents}` respectively. These are SDK resource payloads without the app envelope or `CallToolResult` fields. Resource lookup, capability and transport failures reject. An empty list is success. |

The local `checked` helper also works for the resource tools: it preserves their
success payload and propagates a rejection through `await`. Do not require an
`ok` field on every discovered tool. Catch a rejection only when the script can
handle that failure; converting it to an unchecked `{ERROR: ...}` object hides
the failure from dependent operations.

Forward image blocks with `image`; `text(result)` prints their base64. Browser
argument and service failures mark the browser tool and its nested call failed;
an outer script that handles the failure can still succeed.
`INVALID_REF` means invalid syntax; `REF_NOT_IN_SNAPSHOT` means the ref is absent
from the current allowed set (including removed, mistyped or old-page refs).
`STALE_SNAPSHOT` means there is no usable snapshot or a user interaction
invalidated it. Refs identify elements in the page/frame, not positions or
snapshot generation tokens: a surviving element can retain its ref across
captures, and deleting an earlier element does not renumber the remaining
elements. Only use refs present in the active page's latest snapshot; never
infer freshness from the ref string or reuse it across pages/navigation.
A browser wait timeout remains an observation with `unmet`
conditions. Snapshot `data.window` reports offset, nextOffset, totalChars, EOF
and whether the text is a diff; it describes that capture, not a frozen page
across future browser actions.

| Tool | Completion/continuation contract |
| --- | --- |
| `read` | `data.text` excludes notices. `eof`, `nextOffset` (1-based lines) and `nextByteOffset` (UTF-8 bytes) are derived from the bytes read. Pass `version` on later pages to detect changes. Oversized single lines automatically switch to byte pages; explicit `byteOffset`/`maxBytes` works too. Both modes retain the 50 KiB output bound; line mode also retains the 2,000-line bound. |
| `bash` | `data.task` is the managed command; `running`/`stopping` remains pending. A nonzero foreground exit returns a structured failure with task, output and exit code, rather than embedding JSON in an exception. The configured initial wait still applies. |
| `bash_task output` | Bounded recent tail. `cursor`/`startCursor` count UTF-16 code units; `truncated` signals a gap before this page. `hasMore` only describes output already available. |
| `bash_task log` | Persistent prefix, capped at 8 MiB. `byteOffset`/`nextByteOffset` count UTF-8 bytes. `truncated` explicitly reports retention loss. `eof` means the command ended and the retained end was reached; it does not prove no output was lost. A page is `complete` only when it contains the entire settled, untruncated output. |
| `debug` | `data.action` identifies the result. Start/restart/stop consistently return `data.session`; stack returns `data.frames`; registers returns scopes to expand with variables, possibly through several register groups. `sessions` includes retained ended targets; filter by `status` when choosing live ones. `help` includes input/result schemas for every action. `wait` observes the named target without sending a control request; `settled` describes target state, while `timedOut` describes the wait. See [debug contracts](debug-implementation.md#action-registry-and-compatibility). |

MCP resource capability is separate from resource count: an empty resource list
is successful. `scripts/prepare-pi-sdk.mjs` maintains a small Pi **0.99.1** patch
to distinguish unavailable, disabled, hidden/unknown and non-resource servers.
The SDK remains the only connection owner. The package version is pinned; install,
dev and build run the idempotent patch, which refuses version or anchor drift.
Review/remove the patch when upgrading to a release with equivalent upstream
diagnostics. It does not change MCP error wire semantics or expose hidden names.

Log EOF is checked against the final flushed size if a command exits during an
in-flight read. A page captured before the final output burst then reports
`hasMore:true`, allowing the next page to recover that burst rather than
prematurely declaring the old prefix complete. `check-bash-tasks.mjs` holds a
real log read across process completion to verify this race deterministically.

The sandbox remains fresh for each script, without Node, filesystem, network or
timers. Failed scripts do not commit `store` writes, but completed tool effects
are never rolled back. Receipt-dependent tools remain model-only.

The offline end-to-end regressions are `check-codemode-contracts.mjs` (real SDK
and QuickJS, production browser/read/bash/debug tools) and
`check-mcp-resource-contracts.mjs` (real stdio MCP transport plus patch guards).

Verify with `npm run typecheck`, `npm run build`, `node scripts/check-native-mcp-codemode.mjs`, `node scripts/check-image-safety.mjs`, `node scripts/check-tool-duration.mjs`, `node scripts/check-continue.mjs`, `node scripts/check-sdk-tool-boundary.mjs`, `node scripts/check-mcp-main.mjs`, `node scripts/check-mcp-settings.mjs`, and the Plan/Rewind/subagent checks.
