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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{resize:(width,height)=>ipcRenderer.invoke('fixture:resize',width,height)});`)
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
   label:i===0?long:labels[i%labels.length]+' '+i,created:new Date().toISOString(),modified:new Date(Date.now()-i*1000).toISOString(),messageCount:2}));
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:${JSON.stringify(['/workspace/pi-app', '/workspace/piws', '/workspace/desktop'])},version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>sessions);
 ipcMain.handle('pi:openSession',()=>snapshot());ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('bash:list',()=>[]);ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:reload',()=>snapshot());ipcMain.handle('pi:compact',()=>snapshot());
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('fixture:resize',(_,width,height)=>win.setBounds({width,height}));
 const win=new BrowserWindow({width:1100,height:700,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 win.loadFile(${JSON.stringify(join(repo, 'out/renderer/index.html'))});
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
    throw new Error('never settled: ' + expression + '\n' + JSON.stringify(exceptions))
  }
  const shotDir = process.env.PI_SIDEBAR_LIST_SCREENSHOT_DIR
  const shoot = async (name, clip) => {
    if (!shotDir) return
    await mkdir(shotDir, { recursive: true })
    const image = await send('Page.captureScreenshot', clip ? { clip } : {})
    await writeFile(join(shotDir, name + '.png'), Buffer.from(image.data, 'base64'))
  }

  await send('Runtime.enable')
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN');localStorage.setItem('theme','light')`)
  await send('Page.reload')
  await waitFor(`document.querySelector('textarea') && document.querySelector('[role="tree"]')`)
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
    const longLabel=rows.map((row)=>row.querySelector('span.relative')).find((label)=>label&&label.scrollWidth>label.clientWidth);
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
      labelMask:longLabel?getComputedStyle(longLabel).maskImage:null,
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

  // 5. The list's own mask must not cost the label its own fade: a title wider
  //    than its row still wears the marquee's horizontal ramp.
  assert.equal(atTop.labelOverflows, true, 'the fixture\'s first title really is wider than its row')
  assert.match(atTop.labelMask, /calc\(100% - 32px\)/, 'the overflowing title keeps its horizontal fade: ' + atTop.labelMask)

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
