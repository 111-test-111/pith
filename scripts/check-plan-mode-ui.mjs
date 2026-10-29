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
import { checkPromptEditor } from './lib/check-prompt-editor.mjs'
const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-plan-ui-'))
const fixture = String.raw`<!doctype html><html><body style="margin:0"><div id="root" style="max-width:800px;margin:40px auto"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from '/src/components/app/Composer.tsx';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {setCompactTools} from '/src/lib/compact-tools.ts';
import {setReduceMotion} from '/src/lib/reduce-motion.ts';
window.setDensity=setCompactTools;window.setInstant=setReduceMotion;
import {I18nProvider} from '/src/i18n/index.tsx'; import '/src/styles.css';
const h=React.createElement;
localStorage.setItem('pi-app:locale', new URLSearchParams(location.search).get('locale') || 'en');
window.sent=[]; window.modeCalls=[];
const markdown='# Reviewable plan\n\n1. Inspect the repository.\n2. Implement the change.\n3. Run verification.';
const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(markdown)))].map(n=>n.toString(16).padStart(2,'0')).join('');
window.reference={planId:'p1',revision:1,submissionEntryId:'s1',hash,planningTurnEntryId:'u1',submittedAt:2000};
window.approvals=[];window.exports=[];window.refines=0;window.reviewOpens=[];
 window.rejectMode=false;window.rejectInit=false;window.holdMode=false;
window.plan={seq:1,mode:'normal',planId:null,latest:null,revisionPending:false,approval:null,configuredSandboxMode:'workspace-write',effectiveSandboxMode:'workspace-write',shellEnforcement:'full',blockers:{switch:[],submit:[],approve:[]}};
window.pi={setSessionMode:async request=>{window.modeCalls.push(request); if(window.holdMode)await new Promise(resolve=>window.releaseMode=resolve); if(window.rejectMode)return {ok:false,code:'busy',blockers:['busy']}; if(window.rejectInit){window.rejectInit=false;return {ok:false,code:'initializing',blockers:['initializing']}}; return {ok:true,value:{...window.plan,seq:window.plan.seq+1,mode:request.mode,effectiveSandboxMode:request.mode==='plan'?'read-only':'workspace-write'}}},searchFiles:async()=>[],queueAction:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[],
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
window.setTranscript=(kind='full')=>{window.store.applySnapshot({sessionPath:currentPath,sessionId:'fixture',cwd:'/tmp',projectless:false,model:null,thinkingLevel:'off',isStreaming:false,eventSequence:++sequence,sandboxMode:window.plan.effectiveSandboxMode,plan:window.plan,messages:kind==='executed'?[...full,...execution]:kind==='full'?full:[{role:'compactionSummary',summary:'Older investigation',tokensBefore:100,timestamp:3000},{role:'user',content:'Later conversation',timestamp:4000}]})};
const cards=new URLSearchParams(location.search).has('cards');
if(cards){window.plan={...window.plan,mode:'plan',effectiveSandboxMode:'read-only',planId:'p1',latest:window.reference};window.setTranscript()}
if(cards&&new URLSearchParams(location.search).has('executed')){window.plan={...window.plan,seq:window.plan.seq+1,mode:'normal',effectiveSandboxMode:'workspace-write',planId:'p1',latest:window.reference,approval:{approvalId:'ap1',ref:window.reference,status:'started',executionEntryId:'exec-entry'},executionTurnId:2600};window.setTranscript('executed')}
function App(){
const [appendDraft,setAppendDraft]=React.useState(null);window.setAppendDraft=setAppendDraft;
const [readOnly,setReadOnly]=React.useState(false);window.setReadOnly=setReadOnly;const [plan,setPlan]=React.useState(window.plan);const [busy,setBusy]=React.useState(false);const [init,setInit]=React.useState(false);window.setBusy=setBusy;window.setInit=setInit; window.setPlan=p=>{window.plan=p;setPlan(p);window.store.dispatch({type:'plan_state_update',sessionPath:'/fixture.jsonl',plan:p})};
return h(I18nProvider,null,h('div',{style:{display:'flex',flexDirection:'column',justifyContent:'flex-end',height:'780px'}},cards?h('div',{style:{display:'flex',flexDirection:'column',height:'570px'}},h(ChatView,{store:window.store,onResend:()=>{},onFork:()=>{},onReview:id=>{window.reviewOpens.push(id)},onRefinePlan:()=>{window.refines++;window.dispatchEvent(new CustomEvent('pith:refine-plan',{detail:{sessionPath:'/fixture.jsonl'}}))}})):null,h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy,initializing:init,plan,sessionPath:'/fixture.jsonl',onPlanState:(_path,p)=>window.setPlan(p),appendDraft,readOnly,queued:{steering:[],followUp:[]},onSend:p=>window.sent.push(p),onQueue:p=>window.sent.push(p),onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}})))}
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
  // Native-caret pixel checks need renderer focus even in the hidden window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.focus())
  page.on('pageerror', error => errors.push(String(error)))
  for (const locale of ['en', 'zh-CN']) {
    await page.goto(url + '?locale=' + locale)
    const editor = page.locator('[data-prompt-editor]')
    await editor.waitFor()
    // The plus menu enters Plan Mode; only the active mode has a bottom control.
    const planAction = page.locator('[data-plan-mode-control]')
    const enterPlan = async () => {
      await page.getByRole('button', { name: 'Add to prompt' }).click()
      await page.getByRole('button', { name: locale === 'en' ? 'Plan mode' : '计划模式', exact: true }).click()
    }
    const draftFocused = () => editor.evaluate(node => document.activeElement === node)
    await page.evaluate(() => window.holdMode = true)
    await editor.focus()
    assert.equal(await planAction.count(), 0, 'normal mode has no bottom Plan control')
    await enterPlan()
    await planAction.waitFor()
    assert.equal(await planAction.getAttribute('aria-pressed'), 'true', 'the click paints the mode before IPC resolves')
    assert.equal(await page.evaluate(() => window.plan.mode), 'normal', 'the durable mode is still awaiting confirmation')
    assert.equal(await draftFocused(), true, 'the optimistic control preserves input focus')
    await page.keyboard.insertText('waiting draft')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.sent.length), 0, 'optimistic appearance must not allow sending before the mode applies')
    assert.equal(await editor.textContent(), 'waiting draft')
    await editor.fill('')
    await page.evaluate(() => { window.holdMode = false; window.releaseMode() })
    await page.waitForFunction(() => window.plan.mode === 'plan')
    assert.equal(await editor.isEnabled(), true)
    assert.equal(await draftFocused(), true, 'choosing plan mode restores the empty draft focus')
    // Use page-level typing: locator.press/fill would focus the editor for us
    // and hide this regression. Preserve both a caret and a selected range.
    await page.keyboard.insertText('draft')
    await page.keyboard.press('ArrowLeft')
    await planAction.click()
    assert.equal(await planAction.count(), 0, 'the bottom control disappears on exit')
    await page.waitForFunction(() => window.plan.mode === 'normal')
    assert.equal(await draftFocused(), true, 'leaving plan mode returns focus to the draft too')
    await page.keyboard.insertText('!')
    assert.equal(await editor.textContent(), 'draf!t', 'the original caret position survives the mode toggle')
    await page.keyboard.press('Shift+ArrowLeft')
    await enterPlan()
    await page.waitForFunction(() => window.plan.mode === 'plan')
    assert.equal(await draftFocused(), true)
    assert.equal(await page.evaluate(() => getSelection().toString()), '!', 'the selected draft range survives the mode toggle')
    await page.keyboard.insertText('X')
    assert.equal(await editor.textContent(), 'drafXt')
    await editor.fill('')
    // Enabling plan keeps the sandbox picker visible and disabled, while the
    // active indicator stays in the bottom row outside the draft scrollport.
    const picker = page.locator('button:has([data-sandbox-mode-icon])')
    assert.equal(await picker.count(), 1)
    assert.equal(await picker.isDisabled(), true, 'the picker is read-only under a plan')
    // A snapshot landing mid-plan carries the EFFECTIVE read-only overlay in
    // its sandboxMode (production semantics); the picker must still show the
    // session's stored mode, read from the plan DTO.
    await page.evaluate(() => window.setTranscript())
    assert.equal(await page.locator('[data-sandbox-mode-icon]').getAttribute('data-sandbox-mode-icon'), 'workspace-write', 'a mid-plan snapshot must not repaint the picker with the read-only overlay')
    await planAction.getByText(locale === 'en' ? 'Plan' : '计划', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-plan-chip], [data-prompt-prefix]').count(), 0, 'the plan mode no longer occupies the editable line')
    const position = await planAction.evaluate(node => {
      const control = node.getBoundingClientRect()
      const viewport = document.querySelector('[data-prompt-viewport]').getBoundingClientRect()
      const frame = node.closest('form').getBoundingClientRect()
      const model = node.previousElementSibling?.querySelector('button')?.getBoundingClientRect()
      return { control: control.toJSON(), viewport: viewport.toJSON(), frame: frame.toJSON(), model: model?.toJSON(), icons: [...node.querySelectorAll('svg')].map(icon => icon.getAttribute('data-app-icon')) }
    })
    assert(position.control.top >= position.viewport.bottom, 'the plan control sits below the editable area')
    assert(position.control.bottom <= position.frame.bottom, 'the plan control stays inside the composer frame')
    assert(position.model && position.control.left >= position.model.right, 'the active Plan control follows the model picker')
    assert.deepEqual(position.icons, ['NotebookPen', 'X'], 'the active Plan control carries the plan and close glyphs')
    await planAction.hover()
    await page.waitForFunction(() => {
      const icons = document.querySelectorAll('[data-plan-mode-control] svg')
      return icons.length === 2 && getComputedStyle(icons[0]).opacity === '0' && getComputedStyle(icons[1]).opacity === '1'
    })
    await page.mouse.move(0, 0)
    await page.waitForFunction(() => {
      const icons = document.querySelectorAll('[data-plan-mode-control] svg')
      return icons.length === 2 && getComputedStyle(icons[0]).opacity === '1' && getComputedStyle(icons[1]).opacity === '0'
    })
    await checkPromptEditor(page, locale)
    for (const corners of ['square', 'squircle']) for (const dark of [false, true]) for (const compact of [false, true]) {
      await page.evaluate(({ corners, dark, compact }) => {
        document.documentElement.dataset.corners = corners;
        document.documentElement.classList.toggle('dark', dark);
        window.setDensity(compact);window.setInstant(true)
      }, { corners, dark, compact })
      const visible = await planAction.evaluate(node => {
        const button = node.getBoundingClientRect()
        const frame = node.closest('form').getBoundingClientRect()
        return {
          inside: button.left >= frame.left && button.right <= frame.right && button.top >= frame.top && button.bottom <= frame.bottom,
          hit: node.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2))
        }
      })
      assert.equal(visible.inside, true, 'the bottom control stays inside the composer')
      assert.equal(visible.hit, true, 'the bottom control remains reachable')
      if (process.env.PI_PLAN_SCREENSHOT_DIR) await page.locator('form:has([data-prompt-editor])').screenshot({ path: join(process.env.PI_PLAN_SCREENSHOT_DIR, `plan-control-${locale}-${corners}-${dark ? 'dark' : 'light'}.png`) })
    }
    await page.evaluate(() => { document.documentElement.dataset.corners = 'square'; document.documentElement.classList.remove('dark'); window.holdMode = true })
    await planAction.click()
    assert.equal(await planAction.count(), 0, 'exiting plan mode removes the control before IPC resolves')
    assert.equal(await page.evaluate(() => window.plan.mode), 'plan')
    await page.evaluate(() => { window.holdMode = false; window.releaseMode() })
    await page.waitForFunction(() => window.plan.mode === 'normal')
    assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
    assert.equal(await picker.isDisabled(), false, 'leaving plan re-enables the picker')
    assert.equal(await page.locator('[data-sandbox-mode-icon]').getAttribute('data-sandbox-mode-icon'), 'workspace-write', 'leaving plan restores the stored mode without waiting for a snapshot')
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-prompt-editor]')).textIndent), '0px', 'leaving plan restores the draft to the field edge')
    await editor.fill('/plan')
    await editor.press('Enter')
    await page.waitForFunction(() => window.plan.mode === 'plan')
    await editor.fill('/plan')
    await editor.press('Enter')
    await page.waitForFunction(() => window.plan.mode === 'normal')
    assert.equal(await page.evaluate(() => window.sent.length), 0)
    await page.evaluate(() => { window.rejectMode = true; window.holdMode = true })
    await editor.fill('/plan'); await editor.press('Enter')
    assert.equal(await planAction.getAttribute('aria-pressed'), 'true', 'a pending slash toggle uses the same immediate appearance')
    await page.evaluate(() => { window.holdMode = false; window.releaseMode() })
    await page.getByRole('alert').waitFor()
    assert.equal(await planAction.count(), 0, 'a refused mode change restores the confirmed mode')
    assert.equal(await editor.textContent(), '/plan')
    await page.evaluate(() => { window.rejectMode = false; window.setBusy(true) })
    await editor.press('Enter')
    assert.equal(await page.evaluate(() => window.sent.length), 0)
    await page.evaluate(() => window.setBusy(false))
    await editor.fill('/plan ordinary text'); await editor.press('Enter')
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
  // Option B: a mode chosen mid-initialization queues — the control shows
  // immediately, no IPC — and applies when the session reports initialized;
  // a failed flush reverts the optimistic UI and surfaces the reason.
  await page.goto(url + '?locale=en')
  await page.locator('[data-prompt-editor]').waitFor()
  await page.evaluate(() => window.setInit(true))
  const queuedControl = page.locator('[data-plan-mode-control]')
  const enterQueuedPlan = async () => {
    await page.getByRole('button', { name: 'Add to prompt' }).click()
    await page.getByRole('button', { name: 'Plan mode', exact: true }).click()
  }
  await enterQueuedPlan()
  assert.equal(await page.locator('[data-prompt-editor]').evaluate(node => document.activeElement === node), true, 'a queued mode intent restores draft focus before initialization finishes')
  assert.equal(await page.evaluate(() => window.modeCalls.length), 0, 'queued intent must not hit IPC during initialization')
  assert.equal(await queuedControl.getAttribute('aria-pressed'), 'true', 'queued intent shows the plan mode immediately')
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1, 'the picker stays visible (disabled) for a queued intent')
  // The send path waits for the queued intent: Enter must not fire a prompt
  // that would race the flush IPC into a 'busy' refusal.
  const input = page.locator('[data-prompt-editor]')
  await input.fill('queued draft')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.sent.length), 0, 'a queued mode intent gates the first send')
  assert.equal(await input.textContent(), 'queued draft')
  await page.evaluate(() => { window.holdMode = true; window.setInit(false) })
  await page.waitForFunction(() => window.modeCalls.length === 1)
  assert.equal(await queuedControl.getAttribute('aria-pressed'), 'true', 'the queued control stays active while its flush awaits IPC')
  assert.equal(await page.evaluate(() => window.plan.mode), 'normal')
  await input.press('Enter')
  assert.equal(await page.evaluate(() => window.sent.length), 0, 'flushing the intent keeps sending gated')
  await page.evaluate(() => { window.holdMode = false; window.releaseMode() })
  await page.waitForFunction(() => window.modeCalls.length === 1 && window.plan.mode === 'plan')
  // The flush has applied plan mode; the preserved draft now sends under it.
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled)
  await input.press('Enter')
  await page.waitForFunction(() => window.sent.length === 1)
  // Queued exit: the control changes immediately while the flush leaves plan mode
  // when initialization ends; the picker never moved.
  await page.evaluate(() => window.setInit(true))
  await queuedControl.click()
  assert.equal(await page.evaluate(() => window.modeCalls.length), 1)
  assert.equal(await queuedControl.count(), 0, 'queued exit removes the active control immediately')
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
  await page.evaluate(() => window.setInit(false))
  await page.waitForFunction(() => window.modeCalls.length === 2 && window.plan.mode === 'normal')
  // A failed flush reverts the control and shows the reason.
  await page.evaluate(() => window.setInit(true))
  await enterQueuedPlan()
  await page.evaluate(() => { window.rejectMode = true; window.setInit(false) })
  await page.getByRole('alert').waitFor()
  assert.equal(await queuedControl.count(), 0)
  assert.equal(await page.locator('[data-sandbox-mode-icon]').count(), 1)
  await page.evaluate(() => { window.rejectMode = false })
  // The stale-DTO race: the shell flag has cleared but the plan state still
  // carries the initializing blocker — the click queues instead of erroring.
  const base = await page.evaluate(() => window.modeCalls.length)
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, blockers: { ...window.plan.blockers, switch: ['initializing'] } }))
  await enterQueuedPlan()
  assert.equal(await page.evaluate(() => window.modeCalls.length), base, 'stale initializing blocker must queue, not error')
  assert.equal(await queuedControl.getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: window.plan.seq + 1, blockers: { ...window.plan.blockers, switch: [] } }))
  await page.waitForFunction((mc) => window.modeCalls.length === mc + 1 && window.plan.mode === 'plan', base)
  // An IPC refusal with code 'initializing' (the renderer never saw the
  // state) queues as well, and the flush retries once main admits.
  const base2 = await page.evaluate(() => window.modeCalls.length)
  await page.evaluate(() => { window.setPlan({ ...window.plan, seq: window.plan.seq + 1, mode: 'normal', effectiveSandboxMode: 'workspace-write' }); window.rejectInit = true })
  await enterQueuedPlan()
  await page.waitForFunction((mc) => window.modeCalls.length === mc + 2 && window.plan.mode === 'plan', base2)
  assert.equal(await queuedControl.getAttribute('aria-pressed'), 'true')
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
      const spacing = () => card.evaluate(node => {
        const ending=node.nextElementSibling;
        return {top:node.getBoundingClientRect().top-node.previousElementSibling.getBoundingClientRect().bottom,
          bottom:ending.querySelector('button').getBoundingClientRect().top-node.getBoundingClientRect().bottom,
          glyph:ending.querySelector('button svg').getBoundingClientRect().top-node.getBoundingClientRect().bottom}
      })
      assert.deepEqual(await spacing(), {top:24,bottom:12,glyph:19}, 'plan boundaries match normal text, including visible button glyphs')
      const fold=page.locator('[data-transcript-gap-after="divider"] [data-agent-trigger]').first()
      await fold.click()
      assert.deepEqual(await spacing(), {top:24,bottom:12,glyph:19}, 'expanded process preserves the same boundaries')
      await fold.click()
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
    assert.equal(await page.evaluate(() => { const body = document.querySelector('[data-plan-card="s1"] [data-fade-scroll]'); return body ? getComputedStyle(body).maxHeight : null }), '464px', 'the plan body keeps the taller cap (28rem + the 16px the thinner footer gave back)')
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
  assert.equal(await page.locator('[data-prompt-editor]').textContent(), '')
  await card.getByRole('button', { name: 'Start execution' }).click()
  await card.getByRole('alert').waitFor()
  assert.equal(await page.evaluate(() => window.approvals.length), 1)
  await page.locator('[data-prompt-editor]').fill('Change the order of the steps')
  await page.locator('[data-prompt-editor]').press('Enter')
  assert.equal(await page.evaluate(() => window.sent.at(-1)?.text), 'Change the order of the steps')
  await page.evaluate(() => window.setPlan({ ...window.plan, seq: 12, revisionPending: true,
    blockers: { ...window.plan.blockers, approve: ['stale-submission'] } }))
  await card.getByText('Awaiting revised plan', { exact: true }).waitFor()
  assert.equal(await card.getByRole('button', { name: 'Start execution' }).count(), 0, 'an older plan offers no execution action after revision feedback')
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
  console.log('PASS: plus-menu Plan entry, bottom active control, read-only permissions, drafts, slash interception, locales, style/theme matrix and plan card/recovery actions')
} finally { await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }) }
await (await import('./lib/check-plan-ipc.mjs')).checkPlanIpc()
