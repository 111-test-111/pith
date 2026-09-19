/**
 * The right rail's context pane in isolated Electron; no model calls, no user
 * data. Mounts the real `SidebarPanel` (its registry has to know the pane) with
 * a stubbed `window.pi.contextDetail`, and pins what the pane is for: the stat
 * grid shows every field at full precision, the breakdown bar's four segments
 * add up to the ring's total, the two honesty notes are there, no message body
 * is rendered anywhere, the readout follows the ring live, a failed refresh
 * keeps the numbers it already has, and the labels follow the locale.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-context-detail-ui-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__context-detail-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {SidebarPanel} from '/src/components/app/SidebarPanel.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const DETAIL={sessionId:'fixture',sessionPath:'/ui/session',title:'Context pane fixture session',cwd:'/ui',projectless:false,
 provider:'anthropic',model:'claude-sonnet-4-5',thinkingLevel:'high',createdAt:1781622135000,lastActivity:1781622255000,
 userMessages:1,assistantMessages:19,toolCalls:12,toolResults:12,totalMessages:32,
 tokens:{input:821,output:206,reasoning:503,cacheRead:52224,cacheWrite:0,total:53454},cost:1.2345,
 usage:{tokens:53754,contextWindow:200000,percent:26.877,sessionCost:1.2345,cacheHitRate:0.9301},
 breakdown:{user:108,assistant:2000,toolResults:20000,other:31646,total:53754}};
window.calls=[];window.failMode=false;
window.pi={contextDetail:()=>new Promise((res,rej)=>{window.calls.push({res,rej})})};
window.answer=()=>{const calls=window.calls.splice(0);for(const call of calls){if(window.failMode)call.rej(new Error('fixture failure'));else call.res(JSON.parse(JSON.stringify(DETAIL)))}};
const listeners=new Set();
let shell={sessionPath:'/ui/session',isStreaming:false,contextUsage:DETAIL.usage};
const store={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getShell:()=>shell};
window.pushShell=patch=>{shell=Object.assign({},shell,patch);for(const fn of listeners)fn()};
// The stub serves the same readout main would: pushing a new ring payload also
// moves what the next contextDetail call answers with.
window.moveRing=usage=>{DETAIL.usage=usage;DETAIL.cost=usage.sessionCost;window.pushShell({contextUsage:usage})};
const pane={files:{subscribeOpen:()=>()=>{},select:()=>{}},terminals:{},onNewTerminal:()=>{},onTerminalsEmpty:()=>{},
 store,reviewTurnId:null,sideChat:null,sideChatDraft:'',onSideChatDraftChange:()=>{},sideChatOnCurrentSession:true,onSideChatRebind:()=>{},agentRuns:new Map(),onOpenSessionInChat:()=>{}};
window.opened=[];
function Rail(props){return React.createElement(SidebarPanel,Object.assign({pane,
 onSelectTab:id=>window.opened.push('select:'+id),onOpenTab:kind=>window.opened.push('open:'+kind),
 onCloseTab:()=>{},onCloseOtherTabs:()=>{},onCloseAllTabs:()=>{}},props))}
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;
 return React.createElement(React.Fragment,null,
  React.createElement('div',{id:'rail-wrap',style:{width:420,height:900,display:'flex'}},
   React.createElement(Rail,{open:true,width:420,tabs:['context'],activeTab:'context'})),
  React.createElement('div',{id:'picker-wrap',style:{width:320,height:460,display:'flex'}},
   React.createElement(Rail,{open:true,width:320,tabs:[],activeTab:null})));}
window.checkRoot=createRoot(document.getElementById('root'));flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement(Fixture))));
window.press=node=>{node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',buttons:1}));node.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));node.click()};
window.stat=label=>{const cell=document.querySelector('#rail-wrap [data-context-stat="'+label+'"]');return cell?cell.querySelector('[data-context-stat-value]').textContent.trim():null};
window.stats=()=>[...document.querySelectorAll('#rail-wrap [data-context-stat]')].map(node=>[node.getAttribute('data-context-stat'),node.querySelector('[data-context-stat-value]').textContent.trim()]);
window.segments=()=>{const bar=document.querySelector('#rail-wrap [data-context-breakdown]');if(!bar)return null;const width=bar.getBoundingClientRect().width;
 return [...bar.querySelectorAll('[data-context-segment]')].map(node=>({key:node.getAttribute('data-context-segment'),ratio:node.getBoundingClientRect().width/width}))};
window.openPicker=()=>{const rows=[...document.querySelectorAll('#picker-wrap button')];window.press(rows.find(node=>node.textContent.trim().startsWith('Context')))};
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1400,height:1050,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
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
  for (let i = 0; i < 200; i++) { if (await evaluate(`!!document.querySelector('#rail-wrap [data-context-stat]') || !!document.querySelector('#rail-wrap [role=alert]')`)) break; await pause(50) }
  await evaluate(`document.fonts.ready`)
  await pause(200)

  // 1. The pane asks for the readout and paints NOTHING until it lands —
  //    the transitional "reading…" row is gone, so the fixture never answering
  //    leaves a silent pane. (The rail's own text is the tab strip's "Context"
  //    label; the pane content area itself must hold no row.)
  assert.equal(await evaluate(`window.calls.length`), 1, 'opening the tab reads the context once')
  assert.equal(
    await evaluate(`document.querySelectorAll('#rail-wrap [data-context-stat], #rail-wrap p, #rail-wrap button[aria-label="Retry"]').length`),
    0,
    'the pane paints no row before the readout arrives'
  )

  await evaluate('window.answer()')
  await pause(250)

  // 2. Every field of the DTO reaches the grid, at full precision: exact grouped
  //    counts (never `53.5k`), one decimal on the estimated percent, two on the
  //    cache rate and up to four on the cost.
  const stats = Object.fromEntries(await evaluate('window.stats()'))
  assert.equal(stats.Session, undefined, 'the session name row is gone')
  assert.equal(stats.Provider, 'anthropic')
  assert.equal(stats.Model, 'claude-sonnet-4-5')
  assert.equal(stats.Thinking, 'high')
  assert.equal(stats['Context limit'], '200,000', 'the window is the exact number')
  assert.equal(stats['Total tokens'], '53,454', 'and so is the cumulative billed total')
  assert.equal(stats.Usage, '26.9%', 'the estimated percent keeps one decimal')
  assert.equal(stats['Context tokens'], '~53,754', 'the live context size stays marked as an estimate')
  assert.equal(stats['Input tokens'], '821')
  assert.equal(stats['Output tokens'], '206')
  assert.equal(stats['Reasoning tokens'], '503')
  assert.equal(stats['Cache hit'], '93.01%', 'the cache rate keeps its second decimal')
  assert.equal(stats['Cached tokens (read / write)'], '52,224 / 0')
  assert.equal(stats['Total cost'], '$1.2345', 'the cost is not rounded away')
  assert.equal(stats.Usage, '26.9%')
  assert.equal(stats['User messages'], '1')
  assert.equal(stats['Assistant messages'], '19')
  assert.equal(stats['Tool calls'], '12')
  assert.equal(stats['Tool results'], '12')
  assert.equal(stats.Messages, '32')
  assert.notEqual(stats.Created, '—', 'the creation time is shown')
  assert.notEqual(stats['Last activity'], '—', 'and so is the last activity')

  // 3. Both honesty notes are on screen: what "cumulative" covers, and that the
  //    breakdown is an estimate whose residue is the system prompt.
  const notes = await evaluate(`[...document.querySelectorAll('#rail-wrap [data-context-note], #rail-wrap section p')].map(n=>n.textContent.trim())`)
  assert.ok(
    notes.some((note) => /whole session/.test(note)),
    'the cumulative note explains the counting basis: ' + JSON.stringify(notes)
  )
  assert.ok(
    notes.some((note) => /Estimated from message text/.test(note)),
    'the breakdown note explains the estimate: ' + JSON.stringify(notes)
  )

  // 4. No message body is rendered: the pane is statistics only.
  assert.equal(await evaluate(`!!document.querySelector('#rail-wrap pre')`), false, 'no raw message JSON in the rail')

  // 5. The breakdown bar is proportional and adds up to the ring's total: the
  //    four buckets are drawn, ordered, and fill the whole track.
  const segments = await evaluate('window.segments()')
  assert.deepEqual(segments.map((segment) => segment.key), ['user', 'assistant', 'toolResults', 'other'])
  const sum = segments.reduce((total, segment) => total + segment.ratio, 0)
  assert.ok(Math.abs(sum - 1) < 0.02, `the four segments fill the track: ${JSON.stringify(segments)}`)
  assert.ok(segments[0].ratio < segments[1].ratio && segments[1].ratio < segments[2].ratio, 'widths follow the bucket sizes')
  assert.ok(segments[3].ratio > segments[2].ratio, 'the system-and-residue bucket is the largest here')

  // 6. It follows the ring: main's 2s readout moving re-reads the pane, so the
  //    numbers here are never a snapshot of a session that has moved on.
  const callsBefore = await evaluate('window.calls.length')
  await evaluate(`window.moveRing({tokens:100000,contextWindow:200000,percent:50,sessionCost:2.5,cacheHitRate:0.5})`)
  await pause(150)
  assert.equal(await evaluate('window.calls.length'), callsBefore + 1, 'a new ring readout triggers exactly one re-read')
  await evaluate('window.answer()')
  await pause(250)
  assert.equal(await evaluate(`window.stat('Context tokens')`), '~100,000', 'the context size follows the ring')
  assert.equal(await evaluate(`window.stat('Usage')`), '50.0%')
  assert.equal(await evaluate(`window.stat('Cache hit')`), '50.00%')
  assert.equal(await evaluate(`window.stat('Total cost')`), '$2.50')

  // 7. A failed refresh keeps what the user is reading and says so above it.
  await evaluate('window.failMode=true')
  await evaluate(`window.press(document.querySelector('#rail-wrap button[aria-label="Refresh context details"]'))`)
  await evaluate('window.answer()')
  await pause(250)
  assert.equal(await evaluate(`!!document.querySelector('#rail-wrap [data-context-error]')`), true, 'a failed refresh is reported')
  assert.equal(await evaluate(`window.stat('Provider')`), 'anthropic', 'and the last good readout stays on screen')
  await evaluate('window.failMode=false')
  await evaluate(`window.press(document.querySelector('#rail-wrap [data-context-error] button'))`)
  await evaluate('window.answer()')
  await pause(250)
  assert.equal(await evaluate(`!!document.querySelector('#rail-wrap [data-context-error]')`), false, 'retrying clears the notice')

  // 8. The locale reaches every label, notes included.
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(150)
  const zh = await evaluate(`document.querySelector('#rail-wrap').textContent`)
  assert.match(zh, /上下文细分/, 'the breakdown heading is translated')
  assert.match(zh, /系统与其他/, 'and so is the residue bucket')
  assert.match(zh, /整个会话的累计值/, 'and the cumulative note')
  assert.equal(await evaluate(`window.stat('消息数')`), '32', 'the grid is translated too')
  await evaluate(`window.setLocale('en')`)
  await pause(150)

  // 9. The picker still lists the pane under its own label and open callback.
  await evaluate('window.openPicker()')
  await pause(100)
  assert.ok(
    (await evaluate('window.opened')).includes('open:context'),
    'the rail picker opens the context pane: ' + JSON.stringify(await evaluate('window.opened'))
  )

  assert.deepEqual(exceptions, [], 'no renderer exceptions: ' + JSON.stringify(exceptions.map((entry) => entry.exceptionDetails?.exception?.description)))
  console.log('PASS: context detail pane — full-precision stat grid, reconciled breakdown bar, both notes, no message bodies, live ring following, resilient refresh, picker registration and both locales.')
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
