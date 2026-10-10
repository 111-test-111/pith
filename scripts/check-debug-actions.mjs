/** Registry contract + source identity through the production DAP transport. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Check } from 'typebox/value'
const temp = mkdtempSync(join(tmpdir(), 'pith-debug-actions-'))
const log=join(temp,'requests.jsonl');process.env.PI_DAP_PROTOCOL_LOG=log
let manager
try {
  await build({ stdin: { contents: `export * from './src/main/debug/action-registry'; export * from './src/main/debug/identity'; export * from './src/main/debug/manager'; export * from './src/main/debug/adapters'; export * from './src/main/debug/tools'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|typebox)$/ }, a => ({ path: fileURLToPath(import.meta.resolve(a.path)), external: true })) } }] })
  const { DebugManager, debugAdapterSpec, prepareDebugArguments, debugActions, debugParameters, dispatchDebugAction, dispatchDebugPanel, debugSource, createDebugTools } = await import(pathToFileURL(join(temp, 'module.mjs')))
  // Real preflight, before substituting protocol-only virtual programs.
  for (const adapter of ['lldb-dap', 'debugpy', 'js-debug']) {
    const spec = debugAdapterSpec(temp, adapter)
    assert.throws(() => spec.validateLaunch({ program: 'missing-program', cwd: temp }), error => error.code === 'DEBUG_PROGRAM_NOT_FOUND')
    spec.validateLaunch({ program: process.execPath, cwd: temp })
  }
  debugAdapterSpec(temp, 'debugpy').validateLaunch({ module: 'package.module', cwd: temp })
  debugAdapterSpec(temp, 'dlv').validateLaunch({ program: 'example.org/package/cmd/demo', mode: 'debug', cwd: temp })
  debugAdapterSpec(temp, 'js-debug').validateLaunch({ program: '/remote/demo.js', remoteRoot: '/remote', cwd: temp })
  assert.deepEqual(Object.keys(debugParameters.properties).sort(), ['debugId','stopId','request','sandbox_permissions','justification'].sort())
  assert.equal(debugParameters.properties.request.anyOf.length, Object.keys(debugActions).length)
  assert.deepEqual(prepareDebugArguments({ action: 'breakpoints', debugId:'a', file:'/demo.c', lines:[4,7], conditions:['v > 0',''] }), { debugId:'a', request:{action:'breakpoints', file:'/demo.c', items:[{line:4,condition:'v > 0'},{line:7,condition:''}]}})
  for (const bad of [ { action:'stack', expression:'wrong action field' }, { request:{action:'stop', file:'unexpected'} }, { action:'stop', request:{action:'stop'} }, {action:'breakpoints',file:'/f',lines:[1],conditions:[]}, {request:{action:'scopes'}}, {request:{action:'__proto__'}}, {request:{action:'variables',variablesReference:1,count:501}} ]) assert.throws(()=>prepareDebugArguments(bad))
  assert.deepEqual(debugSource({path:'/f',sourceReference:0}),{kind:'file',path:'/f'})
  assert.deepEqual(debugSource({path:'/fake',sourceReference:9}),{kind:'adapter',path:'/fake',sourceReference:9})
  assert.equal(debugSource({name:'anonymous'}),undefined)
  manager = new DebugManager(()=>{})
  // Protocol fixtures use virtual target paths. Keep argument validation but
  // substitute a real file only for the host-file preflight.
  for (const spec of [debugAdapterSpec(temp, 'lldb-dap')]) {
    const validate = spec.validateLaunch
    spec.validateLaunch = args => validate({ ...args, ...(typeof args.program === 'string' ? { program: process.execPath } : {}) })
  }
  debugAdapterSpec(temp, 'lldb-dap').detect = async()=>({ command:process.execPath, args:[resolve('scripts/debug-fixtures/protocol-adapter.mjs'),'identity'] })
  const start = (program, sessionPath='/parent')=>manager.start({sessionId:sessionPath,sessionPath,workspaceCwd:temp,cwd:temp,adapterId:'lldb-dap',kind:'launch',program})
  const a=await start('/one'), b=await start('/two'), child=await start('/child','/child')
  const context={manager,sessionPath:'/parent',debugId:a.id,stopId:a.stopId}
  assert.equal(a.location.file,undefined);assert.equal(a.location.source.kind,'adapter')
  assert.equal(a.location.instructionPointerReference,'0xFFFFFFFFFFFFFFF0');assert.equal(a.location.moduleId,'mod-1')
  assert.equal(a.capabilities.supportsDisassembleRequest,true)
  assert.deepEqual(await dispatchDebugPanel(manager,{sessionPath:'/parent',debugId:a.id,stopId:a.stopId,action:'threads'}),await dispatchDebugAction(context,{action:'threads'}))
  const request={action:'source',sourceReference:1,sourceVersion:a.sourceVersion}
  assert.match((await dispatchDebugAction(context,request)).content,/\/one/)
  assert.match((await manager.source('/parent',1,b.sourceVersion,b.id,b.stopId)).content,/\/two/)
  await assert.rejects(dispatchDebugAction({...context,debugId:child.id},request),/No debug session/)
  await assert.rejects(dispatchDebugAction({...context,debugId:undefined},request),/debugId and stopId/)
  const scopes=await manager.scopes('/parent',1,a.id,a.stopId);assert.equal(scopes[0].presentationHint,'registers')
  const variables=await manager.variables('/parent',100,0,1,a.id,a.stopId);assert.equal(variables.variables[0].memoryReference,'opaque:memory:1')
  const unpinned={manager,sessionPath:'/parent',debugId:a.id}
  for(const reference of [{action:'scopes',frameId:1},{action:'variables',variablesReference:100},{action:'evaluate',expression:'value',frameId:1}])
    await assert.rejects(dispatchDebugAction(unpinned,reference),/debugId and stopId are required/)
  assert.equal((await dispatchDebugAction(unpinned,{action:'evaluate',expression:'value'})).result,'42')
  await manager.evaluate('/parent','invalidate',1,a.id,a.stopId)
  assert.equal(manager.get('/parent',a.id).capabilities.supportsDisassembleRequest,false)
  await assert.rejects(dispatchDebugAction(context,request),/source changed/)
  await manager.control('/parent','next',1,500,a.id,a.stopId)
  await assert.rejects(dispatchDebugAction(context,request),/stop changed/i)
  for(const reference of [{action:'scopes',frameId:1},{action:'variables',variablesReference:100},{action:'evaluate',expression:'value',frameId:1}])
    await assert.rejects(dispatchDebugAction(context,reference),/stop changed/i)
  const options={manager,services:{cwd:temp},sessionId:'p',sessionPath:'/parent',enabled:()=>true,sandboxMode:()=> 'read-only',canStart:()=>true,runInTerminal:()=>undefined}
  const tool=createDebugTools(options)[0]
  for (const request of [{ action:'help' }, { action:'sessions' }, { action:'threads' }, { action:'stack' }, { action:'registers',frameId:1 }, { action:'variables',variablesReference:100 }, { action:'output' }]) {
    const result = await tool.execute('schema', {debugId:b.id,stopId:b.stopId,request}, undefined, undefined, {cwd:temp})
    assert(Check(tool.outputSchema, result.structuredContent), `advertised result schema: ${request.action}`)
  }
  // Detailed recipes stay discoverable without riding every model request.
  const help = await tool.execute('help-topic', {request:{action:'help',topic:'breakpoints'}}, undefined, undefined, {cwd:temp})
  assert(Check(tool.outputSchema, help.structuredContent))
  assert.deepEqual(help.structuredContent.data.actions.map(action => action.action), ['breakpoints'])
  assert(help.structuredContent.data.actions[0].guidelines.some(text => text.includes('NOT expression validity')))
  const aliasHelp = await tool.execute('help-alias', {request:{action:'help',topic:'breakpoints.instruction.toggle'}}, undefined, undefined, {cwd:temp})
  assert(aliasHelp.structuredContent.data.actions[0].guidelines.some(text => text.includes('ASLR')))
  await assert.rejects(tool.execute('bad-help', {request:{action:'help',topic:'__proto__'}}, undefined, undefined, {cwd:temp}), /Unknown debug help topic/)
  const missing=await tool.execute('missing',{debugId:'missing',request:{action:'stack'}},undefined,undefined,{cwd:temp})
  assert.equal(missing.structuredContent.error.code,'DEBUG_SESSION_NOT_FOUND')
  const stale=await tool.execute('stale',{debugId:b.id,stopId:b.stopId+1,request:{action:'stack'}},undefined,undefined,{cwd:temp})
  assert.equal(stale.structuredContent.error.code,'DEBUG_STALE_STOP')
  const { validateToolArguments }=await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')))
  for (const raw of [{action:'sessions'}, {debugId:b.id,request:{action:'breakpoints',file:'/file.c',items:[{line:2,condition:'x>0'}]}}, {debugId:b.id,stopId:1,request:{action:'disassemble',memoryReference:'0x2000000000000001',count:20}}]) {
    const prepared=tool.prepareArguments(raw)
    assert.deepEqual(validateToolArguments(tool,{id:'test',name:'debug',arguments:prepared}),prepared,'installed SDK validator must preserve nested action arguments')
  }
  assert.deepEqual(tool.prepareArguments({action:'sessions'}),{request:{action:'sessions'}})
  for (const request of [{action:'evaluate',expression:'mutate()'},{action:'control',control:'next'},{action:'breakpoints',file:'/f',items:[]},{action:'adapters'}]) await assert.rejects(tool.execute('test',{debugId:b.id,request},undefined,undefined,{cwd:temp}),/sandbox/i)
  assert.ok(JSON.parse((await tool.execute('list',{request:{action:'sessions'}},undefined,undefined,{cwd:temp})).content[0].text).length>=2)
  const restricted=createDebugTools({...options,isPlanRestricted:()=>true})[0]
  await assert.rejects(restricted.execute('test',{request:{action:'sessions'}},undefined,undefined,{cwd:temp}),/Plan mode/)
  await manager.stopSession('/parent');await manager.stopSession('/child')
  // Native operations share the same admission and preserve opaque references.
  const useNative = mode => { debugAdapterSpec(temp, 'lldb-dap').detect = async()=>({ command:process.execPath, args:[resolve('scripts/debug-fixtures/protocol-adapter.mjs'),mode] }) }
  for (const mode of ['native-paged','native-unpaged','native-ignore-start']) {
    useNative(mode)
    let dto=await start('/native')
    const act=request=>dispatchDebugAction({manager,sessionPath:'/parent',debugId:dto.id,stopId:dto.stopId},request)
    const address='0x2000000000000001'
    const rows=await act({action:'disassemble',memoryReference:address,count:3})
    assert.equal(rows.instructions[0].address,address);assert.equal(rows.instructions[0].source.kind,'adapter')
    const memory=await act({action:'memory.read',memoryReference:'opaque:exact-ref',count:8})
    assert.equal(memory.address,'opaque:exact-ref');assert.equal(memory.hex,'01 02 03 04');assert.equal(memory.bytesRead,4);assert.equal(memory.unreadableBytes,4);assert.equal(memory.truncated,true)
    const gap=await act({action:'memory.read',memoryReference:address,offset:1,count:8})
    assert.equal(gap.hex,'');assert.equal(gap.bytesRead,0);assert.equal(gap.unreadableBytes,8)
    const moduleIds=[]
    for(let start=0;start<51;start+=20){const page=await act({action:'modules',start,count:20});moduleIds.push(...page.modules.map(m=>m.id));assert.equal(page.truncated,start<40)}
    assert.deepEqual(moduleIds,Array.from({length:51},(_,i)=>i))
    await act({action:'breakpoints.instruction',items:[{instructionReference:address,offset:4,condition:'value>0'}]})
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).instruction[0].conditionStatus,'unvalidated')
    await act({action:'breakpoints.instruction.toggle',instructionReference:'0x2000000000000005'})
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).instruction.length,0,'toggle must remove the relocated/offset binding')
    await act({action:'breakpoints.instruction',items:[{instructionReference:address}]})
    await act({action:'breakpoints.function',items:[{name:'entry',condition:'x > 0'}]})
    await Promise.all([act({action:'breakpoints.function.update',name:'other',enabled:true}),act({action:'breakpoints.function.update',name:'third',enabled:true})])
    await act({action:'breakpoints.function.update',name:'other',enabled:false})
    assert.deepEqual(manager.nativeBreakpoints('/parent',dto.id).function.map(point=>point.name),['entry','third'])
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).function[0].condition,'x > 0')
    await Promise.all([act({action:'breakpoints.instruction.update',instructionReference:'0x2000000000000011',enabled:true}),act({action:'breakpoints.instruction.update',instructionReference:'0x2000000000000021',enabled:true})])
    await act({action:'breakpoints.instruction.update',instructionReference:'0x2000000000000011',enabled:false})
    assert.deepEqual(manager.nativeBreakpoints('/parent',dto.id).instruction.map(point=>point.instructionReference),[address,'0x2000000000000021'])
    // Native restart clears absolute addresses before issuing restart, retaining named intent.
    dto=await manager.restart('/parent',dto.id)
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).instruction.length,0)
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).function[0].name,'entry')
    const wire=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
    const restartIndex=wire.findLastIndex(r=>r.command==='restart')
    assert.deepEqual(wire[restartIndex-1].arguments.breakpoints,[])
    const slow=act({action:'disassemble',memoryReference:address,offset:99,count:2});const stale=assert.rejects(slow,/stop changed/i)
    dto=(await act({action:'control',control:'next',granularity:'instruction',waitMs:500})).session;await stale
    const memorySlow=act({action:'memory.read',memoryReference:address,offset:99,count:8});const memoryStale=assert.rejects(memorySlow,/stop changed/i)
    dto=(await act({action:'control',control:'next',waitMs:500})).session;await memoryStale
    const oldStop=dto.stopId
    await act({action:'evaluate',expression:'invalidate-refs'}).catch(error=>assert.match(error.message,/stop changed/i))
    dto=manager.get('/parent',dto.id);assert.ok(dto.stopId>oldStop)
    const waiting=act({action:'breakpoints.instruction.toggle',instructionReference:address})
    const moving=act({action:'control',control:'next',granularity:'instruction',waitMs:500})
    await waiting;dto=(await moving).session
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).instruction.length,1)
    await act({action:'evaluate',expression:'remove-instruction'})
    assert.equal(manager.nativeBreakpoints('/parent',dto.id).instruction.length,0)
    await act({action:'evaluate',expression:'invalidate'})
    await assert.rejects(act({action:'disassemble',memoryReference:address,count:2}),/does not support/)
    const readonly=createDebugTools(options)[0]
    assert.ok(await readonly.execute('read',{debugId:dto.id,stopId:dto.stopId,request:{action:'memory.read',memoryReference:address,count:8}},undefined,undefined,{cwd:temp}))
    for (const request of [{action:'breakpoints.instruction',items:[]},{action:'breakpoints.function',items:[]}]) await assert.rejects(readonly.execute('set',{debugId:dto.id,stopId:dto.stopId,request},undefined,undefined,{cwd:temp}),/sandbox/i)
    await manager.stop('/parent',dto.id)
  }
  useNative('native-large-source')
  const large = await start('/large-source')
  const sourceRef = large.location.source.sourceReference
  const sourceAction = request => dispatchDebugAction({ manager, sessionPath: '/parent', debugId: large.id, stopId: large.stopId },
    { action: 'source', sourceReference: sourceRef, sourceVersion: large.sourceVersion, ...request })
  const first = await sourceAction({})
  assert.equal(first.startLine, 1)
  assert.ok(first.content.length <= 16_384 && first.nextOffset < first.totalChars)
  const late = await sourceAction({ startLine: 12_001, limit: 256 })
  assert.equal(late.startLine, 12_001)
  assert.ok(late.offset > 262_144)
  assert.match(late.content, /TARGET_AFTER_262144/)
  assert.equal((await sourceAction({ offset: late.offset, limit: 256 })).content, late.content)
  await manager.stop('/parent', large.id)
  useNative('native-source-boundaries')
  const boundary = await start('/boundary-source')
  const windowAt = request => dispatchDebugAction({ manager, sessionPath: '/parent', debugId: boundary.id, stopId: boundary.stopId },
    { action: 'source', sourceReference: boundary.location.source.sourceReference, sourceVersion: boundary.sourceVersion, limit: 40, ...request })
  const header = await windowAt({})
  assert.equal(header.content, 'first\n')
  assert.equal(header.nextOffset, 6, 'complete lines must not be cut at the character budget')
  const longLine = await windowAt({ offset: header.nextOffset })
  assert.equal(longLine.content, 'X'.repeat(40))
  assert.equal(longLine.startLine, 2)
  assert.equal(longLine.continuedLine, false)
  const continuation = await windowAt({ offset: longLine.nextOffset })
  assert.equal(continuation.startLine, 2)
  assert.equal(continuation.continuedLine, true)
  assert.equal(continuation.content, 'X'.repeat(40))
  assert.ok(continuation.previousOffset < continuation.offset)
  await manager.stop('/parent', boundary.id)
  useNative('slow-stack')
  const waiting = await start('/waiting')
  const running = await manager.control('/parent','continue',1,500,waiting.id,waiting.stopId)
  assert.equal(running.settled,false)
  const beforeWait = readFileSync(log,'utf8')
  const timeout = await manager.wait('/parent',waiting.id,{afterRevision:running.session.revision,waitMs:5})
  assert.equal(timeout.timedOut,true);assert.equal(timeout.settled,false)
  assert.equal(readFileSync(log,'utf8'),beforeWait,'passive wait sends no DAP request')
  const runningError=await tool.execute('running',{debugId:waiting.id,request:{action:'stack'}},undefined,undefined,{cwd:temp})
  assert.equal(runningError.structuredContent.error.code,'DEBUG_NOT_STOPPED')
  const controller=new AbortController()
  const cancelled=manager.wait('/parent',waiting.id,{waitMs:1000,signal:controller.signal})
  controller.abort();await assert.rejects(cancelled,error=>error.code==='CANCELLED')
  assert.equal(manager.changeWaiters.size,0,'cancel and timeout release all event listeners')
  await assert.rejects(manager.wait('/child',waiting.id),error=>error.code==='DEBUG_SESSION_NOT_FOUND')
  await assert.rejects(manager.wait('/parent',waiting.id,{afterRevision:999999}),error=>error.code==='INVALID_DEBUG_CURSOR')
  const wake=manager.wait('/parent',waiting.id,{afterRevision:running.session.revision,waitMs:1000})
  await manager.control('/parent','pause',1,500,waiting.id)
  const observed=await wake
  assert(observed.settled && observed.changed && !observed.timedOut)
  const immediate=await manager.wait('/parent',waiting.id,{afterRevision:running.session.revision,waitMs:0})
  assert.equal(immediate.timedOut,false,'an event arriving before wait registration is not lost')
  for (const until of ['stopped','changed']) {
    const idle=await manager.wait('/parent',waiting.id,{afterRevision:immediate.revision,until,waitMs:0})
    assert.equal(idle.timedOut,true,'afterRevision requires a newer observation even for an already stopped target')
    assert.equal(idle.settled,true,'settled describes target state, independently of the wait timeout')
    assert.equal(idle.changed,false)
  }
  const ended=manager.wait('/parent',waiting.id,{afterRevision:observed.revision,until:'changed',waitMs:1000})
  await manager.stop('/parent',waiting.id)
  assert.equal((await ended).session.status,'terminated')
  const endedError=await tool.execute('ended',{debugId:waiting.id,request:{action:'stack'}},undefined,undefined,{cwd:temp})
  assert.equal(endedError.structuredContent.error.code,'DEBUG_SESSION_ENDED')
  assert.equal(manager.changeWaiters.size,0)
  console.log('PASS debug contracts: typed schemas/errors, local path validation, passive wait/cursor/timeout/cancellation/ownership')
  console.log('PASS native protocol: capabilities, large/opaque addresses, gaps, bounded paging, stale replies, invalidated refs, breakpoint serialization/events and ASLR restart clearing')
  console.log('PASS adapter source windows: bounded first page and line/offset access beyond 262144 characters')
  console.log('PASS action registry: nested schema, legacy normalization, shared panel routing, permissions; source identity, ownership, cache invalidation and stale stops')
} finally { await manager?.dispose(); delete process.env.PI_DAP_PROTOCOL_LOG; rmSync(temp,{recursive:true,force:true}) }
