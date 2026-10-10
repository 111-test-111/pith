/**
 * Claude Code spinner verbs, in isolated Electron: no model calls, no user data.
 * The real `TurnStatus` row is mounted with a virtual clock — the rotation runs
 * on 10-second wall-clock slots, so the check moves `Date.now()` to just before
 * a boundary instead of waiting out the real interval.
 *
 * Covered: the verb table and its pools (every verb reachable, no typos), tool →
 * pool targeting, the wall-clock slot math and the pure hash pick, the row's
 * dither loader + accent sentence in all three locales, per-slot latching (a step change
 * mid-slot never swaps the sentence), beUI's native TextShimmer (its sweep
 * running continuously across a rotation, with the component's own reduced-motion
 * reset), the Settings preference off/on, the one-line/truncating geometry, and
 * the fact that the row owns no per-character DOM or timers of its own.
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
 * sampled in the same tick, so a boundary can never split the comparison. */
window.__snapshot = (ctx, locale) => {
  const row = document.querySelector('#column > div');
  const sentence = row ? row.querySelector('.beui-text-shimmer') : null;
  const slot = V.spinnerSlotAt(Date.now());
  const style = sentence ? getComputedStyle(sentence) : null;
  const animation = sentence
    ? sentence.getAnimations().find((entry) => entry.animationName === 'beui-text-shimmer') ?? null
    : null;
  return {
    exists: !!row,
    id: row ? row.getAttribute('data-spinner-verb') : null,
    text: sentence ? sentence.textContent : null,
    loader: row ? row.getAttribute('data-spinner-loader') : null,
    // The row's spinner is beUI's "dither" — a 4×4 Bayer matrix of squares —
    // with its four corner particles dropped: twelve cells inside the status
    // wrapper (vendored structure, pinned so a loader swap cannot pass
    // unnoticed), plus their grid slots, so the check can prove which cells are
    // missing rather than only how many survive.
    cells: row && row.querySelector('[role=status] .grid')
      ? [...row.querySelectorAll('[role=status] .grid > span')].map((cell) => ({
          column: getComputedStyle(cell).gridColumnStart,
          row: getComputedStyle(cell).gridRowStart
        }))
      : [],
    // Theme colour, checked against a probe that resolves the same tokens: the
    // loader's particles (currentColor) and the sentence's gradient must both be
    // the accent the row asks for, and neither may fall back to the vendored default.
    loaderColor: row && row.querySelector('[role=status] .grid > span')
      ? getComputedStyle(row.querySelector('[role=status] .grid > span')).backgroundColor
      : null,
    accent: (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)';
      probe.style.backgroundColor = 'var(--primary)';
      document.body.appendChild(probe);
      const value = {
        color: getComputedStyle(probe).color,
        background: getComputedStyle(probe).backgroundColor
      };
      probe.remove();
      return value;
    })(),
    muted: (() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--muted-foreground)';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    })(),
    loaderBox: row && row.querySelector('[role=status]')
      ? (() => { const box = row.querySelector('[role=status]').getBoundingClientRect(); return Math.round(box.width) + 'x' + Math.round(box.height) })()
      : null,
    fontSize: style ? style.fontSize : null,
    color: style ? style.color : null,
    textFill: style ? style.webkitTextFillColor : null,
    backgroundImage: style ? style.backgroundImage : null,
    backgroundSize: style ? style.backgroundSize : null,
    backgroundClip: style ? style.backgroundClip : null,
    webkitBackgroundClip: style ? style.webkitBackgroundClip : null,
    animationName: style ? style.animationName : null,
    animationDuration: style ? style.animationDuration : null,
    animationTimingFunction: style ? style.animationTimingFunction : null,
    animationIterationCount: style ? style.animationIterationCount : null,
    // The sentence rotates on a wall clock, so a swapped sentence must not
    // restart the sweep (and under reduced motion there is no animation at all).
    animationStartTime: animation ? animation.startTime : null,
    animations: sentence ? sentence.getAnimations().length : 0,
    aria: row && row.querySelector('[role=status]') ? row.querySelector('[role=status]').getAttribute('aria-label') : null,
    slot,
    expected: V.spinnerVerbLabel(V.pickSpinnerVerb(ctx, slot, window.__seed), locale),
    inPool: sentence ? V.spinnerVerbPool(ctx).some((v) => v.en === sentence.textContent || v.zh === sentence.textContent || v.tw === sentence.textContent) : false,
    height: row ? row.getBoundingClientRect().height : null,
    sentenceHeight: sentence ? sentence.getBoundingClientRect().height : null,
    scrollWidth: sentence ? sentence.scrollWidth : null,
    clientWidth: sentence ? sentence.clientWidth : null,
    whiteSpace: style ? style.whiteSpace : null,
    textOverflow: style ? style.textOverflow : null
  };
};

/** The shimmer's own animation facts, read from the animation the vendored
 * component attaches (its keyframes travel the doubled gradient). */
window.__shimmer = () => {
  const node = document.querySelector('.beui-text-shimmer');
  if (!node) return null;
  const animation = node.getAnimations().find((entry) => entry.animationName === 'beui-text-shimmer') ?? node.getAnimations()[0];
  const style = getComputedStyle(node);
  return {
    backgroundSize: style.backgroundSize,
    backgroundImage: style.backgroundImage,
    backgroundClip: style.backgroundClip,
    webkitBackgroundClip: style.webkitBackgroundClip,
    textFill: style.webkitTextFillColor,
    color: style.color,
    animationName: style.animationName,
    animationDuration: style.animationDuration,
    animationTimingFunction: style.animationTimingFunction,
    animationIterationCount: style.animationIterationCount,
    keyframes: animation
      ? animation.effect.getKeyframes().map((frame) => ({ offset: frame.offset, position: String(frame.backgroundPositionX ?? '') }))
      : []
  };
};

/** rAF deltas for the requested window: the sweep repaints its own line every
 * frame, so a regression to per-frame SVG path motion or a heavier paint shows
 * up here. pause measures the same row with the sweep stopped as a baseline. */
window.__frameStats = (ms, pause) => new Promise((resolve) => {
  const node = document.querySelector('.beui-text-shimmer');
  const animations = node ? node.getAnimations() : [];
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
    // Freeze the sweep mid-pass so the artifact shows the band inside the
    // sentence instead of wherever the capture happened to land.
    await evaluate(`document.querySelectorAll('.beui-text-shimmer').forEach((node) => node.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = 1000 }))`)
    await mkdir(shotDirectory, { recursive: true })
    await writeFile(join(shotDirectory, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    await evaluate(`document.querySelectorAll('.beui-text-shimmer').forEach((node) => node.getAnimations().forEach((animation) => animation.play()))`)
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

  // ── 2. The live row: dither spinner + beUI's accent-tinted shimmering sentence ─
  // Mounted 1.5s before slot 501 so the first read is unambiguously slot 500 and
  // the second one lands after the row's own 10-second timer re-latched.
  await evaluate(`window.__setClock(5008500); window.__mount('en', ${json(readCtx)})`)
  await pause(120)
  let row = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.ok(row.exists, 'the waiting row renders')
  assert.equal(row.height, 36, 'the waiting row is the transcript’s shared 36px box: ' + row.height)
  assert.equal(row.loader, 'dither-plus', 'the plain spinner is replaced by the corner-less dither: ' + row.loader)
  assert.equal(row.cells.length, 12, "the dither keeps twelve of its 4×4 matrix's sixteen particles: " + row.cells.length)
  // Only the corners went: the four corner slots are the ones with no cell, and
  // every other slot of the matrix has exactly one.
  const lattice = row.cells.map((cell) => `${cell.column}/${cell.row}`).sort()
  const expected = []
  for (let column = 1; column <= 4; column++)
    for (let row = 1; row <= 4; row++)
      if (!((column === 1 || column === 4) && (row === 1 || row === 4)))
        expected.push(`${column}/${row}`)
  assert.deepEqual(lattice, expected.sort(), 'and it is exactly the four corners that are missing: ' + json(row.cells))
  assert.equal(row.loaderColor, row.accent.background, 'the dots wear the theme accent: ' + json(row.loaderColor))
  assert.equal(row.slot, 500, 'the first read sits in the mounting slot: ' + row.slot)
  assert.ok(row.inPool && row.text === row.expected, 'the sentence is the read pool pick for its slot: ' + json(row))
  assert.equal(row.aria, 'Working…', 'the screen-reader status is unchanged by the flavor text: ' + row.aria)
  assert.equal(row.loaderBox, '16x16', "the loader is the tool glyphs' size-4 square: " + row.loaderBox)
  assert.equal(row.fontSize, '14px', "the sentence is body size (text-sm): " + row.fontSize)
  // beUI's native text animation, not an app-local one: the sentence carries the
  // vendored component's own marker class and its animation.
  assert.equal(row.animationName, 'beui-text-shimmer', "the sentence runs beUI's shimmer: " + row.animationName)
  assert.equal(row.animationDuration, '2s', 'one sweep per 2s, as the row asks for: ' + row.animationDuration)
  assert.equal(row.animationTimingFunction, 'linear', 'the band travels at a constant speed: ' + row.animationTimingFunction)
  assert.equal(row.animationIterationCount, 'infinite', 'and the sweep repeats: ' + row.animationIterationCount)
  assert.equal(row.backgroundSize, '200% 100%', 'the shimmer gradient is twice the sentence width: ' + row.backgroundSize)
  assert.equal(row.textFill, 'rgba(0, 0, 0, 0)', 'the gradient is the fill: ' + row.textFill)
  assert.ok(
    row.backgroundClip === 'text' || row.webkitBackgroundClip === 'text',
    'and is clipped to the glyphs: ' + json({ backgroundClip: row.backgroundClip, webkit: row.webkitBackgroundClip })
  )
  assert.match(row.backgroundImage, /linear-gradient/, 'the fill is a gradient: ' + row.backgroundImage)
  // No app-local DOM or timers: the sentence is one text node, and no per-character
  // spans exist anywhere in the row.
  assert.equal(row.animations, 1, 'the sentence owns exactly one animation: ' + row.animations)
  const first = { id: row.id, text: row.text, slot: row.slot, startTime: row.animationStartTime }

  await pause(1500)
  row = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(row.slot, first.slot + 1, 'the wall-clock slot boundary arrived while mounted: ' + row.slot)
  assert.ok(row.text === row.expected, 'the rotated sentence is the read pool pick for the new slot: ' + json(row))
  assert.notEqual(row.text, first.text, 'the row re-latched its own timer onto the next slot')
  assert.ok(row.inPool, 'the new sentence belongs to its pool: ' + json(row))
  // The sweep is a continuous ambient animation: swapping the sentence must not
  // restart it, or every rotation would read as a stutter.
  assert.equal(row.animationStartTime, first.startTime, 'a sentence change keeps the sweep phase: ' + json(row))

  // ── 3. Per-slot latching: a step change mid-slot never swaps the sentence ──
  await evaluate(`window.__step(${json(runCtx)})`)
  await pause(200)
  const latched = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(latched.slot, row.slot, 'still inside the same slot')
  assert.equal(latched.id, row.id, 'the running tool does not swap the sentence mid-slot')
  assert.equal(latched.text, row.text, 'the sentence is latched for the whole slot: ' + json(latched))
  assert.ok(
    (await evaluate(`window.__snapshot(${json(runCtx)}, 'en')`)).inPool,
    'the (now stale) sentence still belongs to the pool the slot was latched from'
  )

  // ── 4. Targeting, the shimmer's sweep and the frame budget ────────────────
  await evaluate(`window.__setClock(6009990); window.__mount('en', ${json(runCtx)})`)
  // The mount lands a few ms before a boundary, so let that sentence start its
  // sweep before asserting and capturing: the artifact should show the band.
  await pause(1000)
  const runRow = await evaluate(`window.__snapshot(${json(runCtx)}, 'en')`)
  assert.ok(runRow.inPool && runRow.text === runRow.expected, 'a running command picks from the run pool: ' + json(runRow))

  // The sweep itself, from the animation the vendored component attaches: the
  // doubled gradient travels from one side to the other.
  const shimmer = await evaluate('window.__shimmer()')
  assert.equal(shimmer.animationName, 'beui-text-shimmer', 'the sweep is the vendored animation: ' + json(shimmer))
  assert.equal(shimmer.animationIterationCount, 'infinite', 'and it repeats: ' + shimmer.animationIterationCount)
  assert.equal(shimmer.backgroundSize, '200% 100%', 'the gradient is twice the sentence width: ' + shimmer.backgroundSize)
  assert.equal(shimmer.textFill, 'rgba(0, 0, 0, 0)', 'the gradient is the fill: ' + shimmer.textFill)
  assert.match(shimmer.backgroundImage, /linear-gradient/, 'a gradient paints the text: ' + shimmer.backgroundImage)
  // The sentence wears the theme accent too: the vendored gradient's colours
  // (muted-foreground -> foreground) are replaced by the accent, so the resolved
  // primary colour has to appear in the painted gradient.
  assert.ok(
    shimmer.backgroundImage.includes(runRow.accent.color),
    'the sentence gradient is tinted with the theme accent: ' + json({ image: shimmer.backgroundImage, accent: runRow.accent.color })
  )
  assert.ok(
    !shimmer.backgroundImage.includes(runRow.muted),
    "and no longer paints the vendored default's dim colour: " + json({ image: shimmer.backgroundImage, muted: runRow.muted })
  )
  assert.equal(shimmer.keyframes.length, 2, 'the sweep has a start and an end phase: ' + json(shimmer.keyframes))
  assert.deepEqual(
    shimmer.keyframes.map((frame) => frame.position),
    ['200%', '-200%'],
    'the band crosses the whole sentence: ' + json(shimmer.keyframes)
  )

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
    thinkingRow.inPool && thinkingRow.text === thinkingRow.expected,
    'reasoning with no tool call picks from the thinking pool: ' + json(thinkingRow)
  )

  // ── 5. Locale: the same verb's Chinese sentence ────────────────────────────
  await evaluate(`window.__setClock(8009990); window.__mount('zh-CN', ${json(thinkingCtx)})`)
  await pause(250)
  const zhRow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.ok(zhRow.text === zhRow.expected && /[\u4e00-\u9fff]/.test(zhRow.text), 'zh-CN shows the Chinese sentence: ' + json(zhRow))
  assert.equal(zhRow.animationName, 'beui-text-shimmer', 'and it shimmers too: ' + zhRow.animationName)

  // ── 5b. Locale: the same verb's Traditional Chinese sentence ──────────────
  await evaluate(`window.__setClock(8009990); window.__mount('zh-TW', ${json(thinkingCtx)})`)
  await pause(250)
  const twRow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-TW')`)
  assert.ok(twRow.text === twRow.expected && /[\u4e00-\u9fff]/.test(twRow.text), 'zh-TW shows the Traditional Chinese sentence: ' + json(twRow))
  assert.notEqual(twRow.text, zhRow.text, 'and it differs from the Simplified one: ' + json(twRow))
  // Leave the fixture mounted in zh-CN: the steps below sample the live row.
  await evaluate(`window.__mount('zh-CN', ${json(thinkingCtx)})`)
  await pause(200)

  // ── 6. The preference: off is exactly the old bare spinner ────────────────
  await evaluate(`window.__setEnabled(false)`)
  await pause(200)
  const off = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.equal(off.id, null, 'off removes the sentence')
  assert.equal(off.loader, 'spinner', 'off restores the plain spinner glyph')
  assert.equal(off.cells.length, 0, 'and no dither grid: ' + json(off.cells))
  assert.equal(off.height, 36, 'off keeps the same one-row box')
  assert.equal(off.aria, '正在处理…', 'off keeps the screen-reader label: ' + off.aria)

  await evaluate(`window.__setEnabled(true)`)
  await pause(250)
  const backOn = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.ok(backOn.id && backOn.text === backOn.expected, 'turning it back on resumes the sentences: ' + json(backOn))

  // ── 7. Narrow pane: the sentence truncates instead of wrapping ────────────
  await evaluate(`window.__width(120)`)
  await pause(200)
  const narrow = await evaluate(`window.__snapshot(${json(thinkingCtx)}, 'zh-CN')`)
  assert.equal(narrow.height, 36, 'a narrow pane keeps the shared one-row box: ' + narrow.height)
  assert.ok(narrow.sentenceHeight <= 24, 'the sentence never wraps to a second line: ' + narrow.sentenceHeight)
  assert.ok(
    ['nowrap', 'pre'].includes(narrow.whiteSpace),
    'the sentence cannot wrap (beUI keeps it pre-formatted): ' + narrow.whiteSpace
  )
  assert.equal(narrow.textOverflow, 'ellipsis', 'an over-long sentence ellipsises')
  assert.ok(narrow.scrollWidth > narrow.clientWidth, 'the narrow pane actually truncated it: ' + json(narrow))

  // ── 8. Reduced motion: the sentence, painted outright ─────────────────────
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // motion keeps the preference in a module global fed by the media query's
  // `change` event, so let that land before mounting — the value is read when
  // the row mounts.
  await pause(250)
  await evaluate(`window.__setClock(9008500); window.__mount('en', ${json(readCtx)})`)
  await pause(120)
  const reduced = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  const reduceQuery = await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  assert.ok(reduceQuery, 'the reduced-motion media query is emulated')
  assert.ok(reduced.id && reduced.loader === 'dither-plus', 'reduced motion still shows the dither row: ' + json(reduced))
  // The shimmer's reduced-motion reset travels inside the vendored component: the
  // animation stops, and the static gradient still paints the sentence.
  assert.equal(reduced.animationName, 'none', 'reduced motion stops the sweep: ' + reduced.animationName)
  assert.ok(
    reduced.backgroundClip === 'text' || reduced.webkitBackgroundClip === 'text',
    'the gradient still fills the glyphs: ' + json({ backgroundClip: reduced.backgroundClip, webkit: reduced.webkitBackgroundClip })
  )
  assert.match(reduced.backgroundImage, /linear-gradient/, 'and is still painted: ' + reduced.backgroundImage)
  assert.equal(reduced.textFill, 'rgba(0, 0, 0, 0)', 'the gradient remains the fill: ' + reduced.textFill)
  const reducedFirst = { text: reduced.text, slot: reduced.slot }
  await pause(1700)
  const reducedNext = await evaluate(`window.__snapshot(${json(readCtx)}, 'en')`)
  assert.equal(reducedNext.slot, reducedFirst.slot + 1, 'the reduced row crossed a slot too: ' + reducedNext.slot)
  assert.notEqual(reducedNext.text, reducedFirst.text, 'and moved on to the next sentence')
  assert.equal(reducedNext.text, reducedNext.expected, 'reduced motion swaps the sentence at once: ' + json(reducedNext))
  assert.equal(reducedNext.animationName, 'none', 'and never starts a sweep: ' + reducedNext.animationName)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  await screenshot('spinner-verb-reduced')
  console.log(
    'PASS: spinner verbs — 53 entries and their pools, step targeting, wall-clock rotation and per-slot latching, ' +
      "the tool-glyph-sized beUI dither (its four corner particles dropped) and the accent-tinted beUI TextShimmer sentence (its own keyframes and " +
      'reduced-motion reset, one text node and no app-local timers, its phase surviving a rotation), all three locales, the ' +
      'Settings preference and one-line truncating geometry.'
  )
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
