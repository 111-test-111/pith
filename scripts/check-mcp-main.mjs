/**
 * Main-process MCP module check: exercises src/main/pi/mcp.ts against the REAL
 * ~/.pi/agent install of pi-mcp-adapter (read-only) and temp dirs (writes).
 *
 * - parse/serialize round-trip, `mcp-servers` alias, invalid JSON.
 * - findAdapterInstall finds the npm package and its version.
 * - loadAdapterModules dynamically imports the adapter's compiled
 *   config/metadata-cache modules from its install path.
 * - buildMcpRoster merges through the adapter's own loader: the user's real
 *   global servers (beui, context7) appear, editable, with cache-derived
 *   tool counts; a live snapshot overrides status.
 * - mcpServerDetail reads the metadata cache.
 * - Writes (writeMcpConfigFile / upsert / delete / disabled toggle) land in a
 *   TEMP agent dir + project cwd; the real mcp.json is never touched.
 * - Path validation refuses writes outside the editable config files.
 *
 * Bundles the TS source with esbuild (no vite/electron boot):
 *   node scripts/check-mcp-main.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-mcp-main-'))

// Bundle the module under test; the SDK stays external and resolves from the
// repo's node_modules via the bundle's location inside it.
const bundleDir = join(repo, 'node_modules', '.cache', 'pith-mcp-main-check')
await mkdir(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'mcp.bundle.mjs')
await build({
  entryPoints: [join(repo, 'src/main/pi/mcp.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@earendil-works/pi-coding-agent', 'electron'],
  logLevel: 'error'
})
const mcp = await import(pathToFileURL(bundlePath).href)
const { getAgentDir } = await import('@earendil-works/pi-coding-agent')

// ---- pure document model ----
const parsed = mcp.parseMcpConfigJson('{"mcpServers":{"a":{"url":"https://x/mcp"}}}')
assert.ok(parsed.ok && parsed.config.mcpServers.a.url === 'https://x/mcp', 'parses mcpServers')
const alias = mcp.parseMcpConfigJson('{"mcp-servers":{"a":{"command":"npx"}}}')
assert.ok(alias.ok && alias.config.mcpServers.a.command === 'npx', 'accepts the mcp-servers alias')
assert.ok(!mcp.parseMcpConfigJson('{ nope').ok, 'invalid JSON is reported')
assert.ok(!mcp.parseMcpConfigJson('[1]').ok, 'a non-object root is reported')
const roundTrip = mcp.parseMcpConfigJson(mcp.serializeMcpConfig(parsed.config))
assert.ok(roundTrip.ok && roundTrip.config.mcpServers.a.url === 'https://x/mcp', 'serialize round-trips')

// ---- real adapter discovery + bridge (read-only) ----
const agentDir = getAgentDir()
const adapter = mcp.findAdapterInstall(null, agentDir)
assert.ok(adapter, 'pi-mcp-adapter is installed for the real agent dir')
assert.ok(adapter.version, `adapter version resolved: ${adapter.version}`)
assert.ok(adapter.installedPath.includes('pi-mcp-adapter'), 'adapter install path resolved')
const modules = await mcp.loadAdapterModules(adapter.installedPath)
assert.ok(modules, 'the adapter config/cache modules import from the install path')
assert.equal(typeof modules.config.loadMcpConfig, 'function', 'dist/config.js bridge works')
assert.equal(typeof modules.cache.loadMetadataCache, 'function', 'dist/metadata-cache.js bridge works')

// Roster through the adapter's own merge: the user's real global servers show
// up, editable, with tool metadata from the real cache.
const roster = mcp.buildMcpRoster({ cwd: null, agentDir, adapter, modules, live: null })
const beui = roster.find((server) => server.name === 'beui')
const context7 = roster.find((server) => server.name === 'context7')
assert.ok(beui && context7, 'real global servers appear: ' + roster.map((s) => s.name).join(','))
assert.equal(beui.scope, 'global', 'beui is global')
assert.equal(beui.editable, true, 'beui is editable')
assert.equal(beui.transport, 'http', 'beui transport is http')
assert.ok((beui.toolCount ?? 0) > 0, 'beui has cached tools')
assert.ok(beui.cachedAt, 'beui has a cache timestamp')
assert.equal(beui.status, 'cached', 'beui status derives from the cache without a live snapshot')
// A live snapshot wins over the cache-derived status.
const liveRoster = mcp.buildMcpRoster({
  cwd: null, agentDir, adapter, modules,
  live: new Map([['beui', { status: 'connected', toolCount: 99, disabled: false }]])
})
const liveBeui = liveRoster.find((server) => server.name === 'beui')
assert.equal(liveBeui.status, 'connected', 'live status wins')
assert.equal(liveBeui.toolCount, 99, 'live tool count wins')

// An idle server (lazy connect, first tool call) must not lose its cached
// metadata to a zero-tool live report: status stays `cached` while the cache
// is valid, and the cached tool count survives.
const idleRoster = mcp.buildMcpRoster({
  cwd: null, agentDir, adapter, modules,
  live: new Map([['beui', { status: 'not-connected', toolCount: 0, disabled: false }]])
})
const idleBeui = idleRoster.find((server) => server.name === 'beui')
assert.equal(idleBeui.status, 'cached', 'a live not-connected report keeps the cached status while the cache is valid')
assert.equal(idleBeui.toolCount, beui.toolCount, 'the cached tool count survives a zero-tool live report')
// context7's real cache is expired right now: it must stay not-connected but
// still report its cached tool count.
const idleContext7 = idleRoster.find((server) => server.name === 'context7')
assert.equal(idleContext7.status, 'not-connected', 'an expired cache is honestly not-connected')
assert.equal(idleContext7.toolCount, 2, 'the stale cache still reports its tool count')

const detail = mcp.mcpServerDetail('beui', agentDir, modules)
assert.ok(detail.tools.length > 0, 'server detail lists cached tools')
assert.ok(detail.tools.every((tool) => typeof tool.name === 'string'), 'tool rows carry names')

// Fallback without the adapter bridge still lists the editable files' servers.
const fallback = mcp.buildMcpRoster({ cwd: null, agentDir, adapter: null, modules: null, live: null })
assert.ok(fallback.some((server) => server.name === 'beui'), 'fallback roster reads the global file')
assert.ok(fallback.find((server) => server.name === 'beui').editable, 'fallback marks the global file editable')

// ---- writes land only in the temp dirs ----
const tempAgent = join(temporary, 'agent')
const tempCwd = join(temporary, 'proj')
await mkdir(tempAgent, { recursive: true })
await mkdir(tempCwd, { recursive: true })

const written = mcp.writeMcpConfigFile('global', '{"mcpServers":{"one":{"command":"a"}}}', null, tempAgent)
assert.equal(written.parseError, null, 'write returns a clean file payload')
const onDisk = JSON.parse(await readFile(join(tempAgent, 'mcp.json'), 'utf8'))
assert.ok(onDisk.mcpServers.one.command === 'a', 'the global file was written')
assert.throws(
  () => mcp.writeMcpConfigFile('global', '{ broken', null, tempAgent),
  /Invalid MCP config/,
  'an invalid JSON write is refused'
)

mcp.upsertMcpServerEntry(
  { scope: 'project', name: 'two', entry: { url: 'https://two/mcp' } },
  { cwd: tempCwd, agentDir: tempAgent }
)
const projectOnDisk = JSON.parse(await readFile(join(tempCwd, '.mcp.json'), 'utf8'))
assert.ok(projectOnDisk.mcpServers.two.url === 'https://two/mcp', 'the project file was created')

// Rename via originalName drops the old key.
mcp.upsertMcpServerEntry(
  { targetPath: join(tempCwd, '.mcp.json'), originalName: 'two', name: 'two-renamed', entry: { url: 'https://two/mcp', disabled: true } },
  { cwd: tempCwd, agentDir: tempAgent }
)
const renamed = JSON.parse(await readFile(join(tempCwd, '.mcp.json'), 'utf8'))
assert.ok(!('two' in renamed.mcpServers) && renamed.mcpServers['two-renamed'].disabled === true, 'rename moves the entry')

// The disabled toggle edits the defining file in place (and removes the key
// when enabling again).
mcp.setMcpServerDisabled('one', true, { cwd: tempCwd, agentDir: tempAgent, modules: null })
let globalOnDisk = JSON.parse(await readFile(join(tempAgent, 'mcp.json'), 'utf8'))
assert.equal(globalOnDisk.mcpServers.one.disabled, true, 'disable writes the flag')
mcp.setMcpServerDisabled('one', false, { cwd: tempCwd, agentDir: tempAgent, modules: null })
globalOnDisk = JSON.parse(await readFile(join(tempAgent, 'mcp.json'), 'utf8'))
assert.ok(!('disabled' in globalOnDisk.mcpServers.one), 'enable removes the flag')

mcp.deleteMcpServerEntry(join(tempAgent, 'mcp.json'), 'one', { cwd: tempCwd, agentDir: tempAgent })
globalOnDisk = JSON.parse(await readFile(join(tempAgent, 'mcp.json'), 'utf8'))
assert.ok(!('one' in globalOnDisk.mcpServers), 'delete removes the entry')

// Path validation: anything outside the editable set is refused.
assert.throws(
  () => mcp.deleteMcpServerEntry(join(temporary, 'elsewhere.json'), 'x', { cwd: tempCwd, agentDir: tempAgent }),
  /outside the MCP config files/,
  'delete refuses a foreign path'
)
assert.throws(
  () => mcp.upsertMcpServerEntry({ targetPath: join(temporary, 'elsewhere.json'), name: 'x', entry: {} }, { cwd: tempCwd, agentDir: tempAgent }),
  /outside the MCP config files/,
  'upsert refuses a foreign path'
)

console.log('PASS: document model, real adapter bridge (discovery/import/roster/detail), live override, temp-dir writes, path validation')
