/**
 * The session list's bottom edge, in the built renderer with synthetic sessions
 * and an isolated profile (no model calls, no user data).
 *
 * The list carries NO bottom padding — neither its own scrollport nor the
 * sidebar content shell around it — so the last row reaches the panel's bottom
 * line instead of stopping 44px short of it. And because the list is flush, the
 * edge that hides content is marked with the app's shared 12px ramp (the same
 * one `AgentActivity`, the task panels and the tool-output viewport use), so a
 * row the fold cuts in half fades out instead of ending in a hard chop: the
 * ramp is absent while the list sits at its end, appears at the bottom while
 * more rows are below, and at both ends once the list is scrolled.
 *
 * Run after `npm run build`.
 * PI_SIDEBAR_LIST_SCREENSHOT_DIR retains the top/middle/bottom views.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-sidebar-list-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child, ws
try {
  // Reloads must keep the same production assets if another build replaces out/.
  const built = join(temporary, 'out')
  await cp(join(repo, 'out/renderer'), join(built, 'renderer'), { recursive: true })
  await cp(join(repo, 'out/preload'), join(built, 'preload'), { recursive: true })
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(built, 'preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{resize:(width,height)=>ipcRenderer.invoke('fixture:resize',width,height),state:()=>ipcRenderer.invoke('fixture:state'),emit:(event)=>ipcRenderer.invoke('fixture:emit',event)});`)
  const main = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const projects=['/workspace/pi-app','/workspace/piws','/workspace/desktop'];
 const labels=['统一窗口标题栏与页面布局','梳理项目结构与入口','实现一个新的工具面板','检查最近的界面改动'];
 const long='这是一条非常非常长的会话标题用来观察文本溢出时的表现方式';
 const sessions=Array.from({length:24},(_,i)=>({id:'chat-'+i,path:'/fixture/chat-'+i,cwd:projects[i%3],projectless:false,
   label:i===0?long:labels[i%labels.length]+' '+i,created:new Date(Date.now()-i*86400000).toISOString(),modified:new Date(Date.now()-i*1000).toISOString(),messageCount:2,running:i===3}));
 let activePath='/fixture/chat-0';const opened=[],deleted=[],renamed=[];
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const snapshot=()=>({sessionId:'fixture',sessionPath:activePath,cwd:sessions.find(s=>s.path===activePath)?.cwd??'/workspace/pi-app',projectless:false,messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:${JSON.stringify(['/workspace/pi-app', '/workspace/piws', '/workspace/desktop'])},version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>sessions);
 ipcMain.handle('pi:openSession',(_,path)=>{activePath=path;opened.push(path);return snapshot()});
 ipcMain.handle('pi:renameSession',(_,path,name)=>{if(name==='reject rename')throw Error('fixture rename rejected');const session=sessions.find(s=>s.path===path);if(session)session.label=name;renamed.push(path);});
 ipcMain.handle('pi:deleteSession',(_,path)=>{deleted.push(path);const index=sessions.findIndex(s=>s.path===path);if(index>=0)sessions.splice(index,1);return snapshot()});
 ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('bash:list',()=>[]);ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:reload',()=>snapshot());ipcMain.handle('pi:compact',()=>snapshot());
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('fixture:resize',(_,width,height)=>win.setBounds({width,height}));
 ipcMain.handle('fixture:state',()=>({sessions,opened,deleted,renamed}));
 ipcMain.handle('fixture:emit',(_,event)=>{
   const session=sessions.find(s=>s.path===event.sessionPath);
   if(session){
     if(event.type==='agent_start')session.running=true;
     else if(event.type==='agent_settled')session.running=Boolean(event.continuing);
   }
   win.webContents.send('pi:event',event);
 });
 const win=new BrowserWindow({width:1100,height:700,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 win.loadFile(${JSON.stringify(join(built, 'renderer/index.html'))});
});
app.on('window-all-closed',()=>app.quit());`,
      resolveDir: repo,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main
  })
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
    for (let i = 0; i < 150; i++) { if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return; await pause(100) }
    const state = await evaluate(`({lang:document.documentElement.lang,locale:localStorage.getItem('pi-app:locale'),sidebar:!!document.querySelector('.session-sidebar'),body:document.body.innerText.slice(0,800)})`)
    throw new Error('never settled: ' + expression + '\n' + JSON.stringify({ state, exceptions }))
  }
  const shotDir = process.env.PI_SIDEBAR_LIST_SCREENSHOT_DIR
  const shoot = async (name, clip) => {
    if (!shotDir) return
    await mkdir(shotDir, { recursive: true })
    const image = await send('Page.captureScreenshot', clip ? { clip } : {})
    await writeFile(join(shotDir, name + '.png'), Buffer.from(image.data, 'base64'))
  }

  await send('Runtime.enable')
  // Keep native cursor/focus changes outside the fixture; CDP owns its input.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN');localStorage.setItem('theme','light')`)
  await send('Page.reload')
  await waitFor(`document.querySelector('[data-prompt-editor]') && document.querySelector('[role="tree"]')`)
  await pause(600)

  /** The list, its content shell and the row at its foot, as the DOM has them. */
  const read = `(()=>{
    const tree=document.querySelector('[role="tree"]');
    const viewport=tree.parentElement;
    const shell=document.querySelector('[data-slot="sidebar-content"]');
    const panel=viewport.closest('[data-slot="sidebar"],aside');
    const rows=[...tree.querySelectorAll('[role="treeitem"]')];
    const last=rows[rows.length-1];
    // The one genuinely long title in the fixture (the folders lead the tree,
    // so the first row is not the session).
    const longLabel=rows.map((row)=>row.querySelector('[data-resource-label]')).find((label)=>label&&label.scrollWidth>label.clientWidth);
    const overflow=viewport.scrollHeight-viewport.clientHeight;
    return {
      viewportPadding:getComputedStyle(viewport).paddingBottom,
      shellPadding:getComputedStyle(shell).paddingBottom,
      scrollTop:Math.round(viewport.scrollTop),overflow:Math.round(overflow),
      atEnd:Math.abs(overflow-viewport.scrollTop)<1,
      viewportBottom:viewport.getBoundingClientRect().bottom,
      panelBottom:panel.getBoundingClientRect().bottom,
      lastRowBottom:last.getBoundingClientRect().bottom,
      rows:rows.length,
      labelOverflows:Boolean(longLabel),
      mask:getComputedStyle(viewport).maskImage
    };
  })()`
  const scrollTo = async (value) => {
    await evaluate(`document.querySelector('[role="tree"]').parentElement.scrollTop=${value}`)
    await pause(300)
  }

  // 1. No bottom padding anywhere on the way out: the list reaches the panel's
  //    bottom line. 44px of dead space (a 32px list padding over a 12px shell
  //    padding) is exactly what the owner reported as the gap under the text.
  const atTop = await evaluate(read)
  assert.equal(atTop.viewportPadding, '0px', 'the session list scrollport carries no bottom padding')
  assert.equal(atTop.shellPadding, '0px', 'the sidebar content shell carries no bottom padding (the vendored py-2 is overridden)')
  assert.ok(atTop.overflow > 0, 'the fixture overflows, so the edges below are real')
  assert.equal(atTop.viewportBottom, atTop.panelBottom, 'the scrollport ends on the panel\'s bottom line')
  assert.ok(atTop.lastRowBottom > atTop.viewportBottom, 'a row is cut by the bottom edge at rest — this is what must fade')

  // 2. At the top of the list the bottom edge hides content: the 12px ramp (the
  //    shared one) fades the cut row, and the top edge — hiding nothing — keeps
  //    its text crisp.
  assert.equal(atTop.mask, 'linear-gradient(rgb(0, 0, 0) calc(100% - 12px), rgba(0, 0, 0, 0))', 'the bottom edge carries the shared 12px ramp: ' + atTop.mask)
  await shoot('top', { x: 0, y: 540, width: 260, height: 160, scale: 2 })

  // 3. Scrolled into the middle both edges hide content: a ramp at each end.
  await scrollTo(120)
  const middle = await evaluate(read)
  assert.equal(middle.mask, 'linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 12px, rgb(0, 0, 0) calc(100% - 12px), rgba(0, 0, 0, 0))', 'a scrolled list ramps both ends: ' + middle.mask)
  await shoot('middle', { x: 0, y: 540, width: 260, height: 160, scale: 2 })

  // 4. At the end of the list nothing is hidden below it: the last row is
  //    fully opaque AND flush with the panel's bottom line — text no longer
  //    stops short of the app's bottom edge.
  await scrollTo(1e6)
  const atEnd = await evaluate(read)
  assert.equal(atEnd.atEnd, true, 'the list did reach its end')
  assert.ok(atEnd.scrollTop > 0, 'the list really scrolled')
  assert.equal(atEnd.lastRowBottom, atEnd.viewportBottom, 'the last row ends on the bottom line')
  assert.equal(atEnd.viewportBottom, atEnd.panelBottom, 'and that line is the panel\'s own bottom edge')
  assert.doesNotMatch(atEnd.mask, /calc\(100% - 12px\)/, 'the bottom ramp is gone once nothing is hidden below: ' + atEnd.mask)
  assert.match(atEnd.mask, /rgb\(0, 0, 0\) 12px\)$/, 'only the top ramp remains')
  await shoot('bottom', { x: 0, y: 540, width: 260, height: 160, scale: 2 })
  await shoot('full', null)

  // 5. The overflowing title is clipped within its row; its full text remains
  //    available through the title tooltip exercised below.
  assert.equal(atTop.labelOverflows, true, 'the fixture\'s first title really is wider than its row')

  // Exercise the application sidebar through the production renderer/preload.
  const row = (id) => `document.querySelector(${JSON.stringify(`[data-resource-id="${id}"]`)})`
  const preferences = `JSON.parse(localStorage.getItem('pi-app:session-sidebar:v1')||'{}')`
  const sessionIds = `[...document.querySelectorAll('.session-sidebar [data-session-row]')].map(node=>node.closest('[data-resource-id]').dataset.resourceId)`
  const button = (label, scope = '.session-sidebar') => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(node=>!node.closest('[inert]')&&(node.getAttribute('aria-label')===${JSON.stringify(label)}||node.textContent.trim()===${JSON.stringify(label)}))`
  const click = async (expression) => { await waitFor(expression); await evaluate(`(${expression}).click()`); await pause(100) }
  const type = async (selector, value) => {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  const menuAction = async (id, label) => {
    await waitFor(row(id))
    await evaluate(`(${row(id)}).scrollIntoView({block:'center'})`)
    await click(`(${row(id)}).querySelector('button[aria-label$="的操作"]')`)
    await click(`[...document.querySelectorAll(${JSON.stringify(`[data-sidebar-resource-menu="${id}"] button`)})].find(node=>node.textContent.trim()===${JSON.stringify(label)})`)
  }
  const radio = async (label) => click(`[...document.querySelectorAll('[data-session-options] label')].find(node=>node.textContent.trim()===${JSON.stringify(label)})?.querySelector('[role="radio"]')`)
  const setOption = async (label) => { await click(button('会话视图选项')); await radio(label); await click(button('会话视图选项')) }
  const optionAction = async (label) => { await click(button('会话视图选项')); await click(button(label, '[data-session-options]')); await waitFor(`!document.querySelector('[data-session-options]:not([inert])')`) }
  const saveEditor = async () => { await click(button('保存', '[data-session-editor]')); await waitFor(`!document.querySelector('[data-session-editor]')`) }

  await scrollTo(0)
  // Selecting a session from another project leaves the project rows in place:
  // activity only sorts the sessions inside each project.
  const projectIds = `[...document.querySelectorAll('.session-sidebar [data-resource-id^="folder:"]')].map(node=>node.dataset.resourceId)`
  const projectsBefore = await evaluate(projectIds)
  await click(row('/fixture/chat-1'))
  assert.deepEqual((await evaluate('window.fixture.state()')).opened, ['/fixture/chat-1'], 'the other project\u2019s session really opened')
  assert.deepEqual(await evaluate(projectIds), projectsBefore, 'opening another project\u2019s session does not reorder the project rows')
  // Hover reveals more of a title in a bounded tooltip without moving the row
  // or its text. Sample the actual text, rather than just its clipping box.
  const titleProbe = `(()=>{
    const row=${row('/fixture/chat-0')};
    const title=row.querySelector('[data-resource-label]');
    const range=document.createRange();range.selectNodeContents(title);
    const rect=range.getBoundingClientRect();
    return {text:title.textContent,x:rect.x,y:rect.y,width:rect.width,height:rect.height,
      rowHeight:row.getBoundingClientRect().height,
      unusedRight:row.getBoundingClientRect().right-parseFloat(getComputedStyle(row).paddingRight)-title.getBoundingClientRect().right};
  })()`
  const tooltipProbe = `(()=>{
    const content=document.querySelector('[data-session-title-tooltip]');
    const tooltip=content?.closest('[role="tooltip"]');
    if(!tooltip)return null;
    const style=getComputedStyle(tooltip),rect=tooltip.getBoundingClientRect();
    return {text:content.textContent,visible:style.visibility==='visible'&&Number(style.opacity)>.99,
      lines:content.clientHeight/parseFloat(getComputedStyle(content).lineHeight),
      truncated:content.scrollHeight>content.clientHeight,
      inViewport:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight};
  })()`
  const originalTitle = (await evaluate(titleProbe)).text
  const renameInline = async (name) => {
    await evaluate(`${row('/fixture/chat-0')}.focus()`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2' })
    await waitFor(`${row('/fixture/chat-0')}.querySelector('input')`)
    await waitFor(`!document.querySelector('[data-session-title-tooltip]')`)
    await type('[data-resource-id="/fixture/chat-0"] input', name)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
    await waitFor(`!${row('/fixture/chat-0')}.querySelector('input')&&(${titleProbe}).text===${JSON.stringify(name)}`)
    await pause(350)
  }
  const hoverTitle = async (part = 'title', id = '/fixture/chat-0') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 100 })
    await pause(100)
    const point = await evaluate(`(()=>{
      const node=${row(id)};
      const target=${JSON.stringify(part)}==='status'?node.querySelector('[role="status"]'):
        ${JSON.stringify(part)}==='padding'?node:node.querySelector('[data-resource-label]');
      const rect=target.getBoundingClientRect();return{x:rect.x+(${JSON.stringify(part)}==='padding'?3:12),y:rect.y+rect.height/2};
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x+1, y: point.y })
    try { await waitFor(`${row(id)}.matches(':hover')`) }
    catch(error) {
      const state=await evaluate(`(()=>{const node=${row(id)};const title=node.querySelector('[data-resource-label]');return{row:node.getBoundingClientRect().toJSON(),title:title.getBoundingClientRect().toJSON(),hit:document.elementFromPoint(${point.x+1},${point.y})?.outerHTML?.slice(0,500),scrollTop:node.closest('[role="tree"]').parentElement.scrollTop}})()`)
      throw new Error(`${error.message}\nHover geometry: ${JSON.stringify({point,state})}`)
    }
  }
  const assertTitleStable = async (before) => {
    const after = await evaluate(titleProbe)
    for(const key of ['x','y','width','height','rowHeight']) assert(Math.abs(after[key]-before[key])<.5, `hover keeps title ${key} stable: ${JSON.stringify({before,after})}`)
  }
  const leaveTitle = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 100 })
    await waitFor(`!document.querySelector('[data-session-title-tooltip]')`)
  }
  const restingTitle = await evaluate(titleProbe)
  assert(Math.abs(restingTitle.unusedRight)<1, 'at rest the title uses the row width: no reserved action column')
  await hoverTitle()
  await assertTitleStable(restingTitle)
  await waitFor(`(${tooltipProbe})?.visible`)
  const titleTooltip = await evaluate(tooltipProbe)
  assert.equal(titleTooltip.text, originalTitle, 'the tooltip shows the session title')
  assert(titleTooltip.lines>1 && titleTooltip.inViewport, 'long titles wrap in a tooltip inside the window')
  await pause(600)
  await assertTitleStable(restingTitle)
  await shoot('title-tooltip', null)
  await leaveTitle()
  await assertTitleStable(restingTitle)
  // Row actions carry no frame: the row's own hover fill shows through, only
  // the glyph darkens, and the control still owns the pointer — a transparent
  // button must never end up underneath the title it floats over. It stays
  // pinned to the row's trailing edge either way.
  const actionProbe = (id, selector) => `(()=>{
    const node=${row(id)};const button=node.querySelector(${JSON.stringify(selector)});
    if(!button) return null;
    const r=button.getBoundingClientRect(),style=getComputedStyle(button);
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {covered:!(hit===button||button.contains(hit)),bg:style.backgroundColor,color:style.color,opacity:Number(style.opacity),right:Math.round(node.getBoundingClientRect().right-r.right)};
  })()`
  const hoverAction = async (id, selector) => {
    const point = await evaluate(`(()=>{const r=(${row(id)}).querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x+1, y: point.y })
    await waitFor(`(${row(id)}).querySelector(${JSON.stringify(selector)}).matches(':hover')`)
    await pause(120)
    return evaluate(actionProbe(id, selector))
  }
  const luminance = color => evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=${JSON.stringify(color)};ctx.fillRect(0,0,1,1);const [r,g,b]=ctx.getImageData(0,0,1,1).data;return 0.2126*r+0.7152*g+0.0722*b})()`)
  const tokenColor = name => evaluate(`(()=>{const probe=document.createElement('span');probe.style.color=${JSON.stringify(name)};document.body.appendChild(probe);const value=getComputedStyle(probe).color;probe.remove();return value})()`)
  const mutedLuminance = await luminance(await tokenColor('var(--muted-foreground)'))
  const hoveredMenu = await hoverAction('/fixture/chat-0', 'button[aria-haspopup="dialog"]')
  assert.ok(hoveredMenu, 'the session row reveals its menu action')
  assert.equal(hoveredMenu.covered, false, 'the revealed menu action stays above the row title: ' + JSON.stringify(hoveredMenu))
  assert.equal(hoveredMenu.bg, 'rgba(0, 0, 0, 0)', 'the menu action paints no frame on hover: ' + JSON.stringify(hoveredMenu))
  assert.ok(await luminance(hoveredMenu.color) < mutedLuminance, 'hovering the menu action only strengthens its glyph: ' + JSON.stringify(hoveredMenu))
  assert.ok(hoveredMenu.right >= 8 && hoveredMenu.right <= 20, 'the menu action stays pinned to the row edge: ' + JSON.stringify(hoveredMenu))
  const titleEdge = await evaluate(`(()=>{const row=R0;const label=row.querySelector('[data-resource-label]'),button=row.querySelector('button[aria-haspopup="dialog"]'),cluster=row.querySelector('[data-session-row]');return{labelRight:Math.round(label.getBoundingClientRect().right),buttonLeft:Math.round(button.getBoundingClientRect().left),clusterRight:Math.round(cluster.getBoundingClientRect().right),mask:getComputedStyle(label).maskImage}})()`.replace('R0', row('/fixture/chat-0')))
  assert.ok(titleEdge.clusterRight <= titleEdge.buttonLeft + 1, 'the hovered title ends before the floated menu instead of running under it: ' + JSON.stringify(titleEdge))
  assert.match(titleEdge.mask, /linear-gradient/, 'the hovered title keeps its gradient fade: ' + titleEdge.mask)
  // A running session shows a spinner after its title: the row gives that a slot
  // too, so neither the text nor the spinner can slide under the menu.
  const runningMenu = await hoverAction('/fixture/chat-3', 'button[aria-haspopup="dialog"]')
  assert.ok(runningMenu, 'the running session reveals its menu action')
  const runningEdge = await evaluate(`(()=>{const row=R3;const status=row.querySelector('[role="status"]'),button=row.querySelector('button[aria-haspopup="dialog"]'),label=row.querySelector('[data-resource-label]');return{spinnerRight:Math.round(status.getBoundingClientRect().right),spinnerLeft:Math.round(status.getBoundingClientRect().left),buttonLeft:Math.round(button.getBoundingClientRect().left),labelRight:Math.round(label.getBoundingClientRect().right)}})()`.replace('R3', row('/fixture/chat-3')))
  assert.ok(runningEdge.spinnerRight <= runningEdge.buttonLeft, 'the running spinner keeps clear of the floated menu: ' + JSON.stringify(runningEdge))
  assert.ok(runningEdge.labelRight <= runningEdge.spinnerLeft, 'the title ends before the spinner, not under it: ' + JSON.stringify(runningEdge))
  await shoot('row-action-hover', null)
  // A project row keeps its count and disclosure arrow at the trailing edge at
  // rest; while the row is active those step aside IN PLACE (same boxes, no
  // shift) so the floated actions take that space, and the title ends early
  // rather than running under a button.
  const groupTrailing = `(()=>{const node=GROUP0;
    const count=node.querySelector('.session-group-count'),chevron=node.querySelector('.session-group-chevron'),label=node.querySelector('[data-resource-label]'),action=node.querySelector('.session-group-action');
    const pick=el=>{const r=el.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width)}};
    const box=node.getBoundingClientRect();
    return {count:pick(count),chevron:pick(chevron),countVisibility:getComputedStyle(count).visibility,chevronVisibility:getComputedStyle(chevron).visibility,
      labelRight:Math.round(label.getBoundingClientRect().right),actionLeft:Math.round(action.getBoundingClientRect().left),mask:getComputedStyle(label).maskImage,
      unusedRight:Math.round(box.right-parseFloat(getComputedStyle(node).paddingRight)-label.getBoundingClientRect().right)}})()`.replace('GROUP0', row('folder:/workspace/pi-app'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 100 })
  await pause(150)
  const groupRest = await evaluate(groupTrailing)
  const hoveredGroup = await hoverAction('folder:/workspace/pi-app', '.session-group-action')
  const groupActive = await evaluate(groupTrailing)
  assert.deepEqual({ count: groupActive.count, chevron: groupActive.chevron }, { count: groupRest.count, chevron: groupRest.chevron }, 'the count and arrow keep their exact boxes instead of shifting left')
  assert.equal(groupRest.countVisibility, 'visible', 'the count shows at rest')
  assert.equal(groupRest.chevronVisibility, 'visible', 'the disclosure arrow shows at rest, in its original place')
  assert.ok(groupRest.labelRight <= groupRest.count.x && groupRest.count.x - groupRest.labelRight <= 12, 'at rest the project title runs right up to its count: ' + JSON.stringify(groupRest))
  assert.equal(groupActive.countVisibility, 'hidden', 'the count yields its slot to the row actions')
  assert.equal(groupActive.chevronVisibility, 'hidden', 'the arrow yields its slot to the row actions')
  assert.ok(groupActive.labelRight <= groupActive.actionLeft, 'the project title ends before the floated actions instead of running under them: ' + JSON.stringify(groupActive))
  assert.match(groupActive.mask, /linear-gradient/, 'the project title keeps its gradient fade: ' + groupActive.mask)
  assert.ok(hoveredGroup, 'the project row reveals its new-chat action')
  assert.equal(hoveredGroup.covered, false, 'the revealed project action stays above the row title: ' + JSON.stringify(hoveredGroup))
  assert.equal(hoveredGroup.bg, 'rgba(0, 0, 0, 0)', 'the project action paints no frame on hover: ' + JSON.stringify(hoveredGroup))
  assert.ok(hoveredGroup.right >= 24 && hoveredGroup.right <= 56, 'the project action stays pinned beside the row chevron: ' + JSON.stringify(hoveredGroup))
  // The row's own muted colour is unlayered CSS and would otherwise outrank the
  // button variant's hover colour: hovering must still darken the glyph.
  assert.ok(await luminance(hoveredGroup.color) < mutedLuminance, 'hovering the project action darkens its glyph: ' + JSON.stringify(hoveredGroup))
  await shoot('group-row-hover', null)
  await leaveTitle()

  assert.equal(await evaluate(`document.querySelectorAll('.session-sidebar [title]').length`), 0, 'the sidebar has no competing native tooltip triggers')
  await hoverTitle('padding')
  await waitFor(`(${tooltipProbe})?.visible`)
  assert.equal((await evaluate(tooltipProbe)).text, originalTitle, 'row padding opens the same session title tooltip')
  assert.match(await evaluate(`document.querySelector('[data-session-details-tooltip]').textContent`), /2\s*条消息.*\/workspace\/pi-app/, 'message count and project path remain available in the beUI tooltip')
  await assertTitleStable(restingTitle)
  await leaveTitle()
  // Moving between the title and row padding keeps the same bubble open.
  await hoverTitle()
  await waitFor(`(${tooltipProbe})?.visible`)
  const bubbleId = await evaluate(`document.querySelector('[data-session-title-tooltip]').closest('[role="tooltip"]').id`)
  for(const part of ['padding','title']) {
    const point=await evaluate(`(()=>{const node=${row('/fixture/chat-0')};const target=${JSON.stringify(part)}==='padding'?node:node.querySelector('[data-resource-label]');const rect=target.getBoundingClientRect();return{x:rect.x+(${JSON.stringify(part)}==='padding'?3:10),y:rect.y+rect.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await pause(150)
    assert.equal(await evaluate(`document.querySelector('[data-session-title-tooltip]')?.closest('[role="tooltip"]').id`), bubbleId, 'moving inside a row keeps its tooltip mounted')
    assert((await evaluate(tooltipProbe)).visible, 'moving between row regions does not restart the delay')
  }
  await hoverTitle('status','/fixture/chat-3')
  await waitFor(`(${tooltipProbe})?.visible&&(${tooltipProbe}).text==='检查最近的界面改动 3'`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-session-title-tooltip]').length`), 1, 'moving between sessions leaves one title tooltip')
  assert(await evaluate(`(()=>{const node=${row('/fixture/chat-3')};const status=node.querySelector('[role="status"]');const title=node.querySelector('[data-resource-label]').getBoundingClientRect();const mark=status.getBoundingClientRect();return !status.closest('[aria-hidden="true"]')&&mark.left>=title.right&&Math.abs(mark.y+mark.height/2-title.y-title.height/2)<1})()`), 'the running status remains accessible on the same line to the right of the title')
  await leaveTitle()
  const projectPoint=await evaluate(`(()=>{const rect=${row('folder:/workspace/pi-app')}.querySelector('[data-session-group]').getBoundingClientRect();return{x:rect.x+12,y:rect.y+rect.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...projectPoint })
  await waitFor(`document.querySelector('[data-session-group-tooltip]')?.textContent==='/workspace/pi-app'`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:900,y:100 })
  await waitFor(`!document.querySelector('[data-session-group-tooltip]')`)

  // A pointer click on a project header toggles its section and focuses the
  // row itself (the tree keeps a roving tabindex). With the pointer gone the
  // header's new-chat action must go with it, exactly like the row menu beside
  // it: gating the action on `:focus-within` left its glyph painted over the
  // resting row, because a mouse click focuses without matching
  // `:focus-visible`, which is what the menu button keys off.
  const header = 'folder:/workspace/pi-app'
  const headerProbe = `(()=>{const node=${row(header)};const action=node.querySelector('.session-group-action');const menu=node.querySelector('button[aria-haspopup="dialog"]');
    return {focused:document.activeElement===node,hover:node.matches(':hover'),expanded:node.getAttribute('aria-expanded'),
      action:action?Number(getComputedStyle(action).opacity):null,menu:menu?Number(getComputedStyle(menu).opacity):null}})()`
  const pressHeader = async () => {
    const point = await evaluate(`(()=>{const rect=${row(header)}.getBoundingClientRect();return{x:rect.x+60,y:rect.y+rect.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await pause(200)
  }
  const expandedBefore = await evaluate(`(${headerProbe}).expanded`)
  await pressHeader()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:900,y:100 })
  await pause(300)
  const collapsed = await evaluate(headerProbe)
  assert.equal(collapsed.expanded, expandedBefore === 'true' ? 'false' : 'true', 'a pointer click on the project header toggles its section')
  assert(collapsed.focused && !collapsed.hover, 'the click leaves the row focused once the pointer has left it')
  assert.equal(collapsed.action, 0, 'the project new-chat action hides when the pointer leaves the focused row')
  assert.equal(collapsed.menu, 0, 'the row menu hides with it')
  // Expanded again for the checks below, and keyboard focus (the tabbed-to
  // action inside the row) still reveals it.
  await pressHeader()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:900,y:100 })
  await waitFor(`(${headerProbe}).expanded===${JSON.stringify(expandedBefore)}`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await waitFor(`(${headerProbe}).action===1`)
  assert(await evaluate(`document.querySelector(${JSON.stringify(`[data-resource-id="${header}"] .session-group-action`)}).matches(':focus-visible')`), 'the tabbed-to action holds keyboard focus')
  await evaluate(`(${row(header)}).focus()`)

  await hoverTitle('padding')
  await waitFor(`(${tooltipProbe})?.visible`)
  await evaluate(`void(window.__tooltipRow=${row('/fixture/chat-0')})`)
  await click(`(${row('/fixture/chat-0')}).querySelector('button[aria-haspopup="dialog"]')`)
  await waitFor(`(${row('/fixture/chat-0')}).querySelector('button[aria-haspopup="dialog"]').getAttribute('aria-expanded')==='true'`)
  await waitFor(`!document.querySelector('[data-session-title-tooltip]')`)
  assert(await evaluate(`${row('/fixture/chat-0')}===window.__tooltipRow`), 'opening the menu preserves the row element')
  await click(`(${row('/fixture/chat-0')}).querySelector('button[aria-haspopup="dialog"]')`)
  await waitFor(`(${row('/fixture/chat-0')}).querySelector('button[aria-haspopup="dialog"]').getAttribute('aria-expanded')==='false'`)
  await leaveTitle()

  const oversizedTitle = originalTitle.repeat(30)
  // Imported/generated SDK titles can exceed the inline editor's name limit.
  await evaluate(`window.pi.renameSession('/fixture/chat-0',${JSON.stringify(oversizedTitle)})`)
  await send('Page.reload')
  await waitFor(`${row('/fixture/chat-0')}?.querySelector('[data-resource-label]')`)
  await waitFor(`(${titleProbe}).text===${JSON.stringify(oversizedTitle)}`)
  await evaluate('document.fonts.ready')
  await scrollTo(0)
  const oversizedResting = await evaluate(titleProbe)
  await hoverTitle()
  await waitFor(`(${tooltipProbe})?.visible`)
  const boundedTooltip = await evaluate(tooltipProbe)
  assert.equal(boundedTooltip.text, oversizedTitle, 'the tooltip retains the source title')
  assert(boundedTooltip.lines>5 && boundedTooltip.lines<=6.1 && boundedTooltip.truncated && boundedTooltip.inViewport, 'very long titles show up to six lines before truncating')
  await assertTitleStable(oversizedResting)
  await shoot('title-tooltip-truncated', null)
  await leaveTitle()
  await renameInline('短标题')
  const shortResting = await evaluate(titleProbe)
  await hoverTitle()
  await waitFor(`(${tooltipProbe})?.visible`)
  assert.equal((await evaluate(tooltipProbe)).text, '短标题', 'short titles also have a tooltip')
  await assertTitleStable(shortResting)
  await leaveTitle()
  await renameInline(originalTitle)
  await shoot('projects-light', null)
  const sdkBefore = await evaluate('window.fixture.state()')
  // All organization controls share one options surface, leaving the first
  // view focused on the session list. Selecting a view persists like sorting.
  assert.equal(await evaluate(`document.querySelector('.session-sidebar input,[role="tablist"]')===null`), true)
  const navigation = await evaluate(`(()=>{
    const nav=document.querySelector('[data-slot="sidebar-menu"]')
    return {present:!!nav,labels:nav?[...nav.querySelectorAll('button')].map(button=>button.textContent.trim()):[]}
  })()`)
  assert.deepEqual(navigation, { present: false, labels: [] }, 'the sidebar list starts directly with sessions, without a navigation row')
  assert.equal(await evaluate(`(${button('查看归档会话')})===undefined`), true, 'archive is inside options')
  await click(button('会话视图选项'))
  assert.equal(await evaluate(`document.querySelectorAll('[data-session-options] [role="radiogroup"]').length`), 3)
  await radio('分组')
  await waitFor(`(${preferences}).view==='groups'`)
  await radio('项目')
  await click(button('会话视图选项'))
  await setOption('运行中')
  await waitFor(`JSON.stringify(${sessionIds})==='["/fixture/chat-3"]'`)
  await menuAction('/fixture/chat-3', '标记为未读')
  await setOption('未读')
  assert.deepEqual(await evaluate(sessionIds), ['/fixture/chat-3'])
  await click(row('/fixture/chat-3'))
  await waitFor(`(${preferences}).unread.length===0`)
  assert.deepEqual(await evaluate(sessionIds), [], 'opening a session acknowledges its unread mark')
  await click(button('清除筛选'))

  await setOption('分组')
  await optionAction('新建分组')
  await waitFor(`document.querySelector('[data-session-editor="new-group"] input')===document.activeElement`)
  await type('[data-session-editor] input', '待办项目')
  await saveEditor()
  const groupId = await evaluate(`(${preferences}).groups[0].id`)
  await menuAction('/fixture/chat-0', '移至分组')
  await click(button('分组', '[data-session-editor]'))
  await click(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()==='待办项目')`)
  await saveEditor()
  assert.deepEqual(await evaluate(`(${preferences}).groups[0].sessions`), ['/fixture/chat-0'])
  assert.equal((await evaluate('window.fixture.state()')).sessions.find(s => s.path === '/fixture/chat-0').cwd, '/workspace/pi-app', 'group assignment never changes project ownership')
  await click(row(groupId))
  await waitFor(`!${row('/fixture/chat-0')}`)
  assert(await evaluate(`(${preferences}).collapsed.includes(${JSON.stringify(groupId)})`))
  // A new group used to remount the whole tree and forget unrelated collapse state.
  await optionAction('新建分组'); await type('[data-session-editor] input', '其他'); await saveEditor()
  assert.equal(await evaluate(`(${row(groupId)}).getAttribute('aria-expanded')`), 'false')
  await send('Page.reload')
  await waitFor(row(groupId))
  assert.equal(await evaluate(`(${row(groupId)}).getAttribute('aria-expanded')`), 'false', 'collapse and selected view survive a reload')
  assert.equal(await evaluate(`(${preferences}).view`), 'groups')
  await click(row(groupId))
  await menuAction('/fixture/chat-0', '置顶会话')
  assert(await evaluate(`(${preferences}).pinned.includes('/fixture/chat-0')`))
  await scrollTo(0); await shoot('groups-light', null)

  const archiveState = await evaluate(preferences)
  await menuAction('/fixture/chat-0', '归档会话')
  await waitFor(`!${row('/fixture/chat-0')}`)
  assert.deepEqual((await evaluate('window.fixture.state()')).deleted, [], 'archive never invokes deletion')
  await optionAction('查看归档会话')
  await waitFor(row('/fixture/chat-0'))
  assert.deepEqual(await evaluate(sessionIds), ['/fixture/chat-0'])
  await click(row('/fixture/chat-0'))
  assert(await evaluate(`(${preferences}).archived.includes('/fixture/chat-0')`), 'opening an archive does not implicitly restore it')
  await shoot('archive-light', null)
  await send('Page.reload')
  await waitFor(`document.querySelector('.session-sidebar')`)
  await waitFor(`!${row('/fixture/chat-0')}`)
  await optionAction('查看归档会话')
  await waitFor(row('/fixture/chat-0'))
  await menuAction('/fixture/chat-0', '取消归档')
  await waitFor(`!${row('/fixture/chat-0')}`)
  assert(await evaluate(`document.querySelector('.session-sidebar').textContent.includes('暂无归档会话')`))
  await click(button('返回会话列表'))
  await waitFor(row('/fixture/chat-0'))
  const restored = await evaluate(preferences)
  assert.deepEqual(restored.pinned, archiveState.pinned)
  assert.deepEqual(restored.groups, archiveState.groups)
  assert.deepEqual(restored.order, archiveState.order)

  // Failed persistence must leave the row and saved state intact.
  const savedBeforeFailure = await evaluate(preferences)
  await evaluate(`window.fixtureSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('fixture storage blocked')}`)
  await menuAction('/fixture/chat-0', '归档会话')
  assert(await evaluate(`Boolean(${row('/fixture/chat-0')})`), 'failed archive keeps the original row')
  assert.deepEqual(await evaluate(preferences), savedBeforeFailure)
  assert(await evaluate(`document.querySelector('.session-sidebar [role="alert"]')?.textContent.includes('保存失败')`))
  await evaluate('Storage.prototype.setItem=window.fixtureSetItem')

  // Row menu and the one list-level context menu reuse the same actions —
  // and, being one menu, the same painted width.
  await evaluate(`(${row('/fixture/chat-0')}).scrollIntoView({block:'center'})`)
  const rowMenuTrigger = `(${row('/fixture/chat-0')}).querySelector('button[aria-label$="的操作"]')`
  await click(rowMenuTrigger)
  await waitFor(`document.querySelector('[data-sidebar-resource-menu="/fixture/chat-0"]')`)
  const rowMenuWidth = await evaluate(`(()=>{const menu=document.querySelector('[data-sidebar-resource-menu="/fixture/chat-0"]');return menu?parseFloat(getComputedStyle(menu.closest('[role="dialog"]')).width):null})()`)
  await click(rowMenuTrigger)
  await waitFor(`!document.querySelector('[data-sidebar-resource-menu="/fixture/chat-0"]')`)
  const openCount = (await evaluate('window.fixture.state()')).opened.length
  await evaluate(`(()=>{const node=${row('/fixture/chat-0')};node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.x+30,clientY:rect.y+15}))})()`)
  await waitFor(`document.querySelector('[data-context-menu-portal]:not([inert]) [role="menu"]')`)
  const contextMenuWidth = await evaluate(`parseFloat(getComputedStyle(document.querySelector('[data-context-menu-portal]:not([inert]) [role="menu"]')).width)`)
  assert(rowMenuWidth > 0, `the row menu reports its painted width (${rowMenuWidth})`)
  assert.equal(contextMenuWidth, rowMenuWidth, 'the right-click menu is as wide as the row menu')
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.trim()==='标记为未读')`)
  assert(await evaluate(`(${preferences}).unread.includes('/fixture/chat-0')`))
  assert.equal((await evaluate('window.fixture.state()')).opened.length, openCount, 'context actions do not select the session behind the menu')
  await evaluate(`(()=>{const node=${row('/fixture/chat-3')};node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();node.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true,clientX:rect.x+30,clientY:rect.y+15}))})()`)
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.trim()==='标记为未读')`)
  await evaluate(`(${row('/fixture/chat-3')}).dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',bubbles:true}))`)
  assert(await evaluate(`(${preferences}).unread.includes('/fixture/chat-3')`), 'long press resolves the current row instead of the preceding context target')
  await menuAction('/fixture/chat-0', '重命名')
  await type('[data-session-editor] input', 'reject rename')
  await click(button('保存', '[data-session-editor]'))
  await waitFor(`document.querySelector('[data-session-editor] [role="alert"]')`)
  assert.equal((await evaluate('window.fixture.state()')).sessions[0].label, sdkBefore.sessions[0].label, 'failed SDK rename keeps the previous title')
  await click(button('取消', '[data-session-editor]'))
  await waitFor(`document.activeElement===${row('/fixture/chat-0')}`)
  await menuAction('/fixture/chat-0', '重命名'); await type('[data-session-editor] input', '已重新命名'); await saveEditor()
  assert((await evaluate(`(${row('/fixture/chat-0')}).textContent`)).includes('已重新命名'))

  await setOption('项目')
  await setOption('手动排序')
  await evaluate(`(${row('/fixture/chat-3')}).focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', modifiers: 9, windowsVirtualKeyCode: 40 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', modifiers: 9, windowsVirtualKeyCode: 40 })
  await waitFor(`(${preferences}).order.indexOf('/fixture/chat-6')<(${preferences}).order.indexOf('/fixture/chat-3')&&(${preferences}).order.includes('/fixture/chat-3')`)
  assert.equal((await evaluate('window.fixture.state()')).sessions.find(s => s.path === '/fixture/chat-3').cwd, '/workspace/pi-app')
  await setOption('时间线')
  await setOption('创建时间')
  await waitFor(`document.querySelector('[data-session-group="yesterday"]')`)
  await scrollTo(0); await shoot('timeline-light', null)
  await optionAction('收起全部分区')
  assert.deepEqual(await evaluate(sessionIds), [], 'collapse all also hides pinned rows')
  await optionAction('展开全部分区')
  await waitFor(row('/fixture/chat-0'))

  // Delete remains a separate, confirmed SDK/Trash operation from the archive.
  await setOption('项目')
  // chat-6 sits past the first page of its project, so the list's own paging
  // reveals it — the removed title filter used to be the shortcut here.
  await click(`document.querySelector(${JSON.stringify('[data-resource-id="more:folder:/workspace/pi-app"]')})`)
  await waitFor(row('/fixture/chat-6'))
  await menuAction('/fixture/chat-6', '归档会话')
  await optionAction('查看归档会话')
  await menuAction('/fixture/chat-6', '删除会话')
  await click(button('取消', 'body'))
  assert.deepEqual((await evaluate('window.fixture.state()')).deleted, [])
  await menuAction('/fixture/chat-6', '删除会话')
  await click(button('删除', 'body'))
  await waitFor(`!${row('/fixture/chat-6')}`)
  assert.deepEqual((await evaluate('window.fixture.state()')).deleted, ['/fixture/chat-6'])
  assert(!(await evaluate(preferences)).archived.includes('/fixture/chat-6'), 'deletion cleans up archive references')
  await click(button('返回会话列表'))
  await setOption('分组')
  const sessionsBeforeRemove = (await evaluate('window.fixture.state()')).sessions.length
  await menuAction(groupId, '移除分组')
  await click(button('移除分组', 'body'))
  await waitFor(`!${row(groupId)}`)
  assert.equal((await evaluate('window.fixture.state()')).sessions.length, sessionsBeforeRemove, 'removing a group never deletes its sessions')

  // Completion unread marks use the production event bridge and Workspace.
  // Visiting during a run does not acknowledge a response that arrives later.
  await setOption('项目')
  await evaluate(`(${button('清除筛选')})?.click()`)
  await waitFor(row('/fixture/chat-0'))
  await click(row('/fixture/chat-0'))
  await click(row('/fixture/chat-3'))
  await click(row('/fixture/chat-0'))
  await waitFor(`(${preferences}).unread.length===0`)
  const emit = async (type, sessionPath = '/fixture/chat-3', flags = {}) => {
    await evaluate(`window.fixture.emit(${JSON.stringify({ type, sessionPath, ...flags })})`)
    await pause(100)
  }
  const unreadDot = (id) => `(${row(id)})?.querySelector('[data-session-unread]')`
  await emit('agent_settled', '/fixture/chat-0')
  assert.equal(await evaluate(`Boolean(${unreadDot('/fixture/chat-0')})`), false, 'a completion being viewed in the focused window stays read')
  await emit('agent_start')
  await waitFor(`(${row('/fixture/chat-3')})?.querySelector('[role="status"]')`)
  await click(row('/fixture/chat-3'))
  await click(row('/fixture/chat-0'))
  await emit('agent_end')
  assert.equal(await evaluate(`(${preferences}).unread.length`), 0, 'agent_end does not mark an intermediate response unread')
  await emit('agent_settled', '/fixture/chat-3', { continuing: true })
  assert.equal(await evaluate(`(${preferences}).unread.length`), 0, 'a continuing run does not mark its intermediate settlement unread')
  assert(await evaluate(`Boolean((${row('/fixture/chat-3')})?.querySelector('[role="status"]'))`), 'a continuing background run keeps its spinner')
  await emit('agent_settled', '/fixture/chat-3', { userAborted: true })
  await emit('agent_settled', '/fixture/chat-9', { subagentChild: true })
  assert.equal(await evaluate(`(${preferences}).unread.length`), 0, 'stopped runs and child turns do not create conversation unread marks')
  await emit('agent_start')
  await emit('agent_settled')
  await waitFor(unreadDot('/fixture/chat-3'))
  assert.equal(await evaluate(`Boolean((${row('/fixture/chat-3')})?.querySelector('[role="status"]'))`), false, 'settlement replaces the background running indication with an unread dot')
  await emit('agent_settled')
  assert.deepEqual(await evaluate(`(${preferences}).unread`), ['/fixture/chat-3'], 'repeated completion delivery retains a single unread mark')
  const dotColor = `(()=>{const dot=${unreadDot('/fixture/chat-3')};const probe=document.createElement('span');probe.style.backgroundColor='var(--primary)';document.body.append(probe);const primary=getComputedStyle(probe).backgroundColor;probe.remove();return{color:getComputedStyle(dot).backgroundColor,primary}})()`
  const firstAccent = await evaluate(dotColor)
  assert.equal(firstAccent.color, firstAccent.primary, 'the unread dot uses the active theme accent')
  await shoot('unread-completed-light', null)
  await evaluate(`localStorage.setItem('pi-app:accent','emerald')`)
  await send('Page.reload')
  await waitFor(unreadDot('/fixture/chat-3'))
  const changedAccent = await evaluate(dotColor)
  assert.equal(changedAccent.color, changedAccent.primary, 'the persisted unread dot follows an accent change')
  assert.notEqual(changedAccent.color, firstAccent.color)
  assert.deepEqual(await evaluate(`(${preferences}).unread`), ['/fixture/chat-3'], 'an unseen completion survives renderer reload')
  await shoot('unread-completed-emerald', null)
  await click(row('/fixture/chat-0'))
  assert(await evaluate(`Boolean(${unreadDot('/fixture/chat-3')})`), 'opening another conversation preserves the unread completion')
  await click(row('/fixture/chat-3'))
  await waitFor(`!(${unreadDot('/fixture/chat-3')})&&(${preferences}).unread.length===0`)

  // The selected conversation is unseen while its window is unfocused, or
  // while Settings covers it. Focus alone cannot acknowledge a covered chat.
  await emit('agent_start')
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await waitFor(`!document.hasFocus()`)
  await emit('agent_settled')
  await waitFor(unreadDot('/fixture/chat-3'))
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`document.hasFocus()&&!(${unreadDot('/fixture/chat-3')})&&(${preferences}).unread.length===0`)
  await click(button('设置', 'body'))
  await waitFor(button('返回对话', 'body'))
  await emit('agent_start')
  await emit('agent_settled')
  await waitFor(`(${preferences}).unread.includes('/fixture/chat-3')`)
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  assert(await evaluate(`(${preferences}).unread.includes('/fixture/chat-3')`), 'regaining focus keeps an unread mark while Settings covers the conversation')
  await click(button('返回对话', 'body'))
  await waitFor(`(${preferences}).unread.length===0&&!(${unreadDot('/fixture/chat-3')})`)
  await waitFor(`!document.querySelector('button[aria-label="返回对话"]')`)

  // The same component remains readable in the second theme, icon family and locale.
  await evaluate(`localStorage.setItem('pi-app:ui-style','squircle');localStorage.setItem('pi-app:locale','zh-TW');localStorage.setItem('theme','dark')`)
  await send('Page.reload')
  await waitFor(`document.documentElement?.lang==='zh-TW'&&document.querySelector('.session-sidebar')`)
  await click(button('會話檢視選項'))
  assert(await evaluate(`document.querySelector('button[aria-label="檢視封存會話"] svg')?.dataset.iconFamily==='hugeicons'`), 'archive glyph follows the active interface family')
  await shoot('options-dark-squircle', null)
  await click(button('會話檢視選項'))
  await scrollTo(0); await shoot('groups-dark-squircle', null)
  await evaluate(`window.fixture.resize(920,640)`)
  await pause(250)
  assert(await evaluate(`(()=>{const sidebar=document.querySelector('.session-sidebar');return [...sidebar.querySelectorAll('button:not([data-resource-id] button)')].every(node=>node.getBoundingClientRect().right<=sidebar.getBoundingClientRect().right+1)})()`), 'toolbar controls stay within the sidebar at a smaller window size')
  await shoot('smaller-window', null)

  assert.deepEqual(exceptions, [], 'no renderer exceptions: ' + JSON.stringify(exceptions.map((entry) => entry.exception?.description ?? entry)))
  console.log('check-sidebar-list: all assertions passed')
} finally {
  try { ws?.close() } catch { /* already closed */ }
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) })
  }
  await rm(temporary, { recursive: true, force: true })
}
