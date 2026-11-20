/** Real Electron, production SSH IPC/preload, store and sidebar terminal. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { hasTmux } from './lib/ssh-fixture.mjs'

const repo = resolve('.'), temporary = await mkdtemp(join(tmpdir(), 'pith-ssh-ui-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function terminalFrame(term) {
  if (!term) return null
  term.options.allowProposedApi = true
  const b = term.buffer.active
  const color = row => {
    const cell = b.getLine(b.viewportY + row)?.getCell(0)
    return cell ? { fg: cell.getFgColor(), palette: cell.isFgPalette() } : null
  }
  return { cols: term.cols, rows: term.rows, type: b.type, x: b.cursorX, y: b.cursorY,
    screen: Array.from({ length: term.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '').join('\n').trimEnd(),
    top: color(0), bottom: color(9), modes: { applicationCursor: term.modes.applicationCursorKeysMode,
      paste: term.modes.bracketedPasteMode, wrap: term.modes.wraparoundMode } }
}
let server, child, ws
try {
  if (!hasTmux()) console.log('SKIP: SSH terminal fixture requires tmux on PATH')
  else {
    await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
    const fixturePath = '/__ssh_check.html'
    const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {ThemeProvider} from 'next-themes';
import {I18nProvider} from '/src/i18n/index.tsx';import {TerminalPane} from '/src/components/app/TerminalPane.tsx';
import {TerminalStore,watchSshTerminals} from '/src/state/terminal-store.ts';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');window.terminals=new TerminalStore();window.opened=0;
const watch=()=>watchSshTerminals(()=>terminals,()=>window.opened++);
window.off=watch();
window.buffer=()=>{const term=terminals.sessions.get(terminals.getSnapshot().active)?.runtime?.terminal;if(!term)return '';const b=term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)??'').join('\\n')};
window.frame=()=>(${terminalFrame.toString()})(terminals.sessions.get(terminals.getSnapshot().active)?.runtime?.terminal);
window.mount=()=>{window.root=createRoot(document.getElementById('root'));root.render(React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'dark'},React.createElement(I18nProvider,null,React.createElement(TerminalPane,{terminals,onNew:()=>{},onEmpty:()=>{}}))))};
mount();window.fixtureReady=true;
window.resetStore=()=>{root.unmount();off();terminals.dispose();window.terminals=new TerminalStore();window.off=watch();mount()};
</script></body></html>`
    server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temporary, 'vite'), logLevel: 'error',
      resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react(), tailwindcss(), {
        name: 'ssh-page', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
          if (request.url !== fixturePath) return next()
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
        }) }
      }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
    await server.listen()
    const main = join(temporary, 'main.cjs')
    await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain} from 'electron';import {SshSessionManager} from './src/main/ssh/manager';
import {registerSshIpc} from './src/main/ssh/ipc';
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(async()=>{
const {createSshFixture,fixturePassword}=await import(${JSON.stringify(pathToFileURL(join(repo, 'scripts/lib/ssh-fixture.mjs')).href)});
const remote=await createSshFixture(${JSON.stringify(temporary)});const credentials=${JSON.stringify(join(temporary, 'credentials.json'))};
await import('node:fs/promises').then(fs=>fs.writeFile(credentials,JSON.stringify({password:fixturePassword}),{mode:0o600}));
const manager=new SshSessionManager(${JSON.stringify(join(temporary, 'known-hosts.json'))},event=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('ssh:event',event)},50);
const owner='/fixture/chat';let active;
registerSshIpc({listSshSessions:()=>manager.list(),sshOutput:r=>manager.output(r.sessionPath,r.id,r.cursor,r.maxChars,r.waitMs,undefined,r.snapshot),
watchSshViewer:(id,on)=>manager.watchViewer(id,on),ackSshViewer:(v,id,n)=>manager.ackViewer(v,id,n),
sshPanelAction:async r=>{try{if(r.action==='close')return{session:await manager.close(r.sessionPath,r.id,r.terminateRemote)};
if(r.action==='resize')return{session:manager.resize(r.sessionPath,r.id,r.cols,r.rows)};if(r.action==='reconnect')return{session:await manager.reconnect(r.sessionPath,r.id)};
return{session:manager.write(r.sessionPath,r.id,r.data,r.generation)}}catch{return{error:'failed'}}}});
ipcMain.handle('ssh:fixtureConnect',async(_e,persistence='tmux')=>active=await manager.connect(owner,${JSON.stringify(temporary)},{host:'127.0.0.1',port:remote.port,username:'fixture',credentialsFile:credentials,persistence},()=>true));
ipcMain.handle('ssh:fixtureWrite',(_e,data)=>manager.write(owner,active.id,data,manager.status(owner,active.id).generation));
ipcMain.handle('ssh:fixtureDrop',()=>remote.drop());ipcMain.handle('ssh:fixtureState',()=>active?manager.status(owner,active.id):null);
ipcMain.handle('ssh:fixtureInput',()=>remote.wires.join(''));
ipcMain.handle('ssh:fixtureFrame',async()=>{await manager.output(owner,active.id);return (${terminalFrame.toString()})(manager.sessions.get(active.id).terminal)});
let quitting=false;app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void manager.dispose().then(()=>remote.dispose()).finally(()=>app.quit())});
process.on('SIGTERM',()=>app.quit());
const w=new BrowserWindow({width:1100,height:720,webPreferences:{preload:${JSON.stringify(join(temporary, 'preload.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
w.loadURL(${JSON.stringify('http://127.0.0.1:' + server.httpServer.address().port + fixturePath)});
});app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })
    // Extend the production preload with fixture dispatch, preserving its actual bridge.
    await writeFile(join(temporary, 'preload.mjs'), await readFile(join(repo, 'out/preload/index.mjs'), 'utf8') + `\nimport {contextBridge as bridge,ipcRenderer as ipc} from 'electron';bridge.exposeInMainWorld('fixture',{connect:persistence=>ipc.invoke('ssh:fixtureConnect',persistence),write:data=>ipc.invoke('ssh:fixtureWrite',data),drop:()=>ipc.invoke('ssh:fixtureDrop'),state:()=>ipc.invoke('ssh:fixtureState'),input:()=>ipc.invoke('ssh:fixtureInput'),frame:()=>ipc.invoke('ssh:fixtureFrame')});\n`)
    child = spawn(electron, [main], { env: { ...process.env, SHELL: '/bin/bash' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron debugger timeout ' + stderr)), 15000)
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ' ' + stderr)) })
      child.stderr.on('data', data => { stderr += data; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
    })
    let page
    for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page'); if (!page) await pause(50) }
    assert(page)
    ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
    let serial = 0; const pending = new Map(), exceptions = []
    ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id) } else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails) })
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, m => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression: '(async()=>(' + expression + '))()', returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
    const wait = async (expression, label) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await evaluate('Boolean(' + expression + ')')) return; await pause(40) }; throw new Error(label + ' ' + JSON.stringify(await evaluate('({text:document.body.innerText,tabs:terminals.getSnapshot(),screen:buffer()})')) + stderr.slice(-1000)) }
    await send('Runtime.enable')
    await wait('window.fixtureReady', 'renderer ready')
    const first = await evaluate('fixture.connect()')
    await wait('document.querySelector(".xterm") && document.querySelector("[data-ssh-status=connected]")', 'SSH appears in terminal pane')
    assert.equal(await evaluate('opened'), 1)
    const id = await evaluate('terminals.getSnapshot().active')
    assert.equal(id, 'ssh:' + first.id)
    await evaluate('fixture.write(' + JSON.stringify("printf '\\033[31mVISIBLE_%s\\033[0m\\n' '中文🙂'\r") + ')')
    await wait('buffer().includes("VISIBLE_中文🙂")', 'live Unicode/ANSI output')
    await evaluate('root.unmount()')
    await evaluate('fixture.write(' + JSON.stringify("sleep 0.1; printf 'HIDDEN_%s\\n' 'OUTPUT'\r") + ')')
    await pause(250); await evaluate('mount()')
    await wait('buffer().includes("HIDDEN_OUTPUT") && document.querySelector(".xterm")', 'pane remount retains output')
    const generation = await evaluate('(await fixture.state()).generation')
    await evaluate('fixture.drop()')
    await wait('(await fixture.state()).generation > ' + generation + ' && document.querySelector("[data-ssh-status=connected]")', 'automatic reconnect updates tab')
    assert.equal(await evaluate('terminals.getSnapshot().tabs.length'), 1)
    assert.equal(await evaluate('terminals.getSnapshot().active'), id)
    await evaluate('fixture.write(' + JSON.stringify("printf 'RETURNED_%s\\n' 'OUTPUT'\r") + ')')
    await wait('buffer().includes("RETURNED_OUTPUT")', 'output after reconnect')
    const reloadedGeneration = await evaluate('(await fixture.state()).generation')
    await evaluate('resetStore()')
    await wait('buffer().includes("RETURNED_OUTPUT") && document.querySelector(".xterm")', 'renderer reconstruction hydrates retained SSH output')
    assert.equal(await evaluate('(await fixture.state()).generation'), reloadedGeneration, 'reconstruction does not reconnect or replay input')
    await evaluate("terminals.sessions.get(terminals.getSnapshot().active).runtime.terminal.paste('printf UNAUTHORIZED\\r')")
    await pause(150)
    assert(!(await evaluate('fixture.input()')).includes('UNAUTHORIZED'), 'observation terminal sends no user commands')
    await evaluate('terminals.close(' + JSON.stringify(id) + ')')
    await wait('(await fixture.state()).status === "closed"', 'user close ends connection')
    assert.equal(await evaluate('terminals.getSnapshot().tabs.length'), 0)

    // The current framebuffer cannot be reconstructed from a truncated ANSI
    // tail or from plaintext rows: preserve cursor, SGR, modes and alt buffer.
    const shell = await evaluate('fixture.connect("shell")')
    await wait('frame()?.screen.includes("fixture>") && !terminals.sessions.get(terminals.getSnapshot().active)?.hydrating', 'shell observation ready')
    const paint = label => `printf '\\033[?7h%080000d' 0; printf '\\033[?1049h\\033[2J\\033[H\\033[31m${label}_TOP\\033[10;1H\\033[32mBOTTOM\\033[0m\\033[2;5H\\033[?1h\\033[?2004h\\033[?7l'\r`
    await evaluate('fixture.write(' + JSON.stringify(paint('RESTORE')) + ')')
    await wait('frame()?.screen.startsWith("RESTORE_TOP") && frame()?.screen.split("\\n")[1]?.includes("fixture>")', 'ANSI framebuffer after large output')
    assert((await evaluate('fixture.state()')).outputChars > 65_536)
    const expected = await evaluate('fixture.frame()')
    assert.equal(expected.type, 'alternate')
    assert.deepEqual(expected.top, { fg: 1, palette: true })
    assert.deepEqual(expected.bottom, { fg: 2, palette: true })
    assert.deepEqual(expected.modes, { applicationCursor: true, paste: true, wrap: false })
    await evaluate('resetStore()')
    await wait('frame()?.screen.startsWith("RESTORE_TOP") && !terminals.sessions.get(terminals.getSnapshot().active)?.hydrating', 'snapshot replay after renderer reconstruction')
    assert.deepEqual(await evaluate('frame()'), expected, 'reconstruction preserves geometry, cursor, styles, modes and alternate buffer')
    await evaluate('fixture.write("Z")')
    await wait('frame()?.screen.split("\\n")[1]?.includes("fixture> Z")', 'live output resumes at the restored cursor')
    assert.equal((await evaluate('frame()')).screen.split('\n')[9], 'BOTTOM', 'new output cannot overwrite the last restored row')
    assert.deepEqual(await evaluate('frame()'), await evaluate('fixture.frame()'))

    // Withhold parse acknowledgements until main drops an old batch, then
    // exercise the store's real cursor-gap hydration path while it is mounted.
    await evaluate(`(()=>{const session=terminals.sessions.get(terminals.getSnapshot().active);window.savedWrite=session.runtime.write.bind(session.runtime);session.runtime.write=data=>savedWrite(data,false);window.hydrations=0;const hydrate=terminals.hydrateSsh.bind(terminals);terminals.hydrateSsh=(...args)=>{hydrations++;return hydrate(...args)}})()`)
    const gapPaint = paint('GAP').replace('%080000d', '%0400000d')
    await evaluate('fixture.write(' + JSON.stringify('\u0015' + gapPaint) + ')')
    await wait('(await fixture.frame()).screen.startsWith("GAP_TOP") && (await fixture.frame()).screen.split("\\n")[1]?.includes("fixture>")', 'remote output completes while renderer delivery is stalled')
    await evaluate(`(()=>{terminals.sessions.get(terminals.getSnapshot().active).runtime.write=savedWrite;for(let i=0;i<4;i++)window.pi.sshAck(${JSON.stringify(shell.id)},65536)})()`)
    await wait('hydrations > 0 && frame()?.screen.startsWith("GAP_TOP") && !terminals.sessions.get(terminals.getSnapshot().active)?.hydrating', 'cursor gap hydrates a current ANSI snapshot')
    assert.deepEqual(await evaluate('frame()'), await evaluate('fixture.frame()'), 'backpressure recovery preserves terminal state')
    await evaluate('fixture.write("Q")')
    await wait('frame()?.screen.split("\\n")[1]?.includes("fixture> Q")', 'cursor after backpressure recovery')
    assert.equal((await evaluate('frame()')).screen.split('\n')[9], 'BOTTOM')
    await evaluate('terminals.close(' + JSON.stringify('ssh:' + shell.id) + ')')
    await wait('(await fixture.state()).status === "closed"', 'shell fixture closed')
    assert.deepEqual(exceptions, [])
    console.log('PASS: production SSH IPC/preload, pane retention, reconnect, observation-only input, ANSI snapshot reconstruction and cursor-gap recovery preserve cursor, colors, modes and alternate buffer.')
  }
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
