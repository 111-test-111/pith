/**
 * The composer's model picker is beUI's `Combobox`: a searchable model list
 * whose popover stays open while a reasoning model's thinking levels replace
 * it. This runs the real picker in isolated Electron and checks the compact
 * trigger, the search field, the two-stage flow and the level change. No model
 * calls, no user data.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-model-picker-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__model-picker-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {ModelPicker} from '/src/components/app/ModelPicker.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
window.changes=[];window.levelChanges=[];
const models=[
 {providerId:'p1',providerName:'Provider One',id:'m1',name:'Model One',reasoning:true,available:true,contextWindow:128000},
 {providerId:'p1',providerName:'Provider One',id:'m2',name:'Model Two',reasoning:false,available:true,contextWindow:64000},
 {providerId:'p2',providerName:'Provider Two',id:'m3',name:'Model Three',reasoning:false,available:true}];
function Fixture(){
 const {setLocale}=useI18n();window.setLocale=setLocale;
 const [value,setValue]=React.useState('p1/m1');
 const [level,setLevel]=React.useState('off');
 const [levels,setLevels]=React.useState(['off','high']);
 return React.createElement('div',{style:{width:640,padding:24}},
  React.createElement(ModelPicker,{models,value,thinkingLevel:level,availableThinkingLevels:levels,
   onChange:(m)=>{window.changes.push(m.id);setValue(m.providerId+'/'+m.id);setLevels(['off','high','max'])},
   onThinkingLevelChange:(l)=>{window.levelChanges.push(l);setLevel(l)}}))}
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:700,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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

  await waitFor('window.fixtureReady && document.querySelector(".cursor-text")')
  assert.match(await evaluate(`document.querySelector('.cursor-text').textContent`), /Model One · Off/, 'the compact trigger shows the model and level')

  const openPicker = async () => {
    await evaluate(`(()=>{const t=document.querySelector('.cursor-text');t.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse'}))})()`)
    await waitFor(`document.querySelector('[data-combobox-content]')?.getAttribute('aria-hidden')==='false'`)
    await pause(150)
  }
  const options = () => evaluate(`Array.from(document.querySelectorAll('[role=option]')).map(o=>o.textContent.trim())`)

  await openPicker()
  assert.equal((await options()).length, 3, 'all available models are listed')
  // Search filters the list.
  await evaluate(`(()=>{const input=document.querySelector('input[role=combobox]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'three');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await pause(200)
  const filtered = await options()
  assert.equal(filtered.length, 1, 'the search field narrows the list to one row')
  assert.match(filtered[0], /Model Three/, 'the remaining row is the matching model')
  await evaluate(`(()=>{const input=document.querySelector('input[role=combobox]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await pause(200)

  // Picking a reasoning model keeps the popover open and swaps in its levels.
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Model One')).click()`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-combobox-content]')?.getAttribute('aria-hidden')`), 'false', 'the popover stays open for the thinking step')
  assert.deepEqual(await evaluate('window.changes'), ['m1'], 'picking a model reports it once')
  assert.deepEqual(await options(), ['Off', 'High', 'Max'], 'the supported thinking levels replace the model list')
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='High').click()`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-combobox-content]')?.getAttribute('aria-hidden')`), 'true', 'choosing a level closes the popover')
  assert.deepEqual(await evaluate('window.levelChanges'), ['high'], 'the level change is reported')
  assert.match(await evaluate(`document.querySelector('.cursor-text').textContent`), /Model One · High/, 'the trigger reflects the new level')

  // A non-reasoning model has no second step.
  await openPicker()
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Model Two')).click()`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-combobox-content]')?.getAttribute('aria-hidden')`), 'true', 'a non-reasoning model closes immediately')
  assert.deepEqual(await evaluate('window.changes'), ['m1', 'm2'], 'the second model is reported')
  assert.match(await evaluate(`document.querySelector('.cursor-text').textContent`), /Model Two/, 'the trigger follows the non-reasoning model')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: model picker — searchable combobox, two-stage thinking step, level + model changes')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
