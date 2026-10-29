/**
 * Transcript row-width regression check — an expanded edit/write diff keeps its
 * own horizontal scrollport, whether the turn is streaming or settled.
 *
 * `MessageContent` is a START-aligned flex column, so a row with `width: auto`
 * takes its `fit-content` size, whose floor is the row's own min-content — for
 * a diff that is the widest `whitespace-pre` line. Without a width the row (and
 * the diff's `overflow-auto` viewport inside it) grew to the diff's full width,
 * which left the viewport with `scrollWidth === clientWidth` (nothing to scroll)
 * while the transcript column's `overflow-x-clip` cut the rest away: the reader
 * could not reach the right-hand side of a long line. `TRANSCRIPT_ROW_WIDTH`
 * makes the row a full-width flex item instead, so the overflow stays in the
 * diff's own scrollport.
 *
 * Real `ChatView` in isolated Electron against a stubbed `window.pi`; no SDK, no
 * model calls. Run after building:
 *   node scripts/check-transcript-row-width.mjs
 * `PI_TRANSCRIPT_ROW_WIDTH_SCREENSHOT_DIR` retains the wide-diff screenshots.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pi-row-width-'))
const fixturePath = '/__transcript_row_width_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import '/src/styles.css';

if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale','en');
window.pi = {
  onBashTask: () => () => {},
  listBashTasks: async () => [],
  bashTaskOutput: async () => ({task:null,output:'',cursor:0,truncated:false}),
  stopBashTask: async () => null,
  appInfo: async () => ({version:'fixture'}),
  openExternal: async () => {}
};
// One unbroken 700-column line: the diff's min-content width.
const LONG = 'const value = ' + 'abcdefghij'.repeat(70) + ';';
window.store = new PiStore();
window.seq = 0;
window.snapshot = (messages, isStreaming) => ({sessionId:'s',sessionPath:'/ui/s',cwd:'/ui',projectless:false,messages,model:null,thinkingLevel:'off',isStreaming,activeChangeScopeId:'scope-a',eventSequence:++window.seq});
const user = {role:'user', timestamp:10, content:'write the wide files'};
const writeCall = (id, path) => ({type:'toolCall', name:'write', id, arguments:{path, content: LONG + '\\n'}});
const round = (stamp, calls) => ({role:'assistant', timestamp:stamp, content:calls, changeScopeId:'scope-a', stopReason:'toolUse'});
const result = (id, stamp) => ({role:'toolResult', toolCallId:id, toolName:'write', timestamp:stamp, content:[], isError:false});
window.messagesFor = (kind) => kind === 'group'
  // Two adjacent single-call rounds of the same category: the plan folds them
  // into ONE group row whose own wrapper has to constrain them too.
  ? [user, round(20, [writeCall('g1','/ui/wide-a.ts')]), result('g1',21), round(22, [writeCall('g2','/ui/wide-b.ts')]), result('g2',23)]
  : [user, round(20, [writeCall('w1','/ui/wide.ts')]), result('w1',21)];
window.apply = (kind, streaming) => {
  window.messages = window.messagesFor(kind);
  flushSync(()=>window.store.applySnapshot(window.snapshot(window.messages, streaming)));
};
// A streaming update: another round lands while the turn stays live.
window.streamOnce = () => {
  window.messages = [...window.messages, {role:'assistant', timestamp:40 + window.messages.length, content:[{type:'text',text:'still working '.repeat(20)}], changeScopeId:'scope-a', stopReason:'stop'}];
  flushSync(()=>window.store.applySnapshot(window.snapshot(window.messages, true)));
};
window.settle = () => flushSync(()=>window.store.applySnapshot(window.snapshot(window.messages, false)));
window.expandEverything = () => {
  for (let pass = 0; pass < 8; pass++) {
    const collapsed = [...document.querySelectorAll('#turn [aria-expanded="false"]')];
    if (!collapsed.length) break;
    collapsed.forEach((trigger) => trigger.click());
  }
};
window.viewport = () => document.querySelector('[data-slot="file-diff-viewport"]');
window.read = () => {
  const v = window.viewport();
  if (!v) return null;
  const column = document.querySelector('#turn .max-w-3xl');
  let widest = 0;
  for (let el = v; el && el !== document.body && el !== column; el = el.parentElement) {
    widest = Math.max(widest, el.getBoundingClientRect().width);
  }
  return {
    scrollWidth: v.scrollWidth, clientWidth: v.clientWidth, scrollLeft: v.scrollLeft,
    columnWidth: column ? Math.round(column.getBoundingClientRect().width) : null,
    contentWidth: Math.round(document.querySelector('#turn [data-slot="message-content"]').getBoundingClientRect().width),
    widestAncestor: Math.round(widest),
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth
  };
};
window.apply('single', true);

function Fixture(){
  const {setLocale} = useI18n();
  window.setLocale = setLocale;
  return React.createElement(ImagePreviewProvider,null,
    React.createElement('div',{id:'turn',style:{height:900,display:'flex',flexDirection:'column'}},
      React.createElement(ChatView,{store:window.store,onDismissError:()=>{},onResend:()=>{},onEditMessage:()=>{},onRewindMessage:()=>{},onFork:()=>{},onReview:()=>{}})));
}
flushSync(()=>createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture))));
window.fixtureReady = true;
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:900,title:'Transcript row width',show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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
  for (let i = 0; i < 200; i++) { if (await evaluate('!!document.querySelector("#turn [data-slot=message-content]")')) break; await pause(50) }
  await pause(300)

  const shot = async (name) => {
    if (!process.env.PI_TRANSCRIPT_ROW_WIDTH_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_TRANSCRIPT_ROW_WIDTH_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_TRANSCRIPT_ROW_WIDTH_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  const openDiff = async () => {
    await evaluate('window.expandEverything()')
    await pause(400)
    assert.ok(await evaluate('!!window.viewport()'), 'the diff body mounts once its disclosures are open')
  }
  /** No ancestor between the diff and the column may exceed the column, and the
   *  diff's own scrollport must be the one holding the overflow. */
  const assertContained = (label) => async () => {
    const read = await evaluate('JSON.stringify(window.read())')
    const state = JSON.parse(read)
    assert.ok(state.scrollWidth > state.clientWidth + 100, label + ': the diff really overflows: ' + read)
    assert.ok(state.clientWidth < state.columnWidth, label + ': the diff viewport is the column\'s width, not the content\'s: ' + read)
    assert.ok(state.widestAncestor <= state.columnWidth + 1, label + ': no row ancestor is wider than the column: ' + read)
    assert.equal(state.contentWidth, state.columnWidth, label + ': the message column keeps the column width: ' + read)
    assert.ok(state.pageOverflow <= 0, label + ': the wide diff never widens the page: ' + read)
    return state
  }

  // 1. Streaming turn, one completed edit row, expanded while the run continues.
  await openDiff()
  const streaming = await assertContained('streaming single row')()
  const box = await evaluate(`(()=>{const r=window.viewport().getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  // A real horizontal wheel over the diff body reaches its own scrollport.
  await evaluate('window.viewport().scrollLeft = 0')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 180, deltaY: 0, pointerType: 'mouse' })
  await pause(250)
  const wheeled = await evaluate('window.viewport().scrollLeft')
  assert.ok(wheeled > 0, 'a horizontal wheel over the diff scrolls it: ' + wheeled)
  await shot('streaming-wide-diff')
  // The reader's position survives the stream's own re-renders (and its
  // auto-pin to the bottom of the diff body).
  await evaluate('window.viewport().scrollLeft = 220')
  await evaluate('window.streamOnce()')
  await pause(250)
  assert.equal(await evaluate('window.viewport().scrollLeft'), 220, 'a streaming update does not reset the horizontal position')
  await assertContained('streaming single row, after an update')()

  // 2. The same row inside a folded group row (two adjacent writes).
  await evaluate(`window.apply('group', true)`)
  await pause(300)
  await openDiff()
  const grouped = await assertContained('streaming group row')()
  assert.ok(await evaluate(`document.querySelectorAll('#turn [data-slot="file-diff-viewport"]').length >= 1`), 'the group row reveals its own diff rows')
  await shot('streaming-group-wide-diff')
  assert.ok(grouped.clientWidth < grouped.columnWidth, 'the grouped diff is constrained too')

  // 3. The settled fold keeps the same containment (its own wrapper is `w-full`).
  await evaluate('window.settle()')
  await pause(350)
  await openDiff()
  await assertContained('settled fold')()
  await shot('settled-wide-diff')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('transcript row width check ok: ' + JSON.stringify({ streaming, grouped }))
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
