/**
 * Tooltip lifecycle around overlays, in isolated Electron: no model calls, no
 * user data. Two scenarios share one page: the real `SessionSearchTrigger` +
 * `CenterMorphModal` pair (hovering the search button, opening the panel,
 * dismissing it by pressing the backdrop and getting focus handed back to the
 * trigger), and the real `ContextRing` — a control since it opens the rail's
 * context pane — where a press must both dismiss the readout it was showing and
 * deliver the click that opens the pane.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-tooltip-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__tooltip-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider} from '/src/i18n/index.tsx';
import {Tooltip} from '/src/components/motion/tooltip.tsx';
import {Button} from '/src/components/motion/button/index.tsx';
import {CenterMorphModal,CenterMorphModalContent,CenterMorphModalTrigger} from '/src/components/motion/center-morph-modal.tsx';
import {SessionSearchTrigger} from '/src/components/app/SessionSearch.tsx';
import {ContextRing} from '/src/components/app/ContextRing.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const USAGE={tokens:85000,contextWindow:200000,percent:42.5,sessionCost:1.2345,cacheHitRate:0.93};
function Fixture(){
  const [open,setOpen]=React.useState(false);window.setPanelOpen=setOpen;
  return React.createElement(I18nProvider,null,
    React.createElement('div',{id:'plain-fixture',style:{padding:'24px 24px 8px'}},
      React.createElement(Tooltip,{content:'Plain label'},
        React.createElement(Button,{id:'plain-trigger',variant:'ghost',size:'icon','aria-label':'Plain trigger'},'?')),
      React.createElement('span',{id:'status-fixture'},React.createElement(ContextRing,{usage:USAGE,onOpen:()=>{window.ringOpened=(window.ringOpened||0)+1}}))),
    React.createElement(CenterMorphModal,{open,onOpenChange:setOpen},
      React.createElement('div',{id:'search-fixture',style:{padding:'24px 24px 40px'}},React.createElement(SessionSearchTrigger)),
      React.createElement(CenterMorphModalContent,{ariaLabel:'Session search',closeButtonLabel:'Close search'},
        React.createElement('div',{style:{padding:24}},'panel'))));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
window.press=(node)=>{node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',buttons:1}));node.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));node.click()};
window.hover=(node)=>node.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerId:1,pointerType:'mouse',buttons:0}));
window.unhover=(node)=>node.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerId:1,pointerType:'mouse',buttons:0}));
window.labels=()=>[...document.querySelectorAll('[role=tooltip]')].map(node=>({text:node.textContent,visibility:getComputedStyle(node).visibility,opacity:getComputedStyle(node).opacity}));
</script></body></html>`

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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:640,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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
  // The fixture window is created hidden, so the page has no focus and
  // `element.focus()` would set `activeElement` without firing a focus event —
  // every assertion below is about that event. Emulate a focused window.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 200; i++) { if (await evaluate(`!!document.querySelector('#plain-trigger') && !!document.querySelector('#search-fixture button')`)) break; await pause(50) }
  await evaluate(`document.fonts.ready`)
  await pause(200)
  const plain = '#plain-trigger'
  const search = `#search-fixture button[aria-haspopup=dialog]`

  // 1. Hovering still opens the label, with the vendored delay.
  await evaluate(`window.hover(document.querySelector('${plain}'))`)
  await pause(400)
  assert.equal((await evaluate('window.labels()')).length, 1, 'hovering the trigger shows its label')

  // 2. Pressing the trigger hides it — the overlay the press opens must never
  //    carry the old bubble above itself. The pointer never left, so nothing
  //    else could have taken it down.
  await evaluate(`window.press(document.querySelector('${plain}'))`)
  await pause(250)
  assert.deepEqual(await evaluate('window.labels()'), [], 'a press dismisses the label')

  // 3. The composer's context ring opens the rail's context pane, so it is a
  //    control: a press takes the readout down (the bubble must not hang over
  //    the panel the click just opened) AND delivers the click.
  const ring = `#status-fixture button`
  assert.ok(await evaluate(`!!document.querySelector('${ring}')`), 'the real context ring is mounted as a button')
  await evaluate(`window.hover(document.querySelector('${ring}'))`)
  await pause(600)
  const hovered = await evaluate('window.labels()')
  assert.equal(hovered.length, 1, 'hovering the ring shows its readout')
  // The numbers count up from zero (AnimatedNumber/NumberTicker), so the
  // assertion is about what the readout *is*, not a mid-animation digit.
  assert.match(hovered[0].text, /context used/, 'and the readout is the ring content: ' + hovered[0].text)
  assert.match(hovered[0].text, /\d+(\.\d+)?%/, 'with the live percent: ' + hovered[0].text)
  assert.match(hovered[0].text, /200\.0K/, 'and the window: ' + hovered[0].text)
  await evaluate(`window.press(document.querySelector('${ring}'))`)
  await pause(250)
  assert.deepEqual(await evaluate('window.labels()'), [], 'a press on the ring dismisses its readout')
  assert.equal(await evaluate('window.ringOpened'), 1, 'and the click opens the context pane')
  await evaluate(`window.unhover(document.querySelector('${ring}'))`)
  await pause(250)
  assert.deepEqual(await evaluate('window.labels()'), [], 'leaving the ring still closes it')

  // 4. The reported case: hover the search button, open the panel, dismiss it by
  //    pressing the backdrop. Closing hands focus back to the trigger, which is
  //    not the user asking for a label.
  await evaluate(`window.unhover(document.querySelector('${plain}'))`)
  await evaluate(`window.hover(document.querySelector('${search}'))`)
  await pause(400)
  assert.equal((await evaluate('window.labels()')).length, 1, 'hovering the search trigger shows its label')
  await evaluate(`window.press(document.querySelector('${search}'))`)
  await pause(150)
  assert.equal(await evaluate(`document.querySelector('${search}').getAttribute('aria-expanded')`), 'true', 'the press opened the panel')
  assert.deepEqual(await evaluate('window.labels()'), [], 'opening the panel closes the trigger label')
  await evaluate(`window.unhover(document.querySelector('${search}'))`)
  await evaluate(`window.press(document.querySelector('button[aria-label="Dismiss modal"]'))`)
  await pause(500)
  const closed = await evaluate(`(()=>{const trigger=document.querySelector('${search}');return {expanded:trigger.getAttribute('aria-expanded'),focused:document.activeElement===trigger,labels:window.labels()}})()`)
  assert.equal(closed.expanded, 'false', 'the backdrop press closed the panel')
  assert.ok(closed.focused, 'closing hands focus back to the trigger: ' + JSON.stringify(closed))
  assert.deepEqual(closed.labels, [], 'a restored focus must not resurrect the label: ' + JSON.stringify(closed))

  // 5. The keyboard path survives: Tab (a key press) focusing the trigger still
  //    shows its label, so the fix is about the input, not about focus.
  await pause(400)
  // Park focus somewhere else first: `focus()` on the already-focused trigger
  // fires no focus event, and this step is about that event.
  await evaluate(`document.activeElement.blur()`)
  assert.notEqual(await evaluate(`document.activeElement===document.querySelector('${search}')`), true, 'focus was parked elsewhere')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`)
  await evaluate(`document.querySelector('${search}').focus()`)
  await pause(250)
  const labelled = await evaluate(`(()=>{const trigger=document.querySelector('${search}');return {focused:document.activeElement===trigger,labels:window.labels()}})()`)
  assert.ok(labelled.focused, 'the trigger is focused')
  assert.equal(labelled.labels.length, 1, 'keyboard focus still shows the label: ' + JSON.stringify(labelled))

  // 6. Escape closes the panel too, and the keyboard user keeps their label of
  //    where focus landed instead of leaving it invisible.
  await evaluate(`window.press(document.querySelector('${search}'))`)
  await pause(150)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await pause(500)
  const escaped = await evaluate(`(()=>{const trigger=document.querySelector('${search}');return {expanded:trigger.getAttribute('aria-expanded'),labels:window.labels()}})()`)
  assert.equal(escaped.expanded, 'false', 'Escape closed the panel')
  assert.equal(escaped.labels.length, 1, 'keyboard dismissal labels the trigger focus landed on: ' + JSON.stringify(escaped))

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  if (process.env.PI_TOOLTIP_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_TOOLTIP_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_TOOLTIP_SCREENSHOT_DIR, 'tooltip-after-dismiss.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  console.log('PASS: tooltip lifecycle around overlays — hover/press, the context ring as a control (press dismisses its readout and opens the pane), pointer dismissal with focus restoration, keyboard focus, and Escape.')
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
