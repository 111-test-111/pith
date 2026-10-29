/** Native MCP config boundary, roster, and write checks. Real user files are read only. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'pith-native-mcp-'))
const agentDir = join(root, 'agent')
const cwd = join(root, 'workspace')
await mkdir(join(cwd, '.pi'), { recursive: true })
await mkdir(agentDir, { recursive: true })

const bundleDir = join(repo, 'node_modules', '.cache', 'pith-native-mcp-check')
await mkdir(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'mcp.bundle.mjs')
await build({
  entryPoints: [join(repo, 'src/main/pi/mcp.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error'
})
const mcp = await import(pathToFileURL(bundlePath).href)

const globalPath = join(agentDir, 'mcp.json')
const projectPath = join(cwd, '.pi', 'mcp.json')
const oldProjectPath = join(cwd, '.mcp.json')
const globalConfig = {
  autoEnableCodemode: true,
  mcpServers: {
    beui: { url: 'https://example.com/mcp?token=secret', headers: { Authorization: 'Bearer ${TOKEN}' }, exposure: 'codemode' },
    duplicate: { command: 'npx', args: ['-y', 'server'], enabled: false }
  }
}
const projectConfig = {
  mcpServers: {
    duplicate: { url: 'https://project.example/mcp', exposure: 'direct', toolExposure: { 'write_*': 'hidden' } },
    local: { command: 'node', args: ['server.mjs'], env: { API_KEY: '${API_KEY}' } }
  }
}
await writeFile(globalPath, JSON.stringify(globalConfig, null, 2))
await writeFile(projectPath, JSON.stringify(projectConfig, null, 2))
await writeFile(oldProjectPath, JSON.stringify({ mcpServers: { ignored: { command: 'old' } } }))

assert.equal(mcp.readMcpConfigFile('project', cwd, agentDir).path, projectPath, 'project path is .pi/mcp.json')
assert.ok(mcp.parseMcpConfigJson('{').ok === false, 'invalid JSON rejected')
assert.ok(mcp.parseMcpConfigJson('[]').ok === false, 'non-object root rejected')
assert.ok(mcp.parseMcpConfigJson('{"mcpServers":[]}').ok === false, 'non-object roster rejected')
assert.deepEqual(
  mcp.readMcpConfigIssues(cwd, agentDir, true).map((issue) => issue.code),
  ['legacyProjectPath'],
  'native fields accepted; legacy project path gets a migration hint'
)

const live = new Map([
  ['beui', { tools: [{ name: 'inspect', description: 'Inspect', exposure: 'codemode' }] }],
  ['registered', { tools: [{ name: 'ping' }] }]
])
const roster = mcp.buildMcpRoster({ cwd, agentDir, projectTrusted: true, live })
assert.deepEqual(roster.map((server) => server.name), ['beui', 'duplicate', 'local', 'registered'])
assert.equal(roster.find((server) => server.name === 'duplicate').scope, 'project', 'trusted project wins')
assert.equal(roster.find((server) => server.name === 'duplicate').exposure, 'direct', 'native exposure visible')
assert.equal(roster.find((server) => server.name === 'beui').toolCount, 1, 'live SDK tool count visible')
assert.equal(roster.find((server) => server.name === 'beui').status, 'configured', 'no invented connected state')
assert.equal(roster.find((server) => server.name === 'beui').summary, 'https://example.com/mcp', 'URL credentials not shown')
assert.equal(roster.find((server) => server.name === 'registered').transport, 'registered', 'extension server is not called stdio')
const untrusted = mcp.buildMcpRoster({ cwd, agentDir, projectTrusted: false })
assert.equal(untrusted.find((server) => server.name === 'duplicate').disabled, true, 'untrusted project is ignored')
assert.ok(mcp.readMcpConfigIssues(cwd, agentDir, false).some((issue) => issue.code === 'untrustedProject'))
assert.equal(mcp.mcpServerDetail('beui', live.get('beui').tools).tools[0].name, 'inspect', 'detail comes from live tools')

// A toggle edits the winning native definition, preserving secrets and unrelated fields.
mcp.setMcpServerDisabled('duplicate', true, { cwd, agentDir, projectTrusted: true })
let projectOnDisk = JSON.parse(await readFile(projectPath, 'utf8'))
assert.equal(projectOnDisk.mcpServers.duplicate.enabled, false)
assert.equal(projectOnDisk.mcpServers.duplicate.toolExposure['write_*'], 'hidden')
assert.equal(globalConfig.mcpServers.beui.headers.Authorization, 'Bearer ${TOKEN}')
mcp.setMcpServerDisabled('duplicate', false, { cwd, agentDir, projectTrusted: true })
projectOnDisk = JSON.parse(await readFile(projectPath, 'utf8'))
assert.ok(!('enabled' in projectOnDisk.mcpServers.duplicate), 'enable removes default key')

mcp.upsertMcpServerEntry(
  { targetPath: projectPath, originalName: 'local', name: 'renamed', entry: { command: 'node', args: ['new.mjs'], exposure: 'deferred' } },
  { cwd, agentDir }
)
projectOnDisk = JSON.parse(await readFile(projectPath, 'utf8'))
assert.ok(!projectOnDisk.mcpServers.local && projectOnDisk.mcpServers.renamed)
mcp.deleteMcpServerEntry(projectPath, 'renamed', { cwd, agentDir })
projectOnDisk = JSON.parse(await readFile(projectPath, 'utf8'))
assert.ok(!projectOnDisk.mcpServers.renamed)
assert.throws(
  () => mcp.upsertMcpServerEntry({ targetPath: oldProjectPath, name: 'x', entry: { command: 'x' } }, { cwd, agentDir }),
  /outside the MCP config files/,
  'legacy .mcp.json is never overwritten'
)

const legacy = {
  mcpServers: {
    old: { command: 'run', disabled: true, auth: 'oauth', includeTools: ['read'] }
  }
}
await writeFile(globalPath, JSON.stringify(legacy, null, 2))
const issues = mcp.readMcpConfigIssues(cwd, agentDir, true)
assert.ok(issues.some((issue) => issue.name === 'old' && issue.field === 'disabled'))
assert.ok(issues.some((issue) => issue.name === 'old' && issue.field === 'auth'))
assert.ok(issues.some((issue) => issue.name === 'old' && issue.field === 'includeTools'))
const untouched = await readFile(globalPath, 'utf8')
assert.throws(
  () => mcp.setMcpServerDisabled('old', true, { cwd, agentDir, projectTrusted: true }),
  /Invalid native MCP/,
  'editing legacy document requires migration first'
)
assert.equal(await readFile(globalPath, 'utf8'), untouched, 'invalid write does not change credentials/config')
assert.throws(
  () => mcp.writeMcpConfigFile('global', '{"mcpServers":{"old":{"socket":"/tmp/x"}}}', cwd, agentDir),
  /Invalid native MCP/,
  'unsupported socket cannot silently enter native config'
)

const nativeEntry = {
  url: 'https://native.example/mcp', description: 'Native server discovery',
  auth: { provider: 'anthropic' }, exposure: 'codemode-deferred',
  toolExposure: { 'read-*': 'codemode-deferred' },
  oauth: { clientId: 'registered', clientSecret: '${MCP_SECRET}', callbackPort: 8000,
    callbackUrl: 'http://127.0.0.1:8000/callback', scope: 'read', clientName: 'Pith',
    authServerMetadataUrl: 'https://auth.example/.well-known/oauth-authorization-server' }
}
mcp.writeMcpConfigFile('global', JSON.stringify({ mcpServers: { 'native-server': nativeEntry } }), cwd, agentDir)
const nativeLive = new Map([['native_server', { tools: [{ name: 'mcp__native_server__read_file', exposure: 'deferred' }] }]])
const nativeRoster = mcp.buildMcpRoster({ cwd, agentDir, projectTrusted: true, live: nativeLive })
assert.equal(nativeRoster.filter(row => row.name === 'native-server' || row.name === 'native_server').length, 1,
  'a normalized SDK namespace has exactly one editable config row')
assert.equal(nativeRoster.find(row => row.name === 'native-server').toolCount, 1)
assert.equal(nativeRoster.find(row => row.name === 'native-server').exposure, 'codemode', 'legacy exposure aliases display canonically')
assert(!mcp.readMcpConfigIssues(cwd, agentDir, true).some(issue => issue.name === 'native-server'), 'all Pi 1.0 fields are accepted')
mcp.setMcpServerDisabled('native-server', true, { cwd, agentDir, projectTrusted: true })
assert.deepEqual(JSON.parse(await readFile(globalPath, 'utf8')).mcpServers['native-server'], { ...nativeEntry, enabled: false },
  'toggling preserves provider auth, every OAuth field and raw exposure aliases')
const globalBefore = await readFile(globalPath, 'utf8')
for (const entry of [
  { ...nativeEntry, description: 42 },
  { ...nativeEntry, url: 'http://remote.example/mcp' },
  { ...nativeEntry, auth: { provider: '' } },
  { ...nativeEntry, oauth: { clientName: ' ' } },
  { ...nativeEntry, oauth: { authServerMetadataUrl: 'http://remote.example/auth' } }
]) {
  assert.throws(() => mcp.upsertMcpServerEntry({ name: 'invalid', entry }, { cwd, agentDir }), /Invalid native MCP/)
  assert.equal(await readFile(globalPath, 'utf8'), globalBefore, 'rejected writes leave the complete config unchanged')
}
const projectBefore = await readFile(projectPath, 'utf8')
assert.throws(() => mcp.upsertMcpServerEntry({ scope: 'project', name: 'credentials', entry: nativeEntry }, { cwd, agentDir }), /Invalid native MCP.*auth/)
assert.throws(() => mcp.upsertMcpServerEntry({ scope: 'project', name: 'native_server', entry: { command: 'node' } }, { cwd, agentDir }), /name conflicts/)
assert.equal(await readFile(projectPath, 'utf8'), projectBefore, 'project auth and cross-file namespace collisions fail before writing')
assert.throws(() => mcp.writeMcpConfigFile('global', JSON.stringify({ mcpServers: {
  'same-name': { command: 'node' }, same_name: { command: 'node' }
} }), cwd, agentDir), /Invalid native MCP/)
mcp.upsertMcpServerEntry({ scope: 'project', name: 'native-server', entry: { command: 'node' } }, { cwd, agentDir })
assert.equal(mcp.buildMcpRoster({ cwd, agentDir, projectTrusted: true, live: nativeLive }).find(row => row.name === 'native-server').scope, 'project',
  'exact-name project overrides still work')
assert.equal(await readFile(globalPath, 'utf8'), globalBefore, 'project overrides never rewrite global credentials')

console.log('PASS: native MCP paths, precedence, normalized roster, Pi 1.0 auth/OAuth/description, aliases, namespace collisions and atomic rejected writes')
