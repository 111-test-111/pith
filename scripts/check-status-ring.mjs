/**
 * Real Chromium regression check for the app's status rings.
 * Run: node scripts/check-status-ring.mjs
 *
 * The small circle at the right of a tool row — and of every row in the task
 * strip (background tasks, Q&A records, subagents) — must be a PURE CIRCLE in
 * both interface styles. It used to come from the icon pack table, so the
 * square pack answered `CircleCheck` with Carbon's square `CheckboxChecked` and
 * `Ban` with `SquareSlash`: the same row read as a checkbox in 直角 mode and as
 * a circle in 圆角 mode.
 *
 * This check renders the real surfaces under both packs and asserts:
 *
 *   geometry     every mark is an r=9 circle in the 24 box, with the right
 *                inner mark per status (waiting / done / failed / cancelled)
 *   style-proof  the four marks are byte-identical across the two packs, in the
 *                transcript rows AND in the Q&A and background-task panels
 *   motion       the waiting arc spins, and holds still under reduced motion
 *   untouched    a Settings control still follows the pack (it is not a ring)
 *
 * Uses an isolated Electron profile and fixture data; no SDK, real sessions,
 * model calls or test framework. Requires a graphical session.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pi-status-ring-'))
const fixturePath = '/__status_ring_check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToolResult} from '/src/components/agents/tool-result.tsx';
import {AskUserRecordList} from '/src/components/app/AskUserRecordList.tsx';
import {BashTaskList} from '/src/components/app/BashTaskView.tsx';
import {Checkbox} from '/src/components/motion/checkbox.tsx';
import {IconPackProvider} from '/src/lib/icon-pack.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';
const now = Date.now();
const STATUSES = ['running','success','error','cancelled'];
const records = [
  {toolCallId:'q-open',status:'pending',questions:[{question:'Still waiting?'}],answers:null,at:now},
  {toolCallId:'q-done',status:'answered',questions:[{question:'Which one?'}],answers:[{question:'Which one?',selected:['A']}],at:now},
  {toolCallId:'q-dismissed',status:'cancelled',reason:'dismissed',questions:[{question:'Dismissed?'}],answers:null,at:now}
];
const task = (id,status) => ({id,sessionId:'s1',sessionPath:'/fixture/session.jsonl',toolCallId:'call-'+id,
  command:'echo '+id,cwd:'/fixture',status,background:true,reason:'requested',startedAt:now-1000,
  ...(status === 'running' ? {} : {endedAt:now-500,exitCode:status === 'succeeded' ? 0 : 1}),
  outputChars:12,logPath:'/tmp/'+id+'.log',logTruncated:false});
const tasks = ['running','succeeded','failed','cancelled'].map((status,index) => task('t'+index,status));
const section = (pack) => React.createElement('section',{id:'pack-'+pack,'data-pack':pack},
  React.createElement(IconPackProvider,{pack},
    React.createElement('div',{id:'rows-'+pack,'data-surface':'rows'},
      STATUSES.map(status => React.createElement(ToolResult,{key:status,status,title:'tool · '+status,animateChanges:false,collapseOnComplete:false}))),
    React.createElement('div',{id:'qa-'+pack,'data-surface':'qa'},
      React.createElement(AskUserRecordList,{records})),
    React.createElement('div',{id:'bash-'+pack,'data-surface':'bash'},
      React.createElement(BashTaskList,{tasks})),
    React.createElement('div',{id:'control-'+pack,'data-surface':'control'},
      React.createElement(Checkbox,{checked:true,onCheckedChange:()=>{},'aria-label':'a settings control'}))));
window.checkRoot = createRoot(document.getElementById('root'));
window.renderFixture = () => window.checkRoot.render(React.createElement(I18nProvider,null,
  React.createElement('div',{id:'fixture',style:{width:720,margin:'24px auto'}},
    section('carbon'),section('hugeicons'))));
window.renderFixture();
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
const pause = ms => new Promise(r => setTimeout(r, ms))
const log = message => console.log('[status-ring] ' + message)
let watchdog = setTimeout(() => {
  console.error('[status-ring] TIMEOUT — the check did not finish; see the log above')
  process.exit(3)
}, 120000)
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'status-ring-fixture', configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== fixturePath) return next()
          try {
            res.setHeader('Content-Type', 'text/html')
            res.end(await server.transformIndexHtml(fixturePath, fixture))
          } catch (error) { next(error) }
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  log('vite ready')
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
// Chromium's own sandbox cannot start a renderer in every host (a headless or
// restricted session answers the debugger but never serves the Runtime domain),
// so the fixture window runs un-sandboxed: it loads a local vite fixture and
// touches no credentials. Harmless where the sandbox does work.
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:1000,title:'Status ring regression',webPreferences:{backgroundThrottling:false,sandbox:false}});w.loadURL(${JSON.stringify(url)});});
app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  let sequence = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, m => m.error ? reject(m.error) : resolve(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const ready = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(`!!window.fixtureReady && document.querySelectorAll('[data-surface]').length === 8`)) return
      await pause(50)
    }
    throw new Error('fixture never rendered')
  }
  await ready()
  log('fixture ready')

  if (process.env.PI_STATUS_RING_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_STATUS_RING_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_STATUS_RING_SCREENSHOT_DIR, 'status-rings.png'), Buffer.from(capture.data, 'base64'))
  }

  /** Every status mark inside one surface, reduced to the facts that matter. */
  const marks = id => evaluate(`(()=>[...document.querySelectorAll('#${id} [data-status-ring]')].map(svg => {
    const ring=svg.querySelector('circle');
    return {status:svg.dataset.statusRing, viewBox:svg.getAttribute('viewBox'), html:svg.outerHTML,
      ring:[ring.getAttribute('cx'),ring.getAttribute('cy'),ring.getAttribute('r'),ring.getAttribute('stroke-width')].join(' '),
      dash:ring.getAttribute('stroke-dasharray'),
      shapes:[...svg.querySelectorAll('path,rect,polygon,line')].length,
      spin:svg.classList.contains('animate-spin')}}))()`)

  const PURITY = '12 12 9 1.5'

  // 1. The transcript's tool rows: four states, four pure circles.
  const rows = await marks('rows-carbon')
  assert.deepEqual(rows.map(mark => mark.status), ['running', 'success', 'error', 'cancelled'], 'a row per state')
  for (const mark of rows) {
    assert.equal(mark.viewBox, '0 0 24 24', mark.status + ': the mark draws in the shared 24 box')
    assert.equal(mark.ring, PURITY, mark.status + ': the ring is a 12,12 r=9 circle at 1.5 stroke')
  }
  const [running, success, error, cancelled] = rows
  assert.equal(running.dash, '0.75 0.25', 'waiting is the task strip\'s 3/4 arc')
  assert.equal(running.shapes, 0, 'waiting draws no inner mark')
  assert.equal(success.shapes, 1, 'done draws one check')
  assert.equal(error.shapes, 2, 'failed draws the two cancel strokes')
  assert.equal(cancelled.shapes, 1, 'cancelled draws one slash')
  assert.match(cancelled.html, /M5\.64 5\.64 18\.36 18\.36/, 'the cancel slash ends on the ring')
  assert.equal(running.spin, true, 'waiting spins')
  assert.deepEqual([success.spin, error.spin, cancelled.spin], [false, false, false], 'settled marks never spin')

  // 2. The task strip's own rows: background tasks and Q&A records.
  // Both panels render newest first, so the row order is theirs — this check
  // owns the marks, not the ordering.
  const bash = await marks('bash-carbon')
  assert.deepEqual(bash.map(mark => mark.status).sort(), ['cancelled', 'error', 'running', 'success'],
    'a background task row per state')
  const qa = await marks('qa-carbon')
  assert.deepEqual(qa.map(mark => mark.status).sort(), ['cancelled', 'running', 'success'],
    'Q&A records: awaiting, answered, cancelled')
  for (const mark of [...bash, ...qa]) {
    assert.equal(mark.ring, PURITY, mark.status + ' (' + mark.viewBox + '): a task-strip ring is the same circle')
  }

  // 3. The point of the whole change: the pack cannot reach these marks.
  for (const surface of ['rows', 'qa', 'bash']) {
    const square = await marks(surface + '-carbon')
    const squircle = await marks(surface + '-hugeicons')
    assert.equal(square.length, squircle.length, surface + ': the same marks in both packs')
    assert.deepEqual(squircle.map(mark => mark.html), square.map(mark => mark.html),
      surface + ': the marks are byte-identical under the square and squircle packs')
  }
  log('four statuses are pure circles, identical in both styles, in all three surfaces')

  // 4. Settings controls still follow the pack — a status ring is an exception,
  //    not a change to the icon layer.
  const control = await evaluate(`(()=>{
    const square=document.querySelector('#control-carbon [data-checkbox-mark]');
    const squircle=document.querySelector('#control-hugeicons [data-checkbox-mark]');
    return {rings:document.querySelectorAll('#control-carbon [data-status-ring]').length,
      square:square?.outerHTML ?? null, squircle:squircle?.outerHTML ?? null}})()`)
  assert.equal(control.rings, 0, 'a settings control holds no status ring')
  assert.ok(control.square && control.squircle, 'the control draws its own mark')
  assert.notEqual(control.square, control.squircle, 'the control still follows the icon pack')

  // 5. Reduced motion: the arc holds still, the geometry does not change.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('location.reload()')
  await pause(200)
  await ready()
  const still = await marks('rows-carbon')
  assert.deepEqual(still.map(mark => mark.spin), [false, false, false, false], 'no mark spins under reduced motion')
  assert.deepEqual(still.map(mark => mark.ring), [PURITY, PURITY, PURITY, PURITY], 'reduced motion keeps the circles')
  assert.equal(still[0].dash, '0.75 0.25', 'the waiting arc stays an arc, it just stops')
  const stillPacks = await marks('rows-hugeicons')
  assert.deepEqual(stillPacks.map(mark => mark.html), still.map(mark => mark.html), 'still identical across packs')
  await evaluate('window.checkRoot.unmount()')
  log('waiting spins, holds still under reduced motion, and the pack never reaches a ring')
} finally {
  clearTimeout(watchdog)
  ws?.close()
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
