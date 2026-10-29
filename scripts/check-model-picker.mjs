/**
 * The composer's model picker keeps one trigger and opens a thinking-level
 * submenu from a reasoning model row. Exercise the real picker in isolated
 * Electron: SDK catalog names, row metadata, selection while a new snapshot
 * is in flight, and panel anchoring through layout moves. No model calls or
 * user data.
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
window.changes=[];window.levelChanges=[];window.modelDelay=0;
const models=[
 {providerId:'p1',providerName:'Provider One',id:'gpt-6.1-sol',name:'GPT-6.1 Sol',reasoning:true,available:true,contextWindow:128000,input:['text','image']},
 {providerId:'p1',providerName:'Provider One',id:'m2',name:'Model Two',reasoning:false,available:true,contextWindow:64000,input:['text']},
 {providerId:'p2',providerName:'Provider Two',id:'m3',name:'Model Three',reasoning:false,available:true,input:['text','image']}];
function Fixture(){
 const {setLocale}=useI18n();window.setLocale=setLocale;
 const [value,setValue]=React.useState('p1/gpt-6.1-sol');
 const [level,setLevel]=React.useState('off');
 const [levels,setLevels]=React.useState(['off','high']);
 // The onChange stand-in mirrors handleModelChange: the model (and its own
 // level list) arrive one snapshot round trip later, after a controllable
 // delay — exactly the window in which the level list still describes the
 // PREVIOUS model and must not be pickable.
 const pick=(m)=>{window.changes.push(m.id);return new Promise(r=>setTimeout(()=>{setValue(m.providerId+'/'+m.id);setLevels(m.reasoning?['off','high','max']:['off']);r()},window.modelDelay))};
 // The stage stands in for the composer: a centred, max-width-bounded box whose
 // pickers are shrink-to-fit flex items (the composer's leading-action row), so
 // a width change moves the triggers WITHOUT resizing them — exactly the way
 // Workspace.resizePanels writes the panel widths as CSS variables during a
 // drag, with no window resize and no scroll event to observe.
 return React.createElement('div',{id:'stage',style:{width:640,padding:24}},
  React.createElement('div',{id:'box',style:{width:'100%',maxWidth:592,margin:'0 auto',display:'flex',alignItems:'center',gap:8,paddingLeft:12}},
   React.createElement('span',{id:'leading',style:{width:28,height:28,flexShrink:0,borderRadius:8,background:'#ddd'}}),
   React.createElement(ModelPicker,{models,value,thinkingLevel:level,availableThinkingLevels:levels,
    onChange:pick,onThinkingLevelChange:(l)=>{window.levelChanges.push(l);setLevel(l)}})))}
window.setStageWidth=(maxWidth)=>{document.getElementById('box').style.maxWidth=maxWidth+'px'};
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

  const MODEL = `document.querySelector('button[aria-haspopup=listbox][aria-label="Choose model"]')`
  const PANEL = `document.getElementById(${MODEL}.getAttribute('aria-controls'))`
  const MENU = `document.querySelector('[data-thinking-panel]')`
  await waitFor('window.fixtureReady && document.querySelector("button[aria-haspopup=listbox]")')
  assert(await evaluate(`Boolean(${MODEL})`), 'the model trigger exists')
  assert.match(await evaluate(`${MODEL}.textContent`), /GPT-6.1 Sol/, 'the new SDK model is visible')
  assert.match(await evaluate(`${MODEL}.textContent`), /Off/, 'the current thinking level shares the trigger')

  const openPicker = async () => {
    await evaluate(`${MODEL}.click()`)
    await waitFor(`${PANEL}.getAttribute('aria-hidden')==='false'`)
    await pause(250)
  }
  const closePicker = async () => {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
    await waitFor(`${PANEL}.getAttribute('aria-hidden')==='true'`)
    await pause(150)
  }
  const option = key => `document.querySelector('[data-model-option="${key}"]')`
  const menuLevels = () => evaluate(`Array.from(${MENU}.querySelectorAll('[data-thinking-option]')).map(row=>row.textContent.trim())`)

  await openPicker()
  assert.equal(await evaluate(`${PANEL}.querySelectorAll('[data-model-option]').length`), 3, 'all available models are listed')
  assert.equal(await evaluate(`Boolean(${PANEL}.querySelector('input,textarea,[contenteditable]'))`), false, 'model selection has no text field')
  const rowFacts = await evaluate(`(()=>{
    const facts=['p1/gpt-6.1-sol','p1/m2','p2/m3'].map(key=>{
      const row=document.querySelector('[data-model-option="'+key+'"]');
      const group=row.querySelector('[role=group]');
      const rect=row.getBoundingClientRect();
      const badge=group?.getBoundingClientRect();
      return {height:Math.round(rect.height),text:group?.textContent.trim(),label:group?.getAttribute('aria-label'),
        inside:badge ? badge.bottom<=rect.bottom+0.5&&badge.right<=rect.right+0.5 : false};
    });
    return facts;
  })()`)
  assert.match(rowFacts[0].text, /text/)
  assert.match(rowFacts[0].text, /image/)
  assert.equal(rowFacts[0].label, 'Supported input')
  assert.match(rowFacts[1].text, /text/)
  assert.doesNotMatch(rowFacts[1].text, /image/)
  assert(rowFacts.every(row => row.inside), 'input badges stay inside their rows')
  assert.equal(rowFacts[0].height, rowFacts[1].height, 'multi-input and text-only rows share a height')

  await evaluate(`${option('p1/gpt-6.1-sol')}.click()`)
  await waitFor(`Boolean(${MENU})`)
  assert.deepEqual(await menuLevels(), ['Off','High'], 'the selected model offers its supported thinking levels')
  await evaluate(`document.querySelector('[data-thinking-option="high"]').click()`)
  await waitFor(`${PANEL}.getAttribute('aria-hidden')==='true'`)
  assert.deepEqual(await evaluate('window.levelChanges'), ['high'])
  assert.match(await evaluate(`${MODEL}.textContent`), /High/)

  // A non-reasoning target closes the picker immediately. The trigger updates
  // only after the session snapshot arrives; no stale level can be selected.
  await openPicker()
  await evaluate('window.modelDelay=400')
  await evaluate(`${option('p2/m3')}.click()`)
  await waitFor(`${PANEL}.getAttribute('aria-hidden')==='true'`)
  assert.deepEqual(await evaluate('window.changes'), ['m3'])
  assert.match(await evaluate(`${MODEL}.textContent`), /GPT-6.1 Sol/, 'the previous snapshot remains visible during the switch')
  await waitFor(`${MODEL}.textContent.includes('Model Three')`)
  assert.doesNotMatch(await evaluate(`${MODEL}.textContent`), /High/, 'non-reasoning models show no thinking level')
  await evaluate('window.modelDelay=0')

  // Switching back to a reasoning model waits for its own level list before
  // opening the submenu, then the choice uses that list.
  await openPicker()
  await evaluate(`${option('p1/gpt-6.1-sol')}.click()`)
  await waitFor(`${MODEL}.textContent.includes('GPT-6.1 Sol') && Boolean(${MENU})`)
  assert.deepEqual(await menuLevels(), ['Off','High','Max'])
  await evaluate(`document.querySelector('[data-thinking-option="max"]').click()`)
  await waitFor(`${PANEL}.getAttribute('aria-hidden')==='true'`)
  assert.deepEqual(await evaluate('window.changes'), ['m3','gpt-6.1-sol'])
  assert.deepEqual(await evaluate('window.levelChanges'), ['high','max'])
  assert.match(await evaluate(`${MODEL}.textContent`), /Max/)

  // The model panel follows its trigger through composer width changes even
  // when neither resize nor scroll fires.
  const placement = () => evaluate(`(()=>{
    const trigger=${MODEL}.getBoundingClientRect();
    const panel=${PANEL};
    const rect=panel.getBoundingClientRect();
    return {dx:Math.round(rect.left-trigger.left),dy:Math.round(rect.top-trigger.bottom),
      width:Math.round(rect.width),triggerLeft:Math.round(trigger.left),
      triggerWidth:Math.round(trigger.width),position:getComputedStyle(panel).position};
  })()`)
  await openPicker()
  const atRest = await placement()
  assert.ok(Math.abs(atRest.dx) <= 1, JSON.stringify(atRest))
  assert.ok(atRest.dy >= 0 && atRest.dy <= 14, JSON.stringify(atRest))
  assert.equal(atRest.width, 320)
  assert.equal(atRest.position, 'absolute')
  await closePicker()
  await evaluate('window.setStageWidth(496)')
  await openPicker()
  const shifted = await placement()
  assert.notEqual(shifted.triggerLeft, atRest.triggerLeft, 'the fixture moved the trigger')
  assert.equal(shifted.triggerWidth, atRest.triggerWidth)
  assert.ok(Math.abs(shifted.dx) <= 1, JSON.stringify(shifted))
  await evaluate('window.setStageWidth(560)')
  await pause(120)
  const followed = await placement()
  assert.ok(Math.abs(followed.dx) <= 1, JSON.stringify(followed))
  assert.ok(followed.dy >= 0 && followed.dy <= 14, JSON.stringify(followed))
  await closePicker()

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: model picker — GPT-6.1 Sol, thinking submenu, model metadata and live panel anchoring')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
