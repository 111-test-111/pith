/**
 * Transcript row-rhythm regression check: every row of a turn — a tool row, a
 * folded tool GROUP row, a reasoning row, prose and the waiting row — sits on
 * one and the same flex rhythm, and a block that paints nothing never takes a
 * slot.
 *
 * The bug this pins: a round that opens with a bare `" "` text part rendered an
 * empty markdown block. Zero height, but a real flex item, so it added a whole
 * extra gap (two tool rows sat 24px apart instead of 12px) AND split a tool run
 * that was visually continuous into two separate GROUP rows.
 *
 * Real `ChatView` in isolated Electron against a synthetic store; no SDK, no
 * model calls, no network. Run after building:
 *   node scripts/check-transcript-rhythm.mjs
 * `PI_TRANSCRIPT_SCREENSHOT_DIR` retains the screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-rhythm-'))
const fixturePath = '/__transcript_rhythm_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The transcript's own row gap (`MessageContent className="gap-3"`). */
const ROW_GAP = 12
/** The one row height every transcript row shares (`min-h-9`). */
const ROW_HEIGHT = 36

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const params = new URLSearchParams(location.search);
const caseName = params.get('case') ?? 'invisible';
// The reported turn had "show reasoning blocks" off, so a round's reasoning is
// not a row; the third case turns it back on to prove the same rhythm holds
// when reasoning rows alternate with tool rows.
localStorage.setItem('pi-app:show-reasoning', caseName === 'reasoning' ? 'on' : 'off');

window.pi = { openPath: async () => '', appInfo: async () => ({ version: 'fixture' }), openExternal: async () => {},
  onBashTask: () => () => {}, listBashTasks: async () => [], onSubagents: () => () => {}, appInfoSync: null };

const call = (id, name) => ({ type: 'toolCall', id, name, arguments: {} });
const result = (id, name, timestamp) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content: [{ type: 'text', text: 'ok' }], isError: false });
const thinking = (text) => ({ type: 'thinking', thinking: text });
const round = (timestamp, content) => ({ role: 'assistant', timestamp, content, changeScopeId: 'scope-a', stopReason: 'toolUse' });

// Rounds arrive as separate assistant messages; the reported turn opened every
// round with a one-space text part in front of its hidden reasoning.
const invisibleTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [{ type: 'text', text: ' ' }, thinking('plan'), call('t1', 'todo_write')]),
  result('t1', 'todo_write', 11),
  round(20, [{ type: 'text', text: ' ' }, thinking('look'), call('g1', 'grep'), call('f1', 'find')]),
  result('g1', 'grep', 21), result('f1', 'find', 22),
  round(30, [{ type: 'text', text: ' ' }, thinking('look more'), call('r1', 'read'), call('g2', 'grep')]),
  result('r1', 'read', 31), result('g2', 'grep', 32)
];
// A real prose block between two tool rounds: the rows stay separate, and they
// must still sit on the same rhythm as everything else.
const visibleTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('e1', 'edit'), call('b1', 'bash')]),
  result('e1', 'edit', 11), result('b1', 'bash', 12),
  round(20, [{ type: 'text', text: 'The fix is in. Now I will verify it.' }, call('b2', 'bash')]),
  result('b2', 'bash', 21),
  round(30, [{ type: 'text', text: ' ' }, call('r1', 'read'), call('r2', 'read'), call('r3', 'read')]),
  result('r1', 'read', 31), result('r2', 'read', 32), result('r3', 'read', 33)
];
// The reported trio: a read row, a bash row and a three-call exploration
// GROUP row, all in one merged run — the exact shape whose row gaps were
// reported as unequal.
const mixedTurn = [
  { role: 'user', timestamp: 1, content: 'go' },
  round(10, [call('r1', 'read')]),
  result('r1', 'read', 11),
  round(20, [call('b1', 'bash')]),
  result('b1', 'bash', 21),
  round(30, [call('r2', 'read'), call('r3', 'read'), call('r4', 'read')]),
  result('r2', 'read', 31), result('r3', 'read', 32), result('r4', 'read', 33)
];
const turns = { invisible: invisibleTurn, visible: visibleTurn, reasoning: invisibleTurn, mixed: mixedTurn };
const messages = turns[caseName] ?? invisibleTurn;

window.store = new PiStore();
window.store.applySnapshot({ sessionId: 'rhythm', sessionPath: '/ui/rhythm', cwd: '/ui', projectless: false, messages, isStreaming: true, activeChangeScopeId: 'scope-a', model: null, thinkingLevel: 'off', eventSequence: 1 });
flushSync(() => createRoot(document.getElementById('root')).render(
  React.createElement(I18nProvider, null, React.createElement(ImagePreviewProvider, null,
    React.createElement('div', { id: 'fixture', style: { height: 900, display: 'flex', flexDirection: 'column' } },
      React.createElement(ChatView, { store: window.store, onDismissError: () => {}, onResend: () => {}, onEditMessage: () => {}, onFork: () => {}, onReview: () => {} }))))
));

/** The turn's row column: the waiting row's parent. */
const inkBox = (root) => {
  const rowBox = root.getBoundingClientRect()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const candidates = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node.nodeValue || !node.nodeValue.trim()) continue
    // Screen-reader-only copy is not part of what the eye spaces out.
    if (node.parentElement?.closest('.sr-only')) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    if (!box.height) continue
    // A collapsed disclosure still LAYS OUT its children (height 0, clipped), so
    // anything outside the row's own box is not ink the reader can see.
    if (box.bottom <= rowBox.top + 0.5 || box.top >= rowBox.bottom - 0.5) continue
    candidates.push({ box, size: parseFloat(getComputedStyle(node.parentElement).fontSize) })
  }
  if (!candidates.length) return null
  // The row's LEADING text is what the reader spaces out; the smaller meta and
  // mono runs beside it only smear the union box.
  const largest = Math.max(...candidates.map((entry) => entry.size))
  const primary = candidates.filter((entry) => entry.size >= largest - 0.01)
  const top = Math.min(...primary.map((entry) => entry.box.top))
  const bottom = Math.max(...primary.map((entry) => entry.box.bottom))
  return { top, bottom, center: (top + bottom) / 2 }
};
window.rows = () => {
  const waiting = document.querySelector('#fixture [data-spinner-verb]');
  if (!waiting) return null;
  const column = waiting.parentElement;
  const style = getComputedStyle(column);
  return {
    gap: style.rowGap,
    columnTop: Math.round(column.getBoundingClientRect().top),
    text: column.innerText,
    items: [...column.children].map((row) => {
      const box = row.getBoundingClientRect();
      const ink = inkBox(row);
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        inkCenter: ink ? Math.round(ink.center * 10) / 10 : null,
        inkTop: ink ? Math.round(ink.top * 10) / 10 : null,
        inkBottom: ink ? Math.round(ink.bottom * 10) / 10 : null,
        boxCenter: Math.round((box.top + box.height / 2) * 10) / 10,
        text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 46)
      };
    })
  };
};
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
try {
  server = await createServer({
    configFile: false,
    root: join(repo, 'src/renderer'),
    logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [
      react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }),
      tailwindcss(),
      {
        name: 'rhythm-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== fixturePath) return next()
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) {
              next(error)
            }
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  const exceptions = []
  // Electron's own sandboxed-renderer bundle complains about missing preload
  // startup data in a window that has none; that is not our page.
  const ELECTRON_NOISE = /sandboxed_renderer\.bundle\.js|binding\.startupData/
  let sequence = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (m) => (m.error ? reject(m.error) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const load = async (query) => {
    await send('Page.navigate', { url: origin + (query ?? '') })
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.fixtureReady && !!document.querySelector("#fixture [data-spinner-verb]")')) return
      await pause(50)
    }
    throw new Error(
      'Fixture did not mount: ' +
        JSON.stringify({
          ready: await evaluate('!!window.fixtureReady'),
          body: await evaluate('document.body.innerText.slice(0, 200)'),
          exceptions: exceptions.slice(0, 2).map((entry) => entry.exception?.description ?? entry.console ?? String(entry))
        })
    )
  }
  const screenshot = async (name) => {
    if (!process.env.PI_TRANSCRIPT_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_TRANSCRIPT_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_TRANSCRIPT_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  /**
   * The rhythm a reader actually sees: every row is the same box with its own
   * content centred, so two consecutive rows' text is the same distance apart
   * whichever pair you look at. A row whose box is taller than its content
   * would add its slack to that distance, which is the bug this pins.
   */
  const assertRhythm = (state, label) => {
    assert.ok(state.items.length >= 2, `${label}: the turn paints rows`)
    assert.equal(state.gap, `${ROW_GAP}px`, `${label}: the column's row gap is the shared one`)
    state.items.forEach((row, index) => {
      assert.ok(row.height > 0, `${label}: row ${index} (${row.text}) paints a real row, not an empty slot`)
      assert.ok(
        row.height >= ROW_HEIGHT,
        `${label}: row ${index} (${row.text}) is at least the shared ${ROW_HEIGHT}px box, got ${row.height}px`
      )
      if (index === 0) return
      const gap = row.top - state.items[index - 1].bottom
      assert.equal(
        gap,
        ROW_GAP,
        `${label}: row ${index} sits ${ROW_GAP}px below the previous one, not ${gap}px (${state.items[index - 1].text} → ${row.text})`
      )
      const pitch = row.inkCenter - state.items[index - 1].inkCenter
      // ±2px: a row's leading text can sit a hair off its box centre when
      // smaller meta text shares its baseline (the group row's label), which is
      // below what the eye reads as different spacing — unlike the 4–8px a
      // taller box used to add.
      assert.ok(
        Math.abs(pitch - (ROW_HEIGHT + ROW_GAP)) <= 2,
        `${label}: the text of rows ${index - 1} and ${index} is ${ROW_HEIGHT + ROW_GAP}px apart, got ${pitch}px (${state.items[index - 1].text} → ${row.text})`
      )
    })
  }

  // --- the reported turn: a round that opens with a bare space between tools
  await load()
  await pause(300)
  const invisible = await evaluate('window.rows()')
  assertRhythm(invisible, 'invisible separator')
  // `todo_write` is its own row (uncategorized), the four exploration calls are
  // one group: the invisible text blocks separate nothing, so the two grep/read
  // rounds merge into a single row.
  assert.equal(invisible.items.length, 3, `three rows: a tool, one merged group, the waiting row — got ${JSON.stringify(invisible.items.map((r) => r.text))}`)
  assert.match(invisible.items[1].text, /^Exploration 4 tools/, 'the first exploration round renders the merged group')
  assert.equal(
    (invisible.text.match(/Exploration/g) ?? []).length,
    1,
    'a whitespace-only text block never splits a visually continuous tool run'
  )
  assert.match(invisible.items[2].text, /./, 'the waiting row is the last row of the turn')
  await screenshot('invisible-separator')

  // --- a real prose block between two tool rounds keeps its own row, and the
  // rhythm is unchanged around it; two rows inside ONE round share it too
  await load('?case=visible')
  await pause(300)
  const visible = await evaluate('window.rows()')
  assertRhythm(visible, 'visible prose')
  // Round 1 paints two different-category rows (edit + bash, one block), then
  // the prose row, then a terminal row, then the merged three-call read group,
  // then the waiting row.
  assert.equal(visible.items.length, 6, `six rows — got ${JSON.stringify(visible.items.map((r) => r.text))}`)
  assert.match(visible.items[2].text, /The fix is in/, 'prose keeps its own row')
  assert.match(visible.items[4].text, /^Exploration 3 tools/, 'the three adjacent read calls fold into one group row')
  await screenshot('visible-prose')

  // --- the same turn with reasoning blocks shown: a reasoning row is a row
  // like any other, and it is a VISIBLE separator, so the two tool runs stay
  // two GROUP rows — still on the one rhythm
  await load('?case=reasoning')
  await pause(300)
  const reasoning = await evaluate('window.rows()')
  assertRhythm(reasoning, 'reasoning rows')
  assert.equal(
    reasoning.items.length,
    7,
    `reasoning, tool and waiting rows alternate — got ${JSON.stringify(reasoning.items.map((r) => r.text))}`
  )
  assert.equal(
    (reasoning.text.match(/Exploration/g) ?? []).length,
    2,
    'a VISIBLE reasoning row really does separate two tool runs'
  )
  await screenshot('reasoning-rows')

  // --- the reported trio: a read row, a bash row and a 3-call GROUP row
  await load('?case=mixed')
  await pause(300)
  const mixed = await evaluate('window.rows()')
  assertRhythm(mixed, 'read / bash / group')
  assert.equal(
    mixed.items.length,
    4,
    `a read row, a bash row, a group row and the waiting row — got ${JSON.stringify(mixed.items.map((r) => r.text))}`
  )
  assert.match(mixed.items[0].text, /^read/, 'the first row is the read call')
  assert.match(mixed.items[1].text, /^bash/, 'the second row is the bash call')
  assert.match(mixed.items[2].text, /^Exploration 3 tools/, 'the third row is the folded group')
  assert.equal(mixed.items[2].height, mixed.items[0].height, 'a GROUP row is the same box as a tool row')
  await screenshot('read-bash-group')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')

  console.log(
    `transcript rhythm check ok: every row shares the ${ROW_HEIGHT}px box with a ${ROW_GAP}px gap, so consecutive rows read ${ROW_HEIGHT + ROW_GAP}px apart (±2 for font metrics), and a whitespace-only text part neither paints nor separates`
  )
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
