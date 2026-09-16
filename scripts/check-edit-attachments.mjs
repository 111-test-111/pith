/** Attachment intake in the edit-message dialog and the composer, in isolated
 * Electron against a synthetic session. Run after build.
 * PI_EDIT_ATTACHMENTS_SCREENSHOT_DIR retains the screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-attach-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
/** A real 1×1 PNG, so the thumbnail behind each chip actually decodes. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let child, ws
try {
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('fixture',{resends:()=>ipcRenderer.invoke('fixture:resends')});`)
  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
import {windowChromeOptions} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const model={providerId:'deepseek',providerName:'DeepSeek',id:'fixture',name:'DeepSeek V4.1 Flash',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const message={role:'user',content:'Please review the layout.',timestamp:1};
 const snapshot=()=>({sessionId:'fixture',sessionPath:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,messages:[message],model,thinkingLevel:'high',availableThinkingLevels:['off','high'],isStreaming:false});
 const resends=[];
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[{id:'chat-0',path:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,label:'Layout review',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}]);
 ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('pi:providers',()=>[]);ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('files:search',(_,query)=>query.includes('notes')?[{path:'/workspace/pi-app/docs/notes.md',relPath:'docs/notes.md',name:'notes.md',dir:'docs',kind:'text',size:120,mtime:1}]:[]);
 ipcMain.handle('files:read',(_,path)=>({path,relPath:'docs/notes.md',kind:'text',truncated:false,size:120}));
 ipcMain.handle('pi:resendMessage',(_,payload)=>{resends.push(payload);return snapshot()});
 ipcMain.handle('fixture:resends',()=>resends);
 const w=new BrowserWindow({...windowChromeOptions(),width:1200,height:840,minWidth:760,minHeight:560,title:'Pith · Attachments check',backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
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
  const shot = async name => {
    if (!process.env.PI_EDIT_ATTACHMENTS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_EDIT_ATTACHMENTS_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_EDIT_ATTACHMENTS_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  /** Dispatch a real `paste` carrying files — the only way to prove the two
   * surfaces read `clipboardData` rather than a picker's `change`. */
  const paste = (selector, entries) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no target for paste');const dt=new DataTransfer();${entries}const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev);return el.value})()`)
  const PNG_FILE = `dt.items.add(new File([Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0))],'shot.png',{type:'image/png'}));`
  const TEXT_FILE = `dt.items.add(new File(['# notes'],'notes.md',{type:'text/markdown'}));`
  const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  await send('Runtime.enable')
  await waitFor(`document.querySelector('textarea') && document.querySelector('[data-window-titlebar]')`)
  // The check drives labels, so pin the locale (the app otherwise follows the
  // machine's language).
  await evaluate(`localStorage.setItem('pi-app:locale','en');localStorage.setItem('theme','dark')`)
  await send('Page.reload')
  await pause(300)
  await waitFor(`document.querySelector('textarea') && document.querySelector('[data-window-titlebar]')`)
  // A pasted File is named after itself on the chip: the thumbnail's `alt` and
  // the chip's remove label are how each surface proves it took the file.
  const dialogImage = '[role="dialog"] img[alt="shot.png"]'
  const dialogFile = '[role="dialog"] [aria-label="Remove docs/notes.md"]'

  // ---- the edit-message dialog --------------------------------------------
  await evaluate(`document.querySelector('button[aria-label="Edit and resend"]').click()`)
  await waitFor(`document.querySelector('[role="dialog"] textarea')`)
  assert.equal(await count('textarea'), 2, 'the editor is its own field beside the composer')
  const drafted = await paste('[role="dialog"] textarea', PNG_FILE + TEXT_FILE)
  assert.equal(drafted, 'Please review the layout.', 'a file clipboard does not also paste as text')
  await waitFor(`document.querySelector(${JSON.stringify(dialogImage)})`)
  await pause(300)
  assert.equal(await count(dialogImage), 1, 'the pasted image is attached in the editor')
  assert.equal(await count(dialogFile), 1, 'the pasted file is attached in the editor')
  await shot('edit-dialog-paste')
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent.trim()==='Resend').click()`)
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  const resends = await evaluate('fixture.resends()')
  assert.equal(resends.length, 1, 'resend reached main')
  assert.equal(resends[0].images.length, 1, 'the pasted image rides the resend')
  assert.equal(resends[0].images[0].mimeType, 'image/png')
  assert.deepEqual(resends[0].files, ['/workspace/pi-app/docs/notes.md'], 'the pasted file rides the resend as a path')

  // ---- the composer (unchanged behaviour, same shared intake) --------------
  const composer = 'main textarea'
  const composerDraft = await paste(composer, PNG_FILE + TEXT_FILE)
  assert.equal(composerDraft, '', 'the composer swallows the file paste too')
  await waitFor(`document.querySelector('img[alt="shot.png"]')`)
  await pause(300)
  assert.equal(await count('img[alt="shot.png"]'), 1, 'the composer attaches a pasted image')
  assert.equal(await count('[aria-label="Remove docs/notes.md"]'), 1, 'the composer attaches a pasted file')
  await shot('composer-paste')
  // Text-only pastes still belong to the textarea.
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(composer)});const dt=new DataTransfer();dt.setData('text/plain','hello');const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev)})()`)
  await pause(200)
  assert.equal(await count('img[alt="hello"]'), 0, 'a text paste adds no attachment')
  assert.deepEqual(exceptions, [])
  console.log('PASS: edit-dialog and composer attachment intake (pasted image + file, text untouched, resend payload)')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
