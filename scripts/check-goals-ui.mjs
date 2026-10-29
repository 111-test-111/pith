/** Real Electron/beUI composer and task overlay, with isolated typed IPC. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-goals-ui-'))
const fixture = String.raw`<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {SessionTasks} from '/src/components/app/SessionTasks.tsx';import {Composer} from '/src/components/app/Composer.tsx';
import {BashTasksProvider} from '/src/lib/bash-tasks.tsx';import {setReduceMotion} from '/src/lib/reduce-motion.ts';
import {goalCanBeReplaced} from '/@fs${repo}/src/shared/goal.ts';
import {I18nProvider} from '/src/i18n/index.tsx';import {PiStore} from '/src/state/pi-store.ts';import '/src/styles.css';
const h=React.createElement;const locale=new URLSearchParams(location.search).get('locale')||'en';localStorage.setItem('pi-app:locale',locale);setReduceMotion(true);
const saved=JSON.parse(sessionStorage.getItem('nativeGoal')||'null');
window.calls=[];window.stopCalls=0;window.seq=saved?.seq??1;window.goal=saved?.goal??null;window.reject=false;window.sent=[];window.PiStore=PiStore;
window.store=new PiStore();const snapshot=(path=saved?.path??'/fixture.jsonl')=>({sessionPath:path,sessionId:path,cwd:'/tmp',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false,goal:window.goal,goalSeq:window.seq});
window.store.applySnapshot(snapshot());
window.pi={searchFiles:async()=>[],queueAction:async()=>{},listBashTasks:async()=>[],onBashTask:()=>()=>{},goalAction:async request=>{
window.calls.push(request);if(window.hold)await new Promise(resolve=>window.release=resolve);if(window.reject)return {ok:false,code:'stale'};
const now=Date.now();if(request.action==='create')window.goal={version:2,criteriaRevision:1,criteria:[{id:'c1',revision:1,text:request.acceptance,proof:null,state:'pending'}],evidenceResults:[],evidenceOmitted:0,evidenceBlocked:false,id:'g'+now,objective:request.objective,acceptance:request.acceptance,limits:request.limits,status:'active',reason:null,evidence:null,createdAt:now,updatedAt:now,autoRuns:0,tokens:0,waiting:false,executing:false,accountingAvailable:true};
if(request.action==='pause')window.goal={...window.goal,status:'paused',reason:'user',executing:false};
if(request.action==='resume')window.goal={...window.goal,status:'active',reason:null};
if(request.action==='cancel')window.goal={...window.goal,status:'cancelled',reason:'user'};
if(request.action==='dismiss')window.goal={...window.goal,dismissed:true};
if(request.action==='criteria'||request.action==='definition')window.goal={...window.goal,objective:request.objective??window.goal.objective,executing:false,criteriaRevision:window.goal.criteriaRevision+1,status:'paused',reason:'criteria',evidence:null,criteria:request.criteria.map((row,index)=>{const old=window.goal.criteria.find(c=>c.id===row.id);return old&&old.text===row.text&&(!request.objective||request.objective===window.goal.objective)?old:{id:old?.id||'c'+(index+1),revision:(old?.revision||0)+1,text:row.text,proof:null,state:'pending'}})};
if(request.action==='limits')window.goal={...window.goal,limits:request.limits};
if(request.action==='create'&&!window.skipGoalCommit)window.store.dispatch({type:'message_end',sessionPath:request.sessionPath,message:{role:'user',timestamp:Date.now(),content:[{type:'text',text:request.objective}]}});
if(request.action==='create'&&window.handleGoalInput)window.goal={...window.goal,status:'paused',reason:'user',pendingInput:{cwd:'/tmp',files:[],imageCount:0,available:true}};
window.goal={...window.goal,seq:++window.seq};return {ok:true,goal:window.goal,seq:window.seq};}};
window.publish=patch=>{window.goal={...window.goal,...patch,seq:++window.seq};window.store.dispatch({type:'goal_update',sessionPath:'/fixture.jsonl',goal:window.goal,goalSeq:window.seq})};
window.switchSession=path=>window.store.applySnapshot({...snapshot(path),goal:null,goalSeq:1});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented)window.stopCalls++});
function App(){const state=React.useSyncExternalStore(window.store.subscribe,window.store.getState);const [restricted,setRestricted]=React.useState(false);window.setRestricted=setRestricted;
return h(I18nProvider,null,h(BashTasksProvider,{sessionPath:state.sessionPath},h('div',{style:{display:'flex',flexDirection:'column',height:'100vh',padding:'30px 0',margin:'0 auto',maxWidth:'760px'}},
h(SessionTasks,{key:state.sessionPath,sessionPath:state.sessionPath,todos:{items:[{id:'t1',content:'Existing task',status:'pending'}]},subagents:[],busy:state.goal?.executing===true,goal:state.goal,goalSeq:state.goalSeq,goalAvailable:true,goalRestricted:restricted,goalUI:state.goalUI,onGoalDraft:draft=>window.store.setGoalDraft(state.sessionPath,draft),onGoalEnd:()=>window.store.endGoalMode(state.sessionPath),onGoalState:(sessionPath,goal,goalSeq)=>window.store.dispatch({type:'goal_update',sessionPath,goal,goalSeq})}),
h('div',{'data-transcript':true,style:{flex:1,minHeight:0,background:'var(--background)'}},'Transcript stays in place'),
h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy:state.goal?.executing===true,sessionPath:state.sessionPath,goalEnabled:state.goalUI.enabled,goalPending:state.goalUI.pending,goalError:state.goalUI.error,onGoalModeChange:enabled=>enabled?window.store.openGoalMode(state.sessionPath):window.store.endGoalMode(state.sessionPath),queued:{steering:[],followUp:[]},onSend:payload=>state.goalUI.enabled&&goalCanBeReplaced(state.goal)?window.store.startGoal(payload):window.sent.push(payload),onQueue:()=>{},onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}}))))}
createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
let server, app
const errors = []
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temporary, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react(), tailwindcss(), { name: 'goals-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__goals.html') return next()
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__goals.html', fixture))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__goals.html'
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1000,height:850,show:false,webPreferences:{contextIsolation:false}}).loadURL(${JSON.stringify(url)}));`)
  app = await _electron.launch({ executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))
  const capture=async name=>{
    if(!process.env.PI_GOAL_SCREENSHOT_DIR)return
    await mkdir(process.env.PI_GOAL_SCREENSHOT_DIR,{recursive:true})
    await page.waitForFunction(()=>{
      const panel=document.querySelector('[data-task-panel="goal"]')
      return panel?.getAttribute('aria-hidden')==='false'&&getComputedStyle(panel).opacity==='1'&&getComputedStyle(panel.parentElement).opacity==='1'
    })
    await page.screenshot({path:join(process.env.PI_GOAL_SCREENSHOT_DIR,name)})
  }
  for (const [locale, label, controlLabel] of [['en', 'Goal mode', 'Goal'], ['zh-CN', '目标模式', '目标'], ['zh-TW', '目標模式', '目標']]) {
    await page.goto(url + '?locale=' + locale)
    const editor = page.locator('[data-main-composer]')
    const trigger = page.locator('[data-task-trigger="goal"]')
    const indicator = page.locator('[data-goal-mode-control]')
    await editor.waitFor()
    assert.equal(await trigger.count(), 0, 'Goal is hidden by default')
    assert.equal(await indicator.count(), 0)
    const defaultHint = await editor.getAttribute('aria-placeholder')
    const selectMode = async () => {
      await page.getByRole('button', { name: 'Add to prompt', exact: true }).click()
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.waitForFunction(() => window.store.getState().goalUI.enabled)
      assert.equal(await trigger.count(), 0, 'selection hides the Goal entry, including any ended previous goal')
    }
    const requestText = 'Implement a native goal\nVerify pause and resume.'
    await page.locator('[data-task-trigger="todo"]').click()
    await editor.fill(requestText)
    await selectMode()
    assert.equal(await indicator.count(), 1)
    assert.equal(await indicator.textContent(), controlLabel, 'the bottom control retains the localized Goal text')
    const goalHint = await editor.getAttribute('aria-placeholder')
    assert.notEqual(goalHint, defaultHint, 'Goal selection changes the editor hint')
    assert(goalHint.toLocaleLowerCase().includes(controlLabel.toLocaleLowerCase()), 'the selected hint describes a goal in the active locale')
    assert.equal(await page.evaluate(() => window.calls.length), 0, 'selection grants no execution')
    assert.equal(await page.evaluate(() => window.store.getState().goal), null)
    assert.equal(await editor.textContent(), requestText)
    await indicator.click()
    await page.waitForFunction(() => !window.store.getState().goalUI.enabled)
    assert.equal(await editor.getAttribute('aria-placeholder'), defaultHint, 'ending unstarted Goal mode restores the editor hint')
    assert.equal(await page.evaluate(() => window.calls.length), 0, 'ending unstarted mode needs no execution IPC')
    await selectMode()
    await page.locator('[data-task-trigger="todo"]').click()
    const before = await page.locator('[data-transcript]').boundingBox()
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.stopCalls), 0, 'Escape closes the overlay before Stop')
    await page.evaluate(() => window.hold = true)
    await editor.press('Enter')
    await page.waitForFunction(() => !!window.release)
    assert.equal(await trigger.count(), 0, 'pending creation cannot reveal an old or unsubmitted goal')
    assert.equal(await editor.textContent(), '', 'sending releases the draft before IPC returns')
    assert.equal(await page.evaluate(() => window.store.getState().messages.length),1,'the Goal message appears immediately before held IPC resolves')
    await page.evaluate(() => window.store.applySnapshot({sessionPath:'/fixture.jsonl',sessionId:'fixture',cwd:'/tmp',projectless:false,messages:[],eventSequence:1,model:null,thinkingLevel:'off',isStreaming:false,goal:null,goalSeq:1}))
    assert.equal(await page.evaluate(() => window.store.getState().messages.length),1,'a newer preflight snapshot cannot erase the optimistic Goal message')
    assert.equal(await editor.isEnabled(), true, 'goal activation never blocks editing')
    await editor.fill('Draft for the next turn')
    await editor.press('Enter')
    assert.equal(await page.evaluate(() => window.calls.length), 1, 'pending activation cannot double-submit')
    await page.evaluate(() => { window.hold = false; window.release() })
    await page.waitForFunction(() => window.store.getState().goal?.status === 'active' && !window.store.getState().goalUI.pending)
    assert.equal(await editor.textContent(), 'Draft for the next turn')
    assert.equal(await page.evaluate(() => window.store.getState().messages.length),1,'committed SDK user reconciliation leaves exactly one bubble')
    assert.deepEqual(await page.evaluate(() => window.calls[0]), { sessionPath: '/fixture.jsonl', expectedSeq: 1, goalId: null, action: 'create', objective: requestText, acceptance: requestText, limits: { maxAutoRuns: 20, tokenBudget: null }, images: [], files: [] })
    assert.equal(await trigger.count(), 1, 'a sent goal appears in the task strip')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'sending does not auto-open the Goal panel')
    await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(), requestText, 'opening shows the submitted user message as the current goal')
    assert.equal(await page.locator('[data-goal-acceptance-label]').count(),1,'only one acceptance section exists')
    assert.equal(await page.locator('[data-goal-action="showLimits"]').getAttribute('aria-expanded'),'false','allowance fields are collapsed by default')
    await page.locator('[data-goal-action="pause"]').click()
    await page.locator('[data-goal-status="paused"]').waitFor()
    await page.evaluate(() => window.publish({ tokens: 60, billing: { parentTokens: 20, subagentTokens: 30, jevTokens: 10, unresolved: 0 } }))
    await page.waitForFunction(() => { const disclosure = document.querySelector('[data-goal-billing]')?.closest('[aria-hidden]'); return disclosure?.getAttribute('aria-hidden') === 'true' && disclosure.inert && disclosure.getBoundingClientRect().height === 0 })
    await page.locator('[data-goal-action="showLimits"]').click()
    await page.waitForFunction(() => document.querySelector('[data-goal-billing]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false')
    assert((await page.locator('[data-goal-billing]').textContent()).includes('30'))
    assert((await page.locator('[data-goal-billing]').textContent()).includes('Jev'))
    await page.evaluate(() => window.publish({ accountingAvailable: false, reason: 'accounting', billing: { parentTokens: 20, subagentTokens: 30, jevTokens: 10, unresolved: 1 } }))
    await page.waitForFunction(() => document.querySelector('[data-goal-action="resume"]').disabled)
    assert.equal(await page.locator('[data-goal-action="resume"]').isDisabled(), true, 'unknown independent usage cannot be resumed in any locale')
    assert(!(await page.locator('[data-goal-billing]').textContent()).includes('goal.billingUnresolved'), 'unknown usage is localized')
    await page.evaluate(() => window.publish({ accountingAvailable: true, reason: 'user', billing: { parentTokens: 20, subagentTokens: 30, jevTokens: 10, unresolved: 0 } }))
    await page.locator('[data-goal-action="showLimits"]').click()
    await capture(`goal-${locale}.png`)
    await page.evaluate(() => window.setRestricted(true))
    await page.waitForFunction(() => document.querySelector('[data-goal-action="resume"]').disabled)
    await page.evaluate(() => window.setRestricted(false))
    await page.waitForFunction(() => !document.querySelector('[data-goal-action="resume"]').disabled)
    await page.evaluate(() => window.publish({status:'active',executing:true,waiting:true}))
    assert.equal(await page.locator('[data-goal-action="editCriteria"]').isEnabled(),true,'criteria and objective remain editable during execution and waiting')
    await page.locator('[data-goal-action="editCriteria"]').click()
    assert.equal(await page.locator('[data-goal-objective-input]').inputValue(),requestText)
    await page.locator('[data-goal-action="addCriterion"]').click()
    assert.equal(await page.locator('[data-goal-action="saveCriteria"]').isDisabled(), true, 'empty criteria cannot be saved')
    const criterionInputs = page.locator('[data-goal-criterion-input]')
    await criterionInputs.nth(1).fill('Check crash recovery')
    await page.evaluate(() => window.reject = true)
    await page.locator('[data-goal-action="saveCriteria"]').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await criterionInputs.nth(1).inputValue(), 'Check crash recovery', 'a refused edit preserves the draft')
    await page.evaluate(() => window.reject = false)
    await page.locator('[data-goal-action="saveCriteria"]').click()
    await page.waitForFunction(() => window.store.getState().goal.criteriaRevision === 2)
    assert.equal(await page.locator('[data-goal-criterion]').count(), 2)
    assert.equal(await page.evaluate(() => window.store.getState().goal.reason), 'criteria')
    const criteriaCall = await page.evaluate(() => window.calls.find(c => c.action === 'definition'))
    assert.equal(criteriaCall.criteriaRevision, 1)
    assert.deepEqual(criteriaCall.criteria, [{id:'c1',text:requestText},{text:'Check crash recovery'}])
    await page.evaluate(() => window.publish({criteria:window.goal.criteria.map((c,i)=>i===0?{...c,state:'verified',proof:{revision:c.revision,summary:'Verified with a committed read',receiptId:'r1',sources:[{id:'read1',stampId:'s1',hash:'a'.repeat(64)}]},files:{'/tmp/result.txt':'b'.repeat(64)}}:c)}))
    assert.equal(await page.locator('[data-criterion-state="verified"]').count(), 1)
    const proofToggle=page.locator('[data-goal-proof-toggle]').first()
    assert.equal(await proofToggle.getAttribute('aria-expanded'),'false','long proof details are collapsed by default')
    assert.equal(await page.locator('[data-criterion-proof]').evaluate(node=>node.closest('[aria-hidden]').clientHeight),0)
    await proofToggle.click()
    assert.equal(await page.locator('[data-criterion-proof]').textContent(), 'Verified with a committed read')
    assert.equal(await page.locator('[data-criterion-file]').count(), 1)
    await page.locator('[data-goal-action="editCriteria"]').click()
    await page.locator('[data-goal-criterion-input]').nth(1).fill('Check crash recovery and quotas')
    await page.locator('[data-goal-action="saveCriteria"]').click()
    await page.waitForFunction(() => window.store.getState().goal.criteriaRevision === 3)
    assert.equal(await page.locator('[data-criterion-state="verified"]').count(), 1, 'unchanged proof remains visible')
    await page.evaluate(() => window.publish({status:'active',executing:true,waiting:false}))
    await page.locator('[data-goal-action="editCriteria"]').click()
    await page.locator('[data-goal-objective-input]').fill('Revised current goal')
    await page.locator('[data-goal-action="saveCriteria"]').click()
    await page.waitForFunction(() => window.store.getState().goal.criteriaRevision===4)
    assert.equal(await page.locator('[data-goal-objective]').textContent(),'Revised current goal')
    assert.equal(await page.locator('[data-criterion-state="verified"]').count(),0,'a changed objective clears every proof')
    await page.evaluate(() => window.setRestricted(true))
    assert.equal(await page.locator('[data-goal-action="editCriteria"]').isEnabled(), true, 'definition edits do not change Plan permissions')
    await page.evaluate(() => window.setRestricted(false))
    await capture(`criteria-${locale}.png`)
    await page.locator('[data-goal-action="showLimits"]').click()
    await page.locator('[data-goal-input="runs"]').fill('4')
    await page.locator('[data-goal-input="tokens"]').fill('10000')
    await page.locator('[data-task-trigger="todo"]').click()
    await trigger.click()
    assert.equal(await page.locator('[data-goal-input="runs"]').inputValue(), '4', 'task switching preserves limit edits')
    await page.locator('[data-goal-action="limits"]').click()
    await page.waitForFunction(() => window.store.getState().goal.limits.maxAutoRuns === 4 && window.store.getState().goal.limits.tokenBudget === 10000)
    await page.locator('[data-goal-input="runs"]').fill('0')
    assert.equal(await page.locator('[data-goal-action="limits"]').isDisabled(), true, 'invalid limits cannot be saved')
    await page.locator('[data-goal-input="runs"]').fill('7')
    await page.locator('[data-goal-action="limits"]').click()
    await page.waitForFunction(() => window.store.getState().goal.limits.maxAutoRuns === 7)
    await page.locator('[data-goal-action="resume"]').click()
    await page.locator('[data-goal-status="active"]').waitFor()
    await page.locator('[data-task-trigger="todo"]').click()
    assert.equal((await page.locator('[data-transcript]').boundingBox()).y, before.y, 'overlays never shift the transcript')
    await trigger.click()
    await page.evaluate(() => window.reject = true)
    await page.locator('[data-goal-action="end"]').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await indicator.count(), 1, 'failed End retains goal mode')
    await page.evaluate(() => window.reject = false)
    await page.locator('[data-goal-input="runs"]').fill('0')
    await page.locator('[data-goal-action="end"]').click()
    await page.waitForFunction(() => !window.store.getState().goalUI.enabled)
    assert.equal(await trigger.count(), 0)
    assert.equal(await indicator.count(), 0)
    assert.equal(await page.evaluate(() => window.store.getState().goal.status), 'cancelled', 'End retains the cancelled goal record')

    await selectMode()
    assert.equal(await page.evaluate(() => window.store.getState().goalUI.limits.maxAutoRuns), 7, 'a new selection discards invalid unsaved limits from the ended goal')
    await page.evaluate(() => window.store.setGoalDraft('/fixture.jsonl', { acceptance: '', limits: { maxAutoRuns: 0, tokenBudget: null } }))
    await editor.fill('Retry this goal')
    const beforeInvalid = await page.evaluate(() => window.calls.length)
    await editor.press('Enter')
    await page.waitForFunction(() => window.store.getState().goalUI.error === 'invalid')
    await page.locator('[data-goal-error]').waitFor()
    assert.equal(await trigger.count(), 0, 'a refused start reports in the composer without opening a Goal panel')
    assert.equal(await editor.textContent(), 'Retry this goal')
    assert.equal(await page.evaluate(() => window.calls.length), beforeInvalid, 'invalid limits never create a goal')
    await page.evaluate(() => window.store.setGoalDraft('/fixture.jsonl', { acceptance: '', limits: { maxAutoRuns: 7, tokenBudget: 10000 } }))
    await page.evaluate(() => window.reject = true)
    await editor.fill('Retry this goal')
    await editor.press('Enter')
    await page.waitForFunction(() => !window.store.getState().goalUI.pending && window.store.getState().goalUI.error === 'stale')
    await page.locator('[data-goal-error]').waitFor()
    assert.equal(await trigger.count(), 0)
    assert.equal(await editor.textContent(), 'Retry this goal', 'a refused start restores its draft')
    await page.evaluate(() => { window.hold = true; window.release = null })
    const persistedCount=await page.evaluate(()=>window.store.getState().messages.length)
    await editor.press('Enter')
    await page.waitForFunction(() => !!window.release)
    assert.equal(await page.evaluate(()=>window.store.getState().messages.length),persistedCount+1)
    await editor.fill('Newer draft')
    await page.evaluate(() => { window.hold = false; window.release() })
    await page.waitForFunction(() => !window.store.getState().goalUI.pending)
    assert.equal(await editor.textContent(), 'Newer draft', 'a late failure never overwrites newer input')
    assert.equal(await page.evaluate(()=>window.store.getState().messages.length),persistedCount,'refusal rolls back only its uncommitted echo')
    await page.evaluate(() => window.reject = false)
    await editor.fill('Second goal')
    await editor.press('Enter')
    await page.waitForFunction(() => window.store.getState().goal?.status === 'active' && !window.store.getState().goalUI.pending)
    assert.equal(await page.evaluate(() => window.store.getState().goal.acceptance), 'Second goal', 'unspecified criteria come from this request')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(), 'Second goal', 'the next goal replaces the old message in the panel')
    await page.evaluate(() => { window.hold = true; window.release = null })
    await page.locator('[data-goal-action="end"]').click()
    await page.waitForFunction(() => !!window.release)
    await page.evaluate(() => { window.switchSession('/other.jsonl'); window.hold = false; window.release() })
    await page.waitForFunction(() => window.goal.status === 'cancelled')
    assert.equal(await page.evaluate(() => window.store.getState().goal), null, 'late End stays with its originating chat')
    assert.equal(await indicator.count(), 0)
    await page.evaluate(() => window.store.activateCachedSession('/fixture.jsonl'))
    await page.waitForFunction(() => !window.store.getState().goalUI.pending)
    assert.equal(await trigger.count(), 0, 'late metadata never re-enables ended mode')
    await page.evaluate(() => {
      window.goal={...window.goal,status:'paused',reason:'interrupted'}
      window.store.applySnapshot({ sessionPath: '/restored.jsonl', sessionId: 'restored', cwd: '/tmp', messages: [], model: null, thinkingLevel: 'off', isStreaming: false,
        goal: window.goal, goalSeq: ++window.seq })
    })
    await trigger.waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a restored goal stays discoverable without auto-opening')
    assert.equal(await indicator.textContent(), controlLabel)
    await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(), 'Second goal')
    await page.evaluate(() => {
      const state = window.store.getState()
      window.goal={ ...state.goal, status: 'completed', reason: null, criteria:state.goal.criteria.map(c=>({...c,state:'verified',proof:{revision:c.revision,summary:'Verified with current committed evidence. '.repeat(20),receiptId:'finished-receipt',sources:[{id:'finished-result',stampId:'finished-stamp',hash:'a'.repeat(64)}]},files:{'/tmp/current-result.txt':'b'.repeat(64)}})),evidence:'Repeated summary should not clutter the completed panel.'.repeat(30)}
      window.store.dispatch({ type: 'goal_update', sessionPath: state.sessionPath, goal:window.goal, goalSeq: ++window.seq })
    })
    await page.locator('[data-goal-status="completed"]').waitFor()
    assert.equal(await trigger.count(), 1, 'a completed current goal remains inspectable until End')
    assert.equal(await page.locator('[data-goal-input="acceptance"]').count(),0,'completed goals never gain a second acceptance input')
    assert.equal(await page.locator('[data-goal-evidence]').count(),0,'completion summaries do not repeat the bound proofs')
    await page.evaluate(()=>sessionStorage.setItem('nativeGoal',JSON.stringify({goal:window.goal,seq:window.seq,path:'/restored.jsonl'})))
    await page.reload()
    await trigger.waitFor()
    assert.equal(await indicator.count(),1,'a completed goal survives a fresh renderer restart')
    assert.equal(await trigger.getAttribute('aria-expanded'),'false','restart does not auto-open the retained panel')
    assert.equal(await page.evaluate(()=>window.calls.length),0,'restoring a completed Goal grants no execution')
    assert.equal(await page.evaluate(()=>{
      const delayed=new window.PiStore(),state=window.store.getState()
      delayed.applySnapshot({sessionPath:state.sessionPath,sessionId:'restored',cwd:'/tmp',messages:[],model:null,thinkingLevel:'off',isStreaming:false,goal:null,goalSeq:0})
      delayed.dispatch({type:'goal_update',sessionPath:state.sessionPath,goal:state.goal,goalSeq:state.goalSeq})
      return delayed.getState().goalUI.submitted
    }),true,'late restored metadata cannot leave an existing goal hidden')
    await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(),'Second goal')
    assert.equal(await page.locator('[data-goal-acceptance-label]').count(),1)
    assert.equal(await page.locator('[data-goal-proof-toggle]').first().getAttribute('aria-expanded'),'false')
    await capture(`completed-${locale}.png`)
    const beforeCompletedEnd = await page.evaluate(() => window.calls.length)
    await page.locator('[data-goal-action="end"]').click()
    await page.waitForFunction(() => !window.store.getState().goalUI.enabled)
    assert.equal(await trigger.count(), 0)
    assert.equal(await page.evaluate(() => window.calls.length), beforeCompletedEnd+1, 'End persists presentation independently of completion')
    assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'dismiss')
    assert.equal(await page.evaluate(()=>window.store.getState().goal.status),'completed','End preserves the completed outcome')
    await page.evaluate(()=>sessionStorage.setItem('nativeGoal',JSON.stringify({goal:window.goal,seq:window.seq,path:'/restored.jsonl'})))
    await page.reload()
    await editor.waitFor()
    assert.equal(await trigger.count(),0,'an explicitly ended goal stays hidden after restart')
    assert.equal(await indicator.count(),0)
    assert.equal(await page.evaluate(()=>window.store.getState().goal.dismissed),true,'the goal record survives End')
    await page.evaluate(()=>sessionStorage.removeItem('nativeGoal'))
  }
  await page.goto(url + '?locale=en')
  await page.locator('[data-main-composer]').waitFor()
  await page.evaluate(() => {
    const now=Date.now()
    window.goal={version:2,id:'old-completed',objective:'Old completed goal',acceptance:'Old criterion',criteriaRevision:1,
      criteria:[{id:'old-c',text:'Old criterion',revision:1,state:'stale',proof:{revision:1,summary:'Old proof',sources:[{id:'old-r',stampId:'old-s',hash:'a'.repeat(64)}],receiptId:'old-claim'}}],
      evidenceResults:[],evidenceOmitted:0,evidenceBlocked:false,status:'paused',reason:'evidence',evidence:null,limits:{maxAutoRuns:20,tokenBudget:null},
      createdAt:now,updatedAt:now,autoRuns:0,tokens:10,waiting:false,executing:false,accountingAvailable:true,seq:++window.seq}
    window.store.dispatch({type:'goal_update',sessionPath:'/fixture.jsonl',goal:window.goal,goalSeq:window.seq})
    window.store.openGoalMode('/fixture.jsonl')
  })
  await page.locator('[data-main-composer]').fill('A new submitted goal after stale completion')
  await page.locator('[data-main-composer]').press('Enter')
  await page.waitForFunction(() => window.store.getState().goal.objective === 'A new submitted goal after stale completion')
  assert.equal(await page.evaluate(() => window.calls.at(-1).action), 'create')
  const sendUncommitted = async (handled = false) => {
    await page.goto(url + '?locale=en')
    const editor = page.locator('[data-main-composer]')
    await editor.waitFor()
    await page.evaluate(handled => {
      window.skipGoalCommit = true
      window.handleGoalInput = handled
      window.store.openGoalMode('/fixture.jsonl')
    }, handled)
    await editor.fill('Goal input awaiting SDK acceptance')
    await editor.press('Enter')
    await page.waitForFunction(() => window.store.getState().goal && !window.store.getState().goalUI.pending)
    return editor
  }
  const handledEditor = await sendUncommitted(true)
  assert.deepEqual(await page.evaluate(() => {
    const state = window.store.getState()
    return { messages: state.messages.length, awaiting: state.awaitingRun, status: state.goal.status, submitted: state.goalUI.submitted }
  }), { messages: 0, awaiting: false, status: 'paused', submitted: true }, 'SDK-handled input releases the provisional bubble and spinner while preserving the pending Goal')
  await handledEditor.fill('The editor remains usable')
  assert.equal(await handledEditor.textContent(), 'The editor remains usable')

  await sendUncommitted()
  assert.equal(await page.evaluate(() => window.store.getState().messages.length), 1)
  await page.evaluate(() => {
    window.store.appendOptimisticUser('Another ordinary user message', [])
    window.switchSession('/other.jsonl')
    window.publish({ status: 'paused', reason: 'user', executing: false, pendingInput: { cwd: '/tmp', files: [], imageCount: 0, available: true } })
  })
  assert.deepEqual(await page.evaluate(() => {
    const state = window.store.getState()
    return { messages: state.messages.length, awaiting: state.awaitingRun, goal: state.goal }
  }), { messages: 0, awaiting: false, goal: null }, 'a late Goal pause cannot change the foreground chat')
  await page.evaluate(() => window.store.activateCachedSession('/fixture.jsonl'))
  assert.deepEqual(await page.evaluate(() => {
    const state = window.store.getState()
    return { messages: state.messages.map(m => m.content), awaiting: state.awaitingRun, status: state.goal.status }
  }), { messages: ['Another ordinary user message'], awaiting: true, status: 'paused' }, 'cleanup pins the Goal echo identity and leaves other provisional messages intact')

  await sendUncommitted()
  await page.evaluate(() => window.publish({ status: 'cancelled', reason: 'user', executing: false }))
  assert.deepEqual(await page.evaluate(() => {
    const state = window.store.getState()
    return { messages: state.messages.length, awaiting: state.awaitingRun }
  }), { messages: 0, awaiting: false }, 'End before the first user commit releases the provisional run even without pending-input metadata')

  await sendUncommitted()
  await page.evaluate(() => {
    window.goal = { ...window.goal, status: 'paused', reason: 'interrupted', executing: false,
      pendingInput: { cwd: '/tmp', files: [], imageCount: 0, available: true }, seq: ++window.seq }
    window.store.applySnapshot({ sessionPath: '/fixture.jsonl', sessionId: 'fixture', cwd: '/tmp', messages: [], eventSequence: 2,
      model: null, thinkingLevel: 'off', isStreaming: false, goal: window.goal, goalSeq: window.seq })
  })
  assert.deepEqual(await page.evaluate(() => {
    const state = window.store.getState()
    return { messages: state.messages.length, awaiting: state.awaitingRun, status: state.goal.status }
  }), { messages: 0, awaiting: false, status: 'paused' }, 'a recovery snapshot settles unaccepted Goal input without an extra event')
  assert.deepEqual(errors, [])
  console.log('PASS goals-ui: bottom-only selection, Goal entry after send, immediate/reconciled input, handled/paused/cancelled recovery, single acceptance section, persistent completion/End, live edits, limits, Plan, Escape and chat ownership in all locales')
} finally {
  await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true })
}
