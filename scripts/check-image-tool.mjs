/** Offline provider contracts, filesystem races and real SDK image receipts. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { deflateSync } from 'node:zlib'
import { readdirSync } from 'node:fs'
import { createPlanFixture } from './lib/plan-fixture.mjs'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

const repo = fileURLToPath(new URL('..', import.meta.url))
await mkdir(join(repo, '.test-results'), {recursive:true})
const root = await mkdtemp(join(repo, '.test-results/image-tool-'))
await mkdir(root, { recursive: true })
const outfile = join(root, 'modules.mjs')
await build({ stdin: { contents: `export { createImageTool } from './src/main/pi/image';
export * from './src/main/pi/image-protocol';
export { uncoveredWrites } from './src/main/rewind/coverage';
export { collectTool } from './src/main/library/extract';
export { extractSubagentWrittenFiles } from './src/main/pi/subagents/derive';
export { extractTurnWrittenFiles } from './src/renderer/src/lib/turn-written-files';
export * from './src/main/pi/usage-stats';`, resolveDir: repo },
  bundle: true, format: 'esm', platform: 'node', outfile,
  plugins: [{ name: 'sdk', setup(builder) {
    builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
  } }]
})
const { createImageTool, createNativeImagesApi, ensureOpenRouterNativeImages, uncoveredWrites, collectTool, extractSubagentWrittenFiles, extractTurnWrittenFiles, createUsageAccumulator, accumulateSessionFile, finalizeUsage } = await import(pathToFileURL(outfile))
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
export const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))])
let sequence = 0
const results = []
const args = extra => ({ action: 'generate', prompt: 'A red square', protocol: 'native', ...extra })
const success = (model, blocks) => ({ ...model, output: blocks ?? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], stopReason: 'stop', timestamp: Date.now() })
async function fixture(handler, options = {}) {
  const cwd = join(root, `workspace-${Date.now()}-${++sequence}`), outside = join(root, `outside-${Date.now()}-${sequence}`)
  await mkdir(cwd); await mkdir(outside)
  const id = `test/model-${sequence}`, requests = []
  const models = Object.fromEntries(['native','chat'].map(protocol => [protocol, { type: 'image', id, name: id, api: protocol === 'native' ? 'openrouter-native-images' : 'openrouter-images', provider: protocol === 'native' ? 'openrouter-native' : 'openrouter', input: ['text','image'], output: ['image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]))
  const runtime = { getAuth: async () => undefined, getModelOfType: (_type, provider) => provider === 'openrouter-native' ? models.native : models.chat,
    getAvailableOfType: async () => Object.values(models), generateImages: async (model, context, opts) => { requests.push({ model, context, options: opts }); return handler ? handler(model, context, opts, { cwd, outside }) : success(model) } }
  const tool = createImageTool({ cwd, runtime, canStart: () => true, getMode: () => 'workspace-write', ...options })
  return { cwd, outside, id, requests, tool, run: (extra, signal) => tool.execute('probe', args({ model: id, ...extra }), signal) }
}
async function test(name, fn) { try { const evidence = await fn(); results.push({ name, status: 'PASS', evidence }); console.log('PASS', name, evidence ?? '') } catch (e) { results.push({ name, status: 'FAIL', error: e.message }); console.log('FAIL', name, e.stack) } }

await test('native generation saves exact bytes', async () => { const f = await fixture(); const r = await f.run(); assert.deepEqual(await readFile(r.details.files[0].path), png); assert.equal(r.details.files[0].width, 1) })
await test('edit passes source image bytes', async () => { const f = await fixture(); await writeFile(join(f.cwd,'input.png'), png); await f.run({ action: 'edit', input_images: ['input.png'] }); assert.equal(f.requests[0].context.input[1].data, png.toString('base64')) })
await test('Plan and read-only reject before provider call', async () => { for (const options of [{ isPlanRestricted: () => true }, { getMode: () => 'read-only' }]) { const f = await fixture(null, options); await assert.rejects(f.run()); assert.equal(f.requests.length, 0) } })
await test('existing explicit path rejects before provider call', async () => { const f = await fixture(); await writeFile(join(f.cwd,'old.png'),'old'); await assert.rejects(f.run({ output_path: 'old.png' })); assert.equal(f.requests.length, 0) })
await test('first auto call falls back from native to chat', async () => { const f = await fixture(model => model.provider === 'openrouter-native' ? { ...success(model), output: [], stopReason: 'error', errorMessage: 'Use the chat/completions endpoint for this model' } : success(model)); await f.run({ protocol: 'auto' }); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].model.provider,'openrouter') })
await test('extension correction rechecks sandbox target', async () => { const f = await fixture(); const victim = join(f.outside,'victim.png'); await writeFile(victim, 'untouched'); await symlink(victim,join(f.cwd,'out.png')); let error; try { await f.run({ output_path: 'out.jpg', overwrite: true }) } catch (e) { error = e.message } assert.equal((await readFile(victim)).toString(), 'untouched', `outside-workspace bytes changed (tool error=${error})`) })
await test('explicit target rejects symlink swap during generation', async () => { let victim; const f = await fixture(async (model, _ctx, _opts, env) => { victim = join(env.outside,'victim.png'); await writeFile(victim,'untouched'); await rm(join(env.cwd,'target'), { recursive: true }); await symlink(env.outside, join(env.cwd,'target')); return success(model) }); await f.run({ output_path: 'target/victim.png' }); assert.equal((await readFile(victim)).toString(), 'untouched') })
await test('overwrite false does not clobber file created during request', async () => { const f = await fixture(async (model, _ctx, _opts, env) => { await writeFile(join(env.cwd,'out.png'),'other session output'); return success(model) }); try { await f.run({ output_path: 'out.png' }) } catch {} assert.equal((await readFile(join(f.cwd,'out.png'))).toString(), 'other session output') })
await test('fixed path rechecks live read-only policy', async () => { let mode = 'workspace-write'; const f = await fixture(model => { mode = 'read-only'; return success(model) }, { getMode: () => mode }); assert.equal((await f.run({ output_path: 'out.png' })).isError, true) })
await test('chat preserves restrictive provider routing', async () => { const f = await fixture(); await f.run({ protocol: 'chat', data_collection: 'deny', only: ['trusted'], allow_fallbacks: false }); const forwarded = JSON.stringify(await f.requests[0].options.onPayload({ model:f.id })); assert(forwarded.includes('deny') && forwarded.includes('trusted'), 'chat request options dropped data_collection, only and allow_fallbacks: ' + forwarded) })
await test('corrupt provider image is rejected before saving success', async () => { const f = await fixture(model => success(model,[{ type: 'image', data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' }])); assert.equal((await f.run()).isError, true) })
await test('dotted directory accepts multiple images', async () => { const f = await fixture(model => success(model, [1,2].map(() => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })))); await mkdir(join(f.cwd,'v1.0')); const r = await f.run({ n: 2, output_path: 'v1.0/' }); assert.equal(r.details.files.length, 2) })
await test('successful image write appears in Rewind coverage', async () => { const f = await fixture(null,{ getMode: () => 'danger-full-access' }); const r = await f.run({ output_path: join(f.outside,'out.png') }); const branch = [{ type: 'message', id: 'a', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'probe', name: 'image', arguments: args({ output_path: join(f.outside,'out.png') }) }] } }, { type: 'message', id: 'b', message: { role: 'toolResult', toolName: 'image', toolCallId: 'probe', isError: false, ...r } }]; const uncovered = await uncoveredWrites(branch,f.cwd,f.cwd,null,[]); assert.equal(uncovered.length,1, 'outside-workspace image write missing from skip/consent coverage') })
await test('Library generated image keeps original path', async () => { const f = await fixture(); const r = await f.run(); const items = collectTool({ id: 'probe', path: 'session.jsonl', cwd: f.cwd, workspace: f.cwd, title: 'probe' }, 'entry', Date.now(),'image', args(),r); assert.equal(items[0].imageLabel,'generated'); assert.equal(items[0].originalPath,r.details.files[0].path) })
await test('native transport honors timeoutMs', async () => { const original = globalThis.fetch; let receivedSignal; globalThis.fetch = async (_url, options) => { receivedSignal = options.signal; return new Promise(resolve => { const timer = setTimeout(() => resolve(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] }), { status: 200 })), 60); options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(new Response('{}',{ status: 499 })) },{ once: true }) }) }; try { const started = Date.now(); const result = await createNativeImagesApi(async () => 'fixture').generateImages({ id:'probe',provider:'openrouter-native',api:'openrouter-native-images',baseUrl:'http://test.invalid' }, { input: [{ type:'text',text:'test' }] }, { timeoutMs: 5 }); assert.notEqual(result.stopReason,'stop', `provider continued ${Date.now()-started}ms past timeout; signal attached=${Boolean(receivedSignal)}`) } finally { globalThis.fetch = original } })
await test('auto remembers working protocol without retrying authorization failures', async () => {
  const f = await fixture(model => model.provider === 'openrouter-native' ? { ...success(model), output: [], stopReason: 'error', errorMessage: 'Use the chat/completions endpoint' } : success(model))
  assert.equal((await f.run({ protocol: 'auto' })).details.protocol, 'chat')
  await f.run({ protocol: 'auto' }); assert.equal(f.requests.length, 3)
  const denied = await fixture(model => ({ ...success(model), output: [], stopReason: 'error', errorMessage: '401: Unauthorized' }))
  assert.equal((await denied.run({ protocol: 'auto' })).isError, true); assert.equal(denied.requests.length, 1)
})
await test('chat explicitly reports unsupported controls and fails required downgrade', async () => {
  const f = await fixture()
  const result = await f.run({ protocol:'chat', resolution:'2K', quality:'high' })
  assert.deepEqual(result.details.ignoredParameters, ['resolution','quality'])
  assert.match(result.content[0].text, /Not applied/)
  const before = f.requests.length
  assert.equal((await f.run({ protocol:'chat', resolution:'2K', require_parameters:true })).isError, true)
  assert.equal(f.requests.length, before)
})
await test('cancelled and closed admission calls cannot write after the request', async () => {
  const abort = new AbortController()
  const f = await fixture(model => { abort.abort(); return success(model) })
  assert.equal((await f.run({ output_path:'cancelled.png' }, abort.signal)).isError, true)
  assert.deepEqual(await readdir(f.cwd), [])
  let allowed = true
  const closed = await fixture(model => { allowed = false; return success(model) }, { canStart:() => allowed })
  assert.equal((await closed.run({ output_path:'closed.png' })).isError, true)
  assert.deepEqual(await readdir(closed.cwd), [])
})
await test('atomic overwrite and unique default names preserve complete bytes', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd,'out.png'), 'old')
  const r = await f.run({ output_path:'out.png', overwrite:true })
  assert.deepEqual(await readFile(r.details.files[0].path), png)
  const [a,b] = await Promise.all([f.run(),f.run()])
  assert.notEqual(a.details.files[0].path,b.details.files[0].path)
  assert.deepEqual(await readFile(a.details.files[0].path),png)
  assert.deepEqual(await readFile(b.details.files[0].path),png)
  assert(!(await readdir(join(f.cwd,'images'))).some(name=>name.endsWith('.tmp')))
})
await test('whole-batch validation rejects corruption, excessive count and oversized headers', async () => {
  const good = { type:'image',data:png.toString('base64'),mimeType:'image/png' }
  const huge = Buffer.from(png); huge.writeUInt32BE(100000,16)
  for (const blocks of [[good,{...good,data:png.subarray(0,26).toString('base64')}], [good,good,good], [{...good,data:huge.toString('base64')}], [{...good,data:'!invalid!'}]]) {
    const f = await fixture(model=>success(model,blocks))
    const r = await f.run({ n:2 })
    assert.equal(r.isError,true); assert.deepEqual(r.details.files,[])
    assert.deepEqual(await readdir(join(f.cwd,'images')),[])
  }
})
await test('actual image encoding determines saved extension and valid SVG keeps original bytes', async () => {
  const f = await fixture(model=>success(model,[{type:'image',data:png.toString('base64'),mimeType:'image/jpeg'}]))
  const r = await f.run({ output_path:'wrong.jpg' })
  assert.equal(r.details.files[0].path, join(f.cwd,'wrong.png')); assert.equal(r.details.renamed,true)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>'
  const vector = await fixture(model=>success(model,[{type:'image',data:Buffer.from(svg).toString('base64'),mimeType:'image/svg+xml'}]))
  const v = await vector.run({ output_format:'svg' })
  assert.equal(v.isError,undefined); assert.equal((await readFile(v.details.files[0].path)).toString(),svg)
  assert.equal(v.content[1].mimeType,'image/png'); assert.equal(v.details.files[0].width,24)
  for (const source of [svg.replace('<rect','<script>alert(1)</script><rect'),svg.replace('<rect','<image href="https://invalid.example/image.png"/><rect')]) {
    const invalid = await fixture(model=>success(model,[{type:'image',data:Buffer.from(source).toString('base64'),mimeType:'image/svg+xml'}]))
    assert.equal((await invalid.run()).isError,true)
  }
})
await test('invalid edit source fails before the provider', async () => {
  const f = await fixture(); await writeFile(join(f.cwd,'bad.png'), png.subarray(0,26))
  await assert.rejects(f.run({action:'edit', input_images:['bad.png']})); assert.equal(f.requests.length,0)
})
const billedUsage = {input:24,output:4096,cacheRead:0,cacheWrite:0,totalTokens:4120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0.014}}
await test('failed saves retain billing and only committed partial writes across every consumer', async () => {
  let directory
  const partial = await fixture(model=>({...success(model,Array.from({length:2},()=>({type:'image',data:png.toString('base64'),mimeType:'image/png'}))),usage:billedUsage}), {
    getMode:()=> directory && readdirSync(directory).some(name=>name.endsWith('.png')) ? 'read-only' : 'workspace-write'
  })
  directory=join(partial.cwd,'images');await mkdir(directory)
  // Simulate a policy transition after the first atomic publication.
  const result = await partial.run({n:2})
  assert.equal(result.isError,true); assert.equal(result.details.files.length,1)
  assert.equal(result.usage.cost.total,0.014)
  const assistant = { role:'assistant', content:[{type:'toolCall',id:'probe',name:'image',arguments:{}}] }
  const message = {role:'toolResult',toolName:'image',toolCallId:'probe',timestamp:Date.now(),...result}
  const childWrites=extractSubagentWrittenFiles([assistant,message],partial.cwd)
  assert.equal(childWrites.length,1)
  assert.equal(childWrites[0].kind,'generated-image')
  assert.equal(extractTurnWrittenFiles([assistant],new Map([['probe',message]]),partial.cwd).length,0,'generated images are not code changes')
  const textFile={filePath:join(partial.cwd,'note.txt'),displayPath:'note.txt',patch:'--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note',added:1}
  const svgEdit={filePath:join(partial.cwd,'icon.svg'),displayPath:'icon.svg',patch:'--- a/icon.svg\n+++ b/icon.svg\n@@ -1 +1 @@\n-old\n+new',added:1,removed:1}
  for(const written of [childWrites[0],{...childWrites[0],kind:undefined}]) {
    const subagent={sessionId:'child',runId:'image-run',writtenFilesScope:'run',writtenFiles:[written,textFile,svgEdit]}
    const parent={role:'assistant',content:[{type:'toolCall',id:'child-call',name:'agent',arguments:{}}]}
    const childResult={role:'toolResult',toolName:'agent',timestamp:1,details:{subagent}}
    const notice={role:'custom',customType:'subagent_completion',timestamp:2,details:{subagent}}
    for(const files of [
      extractTurnWrittenFiles([parent],new Map([['child-call',childResult]]),partial.cwd),
      extractTurnWrittenFiles([],new Map(),partial.cwd,[notice])
    ]) assert.deepEqual(files.map(file=>file.filePath),[textFile.filePath,svgEdit.filePath],'foreground, background and legacy image receipts stay outside diffs; text edits remain')
  }
  const entries = [{type:'message',id:'a',message:assistant},{type:'message',id:'b',message}]
  assert.equal((await uncoveredWrites(entries,partial.cwd,partial.cwd,null,[{path:'images',reason:'ignored'}])).length,1)
  assert.equal(collectTool({id:'s',path:'session.jsonl',cwd:partial.cwd,workspace:partial.cwd,title:'Image fixture'},'b',Date.now(),'image',{},result).length,1)
  const accumulator=createUsageAccumulator(); accumulateSessionFile(accumulator, entries.map(e=>JSON.stringify({...e,timestamp:new Date().toISOString()})).join('\n'))
  const stats=finalizeUsage(accumulator,100); assert.equal(stats.totalCost,0.014)
  assert.equal(stats.models[0].model,partial.id); assert.equal(stats.models[0].provider,'openrouter')
})
await test('native wire contract uses live auth, routing, callbacks and options.fetch', async () => {
  let key = 'old'; const bodies=[], headers=[], responses=[]
  const api = createNativeImagesApi(async()=>key)
  const model = {id:'fixture/image',provider:'openrouter-native',api:'openrouter-native-images',baseUrl:'https://fixture.invalid/api/v1/',headers:{'X-Model':'model'}}
  const result = await api.generateImages(model,{input:[{type:'text',text:'edit'},{type:'image',data:png.toString('base64'),mimeType:'image/png'}]}, {
    apiKey:'stale', headers:{'X-Call':'call'}, metadata:{openrouterImage:{n:2,seed:0,outputCompression:0,routing:{only:['trusted'],allowFallbacks:false,dataCollection:'deny',requireParameters:true,order:['trusted'],ignore:['other']}}},
    onPayload:body=>({...body,prompt:'changed'}), onResponse:r=>responses.push(r.status),
    fetch:async(url, init)=>{
      assert.equal(url,'https://fixture.invalid/api/v1/images'); headers.push(new Headers(init.headers));bodies.push(JSON.parse(init.body))
      if(bodies.length===1){key='new';return new Response('{"error":{"message":"expired"}}',{status:401})}
      return new Response(JSON.stringify({data:[{b64_json:png.toString('base64'),media_type:'image/png'}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25,cost:0.012}}))
    }
  })
  assert.equal(result.stopReason,'stop');assert.equal(result.usage.cost.total,0.012)
  assert.deepEqual(responses,[401,200]); assert.equal(headers[0].get('authorization'),'Bearer old');assert.equal(headers[1].get('authorization'),'Bearer new')
  assert.equal(headers[1].get('x-model'),'model');assert.equal(headers[1].get('x-call'),'call')
  assert.equal(bodies[0].prompt,'changed');assert.equal(bodies[0].seed,0);assert.equal(bodies[0].output_compression,0)
  assert.deepEqual(bodies[0].provider,{only:['trusted'],allow_fallbacks:false,data_collection:'deny',require_parameters:true,order:['trusted'],ignore:['other']})
  assert.equal(bodies[0].input_references[0].image_url.url,`data:image/png;base64,${png.toString('base64')}`)
  key=undefined;const blocked=await api.generateImages(model,{input:[]},{apiKey:'stale',fetch:()=>assert.fail('revoked key used')});assert.equal(blocked.stopReason,'error')
})
await test('native transport rejects malformed and oversized responses and honors caller abort', async () => {
  const api=createNativeImagesApi(async()=> 'fixture'), model={id:'m',provider:'openrouter-native',api:'openrouter-native-images'}
  for(const response of [new Response('invalid'),new Response('{"data":[]}'),new Response('oversized',{headers:{'content-length':String(129*1024*1024)}})]) {
    const r=await api.generateImages(model,{input:[]},{fetch:async()=>response});assert.equal(r.stopReason,'error')
  }
  const signal=AbortSignal.abort();const r=await api.generateImages(model,{input:[]},{signal,fetch:()=>assert.fail('aborted request sent')});assert.equal(r.stopReason,'aborted')
})
await test('real SDK default schema, accounting, credential rotation and revocation', async () => {
  const f=await createPlanFixture()
  try {
    await f.managed.lifecyclePromise
    const runtime=await f.app.runtime(), getModel=runtime.getModelOfType.bind(runtime)
    runtime.getAuth=async()=>undefined
    runtime.getModelOfType=(type,provider,id)=>type==='image'?{type,id,provider,api:'openrouter-native-images',input:['text','image'],output:['image'],cost:billedUsage.cost}:getModel(type,provider,id)
    runtime.generateImages=async model=>({...success(model),usage:billedUsage})
    const next=f.requests.length+1
    f.setRespond(index=>index===next?[{type:'toolCall',id:'sdk-image',name:'image',arguments:{action:'generate',prompt:'square',model:'test/image',output_path:'sdk.png'}}]:[{type:'text',text:'done'}])
    await f.session.prompt('Generate an image')
    const result=f.session.messages.find(m=>m.role==='toolResult'&&m.toolCallId==='sdk-image')
    assert.equal(result.isError,false);assert.equal(result.usage.cost.total,0.014)
    assert.equal(result.content.filter(b=>b.type==='image').length,1);assert.equal(f.session.getSessionStats().cost,0.014)
  } finally { await f.close() }
  const authDir=join(root,'auth');await mkdir(authDir)
  const runtime=await ModelRuntime.create({authPath:join(authDir,'auth.json'),modelsPath:join(authDir,'models.json'),modelsStorePath:join(authDir,'models-store'),refreshOnCreate:false,allowModelNetwork:false})
  await runtime.setRuntimeApiKey('openrouter','old-key');await ensureOpenRouterNativeImages(runtime)
  const model=runtime.getModelsOfType('image','openrouter-native')[0];assert(model)
  await runtime.setRuntimeApiKey('openrouter','new-key');await ensureOpenRouterNativeImages(runtime)
  assert.equal(runtime.getRegisteredProviderConfig('openrouter-native').apiKey,'new-key')
  const originalFetch=globalThis.fetch, requests=[]
  let failed=false
  globalThis.fetch=async(_url,init)=>{
    requests.push(JSON.parse(init.body))
    const usage={prompt_tokens:10,completion_tokens:2,total_tokens:12,cost:0.025}
    return new Response(JSON.stringify(failed ? {error:{message:'Fixture rejected'},usage} : {
      id:'fixture-image',choices:[{message:{content:'A square',images:[{image_url:{url:`data:image/png;base64,${png.toString('base64')}`}}]}}],usage
    }),{status:failed?400:200,headers:{'content-type':'application/json'}})
  }
  try {
    const tool=createImageTool({cwd:authDir,runtime,getMode:()=> 'workspace-write',canStart:()=>true})
    const inputs={action:'generate',prompt:'fixture',protocol:'chat',model:model.id,only:['trusted'],data_collection:'deny',allow_fallbacks:false}
    const chat=await tool.execute('wire',inputs)
    assert.equal(chat.isError,undefined);assert.equal(chat.usage.cost.total,0.025,'actual API billing overrides the SDK token-price estimate')
    assert.deepEqual(requests[0].provider,{only:['trusted'],data_collection:'deny',allow_fallbacks:false})
    failed=true
    const rejected=await tool.execute('wire-failed',inputs)
    assert.equal(rejected.isError,true);assert.equal(rejected.usage.cost.total,0.025,'charged failures retain actual usage')
    assert.equal(requests.length,2,'a failed generation is not retried automatically')
  } finally {globalThis.fetch=originalFetch}
  await runtime.removeRuntimeApiKey('openrouter');await ensureOpenRouterNativeImages(runtime)
  assert.equal(runtime.getRegisteredProviderConfig('openrouter-native'),undefined)
})
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length}))
await rm(root,{recursive:true,force:true})
if(results.some(r=>r.status==='FAIL'))process.exitCode=1
