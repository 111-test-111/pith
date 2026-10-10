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
import {I18nProvider} from '/src/i18n/index.tsx';import {PiStore} from '/src/state/pi-store.ts';import '/src/styles.css';
const h=React.createElement;const locale=new URLSearchParams(location.search).get('locale')||'en';localStorage.setItem('pi-app:locale',locale);setReduceMotion(true);
window.calls=[];window.stopCalls=0;window.seq=1;window.goal=null;window.reject=false;window.sent=[];
window.store=new PiStore();const snapshot=(path='/fixture.jsonl')=>({sessionPath:path,sessionId:path,cwd:'/tmp',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false,goal:window.goal,goalSeq:window.seq});
window.store.applySnapshot(snapshot());
window.pi={searchFiles:async()=>[],queueAction:async()=>{},listBashTasks:async()=>[],onBashTask:()=>()=>{},goalAction:async request=>{
window.calls.push(request);if(window.hold)await new Promise(resolve=>window.release=resolve);if(window.reject)return {ok:false,code:'stale'};
const now=Date.now();if(request.action==='create')window.goal={version:1,id:'g'+now,objective:request.objective,acceptance:request.acceptance,limits:request.limits,status:'active',reason:null,evidence:null,createdAt:now,updatedAt:now,autoRuns:0,tokens:0,waiting:false,executing:false,accountingAvailable:true};
if(request.action==='pause')window.goal={...window.goal,status:'paused',reason:'user'};
if(request.action==='resume')window.goal={...window.goal,status:'active',reason:null};
if(request.action==='cancel')window.goal={...window.goal,status:'cancelled',reason:'user'};
if(request.action==='limits')window.goal={...window.goal,limits:request.limits};
window.goal={...window.goal,seq:++window.seq};return {ok:true,goal:window.goal,seq:window.seq};}};
window.publish=patch=>{window.goal={...window.goal,...patch,seq:++window.seq};window.store.dispatch({type:'goal_update',sessionPath:'/fixture.jsonl',goal:window.goal,goalSeq:window.seq})};
window.switchSession=path=>window.store.applySnapshot({...snapshot(path),goal:null,goalSeq:1});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented)window.stopCalls++});
function App(){const state=React.useSyncExternalStore(window.store.subscribe,window.store.getState);const [restricted,setRestricted]=React.useState(false);window.setRestricted=setRestricted;
return h(I18nProvider,null,h(BashTasksProvider,{sessionPath:state.sessionPath},h('div',{style:{display:'flex',flexDirection:'column',height:'100vh',padding:'30px 0',margin:'0 auto',maxWidth:'760px'}},
h(SessionTasks,{key:state.sessionPath,sessionPath:state.sessionPath,todos:{items:[{id:'t1',content:'Existing task',status:'pending'}]},subagents:[],busy:false,goal:state.goal,goalSeq:state.goalSeq,goalAvailable:true,goalRestricted:restricted,goalUI:state.goalUI,onGoalDraft:draft=>window.store.setGoalDraft(state.sessionPath,draft),onGoalEnd:()=>window.store.endGoalMode(state.sessionPath),onGoalState:(sessionPath,goal,goalSeq)=>window.store.dispatch({type:'goal_update',sessionPath,goal,goalSeq})}),
h('div',{'data-transcript':true,style:{flex:1,minHeight:0,background:'var(--background)'}},'Transcript stays in place'),
h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy:false,sessionPath:state.sessionPath,goalEnabled:state.goalUI.enabled,goalPending:state.goalUI.pending,goalError:state.goalUI.error,onGoalModeChange:enabled=>enabled?window.store.openGoalMode(state.sessionPath):window.store.endGoalMode(state.sessionPath),queued:{steering:[],followUp:[]},onSend:payload=>state.goalUI.enabled&&(!state.goal||['completed','cancelled'].includes(state.goal.status))?window.store.startGoal(payload):window.sent.push(payload),onQueue:()=>{},onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}}))))}
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
  for (const [locale, label, controlLabel] of [['en', 'Goal mode', 'Goal'], ['zh-CN', '目标模式', '目标'], ['zh-TW', '目標模式', '目標']]) {
    await page.goto(url + '?locale=' + locale)
    const editor = page.locator('[data-main-composer]')
    const trigger = page.locator('[data-task-trigger="goal"]')
    const indicator = page.locator('[data-goal-mode-control]')
    await editor.waitFor()
    assert.equal(await trigger.count(), 0, 'Goal is hidden by default')
    assert.equal(await indicator.count(), 0)
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
    assert.equal(await page.evaluate(() => window.calls.length), 0, 'selection grants no execution')
    assert.equal(await page.evaluate(() => window.store.getState().goal), null)
    assert.equal(await editor.textContent(), requestText)
    await indicator.click()
    await page.waitForFunction(() => !window.store.getState().goalUI.enabled)
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
    assert.equal(await editor.isEnabled(), true, 'goal activation never blocks editing')
    await editor.fill('Draft for the next turn')
    await editor.press('Enter')
    assert.equal(await page.evaluate(() => window.calls.length), 1, 'pending activation cannot double-submit')
    await page.evaluate(() => { window.hold = false; window.release() })
    await page.waitForFunction(() => window.store.getState().goal?.status === 'active' && !window.store.getState().goalUI.pending)
    assert.equal(await editor.textContent(), 'Draft for the next turn')
    assert.deepEqual(await page.evaluate(() => window.calls[0]), { sessionPath: '/fixture.jsonl', expectedSeq: 1, goalId: null, action: 'create', objective: requestText, acceptance: requestText, limits: { maxAutoRuns: 20, tokenBudget: null }, images: [], files: [] })
    assert.equal(await trigger.count(), 1, 'a sent goal appears in the task strip')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'sending does not auto-open the Goal panel')
    await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(), requestText, 'opening shows the submitted user message as the current goal')
    await page.locator('[data-goal-action="pause"]').click()
    await page.locator('[data-goal-status="paused"]').waitFor()
    if (process.env.PI_GOAL_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_GOAL_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.PI_GOAL_SCREENSHOT_DIR, `goal-${locale}.png`) })
    }
    await page.evaluate(() => window.setRestricted(true))
    await page.waitForFunction(() => document.querySelector('[data-goal-action="resume"]').disabled)
    await page.evaluate(() => window.setRestricted(false))
    await page.waitForFunction(() => !document.querySelector('[data-goal-action="resume"]').disabled)
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
    await editor.press('Enter')
    await page.waitForFunction(() => !!window.release)
    await editor.fill('Newer draft')
    await page.evaluate(() => { window.hold = false; window.release() })
    await page.waitForFunction(() => !window.store.getState().goalUI.pending)
    assert.equal(await editor.textContent(), 'Newer draft', 'a late failure never overwrites newer input')
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
    await page.evaluate(() => window.store.applySnapshot({ sessionPath: '/restored.jsonl', sessionId: 'restored', cwd: '/tmp', messages: [], model: null, thinkingLevel: 'off', isStreaming: false,
      goal: { ...window.goal, status: 'paused', reason: 'interrupted' }, goalSeq: ++window.seq }))
    await trigger.waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a restored goal stays discoverable without auto-opening')
    assert.equal(await indicator.textContent(), controlLabel)
    await trigger.click()
    assert.equal(await page.locator('[data-goal-objective]').textContent(), 'Second goal')
    await page.evaluate(() => {
      const state = window.store.getState()
      window.store.dispatch({ type: 'goal_update', sessionPath: state.sessionPath, goal: { ...state.goal, status: 'completed', reason: null }, goalSeq: ++window.seq })
    })
    await page.locator('[data-goal-status="completed"]').waitFor()
    assert.equal(await trigger.count(), 1, 'a completed current goal remains inspectable until End')
    const beforeCompletedEnd = await page.evaluate(() => window.calls.length)
    await page.locator('[data-goal-action="end"]').click()
    await page.waitForFunction(() => !window.store.getState().goalUI.enabled)
    assert.equal(await trigger.count(), 0)
    assert.equal(await page.evaluate(() => window.calls.length), beforeCompletedEnd, 'ending a completed mode changes presentation only')
  }
  assert.deepEqual(errors, [])
  console.log('PASS goals-ui: bottom-only selection, Goal entry after send, current user message, responsive drafts, End, pause/resume, limits, Plan, Escape and chat ownership in all locales')
} finally {
  await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true })
}
