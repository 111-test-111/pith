/** Real SDK forks share spending but keep session-owned dispatch/progress independent. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const f=await createPlanFixture({withRewind:true,respond:()=>[{type:'text',text:'Work remains.'}]})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate,label) { for(let i=0;i<800;i++){if(predicate())return;await sleep(10)};assert.fail(`Timed out: ${label}`) }
const snapshot=m=>m.goals.snapshot
const idle=m=>m.session.isIdle&&!m.goals.preparing
const call=(m,action,data={})=>f.app.goalAction({sessionPath:m.path,expectedSeq:m.goals.seq,goalId:snapshot(m)?.id??null,action,...data})
const assistant=m=>m.session.sessionManager.getBranch().findLast(e=>e.type==='message'&&e.message.role==='assistant').message
try {
  await f.managed.lifecyclePromise
  const parent=f.managed,parentId=f.session.sessionId,parentFile=f.manager.getSessionFile()
  assert.equal((await call(parent,'create',{objective:'Goal shared across forks',acceptance:'Verify the requested result',limits:{maxAutoRuns:1,tokenBudget:null}})).ok,true)
  await until(()=>snapshot(parent).reason==='runs'&&idle(parent),'parent cap')
  assert.equal(snapshot(parent).tokens,4)
  const {GoalStorage}=await import(pathToFileURL(join(f.temporary,'modules.mjs')).href)
  const pool=new GoalStorage(f.userData,parentId),goalId=snapshot(parent).id
  pool.update(goalId,l=>{l.run={id:'parent-owned-claim',state:'claimed',before:f.manager.getEntries().map(e=>e.id)};l.fingerprint='parent-fingerprint';l.noProgress=2})
  const fork=await f.app.forkFromMessage(assistant(parent).timestamp)
  const child=f.app.sessions.get(fork.snapshot.sessionPath)
  await child.lifecyclePromise
  assert.equal(f.manager.getSessionId(),parentId,'forking never retargets the live parent SDK manager')
  assert.equal(f.manager.getSessionFile(),parentFile)
  assert.equal(snapshot(child).id,goalId)
  assert.equal(snapshot(child).accountingAvailable,true)
  assert.equal(snapshot(child).autoRuns,1)
  assert.equal(snapshot(child).tokens,4)
  assert.equal(snapshot(child).status,'paused')
  const childPool=new GoalStorage(f.userData,child.session.sessionId)
  assert.equal(childPool.owner(goalId),parentId)
  assert.equal(childPool.read(goalId).run,null)
  assert.equal(childPool.read(goalId).fingerprint,null)
  assert.equal(childPool.read(goalId).noProgress,0)
  assert.equal(pool.read(goalId).run.id,'parent-owned-claim','restoring a fork cannot clear a parent dispatch')
  assert.equal(pool.read(goalId).noProgress,2)
  const importedPool=new GoalStorage(f.userData,'__proto__')
  importedPool.linkFork(pool,goalId)
  assert.equal(importedPool.read(goalId,true).run,null,'imported session IDs cannot pick an inherited object property as a run scope')
  assert.equal(importedPool.read(goalId,true).noProgress,0)
  pool.update(goalId,l=>{l.run=null;l.noProgress=0;l.fingerprint=null})
  assert.equal((await call(child,'resume')).code,'quota','copying an old branch does not grant new allowance')

  // Both sessions race for the final shared continuation; exactly one claim wins.
  await call(parent,'limits',{limits:{maxAutoRuns:2,tokenBudget:null}})
  await call(child,'limits',{limits:{maxAutoRuns:2,tokenBudget:null}})
  const before=f.requests.length
  const replies=await Promise.all([call(parent,'resume'),call(child,'resume')])
  assert(replies.every(r=>r.ok))
  await until(()=>snapshot(parent).reason==='runs'&&snapshot(child).reason==='runs'&&idle(parent)&&idle(child),'shared final slot')
  assert.equal(f.requests.length,before+1,'atomic shared claim admits one primary request')
  assert.equal(snapshot(parent).autoRuns,2)
  assert.equal(snapshot(child).autoRuns,2)
  assert.equal(snapshot(parent).tokens,6)
  assert.equal(snapshot(child).tokens,6,'peer publication exposes the latest pool charge')
  assert.equal(new Set(pool.read(goalId).billed).size,3,'copied historical entries are not billed twice')
  assert.equal(pool.read(goalId).run,null)
  assert.equal(childPool.read(goalId).run,null)

  // Further forks resolve directly to the original pool and keep it through Rewind.
  f.app.activateSession(child)
  const nested=await f.app.forkFromMessage(assistant(child).timestamp)
  const nestedManaged=f.app.sessions.get(nested.snapshot.sessionPath)
  await nestedManaged.lifecyclePromise
  const nestedPool=new GoalStorage(f.userData,nestedManaged.session.sessionId)
  assert.equal(nestedPool.owner(goalId),parentId)
  assert.equal(snapshot(nestedManaged).tokens,6)
  await writeFile(join(f.project,'rewind.txt'),'Existing selected version\n')
  const manualBefore=f.requests.length
  f.app.prompt({text:'A manual fork turn to establish a checkpoint.',images:[],files:[]})
  await until(()=>f.requests.length>manualBefore&&idle(nestedManaged),'manual fork turn')
  const cps=(await f.app.rewindList(nestedManaged.path)).value.checkpoints
  assert(cps.length)
  const preview=await f.app.rewindPreview(nestedManaged.path,cps[0].id)
  const restored=await f.app.rewindRestore({sessionPath:nestedManaged.path,token:preview.value.token,mode:'conversation',operationId:randomUUID()})
  assert.equal(restored.error,undefined)
  assert.equal(snapshot(nestedManaged).tokens,6)
  assert.equal(nestedPool.owner(goalId),parentId,'branch changes never unlink lifetime accounting')

  // Ending the inherited goal and explicitly creating a new ID grants a separate pool.
  await call(nestedManaged,'cancel')
  nestedManaged.goals.host.available=()=>false
  assert.equal((await call(nestedManaged,'create',{objective:'Explicitly new goal',acceptance:'Fresh requested outcome',limits:{maxAutoRuns:3,tokenBudget:null}})).ok,true)
  const freshId=snapshot(nestedManaged).id
  assert.notEqual(freshId,goalId)
  assert.equal(snapshot(nestedManaged).tokens,0)
  assert.equal(snapshot(nestedManaged).autoRuns,0)
  assert.equal(nestedPool.owner(freshId),nestedManaged.session.sessionId)
  assert.equal(pool.read(goalId).tokens,6,'new goal never resets the inherited pool')

  // A copied goal with missing accounting remains unavailable; never initialize zero.
  f.app.activateSession(parent)
  const missingFork=await f.app.forkFromMessage(assistant(parent).timestamp)
  const missing=f.app.sessions.get(missingFork.snapshot.sessionPath)
  await missing.lifecyclePromise
  await unlink(pool.path(goalId))
  missing.goals.restore('interrupted')
  assert.equal(snapshot(missing).accountingAvailable,false)
  assert.equal(snapshot(missing).reason,'storage')
  assert.equal((await call(missing,'resume')).code,'storage')
  assert.equal(new GoalStorage(f.userData,missing.session.sessionId).owner(goalId),parentId)
  console.log('PASS goal-fork: shared lifetime quotas, one atomic final slot, independent dispatch/progress, multi-hop fork/Rewind and missing-ledger refusal')
} finally { await f.close() }
