/** Real Electron + PTYs + Workspace, in an isolated profile with no SDK/model
 * calls. Run after npm run build: node scripts/check-terminal.mjs */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, symlink, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { checkTerminalAppearance } from './lib/check-terminal-appearance.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-terminal-'))
const project = join(temporary, 'project with spaces 中文')
const home = join(temporary, 'home')
const pause = ms => new Promise(r => setTimeout(r, ms))
let server, child, ws
const fixturePath = '/__terminal_check.html'
const fixture = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider} from 'next-themes';
import {Workspace} from '/src/components/app/Workspace.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {ToastProvider} from '/src/components/app/ToastProvider.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {TerminalStore} from '/src/state/terminal-store.ts';
import {initFonts} from '/src/lib/fonts.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');initFonts();
window.store=new PiStore();
window.setSession=(cwd,projectless=false)=>store.applySnapshot({cwd,projectless,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
setSession(${JSON.stringify(project)});
const originalCreate=TerminalStore.prototype.create;
TerminalStore.prototype.create=function(...args){if(!window.tc){window.tc=this;window.storeUpdates=0;this.subscribe(()=>window.storeUpdates++);}return originalCreate.apply(this,args)};
window.terminal=id=>tc.sessions.get(id??tc.getSnapshot().active)?.runtime?.terminal;
window.buffer=id=>{const b=terminal(id).buffer.active;return Array.from({length:b.length},(_,i)=>(b.getLine(i).isWrapped?'':'\\n')+b.getLine(i).translateToString(true)).join('')};
window.traffic={};window.pi.onTerminalEvent(e=>{if(e.type==='data'){const s=traffic[e.id]??={chars:0,batches:0,tail:''};s.chars+=e.data.length;s.batches++;s.tail=(s.tail+e.data).slice(-4096)}});
window.root=createRoot(document.getElementById('root'));
root.render(React.createElement(React.StrictMode,null,React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'dark'},React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement(ToastProvider,null,React.createElement(Workspace,{store,accent:'indigo',onAccentChange:()=>{}})))))));
window.fixtureReady=true;
</script></body></html>`

try {
  await mkdir(project); await mkdir(home)
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  await copyFile(join(repo, 'out/main/terminal-host.mjs'), join(temporary, 'terminal-host.mjs'))
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'terminal-fixture', configureServer(server) { server.middlewares.use(async (req,res,next) => {
        if (req.url !== fixturePath) return next()
        try { res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(fixturePath,fixture)) } catch(error) { next(error) }
      }) }
    }], server: {host:'127.0.0.1',port:0,fs:{allow:[repo]}}
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await build({stdin:{contents:`
import {app,BrowserWindow,ipcMain} from 'electron';
import {TerminalManager} from ${JSON.stringify(join(repo,'src/main/terminal/manager.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const manager=new TerminalManager();
 ipcMain.handle('terminal:create',(event,payload)=>manager.create(event.sender,payload));
 ipcMain.on('terminal:command',(event,command)=>command.type==='close'?void manager.closeAndWait(event.sender,command.id):manager.command(event.sender,command));
 ipcMain.handle('app:info',()=>({cwd:${JSON.stringify(project)},folders:[${JSON.stringify(project)}],contextFiles:true,version:'test'}));
 ipcMain.handle('pi:models',()=>[]);ipcMain.handle('pi:listSessions',()=>[]);
 let quitting=false;app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void manager.dispose().finally(()=>app.quit())});
 const w=new BrowserWindow({width:1320,height:880,title:'Terminal regression',webPreferences:{preload:${JSON.stringify(join(repo,'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 w.loadURL(${JSON.stringify(url)});
});app.on('window-all-closed',()=>app.quit());`,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:main,define:process.env.TERMINAL_PACKAGED_RESOURCES?{__dirname:JSON.stringify(join(process.env.TERMINAL_PACKAGED_RESOURCES,'app.asar/out/main'))}:{}})
  const terminalEnv={...process.env,HOME:home,SHELL:'/bin/bash'}
  // The agent/test runner disables colors for captured tool logs. An actual
  // interactive terminal must negotiate color support with the application.
  delete terminalEnv.NO_COLOR
  delete terminalEnv.FORCE_COLOR
  child=spawn(electron,[main],{env:terminalEnv,stdio:['ignore','ignore','pipe']})
  let stderr=''
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Debugger timeout: '+stderr)),15000)
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Electron exited: '+code+' '+stderr))})
    child.stderr.on('data',chunk=>{stderr+=chunk;const m=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}})
  })
  let page
  for(let i=0;i<100&&!page;i++){page=(await(await fetch(endpoint+'/json/list')).json()).find(p=>p.type==='page');if(!page)await pause(50)}
  assert.ok(page)
  ws=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r=>ws.addEventListener('open',r,{once:true}))
  let sequence=0
  const pending=new Map()
  const exceptions=[]
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails)})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value}
  const waitFor=async(expression,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(`Boolean(${expression})`))return;await pause(50)}throw new Error('Timed out: '+label+'; '+JSON.stringify(await evaluate('({text:document.body.innerText,tabs:window.tc?.getSnapshot(),buffer:window.tc?.getSnapshot().active?buffer().slice(-2500):null})'))+'\n'+stderr.slice(-2000))}
  const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await pause(80)}
  const input=async(text,id)=>evaluate(`window.pi.terminalInput(${id?JSON.stringify(id):'tc.getSnapshot().active'},${JSON.stringify(text)})`)
  await send('Runtime.enable')
  const panelSelector='button[aria-label="Toggle sidebar"][aria-pressed]'
  await waitFor(`window.fixtureReady && document.querySelector(${JSON.stringify(panelSelector)})`,'workspace')
  await click(panelSelector)
  await evaluate(`Array.from(document.querySelectorAll('[data-panel="right"] button')).find(b=>b.textContent.includes('Terminal')).click()`)
  await waitFor('window.tc?.getSnapshot().tabs[0]?.status === "running"','default terminal')
  const first=await evaluate('tc.getSnapshot().active')
  await input('printf "__CWD__%s\\n" "$PWD"\r')
  await waitFor(`buffer().includes(${JSON.stringify('__CWD__'+project)})`,'project cwd')
  assert.equal(await evaluate('tc.getSnapshot().tabs.length'),1)
  const pid=await evaluate('tc.getSnapshot().tabs[0].info.pid')
  console.log('PASS: default terminal, real PTY, project path with spaces/CJK')

  const dockedCols = await evaluate('terminal().cols')
  await evaluate('window.__fullscreenTerminal = terminal(); void 0')
  await click('[data-titlebar-action="sidebar-fullscreen"]')
  await waitFor(`terminal().cols > ${dockedCols}`, 'fullscreen terminal fit')
  assert.equal(await evaluate('terminal() === window.__fullscreenTerminal'), true, 'fullscreen retains the terminal emulator')
  assert.equal(await evaluate('tc.getSnapshot().tabs[0].info.pid'), pid, 'fullscreen retains the PTY')
  await input('printf "__FULLSCREEN_ALIVE__\\n"\r')
  await waitFor('buffer().includes("__FULLSCREEN_ALIVE__")', 'terminal input in fullscreen')
  await click('[data-titlebar-action="sidebar-fullscreen"]')
  await waitFor(`terminal().cols === ${dockedCols}`, 'restored terminal fit')
  assert.equal(await evaluate('buffer().includes("__FULLSCREEN_ALIVE__")'), true, 'restoring width retains scrollback')
  console.log('PASS: fullscreen terminal resize, input, PTY and scrollback retention')

  await evaluate(`setSession('/internal/workspace',true)`)
  await click('[aria-label="New terminal"]')
  await waitFor('tc.getSnapshot().tabs[1]?.status === "running"','second terminal')
  const second=await evaluate('tc.getSnapshot().active')
  await input('printf "__HOME__%s\\n" "$PWD"\r')
  await waitFor(`buffer().includes(${JSON.stringify('__HOME__'+home)})`,'projectless home')
  await input('printf "\\033[31m红色中文🙂\\033[0m\\n"\r')
  await waitFor('buffer().includes("红色中文🙂")','Unicode/ANSI')

  // A hidden pane/terminal keeps its PTY and emulator, including background output.
  await input('sleep 0.2; printf "__BACKGROUND_DONE__\\n"\r',first)
  await click(`[data-terminal-tab="${first}"] [role="tab"]`)
  await waitFor('buffer().includes("__BACKGROUND_DONE__")','background output')
  assert.equal(await evaluate('tc.getSnapshot().tabs[0].info.pid'),pid)
  await click(panelSelector)
  await pause(350)
  assert.equal(await evaluate('document.querySelectorAll(".xterm").length'),0)
  await input('printf "__COLLAPSED__\\n"\r',first)
  await click(panelSelector)
  await waitFor('document.querySelector(".xterm") && buffer().includes("__COLLAPSED__")','reopen panel')
  assert.equal(await evaluate('tc.getSnapshot().tabs[0].info.pid'),pid)
  // Switching to Review must detach only the screen, not close its PTY.
  await click('[aria-label="New tab"]')
  await evaluate(`Array.from(document.querySelectorAll('[data-panel="right"] button')).find(b=>b.textContent.includes('Review')).click()`)
  await pause(100)
  assert.equal(await evaluate('document.querySelectorAll(".xterm").length'),0)
  await input('printf "__REVIEW_BACKGROUND__\\n"\r',first)
  await evaluate(`Array.from(document.querySelectorAll('[data-panel="right"] [role="tab"]')).find(b=>b.textContent==='Terminal').click()`)
  await waitFor('document.querySelector(".xterm") && buffer().includes("__REVIEW_BACKGROUND__")','return from Review')
  await click('[aria-label="Close Review"]')
  await evaluate(`window.escapeBubbled=0;window.addEventListener('keydown',e=>{if(e.key==='Escape')window.escapeBubbled++});terminal().focus()`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  assert.equal(await evaluate('escapeBubbled'),0,'terminal Escape does not reach chat stop shortcuts')
  await input('\x03')
  console.log('PASS: multiple terminals, home fallback, Unicode, background output and collapse persistence')

  // Right-click menu: one surface menu, resolved through the active emulator,
  // with paste returning through the same `terminal:*` IPC path.
  const openMenuAt=async(x,y)=>{
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'right',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'right',clickCount:1})
    await waitFor(`Array.from(document.querySelectorAll('[data-context-menu-portal]')).some(p=>p.getAttribute('aria-hidden')==='false')`,'terminal context menu')
  }
  const openMenu=async()=>{
    const rect=await evaluate(`(()=>{const r=document.querySelector('[data-terminal-surface]').getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+30)}})()`)
    await openMenuAt(rect.x,rect.y)
  }
  // "The menu" is the portal that is not hidden — the app keeps every portal in
  // the document.
  const menuItems=()=>evaluate(`Array.from(document.querySelectorAll('[data-context-menu-portal]')).filter(p=>p.getAttribute('aria-hidden')==='false').flatMap(p=>Array.from(p.querySelectorAll('[role=menuitem]'))).map(i=>({label:i.textContent.trim(),disabled:i.disabled}))`)
  const clickMenuItem=async label=>{
    await evaluate(`(()=>{const portal=Array.from(document.querySelectorAll('[data-context-menu-portal]')).find(p=>p.getAttribute('aria-hidden')==='false');const item=Array.from(portal.querySelectorAll('[role=menuitem]')).find(i=>i.textContent.trim()===${JSON.stringify(label)});item.click()})()`)
    await pause(120)
  }
  const menuClosed=()=>evaluate(`Array.from(document.querySelectorAll('[data-context-menu-portal]')).every(p=>p.getAttribute('aria-hidden')==='true')`)

  await input('printf "__MENU_SEED_A__\\n"\r')
  await waitFor('buffer().includes("__MENU_SEED_A__")','menu seed')
  await evaluate('terminal().selectAll()')
  await openMenu()
  assert.deepEqual(await menuItems(),[
    {label:'Copy',disabled:false},{label:'Paste',disabled:false},{label:'Clear',disabled:false},{label:'Select all',disabled:false}
  ],'terminal menu offers copy/paste/clear/select-all')
  // Captured while the menu is open: the platform's own right-click handling
  // (macOS word select) has already run by now.
  const selected=await evaluate('terminal().getSelection()')
  assert.ok(selected.includes('__MENU_SEED_A__'),'a selection survives the right click')
  await clickMenuItem('Copy')
  assert.equal(await menuClosed(),true,'choosing Copy closes the menu')
  assert.equal(await evaluate('navigator.clipboard.readText()'),selected,'Copy writes the emulator selection')
  assert.equal(await evaluate(`document.querySelector('[data-terminal-surface]').contains(document.activeElement)`),true,'the emulator takes focus back after the menu closes')

  await evaluate(`navigator.clipboard.writeText('__PASTED__')`)
  await openMenu();await clickMenuItem('Paste')
  await waitFor('buffer().includes("__PASTED__")','paste reaches the PTY')
  await input('\x03')
  await input('printf "__CLEAR_SEED__\\n"\r')
  await waitFor('buffer().includes("__CLEAR_SEED__")','clear seed')
  await openMenu();await clickMenuItem('Clear')
  assert.equal(await evaluate('buffer().includes("__CLEAR_SEED__")'),false,'Clear drops the viewport and scrollback')
  await input('printf "__SELECT_ALL__\\n"\r')
  await waitFor('buffer().includes("__SELECT_ALL__")','select-all seed')
  await openMenu();await clickMenuItem('Select all')
  assert.equal(await evaluate('terminal().getSelection().includes("__SELECT_ALL__")'),true,'Select all selects the buffer')
  await evaluate('terminal().clearSelection()')
  console.log('PASS: terminal context menu — copy, paste over terminal:* IPC, clear, select all, focus return')

  const oldCols=await evaluate('terminal().cols')
  const originalFont=await evaluate('terminal().options.fontFamily')
  await evaluate(`document.documentElement.style.setProperty('--app-font-mono','"Courier New", monospace')`)
  await waitFor('terminal().options.fontFamily.includes("Courier New")','font update')
  const handle=await evaluate(`(()=>{const r=document.querySelector('[data-panel-handle="left"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+150}})()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1})
  for(let step=1;step<=10;step++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x-step*15,y:handle.y,button:'left',buttons:1});await pause(16)}
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x-150,y:handle.y,button:'left',clickCount:1})
  await waitFor(`terminal().cols > ${oldCols}`,'fit resize')
  await input('printf "__SIZE__"; stty size\r')
  const dimensions=await evaluate('({rows:terminal().rows,cols:terminal().cols})')
  await waitFor(`buffer().includes(${JSON.stringify('__SIZE__'+dimensions.rows+' '+dimensions.cols)})`,'PTY resize')
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'})`)
    await pause(120)
    const shot=await send('Page.captureScreenshot',{format:'png'})
    if(process.env.TERMINAL_SCREENSHOT_DIR)await writeFile(join(process.env.TERMINAL_SCREENSHOT_DIR,`terminal-${theme}.png`),Buffer.from(shot.data,'base64'))
  }
  console.log('PASS: live configured monospace font, theme and PTY resize')

  await evaluate(`document.documentElement.style.setProperty('--app-font-mono',${JSON.stringify(originalFont)})`)
  await waitFor(`terminal().options.fontFamily === ${JSON.stringify(originalFont)}`,'restore configured font')
  await pause(100)
  await checkTerminalAppearance({ evaluate, send, input, waitFor, click, pause, ws, temporary, first, second })

  // Optional reproduction with an explicit local fastfetch configuration. Never
  // edits the user's config; CLI flags exercise the compatible text-only mode.
  if (process.env.TERMINAL_FASTFETCH_BIN && process.env.TERMINAL_FASTFETCH_CONFIG) {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const command = `${quote(process.env.TERMINAL_FASTFETCH_BIN)} --config ${quote(process.env.TERMINAL_FASTFETCH_CONFIG)}`
    await input(`clear; ${command}; printf '__FETCH_ORIGINAL_DONE__\\n'\r`)
    await waitFor('traffic[tc.getSnapshot().active].tail.includes("\\r\\n__FETCH_ORIGINAL_DONE__\\r\\n")','configured fastfetch',30000)
    const original = await evaluate(`Array.from({length:terminal().buffer.active.length},(_,i)=>terminal().buffer.active.getLine(i).translateToString(true)).filter(l=>l.trim()).slice(-35)`)
    assert.ok(original.some(line=>/^ {50,}/.test(line)),'configured 50-column Kitty logo reserves blank space')
    await input(`clear; ${command} --logo-type none --key-type string; printf '__FETCH_TEXT_DONE__\\n'\r`)
    await waitFor('traffic[tc.getSnapshot().active].tail.includes("\\r\\n__FETCH_TEXT_DONE__\\r\\n")','text fastfetch',30000)
    const compatible = await evaluate(`Array.from({length:terminal().buffer.active.length},(_,i)=>terminal().buffer.active.getLine(i).translateToString(true)).filter(l=>l.trim()).slice(-35)`)
    assert.ok(compatible.some(line=>/^OS\s/.test(line)),'plain keys start at the left edge')
    assert.ok(!compatible.some(line=>/^ {50,}/.test(line)),'no empty logo column in compatible output')
    if(process.env.TERMINAL_SCREENSHOT_DIR){const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.TERMINAL_SCREENSHOT_DIR,'terminal-fastfetch.png'),Buffer.from(shot.data,'base64'))}
    console.log('PASS: reproduced fastfetch Kitty-logo padding; text-only flags render without blank columns or icon glyphs')
  }

  // Real high-volume output; timing is diagnostic, not a hardware-dependent gate.
  await evaluate(`window.beforeUpdates=storeUpdates;window.frames=[];window.sampling=true;let last=performance.now();function sample(t){if(!sampling)return;frames.push(t-last);last=t;requestAnimationFrame(sample)}requestAnimationFrame(sample);window.perfStart=performance.now()`)
  await input(`awk 'BEGIN { for(i=0;i<150000;i++) printf "PERF %06d 0123456789012345678901234567890123456789\\n",i; print "PERF_DONE" }'\r`)
  await waitFor('traffic[tc.getSnapshot().active]?.tail.includes("PERF 149999") && buffer().includes("PERF_DONE")','150k lines',45000)
  const perf=await evaluate(`sampling=false;({elapsed:performance.now()-perfStart,frames:frames.length,p95:frames.sort((a,b)=>a-b)[Math.floor(frames.length*.95)],max:Math.max(...frames),reactUpdates:storeUpdates-beforeUpdates,lines:terminal().buffer.active.length,nodes:document.querySelector('.xterm').querySelectorAll('*').length,canvas:document.querySelectorAll('.xterm canvas').length})`)
  assert.ok(perf.lines<=10000+dimensions.rows,'bounded scrollback')
  assert.ok(perf.nodes<1500,'bounded DOM')
  assert.ok(perf.reactUpdates<10,'output never updates React state')
  assert.ok(perf.canvas>0,'WebGL active')
  await pause(300)
  await evaluate('terminal().scrollToTop()')
  await waitFor('terminal().buffer.active.viewportY===0','smooth scroll to top')
  assert.equal(await evaluate('terminal().buffer.active.viewportY'),0,'scrollback top reachable')
  await evaluate('terminal().scrollToBottom()');await pause(200)
  assert.equal(await evaluate('terminal().buffer.active.viewportY===terminal().buffer.active.baseY'),true)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".xterm-scrollable-element > .scrollbar")).display'),'none','no scrollbar chrome')
  console.log('PASS: 150,000 lines (~8MB), bounded DOM/scrollback, zero per-output React work:',perf)

  await input('yes\r');await pause(500)
  const interruptStart=Date.now()
  await input('\x03');await input('printf "__INTERRUPTED__\\n"\r')
  await waitFor('traffic[tc.getSnapshot().active].tail.includes("\\r\\n__INTERRUPTED__\\r\\n")','Ctrl-C',5000)
  console.log('PASS: Ctrl-C during continuous output:',Date.now()-interruptStart,'ms')

  // No ACK means producers must stop instead of filling unbounded IPC queues.
  const raw=await evaluate(`window.rawId=crypto.randomUUID();window.pi.terminalCreate({id:rawId,cwd:null,cols:80,rows:24})`)
  assert.ok(raw.terminal)
  await evaluate(`window.pi.terminalInput(rawId,'yes\\r')`);await pause(500)
  const paused=await evaluate('traffic[rawId].chars')
  await pause(300)
  assert.equal(await evaluate('traffic[rawId].chars'),paused,'unacknowledged output stops')
  assert.ok(paused<512*1024,'IPC backlog is bounded')
  await evaluate('window.pi.terminalClose(rawId)')
  console.log('PASS: flow control bounds stalled consumer to',paused,'characters')

  // Debug cleanup closes from main, retaining a terminal status page in UI.
  const debugTerminal = await evaluate(`tc.spawnForDebug(${JSON.stringify(project)},'Debug fixture')`)
  assert.ok(debugTerminal.id)
  await evaluate(`window.pi.terminalClose(${JSON.stringify(debugTerminal.id)})`)
  await waitFor(`tc.getSnapshot().tabs.find(t=>t.id===${JSON.stringify(debugTerminal.id)})?.status==='exited'`, 'main-initiated terminal cleanup')
  assert.equal(await evaluate(`tc.sessions.get(${JSON.stringify(debugTerminal.id)}).runtime`), undefined)
  assert.throws(()=>process.kill(debugTerminal.pid,0), 'debug shell is gone before its status page settles')
  await evaluate(`tc.close(${JSON.stringify(debugTerminal.id)})`)
  console.log('PASS: main-initiated debug cleanup retains exit status and releases the emulator')

  await input('exit 7\r',second)
  await waitFor(`tc.getSnapshot().tabs.find(t=>t.id===${JSON.stringify(second)}).status==='exited'`,'shell exit')
  assert.equal(await evaluate(`tc.getSnapshot().tabs.find(t=>t.id===${JSON.stringify(second)}).exitCode`),7)
  await click(`[data-terminal-tab="${second}"] [role="tab"]`)
  assert.equal(await evaluate('document.querySelectorAll("[data-terminal-surface], .xterm").length'),0,'exit removes the terminal screen')
  assert.equal(await evaluate('document.querySelector("[data-terminal-pane] [role=status]").textContent'),'Process exited with code 7')
  assert.equal(await evaluate('document.querySelectorAll("[data-terminal-pane] [role=status] button").length'),0,'exit status has no New terminal action')
  assert.equal(await evaluate(`tc.sessions.get(${JSON.stringify(second)}).runtime === undefined`),true,'exit releases emulator resources')
  await click(`[data-terminal-tab="${first}"] [role="tab"]`)
  await waitFor('document.querySelector(".xterm")','return to live terminal')
  await click(`[data-terminal-tab="${second}"] [role="tab"]`)
  assert.equal(await evaluate('document.querySelectorAll(".xterm").length'),0,'revisiting an exited terminal cannot restore text')
  if(process.env.TERMINAL_SCREENSHOT_DIR){await pause(600);const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.TERMINAL_SCREENSHOT_DIR,'terminal-exited.png'),Buffer.from(shot.data,'base64'))}
  await click(`[data-terminal-tab="${second}"] button[aria-label]`)
  await input('sleep 30 & printf "__CHILD__%s\\n" $! ; wait\r',first)
  await waitFor(`/__CHILD__[0-9]+/.test(traffic[${JSON.stringify(first)}].tail)`,'child process')
  const childPid=await evaluate(`Number(traffic[${JSON.stringify(first)}].tail.match(/__CHILD__([0-9]+)/)[1])`)
  await click(`[data-terminal-tab="${first}"] button[aria-label]`)
  await pause(350)
  assert.equal(await evaluate('tc.getSnapshot().tabs.length'),0)
  assert.equal(await evaluate('document.querySelectorAll("[data-panel=right]").length'),0,'last terminal closes Terminal tab and empty rail')
  assert.throws(()=>process.kill(pid,0),'closed shell is terminated')
  assert.throws(()=>process.kill(childPid,0),'closed shell jobs are terminated')

  // Closing immediately, before lazy create resolves, must not leave an orphan.
  await evaluate(`tc.create(${JSON.stringify(project)});tc.close(tc.getSnapshot().active)`)
  await pause(250)
  assert.equal(await evaluate('tc.getSnapshot().tabs.length'),0)
  const bad=await evaluate(`window.pi.terminalCreate({id:crypto.randomUUID(),cwd:'/not/a/real/directory',cols:80,rows:24})`)
  assert.deepEqual(bad,{error:'directory'})
  console.log('PASS: exit status, process cleanup, close-all, create/close race and missing-directory errors')
  // Reload releases terminal ownership even if React never gets to unmount.
  const reloadTerminal=await evaluate(`window.pi.terminalCreate({id:crypto.randomUUID(),cwd:null,cols:80,rows:24})`)
  await send('Page.reload')
  await pause(500)
  assert.throws(()=>process.kill(reloadTerminal.terminal.pid,0),'renderer reload terminates owned shells')
  console.log('PASS: renderer reload cleanup')
  assert.deepEqual(exceptions,[],'no uncaught renderer exceptions')
} finally {
  ws?.close()
  if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited}
  await server?.close()
  await rm(temporary,{recursive:true,force:true})
}
