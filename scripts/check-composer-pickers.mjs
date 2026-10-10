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
 * The final scenario streams a synthetic run and drives the real General
 * section: the pickers freeze while the run is live, the switch (persisted in
 * main, re-read when Settings closes) lets both through, an allowed pick
 * dispatches to main, and turning the switch back off freezes the still-live
 * run until it settles.
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
contextBridge.exposeInMainWorld('fixture',{resize:(w,h)=>ipcRenderer.invoke('fixture:resize',w,h),escalate:request=>ipcRenderer.invoke('fixture:escalation',request),decisions:()=>ipcRenderer.invoke('fixture:decisions'),streaming:(on)=>ipcRenderer.invoke('fixture:streaming',on),calls:()=>ipcRenderer.invoke('fixture:calls')});`)
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
 let active=model,thinkingLevel='high',streaming=false,midRun=false;
 const modelCalls=[],modeCalls=[],midRunCalls=[];
 const levels=()=>!active.reasoning?['off']:active===model?['off','minimal','low','medium','high','xhigh','max']:['off','high'];
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/new',cwd:'/workspace/pi-app',projectless:false,messages:[],model:active,thinkingLevel,availableThinkingLevels:levels(),isStreaming:streaming,eventSequence:0});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,
   checkpointsEnabled:true,debugEnabled:false,startup:'resume',sandboxMode:'workspace-write',sandbox:{support:'host',backend:null},
   askUserTimeoutSeconds:120,responseTimeoutSeconds:60,allowMidRunChanges:midRun,subagentsEnabled:true,subagentMaxConcurrent:4,
   subagentReuseEnabled:false,subagentCommsEnabled:false,subagentTurnLimitOverrideEnabled:false,subagentMaxTurns:null,
   browserConsent:false,browserAgentToolsEnabled:false}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[]);
 ipcMain.handle('pi:models',()=>[model,other,standard]);
 ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:setModel',async(_,providerId,id)=>{modelCalls.push([providerId,id]);await new Promise(r=>setTimeout(r,240));active=id==='plain'?standard:providerId==='minimax'?other:model;return snapshot()});
 ipcMain.handle('pi:setThinkingLevel',(_,level)=>{thinkingLevel=level;return snapshot()});
 ipcMain.handle('sandbox:setMode',(_,sessionPath,mode)=>{modeCalls.push(mode);return {...snapshot(),sessionPath,sandboxMode:mode}});
 ipcMain.handle('app:setAllowMidRunChanges',(_,enabled)=>{midRun=enabled===true;midRunCalls.push(midRun);return midRun});
 ipcMain.handle('fixture:streaming',(_,on)=>{streaming=on===true;w.webContents.send('pi:event',{type:streaming?'agent_start':'agent_settled',sessionId:'fixture',sessionPath:'/fixture/new',...(streaming?{}:{continuing:false})});return streaming});
 ipcMain.handle('fixture:calls',()=>({models:modelCalls,modes:modeCalls,midRun:midRunCalls}));
 ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('files:read',(_,path)=>({path,relPath:path,kind:'text',size:12}));
 ipcMain.handle('fixture:resize',(_,width,height)=>w.setBounds({width,height}));
 const decisions=[];
 ipcMain.handle('fixture:decisions',()=>decisions);
 ipcMain.handle('fixture:escalation',(_,request)=>{
   streaming=true;
   w.webContents.send('pi:event',{type:'agent_start',sessionId:'fixture',sessionPath:'/fixture/new'});
   w.webContents.send('pi:event',{type:'sandbox_escalation',sessionId:'fixture',sessionPath:'/fixture/new',requests:[request]});
 });
 ipcMain.handle('sandbox:respondEscalation',(_,requestId,sessionPath,decision)=>{
   decisions.push({requestId,sessionPath,decision});
   w.webContents.send('pi:event',{type:'sandbox_escalation',sessionId:'fixture',sessionPath:'/fixture/new',requests:[]});
   return true;
 });
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
    const state = await evaluate(`({model:document.querySelector('button[aria-controls="model-picker-panel"]')?.textContent,open:document.getElementById('model-picker-panel')?.getAttribute('aria-hidden'),selected:[...document.querySelectorAll('[data-model-option][aria-selected="true"]')].map(row=>row.dataset.modelOption),focus:document.activeElement?.outerHTML})`)
    await screenshot('failure')
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(state) + '\n' + JSON.stringify(exceptions) + '\n' + output.slice(-2000))
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
  // panel. The level panel is anchored to one row, so scrolling the list
  // beneath it dismisses the cascade — a panel that slid along a moving list
  // would point at a row that is no longer the one it was opened from. The
  // model panel itself stays open.
  await evaluate(`(()=>{
    const row=document.querySelector('[data-model-option="minimax/m27"]');
    const list=document.getElementById('model-picker-panel').firstElementChild;
    list.style.maxHeight='112px';
    list.scrollTop=row.offsetTop-list.offsetTop-24;
  })()`)
  await pause(200)
  assert.ok(await evaluate(`document.getElementById('model-picker-panel').firstElementChild.scrollTop>0`), 'the fixture really scrolls the list')
  await waitFor(`!document.querySelector('[data-thinking-panel]')`)
  assert.equal(await isOpen(MODEL), true, 'scrolling the list keeps the model panel open')
  // Reopen on the row, now unscrolled: the following checks need the cascade
  // open, and the picker must keep working after a scroll.
  await evaluate(`(()=>{const list=document.getElementById('model-picker-panel').firstElementChild;list.scrollTop=0;list.style.maxHeight=''})()`)
  await pause(200)
  await click(`document.querySelector('[data-model-option="minimax/m27"]')`)
  await waitFor(`document.querySelector('[data-thinking-option="high"]')`)
  await pause(250)
  assert.deepEqual((await thinkingGeometry('minimax/m27')).options, ['off', 'high'], 'the cascade reopens on the row after the list scrolled')

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

  // Production permission cards share the editor's width, including narrow
  // chats after a window resize. Long commands and file content stay complete.
  const command = `printf '%s\\n' '${'long-unbroken-command-'.repeat(240)}'\n` + Array.from({ length: 35 }, (_, i) => `printf 'line ${i} 中文\\n'`).join('\n')
  const requestBase = { sessionId: 'fixture', sessionPath: '/fixture/new', toolCallId: 'approval-call', currentMode: 'workspace-write', requestedMode: 'danger-full-access', justification: 'Review the complete operation before allowing this call.', createdAt: Date.now() }
  const geometry = () => evaluate(`(()=>{
    const card=document.querySelector('[data-sandbox-escalation]'),form=document.querySelector('[data-prompt-editor]').closest('form');
    const a=card.getBoundingClientRect(),b=form.getBoundingClientRect(),details=card.querySelector('[data-fade-scroll]');
    return {left:a.left,right:a.right,formLeft:b.left,formRight:b.right,client:details.clientWidth,scroll:details.scrollWidth,
      capped:details.scrollHeight>details.clientHeight,detailsVisible:details.getBoundingClientRect().height>0&&!details.closest('[aria-hidden="true"],[inert]'),
      bottom:b.bottom,viewport:innerHeight,text:card.textContent};
  })()`)
  const checkWidth = async () => {
    const g = await geometry()
    assert.ok(Math.abs(g.left - g.formLeft) <= 1 && Math.abs(g.right - g.formRight) <= 1, `approval and editor edges match: ${show(g)}`)
    assert.ok(g.scroll <= g.client + 1, 'full details wrap without horizontal overflow')
    assert.ok(g.bottom <= g.viewport, 'approval leaves the composer reachable')
  }
  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    await evaluate(`localStorage.setItem('pi-app:locale',${JSON.stringify(locale)})`)
    await send('Page.reload')
    await waitFor(`document.documentElement?.lang===${JSON.stringify(locale)} && document.querySelector('[data-prompt-editor]') && !!window.fixture`)
    await evaluate(`window.fixture.resize(1460,940)`)
    const request = { ...requestBase, requestId: 'bash-' + locale, toolName: 'bash', operation: { cwd: '/workspace/pi-app', parameters: { command, timeout: 20 } } }
    await evaluate(`window.fixture.escalate(${JSON.stringify(request)})`)
    await waitFor(`document.querySelector('[data-sandbox-operation-parameter="command"]')`)
    await pause(300)
    assert.equal(await evaluate(`document.querySelector('[data-sandbox-operation-parameter="command"] code').textContent`), command, 'the entire multiline command is readable')
    assert.equal((await geometry()).detailsVisible, true, 'the full operation stays visible')
    assert.equal(await evaluate(`document.querySelector('[data-sandbox-escalation] button[aria-expanded]')===null`), true, 'permission details have no collapse control')
    assert.equal((await geometry()).capped, true, 'long operations scroll within a bounded card')
    for (const width of [1460, 980, 760]) {
      await evaluate(`window.fixture.resize(${width},780)`)
      await pause(200)
      await checkWidth()
    }
    await evaluate(`window.fixture.resize(760,560)`)
    await pause(200)
    await checkWidth()
    await evaluate(`window.fixture.resize(760,780)`)
    await pause(200)
    if (locale !== 'en') assert.doesNotMatch((await geometry()).text, /Approval required|Allow once|Deny|View details/, 'approval copy follows the selected locale')
    await screenshot('permission-' + locale)
    assert.equal((await geometry()).detailsVisible, true, 'permission details remain visible after resizing')
    await evaluate(`(()=>{const details=document.querySelector('[data-sandbox-escalation] [data-fade-scroll]');details.scrollTop=details.scrollHeight})()`)
    await pause(100)
    assert.ok(await evaluate(`document.querySelector('[data-sandbox-escalation] [data-fade-scroll]').scrollTop>0`), 'the complete operation can be scrolled to its end')
    await evaluate(`document.querySelector('[data-sandbox-escalation]').querySelectorAll('button')[0].click()`)
    await waitFor(`!document.querySelector('[data-sandbox-escalation]')`)
    assert.deepEqual((await evaluate(`window.fixture.decisions()`)).at(-1), { requestId: request.requestId, sessionPath: request.sessionPath, decision: 'approve' }, 'allow once answers the exact pending request')
  }
  const content = 'complete file content 中文\n'.repeat(1500)
  const writeRequest = { ...requestBase, requestId: 'write-complete', toolName: 'write', operation: { cwd: '/workspace/pi-app', parameters: { path: '/outside/' + 'long-file-name-'.repeat(80) + '.txt', content } } }
  await evaluate(`window.fixture.escalate(${JSON.stringify(writeRequest)})`)
  await waitFor(`document.querySelector('[data-sandbox-operation-parameter="content"]')`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-sandbox-operation-parameter="path"] code').textContent`), writeRequest.operation.parameters.path)
  assert.equal(await evaluate(`document.querySelector('[data-sandbox-operation-parameter="content"] code').textContent`), content, 'file details retain all original content and line breaks')
  await checkWidth()
  await screenshot('permission-write')
  await evaluate(`document.querySelector('[data-sandbox-escalation]').querySelectorAll('button')[1].click()`)
  await waitFor(`!document.querySelector('[data-sandbox-escalation]')`)
  assert.deepEqual((await evaluate(`window.fixture.decisions()`)).at(-1), { requestId: writeRequest.requestId, sessionPath: writeRequest.sessionPath, decision: 'deny' }, 'deny answers the exact pending request')

  const edits = [{ oldText: 'before\nsecond line', newText: 'after 中文\nsecond line' }]
  const editRequest = { ...requestBase, requestId: 'edit-details', toolName: 'edit', operation: { cwd: '/workspace/pi-app', parameters: { path: '/outside/permission-test.txt', edits } } }
  await evaluate(`window.fixture.escalate(${JSON.stringify(editRequest)})`)
  await waitFor(`document.querySelector('[data-sandbox-operation-parameter="edits"]')`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-sandbox-operation-parameter="edits"] code').textContent`), JSON.stringify(edits, null, 2), 'edit approval displays complete before/after text')
  await checkWidth()
  await screenshot('permission-edit')

  // --- Mid-run switches (Settings → General) -------------------------------
  // The bottom-row model and permission pickers freeze while a run streams
  // unless the General switch allows it. This claims the whole path, not just
  // the Composer prop: the flag is read from appInfo at boot and re-read when
  // Settings closes, and an allowed pick must reach main's IPC.
  await evaluate(`localStorage.setItem('pi-app:locale','en')`)
  await send('Page.reload')
  await waitFor(`document.documentElement?.lang==='en' && document.querySelector('[data-prompt-editor]') && !!window.fixture`)
  await evaluate(`window.fixture.resize(1460,940)`)
  // A reload boots from the fixture's main-process state, which the escalation
  // leg above left streaming; settle it before the idle claims.
  await evaluate(`window.fixture.streaming(false)`)
  await waitFor(`(${MODEL}).disabled===false`)
  const frozen = () => evaluate(`({model:(${MODEL}).disabled===true,sandbox:(${SANDBOX}).disabled===true})`)
  const midRunSwitch = `document.querySelector('button[role="checkbox"][aria-label="Change model and permissions during a run"]')`
  // Settings owns its entrance/exit motion, so this scenario drives it with
  // DOM clicks (the picker geometry part above already owns real pointer
  // input): coordinates captured mid-animation can miss a moving target.
  const openSettings = async () => {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Settings').click()`)
    await waitFor(`Boolean(${midRunSwitch})`)
    await pause(400)
  }
  const closeSettings = async () => {
    await evaluate(`document.querySelector('button[aria-label="Back to chat"]').click()`)
    // The page is removed on exit completion; an exit that never completes
    // leaves an invisible full-window container behind, so the wait is on the
    // container itself, not just its back button.
    await waitFor(`!document.querySelector('.window-page.absolute.inset-0.z-40')`)
    await waitFor(`!document.querySelector('button[aria-label="Back to chat"]')`)
  }
  const fixtureCalls = () => evaluate(`window.fixture.calls()`)

  // Idle with the setting off, both pickers are usable as before.
  assert.deepEqual(await frozen(), { model: false, sandbox: false }, 'idle with mid-run switches off: both pickers are usable')

  // The General switch lets them through and saves through main; the idle
  // close claims the plain Settings round trip before the stream starts.
  await openSettings()
  assert.equal(await evaluate(`${midRunSwitch}.getAttribute('data-state')`), 'unchecked', 'the mid-run switch starts off')
  await evaluate(`${midRunSwitch}.click()`)
  await waitFor(`${midRunSwitch}.getAttribute('data-state')==='checked'`)
  await closeSettings()
  let calls = await fixtureCalls()
  assert.deepEqual(calls.midRun, [true], 'the General switch reaches main')

  // Off is the default rule, but with the switch on a streaming run keeps both
  // triggers usable — and a frozen trigger still cannot open its panel.
  await evaluate(`window.fixture.streaming(true)`)
  await waitFor(`(${MODEL}).disabled===false`)
  assert.deepEqual(await frozen(), { model: false, sandbox: false }, 'mid-run switches on: both pickers stay usable while the run streams')

  // An allowed mid-run pick really dispatches for both pickers.
  const modelsBefore = calls.models.length
  await click(MODEL)
  await waitFor(`document.getElementById(${MODEL}.getAttribute('aria-controls')).getAttribute('aria-hidden')==='false'`)
  await pause(500)
  await click(`document.querySelector('[data-model-option="minimax/m27"]')`)
  await waitFor(`(${MODEL}).textContent.includes('MiniMax')`)
  calls = await fixtureCalls()
  assert.equal(calls.models.length, modelsBefore + 1, 'the mid-run model pick sends one switch')
  assert.deepEqual(calls.models.at(-1), ['minimax', 'm27'], 'and it carries the picked model')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
  await pause(300)
  const modesBefore = calls.modes.length
  await click(SANDBOX)
  await waitFor(`Boolean(document.querySelector('[data-sandbox-mode-option="read-only"]'))`)
  await pause(400)
  await click(`document.querySelector('[data-sandbox-mode-option="read-only"]')`)
  await waitFor(`(${SANDBOX}).textContent.includes('Read only')`)
  calls = await fixtureCalls()
  assert.equal(calls.modes.length, modesBefore + 1, 'the mid-run permission pick sends one switch')
  assert.equal(calls.modes.at(-1), 'read-only', 'and it carries the picked mode')

  // Back off: the frozen rule returns for a run that is still streaming, and
  // the run settling frees the pickers again even with the setting off.
  await openSettings()
  await evaluate(`${midRunSwitch}.click()`)
  await waitFor(`${midRunSwitch}.getAttribute('data-state')==='unchecked'`)
  await closeSettings()
  await waitFor(`(${MODEL}).disabled===true`)
  assert.deepEqual(await frozen(), { model: true, sandbox: true }, 'turning the switch off freezes a still-streaming run again')
  await evaluate(`window.fixture.streaming(false)`)
  await waitFor(`(${MODEL}).disabled===false`)
  assert.deepEqual(await frozen(), { model: false, sandbox: false }, 'the settled run frees the pickers with the setting off')
  assert.deepEqual((await fixtureCalls()).midRun, [true, false], 'both switch states reached main')

  // The flow the feature exists for: a page that is already busy before its
  // first Settings visit. A reload boots busy from the fixture's main-process
  // state, so this is a fresh session whose only Settings round trip happens
  // mid-run — including its exit, which must not leave an invisible overlay.
  await evaluate(`window.fixture.streaming(true)`)
  await send('Page.reload')
  await waitFor(`document.documentElement?.lang==='en' && document.querySelector('[data-prompt-editor]') && !!window.fixture`)
  await evaluate(`window.fixture.resize(1460,940)`)
  await waitFor(`(${MODEL}).disabled===true`)
  await openSettings()
  await evaluate(`${midRunSwitch}.click()`)
  await waitFor(`${midRunSwitch}.getAttribute('data-state')==='checked'`)
  await closeSettings()
  await waitFor(`(${MODEL}).disabled===false`)
  assert.deepEqual(await frozen(), { model: false, sandbox: false }, 'the switch turned on mid-run frees the pickers of a session that booted busy')
  await evaluate(`window.fixture.streaming(false)`)
  await waitFor(`(${MODEL}).disabled===false`)

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: composer pickers — centered thinking menus with stable first-frame options/heights, non-reasoning→reasoning switches, scrolling and viewport bounds; model/sandbox panels remain anchored, unclipped and on top through panel dragging')
  console.log('PASS: permission cards — complete multiline commands and writes, always-visible details, bounded scrolling, composer-aligned widths after resizing, all locales and request-specific allow/deny')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await rm(temporary, { recursive: true, force: true })
}
