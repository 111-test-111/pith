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
 * It also pins the second report on the same rows: a row whose own trigger opens
 * a growing body (reasoning, folded group, the settled-turn fold) must not move
 * when it opens. `justify-center` re-centres the trigger inside the 36px row
 * while the row has slack and stops the moment the body exceeds it, so the row
 * jumped 4px up on every expand. The trigger now owns the row's box itself.
 *
 * And the third: an EXPANDED body starts where its row's own text does — 16px
 * icon plus 8px gap — whichever component draws it (a tool body, a reasoning
 * body). A body at the row's left edge reads as belonging to the row above it,
 * which is what a reader reports as "the reasoning content has no indent".
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
import { crc32, deflateSync } from 'node:zlib'
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

/**
 * A colour-bar PNG, built here so the fixture carries a CAPTURE-SIZED image.
 * Bands rather than a flat fill: a screenshot of a flat rectangle cannot show
 * whether an image is contained, capped or cropped, and a 1×1 pixel cannot
 * either. The 16:9 shape is what the assertions pin.
 */
function capturePngBytes(width, height) {
  const band = (x) => BANDS[Math.min(BANDS.length - 1, Math.floor((x / width) * BANDS.length))]
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      // A left-to-right shade ramp makes the caps and the aspect ratio visible.
      const shade = 0.55 + 0.45 * (x / width)
      const [red, green, blue] = band(x)
      raw[start + 1 + x * 3] = Math.round(red * shade)
      raw[start + 2 + x * 3] = Math.round(green * shade)
      raw[start + 3 + x * 3] = Math.round(blue * shade)
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BANDS = [
  [214, 96, 77],
  [224, 145, 60],
  [232, 197, 71],
  [138, 176, 90],
  [86, 156, 214],
  [92, 118, 196],
  [140, 98, 190],
  [196, 96, 150]
]
const capturePng = capturePngBytes(1600, 900).toString('base64')

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
localStorage.setItem('pi-app:show-reasoning', caseName === 'reasoning' || caseName === 'images' ? 'on' : 'off');

window.pi = { openPath: async (path) => { window.__opened = path; return ''; }, appInfo: async () => ({ version: 'fixture' }), openExternal: async () => {},
  onBashTask: () => () => {}, listBashTasks: async () => [], onSubagents: () => () => {}, appInfoSync: null };

const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args ?? {} });
const result = (id, name, timestamp) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content: [{ type: 'text', text: 'ok' }], isError: false });
const richResult = (id, name, timestamp, content, isError) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp, content, isError: isError === true });
/** A 1600×900 capture — the image payload a read/screenshot tool result carries. */
const IMAGE = { type: 'image', data: '${capturePng}', mimeType: 'image/png' };
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
// A tool whose output IS an image: the SDK's read tool inlines an image file
// and browser_screenshot returns a capture, each beside its own bookkeeping text
// (and the screenshot's own notes). The same read tool also reads a text file,
// which keeps the framed output box.
const imageTurn = [
  { role: 'user', timestamp: 1, content: 'look at this' },
  round(10, [call('r1', 'read', { path: 'docs/shot.png' }), call('s1', 'browser_screenshot')]),
  richResult('r1', 'read', 11, [{ type: 'text', text: 'Read image file [image/png]' }, IMAGE]),
  richResult('s1', 'browser_screenshot', 12, [IMAGE, { type: 'text', text: '[Targeted by selector button in frame #0.]' }]),
  round(20, [thinking('checked the capture'), call('g1', 'grep')]),
  result('g1', 'grep', 21),
  round(30, [{ type: 'text', text: 'The capture shows the toolbar.' }, call('r2', 'read', { path: 'src/app.ts' })]),
  result('r2', 'read', 31)
];
// A tool result whose image did NOT come back cleanly: an errored result that
// still carries its image, and one whose image bytes cannot be decoded. The text
// beside the image is the tool's diagnosis there — the one case where hiding it
// loses information — so the row keeps it (and drops an undecodable image rather
// than leaving a broken icon behind).
const BROKEN = { type: 'image', data: 'bm90LWFuLWltYWdl', mimeType: 'image/png' };
const imageFailureTurn = [
  { role: 'user', timestamp: 1, content: 'read it' },
  round(10, [call('r1', 'read', { path: 'docs/err.png' })]),
  richResult('r1', 'read', 11, [{ type: 'text', text: 'Read image file [image/png]' }, IMAGE], true),
  round(20, [{ type: 'text', text: 'That one came back with an error.' }, call('r2', 'read', { path: 'docs/broken.png' })]),
  richResult('r2', 'read', 21, [{ type: 'text', text: 'could not decode the image' }, BROKEN]),
  round(30, [{ type: 'text', text: 'Done.' }, call('g1', 'grep')]),
  result('g1', 'grep', 31)
];
// A long tool output: the card caps its body, so the fold has to land on a LINE
// boundary instead of slicing one in half.
const longTurn = [
  { role: 'user', timestamp: 1, content: 'list it' },
  round(10, [call('b1', 'bash')]),
  richResult('b1', 'bash', 11, [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\\n') }]),
  round(20, [call('g1', 'grep')]),
  result('g1', 'grep', 21)
];
const turns = { invisible: invisibleTurn, visible: visibleTurn, reasoning: invisibleTurn, mixed: mixedTurn, images: imageTurn, failure: imageFailureTurn, long: longTurn };
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
/**
 * A row that opens a growing body (a reasoning row, a folded tool group): the
 * geometry of its trigger INSIDE its own row. The reader's report was that
 * opening the reasoning moved the row up a little — which is exactly the
 * trigger's offset inside the row shrinking, not the row moving in the page.
 */
window.triggerGeometry = (needle) => {
  const root = document.querySelector('#fixture');
  const row = [...root.querySelectorAll('[data-content][data-state]')].find(
    (el) => new RegExp(needle).test(el.textContent) && el.getBoundingClientRect().width > 0
  );
  if (!row) return null;
  const trigger = row.firstElementChild;
  const rowBox = row.getBoundingClientRect();
  const triggerBox = trigger.getBoundingClientRect();
  return {
    state: row.getAttribute('data-state'),
    rowHeight: Math.round(rowBox.height),
    triggerHeight: Math.round(triggerBox.height),
    offset: Math.round(triggerBox.top - rowBox.top),
    triggerInkTop: inkBox(trigger)?.top ?? null,
  };
};
window.toggleRow = (needle) => {
  const root = document.querySelector('#fixture');
  const row = [...root.querySelectorAll('[data-content][data-state]')].find(
    (el) => new RegExp(needle).test(el.textContent) && el.getBoundingClientRect().width > 0
  );
  row.firstElementChild.click();
};
/**
 * The left edge of a subtree's own ink — its text runs plus any image/button
 * boxes. This is the x a reader compares when they report "the expanded content
 * is not indented": the row trigger's leading text versus its body's.
 */
window.leadingInk = (node) => {
  let left = null;
  const keep = (value) => { if (left === null || value < left) left = value; };
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (!text.nodeValue || !text.nodeValue.trim()) continue;
    if (text.parentElement && text.parentElement.closest('.sr-only')) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = range.getBoundingClientRect();
    if (box.width) keep(box.left);
  }
  for (const el of node.querySelectorAll('img, button')) {
    const box = el.getBoundingClientRect();
    if (box.width) keep(box.left);
  }
  return left === null ? null : Math.round(left * 10) / 10;
};
/**
 * The row whose own TRIGGER text matches: body text is ignored, so a needle can
 * never match a row through content it merely happens to contain.
 */
window.findRow = (needle) => {
  const root = document.querySelector('#fixture');
  return [...root.querySelectorAll('[data-state]')].find(
    (el) => el.getBoundingClientRect().width > 0 && el.firstElementChild &&
      new RegExp(needle).test(el.firstElementChild.textContent)
  );
};
window.openRow = (needle) => {
  const row = window.findRow(needle);
  if (!row) return false;
  row.firstElementChild.click();
  return true;
};
/** A row's title indent against its expanded body's, and how the body is drawn. */
window.rowBody = (needle) => {
  const row = window.findRow(needle);
  if (!row || row.children.length < 2) return null;
  const trigger = row.firstElementChild;
  const body = row.children[1];
  const frame = body.querySelector('[data-tool-body]');
  return {
    state: row.getAttribute('data-state'),
    kind: frame ? frame.getAttribute('data-tool-body') : 'activity',
    box: frame ? Boolean(frame.querySelector('.rounded-xl')) : null,
    images: body.querySelectorAll('img').length,
    text: body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80),
    rowLeft: Math.round(row.getBoundingClientRect().left * 10) / 10,
    titleLeft: window.leadingInk(trigger),
    bodyLeft: window.leadingInk(body)
  };
};
/** A tool card's own frame: the padding above its output against the padding
 * below it, and whether a copy/status footer row sits inside it. */
window.bodyFrame = (needle) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body]') : null;
  const frame = body ? body.querySelector('.rounded-xl') : null;
  if (!frame) return null;
  // The padding lives ON the content div, so the INK below it is what shows the
  // card's top-to-bottom symmetry.
  const viewport = frame.firstElementChild;
  const content = viewport ? viewport.firstElementChild : null;
  const ink = content && content.firstElementChild ? content.firstElementChild : content;
  const frameBox = frame.getBoundingClientRect();
  const inkBox = ink.getBoundingClientRect();
  return {
    top: Math.round((inkBox.top - frameBox.top) * 10) / 10,
    bottom: Math.round((frameBox.bottom - inkBox.bottom) * 10) / 10,
    footer: frame.querySelectorAll('[aria-label="Copy result"], [aria-label="Copied"], [aria-label="Run again"]').length,
    labels: [...frame.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))
  };
};
/** The output card's fold: where the cap lands against the code lines it shows. */
window.outputFold = (needle) => {
  const row = window.findRow(needle);
  const viewport = row ? row.querySelector('[data-tool-body] [role=\"log\"]') : null;
  if (!viewport) return null;
  const lines = [...viewport.querySelectorAll('pre > code > span')];
  const edge = viewport.getBoundingClientRect().bottom;
  const boxes = lines.map((el) => el.getBoundingClientRect());
  const mask = getComputedStyle(viewport).maskImage;
  return {
    cap: Math.round(viewport.getBoundingClientRect().height),
    scroll: viewport.scrollHeight,
    lineCount: boxes.length,
    pitch: boxes.length > 1 ? Math.round(boxes[1].top - boxes[0].top) : null,
    cut: boxes.filter((b) => b.top < edge - 0.5 && b.bottom > edge + 0.5).length,
    visible: boxes.filter((b) => b.bottom <= edge + 0.5).length,
    fade: viewport.getAttribute('data-fade'),
    mask
  };
};
window.clickThumb = (needle, index) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body]') : null;
  const buttons = body ? [...body.querySelectorAll('button')] : [];
  if (!buttons[index]) return false;
  buttons[index].click();
  return true;
};
/** How the row's image actually landed: a capture-sized image must stay inside
 * the row (the thumbnail is a shrink-to-fit button around the image). */
window.imageFit = (needle) => {
  const row = window.findRow(needle);
  const body = row ? row.querySelector('[data-tool-body]') : null;
  const image = body ? body.querySelector('img') : null;
  if (!image) return null;
  const imageBox = image.getBoundingClientRect();
  return {
    width: Math.round(imageBox.width),
    height: Math.round(imageBox.height),
    ratio: Math.round((imageBox.width / imageBox.height) * 100) / 100,
    rowWidth: Math.round(row.getBoundingClientRect().width),
    overflow: Math.round(row.scrollWidth - row.clientWidth)
  };
};
window.imageDialog = () => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { label: null, openFile: false, close: false };
  return {
    label: dialog.getAttribute('aria-label'),
    openFile: [...dialog.querySelectorAll('button')].some((b) => (b.textContent || '').indexOf('Open file') !== -1),
    close: Boolean(dialog.querySelector('[aria-label="Close preview"]'))
  };
};
window.clickDialog = (what) => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  const button = what === 'open'
    ? [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('Open file') !== -1)
    : dialog.querySelector('[aria-label="Close preview"]');
  if (!button) return false;
  button.click();
  return true;
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

  // --- a tool card has no copy/status footer row: the header already states the
  //     status with its glyph, and the bar made the card's bottom padding larger
  //     than its top (the reported "复制 + Completed" row)
  assert.equal(await evaluate(`window.openRow('bash ·')`), true, 'the bash row opens')
  await pause(400)
  const card = await evaluate(`window.bodyFrame('bash ·')`)
  assert.equal(card.footer, 0, `no copy/retry footer inside the card: ${JSON.stringify(card.labels)}`)
  assert.ok(card.top > 0, `the card keeps its own top padding: ${JSON.stringify(card)}`)
  assert.ok(
    Math.abs(card.top - card.bottom) <= 0.5,
    `the card's padding is the same top and bottom: ${card.top} / ${card.bottom}`
  )
  await screenshot('tool-card-padding')

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
  // A group row opens the same growing body a reasoning row does, so it carries
  // the trigger-owns-the-row invariant too.
  const closedGroup = await evaluate(`window.triggerGeometry('tools')`)
  assert.equal(closedGroup.triggerHeight, ROW_HEIGHT, `a growing row's trigger takes the row's own ${ROW_HEIGHT}px box`)
  assert.equal(closedGroup.offset, 0, 'a growing row\'s trigger has no slack to be re-centred in')
  await screenshot('read-bash-group')

  // --- opening a row that GROWS its own body must move nothing. The trigger
  //     used to sit 4px down (the 36px row's slack around a 28px trigger) and
  //     snapped to the top the moment the body exceeded that slack — the row
  //     visibly jumped up on every open, in either direction. Giving the trigger
  //     the row's box removes the slack, so the expansion has nothing to move.
  await load('?case=reasoning')
  await pause(300)
  const beforeOpen = await evaluate(`window.triggerGeometry('Reasoning')`)
  assert.equal(beforeOpen.state, 'closed', 'the reasoning row starts collapsed')
  assert.equal(beforeOpen.triggerHeight, ROW_HEIGHT, `the collapsed trigger is the row's own ${ROW_HEIGHT}px box: ${JSON.stringify(beforeOpen)}`)
  assert.equal(beforeOpen.offset, 0, `the collapsed trigger is flush with the row's top: ${JSON.stringify(beforeOpen)}`)
  await evaluate(`window.toggleRow('Reasoning')`)
  await pause(500)
  const afterOpen = await evaluate(`window.triggerGeometry('Reasoning')`)
  assert.equal(afterOpen.state, 'open', 'the reasoning row really did open')
  assert.ok(afterOpen.rowHeight > beforeOpen.rowHeight, `the body grew: ${JSON.stringify(afterOpen)}`)
  assert.equal(afterOpen.offset, 0, `opening moves nothing: the trigger is still flush with the row's top (${JSON.stringify(afterOpen)})`)
  assert.ok(
    Math.abs(afterOpen.triggerInkTop - beforeOpen.triggerInkTop) <= 0.5,
    `the trigger's own text keeps its exact position across the open: ${beforeOpen.triggerInkTop} → ${afterOpen.triggerInkTop}`
  )
  await screenshot('reasoning-open')

  // --- a tool whose output is an image: the image renders ALONE, without the
  //     framed output box, at the row's own text indent — and clicking it opens
  //     the same preview overlay every other image in the app uses
  await load('?case=images')
  await pause(300)
  const imageRowTurn = await evaluate('window.rows()')
  assertRhythm(imageRowTurn, 'image output')
  assert.equal(
    imageRowTurn.items.length,
    7,
    `read image · screenshot · reasoning · grep · prose · read text · waiting — got ${JSON.stringify(imageRowTurn.items.map((r) => r.text))}`
  )
  await screenshot('image-output')

  const collapsedImage = await evaluate(`window.rowBody('shot.png')`)
  assert.equal(collapsedImage.state, 'success', 'the read row settled')
  assert.equal(collapsedImage.bodyLeft, null, 'a collapsed row mounts no body to indent')

  await evaluate(`window.openRow('shot.png')`)
  await pause(500)
  const imageRow = await evaluate(`window.rowBody('shot.png')`)
  assert.equal(imageRow.kind, 'bare', 'an image result renders WITHOUT the framed output box')
  assert.equal(imageRow.box, false, 'no output box is painted inside the row')
  assert.equal(imageRow.images, 1, 'the image the tool returned is what the row shows')
  assert.equal(imageRow.text, '', 'the read tool\'s own "Read image file …" bookkeeping text is not painted')
  // The row's own text starts at 16px icon + 8px gap; the body must land there
  // too, which is what "the expanded content keeps an indent" means.
  assert.ok(
    Math.abs(imageRow.titleLeft - imageRow.rowLeft - 24) <= 0.5,
    `the row title starts 24px into the row: ${imageRow.titleLeft - imageRow.rowLeft}`
  )
  assert.ok(
    Math.abs(imageRow.bodyLeft - imageRow.rowLeft - 24) <= 0.5,
    `the image starts 24px into the row, where the title does: ${imageRow.bodyLeft - imageRow.rowLeft}`
  )
  // A capture-sized image stays inside its row — thumbnails are shrink-to-fit
  // buttons, the shape that can let a wide image push the column out.
  const fit = await evaluate(`window.imageFit('shot.png')`)
  assert.ok(fit.width <= fit.rowWidth, `the image fits its row: ${fit.width} ≤ ${fit.rowWidth}`)
  assert.ok(fit.height <= 256.5, `the image honours the 256px cap: ${fit.height}`)
  assert.ok(Math.abs(fit.ratio - 1600 / 900) < 0.02, `the image keeps its aspect ratio: ${fit.ratio}`)
  assert.ok(fit.overflow <= 0, `the row does not overflow horizontally: ${fit.overflow}`)

  // A hovered thumbnail must not lift: the zoom cursor, the focus ring and the
  // preview are the affordance. Measured on the real control, with the pointer
  // really over it, so "no shadow" cannot pass by never hovering anything.
  const thumb = await evaluate(`(() => {
    const image = window.findRow('shot.png').querySelector('[data-tool-body] img');
    const box = image.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumb.x, y: thumb.y })
  await pause(250)
  const thumbHover = await evaluate(`(() => {
    const trigger = window.findRow('shot.png').querySelector('[data-tool-body] button');
    return { hover: trigger.matches(':hover'), shadow: getComputedStyle(trigger).boxShadow };
  })()`)
  assert.equal(thumbHover.hover, true, 'the pointer really is over the thumbnail')
  assert.equal(thumbHover.shadow, 'none', `a hovered thumbnail carries no shadow: ${thumbHover.shadow}`)
  await screenshot('image-row-open')

  // The same tool with a TEXT result keeps the framed box, its output inside the
  // box's own 12px padding — so the change is about images, not about read rows.
  await evaluate(`window.openRow('app.ts')`)
  await pause(400)
  const textRow = await evaluate(`window.rowBody('app.ts')`)
  assert.equal(textRow.kind, 'framed', 'a text result keeps the framed output box')
  assert.equal(textRow.box, true, 'the box is really painted')
  assert.match(textRow.text, /ok/, 'a text result still paints its output')
  assert.ok(
    Math.abs(textRow.bodyLeft - textRow.rowLeft - 36) <= 0.5,
    `a framed body's text sits 12px inside its box (24 + 12): ${textRow.bodyLeft - textRow.rowLeft}`
  )

  // A capture's own notes are bookkeeping too: the row shows the screenshot alone.
  await evaluate(`window.openRow('browser_screenshot')`)
  await pause(400)
  const shotRow = await evaluate(`window.rowBody('browser_screenshot')`)
  assert.equal(shotRow.kind, 'bare', 'a screenshot renders without the framed box')
  assert.equal(shotRow.images, 1, 'the capture is painted')
  assert.equal(shotRow.text, '', 'the screenshot note text is not painted beside the capture')
  const shotFit = await evaluate(`window.imageFit('browser_screenshot')`)
  assert.ok(shotFit.width <= shotFit.rowWidth, `the capture fits its row: ${shotFit.width} ≤ ${shotFit.rowWidth}`)
  assert.ok(shotFit.height <= 256.5, `the capture honours the same 256px cap: ${shotFit.height}`)
  assert.ok(Math.abs(shotFit.ratio - 1600 / 900) < 0.02, `the capture is neither cropped nor letterboxed: ${shotFit.ratio}`)
  assert.ok(shotFit.overflow <= 0, `the capture's row does not overflow: ${shotFit.overflow}`)

  // --- the tool's image IS the app-wide preview: one click opens the overlay,
  //     which offers the file the tool read, and it closes again
  assert.equal(await evaluate(`window.clickThumb('shot.png', 0)`), true, 'the thumbnail is a real control')
  await pause(500)
  const dialog = await evaluate('window.imageDialog()')
  assert.equal(dialog.label, 'Image 1', `the thumbnail opens the app-wide image preview: ${JSON.stringify(dialog)}`)
  assert.equal(dialog.openFile, true, 'the preview offers the file the tool read')
  assert.equal(dialog.close, true, 'the preview has its close control')
  await screenshot('image-preview')
  assert.equal(await evaluate(`window.clickDialog('open')`), true, 'the open-file action is clickable')
  await pause(200)
  assert.equal(await evaluate('window.__opened'), '/ui/docs/shot.png', 'the preview opens the file the tool read')
  assert.equal(await evaluate(`window.clickDialog('close')`), true, 'the preview closes')
  await pause(700)
  assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), false, 'the overlay is gone again')
  await screenshot('image-preview-closed')

  // --- the reasoning body starts where the row's own "Reasoning" label does:
  //     the indent a tool body has, which a reader reported missing
  await evaluate(`window.openRow('Reasoning')`)
  await pause(400)
  const reasoningBody = await evaluate(`window.rowBody('Reasoning')`)
  assert.equal(reasoningBody.kind, 'activity', 'the reasoning body is not a tool body')
  assert.match(reasoningBody.text, /checked the capture/, 'the reasoning text is what the body paints')
  assert.ok(
    Math.abs(reasoningBody.titleLeft - reasoningBody.rowLeft - 24) <= 0.5,
    `the Reasoning label starts 24px into the row: ${reasoningBody.titleLeft - reasoningBody.rowLeft}`
  )
  assert.ok(
    Math.abs(reasoningBody.bodyLeft - reasoningBody.rowLeft - 24) <= 0.5,
    `the reasoning body starts where its own label starts: ${reasoningBody.bodyLeft - reasoningBody.rowLeft}`
  )
  await screenshot('reasoning-indent')

  // --- an image that did NOT come back cleanly: the text beside it is the
  //     tool's diagnosis, so it stays; an undecodable image does not linger
  await load('?case=failure')
  await pause(300)
  const failureRows = await evaluate('window.rows()')
  assertRhythm(failureRows, 'failed image results')
  assert.equal(
    failureRows.items.length,
    6,
    `read(error) · prose · read(broken) · prose · grep · waiting — got ${JSON.stringify(failureRows.items.map((r) => r.text))}`
  )

  await evaluate(`window.openRow('err.png')`)
  await pause(500)
  const errored = await evaluate(`window.rowBody('err.png')`)
  assert.equal(errored.kind, 'framed', 'a FAILED result keeps the framed output box')
  assert.match(errored.text, /Read image file/, "a failed result's own text is painted beside its image")
  assert.equal(errored.images, 1, 'the image the failed result carried is still shown')
  assert.doesNotMatch(errored.text, /\[image\]/, "the text is the tool's own words, not a placeholder for the picture the row already paints")

  await evaluate(`window.openRow('broken.png')`)
  await pause(800)
  const undecodable = await evaluate(`window.rowBody('broken.png')`)
  assert.equal(undecodable.kind, 'framed', 'an undecodable image falls back to the framed text')
  assert.match(undecodable.text, /could not decode/, 'the tool\'s explanation is painted')
  assert.equal(undecodable.images, 0, 'the image that cannot be decoded is not left behind as a broken icon')
  await screenshot('image-failure')

  // --- a capped output card folds on a LINE boundary — the 12px padding lives
  //     inside the scrollport, so the cap is `padding + n × line` — and the fade
  //     sits on the edge that actually hides content (it was swapped, which is
  //     why the fold looked like a hard chop of a half line)
  await load('?case=long')
  await pause(300)
  assert.equal(await evaluate(`window.openRow('bash ·')`), true, 'the long-output row opens')
  await pause(400)
  const fold = await evaluate(`window.outputFold('bash ·')`)
  assert.equal(fold.lineCount, 30, `the fixture paints 30 output lines: ${JSON.stringify(fold)}`)
  assert.equal(fold.pitch, 20, `AgentCode's line grid is the 20px one: ${fold.pitch}`)
  assert.equal(fold.cut, 0, `no line is sliced by the fold: ${JSON.stringify(fold)}`)
  assert.equal(fold.visible, 11, `eleven whole lines fit the card: ${JSON.stringify(fold)}`)
  assert.equal((fold.cap - 12) % fold.pitch, 0, `the cap is padding + n × line: ${fold.cap}`)
  assert.equal(fold.fade, 'bottom', 'content below the fold: the hidden edge is the bottom one')
  // The mask's own colour stops, split on top-level commas only: the last one is
  // transparent exactly when the bottom edge is the one being hidden.
  const stops = fold.mask
    .slice(fold.mask.indexOf('(') + 1, fold.mask.lastIndexOf(')'))
    .split(/,(?![^(]*\))/)
  assert.ok(
    stops[stops.length - 1].includes('rgba(0, 0, 0, 0)'),
    `the bottom edge is the one that fades: ${fold.mask}`
  )
  assert.ok(!stops[0].includes('rgba(0, 0, 0, 0)'), `the top edge is not faded at the top of the scroll: ${fold.mask}`)
  await screenshot('long-output-fold')
  assert.deepEqual(exceptions, [], 'no renderer exceptions')

  console.log(
    `transcript rhythm check ok: every row shares the ${ROW_HEIGHT}px box with a ${ROW_GAP}px gap, so consecutive rows read ${ROW_HEIGHT + ROW_GAP}px apart (±2 for font metrics), a whitespace-only text part neither paints nor separates, opening a row's own growing body moves its trigger by 0px, an expanded body starts where its own row's text does (a tool's framed text 12px further in), an image tool result renders that image alone — bare, with no bookkeeping text and no hover shadow — at the row's indent and opens the app-wide preview overlay onto the file the tool read, an image that did NOT come back cleanly keeps that text instead, a tool card carries no copy/status footer row (its padding is the same top and bottom), and its output caps on a LINE boundary (11 whole 20px lines, the fade on the edge that hides content)`
  )
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
