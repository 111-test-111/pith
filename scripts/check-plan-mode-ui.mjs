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
window.approvals=[];window.exports=[];window.refines=0;window.reviewOpens=[];
 window.rejectMode=false;window.rejectInit=false;
window.plan={seq:1,mode:'normal',planId:null,latest:null,approval:null,configuredSandboxMode:'workspace-write',effectiveSandboxMode:'workspace-write',shellEnforcement:'full',blockers:{switch:[],submit:[],approve:[]}};
window.pi={setSessionMode:async request=>{window.modeCalls.push(request); if(window.rejectMode)return {ok:false,code:'busy',blockers:['busy']}; if(window.rejectInit){window.rejectInit=false;return {ok:false,code:'initializing',blockers:['initializing']}}; return {ok:true,value:{...window.plan,seq:window.plan.seq+1,mode:request.mode,effectiveSandboxMode:request.mode==='plan'?'read-only':'workspace-write'}}},searchFiles:async()=>[],queueAction:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[],
readPlanDocument:async request=>({ok:true,value:{ref:window.reference,markdown}}),
approvePlan:async request=>{window.approvals.push(request);return {ok:false,code:'busy',blockers:['busy']}},
exportPlan:async request=>{window.exports.push(request);return {ok:true,value:{cancelled:true}}}};
window.store=new PiStore();
const submission={role:'toolResult',toolName:'submit_plan',toolCallId:'plan-call',timestamp:2000,isError:false,content:[{type:'text',text:markdown}],details:{kind:'pi-app-plan-submission',version:1,planId:'p1',revision:1,planningTurnEntryId:'u1',plan:markdown,hash},planSubmission:window.reference};
const full=[{role:'user',content:'Design this',timestamp:1000},{role:'assistant',timestamp:1500,stopReason:'toolUse',content:[{type:'thinking',thinking:'Investigating the implementation.'},{type:'toolCall',id:'plan-call',name:'submit_plan',arguments:{plan:markdown}}]},submission];
// The approval writes this exact prompt as a user message; the transcript hides
// it while the approval is the started one. Its turn rewrote a file, so the
// card can offer that turn to the review pane.
const approvalPrompt='The user has explicitly approved the following plan. Implement it in this conversation and verify the result. Ask the user about substantive changes required by new evidence. Use the existing file permissions.\n\n'+markdown;
const execution=[{role:'user',content:approvalPrompt,timestamp:2500,sessionEntryId:'exec-entry'},{role:'assistant',timestamp:2600,stopReason:'toolUse',content:[{type:'toolCall',id:'write-call',name:'write',arguments:{path:'/tmp/approved.txt',content:'approved\n'}}]},{role:'toolResult',toolName:'write',toolCallId:'write-call',timestamp:2610,isError:false,content:[{type:'text',text:'ok'}],details:{}},{role:'assistant',timestamp:2700,stopReason:'stop',content:[{type:'text',text:'Implemented the plan.'}]}];
let sequence=0, currentPath='/fixture.jsonl';
window.switchSession=path=>{currentPath=path;window.setTranscript()};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text}},configurable:true});
window.setTranscript=(kind='full')=>{window.store.applySnapshot({sessionPath:currentPath,sessionId:'fixture',cwd:'/tmp',projectless:false,model:null,thinkingLevel:'off',isStreaming:false,eventSequence:++sequence,plan:window.plan,messages:kind==='executed'?[...full,...execution]:kind==='full'?full:[{role:'compactionSummary',summary:'Older investigation',tokensBefore:100,timestamp:3000},{role:'user',content:'Later conversation',timestamp:4000}]})};
const cards=new URLSearchParams(location.search).has('cards');
if(cards){window.plan={...window.plan,mode:'plan',effectiveSandboxMode:'read-only',planId:'p1',latest:window.reference};window.setTranscript()}
if(cards&&new URLSearchParams(location.search).has('executed')){window.plan={...window.plan,seq:window.plan.seq+1,mode:'normal',effectiveSandboxMode:'workspace-write',planId:'p1',latest:window.reference,approval:{approvalId:'ap1',ref:window.reference,status:'started',executionEntryId:'exec-entry'},executionTurnId:2600};window.setTranscript('executed')}
function App(){const [plan,setPlan]=React.useState(window.plan);const [busy,setBusy]=React.useState(false);const [init,setInit]=React.useState(false);window.setBusy=setBusy;window.setInit=setInit; window.setPlan=p=>{window.plan=p;setPlan(p);window.store.dispatch({type:'plan_state_update',sessionPath:'/fixture.jsonl',plan:p})};
return h(I18nProvider,null,h('div',{style:{display:'flex',flexDirection:'column',justifyContent:'flex-end',height:'780px'}},cards?h('div',{style:{display:'flex',flexDirection:'column',height:'570px'}},h(ChatView,{store:window.store,onReview:id=>{window.reviewOpens.push(id)},onRefinePlan:()=>{window.refines++;window.dispatchEvent(new CustomEvent('pith:refine-plan',{detail:{sessionPath:'/fixture.jsonl'}}))}})):null,h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy,initializing:init,plan,sessionPath:'/fixture.jsonl',onPlanState:(_path,p)=>window.setPlan(p),queued:{steering:[],followUp:[]},onSend:p=>window.sent.push(p),onQueue:p=>window.sent.push(p),onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}})))}
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
    // The plan mode entry lives in the '+' panel: click to enable, click the
    // item again to disable.
    const addButton = page.getByRole('button', { name: 'Add to prompt' })
    await addButton.click()
    await page.getByRole('button', { name: locale === 'en' ? 'Plan mode' : '规划模式' }).click()
    await page.waitForFunction(() => window.plan.mode === 'plan')
    assert.equal(await textarea.isEnabled(), true)
    // Enabling hides the sandbox picker; the plan chip takes its spot.
    assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 0)
    const chip = page.locator('[data-plan-chip]')
    await chip.getByText(locale === 'en' ? 'Plan' : '规划', { exact: true }).waitFor()
    // Hovering reveals the exit mark, which floats on the chip: its width
    // must not change.
    const chipBox = await chip.boundingBox()
    assert(chipBox)
    await chip.hover()
    assert.equal((await chip.boundingBox()).width, chipBox.width, 'hovering must not change the chip width')
    await chip.getByRole('button', { name: locale === 'en' ? 'Exit plan mode' : '退出规划模式' }).click()
    await page.waitForFunction(() => window.plan.mode === 'normal')
    assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
    await textarea.fill('/plan')
    await textarea.press('Enter')
    await page.waitForFunction(() => window.plan.mode === 'plan')
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
  // Option B: a mode chosen mid-initialization queues — the chip shows
  // immediately, no IPC — and applies when the session reports initialized;
  // a failed flush reverts the optimistic UI and surfaces the reason.
  await page.goto(url + '?locale=en')
  await page.locator('textarea').waitFor()
  await page.evaluate(() => window.setInit(true))
  const add = page.getByRole('button', { name: 'Add to prompt' })
  await add.click()
  await page.getByRole('button', { name: 'Plan mode' }).click()
  assert.equal(await page.evaluate(() => window.modeCalls.length), 0, 'queued intent must not hit IPC during initialization')
  assert.equal(await page.locator('[data-plan-chip]').count(), 1, 'queued intent shows the plan chip immediately')
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 0)
  // The send path waits for the queued intent: Enter must not fire a prompt
  // that would race the flush IPC into a 'busy' refusal.
  const input = page.locator('textarea')
  await input.fill('queued draft')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.sent.length), 0, 'a queued mode intent gates the first send')
  assert.equal(await input.inputValue(), 'queued draft')
  await page.evaluate(() => window.setInit(false))
  await page.waitForFunction(() => window.modeCalls.length === 1 && window.plan.mode === 'plan')
  // The flush has applied plan mode; the preserved draft now sends under it.
  await input.press('Enter')
  await page.waitForFunction(() => window.sent.length === 1)
  // Queued exit: the picker restores immediately; the flush leaves plan mode
  // when initialization ends.
  await page.evaluate(() => window.setInit(true))
  const queuedChip = page.locator('[data-plan-chip]')
  await queuedChip.hover()
  await queuedChip.getByRole('button', { name: 'Exit plan mode' }).click()
  assert.equal(await page.evaluate(() => window.modeCalls.length), 1)
  assert.equal(await page.locator('[data-plan-chip]').count(), 0, 'queued exit restores the picker immediately')
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
  await page.evaluate(() => window.setInit(false))
  await page.waitForFunction(() => window.modeCalls.length === 2 && window.plan.mode === 'normal')
  // A failed flush reverts: the picker returns and the reason is shown.
  await page.evaluate(() => window.setInit(true))
  await add.click()
  await page.getByRole('button', { name: 'Plan mode' }).click()
  await page.evaluate(() => { window.rejectMode = true; window.setInit(false) })
  await page.getByRole('alert').waitFor()
  assert.equal(await page.locator('[data-plan-chip]').count(), 0)
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
  await page.evaluate(() => { window.rejectMode = false })
  // The stale-DTO race: the shell flag has cleared but the plan state still
  // carries the initializing blocker — the click queues instead of erroring.
  const base = await page.evaluate(() => window.modeCalls.length)
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, blockers: { ...window.plan.blockers, switch: ['initializing'] } }))
  await add.click()
  await page.getByRole('button', { name: 'Plan mode' }).click()
  assert.equal(await page.evaluate(() => window.modeCalls.length), base, 'stale initializing blocker must queue, not error')
  assert.equal(await page.locator('[data-plan-chip]').count(), 1)
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, blockers: { ...window.plan.blockers, switch: [] } }))
  await page.waitForFunction((mc) => window.modeCalls.length === mc + 1 && window.plan.mode === 'plan', base)
  // An IPC refusal with code 'initializing' (the renderer never saw the
  // state) queues as well, and the flush retries once main admits.
  const base2 = await page.evaluate(() => window.modeCalls.length)
  await page.evaluate(() => { window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'normal', effectiveSandboxMode: 'workspace-write' }); window.rejectInit = true })
  await add.click()
  await page.getByRole('button', { name: 'Plan mode' }).click()
  await page.waitForFunction((mc) => window.modeCalls.length === mc + 2 && window.plan.mode === 'plan', base2)
  assert.equal(await page.locator('[data-plan-chip]').count(), 1)
  assert.equal(await page.getByRole('alert').count(), 0, 'initializing refusal queues instead of erroring')
  for (const locale of ['en', 'zh-CN']) {
    await page.goto(url + '?locale=' + locale + '&cards=1')
    const card = page.locator('[data-plan-card="s1"]')
    await card.getByText('Reviewable plan', { exact: true }).waitFor()
    for (const corners of ['square', 'squircle']) for (const dark of [false, true]) {
      await page.evaluate(({ corners, dark }) => { document.documentElement.dataset.corners = corners; document.documentElement.classList.toggle('dark', dark) }, { corners, dark })
      // Let the real theme transition finish before retaining visual evidence.
      await page.waitForTimeout(250)
      const bounds = await card.boundingBox()
      assert(bounds && bounds.width > 600 && bounds.height > 150)
      assert.equal(await card.getByRole('button', { name: locale === 'en' ? 'Start execution' : '开始执行', exact: true }).isEnabled(), true)
      if (process.env.PI_PLAN_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `card-${locale}-${corners}-${dark ? 'dark' : 'light'}.png`) })
    }
  }
  // Approved and executing: the card offers the execution turn's changes, the
  // synthetic approval prompt is neither a message row nor a rail target, and
  // the action strip stays thin under a taller plan body.
  for (const locale of ['en', 'zh-CN']) {
    await page.goto(url + '?locale=' + locale + '&cards=1&executed=1')
    const executedCard = page.locator('[data-plan-card="s1"]')
    await executedCard.getByText('Reviewable plan', { exact: true }).waitFor()
    assert.equal(await page.getByText('The user has explicitly approved the following plan.').count(), 0, 'the approval opening must not render as a user message')
    assert.equal(await page.locator('[data-rail-id]').count(), 1, 'only the real user prompt keeps a transcript row')
    await executedCard.getByRole('button', { name: locale === 'en' ? 'Review changes' : '查看改动' }).click()
    assert.deepEqual(await page.evaluate(() => window.reviewOpens), [2600], 'Review changes must open the plan execution turn')
    const actions = await page.locator('[data-plan-actions]').boundingBox()
    assert(actions && actions.height <= 30, `the plan footer must stay a thin strip (got ${actions?.height})`)
    assert.equal(await page.evaluate(() => { const body = document.querySelector('[data-plan-card="s1"] [data-fade-scroll]'); return body ? getComputedStyle(body).maxHeight : null }), '448px', 'the plan body keeps the taller cap')
    if (process.env.PI_PLAN_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `card-executed-${locale}.png`) })
  }
  await page.goto(url + '?locale=en&cards=1')
  const card = page.locator('[data-plan-card="s1"]')
  await card.getByText('Reviewable plan', { exact: true }).waitFor()
  assert.equal(await card.count(), 1)
  assert.equal(await card.isVisible(), true, 'a prose-free submission was hidden inside the process fold')
  await card.getByRole('button', { name: 'Copy', exact: true }).click()
  await page.waitForFunction(() => window.copiedText?.includes('1. Inspect the repository.'))
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: 10, blockers: { ...window.plan.blockers, approve: ['deliveries'] } }))
  assert.equal(await card.getByRole('button', { name: 'Start execution' }).isEnabled(), false)
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: 11, blockers: { ...window.plan.blockers, approve: [] } }))
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
  // A late failure from the prior session may not replace the current document.
  await page.evaluate(() => {
    const read = window.pi.readPlanDocument;
    window.pi.readPlanDocument = request => request.sessionPath === '/slow.jsonl'
      ? new Promise(resolve => { window.finishSlow = resolve }) : read(request);
    window.switchSession('/slow.jsonl');
  })
  await page.waitForFunction(() => !!window.finishSlow)
  await page.evaluate(() => window.switchSession('/fast.jsonl'))
  await card.getByText('Reviewable plan', { exact: true }).waitFor()
  await page.evaluate(() => window.finishSlow({ ok: false, code: 'storage', blockers: ['storage'] }))
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await card.getByRole('alert').count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: Plan picker, read-only permissions, drafts, slash interception, locales, style/theme matrix and plan card/recovery actions')
} finally { await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }) }
await (await import('./lib/check-plan-ipc.mjs')).checkPlanIpc()
