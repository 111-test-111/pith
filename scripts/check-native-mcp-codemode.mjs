/** Real SDK + app integration for native MCP's default codemode exposure.
 * A temporary newline-JSON-RPC stdio server and fake provider keep this
 * entirely offline. The profile and child process are removed on exit. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPlanFixture } from './lib/plan-fixture.mjs'
import { checkMcpStatus } from './lib/check-mcp-status.mjs'

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const namespaceInstructions = 'Fixture namespace metadata stays complete.\nModel API:\nPreserve <verbatim> descriptions & matching conditions.\nA nested tool call that fails, is blocked, or gets invalid arguments rejects with an Error carrying the tool\'s error text.'
const longServer = 'Long-Server-' + 'x'.repeat(70)
let fixture
let pidPath
let mcpPath
let gatePath
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}
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
import { existsSync, writeFileSync } from 'node:fs'
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
      while (!existsSync(process.argv[3])) await new Promise(resolve => setTimeout(resolve, 10))
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pi-app-fixture', version: '1.0.0' },
        instructions: ${JSON.stringify(namespaceInstructions)}
      }
      break
    case 'tools/list':
      result = { tools: [{
        name: 'echo', description: 'Echo fixture text.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      }, ...['read-file', 'read_file'].map(name => ({ name, description: 'Read fixture ' + name, inputSchema: { type: 'object', properties: {} } }))] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: request.params?.name === 'echo' ? 'fixture:' + request.params?.arguments?.text : request.params?.name }] }
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
      gatePath = join(agentDir, 'mcp-ready')
      mcpPath = join(agentDir, 'mcp.json')
      await writeFile(mcpPath, JSON.stringify({
        mcpServers: {
          'fixture-server': { command: process.execPath, args: [serverPath, pidPath, gatePath], description: 'Offline fixture server' },
          [longServer]: { command: process.execPath, args: [serverPath, pidPath, gatePath], description: 'Long server identifier fixture' }
        }
      }))
    }
  })

  await fixture.managed.lifecyclePromise
  let providerStarted
  const started = new Promise(resolve => { providerStarted = resolve })
  fixture.setRespond(() => { providerStarted(); return [{ type: 'text', text: 'Ready' }] })
  const firstPrompt = fixture.session.prompt('Start while MCP is still connecting')
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('default MCP blocked the first provider request')), 3000))])
  await writeFile(gatePath, 'ready')
  await firstPrompt
  const next = fixture.requests.length + 1
  fixture.setRespond((index) => index === next
    ? [{ type: 'toolCall', id: 'native-codemode-1', name: 'codemode', arguments: {
      code: `const matches = await searchTools('Echo fixture text', { limit: 4 });
const names = ALL_TOOLS.map(tool => tool.name);
const namespace = await describeNamespace('fixture-server');
text('namespace:' + JSON.stringify(namespace));
const description = await describeTool('mcp__fixture_server__echo');
text('discovery:' + JSON.stringify({
  callableCount: names.length,
  matchCount: matches.length,
  hasFixture: names.includes('mcp__fixture_server__echo'),
  matchedFixture: matches.some(tool => tool.name === 'mcp__fixture_server__echo'),
  matchesAreCallable: matches.every(tool => names.includes(tool.name)),
  descriptionFound: typeof description === 'string' && description.includes('mcp__fixture_server__echo')
}));
const result = await tools.mcp__fixture_server__echo({ text: 'hello' });
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
  const mcpTool = tools.find(tool => tool.name === 'mcp__fixture_server__echo')
  assert(mcpTool, 'the native MCP extension registers a per-tool definition')
  assert.equal(mcpTool.exposure, 'deferred', 'default MCP config uses deferred SDK definitions')
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
  assert.equal(codemodeDescription.includes('Echo fixture text.'), false,
    'the MCP contract stays out of the resident codemode catalog until queried')
  assert.equal(codemodeDescription.includes(namespaceInstructions), false,
    'deferred namespace instructions stay out of the resident description')
  const requestTools = new Map()
  for (const message of fixture.requests.at(-1).messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) requestTools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) requestTools.set(tool.name, tool)
  }
  assert.equal(requestTools.has(mcpTool.name), false, 'the MCP definition remains discovery-only in the provider request')
  assert.equal(requestTools.get('fixture_control_probe')?.description, 'Discovery control',
    'ordinary extension descriptions retain their exact text in the provider request')
  const catalog = await fixture.app.catalog()
  const sourceOf = name => catalog.tools.find(tool => tool.name === name)?.source
  assert.equal(sourceOf(mcpTool.name)?.label, 'Pi MCP', 'Settings names the built-in MCP source')
  assert.equal(sourceOf('codemode')?.label, 'codemode', 'Settings names the scripting source')
  assert.equal(sourceOf('tool_search')?.label, 'tool_search', 'Settings names the search source')

  const mcpState = await fixture.app.mcpState()
  const fixtureServer = mcpState.servers.find(server => server.name === 'fixture-server')
  assert(fixtureServer, 'the desktop settings roster reads the same native mcp.json')
  assert.equal(fixtureServer.status, 'connected',
    'the native MCP connection reports its actual state independently of tool registration')
  assert.equal(fixtureServer.toolCount, 3, 'the roster counts SDK-registered tools')
  const detail = await fixture.app.mcpServerDetail('fixture-server')
  assert(detail.tools.some(tool => tool.name === mcpTool.name), 'the detail view uses the SDK registry')

  const result = fixture.session.messages.findLast(message =>
    message.role === 'toolResult' && message.toolCallId === 'native-codemode-1')
  assert(result, 'the scripted codemode call produces a tool result')
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.match(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), /fixture:hello/,
    'codemode executes the native MCP tool against the real stdio server')
  const discoveryLine = result.content.filter(part => part.type === 'text')
    .flatMap(part => part.text.split('\n')).find(line => line.startsWith('discovery:'))
  assert(discoveryLine, 'codemode reports its nested discovery checks')
  const namespaceLine = result.content.flatMap(part => part.type === 'text' ? part.text.split('\n') : []).find(line => line.startsWith('namespace:'))
  const namespace = JSON.parse(namespaceLine.slice('namespace:'.length))
  assert.equal(namespace.name, 'mcp__fixture_server')
  assert.equal(namespace.instructions, namespaceInstructions, 'describeNamespace preserves opaque instructions verbatim')
  assert.equal(namespace.description, 'Offline fixture server')
  assert.equal(mcpState.servers.length, 2, 'normalized namespaces never create duplicate external settings rows')
  const longDetail = await fixture.app.mcpServerDetail(longServer)
  assert.equal(mcpState.servers.find(server => server.name === longServer)?.toolCount, 3, 'shortened tool identifiers retain their full server owner')
  assert.equal(longDetail.tools.length, 3)
  assert(longDetail.tools.every(tool => tool.name.length <= 64 && tool.name.startsWith('mcp__Long_Server_')), 'long case-sensitive identifiers follow SDK shortening')
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

  const run = async (session, name, args) => {
    const next = fixture.requests.length + 1, id = `native-${next}`
    fixture.setRespond(index => index === next ? [{ type: 'toolCall', id, name, arguments: args }] : [{ type: 'text', text: 'Done' }])
    await session.prompt('Run the native compatibility fixture')
    const result = session.messages.findLast(message => message.role === 'toolResult' && message.toolCallId === id)
    assert(result && !result.isError, JSON.stringify(result?.content))
    return result
  }
  const readTools = tools.filter(tool => tool.name.startsWith('mcp__fixture_server__read_file'))
  assert.equal(readTools.length, 2, 'colliding raw tool names both receive definitions')
  assert.equal(new Set(readTools.map(tool => tool.name)).size, 2, 'normalization never merges two server tools')
  const readResults = await run(fixture.session, 'codemode', { code: readTools.map(tool => `text((await tools.${tool.name}({})).content[0].text);`).join('\n') })
  const readText = readResults.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  assert.match(readText, /read-file/)
  assert.match(readText, /read_file/)

  fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), 'tool_search'])
  await run(fixture.session, 'tool_search', { query: mcpTool.name, limit: 1 })
  assert(fixture.session.getActiveToolNames().includes(mcpTool.name), 'tool_search declares the deferred tool for direct model calls')
  await rm(gatePath)
  await fixture.app.reloadSession(fixture.managed.path)
  const duringReconnect = await fixture.app.setSessionMode({ sessionPath: fixture.managed.path, mode: 'plan' })
  assert.equal(duringReconnect.ok, true)
  await writeFile(gatePath, 'ready')
  await waitFor(() => fixture.session.getAllTools().some(tool => tool.name === mcpTool.name), 'MCP registration resumes after reload')
  assert.equal(fixture.session.getActiveToolNames().includes(mcpTool.name), false, 'late deferred registration remains outside Plan')
  assert.equal(fixture.session.getActiveToolNames().includes('codemode'), false, 'late discovery activation cannot bypass Plan')
  assert.equal((await fixture.app.setSessionMode({ sessionPath: fixture.managed.path, mode: 'normal' })).ok, true)
  assert(fixture.session.getActiveToolNames().includes(mcpTool.name), 'leaving Plan restores the pre-reload tool_search selection')
  await run(fixture.session, mcpTool.name, { text: 'restored' })

  const nextConfig = JSON.parse(await readFile(mcpPath, 'utf8'))
  nextConfig.autoEnableCodemode = false
  await writeFile(mcpPath, JSON.stringify(nextConfig))
  await fixture.app.newSession(fixture.project)
  const optedOut = fixture.app.activeSession
  assert(optedOut, 'a fresh session opens for the opt-out check')
  await optedOut.lifecyclePromise
  fixture.setRespond(() => [{ type: 'text', text: 'Finished' }])
  await optedOut.session.prompt('Verify MCP discovery without automatic codemode')
  await waitFor(() => optedOut.session.getAllTools().some(tool => tool.name === 'mcp__fixture_server__echo'),
    'native MCP still registers tools in the background when codemode auto-activation is disabled')
  assert.equal(optedOut.session.getActiveToolNames().includes('codemode'), false,
    'the app respects the native autoEnableCodemode=false setting')

  // Direct MCP tools must finish registration before the first provider request.
  nextConfig.mcpServers['fixture-server'].exposure = 'direct'
  await writeFile(mcpPath, JSON.stringify(nextConfig))
  await rm(gatePath)
  await rm(pidPath, { force: true })
  await fixture.app.newSession(fixture.project)
  const direct = fixture.app.activeSession
  const beforeDirect = fixture.requests.length
  fixture.setRespond(() => [{ type: 'text', text: 'Direct ready' }])
  const directPrompt = (async () => { await direct.lifecyclePromise; await direct.session.prompt('Wait for the direct tools') })()
  await waitFor(async () => (await readFile(pidPath, 'utf8').catch(() => '')) !== '', 'the direct MCP transport starts')
  assert.equal(fixture.requests.length, beforeDirect, 'a direct server blocks the provider request until ready')
  await writeFile(gatePath, 'ready')
  await directPrompt
  assert(direct.session.getActiveToolNames().includes(mcpTool.name), 'direct tools are present in the first loadout')

  console.log('PASS: Pi 1.0 background/direct startup, normalized names and collisions, namespace discovery, deferred reload/Plan restoration, opt-out and model-only boundaries')
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

await checkMcpStatus()
