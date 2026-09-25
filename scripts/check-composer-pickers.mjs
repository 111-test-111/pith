/**
 * The composer's two pickers — the merged model menu and the sandbox mode —
 * are layout-anchored: a panel the LAYOUT anchors to its trigger (`absolute`
 * against the trigger's own box), so it cannot drift off the trigger, be
 * clipped away, or hide behind the landing cards. Picking a reasoning model
 * opens its thinking levels beside the model list, centered on that row,
 * only after its supported levels arrive. The sandbox
 * picker lives in the bottom-right send
 * cluster, left of the context ring, and aligns its panel to the trigger's
 * RIGHT edge (a left-aligned panel there would run past the window). This
 * runs the real built app in isolated Electron (synthetic IPC, no model
 * calls, no user data) on the landing screen and checks both panels'
 * geometry, the cascade's geometry, stacking and no-typing rule, plus a
 * panel drag — the composer move that reports neither a window resize nor a
 * scroll, which is what let the old portalled model panel float away from
 * its trigger.
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
 const standard={...other,id:'plain',name:'Standard',reasoning:false};
 let active=model,thinkingLevel='high';
 const levels=()=>!active.reasoning?['off']:active===model?['off','minimal','low','medium','high','xhigh','max']:['off','high'];
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/new',cwd:'/workspace/pi-app',projectless:false,messages:[],model:active,thinkingLevel,availableThinkingLevels:levels(),isStreaming:false,eventSequence:0});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[]);
 ipcMain.handle('pi:models',()=>[model,other,standard]);
 ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:setModel',async(_,providerId,id)=>{await new Promise(r=>setTimeout(r,240));active=id==='plain'?standard:providerId==='minimax'?other:model;return snapshot()});
 ipcMain.handle('pi:setThinkingLevel',(_,level)=>{thinkingLevel=level;return snapshot()});
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
  await waitFor(`document.querySelector('[data-prompt-editor]') && document.querySelector('[data-panel-handle]')`)

  // The two composer triggers, told apart by what they carry: the model's
  // name and the sandbox glyph. The model's thinking level has no trigger of
  // its own any more — it lives in the model menu's second-level panel.
  const MODEL = `document.querySelector('button[aria-controls="model-picker-panel"]')`
  const SANDBOX = `document.querySelector('button[aria-haspopup=listbox]:has([data-sandbox-mode-icon])')`
  assert(await evaluate(`Boolean(${MODEL})`), 'the model trigger is in the composer')
  assert(await evaluate(`Boolean(${SANDBOX})`), 'the sandbox trigger is in the composer')
  assert.equal(await evaluate(`document.querySelectorAll('form button[aria-haspopup=listbox]').length`), 2, 'the model and thinking pickers merged into one trigger beside the sandbox picker')

  // The layout the merge implies: one model trigger leads the composer's
  // row; the sandbox picker sits in the bottom-right send cluster (right of
  // the textarea's middle, left of the send button).
  const leftOf = (trigger) => evaluate(`(${trigger}).getBoundingClientRect().left`)
  const [modelLeft, sandboxLeft] = [await leftOf(MODEL), await leftOf(SANDBOX)]
  const composerArea = await evaluate(`(()=>{const r=document.querySelector('[data-prompt-viewport]').getBoundingClientRect();return {left:r.left,right:r.right}})()`)
  assert.ok(modelLeft < sandboxLeft, `model then sandbox read left to right (${[modelLeft, sandboxLeft]})`)
  assert.ok(
    sandboxLeft > composerArea.left + (composerArea.right - composerArea.left) / 2,
    `the sandbox picker sits in the right half of the composer (sandbox ${Math.round(sandboxLeft)}, composer ${Math.round(composerArea.left)}–${Math.round(composerArea.right)})`
  )

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
    return { dx: Math.round(p.left - t.left), dr: Math.round(p.right - t.right), dy: Math.round(p.top - t.bottom),
      panelWidth: Math.round(p.width), panelHeight: Math.round(p.height),
      triggerLeft: Math.round(t.left), triggerWidth: Math.round(t.width), triggerRight: Math.round(t.right),
      position: getComputedStyle(panel).position, topmost: !!hit && panel.contains(hit),
      clippers, hasInput: !!panel.querySelector('input,textarea,[contenteditable]') }
  }`)
  const facts = (trigger) => evaluate(`window.pickerFacts(${trigger})`)
  const isOpen = (trigger) => evaluate(`document.getElementById(${trigger}.getAttribute('aria-controls')).getAttribute('aria-hidden') === 'false'`)
  const show = (value) => JSON.stringify(value)

  // Both composer pickers: layout-anchored panels, no typing. The model menu
  // aligns its panel to the trigger's LEFT edge; the sandbox picker's trigger
  // sits at the composer's right edge, so its panel aligns to the trigger's
  // RIGHT edge instead.
  for (const [name, trigger, width, align] of [['model', MODEL, 320, 'left'], ['sandbox', SANDBOX, 288, 'right']]) {
    await click(trigger)
    await waitFor(`document.getElementById(${trigger}.getAttribute('aria-controls')).getAttribute('aria-hidden') === 'false'`)
    await pause(500)
    const measured = await facts(trigger)
    if (align === 'left') assert.ok(Math.abs(measured.dx) <= 1, `${name}: the panel starts on the trigger's left edge (${show(measured)})`)
    else assert.ok(Math.abs(measured.dr) <= 1, `${name}: the panel's right edge lands on the trigger's right edge (${show(measured)})`)
    assert.ok(measured.dy >= -14 && measured.dy <= 14, `${name}: and sits against its trigger's edge (${show(measured)})`)
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

  // The merged model menu's second level: picking a reasoning model pops the
  // thinking-level panel out BESIDE the model panel — centered on the
  // clicked row, a tight 4px gap between the two surfaces — layout-anchored
  // and unclipped, with no field to type in. Record every animation frame
  // across a delayed switch from seven levels to two: no old-model options
  // may flash, and the first painted height must already be the final height.
  await click(MODEL)
  await waitFor(`document.getElementById(${MODEL}.getAttribute('aria-controls')).getAttribute('aria-hidden') === 'false'`)
  await pause(500)
  await evaluate(`window.thinkingFrames=[];window.recordThinking=true;
    window.sampleThinking=()=>{
      if(!window.recordThinking)return;
      const sub=document.querySelector('[data-thinking-panel]');
      const row=document.querySelector('[data-model-option="minimax/m27"]').getBoundingClientRect();
      const box=sub?.getBoundingClientRect();
      window.thinkingFrames.push(sub?{height:sub.offsetHeight,
        centerDy:box.top+box.height/2-row.top-row.height/2,
        options:[...sub.querySelectorAll('[data-thinking-option]')].map(o=>o.dataset.thinkingOption)}:null);
      requestAnimationFrame(window.sampleThinking);
    };requestAnimationFrame(window.sampleThinking)`)
  await click(`document.querySelector('[data-model-option="minimax/m27"]')`)
  await waitFor(`Boolean(document.querySelector('[data-thinking-panel]'))`)
  await waitFor(`!document.querySelector('[data-thinking-option="off"]').disabled`)
  await pause(400)
  const frames = await evaluate(`window.recordThinking=false;window.thinkingFrames`)
  assert.ok(frames.includes(null), 'the submenu waits for the delayed target snapshot')
  const painted = frames.filter(Boolean)
  assert.ok(painted.length > 2, 'the submenu was sampled through its entrance')
  for (const frame of painted) {
    assert.deepEqual(frame.options, ['off', 'high'], 'only the target model levels are ever painted')
    assert.equal(frame.height, painted.at(-1).height, 'the first painted height is already final')
    assert.ok(Math.abs(frame.centerDy) <= 1, `entrance stays centered on the clicked row (${show(frame)})`)
  }
  const cascade = await evaluate(`(()=>{
    const panel=document.getElementById(${MODEL}.getAttribute('aria-controls'));
    const sub=document.querySelector('[data-thinking-panel]');
    const p=panel.getBoundingClientRect(), s=sub.getBoundingClientRect();
    const hit=document.elementFromPoint(s.left+Math.min(24,s.width/2), s.top+Math.min(20,s.height/2));
    const clippers=[];
    for (let a=sub.parentElement;a;a=a.parentElement){
      const st=getComputedStyle(a);
      if (st.overflow==='visible'&&st.overflowX==='visible'&&st.overflowY==='visible') continue;
      const r=a.getBoundingClientRect();
      if (s.left<r.left-0.5||s.right>r.right+0.5||s.top<r.top-0.5||s.bottom>r.bottom+0.5) clippers.push((a.className||a.tagName).toString().slice(0,60));
    }
    const row=document.querySelector('[data-model-option="minimax/m27"]').getBoundingClientRect();
    return { gapRight: Math.round(s.left-p.right), gapLeft: Math.round(s.right-p.left), dy: Math.round(s.top-p.top),
      centerDy: s.top+s.height/2-row.top-row.height/2, subWidth: Math.round(s.width),
      position: getComputedStyle(sub).position,
      topmost: !!hit && sub.contains(hit), clippers,
      hasInput: !!sub.querySelector('input,textarea,[contenteditable]') }
  })()`)
  assert.equal(cascade.position, 'absolute', `the level panel belongs to the layout, not to a portal (${show(cascade)})`)
  assert.ok(
    (cascade.gapRight >= 2 && cascade.gapRight <= 6) || (cascade.gapLeft >= -6 && cascade.gapLeft <= -2),
    `the level panel pops out beside the model panel with the tight gap (${show(cascade)})`)
  assert.ok(Math.abs(cascade.centerDy) <= 1, `the level panel is centered on the clicked row (${show(cascade)})`)
  assert.ok(cascade.subWidth > 100, `the level panel keeps its own width (${show(cascade)})`)
  assert.equal(cascade.topmost, true, `the level panel is painted above what it overlaps (${show(cascade)})`)
  assert.deepEqual(cascade.clippers, [], `no ancestor clips the level panel (${show(cascade)})`)
  assert.equal(cascade.hasInput, false, `the level panel is a pick-one list, with no field to type in (${show(cascade)})`)
  await screenshot('thinking-cascade')
  // Picking a level applies it and closes the whole cascade; the merged
  // trigger now carries the picked level beside the model name.
  await click(`document.querySelector('[data-thinking-option="off"]')`)
  await pause(500)
  assert.equal(await isOpen(MODEL), false, 'picking a level closes the model panel too')
  const mergedText = await evaluate(`(${MODEL}).textContent`)
  assert.match(mergedText, /Off|关闭/, `the merged trigger shows the picked level (got "${mergedText}")`)

  // The panel overlaps the landing cards, and it must cover them — a panel that
  // dropped into the layout could otherwise be painted underneath them.
  await click(MODEL)
  await pause(500)
  const overCards = await evaluate(`(()=>{
    const panel=document.getElementById(${MODEL}.getAttribute('aria-controls'));
    const p=panel.getBoundingClientRect();
    const composer=document.querySelector('[data-prompt-viewport]').getBoundingClientRect();
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

  const thinkingGeometry = (key) => evaluate(`(()=>{
    const sub=document.querySelector('[data-thinking-panel]'), s=sub.getBoundingClientRect();
    const row=document.querySelector('[data-model-option="${key}"]').getBoundingClientRect();
    const p=document.getElementById('model-picker-panel').getBoundingClientRect();
    return {centerDy:s.top+s.height/2-row.top-row.height/2,top:s.top,bottom:s.bottom,
      abovePanel:s.top<p.top,side:s.right<p.left?'left':'right',viewportHeight:innerHeight,
      options:[...sub.querySelectorAll('[data-thinking-option]')].map(o=>o.dataset.thinkingOption)};
  })()`)
  // The long menu is taller than this model list. It must be free to extend
  // above the list to center on its first row (the old panel clamp prevented it).
  await click(`document.querySelector('[data-model-option="deepseek/fixture"]')`)
  await waitFor(`document.querySelector('[data-thinking-option="max"]')`)
  await pause(250)
  const tall = await thinkingGeometry('deepseek/fixture')
  assert.equal(tall.options.length, 7)
  assert.ok(Math.abs(tall.centerDy) <= 1, `the tall menu centers on the first row (${show(tall)})`)
  assert.equal(tall.abovePanel, true, 'the model panel does not clamp the submenu to its own top')
  await screenshot('thinking-tall-centered')

  // The previous model's ['off'] list must not suppress a reasoning target.
  await click(`document.querySelector('[data-model-option="minimax/plain"]')`)
  await waitFor(`${MODEL}.textContent.includes('Standard')`)
  assert.equal(await isOpen(MODEL), false, 'a non-reasoning model closes the cascade')
  await click(MODEL)
  await click(`document.querySelector('[data-model-option="minimax/m27"]')`)
  await waitFor(`document.querySelector('[data-thinking-option="high"]')`)
  await pause(250)
  assert.deepEqual((await thinkingGeometry('minimax/m27')).options, ['off', 'high'], 'switching from a non-reasoning model opens the target levels')

  // A capped model list scrolls independently of the submenu's containing
  // panel. Center against the visible row, then follow another scroll.
  await evaluate(`(()=>{
    const row=document.querySelector('[data-model-option="minimax/m27"]');
    const list=document.getElementById('model-picker-panel').firstElementChild;
    list.style.maxHeight='112px';
    list.scrollTop=row.offsetTop-list.offsetTop-24;
  })()`)
  await pause(200)
  assert.ok(await evaluate(`document.getElementById('model-picker-panel').firstElementChild.scrollTop>0`), 'the fixture really scrolls the list')
  assert.ok(Math.abs((await thinkingGeometry('minimax/m27')).centerDy) <= 1, 'a scrolled row retains its centered submenu')
  await evaluate(`document.getElementById('model-picker-panel').firstElementChild.scrollTop+=8`)
  await pause(200)
  assert.ok(Math.abs((await thinkingGeometry('minimax/m27')).centerDy) <= 1, 'the open submenu follows subsequent scrolling')

  // Near the top/right viewport edges, keep the tall menu visible and flip
  // left. Moving only the fixture's trigger box preserves the real component.
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    (()=>{const list=document.getElementById('model-picker-panel').firstElementChild;
    list.style.maxHeight='';list.scrollTop=0;
    const root=${MODEL}.parentElement;root.style.position='fixed';root.style.top='0';root.style.left=(innerWidth-328)+'px';})()`)
  await evaluate(`${MODEL}.click()`)
  await pause(250)
  await evaluate(`document.querySelector('[data-model-option="deepseek/fixture"]').click()`)
  await waitFor(`document.querySelector('[data-thinking-option="max"]')`)
  await pause(250)
  const edge = await thinkingGeometry('deepseek/fixture')
  assert.equal(edge.side, 'left', `the submenu flips left at the right edge (${show(edge)})`)
  assert.ok(edge.top >= 7 && edge.top <= 9, `the viewport alone limits upward expansion (${show(edge)})`)
  assert.ok(edge.bottom <= edge.viewportHeight - 7, 'the whole menu remains in the viewport')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: composer pickers — centered thinking menus with stable first-frame options/heights, non-reasoning→reasoning switches, scrolling and viewport bounds; model/sandbox panels remain anchored, unclipped and on top through panel dragging')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await rm(temporary, { recursive: true, force: true })
}
