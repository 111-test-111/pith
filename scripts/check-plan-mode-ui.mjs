/** Isolated Electron + real beUI/Composer. Fake IPC uses no user profile or model. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'
const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-plan-ui-'))
const fixture = String.raw`<!doctype html><html><body style="margin:0"><div id="root" style="max-width:800px;margin:40px auto"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from '/src/components/app/Composer.tsx';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {I18nProvider} from '/src/i18n/index.tsx'; import '/src/styles.css';
const h=React.createElement;
localStorage.setItem('pi-app:locale', new URLSearchParams(location.search).get('locale') || 'en');
window.sent=[]; window.modeCalls=[];
const markdown='# Reviewable plan\n\n1. Inspect the repository.\n2. Implement the change.\n3. Run verification.';
const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(markdown)))].map(n=>n.toString(16).padStart(2,'0')).join('');
window.reference={planId:'p1',revision:1,submissionEntryId:'s1',hash,planningTurnEntryId:'u1',submittedAt:2000};
window.approvals=[];window.exports=[];window.refines=0;
 window.rejectMode=false;
window.plan={seq:1,mode:'normal',planId:null,latest:null,approval:null,configuredSandboxMode:'workspace-write',effectiveSandboxMode:'workspace-write',shellEnforcement:'full',blockers:{switch:[],submit:[],approve:[]}};
window.pi={setSessionMode:async request=>{window.modeCalls.push(request); if(window.rejectMode)return {ok:false,code:'busy',blockers:['busy']}; return {ok:true,value:{...window.plan,seq:window.plan.seq+1,mode:request.mode,effectiveSandboxMode:request.mode==='plan'?'read-only':'workspace-write'}}},searchFiles:async()=>[],queueAction:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[],
readPlanDocument:async request=>({ok:true,value:{ref:window.reference,markdown}}),
approvePlan:async request=>{window.approvals.push(request);return {ok:false,code:'busy',blockers:['busy']}},
exportPlan:async request=>{window.exports.push(request);return {ok:true,value:{cancelled:true}}}};
window.store=new PiStore();
const submission={role:'toolResult',toolName:'submit_plan',toolCallId:'plan-call',timestamp:2000,isError:false,content:[{type:'text',text:markdown}],details:{kind:'pi-app-plan-submission',version:1,planId:'p1',revision:1,planningTurnEntryId:'u1',plan:markdown,hash},planSubmission:window.reference};
const full=[{role:'user',content:'Design this',timestamp:1000},{role:'assistant',timestamp:1500,stopReason:'toolUse',content:[{type:'thinking',thinking:'Investigating the implementation.'},{type:'toolCall',id:'plan-call',name:'submit_plan',arguments:{plan:markdown}}]},submission];
let sequence=0;
window.setTranscript=(kind='full')=>{window.store.applySnapshot({sessionPath:'/fixture.jsonl',sessionId:'fixture',cwd:'/tmp',projectless:false,model:null,thinkingLevel:'off',isStreaming:false,eventSequence:++sequence,plan:window.plan,messages:kind==='full'?full:[{role:'compactionSummary',summary:'Older investigation',tokensBefore:100,timestamp:3000},{role:'user',content:'Later conversation',timestamp:4000}]})};
const cards=new URLSearchParams(location.search).has('cards');
if(cards){window.plan={...window.plan,mode:'plan',effectiveSandboxMode:'read-only',planId:'p1',latest:window.reference};window.setTranscript()}
function App(){const [plan,setPlan]=React.useState(window.plan);const [busy,setBusy]=React.useState(false);window.setBusy=setBusy; window.setPlan=p=>{window.plan=p;setPlan(p);window.store.dispatch({type:'plan_state_update',sessionPath:'/fixture.jsonl',plan:p})};
return h(I18nProvider,null,h('div',{style:{display:'flex',flexDirection:'column',height:'780px'}},cards?h('div',{style:{display:'flex',flexDirection:'column',height:'570px'}},h(ChatView,{store:window.store,onRefinePlan:()=>{window.refines++;window.dispatchEvent(new CustomEvent('pith:refine-plan',{detail:{sessionPath:'/fixture.jsonl'}}))}})):null,h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy,plan,sessionPath:'/fixture.jsonl',onPlanState:(_path,p)=>window.setPlan(p),queued:{steering:[],followUp:[]},onSend:p=>window.sent.push(p),onQueue:p=>window.sent.push(p),onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}})))}
createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
let server, app
const errors = []
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temporary, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'plan-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__plan.html') return next()
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__plan.html', fixture))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__plan.html'
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{contextIsolation:false}});win.loadURL(${JSON.stringify(url)});});`)
  app = await _electron.launch({ executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))
  for (const locale of ['en', 'zh-CN']) {
    await page.goto(url + '?locale=' + locale)
    const textarea = page.locator('textarea')
    await textarea.waitFor()
    const mode = page.getByRole('combobox', { name: locale === 'en' ? 'Working mode' : '工作模式' })
    // Vendored Select's trigger uses a button rather than an ARIA combobox.
    const picker = page.locator('[data-session-mode] button').first()
    await picker.click()
    await page.getByRole('option', { name: locale === 'en' ? 'Plan' : '规划', exact: true }).click()
    await page.waitForFunction(() => window.plan.mode === 'plan')
    assert.equal(await textarea.isEnabled(), true)
    assert.equal(await page.locator('[data-sandbox-mode-icon="read-only"]').count(), 1)
    await textarea.fill('/plan')
    await textarea.press('Enter')
    await page.waitForFunction(() => window.plan.mode === 'normal')
    assert.equal(await page.evaluate(() => window.sent.length), 0)
    await page.evaluate(() => window.rejectMode = true)
    await textarea.fill('/plan'); await textarea.press('Enter')
    await page.getByRole('alert').waitFor()
    assert.equal(await textarea.inputValue(), '/plan')
    await page.evaluate(() => { window.rejectMode = false; window.setBusy(true) })
    await textarea.press('Enter')
    assert.equal(await page.evaluate(() => window.sent.length), 0)
    await page.evaluate(() => window.setBusy(false))
    await textarea.fill('/plan ordinary text'); await textarea.press('Enter')
    await page.waitForFunction(() => window.sent.length === 1)
    assert.equal(await page.evaluate(() => window.sent[0].text), '/plan ordinary text')
    for (const corners of ['square', 'squircle']) for (const dark of [false, true]) {
      await page.evaluate(({ corners, dark }) => { document.documentElement.dataset.corners = corners; document.documentElement.classList.toggle('dark', dark) }, { corners, dark })
      if (process.env.PI_PLAN_SCREENSHOT_DIR) {
        const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.PI_PLAN_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `${locale}-${corners}-${dark ? 'dark' : 'light'}.png`) })
      }
    }
  }
  await page.goto(url + '?locale=en&cards=1')
  const card = page.locator('[data-plan-card="s1"]')
  await card.getByText('Reviewable plan', { exact: true }).waitFor()
  assert.equal(await card.count(), 1)
  assert.equal(await card.isVisible(), true, 'a prose-free submission was hidden inside the process fold')
  await card.getByRole('button', { name: 'Revise plan' }).click()
  assert.equal(await page.evaluate(() => window.refines), 1)
  assert.equal(await page.locator('textarea').inputValue(), '')
  await card.getByRole('button', { name: 'Start execution' }).click()
  await card.getByRole('alert').waitFor()
  assert.equal(await page.evaluate(() => window.approvals.length), 1)
  await card.getByRole('button', { name: 'Export' }).click()
  assert.equal(await page.evaluate(() => window.exports.length), 1)
  await page.evaluate(() => window.setTranscript('compacted'))
  await card.getByText('Reviewable plan', { exact: true }).waitFor()
  assert.equal(await card.count(), 1, 'compaction recovery duplicated the card')
  await page.evaluate(() => window.setTranscript('full'))
  await card.getByText('Reviewable plan', { exact: true }).waitFor()
  assert.equal(await card.count(), 1, 'late original submission duplicated recovery')
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: 20, mode: 'normal', effectiveSandboxMode: 'workspace-write' }))
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-plan-card] button')].some(b => b.textContent.includes('Start execution')))
  if (process.env.PI_PLAN_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.PI_PLAN_SCREENSHOT_DIR,'plan-card.png')})
  assert.deepEqual(errors, [])
  console.log('PASS: Plan picker, read-only permissions, drafts, slash interception, locales, style/theme matrix and plan card/recovery actions')
} finally { await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }) }
