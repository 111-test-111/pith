/**
 * Settings → Usage → Token activity now renders its daily calendar through
 * beUI's `heat-calendar`: same usage-view pipeline, peak-relative intensities,
 * localized readout. This runs the real panel in isolated Electron with a stub
 * stats DTO and checks the grid geometry, the exact counts, the localized
 * tooltip and that the weekly view is untouched. No model calls, no user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-usage-heat-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__usage-heat-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {TokenActivityPanel} from '/src/components/app/settings/usage/TokenActivityPanel.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const day=(tokens)=>({tokens,cost:0,requests:1});
window.stats={generatedAt:Date.now(),firstDay:'2026-09-01',lastDay:'2026-09-15',
 models:[{key:'a/b',provider:'a',model:'b',days:{'2026-09-01':day(100),'2026-09-10':day(500),'2026-09-15':day(250)},totalTokens:850,totalCost:0,totalRequests:3}],
 totalTokens:850,totalCost:0,totalRequests:3,records:[],recordsTruncated:false};
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement('div',{style:{width:900,padding:20}},React.createElement(TokenActivityPanel,{stats:window.stats,today:'2026-09-15'}))}
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
window.fixtureReady=true;
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:900,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  const waitFor = async (expression) => { for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100) } throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(exceptions)) }

  await waitFor('window.fixtureReady && document.querySelectorAll("[data-heat-cell]").length > 300')
  const cells = await evaluate(`document.querySelectorAll('[data-heat-cell]').length`)
  assert.ok(cells >= 357 && cells <= 371, 'a whole Monday-first week grid is rendered: ' + cells)
  const labels = await evaluate(`Array.from(document.querySelectorAll('[data-heat-cell]')).map(c=>c.getAttribute('aria-label'))`)
  assert.ok(labels.some((l) => l.startsWith('500 ')), 'the peak day carries its exact token count: ' + labels.find((l) => l.includes('500')))
  assert.ok(labels.some((l) => l.startsWith('100 ')) && labels.some((l) => l.startsWith('250 ')), 'every nonzero day keeps its count')
  assert.ok(labels.some((l) => l.startsWith('0 ')), 'idle days render as empty contribution cells')
  // Future days stay out of the grid: 2026-09-15 is a Tuesday, so the last
  // (Monday-first) column ends at day index 1.
  const edge = await evaluate(`(()=>{const cells=[...document.querySelectorAll('[data-heat-cell]')].map(c=>c.getAttribute('data-heat-cell').split('-').map(Number));const maxW=Math.max(...cells.map(c=>c[0]));return{maxD:Math.max(...cells.filter(c=>c[0]===maxW).map(c=>c[1]))}})()`)
  assert.equal(edge.maxD, 1, 'future days are not rendered')

  // The localized readout hangs off the cell on hover.
  await evaluate(`(()=>{const cell=[...document.querySelectorAll('[data-heat-cell]')].find(c=>c.getAttribute('aria-label').startsWith('500 '));cell.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}));cell.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))})()`)
  await waitFor(`document.querySelector('[data-heat-tooltip]')`)
  const english = await evaluate(`document.querySelector('[data-heat-tooltip]').textContent`)
  assert.match(english, /500/, 'the tooltip reads the exact count')
  await evaluate(`window.setLocale('zh-CN')`)
  await waitFor(`document.querySelector('[data-heat-tooltip]') && /Token/.test(document.querySelector('[data-heat-tooltip]').textContent)`)
  const chinese = await evaluate(`document.querySelector('[data-heat-tooltip]').textContent`)
  assert.match(chinese, /500/, 'the zh-CN tooltip keeps the count')
  assert.match(chinese, /：/, 'the tooltip is composed from the app dictionary, not vendored English')
  await evaluate(`window.setLocale('en')`)

  // Weekly keeps the app's own block visualization.
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Weekly').click()`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelectorAll('[data-heat-cell]').length`), 0, 'the weekly switch leaves the calendar')
  assert.equal(await evaluate(`document.querySelectorAll('[data-activity-week]').length > 0`), true, 'the weekly blocks still render')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: token activity — heat-calendar daily grid, exact counts, bilingual readout, weekly view intact')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
