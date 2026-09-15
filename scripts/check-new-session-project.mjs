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
 const snapshot=(cwd='/workspace/pi-app')=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd,projectless:cwd.startsWith('/internal/'),messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app','/workspace/piws'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000}));
 ipcMain.handle('pi:init',()=>snapshot('/workspace/pi-app'));
 ipcMain.handle('pi:newSession',(_,cwd)=>{calls.push(cwd??null);return snapshot(cwd??'/internal/private-workspace')});
 ipcMain.handle('pi:listSessions',()=>sessions);
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
  const ready = () => waitFor(`document.querySelector('textarea')`)
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
  assert.deepEqual(options, ['不使用项目', 'pi-app | /workspace/pi-app', 'piws | /workspace/piws'])
  assert.ok(await evaluate(`${projectList}.getBoundingClientRect().height > 60`))
  await screenshot('panel-open-dark')

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

  // Starter cards are beUI TiltCards: the frame that carries the border tilts
  // with the pointer (reduced motion/touch keep it still), and a press still
  // only fills the composer draft.
  const card = `[...document.querySelectorAll('button')].find(b=>/overflow-hidden/.test(b.parentElement?.className||'')&&/will-change-transform/.test(b.parentElement?.className||''))`
  const geometry = await evaluate(`(()=>{const button=${card};const card=button.parentElement;return{cardHeight:Math.round(card.getBoundingClientRect().height),border:getComputedStyle(card).borderTopWidth,radius:getComputedStyle(card).borderTopLeftRadius,glare:Boolean(card.querySelector('div[aria-hidden]'))}})()`)
  assert.equal(geometry.border, '1px', 'the card surface owns the frame')
  assert.equal(geometry.radius, '20px', 'card radius comes from the app token')
  assert.ok(geometry.cardHeight <= 68, 'compressed card height: ' + geometry.cardHeight)
  assert.equal(geometry.glare, true, 'the glare layer is mounted')
  assert.equal(await evaluate(`getComputedStyle(${card}.parentElement.querySelector('div[aria-hidden]')).opacity`), '0.07', 'the app tone down the glare')
  const accent = await evaluate(`(()=>{const probe=document.createElement('div');probe.style.color='var(--primary)';document.body.appendChild(probe);const value=getComputedStyle(probe).color;probe.remove();return value})()`)
  assert.ok((await evaluate(`getComputedStyle(${card}.parentElement.querySelector('div[aria-hidden]')).backgroundImage`)).includes(accent), 'the glare washes in the theme accent: ' + accent)
  await screenshot('starter-cards')
  const cardTransform = () => evaluate(`getComputedStyle(${card}.parentElement).transform`)
  // Largest rotation entry of the matrix3d (sin of the tilt angle).
  const rotationOf = async () => {
    const text = await cardTransform()
    return Math.max(...text.replace(/^matrix3d\(|\)$/g, '').split(',').map((v, i) => [1, 2, 4, 6, 8, 9].includes(i) ? Math.abs(Number(v)) : 0))
  }
  const restingTransform = await cardTransform()
  const cardPoint = await evaluate(`(()=>{const r=${card}.getBoundingClientRect();return{x:r.x+r.width*0.2,y:r.y+r.height*0.3}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cardPoint })
  await pause(900)
  const tilted = await cardTransform()
  assert.match(tilted, /^matrix3d\(/, 'the card surface tilts: ' + tilted)
  assert.notEqual(tilted, restingTransform, 'hover must move the card off its resting transform')
  const tiltAngle = await rotationOf()
  assert.ok(tiltAngle > 0.02, 'the tilt must be visible: ' + tiltAngle)
  assert.ok(tiltAngle < 0.08, 'the tilt must stay slight: ' + tiltAngle)
  // The vendored Button scales itself 2% on hover, which grew the content past
  // the still frame (the text appeared to push out of the card).
  const buttonScale = await evaluate(`(()=>{const m=new DOMMatrixReadOnly(getComputedStyle(${card}).transform);return Math.max(Math.abs(m.a),Math.abs(m.d))})()`)
  assert.ok(buttonScale < 1.001, 'the card content must not scale on hover: ' + buttonScale)
  assert.equal(await evaluate(`getComputedStyle(${card}.parentElement.querySelector('div[aria-hidden]')).backgroundImage.includes('radial-gradient')`), true, 'the cursor-tracked glare follows the pointer')
  await screenshot('starter-cards-hover')

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

  // A file attachment is a quiet expandable chip: only its label is on screen
  // until it is clicked, then the remove action slides out.
  await send('DOM.enable')
  const dom = await send('DOM.getDocument', { depth: -1 })
  const fileInput = (await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: 'input[type=file]:not([accept])' })).nodeId
  assert.ok(fileInput, 'the composer exposes the file input')
  await send('DOM.setFileInputFiles', { files: [attachmentFile], nodeId: fileInput })
  await waitFor(`document.querySelector('[data-attachment-chip] button[aria-expanded]')`)
  const chip = () => evaluate(`(()=>{const root=document.querySelector('[data-attachment-chip]');const label=root.querySelector('button[aria-expanded]');const action=root.querySelectorAll('button')[1];return{label:label.textContent.trim(),expanded:label.getAttribute('aria-expanded'),height:label.getBoundingClientRect().height,actionWidth:action?action.parentElement.getBoundingClientRect().width:0}})()`)
  const chipBefore = await chip()
  assert.match(chipBefore.label, /attachment-sample/, 'the chip names the attached file')
  assert.equal(chipBefore.expanded, 'false', 'the chip starts collapsed')
  assert.equal(chipBefore.actionWidth, 0, 'the remove action is hidden while the chip is quiet')
  await click('[data-attachment-chip] button[aria-expanded]')
  const chipOpen = await chip()
  assert.equal(chipOpen.expanded, 'true', 'clicking the chip reveals its action')
  assert.ok(chipOpen.actionWidth > 0, 'the remove action becomes reachable')
  await screenshot('attachment-chip-expanded')
  await evaluate(`document.querySelector('[data-attachment-chip]').querySelectorAll('button')[1].click()`)
  await pause(250)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-attachment-chip] button[aria-expanded]'))`), false, 'removing drops the chip')

  // Reduced motion (and touch) keep the surface still and drop the glare.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPoint.x, y: cardPoint.y - 240 })
  await pause(900)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // The preference is read at mount, so reload instead of relying on a change event.
  await send('Page.reload'); await pause(500); await ready()
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, 'the emulated preference is active')
  assert.equal(await evaluate(`matchMedia('(hover: hover) and (pointer: fine)').matches`), true, 'emulation must not also report a touch device, or this check proves nothing')
  const reducedPoint = await evaluate(`(()=>{const r=${card}.getBoundingClientRect();return{x:r.x+r.width*0.2,y:r.y+r.height*0.3}})()`)
  assert.ok(await rotationOf() < 0.001, 'the card rests level on mount')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...reducedPoint })
  await pause(600)
  assert.ok(await rotationOf() < 0.001, 'reduced motion keeps the card still')
  assert.equal(await evaluate(`Boolean(${card}.parentElement.querySelector('div[aria-hidden]'))`), false, 'reduced motion drops the glare')
  const shaderFrameRestA = await shaderShot()
  await pause(700)
  assert.equal(await shaderShot(), shaderFrameRestA, 'reduced motion freezes the shader')
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Page.reload'); await pause(500); await ready()
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false, 'the emulated preference is cleared')

  // The landing block is centred on its own height, so any content-height
  // difference between the two starter sets moved the whole page — title and
  // input box included — by half of it the moment the project chip switched.
  // Card text is one line at every size now, so the block cannot move.
  const landingTop = () => evaluate(`(()=>{const h1=document.querySelector('main h1');const inner=h1.parentElement.parentElement;return{top:inner.getBoundingClientRect().top,cards:[...document.querySelectorAll('div[class*="will-change-transform"]')].map(c=>c.getBoundingClientRect().height)}})()`)
  for (const size of ['16px', '19px', '22px']) {
    await evaluate(`document.documentElement.style.fontSize=${JSON.stringify(size)}`)
    await pause(400)
    const project = await landingTop()
    await click(TRIGGER); await clickOption('不使用项目'); await pause(900)
    const none = await landingTop()
    await click(TRIGGER); await clickOption('pi-app'); await pause(900)
    assert.equal(none.top, project.top, `the landing must not sink at ${size}: ` + project.top + ' -> ' + none.top)
    assert.deepEqual(none.cards, project.cards, 'both starter sets keep one card height at ' + size)
  }
  // A longer description can never grow a card: it ellipsises instead.
  const longText = await evaluate(`(()=>{const button=${card};const line=button.children[1];const before=button.parentElement.getBoundingClientRect().height;line.textContent='一段刻意写得很长的说明文字，用来验证它不会把卡片撑高；一旦撑高，垂直居中的整页就会下沉。';const style=getComputedStyle(line);return{after:button.parentElement.getBoundingClientRect().height,before,nowrap:style.whiteSpace,ellipsis:style.textOverflow,overflowing:line.scrollWidth>line.clientWidth}})()`)
  assert.equal(longText.after, longText.before, 'a longer description must not change the card height')
  assert.equal(longText.nowrap, 'nowrap')
  assert.equal(longText.ellipsis, 'ellipsis')
  assert.equal(longText.overflowing, true, 'the overlong text really does overflow its line')
  await evaluate(`document.documentElement.style.fontSize='16px'`)
  await pause(300)

  await clickAt(reducedPoint)
  await waitFor(`document.querySelector('textarea').value.length > 20`)
  assert.match(await evaluate(`document.querySelector('textarea').value`), /项目|计划|想法|任务|代码/)

  // Narrow window: the panel stays inside the viewport.
  await evaluate(`fixture.resize(760,560)`)
  await pause(600)
  await click(TRIGGER)
  const rect = await evaluate(`(()=>{const r=${projectList}.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth}})()`)
  assert.ok(rect.left >= 0 && rect.right <= rect.width, 'panel must stay inside the viewport: ' + JSON.stringify(rect))
  await screenshot('panel-open-narrow')

  // The card frame and glare must read in both themes.
  await evaluate(`fixture.resize(1320,880)`)
  await pause(400)
  await evaluate(`localStorage.setItem('theme','light')`)
  await send('Page.reload'); await pause(400); await ready()
  // A reload rebuilds the DOM: re-enter the card so its onMouseMove fires.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPoint.x, y: cardPoint.y - 240 })
  await pause(200)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cardPoint })
  await pause(900)
  assert.notEqual(await cardTransform(), restingTransform, 'the light card tilts too')
  await screenshot('starter-cards-hover-light')
  assert.deepEqual(exceptions, [])
  console.log('PASS: new-session project picker — options, project switch, projectless switch, privacy, escape, geometry, tilt cards')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
