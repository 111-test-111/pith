/**
 * Claude Code spinner verbs, in isolated Electron: no model calls, no user data.
 * The real `TurnStatus` row is mounted with a virtual clock — the rotation runs
 * on 10-second wall-clock slots, so the check moves `Date.now()` to just before
 * a boundary instead of waiting out the real interval.
 *
 * Covered: the verb table and its pools (every verb reachable, no typos), tool →
 * pool targeting, the wall-clock slot math and the pure hash pick, the row's
 * dot-matrix loader + sentence in both locales, per-slot latching (a step change
 * mid-slot never swaps the sentence), the `TextScramble` transition on a slot
 * boundary (and its suppression under reduced motion), the Settings preference
 * off/on, the one-line/truncating geometry, and the sweep's coverage invariant.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-spinner-verbs-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__spinner-verbs-check.html'

// ── fixture ──────────────────────────────────────────────────────────────────
// `__setClock` installs a virtual `Date.now()` that runs at real speed from a
// chosen base, so mounting 11ms before a slot boundary observes a rotation.
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from '/src/i18n/index.tsx';
import { TurnStatus } from '/src/components/app/TurnStatus.tsx';
import * as V from '/src/lib/spinner-verbs.ts';
import '/src/styles.css';

const h = React.createElement;
const realNow = Date.now.bind(Date);
let clock = null;
Date.now = () => (clock ? clock() : realNow());
window.__setClock = (base) => { const t0 = performance.now(); clock = () => base + Math.floor(performance.now() - t0); };
window.V = V;

let root = null, setEnabled = null;
window.__seed = 'check-seed';
function Fixture({ initialStep }) {
  const [enabled, set] = V.useSpinnerVerbs();
  setEnabled = set;
  const [step, setStep] = React.useState(initialStep || V.THINKING_STEP);
  const [width, setWidth] = React.useState(360);
  window.__step = setStep;
  window.__width = setWidth;
  return h('div', { id: 'column', style: { width, padding: 8 } },
    h(TurnStatus, { step, seedKey: window.__seed }));
}

window.__mount = (locale, step) => {
  if (root) { root.unmount(); root = null; }
  localStorage.setItem('pi-app:locale', locale);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  // The step is the mount-time prop (the latch is created then); __step() is for
  // changing it mid-slot, which deliberately must NOT swap the sentence.
  flushSync(() => root.render(h(I18nProvider, null, h(Fixture, { initialStep: step }))));
};
window.__setEnabled = (next) => setEnabled(next);

/** One consistent read: the sentence and the slot it must correspond to are
 * sampled in the same tick, so a boundary can never split the comparison.
 * text is what the user sees (mid-scramble), label the value the row must
 * resolve to — TextScramble keeps the final value in its own sr-only span. */
window.__snapshot = (ctx, locale) => {
  const row = document.querySelector('#column > div');
  const sentence = row ? row.querySelector('.spinner-verb-flow') : null;
  const visual = sentence ? sentence.querySelector('[aria-hidden="true"]') : null;
  const srOnly = sentence ? sentence.querySelector('.sr-only') : null;
  const svg = row ? row.querySelector('svg') : null;
  const slot = V.spinnerSlotAt(Date.now());
  const text = visual ? visual.textContent : null;
  const label = srOnly ? srOnly.textContent : null;
  const style = sentence ? getComputedStyle(sentence) : null;
  return {
    exists: !!row,
    id: row ? row.getAttribute('data-spinner-verb') : null,
    text,
    label,
    scrambling: Boolean(text && label && text !== label),
    morph: !!(svg && svg.querySelector('title')),
    loader: row ? row.getAttribute('data-spinner-loader') : null,
    // The dot matrix is nine circles inside the status wrapper (vendored
    // structure, pinned so a loader swap cannot pass unnoticed).
    dots: row && row.querySelector('[role=status]') ? row.querySelectorAll('[role=status] .rounded-full').length : 0,
    loaderBox: row && row.querySelector('[role=status]')
      ? (() => { const box = row.querySelector('[role=status]').getBoundingClientRect(); return Math.round(box.width) + 'x' + Math.round(box.height) })()
      : null,
    fontSize: style ? style.fontSize : null,
    textFill: style ? style.webkitTextFillColor : null,
    animationName: style ? style.animationName : null,
    animationDuration: style ? style.animationDuration : null,
    aria: row && row.querySelector('[role=status]') ? row.querySelector('[role=status]').getAttribute('aria-label') : null,
    slot,
    expected: V.spinnerVerbLabel(V.pickSpinnerVerb(ctx, slot, window.__seed), locale),
    inPool: V.spinnerVerbPool(ctx).some((v) => v.en === label || v.zh === label),
    height: row ? row.getBoundingClientRect().height : null,
    sentenceHeight: sentence ? sentence.getBoundingClientRect().height : null,
    scrollWidth: sentence ? sentence.scrollWidth : null,
    clientWidth: sentence ? sentence.clientWidth : null,
    whiteSpace: style ? style.whiteSpace : null,
    textOverflow: style ? style.textOverflow : null
  };
};

/** rAF deltas for the requested window: the sweep repaints its own line every
 * frame, so a regression to per-frame SVG path motion or a heavier paint shows
 * up here. pause measures the same row with the sweep stopped as a baseline. */
window.__frameStats = (ms, pause) => new Promise((resolve) => {
  const sentence = document.querySelector('.spinner-verb-flow');
  const animations = sentence ? sentence.getAnimations() : [];
  animations.forEach((animation) => (pause ? animation.pause() : animation.play()));
  const deltas = [];
  let last = performance.now();
  const startedAt = last;
  const tick = (now) => {
    deltas.push(now - last);
    last = now;
    if (now - startedAt < ms) requestAnimationFrame(tick);
    else {
      animations.forEach((animation) => animation.play());
      const sorted = deltas.slice(1).sort((a, b) => a - b);
      resolve({
        frames: sorted.length,
        median: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
        max: Math.round(sorted[sorted.length - 1] * 10) / 10,
        over32: sorted.filter((delta) => delta > 32).length
      });
    }
  };
  requestAnimationFrame(tick);
});

/** Pure checks, all inside the page: the module is the source of truth. */
window.__pure = () => {
  const kinds = ['read', 'search', 'run', 'write', 'edit', 'fetch', 'other'];
  const covered = new Set(V.spinnerVerbPool({ mode: 'thinking' }).map((v) => v.id));
  for (const kind of kinds) for (const verb of V.spinnerVerbPool({ mode: 'tool', kind })) covered.add(verb.id);
  const poolOf = (ctx, predicate) => V.spinnerVerbPool(ctx).filter(predicate).map((v) => v.id);
  const readCtx = { mode: 'tool', kind: 'read' };
  const picks = [];
  // A seed whose read-pool pick differs across the three slots the render
  // check crosses, so a changed sentence is unambiguous evidence of a re-latch.
  let seed = null;
  for (let n = 0; n < 200 && !seed; n++) {
    const candidate = 'seed-' + n;
    const a = V.pickSpinnerVerb(readCtx, 500, candidate).id;
    const b = V.pickSpinnerVerb(readCtx, 501, candidate).id;
    const c = V.pickSpinnerVerb(readCtx, 502, candidate).id;
    if (a !== b && b !== c) seed = candidate;
  }
  for (let slot = 500; slot < 520; slot++) picks.push(V.pickSpinnerVerb(readCtx, slot, seed).id);
  return {
    count: V.SPINNER_VERBS.length,
    uniqueIds: new Set(V.SPINNER_VERBS.map((v) => v.id)).size,
    covered: covered.size,
    interval: V.SPINNER_VERB_INTERVAL_MS,
    slots: [V.spinnerSlotAt(0), V.spinnerSlotAt(9999), V.spinnerSlotAt(10000), V.spinnerSlotAt(19999)],
    kinds: {
      bash: V.spinnerToolKind('bash'),
      bash_task: V.spinnerToolKind('bash_task'),
      powershell: V.spinnerToolKind('powershell'),
      write: V.spinnerToolKind('write'),
      edit: V.spinnerToolKind('edit'),
      read: V.spinnerToolKind('read'),
      ls: V.spinnerToolKind('ls'),
      grep: V.spinnerToolKind('grep'),
      fffind: V.spinnerToolKind('fffind'),
      web_search: V.spinnerToolKind('web_search'),
      web_fetch: V.spinnerToolKind('web_fetch'),
      mcp: V.spinnerToolKind('mcp__context7'),
      todo: V.spinnerToolKind('todo_write')
    },
    frontier: [
      V.frontierStepContext([]),
      V.frontierStepContext([{ content: [{ type: 'thinking', thinking: 'x' }] }]),
      V.frontierStepContext([{ content: [{ type: 'thinking', thinking: 'x' }, { type: 'toolCall', id: '1', name: 'bash', arguments: {} }] }]),
      V.frontierStepContext([{ content: [{ type: 'toolCall', id: '1', name: 'bash', arguments: {} }] }, { content: [{ type: 'text', text: 'done' }] }]),
      V.frontierStepContext([{ content: [{ type: 'toolCall', id: '1', name: 'edit', arguments: {} }] }])
    ],
    deterministic: V.pickSpinnerVerb(readCtx, 500, seed).id === V.pickSpinnerVerb(readCtx, 500, seed).id,
    seedSpread: new Set(picks).size,
    poolDisjoint: poolOf(readCtx, (v) => true).length,
    thinkingPool: poolOf({ mode: 'thinking' }, (v) => true).length,
    seed
  };
};
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
      react(),
      tailwindcss(),
      {
        name: 'fixture',
        configureServer(server) {
          server.middlewares.use(fixturePath, async (_req, res, next) => {
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
  const main = join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:800,height:400,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`
  )
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolveEndpoint('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((entry) => entry.type === 'page')
    if (!page) await pause(50)
  }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveOpen) => ws.addEventListener('open', resolveOpen, { once: true }))
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
  })
  const send = (method, params = {}) =>
    new Promise((resolveSend, reject) => {
      const id = ++sequence
      pending.set(id, (message) => (message.error ? reject(message.error) : resolveSend(message.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await evaluate(`document.fonts.ready`)
  const shotDirectory = process.env.PI_SPINNER_VERB_SCREENSHOT_DIR
  const screenshot = async (name) => {
    if (!shotDirectory) return
    // Freeze the sweep mid-cycle so the artifact shows the band inside the
    // sentence instead of wherever the capture happened to land.
    await evaluate(`document.querySelectorAll('.spinner-verb-flow').forEach((n) => n.getAnimations().forEach((a) => { a.pause(); const timing = a.effect.getTiming(); a.currentTime = (typeof timing.duration === 'number' ? timing.duration : 1400) / 2 }))`)
    await mkdir(shotDirectory, { recursive: true })
    await writeFile(join(shotDirectory, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    await evaluate(`document.querySelectorAll('.spinner-verb-flow').forEach((n) => n.getAnimations().forEach((a) => a.play()))`)
  }

  // ── 1. The table, the pools and the pure logic ─────────────────────────────
  const pure = await evaluate('window.__pure()')
  assert.equal(pure.count, 53, 'the ported word list keeps its 53 entries')
  assert.equal(pure.uniqueIds, pure.count, 'verb ids are unique')
  assert.equal(pure.covered, pure.count, 'every verb is reachable from at least one pool')
  assert.equal(pure.interval, 10_000, 'one sentence per 10-second slot')
  assert.deepEqual(pure.slots, [0, 0, 1, 1], 'slots advance exactly on the interval')
  assert.deepEqual(pure.kinds, {
    bash: 'run',
    bash_task: 'run',
    powershell: 'run',
    write: 'write',
    edit: 'edit',
    read: 'read',
    ls: 'read',
    grep: 'search',
    fffind: 'search',
    web_search: 'search',
    web_fetch: 'fetch',
    mcp: 'other',
    todo: 'other'
  }, 'tool names map to the pool that matches what the call does: ' + JSON.stringify(pure.kinds))
  assert.deepEqual(pure.frontier, [
    { mode: 'thinking' },
    { mode: 'thinking' },
    { mode: 'tool', kind: 'run' },
    { mode: 'thinking' },
    { mode: 'tool', kind: 'edit' }
  ], 'the newest content part decides the frontier step')
  assert.ok(pure.deterministic, 'the same (context, slot, seed) always picks the same verb')
  assert.ok(pure.seedSpread > 1, 'different slots pick different verbs: ' + pure.seedSpread)
  assert.ok(pure.thinkingPool > 1, 'the thinking pool is populated')
  assert.ok(pure.seed, 'found a seed with distinct consecutive picks')

  const seed = pure.seed
  const readCtx = { mode: 'tool', kind: 'read' }
  const runCtx = { mode: 'tool', kind: 'run' }
  const thinkingCtx = { mode: 'thinking' }
  const json = (value) => JSON.stringify(value)
  await evaluate(`window.__seed = ${json(seed)}`)

  // ── 2. The live row: dot-matrix loader + a sentence, one line tall ─────────
  // Mounted 1.5s before slot 501 so the first read is unambiguously slot 500 and
  // the second one lands after the row's own 10-second timer re-latched.
  await evaluate(`window.__setClock(5008500); window.__mount('en', ${json(readCtx)})`)
  await pause(120)
  let row = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.ok(row.exists, 'the waiting row renders')
  assert.equal(row.height, 24, 'the row stays one 24px line: ' + row.height)
  assert.equal(row.loader, 'dot-matrix', 'the spinner is replaced by the beUI dot matrix')
  assert.equal(row.dots, 9, 'the dot matrix is the vendored 3x3 grid: ' + row.dots)
  assert.equal(row.slot, 500, 'the first read sits in the mounting slot: ' + row.slot)
  assert.ok(row.inPool && row.label === row.expected, 'the sentence is the read pool pick for its slot: ' + json(row))
  assert.equal(row.text, row.label, 'mounting paints the final sentence instead of scrambling it: ' + json(row))
  assert.equal(row.aria, 'Working…', 'the screen-reader status is unchanged by the flavor text: ' + row.aria)
  assert.equal(row.loaderBox, '16x16', "the loader is the tool glyphs' size-4 square: " + row.loaderBox)
  assert.equal(row.fontSize, '14px', "the sentence is body size (text-sm): " + row.fontSize)
  assert.equal(row.animationName, 'spinner-verb-flow', 'the sentence flows: ' + row.animationName)
  assert.equal(row.animationDuration, '1.4s', 'the sweep crosses in about a second and a half: ' + row.animationDuration)
  assert.equal(row.textFill, 'rgba(0, 0, 0, 0)', 'the sweep gradient is the fill: ' + row.textFill)
  const first = { id: row.id, label: row.label, slot: row.slot }

  await pause(1700)
  row = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(row.slot, first.slot + 1, 'the wall-clock slot boundary arrived while mounted: ' + row.slot)
  assert.ok(row.label === row.expected, 'the rotated sentence is the read pool pick for the new slot: ' + json(row))
  assert.notEqual(row.label, first.label, 'the row re-latched its own timer onto the next slot')
  // Caught mid-flight: the new sentence resolves through the scramble instead
  // of swapping outright, and the accessible value is already final.
  assert.ok(row.scrambling, 'the new sentence scrambles in: ' + json(row))
  assert.equal(row.label, row.expected, 'the accessible value resolves at once: ' + row.label)
  await pause(700)
  const resolved = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.ok(!resolved.scrambling && resolved.text === resolved.label, 'the scramble resolves to the full sentence: ' + json(resolved))

  // ── 3. Per-slot latching: a step change mid-slot never swaps the sentence ──
  await evaluate(`window.__step(${json(runCtx)})`)
  await pause(200)
  const latched = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(latched.slot, resolved.slot, 'still inside the same slot')
  assert.equal(latched.id, resolved.id, 'the running tool does not swap the sentence mid-slot')
  assert.equal(latched.label, resolved.label, 'the sentence is latched for the whole slot: ' + json(latched))
  assert.ok(
    (await evaluate(`window.__snapshot(${json(runCtx)}, 'en')`)).inPool,
    'the (now stale) sentence still belongs to the pool the slot was latched from'
  )

  // ── 4. Targeting: a new row's sentence comes from its own step's pool ──────
  await evaluate(`window.__setClock(6009990); window.__mount('en', ${json(runCtx)})`)
  // The mount lands a few ms before a boundary, so let that sentence resolve
  // before asserting and capturing: the artifact should show the flowing text.
  await pause(1000)
  const runRow = await evaluate(`window.__snapshot(${json(runCtx)}, 'en')`)
  assert.ok(runRow.inPool && runRow.label === runRow.expected, 'a running command picks from the run pool: ' + json(runRow))

  // The sweep must keep the gradient over the whole sentence: `background-clip:
  // text` paints ONLY the background, so a phase that moves the 200% image off
  // the box erases part of the text (a 200% start did exactly that).
  const flow = await evaluate(`(() => {
    const node = document.querySelector('.spinner-verb-flow');
    if (!node) return null;
    const animation = node.getAnimations().find((a) => a.animationName === 'spinner-verb-flow');
    return {
      backgroundSize: getComputedStyle(node).backgroundSize,
      frames: animation ? animation.effect.getKeyframes().map((frame) => String(frame.backgroundPositionX ?? '')) : []
    };
  })()`)
  assert.equal(flow.backgroundSize, '200% 100%', 'the sweep gradient is twice the sentence width: ' + json(flow))
  assert.equal(flow.frames.length, 2, 'the sweep has a start and an end phase: ' + json(flow))
  for (const position of flow.frames) {
    const percent = Number(position.replace('%', ''))
    assert.ok(
      Number.isFinite(percent) && percent >= 0 && percent <= 100,
      'every sweep phase keeps the doubled gradient over the whole sentence (0–100% only): ' + position
    )
  }
  // Frame budget: the sweep repaints one short line while the loader animates
  // opacity/scale only. Measured against the same row with the sweep paused, so
  // the numbers stay meaningful on a busy machine.
  const sweeps = await evaluate('window.__frameStats(1200, false)')
  const pausedFrames = await evaluate('window.__frameStats(1200, true)')
  assert.ok(sweeps.frames > 30, 'frames actually ran while the row animated: ' + sweeps.frames)
  assert.ok(
    sweeps.over32 <= pausedFrames.over32,
    'the sweep adds no long frame: ' + json({ sweeps, pausedFrames })
  )
  assert.ok(
    sweeps.median <= Math.max(20, pausedFrames.median * 1.5),
    'the sweep keeps the median frame in the 60Hz budget: ' + json({ sweeps, pausedFrames })
  )
  console.log(
    `  frames: sweep median=${sweeps.median}ms max=${sweeps.max}ms over-32ms=${sweeps.over32} | ` +
      `paused median=${pausedFrames.median}ms max=${pausedFrames.max}ms over-32ms=${pausedFrames.over32}`
  )
  await screenshot('spinner-verb-run')

  await evaluate(`window.__setClock(7009990); window.__mount('en', ${json(thinkingCtx)})`)
  await pause(250)
  const thinkingRow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'en')`)
  assert.ok(
    thinkingRow.inPool && thinkingRow.label === thinkingRow.expected,
    'reasoning with no tool call picks from the thinking pool: ' + json(thinkingRow)
  )

  // ── 5. Locale: the same verb's Chinese sentence ────────────────────────────
  await evaluate(`window.__setClock(8009990); window.__mount('zh-CN', ${json(thinkingCtx)})`)
  await pause(250)
  const zhRow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.ok(zhRow.label === zhRow.expected && /[\u4e00-\u9fff]/.test(zhRow.label), 'zh-CN shows the Chinese sentence: ' + json(zhRow))

  // ── 6. The preference: off is exactly the old bare spinner ────────────────
  await evaluate(`window.__setEnabled(false)`)
  await pause(200)
  const off = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.equal(off.id, null, 'off removes the sentence')
  assert.equal(off.loader, 'spinner', 'off restores the plain spinner glyph')
  assert.equal(off.dots, 0, 'and no dot grid: ' + off.dots)
  assert.equal(off.height, 24, 'off keeps the same one-line row')
  assert.equal(off.aria, '正在处理…', 'off keeps the screen-reader label: ' + off.aria)

  await evaluate(`window.__setEnabled(true)`)
  await pause(250)
  const backOn = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.ok(backOn.id && backOn.label === backOn.expected, 'turning it back on resumes the sentences: ' + json(backOn))

  // ── 7. Narrow pane: the sentence truncates instead of wrapping ────────────
  await evaluate(`window.__width(120)`)
  await pause(200)
  const narrow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.equal(narrow.height, 24, 'a narrow pane keeps the row one line tall: ' + narrow.height)
  assert.ok(narrow.sentenceHeight <= 24, 'the sentence never wraps to a second line: ' + narrow.sentenceHeight)
  assert.ok(
    ['nowrap', 'pre'].includes(narrow.whiteSpace),
    'the sentence cannot wrap (beUI keeps it pre-formatted): ' + narrow.whiteSpace
  )
  assert.equal(narrow.textOverflow, 'ellipsis', 'an over-long sentence ellipsises')
  assert.ok(narrow.scrollWidth > narrow.clientWidth, 'the narrow pane actually truncated it: ' + json(narrow))

  // ── 8. Reduced motion: no sweep, and no scramble either ───────────────────
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // motion keeps the preference in a module global fed by the media query's
  // `change` event, so let that land before mounting — the value is read when
  // the row mounts, and `TextScramble` reads it per change.
  await pause(250)
  await evaluate(`window.__setClock(9008500); window.__mount('en', ${json(readCtx)})`)
  await pause(120)
  const reduced = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  const reduceQuery = await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  assert.ok(reduceQuery, 'the reduced-motion media query is emulated')
  assert.ok(reduced.id && reduced.loader === 'dot-matrix', 'reduced motion still shows the dot-matrix row: ' + json(reduced))
  assert.equal(reduced.animationName, 'none', 'reduced motion stops the text sweep: ' + reduced.animationName)
  assert.notEqual(reduced.textFill, 'rgba(0, 0, 0, 0)', 'the sentence stays visible without the sweep: ' + reduced.textFill)
  const reducedFirst = { label: reduced.label, slot: reduced.slot }
  await pause(1700)
  const reducedNext = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(reducedNext.slot, reducedFirst.slot + 1, 'the reduced row crossed a slot too: ' + reducedNext.slot)
  assert.notEqual(reducedNext.label, reducedFirst.label, 'and moved on to the next sentence')
  assert.ok(!reducedNext.scrambling && reducedNext.text === reducedNext.label, 'reduced motion paints the new sentence at once: ' + json(reducedNext))

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  await screenshot('spinner-verb-reduced')
  console.log(
    'PASS: spinner verbs — 53 entries and their pools, step targeting, wall-clock rotation and per-slot latching, ' +
      'the tool-glyph-sized dot-matrix loader, body-size flowing text, the TextScramble transition (and its reduced-motion ' +
      'suppression), both locales, the Settings preference and one-line truncating geometry.'
  )
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
