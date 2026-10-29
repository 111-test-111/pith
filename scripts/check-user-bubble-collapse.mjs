/**
 * User message bubble collapse in isolated Electron; no model calls or user
 * data. A long paste is capped at ten body lines with a fade and a beUI
 * expand toggle, a short message gets neither, and the same row — mounted
 * through the subagent rail pane, which shares `UserItem` — behaves
 * identically at rail width. Also pins the two traps: the clamped state is in
 * the FIRST painted frame (no flash of a full-height bubble), and expanding
 * must not make the toggle's own overflow verdict flip and take the control
 * away.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-user-bubble-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__user-bubble-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {UserItem} from '/src/components/app/MessageItems.tsx';
import {SubagentSessionPane} from '/src/components/app/SubagentSessionPane.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
window.longText=Array.from({length:40},(_,i)=>'pasted line '+(i+1)).join('\\n');
window.childText=Array.from({length:40},(_,i)=>'delegated step '+(i+1)+' — summarize the module and report every exported symbol it declares').join('\\n');
window.shortText='just a quick note';
window.childSnapshot={sessionId:'child',sessionPath:'/ui/child',cwd:'/ui',projectless:false,initializing:false,
 messages:[{role:'user',timestamp:1,content:window.childText},
  {role:'assistant',timestamp:2,provider:'fixture',model:'fixture',stopReason:'stop',content:[{type:'text',text:'done'}]}],
 model:null,thinkingLevel:'off',isStreaming:false,eventSequence:1,subagentChild:'/ui/parent'};
window.pi={peekSession:async path=>Object.assign({},window.childSnapshot,{sessionPath:path}),onEvent:()=>()=>{},openPath:async()=>'',openExternal:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[],onSubagents:()=>()=>{},onBashTaskUpdate:()=>()=>{}};
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;
 return React.createElement(ImagePreviewProvider,null,
  React.createElement('div',{id:'chat',style:{width:720,padding:8}},
   React.createElement('div',{id:'long'},React.createElement(UserItem,{message:{role:'user',timestamp:1,content:window.longText}})),
   React.createElement('div',{id:'short'},React.createElement(UserItem,{message:{role:'user',timestamp:2,content:window.shortText}}))),
  React.createElement('div',{id:'pane',style:{width:430,height:620,display:'flex',flexDirection:'column'}},React.createElement(SubagentSessionPane,{sessionPath:'/ui/child',run:null,onOpenInChat:()=>{}})));}
window.checkRoot=createRoot(document.getElementById('root'));flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement(Fixture))));
requestAnimationFrame(()=>{const body=document.querySelector('#long [data-user-bubble-body]');window.firstFrame={collapsed:body?body.getAttribute('data-collapsed'):null,height:body?body.getBoundingClientRect().height:null,toggle:!!document.querySelector('#long [data-slot="message-bubble"] button')};});
window.read=root=>{const scope=document.querySelector(root);const body=scope.querySelector('[data-user-bubble-body]');const bubble=body&&body.closest('[data-slot="message-bubble"]');const toggle=(bubble&&bubble.querySelector('button'))||null;return{
 body:!!body,collapsed:body?body.getAttribute('data-collapsed'):null,id:body?body.id:null,
 height:body?body.getBoundingClientRect().height:null,natural:body?body.firstElementChild.getBoundingClientRect().height:null,
 mask:body?getComputedStyle(body).maskImage:null,
 toggle:!!toggle,label:toggle?toggle.textContent.trim():null,expanded:toggle?toggle.getAttribute('aria-expanded'):null,
 controls:toggle?toggle.getAttribute('aria-controls'):null}};
window.press=node=>{node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',buttons:1}));node.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));node.click()};
window.clickToggle=root=>{const body=document.querySelector(root+' [data-user-bubble-body]');window.press(body.closest('[data-slot="message-bubble"]').querySelector('button'))};
window.narrowPane=width=>{document.querySelector('#pane').style.width=width+'px'};
</script></body></html>`

let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  for (let i = 0; i < 200; i++) { if (await evaluate(`!!document.querySelector('#long [data-user-bubble-body]') && !!document.querySelector('#pane [data-user-bubble-body]')`)) break; await pause(50) }
  if (!(await evaluate(`!!document.querySelector('#long [data-user-bubble-body]')`))) {
    throw new Error('fixture never mounted: ' + JSON.stringify(exceptions.map((entry) => entry.exceptionDetails?.exception?.description ?? entry)))
  }
  await evaluate(`document.fonts.ready`)
  await pause(300)

  const collapsedLimit = 15 * Number.parseFloat(await evaluate(`getComputedStyle(document.documentElement).fontSize`))

  // 1. The clamped height and its toggle are in the first painted frame: a
  //    long paste must never flash at full height before the measurement lands.
  const firstFrame = await evaluate('window.firstFrame')
  assert.equal(firstFrame.collapsed, 'true', 'the first painted frame is already clamped: ' + JSON.stringify(firstFrame))
  assert.ok(firstFrame.height <= collapsedLimit + 1, `first frame is capped at ${collapsedLimit}px: ${JSON.stringify(firstFrame)}`)
  assert.ok(firstFrame.toggle, 'the first painted frame already carries the toggle')

  // 2. Collapsed long message: capped, faded, toggle closed and wired to the body.
  const collapsed = await evaluate(`window.read('#long')`)
  assert.equal(collapsed.collapsed, 'true')
  assert.ok(collapsed.height <= collapsedLimit + 1 && collapsed.height > collapsedLimit - 1, `collapsed height is the cap: ${JSON.stringify(collapsed)}`)
  assert.ok(collapsed.natural > collapsedLimit + 20, 'the body is genuinely taller than the cap: ' + JSON.stringify(collapsed))
  assert.match(collapsed.mask, /linear-gradient/, 'the clamped body fades out: ' + JSON.stringify(collapsed))
  assert.equal(collapsed.toggle, true, 'a long message gets the expand toggle')
  assert.equal(collapsed.label, 'Show full message', 'the toggle is labelled: ' + collapsed.label)
  assert.equal(collapsed.expanded, 'false')
  assert.equal(collapsed.controls, collapsed.id, 'the toggle controls the collapsed body')

  // 3. Expanding shows everything and — the trap — keeps its own control.
  await evaluate(`window.clickToggle('#long')`)
  await pause(150)
  const expanded = await evaluate(`window.read('#long')`)
  assert.equal(expanded.collapsed, null, 'expanding removes the clamp: ' + JSON.stringify(expanded))
  assert.equal(expanded.expanded, 'true')
  assert.equal(expanded.mask, 'none', 'no mask while expanded: ' + expanded.mask)
  assert.ok(expanded.height >= expanded.natural - 1, `the expanded bubble holds the whole body: ${JSON.stringify(expanded)}`)
  assert.ok(expanded.height > collapsedLimit + 100, 'the expanded bubble is taller than the cap')
  assert.equal(expanded.toggle, true, 'expanding must not remove the toggle the user just used')
  assert.equal(expanded.label, 'Show less', 'the toggle flips its label: ' + expanded.label)

  // 4. Collapsing again returns to exactly the cap.
  await evaluate(`window.clickToggle('#long')`)
  await pause(150)
  const recollapsed = await evaluate(`window.read('#long')`)
  assert.equal(recollapsed.collapsed, 'true')
  assert.equal(recollapsed.expanded, 'false')
  assert.equal(recollapsed.label, 'Show full message')
  assert.ok(Math.abs(recollapsed.height - collapsed.height) < 1, `re-collapsing restores the cap: ${JSON.stringify(recollapsed)}`)

  // 5. A short message is untouched: no cap, no toggle, no mask.
  const short = await evaluate(`window.read('#short')`)
  assert.equal(short.collapsed, null, 'a short message is not clamped: ' + JSON.stringify(short))
  assert.equal(short.toggle, false, 'a short message gets no toggle')
  assert.equal(short.height, short.natural, 'a short bubble keeps its natural height')

  // 6. The subagent rail pane renders the same row (same component) and behaves
  //    the same at rail width; narrowing it re-wraps without uncapping.
  const pane = await evaluate(`window.read('#pane')`)
  assert.equal(pane.collapsed, 'true', 'the subagent pane clamps its user message: ' + JSON.stringify(pane))
  assert.ok(pane.height <= collapsedLimit + 1, 'the pane bubble is capped')
  assert.equal(pane.toggle, true, 'the pane bubble carries the toggle')
  assert.equal(pane.label, 'Show full message')
  await evaluate(`window.clickToggle('#pane')`)
  await pause(150)
  const paneOpen = await evaluate(`window.read('#pane')`)
  assert.equal(paneOpen.collapsed, null, 'the pane bubble expands: ' + JSON.stringify(paneOpen))
  assert.ok(paneOpen.height > collapsedLimit + 100, 'the pane bubble shows the whole body')
  assert.equal(paneOpen.toggle, true, 'the pane keeps its toggle while expanded')
  await evaluate(`window.clickToggle('#pane')`)
  await pause(150)
  await evaluate(`window.narrowPane(320)`)
  await pause(250)
  const paneNarrow = await evaluate(`window.read('#pane')`)
  assert.equal(paneNarrow.collapsed, 'true', 'a narrower rail re-clamps: ' + JSON.stringify(paneNarrow))
  assert.ok(Math.abs(paneNarrow.height - collapsedLimit) < 1, 'the cap survives the re-wrap')
  assert.ok(paneNarrow.natural > pane.natural, `re-wrapping grew the natural height: ${JSON.stringify({ before: pane.natural, after: paneNarrow.natural })}`)
  assert.equal(paneNarrow.toggle, true)

  // 7. Both locales carry the control.
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(200)
  const zh = await evaluate(`window.read('#long')`)
  assert.equal(zh.label, '展开完整消息', 'the Chinese label renders: ' + zh.label)
  await evaluate(`window.clickToggle('#long')`)
  await pause(150)
  assert.equal((await evaluate(`window.read('#long')`)).label, '收起', 'the Chinese collapse label renders')
  await evaluate(`window.clickToggle('#long')`)
  await pause(150)
  await evaluate(`window.setLocale('en')`)
  await pause(200)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  if (process.env.PI_USER_BUBBLE_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_USER_BUBBLE_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_USER_BUBBLE_SCREENSHOT_DIR, 'collapsed.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    await evaluate(`window.clickToggle('#long')`)
    await pause(200)
    await writeFile(join(process.env.PI_USER_BUBBLE_SCREENSHOT_DIR, 'expanded.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  console.log('PASS: user bubble collapse — capped first frame, fade + beUI toggle, expand/recollapse, short messages untouched, subagent rail pane parity, both locales.')
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
