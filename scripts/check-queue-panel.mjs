/**
 * Queued-message rows in isolated Electron; no model calls or user data. A
 * queued message must read at body size on a row tall enough to sit centred in
 * it — the row used to be a text-xs line pushed up by an asymmetric bottom
 * padding. Geometry only: the row's own height (24px body line + symmetric
 * padding), the text's font/line metrics, and the text and control centres
 * against the row centre, in both locales.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-queue-panel-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__queue-panel-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {QueuePanel} from '/src/components/app/QueuePanel.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
window.steerText='补充：子代理会话页面（侧栏里的）的用户消息气泡也要保持一致。';
window.followText='after this run, summarize every module the delegation touched';
window.pi={openPath:async()=>'',openExternal:async()=>{}};
function Fixture(){const {setLocale,locale}=useI18n();window.setLocale=setLocale;window.locale=locale;
 return React.createElement('div',{id:'panel',style:{width:760,margin:'20px auto'}},
  React.createElement(QueuePanel,{steering:[{text:window.steerText,imageCount:1,filePaths:['a.ts','b.ts']}],
   followUp:[{text:window.followText,imageCount:0,filePaths:[]}],
   onPromote:()=>{},onRemove:()=>{},onRecall:()=>{}}));}
window.checkRoot=createRoot(document.getElementById('root'));window.mount=()=>flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement(Fixture))));window.mount();
window.read=()=>({header:document.querySelector('#panel > div > div').textContent.trim(),
 rows:[...document.querySelectorAll('#panel [data-queue-row]')].map(row=>{const rect=row.getBoundingClientRect();const text=row.querySelector('[data-queue-row-text]');const style=getComputedStyle(text);const textRect=text.getBoundingClientRect();
  return {height:rect.height,center:rect.top+rect.height/2,text:text.textContent.trim(),fontSize:style.fontSize,lineHeight:style.lineHeight,
   textCenter:textRect.top+textRect.height/2,
   controls:[...row.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {height:r.height,center:r.top+r.height/2,label:button.getAttribute('aria-label')}}),
   icons:[...row.querySelectorAll('svg')].map(icon=>{const r=icon.getBoundingClientRect();return r.top+r.height/2})}})});
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:400,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails?.exception?.description ?? msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  for (let i = 0; i < 200; i++) { if (await evaluate(`document.querySelectorAll('#panel [data-queue-row]').length === 2`)) break; await pause(50) }
  if (!(await evaluate(`document.querySelectorAll('#panel [data-queue-row]').length === 2`))) throw new Error('queue rows never mounted: ' + JSON.stringify(exceptions))
  await evaluate(`document.fonts.ready`)
  await pause(300)

  // 1. Body size and a 36px row: the app's 24px body line plus symmetric 6px
  //    padding, instead of a 20px text-xs line pushed up by `pb-1`.
  const { header, rows } = await evaluate('window.read()')
  assert.equal(header, 'Queued · 2', 'the header stays its own row: ' + header)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.fontSize, '14px', 'the queued text is body size: ' + JSON.stringify(row))
    assert.equal(row.lineHeight, '24px', 'the queued text keeps the 24px body line: ' + JSON.stringify(row))
    assert.ok(Math.abs(row.height - 36) < 1, 'the row is 36px tall: ' + JSON.stringify(row))
  }

  // 2. Text, kind icon and action buttons all sit on the row's centre line.
  const centered = (value, center) => Math.abs(value - center) <= 1
  for (const row of rows) {
    assert.ok(centered(row.textCenter, row.center), 'the text is vertically centred: ' + JSON.stringify(row))
    for (const icon of row.icons) assert.ok(centered(icon, row.center), 'the row glyph is centred: ' + JSON.stringify(row))
    assert.ok(row.controls.length >= 1, 'the row keeps its actions: ' + JSON.stringify(row))
    for (const control of row.controls) {
      assert.ok(Math.abs(control.height - 24) < 1, 'the row control is 24px: ' + JSON.stringify(control))
      assert.ok(centered(control.center, row.center), 'the row control is vertically centred: ' + JSON.stringify({ control, row }))
      assert.ok(control.label, 'the row control is labelled: ' + JSON.stringify(control))
    }
  }

  // 3. The two kinds keep their own actions: a steered message only removes, a
  //    follow-up can also be promoted now.
  assert.equal(rows[0].controls.length, 1, 'a queued steer only offers remove: ' + JSON.stringify(rows[0]))
  assert.equal(rows[1].controls.length, 2, 'a follow-up offers steer-now and remove: ' + JSON.stringify(rows[1]))
  assert.ok(rows[1].controls.some((control) => control.label === 'Send now'), 'the follow-up keeps its promote action')

  // 4. Both locales: the row geometry must not depend on the translated prose.
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(250)
  const zh = await evaluate('window.read()')
  assert.equal(zh.header, '已排队 · 2', 'the Chinese header renders: ' + zh.header)
  assert.ok(zh.rows[0].text.startsWith('补充：'), 'the Chinese queued prose renders: ' + zh.rows[0].text)
  assert.ok(Math.abs(zh.rows[0].height - 36) < 1, 'the row height is locale independent: ' + JSON.stringify(zh.rows[0]))
  assert.ok(centered(zh.rows[0].textCenter, zh.rows[0].center), 'the Chinese row is centred too: ' + JSON.stringify(zh.rows[0]))

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  if (process.env.PI_QUEUE_PANEL_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_QUEUE_PANEL_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_QUEUE_PANEL_SCREENSHOT_DIR, 'queue-panel-zh.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  console.log('PASS: queue panel rows — body-size text on a 36px row with text, glyphs and actions centred, in both locales.')
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
