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
} finally {delete globalThis.window;await rm(temp,{recursive:true,force:true})}
