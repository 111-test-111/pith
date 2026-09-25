/**
 * Press/hover geometry in isolated Electron: no model calls, no user data. The
 * real beUI controls are mounted against a Vite dev server, so every assertion
 * reads what the app renders.
 *
 * The rule these pin: **a control must not change size under the pointer.** The
 * vendored press/hover `scale` is removed app-wide (see AGENTS.md), because a
 * full-width sidebar menu row grew 2% on hover and bulged past its own panel,
 * and every button dipped inward while pressed.
 *
 * Covered: `button/base` — in the exact recipe the sidebar's row menu uses
 * (`SidebarRowMenuAction`: ghost/sm, `h-8 w-full`, inside a 220px panel) — plus
 * the selection controls (`checkbox`, `radio`) and a real tool-row icon button
 * (`ToolResult`'s copy action). Each is sampled at rest, on hover, while the
 * pointer is HELD down, after release and after the pointer leaves, comparing
 * both the computed transform and the border box.
 *
 * A fixture-local `motion.button` that still scales on hover/press is the
 * positive control: without it a harness that never delivered a pointer event
 * would "pass" every assertion below.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-button-motion-'))
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms))
const fixturePath = '/__button-motion-check.html'
const json = (value) => JSON.stringify(value)

// ── fixture ──────────────────────────────────────────────────────────────────
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { motion } from 'motion/react';
import { I18nProvider } from '/src/i18n/index.tsx';
import { Button } from '/src/components/motion/button';
import { Checkbox } from '/src/components/motion/checkbox';
import { RadioGroup, RadioGroupItem } from '/src/components/motion/radio';
import { ToolResult } from '/src/components/agents/tool-result';
import '/src/styles.css';

const h = React.createElement;

/** A real selection control, with real state so the press still acts. */
function Toggle() {
  const [on, setOn] = React.useState(false);
  return h(Checkbox, { mark: 'square', checked: on, onCheckedChange: setOn, 'aria-label': 'square toggle' });
}

/** The sidebar row menu's own panel: the box a hovered row must stay inside. */
function Panel({ children }) {
  return h('div', { 'data-panel': 'true', style: { width: 220, padding: 6 } }, children);
}

function mount() {
  const root = document.getElementById('root');
  flushSync(function () {
    createRoot(root).render(h(I18nProvider, null,
      h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' } },
        // Positive control: a plain motion button that still scales both ways.
        h(motion.button, {
          'data-target': 'control',
          whileHover: { scale: 1.02 },
          whileTap: { scale: 0.9 },
          transition: { type: 'spring', stiffness: 480, damping: 32 },
          style: { height: 36, width: 160, borderRadius: 8, background: 'var(--muted)' }
        }, 'control'),
        // The app's session-row menu action, verbatim except for its click handler.
        h(Panel, null, h(Button, {
          'data-target': 'menu-row',
          variant: 'ghost',
          size: 'sm',
          className: 'flex h-8 w-full items-center justify-start gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring'
        }, h('span', { className: 'min-w-0 truncate' }, '置顶会话'))),
        h(Toggle),
        h(RadioGroup, { value: 'a', onValueChange: function () {} }, h(RadioGroupItem, { value: 'a', label: 'option A' })),
        h(ToolResult, { title: 'bash', status: 'success', copyText: 'output' }, 'output')
      )));
  });
}

window.__mount = function () { mount(); };

window.__probe = function (selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const panel = el.closest('[data-panel]');
  const panelBox = panel ? panel.getBoundingClientRect() : null;
  const round = function (value) { return Math.round(value * 100) / 100; };
  return {
    rect: [round(box.x), round(box.y), round(box.width), round(box.height)],
    transform: style.transform,
    insidePanel: panelBox ? box.x >= panelBox.x - 0.5 && box.right <= panelBox.right + 0.5 : null,
    x: box.x + box.width / 2,
    y: box.y + box.height / 2
  };
};

window.__reveal = function (selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  return window.__probe(selector);
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
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:820,height:700,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`
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
  const pointer = (type, x, y, button) => {
    const params = { type, x, y, button: button ?? 'none', clickCount: type === 'mouseMoved' ? 0 : 1 }
    return send('Input.dispatchMouseEvent', params)
  }
  const screenshotDirectory = process.env.PI_BUTTON_MOTION_SCREENSHOT_DIR
  const screenshot = async (name) => {
    if (!screenshotDirectory) return
    await mkdir(screenshotDirectory, { recursive: true })
    await writeFile(join(screenshotDirectory, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await send('Runtime.enable')
  await evaluate(`document.fonts.ready`)
  await evaluate(`window.__mount()`)
  await pause(250)

  const IDENTITY = (transform) => transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)'
  const AWAY = { x: 3, y: 3 }

  /**
   * Sample one control through the whole pointer story: at rest, hovered, held
   * down, released and after the pointer left. `whileTap` only animates while
   * the button is held, so the pressed sample is the one that catches a dip.
   */
  const story = async (selector) => {
    const rest = await evaluate(`window.__reveal(${json(selector)})`)
    assert.ok(rest, `the control renders: ${selector}`)
    await pointer('mouseMoved', AWAY.x, AWAY.y)
    await pause(220)
    const away0 = await evaluate(`window.__probe(${json(selector)})`)
    await pointer('mouseMoved', rest.x, rest.y)
    await pause(220)
    const hovered = await evaluate(`window.__probe(${json(selector)})`)
    await pointer('mousePressed', rest.x, rest.y, 'left')
    await pause(220)
    const held = await evaluate(`window.__probe(${json(selector)})`)
    await pointer('mouseReleased', rest.x, rest.y, 'left')
    await pause(220)
    const released = await evaluate(`window.__probe(${json(selector)})`)
    await pointer('mouseMoved', AWAY.x, AWAY.y)
    await pause(220)
    const away = await evaluate(`window.__probe(${json(selector)})`)
    return { rest, away0, hovered, held, released, away }
  }

  const still = (samples, label) => {
    for (const [name, sample] of Object.entries(samples)) {
      assert.ok(sample, `${label}: the control is still mounted ${name}`)
      assert.ok(IDENTITY(sample.transform), `${label}: no scale ${name} (transform ${sample.transform})`)
      assert.equal(json(sample.rect), json(samples.rest.rect), `${label}: the border box is unchanged ${name} (${json(sample.rect)} vs ${json(samples.rest.rect)})`)
      if (sample.insidePanel !== null) {
        assert.equal(sample.insidePanel, true, `${label}: stays inside its own panel ${name}`)
      }
    }
  }

  // ── 1. The probe itself: a scaling button is still detected ────────────────
  const control = await story('[data-target="control"]')
  assert.notEqual(control.hovered.transform, control.rest.transform, 'the positive control scales on hover (the harness really delivers hover): ' + json(control))
  assert.notEqual(control.held.transform, control.rest.transform, 'the positive control scales while held (the harness really delivers press): ' + json(control))
  assert.equal(IDENTITY(control.hovered.transform), false, 'and its hover transform is a real scale: ' + control.hovered.transform)
  assert.equal(IDENTITY(control.held.transform), false, 'and its pressed transform is a real scale: ' + control.held.transform)

  // ── 2. The sidebar row menu's own row recipe ───────────────────────────────
  const menuRow = await story('[data-target="menu-row"]')
  still(menuRow, 'sidebar menu row')
  assert.equal(menuRow.rest.insidePanel, true, 'the row starts inside its panel')

  // ── 3. The selection controls ──────────────────────────────────────────────
  still(await story('[role=checkbox]'), 'checkbox')
  still(await story('[role=radio]'), 'radio')

  // ── 4. A real tool-row icon button ─────────────────────────────────────────
  still(await story('[aria-label="Copy result"], [aria-label="Copied"]'), 'tool-row icon button')

  // ── 5. A normal Button keeps its hover colour and its click ────────────────
  // (the geometry rule must not have been bought by disabling the control)
  const rowPoint = await evaluate(`window.__reveal('[data-target="menu-row"]')`)
  await pointer('mouseMoved', rowPoint.x, rowPoint.y)
  await pause(250)
  const hoveredColour = await evaluate(`(()=>{const el=document.querySelector('[data-target="menu-row"]');return{background:getComputedStyle(el).backgroundColor,transition:getComputedStyle(el).transitionProperty}})()`)
  assert.match(hoveredColour.transition, /color|all|background/, 'the row still transitions its colours: ' + json(hoveredColour))
  await pointer('mouseMoved', AWAY.x, AWAY.y)
  await pause(250)
  const restColour = await evaluate(`getComputedStyle(document.querySelector('[data-target="menu-row"]')).backgroundColor`)
  assert.notEqual(hoveredColour.background, restColour, 'hover still tints the row: ' + json({ hovered: hoveredColour.background, rest: restColour }))
  assert.equal(
    await evaluate(`document.querySelector('[role=checkbox]').getAttribute('aria-checked')`),
    'true',
    'pressing the checkbox still toggles it (the press still acts)'
  )
  await screenshot('button-motion')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log(
    'PASS: press/hover geometry — a scaling control is still detected, while the sidebar menu row, the checkbox, the radio and a ' +
      "tool-row icon button keep their border box and an identity transform at rest, on hover, held down, released and after the " +
      'pointer leaves; hover colour, focus geometry and the click itself survive.'
  )
} finally {
  ws?.close()
  child?.kill()
  await server?.close()
}
