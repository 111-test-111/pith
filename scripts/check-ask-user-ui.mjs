/**
 * ask_user_question panel regression check: the real `AskUserPanel` in isolated
 * Electron against a synthetic pending request — no SDK, no model calls, no
 * user data. Run after building:
 *   node scripts/check-ask-user-ui.mjs
 *
 * Pins the behaviours the panel's own history broke on:
 *   - option rows keep one geometry whichever option is picked (the vendored
 *     control's inline-flex baseline used to grow the selected row and push
 *     every row below it down),
 *   - the free-text field keeps its icon-aware left padding, so the
 *     placeholder never renders under the pencil glyph,
 *   - every question's `header` is rendered (the chip row) and usable to jump,
 *   - collapse/expand parks and reopens the set without settling it, while
 *     close (and Skip, and Esc) settles it as unanswered with local feedback,
 *   - radios auto-advance, multi-select waits for the explicit submit, and the
 *     submitted payload carries the picked labels / free text,
 *   - both locales and dark mode, and no renderer exceptions.
 *
 * `PI_ASK_USER_SCREENSHOT_DIR` retains the screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-ask-user-ui-'))
const fixturePath = '/__ask_user_panel_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Past AUTO_ADVANCE_MS (480ms) so a single pick has settled into a slide. */
const ADVANCE_SETTLE_MS = 750

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { padding: 24px; max-width: 760px; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AskUserPanel, AskUserResultCard} from '/src/components/app/AskUserPanel.tsx';
import {AskUserRecordList} from '/src/components/app/AskUserRecordList.tsx';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';

const params = new URLSearchParams(location.search);
if (params.get('locale')) localStorage.setItem('pi-app:locale', params.get('locale'));
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale', 'en');

window.QUESTIONS = [
  {
    question: 'Which database should the migration target?',
    header: 'Database',
    options: [{label: 'Postgres', description: 'Already in staging'}, {label: 'SQLite'}]
  },
  {
    question: 'Which paths should be verified?',
    header: 'Verify',
    multiSelect: true,
    options: [{label: 'Subagent'}, {label: 'Stop'}, {label: 'Snapshot'}, {label: 'Locale'}]
  },
  {
    question: 'Does the panel itself look right?',
    header: 'Panel',
    options: [{label: 'Yes'}, {label: 'No — see the free text'}]
  }
];
window.request = {
  requestId: 'req-1',
  sessionPath: '/tmp/ask-user-check.jsonl',
  questions: window.QUESTIONS,
  createdAt: Date.now(),
  ...(params.get('noTimeout') ? {} : { timeoutMs: Number(params.get('timeoutMs') ?? 120000) }),
  ...(params.get('engaged') ? { engaged: true } : {})
};
window.responds = [];
window.engages = [];

window.probe = () => {
  const root = document.querySelector('[data-ask-user]');
  if (!root) return null;
  const rows = [...root.querySelectorAll('[data-ask-user-option]')].map((row) => {
    const control = row.querySelector('[role="radio"],[role="checkbox"]');
    const rect = row.getBoundingClientRect();
    const label = row.querySelector('span.select-none');
    return {
      label: label ? label.textContent.trim() : row.textContent.trim(),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      checked: control ? control.getAttribute('aria-checked') : null
    };
  });
  const chips = [...root.querySelectorAll('[data-ask-user-chip]')].map((chip) => ({
    index: Number(chip.getAttribute('data-ask-user-chip')),
    label: chip.textContent.trim(),
    current: chip.getAttribute('aria-current') === 'true',
    width: Math.round(chip.getBoundingClientRect().width)
  }));
  const input = root.querySelector('input');
  let inputBox = null;
  if (input) {
    const rect = input.getBoundingClientRect();
    const field = input.parentElement.getBoundingClientRect();
    const style = getComputedStyle(input);
    const icon = input.parentElement.querySelector('span');
    inputBox = {
      placeholder: input.placeholder,
      value: input.value,
      paddingLeft: Math.round(parseFloat(style.paddingLeft)),
      textOrigin: Math.round(rect.left + parseFloat(style.paddingLeft)),
      iconRight: icon ? Math.round(icon.getBoundingClientRect().right) : null,
      fullyVisible: rect.top >= field.top && rect.bottom <= field.bottom
    };
  }
  const rootRect = root.getBoundingClientRect();
  const countdownNode = root.querySelector('[data-ask-user-countdown]');
  const counter = [...root.querySelectorAll('span')]
    .map((node) => node.textContent.trim())
    .find((text) => /^[0-9]+ \\/ [0-9]+$/.test(text)) || null;
  return {
    state: root.getAttribute('data-ask-user-state'),
    countdown: countdownNode
      ? { seconds: Number(countdownNode.getAttribute('data-ask-user-countdown')), text: countdownNode.textContent.trim() }
      : null,
    question: root.querySelector('p') ? root.querySelector('p').textContent.trim() : null,
    counter,
    text: root.textContent.replace(/\\s+/g, ' ').trim(),
    rows,
    chips,
    input: inputBox,
    buttons: [...root.querySelectorAll('button')].map((button) => ({
      action: button.getAttribute('data-ask-user-action'),
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      disabled: button.disabled
    })),
    settled: root.querySelector('[data-ask-user-action="settled"]')?.textContent.trim() ?? null,
    height: Math.round(rootRect.height),
    width: Math.round(rootRect.width)
  };
};

window.clickOption = (index) => {
  // A question slide keeps the outgoing question mounted for a beat, so the
  // LAST match is the live one.
  const rows = [...document.querySelectorAll('[data-ask-user-option="' + index + '"]')];
  const row = rows.pop();
  if (!row) return false;
  row.querySelector('button').click();
  return true;
};
window.clickChip = (index) => {
  const chip = document.querySelector('[data-ask-user-chip="' + index + '"]');
  if (!chip) return false;
  chip.click();
  return true;
};
window.clickAction = (action) => {
  const button = document.querySelector('[data-ask-user-action="' + action + '"]');
  if (!button) return false;
  button.click();
  return true;
};
window.setCustom = (value) => {
  const input = document.querySelector('[data-ask-user] input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
// The panel's handlers listen on window in the capture phase.
window.pressKey = (key) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  return true;
};

// The settled card on its own: the transcript's Q&A body, whose badge differs
// per outcome (async receipt, timeout, dismissal, answers).
window.probeCard = () => {
  const card = document.querySelector('[data-ask-user-result]');
  if (!card) return null;
  const badge = card.querySelector('[data-ask-user-status]');
  return {
    status: card.getAttribute('data-ask-user-result'),
    reason: card.getAttribute('data-ask-user-reason'),
    badge: badge ? badge.getAttribute('data-ask-user-status') : null,
    text: card.textContent
  };
};

// The Q&A record panel's data: one record per outcome the panel must label.
window.RECORDS = [
  { toolCallId: 'r1', questions: [{ question: 'Oldest answered question', header: 'Old', options: [{ label: 'A' }, { label: 'B' }] }], status: 'answered', answers: [{ question: 'Oldest answered question', selected: ['A'] }], at: 1700000000000 },
  { toolCallId: 'r2', questions: [{ question: 'Async answered question', header: 'Async', options: [{ label: 'A' }, { label: 'B' }] }], status: 'answered', answers: [{ question: 'Async answered question', selected: ['B'] }], mode: 'async', at: 1700000001000 },
  { toolCallId: 'r3', questions: [{ question: 'Dismissed question', header: 'No', options: [{ label: 'A' }, { label: 'B' }] }], status: 'cancelled', reason: 'dismissed', answers: null, at: 1700000002000 },
  { toolCallId: 'r4', questions: [{ question: 'Timed out question', header: 'Time', options: [{ label: 'A' }, { label: 'B' }] }], status: 'cancelled', reason: 'timeout', answers: null, at: 1700000003000 },
  { toolCallId: 'r5', questions: [{ question: 'Interrupted question', header: 'Stop', options: [{ label: 'A' }, { label: 'B' }] }], status: 'cancelled', reason: 'aborted', answers: null, at: 1700000004000 },
  { toolCallId: 'r6', questions: [{ question: 'Awaiting question', header: 'Wait', options: [{ label: 'A' }, { label: 'B' }] }], status: 'pending', answers: null, mode: 'async', at: 1700000005000 }
];

window.probeRecords = () => {
  const root = document.querySelector('[data-ask-user-records]');
  if (!root) return null;
  return {
    rows: [...root.querySelectorAll('[data-ask-user-record]')].map((row) => ({
      id: row.getAttribute('data-ask-user-record'),
      kind: row.getAttribute('data-ask-user-record-kind'),
      text: row.textContent,
      expanded: row.querySelector('button[aria-expanded]').getAttribute('aria-expanded') === 'true',
      hasCard: !!row.querySelector('[data-ask-user-result]'),
      /** What actually paints the row: a frame here means the panel regressed
       * to per-row cards instead of the sibling panels' quiet rows. */
      frame: (() => {
        const outer = getComputedStyle(row);
        const inner = row.firstElementChild ? getComputedStyle(row.firstElementChild) : null;
        const trigger = row.querySelector('button') ? getComputedStyle(row.querySelector('button')) : null;
        return {
          outer: [outer.borderTopWidth, outer.borderBottomWidth, outer.backgroundColor, outer.boxShadow === 'none' ? 'none' : 'shadow'].join('/'),
          inner: inner ? [inner.borderTopWidth, inner.backgroundColor].join('/') : 'none',
          trigger: trigger ? [trigger.borderTopWidth, trigger.backgroundColor].join('/') : 'none',
          indent: Math.round(row.getBoundingClientRect().left - root.getBoundingClientRect().left),
          height: Math.round(row.getBoundingClientRect().height),
          gap: row.nextElementSibling ? Math.round(row.nextElementSibling.getBoundingClientRect().top - row.getBoundingClientRect().bottom) : null
        };
      })()
    }))
  };
};
window.clickRecord = (id) => {
  const trigger = document.querySelector('[data-ask-user-record="' + id + '"] button[aria-expanded]');
  if (!trigger) return false;
  trigger.click();
  return true;
};
// The transcript's own ask row: a name and an outcome chip, never the record.
window.probeRow = () => {
  const row = document.querySelector('[data-ask-user-row]');
  if (!row) return null;
  return { text: row.textContent, hasCard: !!row.querySelector('[data-ask-user-result]') };
};

const h = React.createElement;
const cardMode = params.get('card');
const details = cardMode === 'pending'
  ? { kind: 'pi-app-ask-user', status: 'pending', questions: window.QUESTIONS, answers: null, mode: 'async' }
  : cardMode === 'timeout'
    ? { kind: 'pi-app-ask-user', status: 'cancelled', questions: window.QUESTIONS, answers: null, mode: 'blocking', reason: 'timeout' }
    : cardMode === 'dismissed'
      ? { kind: 'pi-app-ask-user', status: 'cancelled', questions: window.QUESTIONS, answers: null, mode: 'blocking', reason: 'dismissed' }
      : { kind: 'pi-app-ask-user', status: 'answered', questions: window.QUESTIONS, mode: 'async',
          answers: [{ question: 'q', selected: ['Postgres'] }, { question: 'q', selected: ['Subagent'] }, { question: 'q', selected: [], custom: 'later' }] };
createRoot(document.getElementById('root')).render(
  h(I18nProvider, null, cardMode
    ? h(AskUserResultCard, { details })
    : params.get('panel') === 'records'
      ? h(AskUserRecordList, { records: window.RECORDS })
      : params.get('panel') === 'row'
        ? h(ToolCallView, {
            call: { type: 'toolCall', id: 'call-row', name: 'ask_user_question', arguments: { questions: window.QUESTIONS } },
            result: {
              role: 'toolResult', toolCallId: 'call-row', toolName: 'ask_user_question',
              content: [{ type: 'text', text: 'The user answered 1 question(s)' }],
              details: { kind: 'pi-app-ask-user', status: 'answered', questions: window.QUESTIONS, answers: [{ question: 'q', selected: ['Yes'] }] },
              timestamp: 1700000001000
            }
          })
        : h(AskUserPanel, {
            request: window.request,
            onEngage: (id) => window.engages.push(id),
            onRespond: (id, payload) => window.responds.push([id, payload])
          }))
);
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
        name: 'ask-user-panel-fixture',
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
app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve_, reject) => {
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
        resolve_('http://127.0.0.1:' + match[1])
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
    new Promise((resolve_, reject) => {
      const id = ++sequence
      pending.set(id, (m) => (m.error ? reject(m.error) : resolve_(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
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
      const ready = await evaluate('!!window.fixtureReady && !!(window.probe() || window.probeCard() || window.probeRecords() || window.probeRow())')
      if (ready) return
      await pause(50)
    }
    throw new Error('Fixture did not mount')
  }
  const probe = () => evaluate('window.probe()')
  const clickOption = (index) => evaluate(`window.clickOption(${index})`)
  const clickChip = (index) => evaluate(`window.clickChip(${index})`)
  const clickAction = (action) => evaluate(`window.clickAction(${JSON.stringify(action)})`)
  /** Jump to a question and let its slide finish: the outgoing question stays
   * mounted through the transition, and a click that lands on it belongs to
   * the question being left behind. */
  const nav = async (index) => {
    const ok = await clickChip(index)
    await frame()
    await pause(400)
    return ok
  }
  const setCustom = (value) => evaluate(`window.setCustom(${JSON.stringify(value)})`)
  const responds = () => evaluate('window.responds')
  /** A click that settles the UI: two frames, then the auto-advance beat. */
  const settled = async (action) => {
    await action()
    await frame()
    await pause(ADVANCE_SETTLE_MS)
    return probe()
  }
  const screenshot = async (name) => {
    if (!process.env.PI_ASK_USER_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_ASK_USER_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_ASK_USER_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  const actions = (state) => state.buttons.map((button) => button.action).filter(Boolean)
  const button = (state, action) => state.buttons.find((item) => item.action === action)

  await load()
  await pause(300)
  await screenshot('panel-open')

  // --- first paint: headers rendered as the chip row, one question at a time
  let state = await probe()
  assert.equal(state.state, 'open', 'the panel opens')
  assert.equal(state.question, 'Which database should the migration target?', 'it shows the first question')
  assert.equal(state.counter, '1 / 3', 'the counter names the position')
  assert.deepEqual(state.chips.map((chip) => chip.label), ['Database', 'Verify', 'Panel'], 'every question header is rendered')
  assert.deepEqual(state.chips.filter((chip) => chip.current).map((chip) => chip.index), [0], 'the active chip is marked')
  assert.equal(state.rows.length, 2, 'the first question offers two options')
  assert.equal(state.rows[0].checked, 'false', 'and nothing is picked yet')

  // --- free-text entry fits its visible frame and keeps icon-aware padding
  assert.ok(state.input, 'the free-text field is present')
  assert.ok(state.input.fullyVisible, 'the free-text entry is not clipped by its field')
  assert.ok(
    state.input.iconRight !== null && state.input.textOrigin >= state.input.iconRight + 2,
    `the placeholder cannot sit under the pencil glyph (icon ends at ${state.input.iconRight}, text starts at ${state.input.textOrigin})`
  )

  // --- option geometry is independent of which option is picked
  assert.equal(await nav(2), true, 'the third chip jumps to its question')
  const beforePick = await settled(() => clickOption(0))
  assert.equal(beforePick.question, 'Does the panel itself look right?', 'the chip row navigates')
  assert.equal(beforePick.rows.length, 2, 'the third question offers two options')
  assert.equal(beforePick.rows[0].checked, 'true', 'the first option is picked')
  const secondPick = await settled(() => clickOption(1))
  const openHeight = beforePick.height
  assert.equal(secondPick.rows[1].checked, 'true', 'the second option is picked')
  assert.equal(secondPick.rows[0].checked, 'false', 'and the first is released')
  assert.deepEqual(
    secondPick.rows.map((row) => row.height),
    beforePick.rows.map((row) => row.height),
    'a picked row is exactly as tall as an unpicked one'
  )
  assert.deepEqual(
    secondPick.rows.map((row) => row.top),
    beforePick.rows.map((row) => row.top),
    'so picking a different option never shifts the rows'
  )
  assert.equal(
    secondPick.rows[1].top - secondPick.rows[0].top,
    beforePick.rows[1].top - beforePick.rows[0].top,
    'the gap between options is a constant'
  )
  await screenshot('panel-picked')

  // --- a radio pick advances to the next question, once
  assert.equal(await nav(0), true, 'back to the first question')
  const advanced = await settled(() => clickOption(0))
  assert.equal(advanced.question, 'Which paths should be verified?', 'a single pick advances to the next question')
  assert.equal(advanced.counter, '2 / 3', 'the counter follows')
  assert.equal(advanced.rows.length, 4, 'the multi-select question lists four options')
  const multi = await settled(() => clickOption(0))
  assert.equal(multi.question, 'Which paths should be verified?', 'a multi-select pick does not auto-advance')
  assert.equal(multi.rows[0].checked, 'true', 'the first box is checked')
  assert.equal(button(multi, 'submit').disabled, false, 'a pick enables the submit action')
  const multiTwo = await settled(() => clickOption(2))
  assert.deepEqual(multiTwo.rows.map((row) => row.checked), ['true', 'false', 'true', 'false'], 'a multi-select keeps several picks')
  assert.deepEqual(multiTwo.chips.map((chip) => chip.width > 0), [true, true, true], 'the chips stay laid out')

  // --- the bottom-right action is Continue until the last question, where it
  //     submits the whole set
  const continuing = await settled(() => clickAction('submit'))
  assert.equal(continuing.question, 'Does the panel itself look right?', 'the action advances until the last question')
  const third = await settled(() => clickOption(0))
  assert.equal(third.rows[0].checked, 'true', 'the last question takes its own answer')
  const submitted = await settled(() => clickAction('submit'))
  assert.equal(submitted.rows.length, 0, 'the panel settles after submitting')
  assert.equal(submitted.state, 'sent', 'and says the answers were sent')
  assert.match(submitted.settled ?? '', /sent/i, `the local confirmation is rendered: ${submitted.settled}`)
  const [requestId, payload] = (await responds()).at(-1)
  assert.equal(requestId, 'req-1', 'the answer names its request')
  assert.deepEqual(
    payload.answers.map((answer) => answer.selected),
    [['Postgres'], ['Subagent', 'Snapshot'], ['Yes']],
    'the payload carries the picked labels per question'
  )

  // --- free text is an answer of its own, and clears a single pick
  await load()
  await pause(200)
  await nav(2)
  await settled(() => clickOption(0))
  await setCustom('Neither — ask me later')
  await frame()
  const typed = await probe()
  assert.equal(typed.rows[0].checked, 'false', 'typing an answer releases the single pick')
  assert.equal(button(typed, 'submit').disabled, false, 'the free text alone counts as an answer')
  const customSubmit = await settled(() => clickAction('submit'))
  assert.equal(customSubmit.state, 'sent', 'the free-text answer submits')
  const customPayload = (await responds()).at(-1)[1]
  assert.deepEqual(
    customPayload.answers[2],
    { question: 'Does the panel itself look right?', selected: [], custom: 'Neither — ask me later' },
    'the free text travels as the answer'
  )

  // --- collapse parks the set without settling it; expand reopens in place
  await load()
  await pause(200)
  await nav(1)
  const collapsed = await settled(() => clickAction('collapse'))
  assert.equal(collapsed.state, 'collapsed', 'collapse folds the panel')
  assert.ok(collapsed.height <= 48, `the folded panel is one line (${collapsed.height}px)`)
  assert.ok(
    collapsed.height < openHeight / 3,
    `the folded panel is a fraction of the open one (${collapsed.height}px vs ${openHeight}px)`
  )
  assert.match(collapsed.text, /Which paths should be verified\?/, 'the folded line names the question')
  assert.equal(collapsed.rows.length, 0, 'and hides the options')
  assert.deepEqual(actions(collapsed).sort(), ['close', 'expand'], 'the folded line keeps expand and close')
  assert.deepEqual(await responds(), [], 'collapsing settles nothing')
  await screenshot('panel-collapsed')
  const reopened = await settled(() => clickAction('expand'))
  assert.equal(reopened.state, 'open', 'expand reopens the panel')
  assert.equal(reopened.question, 'Which paths should be verified?', 'on the question it was folded on')
  assert.deepEqual(await responds(), [], 'and still settles nothing')

  // --- close means unanswered: settle as cancelled with local feedback
  await clickAction('collapse')
  await frame()
  const closed = await settled(() => clickAction('close'))
  assert.equal(closed.state, 'cancelled', 'closing the panel settles it')
  assert.deepEqual(await responds(), [['req-1', { cancelled: true }]], 'close reaches main as a dismissal')
  assert.match(closed.settled ?? '', /not answered/i, `the panel says the question went unanswered: ${closed.settled}`)

  // --- Skip and Esc dismiss the same way
  await load()
  await pause(200)
  const skipped = await settled(() => clickAction('skip'))
  assert.equal(skipped.state, 'cancelled', 'Skip dismisses the questions')
  assert.deepEqual((await responds()).at(-1), ['req-1', { cancelled: true }], 'Skip reaches main as a dismissal')
  await load()
  await pause(200)
  const escaped = await settled(() => evaluate("window.pressKey('Escape')"))
  assert.equal(escaped.state, 'cancelled', 'Esc dismisses the questions too')
  assert.deepEqual((await responds()).at(-1), ['req-1', { cancelled: true }], 'Esc reaches main as a dismissal')

  // --- both locales, and dark mode leaves the geometry alone
  await evaluate("localStorage.setItem('pi-app:locale','zh-CN')")
  await load()
  await pause(300)
  const zh = await probe()
  assert.equal(zh.input.placeholder, '其他（自定义回答）', 'the Chinese placeholder is used')
  assert.ok(zh.input.textOrigin >= zh.input.iconRight + 2, 'and it clears the icon too')
  assert.equal(button(zh, 'collapse').label, '收起提问', 'the collapse action is translated')
  assert.equal(button(zh, 'close').label, '关闭提问（视为未回答）', 'the close action is translated')
  assert.deepEqual(zh.chips.map((chip) => chip.label), ['Database', 'Verify', 'Panel'], 'the model’s own headers are never translated')
  const zhCollapsed = await settled(() => clickAction('collapse'))
  assert.equal(button(zhCollapsed, 'expand').label, '展开提问', 'the folded row offers the translated expand action')
  await screenshot('panel-dark-zh')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('document.documentElement.classList.add("dark")')
  await frame()
  const darkCollapsed = await probe()
  assert.equal(darkCollapsed.height, zhCollapsed.height, 'dark mode does not change the folded row’s height')

  // --- the auto-settle countdown runs until the user engages, then stops
  // Back to English: the locale block above left the fixture in Chinese.
  await evaluate("localStorage.setItem('pi-app:locale','en')")
  await load()
  await pause(200)
  const counting = await probe()
  assert.ok(counting.countdown, 'an untouched question shows its auto-close countdown')
  assert.ok(
    counting.countdown.seconds > 110 && counting.countdown.seconds <= 120,
    `the countdown starts at the configured deadline (${counting.countdown?.seconds}s)`
  )
  assert.match(counting.countdown.text, /Closes in/, 'and says what it means')
  await pause(1200)
  const ticked = await probe()
  assert.ok(
    ticked.countdown && ticked.countdown.seconds < counting.countdown.seconds,
    `the countdown ticks down (${counting.countdown.seconds}s to ${ticked.countdown?.seconds}s)`
  )
  assert.deepEqual(await evaluate('window.engages'), [], 'merely reading the panel is not engagement')
  const engaged = await settled(() => clickOption(0))
  assert.deepEqual(await evaluate('window.engages'), ['req-1'], 'picking an option engages the question')
  assert.equal(engaged.countdown, null, 'and the countdown is gone for good')
  assert.equal(engaged.question, 'Which paths should be verified?', 'the pick itself still registered (and advanced)')

  // --- engagement is reported once, whichever interaction comes first
  await load()
  await pause(200)
  await clickAction('collapse')
  await frame()
  assert.equal((await probe()).state, 'collapsed', 'the question is folded away')
  assert.deepEqual(await evaluate('window.engages'), [], 'folding it away does NOT count as engaging')
  const expandedAgain = await clickAction('expand')
  assert.equal(expandedAgain, true, 'the folded row reopens it')
  await frame()
  assert.deepEqual(await evaluate('window.engages'), ['req-1'], 'reopening it does count')
  await setCustom('typed by hand')
  await frame()
  await nav(2)
  assert.deepEqual(await evaluate('window.engages'), ['req-1'], 'later interactions do not report again')
  assert.equal((await probe()).countdown, null, 'and the countdown stays away')

  // --- an engaged question draws no countdown, and neither does a session with
  //     no deadline configured
  await load('?engaged=1')
  await pause(200)
  assert.equal((await probe()).countdown, null, 'a question already engaged shows no countdown')
  await load('?noTimeout=1')
  await pause(200)
  assert.equal((await probe()).countdown, null, 'a zero deadline means no countdown at all')

  // --- the transcript card's own states: async receipt, timeout, dismissal
  await load('?card=pending')
  await pause(150)
  const pendingCard = await evaluate('window.probeCard()')
  assert.equal(pendingCard.status, 'pending', 'an async dispatch renders as a receipt')
  assert.equal(pendingCard.reason, 'pending', 'marked as still open')
  assert.match(pendingCard.text, /Async/, 'with its async badge')
  assert.match(pendingCard.text, /Sent/, 'and a waiting note')
  assert.ok(
    !/Not answered/.test(pendingCard.text),
    'the receipt never claims the user left a question unanswered'
  )
  await load('?card=timeout')
  await pause(150)
  const timeoutCard = await evaluate('window.probeCard()')
  assert.equal(timeoutCard.badge, 'timeout', 'a timed-out question says so')
  assert.match(timeoutCard.text, /Timed out/, 'with the timeout badge')
  await load('?card=dismissed')
  await pause(150)
  assert.equal((await evaluate('window.probeCard()')).badge, 'dismissed', 'a dismissal keeps its own badge')
  await load('?card=answered')
  await pause(150)
  const answeredCard = await evaluate('window.probeCard()')
  assert.equal(answeredCard.badge, null, 'an answered question carries no status badge')
  assert.equal(answeredCard.status, 'answered')
  assert.match(answeredCard.text, /Postgres/, 'and lists what was picked')
  assert.match(answeredCard.text, /later/, 'including free text')

  // --- the Q&A record panel: every outcome, newest first, expandable
  await load('?panel=records')
  await pause(200)
  const listed = await evaluate('window.probeRecords()')
  assert.deepEqual(
    listed.rows.map((row) => row.id),
    ['r6', 'r5', 'r4', 'r3', 'r2', 'r1'],
    'records are listed newest first'
  )
  assert.deepEqual(
    listed.rows.map((row) => row.kind),
    ['pending', 'aborted', 'timeout', 'dismissed', 'answered', 'answered'],
    'each record labels its own outcome'
  )
  assert.ok(listed.rows.every((row) => !row.hasCard), 'a collapsed row carries no Q&A card')
  // The row is the sibling panels' quiet row: no frame of its own, a 4px list
  // inset plus its own 6px, and the shared 8px rhythm.
  assert.ok(
    listed.rows.every((row) => row.frame.outer.startsWith('0px/0px/')),
    `a record row draws no border of its own (${JSON.stringify(listed.rows.map((row) => row.frame.outer))})`
  )
  assert.ok(
    listed.rows.every((row) => row.frame.inner.startsWith('0px/') && row.frame.trigger.startsWith('0px/')),
    `nor does anything inside it (${JSON.stringify(listed.rows.map((row) => [row.frame.inner, row.frame.trigger]))})`
  )
  assert.deepEqual(
    [...new Set(listed.rows.map((row) => row.frame.indent))],
    [4],
    'every row starts at the list’s own 4px inset, whatever its outcome'
  )
  assert.deepEqual(
    [...new Set(listed.rows.map((row) => row.frame.gap).filter((gap) => gap !== null))],
    [8],
    'rows keep the shared 8px gap'
  )
  assert.match(listed.rows[0].text, /Awaiting answer/, 'an open question reads as awaiting')
  assert.match(listed.rows[1].text, /Interrupted/, 'an interrupted one says so')
  assert.match(listed.rows[2].text, /Timed out/, 'a timed-out one says so')
  assert.match(listed.rows[3].text, /Dismissed/, 'a dismissed one says so')
  assert.match(listed.rows[4].text, /Answered/, 'an answered one says so')
  assert.match(listed.rows[0].text, /Async/, 'an async record is marked as such')
  assert.match(listed.rows[4].text, /Async/, 'including one that came back answered')
  assert.ok(!/Async/.test(listed.rows[1].text), 'a blocking record carries no async badge')
  assert.match(listed.rows[0].text, /Awaiting question/, 'the row names the first question')
  await screenshot('records-panel')

  assert.equal(await evaluate("window.clickRecord('r2')"), true, 'a record row expands')
  await frame()
  const expanded = await evaluate('window.probeRecords()')
  const expandedRow = expanded.rows.find((row) => row.id === 'r2')
  assert.equal(expandedRow.expanded, true, 'the row reports itself expanded')
  assert.equal(expandedRow.hasCard, true, 'and mounts the Q&A card')
  assert.match(expandedRow.text, /Async answered question/, 'showing the question')
  assert.match(expandedRow.text, /B/, 'and what was picked')
  assert.equal(expanded.rows.filter((row) => row.hasCard).length, 1, 'only one record is open at a time')
  assert.equal(await evaluate("window.clickRecord('r2')"), true)
  await frame()
  assert.equal(
    (await evaluate('window.probeRecords()')).rows.filter((row) => row.hasCard).length,
    0,
    'clicking it again closes it'
  )

  // --- the transcript's ask row names the question and stops there
  await load('?panel=row')
  await pause(150)
  const askRow = await evaluate('window.probeRow()')
  assert.ok(askRow, 'the transcript still shows that a question was asked')
  assert.match(askRow.text, /Ask user/, 'naming the tool')
  assert.match(askRow.text, /Which database should the migration target/, 'and the first question')
  assert.match(askRow.text, /Answered/, 'with the outcome chip')
  assert.equal(askRow.hasCard, false, 'but never the Q&A record itself')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('check-ask-user-ui: the panel renders, collapses, dismisses and answers as designed')
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
