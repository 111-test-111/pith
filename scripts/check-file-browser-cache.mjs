/** Isolated cache races, pagination and capacity checks; no app/user files. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const temp=await mkdtemp(join(tmpdir(),'pith-file-cache-'))
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
const directory=(path,name)=>({path,entries:name?[{path:path+'/'+name,name,directory:false,symlink:false}]:[]})
const document=(path,text)=>({path,relativePath:path,gitRoot:'/project',size:text.length,truncated:false,text})
const diff=patch=>({gitRoot:'/project',patch,binary:false})
try {
  await build({entryPoints:[join(repo,'src/renderer/src/state/file-browser-cache.ts')],outfile:join(temp,'cache.mjs'),bundle:true,platform:'node',format:'esm',tsconfig:join(repo,'tsconfig.web.json'),logLevel:'silent'})
  const {FileBrowserCache}=await import(pathToFileURL(join(temp,'cache.mjs')))
  let calls=0,active=0,peak=0
  globalThis.window={pi:{listFileDirectory:async request=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return directory(request.path)},readFileDocument:async request=>document(request.path,'source')}}
  const cache=new FileBrowserCache()
  const path='/project/'+Array.from({length:10},(_,i)=>'level'+i).join('/')+'/file.ts'
  await cache.prepareTree('/project',path,[])
  assert.equal(calls,11);assert.equal(peak,6,'parallel ancestor reads respect admission limit')
  await cache.prepareTree('/project',path,[])
  assert.equal(calls,11,'warm branch causes no directory IO')
  cache.clear();calls=0
  await Promise.all(Array.from({length:10},()=>cache.readDirectory({cwd:'/project',path:'/project'})))
  assert.equal(calls,1,'concurrent mounts share IO')

  cache.clear();const old=deferred(),newer=deferred();const queue=[old,newer]
  window.pi.listFileDirectory=()=>queue.shift().promise
  const oldRead=cache.readDirectory({cwd:'/project',path:'/project'})
  cache.invalidateTree('/project')
  const newRead=cache.readDirectory({cwd:'/project',path:'/project'})
  newer.resolve(directory('/project','fresh'));await newRead
  old.resolve(directory('/project','stale'));await oldRead
  assert.equal(cache.directory('/project').entries[0].name,'fresh','late invalidated response cannot replace fresh directory')
  const closing=deferred();window.pi.readFileDocument=()=>closing.promise
  const request={cwd:'/project',path:'/project/closed.ts'}
  const closingRead=cache.readDocument(request);cache.closeDocument(request.path)
  closing.resolve(document(request.path,'closed'));await closingRead
  assert.equal(cache.document(request),undefined,'late read cannot resurrect a closed source cache')
  const oldDoc=deferred(),newDoc=deferred();const documents=[oldDoc,newDoc]
  window.pi.readFileDocument=()=>documents.shift().promise
  const first=cache.readDocument(request);cache.invalidateTree('/project');const second=cache.readDocument(request)
  newDoc.resolve(document(request.path,'fresh'));await second
  oldDoc.resolve(document(request.path,'stale'));await first
  assert.equal(cache.document(request).text,'fresh','refresh owns latest document snapshot')
  console.log('PASS: parallel admission, warm reuse, request deduplication, refresh races and close lifetimes')

  cache.clear();const pendingDiff=deferred();let diffCalls=0
  window.pi.readFileGitDiff=()=>{diffCalls++;return pendingDiff.promise}
  const diffRequest={cwd:'/project',path:'/project/change.ts'}
  const diffRead=cache.readGitDiff(diffRequest)
  assert.equal(cache.readGitDiff(diffRequest),diffRead,'concurrent diff mounts share one read')
  assert.equal(diffCalls,1)
  pendingDiff.resolve(diff('original'));const snapshot=await diffRead
  window.pi.readFileGitDiff=async()=>diff('original')
  assert.equal(await cache.readGitDiff(diffRequest),snapshot,'unchanged diff validation retains snapshot identity')
  assert.equal(cache.gitDiff({...diffRequest,cwd:'/other'}),undefined,'diff identity includes the originating workspace')
  const staleDiff=deferred(),freshDiff=deferred(),diffQueue=[staleDiff,freshDiff]
  window.pi.readFileGitDiff=()=>diffQueue.shift().promise
  const staleRead=cache.readGitDiff(diffRequest)
  assert.equal(cache.gitDiff(diffRequest),snapshot,'pending revalidation keeps the previous diff available')
  cache.invalidateTree('/project');const freshRead=cache.readGitDiff(diffRequest)
  freshDiff.resolve(diff('fresh'));await freshRead
  staleDiff.resolve(diff('stale'));await staleRead
  assert.equal(cache.gitDiff(diffRequest).patch,'fresh','invalidated diff reads cannot overwrite a refreshed snapshot')
  const closedDiff=deferred();window.pi.readFileGitDiff=()=>closedDiff.promise
  const closingDiff=cache.readGitDiff(diffRequest);cache.closeDocument(diffRequest.path)
  closedDiff.resolve(diff('closed'));await closingDiff
  assert.equal(cache.gitDiff(diffRequest),undefined,'late diff reads cannot restore a closed tab')
  const clearedDiff=deferred();window.pi.readFileGitDiff=()=>clearedDiff.promise
  const clearingDiff=cache.readGitDiff(diffRequest);cache.clear()
  clearedDiff.resolve(diff('cleared'));await clearingDiff
  assert.equal(cache.gitDiff(diffRequest),undefined,'clearing the workspace revokes pending diff snapshots')
  window.pi.readFileGitDiff=async()=>diff('')
  await cache.readGitDiff(diffRequest)
  assert.equal(cache.gitDiff(diffRequest).patch,'','clean files retain an empty diff snapshot')
  window.pi.readFileGitDiff=async()=>{throw new Error('git failed')}
  assert.equal((await cache.readGitDiff(diffRequest)).error,'git','failed revalidation reports an error instead of stale changes')
  cache.clear();window.pi.readFileGitDiff=async()=>diff('small')
  for(let i=0;i<20;i++)await cache.readGitDiff({...diffRequest,path:'/project/'+i+'.ts'})
  assert.equal(Array.from({length:20},(_,i)=>cache.gitDiff({...diffRequest,path:'/project/'+i+'.ts'})).filter(Boolean).length,16,'diff entry budget')
  cache.clear();window.pi.readFileGitDiff=async()=>diff('x'.repeat(512*1024))
  for(let i=0;i<20;i++)await cache.readGitDiff({...diffRequest,path:'/project/'+i+'.ts'})
  assert.equal(Array.from({length:20},(_,i)=>cache.gitDiff({...diffRequest,path:'/project/'+i+'.ts'})).filter(Boolean).length,8,'diff byte budget')
  console.log('PASS: warm diff reuse, unchanged identity, deduplication, refresh/close/clear races and bounded retention')

  cache.clear()
  window.pi.readFileDocument=async request=>({...document(request.path,request.encoding==='big5'?'繁體':'简体'),encoding:request.encoding??'utf-8'})
  const legacy={cwd:'/project',path:'/project/legacy.txt'}
  await Promise.all([cache.readDocument({...legacy,encoding:'big5'}),cache.readDocument({...legacy,encoding:'gb18030'})])
  assert.equal(cache.document({...legacy,encoding:'big5'}).text,'繁體')
  assert.equal(cache.document({...legacy,encoding:'gb18030'}).text,'简体')
  cache.closeDocument(legacy.path)
  assert.equal(cache.document({...legacy,encoding:'big5'}),undefined,'close drops every encoding')
  const cancelled=[],binary=deferred();let binaryCalls=0
  window.pi.binaryPreview=()=>{binaryCalls++;return binary.promise};window.pi.cancelBinaryPreview=id=>cancelled.push(id)
  const previewKey='/project\0/project/bundle.zip\0generation',previewRequest={cwd:'/project',path:'/project/bundle.zip'},previewQuery={type:'archive-index'}
  const mount=cache.readBinary(previewKey,previewRequest,previewQuery),sibling=cache.readBinary(previewKey,previewRequest,previewQuery)
  assert.equal(binaryCalls,1,'binary mounts share one reader')
  mount.cancel();assert.equal(cancelled.length,0,'one remaining owner keeps the reader alive')
  sibling.cancel();assert.equal(cancelled.length,1,'last owner cancels the worker')
  binary.resolve({value:{type:'archive-index',revision:'old',format:'zip',entries:[],truncated:false}})
  await mount.promise
  assert.equal(cache.binary(previewKey),undefined,'released response cannot resurrect the binary cache')
  window.pi.binaryPreview=async()=>({value:{type:'archive-index',revision:'fresh',format:'zip',entries:[],truncated:false}})
  await cache.readBinary(previewKey,previewRequest,previewQuery).promise
  assert.equal(cache.binary(previewKey).revision,'fresh')
  cache.closeDocument(previewRequest.path);assert.equal(cache.binary(previewKey),undefined)
  window.pi.binaryPreview=async request=>({value:{type:'archive-entry',revision:'bytes',name:'file.txt',size:512*1024,truncated:false,text:'x'.repeat(512*1024)}})
  for(let i=0;i<20;i++)await cache.readBinary('binary-'+i,previewRequest,{type:'archive-entry',revision:'bytes',entry:String(i)}).promise
  assert.ok(Array.from({length:20},(_,i)=>cache.binary('binary-'+i)).filter(Boolean).length<=16,'binary byte and entry budgets')
  console.log('PASS: encoding cache identities, binary refcounts/cancellation, close races and retained-byte limits')

  cache.clear();window.pi.listFileDirectory=async request=>directory(request.path)
  for(let index=0;index<170;index++)await cache.readDirectory({cwd:'/project',path:'/project/'+index})
  assert.equal(cache.directorySnapshot('/project').size,160,'directory entry cap')
  window.pi.readFileDocument=async request=>document(request.path,'x'.repeat(512*1024))
  for(let index=0;index<20;index++)await cache.readDocument({cwd:'/project',path:'/project/'+index+'.ts'})
  assert.equal(Array.from({length:20},(_,index)=>cache.document({cwd:'/project',path:'/project/'+index+'.ts'})).filter(Boolean).length,8,'source byte budget')
  cache.clear()
  window.pi.listFileDirectory=async(request,offset=0)=>({path:request.path,entries:Array.from({length:offset<600?300:1},(_,index)=>({name:'x'.repeat(255),path:'/project/'+'d'.repeat(3800)+'/'+(offset+index),directory:false,symlink:false})),...(offset<600?{nextOffset:offset+300}:{})})
  const folder={cwd:'/project',path:'/project/large'}
  let page=await cache.readDirectory(folder)
  page=await cache.readDirectory(folder,true,page)
  assert.equal(cache.directory(folder.path),undefined,'oversize directory snapshot is evicted')
  page=await cache.readDirectory(folder,true,page)
  assert.equal(page.entries.length,601,'visible snapshot can continue pagination after eviction')
  const pending=deferred();window.pi.listFileDirectory=()=>pending.promise
  const clearing=cache.readDirectory({cwd:'/project',path:'/project/pending'});cache.clear()
  pending.resolve(directory('/project/pending','late'));await clearing
  assert.equal(cache.directorySnapshot('/project').size,0,'clear rejects outstanding cache writes')
  console.log('PASS: entry/byte limits, pagination after eviction and clear races')

  await build({stdin:{contents:`export {FileBrowserStore} from './src/renderer/src/state/file-browser-store';export {localFileTarget} from './src/renderer/src/lib/file-navigation';export {resolveFromCwd} from './src/renderer/src/lib/tool-path';`,resolveDir:repo,loader:'ts'},outfile:join(temp,'navigation.mjs'),bundle:true,platform:'node',format:'esm',tsconfig:join(repo,'tsconfig.web.json'),logLevel:'silent'})
  const {FileBrowserStore,localFileTarget,resolveFromCwd}=await import(pathToFileURL(join(temp,'navigation.mjs')))
  const homeTarget=localFileTarget('%7E/资料/Assignment%201%23%25.pdf#L12','/project')
  assert.deepEqual(homeTarget,{path:'~/资料/Assignment 1#%.pdf',line:12},'decode URL/line syntax without rebasing the home marker')
  assert.equal(resolveFromCwd('~/../docs/file.txt','/project'),'~/../docs/file.txt','dot segments wait until the home directory is known')
  assert.equal(resolveFromCwd('~\\docs\\file.txt','C:/project'),'~/docs/file.txt','Windows tool spelling retains home semantics')
  assert.deepEqual(localFileTarget('./~/literal.txt','/project'),{path:'/project/~/literal.txt'},'an explicit relative tilde directory remains literal')
  assert.deepEqual(localFileTarget('file:///project/%7E/literal.txt','/project'),{path:'/project/~/literal.txt'},'file URL path segments are literal')
  assert.deepEqual(localFileTarget('~other/file.txt','/project'),{path:'/project/~other/file.txt'},'named-user syntax is an ordinary filename')
  const files=new FileBrowserStore(),requests=[],opened=[]
  files.subscribeOpen(path=>opened.push(path))
  let resolution=deferred()
  window.pi.resolveFilePath=request=>{requests.push(request);return resolution.promise}
  const homeOpen=files.open('/project',homeTarget)
  assert.equal(files.getSnapshot().tabs.length,0,'unresolved home paths never become tabs or media URLs')
  resolution.resolve('/home/user/资料/Assignment 1#%.pdf');await homeOpen
  assert.deepEqual(requests[0],{cwd:'/project',path:homeTarget.path})
  assert.equal(files.getSnapshot().active,'/home/user/资料/Assignment 1#%.pdf')
  assert.equal(files.getSnapshot().tabs[0].line,12,'home navigation retains source line')
  files.open('/project',{path:'/home/user/资料/Assignment 1#%.pdf'})
  assert.equal(files.getSnapshot().tabs.length,1,'home and absolute spellings share a tab')

  resolution=deferred();const superseded=files.open('/project',{path:'~/old.txt'})
  files.open('/project',{path:'/project/new.txt'})
  resolution.resolve('/home/user/old.txt');await superseded
  assert.equal(files.getSnapshot().active,'/project/new.txt','a slow home resolution cannot steal newer navigation')
  assert.ok(!files.getSnapshot().tabs.some(tab=>tab.path.endsWith('/old.txt')))
  resolution=deferred();const cleared=files.open('/project',{path:'~/cleared.txt'})
  files.clear();resolution.resolve('/home/user/cleared.txt');await cleared
  assert.equal(files.getSnapshot().tabs.length,0,'clear cancels pending navigation')
  resolution=deferred();const firstHome=files.open('/project',{path:'~/first.txt'})
  const firstResolution=resolution;resolution=deferred()
  const secondHome=files.open('/project',{path:'~/second.txt'})
  resolution.resolve('/home/user/second.txt');await secondHome
  firstResolution.resolve('/home/user/first.txt');await firstHome
  assert.equal(files.getSnapshot().active,'/home/user/second.txt','home resolutions may arrive out of order')
  let errors=0;files.subscribeOpenError(()=>errors++)
  window.pi.resolveFilePath=async()=>{throw new Error('invalid path')}
  await files.open('/project',{path:'~/failed.txt'})
  assert.equal(errors,1,'resolution failures report an error without opening a fabricated path')
  assert.equal(files.getSnapshot().active,'/home/user/second.txt')
  assert.deepEqual(opened,['/home/user/资料/Assignment 1#%.pdf','/home/user/资料/Assignment 1#%.pdf','/project/new.txt','/home/user/second.txt'])
  console.log('PASS: home links/tool paths, literal tildes, canonical tabs, line navigation, failure reporting and navigation races')
} finally {delete globalThis.window;await rm(temp,{recursive:true,force:true})}
