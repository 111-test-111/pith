/** Native MCP status lifecycle exercised by the real-SDK integration suite. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPlanFixture } from './plan-fixture.mjs'

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

export async function checkMcpStatus() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  let fixture, script, gate, pidDir, extensionApi, origin
  const pushes = []
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url.startsWith('/.well-known/oauth-protected-resource')) {
      response.end(JSON.stringify({ resource: origin + '/mcp', authorization_servers: [origin] }))
    } else if (request.url.startsWith('/.well-known/oauth-authorization-server')) {
      response.end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'] }))
    } else {
      response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` })
      response.end('{}')
    }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${http.address().port}`
  try {
    fixture = await createPlanFixture({
      loadDiscoveredExtensions: true,
      extensionFactories: [pi => {
        extensionApi = pi
        pi.registerMcpServer('extension-empty', { command: process.execPath, args: [script, 'empty', gate, pidDir] })
      }],
      prepareAgentDir: async agentDir => {
        process.env.PI_CODING_AGENT_DIR = agentDir
        script = join(agentDir, 'status-server.mjs')
        gate = join(agentDir, 'connect-ready')
        pidDir = join(agentDir, 'pids')
        await mkdir(pidDir)
        await writeFile(script, String.raw`
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const [mode, gate, pidDir] = process.argv.slice(2);
writeFileSync(join(pidDir, String(process.pid)), JSON.stringify({ pid: process.pid, mode }));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      if (mode === 'failed') { process.stderr.write('fixture connection failure\n'); process.exit(2); }
      if (mode === 'tools') while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
      result = { protocolVersion: request.params.protocolVersion, capabilities: mode === 'empty' ? { resources: {} } : { tools: {} }, serverInfo: { name: mode, version: '1' } };
      break;
    case 'tools/list': result = { tools: [{ name: 'echo', description: 'Status fixture echo', inputSchema: { type: 'object', properties: {} } }] }; break;
    case 'tools/call': result = { content: [{ type: 'text', text: 'echo' }] }; break;
    case 'resources/list': result = { resources: [] }; break;
    case 'resources/templates/list': result = { resourceTemplates: [] }; break;
    case 'ping': result = {}; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
`)
        const server = mode => ({ command: process.execPath, args: [script, mode, gate, pidDir] })
        await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
          'tools-server': server('tools'), empty: server('empty'), failed: server('failed'),
          disabled: { ...server('disabled'), enabled: false },
          'auth-required': { url: origin + '/mcp', oauth: { clientId: 'fixture-client' } }
        } }))
      }
    })
    const emit = fixture.app.emit
    fixture.app.emit = (channel, value) => {
      if (channel === 'pi:mcp-status') pushes.push(JSON.parse(JSON.stringify(value)))
      emit(channel, value)
    }
    await fixture.managed.lifecyclePromise
    const state = () => fixture.app.mcpState()
    const server = async name => (await state()).servers.find(row => row.name === name)
    assert.equal((await server('tools-server')).status, 'connecting', 'startup is observed before any tool registers')
    assert.equal((await server('tools-server')).toolCount, 0)
    const sequence = fixture.managed.eventSequence
    fixture.app.publishMcpStatusIfChanged()
    assert.equal(fixture.managed.eventSequence, sequence, 'status pushes do not consume transcript sequence')

    await writeFile(gate, 'ready')
    for (const [name, status] of [['tools-server', 'connected'], ['empty', 'connected'],
      ['extension-empty', 'connected'], ['failed', 'failed'], ['auth-required', 'needs-auth'], ['disabled', 'disabled']]) {
      await waitFor(async () => (await server(name))?.status === status, `${name} reports ${status}`)
    }
    assert.equal((await server('empty')).toolCount, 0, 'a resource-only server is connected without tools')
    assert.equal((await server('extension-empty')).scope, 'external', 'native registrations keep their original name even without tools')
    assert.equal((await server('extension-empty')).toolCount, 0)
    assert.equal((await server('failed')).toolCount, 0, 'connection failure is visible before registration')
    assert.equal(pushes.at(-1).sessionPath, fixture.managed.path)
    assert(pushes.every(push => !('eventSequence' in push)), 'native status snapshots are sequence-free')

    const processes = async () => Promise.all((await readdir(pidDir)).map(async name => JSON.parse(await readFile(join(pidDir, name), 'utf8'))))
    assert.equal((await processes()).some(entry => entry.mode === 'disabled'), false, 'disabled servers never launch')
    const firstPid = (await processes()).find(entry => entry.mode === 'tools').pid
    process.kill(firstPid, 'SIGTERM')
    await waitFor(async () => (await server('tools-server')).status === 'disconnected', 'transport exit is observed')
    assert.equal((await server('tools-server')).toolCount, 1, 'retained tool registrations do not falsely report connected')
    assert.equal((await fixture.app.mcpServerDetail('tools-server')).tools.length, 1)

    await fixture.session.prompt('/mcp reconnect tools-server')
    await waitFor(async () => (await server('tools-server')).status === 'connected', 'native reconnect updates status')
    assert(pushes.some(push => push.servers.find(row => row.name === 'tools-server')?.status === 'connecting'))
    const reconnectedPid = (await processes()).find(entry => entry.mode === 'tools' && entry.pid !== firstPid).pid

    const disabled = await fixture.app.setMcpServerDisabled('tools-server', true)
    assert.equal(disabled.servers.find(row => row.name === 'tools-server').status, 'disabled')
    assert.equal((await server('tools-server')).toolCount, 0, 'disabled reload clears the previous tool roster')
    await fixture.app.setMcpServerDisabled('tools-server', false)
    await waitFor(async () => (await server('tools-server')).status === 'connected', 'enabling observes the new native connection')
    const firstSessionPid = (await processes()).find(entry => entry.mode === 'tools' && ![firstPid, reconnectedPid].includes(entry.pid)).pid

    extensionApi.unregisterMcpServer('extension-empty')
    await waitFor(async () => !(await server('extension-empty')), 'unregistering removes a tool-free external server')

    // Two independent sessions in one cwd must never merge their runtime facts.
    await rm(gate)
    await fixture.app.newSession(fixture.project)
    const second = fixture.app.activeSession
    await second.lifecyclePromise
    assert.equal((await server('tools-server')).status, 'connecting', 'another session cannot borrow the first connection')
    assert.equal((await server('tools-server')).toolCount, 0, 'another session cannot borrow the first tool definitions')
    assert.equal((await fixture.app.mcpServerDetail('tools-server')).tools.length, 0)
    assert.equal(pushes.at(-1).sessionPath, second.path)
    process.kill(firstSessionPid, 'SIGTERM')
    await waitFor(() => fixture.app.mcpRuntimeStatuses.get(fixture.managed.resourceLoader)?.get('tools_server')?.status === 'disconnected',
      'the inactive session observes its own transport exit')
    assert.equal((await server('tools-server')).status, 'connecting', 'an inactive transport exit cannot replace selected-session facts')
    await writeFile(gate, 'ready')
    await waitFor(async () => (await server('tools-server')).status === 'connected', 'the selected session connects independently')
    await fixture.app.openSession(fixture.managed.path, fixture.project)
    await waitFor(async () => (await server('tools-server')).status === 'disconnected', 'switching back shows that session\'s disconnected state')
    assert.equal(pushes.at(-1).sessionPath, fixture.managed.path)

    // Shutdown/reload clears old observations before the next native host starts.
    await rm(gate)
    await fixture.app.reloadSession(fixture.managed.path)
    assert.equal((await server('tools-server')).status, 'connecting', 'reload does not retain connected or disconnected state from the old host')
    assert.equal((await server('tools-server')).toolCount, 0)
    await writeFile(gate, 'ready')
    await waitFor(async () => (await server('tools-server')).status === 'connected', 'the new host reports connected after reload')
    const pushCount = pushes.length
    await fixture.close()
    fixture = null
    assert.equal(pushes.length, pushCount, 'late shutdown callbacks cannot publish state after disposal')
    console.log('PASS: native MCP startup, tool-free servers, authentication, failure, disconnect/reconnect, toggles, same-cwd ownership, reload and shutdown statuses')
  } finally {
    try { await fixture?.close() } finally {
      http.closeAllConnections()
      await new Promise(resolve => http.close(resolve))
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
  }
}
