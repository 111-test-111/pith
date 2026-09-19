/**
 * Session sidebar glass in isolated Electron; no model calls or user data.
 * The frosted panel (default on) is translucent with a backdrop blur over the
 * accent wash painted behind it; Settings → Appearance toggles it off (opaque
 * column, wash unmounted, preference persisted), a reload restores the stored
 * value, garbage values fall back to on, the wash follows the live theme and
 * accent, and the mobile sheet never renders the wash. The fixture mounts the
 * same shared composition the workspace uses (SidebarGlass.tsx), so the check
 * exercises the real class strings rather than a copy.
 *
 * PI_SIDEBAR_GLASS_SCREENSHOT_DIR retains the light/dark × on/off gallery.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-sidebar-glass-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__sidebar-glass-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {AnimatedSidebarProvider,AnimatedSidebar,AnimatedSidebarContent,AnimatedSidebarInset} from '/src/components/motion/animated-sidebar.tsx';
import {SidebarGlassWash,sidebarGlassPanelClassName} from '/src/components/app/SidebarGlass.tsx';
import {useSidebarGlass} from '/src/lib/sidebar-glass.ts';
import '/src/styles.css';
window.pi={platform:'darwin'};
const sessions=['Refactor the rewind engine','Fix sidebar drag reorder','Write release notes','Investigate terminal flicker','Update beUI components'];
function Shell(){
  const [glass,setGlass]=useSidebarGlass();window.setGlass=setGlass;
  return React.createElement(AnimatedSidebarProvider,{style:{height:'100vh'}},
    React.createElement(AnimatedSidebar,{ariaLabel:'Sessions',collapsible:'offcanvas',
      backdrop:glass?React.createElement(SidebarGlassWash):undefined,
      panelClassName:sidebarGlassPanelClassName(glass)},
      React.createElement(AnimatedSidebarContent,{className:'relative gap-2 overflow-hidden px-2 pt-2'},
        React.createElement('div',{style:{height:'100%',overflowY:'auto'}},
          sessions.map(label=>React.createElement('div',{key:label,style:{padding:'10px 8px',fontSize:13}},label))))),
    React.createElement(AnimatedSidebarInset,{className:'overflow-hidden bg-background'},
      React.createElement('div',{style:{padding:24,color:'var(--muted-foreground)',fontSize:13}},'conversation column')));
}
window.checkRoot=createRoot(document.getElementById('root'));flushSync(()=>window.checkRoot.render(React.createElement(Shell)));
window.read=()=>{
  const aside=document.querySelector('[data-slot="sidebar"]');
  const panel=aside?aside.querySelector(':scope > div:last-of-type'):null;
  const wash=document.querySelector('[data-sidebar-glass-wash]');
  const pc=panel?getComputedStyle(panel):null;
  const wc=wash?getComputedStyle(wash):null;
  return{aside:!!aside,panel:!!panel,
    wash:!!wash,washFirst:wash?wash.previousElementSibling===null:null,washBeforePanel:wash?wash.nextElementSibling===panel:null,
    washImage:wc?wc.backgroundImage:null,washPointer:wc?wc.pointerEvents:null,washPosition:wc?wc.position:null,
    filter:pc?pc.backdropFilter:null,panelBg:pc?pc.backgroundColor:null,
    stored:(()=>{try{return localStorage.getItem('pi-app:sidebar-glass')}catch{return null}})()};
};
</script></body></html>`

/** Alpha of a computed color: `oklch(... / 0.7)` / `rgba(..., 0.7)` → 0.7. */
function alphaOf(color) {
  if (typeof color !== 'string') return null
  const slash = /\/\s*([\d.]+)\)\s*$/.exec(color)
  if (slash) return Number.parseFloat(slash[1])
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(color.trim())
  if (rgba) return Number.parseFloat(rgba[1])
  return color.trim() === 'transparent' ? 0 : 1
}

let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:860,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  await send('Page.enable')
  const waitFor = async (expression) => { for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await pause(50) } throw new Error('fixture never settled: ' + expression) }
  await waitFor(`!!document.querySelector('[data-slot="sidebar"]')`)
  await evaluate(`document.fonts.ready`)
  await pause(300)

  const shotDir = process.env.PI_SIDEBAR_GLASS_SCREENSHOT_DIR
  const shoot = async (name) => {
    if (!shotDir) return
    const image = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(shotDir, name), Buffer.from(image.data, 'base64'))
  }
  if (shotDir) await mkdir(shotDir, { recursive: true })

  // 1. Default (no stored preference): glass on — a translucent, blurred panel
  //    over the wash, which paints behind it as the aside's first child and
  //    never takes pointer events.
  const on = await evaluate('window.read()')
  assert.equal(on.stored, null, 'fresh profile has no stored value')
  assert.ok(on.wash, 'the wash is mounted')
  assert.equal(on.washFirst, true, 'the wash is the aside\'s first child, so it paints behind the panel')
  assert.equal(on.washBeforePanel, true, 'the wash immediately precedes the panel')
  assert.equal(on.washPointer, 'none', 'the wash never takes pointer events')
  assert.equal(on.washPosition, 'absolute', 'the wash is positioned within the aside')
  assert.match(on.washImage, /radial-gradient/, 'the wash carries the themed gradient')
  assert.match(on.filter, /blur/, 'the panel surface is frosted: ' + on.filter)
  assert.ok(alphaOf(on.panelBg) > 0 && alphaOf(on.panelBg) < 1, 'the panel surface is translucent: ' + on.panelBg)
  await shoot('light-on.png')

  // 2. The wash follows the live theme and accent: both change its resolved
  //    gradient (color-mix over --primary/--background) with no reload.
  const lightWash = on.washImage, lightPanel = on.panelBg
  await evaluate(`document.documentElement.classList.add('dark')`)
  await pause(100)
  const dark = await evaluate('window.read()')
  assert.notEqual(dark.washImage, lightWash, 'dark mode retints the wash')
  assert.notEqual(dark.panelBg, lightPanel, 'dark mode changes the panel surface')
  await shoot('dark-on.png')
  await evaluate(`document.documentElement.dataset.accent='rose'`)
  await pause(100)
  assert.notEqual((await evaluate('window.read()')).washImage, dark.washImage, 'the accent preset retints the wash')
  await evaluate(`document.documentElement.dataset.accent=''`)
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await pause(100)

  // 3. Settings toggle off: the column goes back to the opaque surface, the
  //    wash unmounts entirely, and the value persists.
  await evaluate(`window.setGlass(false)`)
  await pause(150)
  const off = await evaluate('window.read()')
  assert.ok(!off.wash, 'the wash unmounts when glass is off')
  assert.equal(off.filter, 'none', 'no backdrop filter when glass is off')
  assert.equal(alphaOf(off.panelBg), 1, 'the panel surface is opaque when glass is off: ' + off.panelBg)
  assert.equal(off.stored, 'off', 'the off value persists to localStorage')
  await shoot('light-off.png')
  await evaluate(`document.documentElement.classList.add('dark')`)
  await pause(100)
  await shoot('dark-off.png')
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await pause(100)

  // 4. Toggle back on restores every layer, and stores 'on'.
  await evaluate(`window.setGlass(true)`)
  await pause(150)
  const onAgain = await evaluate('window.read()')
  assert.ok(onAgain.wash && onAgain.washFirst && onAgain.washBeforePanel, 'the wash returns behind the panel')
  assert.match(onAgain.filter, /blur/)
  assert.ok(alphaOf(onAgain.panelBg) < 1)
  assert.equal(onAgain.stored, 'on')
  assert.equal(onAgain.washImage, lightWash, 'the restored wash matches the original')

  // 5. A reload restores the STORED value: off survives the round trip.
  await evaluate(`window.setGlass(false)`)
  await pause(100)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('[data-slot="sidebar"]') && typeof window.read === 'function'`)
  await pause(300)
  const reloaded = await evaluate('window.read()')
  assert.equal(reloaded.stored, 'off')
  assert.ok(!reloaded.wash, 'glass stays off after reload')
  assert.equal(reloaded.filter, 'none')

  // 6. A value other than 'off' (garbage) falls back to the default: on.
  await evaluate(`localStorage.setItem('pi-app:sidebar-glass','banana')`)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('[data-slot="sidebar"]') && typeof window.read === 'function'`)
  await pause(300)
  const garbage = await evaluate('window.read()')
  assert.ok(garbage.wash, 'a garbage value reads as on')
  assert.match(garbage.filter, /blur/)

  // 7. Mobile: the sidebar becomes the vendored sheet and the wash never
  //    renders — the sheet is an opaque overlay, and the backdrop slot is
  //    desktop-only by construction.
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 860, deviceScaleFactor: 1, mobile: false })
  await waitFor(`!!document.querySelector('[data-mobile="true"]')`)
  await pause(300)
  const mobile = await evaluate(`({sheet:!!document.querySelector('[data-mobile="true"]'),desktop:!!document.querySelector('[data-slot="sidebar"]'),wash:!!document.querySelector('[data-sidebar-glass-wash]')})`)
  assert.ok(mobile.sheet, 'the mobile sheet mounts')
  assert.ok(!mobile.desktop, 'the desktop aside is gone')
  assert.ok(!mobile.wash, 'the wash never renders on mobile')
  await send('Emulation.clearDeviceMetricsOverride')
  await waitFor(`!!document.querySelector('[data-slot="sidebar"]')`)
  await pause(300)
  assert.ok((await evaluate('window.read()')).wash, 'desktop glass returns with the viewport')

  // 8. No renderer exceptions through the whole run.
  assert.deepEqual(exceptions, [], 'no renderer exceptions: ' + JSON.stringify(exceptions.map((entry) => entry.exceptionDetails?.exception?.description ?? entry)))

  console.log('check-sidebar-glass: all assertions passed')
} finally {
  try { ws?.close() } catch { /* already closed */ }
  child?.kill('SIGTERM')
  await server?.close()
}
