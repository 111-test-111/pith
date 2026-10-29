/**
 * The real discovery dialog supports direct keyboard selection, cross-search
 * selections, searching beyond the display cap and duplicate-safe imports.
 * Runs in isolated Electron with synthetic provider responses.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
  {id:'alpha-1',name:'Alpha One'},{id:'beta-2',name:'Beta Two'},{id:'gamma-3'},{id:'added-4',name:'Added Four'},...Array.from({length:310},(_,i)=>({id:'catalog-'+i,name:'Catalog '+i}))
]};
window.mutate=(updater,immediate)=>{window.imported={result:updater({providers:{}},false),immediate}};
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement(DiscoverDialog,{open:true,providerId:'acme',providerName:'Acme',entry:{models:[{id:'added-4'}]},flush:async()=>{window.flushCalls++;return true},mutate:window.mutate,onClose:()=>{window.closeCount++}})}
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

  await waitFor('window.fixtureReady && document.querySelectorAll("[data-discovered-model]").length === 300')
  assert.equal(await evaluate('window.flushCalls'), 1, 'opening flushes pending connection edits')
  assert.equal(await evaluate('document.querySelector("[data-discovered-model=added-4] [role=checkbox]").disabled'), true, 'an already-added ID cannot be selected')
  const toggle = async id => {
    await evaluate(`document.querySelector('[data-discovered-model="' + ${JSON.stringify(id)} + '"] [role=checkbox]').click()`)
    await pause(100)
  }
  const search = async value => {
    await evaluate('(()=>{const input=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,' + JSON.stringify(value) + ');input.dispatchEvent(new Event("input",{bubbles:true}))})()')
    await pause(100)
  }
  await toggle('alpha-1')
  assert.equal(await evaluate('document.querySelector("[data-discovered-model=alpha-1] [role=checkbox]").getAttribute("aria-checked")'), 'true')
  await evaluate('document.querySelector("[data-discovered-model=gamma-3] [role=checkbox]").focus()')
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:' ', code:'Space', windowsVirtualKeyCode:32 })
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32 })
  await pause(100)
  assert.equal(await evaluate('document.querySelector("[data-discovered-model=gamma-3] [role=checkbox]").getAttribute("aria-checked")'), 'true', 'Space selects a focused model')
  await search('Beta')
  assert.equal(await evaluate('document.querySelectorAll("[data-discovered-model]").length'), 1, 'search filters by display name')
  await toggle('beta-2')
  await search('catalog-309')
  assert.equal(await evaluate('document.querySelector("[data-discovered-model]").dataset.discoveredModel'), 'catalog-309', 'search reaches models beyond the display cap')
  await toggle('catalog-309')
  await search('')
  assert.equal(await evaluate('document.querySelector("[data-discovered-model=alpha-1] [role=checkbox]").getAttribute("aria-checked")'), 'true', 'changing search retains selections')
  if (process.env.PI_PROVIDER_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_PROVIDER_SCREENSHOT_DIR, {recursive:true})
    const shot=await send('Page.captureScreenshot',{format:'png'})
    await writeFile(join(process.env.PI_PROVIDER_SCREENSHOT_DIR,'discover-models.png'),Buffer.from(shot.data,'base64'))
  }
  const importButton = await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Import 4"))?.textContent')
  assert(importButton, 'the import action counts all selections across searches')
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Import 4")).click()')
  await pause(150)
  assert.equal(await evaluate('window.closeCount'), 1, 'a saved import dismisses the dialog')
  assert.equal(await evaluate('window.flushCalls'), 2, 'import waits for persistence')
  assert.deepEqual(await evaluate('window.imported.result.providers.acme.models'), [
    {id:'alpha-1',name:'Alpha One'}, {id:'gamma-3'}, {id:'beta-2',name:'Beta Two'}, {id:'catalog-309',name:'Catalog 309'}
  ], 'imports include only selected new IDs and preserve provider names')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: provider discovery — keyboard selection, cross-search retention, capped search and duplicate-safe saved import')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  const { rm } = await import('node:fs/promises')
  await rm(temporary, { recursive: true, force: true })
}
