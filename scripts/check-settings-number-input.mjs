/**
 * Settings numeric-field regression check: the numeric settings fields (the
 * bash wait threshold in General; the subagent concurrency limit in the
 * Subagents section, where it moved beside the profiles it governs) are plain
 * beUI `Input` fields — no increment/decrement actions, no native number
 * spinners — that filter what can be typed and clamp into their documented
 * range (1–16, 0.1–60s) the moment the field is left, so an out-of-range value
 * can never reach the setter.
 *
 * Real `GeneralSection` + `SubagentsSection` in isolated Electron against a
 * mocked `window.pi`; no SDK, no model calls, no network. Run after building:
 *   node scripts/check-settings-number-input.mjs
 * `PI_SETTINGS_INPUT_SCREENSHOT_DIR` retains the light/dark screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-number-field-'))
const fixturePath = '/__settings_number_field_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CONCURRENCY_LABEL = 'Concurrent delegations'
const WAIT_LABEL = 'Maximum blocking time in seconds'
const ASK_TIMEOUT_LABEL = 'Auto-close seconds'
const RESPONSE_TIMEOUT_LABEL = 'Response timeout seconds'

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { padding: 24px; max-width: 900px; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {GeneralSection} from '/src/components/app/settings/GeneralSection.tsx';
import {SubagentsSection} from '/src/components/app/settings/SubagentsSection.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';

const params = new URLSearchParams(location.search);
const appInfo = {
  version: '9.9.9',
  checkpointsEnabled: true,
  startup: 'resume',
  subagentsEnabled: true,
  subagentMaxConcurrent: Number(params.get('concurrency') ?? 4),
  bashMaxWaitMs: Number(params.get('waitMs') ?? 10000),
  askUserTimeoutSeconds: Number(params.get('askTimeout') ?? 120),
  responseTimeoutSeconds: Number(params.get('responseTimeout') ?? 60),
  sandboxMode: 'workspace-write',
  sandbox: { support: params.get('sandbox') ?? 'ready', backend: 'seatbelt' }
};
window.calls = [];
const subagentProfiles = {
  profiles: [
    { name: 'explore', displayName: 'Explorer', description: 'Read-only researcher.', systemPrompt: 'You explore.',
      tools: ['read', 'grep', 'find', 'ls'], toolsSource: 'explicit', inheritContext: true, runInBackground: false,
      enabled: true, scope: 'global', filePath: '/agents/explore.md' }
  ],
  globalDir: '/agents',
  projectDir: null
};
window.pi = {
  appInfo: async () => appInfo,
  setStartup: async (v) => v,
  setSubagentsEnabled: async (v) => v,
  setSubagentMaxConcurrent: async (v) => { window.calls.push(['concurrency', v]); return v; },
  subagentProfiles: async () => subagentProfiles,
  setSubagentProfileTools: async (filePath, tools) => { window.calls.push(['profileTools', filePath, tools]); return subagentProfiles; },
  toolsCatalog: async () => ({ tools: [], extensions: [], skills: [], skillDiagnostics: [] }),
  setAskUserTimeoutSeconds: async (v) => { window.calls.push(['askTimeout', v]); return v; },
  setResponseTimeoutSeconds: async (v) => { window.calls.push(['responseTimeout', v]); return v; },
  setBashMaxWaitMs: async (v) => { window.calls.push(['waitMs', v]); return v; },
  setCheckpointsEnabled: async (v) => v,
  setSandboxMode: async (v) => v,
  openExternal: async () => {}
};
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale', 'en');

// React tracks its own value, so a scripted edit goes through the native setter
// and a bubbling input event — the same path a keystroke takes.
window.field = (label) => document.querySelector('input[aria-label="' + label + '"]');
window.type = (label, value) => {
  const el = window.field(label);
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
};
window.leave = (label) => {
  const el = window.field(label);
  el.focus();
  el.blur();
  return el.value;
};
window.press = (label, key) => {
  const el = window.field(label);
  el.focus();
  if (document.activeElement !== el) return false;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  // The handler commits by leaving the field, so the press ends unfocused.
  return document.activeElement !== el;
};
window.probeField = (label) => {
  const input = window.field(label);
  if (!input) return null;
  const field = input.parentElement;
  const cluster = field.parentElement.parentElement;
  const inputRect = input.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  return {
    value: input.value,
    type: input.type,
    inputMode: input.inputMode,
    align: getComputedStyle(input).textAlign,
    fullyVisible: inputRect.top >= fieldRect.top && inputRect.bottom <= fieldRect.bottom,
    width: Math.round(fieldRect.width),
    inputWidth: Math.round(inputRect.width),
    buttons: [...cluster.querySelectorAll('button')].map((b) => b.textContent.trim()),
    clusterWidth: Math.round(cluster.getBoundingClientRect().width),
    unit: (() => {
      const unit = [...cluster.querySelectorAll('span')].find(
        (s) => !cluster.querySelector('input').contains(s) && s.className.includes('text-xs')
      );
      return unit ? { text: unit.textContent.trim(), center: (unit.getBoundingClientRect().top + unit.getBoundingClientRect().bottom) / 2 } : null;
    })(),
    center: (fieldRect.top + fieldRect.bottom) / 2,
    saveDisabled: (() => {
      const button = [...cluster.querySelectorAll('button')].find((b) => !b.closest('input'));
      return button ? button.disabled : null;
    })()
  };
};
window.clickSave = (label) => {
  const cluster = window.field(label).parentElement.parentElement.parentElement;
  const button = [...cluster.querySelectorAll('button')].find((b) => !b.closest('input'));
  if (!button) return false;
  button.click();
  return true;
};

const h = React.createElement;
createRoot(document.getElementById('root')).render(h(I18nProvider, null, h('div', null, h(GeneralSection), h(SubagentsSection))));
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
        name: 'number-field-fixture',
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
app.whenReady().then(()=>{const w=new BrowserWindow({width:1180,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
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
  // The fixture window is created hidden, so the page has no focus and
  // `element.blur()` would fire no event at all. Emulate a focused window:
  // the clamp under test lives on the blur handler.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const load = async (query) => {
    await send('Page.navigate', { url: origin + (query ?? '') })
    for (let i = 0; i < 200; i++) {
      const ready = await evaluate(
        `!!window.fixtureReady && document.querySelectorAll('input[aria-label]').length >= 2`
      )
      if (ready) return
      await pause(50)
    }
    throw new Error('Fixture did not mount')
  }
  const probe = (label) => evaluate(`window.probeField(${JSON.stringify(label)})`)
  const type = (label, value) => evaluate(`window.type(${JSON.stringify(label)}, ${JSON.stringify(value)})`)
  // React flushes the controlled value on the next render, so every reading
  // below waits for a frame before it looks at the DOM.
  const typed = async (label, value) => {
    await type(label, value)
    await frame()
    return (await probe(label)).value
  }
  const left = async (label, value) => {
    if (value !== undefined) await typed(label, value)
    await evaluate(`window.leave(${JSON.stringify(label)})`)
    await frame()
    return (await probe(label)).value
  }
  const calls = () => evaluate('window.calls')
  const screenshot = async (name) => {
    if (!process.env.PI_SETTINGS_INPUT_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_SETTINGS_INPUT_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_SETTINGS_INPUT_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  // A text field, never a number input: the native spinner would be the
  // increment/decrement chrome this setting deliberately does not have.
  const assertTextField = async (label, { unit, save }) => {
    const state = await probe(label)
    assert.equal(state.type, 'text', `${label}: a text field, so no native stepper chrome`)
    assert.ok(state.inputMode === 'numeric' || state.inputMode === 'decimal', `${label}: numeric keyboard on touch`)
    assert.equal(state.align, 'center', `${label}: the value is centred in its field`)
    assert.ok(state.fullyVisible, `${label}: the editable value fits its visible field`)
    assert.equal(state.buttons.length, save ? 1 : 0, `${label}: no increment/decrement actions`)
    if (save) assert.deepEqual(state.buttons, [save], `${label}: the only action is Save`)
    if (unit) {
      assert.equal(state.unit?.text, unit, `${label}: the unit follows the field`)
      assert.equal(Math.round(Math.abs(state.unit.center - state.center)), 0, `${label}: the unit shares the field’s centre line`)
    }
    return state
  }

  await load()
  await pause(300)
  await screenshot('general-light')

  // --- the two rows are plain, compact, numeric text fields
  const concurrencyField = await assertTextField(CONCURRENCY_LABEL, { unit: null, save: null })
  assert.equal(concurrencyField.value, '4', 'the concurrency field shows the saved value')
  assert.ok(concurrencyField.width <= 72, `the concurrency field is narrow (${concurrencyField.width}px)`)
  const waitField = await assertTextField(WAIT_LABEL, { unit: 's', save: 'Save' })
  assert.equal(waitField.value, '10.0', 'the wait field shows one decimal')
  assert.equal(waitField.saveDisabled, true, 'Save is disabled while nothing changed')

  // --- typing is filtered: digits, at most one dot, no other character
  assert.equal(await typed(CONCURRENCY_LABEL, '1a2.3'), '12', 'letters and dots never enter the concurrency field')
  assert.equal(await typed(CONCURRENCY_LABEL, '123'), '12', 'the concurrency field takes at most two digits')
  assert.equal(await typed(WAIT_LABEL, '1a2.3s'), '12.3', 'letters and a stray unit never enter the wait field')
  assert.equal(await typed(WAIT_LABEL, '1.2.3'), '1.23', 'a second dot cannot start a third decimal group')
  await screenshot('typing-light')

  // --- leaving the field clamps into range and saves only a real change
  assert.equal(await left(CONCURRENCY_LABEL, '99'), '16', 'an above-range entry clamps to the maximum on blur')
  assert.deepEqual(await calls(), [['concurrency', 16]], 'the clamped value is what reaches the setter')
  assert.equal(await left(CONCURRENCY_LABEL, ''), '16', 'an emptied field restores the saved value')
  assert.deepEqual(await calls(), [['concurrency', 16]], 'restoring makes no further save')
  assert.equal(await left(CONCURRENCY_LABEL, '0'), '1', 'a below-range entry clamps to the minimum')
  assert.deepEqual(await calls(), [['concurrency', 16], ['concurrency', 1]], 'the minimum reaches the setter too')
  await typed(CONCURRENCY_LABEL, '7')
  assert.equal(await evaluate(`window.press(${JSON.stringify(CONCURRENCY_LABEL)}, 'Enter')`), true, 'Enter leaves the field, which commits it')
  await frame()
  assert.equal((await probe(CONCURRENCY_LABEL)).value, '7', 'Enter commits the entry')
  assert.deepEqual((await calls()).at(-1), ['concurrency', 7], 'Enter saves through the setter')

  // --- the wait threshold clamps the same way, and only Save commits it
  assert.equal(await left(WAIT_LABEL, '999'), '60.0', 'an above-range entry clamps to 60 seconds')
  assert.deepEqual(await calls(), [['concurrency', 16], ['concurrency', 1], ['concurrency', 7]], 'a clamped wait value is not saved yet')
  assert.equal((await probe(WAIT_LABEL)).saveDisabled, false, 'Save enables once the field differs from the saved value')
  assert.equal(await left(WAIT_LABEL, '0.05'), '0.1', 'a below-range entry clamps to 0.1 seconds')
  assert.equal(await left(WAIT_LABEL, ''), '10.0', 'an emptied wait field restores the saved value')
  assert.equal((await probe(WAIT_LABEL)).saveDisabled, true, 'restoring disables Save again')
  await typed(WAIT_LABEL, '12.5')
  assert.equal(await evaluate(`window.clickSave(${JSON.stringify(WAIT_LABEL)})`), true, 'Save is clickable')
  await frame()
  assert.deepEqual((await calls()).at(-1), ['waitMs', 12500], 'Save commits the typed seconds exactly once')
  assert.equal((await probe(WAIT_LABEL)).value, '12.5', 'the committed value stays on screen')
  assert.equal((await probe(WAIT_LABEL)).saveDisabled, true, 'Save is disabled again after committing')

  // --- bounds hold for the extremes too
  await load('?concurrency=1&waitMs=60000')
  await pause(300)
  assert.equal((await probe(CONCURRENCY_LABEL)).value, '1', 'a session at the minimum shows it')
  assert.equal((await probe(WAIT_LABEL)).value, '60.0', 'a session at the maximum shows it')
  assert.deepEqual(await calls(), [], 'mounting alone never writes a setting')
  assert.equal(await left(CONCURRENCY_LABEL, '17'), '16', 'the ceiling is the documented maximum, not the next step')
  assert.equal(await typed(CONCURRENCY_LABEL, '-3'), '3', 'a minus sign never enters the field')
  assert.equal(await left(CONCURRENCY_LABEL), '3', 'so a “negative” entry can only be its digits')
  assert.deepEqual((await calls()).at(-1), ['concurrency', 3], 'the sign-free value is what gets saved')
  await screenshot('general-light-clamped')

  // --- the ask_user_question auto-settle deadline is the same kind of field:
  // whole seconds, filtered while typing, clamped on leave, saved explicitly
  await load()
  await pause(300)
  const askField = await assertTextField(ASK_TIMEOUT_LABEL, { unit: 's', save: 'Save' })
  assert.equal(askField.value, '120', 'the ask panel deadline shows the saved seconds')
  assert.equal(askField.saveDisabled, true, 'its Save is disabled while nothing changed')
  assert.equal(await typed(ASK_TIMEOUT_LABEL, '1a2s.5'), '125', 'letters, units and dots never enter the deadline field')
  assert.equal(await typed(ASK_TIMEOUT_LABEL, '12345'), '1234', 'the deadline field takes at most four digits')
  assert.equal(await left(ASK_TIMEOUT_LABEL), '1234', 'an in-range entry is kept on leave')
  assert.equal(await left(ASK_TIMEOUT_LABEL, '9999'), '3600', 'an above-range entry clamps to the maximum')
  assert.equal(await left(ASK_TIMEOUT_LABEL, ''), '120', 'an emptied deadline field restores the saved value')
  await typed(ASK_TIMEOUT_LABEL, '45')
  assert.equal(await evaluate(`window.clickSave(${JSON.stringify(ASK_TIMEOUT_LABEL)})`), true, 'the deadline Save is clickable')
  await frame()
  assert.deepEqual((await calls()).at(-1), ['askTimeout', 45], 'Save commits the typed seconds exactly once')
  assert.equal((await probe(ASK_TIMEOUT_LABEL)).saveDisabled, true, 'and disables Save again')

  // --- the provider response timeout (Settings → General → timeouts) is the
  // same kind of field: whole seconds, filtered while typing, clamped on leave,
  // saved explicitly. It is the value the SDK receives as
  // retry.provider.timeoutMs, so an unanswered request fails and retries.
  await load()
  await pause(300)
  const responseField = await assertTextField(RESPONSE_TIMEOUT_LABEL, { unit: 's', save: 'Save' })
  assert.equal(responseField.value, '60', 'the response timeout shows the one-minute default')
  assert.equal(responseField.saveDisabled, true, 'its Save is disabled while nothing changed')
  assert.equal(await typed(RESPONSE_TIMEOUT_LABEL, '1a2s.5'), '125', 'letters, units and dots never enter the response-timeout field')
  assert.equal(await typed(RESPONSE_TIMEOUT_LABEL, '12345'), '1234', 'the response-timeout field takes at most four digits')
  assert.equal(await left(RESPONSE_TIMEOUT_LABEL), '1234', 'an in-range entry is kept on leave')
  assert.equal(await left(RESPONSE_TIMEOUT_LABEL, '9999'), '3600', 'an above-range entry clamps to the maximum')
  assert.equal(await left(RESPONSE_TIMEOUT_LABEL, '0'), '10', 'a below-range entry clamps to the minimum')
  assert.equal(await left(RESPONSE_TIMEOUT_LABEL, ''), '60', 'an emptied field restores the saved value')
  await typed(RESPONSE_TIMEOUT_LABEL, '90')
  assert.equal(await evaluate(`window.clickSave(${JSON.stringify(RESPONSE_TIMEOUT_LABEL)})`), true, 'the response-timeout Save is clickable')
  await frame()
  assert.deepEqual((await calls()).at(-1), ['responseTimeout', 90], 'Save commits the typed seconds exactly once')
  assert.equal((await probe(RESPONSE_TIMEOUT_LABEL)).saveDisabled, true, 'and disables Save again')

  // --- both locales
  await evaluate('localStorage.setItem("pi-app:locale","zh-CN")')
  await load('?concurrency=4&waitMs=10000')
  await pause(300)
  const zhConcurrency = await evaluate(`window.field('并发委派数').value`)
  const zhWait = await evaluate(`window.field('最大阻塞时长（秒）').value`)
  assert.equal(zhConcurrency, '4', 'the Chinese labels map to the same fields')
  assert.equal(zhWait, '10.0', 'the Chinese wait field shows one decimal')
  const zhResponseTimeout = await evaluate(`window.field('无响应超时（秒）').value`)
  assert.equal(zhResponseTimeout, '60', 'the Chinese labels map to the response-timeout field too')
  const zhState = await evaluate(`window.probeField('最大阻塞时长（秒）')`)
  assert.equal(zhState.unit?.text, '秒', 'the unit suffix is translated')
  assert.equal(Math.round(Math.abs(zhState.unit.center - zhState.center)), 0, 'the Chinese unit shares the field’s centre line')
  assert.equal(await evaluate(`window.type('并发委派数', '99')`), '99', 'the Chinese field accepts typing')
  await frame()
  await evaluate(`window.leave('并发委派数')`)
  await frame()
  assert.equal((await evaluate(`window.probeField('并发委派数')`)).value, '16', 'and clamps identically')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('document.documentElement.classList.add("dark")')
  await frame()
  assert.ok((await evaluate(`window.probeField('并发委派数')`)).fullyVisible, 'reduced motion keeps the editable value fully visible')
  await screenshot('general-dark-zh')

  // The sandbox group's status line speaks only when there is something to act
  // on: a host that runs unconfined shows nothing, because the radio group
  // above already names the mode that is on.
  await evaluate('document.documentElement.classList.remove("dark")')
  await load()
  const enforced = await evaluate(`document.querySelector('[data-sandbox-status]')?.textContent`)
  assert.match(enforced ?? '', /seatbelt/, `an enforced host reports its backend: ${enforced}`)
  await load('?sandbox=host')
  assert.ok(await evaluate(`document.querySelectorAll('[role="radio"]').length`) >= 3, 'the settings page still renders its mode choices')
  assert.equal(
    await evaluate(`!!document.querySelector('[data-sandbox-status]')`),
    false,
    'full access on the host shows no status line'
  )

  assert.deepEqual(exceptions, [], 'no renderer exceptions')

  console.log(
    'settings numeric-field check ok: both numbers are plain range-limited inputs that filter, clamp and save correctly'
  )
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
