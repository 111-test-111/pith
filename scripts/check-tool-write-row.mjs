/**
 * Real Chromium regression check for the `write` transcript row.
 * Run: node scripts/check-tool-write-row.mjs
 *
 * The row's diff is SYNTHESIZED from the call's `arguments.content` (pi's
 * `write` returns no `details`), so it is the call's intent, not an outcome.
 * This check pins the four states apart from each other:
 *
 *   denied write    -> error row, the denial text, never a diff or a "+n" count
 *   applied write   -> diff row with its counts and the "applied" glyph
 *   running write   -> plain "Writing file…" row, no diff (content is not a file
 *                      until the result says so)
 *   denied edit     -> error row (the control: `edit` reads its diff only from
 *                      `details.patch`, which a denial does not carry)
 *
 * Uses an isolated Electron profile, a fake tool call per case and no SDK, real
 * sessions, model calls or test framework. Requires a graphical session.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pi-write-row-'))
const fixturePath = '/__tool_write_row_check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';
const CONTENT = 'const value = 1;';
window.__errors = [];
window.addEventListener('error', event => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', event => window.__errors.push(String(event.reason)));
const DENIAL = '[sandbox: file access denied under read-only mode]\\nsandbox denied this file mutation under "read-only": /fixture\\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]';
const now = Date.now();
const cases = [
  {id:'denied-write', tool:'write',
   call:{type:'toolCall',id:'w-denied',name:'write',arguments:{path:'src/denied.ts',content:CONTENT}},
   result:{role:'toolResult',toolCallId:'w-denied',toolName:'write',content:[{type:'text',text:DENIAL}],details:{},isError:true,timestamp:now},
   run:{toolCallId:'w-denied',toolName:'write',args:{},status:'error',partial:undefined,startedAt:now-40,endedAt:now}},
  {id:'applied-write', tool:'write',
   call:{type:'toolCall',id:'w-applied',name:'write',arguments:{path:'src/applied.ts',content:CONTENT}},
   result:{role:'toolResult',toolCallId:'w-applied',toolName:'write',content:[{type:'text',text:''}],details:{},isError:false,timestamp:now},
   run:{toolCallId:'w-applied',toolName:'write',args:{},status:'success',partial:undefined,startedAt:now-40,endedAt:now}},
  {id:'running-write', tool:'write',
   call:{type:'toolCall',id:'w-running',name:'write',arguments:{path:'src/running.ts',content:CONTENT}},
   run:{toolCallId:'w-running',toolName:'write',args:{},status:'running',partial:undefined,startedAt:now}},
  {id:'denied-edit', tool:'edit',
   call:{type:'toolCall',id:'e-denied',name:'edit',arguments:{path:'src/denied.ts',oldText:'a',newText:'b'}},
   result:{role:'toolResult',toolCallId:'e-denied',toolName:'edit',content:[{type:'text',text:DENIAL}],details:{},isError:true,timestamp:now},
   run:{toolCallId:'e-denied',toolName:'edit',args:{},status:'error',partial:undefined,startedAt:now-40,endedAt:now}}
];
window.checkRoot = createRoot(document.getElementById('root'));
window.renderFixture = () => window.checkRoot.render(React.createElement(I18nProvider,null,
 React.createElement('div',{id:'fixture',style:{width:620,margin:'24px auto'}},
  cases.map(entry => React.createElement('div',{key:entry.id,'data-case':entry.id},
   React.createElement(ToolCallView,{call:entry.call,result:entry.result,run:entry.run,cwd:'/fixture'})))))); 
window.renderFixture();
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
const pause = ms => new Promise(r => setTimeout(r, ms))
const log = message => console.log('[write-row] ' + message)
// A check that hangs is worse than one that fails: it never reports. The suite
// is a few seconds of real work, so a watchdog turns any stall into a diagnosis.
let watchdog = setTimeout(() => {
  console.error('[write-row] TIMEOUT — the check did not finish; see the log above')
  process.exit(3)
}, 120000)
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'tool-write-row-fixture', configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== fixturePath) return next()
          try {
            res.setHeader('Content-Type', 'text/html')
            res.end(await server.transformIndexHtml(fixturePath, fixture))
          } catch (error) { next(error) }
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  log('vite ready')
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
// Chromium's own sandbox cannot start a renderer in every host (a headless or
// restricted session answers the debugger but never serves the Runtime domain),
// so the fixture window runs un-sandboxed: it loads a local vite fixture and
// touches no credentials. Harmless where the sandbox does work.
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:760,title:'Tool write row regression',webPreferences:{backgroundThrottling:false,sandbox:false}});w.loadURL(${JSON.stringify(url)});});
app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  log('page attached')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  let sequence = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, m => m.error ? reject(m.error) : resolve(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  for (let attempt = 0; attempt < 200; attempt++) {
    if (await evaluate(`!!window.fixtureReady && document.querySelectorAll('[data-case]').length === 4`)) break
    await pause(50)
  }
  if (!await evaluate('!!window.fixtureReady')) {
    throw new Error('fixture never rendered: ' + JSON.stringify(await evaluate('window.__errors')))
  }
  assert.equal(await evaluate(`document.querySelectorAll('[data-case]').length`), 4, 'all four rows rendered')
  log('fixture ready')

  if (process.env.PI_WRITE_ROW_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_WRITE_ROW_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_WRITE_ROW_SCREENSHOT_DIR, 'tool-write-rows.png'), Buffer.from(capture.data, 'base64'))
  }

  /** Everything the row claims about itself, read from the DOM. */
  const row = id => evaluate(`(()=>{const c=document.querySelector('[data-case="${id}"]');
    const body=c.querySelector('[data-tool-body]');
    return {state:c.querySelector('div[data-state]')?.dataset.state ?? null,
      busy:!!c.querySelector('[aria-busy="true"]'),
      diff:!!c.querySelector('[data-slot="file-diff-viewport"]'),
      applied:!!c.querySelector('[aria-label="Changes applied"]'),
      spinning:!!c.querySelector('[aria-label="Applying changes"]'),
      counts:(c.textContent.match(/\\+\\d+/)||[])[0] ?? null,
      status:c.querySelector('.sr-only')?.textContent ?? null,
      expanded:c.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
      destructive:!!c.querySelector('.text-destructive'),
      text:c.textContent}})()`)
  const expand = id => evaluate(`document.querySelector('[data-case="${id}"] button[aria-expanded]').click()`)
  log('rendering states')

  // 1. A denied write must read as a failure: no diff surface, no counts, and
  //    the denial itself once the row is opened.
  const deniedCollapsed = await row('denied-write')
  assert.equal(deniedCollapsed.state, 'error', 'a denied write is an error row')
  assert.equal(deniedCollapsed.diff, false, 'a denied write shows no diff body')
  assert.equal(deniedCollapsed.applied, false, 'a denied write never claims its changes were applied')
  assert.equal(deniedCollapsed.counts, null, 'a denied write shows no +n count for a file it never wrote')
  assert.equal(deniedCollapsed.expanded, 'false', 'the denied write starts collapsed')
  assert.deepEqual(deniedCollapsed.diff && deniedCollapsed.text.includes('const value = 1;'), false,
    'the intended content stays out of the row')
  await expand('denied-write')
  await pause(240)
  const deniedOpen = await row('denied-write')
  assert.equal(deniedOpen.expanded, 'true', 'the denied write opens on click')
  assert.equal(deniedOpen.diff, false, 'opening a denied write does not reveal a diff')
  assert.ok(deniedOpen.text.includes('file access denied under read-only mode'), 'the denial is the row body')
  assert.ok(deniedOpen.text.includes('escalation available'), 'the way forward survives to the DOM')
  assert.equal(deniedOpen.destructive, true, 'the denial renders in the destructive color')
  assert.equal(deniedOpen.busy, false, 'a settled denial is not busy')

  // 2. A successful write keeps the synthesized diff, its counts and the glyph.
  const appliedCollapsed = await row('applied-write')
  // An applied write IS its diff row — there is no ToolResult wrapper — so its
  // state is the diff's own settled one, and never `streaming`.
  assert.equal(appliedCollapsed.state, 'complete', 'an applied write is a settled diff row')
  assert.equal(appliedCollapsed.applied, true, 'an applied write carries the applied glyph')
  assert.equal(appliedCollapsed.spinning, false, 'a settled diff never spins')
  assert.equal(appliedCollapsed.counts, '+1', 'an applied write counts its inserted line')
  await expand('applied-write')
  await pause(240)
  const appliedOpen = await row('applied-write')
  assert.equal(appliedOpen.diff, true, 'an applied write opens its diff body')
  assert.ok(appliedOpen.text.includes('const value = 1;'), 'the applied diff shows the written content')

  // 3. A running write has not written anything yet: its content is streamed
  //    arguments, so it must render a plain row — no diff, no counts, no
  //    streaming diff artifacts (auto-open, auto-scroll, deferred colors).
  const runningCollapsed = await row('running-write')
  assert.equal(runningCollapsed.diff, false, 'a running write shows no diff body')
  assert.equal(runningCollapsed.applied, false, 'a running write never claims its changes were applied')
  assert.equal(runningCollapsed.counts, null, 'a running write shows no +n count')
  assert.equal(runningCollapsed.busy, true, 'a running write still reports itself as busy')
  await expand('running-write')
  await pause(240)
  const runningOpen = await row('running-write')
  assert.equal(runningOpen.diff, false, 'opening a running write still shows no diff')
  assert.equal(runningOpen.spinning, false, 'a running write has no streaming diff spinner')
  assert.deepEqual(runningOpen.text.includes('const value = 1;'), false, 'the streamed content stays out of the row')
  assert.ok(runningOpen.text.trim().length > 0, 'a running write shows its own placeholder')

  // 4. The control: `edit` reads its diff only from `details.patch`, so a
  //    denial already landed on the error row before this fix.
  const deniedEdit = await row('denied-edit')
  assert.equal(deniedEdit.state, 'error', 'a denied edit is an error row')
  assert.equal(deniedEdit.diff, false, 'a denied edit shows no diff body')
  assert.equal(deniedEdit.counts, null, 'a denied edit shows no changed-line count')
  await expand('denied-edit')
  await pause(240)
  assert.ok((await row('denied-edit')).text.includes('file access denied under read-only mode'),
    'a denied edit explains itself too')

  await evaluate('window.checkRoot.unmount()')
  log('denied write/edit show their denial; applied write shows its diff; running write shows its placeholder')
} finally {
  clearTimeout(watchdog)
  ws?.close()
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
