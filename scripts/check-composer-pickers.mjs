/**
 * The composer's two pickers — the model and the sandbox mode — are the same
 * `Select`: a panel the LAYOUT anchors to its trigger (`absolute left-0
 * top-full`), so it cannot drift off the trigger, be clipped away, or hide
 * behind the landing cards. This runs the real built app in isolated Electron
 * (synthetic IPC, no model calls, no user data) on the landing screen and
 * checks both panels' geometry, stacking and no-typing rule, plus a panel drag
 * — the composer move that reports neither a window resize nor a scroll, which
 * is what let the old portalled model panel float away from its trigger.
 *
 * Run after `npm run build`. PI_PICKER_SCREENSHOT_DIR retains the views.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-composer-pickers-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child, ws
try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{resize:(w,h)=>ipcRenderer.invoke('fixture:resize',w,h)});`)
  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text','image'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const other={providerId:'minimax',providerName:'MiniMax CN',id:'m27',name:'MiniMax-M2.7',reasoning:true,input:['text'],contextWindow:205000,available:true,costInputPerM:0,costOutputPerM:0};
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/new',cwd:'/workspace/pi-app',projectless:false,messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false,eventSequence:0});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[]);
 ipcMain.handle('pi:models',()=>[model,other]);
 ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('files:read',(_,path)=>({path,relPath:path,kind:'text',size:12}));
 ipcMain.handle('fixture:resize',(_,width,height)=>w.setBounds({width,height}));
 const w=new BrowserWindow({...windowChromeOptions(),width:1320,height:880,minWidth:760,minHeight:560,title:'Pith composer pickers check',backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 w.loadFile(${JSON.stringify(join(repo, 'out/renderer/index.html'))});
});app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })
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
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page')
    if (!page) await pause(50)
  }
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
    for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(exceptions) + '\n' + output.slice(-2000))
  }
  const clickAt = async (point) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const click = async (elementExpression) => {
    const point = await evaluate(`(()=>{const r=(${elementExpression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await clickAt(point)
    await pause(400)
  }
  const screenshot = async (name) => {
    if (!process.env.PI_PICKER_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_PICKER_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_PICKER_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }

  await send('Runtime.enable')
  // The left sidebar's strip is `data-panel-handle="right"` (it grows rightward).
  await waitFor(`document.querySelector('textarea') && document.querySelector('[data-panel-handle]')`)

  // The two composer triggers, told apart by what they carry: the model's name,
  // and the sandbox glyph.
  const MODEL = `[...document.querySelectorAll('button[aria-haspopup=listbox]')].find(b=>b.textContent.includes('DeepSeek V4.1 Flash'))`
  const SANDBOX = `document.querySelector('button[aria-haspopup=listbox]:has([data-sandbox-mode-icon])')`
  assert(await evaluate(`Boolean(${MODEL})`), 'the model trigger is in the composer')
  assert(await evaluate(`Boolean(${SANDBOX})`), 'the sandbox trigger is in the composer')

  // Every claim about a panel, measured in one pass: where it sits relative to
  // its trigger, whether it is the topmost thing at its own point (a panel
  // behind the landing cards would fail here), whether any clipping ancestor
  // cuts it, and whether it offers a field to type in.
  await evaluate(`window.pickerFacts = (trigger) => {
    const panel = document.getElementById(trigger.getAttribute('aria-controls'))
    const t = trigger.getBoundingClientRect(), p = panel.getBoundingClientRect()
    const hit = document.elementFromPoint(p.left + Math.min(24, p.width / 2), p.top + Math.min(20, Math.max(p.height - 4, 4)))
    const clippers = []
    for (let a = panel.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.overflow === 'visible' && s.overflowX === 'visible' && s.overflowY === 'visible') continue
      const r = a.getBoundingClientRect()
      if (p.left < r.left - 0.5 || p.right > r.right + 0.5 || p.top < r.top - 0.5 || p.bottom > r.bottom + 0.5)
        clippers.push((a.className || a.tagName).toString().slice(0, 60))
    }
    return { dx: Math.round(p.left - t.left), dy: Math.round(p.top - t.bottom),
      panelWidth: Math.round(p.width), panelHeight: Math.round(p.height),
      triggerLeft: Math.round(t.left), triggerWidth: Math.round(t.width),
      position: getComputedStyle(panel).position, topmost: !!hit && panel.contains(hit),
      clippers, hasInput: !!panel.querySelector('input,textarea,[contenteditable]') }
  }`)
  const facts = (trigger) => evaluate(`window.pickerFacts(${trigger})`)
  const isOpen = (trigger) => evaluate(`document.getElementById(${trigger}.getAttribute('aria-controls')).getAttribute('aria-hidden') === 'false'`)
  const show = (value) => JSON.stringify(value)

  // Both composer pickers: the same control, the same anchoring, no typing.
  for (const [name, trigger, width] of [['model', MODEL, 320], ['sandbox', SANDBOX, 288]]) {
    await click(trigger)
    await waitFor(`document.getElementById(${trigger}.getAttribute('aria-controls')).getAttribute('aria-hidden') === 'false'`)
    await pause(500)
    const measured = await facts(trigger)
    assert.ok(Math.abs(measured.dx) <= 1, `${name}: the panel starts on the trigger's left edge (${show(measured)})`)
    assert.ok(measured.dy >= 0 && measured.dy <= 14, `${name}: and hangs off its bottom edge (${show(measured)})`)
    assert.equal(measured.position, 'absolute', `${name}: the panel belongs to the layout, not to a portal`)
    assert.equal(measured.panelWidth, width, `${name}: the panel keeps its own width (${show(measured)})`)
    assert.equal(measured.topmost, true, `${name}: the panel is painted above the landing content (${show(measured)})`)
    assert.deepEqual(measured.clippers, [], `${name}: no ancestor clips the panel (${show(measured)})`)
    assert.equal(measured.hasInput, false, `${name}: the panel is a pick-one list, with no field to type in`)
    await screenshot(`${name}-panel`)
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
    await pause(400)
    assert.equal(await isOpen(trigger), false, `${name}: Escape closes the panel`)
  }

  // The panel overlaps the landing cards, and it must cover them — a panel that
  // dropped into the layout could otherwise be painted underneath them.
  await click(MODEL)
  await pause(500)
  const overCards = await evaluate(`(()=>{
    const panel=document.getElementById(${MODEL}.getAttribute('aria-controls'));
    const p=panel.getBoundingClientRect();
    const composer=document.querySelector('textarea').getBoundingClientRect();
    const hit=document.elementFromPoint(p.left+40, p.bottom-6);
    return {reachesPastComposer:p.bottom>composer.bottom+20, hitInside:!!hit&&panel.contains(hit), hitTag:hit?hit.tagName:'none'};
  })()`)
  assert.equal(overCards.reachesPastComposer, true, `the panel overlaps what is below the composer (${show(overCards)})`)
  assert.equal(overCards.hitInside, true, `and it covers what it overlaps (${show(overCards)})`)

  // The real-world move the old measurement could not see: dragging the panel
  // widths writes CSS variables, reflowing the composer with no window resize
  // and no scroll event. (The panel is closed first — a pointerdown outside it
  // dismisses a Select, which is its own rule.) Reopening at the new position
  // must not remember the composer's old edge.
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
  await pause(400)
  const before = await facts(MODEL)
  const handle = await evaluate(`(()=>{const r=[...document.querySelectorAll('[data-panel-handle]')].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)[0].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+80}})()`)
  const pointer = (type, x) => ({ type, x, y: handle.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', pointer('mousePressed', handle.x))
  await send('Input.dispatchMouseEvent', pointer('mouseMoved', handle.x + 60))
  await send('Input.dispatchMouseEvent', pointer('mouseMoved', handle.x + 120))
  await send('Input.dispatchMouseEvent', pointer('mouseReleased', handle.x + 120))
  await pause(600)
  const moved = await facts(MODEL)
  assert.notEqual(moved.triggerLeft, before.triggerLeft, 'the drag really moved the composer')
  await click(MODEL)
  await pause(500)
  const after = await facts(MODEL)
  assert.equal(await isOpen(MODEL), true, 'the panel opens at the new position')
  assert.ok(Math.abs(after.dx) <= 1, `and lands on its trigger's edge there too (${show(after)})`)
  await screenshot('after-panel-drag')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: composer pickers — the model and sandbox Selects are anchored to their triggers, unclipped and on top, with no field to type in, and follow a panel drag')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await rm(temporary, { recursive: true, force: true })
}
