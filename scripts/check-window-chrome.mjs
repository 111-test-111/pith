/** Built renderer + native window chrome, synthetic sessions and isolated storage.
 * Run after build. PI_WINDOW_SCREENSHOT_DIR retains the visual checks. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-window-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, ws
try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(pathToFileURL(join(repo, 'out/preload/index.mjs')).href)};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{window:()=>ipcRenderer.invoke('fixture:window'),alpha:rect=>ipcRenderer.invoke('fixture:alpha',rect),resize:(width,height)=>ipcRenderer.invoke('fixture:resize',width,height),fullscreen:value=>ipcRenderer.invoke('fixture:fullscreen',value),scenario:value=>ipcRenderer.invoke('fixture:scenario',value),event:event=>ipcRenderer.invoke('fixture:event',event),startupChoices:()=>ipcRenderer.invoke('fixture:startupChoices'),reloads:()=>ipcRenderer.invoke('fixture:reloads'),compacts:()=>ipcRenderer.invoke('fixture:compacts'),opens:()=>ipcRenderer.invoke('fixture:opens')});`)
  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain,nativeTheme} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 let scenario='project';
 let running=false;
 let compactionQueue={queued:false,revision:0};
 let queue={steering:[],followUp:[]};
 let startupChoice='resume';
 const startupChoices=[];
 const reloads=[];
 const compacts=[];
 const opens=[];
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const labels=['统一窗口标题栏与页面布局','梳理项目结构与入口','实现一个新的工具面板','检查最近的界面改动'];
 const sessions=labels.map((label,i)=>({id:'chat-'+i,path:'/fixture/chat-'+i,cwd:'/workspace/pi-app',projectless:false,label,created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}));
 const snapshot=(cwd='/workspace/pi-app')=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd,projectless:scenario==='projectless',messages:scenario==='long'?[{role:'user',content:'Please review the layout.',timestamp:1},{role:'assistant',content:[{type:'text',text:'The window controls and workspace now share one title row.'}],timestamp:2,stopReason:'stop'}]:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:running,queue,compactionQueue});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app','/workspace/piws'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:startupChoice}));
 ipcMain.handle('app:setStartup',(_,mode)=>{startupChoices.push(mode);startupChoice=mode;return mode});
 ipcMain.handle('pi:init',()=>snapshot(scenario==='projectless'?'/internal/private-workspace':'/workspace/pi-app'));
 ipcMain.handle('pi:newSession',(_,cwd)=>{scenario=cwd?'project':'projectless';return snapshot(cwd??'/internal/private-workspace')});
 ipcMain.handle('pi:listSessions',()=>scenario==='long'?[{...sessions[0],label:'A very long session title / 很长的会话标题 '.repeat(12)},...sessions.slice(1)]:sessions);
 ipcMain.handle('pi:openSession',(_,path)=>{opens.push(path);return snapshot()});ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('bash:list',()=>[]);ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:reload',(_,sessionPath)=>{reloads.push(sessionPath);return snapshot()});
 ipcMain.handle('pi:compact',(_,sessionPath)=>{
  compacts.push(sessionPath);
  if(scenario==='compact-small') throw new Error('Nothing to compact (session too small)');
  if(running&&!compactionQueue.queued){
   compactionQueue={queued:true,revision:compactionQueue.revision+1};
   w.webContents.send('pi:event',{type:'compaction_queue_update',sessionPath,sessionId:'fixture',compactionQueue});
  }
  return snapshot();
 });
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 const w=new BrowserWindow({...windowChromeOptions(),width:1320,height:880,minWidth:760,minHeight:560,title:'Pith · Layout check',backgroundColor:process.platform==='darwin'?'#00000000':'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 ipcMain.handle('fixture:window',()=>({bounds:w.getBounds(),content:w.getContentBounds(),buttons:process.platform==='darwin'?w.getWindowButtonPosition():null,fullscreen:w.isFullScreen(),dark:nativeTheme.shouldUseDarkColors,theme:nativeTheme.themeSource}));
 ipcMain.handle('fixture:alpha',async(_,rect)=>{
  const image=await w.webContents.capturePage(rect);
  const bytes=image.toBitmap();
  let min=255,max=0;
  for(let i=3;i<bytes.length;i+=4){min=Math.min(min,bytes[i]);max=Math.max(max,bytes[i])}
  return{min,max,pixels:bytes.length/4};
 });
 ipcMain.handle('fixture:resize',(_,width,height)=>w.setBounds({width,height}));
 ipcMain.handle('fixture:fullscreen',(_,value)=>w.setFullScreen(value));
 ipcMain.handle('fixture:scenario',(_,value)=>{scenario=value});
 ipcMain.handle('fixture:event',(_,event)=>{
  if(event.type==='agent_start') running=true;
  if(event.type==='agent_settled') running=false;
  if(event.type==='compaction_queue_update') compactionQueue=event.compactionQueue;
  if(event.type==='queue_update') queue={steering:event.steering,followUp:event.followUp};
  w.webContents.send('pi:event',event);
 });
 ipcMain.handle('fixture:startupChoices',()=>startupChoices);
 ipcMain.handle('fixture:reloads',()=>reloads);
 ipcMain.handle('fixture:compacts',()=>compacts);
 ipcMain.handle('fixture:opens',()=>opens);
 w.loadFile(${JSON.stringify(join(repo, 'out/renderer/index.html'))});
});app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page')
    if (!page) await pause(50)
  }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, msg => msg.error ? reject(msg.error) : resolve(msg.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return; await pause(100) }
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(exceptions) + '\n' + output.slice(-2000))
  }
  const ready = () => waitFor(`document.querySelector('[data-prompt-editor]') && document.querySelector('[data-slot="sidebar-trigger"]')`)
  const click = async selector => {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pause(400)
  }
  const screenshot = async name => {
    if (!process.env.PI_WINDOW_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_WINDOW_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_WINDOW_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  const reload = async () => { await send('Page.reload'); await pause(300); await ready() }
  await send('Runtime.enable')
  await ready()
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN');localStorage.setItem('theme','dark')`)
  await reload()
  const native = await evaluate('fixture.window()')
  assert.equal(native.content.height, native.bounds.height, 'native title bar consumes no extra height')
  if (process.platform === 'darwin') assert.deepEqual(native.buttons, { x: 16, y: 19 })
  assert.equal(native.dark, true, 'native controls follow the chosen app theme')
  assert.equal(await evaluate(`document.querySelector('[data-window-titlebar]').getBoundingClientRect().height`), 52)
  assert.equal(await evaluate(`document.querySelector('main').getBoundingClientRect().top`), 52)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'drag')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-slot="sidebar-trigger"]')).webkitAppRegion`), 'no-drag')
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true)
  // Capture the real workspace's composited alpha, including every ancestor
  // and the native WebContents backing. A translucent sidebar panel alone
  // cannot prove that glass reaches the window material behind the page.
  const regionAlpha = selector => evaluate(`(()=>{
    const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return fixture.alpha({x:Math.floor(r.right-24),y:Math.floor(r.bottom-24),width:8,height:8});
  })()`)
  const assertTitlebarGlass = async enabled => {
    // Sample empty strips across the full width, below the controls and above
    // the bottom border. Pick the visible page title when the workspace is covered.
    for (const position of [0.125, 0.5, 0.875]) {
      const title = await evaluate(`(()=>{
        const header=[...document.querySelectorAll('[data-window-titlebar]')].find(el=>getComputedStyle(el).visibility==='visible'&&el.getBoundingClientRect().height>0);
        const r=header.getBoundingClientRect();
        return fixture.alpha({x:Math.floor(r.left+r.width*${position}),y:Math.floor(r.bottom-4),width:8,height:2});
      })()`)
      assert.ok(title.pixels > 0, 'the title-row capture contains pixels')
      if (process.platform === 'darwin' && enabled) {
        assert.ok(title.max < 255, 'glass reaches native material across the whole title row: ' + JSON.stringify(title))
      } else {
        assert.equal(title.min, 255, 'the title row is opaque with glass disabled or without a native material')
      }
    }
  }
  const assertWorkspaceGlass = async enabled => {
    const sidebar = await regionAlpha('[data-slot="sidebar"]')
    assert.ok(sidebar.pixels > 0, 'the sidebar capture contains pixels')
    if (process.platform === 'darwin' && enabled) {
      assert.ok(sidebar.max < 255, 'the whole sidebar background leaves the native material visible: ' + JSON.stringify(sidebar))
    } else {
      assert.equal(sidebar.min, 255, 'the sidebar is opaque with glass disabled or without a native material')
    }
    assert.equal((await regionAlpha('main')).min, 255, 'the conversation keeps its opaque background')
    await assertTitlebarGlass(enabled)
  }
  await assertWorkspaceGlass(true)
  // One chrome canvas: every title-row control draws the same 16px compact
  // glyph the sessions sidebar's own controls draw (AGENTS.md · workspace).
  const chromeGlyphs = await evaluate(`(()=>{const sizes=sel=>Array.from(document.querySelectorAll(sel)).map(svg=>[svg.dataset.appIcon,svg.getBoundingClientRect().width,svg.getBoundingClientRect().height]);return{titleRow:sizes('[data-window-titlebar] button svg[data-app-icon]'),sidebar:sizes('[data-slot="sidebar"] [data-slot="sidebar-menu"] svg[data-app-icon]')}})()`)
  assert.ok(chromeGlyphs.sidebar.length >= 2 && chromeGlyphs.sidebar.every(([, width, height]) => width === 16 && height === 16), 'the sessions sidebar draws the compact 16px canvas: ' + JSON.stringify(chromeGlyphs))
  assert.ok(chromeGlyphs.titleRow.length >= 4, 'the title row renders its control glyphs: ' + JSON.stringify(chromeGlyphs))
  assert.ok(chromeGlyphs.titleRow.every(([, width, height]) => width === 16 && height === 16), 'every title-row control glyph matches the sidebar canvas: ' + JSON.stringify(chromeGlyphs))
  await screenshot('dark-home')
  // The row's pocket for later actions: it rests collapsed and keeps nothing
  // tabbable, unfolds to the LEFT of the chevron that leads the right-hand
  // action group, leaves the controls beside it in place, and a pick reaches
  // main and closes it again.
  const pocket = () => evaluate(`(()=>{const p=document.querySelector('[data-titlebar-overflow]');const c=document.querySelector('[data-titlebar-more]');const a=p.querySelector('[data-titlebar-action="reload"]');const k=p.querySelector('[data-titlebar-action="compact"]');const g=document.querySelector('[data-titlebar-action="sidebar-fullscreen"]');const r=g.getBoundingClientRect();return{state:p.dataset.titlebarOverflow,actions:p.querySelectorAll('[data-titlebar-action]').length,expanded:c.getAttribute('aria-expanded'),chevron:c.getBoundingClientRect().toJSON(),neighbour:r.toJSON(),glyph:g.querySelector('svg[data-app-icon]').dataset.appIcon,action:a?a.getBoundingClientRect().toJSON():null,compact:k?k.getBoundingClientRect().toJSON():null,compactGlyph:k?k.querySelector('svg[data-app-icon]').dataset.appIcon:null}})()`)
  // Fullscreen is a row control: it is pressed from the row, never from the
  // pocket, and an outside press on it closes an open pocket like any other
  // control beside the chevron.
  assert.equal(await evaluate(`document.querySelector('[data-titlebar-action="sidebar-fullscreen"]').disabled`), true, 'fullscreen is disabled while the rail is closed')
  await click('[data-titlebar-action="sidebar-fullscreen"]')
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-panel="right"]'))`), false, 'a disabled fullscreen action cannot open the rail')
  const resting = await pocket()
  assert.equal(resting.state, 'closed')
  assert.equal(resting.actions, 0, 'a collapsed pocket keeps no tabbable button')
  assert.equal(resting.expanded, 'false')
  assert.equal(await evaluate(`document.querySelector('[data-titlebar-action="sidebar-fullscreen"]').closest('[data-titlebar-overflow]')===null`), true, 'right-sidebar fullscreen rests in the row, outside the pocket')
  assert.ok(resting.chevron.left < resting.neighbour.left, 'the chevron leads the right-hand action group')
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="reload"]')`)
  const unfolded = await pocket()
  assert.equal(unfolded.state, 'open')
  assert.equal(unfolded.expanded, 'true')
  assert.deepEqual(
    await evaluate(`[...document.querySelectorAll('[data-titlebar-overflow] [data-titlebar-action]')].map(button => button.dataset.titlebarAction)`),
    ['compact', 'reload', 'system-prompt', 'picture-in-picture', 'rewind'],
    'all later actions are in the pocket'
  )
  assert.equal(await evaluate(`document.querySelector('[data-titlebar-action="picture-in-picture"] svg[data-app-icon]').dataset.appIcon`), 'PictureInPicture2')
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-titlebar-overflow] [data-titlebar-action="rewind"]'))`), true, 'the checkpoint entry is one of them')
  assert.notEqual(unfolded.glyph, unfolded.compactGlyph, 'fullscreen and summarize no longer share one glyph')
  assert.equal(unfolded.action.width, 32, 'the revealed button keeps its full size')
  assert.equal(unfolded.compact.width, 32)
  assert.ok(unfolded.compact.right <= unfolded.action.left, 'the pocket lays its actions out in order')
  assert.ok(Math.abs(unfolded.action.right - unfolded.compact.left - 68) < 0.5, 'two 32px buttons and their 4px gaps, nothing squeezed')
  assert.ok(unfolded.action.right <= unfolded.chevron.left + 1, 'the pocket unfolds to the left of the chevron')
  // Sub-pixel: Motion measures the pocket's `auto` width, so the row settles a
  // fraction of a pixel from where it rested.
  assert.ok(Math.abs(unfolded.chevron.left - resting.chevron.left) < 0.5, 'the chevron holds its place while the pocket opens')
  assert.equal(unfolded.neighbour.left, resting.neighbour.left, 'the controls beside the chevron never move')
  assert.ok(unfolded.chevron.right <= await evaluate('innerWidth'), 'the whole pocket stays inside the row')
  await screenshot('dark-titlebar-pocket')
  await click('[data-titlebar-action="reload"]')
  assert.deepEqual(await evaluate('fixture.reloads()'), ['/fixture/chat-0'])
  assert.equal((await pocket()).actions, 0, 'picking an action closes the pocket')
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="compact"]')`)
  await click('[data-titlebar-action="compact"]')
  assert.deepEqual(await evaluate('fixture.compacts()'), ['/fixture/chat-0'])
  assert.equal((await pocket()).actions, 0, 'the second action closes it too')
  await evaluate(`fixture.event({type:'agent_start',sessionPath:'/fixture/chat-0'})`)
  await pause(50)
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="compact"]')`)
  await click('[data-titlebar-action="compact"]')
  await waitFor(`document.querySelector('[data-queue-compaction]')?.textContent.includes('等待压缩上下文')`)
  assert.deepEqual(await evaluate('fixture.compacts()'), ['/fixture/chat-0', '/fixture/chat-0'], 'live clicks reach main instead of being refused in the renderer')
  await pause(250)
  assert.equal(await evaluate(`document.querySelector('[data-queue-compaction]').closest('[data-queue-panel]')!==null`), true, 'the action uses the existing composer queue')
  assert.equal(await evaluate(`document.querySelector('[data-queue-panel]').getBoundingClientRect().bottom<=document.querySelector('[contenteditable="plaintext-only"]').getBoundingClientRect().top`), true, 'the queue remains above the input')
  assert.match(await evaluate(`document.querySelector('[data-queue-compaction]').textContent`), /当前回复与工具调用完成后执行/)
  assert.equal(await evaluate(`document.querySelector('[data-queue-panel]').querySelectorAll('button').length`), 0, 'the action has no message recall or promotion controls')
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="compact"]')`)
  await click('[data-titlebar-action="compact"]')
  assert.equal(await evaluate(`document.querySelectorAll('[data-queue-compaction]').length`), 1, 'repeated clicks keep one pending row')
  await evaluate(`fixture.event({type:'queue_update',sessionPath:'/fixture/chat-0',steering:[{text:'Check the current tool result',originalText:'Check the current tool result',imageCount:0,filePaths:[]}],followUp:[{text:'Review after finishing',originalText:'Review after finishing',imageCount:0,filePaths:[]}]})`)
  await waitFor(`document.querySelectorAll('[data-queue-row]').length===2`)
  assert.match(await evaluate(`document.querySelector('[data-queue-panel]').textContent`), /已排队 · 3/)
  await screenshot('dark-compaction-queue')
  await evaluate(`fixture.event({type:'compaction_queue_update',sessionPath:'/fixture/chat-0',compactionQueue:{queued:false,revision:2}})`)
  await evaluate(`fixture.event({type:'compaction_start',sessionPath:'/fixture/chat-0',reason:'manual'})`)
  await waitFor(`!document.querySelector('[data-queue-compaction]')`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-queue-row]').length`), 2, 'starting compaction preserves ordinary queued messages')
  await evaluate(`fixture.event({type:'compaction_end',sessionPath:'/fixture/chat-0',reason:'manual'})`)
  await evaluate(`fixture.event({type:'queue_update',sessionPath:'/fixture/chat-0',steering:[],followUp:[]})`)
  await waitFor(`!document.querySelector('[data-queue-panel]')`)
  await evaluate(`fixture.scenario('compact-small')`)
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="compact"]')`)
  await click('[data-titlebar-action="compact"]')
  await waitFor(`document.body.textContent.includes('当前会话内容较少，无需总结')`)
  assert.equal((await evaluate('fixture.compacts()')).length, 4, 'too-small live requests also reach main and show its rejection')
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-queue-compaction]'))`), false, 'too-small rejection adds no queued action')
  await evaluate(`fixture.scenario('project')`)
  await evaluate(`fixture.event({type:'agent_settled',sessionPath:'/fixture/chat-0'})`)
  // Escape is the pocket's own key: it closes the surface and claims the event —
  // the flag the composer's Esc-to-stop reads.
  await click('[data-titlebar-more]')
  await waitFor(`document.querySelector('[data-titlebar-action="reload"]')`)
  await evaluate(`window.__esc=null;window.addEventListener('keydown',e=>{if(e.key==='Escape')window.__esc=e.defaultPrevented},false)`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await pause(400)
  assert.equal((await pocket()).actions, 0, 'Escape closes the pocket')
  assert.equal(await evaluate('window.__esc'), true, 'the pocket claims Escape before the rest of the page')
  assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-titlebar-more]')`), true, 'closing hands focus back to the chevron')
  // The rail fills the inset, which starts at the session sidebar's live edge.
  // Read geometry before releasing a drag: checking only the final width would
  // miss a panel that follows React commits but ignores the direct CSS path.
  const railToggle = 'button[aria-label="切换侧边栏"][aria-pressed],button[aria-label="Toggle sidebar"][aria-pressed]'
  const fullAction = '[data-titlebar-action="sidebar-fullscreen"]'
  const toggleFull = async () => {
    assert.equal(await evaluate(`document.querySelector('${fullAction}').disabled`), false)
    await click(fullAction)
  }
  const railGeometry = () => evaluate(`(()=>{
    const rail=document.querySelector('[data-panel="right"]'), main=document.querySelector('main');
    const sidebar=document.querySelector('aside[data-slot="sidebar"]');
    const r=rail.getBoundingClientRect(), m=main.getBoundingClientRect(), s=sidebar.getBoundingClientRect();
    return {rail:r.toJSON(),main:m.toJSON(),sidebar:s.toJSON(),viewport:innerWidth,
      fullscreen:rail.dataset.panelFullscreen==='true',
      covered:rail.contains(document.elementFromPoint(m.left+10,m.top+80)),
      sidebarCovered:rail.contains(document.elementFromPoint(s.right-10,s.top+80))};
  })()`)
  const assertFull = async () => {
    // An occluded native window can defer Motion's first rendered frame even
    // with a zero-duration transition. Check compositor-visible geometry,
    // rather than reading the newly mounted aside's initial width of zero.
    await send('Page.captureScreenshot')
    const g = await railGeometry()
    assert.equal(g.fullscreen, true)
    assert.ok(Math.abs(g.rail.left-g.main.left)<1, 'fullscreen starts at the chat boundary: ' + JSON.stringify(g))
    assert.ok(Math.abs(g.rail.right-g.viewport)<1, 'fullscreen reaches the window edge')
    assert.equal(g.rail.top, 52, 'fullscreen stays below the title row')
    assert.equal(g.rail.bottom, g.main.bottom)
    assert.equal(g.covered, true, 'the rail owns pointer input over the chat')
    assert.equal(g.sidebarCovered, false, 'the session sidebar stays accessible')
    // One VISIBLE rule at the seam. Fullscreen anchors the rail's left edge
    // exactly on the session sidebar's right border, so a painted rail border
    // there stacked a second 1px line against that sidebar rule — a 2px double
    // seam. The rail keeps its 1px box (the pane's width must not change with
    // the mode) but paints nothing: the session sidebar's own rule is the
    // boundary, exactly as it is against the chat when the rail is folded.
    const seam = await evaluate(`(()=>{
      const rail=document.querySelector('[data-panel="right"]');
      const panel=document.querySelector('aside[data-slot="sidebar"] > div:last-child');
      const r=getComputedStyle(rail.firstElementChild), s=getComputedStyle(panel);
      return {railWidth:r.borderLeftWidth,railRule:r.borderLeftColor,sidebarWidth:s.borderRightWidth,sidebarRule:s.borderRightColor};
    })()`)
    assert.equal(seam.railWidth, '1px', 'the fullscreen rail keeps its 1px border box: ' + JSON.stringify(seam))
    assert.equal(seam.railRule, 'rgba(0, 0, 0, 0)', 'the fullscreen rail paints no rule of its own: ' + JSON.stringify(seam))
    assert.equal(seam.sidebarWidth, '1px')
    assert.notEqual(seam.sidebarRule, 'rgba(0, 0, 0, 0)', 'the session sidebar draws the fullscreen seam: ' + JSON.stringify(seam))
    return g
  }
  await click(railToggle)
  const docked = await railGeometry()
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-panel="right"]').firstElementChild).borderLeftWidth`), '1px', 'the docked rail draws its own left rule')
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('[data-panel="right"]').firstElementChild).borderLeftColor`), 'rgba(0, 0, 0, 0)', 'the docked rail paints its own left rule')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('aside[data-slot="sidebar"] > div:last-child')).borderRightWidth`), '1px', 'the session sidebar keeps its right rule')
  await evaluate(`window.__railBeforeFullscreen=document.querySelector('[data-panel="right"]');window.__composerBeforeFullscreen=document.querySelector('[data-prompt-editor]');void 0`)
  await toggleFull()
  await assertFull()
  assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').closest('[inert]')!==null`), true, 'the covered composer cannot receive keyboard focus')
  assert.equal(await evaluate(`document.querySelector('[data-panel-handle="left"]')===null`), true, 'the docked divider is absent in fullscreen')
  await screenshot('dark-sidebar-fullscreen')
  await toggleFull()
  assert.ok(Math.abs((await railGeometry()).rail.width-docked.rail.width)<1, 'leaving fullscreen restores docked width')
  assert.equal(await evaluate(`document.querySelector('[data-panel="right"]')===window.__railBeforeFullscreen && document.querySelector('[data-prompt-editor]')===window.__composerBeforeFullscreen`), true, 'fullscreen retains rail and composer DOM')
  await toggleFull()
  for (const width of [1100, 1400, 1320]) {
    await evaluate(`fixture.resize(${width},880)`)
    await pause(400)
    await assertFull()
  }
  const beforeDrag = await railGeometry()
  const handle = await evaluate(`(()=>{const r=document.querySelector('[data-panel-handle="right"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+120}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 })
  for (const dx of [16, 48, -24, 64]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x+dx, y: handle.y, button: 'left', buttons: 1 })
    await pause(80)
    const g = await railGeometry()
    assert.ok(Math.abs(g.rail.left-g.main.left)<1, 'fullscreen follows every drag frame')
    assert.ok(Math.abs(g.rail.right-g.viewport)<1)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x+64, y: handle.y, button: 'left', clickCount: 1 })
  await pause(400)
  assert.ok((await assertFull()).rail.left > beforeDrag.rail.left+40, 'session resize really changed the fullscreen boundary')
  await click('[data-slot="sidebar-trigger"]')
  assert.ok((await assertFull()).rail.left<1, 'fullscreen also follows session-sidebar collapse')
  await click('[data-slot="sidebar-trigger"]')
  await assertFull()
  await click(railToggle)
  await click(railToggle)
  assert.equal((await railGeometry()).fullscreen, false, 'folding and reopening never restores fullscreen')
  await evaluate(`[...document.querySelectorAll('[data-panel="right"] button')].find(b=>b.textContent.includes('审查')).click()`)
  await pause(400)
  await toggleFull()
  await click('[data-sidebar-tab="review"] button[aria-label]')
  await waitFor(`!document.querySelector('[data-panel="right"]')`)
  await click(railToggle)
  assert.equal((await railGeometry()).fullscreen, false, 'closing the last tab also clears fullscreen')
  await click(railToggle)
  console.log('PASS: sidebar fullscreen bounds, live resize, retained DOM, restored width and fold reset')
  // Copy-session-ID follows Rename and precedes destructive Delete, alongside
  // the other session actions, and copies the session's own ID — not its file
  // path. `navigator.clipboard` refuses an unfocused document, so the write is
  // wrapped in the focus emulation the other CDP checks use.
  await click('[data-resource-id="/fixture/chat-0"] button[aria-label]')
  const rowMenu = '[data-sidebar-resource-menu="/fixture/chat-0"]'
  await waitFor(`document.querySelector('${rowMenu}')`)
  const menuRows = await evaluate(`[...document.querySelectorAll('${rowMenu} button')].map((b) => b.innerText.trim())`)
  const renameIndex = menuRows.indexOf('重命名'), copyIndex = menuRows.indexOf('复制会话 ID'), deleteIndex = menuRows.indexOf('删除会话')
  assert.ok(renameIndex >= 0 && renameIndex < copyIndex && copyIndex < deleteIndex, `the ID action follows Rename and precedes Delete: ${JSON.stringify(menuRows)}`)
  assert.equal(menuRows.at(-1), '删除会话', 'Delete remains the final, destructive action')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await evaluate(`navigator.clipboard.writeText('__NOT_COPIED__')`)
  const copyPoint = await evaluate(`(()=>{const b=[...document.querySelectorAll('${rowMenu} button')].find((n) => n.innerText.trim()==='复制会话 ID');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...copyPoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...copyPoint, button: 'left', clickCount: 1 })
  await pause(400)
  assert.equal(await evaluate('navigator.clipboard.readText()'), 'chat-0', 'the action copies the session ID, not the file path')
  assert.deepEqual(await evaluate('fixture.opens()'), [], 'a menu action must not select the session it belongs to')
  await waitFor(`!document.querySelector('${rowMenu}')`)
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  // Real mouse events exercise the controls inside the draggable strip.
  await click('[data-slot="sidebar-trigger"]')
  assert.equal(await evaluate(`document.querySelector('[data-slot="sidebar-trigger"]').getAttribute('aria-expanded')`), 'false')
  assert.ok(await evaluate(`document.querySelector('main').getBoundingClientRect().width>innerWidth-2`))
  await screenshot('collapsed-sidebar')
  await click('[data-slot="sidebar-trigger"]')
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-prompt-editor]').focus()` })
  await send('Input.insertText', { text: '保留这份草稿 / keep this draft' })
  await click('button[aria-label="设置"]')
  assert.ok(await evaluate(`document.querySelector('button[aria-label="返回对话"]').getBoundingClientRect().left>=${process.platform === 'darwin' ? 92 : 12}`))
  await assertTitlebarGlass(true)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.workspace-window > [data-window-titlebar]')).visibility`), 'hidden', 'the covered title controls do not show through page glass')
  // Startup preference: the saved choice is the selected radio, and picking the
  // other one writes it back through the bridge.
  const startupRadio = label => `(()=>{const l=[...document.querySelectorAll('label')].find(n=>n.innerText.trim()===${JSON.stringify(label)});return l?l.querySelector('[role="radio"]'):null})()`
  assert.equal(await evaluate(`${startupRadio('打开上次的会话')}.getAttribute('aria-checked')`), 'true', 'the persisted choice is selected')
  const startupPoint = await evaluate(`(()=>{const r=${startupRadio('总是新建会话')}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...startupPoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...startupPoint, button: 'left', clickCount: 1 })
  await pause(400)
  assert.equal(await evaluate(`${startupRadio('总是新建会话')}.getAttribute('aria-checked')`), 'true')
  assert.deepEqual(await evaluate('fixture.startupChoices()'), ['new'])
  await screenshot('settings')
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(button=>button.textContent.trim()==='外观').click()`)
  const glassCheckbox = '[role="checkbox"][aria-label="半透明顶栏和侧栏"]'
  await waitFor(`document.querySelector('${glassCheckbox}')`)
  await evaluate(`document.querySelector('${glassCheckbox}').scrollIntoView({block:'center'})`)
  await pause(300)
  await click(glassCheckbox)
  assert.equal(await evaluate(`document.querySelector('${glassCheckbox}').getAttribute('aria-checked')`), 'false')
  await assertTitlebarGlass(false)
  await screenshot('settings-glass-off')
  await click('button[aria-label="返回对话"]')
  await assertWorkspaceGlass(false)
  await click('button[aria-label="设置"]')
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(button=>button.textContent.trim()==='外观').click()`)
  await evaluate(`document.querySelector('${glassCheckbox}').scrollIntoView({block:'center'})`)
  await pause(300)
  await click(glassCheckbox)
  await assertTitlebarGlass(true)
  await screenshot('settings-glass-on')
  await click('button[aria-label="返回对话"]')
  await assertWorkspaceGlass(true)
  assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').textContent`), '保留这份草稿 / keep this draft')
  await click('button[aria-label="搜索会话"]')
  await waitFor(`document.querySelector('[aria-modal="true"]')`)
  // The "exclude tools, files and thinking" filter is a square point-select
  // box, not a switch, it is CHECKED by default (details excluded unless the
  // user asks), and it is sized to the row's own 12px text.
  const detailsBox = await evaluate(`(()=>{const dialog=document.querySelector('[aria-modal="true"]');const box=dialog.querySelector('[role="checkbox"]');if(!box)return null;const label=document.querySelector('label[for="'+box.id+'"]');const r=box.getBoundingClientRect();return {switches:dialog.querySelectorAll('[role="switch"]').length,checked:box.getAttribute('aria-checked'),label:label?label.innerText.trim():null,width:r.width,radius:getComputedStyle(box).borderTopLeftRadius}})()`)
  assert.ok(detailsBox, 'the search filter renders a checkbox')
  assert.equal(detailsBox.switches, 0, 'and no switch next to it')
  assert.equal(detailsBox.checked, 'true', 'it starts ON — details are excluded and search covers prose only')
  assert.ok(detailsBox.label?.includes('排除'), `its label reads as an exclusion and is associated: ${JSON.stringify(detailsBox)}`)
  assert.equal(detailsBox.width, 14, `the box is text-sized: ${JSON.stringify(detailsBox)}`)
  assert.equal(detailsBox.radius, '0px', 'and hard-edged like every other control')
  await screenshot('search-details')
  await click('[role="checkbox"]')
  assert.equal(await evaluate(`document.querySelector('[role="checkbox"]').getAttribute('aria-checked')`), 'false', 'clicking the box toggles the exclusion off')
  await click('[role="checkbox"]')
  assert.equal(await evaluate(`document.querySelector('[role="checkbox"]').getAttribute('aria-checked')`), 'true', 'and back on')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'no-drag')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await pause(400)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'drag')
  await evaluate(`fixture.resize(800,600)`)
  await pause(400)
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true)
  await screenshot('compact-home')
  await evaluate(`fixture.resize(760,560)`)
  await pause(400)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'drag', 'closed mobile sidebar must not own the title row')
  await click('[data-slot="sidebar-trigger"]')
  assert.ok(await evaluate(`document.querySelector('[data-mobile="true"] button').getBoundingClientRect().top>=52`), 'mobile navigation clears the native controls')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'no-drag')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await pause(400)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-titlebar]')).webkitAppRegion`), 'drag')
  await evaluate(`fixture.resize(800,600)`)
  await pause(400)
  await evaluate(`fixture.scenario('long');localStorage.setItem('pi-app:locale','en');localStorage.setItem('theme','light')`)
  // The installed Motion hook samples the OS preference when mounted. Set
  // this scenario before reload so it actually exercises reduced motion.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await reload()
  assert.equal((await evaluate('fixture.window()')).dark, false)
  await assertWorkspaceGlass(true)
  await waitFor(`document.querySelector('[data-window-titlebar]').innerText.includes('A very long session title')`)
  // Long labels must keep window controls reachable; a private fade marker is
  // an implementation detail rather than an observable layout contract.
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, 'long labels do not overflow the window')
  assert.ok(await evaluate(`document.querySelector('[aria-label="Toggle sidebar"][aria-pressed]').getBoundingClientRect().right<=innerWidth`))
  await screenshot('light-long-title')
  await click(railToggle)
  assert.equal(await evaluate(`document.querySelector('${fullAction}').getAttribute('aria-label')`), 'Expand sidebar over chat')
  await click(fullAction)
  await assertFull()
  await screenshot('light-sidebar-fullscreen-reduced')
  await toggleFull()
  assert.equal((await railGeometry()).fullscreen, false, 'fullscreen exits under reduced motion too')
  await click(railToggle)
  await send('Emulation.setEmulatedMedia', { features: [] })
  await evaluate(`fixture.scenario('projectless')`)
  await reload()
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-window-titlebar]').innerText`), /internal|private-workspace|pi-app/)
  await evaluate(`fixture.resize(1320,880)`)
  await pause(400)
  await screenshot('light-projectless')
  await evaluate(`fixture.fullscreen(true)`)
  await waitFor(`fixture.window().then(w=>w.fullscreen)`)
  await pause(800)
  assert.ok(await evaluate(`document.querySelector('[data-slot="sidebar-trigger"]').getBoundingClientRect().left>=${process.platform === 'darwin' ? 92 : 12}`))
  await evaluate(`fixture.fullscreen(false)`)
  await waitFor(`fixture.window().then(w=>!w.fullscreen)`)
  assert.deepEqual(exceptions, [])
  console.log('PASS: native title row, themes, composited sidebar transparency, control hit targets, titlebar pocket, session row menu, sidebar, settings/draft, modal ownership, narrow layout, long titles, projectless privacy and fullscreen')
  if (process.env.PI_WINDOW_INSPECT) {
    console.log('Inspection endpoint: ' + endpoint)
    await evaluate(`fixture.scenario('project');localStorage.setItem('pi-app:locale','zh-CN');localStorage.setItem('theme','dark')`)
    await reload()
    await pause(60000)
  }
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
