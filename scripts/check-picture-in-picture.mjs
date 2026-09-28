/** Built renderer + real Electron picture-in-picture window, isolated profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  const fixturePreload = join(temporary, 'preload.mjs')
  await writeFile(fixturePreload, `import ${JSON.stringify(preload)};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{windows:()=>ipcRenderer.invoke('fixture:windows'),emit:event=>ipcRenderer.invoke('fixture:emit',event)});`)
  const fixtureMain = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
import {registerPictureInPictureIpc} from ${JSON.stringify(join(repo, 'src/main/picture-in-picture.ts'))};
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const pip=registerPictureInPictureIpc({preload:${JSON.stringify(preload)},documentUrl:${JSON.stringify(pathToFileURL(renderer).toString())}});
 const sessionPath='/fixture/chat';
 const snapshot=()=>({sessionId:'fixture',sessionPath,cwd:'/fixture',projectless:false,messages:[{role:'user',content:'Check this task.',timestamp:1}],model:null,thinkingLevel:'off',isStreaming:false,eventSequence:0});
 const w=new BrowserWindow({...windowChromeOptions(),width:1000,height:700,webPreferences:{preload:${JSON.stringify(fixturePreload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 ipcMain.handle('app:info',()=>({cwd:'/fixture',folders:['/fixture'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:peekSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[{id:'fixture',path:sessionPath,cwd:'/fixture',projectless:false,label:'Picture-in-picture check',modified:new Date().toISOString(),messageCount:1,running:false}]);
 ipcMain.handle('pi:models',()=>[]);ipcMain.handle('pi:providers',()=>[]);ipcMain.handle('bash:list',()=>[]);
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 ipcMain.handle('fixture:windows',()=>{const compact=BrowserWindow.getAllWindows().find(win=>win!==w);return{mainVisible:w.isVisible(),compact:compact?{visible:compact.isVisible(),alwaysOnTop:compact.isAlwaysOnTop(),movable:compact.isMovable(),bounds:compact.getBounds()}:null,mainBridgeOwner:pip.mainWindow()===w}});
 ipcMain.handle('fixture:emit',(_event,value)=>{for(const win of BrowserWindow.getAllWindows())win.webContents.send('pi:event',value)});
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
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
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
  await main.evaluate(`document.querySelector('[data-titlebar-more]').click()`)
  await waitFor(main.evaluate, `document.querySelector('[data-titlebar-action="picture-in-picture"]')`)
  await main.evaluate(`document.querySelector('[data-titlebar-action="picture-in-picture"]').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>!value.mainVisible&&value.compact?.visible)`)
  const compact = await connect(await target((page) => page.url.includes('view=pip')))
  await waitFor(compact.evaluate, `document.querySelector('[data-pip-window]') && document.querySelector('[data-pip-response]')`)
  assert.deepEqual(await compact.evaluate(`window.pi.pictureInPictureState()`), { sessionPath: '/fixture/chat', pinned: true })
  assert.equal(await compact.evaluate(`document.querySelector('[data-pip-window]').getBoundingClientRect().width`), 380)
  assert.equal(await compact.evaluate(`getComputedStyle(document.querySelector('[data-pip-drag]')).webkitAppRegion`), 'drag')
  assert.equal(await compact.evaluate(`getComputedStyle(document.querySelector('[data-pip-drag] button')).webkitAppRegion`), 'no-drag')
  assert.deepEqual(await main.evaluate(`fixture.windows()`), {
    mainVisible: false,
    compact: { visible: true, alwaysOnTop: true, movable: true, bounds: await main.evaluate(`fixture.windows().then(value=>value.compact.bounds)`) },
    mainBridgeOwner: true
  })

  if (process.env.PI_PIP_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_PIP_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_PIP_SCREENSHOT_DIR, 'picture-in-picture.png'), Buffer.from((await compact.send('Page.captureScreenshot')).data, 'base64'))
  }

  await main.evaluate(`fixture.emit({type:'agent_start',sessionPath:'/fixture/chat',sessionId:'fixture',eventSequence:1,todos:{toolCallId:'todo',items:[{id:'a',content:'Inspect',status:'completed'},{id:'b',content:'Implement',activeForm:'Implementing',status:'in_progress'}]}})`)
  await main.evaluate(`fixture.emit({type:'message_update',sessionPath:'/fixture/chat',sessionId:'fixture',eventSequence:2,message:{role:'assistant',content:[{type:'text',text:'Live reply from the active run'}],provider:'fixture',model:'fixture',stopReason:'',timestamp:3}})`)
  await waitFor(compact.evaluate, `document.querySelector('[data-pip-response]')?.textContent.includes('Live reply from the active run')`)
  assert.ok((await compact.evaluate(`document.querySelector('[data-pip-window]').innerText`)).includes('1 of 2 tasks done'))
  if (process.env.PI_PIP_SCREENSHOT_DIR) {
    await writeFile(join(process.env.PI_PIP_SCREENSHOT_DIR, 'picture-in-picture-live.png'), Buffer.from((await compact.send('Page.captureScreenshot')).data, 'base64'))
  }
  await main.evaluate(`fixture.emit({type:'message_end',sessionPath:'/fixture/chat',sessionId:'fixture',eventSequence:3,message:{role:'assistant',content:[{type:'text',text:'Live reply from the active run'}],provider:'fixture',model:'fixture',stopReason:'stop',timestamp:3}})`)
  await main.evaluate(`fixture.emit({type:'agent_settled',sessionPath:'/fixture/chat',sessionId:'fixture',eventSequence:4,continuing:false})`)
  await waitFor(compact.evaluate, `document.querySelector('[data-pip-window]')?.innerText.includes('Finished')`)

  await compact.evaluate(`document.querySelector('[data-pip-drag] button').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.compact?.alwaysOnTop===false)`)
  assert.equal(await compact.evaluate(`window.pi.pictureInPictureState().then(value=>value.pinned)`), false)
  await compact.evaluate(`document.querySelector('[data-pip-window] footer button').click()`)
  await waitFor(main.evaluate, `fixture.windows().then(value=>value.mainVisible&&!value.compact)`)
  assert.deepEqual(main.exceptions, [])
  assert.deepEqual(compact.exceptions, [])
  console.log('PASS: compact native window, drag region, live session events, pin toggle and full-window restore')
} finally {
  for (const socket of sockets) socket.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) })
  }
  await rm(temporary, { recursive: true, force: true })
}
