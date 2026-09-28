/**
 * Settings page tab-shell regression check: sections mount lazily and a tab
 * switch never remounts the panel it deactivates.
 *
 * - Opening Settings mounts only the active section; unvisited panels stay
 *   empty and fire no IPC (usage aggregation, tools catalog, providers…).
 *   The vendored TabsContent keeps inactive panels mounted-but-hidden, so
 *   eager rendering would mount every section and fire
 *   every section's reads in the same frame the entry animation starts.
 * - Switching tabs keeps the deactivated section's component alive: its
 *   state survives the round trip and its mount-time effects do not refire
 *   (the registry's active `motion.div` vs inactive plain `div` used to
 *   change the element type at the same position, tearing the subtree down
 *   on every switch — a hidden Tools refetched the catalog on each leave).
 *
 * Real `SettingsPage` (titlebar, vertical tabs, all fifteen registered
 * sections) in isolated Electron against a mocked `window.pi`; no SDK, no
 * model calls, no network. Run after building is NOT required (vite serves
 * the source): `node scripts/check-settings-tabs.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-settings-tabs-'))
const fixturePath = '/__settings_tabs_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const WAIT_LABEL = 'Maximum blocking time in seconds'

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { height: 100vh; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from '/src/components/app/settings/SettingsPage.tsx';
import {JevWorkflowStatus} from '/src/components/app/JevWorkflowStatus.tsx';
import {I18nProvider, useI18n} from '/src/i18n/index.tsx';
import en from '/src/i18n/locales/en.ts';
import zh from '/src/i18n/locales/zh-CN.ts';
// Same handles the other UI checks use: assertions compare rendered text
// against the locale dictionaries instead of re-typing the copy.
window.en = en; window.zh = zh;
import '/src/styles.css';

// The whole window.pi surface Settings can reach in this pass, with call
// counts so the assertions can prove what fired and what did not.
window.calls = [];
const count = (name, value) => { window.calls.push(name); return Promise.resolve(value) };
const appInfo = {
  version: '9.9.9', checkpointsEnabled: true, startup: 'resume',
  subagentsEnabled: true, subagentMaxConcurrent: 4, bashMaxWaitMs: 10000,
  sandboxMode: 'workspace-write', sandbox: { support: 'ready', backend: 'seatbelt' },
  browserConsent: true, browserAgentToolsEnabled: false
};
const catalog = {
  tools: [
    { name: 'read', description: 'Read a file.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'edit', description: 'Edit a file.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'ctx_one', description: 'Extension tool one.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false },
    { name: 'ctx_two', description: 'Extension tool two.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false }
  ],
  extensions: [{ id: '/ext/ctx', name: 'context-mode', version: '1.0.0', source: 'npm:context-mode', scope: 'user', origin: 'package', path: '/ext/ctx', toolNames: ['ctx_one', 'ctx_two'], enabled: true, resources: [], manageable: true }],
  skills: [{ name: 'github', description: 'GitHub skill', filePath: '/skills/github/SKILL.md', baseDir: '/skills/github', source: 'npm:skills-pack', scope: 'user', origin: 'package', disableModelInvocation: false }],
  skillDiagnostics: []
};
const dayKey = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const usage = {
  generatedAt: Date.now(), firstDay: dayKey(6), lastDay: dayKey(0),
  models: [{ key: 'deepseek/chat', provider: 'deepseek', model: 'chat', days: { [dayKey(0)]: { tokens: 3e5, cost: 0.4, requests: 24 }, [dayKey(2)]: { tokens: 2e5, cost: 0.2, requests: 12 } }, totalTokens: 5e5, totalCost: 0.6, totalRequests: 36 }],
  totalTokens: 5e5, totalCost: 0.6, totalRequests: 36,
  records: [{ startTs: Date.now() - 36e5, endTs: Date.now() - 35e5, models: [{ provider: 'deepseek', model: 'chat', tokens: 5e4 }], tokens: 5e4, cost: 0.21, requests: 3 }],
  recordsTruncated: false
};
let jev = { mode: 'off', choice: true, score: true, noul: true, keySource: 'missing' };
let pip = { frameRate: 5, position: 'last', initialScale: 'last', startPinned: true };
window.pipUpdates = [];
window.pi = {
  pictureInPicturePreferences: () => count('pictureInPicturePreferences', pip),
  setPictureInPicturePreferences: (update) => {
    window.calls.push('setPictureInPicturePreferences');
    window.pipUpdates.push(update);
    pip = { ...pip, ...update };
    return Promise.resolve(pip);
  },
  jevSettings: () => count('jevSettings', jev),
  updateJevSettings: (update) => {
    if (window.jevUpdateFailure) return count('updateJevSettings', { ok: false, code: 'authentication' });
    jev = { ...jev, ...update.preferences, ...('apiKey' in update ? { keySource: update.apiKey ? 'saved' : 'missing' } : {}) };
    return count('updateJevSettings', { ok: true, data: jev });
  },
  testJev: () => count('testJev', window.jevFailure ? {ok:false,code:'authentication'} : {ok:true,data:{
    model:'jev-1.13.0', elapsedMs:120, inputTokens:100, outputTokens:30,
    answers:{category:{type:'choice',choice:'bug'},severity:{type:'score',score:1.9},reproducible:{type:'noul',noul:0.99}}
  }}),
  appInfo: () => count('appInfo', appInfo),
  setStartup: (v) => count('setStartup', v),
  setSubagentsEnabled: (v) => count('setSubagentsEnabled', v),
  setBrowserAgentTools: (v) => count('setBrowserAgentTools', v),
  browserClearData: () => count('browserClearData', undefined),
  setSubagentMaxConcurrent: (v) => count('setSubagentMaxConcurrent', v),
  subagentProfiles: () => count('subagentProfiles', {
    profiles: [
      { name: 'explore', displayName: 'Explorer', description: 'Read-only researcher.', systemPrompt: 'You explore.',
        tools: ['read', 'grep'], toolsSource: 'explicit', inheritContext: true, runInBackground: false,
        enabled: true, scope: 'global', filePath: '/agents/explore.md' }
    ],
    globalDir: '/agents',
    projectDir: null
  }),
  createSubagentProfile: (payload) => count('createSubagentProfile', payload),
  setSubagentProfileTools: (filePath, tools) => count('setSubagentProfileTools', tools),
  setBashMaxWaitMs: (v) => count('setBashMaxWaitMs', v),
  setCheckpointsEnabled: (v) => count('setCheckpointsEnabled', v),
  setSandboxMode: (v) => count('setSandboxMode', v),
  openExternal: () => count('openExternal', undefined),
  toolsCatalog: () => count('toolsCatalog', catalog),
  setExtensionEnabled: (id, enabled) => count('setExtensionEnabled', { ...catalog }),
  usageStats: () => count('usageStats', usage),
  providers: () => count('providers', []),
  models: () => count('models', []),
  defaultModel: () => count('defaultModel', null),
  modelsConfig: () => count('modelsConfig', { providers: {} }),
  saveModelsConfig: (config) => count('saveModelsConfig', config),
  login: (id) => count('login', undefined),
  logout: (id) => count('logout', undefined),
  readSkill: () => count('readSkill', { path: '/skills/github/SKILL.md', text: '# github — Skill body.', truncated: false }),
  openPath: () => count('openPath', undefined),
  showInFolder: () => count('showInFolder', undefined),
  setSkillModelInvocation: (path, disabled) => count('setSkillModelInvocation', { ...catalog }),
  setDefaultModel: (p, m) => count('setDefaultModel', undefined),
  appendPrompt: () => count('appendPrompt', '')
};
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale', 'en');

// Panels = the Tabs wrapper's children minus its tablist; the wrapper is the
// only element with the SettingsPage Tabs classes in this fixture.
window.panels = () => {
  const tabs = document.querySelector('.flex.min-h-0.flex-1');
  return [...tabs.children].filter((c) => c.getAttribute('role') !== 'tablist').map((p) => ({
    hidden: p.hasAttribute('hidden'),
    elements: p.querySelectorAll('*').length,
    inputs: p.querySelectorAll('input[aria-label]').length,
    tools: p.querySelectorAll('[data-tool]').length,
    // Anything section-specific beyond the header scaffold (h2/p/wrappers).
    content: p.querySelectorAll('input,button,canvas,table,[data-slot],[data-tool],[role=switch]').length,
    text: p.innerText.slice(0, 40)
  }));
};
// Trailing rail tag (e.g. Beta) is part of the trigger's text; tab lookup
// compares the label without it so the registry stays addressable by name.
window.tab = (label) => [...document.querySelectorAll('[role=tab]')].find((b) => {
  const badge = b.querySelector('[data-tab-badge]');
  const text = (badge ? b.textContent.replace(badge.textContent, '') : b.textContent).trim();
  return text === label;
});
window.openTab = async (label) => { window.tab(label).click(); await new Promise((r) => setTimeout(r, 350)); };
// React tracks its own value, so a scripted edit goes through the native
// setter and a bubbling input event — the same path a keystroke takes.
window.typeWait = (value) => {
  const el = document.querySelector('input[aria-label="' + ${JSON.stringify(WAIT_LABEL)} + '"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
};
window.waitValue = () => document.querySelector('input[aria-label="' + ${JSON.stringify(WAIT_LABEL)} + '"]')?.value ?? null;
window.callsOf = (name) => window.calls.filter((c) => c === name).length;

const h = React.createElement;
function LocaleBridge(){ window.changeLocale = useI18n().setLocale; return null; }
function WorkflowFixture(){
  const [state,setState]=React.useState(null); window.setWorkflow=setState;
  return h(JevWorkflowStatus,{state});
}
createRoot(document.getElementById('root')).render(
  h(I18nProvider, null, h(LocaleBridge), h(SettingsPage, { open: true, onBack: () => {}, accent: 'violet', onAccentChange: () => {} }), h(WorkflowFixture))
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
        name: 'settings-tabs-fixture',
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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`!!window.fixtureReady && !!document.querySelector('[role=tablist]')`)) break
    await pause(50)
  }
  if (!(await evaluate(`!!document.querySelector('[role=tablist]')`))) {
    console.log('MOUNT FAIL exceptions:', JSON.stringify(exceptions).slice(0, 700))
    console.log('MOUNT FAIL vite:', await evaluate(`(()=>{const o=document.querySelector('vite-error-overlay');return o?(o.shadowRoot?.textContent||'').slice(0,400):'none'})()`))
  }
  assert.ok(await evaluate(`!!document.querySelector('[role=tablist]')`), 'fixture mounted')

  // 1. Opening Settings mounts only the active section and fires no section
  //    data reads: fifteen panels, General populated, the rest empty.
  await pause(500)
  let panels = await evaluate('window.panels()')
  assert.equal(panels.length, 15, 'all fifteen section panels exist in the DOM')
  assert.equal(panels.filter((p) => !p.hidden).length, 1, 'exactly one panel is active')
  assert.ok(panels[0].inputs >= 2, 'General (first section) is the mounted one')
  assert.ok(panels.slice(1).every((p) => p.content === 0), 'unvisited panels render no section content (header scaffold only)')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 0, 'no catalog read on open')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 0, 'no subagent profile read on open')
  assert.equal(await evaluate('window.callsOf("usageStats")'), 0, 'no usage aggregation on open')
  assert.equal(await evaluate('window.callsOf("providers")'), 0, 'no providers read on open')

  // 2. A draft held in General survives tab round trips: the deactivated
  //    panel keeps its React state instead of remounting from props.
  assert.equal(await evaluate(`window.typeWait('12.5')`), '12.5', 'the wait field accepts a typed draft')

  // 3. The new Notifications page owns both native alerts and sounds; General
  //    stays mounted but no longer carries those controls.
  await evaluate(`window.openTab('Notifications')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[1].hidden && panels[1].content > 0, 'Notifications is a real lazily mounted section')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'opening Notifications preserves the General draft')

  // 4. Picture in picture reads its preferences only on first visit.
  assert.equal(await evaluate('window.callsOf("pictureInPicturePreferences")'), 0)
  await evaluate(`window.openTab('Picture in picture')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[4].hidden && panels[4].content > 0, 'Picture in picture is a lazily mounted section')
  assert.equal(await evaluate('window.callsOf("pictureInPicturePreferences")'), 1)
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the General draft survives Picture in picture')
  if (process.env.PI_PIP_SETTINGS_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_PIP_SETTINGS_SCREENSHOT_DIR, { recursive: true })
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(process.env.PI_PIP_SETTINGS_SCREENSHOT_DIR, 'picture-in-picture-settings.png'), Buffer.from(shot.data, 'base64'))
  }
  const choosePip = async (label, option) => {
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`)
    await pause(120)
    await evaluate(`[...document.querySelectorAll('[role="listbox"][aria-hidden="false"] [role="option"]')].find(option=>option.textContent.trim()===${JSON.stringify(option)}).click()`)
    await pause(120)
  }
  await choosePip('Maximum frame rate', '10 fps')
  await choosePip('Opening position', 'Top left')
  await choosePip('Opening scale', '65%')
  await evaluate(`document.querySelector('button[role="checkbox"][aria-label="Keep on top when opened"]').click()`)
  await pause(120)
  assert.deepEqual(await evaluate('window.pipUpdates'), [
    { frameRate: 10 }, { position: 'top-left' }, { initialScale: '65' }, { startPinned: false }
  ], 'every Picture in picture control persists through its bridge setter')

  // 5. Visiting Tools mounts it once and fetches the catalog once.
  await evaluate(`window.openTab('Tools')`)
  panels = await evaluate('window.panels()')
  assert.equal(panels.filter((p) => !p.hidden).length, 1)
  assert.ok(panels[7].tools >= 2, 'Tools renders its list once visited')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 1, 'catalog fetched on first visit')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 6. Visiting Subagents mounts it once and fetches the profile list once;
  //    its catalog refresh rides the SAME catalog read Tools started.
  await evaluate(`window.openTab('Subagents')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[8].hidden, 'Subagents is the active panel')
  assert.ok(panels[8].inputs >= 1, 'Subagents renders its concurrency field (the toggle is a checkbox button)')
  assert.ok(panels[8].content > 0, 'Subagents renders its profile list once visited')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'profiles fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'Subagents shares the catalog: its first visit refreshes it once, like Skills')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 7. Visiting Usage must not refire Tools' or Subagents' mount effects —
  //    the deactivated panels' subtrees are kept, not torn down.
  await evaluate(`window.openTab('Usage')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[13].hidden, 'Usage is the active panel')
  assert.ok((await evaluate('window.callsOf("usageStats")')) >= 1, 'usage fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'a hidden Tools/Subagents panel does not refetch the catalog')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'a hidden Subagents panel does not refetch profiles')
  assert.ok(panels[7].tools >= 2, 'the hidden Tools list is still mounted')

  // 8. Returning to Tools reuses the mounted panel; the General draft still
  //    survives the second round trip.
  await evaluate(`window.openTab('Tools')`)
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'returning to Tools refetches nothing')
  await evaluate(`window.openTab('General')`)
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the General draft survives the full round trip')

  // 9. Never-visited sections stay empty and silent through all of it.
  assert.equal(await evaluate('window.callsOf("providers")'), 0, 'Providers never mounted, never read')
  assert.equal(await evaluate('window.callsOf("appendPrompt")'), 0, 'Prompt never mounted, never read')
  assert.equal(await evaluate('window.callsOf("setBrowserAgentTools")'), 0, 'Browser never mounted, never toggled')
  assert.equal(await evaluate('window.callsOf("browserClearData")'), 0, 'Browser never mounted, never cleared')

  // Jev uses native controls, never reads a secret back, and retains only an unsaved draft.
  assert.equal(await evaluate('window.callsOf("jevSettings")'), 0)
  await evaluate(`window.openTab('Jev')`)
  assert.equal(await evaluate('window.callsOf("jevSettings")'), 1)
  // The Jev rail row carries a trailing Beta tag: it sits inside the tab, after
  // the label, and stays on the row's own line box instead of inflating it.
  const jevBadge = await evaluate(`(() => { const tab = window.tab('Jev'); const badge = tab.querySelector('[data-tab-badge]'); const box = badge.getBoundingClientRect(); const row = tab.getBoundingClientRect(); const heights = (label) => Math.round(window.tab(label).getBoundingClientRect().height); return { text: badge.textContent, inside: box.left > window.tab('Jev').querySelector('svg').getBoundingClientRect().right, top: Math.round(box.top), bottom: Math.round(box.bottom), rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom), jevHeight: heights('Jev'), generalHeight: heights('General') } })()`)
  console.log('CONTROL jev tab badge', JSON.stringify(jevBadge))
  assert.equal(jevBadge.text, await evaluate('window.en["settings.beta"]'), 'the Jev tab shows the Beta tag')
  assert(jevBadge.inside, `the Beta tag renders inside the Jev tab (${JSON.stringify(jevBadge)})`)
  assert(jevBadge.top >= jevBadge.rowTop && jevBadge.bottom <= jevBadge.rowBottom, `the Beta tag stays inside the tab row (${JSON.stringify(jevBadge)})`)
  assert.equal(jevBadge.jevHeight, jevBadge.generalHeight, `the Beta tag does not inflate the Jev tab row (${JSON.stringify(jevBadge)})`)
  const jevButton = label => `[...document.querySelectorAll('[data-jev-settings] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`
  const clickJev = async label => { await evaluate(`${jevButton(label)}.click()`); await pause(100) }
  assert.equal(await evaluate(`${jevButton('Test connection')}.disabled`), true)
  // No secret field lives in the section: the credentials group is a status row
  // whose action opens a dedicated dialog, so the input exists only while the
  // user is entering a key.
  assert.equal(await evaluate(`document.querySelectorAll('[data-jev-settings] input').length`), 0, 'the key field is dialog-only')
  // The three runtime modes are one row, not a stack: a single shared top edge
  // with three distinct lefts. (Regression guard: the group defaults to
  // vertical, which read as three separate settings.)
  const jevRadios = await evaluate(`[...document.querySelectorAll('[data-jev-settings] [role=radio]')].map(el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) } })`)
  assert.equal(jevRadios.length, 3, 'all three Jev modes render')
  console.log('CONTROL jev radios', JSON.stringify(jevRadios))
  assert.equal(new Set(jevRadios.map(r => r.top)).size, 1, `the Jev modes share one row (${JSON.stringify(jevRadios)})`)
  assert.equal(new Set(jevRadios.map(r => r.left)).size, 3, `each Jev mode holds its own column (${JSON.stringify(jevRadios)})`)
  await evaluate(`[...document.querySelectorAll('[data-jev-settings] [role=radio]')].find(el=>el.closest('label').textContent.includes('Provide tool')).click()`)
  await pause(100)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-jev-settings] [role=radio]')].find(el=>el.closest('label').textContent.includes('Provide tool')).getAttribute('aria-checked')`), 'true')
  await evaluate(`[...document.querySelectorAll('[data-jev-settings] [role=radio]')].find(el=>el.closest('label').textContent.includes('Jev workflow')).click()`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('[data-jev-settings] [aria-label="Choice"]').disabled`), true)
  assert.match(await evaluate(`document.querySelector('[data-jev-settings]').textContent`), /no round, request or duration cap/)
  // The mode help is one condensed line in workflow mode — the longest copy.
  const jevHelp = await evaluate(`(() => { const p = document.querySelector('[data-jev-settings] [role=group] p'); const style = getComputedStyle(p); return { lines: p.getClientRects().length, text: p.textContent, height: Math.round(p.getBoundingClientRect().height), lineHeight: Math.round(parseFloat(style.lineHeight)) } })()`)
  console.log('CONTROL jev mode help', JSON.stringify({ lines: jevHelp.lines, height: jevHelp.height, lineHeight: jevHelp.lineHeight }))
  assert.equal(jevHelp.lines, 1, `the workflow mode help stays one line (${JSON.stringify(jevHelp)})`)
  await evaluate(`window.setWorkflow({seq:1,phase:'verifying',route:'act',corrections:1,requests:2,jevInput:30,jevOutput:5,mainInput:100,mainOutput:20,cacheRead:50,cacheWrite:0})`)
  await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-jev-workflow]').textContent`), /Jev · verifying/)
  // Type a key into the dialog, leave the section and come back: the draft
  // survives (component stays mounted) and nothing is written until Save.
  const typeKey = value => evaluate(`(()=>{const el=document.querySelector('[data-jev-settings] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const jevWritesBefore = await evaluate('window.callsOf("updateJevSettings")')
  await clickJev('Set API key')
  assert.equal(await evaluate(`document.querySelector('[data-jev-settings] input').type`), 'password')
  assert.equal(await evaluate(`document.querySelector('[data-jev-settings] input').getAttribute('aria-label')`), await evaluate('window.en["jev.apiKey"]'))
  await typeKey('fixture-key-only')
  assert.equal(await evaluate('window.callsOf("updateJevSettings")'), jevWritesBefore, 'typing never writes the key')
  await evaluate(`window.openTab('General')`)
  await evaluate(`window.openTab('Jev')`)
  assert.equal(await evaluate(`document.querySelector('[data-jev-settings] input').value`), 'fixture-key-only')
  assert.equal(await evaluate('window.callsOf("jevSettings")'), 1)
  // A rejected key keeps the dialog open with the failure on the field itself;
  // the section-level alert stays off screen while the dialog owns the error.
  await evaluate('window.jevUpdateFailure = true')
  await clickJev('Save key')
  assert.equal(await evaluate(`document.querySelector('[data-jev-settings] input').value`), 'fixture-key-only', 'a failed save keeps the draft in the open dialog')
  assert.equal(await evaluate(`document.querySelectorAll('[data-jev-settings] [role=alert]').length`), 1)
  assert.match(await evaluate(`document.querySelector('[data-jev-settings] [role=alert]').textContent`), /rejected the API key/)
  await evaluate('window.jevUpdateFailure = false')
  await clickJev('Save key')
  // The panel animates out, so the dialog's input leaves the DOM a few frames
  // after the write resolves.
  await pause(400)
  assert.equal(await evaluate(`document.querySelectorAll('[data-jev-settings] input').length`), 0, 'the dialog closes once the key is stored')
  assert.equal(await evaluate(`document.querySelectorAll('[data-jev-settings] [role=alert]').length`), 0)
  assert.equal(await evaluate(`${jevButton('Test connection')}.disabled`), false)
  await clickJev('Test connection')
  assert.match(await evaluate(`document.querySelector('[data-jev-result]').textContent`), /Connected.*jev-1.13.0/)
  // The result reports pass/fail only — the example answers are a fixture, so
  // they must not reappear as if the reader could act on them.
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-jev-result]').textContent`), /severity|Example|severity 2\.00/)
  // Credentials collapse to a single status row: no key field on its own line,
  // and the row's actions sit beside the status text.
  const jevCredentials = await evaluate(`(() => { const group = [...document.querySelectorAll('[data-jev-settings] section')].find(s => s.textContent.includes(window.en['jev.keyStatus'])); const rows = group.querySelector('.divide-y'); const box = rows.getBoundingClientRect(); const buttons = [...rows.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)); return { rows: rows.children.length, buttons, rowTop: Math.round(box.top), rowBottom: Math.round(box.bottom) } })()`)
  console.log('CONTROL jev credentials', JSON.stringify(jevCredentials))
  assert.equal(jevCredentials.rows, 1, `credentials render as one row (${JSON.stringify(jevCredentials)})`)
  assert.equal(jevCredentials.buttons.length, 2, `the saved key offers replace and remove (${JSON.stringify(jevCredentials)})`)
  assert(jevCredentials.buttons.every(top => top > jevCredentials.rowTop && top < jevCredentials.rowBottom), `both key actions stay on the status row (${JSON.stringify(jevCredentials)})`)
  await evaluate('window.jevFailure = true')
  await clickJev('Test connection')
  assert.match(await evaluate(`document.querySelector('[data-jev-settings] [role=alert]').textContent`), /rejected the API key/)
  await evaluate('window.changeLocale("zh-CN")')
  await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-jev-settings] [role=alert]').textContent`), /拒绝了此密钥/)
  assert.match(await evaluate(`document.querySelector('[data-jev-workflow]').textContent`), /Jev · 正在校验/)
  await evaluate(`window.setWorkflow(null)`)
  await evaluate('window.jevFailure = false')
  await clickJev('测试连接')
  assert.match(await evaluate(`document.querySelector('[data-jev-result]').textContent`), /连接成功/)
  if (process.env.PI_JEV_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_JEV_SCREENSHOT_DIR, {recursive:true})
    for (const theme of ['light','dark']) {
      await evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await pause(100)
      const shot = await send('Page.captureScreenshot', {format:'png'})
      await writeFile(join(process.env.PI_JEV_SCREENSHOT_DIR, `jev-${theme}.png`), Buffer.from(shot.data,'base64'))
    }
  }
  await clickJev('移除已保存的密钥')
  assert.equal(await evaluate(`${jevButton('测试连接')}.disabled`), true)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: settings tabs — lazy sections, switches never remount, drafts and stores survive')
} finally {
  try { child?.kill('SIGKILL') } catch {}
  try { await server?.close() } catch {}
}
