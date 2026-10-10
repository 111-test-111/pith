/** Real Electron/beUI task overlay. All IPC and state use an isolated fixture. */
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
import {SessionTasks} from '/src/components/app/SessionTasks.tsx';
import {BashTasksProvider} from '/src/lib/bash-tasks.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';import {PiStore} from '/src/state/pi-store.ts';import '/src/styles.css';
const h=React.createElement;const locale=new URLSearchParams(location.search).get('locale')||'en';localStorage.setItem('pi-app:locale',locale);
window.calls=[];window.stopCalls=0;window.seq=1;window.goal=null;window.reject=false;
window.store=new PiStore();const snapshot=(path='/fixture.jsonl')=>({sessionPath:path,sessionId:path,cwd:'/tmp',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false,goal:window.goal,goalSeq:window.seq});
window.store.applySnapshot(snapshot());
window.pi={listBashTasks:async()=>[],onBashTask:()=>()=>{},goalAction:async request=>{
window.calls.push(request);if(window.hold)await new Promise(resolve=>window.release=resolve);if(window.reject)return {ok:false,code:'stale'};
const now=Date.now();if(request.action==='create')window.goal={version:1,id:'g1',objective:request.objective,acceptance:request.acceptance,limits:request.limits,status:'active',reason:null,evidence:null,createdAt:now,updatedAt:now,autoRuns:0,tokens:0,waiting:false,accountingAvailable:true};
if(request.action==='pause')window.goal={...window.goal,status:'paused',reason:'user'};
if(request.action==='resume')window.goal={...window.goal,status:'active',reason:null};
if(request.action==='cancel')window.goal={...window.goal,status:'cancelled',reason:'user'};
if(request.action==='limits')window.goal={...window.goal,limits:request.limits};
window.goal={...window.goal,seq:++window.seq};return {ok:true,goal:window.goal,seq:window.seq};}};
window.publish=(patch)=>{window.goal={...window.goal,...patch,seq:++window.seq};window.store.dispatch({type:'goal_update',sessionPath:'/fixture.jsonl',goal:window.goal,goalSeq:window.seq})};
window.switchSession=path=>window.store.applySnapshot({...snapshot(path),goal:null,goalSeq:1});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented)window.stopCalls++});
function App(){const state=React.useSyncExternalStore(window.store.subscribe,window.store.getState);const [restricted,setRestricted]=React.useState(false);window.setRestricted=setRestricted;
return h(I18nProvider,null,h('div',{style:{padding:'30px 0',margin:'0 auto',maxWidth:'760px'}},h(BashTasksProvider,{sessionPath:state.sessionPath},
h(SessionTasks,{key:state.sessionPath,sessionPath:state.sessionPath,todos:{items:[{id:'t1',content:'Existing task',status:'pending'}]},subagents:[],busy:false,goal:state.goal,goalSeq:state.goalSeq,goalAvailable:true,goalRestricted:restricted,onGoalState:(sessionPath,goal,goalSeq)=>window.store.dispatch({type:'goal_update',sessionPath,goal,goalSeq})}),
h('div',{'data-transcript':true,style:{height:600,background:'var(--background)'}},'Transcript stays in place'))))}
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
  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    await page.goto(url + '?locale=' + locale)
    const trigger = page.locator('[data-task-trigger="goal"]')
    await trigger.waitFor()
    const before = await page.locator('[data-transcript]').boundingBox()
    await trigger.click()
    await page.locator('[data-goal-input="objective"]').fill('Implement a native goal')
    await page.locator('[data-goal-input="acceptance"]').fill('The specific checks pass')
    await page.locator('[data-task-trigger="todo"]').click()
    await trigger.click()
    assert.equal(await page.locator('[data-goal-input="objective"]').inputValue(), 'Implement a native goal', 'switching task panels preserves the goal draft')
    await page.locator('[data-goal-input="runs"]').fill('4')
    await page.locator('[data-goal-input="tokens"]').fill('10000')
    await page.locator('[data-goal-action="create"]').click()
    await page.locator('[data-goal-status="active"]').waitFor()
    assert.equal(await page.locator('[data-goal-evidence]').count(), 0)
    const request = await page.evaluate(() => window.calls[0])
    assert.deepEqual(request, { sessionPath: '/fixture.jsonl', expectedSeq: 1, goalId: null, action: 'create', objective: 'Implement a native goal', acceptance: 'The specific checks pass', limits: { maxAutoRuns: 4, tokenBudget: 10000 } })
    await page.locator('[data-goal-action="pause"]').click()
    await page.locator('[data-goal-status="paused"]').waitFor()
    if (process.env.PI_GOAL_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_GOAL_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.PI_GOAL_SCREENSHOT_DIR, `goal-${locale}.png`) })
    }
    await page.evaluate(() => window.setRestricted(true))
    await page.waitForFunction(() => document.querySelector('[data-goal-action="resume"]').disabled)
    assert.equal(await page.locator('[data-goal-action="resume"]').isEnabled(), false, 'Plan cannot resume')
    await page.evaluate(() => window.setRestricted(false))
    await page.waitForFunction(() => !document.querySelector('[data-goal-action="resume"]').disabled)
    await page.locator('[data-goal-input="runs"]').fill('7')
    await page.locator('[data-goal-action="limits"]').click()
    await page.waitForFunction(() => window.store.getState().goal.limits.maxAutoRuns === 7)
    await page.locator('[data-goal-action="resume"]').click()
    await page.locator('[data-goal-status="active"]').waitFor()
    await page.locator('[data-task-trigger="todo"]').click()
    assert.equal((await page.locator('[data-transcript]').boundingBox()).y, before.y, 'task panels never shift the transcript')
    await trigger.click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-task-trigger="goal"]').getAttribute('aria-expanded') === 'false')
    assert.equal(await page.evaluate(() => window.stopCalls), 0, 'Escape closes the overlay before Stop')
    await trigger.click()
    await page.evaluate(() => window.reject = true)
    await page.locator('[data-goal-action="pause"]').click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('[data-goal-status="active"]').count(), 1, 'failed IPC cannot paint a pause')
    await page.evaluate(() => { window.reject = false; window.hold = true })
    await page.locator('[data-goal-action="cancel"]').click()
    await page.waitForFunction(() => !!window.release)
    await page.evaluate(() => { window.switchSession('/other.jsonl'); window.hold = false; window.release() })
    await page.waitForFunction(() => window.goal.status === 'cancelled')
    assert.equal(await page.evaluate(() => window.store.getState().goal), null, 'late action receipts stay with the originating session')
  }
  assert.deepEqual(errors, [])
  console.log('PASS goals-ui: create, pause, resume, limits, Plan, Escape and session ownership in all locales')
} finally {
  await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true })
}
