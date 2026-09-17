/**
 * Notification-sound regression check, in isolated Electron: the real General
 * section plus the real event→cue router, against a recording stand-in for the
 * output device and a mocked `window.pi`. No SDK, no model calls, no audio
 * hardware, no user data. Run after building:
 *
 *   node scripts/check-notification-sounds.mjs
 *
 * `PI_SOUNDS_SCREENSHOT_DIR` retains the Sounds group screenshots.
 *
 * Covered: the two cue tables are genuinely different sounds (melody, timbre,
 * rhythm, disjoint pitches, short), the routing rules (settled-but-not-
 * continuing rings, a continuation does not, a subagent child never does, a
 * republished ask set rings once per request id), the settings store and its
 * localStorage keys, the master/per-cue gating with previews that stay audible
 * while a cue is off — and that the Settings rows drive all of it, in both
 * locales.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-notification-sounds-'))
const fixturePath = '/__notification_sounds_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SOUNDS_GROUP = 'Sounds'
const SOUNDS_LABEL = 'Notification sounds'
const TURN_LABEL = 'Turn finished'
const ASK_LABEL = 'Waiting for your answer'
const SOUNDS_LABEL_ZH = '提示音'
const SOUNDS_GROUP_ZH = '提示音'
const TURN_LABEL_ZH = '轮次完成'
const ASK_LABEL_ZH = '等待你的回答'
const PREVIEW_ZH = '试听'

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { padding: 24px; max-width: 900px; }
</style></head><body>
<script>
// A recording stand-in for the output device. It is installed HERE, before the
// module script runs, because the app module caches the AudioContext it opens.
window.__audio = { notes: [], contexts: 0 };
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 12; window.__audio.contexts++; }
  get destination() { return { kind: 'destination' }; }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node
    };
  }
  createOscillator() {
    const note = {
      type: 'sine',
      frequency: { value: 0 },
      startedAt: null,
      stoppedAt: null,
      connect: (node) => node,
      start(t) { this.startedAt = t; },
      stop(t) { this.stoppedAt = t; }
    };
    window.__audio.notes.push(note);
    return note;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
window.AudioContext = FakeAudioContext;

// The app talks to main only through window.pi; this fixture owns a stub of the
// surface the General section and the cue router use.
window.__listeners = [];
const appInfo = {
  version: '9.9.9',
  checkpointsEnabled: true,
  startup: 'resume',
  subagentsEnabled: true,
  subagentMaxConcurrent: 4,
  bashMaxWaitMs: 10000,
  askUserTimeoutSeconds: 120,
  sandboxMode: 'workspace-write',
  sandbox: { support: 'ready', backend: 'seatbelt' }
};
window.pi = {
  appInfo: async () => appInfo,
  onEvent: (listener) => {
    window.__listeners.push(listener);
    return () => { window.__listeners = window.__listeners.filter((entry) => entry !== listener); };
  },
  setStartup: async (v) => v,
  setSubagentsEnabled: async (v) => v,
  setSubagentMaxConcurrent: async (v) => v,
  subagentProfiles: async () => ({ profiles: [], globalDir: '/agents', projectDir: null }),
  toolsCatalog: async () => ({ tools: [], extensions: [], skills: [], skillDiagnostics: [] }),
  setAskUserTimeoutSeconds: async (v) => v,
  setBashMaxWaitMs: async (v) => v,
  setCheckpointsEnabled: async (v) => v,
  setSandboxMode: async (v) => v,
  openExternal: async () => {}
};
</script>
<div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from '/src/i18n/index.tsx';
import { GeneralSection } from '/src/components/app/settings/GeneralSection.tsx';
import * as S from '/src/lib/notification-sounds.ts';
import '/src/styles.css';

const h = React.createElement;
window.S = S;

// The router under test is mounted exactly as the app mounts it, beside the
// Settings section that governs it.
function Fixture() {
  S.useNotificationSoundEvents();
  return h(GeneralSection);
}

let root = null;
const container = document.getElementById('root');
window.__mount = (locale) => {
  localStorage.setItem('pi-app:locale', locale);
  if (root) root.unmount();
  root = createRoot(container);
  flushSync(() => root.render(h(I18nProvider, null, h(Fixture))));
};

// What the fake device was asked to play, in schedule order. Offsets are
// relative to the context clock so they line up with the cue tables.
window.__notes = () => window.__audio.notes.map((note) => ({
  type: note.type,
  frequency: note.frequency.value,
  at: Number((note.startedAt - 12).toFixed(4)),
  until: Number((note.stoppedAt - 12).toFixed(4))
}));
window.__resetAudio = () => { window.__audio.notes = []; };
window.__emit = (event) => { for (const listener of [...window.__listeners]) listener(event); };
window.__listeners_count = () => window.__listeners.length;
window.__settings = () => S.notificationSoundSettings();
window.__setSettings = (patch) => S.setNotificationSoundSettings(patch);
window.__stored = (key) => localStorage.getItem(key);
window.__allowed = (kind) => S.notificationSoundAllowed(kind);
window.__kinds = () => [...S.NOTIFICATION_SOUND_KINDS];
window.__table = (kind) => S.NOTIFICATION_SOUNDS[kind].map((tone) => ({ ...tone }));

// The pure routing rules, including the "already announced" set.
window.__routing = () => ({
  settled: S.notificationSoundForEvent({ type: 'agent_settled' }, () => false),
  continuing: S.notificationSoundForEvent({ type: 'agent_settled', continuing: true }, () => false),
  userAborted: S.notificationSoundForEvent({ type: 'agent_settled', userAborted: true }, () => false),
  child: S.notificationSoundForEvent({ type: 'agent_settled', subagentChild: true }, () => false),
  childAsk: S.notificationSoundForEvent(
    { type: 'ask_user', subagentChild: true, requests: [{ requestId: 'child-1' }] },
    () => false
  ),
  agentEnd: S.notificationSoundForEvent({ type: 'agent_end' }, () => false),
  messageEnd: S.notificationSoundForEvent({ type: 'message_end', message: { role: 'assistant' } }, () => false),
  ask: S.notificationSoundForEvent({ type: 'ask_user', requests: [{ requestId: 'req-1' }] }, () => false),
  askRepeat: S.notificationSoundForEvent(
    { type: 'ask_user', requests: [{ requestId: 'req-1' }] },
    (id) => id === 'req-1'
  ),
  askSecond: S.notificationSoundForEvent(
    { type: 'ask_user', requests: [{ requestId: 'req-1' }, { requestId: 'req-2' }] },
    (id) => id === 'req-1'
  ),
  askEmpty: S.notificationSoundForEvent({ type: 'ask_user', requests: [] }, () => false),
  askMalformed: S.notificationSoundForEvent(
    { type: 'ask_user', requests: [{}, { requestId: 7 }, null, { requestId: '' }] },
    () => false
  )
});

// Settings rows are located by the checkbox's accessible name — the same thing
// a screen reader uses — and the row's non-checkbox button is its Preview.
window.__row = (label) => document.querySelector('[role="checkbox"][aria-label="' + label + '"]');
window.__disabled = (label) => { const box = window.__row(label); return box ? box.disabled : null; };
window.__checked = (label) => {
  const box = window.__row(label);
  if (!box) return null;
  const mark = box.querySelector('[data-checkbox-square]');
  return { state: box.getAttribute('data-state'), mark: !!mark };
};
window.__clickToggle = (label) => { const box = window.__row(label); if (!box) return null; box.click(); return true; };
window.__labels = (title) => {
  const section = window.__soundsSection(title);
  return section
    ? [...section.querySelectorAll('[role="checkbox"][aria-label]')].map((box) => box.getAttribute('aria-label'))
    : [];
};
window.__previewLabel = (rowLabel) => {
  const box = window.__row(rowLabel);
  const row = box ? box.closest('div') : null;
  if (!row) return null;
  const button = [...row.querySelectorAll('button')].find((entry) => entry !== box);
  return button ? button.textContent.trim() : null;
};
window.__clickPreview = (rowLabel) => {
  const box = window.__row(rowLabel);
  const row = box ? box.closest('div') : null;
  if (!row) return false;
  const button = [...row.querySelectorAll('button')].find((entry) => entry !== box);
  if (!button) return false;
  button.click();
  return true;
};
window.__soundsSection = (title) => [...document.querySelectorAll('section')].find((section) => {
  const heading = section.querySelector('p');
  return !!heading && heading.textContent.trim() === title;
});
window.__hasGroupTitle = (title) => !!window.__soundsSection(title);

window.__mount('en');
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
        name: 'notification-sounds-fixture',
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
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:1100,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolveEndpoint, reject) => {
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
        resolveEndpoint('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((entry) => entry.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveOpen) => ws.addEventListener('open', resolveOpen, { once: true }))
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
      const text = message.params.args.map((arg) => arg.value ?? arg.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolveSend, reject) => {
      const id = ++sequence
      pending.set(id, (message) => (message.error ? reject(message.error) : resolveSend(message.result)))
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
  const json = (value) => JSON.stringify(value)
  for (let i = 0; i < 200; i++) {
    if (await evaluate('!!window.fixtureReady')) break
    await pause(50)
  }
  const screenshot = async (name) => {
    if (!process.env.PI_SOUNDS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_SOUNDS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_SOUNDS_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  /** Emit one synthetic main-process event through the app's own listener. */
  const emit = (event) => evaluate(`window.__emit(${json(event)})`)
  const notes = () => evaluate('window.__notes()')
  const resetAudio = () => evaluate('window.__resetAudio()')
  /**
   * A played cue must BE the table's cue: same note count, same pitch and
   * waveform, same rhythm and note lengths — and nothing scheduled in the past.
   */
  const assertCue = (played, table, label) => {
    assert.equal(played.length, table.length, `${label}: every note of the cue is scheduled`)
    assert.ok(played[0].at >= 0, `${label}: the cue starts at or after the current time`)
    table.forEach((tone, index) => {
      assert.equal(played[index].type, tone.wave, `${label}: note ${index} keeps its waveform`)
      assert.equal(played[index].frequency, tone.frequency, `${label}: note ${index} keeps its pitch`)
      assert.ok(
        Math.abs((played[index].at - played[0].at) - (tone.at - table[0].at)) < 1e-6,
        `${label}: note ${index} keeps its place in the rhythm`
      )
      assert.ok(
        played[index].until - played[index].at >= tone.duration,
        `${label}: note ${index} rings for its full length`
      )
    })
  }

  await pause(300)
  await screenshot('sounds-light')

  // ── 1. The cue tables: two sounds, not one sound twice ─────────────────────
  const tables = await evaluate('({ turnComplete: window.__table("turnComplete"), askUser: window.__table("askUser") })')
  const kinds = await evaluate('window.__kinds()')
  assert.deepEqual(kinds, ['turnComplete', 'askUser'], 'two cues, in the Settings order')
  const tones = (table) => table.map((tone) => tone.frequency)
  for (const [kind, table] of Object.entries(tables)) {
    assert.ok(table.length >= 2 && table.length <= 4, `${kind}: a cue is a few notes, not a phrase (${table.length})`)
    const end = Math.max(...table.map((tone) => tone.at + tone.duration))
    assert.ok(end > 0 && end <= 2, `${kind}: the cue stays under two seconds (${end}s)`)
    assert.ok(table.every((tone) => tone.frequency > 100 && tone.frequency < 4000), `${kind}: pitches sit in the audible midrange`)
  }
  const completion = tones(tables.turnComplete)
  assert.ok(
    completion.every((frequency, index) => index === 0 || frequency > completion[index - 1]),
    `turnComplete rises, so it can only read as an ending: ${json(completion)}`
  )
  const ask = tones(tables.askUser)
  assert.equal(new Set(ask).size, 1, `askUser repeats one pitch as a call for attention: ${json(ask)}`)
  assert.equal(
    completion.filter((frequency) => ask.includes(frequency)).length,
    0,
    `the two cues share no pitch: ${json(completion)} vs ${json(ask)}`
  )
  assert.notEqual(
    tables.turnComplete[0].wave,
    tables.askUser[0].wave,
    'and they are told apart by timbre as well as by melody'
  )
  const rhythm = (table) => table.map((tone) => tone.at).join(',')
  assert.notEqual(
    rhythm(tables.turnComplete),
    rhythm(tables.askUser),
    'and by rhythm: the bell walks its notes, the ask pings are spaced for attention'
  )
  const length = (table) => Math.max(...table.map((tone) => tone.at + tone.duration))
  assert.notEqual(
    length(tables.turnComplete),
    length(tables.askUser),
    'and they do not even last the same time'
  )

  // ── 2. The routing rules ──────────────────────────────────────────────────
  const routing = await evaluate('window.__routing()')
  assert.deepEqual(routing.settled, { kind: 'turnComplete' }, 'a settled run plays the completion cue')
  assert.equal(routing.continuing, null, 'a settle that continues (queued message, retry, background completion) stays silent')
  assert.equal(routing.userAborted, null, 'a run the user stopped with Stop/Esc is not a finished run')
  assert.equal(routing.child, null, 'a subagent child’s settle never chimes')
  assert.equal(routing.childAsk, null, 'and neither does a child’s ask (its owner chat announces that one)')
  assert.equal(routing.agentEnd, null, 'agent_end is not the end of a run')
  assert.equal(routing.messageEnd, null, 'ordinary message traffic makes no sound')
  assert.deepEqual(routing.ask, { kind: 'askUser', announce: 'req-1' }, 'a fresh question plays the ask cue')
  assert.equal(routing.askRepeat, null, 'a republished pending set does not ring a second time')
  assert.deepEqual(routing.askSecond, { kind: 'askUser', announce: 'req-2' }, 'a NEW question in the same set does')
  assert.equal(routing.askEmpty, null, 'an empty pending set is not a question')
  assert.equal(routing.askMalformed, null, 'malformed requests are ignored rather than rung')

  // ── 3. Live playback through the real router ──────────────────────────────
  assert.equal(await evaluate('window.__listeners_count()'), 1, 'the router listens once')
  const defaults = await evaluate('window.__settings()')
  assert.deepEqual(defaults, { enabled: true, turnComplete: true, askUser: true }, 'every cue is on out of the box')
  assert.equal(await evaluate('window.__stored("pi-app:sound-enabled")'), null, 'the default is not written until it changes')

  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl' })
  assertCue(await notes(), tables.turnComplete, 'a finished turn')

  await resetAudio()
  await emit({ type: 'ask_user', sessionPath: '/sessions/a.jsonl', requests: [{ requestId: 'live-1' }] })
  const askPlayed = await notes()
  assertCue(askPlayed, tables.askUser, 'a question for the user')

  // The same question republished (main re-announces on session activation).
  await resetAudio()
  await emit({ type: 'ask_user', sessionPath: '/sessions/a.jsonl', requests: [{ requestId: 'live-1' }] })
  assert.equal((await notes()).length, 0, 'answering/navigating does not replay the ask cue for a question already heard')
  await resetAudio()
  await emit({ type: 'ask_user', sessionPath: '/sessions/a.jsonl', requests: [{ requestId: 'live-1' }, { requestId: 'live-2' }] })
  assertCue(await notes(), tables.askUser, 'a second question in the same chat')

  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/child.jsonl', subagentChild: true })
  assert.equal((await notes()).length, 0, 'a delegation’s child rounds stay silent')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl', continuing: true })
  assert.equal((await notes()).length, 0, 'a run that continues after settling stays silent')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl', userAborted: true })
  assert.equal((await notes()).length, 0, 'and so does the run the user stopped')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl' })
  assertCue(await notes(), tables.turnComplete, 'the next real run')

  // ── 4. Settings gate the cues, previews do not ────────────────────────────
  await evaluate('window.__setSettings({ enabled: false })')
  assert.equal(await evaluate('window.__stored("pi-app:sound-enabled")'), 'off', 'switching the master off persists')
  assert.equal(await evaluate('window.__allowed("turnComplete")'), false, 'the master silences the completion cue')
  assert.equal(await evaluate('window.__allowed("askUser")'), false, 'and the ask cue')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl' })
  await emit({ type: 'ask_user', sessionPath: '/sessions/a.jsonl', requests: [{ requestId: 'live-3' }] })
  assert.equal((await notes()).length, 0, 'nothing sounds while the master is off')

  await resetAudio()
  assert.equal(await evaluate(`window.__clickPreview(${json(TURN_LABEL)})`), true, 'the row offers a preview')
  assertCue(await notes(), tables.turnComplete, 'a preview') // audible even with the master off

  await frame()
  assert.equal(await evaluate(`window.__disabled(${json(TURN_LABEL)})`), true, 'the per-cue switches are disabled while the master is off')
  await evaluate(`window.__clickToggle(${json(SOUNDS_LABEL)})`)
  await frame()
  assert.equal(await evaluate('window.__stored("pi-app:sound-enabled")'), 'on', 'the Settings row switches the master back on')
  assert.equal(await evaluate(`window.__disabled(${json(TURN_LABEL)})`), false, 'and the per-cue switches come back')

  await evaluate('window.__setSettings({ turnComplete: false })')
  assert.equal(await evaluate('window.__allowed("turnComplete")'), false, 'one cue can be switched off alone')
  assert.equal(await evaluate('window.__allowed("askUser")'), true, 'without touching the other')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl' })
  assert.equal((await notes()).length, 0, 'the muted cue stays quiet')
  await resetAudio()
  await emit({ type: 'ask_user', sessionPath: '/sessions/a.jsonl', requests: [{ requestId: 'live-4' }] })
  assertCue(await notes(), tables.askUser, 'the other cue')

  // ── 5. The Settings rows themselves ───────────────────────────────────────
  await evaluate('window.__setSettings({ enabled: true, turnComplete: true, askUser: true })')
  await frame()
  assert.equal(
    await evaluate(`window.__hasGroupTitle(${json(SOUNDS_GROUP)})`),
    true,
    'the Sounds group has its own heading'
  )
  assert.deepEqual(
    await evaluate(`window.__labels(${json(SOUNDS_GROUP)})`),
    [SOUNDS_LABEL, TURN_LABEL, ASK_LABEL],
    'the group holds one master switch and one switch per cue'
  )
  assert.deepEqual(
    await evaluate(`({ turn: window.__checked(${json(TURN_LABEL)}), ask: window.__checked(${json(ASK_LABEL)}) })`),
    { turn: { state: 'checked', mark: true }, ask: { state: 'checked', mark: true } },
    'each cue renders as the app’s square on/off control, on by default'
  )
  assert.equal(await evaluate(`window.__previewLabel(${json(TURN_LABEL)})`), 'Preview', 'each cue row can be auditioned')
  await evaluate(`window.__clickToggle(${json(ASK_LABEL)})`)
  await frame()
  assert.equal(await evaluate('window.__stored("pi-app:sound-ask-user")'), 'off', 'clicking the row writes the cue’s own key')
  assert.equal(await evaluate(`window.__checked(${json(ASK_LABEL)})`).then((value) => value.state), 'unchecked', 'and the box follows')
  await evaluate('window.__setSettings({ askUser: true })')
  await frame()

  // ── 6. Both locales ───────────────────────────────────────────────────────
  await evaluate('window.__mount("zh-CN")')
  await frame()
  assert.equal(
    await evaluate(`window.__hasGroupTitle(${json(SOUNDS_GROUP_ZH)})`),
    true,
    'the Chinese group heading is translated too'
  )
  assert.deepEqual(
    await evaluate(`window.__labels(${json(SOUNDS_GROUP_ZH)})`),
    [SOUNDS_LABEL_ZH, TURN_LABEL_ZH, ASK_LABEL_ZH],
    'the Chinese labels map to the same three switches'
  )
  assert.equal(await evaluate(`window.__previewLabel(${json(TURN_LABEL_ZH)})`), PREVIEW_ZH, 'and the preview action is translated')
  assert.equal(await evaluate('window.__listeners_count()'), 1, 'remounting switches the router over, it does not stack a second one')
  await resetAudio()
  await emit({ type: 'agent_settled', sessionPath: '/sessions/a.jsonl' })
  assertCue(await notes(), tables.turnComplete, 'the cue after a locale switch')

  await evaluate('document.documentElement.classList.add("dark")')
  await frame()
  await screenshot('sounds-dark-zh')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')

  console.log(
    'notification-sound check ok: two distinct cues, routed from settled runs and fresh questions, gated by Settings in both locales'
  )
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
