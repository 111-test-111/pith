/** Version-checked, idempotent upstream compatibility patches. Never silently
 * apply a text patch to a different SDK release. Remove after upstream fixes. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const patches = [
  ['dist/core/agent-session.js',
    '    async compact(customInstructions) {\n        await this.abort();\n        this._compactionAbortController = new AbortController();',
    `    async compact(customInstructions) {
        await this.abort();
        return this.compactAtBoundary(customInstructions);
    }
    /** local patch (pi-app): the host awaits this only at a completed tool/result
     * boundary or while idle. Preserve manual hooks/events without aborting the run. */
    async compactAtBoundary(customInstructions) {
        this._compactionAbortController = new AbortController();`],
  ['dist/core/agent-session.d.ts',
    '    compact(customInstructions?: string): Promise<CompactionResult>;',
    `    compact(customInstructions?: string): Promise<CompactionResult>;
    /** local patch (pi-app): compact without abort; caller must own an idle or awaited completed-turn boundary. */
    compactAtBoundary(customInstructions?: string): Promise<CompactionResult>;`],
  ['dist/extensions/mcp/index.js',
    '        const emitChange = () => {\n            for (const listener of listeners)',
    `        const emitChange = () => {
            // local patch (pi-app): observe native state without another MCP client or config secrets.
            options.onStatusChange?.(servers.map(server => ({
                name: server.entry.name,
                state: !isEnabled(server) ? "disabled" : (server.connection?.state ?? "connecting")
            })));
            for (const listener of listeners)`],
  ['dist/extensions/mcp/index.d.ts',
    'export interface McpExtensionOptions {',
    `export interface McpExtensionOptions {
    /** local patch (pi-app): complete native runtime roster on startup, changes and shutdown. */
    onStatusChange?: (servers: readonly {
        name: string;
        state: "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed" | "disabled";
    }[]) => void;`],
  ['dist/extensions/mcp/index.js',
    'if (/\\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\\b/.test(code))',
    '// local patch (pi-app): resource helpers also wait for background MCP registration.\n    if (/\\b(searchTools|describeNamespace|describeTool|ALL_TOOLS|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)\\b/.test(code))'],
  ['dist/extensions/mcp/index.js',
    'createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers })',
    `createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers,
                // local patch (pi-app): diagnose capability, not resource count.
                unavailableReason: (name) => {
                    const server = findServer(name);
                    if (!server || exposureOf(server.entry) === "hidden") return "Unknown or hidden MCP server";
                    if (!isEnabled(server)) return "MCP server is disabled";
                    if (!server.connection || server.connection.state !== "connected") return "MCP server is not connected (" + (server.connection?.state ?? "unavailable") + ")";
                    if (!server.connection.hasResources) return "MCP server does not advertise the resources capability";
                    return "MCP resources are unavailable";
                }
            })`],
  ['dist/extensions/mcp/resources.js',
    'throw new Error(`MCP server "${name}" has no resources${available ? `. Servers with resources: ${available}` : ""}`);',
    '// local patch (pi-app): an empty listing is a successful result, not a capability error.\n        throw new Error(`${options.unavailableReason?.(name) ?? "MCP server is unavailable to this resource tool"}: "${name}"${available ? `. Servers exposing the resources capability: ${available}` : ""}`);'],
  ['dist/extensions/mcp/resources.d.ts',
    '    servers: () => readonly McpResourceServer[];',
    '    servers: () => readonly McpResourceServer[];\n    /** local patch (pi-app): diagnostic for an inaccessible resource server. */\n    unavailableReason?: (name: string) => string;']
]

export async function preparePiSdk(root = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))))) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.version !== '1.0.0') throw new Error(`Review pi-app SDK patches before using Pi ${manifest.version}; expected 1.0.0`)
  const changes = new Map()
  for (const [relative, before, after] of patches) {
    const path = join(root, relative), source = changes.get(path) ?? await readFile(path, 'utf8')
    if (source.includes(after)) continue
    if (source.split(before).length !== 2) throw new Error(`Pi SDK patch drift: ${relative}; refusing to modify the package`)
    changes.set(path, source.replace(before, after))
  }
  for (const [path, source] of changes) await writeFile(path, source)
  return changes.size
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = await preparePiSdk()
  if (count) console.log(`Applied Pi 1.0.0 compatibility patches (${count} files)`)
}
