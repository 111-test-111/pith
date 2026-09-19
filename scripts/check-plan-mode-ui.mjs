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
const fixture = `<!doctype html><html><body style="margin:0"><div id="root" style="max-width:800px;margin:40px auto"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from '/src/components/app/Composer.tsx';
import {I18nProvider} from '/src/i18n/index.tsx'; import '/src/styles.css';
const h=React.createElement;
localStorage.setItem('pi-app:locale', new URLSearchParams(location.search).get('locale') || 'en');
window.sent=[]; window.modeCalls=[]; window.rejectMode=false;
window.plan={seq:1,mode:'normal',planId:null,latest:null,approval:null,configuredSandboxMode:'workspace-write',effectiveSandboxMode:'workspace-write',shellEnforcement:'full',blockers:{switch:[],submit:[],approve:[]}};
window.pi={setSessionMode:async request=>{window.modeCalls.push(request); if(window.rejectMode)return {ok:false,code:'busy',blockers:['busy']}; return {ok:true,value:{...window.plan,seq:window.plan.seq+1,mode:request.mode,effectiveSandboxMode:request.mode==='plan'?'read-only':'workspace-write'}}},searchFiles:async()=>[],queueAction:async()=>{}};
function App(){const [plan,setPlan]=React.useState(window.plan);const [busy,setBusy]=React.useState(false);window.setBusy=setBusy; window.setPlan=p=>{window.plan=p;setPlan(p)};
return h(I18nProvider,null,h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy,plan,sessionPath:'/fixture.jsonl',onPlanState:(_path,p)=>window.setPlan(p),queued:{steering:[],followUp:[]},onSend:p=>window.sent.push(p),onQueue:p=>window.sent.push(p),onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}}))}
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
  assert.deepEqual(errors, [])
  console.log('PASS: Plan picker, read-only permissions, drafts, slash interception, locales and style/theme matrix')
} finally { await app?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }) }
