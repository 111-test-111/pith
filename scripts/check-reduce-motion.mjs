/**
 * Disable animations (Settings → Appearance, `lib/reduce-motion.ts`) in isolated
 * Electron: no model calls, no user data. The real components are mounted
 * against a Vite dev server, so every assertion reads what the app renders.
 *
 * Covered:
 *
 * - The preference store: default off, `pi-app:reduce-motion`, the boot path
 *   (`initReduceMotion` re-applies from storage) and the live flip.
 * - Both halves of the switch: motion's global `skipAnimations` (what makes a
 *   flip instant for everything already mounted) and the CSS rule on
 *   `html[data-reduce-motion]` (transitions → 0ms, keyframes → none, the theme
 *   View Transition's snapshots included).
 * - The running-state exception, in all three of its forms: the vendored motion
 *   `Loader`'s rotation is re-added through Tailwind's own keyframes
 *   (`components/app/RunningLoader.tsx`), its dither PARTICLES keep their own
 *   staggered jump (patched in `components/motion/loader.tsx`), the waiting
 *   row's sentence keeps its sweep (`beui-text-shimmer`), and the app's/vendored
 *   beUI busy glyphs (`.animate-spin`) are exempt from the CSS rule.
 * - A real transcript entrance (beUI `Message animateIn`) landing instantly,
 *   measured against the same row mounted without `animateIn` as the resting
 *   oracle.
 * - The Settings row itself: label/description in both locales, the click
 *   flipping store + `<html>` + motion's flag + storage, and clicking back. The
 *   neighbouring Compact consecutive tool calls row (Appearance) is checked here too —
 *   its own store key and `<html>` attribute, which the transcript's row spacing
 *   is styled off (the spacing itself is pinned in `check-transcript-rhythm.mjs`).
 * - The shader backdrop's freeze (its `speed` is not motion's or CSS's to stop).
 * - The documented boundary: the OS `prefers-reduced-motion` preference keeps
 *   beUI's own behaviour (it drops a busy glyph's rotation rather than freezing
 *   it), which this switch deliberately does not override — while the app's own
 *   running `Loader` stays immune to both signals.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-reduce-motion-'))
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms))
const fixturePath = '/__reduce-motion-check.html'
const json = (value) => JSON.stringify(value)
/** One comparable signature for a sampled element's animated pose. */
const pose = (sample) => sample.computedTransform + '|' + sample.computedOpacity

// ── fixture ──────────────────────────────────────────────────────────────────
// Every mount is a real app surface. `Probe` is the only artificial node: it
// renders the store's value into a data attribute, since a hook cannot be read
// from outside React.
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider } from 'next-themes';
import { MotionGlobalConfig } from 'motion/react';
import { I18nProvider } from '/src/i18n/index.tsx';
import { AppearanceSection } from '/src/components/app/settings/AppearanceSection.tsx';
import { TurnStatus } from '/src/components/app/TurnStatus.tsx';
import { RunningLoader } from '/src/components/app/RunningLoader.tsx';
import { ShaderBackdrop } from '/src/components/app/ShaderBackdrop.tsx';
import { ToolResult } from '/src/components/agents/tool-result.tsx';
import { Message } from '/src/components/agents/message.tsx';
import { THINKING_STEP } from '/src/lib/spinner-verbs.ts';
import * as R from '/src/lib/reduce-motion.ts';
import en from '/src/i18n/locales/en.ts';
import zhCN from '/src/i18n/locales/zh-CN.ts';
import '/src/styles.css';

const h = React.createElement;
let root = null;

window.__dict = { en: en, zhCN: zhCN };

function Probe() {
  return h('span', { id: 'motion-probe', 'data-reduce-motion': String(R.useReduceMotion()) });
}

function body(kind) {
  if (kind === 'settings') {
    return h(AppearanceSection, { accent: 'indigo', onAccentChange: function () {}, uiStyle: 'square', onUiStyleChange: function () {} });
  }
  if (kind === 'shader') {
    return h('div', { style: { position: 'relative', width: 320, height: 200 } }, h(ShaderBackdrop));
  }
  if (kind === 'tool') {
    return h(ToolResult, { title: 'bash', status: 'running' }, 'output');
  }
  return h('div', null,
    h(TurnStatus, { step: THINKING_STEP, seedKey: 'check-seed' }),
    h(RunningLoader, { variant: 'spinner', size: 16, label: 'spin' }),
    h(RunningLoader, { variant: 'dither-plus', size: 16, label: 'pulse' }));
}

function render(node) {
  if (root) { root.unmount(); root = null; }
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  flushSync(function () {
    root.render(h(ThemeProvider, { attribute: 'class', defaultTheme: 'light' },
      h(I18nProvider, null, h(React.Fragment, null, h(Probe), node))));
  });
}

window.__mount = function (kind, locale) {
  localStorage.setItem('pi-app:locale', locale || 'en');
  render(body(kind));
};

window.__state = function () {
  const probe = document.getElementById('motion-probe');
  return {
    dataset: document.documentElement.dataset.reduceMotion === undefined ? null : document.documentElement.dataset.reduceMotion,
    stored: localStorage.getItem('pi-app:reduce-motion'),
    skip: MotionGlobalConfig.skipAnimations === undefined ? null : MotionGlobalConfig.skipAnimations,
    probe: probe ? probe.getAttribute('data-reduce-motion') : null
  };
};

window.__set = function (next) { R.setReduceMotion(next); };
/** The app's boot path, as main.tsx runs it. */
window.__boot = function () { R.initReduceMotion(); };
/** The boot path from scratch: throw the applied state away, then re-read storage. */
window.__reboot = function () { R.applyReduceMotion(false); R.initReduceMotion(); };

function readNode(el) {
  if (!el) return null;
  const style = getComputedStyle(el);
  return {
    transform: el.style.transform,
    inlineOpacity: el.style.opacity,
    computedTransform: style.transform,
    computedOpacity: style.opacity,
    animationName: style.animationName,
    animationDuration: style.animationDuration,
    animationIterationCount: style.animationIterationCount,
    transitionDuration: style.transitionDuration,
    running: el.getAnimations().filter(function (a) { return a.playState === 'running' })
      .map(function (a) { return a.animationName })
  };
}

window.__sample = function (selector, ms) {
  return new Promise(function (done) {
    const read = function () { return readNode(document.querySelector(selector)); };
    const first = read();
    requestAnimationFrame(function () {
      const second = read();
      setTimeout(function () { done({ first: first, second: second, third: read() }); }, ms);
    });
  });
};

window.__cells = function () {
  // Computed, not inline: motion drives these cells through the Web Animations
  // API, so an inline style may never appear.
  return [...document.querySelectorAll('[data-spinner-loader] [role=status] .grid > span')]
    .map(function (el) { return getComputedStyle(el).opacity; });
};

/** One entry per dither particle: its opacity plus the animation carrying it. */
window.__cellStyles = function () {
  return [...document.querySelectorAll('[data-spinner-loader] [role=status] .grid > span')]
    .map(function (el) {
      const style = getComputedStyle(el);
      return {
        opacity: style.opacity,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
        running: el.getAnimations().filter(function (a) { return a.playState === 'running' })
          .map(function (a) { return a.animationName; })
      };
    });
};

window.__reveal = function (label) {
  const el = [...document.querySelectorAll('[role=checkbox]')]
    .find(function (node) { return node.getAttribute('aria-label') === label; });
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const box = el.getBoundingClientRect();
  return {
    label: el.getAttribute('aria-label'),
    checked: el.getAttribute('aria-checked'),
    onScreen: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    x: box.x + box.width / 2,
    y: box.y + box.height / 2
  };
};

window.__checkboxes = function () {
  return [...document.querySelectorAll('[role=checkbox]')].map(function (el) {
    const box = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label'),
      checked: el.getAttribute('aria-checked'),
      transitionDuration: getComputedStyle(el).transitionDuration,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    };
  });
};

window.__text = function () { return document.body.textContent; };

/** A real transcript entrance: the same row with and without \`animateIn\`. */
window.__entrance = function (animateIn) {
  return new Promise(function (done) {
    render(h(Message, { from: 'assistant', animateIn: animateIn }, h('span', null, 'hi')));
    const read = function () { return readNode(document.querySelector('[data-slot=message]')); };
    const first = read();
    requestAnimationFrame(function () {
      const second = read();
      setTimeout(function () {
        const t50 = read();
        setTimeout(function () {
          const t120 = read();
          setTimeout(function () { done({ first: first, second: second, t50: t50, t120: t120, third: read() }); }, 120);
        }, 70);
      }, 50);
    });
  });
};

window.__shader = function () {
  const node = document.querySelector('[data-shader-backdrop]');
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return {
    motion: node.getAttribute('data-shader-motion'),
    clip: { x: Math.round(box.x + 8), y: Math.round(box.y + 8), width: 240, height: 160, scale: 1 }
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
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:700,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`
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
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const shot = async (clip) => (await send('Page.captureScreenshot', { clip, format: 'png' })).data
  const screenshotDirectory = process.env.PI_REDUCE_MOTION_SCREENSHOT_DIR
  const screenshot = async (name) => {
    if (!screenshotDirectory) return
    await mkdir(screenshotDirectory, { recursive: true })
    await writeFile(join(screenshotDirectory, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await send('Runtime.enable')
  await evaluate(`document.fonts.ready`)

  const dict = await evaluate(`window.__dict`)

  // ── 1. Both dictionaries carry the switch (and say different things) ───────
  for (const key of ['settings.interfaceGroup', 'settings.reduceMotion', 'settings.reduceMotionDesc']) {
    assert.ok(dict.en[key] && dict.zhCN[key], `${key} exists in both locales`)
    assert.notEqual(dict.en[key], dict.zhCN[key], `${key} is actually translated`)
  }

  // ── 2. Boot: off by default, and the boot path applies it ─────────────────
  await evaluate(`window.__boot()`)
  await evaluate(`window.__mount('row', 'en')`)
  await pause(150)
  let state = await evaluate(`window.__state()`)
  assert.equal(state.dataset, 'false', 'the switch advertises its state on <html>: ' + json(state))
  assert.equal(state.stored, null, 'nothing is stored until the user flips it: ' + json(state))
  assert.equal(state.skip, false, "motion's global flag is off while the switch is off: " + json(state))
  assert.equal(state.probe, 'false', 'and the store reports the same value to React: ' + json(state))

  // ── 3. Switch off: the real surfaces animate ─────────────────────────────
  const rowOff = await evaluate(`window.__sample('[data-spinner-loader] .beui-text-shimmer', 300)`)
  assert.equal(rowOff.first.animationName, 'beui-text-shimmer', 'the waiting sentence runs its sweep: ' + json(rowOff.first))
  assert.ok(rowOff.first.running.includes('beui-text-shimmer'), 'and the sweep is running')
  const cellsOffA = await evaluate(`window.__cells()`)
  await pause(500)
  const cellsOffB = await evaluate(`window.__cells()`)
  assert.equal(cellsOffA.length, 12, 'the waiting row still shows the corner-less dither: ' + cellsOffA.length)
  assert.ok(cellsOffA.some((value, index) => value !== cellsOffB[index]), 'the dither pulses: ' + json([cellsOffA, cellsOffB]))
  const svgOff = await evaluate(`window.__sample('[aria-label="spin"] svg', 300)`)
  assert.notEqual(svgOff.first.computedTransform, svgOff.third.computedTransform, 'the vendored loader rotates: ' + json(svgOff))

  // The resting oracle: the same row mounted without `animateIn` never moves.
  const entranceResting = await evaluate(`window.__entrance(false)`)
  const entranceOff = await evaluate(`window.__entrance(true)`)
  assert.notEqual(
    pose(entranceOff.first),
    pose(entranceResting.first),
    'an entrance starts away from its resting state while the switch is off: ' + json({ entranceOff: entranceOff.first, resting: entranceResting.first })
  )
  assert.notEqual(
    pose(entranceOff.t50),
    pose(entranceOff.third),
    'and is still on its way 190ms later (a real spring ran): ' + json(entranceOff)
  )

  await evaluate(`window.__mount('tool', 'en')`)
  await pause(120)
  const glyphOff = await evaluate(`window.__sample('.animate-spin', 300)`)
  assert.equal(glyphOff.first.animationName, 'spin', "a running tool row's busy glyph spins: " + json(glyphOff.first))
  assert.ok(glyphOff.first.running.includes('spin'), 'and that rotation is running')

  // ── 4. Flip it on: store, <html>, motion's flag, and persistence ───────────
  await evaluate(`window.__set(true)`)
  await pause(150)
  state = await evaluate(`window.__state()`)
  assert.equal(state.dataset, 'true', 'the switch paints <html data-reduce-motion>: ' + json(state))
  assert.equal(state.skip, true, "motion's global skip flag is set: " + json(state))
  assert.equal(state.stored, 'on', 'and the preference is persisted: ' + json(state))
  assert.equal(state.probe, 'true', 'the store reports the same value to React: ' + json(state))

  await evaluate(`window.__reboot()`)
  assert.equal((await evaluate(`window.__state()`)).skip, true, 'boot re-applies the stored preference')
  await evaluate(`window.__set(false)`)

  // ── 5. Switch on: instant everywhere, except the running indicators ────────
  // A fresh mount, because motion's flag is read when an animation is created:
  // an animation already in flight finishes (which is exactly why the switch is
  // instant for everything on screen rather than freezing it mid-flight).
  await evaluate(`window.__set(true)`)
  await evaluate(`window.__mount('row', 'en')`)
  await pause(150)
  const rowOn = await evaluate(`window.__sample('[data-spinner-loader] .beui-text-shimmer', 300)`)
  assert.equal(rowOn.first.animationName, 'beui-text-shimmer', 'the sentence sweep is exempt from the switch: ' + json(rowOn.first))
  assert.ok(rowOn.first.running.includes('beui-text-shimmer'), 'and keeps running: ' + json(rowOn.first.running))
  assert.equal(rowOn.first.transitionDuration, '0s', 'while transitions still are disabled: ' + json(rowOn.first))
  const svgOn = await evaluate(`window.__sample('[aria-label="spin"] svg', 300)`)
  assert.equal(svgOn.first.computedTransform, svgOn.third.computedTransform, "the loader's own rotation is frozen: " + json(svgOn))

  // …but the running indicator keeps moving, through Tailwind's own keyframes:
  // the particles jump themselves (each carrying the vendored Bayer stagger)…
  const cellsOn = await evaluate(`window.__cellStyles()`)
  await pause(500)
  const cellsOnLater = await evaluate(`window.__cellStyles()`)
  assert.equal(cellsOn.length, 12, 'the waiting row keeps its twelve-particles-plus dither: ' + cellsOn.length)
  assert.ok(
    cellsOn.every((cell) => cell.animationName === 'pulse'),
    "every particle carries Tailwind's own pulse: " + json(cellsOn.map((cell) => cell.animationName))
  )
  assert.ok(
    cellsOn.every((cell) => cell.running.includes('pulse')),
    'and every one of them is running: ' + json(cellsOn.map((cell) => cell.running))
  )
  assert.ok(
    cellsOn.some((cell, index) => cell.opacity !== cellsOnLater[index].opacity),
    'the particles really jump: ' + json([cellsOn.map((cell) => cell.opacity), cellsOnLater.map((cell) => cell.opacity)])
  )
  assert.equal(
    new Set(cellsOn.map((cell) => cell.animationDelay)).size > 1,
    true,
    'and keep the Bayer stagger: ' + json(cellsOn.map((cell) => cell.animationDelay))
  )
  assert.equal(
    new Set(cellsOn.map((cell) => cell.animationDuration)).size,
    1,
    'at one vendored duration: ' + json(cellsOn.map((cell) => cell.animationDuration))
  )
  assert.equal(cellsOn[0].animationDuration, '1s', 'which is the loader default speed: ' + cellsOn[0].animationDuration)
  const spinOn = await evaluate(`window.__sample('[aria-label="spin"]', 300)`)
  assert.equal(spinOn.first.animationName, 'spin', 'the spinner Loader keeps spinning: ' + json(spinOn.first))
  assert.ok(spinOn.first.running.includes('spin'), 'and it is running')
  assert.notEqual(spinOn.first.computedTransform, spinOn.third.computedTransform, 'the spin really rotates: ' + json(spinOn))

  const entranceRestingOn = await evaluate(`window.__entrance(false)`)
  const entranceOn = await evaluate(`window.__entrance(true)`)
  // A skipped animation is resolved on the frame it would have started on, so
  // "instant" means: motion's own target is final on the first frame, and the
  // element is at rest from the next one on — never a mid-animation pose.
  assert.equal(
    entranceOn.second.transform,
    entranceRestingOn.second.transform,
    "motion's target is final on the first frame: " + json({ entranceOn: entranceOn.second, resting: entranceRestingOn.second })
  )
  assert.equal(
    pose(entranceOn.t50),
    pose(entranceRestingOn.t50),
    'an entrance is at rest one frame later: ' + json({ entranceOn: entranceOn.t50, resting: entranceRestingOn.t50 })
  )
  assert.equal(pose(entranceOn.t50), pose(entranceOn.third), 'and never moves after that: ' + json(entranceOn))

  await evaluate(`window.__mount('tool', 'en')`)
  await pause(120)
  const glyphOn = await evaluate(`window.__sample('.animate-spin', 300)`)
  assert.equal(glyphOn.first.animationName, 'spin', 'a busy glyph is exempt from the CSS rule: ' + json(glyphOn.first))
  assert.ok(glyphOn.first.running.includes('spin'), 'and keeps running')
  assert.notEqual(glyphOn.first.computedTransform, glyphOn.third.computedTransform, 'it really rotates: ' + json(glyphOn))

  // ── 6. The Settings row drives all of that ────────────────────────────────
  await evaluate(`window.__mount('settings', 'en')`)
  await pause(200)
  let boxes = await evaluate(`window.__checkboxes()`)
  let reduceBox = boxes.find((box) => box.label === dict.en['settings.reduceMotion'])
  assert.ok(reduceBox, 'Settings → Appearance carries the switch: ' + json(boxes))
  assert.equal(reduceBox.label, 'Disable animations', 'and it is labelled from the dictionary')
  assert.equal(reduceBox.checked, 'true', 'the row renders the live preference: ' + json(reduceBox))
  assert.equal(reduceBox.transitionDuration, '0s', 'its own hover transition is collapsed too: ' + reduceBox.transitionDuration)
  assert.ok(
    (await evaluate(`window.__text()`)).includes(dict.en['settings.interfaceGroup']),
    "the section is grouped under the locale's own heading"
  )
  reduceBox = await evaluate(`window.__reveal(${json(dict.en['settings.reduceMotion'])})`)
  assert.equal(reduceBox.onScreen, true, 'the switch is on screen before clicking it: ' + json(reduceBox))
  await clickAt(reduceBox.x, reduceBox.y)
  await pause(250)
  state = await evaluate(`window.__state()`)
  assert.equal(state.dataset, 'false', 'clicking the row turns the switch off: ' + json(state))
  assert.equal(state.skip, false, "and clears motion's flag: " + json(state))
  assert.equal(state.stored, 'off', 'and persists it: ' + json(state))

  reduceBox = await evaluate(`window.__reveal(${json(dict.en['settings.reduceMotion'])})`)
  await clickAt(reduceBox.x, reduceBox.y)
  await pause(250)
  state = await evaluate(`window.__state()`)
  assert.equal(state.dataset, 'true', 'clicking again turns it back on: ' + json(state))
  assert.equal(state.skip, true, "with motion's flag set: " + json(state))
  boxes = await evaluate(`window.__checkboxes()`)
  reduceBox = boxes.find((box) => box.label === dict.en['settings.reduceMotion'])
  assert.equal(reduceBox.checked, 'true', 'and the row shows the new state: ' + json(reduceBox))

  // The section's newer transcript switch rides the same pattern — its own
  // `pi-app:compact-tools` key behind its own `<html>` attribute, which is what
  // the transcript's row spacing is styled off (the spacing itself is pinned in
  // check-transcript-rhythm.mjs).
  let compactBox = boxes.find((box) => box.label === dict.en['settings.compactTools'])
  assert.ok(compactBox, 'Settings → Appearance also carries the compact-tool-calls switch: ' + json(boxes))
  compactBox = await evaluate(`window.__reveal(${json(dict.en['settings.compactTools'])})`)
  await clickAt(compactBox.x, compactBox.y)
  await pause(250)
  assert.equal(
    await evaluate('document.documentElement.dataset.compactTools'),
    'true',
    'the compact switch reaches <html>'
  )
  assert.equal(await evaluate(`localStorage.getItem('pi-app:compact-tools')`), 'on', 'and persists')
  boxes = await evaluate(`window.__checkboxes()`)
  compactBox = boxes.find((box) => box.label === dict.en['settings.compactTools'])
  assert.equal(compactBox.checked, 'true', 'the compact row shows the new state: ' + json(compactBox))
  compactBox = await evaluate(`window.__reveal(${json(dict.en['settings.compactTools'])})`)
  await clickAt(compactBox.x, compactBox.y)
  await pause(250)
  assert.equal(
    await evaluate('document.documentElement.dataset.compactTools'),
    'false',
    'clicking again turns the compact switch back off'
  )

  await evaluate(`window.__mount('settings', 'zh-CN')`)
  await pause(200)
  const zhBoxes = await evaluate(`window.__checkboxes()`)
  assert.ok(
    zhBoxes.some((box) => box.label === dict.zhCN['settings.reduceMotion']),
    'the row is localised (label): ' + json(zhBoxes)
  )
  assert.ok((await evaluate(`window.__text()`)).includes(dict.zhCN['settings.interfaceGroup']), 'the row is localised (heading)')
  assert.ok((await evaluate(`window.__text()`)).includes(dict.zhCN['settings.reduceMotionDesc']), 'the row is localised (description)')
  assert.ok(
    (await evaluate(`window.__text()`)).includes(dict.zhCN['settings.compactToolsDesc']),
    'the compact switch is localised (description)'
  )
  await screenshot('reduce-motion-settings-zh')

  // ── 7. The shader backdrop freezes: it is neither motion nor CSS ───────────
  await evaluate(`window.__set(false)`)
  await evaluate(`window.__mount('shader', 'en')`)
  await pause(250)
  const shader = await evaluate(`window.__shader()`)
  assert.equal(shader.motion, 'live', 'the shader reports live motion: ' + json(shader))
  const shaderLiveA = await shot(shader.clip)
  await pause(450)
  const shaderLiveB = await shot(shader.clip)
  assert.notEqual(shaderLiveA, shaderLiveB, 'the shader animates while the switch is off')
  await evaluate(`window.__set(true)`)
  await pause(450)
  assert.equal((await evaluate(`window.__shader()`)).motion, 'frozen', 'the switch freezes the shader: ' + json(await evaluate(`window.__shader()`)))
  const shaderFrozenA = await shot(shader.clip)
  await pause(450)
  const shaderFrozenB = await shot(shader.clip)
  assert.equal(shaderFrozenA, shaderFrozenB, 'and the shader really stops moving')
  await screenshot('reduce-motion-shader-frozen')

  // ── 8. The OS preference keeps its own (beUI) behaviour ───────────────────
  // Pinned on purpose: a busy glyph drops its rotation under the OS setting
  // (beUI's own reduced-motion design), which this app switch does not override.
  // The app's own running Loader is immune to both signals.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pause(250)
  await evaluate(`window.__mount('tool', 'en')`)
  await pause(120)
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.animate-spin'))`),
    false,
    'the OS preference keeps beUI behaviour: a busy glyph has no rotation there'
  )
  await evaluate(`window.__mount('row', 'en')`)
  await pause(120)
  const cellsReduced = await evaluate(`window.__cellStyles()`)
  await pause(500)
  const cellsReducedLater = await evaluate(`window.__cellStyles()`)
  assert.ok(
    cellsReduced.every((cell) => cell.running.includes('pulse')),
    "the waiting row's particles are never stilled by either signal: " + json(cellsReduced.map((cell) => cell.running))
  )
  assert.ok(
    cellsReduced.some((cell, index) => cell.opacity !== cellsReducedLater[index].opacity),
    'and they keep jumping: ' + json([cellsReduced.map((cell) => cell.opacity), cellsReducedLater.map((cell) => cell.opacity)])
  )
  const spinReduced = await evaluate(`window.__sample('[aria-label="spin"]', 260)`)
  assert.ok(
    spinReduced.first.running.includes('spin'),
    "the app's spinner keeps rotating under both signals: " + json(spinReduced.first.running)
  )
  await send('Emulation.setEmulatedMedia', { features: [] })
  await pause(200)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log(
    'PASS: reduce motion — the preference store and its boot path, motion\'s global skip flag, the CSS half ' +
      '(transitions, keyframes, the theme View Transition) with its .animate-spin/.animate-pulse exemption, the ' +
      'running-state exception on the vendored Loader and on the app\'s busy glyphs, a real transcript entrance landing ' +
      'instantly (measured against its own resting state), the Settings row in both locales, the shader freeze, and the ' +
      'documented OS-preference boundary.'
  )
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
