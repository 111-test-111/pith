/**
 * The inner padding of the three dropdown surfaces — `Select`, `Combobox` and
 * `MultiSelect` — measured in isolated Electron against a Vite-served fixture
 * that mounts the vendored components themselves (no app data, no model calls).
 *
 * All three animate their BORDER-box height from a measured inner content
 * height, so the panel's own 1px borders have to be part of that measurement.
 * Without them the panel settles 2px short of its content and `overflow:
 * hidden` eats the difference at the BOTTOM: the first row sat 5px below the
 * panel's top edge while the last row sat 3px above its bottom edge — the
 * "top padding is bigger than the bottom" the owner reported across many
 * dropdowns (it applied to every Select in the app at once).
 *
 * The assertions are the invariant, not a magic number: the gap above the
 * first row equals the gap below the last one, and the panel's client box
 * holds its whole content (nothing clipped).
 *
 * PI_SELECT_PADDING_SCREENSHOT_DIR retains the three panels.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-select-padding-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__select-padding-check.html'

/** One two-line row per option — the shape every real picker uses. */
const rows = JSON.stringify([
  ['read-only', '只读', '拒绝所有文件写入，工作区也不例外；文件读取与网络访问不受限制。'],
  ['workspace-write', '工作区可写', '只允许写入本项目与临时目录；文件读取与网络访问不受限制。'],
  ['danger-full-access', '完全访问', '无沙箱：命令与文件工具直接在主机上运行。']
])

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/motion/select';
import {Combobox,ComboboxContent,ComboboxItem,ComboboxList,ComboboxTrigger,ComboboxValue} from '@/components/motion/combobox';
import {MultiSelect,MultiSelectContent,MultiSelectInput,MultiSelectItem,MultiSelectList,MultiSelectTrigger,MultiSelectValue} from '@/components/motion/multi-select';
import '@/styles.css';
window.pi={platform:'darwin'};
const OPTIONS=${rows};
const Row=({label,desc,marker})=>React.createElement('span',{className:'flex min-w-0 flex-col','data-check-row':marker},[
  React.createElement('span',{key:'t',className:'truncate'},label),
  React.createElement('span',{key:'d',className:'text-[10px] leading-4 text-muted-foreground'},desc)
]);
function Shell(){
  const [v1,setV1]=React.useState('workspace-write');
  const [v2,setV2]=React.useState('read-only');
  const [v3,setV3]=React.useState(['read-only']);
  return React.createElement('div',{className:'flex min-h-screen items-start gap-16 p-8'},
    React.createElement(Select,{value:v1,onValueChange:setV1,open:true,className:'w-64'},
      React.createElement(SelectTrigger,{className:'h-8 w-full text-xs'},React.createElement(SelectValue)),
      React.createElement(SelectContent,null,OPTIONS.map(([value,label,desc])=>React.createElement(SelectItem,{key:value,value},React.createElement(Row,{label,desc,marker:'select'}))))),
    React.createElement(Combobox,{value:v2,onValueChange:setV2,open:true,className:'w-64'},
      React.createElement(ComboboxTrigger,{className:'h-8 text-xs'},React.createElement(ComboboxValue,{placeholder:'combobox'})),
      React.createElement(ComboboxContent,null,
        React.createElement(ComboboxList,{ariaLabel:'combobox options'},OPTIONS.map(([value,label,desc])=>React.createElement(ComboboxItem,{key:value,value,textValue:label},React.createElement(Row,{label,desc,marker:'combobox'})))))),
    React.createElement(MultiSelect,{value:v3,onValueChange:setV3,open:true,className:'w-64'},
      React.createElement(MultiSelectTrigger,{className:'h-8'},
        React.createElement(MultiSelectValue,{placeholder:'multi'}),
        React.createElement(MultiSelectInput,{placeholder:'multi','aria-label':'multi'})),
      React.createElement(MultiSelectContent,null,
        React.createElement(MultiSelectList,{ariaLabel:'multi options'},OPTIONS.map(([value,label,desc])=>React.createElement(MultiSelectItem,{key:value,value,textValue:label},React.createElement(Row,{label,desc,marker:'multiselect'})))))));
}
window.checkRoot=createRoot(document.getElementById('root'));flushSync(()=>window.checkRoot.render(React.createElement(Shell)));
/** Geometry of every open panel: its padding above the first row must equal its
 *  padding below the last one, and none of its content may be clipped. */
window.read=()=>{
  const panels=[['select',document.querySelector('[data-check-row="select"]')?.closest('[role="listbox"]')],
    ['combobox',document.querySelector('[data-check-row="combobox"]')?.closest('[data-combobox-content]')],
    ['multiselect',document.querySelector('[data-check-row="multiselect"]')?.closest('[data-multi-select-content]')]];
  return panels.map(([name,panel])=>{
    if(!panel)return{name,missing:true};
    const box=panel.getBoundingClientRect();
    const options=[...panel.querySelectorAll('[role="option"]')];
    const first=options[0]?.getBoundingClientRect(),last=options[options.length-1]?.getBoundingClientRect();
    const inner=panel.firstElementChild;
    return{name,rows:options.length,
      panelHeight:+box.height.toFixed(2),clientHeight:panel.clientHeight,
      innerHeight:inner?inner.offsetHeight:null,
      clipped:inner?+(inner.offsetHeight-panel.clientHeight).toFixed(2):null,
      topGap:first?+(first.top-box.top).toFixed(2):null,
      bottomGap:last?+(box.bottom-last.bottom).toFixed(2):null};
  });
};
</script></body></html>`

let child, ws, server
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), {
      name: 'fixture',
      configureServer(server) {
        server.middlewares.use(fixturePath, async (_req, res, next) => {
          try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:900,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return; await pause(50) }
    throw new Error('fixture never settled: ' + expression + '\n' + JSON.stringify(exceptions))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await waitFor(`typeof window.read === 'function' && window.read().every((p)=>!p.missing && p.rows === 3)`)
  await evaluate(`document.fonts.ready`)
  // The panels open through a spring, so wait for the height to stop moving
  // (three identical samples) — then the geometry is at rest.
  let last = null, stable = 0
  for (let i = 0; i < 60 && stable < 3; i++) {
    const sample = JSON.stringify((await evaluate('window.read()')).map((p) => [p.panelHeight, p.innerHeight]))
    stable = sample === last ? stable + 1 : 0
    last = sample
    await pause(100)
  }
  const panels = await evaluate('window.read()')
  const shotDir = process.env.PI_SELECT_PADDING_SCREENSHOT_DIR
  if (shotDir) {
    await mkdir(shotDir, { recursive: true })
    const image = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(shotDir, 'panels.png'), Buffer.from(image.data, 'base64'))
  }

  for (const panel of panels) {
    assert.ok(!panel.missing, `${panel.name}: the panel rendered`)
    assert.equal(panel.rows, 3, `${panel.name}: three options`)
    // 1. The panel's own borders must be inside the animated height — a panel
    //    that settles short clips its BOTTOM padding (the reported bug: 5px
    //    above the first row, 3px below the last).
    assert.ok(
      panel.clipped <= 0.5,
      `${panel.name}: nothing clipped (inner ${panel.innerHeight} vs client ${panel.clientHeight})`
    )
    // 2. The invariant itself: equal inner padding top and bottom.
    assert.ok(
      Math.abs(panel.topGap - panel.bottomGap) <= 0.5,
      `${panel.name}: inner padding is symmetric (top ${panel.topGap}, bottom ${panel.bottomGap})`
    )
  }
  assert.deepEqual(exceptions, [], 'no renderer exceptions: ' + JSON.stringify(exceptions.map((entry) => entry.exceptionDetails?.exception?.description ?? entry)))
  console.log('check-select-panel-padding: all assertions passed')
  console.log(JSON.stringify(panels))
} finally {
  try { ws?.close() } catch { /* already closed */ }
  child?.kill('SIGTERM')
  await server?.close()
}
