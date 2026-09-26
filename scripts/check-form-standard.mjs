/**
 * Built-source check for the app's create/edit panel standard
 * (`src/renderer/src/lib/form-standard.ts`, AGENTS.md → create/edit panels).
 *
 * Renders the two provider-side panels straight from source in an isolated
 * Electron page — Add provider (a create form) and Add model (the model
 * editor) — and measures the rules the standard fixes:
 *   - panel title: 16px semibold;
 *   - field titles: 14px, one colour, flush with the control below (no inset);
 *   - title-to-control gap: 10px everywhere;
 *   - control text: the 14px form scale;
 *   - editing items: a 20px rhythm, never the 12px control gap.
 * The MCP, scheduled-task and subagent panels assert the same rules in their
 * own checks (check-mcp-settings / check-scheduled-tasks-ui /
 * check-subagent-settings).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-form-standard-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__form-standard-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {AddProviderDialog} from '/src/components/app/settings/providers/AddProviderDialog.tsx';
import {ModelEditorDialog} from '/src/components/app/settings/providers/ModelEditorDialog.tsx';
import {Button} from '@/components/motion/button';
import {I18nProvider} from '@/i18n/index.tsx';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');localStorage.removeItem('pi-app:reduce-motion');
window.pi={openExternal:async()=>'',testModel:async()=>({ok:true,latencyMs:1,status:200})};
function Fixture(){
  const [provider,setProvider]=React.useState(false);
  const [model,setModel]=React.useState(false);
  window.setProvider=setProvider;window.setModel=setModel;
  return React.createElement('div',{className:'p-8'},
    React.createElement(Button,{id:'open-provider',onClick:()=>setProvider(true)},'Add provider'),
    React.createElement(Button,{id:'open-model',onClick:()=>setModel(true)},'Add model'),
    React.createElement(AddProviderDialog,{open:provider,config:{providers:{}},mutate:()=>{},onClose:()=>setProvider(false),onCreated:()=>{}}),
    React.createElement(ModelEditorDialog,{target:model?{kind:'new'}:null,providerId:'fixture',entry:undefined,mutate:()=>{},flush:async()=>{},onClose:()=>setModel(false)}));
}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(Fixture))));
</script></body></html>`

let child, ws, server
try {
  server = await createServer({
    configFile: false,
    root: join(repo, 'src/renderer'),
    logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'fixture',
        configureServer(server) {
          server.middlewares.use(fixturePath, async (_req, res, next) => {
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) {
              next(error)
            }
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:1000,title:'Form standard check',webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`
  )
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let index = 0; index < 100 && !page; index++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((entry) => entry.type === 'page')
    if (!page) await pause(50)
  }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (message) => (message.error ? reject(message.error) : resolve(message.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async (expression) => {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(`Boolean(${expression})`)) return
      await pause(100)
    }
    throw new Error(`Timed out: ${expression}\n${JSON.stringify(exceptions)}`)
  }
  const click = async (expression) => {
    const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }

  /** Every rule the standard fixes, measured on one panel's own surface. */
  const assertStandard = async (name) => {
    const facts = await evaluate(`(()=>{
      const body=document.querySelector('[data-form-items]');
      if(!body) return null;
      const root=body.parentElement;
      const titles=[...root.querySelectorAll('label.text-sm.font-medium,p.text-sm.font-medium,span.text-sm.font-medium')];
      const box=e=>({l:e.getBoundingClientRect().left,p:parseFloat(getComputedStyle(e).paddingLeft)});
      const inset=e=>{const a=box(e),b=box(e.parentElement);return Math.round(a.l+a.p-b.l-b.p)};
      const gap=e=>Math.round(e.nextElementSibling.getBoundingClientRect().top-e.getBoundingClientRect().bottom);
      const heading=root.querySelector('h2');
      const items=[...root.querySelectorAll('[data-form-items] > *')];
      return{
        title:heading?{text:heading.textContent.trim(),size:getComputedStyle(heading).fontSize,weight:Number(getComputedStyle(heading).fontWeight)}:null,
        titles:titles.map(e=>e.textContent.trim()),
        insets:[...new Set(titles.map(inset))],
        colors:[...new Set(titles.map(e=>getComputedStyle(e).color))],
        sizes:[...new Set(titles.map(e=>getComputedStyle(e).fontSize))],
        gaps:[...new Set(titles.map(gap))],
        items:items.length,
        itemGaps:[...new Set(items.map(e=>e.getBoundingClientRect()).flatMap(r=>{const next=items.map(e=>e.getBoundingClientRect()).filter(o=>o.top>=r.bottom-1).sort((a,b)=>a.top-b.top)[0];return next?[Math.round(next.top-r.bottom)]:[]}))],
        controls:[...new Set([...root.querySelectorAll('input,textarea,button[aria-haspopup="listbox"]')].map(e=>getComputedStyle(e).fontSize))],
        clipped:{scroll:body.scrollHeight,client:body.clientHeight},
        columns:getComputedStyle(body).gridTemplateColumns.split(' ').length,
        panelTop:Math.round(root.getBoundingClientRect().top),
        panelBottom:Math.round(root.getBoundingClientRect().bottom),
        viewport:window.innerHeight
      }})()`)
    assert.ok(facts, `${name}: the panel renders its item stack ([data-form-items])`)
    assert.ok(
      facts.title && facts.title.size === '16px' && facts.title.weight >= 600,
      `${name}: the panel title is a 16px semibold heading: ${JSON.stringify(facts.title)}`
    )
    assert.ok(
      facts.titles.length >= 3 && facts.insets.length === 1 && facts.insets[0] === 0,
      `${name}: field titles are flush with their controls: ${JSON.stringify(facts)}`
    )
    assert.deepEqual(facts.sizes, ['14px'], `${name}: field titles share the form type scale: ${JSON.stringify(facts.sizes)}`)
    assert.equal(facts.colors.length, 1, `${name}: field titles share one colour: ${JSON.stringify(facts.colors)}`)
    assert.ok(
      facts.gaps.length === 1 && facts.gaps[0] === 10,
      `${name}: every title sits 10px above its control: ${JSON.stringify(facts.gaps)}`
    )
    assert.deepEqual(facts.controls, ['14px'], `${name}: controls carry the form type scale: ${JSON.stringify(facts.controls)}`)
    assert.ok(
      facts.items >= 3 && facts.itemGaps.every((gap) => gap >= 16) && facts.itemGaps.includes(20),
      `${name}: editing items keep the 20px rhythm: ${JSON.stringify(facts.itemGaps)} (${facts.items} items)`
    )
    assert.equal(facts.columns, 2, `${name}: the form lays out in two columns: ${facts.columns}`)
    assert.ok(
      facts.clipped.scroll <= facts.clipped.client + 2,
      `${name}: every item shows at once, nothing clipped: ${JSON.stringify(facts.clipped)}`
    )
    assert.ok(
      facts.panelTop >= 0 && facts.panelBottom <= facts.viewport,
      `${name}: the panel fits the viewport: ${JSON.stringify({ top: facts.panelTop, bottom: facts.panelBottom, viewport: facts.viewport })}`
    )
    return facts
  }

  await until(`document.querySelector('#open-provider')`)
  await click(`document.querySelector('#open-provider')`)
  await until(`document.querySelector('[data-form-items]')`)
  await pause(250)
  const provider = await assertStandard('add provider')
  // The create path still refuses an invalid id (the standard is styling only).
  // Scope to the panel: the fixture's own launcher wears the same label.
  await click(`[...document.querySelector('[data-form-items]').parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add provider')`)
  await until(`document.body.textContent.includes('lowercase')`)
  await evaluate(`window.setProvider(false)`)
  await until(`!document.querySelector('[data-form-items]')`)

  await click(`document.querySelector('#open-model')`)
  await until(`document.querySelector('[data-form-items]')`)
  await pause(250)
  const model = await assertStandard('add model')
  assert.ok(
    model.titles.includes('Model ID') && model.titles.length >= 8,
    `the model editor renders all of its own fields: ${JSON.stringify(model.titles)}`
  )
  assert.deepEqual(exceptions, [], 'no renderer exception while measuring both panels')
  console.log(
    `PASS: create/edit panel standard — add provider (${provider.titles.length} titles) and add model (${model.titles.length} titles): 16px panel title, flush 14px titles in one colour, 10px title gap, 14px controls, 20px item rhythm`
  )
} finally {
  ws?.close()
  child?.kill()
  server?.close()
  // Electron keeps flushing its profile as it exits; retry rather than race it.
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
