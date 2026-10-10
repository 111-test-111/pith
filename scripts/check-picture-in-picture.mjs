/** Built renderer + real Electron picture-in-picture window, isolated profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-pip-'))
const renderer = join(repo, 'out/renderer/index.html')
const preload = join(repo, 'out/preload/index.mjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child
const sockets = []

try {
  // External production dependencies resolve from the isolated fixture entry.
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const fixturePreload = join(temporary, 'preload.mjs')
  await writeFile(fixturePreload, `import ${JSON.stringify(preload)};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{windows:()=>ipcRenderer.invoke('fixture:windows'),blurCompact:()=>ipcRenderer.invoke('fixture:blurCompact'),focusCompact:()=>ipcRenderer.invoke('fixture:focusCompact'),display:()=>ipcRenderer.invoke('fixture:display'),settings:()=>ipcRenderer.invoke('fixture:settings'),moveCompact:(x,y)=>ipcRenderer.invoke('fixture:moveCompact',x,y)});`)
  const fixtureMain = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
import {app,BrowserWindow,ipcMain,screen} from 'electron';
import {registerPictureInPictureIpc} from ${JSON.stringify(join(repo, 'src/main/picture-in-picture.ts'))};
import {loadSettings,updatePictureInPicturePreferences} from ${JSON.stringify(join(repo, 'src/main/settings.ts'))};
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const pip=registerPictureInPictureIpc({preload:${JSON.stringify(preload)},documentUrl:${JSON.stringify(pathToFileURL(renderer).toString())}});
 ipcMain.handle('window:pipPreferences',()=>loadSettings().pictureInPicture);
 ipcMain.handle('window:pipSetPreferences',(_event,update)=>{const next=updatePictureInPicturePreferences(update);pip.setPreferences(next);return next});
 const sessionPath='/fixture/chat';
 const snapshot=()=>({sessionId:'fixture',sessionPath,cwd:'/fixture',projectless:false,messages:[{role:'user',content:'Check this task.',timestamp:1}],model:null,thinkingLevel:'off',isStreaming:false,eventSequence:0});
 const w=new BrowserWindow({...windowChromeOptions(),width:1000,height:700,webPreferences:{preload:${JSON.stringify(fixturePreload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 ipcMain.handle('app:info',()=>({cwd:'/fixture',folders:['/fixture'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:peekSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[{id:'fixture',path:sessionPath,cwd:'/fixture',projectless:false,label:'Picture-in-picture check',modified:new Date().toISOString(),messageCount:1,running:false}]);
 ipcMain.handle('pi:models',()=>[]);ipcMain.handle('pi:providers',()=>[]);ipcMain.handle('bash:list',()=>[]);
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 ipcMain.handle('fixture:windows',()=>{const compact=BrowserWindow.getAllWindows().find(win=>win!==w);return{mainVisible:w.isVisible(),compact:compact?{visible:compact.isVisible(),focused:compact.isFocused(),alwaysOnTop:compact.isAlwaysOnTop(),movable:compact.isMovable(),resizable:compact.isResizable(),bounds:compact.getBounds(),minimum:compact.getMinimumSize(),maximum:compact.getMaximumSize()}:null,mainBridgeOwner:pip.mainWindow()===w}});
 ipcMain.handle('fixture:blurCompact',()=>{BrowserWindow.getAllWindows().find(win=>win!==w)?.blur()});
 ipcMain.handle('fixture:focusCompact',()=>{BrowserWindow.getAllWindows().find(win=>win!==w)?.focus()});
 ipcMain.handle('fixture:display',()=>screen.getDisplayMatching(w.getBounds()).workArea);
 ipcMain.handle('fixture:settings',()=>({preferences:loadSettings().pictureInPicture,last:loadSettings().pictureInPictureLast}));
 ipcMain.handle('fixture:moveCompact',(_event,x,y)=>{BrowserWindow.getAllWindows().find(win=>win!==w)?.setPosition(x,y)});
 w.loadFile(${JSON.stringify(renderer)});
});app.on('window-all-closed',()=>app.quit());`,
      resolveDir: repo,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: fixtureMain
  })
  child = spawn(electron, [fixtureMain], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Electron exited: ${code}\n${output}`)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) }
    })
  })

  async function target(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const pages = await (await fetch(`${endpoint}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && predicate(entry))
      if (page) return page
      await pause(100)
    }
    throw new Error(`No matching CDP target: ${output.slice(-1500)}`)
  }

  async function connect(page) {
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    sockets.push(socket)
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
    let sequence = 0
    const pending = new Map()
    const exceptions = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (message) => message.error ? reject(message.error) : resolve(message.result))
      socket.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    const evaluate = async (expression) => {
      let timer
      try {
        const result = await Promise.race([
          send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP evaluation timed out: ${expression}`)), 5000) })
        ])
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
        return result.result.value
      } finally { clearTimeout(timer) }
    }
    return { send, evaluate, exceptions }
  }

  async function waitFor(evaluate, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return
      await pause(100)
    }
    throw new Error(`Timed out: ${expression}\n${output.slice(-1500)}`)
  }

  const main = await connect(await target((page) => !page.url.includes('view=pip')))
  await waitFor(main.evaluate, `document.querySelector('[data-prompt-editor]')`)
  await main.evaluate(`localStorage.setItem('pi-app:locale','en')`)
  await main.evaluate(`localStorage.setItem('theme',${JSON.stringify(process.env.PI_PIP_THEME === 'dark' ? 'dark' : 'light')})`)
  const probe = (selector, color) => `(()=>{
    const host=document.querySelector(${JSON.stringify(selector)});
    if(!host)return false;
    host.style.position='relative';
    let mark=host.querySelector('[data-pip-probe]');
    if(!mark){mark=document.createElement('div');mark.dataset.pipProbe='true';mark.style.cssText='position:absolute;inset:0;z-index:1000;pointer-events:none';host.append(mark)}
    mark.style.backgroundColor=${JSON.stringify(color)};
    return true
  })()`
  const pixel = `(()=>{const img=document.querySelector('[data-pip-frame]');if(!img?.complete||!img.naturalWidth)return null;const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,Math.floor(img.naturalWidth/2),Math.floor(img.naturalHeight/2),1,1,0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data)})()`
  const pipTargetIds = new Set()
  const compactTargets = []
  const openCompact = async () => {
    await main.evaluate(`document.querySelector('[data-titlebar-more]').click()`)
    await waitFor(main.evaluate, `document.querySelector('[data-titlebar-action="picture-in-picture"]')`)
    await main.evaluate(`document.querySelector('[data-titlebar-action="picture-in-picture"]').click()`)
    await waitFor(main.evaluate, `fixture.windows().then(value=>!value.mainVisible&&value.compact?.visible)`)
    const page = await target((entry) => entry.url.includes('view=pip') && !pipTargetIds.has(entry.id))
    pipTargetIds.add(page.id)
    const compact = await connect(page)
    await waitFor(compact.evaluate, `document.querySelector('[data-pip-frame]')?.naturalWidth>0`)
    compactTargets.push(compact)
    return compact
  }

  const conversationBounds = await main.evaluate(`document.querySelector('[data-pip-source="conversation"]').getBoundingClientRect().toJSON()`)
  assert.equal(await main.evaluate(probe('[data-pip-source="conversation"]', '#e02020')), true)
  const compact = await openCompact()
  const state = await compact.evaluate(`window.pi.pictureInPictureState()`)
  assert.equal(state.sessionPath, '/fixture/chat')
  assert.equal(state.source, 'conversation')
  assert.equal(state.pinned, true)
  assert.equal(state.frameRate, 5)
  const conversationFrame = await compact.evaluate(`window.pi.pictureInPictureFrame().then(frame=>({width:frame.width,height:frame.height}))`)
  assert.ok(Math.abs(conversationFrame.width / conversationFrame.height - conversationBounds.width / conversationBounds.height) < 0.02, 'only the conversation bounds are captured')
  assert.equal(await compact.evaluate(`getComputedStyle(document.querySelector('[data-pip-drag]')).webkitAppRegion`), 'drag')
  assert.equal(await compact.evaluate(`getComputedStyle(document.querySelector('[data-pip-controls] button')).webkitAppRegion`), 'no-drag')
  const native = await main.evaluate(`fixture.windows()`)
  assert.equal(native.mainVisible, false)
  assert.equal(native.mainBridgeOwner, true)
  assert.equal(native.compact.alwaysOnTop, true)
  assert.equal(native.compact.movable, true)
  assert.equal(native.compact.resizable, true)
  assert.ok(native.compact.minimum[0] >= 260 && native.compact.minimum[1] >= 180)
  assert.ok(native.compact.maximum[0] <= 560 && native.compact.maximum[1] <= 520)
  await waitFor(compact.evaluate, `${pixel}?.[0]>180 && ${pixel}?.[1]<80 && ${pixel}?.[2]<80`)

  // Change the actual source DOM after its native window has been hidden.
  assert.equal(await main.evaluate(probe('[data-pip-source="conversation"]', '#2020e0')), true)
  await waitFor(compact.evaluate, `${pixel}?.[2]>180 && ${pixel}?.[0]<80 && ${pixel}?.[1]<80`)
  assert.ok(await compact.evaluate(`window.pi.pictureInPictureFrame().then(frame=>frame?.sequence>1)`))
  if (process.env.PI_PIP_SCREENSHOT_DIR) {
    await main.evaluate(probe('[data-pip-source="conversation"]', 'transparent'))
    await pause(400)
    await mkdir(process.env.PI_PIP_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_PIP_SCREENSHOT_DIR, 'picture-in-picture-conversation.png'), Buffer.from((await compact.send('Page.captureScreenshot')).data, 'base64'))
  }

  await main.evaluate(`fixture.blurCompact()`)
  await waitFor(compact.evaluate, `document.querySelector('[data-pip-controls]')?.dataset.focused==='false'`)
  await waitFor(compact.evaluate, `Number(getComputedStyle(document.querySelector('[data-pip-controls]')).opacity)<0.01`)
  await main.evaluate(`fixture.focusCompact()`)
  await waitFor(compact.evaluate, `document.querySelector('[data-pip-controls]')?.dataset.focused==='true'`)
  assert.equal(await compact.evaluate(`document.querySelector('[data-pip-controls]').classList.contains('opacity-100')`), true)

  await compact.evaluate(`document.querySelector('button[aria-label="Stop keeping on top"]').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.compact?.alwaysOnTop===false)`)
  for (let index = 0; index < 20; index++) await compact.evaluate(`window.pi.zoomPictureInPicture('in')`)
  const largest = await main.evaluate(`fixture.windows().then(value=>value.compact)`)
  assert.ok(largest.bounds.width <= largest.maximum[0] && largest.bounds.height <= largest.maximum[1])
  assert.equal(await compact.evaluate(`window.pi.pictureInPictureState().then(value=>value.canZoomIn)`), false)
  await waitFor(compact.evaluate, `document.querySelector('button[aria-label="Enlarge window"]').disabled`)
  for (let index = 0; index < 20; index++) await compact.evaluate(`window.pi.zoomPictureInPicture('out')`)
  const smallest = await main.evaluate(`fixture.windows().then(value=>value.compact)`)
  assert.ok(smallest.bounds.width >= smallest.minimum[0] && smallest.bounds.height >= smallest.minimum[1])
  assert.equal(await compact.evaluate(`window.pi.pictureInPictureState().then(value=>value.canZoomOut)`), false)
  await waitFor(compact.evaluate, `document.querySelector('button[aria-label="Shrink window"]').disabled`)
  await compact.evaluate(`document.querySelector('button[aria-label="Return to app"]').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.mainVisible&&!value.compact)`)

  const rejected = await main.evaluate(`window.pi.setPictureInPicturePreferences({frameRate:999,position:'off-screen',initialScale:'12',startPinned:'yes'})`)
  assert.deepEqual(rejected, { frameRate: 5, position: 'last', initialScale: 'last', startPinned: true }, 'unsupported values cannot enter persisted preferences')
  const configured = await main.evaluate(`window.pi.setPictureInPicturePreferences({frameRate:1,position:'center',initialScale:'35',startPinned:false})`)
  assert.deepEqual(configured, { frameRate: 1, position: 'center', initialScale: '35', startPinned: false })
  assert.deepEqual((await main.evaluate(`fixture.settings()`)).preferences, configured, 'preferences persist to app-settings.json')

  // A full-screen side panel is the sole projected source in this mode.
  await main.evaluate(`document.querySelector('button[aria-label="Toggle sidebar"][aria-pressed],button[aria-label="切换侧边栏"][aria-pressed]').click()`)
  await waitFor(main.evaluate, `document.querySelector('[data-panel="right"]')`)
  await main.evaluate(`document.querySelector('[data-titlebar-action="sidebar-fullscreen"]').click()`)
  await waitFor(main.evaluate, `document.querySelector('[data-panel="right"][data-panel-fullscreen]')`)
  await pause(400)
  const sidebarBounds = await main.evaluate(`document.querySelector('[data-panel="right"][data-panel-fullscreen]').getBoundingClientRect().toJSON()`)
  assert.equal(await main.evaluate(probe('[data-panel="right"][data-panel-fullscreen]', '#20d020')), true)
  const panelCompact = await openCompact()
  const panelState = await panelCompact.evaluate(`window.pi.pictureInPictureState()`)
  assert.equal(panelState.source, 'sidebar')
  assert.equal(panelState.frameRate, 1)
  assert.equal(panelState.pinned, false)
  const workArea = await main.evaluate(`fixture.display()`)
  const centered = await main.evaluate(`fixture.windows().then(value=>value.compact)`)
  assert.equal(centered.alwaysOnTop, false)
  assert.ok(Math.abs(centered.bounds.x - Math.round(workArea.x + (workArea.width - centered.bounds.width) / 2)) <= 1)
  assert.ok(Math.abs(centered.bounds.y - Math.round(workArea.y + (workArea.height - centered.bounds.height) / 2)) <= 1)
  assert.equal(centered.bounds.width, Math.max(centered.minimum[0], Math.min(centered.maximum[0], Math.round(sidebarBounds.width * 0.35))))
  await main.evaluate(`window.pi.setPictureInPicturePreferences({frameRate:2})`)
  await waitFor(panelCompact.evaluate, `window.pi.pictureInPictureState().then(value=>value.frameRate===2)`)
  const sidebarFrame = await panelCompact.evaluate(`window.pi.pictureInPictureFrame().then(frame=>({width:frame.width,height:frame.height}))`)
  assert.ok(Math.abs(sidebarFrame.width / sidebarFrame.height - sidebarBounds.width / sidebarBounds.height) < 0.02, 'only the fullscreen sidebar bounds are captured')
  await waitFor(panelCompact.evaluate, `${pixel}?.[1]>140 && ${pixel}?.[0]<80 && ${pixel}?.[2]<80`)
  if (process.env.PI_PIP_SCREENSHOT_DIR) {
    await main.evaluate(probe('[data-panel="right"][data-panel-fullscreen]', 'transparent'))
    await pause(400)
    await writeFile(join(process.env.PI_PIP_SCREENSHOT_DIR, 'picture-in-picture-sidebar.png'), Buffer.from((await panelCompact.send('Page.captureScreenshot')).data, 'base64'))
  }
  await panelCompact.evaluate(`window.pi.zoomPictureInPicture('in')`)
  await panelCompact.evaluate(`window.pi.zoomPictureInPicture('in')`)
  const lastX = workArea.x + 64
  const lastY = workArea.y + 72
  await main.evaluate(`fixture.moveCompact(${lastX},${lastY})`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.compact?.bounds.x===${lastX}&&value.compact?.bounds.y===${lastY})`)
  const lastSize = await main.evaluate(`fixture.windows().then(value=>value.compact.bounds.width)`)
  await panelCompact.evaluate(`document.querySelector('button[aria-label="Return to app"]').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.mainVisible&&!value.compact)`)
  const remembered = await main.evaluate(`fixture.settings().then(value=>value.last)`)
  assert.equal(remembered.x, lastX)
  assert.equal(remembered.y, lastY)
  assert.ok(Math.abs(remembered.scale - lastSize / sidebarBounds.width) < 0.001)

  await main.evaluate(`window.pi.setPictureInPicturePreferences({frameRate:10,position:'last',initialScale:'last',startPinned:true})`)
  const recalledCompact = await openCompact()
  const recalled = await main.evaluate(`fixture.windows().then(value=>value.compact)`)
  assert.equal(recalled.bounds.x, lastX)
  assert.equal(recalled.bounds.y, lastY)
  assert.equal(recalled.bounds.width, lastSize)
  assert.equal(recalled.alwaysOnTop, true)
  assert.equal(await recalledCompact.evaluate(`window.pi.pictureInPictureState().then(value=>value.frameRate)`), 10)
  await recalledCompact.evaluate(`document.querySelector('button[aria-label="Return to app"]').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.mainVisible&&!value.compact)`)

  for (const [position, xSide, ySide] of [
    ['top-left', 'left', 'top'],
    ['top-right', 'right', 'top'],
    ['bottom-left', 'left', 'bottom'],
    ['bottom-right', 'right', 'bottom']
  ]) {
    await main.evaluate(`window.pi.setPictureInPicturePreferences({position:${JSON.stringify(position)},initialScale:'50'})`)
    const cornerCompact = await openCompact()
    const corner = await main.evaluate(`fixture.windows().then(value=>value.compact.bounds)`)
    const expectedX = xSide === 'left' ? workArea.x + 24 : workArea.x + workArea.width - corner.width - 24
    const expectedY = ySide === 'top' ? workArea.y + 24 : workArea.y + workArea.height - corner.height - 24
    assert.ok(Math.abs(corner.x - expectedX) <= 1 && Math.abs(corner.y - expectedY) <= 1, `${position} placement`)
    await cornerCompact.evaluate(`document.querySelector('button[aria-label="Return to app"]').click()`)
    await waitFor(main.evaluate, `fixture.windows().then(value=>value.mainVisible&&!value.compact)`)
  }
  assert.deepEqual(main.exceptions, [])
  for (const target of compactTargets) assert.deepEqual(target.exceptions, [])
  console.log('PASS: live crops, focus controls, bounded zoom, frame rate, persisted position/scale, all corners, pin and restore')
} finally {
  for (const socket of sockets) socket.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) })
  }
  await rm(temporary, { recursive: true, force: true })
}
