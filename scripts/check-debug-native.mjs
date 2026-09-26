/** Real LLDB source-less loop. Missing LLDB/clang is SKIP, never coverage. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const temp=mkdtempSync(join(tmpdir(),'pith-debug-native-')), owner='/native'
let manager
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function stopped(id) { for(let i=0;i<400;i++){const dto=manager.get(owner,id);if(dto.status==='stopped'&&dto.location)return dto;if(['failed','terminated'].includes(dto.status))throw Error(JSON.stringify(dto));await delay(25)}throw Error('No LLDB stop') }
const mac=process.platform==='darwin', clang=mac?'xcrun':'clang'
try {
  let lldb
  try { lldb=mac?execFileSync('xcrun',['-f','lldb-dap'],{encoding:'utf8'}).trim():execFileSync('sh',['-c','command -v lldb-dap'],{encoding:'utf8'}).trim();execFileSync(clang,mac?['clang','--version']:['--version']) } catch { console.log('[SKIP] native debugging requires LLDB DAP and clang');process.exitCode=0 }
  if(lldb){
    await build({stdin:{contents:`export * from './src/main/debug/manager'; export * from './src/main/debug/action-registry'`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(temp,'module.mjs'),plugins:[{name:'sdk',setup(b){b.onResolve({filter:/^(@earendil-works\/pi-coding-agent|typebox)$/},a=>({path:fileURLToPath(import.meta.resolve(a.path)),external:true}))}}]})
    const {DebugManager,dispatchDebugAction}=await import(pathToFileURL(join(temp,'module.mjs')))
    manager=new DebugManager(()=>{})
    const source=join(temp,'missing.c'), stripped=join(temp,'stripped'), symbols=join(temp,'symbols')
    writeFileSync(source,`volatile unsigned long long marker = 0x1122334455667788ULL;
__attribute__((noinline)) void checkpoint(void) {
  marker += 1;
  __builtin_debugtrap();
  marker += 2;
  marker += 3;
}
int main(void) { checkpoint(); checkpoint(); return marker == 0; }
`)
    for(const [binary,debug] of [[stripped,false],[symbols,true]])execFileSync(clang,[...(mac?['clang']:[]),...(debug?['-g']:[]),'-O0',source,'-o',binary],{timeout:30000})
    execFileSync('strip',mac?[stripped]:['--strip-all',stripped])
    unlinkSync(source);assert.equal(existsSync(source),false)
    const start=async(program,extra={})=>{const dto=await manager.start({sessionId:owner,sessionPath:owner,workspaceCwd:temp,cwd:temp,adapterId:'lldb-dap',kind:'launch',program,...extra});return stopped(dto.id)}
    const act=(dto,request)=>dispatchDebugAction({manager,sessionPath:owner,debugId:dto.id,stopId:dto.stopId},request)
    let dto=await start(stripped)
    assert.equal(dto.location.file,undefined,'stripped frame must not invent a disk path')
    assert.ok(dto.location.instructionPointerReference)
    const frames=await act(dto,{action:'stack'}), pc=frames[0].instructionPointerReference
    assert.equal(typeof frames[0].moduleId,'string')
    if(frames[0].source?.kind==='adapter') {
      const sourcePage=await act(dto,{action:'source',sourceReference:frames[0].source.sourceReference,sourceVersion:dto.sourceVersion})
      assert.ok(sourcePage.content.length>0);assert.equal(sourcePage.debugId,dto.id)
    }
    const assembly=await act(dto,{action:'disassemble',memoryReference:pc,count:16})
    assert.ok(assembly.instructions.length>=4)
    assert.ok(assembly.instructions.some(i=>BigInt(i.address)===BigInt(pc)))
    const memory=await act(dto,{action:'memory.read',memoryReference:pc,count:32})
    assert.equal(memory.bytesRead,32);assert.equal(memory.unreadableBytes,0);assert.equal(Buffer.from(memory.data,'base64').length,32)
    const scopes=await act(dto,{action:'registers',frameId:frames[0].id});assert.ok(scopes.length>0,'register scope must retain presentation hint')
    let registers=await act(dto,{action:'variables',variablesReference:scopes[0].variablesReference})
    assert.ok(registers.variables.length>0)
    if(registers.variables[0].variablesReference)registers=await act(dto,{action:'variables',variablesReference:registers.variables[0].variablesReference})
    assert.ok(registers.variables.some(v=>/^(pc|rip|x[0-9]+|rax)$/.test(v.name)))
    const modules=await act(dto,{action:'modules',count:2});assert.equal(modules.modules.length,2);assert.ok(modules.totalModules>=2)
    if(modules.truncated){const next=await act(dto,{action:'modules',start:2,count:2});assert.notEqual(next.modules[0]?.id,modules.modules[0].id)}
    const stepped=await act(dto,{action:'control',control:'next',granularity:'instruction',waitMs:10000})
    assert.equal(stepped.settled,true);assert.equal(stepped.session.status,'stopped');assert.notEqual(stepped.session.location.instructionPointerReference,pc)
    await assert.rejects(act(dto,{action:'memory.read',memoryReference:pc,count:4}),/stop changed/i)
    dto=stepped.session
    const rows=(await act(dto,{action:'disassemble',memoryReference:dto.location.instructionPointerReference,count:8})).instructions
    const address=rows[2].address
    const bindings=await act(dto,{action:'breakpoints.instruction',items:[{instructionReference:address}]})
    assert.equal(bindings.instruction[0].verified,true,JSON.stringify(bindings))
    const hit=await act(dto,{action:'control',control:'continue',waitMs:10000});assert.equal(hit.session.status,'stopped');assert.equal(BigInt(hit.session.location.instructionPointerReference),BigInt(address))
    assert.ok(hit.session.hitBreakpointIds?.includes(bindings.instruction[0].id))
    dto=hit.session
    await act(dto,{action:'breakpoints.instruction.toggle',instructionReference:address})
    assert.equal((await act(dto,{action:'breakpoints.native'})).instruction.length,0)
    await act(dto,{action:'breakpoints.instruction',items:[{instructionReference:address}]})
    const restarted=await manager.restart(owner,dto.id), restartedStop=await stopped(restarted.id)
    assert.equal(manager.nativeBreakpoints(owner,restartedStop.id).instruction.length,0)
    await manager.stop(owner,restartedStop.id)
    console.log('[PASS] real stripped/no-source LLDB: virtual source → PC/disassembly → register groups/memory/modules → instruction step → instruction breakpoint hit → restart clears addresses')
    dto=await start(symbols)
    assert.equal(existsSync(dto.location.file??''),false)
    const functions=await act(dto,{action:'breakpoints.function',items:[{name:'checkpoint'}]});assert.equal(functions.function[0].verified,true)
    const functionHit=await act(dto,{action:'control',control:'continue',waitMs:10000});assert.ok(functionHit.session.hitBreakpointIds?.includes(functions.function[0].id),JSON.stringify(functionHit.session))
    const functionRestart=await manager.restart(owner,dto.id);await stopped(functionRestart.id)
    assert.equal(manager.nativeBreakpoints(owner,functionRestart.id).function[0].name,'checkpoint')
    await manager.stop(owner,functionRestart.id)
    console.log('[PASS] real symbols-without-source LLDB: missing source path retained as file identity; function breakpoint hit and restart retention')
    const coreFile=join(temp,'native.core')
    execFileSync(mac?'xcrun':'lldb',[...(mac?['lldb']:[]),'-b','-o','settings set target.disable-aslr false','-o','breakpoint set --name checkpoint','-o','run','-o',`process save-core ${coreFile}`,'-o','process kill',symbols],{timeout:30000,stdio:'pipe'})
    assert.ok(existsSync(coreFile))
    dto=await start(symbols,{kind:'core',coreFile})
    const corePC=dto.location.instructionPointerReference
    assert.ok((await act(dto,{action:'disassemble',memoryReference:corePC,count:4})).instructions.length)
    assert.ok((await act(dto,{action:'memory.read',memoryReference:corePC,count:8})).bytesRead)
    assert.ok((await act(dto,{action:'modules',count:2})).modules.length)
    const coreFrames=await act(dto,{action:'stack'})
    const coreRegisters=await act(dto,{action:'registers',frameId:coreFrames[0].id})
    assert.ok(coreRegisters.length)
    assert.ok((await act(dto,{action:'variables',variablesReference:coreRegisters[0].variablesReference})).variables.length)
    if(dto.location.source?.kind==='adapter')assert.ok((await act(dto,{action:'source',sourceReference:dto.location.source.sourceReference,sourceVersion:dto.sourceVersion})).content)
    for(const request of [{action:'evaluate',expression:'1'},{action:'control',control:'continue'},{action:'breakpoints.instruction',items:[]},{action:'breakpoints.function',items:[]},{action:'restart'}])await assert.rejects(act(dto,request),/Core inspection/)
    console.log('[PASS] real LLDB core: stack/registers/disassembly/memory/modules read-only; execution/evaluate/breakpoint/restart rejected')
  }
}finally{await manager?.dispose();rmSync(temp,{recursive:true,force:true})}
