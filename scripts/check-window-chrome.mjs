/** Built renderer + native window chrome, synthetic sessions and isolated storage.
 * Run after build. PI_WINDOW_SCREENSHOT_DIR retains the visual checks. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-window-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, ws
try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{window:()=>ipcRenderer.invoke('fixture:window'),resize:(width,height)=>ipcRenderer.invoke('fixture:resize',width,height),fullscreen:value=>ipcRenderer.invoke('fixture:fullscreen',value),scenario:value=>ipcRenderer.invoke('fixture:scenario',value),startupChoices:()=>ipcRenderer.invoke('fixture:startupChoices')});`)
  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain,nativeTheme} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 let scenario='project';
 let startupChoice='resume';
 const startupChoices=[];
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const labels=['统一窗口标题栏与页面布局','梳理项目结构与入口','实现一个新的工具面板','检查最近的界面改动'];
 const sessions=labels.map((label,i)=>({id:'chat-'+i,path:'/fixture/chat-'+i,cwd:'/workspace/pi-app',projectless:false,label,created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}));
 const snapshot=(cwd='/workspace/pi-app')=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd,projectless:scenario==='projectless',messages:scenario==='long'?[{role:'user',content:'Please review the layout.',timestamp:1},{role:'assistant',content:[{type:'text',text:'The window controls and workspace now share one title row.'}],timestamp:2,stopReason:'stop'}]:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app','/workspace/piws'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:startupChoice}));
 ipcMain.handle('app:setStartup',(_,mode)=>{startupChoices.push(mode);startupChoice=mode;return mode});
 ipcMain.handle('pi:init',()=>snapshot(scenario==='projectless'?'/internal/private-workspace':'/workspace/pi-app'));
 ipcMain.handle('pi:newSession',(_,cwd)=>{scenario=cwd?'project':'projectless';return snapshot(cwd??'/internal/private-workspace')});
 ipcMain.handle('pi:listSessions',()=>scenario==='long'?[{...sessions[0],label:'A very long session title / 很长的会话标题 '.repeat(12)},...sessions.slice(1)]:sessions);
 ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('bash:list',()=>[]);ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 const w=new BrowserWindow({...windowChromeOptions(),width:1320,height:880,minWidth:760,minHeight:560,title:'Pith · Layout check',backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 ipcMain.handle('fixture:window',()=>({bounds:w.getBounds(),content:w.getContentBounds(),buttons:process.platform==='darwin'?w.getWindowButtonPosition():null,fullscreen:w.isFullScreen(),dark:nativeTheme.shouldUseDarkColors,theme:nativeTheme.themeSource}));
 ipcMain.handle('fixture:resize',(_,width,height)=>w.setBounds({width,height}));
 ipcMain.handle('fixture:fullscreen',(_,value)=>w.setFullScreen(value));
 ipcMain.handle('fixture:scenario',(_,value)=>{scenario=value});
 ipcMain.handle('fixture:startupChoices',()=>startupChoices);
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
  const ready = () => waitFor(`document.querySelector('textarea') && document.querySelector('[data-slot="sidebar-trigger"]')`)
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
  await screenshot('dark-home')
  // Real mouse events exercise the controls inside the draggable strip.
  await click('[data-slot="sidebar-trigger"]')
  assert.equal(await evaluate(`document.querySelector('[data-slot="sidebar-trigger"]').getAttribute('aria-expanded')`), 'false')
  assert.ok(await evaluate(`document.querySelector('main').getBoundingClientRect().width>innerWidth-2`))
  await screenshot('collapsed-sidebar')
  await click('[data-slot="sidebar-trigger"]')
  await send('Runtime.evaluate', { expression: `document.querySelector('textarea').focus()` })
  await send('Input.insertText', { text: '保留这份草稿 / keep this draft' })
  await click('button[aria-label="设置"]')
  assert.ok(await evaluate(`document.querySelector('button[aria-label="返回对话"]').getBoundingClientRect().left>=${process.platform === 'darwin' ? 92 : 12}`))
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
  await click('button[aria-label="返回对话"]')
  assert.equal(await evaluate(`document.querySelector('textarea').value`), '保留这份草稿 / keep this draft')
  await click('button[aria-label="搜索会话"]')
  await waitFor(`document.querySelector('[aria-modal="true"]')`)
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
  await reload()
  assert.equal((await evaluate('fixture.window()')).dark, false)
  // The fade mark arrives from a ResizeObserver, so this needs one rendered
  // frame: a screenshot is what guarantees one while the window is not
  // frontmost (a bare evaluate leaves it unset on an occluded window).
  await screenshot('light-long-title')
  assert.ok(await evaluate(`Boolean(document.querySelector('[data-window-titlebar] [data-overflow]'))`))
  assert.ok(await evaluate(`document.querySelector('[aria-label="Toggle sidebar"][aria-pressed]').getBoundingClientRect().right<=innerWidth`))
  await screenshot('light-long-title')
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
  console.log('PASS: native title row, themes, control hit targets, sidebar, settings/draft, modal ownership, narrow layout, long titles, projectless privacy and fullscreen')
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
