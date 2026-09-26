/**
 * Right-rail tab strip geometry: the hover fill's corners and the tab
 * content's vertical centre. Built renderer + real Workspace, synthetic
 * sessions, isolated profile (no model calls, no user data).
 *
 * Two defects this guards:
 *  1. The underline variant's hover fill was painted with no radius at all, so
 *     the rail's tabs stayed hard-edged in the squircle style while the
 *     browser page strip right below them (the segment variant) was already
 *     rounded. Every tab fill now takes the same scale step.
 *  2. The underline trigger's registry recipe (`pt-1 pb-2.5` + `-mb-px`) is
 *     built for a tab that hangs BELOW its strip; the rail stretches the tab
 *     over its own row instead (`h-9 min-h-0`), so that asymmetric padding
 *     pushed the icon and label 2.5px above the row's centre while the close
 *     button sat on it. Icon, label, box, close button, add button and the
 *     strip's rule now share one centre line.
 *
 * Run after `npm run build`. PI_RAIL_TABS_SCREENSHOT_DIR retains the views.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-rail-tabs-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child, ws

/** One tab row as the reader sees it: box, fill corner, and the three centres
 *  that have to agree (icon, label, close button). */
const rowProbe = `(()=>[...document.querySelectorAll('[data-sidebar-tabs] [data-sidebar-tab]')].map(row=>{
  const tab=row.querySelector('[role=tab]');
  const box=tab.getBoundingClientRect();
  const style=getComputedStyle(tab);
  const centre=element=>{if(!element)return null;const r=element.getBoundingClientRect();return r.top+r.height/2};
  const close=row.querySelector('button[aria-label^="Close"]');
  return {
    id:row.dataset.sidebarTab,
    selected:tab.getAttribute('aria-selected')==='true',
    height:box.height,width:box.width,top:box.top,
    centre:box.top+box.height/2,
    radius:parseFloat(style.borderTopLeftRadius),
    radii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],
    shape:style.cornerShape,
    fill:style.backgroundColor,
    icon:centre(tab.querySelector('svg,img')),
    label:centre([...tab.querySelectorAll('span')].find(span=>span.textContent.trim())),
    close:centre(close)
  };
}))()`

const stripProbe = `(()=>{
  const strip=document.querySelector('[data-sidebar-tabs]');
  const scroller=strip.querySelector('.overflow-x-auto');
  const plus=strip.querySelector('button[aria-label="New tab"]');
  const box=strip.getBoundingClientRect();
  const plusBox=plus.getBoundingClientRect();
  return {
    height:box.height,
    bottom:box.bottom,
    rule:box.height-scroller.getBoundingClientRect().top+strip.getBoundingClientRect().top,
    scrollHeight:scroller.scrollHeight,
    clientHeight:scroller.clientHeight,
    plusCentre:plusBox.top+plusBox.height/2,
    plusCoversStrip:Math.abs((plusBox.top+plusBox.height/2)-(box.top+(box.height-1)/2))<=0.25
  };
})()`

try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};\n`)
  const main = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
import {app,BrowserWindow,ipcMain,nativeTheme} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const sessions=['统一右侧栏标签页的圆角与文字对齐','梳理项目结构与入口'].map((label,i)=>({id:'chat-'+i,path:'/fixture/chat-'+i,cwd:'/workspace/pi-app',projectless:false,label,created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}));
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,messages:[],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('app:setStartup',()=>'resume');
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>sessions);
 ipcMain.handle('pi:openSession',()=>snapshot());
 ipcMain.handle('pi:models',()=>[model]);
 ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('pi:reload',()=>snapshot());
 ipcMain.handle('pi:compact',()=>snapshot());
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('pi:contextDetail',()=>null);
 const w=new BrowserWindow({...windowChromeOptions(),width:1280,height:820,minWidth:760,minHeight:560,backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 w.loadFile(${JSON.stringify(join(repo, 'out/renderer/index.html'))});
});app.on('window-all-closed',()=>app.quit());`,
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
  assert(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, (message) => message.error ? reject(message.error) : resolve(message.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression, label) => {
    for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100) }
    throw new Error('Timed out: ' + (label ?? expression) + '\n' + JSON.stringify(exceptions) + '\n' + output.slice(-2000))
  }
  const ready = () => waitFor(`document.querySelector('[data-prompt-editor]')`, 'workspace mounted')
  const point = async (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const click = async (selector) => {
    const at = await point(selector)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
    await pause(450)
  }
  const hover = async (selector) => {
    const at = await point(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
    await pause(350)
  }
  const screenshot = async (name) => {
    if (!process.env.PI_RAIL_TABS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_RAIL_TABS_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_RAIL_TABS_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  const setStyle = async (style) => {
    await evaluate(`localStorage.setItem('pi-app:ui-style',${JSON.stringify(style)});localStorage.setItem('pi-app:locale','en')`)
    await send('Page.reload')
    await pause(400)
    await ready()
    await openRail()
  }
  /** The rail, with two fixed-kind panes open: two tabs is the smallest strip
   *  that has an INACTIVE tab to hover. The first pane comes from the picker
   *  (the strip only exists once a tab does), the second from its add button. */
  const openRail = async () => {
    if (!(await evaluate(`Boolean(document.querySelector('[data-panel="right"]'))`))) await click('[aria-label="Toggle sidebar"]')
    await waitFor(`document.querySelector('[data-panel="right"]')`, 'right rail open')
    const pick = async (label) => {
      await waitFor(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim().startsWith(${JSON.stringify(label)}))`, 'picker row ' + label)
      const picked = await evaluate(`(()=>{const row=[...document.querySelectorAll('button')].find(button=>button.textContent.trim().startsWith(${JSON.stringify(label)}));if(!row)return false;row.click();return true})()`)
      assert(picked, 'the picker offers the ' + label + ' pane')
      await pause(400)
    }
    if (!(await evaluate(`Boolean(document.querySelector('[data-sidebar-tabs]'))`))) await pick('Context')
    await waitFor(`document.querySelectorAll('[data-sidebar-tabs] [data-sidebar-tab]').length === 1`, 'the Context tab opened')
    if (!(await evaluate(`document.querySelectorAll('[data-sidebar-tabs] [data-sidebar-tab]').length >= 2`))) {
      await click('[data-sidebar-tabs] button[aria-label="New tab"]')
      await pick('Review')
      await waitFor(`document.querySelectorAll('[data-sidebar-tabs] [data-sidebar-tab]').length >= 2`, 'the Review tab opened')
    }
    await pause(250)
  }

  await send('Runtime.enable')
  await ready()

  const squareStep = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--app-radius-inner').trim()`)
  assert.equal(squareStep, '0px', 'the default (square) style starts hard-edged')

  for (const style of ['square', 'squircle']) {
    await setStyle(style)
    const step = parseFloat(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--app-radius-inner')`))
    assert.equal(step, style === 'square' ? 0 : 10, style + ': the scale step this check pins')

    // The hover fill is the only one this check can see paint, so hover the
    // inactive tab and read the row as the reader sees it.
    const inactive = `[data-sidebar-tab]:not([data-sidebar-tab="review"]) [role=tab]`
    await hover(inactive)
    const rows = await evaluate(rowProbe)
    assert.equal(rows.length, 2, style + ': the rail strip has two tabs')

    const strip = await evaluate(stripProbe)
    // The strip's recipe (4px + a 36px list + 4px, plus the 1px rule) is the
    // transcript task strip's own height; the corner work must not move it.
    assert.equal(strip.height, 45, style + ': the strip keeps its 44px content row plus the 1px rule')
    assert.equal(strip.scrollHeight, strip.clientHeight, style + ': the tab box never overflows its scroller')
    assert.equal(strip.plusCoversStrip, true, style + ': the add button is centred on the strip')

    for (const row of rows) {
      // The rail's call site pins the row with `h-9 min-h-0` (it overrides the
      // registry's own `min-h-[44px]`), so the tab box IS the list row.
      assert.equal(row.height, 36, style + ': ' + row.id + ' fills the strip row')
      assert.equal(row.shape, 'superellipse(2)', style + ': ' + row.id + ' keeps the continuous corner shape')
      const expected = style === 'square' ? 0 : step
      assert.equal(row.radius, expected, style + ': ' + row.id + ' hover fill takes the scale step (' + row.radii.join('/') + ')')
      // Content and close button share ONE centre line, and it is the strip's.
      for (const [what, value] of [['icon', row.icon], ['label', row.label]]) {
        assert.ok(value !== null, style + ': ' + row.id + ' renders its ' + what)
        assert.ok(
          Math.abs(value - row.close) <= 0.5,
          style + ': ' + row.id + ' ' + what + ' centre ' + value + ' must match the close button centre ' + row.close
        )
      }
      assert.ok(
        Math.abs(row.centre - row.close) <= 0.25,
        style + ': ' + row.id + ' box centre ' + row.centre + ' must sit on the close button centre ' + row.close + ' (the registry\'s `-mb-px` used to drop the whole box half a pixel)'
      )
      assert.ok(Math.abs(row.centre - strip.plusCentre) <= 0.25, style + ': ' + row.id + ' aligns with the add button')
    }

    // The radius read above is only worth anything if the element really is
    // the fill the reader sees: the hovered (inactive) tab paints one, the
    // unhovered one paints nothing at all.
    const hovered = rows.find((row) => !row.selected)
    assert.notEqual(hovered.fill, 'rgba(0, 0, 0, 0)', `${style}: the hovered tab paints its fill`)
    assert.equal(rows.find((row) => row.selected).fill, 'rgba(0, 0, 0, 0)', `${style}: a tab without the pointer paints no fill`)
    await screenshot(style + '-rail-tabs')
  }

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: rail tab fills take the scale step in both styles, and every tab keeps one centre line for icon, label, close button and the strip itself.')
} finally {
  ws?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(3000)])
  }
  await rm(temporary, { recursive: true, force: true })
}
