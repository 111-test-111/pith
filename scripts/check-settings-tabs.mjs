/**
 * Settings page tab-shell regression check: sections mount lazily and a tab
 * switch never remounts the panel it deactivates.
 *
 * - Opening Settings mounts only the active section; unvisited panels stay
 *   empty and fire no IPC (usage aggregation, tools catalog, providers…).
 *   The vendored TabsContent keeps inactive panels mounted-but-hidden, so
 *   eager rendering would mount all eight sections (~2.4k nodes) and fire
 *   every section's reads in the same frame the entry animation starts.
 * - Switching tabs keeps the deactivated section's component alive: its
 *   state survives the round trip and its mount-time effects do not refire
 *   (the registry's active `motion.div` vs inactive plain `div` used to
 *   change the element type at the same position, tearing the subtree down
 *   on every switch — a hidden Tools refetched the catalog on each leave).
 *
 * Real `SettingsPage` (titlebar, vertical tabs, all ten registered
 * sections) in isolated Electron against a mocked `window.pi`; no SDK, no
 * model calls, no network. Run after building is NOT required (vite serves
 * the source): `node scripts/check-settings-tabs.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
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
import {I18nProvider} from '/src/i18n/index.tsx';
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
window.pi = {
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
window.tab = (label) => [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === label);
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
createRoot(document.getElementById('root')).render(
  h(I18nProvider, null, h(SettingsPage, { open: true, onBack: () => {}, accent: 'violet', onAccentChange: () => {} }))
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
  //    data reads: nine panels, General populated, the rest empty.
  await pause(500)
  let panels = await evaluate('window.panels()')
  assert.equal(panels.length, 10, 'all ten section panels exist in the DOM')
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

  // 3. Visiting Tools mounts it once and fetches the catalog once.
  await evaluate(`window.openTab('Tools')`)
  panels = await evaluate('window.panels()')
  assert.equal(panels.filter((p) => !p.hidden).length, 1)
  assert.ok(panels[4].tools >= 2, 'Tools renders its list once visited')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 1, 'catalog fetched on first visit')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 4. Visiting Subagents mounts it once and fetches the profile list once;
  //    its catalog refresh rides the SAME catalog read Tools started.
  await evaluate(`window.openTab('Subagents')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[5].hidden, 'Subagents is the active panel')
  assert.ok(panels[5].inputs >= 1, 'Subagents renders its concurrency field (the toggle is a checkbox button)')
  assert.ok(panels[5].content > 0, 'Subagents renders its profile list once visited')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'profiles fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'Subagents shares the catalog: its first visit refreshes it once, like Skills')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 5. Visiting Usage must not refire Tools' or Subagents' mount effects —
  //    the deactivated panels' subtrees are kept, not torn down.
  await evaluate(`window.openTab('Usage')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[9].hidden, 'Usage is the active panel')
  assert.ok((await evaluate('window.callsOf("usageStats")')) >= 1, 'usage fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'a hidden Tools/Subagents panel does not refetch the catalog')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'a hidden Subagents panel does not refetch profiles')
  assert.ok(panels[4].tools >= 2, 'the hidden Tools list is still mounted')

  // 6. Returning to Tools reuses the mounted panel; the General draft still
  //    survives the second round trip.
  await evaluate(`window.openTab('Tools')`)
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'returning to Tools refetches nothing')
  await evaluate(`window.openTab('General')`)
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the General draft survives the full round trip')

  // 7. Never-visited sections stay empty and silent through all of it.
  assert.equal(await evaluate('window.callsOf("providers")'), 0, 'Providers never mounted, never read')
  assert.equal(await evaluate('window.callsOf("appendPrompt")'), 0, 'Prompt never mounted, never read')
  assert.equal(await evaluate('window.callsOf("setBrowserAgentTools")'), 0, 'Browser never mounted, never toggled')
  assert.equal(await evaluate('window.callsOf("browserClearData")'), 0, 'Browser never mounted, never cleared')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: settings tabs — lazy sections, switches never remount, drafts and stores survive')
} finally {
  try { child?.kill('SIGKILL') } catch {}
  try { await server?.close() } catch {}
}
