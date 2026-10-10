import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePiSdk } from './prepare-pi-sdk.mjs'
import { createPlanFixture } from './lib/plan-fixture.mjs'

await preparePiSdk()
assert.equal(await preparePiSdk(), 0, 'the patch is idempotent')
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))))
const temp = await mkdtemp(join(tmpdir(), 'pith-sdk-patch-'))
try {
  await writeFile(join(temp, 'package.json'), JSON.stringify({ version: '0.99.2' }))
  await assert.rejects(preparePiSdk(temp), /Review pi-app SDK patches/)
  await writeFile(join(temp, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  // The patcher validates every affected SDK file before writing any change.
  // Include the core boundary-compaction adapter in this pinned-SDK fixture.
  for (const relative of ['dist/core/agent-session.js', 'dist/core/agent-session.d.ts']) {
    await mkdir(dirname(join(temp, relative)), { recursive: true })
    await writeFile(join(temp, relative), await readFile(join(sdkRoot, relative)))
  }
  const dir = join(temp, 'dist/extensions/mcp')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.d.ts'), await readFile(join(sdkRoot, 'dist/extensions/mcp/index.d.ts')))
  const original = await readFile(join(sdkRoot, 'dist/extensions/mcp/index.js'), 'utf8')
  await writeFile(join(dir, 'index.js'), original.replace('unavailableReason: (name)', 'upstreamChanged: (name)'))
  await assert.rejects(preparePiSdk(temp), /patch drift/)
} finally { await rm(temp, { recursive: true, force: true }) }

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
let fixture
try {
  fixture = await createPlanFixture({ loadDiscoveredExtensions: true, prepareAgentDir: async agentDir => {
    process.env.PI_CODING_AGENT_DIR = agentDir
    const script = join(agentDir, 'server.mjs')
    await writeFile(script, `import {createInterface} from 'node:readline';
const mode=process.argv[2];
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const r=JSON.parse(line);if(r.id===undefined)continue;
  if(mode==='disconnected'){process.exit(1)}
  let result;
  switch(r.method) {
    case 'initialize':result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{},...(mode==='empty'?{resources:{}}:{})},serverInfo:{name:mode,version:'1'}};break;
    case 'tools/list':result={tools:[{name:'soft_error',description:'Return an MCP tool business error',inputSchema:{type:'object',properties:{}}}]};break;
    case 'tools/call':result={isError:true,content:[{type:'text',text:'Expected fixture business error'}]};break;
    case 'resources/list':result={resources:[]};break;
    case 'resources/templates/list':result={resourceTemplates:[]};break;
    case 'ping':result={};break;
    default:process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Method not found'}})+'\\n');continue;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}`)
    const server = mode => ({ command: process.execPath, args: [script, mode] })
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      empty: server('empty'), toolsonly: server('toolsonly'), disconnected: server('disconnected'),
      disabled: { ...server('empty'), enabled: false }, hidden: { ...server('empty'), exposure: 'hidden' }
    } }))
  } })
  await fixture.managed.lifecyclePromise
  const next = fixture.requests.length + 1
  fixture.setRespond(i => i === next ? [{ type:'toolCall',id:'resources-contract',name:'codemode',arguments:{code:`
async function checked(p){const r=await p;if(r?.isError || r?.ok===false)throw new Error(r.error?.message || r.content?.filter(b=>b.type==='text').map(b=>b.text).join('\\n') || 'Tool failed');return r;}
const empty=await checked(tools.list_mcp_resources({server:'empty'}));
if(empty.resources.length!==0 || 'ok' in empty || 'isError' in empty || 'content' in empty)throw new Error('empty listing must preserve the resource payload without an envelope');
const templates=await checked(tools.list_mcp_resource_templates({server:'empty'}));
if(templates.resourceTemplates.length!==0 || 'ok' in templates)throw new Error('resource template payload');
const cases=[['toolsonly','does not advertise the resources capability'],['missing','Unknown or hidden'],['disabled','disabled'],['hidden','Unknown or hidden'],['disconnected','not connected']];
for(const [server,expected] of cases){let error;try{await checked(tools.list_mcp_resources({server}));}catch(e){error=e.message;}if(!error?.includes(expected))throw new Error(server+':'+error);text({server,error});}
const result=await Promise.allSettled([tools.mcp__toolsonly__soft_error({})]);
if(result[0].status!=='fulfilled' || result[0].value.isError!==true)throw new Error('MCP business error contract changed');
let message;try{await checked(result[0].value);}catch(e){message=e.message;}
if(message!=='Expected fixture business error')throw new Error('checked must also reject a fulfilled native MCP error');
text('MCP resource and soft-error contracts passed');`}}] : [{type:'text',text:'Done'}])
  await fixture.session.prompt('Verify MCP resource diagnostics offline')
  const result = fixture.session.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === 'resources-contract')
  assert(result && !result.isError, JSON.stringify(result?.content))
  assert.equal(result.details.calls.filter(c => c.status === 'error').length, 6)
  console.log('PASS MCP contracts: empty resources, missing/hidden/disabled/disconnected/capability diagnostics, native soft errors, patch idempotence/version/drift guards')
} finally {
  await fixture?.close()
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
}
