/** Real pinned SDK, committed source receipts and file hashes; no model/network calls. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) { for (let i=0;i<600;i++) { if (await predicate()) return; await sleep(10) } assert.fail(`Timed out: ${label}`) }
function deferred() { let resolve; const promise = new Promise(done => { resolve=done }); return {promise,resolve} }
const text = value => ({ type:'text', text:value })
const tool = (name,args) => ({type:'toolCall',id:randomUUID(),name,arguments:args})
const goal = f => f.managed.goals.snapshot
const call = (f,action,data={}) => f.app.goalAction({ sessionPath:f.managed.path,expectedSeq:f.managed.goals.seq,goalId:goal(f)?.id??null,action,...data })
const idle = f => f.session.isIdle && !f.managed.goals.preparing
const lastResult = f => f.manager.getBranch().findLast(e=>e.type==='message'&&e.message.role==='toolResult').message
const proof = (f,id,ids) => ({criterionId:id,evidence:'Verified with the referenced committed result.',evidenceIds:ids})
const update = (f,status,claims=[],revision=goal(f).criteriaRevision) => tool('update_goal',{goalId:goal(f).id,criteriaRevision:revision,status,evidence:'The requested criteria were checked against actual results.',claims})
const source = (f,path) => goal(f).evidenceResults.find(e=>e.path===path&&e.status==='success')?.id
async function run(f,steps) {
  f.setRespond(()=>{const next=steps.shift();return next?typeof next==='function'?next():next:[text('Results inspected.')]})
  const before=f.requests.length
  f.app.prompt({text:'Verify the current goal from committed results.',images:[],files:[]})
  await until(()=>f.requests.length>before&&steps.length===0&&idle(f),'manual evidence turn')
  assert.equal(steps.length,0)
}
const fixtures=[]
async function fixture(options={}) {
  const f=await createPlanFixture({withRewind:true,...options});fixtures.push(f);await f.managed.lifecyclePromise
  f.available=f.managed.goals.host.available;f.managed.goals.host.available=()=>false
  f.a=join(f.project,'a.txt');f.b=join(f.project,'b.txt')
  await writeFile(f.a,'A original\n');await writeFile(f.b,'B original\n')
  assert.equal((await call(f,'create',{objective:'Implement A and B, and verify both.',acceptance:'A is correct',limits:{maxAutoRuns:20,tokenBudget:null}})).ok,true)
  const first=goal(f).criteria[0]
  assert.equal((await call(f,'criteria',{criteriaRevision:1,criteria:[{id:first.id,text:first.text},{text:'B is correct'}]})).ok,true)
  assert.equal((await call(f,'resume')).ok,true)
  return f
}
try {
  const readGate=deferred(),readStarted=deferred()
  const f=await fixture({extensionFactories:[pi=>pi.registerTool({name:'delayed_inspection',label:'Delayed inspection',description:'Read a file then await a controlled commit barrier.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},async execute(_id,args){const content=await readFile(args.path,'utf8');readStarted.resolve();await readGate.promise;return {content:[{type:'text',text:content}]}}})]})
  const [a,b]=goal(f).criteria.map(c=>c.id)
  let checkpoint
  const readA=()=>[tool('read',{path:f.a})],readB=()=>[tool('read',{path:f.b})]
  await run(f,[readA,readB,()=>[update(f,'verify',[proof(f,a,[source(f,f.a)])])]])
  checkpoint=(await f.app.rewindList(f.managed.path)).value.checkpoints[0]
  assert.deepEqual(goal(f).criteria.map(c=>c.state),['verified','pending'])
  assert.equal(goal(f).status,'active','a partial receipt cannot complete a goal')
  const originalProof=structuredClone(goal(f).criteria[0].proof)
  await run(f,[readA,readB])
  assert.equal(goal(f).criteria[0].state,'verified','repeated successful inspection preserves unchanged bound evidence')
  assert.deepEqual(goal(f).criteria[0].proof,originalProof)
  const used=goal(f).tokens
  assert(originalProof.receiptId)
  assert.equal(goal(f).criteria[0].files[f.a].length,64,'file bindings use full SHA-256')
  assert.equal((await call(f,'criteria',{criteriaRevision:1,criteria:[{id:a,text:'A is correct'}]})).code,'stale')
  assert.equal((await call(f,'criteria',{criteriaRevision:2,criteria:[{id:'foreign-id',text:'A is correct'}]})).code,'invalid')
  assert.equal((await call(f,'criteria',{criteriaRevision:2,criteria:[{id:a,text:'A is correct'},{id:b,text:'B satisfies the revised output'}]})).ok,true)
  assert.equal(goal(f).status,'paused');assert.equal(goal(f).reason,'criteria')
  assert.equal(goal(f).criteriaRevision,3);assert.equal(goal(f).criteria[0].revision,1);assert.equal(goal(f).criteria[1].revision,2)
  assert.deepEqual(goal(f).criteria[0].proof,originalProof,'unchanged criteria retain committed proof')
  assert.equal(goal(f).tokens,used,'editing never refunds usage')
  await call(f,'resume')
  await run(f,[()=>[update(f,'complete',[],2)]])
  assert.equal(lastResult(f).isError,true,'old criterion revision is refused at the actual tool boundary')
  await run(f,[()=>[tool('todo_write',{todos:[{content:'A and B done',status:'completed'}]})],()=>[update(f,'complete',[proof(f,b,[lastResult(f).toolCallId])])]])
  assert.equal(lastResult(f).isError,true,'Todo completion is not an evidence source')
  await run(f,[()=>[tool('write',{path:f.b,content:'B revised\n'})],()=>[update(f,'complete',[proof(f,b,[source(f,f.b)])])]])
  assert.deepEqual(goal(f).criteria.map(c=>c.state),['verified','verified'],'an unrelated B write does not discard A file evidence')
  assert.equal(goal(f).status,'verifying')
  await run(f,[()=>[tool('todo_write',{todos:[{content:'Unverified dependency',status:'pending'}]})],()=>[tool('todo_write',{todos:[]})],()=>[update(f,'complete')]])
  f.managed.goals.host.available=f.available;f.managed.goals.flush()
  await until(()=>goal(f)?.status==='paused'&&idle(f),'unfinished retained Todo prevents completion')
  assert.notEqual(goal(f).status,'completed')
  f.managed.goals.host.available=()=>false
  await call(f,'limits',{limits:{maxAutoRuns:40,tokenBudget:null}});await call(f,'resume')
  await run(f,[()=>[tool('todo_write',{todos:[{content:'Unverified dependency',status:'cancelled'}]})],()=>[update(f,'complete')]])
  assert.equal(goal(f).status,'verifying','cancelled Todo settles work but does not create criterion evidence')
  await writeFile(f.a,'A externally changed\n')
  await f.managed.goals.inspect()
  assert.equal(goal(f).criteria[0].state,'stale')
  await run(f,[()=>[update(f,'complete',[proof(f,a,[originalProof.sources[0].id])])]])
  assert.equal(lastResult(f).isError,true,'old passing output cannot establish changed file contents')
  await run(f,[readA,()=>[update(f,'complete',[proof(f,a,[source(f,f.a)])])]])
  assert.deepEqual(goal(f).criteria.map(c=>c.state),['verified','verified'])

  // A file changing between tool execution and the committed receipt cannot
  // acquire a new-version stamp for historical output.
  const raceTurn=run(f,[[tool('delayed_inspection',{path:f.a})]])
  await readStarted.promise
  await writeFile(f.a,'A changed during inspection\n')
  readGate.resolve();await raceTurn
  const raced=goal(f).evidenceResults.find(e=>e.tool==='delayed_inspection')
  assert.equal(raced.status,'stale')
  await run(f,[()=>[update(f,'verify',[proof(f,a,[raced.id])])]])
  assert.equal(lastResult(f).isError,true,'commit-time hashing cannot rebind historical output to new bytes')
  await run(f,[readA,()=>[update(f,'complete',[proof(f,a,[source(f,f.a)])])]])

  // A latest failing result outranks a plausible completion claim and even
  // otherwise-current file proofs. Retry the same concrete check to resolve it.
  const checked=await fixture({extensionFactories:[pi=>pi.registerTool({name:'goal_check',label:'Fixture check',description:'A deterministic check.',
    parameters:{type:'object',properties:{command:{type:'string'},passed:{type:'boolean'}},required:['command','passed']},
    async execute(_id,args){if(!args.passed)throw new Error('Deliberately failing acceptance check');return {content:[{type:'text',text:'Check passed.'}]}}})]})
  const [ca,cb]=goal(checked).criteria.map(c=>c.id)
  const check=passed=>[tool('goal_check',{command:'verify A and B',passed})]
  await run(checked,[[tool('read',{path:checked.a})],[tool('read',{path:checked.b})],check(true),()=>[update(checked,'complete',[proof(checked,ca,[source(checked,checked.a)]),proof(checked,cb,[source(checked,checked.b)])])]])
  const pass=goal(checked).evidenceResults.find(e=>e.kind==='check'&&e.status==='success').id
  await run(checked,[check(false),()=>[update(checked,'complete')],[text('Everything is correct; the failure is harmless.')]])
  assert.equal(goal(checked).evidenceBlocked,true)
  assert.equal(lastResult(checked).isError,true,'plausible prose cannot override the failing check')
  await run(checked,[()=>[update(checked,'verify',[proof(checked,ca,[pass])])]])
  assert.equal(lastResult(checked).isError,true,'a superseded passing check cannot be referenced')
  await run(checked,[check(true),()=>[update(checked,'complete')]])
  assert.equal(goal(checked).evidenceBlocked,false)
  assert.equal(goal(checked).status,'verifying')

  await run(checked,[[tool('write',{path:checked.b,content:'B written by the goal\n'})],check(true),()=>[update(checked,'complete',[proof(checked,cb,[source(checked,checked.b)])])]])
  await writeFile(checked.b,'B externally corrected\n')
  await run(checked,[[tool('read',{path:checked.b})],()=>[update(checked,'complete',[proof(checked,cb,[source(checked,checked.b)])])]])
  assert.equal(goal(checked).criteria[1].state,'verified')

  // Committed completion messages carry a creation time distinct from the
  // persisted entry time, and must retain the command's original file version.
  const background=await fixture({extensionFactories:[pi=>{
    pi.on('before_agent_start',async()=>{await sleep(20)})
    pi.registerTool({
      name:'fixture_background',label:'Background receipt',description:'Return a pending managed-command receipt.',
      parameters:{type:'object',properties:{}},
      async execute(){return {content:[{type:'text',text:'Check running.'}],details:{bashTask:{id:'fixture-bg',status:'running',command:'fixture background check',exitCode:null}}}}
    })
  }]})
  await run(background,[[tool('read',{path:background.a})],[tool('read',{path:background.b})],[tool('fixture_background',{})]])
  background.setRespond(()=>[text('Completion consumed.')])
  await background.session.sendCustomMessage({customType:'bash_task_completion',content:'Check passed.',display:true,details:{taskId:'fixture-bg',bashTask:{id:'fixture-bg',status:'succeeded',command:'fixture background check',exitCode:0}}},{triggerTurn:true})
  const bgResult=goal(background).evidenceResults.find(r=>r.tool==='bash_task_completion')
  assert.equal(bgResult.status,'success','a real committed custom completion receives a proof stamp')
  const bgEntry=background.manager.getBranch().findLast(e=>e.type==='custom_message'&&e.customType==='bash_task_completion')
  assert(background.manager.getBranch().some(e=>e.type==='custom'&&e.customType==='pith_goal_evidence_v1'&&e.data.items.some(item=>item.id===bgEntry.id)))
  await run(background,[[tool('fixture_background',{})]])
  await writeFile(background.a,'Changed before command completion delivery\n')
  background.setRespond(()=>[text('Historical completion consumed.')])
  await background.session.sendCustomMessage({customType:'bash_task_completion',content:'Check passed after a delayed delivery.',display:true,details:{taskId:'fixture-bg',bashTask:{id:'fixture-bg',status:'succeeded',command:'fixture background check',exitCode:0}}},{triggerTurn:true})
  const late=goal(background).evidenceResults.find(r=>r.tool==='bash_task_completion')
  assert.equal(late.status,'stale','delayed success cannot acquire the version of code changed since dispatch')
  await run(background,[()=>[update(background,'verify',[proof(background,goal(background).criteria[0].id,[late.id])])]])
  assert.equal(lastResult(background).isError,true)

  // Stop wins during asynchronous final hash validation, before completion.
  const gate=deferred(),inspect=checked.managed.goals.inspect.bind(checked.managed.goals)
  let validating=false
  checked.managed.goals.inspect=async()=>{validating=true;await gate.promise;return inspect()}
  checked.managed.goals.host.available=checked.available;checked.managed.goals.flush()
  await until(()=>validating,'final validation reservation')
  checked.app.abort();gate.resolve()
  await until(()=>idle(checked),'Stop drains final validation')
  assert.equal(goal(checked).status,'paused');assert.equal(goal(checked).reason,'stopped')
  checked.managed.goals.inspect=inspect

  checked.managed.goals.host.available=()=>false
  await call(checked,'resume')
  await run(checked,[()=>[update(checked,'complete')]])
  const planGate=deferred(),planInspect=checked.managed.goals.inspect.bind(checked.managed.goals)
  let planValidation=false
  checked.managed.goals.inspect=async()=>{planValidation=true;await planGate.promise;return planInspect()}
  checked.managed.goals.host.available=checked.available;checked.managed.goals.flush()
  await until(()=>planValidation,'Plan final-validation reservation')
  const entering=checked.app.setSessionMode({sessionPath:checked.managed.path,mode:'plan'})
  assert.equal(checked.managed.plan.transitionBusy,true)
  planGate.resolve();assert.equal((await entering).ok,true)
  assert.equal(goal(checked).status,'paused');assert.equal(goal(checked).reason,'plan')
  checked.managed.goals.inspect=planInspect
  assert.equal((await checked.app.setSessionMode({sessionPath:checked.managed.path,mode:'normal'})).ok,true)
  assert.equal(goal(checked).status,'paused','leaving Plan cannot complete or resume a paused candidate')

  // Compaction truncates provider context, never the selected-branch facts used
  // to resolve evidence identities and receipt provenance.
  const kept=f.manager.getBranch().findLast(e=>e.type==='message'&&e.message.role==='assistant').id
  f.manager.appendCompaction('Bounded summary.',kept,100)
  await f.managed.goals.inspect()
  assert.deepEqual(goal(f).criteria.map(c=>c.state),['verified','verified'])

  // Complete then file-only Rewind: keep the reviewed SDK leaf and accounting,
  // invalidate completion, and expose stale evidence for restored versions.
  f.managed.goals.host.available=f.available;f.managed.goals.flush()
  await until(()=>goal(f)?.status==='completed'&&idle(f),'fully bound completion')
  const completedUsage=goal(f).tokens
  const preview=await f.app.rewindPreview(f.managed.path,checkpoint.id)
  assert.equal(preview.error,undefined)
  const leaf=f.manager.getLeafId()
  const restored=await f.app.rewindRestore({sessionPath:f.managed.path,token:preview.value.token,mode:'files',operationId:randomUUID()})
  assert.equal(restored.error,undefined)
  assert.equal(f.manager.getLeafId(),leaf,'file-only checkout never appends Goal metadata')
  assert.equal(goal(f).tokens,completedUsage);assert.equal(goal(f).status,'paused');assert.equal(goal(f).reason,'rewound')
  await f.managed.goals.inspect()
  assert.equal(goal(f).criteria[1].state,'stale','restored B cannot retain its modified-file proof')
  assert.equal(await readFile(f.b,'utf8'),'B original\n')
  const requests=f.requests.length
  await sleep(40);assert.equal(f.requests.length,requests,'Rewind cannot wake an old completion candidate')

  // Observing stale evidence after completion cannot strand the next selected
  // composer goal, while an explicit Rewind keeps its existing paused owner.
  assert.equal((await call(f,'create',{objective:'An overlapping goal',acceptance:'No',limits:{maxAutoRuns:20,tokenBudget:null}})).code,'busy')
  const replacement=await fixture()
  const [pa,pb]=goal(replacement).criteria.map(c=>c.id)
  await run(replacement,[[tool('read',{path:replacement.a})],[tool('read',{path:replacement.b})],()=>[update(replacement,'complete',[proof(replacement,pa,[source(replacement,replacement.a)]),proof(replacement,pb,[source(replacement,replacement.b)])])]])
  replacement.managed.goals.host.available=replacement.available;replacement.managed.goals.flush()
  await until(()=>goal(replacement)?.status==='completed'&&idle(replacement),'replaceable completed goal')
  replacement.managed.goals.host.available=()=>false
  const previousId=goal(replacement).id
  await writeFile(replacement.a,'Changed after completion\n');await replacement.managed.goals.inspect()
  assert.equal(goal(replacement).reason,'evidence')
  assert.equal((await call(replacement,'create',{objective:'The next submitted goal',acceptance:'Verify the next request',limits:{maxAutoRuns:20,tokenBudget:null}})).ok,true)
  assert.notEqual(goal(replacement).id,previousId)
  assert.equal(goal(replacement).objective,'The next submitted goal')

  // Crash/reopen retains branch proof, never replays it or appends a transition.
  const modules=await import(pathToFileURL(join(f.temporary,'modules.mjs')).href)
  await f.app.disposeManaged(f.managed)
  const manager=modules.SessionManager.open(f.managed.path),before=manager.getLeafId()
  const reopened=await f.app.buildSession(manager);await reopened.lifecyclePromise;await reopened.goals.inspect()
  assert.equal(manager.getLeafId(),before);assert.equal(reopened.goals.snapshot.tokens,completedUsage)
  assert.notEqual(reopened.goals.snapshot.status,'completed');assert.equal(f.requests.length,requests)
  // A service answer received after an external file edit cannot certify the
  // earlier criteria/evidence snapshot, even when it confidently says complete.
  const reviewRace=await fixture(),reviewGate=deferred(),reviewStarted=deferred()
  reviewRace.app.jevService.options.fetch=async(_url,init)=>{
    const input=JSON.parse(init.body)
    if(input.questions.review){reviewStarted.resolve();await reviewGate.promise}
    const answers=Object.fromEntries(Object.entries(input.questions).map(([id,q])=>{
      const choice=id==='route'?'act':'complete'
      return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(key=>[key,key===choice?1:0]))}]
    }))
    return new Response(JSON.stringify({model:'jev-1.13.0',answers,usage:{input_tokens:30,output_tokens:5}}),{status:200})
  }
  assert.equal((await reviewRace.app.updateJevSettings({apiKey:'goal-evidence-fixture'})).ok,true)
  assert.equal((await reviewRace.app.updateJevSettings({preferences:{mode:'workflow',choice:true,score:true,noul:true}})).ok,true)
  const [ra,rb]=goal(reviewRace).criteria.map(c=>c.id)
  const reviewing=run(reviewRace,[[tool('read',{path:reviewRace.a})],[tool('read',{path:reviewRace.b})],()=>[update(reviewRace,'complete',[proof(reviewRace,ra,[source(reviewRace,reviewRace.a)]),proof(reviewRace,rb,[source(reviewRace,reviewRace.b)])])]])
  await reviewStarted.promise;await writeFile(reviewRace.a,'Changed while Jev was reviewing\n');reviewGate.resolve();await reviewing
  assert.equal(reviewRace.managed.jevWorkflow.snapshot.phase,'paused')
  assert.equal(reviewRace.managed.jevWorkflow.snapshot.reason,'uncertain')
  assert.equal(goal(reviewRace).criteria[0].state,'stale')
  reviewRace.managed.goals.host.available=reviewRace.available;reviewRace.managed.goals.flush()
  await until(()=>goal(reviewRace)?.reason==='review'&&idle(reviewRace),'stale independent review pauses Goal')
  assert.notEqual(goal(reviewRace).status,'completed')

  const tampered=await fixture({extensionFactories:[pi=>pi.registerTool({name:'wide_result',label:'Long committed result',description:'A bounded-view fixture.',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},async execute(){return {content:[{type:'text',text:'HEAD'+ 'A'.repeat(5000)+'TAIL'}]}}})]})
  const tc=goal(tampered).criteria[0].id
  await run(tampered,[[tool('wide_result',{command:'fixture wide check'})],()=>[update(tampered,'verify',[proof(tampered,tc,[goal(tampered).evidenceResults.find(r=>r.tool==='wide_result').id])])]])
  const fullResult=tampered.manager.getBranch().findLast(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='wide_result')
  fullResult.message.content[0].text='HEAD'+ 'A'.repeat(2500)+'changed hidden middle'+ 'A'.repeat(2500)+'TAIL'
  await tampered.managed.goals.inspect()
  assert.equal(goal(tampered).criteria[0].state,'stale','the source hash covers the full committed result, not just its displayed excerpt')

  const historical=await fixture()
  await run(historical,[[tool('read',{path:historical.a})]])
  const old=goal(historical),legacyUsage=old.tokens
  const {criteria,criteriaRevision,evidenceResults,evidenceOmitted,evidenceBlocked,seq,autoRuns,tokens,accountingAvailable,executing,waiting,...record}=old
  historical.manager.appendCustomEntry('pith_goal_v1',{...record,version:1,status:'completed',reason:null,evidence:'Legacy prose-only completion.'})
  const legacyLeaf=historical.manager.getLeafId()
  historical.managed.goals.restore('interrupted');await historical.managed.goals.inspect()
  assert.equal(goal(historical).status,'paused');assert.equal(goal(historical).reason,'evidence')
  assert.equal(goal(historical).criteria[0].state,'pending');assert.equal(goal(historical).tokens,legacyUsage)
  assert.equal(historical.manager.getLeafId(),legacyLeaf,'legacy migration cannot append a transition or create allowance')

  console.log('PASS goal-evidence: criterion revisions, committed proof, file hashes, Todo gates, failed checks, Stop, Rewind and crash recovery')
} finally { await Promise.all(fixtures.map(f=>f.close())) }
