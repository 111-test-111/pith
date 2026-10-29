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
contextBridge.exposeInMainWorld('fixture',{resends:()=>ipcRenderer.invoke('fixture:resends'),prompts:()=>ipcRenderer.invoke('fixture:prompts')});`)
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
 // The prompt route stays UNSETTLED while the renderer paints the user's row,
 // and the edit resend answers late and then confirms with the persisted
 // message — the window in which the transcript must show one row either way.
 const prompts=[];let promptSettled=false;
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000,startup:'resume'}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:listSessions',()=>[{id:'chat-0',path:'/fixture/chat-0',cwd:'/workspace/pi-app',projectless:false,label:'Layout review',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2}]);
 ipcMain.handle('pi:models',()=>[model]);ipcMain.handle('pi:providers',()=>[]);ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('files:search',(_,query)=>query.includes('notes')?[{path:'/workspace/pi-app/docs/notes.md',relPath:'docs/notes.md',name:'notes.md',dir:'docs',kind:'text',size:120,mtime:1}]:[]);
 ipcMain.handle('files:read',(_,path)=>({path,relPath:'docs/notes.md',kind:'text',truncated:false,size:120}));
 ipcMain.handle('pi:resendMessage',async(event,payload)=>{resends.push(payload);
  const blocks=(payload.files||[]).map(file=>{const p=String(file);const rel=p.charAt(0)==='/'?p.slice(1):p;return '<file path="'+rel+'"># notes</file>'}).join('\\n\\n');
  const content=blocks?payload.text+'\\n\\n'+blocks:payload.text;
  await new Promise(resolve=>setTimeout(resolve,400));
  // The rewrite arrives after main answers: the edit's own row must be on
  // screen meanwhile, then confirm in place.
  setTimeout(()=>event.sender.send('pi:event',{type:'message_end',sessionPath:'/fixture/chat-0',eventSequence:2,
    message:{role:'user',content,timestamp:Date.now()}}),250);
  return {...snapshot(),messages:[],eventSequence:1}});
 ipcMain.handle('pi:prompt',async(event,payload)=>{prompts.push(payload);await new Promise(resolve=>setTimeout(resolve,600));promptSettled=true;
  // The run the echo opened: agent_start takes the waiting row over, and the
  // later settle must release it again.
  event.sender.send('pi:event',{type:'agent_start',sessionPath:'/fixture/chat-0',eventSequence:5});
  setTimeout(()=>event.sender.send('pi:event',{type:'agent_settled',sessionPath:'/fixture/chat-0',eventSequence:6}),400);
  return {accepted:true}});
 ipcMain.handle('fixture:prompts',()=>({prompts,settled:promptSettled}));
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
  const paste = (selector, entries) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no target for paste');const dt=new DataTransfer();${entries}const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev);return el.value ?? el.textContent})()`)
  const PNG_FILE = `dt.items.add(new File([Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0))],'shot.png',{type:'image/png'}));`
  const TEXT_FILE = `dt.items.add(new File(['# notes'],'notes.md',{type:'text/markdown'}));`
  const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const checkImageGroup = async selector => {
    await paste(selector,PNG_FILE.replaceAll('shot.png','second.png'))
    await waitFor(`document.querySelector('img[alt="second.png"]')`)
    await evaluate(`(()=>{const button=document.querySelector('img[alt="second.png"]').closest('button');button.focus();button.click()})()`)
    await waitFor(`document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent==='2/2'`)
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37})
    await waitFor(`document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent==='1/2'`)
    assert.equal(await evaluate(`document.querySelector('[data-image-preview-navigation]').closest('[role=dialog]').getAttribute('aria-label')`),'shot.png')
    await evaluate(`document.querySelector('button[aria-label="Close preview"]').click()`)
    await waitFor(`!document.querySelector('[data-image-preview-navigation]')`)
    await evaluate(`document.querySelector('button[aria-label="Remove second.png"]').click()`)
  }
  await send('Runtime.enable')
  await waitFor(`document.querySelector('[data-prompt-editor]') && document.querySelector('[data-window-titlebar]')`)
  // The check drives labels, so pin the locale (the app otherwise follows the
  // machine's language).
  await evaluate(`localStorage.setItem('pi-app:locale','en');localStorage.setItem('theme','dark')`)
  await send('Page.reload')
  await pause(300)
  await waitFor(`document.querySelector('[data-prompt-editor]') && document.querySelector('[data-window-titlebar]')`)
  // A pasted File is named after itself on the chip: the thumbnail's `alt` and
  // the chip's remove label are how each surface proves it took the file.
  const dialogImage = '[role="dialog"] img[alt="shot.png"]'
  const dialogFile = '[role="dialog"] [aria-label="Remove docs/notes.md"]'

  // ---- the edit-message dialog --------------------------------------------
  await evaluate(`document.querySelector('button[aria-label="Edit and resend"]').click()`)
  await waitFor(`document.querySelector('[role="dialog"] textarea')`)
  assert.equal(await count('textarea, [data-prompt-editor]'), 2, 'the editor is its own field beside the composer')
  const drafted = await paste('[role="dialog"] textarea', PNG_FILE + TEXT_FILE)
  assert.equal(drafted, 'Please review the layout.', 'a file clipboard does not also paste as text')
  await waitFor(`document.querySelector(${JSON.stringify(dialogImage)})`)
  await pause(300)
  assert.equal(await count(dialogImage), 1, 'the pasted image is attached in the editor')
  assert.equal(await count(dialogFile), 1, 'the pasted file is attached in the editor')
  await shot('edit-dialog-paste')
  await checkImageGroup('[role="dialog"] textarea')
  assert.equal(await count('[role="dialog"] textarea'),1,'closing the nested image viewer preserves the edited message')
  // Retitle the draft so the swap is observable: the edited text must take the
  // old row's place without a gap.
  const editedText = 'Edited: review the new layout.'
  // Drive the controlled textarea through the native value setter so React
  // sees the change (its own value tracker otherwise swallows a direct write).
  await evaluate(`(()=>{
    const el=document.querySelector('[role="dialog"] textarea');
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(el,${JSON.stringify(editedText)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await pause(150)
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] textarea').value`), editedText, 'the editor holds the edited text')
  // Sample every frame across the swap: each frame carries exactly ONE user
  // row, holding either the old text or the edited one. A row that vanishes
  // until the SDK persists its replacement (or a duplicate echo) fails here.
  await evaluate(`window.swapFrames=[];window.recordSwap=true;window.sampleSwap=()=>{if(!window.recordSwap)return;
    window.swapFrames.push([...document.querySelectorAll('[data-slot="message"][data-from="user"]')].map(row=>row.textContent));
    requestAnimationFrame(window.sampleSwap)};requestAnimationFrame(window.sampleSwap)`)
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent.trim()==='Resend').click()`)
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  await waitFor(`document.querySelector('[data-slot="message"][data-from="user"]')?.textContent.includes(${JSON.stringify(editedText)})`)
  await pause(800)
  const swapFrames = await evaluate(`window.recordSwap=false;window.swapFrames`)
  assert.ok(swapFrames.length > 4, `the swap was sampled frame by frame (${swapFrames.length})`)
  const oldRows = swapFrames.filter(rows => rows.length === 1 && rows[0].includes('Please review the layout.'))
  const newRows = swapFrames.filter(rows => rows.length === 1 && rows[0].includes(editedText))
  assert.equal(oldRows.length + newRows.length, swapFrames.length,
    `every frame kept exactly one user row (${JSON.stringify(swapFrames.slice(0, 12))})`)
  assert.ok(oldRows.length > 0 && newRows.length > 0, 'the sampling spans both sides of the swap')
  // The persisted message_end confirms the echo: still one row, carrying the
  // edited text and the file chip its inlined blocks restored.
  const settledRows = await evaluate(`[...document.querySelectorAll('[data-slot="message"][data-from="user"]')].map(row=>row.textContent)`)
  assert.equal(settledRows.length, 1, `one user row after the persisted message (${JSON.stringify(settledRows)})`)
  assert.ok(settledRows[0].includes(editedText), `the settled row carries the edited text (${JSON.stringify(settledRows)})`)
  const resends = await evaluate('fixture.resends()')
  assert.equal(resends.length, 1, 'resend reached main')
  assert.equal(resends[0].text, editedText, 'the edit, not the original, rides the resend')
  assert.equal(resends[0].images.length, 1, 'the pasted image rides the resend')
  assert.equal(resends[0].images[0].mimeType, 'image/png')
  assert.deepEqual(resends[0].files, ['/workspace/pi-app/docs/notes.md'], 'the pasted file rides the resend as a path')

  // ---- the composer (unchanged behaviour, same shared intake) --------------
  const composer = 'main [data-prompt-editor]'
  const composerDraft = await paste(composer, PNG_FILE + TEXT_FILE)
  assert.equal(composerDraft, '', 'the composer swallows the file paste too')
  await waitFor(`document.querySelector('img[alt="shot.png"]')`)
  await pause(300)
  assert.equal(await count('img[alt="shot.png"]'), 1, 'the composer attaches a pasted image')
  assert.equal(await count('[aria-label="Remove docs/notes.md"]'), 1, 'the composer attaches a pasted file')
  await shot('composer-paste')
  await checkImageGroup(composer)
  // Text-only pastes still belong to the textarea.
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(composer)});const dt=new DataTransfer();dt.setData('text/plain','hello');const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev)})()`)
  await pause(200)
  assert.equal(await count('img[alt="hello"]'), 0, 'a text paste adds no attachment')

  // ---- the outgoing prompt does not wait for main's round trip -------------
  // The user's own row must be on screen while the prompt IPC is still
  // unsettled, and the composer must empty in the same stroke.
  const composerEditor = 'main [data-prompt-editor]'
  const sentText = 'Send this immediately'
  await evaluate(`document.querySelector(${JSON.stringify(composerEditor)}).focus()`)
  await send('Input.insertText', { text: sentText })
  await pause(120)
  // Sample every frame across the send: the waiting row (spinner + sentence)
  // belongs to the echo's own commit, so no frame may show the sent row
  // without it — a spinner that trails the bubble by an IPC round trip is the
  // regression this covers.
  await evaluate(`window.sendFrames=[];window.recordSend=true;window.sampleSend=()=>{if(!window.recordSend)return;
    const user=[...document.querySelectorAll('[data-slot="message"][data-from="user"]')].pop();
    const spin=document.querySelector('[data-spinner-loader]');
    const viewport=document.querySelector('[data-slot="message-scroller"] section');
    window.sendFrames.push({bubble:!!user&&user.textContent.includes(${JSON.stringify(sentText)}),
      status:!!spin,actions:!!user?.querySelector('[data-message-actions]'),
      userH:user?Math.round(user.getBoundingClientRect().height):null,spinH:spin?Math.round(spin.getBoundingClientRect().height):null,
      spinTop:spin&&viewport?spin.getBoundingClientRect().top-viewport.getBoundingClientRect().top:null});
    requestAnimationFrame(window.sampleSend)};requestAnimationFrame(window.sampleSend)`)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await waitFor(`[...document.querySelectorAll('[data-slot="message"][data-from="user"]')].some(row=>row.textContent.includes(${JSON.stringify(sentText)}))`)
  assert.equal(await evaluate(`fixture.prompts().then(state=>state.settled)`), false, 'the row lands before main accepts the prompt')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(composerEditor)}).textContent`), '', 'the composer empties immediately')
  // Keep recording through agent_start: it must not remove a temporary user
  // action row and pull the already-visible spinner upward.
  await waitFor(`fixture.prompts().then(state=>state.settled && state.prompts.some(p=>p.text===${JSON.stringify(sentText)}))`)
  await pause(100)
  const sendFrames = await evaluate(`window.recordSend=false;window.sendFrames`)
  const withBubble = sendFrames.filter((frame) => frame.bubble)
  assert.ok(withBubble.length > 0, 'the send was sampled frame by frame: ' + JSON.stringify(sendFrames.slice(0, 8)))
  assert.ok(
    withBubble.every((frame) => frame.status),
    'the waiting row appears with the sent row, never a frame later: ' + JSON.stringify(sendFrames.slice(0, 8))
  )
  assert.ok(
    sendFrames.filter((frame) => frame.status).every((frame) => frame.bubble),
    'and the spinner never leads the sent row: ' + JSON.stringify(sendFrames.slice(0, 8))
  )
  // Both boxes are their real size in the very frame they appear: a tail row
  // laid out as the `content-visibility` placeholder was painted 400px tall,
  // far below the fold, and snapped back one frame later.
  const settledUser = sendFrames.filter((frame) => frame.userH).at(-1)?.userH ?? 0
  const settledSpin = sendFrames.filter((frame) => frame.spinH).at(-1)?.spinH ?? 0
  assert.ok(
    sendFrames.every((frame) => !frame.userH || frame.userH <= settledUser + 1),
    'the sent row keeps its real height from its first frame: ' + JSON.stringify(sendFrames.slice(0, 8))
  )
  assert.ok(
    sendFrames.every((frame) => !frame.spinH || frame.spinH <= settledSpin + 1),
    'and so does the waiting row: ' + JSON.stringify(sendFrames.slice(0, 8))
  )
  const waitingFrames = withBubble.filter((frame) => frame.status)
  const restingTop = waitingFrames.at(-1).spinTop
  assert.ok(
    waitingFrames.every((frame) => Math.abs(frame.spinTop - restingTop) <= 1),
    'the spinner keeps its position from the echoed prompt through agent_start: ' + JSON.stringify(waitingFrames)
  )
  assert.ok(waitingFrames.every((frame) => !frame.actions), 'a pending prompt has no temporary action row')
  // The announced run keeps the same row (no gap, no remount), and settling
  // releases it — the echo's flag must not spin forever.
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-spinner-loader]'))`), true, 'the announced run keeps the waiting row')
  await waitFor(`!document.querySelector('[data-spinner-loader]')`)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-slot="message"][data-from="user"]')].at(-1).querySelector('[data-message-actions]') !== null`), true, 'settlement restores the sent message actions')
  assert.deepEqual(exceptions, [])
  console.log('PASS: edit-dialog and composer attachment intake, immediate sent rows and stable waiting-row position through run admission')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
