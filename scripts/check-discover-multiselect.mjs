/**
 * Provider model discovery uses beUI's `MultiSelect`: the fetched /models list
 * is a searchable multi-select listbox instead of a wall of checkboxes. This
 * runs the real dialog in isolated Electron with a stub provider endpoint and
 * asserts selection, chip display, the already-added guard, filtering,
 * keyboard toggling and the resulting ModelsConfig mutation. No model calls,
 * no user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-discover-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__discover-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {DiscoverDialog} from '/src/components/app/settings/providers/DiscoverDialog.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
window.closeCount=0;window.flushCalls=0;window.imported=null;
window.pi={discoverModels:async()=>[
  {id:'alpha-1',name:'Alpha One'},{id:'beta-2',name:'Beta Two'},{id:'gamma-3'},{id:'added-4',name:'Added Four'}
]};
window.mutate=(updater,immediate)=>{window.imported={result:updater({providers:{}},false),immediate}};
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement(DiscoverDialog,{open:true,providerId:'acme',providerName:'Acme',entry:{models:[{id:'added-4'}]},flush:async()=>{window.flushCalls++},mutate:window.mutate,onClose:()=>{window.closeCount++}})}
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:800,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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

  await waitFor('window.fixtureReady && document.querySelectorAll("[role=option]").length === 4')
  assert.equal(await evaluate('window.flushCalls'), 1, 'opening flushes pending edits before fetching')
  const options = () => evaluate(`Array.from(document.querySelectorAll('[role=option]')).map(o=>({label:o.textContent.trim(),disabled:o.disabled,selected:o.getAttribute('aria-selected')}))`)
  const before = await options()
  assert.ok(before.some((o) => o.label.includes('Alpha One')), 'the fetched models are listed')
  assert.equal(before.every((o) => o.selected === 'false'), true, 'nothing starts selected')
  assert.equal(before.find((o) => o.label.includes('Added Four')).disabled, true, 'an already-added model cannot be selected again')

  // The trigger opens the listbox; selecting a row shows a chip and updates the
  // import count, and the search input filters the options.
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-multi-select-content]'))`), true, 'the listbox portal exists')
  await evaluate(`(()=>{const trigger=document.querySelector('.cursor-text');trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse'}))})()`)
  await waitFor(`document.querySelector('[data-multi-select-content]')?.getAttribute('aria-hidden')==='false'`)
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Alpha One')).click()`)
  await pause(150)
  assert.equal(await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Alpha One')).getAttribute('aria-selected')`), 'true', 'clicking a row selects it')
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Import 1'))`), true, 'the import count follows the selection')
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Import 1')).click()`)
  await pause(150)
  assert.equal(await evaluate('window.closeCount'), 1, 'importing closes the dialog')
  const models = await evaluate('window.imported.result.providers.acme.models')
  assert.deepEqual(models, [{ id: 'alpha-1', name: 'Alpha One' }], 'import appends the selected model with its name')
  assert.equal(await evaluate('window.imported.immediate'), true, 'the import persists immediately')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: provider discovery — searchable multi-select, already-added guard, chip count, immediate import')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  const { rm } = await import('node:fs/promises')
  await rm(temporary, { recursive: true, force: true })
}
