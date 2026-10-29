/** Real Pi SDK -> app tools -> QuickJS -> persisted result contract. Offline. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent'
import { createBrowserTools } from '../src/main/browser/tools.ts'
import { RefNotInSnapshotError } from '../src/main/browser/service.ts'
import { createAppCodemodeExtension } from '../src/main/pi/codemode-guidance.ts'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const { loadPhoton } = await import(new URL('./utils/photon.js', import.meta.resolve('@earendil-works/pi-coding-agent')))
const photon = await loadPhoton()
assert(photon)
const pixels = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
const jpeg = Buffer.from(pixels.get_bytes_jpeg(80)).toString('base64')
pixels.free()
const browserTools = createBrowserTools({ ownerId: 'fixture', service: {
  agentScreenshot: async () => ({ pageId: 'fixture-page', jpegBase64: jpeg, annotated: false }),
  agentClickRef: async () => { throw new RefNotInSnapshotError('e999') }
} })
for (const name of ['browser_screenshot', 'browser_navigate', 'browser_click']) {
  const tool = browserTools.find(t => t.name === name)
  const result = await tool.execute('direct', name === 'browser_navigate' ? { url: 'file:///tmp/no' } : name === 'browser_click' ? { ref: 'e999' } : {})
  assert(Check(tool.outputSchema, result.structuredContent), `${name} must match its advertised result schema`)
  assert.equal(result.isError, name !== 'browser_screenshot')
}

let probeCalls = 0
let prepareCalls = 0
const probe = {
  name: 'fixture_contract_probe',
  description: 'Inspect the orchid fixture contract.',
  parameters: Type.Object({ kind: Type.Literal('probe') }),
  prepareLoadout: () => { prepareCalls++ },
  outputSchema: Type.Object({
    contractToken: Type.Literal('orchid_contract_preserved'),
    ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [
      `optionalField${i}`, Type.Optional(Type.String({ description: 'An optional fixture output field.' }))
    ]))
  }),
  execute: async () => {
    probeCalls++
    return { content: [{ type: 'text', text: 'Probe completed' }], structuredContent: { contractToken: 'orchid_contract_preserved' } }
  }
}
const requestTools = request => {
  const tools = new Map()
  for (const message of request.messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return tools
}

// The app keeps the SDK's mode selection, including hidden direct declarations.
let compactDefinition
createAppCodemodeExtension()({
  registerTool: definition => { compactDefinition = definition },
  getSettings: () => ({ codemode: { mode: 'only', inlineBudget: 100000 } }),
  getAllTools: () => [probe]
})
const onlyLoadout = compactDefinition.prepareLoadout({
  declared: [probe, compactDefinition], callable: [probe], registered: [probe, compactDefinition],
  getExposure: name => name === 'codemode' ? 'model-only' : 'direct',
  getNamespace: () => undefined
})
assert.deepEqual(onlyLoadout.hiddenDeclarations, [probe.name], 'codemode-only still hides direct declarations')
assert.deepEqual(Object.keys(onlyLoadout.descriptions), ['codemode'], 'only codemode presentation is replaced')
let sdkDefinition
createCodemodeExtension()({
  registerTool: definition => { sdkDefinition = definition },
  getSettings: () => ({}), getAllTools: () => []
})
assert(onlyLoadout.descriptions.codemode.includes(sdkDefinition.description),
  'the app retains the complete native compact runtime and model API reference')


let fixture
try {
  fixture = await createPlanFixture({ withLibrary: true, extensionFactories: [api => {
    for (const tool of browserTools) api.registerTool({ ...tool, name: `fixture_${tool.name}` })
    api.registerTool(probe)
  }] })
  await fixture.managed.lifecyclePromise
  fixture.app.setSessionSandboxMode(fixture.managed.path, 'danger-full-access')
  fixture.app.setBashMaxWaitMs(1000)
  fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), 'codemode', probe.name, ...browserTools.map(t => `fixture_${t.name}`)])
  assert(fixture.session.getActiveToolNames().includes('codemode'), 'the isolated fixture explicitly activates its real SDK codemode extension')
  const beforeAssignment = prepareCalls
  const currentTools = fixture.session.agent.state.tools
  fixture.session.agent.state.tools = currentTools
  assert.equal(prepareCalls, beforeAssignment, 'filtering an SDK state assignment never reruns prepareLoadout hooks')
  assert.notEqual(fixture.session.agent.state.tools, currentTools, 'the public tools accessor still copies its assigned array')
  const run = async code => {
    const next = fixture.requests.length + 1, id = `contract-${next}`
    fixture.setRespond(i => i === next ? [{ type: 'toolCall', id, name: 'codemode', arguments: { code } }]
      : [{ type: 'text', text: 'Done' }])
    await fixture.session.prompt('Run the offline contract check')
    const result = fixture.session.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === id)
    assert(result && !result.isError, JSON.stringify(result?.content))
    return result
  }
  const discovered = await run(`
const matches = await searchTools('orchid fixture contract', {limit:2});
if (!matches.some(t => t.name === 'fixture_contract_probe')) throw new Error('discovery failed');
const declaration = await describeTool('fixture_contract_probe');
if (typeof declaration !== 'string') throw new Error('missing full declaration');
text(declaration);
const result = await tools.fixture_contract_probe({kind:'probe'});
text(result.contractToken);
if (!('fixture_contract_probe' in tools) || 'absent_fixture' in tools) throw new Error('presence checks failed');
try { tools.fixture_contract_prob; throw new Error('missing tool access did not throw'); }
catch (e) { if (!e.message.includes('fixture_contract_probe')) throw e; }
try { models.getAvailableOfTyp; throw new Error('missing model helper access did not throw'); }
catch (e) { if (!e.message.includes('getAvailableOfType')) throw e; }
const invalid = await Promise.allSettled([tools.fixture_contract_probe({kind:'invalid'})]);
if (invalid[0].status !== 'rejected') throw new Error('schema validation lost');
`)
  const discoveryText = discovered.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.match(discoveryText, /optionalField299/)
  assert.match(discoveryText, /orchid_contract_preserved/)
  assert.equal(probeCalls, 1, 'invalid input is rejected before execution')
  const declared = requestTools(fixture.requests.at(-1))
  assert.equal(declared.get(probe.name)?.description, probe.description, 'the provider receives the original description without generated return types')
  assert.deepEqual(declared.get(probe.name)?.parameters, JSON.parse(JSON.stringify(probe.parameters)), 'the provider retains the complete input schema')
  assert(!declared.get('codemode').description.includes('optionalField299'), 'the large nested contract enters context only through discovery')

  await fixture.app.reloadSession(fixture.managed.path)
  fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), 'codemode', probe.name, ...browserTools.map(t => `fixture_${t.name}`)])
  await run(`text(await describeTool('fixture_contract_probe')); text((await tools.fixture_contract_probe({kind:'probe'})).contractToken);`)
  assert.equal(probeCalls, 2, 'discovery and execution survive a resource reload')
  assert.equal(requestTools(fixture.requests.at(-1)).get(probe.name)?.description, probe.description)

  const result = await run(`
const shot = await tools.fixture_browser_screenshot({});
if (!shot.ok || shot.content[0].type !== 'image') throw new Error('image projection lost');
image(shot.content[0]);
const outcomes = await Promise.allSettled([
  tools.fixture_browser_navigate({url:'file:///tmp/no'}),
  tools.fixture_browser_click({ref:'e999'})
]);
text(outcomes.map(o => ({status:o.status, ok:o.value?.ok, code:o.value?.error?.code})));
`)
  assert.equal(result.content.filter(b => b.type === 'image').length, 1)
  assert.equal(result.content.find(b => b.type === 'image').data, jpeg)
  assert.equal(result.details.calls.filter(c => c.status === 'error').length, 2, 'business failures must be recorded as failed nested calls')
  assert.match(JSON.stringify(result.content.filter(b => b.type === 'text')), /NAVIGATION_BLOCKED/)
  assert.match(JSON.stringify(result.content.filter(b => b.type === 'text')), /REF_NOT_IN_SNAPSHOT/)

  const lines = Array.from({ length: 2301 }, (_, i) => `${i}:中文😀${'x'.repeat(30)}`).join('\n')
  const long = '中文😀'.repeat(12000)
  await writeFile(join(fixture.project, 'lines.txt'), lines)
  await writeFile(join(fixture.project, 'long.txt'), long)
  await writeFile(join(fixture.project, 'empty.txt'), '')
  await writeFile(join(fixture.project, 'short.txt'), 'x\n'.repeat(2200))
  await writeFile(join(fixture.project, 'pixel.jpg'), Buffer.from(jpeg, 'base64'))
  const failureBoundaries = await run(`
const results=await Promise.allSettled([
  tools.read({path:'missing-file.txt'}),
  tools.read({path:'empty.txt',limit:0})
]);
if(results[0].status!=='fulfilled' || results[0].value.error?.code!=='TOOL_FAILED' || results[0].value.ok!==false)throw new Error('filesystem error must be structured');
if(results[1].status!=='rejected')throw new Error('SDK schema validation must reject before the handler');
text('Both failure boundaries were handled');
`)
  assert.equal(failureBoundaries.details.calls.filter(c => c.status === 'error').length, 2)
  await run(`
async function checked(p) { const r = await p; if (r?.isError || r?.ok === false) throw new Error(r.error?.message || 'Tool failed'); return r; }
let offset=1, version, pages=[], eof=false;
while (!eof) { const r=await checked(tools.read({path:'lines.txt',offset,limit:333,version})); const d=r.data; pages.push(d.text); version=d.version; eof=d.eof; offset=d.nextOffset; if(pages.length>20)throw new Error('no progress'); }
if(pages.join('\\n') !== ${JSON.stringify(lines)}) throw new Error('line page loss');
let r=await checked(tools.read({path:'long.txt'})), textValue=r.data.text, count=1;
while (!r.data.eof) { r=await checked(tools.read({path:'long.txt',byteOffset:r.data.nextByteOffset,version:r.data.version,maxBytes:4097})); textValue+=r.data.text; if(++count>100)throw new Error('no progress'); }
if(textValue !== ${JSON.stringify(long)}) throw new Error('byte page loss');
if(!(await checked(tools.read({path:'empty.txt'}))).data.eof) throw new Error('empty EOF');
const capped=(await checked(tools.read({path:'short.txt'}))).data;
if(capped.eof||capped.nextOffset!==2001)throw new Error('line cap');
const byteCapped=(await checked(tools.read({path:'lines.txt'}))).data;
if(byteCapped.eof||byteCapped.nextOffset>=2001)throw new Error('byte cap');
const imageResult=await checked(tools.read({path:'pixel.jpg'}));
if(!imageResult.content.some(b=>b.type==='image'))throw new Error('read image lost');
store('version',version); text({pages:pages.length,bytePages:count});
`)
  await writeFile(join(fixture.project, 'lines.txt'), 'changed')
  await run(`const r=await tools.read({path:'lines.txt',offset:2,version:load('version')}); if(r.ok || r.error.code!=='FILE_CHANGED')throw new Error('missed mutation'); text(r.error.code)`)
  await run(`
const failure=await tools.bash({command:'printf broken; exit 7'});
if(failure.ok || failure.error.code!=='COMMAND_FAILED' || failure.data.task.exitCode!==7)throw new Error('failed command lost');
const launch=await tools.bash({command:'seq 1 200000'});
if(!launch.ok || launch.data.task.status!=='succeeded' || !launch.data.truncated)throw new Error('large command status');
let cursor=0, output='', page;
do {page=await tools.bash_task({action:'log',taskId:launch.data.task.id,byteOffset:cursor,maxBytes:65536}); if(!page.ok)throw new Error('log error'); output+=page.data.output; cursor=page.data.nextByteOffset;} while(page.data.hasMore);
if(!page.data.eof || page.data.truncated || !output.startsWith('1\\n') || !output.endsWith('200000\\n'))throw new Error('persisted log gap');
text({exit:failure.data.task.exitCode,logBytes:cursor});
`)
  await fixture.app.setDebugEnabled(true)
  fixture.debugAdapterSpec(fixture.project,'lldb-dap').detect = async () => ({command:process.execPath,args:[resolve('scripts/debug-fixtures/protocol-adapter.mjs'),'identity']})
  await run(`
async function checked(p){const r=await p;if(r.isError||r.ok===false)throw new Error(r.error?.message||'Tool failed');return r.data;}
const started=await checked(tools.debug({request:{action:'start',adapter:'lldb-dap',program:'lines.txt'}}));
const session=started.session;
const ref={debugId:session.id,stopId:session.stopId};
const stack=await checked(tools.debug({...ref,request:{action:'stack'}}));
if(!Array.isArray(stack.frames)||stack.frames.length===0)throw new Error('stack schema');
const registers=await checked(tools.debug({...ref,request:{action:'registers',frameId:stack.frames[0].id}}));
if(!Array.isArray(registers.scopes))throw new Error('register scopes schema');
const waited=await checked(tools.debug({debugId:session.id,request:{action:'wait',waitMs:0}}));
if(!waited.settled || waited.timedOut)throw new Error('passive wait');
const idle=await checked(tools.debug({debugId:session.id,request:{action:'wait',until:'changed',afterRevision:waited.revision,waitMs:0}}));
if(!idle.settled || !idle.timedOut || idle.changed)throw new Error('settled and timedOut are independent');
const invalid=await Promise.allSettled([tools.debug({...ref,request:{action:'control',control:'continue',waitMs:0}})]);
if(invalid[0].status!=='rejected')throw new Error('control must reject waitMs=0');
const unchanged=await checked(tools.debug({debugId:session.id,request:{action:'wait',waitMs:0}}));
if(unchanged.session.status!=='stopped' || unchanged.session.stopId!==session.stopId || unchanged.revision!==idle.revision)throw new Error('invalid control changed the target');
const stopped=await checked(tools.debug({debugId:session.id,request:{action:'stop'}}));
if(stopped.session.status!=='terminated')throw new Error('stop schema');
const history=await checked(tools.debug({request:{action:'sessions'}}));
if(!history.sessions.some(s=>s.id===session.id && s.status==='terminated'))throw new Error('ended target console history disappeared');
if(history.sessions.some(s=>['starting','running','stopped'].includes(s.status)))throw new Error('test target remained live');
const terminal=await checked(tools.debug({debugId:session.id,request:{action:'wait',until:'changed',afterRevision:stopped.session.revision,waitMs:0}}));
if(!terminal.settled || terminal.timedOut || terminal.changed)throw new Error('terminal target must return immediately even at the same revision');
const ended=await tools.debug({...ref,request:{action:'stack'}});
if(ended.error?.code!=='DEBUG_SESSION_ENDED')throw new Error('ended diagnosis');
text({debug:true,frames:stack.frames.length});
`)
  // Pi 1.0's real QuickJS models API, with only the provider request replaced.
  const registry = await fixture.app.runtime()
  const imageModel = { type: 'image', id: 'offline-image', name: 'Offline image', provider: 'fixture-image',
    api: 'fixture-images', baseUrl: 'http://127.0.0.1:1', headers: { authorization: 'fixture-private' } }
  const usage = { input: 17, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
    cost: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.12 } }
  registry.getModelsOfType = type => type === 'image' ? [imageModel] : []
  registry.getAvailableOfType = async type => type === 'image' ? [imageModel] : []
  registry.getModelOfType = (type, provider, id) => type === 'image' && provider === imageModel.provider && id === imageModel.id ? imageModel : undefined
  let generated = 0
  registry.generateImages = async (model, context, options) => {
    assert.equal(model, imageModel, 'script-supplied model URLs and credentials never replace the registry model')
    assert(options.signal instanceof AbortSignal)
    generated++
    return { api: imageModel.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      output: context.input[0].text === 'fail' ? [] : [{ type: 'image', data: jpeg, mimeType: 'image/jpeg' }],
      stopReason: context.input[0].text === 'fail' ? 'error' : 'stop',
      ...(context.input[0].text === 'fail' ? { errorMessage: 'Fixture image generation failed' } : { usage }) }
  }
  const beforeImage = fixture.session.getSessionStats()
  const generatedResult = await run(`
const available = await models.getAvailableOfType('image');
if (available.length !== 1 || 'headers' in available[0]) throw new Error('image model catalog leaked credentials');
const invalid = await Promise.allSettled([models.generateImages(available[0], {prompt:'invalid'})]);
if (invalid[0].status !== 'rejected') throw new Error('invalid image context passed validation');
const result = await models.generateImages({...available[0], baseUrl:'https://untrusted.example', headers:{authorization:'untrusted'}}, {input:[{type:'text',text:'offline pixel'}]});
if (result.stopReason !== 'stop') throw new Error(result.errorMessage);
for (const block of result.output) if (block.type === 'image') image(block);
const failed = await models.generateImages(available[0], {input:[{type:'text',text:'fail'}]});
if (failed.stopReason !== 'error') throw new Error('image failure lost');
text(failed.errorMessage);
`)
  assert.equal(generated, 2, 'invalid contexts never reach the image provider')
  assert.equal(generatedResult.content.find(block => block.type === 'image')?.data, jpeg, 'generated pixels persist byte-for-byte')
  assert.deepEqual(generatedResult.usage, usage)
  const calls = generatedResult.details.calls.filter(call => call.name === 'models.generateImages')
  assert.deepEqual(calls.map(call => call.status), ['ok', 'error'])
  assert.equal(calls[0].cost, usage.cost.total)
  assert(calls.every(call => !JSON.stringify(call).includes(jpeg) && !JSON.stringify(call).includes('offline pixel')), 'nested model rows retain no prompts or pixels')
  assert.equal(fixture.session.getSessionStats().cost - beforeImage.cost, usage.cost.total, 'SDK image billing is counted once')
  assert.equal((await fixture.app.contextDetail()).cost, fixture.session.getSessionStats().cost, 'app context billing includes image usage without adding nested costs again')
  const generatedEntry = fixture.session.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === generatedResult.toolCallId)
  assert(generatedEntry, 'the generated result is committed to the selected SDK branch')
  let archived
  for (let attempt = 0; attempt < 200; attempt++) {
    archived = (await fixture.library.page({ kind: 'image' })).items.find(item => item.entryId === generatedEntry.id && item.toolName === 'codemode' && item.storage === 'saved')
    if (archived) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(archived, 'forwarded model images enter the app Library')
  assert.deepEqual(await readFile(archived.archivedPath), Buffer.from(jpeg, 'base64'))
  console.log('PASS codemode contracts: compact discovery, validation/reload/mode-only, Pi 1.0 model images/billing/library, browser images/errors, exact paging, durable logs and debug lifecycle')
} finally { await fixture?.close() }
