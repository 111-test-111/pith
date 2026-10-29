/**
 * ⌘K command palette, in isolated Electron: no model calls, no user data.
 *
 * The fixture mounts the app's own `AppCommandPalette` composition with
 * recording spies instead of the real Workspace: that keeps this check about
 * the palette's own contract — the shortcut, filtering, grouping, keyboard
 * dispatch, dismissal and both locales. The command *bodies* are the
 * workspace's existing actions, stubbed here. What this deliberately does not
 * cover is Workspace's own callback wiring.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-palette-'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const fixturePath = '/__palette_check.html'

const fixture = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {ThemeProvider} from 'next-themes';
import {I18nProvider} from '/src/i18n/index.tsx';
import {AppCommandPalette} from '/src/components/app/CommandPalette.tsx';
import {installShortcutDispatcher,registerShortcutHandlers} from '/src/lib/shortcuts/shortcut-dispatcher.ts';
import '/src/styles.css';
// Pin the locale once: an isolated profile has none, and the fallback follows
// the host, which would make these assertions depend on the developer's
// machine. Only when unset — the zh-CN step below reloads the page on purpose.
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale','en');
window.calls=[];
const spy=(name)=>(...args)=>window.calls.push([name,...args]);
window.sessions=[
  {path:'/s/alpha.jsonl',id:'alpha',label:'Fix the parser',modified:new Date().toISOString(),messageCount:4,cwd:'/w/proj-a',projectless:false,running:false},
  {path:'/s/beta.jsonl',id:'beta',label:null,modified:new Date(Date.now()-3600e3).toISOString(),messageCount:1,cwd:'/w/scratch',projectless:true,running:false}
];
// The palette's ⌘K now rides the app's real shortcut dispatcher (the vendored
// surface's own listener is off): the fixture replicates the Workspace wiring —
// controlled open state plus the dispatcher's commandPalette handler.
function PaletteHost(){
  const [open,setOpen]=React.useState(false);
  React.useEffect(()=>installShortcutDispatcher(document),[]);
  React.useEffect(()=>registerShortcutHandlers({commandPalette:()=>setOpen(o=>!o)}),[]);
  return React.createElement(AppCommandPalette,{
    open,onOpenChange:setOpen,
    sessions:window.sessions,
    activePath:'/s/alpha.jsonl',
    folders:['/w/proj-a','/w/proj-b'],
    sidebarOpen:true,
    sidePanelOpen:false,
    onOpenSession:spy('openSession'),
    onNewSession:spy('newSession'),
    onOpenSettings:spy('settings'),
    onNewTerminal:spy('terminal'),
    onCompact:spy('compact'),
    onToggleSidebar:spy('toggleSidebar'),
    onToggleRail:spy('toggleRail')
  });
}
createRoot(document.getElementById('root')).render(
  React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'light'},
    React.createElement(I18nProvider,null,
      React.createElement(PaletteHost))));
// The dispatcher matches on the PHYSICAL code (layout-independent), so a
// synthetic keystroke must carry one.
window.pressK=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',metaKey:true,bubbles:true}));
window.pressEscape=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
window.pressEnter=()=>document.querySelector('[role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
window.dialog=()=>document.querySelector('[role=dialog]');
window.options=()=>[...document.querySelectorAll('[role=option]')].map(n=>({text:n.textContent.trim(),selected:n.getAttribute('aria-selected')}));
window.dialogText=()=>dialog()?dialog().textContent:'';
// React tracks the input's value through a native setter; assigning the
// value property directly would update the DOM without firing the change
// event the palette reads.
window.query=(value)=>{const input=document.querySelector('[role=combobox]');
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
window.clickOption=(index)=>document.querySelectorAll('[role=option]')[index].click();
window.fixtureReady=true;
</script></body></html>`

let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'palette-fixture', configureServer(server) {
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
  assert(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  // The window is created hidden: focusing the palette's input must still be
  // observable, so the page has to report itself as focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const ready = async () => { for (let i = 0; i < 240; i++) { if (await evaluate('!!window.fixtureReady')) return true; await pause(50) } return false }
  assert(await ready(), 'fixture mounted')
  await evaluate('document.fonts.ready')
  await pause(150)

  // 1. Closed by default, and ⌘K opens a real modal dialog whose input takes
  //    focus. `aria-modal` is what the composer's Escape-to-stop guard reads,
  //    so the palette's own Escape cannot stop a running turn.
  assert.equal(await evaluate('!!window.dialog()'), false, 'the palette starts closed')
  await evaluate('window.pressK()')
  await pause(300)
  const opened = await evaluate(`(()=>{const d=window.dialog();return {open:!!d,modal:d?.getAttribute('aria-modal'),label:d?.getAttribute('aria-label'),focused:document.activeElement===document.querySelector('[role=combobox]'),placeholder:document.querySelector('[role=combobox]')?.getAttribute('placeholder')}})()`)
  assert.ok(opened.open, '⌘K opens the palette')
  assert.equal(opened.modal, 'true', 'the palette is a modal dialog')
  assert.ok(opened.focused, 'the query input takes focus')
  assert.equal(opened.placeholder, 'Search commands and sessions…', 'localized placeholder')
  assert.equal(opened.label, 'Command palette', 'the dialog is labelled')

  // 2. One list holds the workspace's actions, the projects and the sessions,
  //    each under its own localized group heading.
  const initial = await evaluate('window.dialogText()')
  for (const expected of ['Actions', 'Projects', 'Sessions', 'Terminal', 'New chat', 'Summarize conversation', 'proj-a', 'Fix the parser']) {
    assert.ok(initial.includes(expected), `the initial list holds "${expected}": ${initial.slice(0, 200)}`)
  }
  assert.ok((await evaluate('window.options()')).length >= 10, 'actions, projects and sessions are all listed')
  assert.ok((await evaluate('window.dialogText()')).includes('Current'), 'the active session is marked')

  // 3. Filtering narrows to the match and Enter runs that row, closing first.
  await evaluate(`window.query('terminal')`)
  await pause(250)
  const filtered = await evaluate('window.options()')
  assert.equal(filtered[0].selected, 'true', 'the first match is highlighted')
  assert.match(filtered[0].text, /Terminal/, 'the match is the terminal action')
  await evaluate('window.pressEnter()')
  await pause(350)
  assert.deepEqual(await evaluate('window.calls'), [['terminal']], 'Enter ran the highlighted command')
  assert.equal(await evaluate('!!window.dialog()'), false, 'running a command closes the palette')

  // 3b. Manual compaction is offered from the palette (the app's `/compact`
  //     equivalent) and dispatches to its own action.
  await evaluate('window.pressK()')
  await pause(300)
  await evaluate(`window.query('compact')`)
  await pause(250)
  assert.match((await evaluate('window.options()'))[0].text, /Summarize conversation/, 'compaction is a command')
  await evaluate('window.pressEnter()')
  await pause(350)
  assert.deepEqual(await evaluate('window.calls').then((calls) => calls.at(-1)), ['compact'], 'the compaction command dispatched')

  // 4. A click dispatches that row, and session rows carry their real target
  //    (path plus owning cwd) so the wired workspace action needs no lookup.
  await evaluate('window.pressK()')
  await pause(300)
  await evaluate(`window.query('Fix the parser')`)
  await pause(250)
  await evaluate('window.clickOption(0)')
  await pause(350)
  assert.deepEqual(await evaluate('window.calls.at(-1)'), ['openSession', '/s/alpha.jsonl', '/w/proj-a'], 'a session row opens that session')

  // 5. A session with no messages yet is named by its state, never a blank row.
  await evaluate('window.pressK()')
  await pause(300)
  await evaluate(`window.query('scratch')`)
  await pause(250)
  const unlabelled = await evaluate('window.options()')
  assert.match(unlabelled[0].text, /New chat/, 'an unlabelled session falls back to a localized name')

  // 6. Escape dismisses, and the palette leaves no overlay behind.
  await evaluate('window.pressEscape()')
  await pause(400)
  assert.equal(await evaluate('!!window.dialog()'), false, 'Escape closes the palette')
  assert.equal(await evaluate('!!document.querySelector(".app-toast-region")'), false, 'no stray surface remains')

  // 7. The other locale, through the same dictionary.
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN')`)
  await send('Page.reload')
  await pause(600)
  assert(await ready(), 'fixture remounted after reload')
  await pause(250)
  await evaluate('window.pressK()')
  await pause(350)
  const zh = await evaluate(`(()=>({placeholder:document.querySelector('[role=combobox]')?.getAttribute('placeholder'),text:window.dialogText()}))()`)
  assert.equal(zh.placeholder, '搜索命令和会话…', 'localized placeholder (zh-CN)')
  for (const expected of ['操作', '项目', '会话']) assert.ok(zh.text.includes(expected), `zh-CN group heading "${expected}"`)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  if (process.env.PI_PALETTE_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_PALETTE_SCREENSHOT_DIR, { recursive: true })
    for (const [name, dark] of [['light', false], ['dark', true]]) {
      await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
      await pause(250)
      await writeFile(join(process.env.PI_PALETTE_SCREENSHOT_DIR, `palette-${name}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    }
  }
  console.log('PASS: ⌘K palette — modal open/focus, grouped commands, filtering, Enter and click dispatch, dismissal, unlabelled sessions, both locales.')
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
