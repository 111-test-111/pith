/** Live edits drain actual SDK tools, fence admissions and keep branch/accounting owners. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) { for (let i=0;i<800;i++) { if (predicate()) return; await sleep(10) }; assert.fail(`Timed out: ${label}`) }
const text = value => ({ type:'text', text:value })
const tool = (name, args) => ({ type:'toolCall', id:randomUUID(), name, arguments:args })
let gate = deferred(), entered = deferred()
const f = await createPlanFixture({ withRewind:true, extensionFactories:[pi => pi.registerTool({
  name:'held_inspection', label:'Held inspection', description:'Controlled committed-result barrier.', parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},
  async execute(_id,args) { const content=await readFile(args.path,'utf8'); entered.resolve(); await gate.promise; return {content:[text(content)]} }
})] })
const goal = () => f.managed.goals.snapshot
const call = (action, data={}) => f.app.goalAction({ sessionPath:f.managed.path, expectedSeq:f.managed.goals.seq, goalId:goal()?.id??null, action, ...data })
const idle = () => f.session.isIdle && !f.managed.goals.preparing
const manual = async steps => {
  f.setRespond(() => { const next=steps.shift(); return next ? typeof next==='function'?next():next : [text('Committed results retained.')] })
  const before=f.requests.length
  f.app.prompt({text:'Inspect the current work.',images:[],files:[]})
  await until(()=>f.requests.length>before&&steps.length===0&&idle(),'manual turn')
}
try {
  await f.managed.lifecyclePromise
  const available=f.managed.goals.host.available
  f.managed.goals.host.available=()=>false
  const a=join(f.project,'a.txt'),b=join(f.project,'b.txt')
  await writeFile(a,'A verified\n'); await writeFile(b,'B verified\n')
  assert.equal((await call('create',{objective:'Implement A and B.',acceptance:'A matches the requested output',limits:{maxAutoRuns:10,tokenBudget:null}})).ok,true)
  const first=goal().criteria[0]
  await call('criteria',{criteriaRevision:1,criteria:[{id:first.id,text:first.text},{text:'B matches the requested output'}]})
  await call('resume')
  await manual([[tool('todo_write',{todos:[{content:'Keep completed A work',status:'completed'},{content:'Finish B',status:'pending'}]})],
    [tool('read',{path:a})],()=>[tool('update_goal',{goalId:goal().id,criteriaRevision:goal().criteriaRevision,status:'verify',evidence:'A verified.',
      claims:[{criterionId:first.id,evidence:'Current committed read verifies A.',evidenceIds:[goal().evidenceResults.find(r=>r.path===a&&r.status==='success').id]}]})]])
  const proof=structuredClone(goal().criteria[0].proof), todos=structuredClone(f.managed.todos.snapshot), used=goal().tokens
  assert(proof)
  const steps=[[tool('held_inspection',{path:b})]]
  f.setRespond(()=>steps.shift()??[text('Settled held inspection.')])
  f.app.prompt({text:'Inspect B while the goal is active.',images:[],files:[]})
  await entered.promise
  assert.equal(f.session.isIdle,false)
  assert.equal((await call('definition',{objective:' ',criteriaRevision:goal().criteriaRevision,criteria:goal().criteria})).code,'invalid')
  assert.equal(goal().status,'active','invalid edits do not stop the run')
  const revision=goal().criteriaRevision, oldSeq=f.managed.goals.seq
  const editing=call('definition',{expectedSeq:oldSeq-1,objective:goal().objective,criteriaRevision:revision,
    criteria:goal().criteria.map((c,i)=>({id:c.id,text:i===1?'B satisfies the revised check':c.text}))})
  assert.equal(f.managed.plan.transitionBusy,true,'edit synchronously owns the Plan admission lock')
  assert.equal(goal().status,'paused')
  assert.equal(goal().criteriaRevision,revision,'definition waits for old work to drain')
  assert.throws(()=>f.app.prompt({text:'Race with saving',images:[],files:[]}),/mode change/)
  assert.equal((await f.app.setSessionMode({sessionPath:f.managed.path,mode:'plan'})).code,'transition')
  assert.equal((await f.app.rewindRestore({sessionPath:f.managed.path,token:'unknown',mode:'files',operationId:randomUUID()})).error.code,'busy')
  gate.resolve()
  assert.equal((await editing).ok,true,'hot accounting revisions do not refuse a current definition edit')
  assert.equal(goal().criteriaRevision,revision+1)
  assert.deepEqual(goal().criteria[0].proof,proof,'unchanged criterion proof survives the live edit')
  assert.equal(goal().criteria[1].proof,null)
  assert.equal(goal().reason,'criteria')
  assert(goal().tokens>=used,'draining records usage rather than refunding it')
  assert.deepEqual(f.managed.todos.snapshot,todos,'Goal edits never rewrite committed Todo')
  const requests=f.requests.length
  await sleep(60); assert.equal(f.requests.length,requests,'saving does not implicitly resume')

  // A user Stop arriving after Save has started wins; no late definition can commit.
  await call('resume'); gate=deferred();entered=deferred()
  const next=[[tool('held_inspection',{path:b})]]
  f.setRespond(()=>next.shift()??[text('Stopped old result.')])
  f.app.prompt({text:'A second running inspection.',images:[],files:[]})
  await entered.promise
  const beforeStop=goal().criteriaRevision
  const stoppedEdit=call('definition',{objective:'A change cancelled by Stop',criteriaRevision:beforeStop,criteria:goal().criteria})
  f.app.abort(); gate.resolve()
  assert.equal((await stoppedEdit).code,'busy')
  assert.equal(goal().criteriaRevision,beforeStop)
  assert.equal(goal().objective,'Implement A and B.')
  assert.equal(f.managed.plan.transitionBusy,false)
  await until(idle,'Stop drainage')

  // A previously minted receipt may persist late, but cannot revalidate a new objective.
  await call('resume')
  const receiptInput={goalId:goal().id,criteriaRevision:goal().criteriaRevision,status:'verify',evidence:'Old target verified.',
    claims:[{criterionId:first.id,evidence:'Old committed proof.',evidenceIds:proof.sources.map(s=>s.id)}]}
  const oldReceipt=await f.managed.goals.receipt(receiptInput)
  const rowRevisions=goal().criteria.map(c=>c.revision), consumed=goal().tokens
  assert.equal((await call('definition',{objective:'Implement the new target for A and B.',criteriaRevision:goal().criteriaRevision,criteria:goal().criteria})).ok,true)
  assert(goal().criteria.every(c=>c.proof===null))
  assert.deepEqual(goal().criteria.map(c=>c.revision),rowRevisions.map(r=>r+1))
  const oldMessage={role:'toolResult',toolCallId:'old-receipt',toolName:'update_goal',content:[text('Late old result')],isError:false,timestamp:Date.now(),details:oldReceipt}
  f.manager.appendMessage(oldMessage)
  await f.managed.goals.committed({type:'message_end',message:oldMessage})
  assert(goal().criteria.every(c=>c.proof===null),'late old receipt cannot certify a revised objective')
  assert.equal(goal().tokens,consumed)
  f.managed.goals.restore('interrupted')
  assert.equal(goal().objective,'Implement the new target for A and B.')
  assert(goal().criteria.every(c=>c.proof===null),'full branch folding also rejects the old receipt')

  const plan=await f.app.setSessionMode({sessionPath:f.managed.path,mode:'plan'})
  assert.equal(plan.ok,true)
  assert.equal((await call('definition',{objective:'Goal editable while Plan is paused',criteriaRevision:goal().criteriaRevision,criteria:goal().criteria})).ok,true)
  assert.equal(f.managed.plan.snapshot.mode,'plan')
  assert.equal((await call('resume')).code,'plan')
  assert.equal((await f.app.setSessionMode({sessionPath:f.managed.path,mode:'normal'})).ok,true)
  assert.equal(goal().status,'paused','leaving Plan preserves the edit pause')

  const checkpoints=(await f.app.rewindList(f.managed.path)).value.checkpoints
  const preview=await f.app.rewindPreview(f.managed.path,checkpoints[0].id)
  const beforeRewind=goal().tokens
  const rewound=await f.app.rewindRestore({sessionPath:f.managed.path,token:preview.value.token,mode:'conversation',operationId:randomUUID()})
  assert.equal(rewound.error,undefined)
  assert.equal(goal().tokens,beforeRewind)
  assert.equal(goal().status,'paused')
  assert.equal(f.requests.length,requests+1,'editing and Rewind add no provider dispatches')

  // A fresh explicit run reads the revised target through the ordinary continuation.
  assert.equal((await call('definition',{objective:'Only the final current target',criteriaRevision:goal().criteriaRevision,criteria:[{text:'Validate the final current result'}]})).ok,true)
  await call('limits',{limits:{maxAutoRuns:goal().autoRuns+1,tokenBudget:null}})
  f.setRespond(()=>[text('Final target is in current context.')])
  f.managed.goals.host.available=available
  assert.equal((await call('resume')).ok,true)
  await until(()=>goal().reason==='runs'&&idle(),'explicit run after edit')
  const last=f.requests.at(-1)
  assert(JSON.stringify(last.messages).includes('Only the final current target'))
  assert(JSON.stringify(last.messages).includes('Validate the final current result'))
  await call('cancel')
  const nativeId=goal().id, beforeCapture=f.requests.length
  const capture=f.managed.goals.inputs.capture.bind(f.managed.goals.inputs)
  for (const action of ['stop','plan']) {
    const captureGate=deferred(),captureEntered=deferred()
    f.managed.goals.inputs.capture=async (...args)=>{captureEntered.resolve();await captureGate.promise;return capture(...args)}
    const preparing=call('create',{objective:'Cancelled before the durable definition',acceptance:'No input should execute',limits:{maxAutoRuns:1,tokenBudget:null}})
    await captureEntered.promise
    assert.equal(f.managed.goals.preparing,true)
    assert.equal(goal().id,nativeId,'capturing attachments cannot prematurely replace a goal')
    let planning
    if(action==='stop')f.app.abort()
    else planning=f.app.setSessionMode({sessionPath:f.managed.path,mode:'plan'})
    captureGate.resolve()
    assert.equal((await preparing).code,'busy','Stop/Plan cancels async capture before definition or dispatch')
    if(planning){assert.equal((await planning).ok,true);await f.app.setSessionMode({sessionPath:f.managed.path,mode:'normal'})}
    assert.equal(goal().id,nativeId)
    assert.equal(f.requests.length,beforeCapture)
  }
  f.managed.goals.inputs.capture=capture
  const receiptRoot=join(f.userData,'goals','input'), directories=(await readdir(receiptRoot)).sort()
  const invalidInput=await call('create',{objective:'Invalid image must be refused',acceptance:'Validated image bytes only',limits:{maxAutoRuns:1,tokenBudget:null},
    images:[{type:'image',data:Buffer.from('invalid PNG bytes').toString('base64'),mimeType:'image/png'}]})
  assert.equal(invalidInput.code,'attachments')
  assert.equal(goal().id,nativeId)
  assert.equal(f.requests.length,beforeCapture)
  assert.deepEqual((await readdir(receiptRoot)).sort(),directories,'failed capture leaves no orphan input directory')
  console.log('PASS goal-definition: live objective/criteria edits, stable revision pins, Stop/Plan/Rewind fencing, old receipts, Todo and retained allowance')
} finally { gate.resolve(); await f.close() }
