/** Version-checked, idempotent upstream compatibility patches. Never silently
 * apply a text patch to a different SDK release. Remove after upstream fixes. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const patches = [
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
  if (manifest.version !== '0.99.1') throw new Error(`Review pi-app SDK patches before using Pi ${manifest.version}; expected 0.99.1`)
  const changes = []
  for (const [relative, before, after] of patches) {
    const path = join(root, relative), source = await readFile(path, 'utf8')
    if (source.includes(after)) continue
    if (source.split(before).length !== 2) throw new Error(`Pi SDK patch drift: ${relative}; refusing to modify the package`)
    changes.push([path, source.replace(before, after)])
  }
  for (const [path, source] of changes) await writeFile(path, source)
  return changes.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = await preparePiSdk()
  if (count) console.log(`Applied Pi 0.99.1 resource diagnostics patch (${count} files)`)
}
