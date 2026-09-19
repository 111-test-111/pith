/**
 * The composer's model picker is a `Select` — the same pick-one control as the
 * sandbox-mode picker beside it: a panel anchored to its trigger, which stays
 * on the trigger through layout moves that report no resize or scroll. This
 * runs the real picker in isolated Electron and checks the compact trigger, the
 * two-stage flow, the level change, the model row itself (inputs accepted, no
 * step hint) and that the panel cannot drift. No model calls, no user data.
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
 {providerId:'p1',providerName:'Provider One',id:'m1',name:'Model One',reasoning:true,available:true,contextWindow:128000,input:['text','image']},
 {providerId:'p1',providerName:'Provider One',id:'m2',name:'Model Two',reasoning:false,available:true,contextWindow:64000,input:['text']},
 {providerId:'p2',providerName:'Provider Two',id:'m3',name:'Model Three',reasoning:false,available:true,input:['text','image']}];
function Fixture(){
 const {setLocale}=useI18n();window.setLocale=setLocale;
 const [value,setValue]=React.useState('p1/m1');
 const [level,setLevel]=React.useState('off');
 const [levels,setLevels]=React.useState(['off','high']);
 // The stage stands in for the composer: a centred, max-width-bounded box whose
 // picker is a shrink-to-fit flex item (the composer's leading-action row), so a
 // width change moves the trigger WITHOUT resizing it — exactly the way
 // Workspace.resizePanels writes the panel widths as CSS variables during a
 // drag, with no window resize and no scroll event to observe.
 return React.createElement('div',{id:'stage',style:{width:640,padding:24}},
  React.createElement('div',{id:'box',style:{width:'100%',maxWidth:592,margin:'0 auto',display:'flex',alignItems:'center',gap:8,paddingLeft:12}},
   React.createElement('span',{id:'leading',style:{width:28,height:28,flexShrink:0,borderRadius:8,background:'#ddd'}}),
   React.createElement(ModelPicker,{models,value,thinkingLevel:level,availableThinkingLevels:levels,
    onChange:(m)=>{window.changes.push(m.id);setValue(m.providerId+'/'+m.id);setLevels(['off','high','max'])},
    onThinkingLevelChange:(l)=>{window.levelChanges.push(l);setLevel(l)}})))}
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

  await waitFor('window.fixtureReady && document.querySelector("[aria-haspopup=listbox]")')
  assert.match(await evaluate(`document.querySelector('[aria-haspopup=listbox]').textContent`), /Model One · Off/, 'the compact trigger shows the model and level')

  // The picker is a `Select` (the sandbox-mode picker beside it, Settings →
  // Providers' default-model row): a list you choose from, with no field to
  // type in, and a panel the layout anchors to the trigger.
  const openPicker = async () => {
    await evaluate(`document.querySelector('[aria-haspopup=listbox]').click()`)
    await waitFor(`document.querySelector('[role=listbox]')?.getAttribute('aria-hidden')==='false'`)
    await pause(150)
  }
  // The Select keeps every item mounted while closed (their labels are what the
  // trigger reads), so a reading of the list has to scope itself to the OPEN panel.
  const options = () => evaluate(`Array.from(document.querySelector('[role=listbox][aria-hidden="false"]').querySelectorAll('[role=option]')).map(o=>o.textContent.trim())`)
  const listState = () => evaluate(`document.querySelector('[role=listbox]').getAttribute('aria-hidden')`)

  await openPicker()
  assert.equal((await options()).length, 3, 'all available models are listed')
  assert.equal(
    await evaluate(`Boolean(document.querySelector('[role=listbox][aria-hidden="false"]').querySelector('input,textarea,[contenteditable]'))`),
    false,
    'the panel offers no field to type in — it is a pick-one list'
  )

  // A model row states the inputs it accepts, and carries no step hint: the
  // picker's second stage opens on a reasoning model by itself.
  const rowFacts = await evaluate(`(()=>{
    const rows=[...document.querySelector('[role=listbox][aria-hidden="false"]').querySelectorAll('[role=option]')];
    const fact=(name)=>{
      const row=rows.find(o=>o.textContent.includes(name));
      if(!row) return null;
      const r=row.getBoundingClientRect();
      const group=row.querySelector('[role=group]');
      const g=group?group.getBoundingClientRect():null;
      return { height:Math.round(r.height),
        hints:[...row.querySelectorAll('svg')].filter(s=>!s.closest('[role=group]') && s.getAttribute('data-app-icon')!=='Check').length,
        group: g?{label:group.getAttribute('aria-label'),text:group.textContent.trim(),inside:g.bottom<=r.bottom+0.5&&g.right<=r.right+0.5}:null };
    };
    const names=['Model One','Model Two','Model Three'].map(fact);
    return {one:names[0],two:names[1],three:names[2],total:names.map(f=>f.hints).reduce((a,b)=>a+b,0)};
  })()`)
  assert.match(rowFacts.one.group.text, /text/, 'a text-only input is stated')
  assert.match(rowFacts.one.group.text, /image/, 'an image input is stated')
  assert.equal(rowFacts.one.group.label, 'Supported input', 'the badges are labelled as a group')
  assert.match(rowFacts.two.group.text, /text/, 'the second model states its text input')
  assert.doesNotMatch(rowFacts.two.group.text, /image/, 'and nothing it does not accept')
  for (const key of ['one', 'two', 'three']) {
    assert.equal(rowFacts[key].group.inside, true, `${key}: the input badges stay inside their row`)
  }
  assert.equal(
    rowFacts.total,
    0,
    'no expand/step hint is drawn in a model row (the only other glyph is the selection check)'
  )
  assert.equal(
    rowFacts.one.height,
    rowFacts.two.height,
    'a two-input row is no taller than a one-input row'
  )
  assert.equal(rowFacts.two.height, rowFacts.three.height, 'every model row keeps one height')

  // Picking a reasoning model keeps the panel open and swaps in its levels.
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Model One')).click()`)
  await pause(300)
  assert.equal(await listState(), 'false', 'the panel stays open for the thinking step')
  assert.deepEqual(await evaluate('window.changes'), ['m1'], 'picking a model reports it once')
  assert.deepEqual(await options(), ['Off', 'High', 'Max'], 'the supported thinking levels replace the model list')
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='High').click()`)
  await pause(300)
  assert.equal(await listState(), 'true', 'choosing a level closes the panel')
  assert.deepEqual(await evaluate('window.levelChanges'), ['high'], 'the level change is reported')
  assert.match(await evaluate(`document.querySelector('[aria-haspopup=listbox]').textContent`), /Model One · High/, 'the trigger reflects the new level')

  // A non-reasoning model has no second step.
  await openPicker()
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Model Two')).click()`)
  await pause(300)
  assert.equal(await listState(), 'true', 'a non-reasoning model closes immediately')
  assert.deepEqual(await evaluate('window.changes'), ['m1', 'm2'], 'the second model is reported')
  assert.match(await evaluate(`document.querySelector('[aria-haspopup=listbox]').textContent`), /Model Two/, 'the trigger follows the non-reasoning model')

  // The panel is ANCHORED to the trigger, not parked at a stored viewport
  // measurement: a moving composer must carry it along, and every open must
  // land in the same place. Only the side is decided in JS; the position is the
  // layout's own, which is what makes it impossible to drift.
  const panelPlacement = () => evaluate(`(()=>{
    const trigger=document.querySelector('[aria-haspopup=listbox]');
    const t=trigger.getBoundingClientRect();
    const panel=document.querySelector('[role=listbox]');
    const p=panel.getBoundingClientRect();
    const box=document.getElementById('box').getBoundingClientRect();
    return {dx:Math.round(p.left-t.left),dy:Math.round(p.top-t.bottom),
      panelWidth:Math.round(p.width),triggerWidth:Math.round(t.width),triggerLeft:Math.round(t.left),
      boxLeft:Math.round(box.left),position:getComputedStyle(panel).position,side:panel.dataset.side||''};
  })()`)
  const closePicker = async () => {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
    await waitFor(`document.querySelector('[role=listbox]')?.getAttribute('aria-hidden')==='true'`)
    await pause(150)
  }
  const show = (placement) => JSON.stringify(placement)
  const flushLeftEdge = (placement, label) =>
    assert.ok(Math.abs(placement.dx) <= 1, `${label} (${show(placement)})`)
  // The near gap animates (a spring with a 0.12s delay) from 0 to 8px, so the
  // assertion is "attached to the trigger's bottom edge, never floated away".
  const underTrigger = (placement, label) =>
    assert.ok(placement.dy >= 0 && placement.dy <= 14, `${label} (${show(placement)})`)
  await openPicker()
  const atRest = await panelPlacement()
  flushLeftEdge(atRest, "the panel starts on the trigger's left edge")
  underTrigger(atRest, 'and hangs off its bottom edge')
  await closePicker()

  // Narrow the composer exactly the way Workspace.resizePanels moves it (a CSS
  // width write, no window resize, no scroll), then open again: the panel must
  // not remember where the trigger used to be.
  await evaluate(`window.setStageWidth(496)`)
  await pause(100)
  await openPicker()
  const shifted = await panelPlacement()
  assert.notEqual(shifted.triggerLeft, atRest.triggerLeft, 'the fixture really moved the trigger')
  assert.equal(shifted.triggerWidth, atRest.triggerWidth, 'and left its width alone')
  flushLeftEdge(shifted, 'a moved composer takes the panel with it (no stale anchor)')
  underTrigger(shifted, 'no stale vertical anchor either')

  // And it keeps tracking while it is open: the panel is anchored, so it
  // follows the trigger live instead of waiting for a resize or scroll event.
  await evaluate(`window.setStageWidth(560)`)
  await pause(120)
  const followed = await panelPlacement()
  flushLeftEdge(followed, 'an open panel follows its trigger')
  underTrigger(followed, 'vertically too')
  assert.equal(followed.panelWidth, 320, `the anchored panel keeps its own width (${show(followed)})`)
  assert.equal(followed.position, 'absolute', 'the panel belongs to the layout, not to a portal')
  await closePicker()
  await evaluate(`window.setStageWidth(592)`)

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: model picker — pick-one Select anchored to its trigger, per-row input badges, no step hint, two-stage thinking step, level + model changes')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
