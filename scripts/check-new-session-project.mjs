/** New-session project picker: built renderer, synthetic sessions, isolated storage.
 * Run after `npm run build`. PI_NEW_SESSION_SCREENSHOT_DIR retains the views.
 *
 * Covers the landing page's project chip: it lists known projects plus "no
 * project", re-creates the session in the chosen folder (the SDK fixes a
 * session's cwd at creation), keeps the internal projectless workspace hidden,
 * and stays inside the viewport at the narrow layout.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-picker-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const TRIGGER = 'button[aria-label="选择项目"]'
let child, ws
try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{calls:()=>ipcRenderer.invoke('fixture:calls'),resize:(w,h)=>ipcRenderer.invoke('fixture:resize',w,h)});`)
  const main = join(temporary, 'main.cjs')
  const attachmentFile = join(temporary, 'attachment-sample.txt')
  await writeFile(attachmentFile, 'attached sample\n')
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const sessions=[{id:'chat-0',path:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,label:'梳理项目结构',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}];
 const calls=[];
 let folders=['/workspace/pi-app','/workspace/piws'];
 const snapshot=(cwd='/workspace/pi-app')=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd,projectless:cwd.startsWith('/internal/'),messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:[...folders],version:'fixture',contextFiles:true,bashMaxWaitMs:10000}));
 ipcMain.handle('pi:init',()=>snapshot('/workspace/pi-app'));
 // The real manager remembers every folder it activates, so a project picked
 // on the landing page shows up in the sidebar before it has a session.
 ipcMain.handle('pi:newSession',(_,cwd)=>{calls.push(cwd??null);if(cwd)folders=[cwd,...folders.filter(f=>f!==cwd)];return snapshot(cwd??'/internal/private-workspace')});
 ipcMain.handle('pi:listSessions',()=>sessions);
 ipcMain.handle('app:pickDirectory',()=>({cwd:'/workspace/new-project'}));
 ipcMain.handle('fixture:calls',()=>calls);
 ipcMain.handle('fixture:resize',(_,width,height)=>w.setBounds({width,height}));
 ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('bash:list',()=>[]);ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('files:read',(_,path)=>({path,relPath:path,kind:'text',size:12}));
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 const w=new BrowserWindow({...windowChromeOptions(),width:1320,height:880,minWidth:760,minHeight:560,title:'Pith picker check',backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
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
  const ready = () => waitFor(`document.querySelector('[data-prompt-editor]')`)
  const clickAt = async point => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pause(500)
  }
  const click = async selector => clickAt(await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`))
  // The panel is the listbox this trigger owns; the model picker's items stay
  // mounted in the DOM even while its own panel is closed.
  const projectList = `document.getElementById(document.querySelector('${TRIGGER}').getAttribute('aria-controls'))`
  const clickOption = async text => {
    const point = await evaluate(`(()=>{const node=[...${projectList}.querySelectorAll('[role="option"]')].find(n=>n.textContent.includes(${JSON.stringify(text)}));if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    assert(point, 'option not found: ' + text)
    await clickAt(point)
  }
  const triggerText = () => evaluate(`document.querySelector('${TRIGGER}').innerText.trim()`)
  const panelOpen = () => evaluate(`${projectList}.getAttribute('aria-hidden') === 'false'`)
  const screenshot = async name => {
    if (!process.env.PI_NEW_SESSION_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_NEW_SESSION_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_NEW_SESSION_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await send('Runtime.enable')
  await ready()
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN');localStorage.setItem('theme','dark')`)
  await send('Page.reload'); await pause(400); await ready()

  // The landing page shows the active project in a real control, not a label.
  assert.equal(await triggerText(), 'pi-app')
  assert.equal(await evaluate(`document.querySelector('${TRIGGER}').getAttribute('aria-expanded')`), 'false')
  assert.equal(await panelOpen(), false)
  await click(TRIGGER)
  assert.equal(await panelOpen(), true)
  const options = await evaluate(`[...${projectList}.querySelectorAll('[role="option"]')].map(n=>n.innerText.replace(/\\n/g,' | '))`)
  assert.deepEqual(options, ['不使用项目', '新建项目…', 'pi-app | /workspace/pi-app', 'piws | /workspace/piws'])
  assert.ok(await evaluate(`${projectList}.getBoundingClientRect().height > 60`))
  await screenshot('panel-open-dark')

  // The panel floats OVER the composer. Its input viewport is
  // the overlap region the panel must paint above — the earlier probe targeted
  // the Combobox model trigger, which the Select migration removed.
  const overlay = await evaluate(`(()=>{
    const list=${projectList};
    const trigger=document.querySelector('[data-prompt-viewport]');
    const t=trigger.getBoundingClientRect(), l=list.getBoundingClientRect();
    const top=Math.max(t.top,l.top), bottom=Math.min(t.bottom,l.bottom);
    const left=Math.max(t.left,l.left), right=Math.min(t.right,l.right);
    if (bottom<=top||right<=left) return {overlapping:false,list:l.toJSON(),trigger:t.toJSON()};
    const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
    return {overlapping:true,onTop:hit===list||list.contains(hit),hit:hit?hit.tagName+'.'+hit.className:null};
  })()`)
  assert.equal(overlay.overlapping, true, 'the open panel must reach the composer controls row: ' + JSON.stringify(overlay))
  assert.equal(overlay.onTop, true, 'the panel paints above the composer row it overlaps: ' + JSON.stringify(overlay))

  // Picking another project re-creates the session in that folder.
  await clickOption('piws')
  await waitFor(`document.querySelector('${TRIGGER}').innerText.includes('piws')`)
  assert.deepEqual(await evaluate('fixture.calls()'), ['/workspace/piws'])
  assert.ok(await evaluate(`document.querySelector('[data-window-titlebar]').innerText.includes('piws')`))
  assert.equal(await panelOpen(), false)
  await screenshot('switched-project')

  // "No project" goes to the internal workspace, which stays out of the UI.
  await click(TRIGGER)
  await clickOption('不使用项目')
  await waitFor(`document.querySelector('${TRIGGER}').innerText.includes('不使用项目')`)
  assert.deepEqual(await evaluate('fixture.calls()'), ['/workspace/piws', null])
  assert.equal(await evaluate(`/internal|private-workspace/.test(document.body.innerText)`), false)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-window-titlebar] [data-window-interactive]'))`), false)
  await screenshot('switched-projectless')

  // ...and back to a project from a projectless chat.
  await click(TRIGGER)
  await clickOption('pi-app')
  await waitFor(`document.querySelector('${TRIGGER}').innerText.trim() === 'pi-app'`)
  assert.deepEqual(await evaluate('fixture.calls()'), ['/workspace/piws', null, '/workspace/pi-app'])

  // Escape closes the panel without recreating anything.
  await click(TRIGGER)
  assert.equal(await panelOpen(), true)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await pause(400)
  assert.equal(await panelOpen(), false)
  assert.deepEqual(await evaluate('fixture.calls()'), ['/workspace/piws', null, '/workspace/pi-app'])

  // "New project…" is an action row, not a value: it asks for a folder and
  // starts the chat there, which makes that folder a known project.
  await click(TRIGGER)
  await clickOption('新建项目')
  await waitFor(`document.querySelector('${TRIGGER}').innerText.includes('new-project')`)
  assert.deepEqual(await evaluate('fixture.calls()'), ['/workspace/piws', null, '/workspace/pi-app', '/workspace/new-project'])
  assert.equal(await panelOpen(), false, 'picking a folder closes the panel')
  // The picked folder is a known project now: the sidebar lists it even though
  // it has no session yet.
  const projectRow = `[data-sidebar-group="folder:/workspace/new-project"]`
  await waitFor(`document.querySelector('${projectRow}')`)
  assert.match(await evaluate(`document.querySelector('${projectRow}').closest('[role=treeitem]').innerText`), /new-project/)
  await screenshot('new-project')

  // The landing wears the shader backdrop: present, behind the content,
  // pointer-transparent, and actually animating. A clip over an empty corner
  // isolates the shader from the (static) landing content.
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-shader-backdrop][aria-hidden="true"]'))`), true, 'the landing shader backdrop is mounted and hidden from assistive tech')
  assert.equal(await evaluate(`document.querySelectorAll('[data-shader-backdrop] canvas').length > 0`), true, 'the shader canvas renders')
  const shaderShot = async () => {
    const clip = await evaluate(`(()=>{const b=document.querySelector('[data-shader-backdrop]').getBoundingClientRect();return{x:Math.round(b.x+b.width*0.08),y:Math.round(b.y+12),width:280,height:180,scale:1}})()`)
    return (await send('Page.captureScreenshot', { format: 'png', clip })).data
  }
  const shaderHit = await evaluate(`(()=>{const b=document.querySelector('[data-shader-backdrop]').getBoundingClientRect();const el=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return el?.closest('[data-shader-backdrop]')?'backdrop':'content'})()`)
  assert.equal(shaderHit, 'content', 'the backdrop is pointer-transparent and sits behind the landing content')
  const shaderInfo = await evaluate(`(()=>{const b=document.querySelector('[data-shader-backdrop]');const c=b.querySelector('canvas');return{colors:b.getAttribute('data-shader-colors'),canvas:c?[c.width,c.height]:null}})()`)
  assert.equal(new Set(shaderInfo.colors.split(' ')).size >= 2, true, 'the palette resolves to distinct theme colors: ' + shaderInfo.colors)
  assert.ok(shaderInfo.canvas && shaderInfo.canvas[0] > 0, 'the shader canvas is sized')
  const shaderFrameA = await shaderShot()
  await pause(700)
  assert.notEqual(await shaderShot(), shaderFrameA, 'the shader animates when motion is allowed')

  // A file attachment is a card INSIDE the input frame: as tall as the image
  // thumbs (h-14), type artwork over the file name and its directory, with a
  // corner close control that rides in on hover.
  await send('DOM.enable')
  const dom = await send('DOM.getDocument', { depth: -1 })
  const fileInput = (await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: 'input[type=file]:not([accept])' })).nodeId
  assert.ok(fileInput, 'the composer exposes the file input')
  await send('DOM.setFileInputFiles', { files: [attachmentFile], nodeId: fileInput })
  await waitFor(`document.querySelector('[data-attachment-card]')`)
  const card = () => evaluate(`(()=>{const root=document.querySelector('[data-attachment-card]');const open=root.querySelector('button');const texts=[...open.querySelectorAll('[data-middle-ellipsis]')].map(n=>n.textContent);const close=root.querySelectorAll('button')[1];const form=root.closest('form');return{name:texts[0]??'',dir:texts[1]??'',height:open.getBoundingClientRect().height,insideFrame:Boolean(form&&form.contains(document.querySelector('[data-prompt-editor]'))),closeLabel:close?.getAttribute('aria-label')??''}})()`)
  const cardBefore = await card()
  assert.match(cardBefore.name, /attachment-sample/, 'the card names the attached file')
  assert.ok(cardBefore.dir.length > 0, 'the card shows the containing directory')
  assert.equal(cardBefore.height, 56, 'the card matches the image thumbs (h-14)')
  assert.equal(cardBefore.insideFrame, true, 'the card renders inside the input frame')
  assert.match(cardBefore.closeLabel, /attachment-sample/, 'the corner control removes the card')
  await screenshot('attachment-card')
  await evaluate(`document.querySelector('[data-attachment-card]').querySelectorAll('button')[1].click()`)
  await pause(250)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-attachment-card]'))`), false, 'removing drops the card')

  // Reduced motion (and touch) keep the shader still.
  await pause(900)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // The preference is read at mount, so reload instead of relying on a change event.
  await send('Page.reload'); await pause(500); await ready()
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, 'the emulated preference is active')
  const shaderFrameRestA = await shaderShot()
  await pause(700)
  assert.equal(await shaderShot(), shaderFrameRestA, 'reduced motion freezes the shader')
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Page.reload'); await pause(500); await ready()
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false, 'the emulated preference is cleared')

  // Narrow window: the panel stays inside the viewport.
  await evaluate(`fixture.resize(760,560)`)
  await pause(600)
  await click(TRIGGER)
  const rect = await evaluate(`(()=>{const r=${projectList}.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth}})()`)
  assert.ok(rect.left >= 0 && rect.right <= rect.width, 'panel must stay inside the viewport: ' + JSON.stringify(rect))
  await screenshot('panel-open-narrow')

  assert.deepEqual(exceptions, [])
  console.log('PASS: new-session project picker — options, project switch, projectless switch, privacy, escape, geometry')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
