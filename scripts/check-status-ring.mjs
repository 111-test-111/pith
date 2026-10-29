/**
 * Real Chromium regression check for the app's status marks.
 * Run: node scripts/check-status-ring.mjs
 *
 * The small circle at the right of a tool row — and of every row in the task
 * strip (background tasks, Q&A records, subagents) — is one mark per outcome.
 * A settled row draws the active family's success / error / cancellation marks through
 * the icon adapter, and only the waiting row is drawn app-side in
 * `lib/status-ring.tsx`, because no glyph carries the spinning 3/4 arc. The task
 * panel's rows split the same way: awaiting uses the pack's dashed circle,
 * while moving arcs stay app geometry and draw-in marks use pack artwork.
 *
 * This check renders the real surfaces and asserts:
 *
 *   geometry     the waiting arc is an r=9 circle at 1.5 stroke in the 24 box,
 *                and settled glyphs keep Hugeicons' native r=10 success/error
 *                and r=9 cancellation rings in that same box at 1.5 stroke
 *
 *   family       settled marks ARE adapter glyphs (`data-app-icon`) and waiting
 *                arcs are not — one owner per mark, no second drawing
 *   statuses     the right mark per status across the transcript, the task strip
 *                and the todo panel (waiting / done / failed / cancelled)
 *   motion       the waiting arcs spin, and hold still under reduced motion
 *   untouched    a Settings control draws its own mark (it is not a status mark)
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
import {TodoList} from '/src/components/agents/todo-list.tsx';
import {AskUserRecordList} from '/src/components/app/AskUserRecordList.tsx';
import {BashTaskList} from '/src/components/app/BashTaskView.tsx';
import {Checkbox} from '/src/components/motion/checkbox.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {setUiStyle} from '/src/lib/ui-style.ts';
import '/src/styles.css';
window.setUiStyle=setUiStyle;
setUiStyle('squircle');
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
const todos = [
  {id:'t-pending',title:'Awaiting',status:'pending'},
  {id:'t-running',title:'Running',status:'in-progress'},
  {id:'t-done',title:'Done',status:'completed'},
  {id:'t-dropped',title:'Dropped',status:'cancelled'}
];
window.checkRoot = createRoot(document.getElementById('root'));
window.renderFixture = () => window.checkRoot.render(React.createElement(I18nProvider,null,
  React.createElement('div',{id:'fixture',style:{width:720,margin:'24px auto'}},
    React.createElement('section',{id:'main'},
      React.createElement('div',{id:'rows','data-surface':'rows'},
        STATUSES.map(status => React.createElement(ToolResult,{key:status,status,title:'tool · '+status,animateChanges:false,collapseOnComplete:false}))),
      React.createElement('div',{id:'qa','data-surface':'qa'},
        React.createElement(AskUserRecordList,{records})),
      React.createElement('div',{id:'bash','data-surface':'bash'},
        React.createElement(BashTaskList,{tasks})),
      React.createElement('div',{id:'todo','data-surface':'todo'},
        React.createElement(TodoList,{items:todos,title:'To-dos',defaultOpen:true,collapseOnComplete:false})),
      React.createElement('div',{id:'control','data-surface':'control'},
        React.createElement(Checkbox,{checked:true,onCheckedChange:()=>{},'aria-label':'a settings control'}))))));
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
app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:1300,title:'Status ring regression',webPreferences:{backgroundThrottling:false,sandbox:false}});w.loadURL(${JSON.stringify(url)});});
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
      if (await evaluate(`!!window.fixtureReady && document.querySelectorAll('[data-surface]').length === 5`)) return
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

  /**
   * Every status mark inside one surface, reduced to the facts that matter. A
   * settled mark is an adapter glyph (one Hugeicons drawing on the family's 24 grid,
   * no circle element); a waiting mark is the drawn 24-box 3/4 arc. `box` is the
   * mark's own user-space box and `side` that box rendered into the 24 box, so
   * both owners can be measured against the one circle they draw.
   */
  const marks = id => evaluate(`(()=>[...document.querySelectorAll('#${id} [data-status-ring]')].map(svg => {
    const ring=svg.querySelector('circle');
    const box=svg.getBBox();
    const view=svg.getAttribute('viewBox').split(' ').map(Number);
    return {status:svg.dataset.statusRing, viewBox:svg.getAttribute('viewBox'),
      glyph:svg.dataset.appIcon ?? null,
      box:[box.x,box.y,box.width,box.height].join(' '),
      side:Math.max(box.width,box.height)*(24/view[2]),
      stroke:svg.getAttribute('stroke-width'),
      family:svg.dataset.iconFamily,fill:svg.getAttribute('fill'),outline:svg.getAttribute('stroke'),
      ring:ring?[ring.getAttribute('cx'),ring.getAttribute('cy'),ring.getAttribute('r'),ring.getAttribute('stroke-width')].join(' '):null,
      dash:ring?.getAttribute('stroke-dasharray') ?? null,
      paths:svg.querySelectorAll('path').length,
      spin:svg.classList.contains('animate-spin'),
      reads:getComputedStyle(svg).stroke===getComputedStyle(svg).color}}))()`)

  // Waiting: the app's own drawing — r=9 at 1.5 stroke in the shared 24 box.
  const PURITY = '12 12 9 1.5'
  const ARC_BOX = '3 3 18 18'
  const ARC_STROKE = 1.5
  // Native Hugeicons rings: r=10 for success/error, r=9 for cancellation,
  // all at the same 1.5 stroke as the waiting arc.
  const GLYPH_SIDE = { success: 20, error: 20, cancelled: 18 }
  const SETTLED = { success: 'CircleCheck', error: 'CircleX', cancelled: 'Ban' }
  const isArc = mark => mark.status === 'running'
  const assertArc = (mark, where) => {
    assert.equal(mark.glyph, null, where + ': the waiting arc is drawn app-side, not an adapter glyph')
    assert.equal(mark.viewBox, '0 0 24 24', where + ': the waiting arc draws in the shared 24 box')
    assert.equal(mark.ring, PURITY, where + ': the waiting arc is a 12,12 r=9 circle at 1.5 stroke')
    assert.equal(mark.dash, '0.75 0.25', where + ": waiting is the task strip's 3/4 arc")
    assert.equal(mark.paths, 0, where + ': waiting draws no inner mark')
    assert.equal(mark.box, ARC_BOX, where + ': the waiting arc spans the shared mark box')
  }
  const assertGlyph = (mark, where) => {
    assert.equal(mark.glyph, SETTLED[mark.status], where + ': Hugeicons ' + SETTLED[mark.status])
    assert.equal(mark.viewBox, '0 0 24 24', where + ': the glyph draws in the same 24 box')
    assert.equal(mark.stroke, String(ARC_STROKE), where + ': the glyph is drawn at the arc\'s weight')
    assert.ok(mark.paths >= 1, where + ': the glyph draws real geometry')
    assert.ok(Math.abs(mark.side - GLYPH_SIDE[mark.status]) < 1, where + ": the glyph's ring is the row's own circle")
    assert.equal(mark.reads, true, where + ': the mark follows the row colour')
  }

  // 1. The transcript's tool rows: four states, one mark each.
  const rows = await marks('rows')
  assert.deepEqual(rows.map(mark => mark.status), ['running', 'success', 'error', 'cancelled'], 'a row per state')
  const [running, success, error, cancelled] = rows
  assertArc(running, 'a running tool row')
  for (const mark of [success, error, cancelled]) assertGlyph(mark, 'a ' + mark.status + ' tool row')
  assert.equal(running.spin, true, 'waiting spins')
  assert.deepEqual([success.spin, error.spin, cancelled.spin], [false, false, false], 'settled marks never spin')

  // 2. The task strip's own rows: background tasks and Q&A records.
  // Both panels render newest first, so the row order is theirs — this check
  // owns the marks, not the ordering.
  const bash = await marks('bash')
  assert.deepEqual(bash.map(mark => mark.status).sort(), ['cancelled', 'error', 'running', 'success'],
    'a background task row per state')
  const qa = await marks('qa')
  assert.deepEqual(qa.map(mark => mark.status).sort(), ['cancelled', 'running', 'success'],
    'Q&A records: awaiting, answered, cancelled')
  for (const mark of [...bash, ...qa]) {
    const where = 'a task-strip ' + mark.status + ' row'
    if (isArc(mark)) assertArc(mark, where)
    else assertGlyph(mark, where)
  }

  // 3. One owner per mark: a settled row is the adapter's Hugeicons glyph, and
  //    only the waiting arc is drawn app-side.
  for (const mark of [...rows, ...bash, ...qa]) {
    assert.equal(mark.glyph, isArc(mark) ? null : SETTLED[mark.status], mark.status + ': one owner per mark')
  }
  log('four statuses, one mark each, across the three transcript surfaces')

  // 4. The task panel's own rows split the same way and draw the same circle.
  const todoRows = await evaluate(`(()=>[...document.querySelectorAll('#todo ol > li')].map(li=>{
    const svg=li.querySelector('svg');
    const ring=svg?.querySelector('circle');
    return {glyph:svg?.dataset.appIcon ?? null, viewBox:svg?.getAttribute('viewBox') ?? null,
      progress:!!svg?.hasAttribute('data-todo-progress'),
      stroke:svg?.getAttribute('stroke-width') ?? null,
      ring:ring?[ring.getAttribute('cx'),ring.getAttribute('cy'),ring.getAttribute('r'),ring.getAttribute('stroke-width')].join(' '):null,
      paths:svg?svg.querySelectorAll('path').length:0,
      spin:!!svg?.classList.contains('animate-spin')}}))()`)
  assert.equal(todoRows.length, 4, 'a todo row per state')
  const [awaiting, active, done, dropped] = todoRows
  assert.equal(active.progress, true, 'a running todo row is the shared drawn arc')
  assert.equal(active.glyph, null, 'a running todo row is drawn app-side')
  assert.equal(active.ring, PURITY, 'a running todo row is a 12,12 r=9 circle at 1.5 stroke')
  assert.equal(active.spin, true, 'a running todo row spins')
  for (const [mark, where, glyph] of [
    [done, 'a completed todo row', 'CircleCheck'],
    [dropped, 'a dropped todo row', 'Ban']
  ]) {
    assert.equal(mark.glyph, glyph, where + ' is Hugeicons ' + glyph)
    assert.equal(mark.viewBox, '0 0 24 24', where + ' draws in the shared 24 box')
    assert.equal(mark.stroke, String(ARC_STROKE), where + " is drawn at the arc's weight")
    assert.ok(mark.paths >= 1, where + ' draws real geometry')
    assert.equal(mark.spin, false, where + ' never spins')
  }

  // 6. Settings controls draw their own mark — a status mark is an exception,
  //    not a property of every mark in the app.
  const control = await evaluate(`(()=>{
    const mark=document.querySelector('#control [data-checkbox-mark]');
    return {rings:document.querySelectorAll('#control [data-status-ring]').length,
      mark:mark?.outerHTML ?? null}})()`)
  assert.equal(control.rings, 0, 'a settings control holds no status ring')
  assert.ok(control.mark, 'the control draws its own mark')

  // 6. Reduced motion: the arcs hold still, the marks do not change.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('location.reload()')
  await pause(200)
  await ready()
  const still = await marks('rows')
  assert.deepEqual(still.map(mark => mark.spin), [false, false, false, false], 'no mark spins under reduced motion')
  assertArc(still[0], 'a reduced-motion waiting arc')
  for (const mark of still) {
    if (!isArc(mark)) assertGlyph(mark, 'a reduced-motion ' + mark.status + ' row')
  }
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#todo [data-todo-progress]')).transform`), 'none',
    'a running todo row stops spinning under reduced motion')
  // A live interface switch replaces settled artwork on every surface while
  // preserving the waiting owner and reduced-motion state.
  await evaluate("window.setUiStyle('square')")
  await pause(100)
  for (const surface of ['rows','bash','qa']) {
    for (const mark of await marks(surface)) {
      if (isArc(mark)) { assertArc(mark, surface + ': Remix waiting arc'); continue }
      assert.equal(mark.glyph, SETTLED[mark.status], surface + ': shared semantic status')
      assert.equal(mark.family, 'remix', surface + ': live Remix status')
      assert.equal(mark.fill, 'currentColor', surface + ': native filled outline')
      assert.equal(mark.outline, 'none', surface + ': no doubled stroke')
      assert.equal(mark.stroke, null, surface + ': stroke-family weight does not leak')
      assert.ok(mark.paths > 0, surface + ': real settled geometry')
      assert.equal(mark.spin, false, surface + ': reduced motion survives switching')
    }
  }
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('#todo [data-app-icon="CircleCheck"],#todo [data-app-icon="Ban"]')).every(svg=>svg.dataset.iconFamily==='remix')`),true,'todo outcomes switch with the other surfaces')
  if (process.env.PI_STATUS_RING_SCREENSHOT_DIR) {
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_STATUS_RING_SCREENSHOT_DIR, 'square-status-rings.png'), Buffer.from(capture.data, 'base64'))
  }
  await evaluate('window.checkRoot.unmount()')
  log('waiting arcs spin, hold still under reduced motion, and settled marks are adapter artwork')
} finally {
  clearTimeout(watchdog)
  ws?.close()
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
