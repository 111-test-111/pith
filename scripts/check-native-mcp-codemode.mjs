/** Real SDK + app integration for native MCP's default codemode exposure.
 * A temporary newline-JSON-RPC stdio server and fake provider keep this
 * entirely offline. The profile and child process are removed on exit. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
let fixture
let pidPath
let mcpPath
try {
  fixture = await createPlanFixture({
    loadDiscoveredExtensions: true,
    prepareAgentDir: async (agentDir) => {
      process.env.PI_CODING_AGENT_DIR = agentDir
      const legacyDir = join(agentDir, 'extensions', 'pi-mcp-adapter')
      const controlDir = join(agentDir, 'extensions', 'fixture-control')
      await mkdir(legacyDir, { recursive: true })
      await mkdir(controlDir, { recursive: true })
      await writeFile(join(legacyDir, 'index.ts'), `export default function(pi) {
        pi.registerTool({ name: 'legacy_mcp_adapter_probe', description: 'Legacy adapter probe', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'legacy' }] }) })
      }`)
      await writeFile(join(controlDir, 'index.ts'), `export default function(pi) {
        pi.registerTool({ name: 'fixture_control_probe', description: 'Discovery control', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'control' }] }) })
      }`)
      const serverPath = join(agentDir, 'fixture-mcp-server.mjs')
      pidPath = join(agentDir, 'fixture-mcp-server.pid')
      await writeFile(serverPath, String.raw`
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

writeFileSync(process.argv[2], String(process.pid))
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pi-app-fixture', version: '1.0.0' }
      }
      break
    case 'tools/list':
      result = { tools: [{
        name: 'echo', description: 'Echo fixture text.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      }] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'fixture:' + request.params?.arguments?.text }] }
      break
    case 'ping':
      result = {}
      break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      continue
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
`)
      mcpPath = join(agentDir, 'mcp.json')
      await writeFile(mcpPath, JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [serverPath, pidPath] } }
      }))
    }
  })

  await fixture.managed.lifecyclePromise
  const next = fixture.requests.length + 1
  fixture.setRespond((index) => index === next
    ? [{ type: 'toolCall', id: 'native-codemode-1', name: 'codemode', arguments: {
      code: `const names = ALL_TOOLS.map(tool => tool.name);
const matches = await searchTools('Echo fixture text', { limit: 4 });
const description = await describeTool('mcp__fixture__echo');
text('discovery:' + JSON.stringify({
  callableCount: names.length,
  matchCount: matches.length,
  hasFixture: names.includes('mcp__fixture__echo'),
  matchedFixture: matches.some(tool => tool.name === 'mcp__fixture__echo'),
  matchesAreCallable: matches.every(tool => names.includes(tool.name)),
  descriptionFound: typeof description === 'string' && description.includes('mcp__fixture__echo')
}));
const result = await tools.mcp__fixture__echo({ text: 'hello' });
text(result.content[0].text)`
    } }]
    : [{ type: 'text', text: 'Finished' }])
  await fixture.session.prompt('Call the fixture MCP tool in codemode')

  const tools = fixture.session.getAllTools()
  assert(tools.some(tool => tool.name === 'fixture_control_probe'),
    'the fixture discovers regular file extensions from the same directory')
  assert.equal(tools.some(tool => tool.name === 'legacy_mcp_adapter_probe'), false,
    'the installed legacy adapter is filtered before extension binding')
  assert.equal(fixture.managed.resourceLoader.getExtensions().extensions.some(extension =>
    extension.path.includes('/pi-mcp-adapter/')), false, 'the desktop loader excludes the legacy adapter')
  const mcpTool = tools.find(tool => tool.name === 'mcp__fixture__echo')
  assert(mcpTool, 'the native MCP extension registers a per-tool definition')
  assert.equal(mcpTool.exposure, 'codemode', 'native MCP defaults to codemode exposure')
  assert.equal(fixture.session.getActiveToolNames().includes(mcpTool.name), false,
    'the MCP definition is not declared directly to the model')
  assert.equal(fixture.session.getCallableToolNames().includes(mcpTool.name), true,
    'the MCP definition remains callable through the SDK tool context')
  assert.equal(fixture.session.getActiveToolNames().includes('codemode'), true,
    'the MCP extension activates codemode for its default exposure')
  const codemodeDescription = fixture.session.agent.state.tools.find(tool => tool.name === 'codemode')?.description
  assert.match(codemodeDescription ?? '', /await searchTools\(/,
    'the model-facing codemode description explicitly awaits ranked search')
  assert.match(codemodeDescription ?? '', /await describeTool\(/,
    'the model-facing codemode description explicitly awaits declaration lookup')
  const catalog = await fixture.app.catalog()
  const sourceOf = name => catalog.tools.find(tool => tool.name === name)?.source
  assert.equal(sourceOf(mcpTool.name)?.label, 'Pi MCP', 'Settings names the built-in MCP source')
  assert.equal(sourceOf('codemode')?.label, 'codemode', 'Settings names the scripting source')
  assert.equal(sourceOf('tool_search')?.label, 'tool_search', 'Settings names the search source')

  const mcpState = await fixture.app.mcpState()
  const fixtureServer = mcpState.servers.find(server => server.name === 'fixture')
  assert(fixtureServer, 'the desktop settings roster reads the same native mcp.json')
  assert.equal(fixtureServer.status, 'configured',
    'registered tools alone cannot prove a transport remains connected')
  assert.equal(fixtureServer.toolCount, 1, 'the roster counts SDK-registered tools')
  const detail = await fixture.app.mcpServerDetail('fixture')
  assert.equal(detail.tools[0]?.name, mcpTool.name, 'the detail view uses the SDK registry')

  const result = fixture.session.messages.findLast(message =>
    message.role === 'toolResult' && message.toolCallId === 'native-codemode-1')
  assert(result, 'the scripted codemode call produces a tool result')
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.match(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), /fixture:hello/,
    'codemode executes the native MCP tool against the real stdio server')
  const discoveryLine = result.content.filter(part => part.type === 'text')
    .flatMap(part => part.text.split('\n')).find(line => line.startsWith('discovery:'))
  assert(discoveryLine, 'codemode reports its nested discovery checks')
  const discovery = JSON.parse(discoveryLine.slice('discovery:'.length))
  assert.equal(discovery.callableCount, fixture.session.getCallableToolNames().filter(name => name !== 'codemode').length,
    'ALL_TOOLS covers the session callable set except the enclosing codemode tool')
  assert(discovery.matchCount <= 4, 'searchTools applies its requested result limit')
  assert.equal(discovery.hasFixture, true, 'ALL_TOOLS lists the callable native MCP tool')
  assert.equal(discovery.matchedFixture, true, 'await searchTools finds the same native MCP tool')
  assert.equal(discovery.matchesAreCallable, true, 'searchTools results are a ranked subset of ALL_TOOLS')
  assert.equal(discovery.descriptionFound, true, 'describeTool resolves the same nested tool')

  const callable = new Set(fixture.session.getCallableToolNames())
  const modelOnlyApp = tools.filter(tool =>
    tool.exposure === 'model-only' && ['todo_write', 'submit_plan', 'ask_user_question', 'agent'].includes(tool.name))
  assert(modelOnlyApp.length > 0, 'the app registers a model-only stateful tool')
  for (const tool of modelOnlyApp) assert.equal(callable.has(tool.name), false,
    `${tool.name} must not be callable from codemode`)

  const nextConfig = JSON.parse(await readFile(mcpPath, 'utf8'))
  nextConfig.autoEnableCodemode = false
  await writeFile(mcpPath, JSON.stringify(nextConfig))
  await fixture.app.newSession(fixture.project)
  const optedOut = fixture.app.activeSession
  assert(optedOut, 'a fresh session opens for the opt-out check')
  await optedOut.lifecyclePromise
  fixture.setRespond(() => [{ type: 'text', text: 'Finished' }])
  await optedOut.session.prompt('Verify MCP discovery without automatic codemode')
  assert(optedOut.session.getAllTools().some(tool => tool.name === 'mcp__fixture__echo'),
    'native MCP still registers the tool when codemode auto-activation is disabled')
  assert.equal(optedOut.session.getActiveToolNames().includes('codemode'), false,
    'the app respects the native autoEnableCodemode=false setting')

  console.log('PASS: real SDK native MCP runs via codemode, respects autoEnableCodemode=false, excludes the legacy adapter and keeps model-only app tools out of scripts.')
} finally {
  let serverPid
  if (pidPath) {
    const raw = await readFile(pidPath, 'utf8').catch(() => '')
    serverPid = Number.parseInt(raw, 10)
  }
  let closeError
  try { await fixture?.close() } catch (error) { closeError = error } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
  if (Number.isInteger(serverPid) && serverPid > 0) {
    try { process.kill(serverPid, 0); process.kill(serverPid, 'SIGTERM') } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  if (closeError) throw closeError
}
