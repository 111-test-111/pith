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
 * - Provider settings and the Delete row survive a cleared visibility
 *   override; badges follow each click before saves or inventories return.
 *
 * Real `SettingsPage` (titlebar, vertical tabs, all registered
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
import {setUiStyle} from '/src/lib/ui-style.ts';
window.setUiStyle = setUiStyle;
document.documentElement.dataset.corners = 'square';

// The whole window.pi surface Settings can reach in this pass, with call
// counts so the assertions can prove what fired and what did not.
window.calls = [];
const count = (name, value) => { window.calls.push(name); return Promise.resolve(value) };
const appInfo = {
  version: '9.9.9', checkpointsEnabled: true, startup: 'resume',
  subagentsEnabled: true, subagentMaxConcurrent: 4, bashMaxWaitMs: 10000,
  sandboxMode: 'workspace-write', sandbox: { support: 'ready', backend: 'seatbelt' },
  browserConsent: true, browserAgentToolsEnabled: false, browserSearchEngine: 'google'
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
window.modelConfig = { providers: { openrouter: { modelOverrides: {
  'fixture/alpha': { hidden: true }, 'fixture/beta': { hidden: true }
} } } };
window.savedModelsConfigs = [];
window.defaultModelChoice = null;
window.savedDefaultModels = [];
window.deferredModelSaves = [];
window.deferredModelInventories = [];
window.pi = {
  libraryStatus: () => count('libraryStatus', { ok: true, value: { preferences: { enabled: true, directory: null, maxBytes: 2*1024**3 }, directory: '/fixture/library', usedBytes: 0, total: 0, unsaved: 0, projects: [], scanning: false, scanErrors: 0, lastScanAt: null } }),
  onLibraryChanged: () => () => {},
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
  setBrowserSearchEngine: (v) => { appInfo.browserSearchEngine = v; return count('setBrowserSearchEngine', v) },
  onBrowserSearchEngineChanged: () => () => {},
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
  providers: () => count('providers', [
    { id: 'openai', name: 'OpenAI', authTypes: ['api_key', 'oauth'], authenticated: false, canLogin: true, builtin: true, custom: false, discoverable: false, modelCount: 1 },
    { id: 'openrouter', name: 'OpenRouter', authTypes: ['api_key'], authenticated: false, canLogin: true, builtin: true, custom: true, discoverable: false, api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api/v1', modelCount: 2 },
    { id: 'openai-codex', name: 'OpenAI Codex', authTypes: ['oauth'], authenticated: false, canLogin: true, builtin: true, custom: false, discoverable: false, api: 'openai-codex-responses', modelCount: 0 },
    ...Object.entries(window.modelConfig.providers).filter(([id]) => !['openai','openrouter','openai-codex'].includes(id)).map(([id, entry]) => ({
      id, name: entry.name || id, authTypes: ['api_key'], authenticated: !!entry.apiKey, canLogin: false,
      builtin: false, custom: true, discoverable: true, api: entry.api, baseUrl: entry.baseUrl, modelCount: entry.models?.length || 0
    }))
  ]),
  providerModels: (providerId) => {
    const inventory = providerId === 'openrouter' ? ['fixture/alpha', 'fixture/beta'].map(id => ({
      id, name: id, contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ['text', 'image'],
      api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api/v1', source: 'builtin', hasOverride: false, available: true,
      hidden: window.modelConfig.providers[providerId]?.modelOverrides?.[id]?.hidden === true
    })) : (window.modelConfig.providers[providerId]?.models || []).map(model => ({
      ...model, name: model.name || model.id, contextWindow: model.contextWindow || 0, maxTokens: model.maxTokens || 0,
      reasoning: !!model.reasoning, input: model.input || ['text'], source: 'custom', hasOverride: false, available: true,
      hidden: window.modelConfig.providers[providerId]?.modelOverrides?.[model.id]?.hidden === true
    }));
    return count('providerModels', window.deferModelInventories
      ? new Promise(resolve => window.deferredModelInventories.push(() => resolve(inventory)))
      : inventory);
  },
  models: () => count('models', [{ providerId: 'openai', providerName: 'OpenAI', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: true, thinkingLevels: ['low', 'medium', 'high'], input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384, available: true, costInputPerM: 0, costOutputPerM: 0 }]),
  defaultModel: () => count('defaultModel', window.defaultModelChoice),
  modelsConfig: () => count('modelsConfig', window.modelConfig),
  saveModelsConfig: (config) => {
    window.savedModelsConfigs.push(structuredClone(config));
    if (window.modelsConfigSaveFailure) return Promise.reject(new Error('Fixture cannot write provider configuration'));
    window.modelConfig = structuredClone(window.modelsConfigWriteResult ?? config);
    delete window.modelsConfigWriteResult;
    const written = window.modelConfig;
    return count('saveModelsConfig', window.deferModelSaves
      ? new Promise(resolve => window.deferredModelSaves.push(() => resolve(written)))
      : written);
  },
  login: (id, kind) => { window.lastLogin = { id, kind }; return count('login', undefined) },
  logout: (id) => count('logout', undefined),
  // The provider detail page drives OAuth flows inline: it subscribes to the
  // auth events and may reply/cancel through these.
  replyAuth: () => count('replyAuth', undefined),
  cancelLogin: (id) => count('cancelLogin', id),
  onAuthPrompt: () => () => {},
  onAuthDismiss: () => () => {},
  onAuthNotify: () => () => {},
  configuredModels: () => count('configuredModels', [{
    providerId:'openrouter', providerName:'OpenRouter', id:'fixture/source', name:'Fixture source',
    contextWindow:128000, maxTokens:4096, reasoning:true, input:['text','image'],
    cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0.2}, compat:{supportsStore:false}
  }]),
  catalogPreset: () => count('catalogPreset', {
    exactMatches:1, matchedProviderName:'Fixture', preset:{contextWindow:64000,maxTokens:2048},
    price:{status:'unreliable',reason:'no-exact-match'}
  }),
  testModel: (id, model) => count('testModel', { ok: true, latencyMs: 12, status: 200, model }),
  readSkill: () => count('readSkill', { path: '/skills/github/SKILL.md', text: '# github — Skill body.', truncated: false }),
  openPath: () => count('openPath', undefined),
  showInFolder: () => count('showInFolder', undefined),
  setSkillModelInvocation: (path, disabled) => count('setSkillModelInvocation', { ...catalog }),
  setDefaultModel: (providerId, modelId) => {
    window.defaultModelChoice = { providerId, modelId };
    window.savedDefaultModels.push(window.defaultModelChoice);
    return count('setDefaultModel', undefined);
  },
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
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return
      await pause(50)
    }
    console.log('WAIT STATE', await evaluate('JSON.stringify({dialogs:[...document.querySelectorAll("[role=dialog]")].map(dialog=>({name:dialog.getAttribute("aria-label"),text:dialog.innerText})),saveButton:[...document.querySelectorAll("button")].filter(button=>button.textContent.trim()===window.en["settings.saveModel"]).map(button=>({disabled:button.disabled,inert:!!button.closest("[inert]")})),writes:window.savedModelsConfigs.length,calls:window.calls.slice(-12),exceptions:document.querySelectorAll("[role=alert]").length})'))
    assert.fail(message)
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
  //    data reads: General populated, the rest empty.
  await pause(500)
  let panels = await evaluate('window.panels()')
  assert.equal(panels.length, 17, 'all registered section panels exist in the DOM')
  assert.equal(panels.filter((p) => !p.hidden).length, 1, 'exactly one panel is active')
  assert.ok(panels[0].inputs >= 2, 'General (first section) is the mounted one')
  assert.ok(panels.slice(1).every((p) => p.content === 0), 'unvisited panels render no section content (header scaffold only)')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 0, 'no catalog read on open')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 0, 'no subagent profile read on open')
  assert.equal(await evaluate('window.callsOf("usageStats")'), 0, 'no usage aggregation on open')
  assert.equal(await evaluate('window.callsOf("providers")'), 0, 'no providers read on open')
  assert.equal(await evaluate('window.callsOf("libraryStatus")'), 0, 'an unvisited Library makes no IPC reads')

  // 2. A draft held in General survives tab round trips: the deactivated
  //    panel keeps its React state instead of remounting from props.
  assert.equal(await evaluate(`window.typeWait('12.5')`), '12.5', 'the wait field accepts a typed draft')

  // 3. The new Notifications page owns both native alerts and sounds; General
  //    stays mounted but no longer carries those controls.
  await evaluate(`window.openTab('Notifications')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[2].hidden && panels[2].content > 0, 'Notifications is a real lazily mounted section')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'opening Notifications preserves the General draft')

  // 4. Picture in picture reads its preferences only on first visit.
  assert.equal(await evaluate('window.callsOf("pictureInPicturePreferences")'), 0)
  await evaluate(`window.openTab('Picture in picture')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[7].hidden && panels[7].content > 0, 'Picture in picture is a lazily mounted section')
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
  assert.ok(panels[9].tools >= 2, 'Tools renders its list once visited')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 1, 'catalog fetched on first visit')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 6. Visiting Subagents mounts it once and fetches the profile list once;
  //    its catalog refresh rides the SAME catalog read Tools started.
  await evaluate(`window.openTab('Subagents')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[10].hidden, 'Subagents is the active panel')
  assert.ok(panels[10].inputs >= 1, 'Subagents renders its concurrency field (the toggle is a checkbox button)')
  assert.ok(panels[10].content > 0, 'Subagents renders its profile list once visited')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'profiles fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'Subagents shares the catalog: its first visit refreshes it once, like Skills')
  assert.ok(panels[0].hidden && panels[0].inputs >= 2, 'General stays mounted while hidden')
  assert.equal(await evaluate('window.waitValue()'), '12.5', 'the hidden General draft is intact')

  // 7. Visiting Usage must not refire Tools' or Subagents' mount effects —
  //    the deactivated panels' subtrees are kept, not torn down.
  await evaluate(`window.openTab('Usage')`)
  panels = await evaluate('window.panels()')
  assert.ok(!panels[14].hidden, 'Usage is the active panel')
  assert.ok((await evaluate('window.callsOf("usageStats")')) >= 1, 'usage fetched on first visit')
  assert.equal(await evaluate('window.callsOf("toolsCatalog")'), 2, 'a hidden Tools/Subagents panel does not refetch the catalog')
  assert.equal(await evaluate('window.callsOf("subagentProfiles")'), 1, 'a hidden Subagents panel does not refetch profiles')
  assert.ok(panels[9].tools >= 2, 'the hidden Tools list is still mounted')

  await evaluate(`window.openTab('Library')`)
  assert.equal(await evaluate('window.callsOf("libraryStatus")'), 1, 'Library first visit reads its independent archive status')
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="Maximum archive size"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'3072');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await evaluate(`window.openTab('Usage')`)
  await evaluate(`window.openTab('Library')`)
  assert.equal(await evaluate(`document.querySelector('input[aria-label="Maximum archive size"]').value`), '3072', 'Library retains an unapplied capacity draft when revisited')
  assert.equal(await evaluate('window.callsOf("libraryStatus")'), 1, 'revisiting Library reuses its mounted status subscription')

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
  // Credentials share one group with the connection test, but the key itself
  // still collapses to a single status row: no key field on its own line, and
  // the row's actions sit beside the status text.
  const jevCredentials = await evaluate(`(() => { const row = [...document.querySelectorAll('[data-jev-settings] .divide-y > *')].find(r => r.textContent.includes(window.en['jev.keyStatus'])); const box = row.getBoundingClientRect(); const buttons = [...row.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)); return { buttons, rowTop: Math.round(box.top), rowBottom: Math.round(box.bottom) } })()`)
  console.log('CONTROL jev credentials', JSON.stringify(jevCredentials))
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

  // The OpenAI OAuth action introduced by the SDK names ChatGPT explicitly
  // in both locales and keeps the existing provider login IPC contract.
  // Unconfigured providers are selected from the toolbar's
  // provider chooser opens their detail sub-page instead.
  await evaluate(`window.openTab(window.zh['settings.providers'])`)
  assert.equal(await evaluate(`document.body.textContent.includes(window.zh['settings.signInWithChatGPT'])`), false, 'unconfigured providers stay out of the list')
  await evaluate(`
    window.pickNewProvider = (name) => {
      const item = [...document.querySelectorAll('[role="listbox"][aria-hidden="false"] [data-provider-option]')].find((el) => el.textContent.includes(name));
      if (!item) throw new Error('provider missing from the chooser: ' + name);
      item.click();
    };
    document.querySelector('button[aria-label="' + window.zh['settings.addProvider'] + '"]').click();
  `)
  await waitFor(`!!document.querySelector('[role="listbox"][aria-hidden="false"] [data-provider-option]')`, 'the provider dropdown opens')
  await evaluate(`window.pickNewProvider('OpenAI')`)
  // The access pane defaults to the API key field; switch to OAuth first.
  // Scope by the switcher's aria-label — visited settings tabs keep their
  // own (hidden) radios mounted, so a bare [role=radio] query would match
  // the Jev section's instead.
  await waitFor(`!!document.querySelector('div[aria-label="' + window.zh['settings.signInMethod'] + '"] [role=radio]')`, 'the provider detail sub-page opens with the method switcher')
  await evaluate(`
    const group = document.querySelector('div[aria-label="' + window.zh['settings.signInMethod'] + '"]');
    [...group.querySelectorAll('[role=radio]')].find((el) => el.closest('label')?.textContent.trim() === 'OAuth')?.click();
  `)
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === window.zh['settings.signInWithChatGPT'])`, 'the OAuth pane offers ChatGPT sign-in')
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === window.zh['settings.signInWithChatGPT']).click()`)
  assert.deepEqual(await evaluate('window.lastLogin'), { id: 'openai', kind: 'oauth' })
  await evaluate('window.changeLocale("en")')
  await pause(100)
  assert.equal(await evaluate(`document.body.textContent.includes(window.en['settings.signInWithChatGPT'])`), true)
  await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.backToList'] + '"]').click()`)
  await waitFor(`!!document.querySelector('button[aria-label="' + window.en['settings.viewProvider'].replace('{name}', 'OpenRouter') + '"]')`, 'the provider list reopens')

  // Showing all models removes the last hide-only override. The backend is
  // allowed to return an empty providers map; that must not remove settings.
  await evaluate(`
    window.providerField = key => {
      const scope = document.querySelector('[role=dialog][aria-modal=true]') ?? document.querySelector('[data-provider-settings]');
      const label = [...scope.querySelectorAll('label')].find(label => label.textContent.trim() === window.en[key]);
      return label ? document.getElementById(label.htmlFor) : null;
    };
    window.providerButton = key => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === window.en[key] && !button.closest('[hidden], [inert]') && button.getClientRects().length > 0);
    window.providerDeleteRow = () => [...document.querySelectorAll('p')].find(p => p.textContent === window.en['settings.deleteProvider'])?.parentElement.parentElement;
    window.modelRows = () => [...document.querySelectorAll('[data-provider-model]')];
    window.hiddenModelCount = () => window.modelRows().filter(row => [...row.querySelectorAll('span')].some(span => span.textContent === window.en['settings.modelHidden'])).length;
    window.openProvider = name => document.querySelector('button[aria-label="' + window.en['settings.viewProvider'].replace('{name}', name) + '"]').click();
    window.editProviderField = (key, value) => {
      const input = window.providerField(key);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.openProvider('OpenRouter');
  `)
  await waitFor(`!!window.providerField('settings.baseUrl') && !window.providerButton('settings.unhideAllModels').disabled`, 'OpenRouter detail loads its hidden model inventory')
  assert.equal(await evaluate(`['settings.displayName', 'settings.baseUrl', 'settings.apiKeyOptional'].every(key => window.providerField(key) instanceof HTMLInputElement)`), true, 'all provider fields are present before visibility changes')
  assert.equal(await evaluate(`window.providerField('settings.baseUrl').value`), 'https://openrouter.ai/api/v1', 'the inherited URL remains visible')
  assert.equal(await evaluate(`document.body.textContent.includes(window.en['settings.deleteProvider'])`), true, 'a stored override can be removed')
  await evaluate(`
    window.originalProviderFields = ['settings.displayName', 'settings.baseUrl', 'settings.apiKeyOptional'].map(window.providerField);
    window.originalDeleteRow = window.providerDeleteRow();
    window.modelsConfigWriteResult = { providers: {} };
    window.providerButton('settings.unhideAllModels').click();
  `)
  await waitFor(`window.savedModelsConfigs.length === 1 && window.providerButton('settings.unhideAllModels').disabled`, 'show all saves and refreshes model visibility')
  assert.deepEqual(await evaluate('window.savedModelsConfigs[0]'), { providers: { openrouter: { modelOverrides: {} } } }, 'show all removes the hidden flags instead of preserving an empty override')
  assert.deepEqual(await evaluate('window.modelConfig'), { providers: {} }, 'the fixture adopts the sanitized empty config')
  assert.equal(await evaluate(`['settings.displayName', 'settings.baseUrl', 'settings.apiKeyOptional'].every((key, index) => window.providerField(key) === window.originalProviderFields[index])`), true, 'provider fields stay mounted after the final override disappears')
  assert.equal(await evaluate('window.providerDeleteRow() === window.originalDeleteRow'), true, 'clearing the hidden flags keeps the Delete provider row mounted')
  assert.equal(await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.api'] + '"]').textContent.trim()`), 'anthropic-messages', 'the registry API remains displayed')
  assert.equal(await evaluate(`window.providerButton('settings.hideAllModels').disabled`), false, 'the restored models can still be hidden')

  // Editing fields after the empty entry was dropped creates a fresh override.
  await evaluate(`window.editProviderField('settings.baseUrl', 'https://fixture.invalid/v1')`)
  await waitFor('window.savedModelsConfigs.length === 2', 'provider URL edits still save after showing all models')
  assert.equal(await evaluate('window.modelConfig.providers.openrouter.baseUrl'), 'https://fixture.invalid/v1')
  await evaluate(`window.providerButton('settings.hideAllModels').click()`)
  await waitFor(`window.savedModelsConfigs.length === 3 && !window.providerButton('settings.unhideAllModels').disabled`, 'hide all refreshes the model inventory')
  assert.deepEqual(await evaluate('window.modelConfig.providers.openrouter'), {
    baseUrl: 'https://fixture.invalid/v1',
    modelOverrides: { 'fixture/alpha': { hidden: true }, 'fixture/beta': { hidden: true } }
  }, 'visibility changes preserve provider settings')
  await evaluate(`window.providerButton('settings.unhideAllModels').click()`)
  await waitFor(`window.savedModelsConfigs.length === 4 && window.providerButton('settings.unhideAllModels').disabled`, 'show all refreshes the models again')
  assert.equal(await evaluate(`window.providerField('settings.baseUrl').value`), 'https://fixture.invalid/v1', 'a configured URL survives show all')
  assert.deepEqual(await evaluate('window.modelConfig.providers.openrouter.modelOverrides'), {})

  // Restoring the inherited URL also drops the now-empty entry, with the
  // settings still present when returning to this provider's detail page.
  const inventoryReadsBeforeReset = await evaluate('window.callsOf("providerModels")')
  await evaluate(`window.modelsConfigWriteResult = { providers: {} }; window.editProviderField('settings.baseUrl', 'https://openrouter.ai/api/v1')`)
  await waitFor(`window.savedModelsConfigs.length === 5 && window.callsOf('providerModels') > ${inventoryReadsBeforeReset}`, 'resetting the URL saves and refreshes its inherited value')
  assert.equal(await evaluate(`window.providerField('settings.baseUrl').value`), 'https://openrouter.ai/api/v1')

  // Hold backend responses to prove visibility updates on the next frame,
  // then deliver them out of order while the user keeps switching. An old
  // inventory must not bring the Hidden badges back or remount model rows.
  await evaluate(`window.originalModelRows = window.modelRows(); window.deferModelSaves = true`)
  const clickVisibility = async (key, hiddenCount) => {
    await evaluate(`window.providerButton(${JSON.stringify(key)}).click(); new Promise(requestAnimationFrame)`)
    assert.equal(await evaluate('window.hiddenModelCount()'), hiddenCount, 'Hidden badges update before the save responds')
    assert.equal(await evaluate(`window.providerButton('settings.hideAllModels').disabled`), hiddenCount === 2, 'hide-all availability immediately follows the current draft')
    assert.equal(await evaluate(`window.providerButton('settings.unhideAllModels').disabled`), hiddenCount === 0, 'show-all availability immediately follows the current draft')
    assert.equal(await evaluate('window.providerDeleteRow() === window.originalDeleteRow'), true, 'visibility clicks keep the Delete provider row mounted')
  }
  await clickVisibility('settings.hideAllModels', 2)
  await clickVisibility('settings.unhideAllModels', 0)
  await clickVisibility('settings.hideAllModels', 2)
  assert.equal(await evaluate('window.deferredModelSaves.length'), 3, 'rapid visibility changes are all submitted without waiting for older saves')
  await evaluate('window.deferredModelSaves[0](); new Promise(requestAnimationFrame)')
  assert.equal(await evaluate('window.hiddenModelCount()'), 2, 'an older save result cannot overwrite the latest draft')
  await evaluate('window.deferModelInventories = true; window.deferredModelSaves[2]()')
  await waitFor('window.deferredModelInventories.length === 1', 'the latest save starts a delayed inventory refresh')
  await evaluate('window.modelsConfigWriteResult = { providers: {} }')
  await clickVisibility('settings.unhideAllModels', 0)
  await evaluate('window.deferredModelInventories[0](); window.deferredModelSaves[1](); new Promise(requestAnimationFrame)')
  assert.equal(await evaluate('window.hiddenModelCount()'), 0, 'stale hidden inventory and older save results do not flash badges back on')
  await evaluate('window.deferredModelSaves[3]()')
  await waitFor('window.deferredModelInventories.length === 2', 'the final save refreshes the visible inventory')
  await evaluate('window.deferredModelInventories[1](); window.deferModelSaves = false; window.deferModelInventories = false; new Promise(requestAnimationFrame)')
  assert.equal(await evaluate('window.hiddenModelCount()'), 0, 'settling every response preserves the latest visible state')
  assert.equal(await evaluate('window.modelRows().every((row, index) => row === window.originalModelRows[index])'), true, 'visibility changes retain existing model row nodes')
  assert.equal(await evaluate('window.providerDeleteRow() === window.originalDeleteRow'), true, 'the Delete row survives sanitized empty configurations')
  assert.equal(await evaluate('window.providerDeleteRow().querySelector("button").disabled'), false, 'the Delete action remains available when all models are visible')

  await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.backToList'] + '"]').click()`)
  await waitFor(`!!document.querySelector('button[aria-label="' + window.en['settings.viewProvider'].replace('{name}', 'OpenRouter') + '"]')`, 'the provider list reopens')
  await evaluate(`window.openProvider('OpenRouter')`)
  await waitFor(`!!window.providerField('settings.baseUrl')`, 'an unconfigured built-in provider exposes settings on first mount')
  assert.equal(await evaluate(`window.providerField('settings.baseUrl').value`), 'https://openrouter.ai/api/v1')
  assert.equal(await evaluate('!!window.providerDeleteRow()'), true, 'the Delete row stays visible on reentry with all models shown')

  await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.backToList'] + '"]').click()`)
  // Wait for the overview to be fully mounted before opening the dropdown:
  // the toolbar button is always present, and the exiting detail page still
  // carries an API select the next waitFor could latch onto.
  await waitFor(`!!document.querySelector('button[aria-label="' + window.en['settings.viewProvider'].replace('{name}', 'OpenRouter') + '"]')`, 'the provider list reopens')
  await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.addProvider'] + '"]').click()`)
  await waitFor(`!!document.querySelector('[role="listbox"][aria-hidden="false"] [data-provider-option]')`, 'the provider dropdown opens')
  await evaluate(`window.pickNewProvider('OpenAI Codex')`)
  await waitFor(`!!document.querySelector('button[aria-label="' + window.en['settings.api'] + '"]')`, 'OAuth-only provider settings load')
  assert.equal(await evaluate(`document.querySelector('button[aria-label="' + window.en['settings.api'] + '"]').textContent.trim()`), 'openai-codex-responses', 'OAuth-only providers retain their own registry API')
  assert.equal(await evaluate(`window.providerField('settings.apiKeyOptional') === null`), true, 'OAuth-only providers do not gain an API-key field')

  // The new connection flow validates identity, waits for persistence, and retains a failed draft.
  const providerShot = async name => {
    if (!process.env.PI_PROVIDER_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_PROVIDER_SCREENSHOT_DIR, { recursive: true })
    await pause(250)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(process.env.PI_PROVIDER_SCREENSHOT_DIR, name + '.png'), Buffer.from(shot.data, 'base64'))
  }
  const clickProviderText = async key => {
    await evaluate('window.providerButton(' + JSON.stringify(key) + ').click()')
    await pause(100)
  }
  await evaluate('document.querySelector("[data-provider-detail] button").click()')
  await waitFor('!document.querySelector("[data-provider-detail]")', 'overview returns')
  await waitFor('document.querySelectorAll("[data-default-model-slot]").length === 3', 'all three default model controls appear')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-default-model-slot]")].map(row => ({slot:row.dataset.defaultModelSlot,disabled:row.querySelector("button").disabled}))'), [
    {slot:'main',disabled:false}, {slot:'vision',disabled:true}, {slot:'advisor',disabled:true}
  ], 'only the main session model is active; Vision and Advisor are placeholders')
  await evaluate('document.querySelector("[data-default-model-slot=vision] button").click(); document.querySelector("[data-default-model-slot=advisor] button").click()')
  assert.deepEqual(await evaluate('window.savedDefaultModels'), [], 'placeholder controls never update the effective default')
  await evaluate('document.querySelector("[data-default-model-slot=main] button").click()')
  await waitFor('!!document.querySelector("#default-model-picker-main[aria-hidden=false] [data-model-option]")', 'main session default uses the shared model picker')
  await providerShot('default-model-picker')
  await evaluate(`document.querySelector('#default-model-picker-main [data-model-option="openai/gpt-6.1-sol"]').click()`)
  await waitFor('document.querySelector("[data-default-model-slot=main] button").textContent.includes("GPT-6.1 Sol")', 'the saved main session default is displayed')
  assert.deepEqual(await evaluate('window.savedDefaultModels'), [{providerId:'openai',modelId:'gpt-6.1-sol'}], 'main default selection retains the existing persistence contract')
  assert.equal(await evaluate('document.querySelector("[data-default-model-slot=main] button").getAttribute("aria-expanded")'), 'false', 'default selection closes immediately even for a reasoning model')
  assert.equal(await evaluate('!!document.querySelector("[data-thinking-panel]")'), false, 'default model preferences do not open a thinking submenu')
  await evaluate('document.querySelector("[data-default-model-slot=main] button").click()')
  await waitFor('document.getElementById("default-model-picker-main").getAttribute("aria-hidden") === "false"', 'the shared default picker reopens')
  await evaluate('document.querySelector("#default-model-picker-main [data-model-option]").focus(); window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
  await waitFor('document.getElementById("default-model-picker-main").getAttribute("aria-hidden") === "true"', 'Escape closes the shared default picker')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), await evaluate('window.en["settings.mainDefaultModel"]'), 'the default picker restores its trigger focus')
  await providerShot('providers-overview')
  await evaluate('window.changeLocale("zh-CN")')
  await pause(100)
  await providerShot('providers-overview-zh-CN')
  await evaluate('window.changeLocale("en")')
  await pause(100)
  await clickProviderText('settings.addProvider')
  await waitFor('!!document.querySelector("[role=listbox][aria-hidden=false] [data-provider-option]")', 'provider dropdown opens')
  assert.equal(await evaluate('!!document.querySelector("[role=dialog][aria-modal=true]")'), false, 'adding a provider uses a dropdown without a modal')
  assert.equal(await evaluate('document.body.style.overflow'), '', 'the provider dropdown keeps the settings page scrollable')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), await evaluate('window.en["settings.addProviderSearch"]'), 'the provider dropdown focuses its search')
  assert.equal(await evaluate('!!document.activeElement.closest("[role=listbox][aria-hidden=false]")'), true, 'search focus belongs to the open dropdown')
  await providerShot('provider-chooser')
  await evaluate(`(()=>{const input=document.querySelector('[role=listbox][aria-hidden=false] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'Codex');input.dispatchEvent(new Event("input",{bubbles:true}))})()`)
  await waitFor('document.querySelectorAll("[role=listbox][aria-hidden=false] [data-provider-option]").length === 1', 'provider dropdown search filters the choices')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
  await waitFor(`document.querySelector('button[aria-label="' + window.en['settings.addProvider'] + '"]').getAttribute('aria-expanded') === 'false'`, 'Escape closes the provider dropdown')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), await evaluate('window.en["settings.addProvider"]'), 'closing the provider dropdown restores trigger focus')
  await clickProviderText('settings.addProvider')
  await waitFor('document.querySelector("[role=listbox][aria-hidden=false] input")?.value === ""', 'reopening the provider dropdown resets its search')
  await clickProviderText('settings.addCustomProvider')
  await waitFor('!!document.querySelector("[data-custom-provider]")', 'custom connection form opens')
  await evaluate("window.editProviderField('settings.providerId', 'openai'); window.editProviderField('settings.baseUrl', 'http://localhost:11434/v1')")
  const writesBeforeDuplicate = await evaluate('window.savedModelsConfigs.length')
  await clickProviderText('settings.providerCreateAndConfigure')
  assert.equal(await evaluate('document.querySelector("[data-custom-provider] [role=alert]").textContent'), await evaluate('window.en["settings.providerIdExists"]'))
  assert.equal(await evaluate('window.savedModelsConfigs.length'), writesBeforeDuplicate, 'a built-in ID cannot be overwritten by custom creation')
  await evaluate("window.editProviderField('settings.providerId', 'fixture-local'); window.editProviderField('settings.displayName', 'Local fixture'); window.modelsConfigSaveFailure = true")
  await clickProviderText('settings.providerCreateAndConfigure')
  await waitFor('!!document.querySelector("[data-custom-provider] [role=alert]")', 'failed creation retains its form')
  assert.equal(await evaluate("window.providerField('settings.providerId').value"), 'fixture-local')
  await providerShot('custom-provider-failed-save')
  await evaluate('window.modelsConfigSaveFailure = false')
  await clickProviderText('settings.providerCreateAndConfigure')
  await waitFor('document.querySelector("[data-provider-detail]")?.dataset.providerDetail === "fixture-local"', 'created connection opens only after saving')
  assert.equal(await evaluate('window.modelConfig.providers["fixture-local"].name'), 'Local fixture')
  const testsBeforeKey = await evaluate('window.callsOf("testModel")')
  await evaluate("window.editProviderField('settings.apiKeyOptional', 'fixture-secret')")
  await waitFor('window.modelConfig.providers["fixture-local"].apiKey === "fixture-secret"', 'key edits autosave')
  assert.equal(await evaluate('window.callsOf("testModel")'), testsBeforeKey, 'saving a key does not send a model request')

  // Model editing uses a separate draft. Copy is a nested, keyboard-dismissable dialog.
  await clickProviderText('settings.addModel')
  await waitFor('!!document.querySelector("[role=dialog]")', 'model editor opens')
  await evaluate("window.editProviderField('settings.modelId', 'fixture-new'); window.editProviderField('settings.modelName', 'New fixture model')")
  await providerShot('model-editor')
  await clickProviderText('settings.copyFromModel')
  await waitFor('!!document.querySelector("[data-copy-model]")', 'copy sources load')
  assert.equal(await evaluate('document.querySelectorAll("[role=dialog][aria-modal=true]").length'), 1, 'only the child traps focus')
  await providerShot('model-copy')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true }))')
  await waitFor('!document.querySelector("[data-copy-model]")', 'Escape dismisses only the copy picker')
  assert.equal(await evaluate("window.providerField('settings.modelId').value"), 'fixture-new', 'nested dismissal keeps the editor draft')
  assert.equal(await evaluate('document.body.style.overflow'), 'hidden', 'parent modal retains its scroll lease')
  await clickProviderText('settings.copyFromModel')
  await waitFor('!!document.querySelector("[data-copy-model]")', 'copy picker reopens')
  await evaluate('document.querySelector("[data-copy-model]").click()')
  await waitFor("window.providerField('settings.contextWindow').value === '128000'", 'copy applies the chosen configuration')
  assert.equal(await evaluate("window.providerField('settings.modelId').value"), 'fixture-new', 'copy retains the destination ID')
  await evaluate('window.modelsConfigSaveFailure = true')
  await clickProviderText('settings.saveModel')
  await waitFor('!!document.querySelector("[role=dialog] [role=alert]")', 'a failed model save retains the editor')
  await evaluate('window.modelsConfigSaveFailure = false')
  await clickProviderText('settings.saveModel')
  await waitFor('!document.querySelector("[role=dialog]")', 'retry saves and closes the model editor')
  assert.equal(await evaluate('window.modelConfig.providers["fixture-local"].models.length'), 1, 'retry never duplicates a newly staged model')
  assert.equal(await evaluate('window.modelConfig.providers["fixture-local"].models[0].contextWindow'), 128000)
  assert.deepEqual(await evaluate('window.modelConfig.providers["fixture-local"].models[0].compat'), { supportsStore:false })
  await waitFor('!!document.querySelector("[data-provider-model]")', 'the saved model reaches the inventory')
  await providerShot('provider-detail')
  await evaluate('window.changeLocale("zh-CN")')
  await pause(100)
  await providerShot('provider-models-zh-CN')
  await evaluate('window.changeLocale("en")')
  await pause(100)
  // Search controls have accessible names instead of visible labels.
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="' + window.en['settings.searchProviderModels'] + '"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'missing');input.dispatchEvent(new Event("input",{bubbles:true}))})()`)
  await waitFor('document.querySelectorAll("[data-provider-model]").length === 0', 'model search filters the inventory')
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="' + window.en['settings.searchProviderModels'] + '"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'');input.dispatchEvent(new Event("input",{bubbles:true}))})()`)
  await waitFor('!!document.querySelector("[data-provider-model]")', 'clearing search restores models')
  await clickProviderText('settings.hideAllModels')
  assert.equal(await evaluate('document.querySelector("[data-provider-model] [role=checkbox]").getAttribute("aria-checked")'), 'false', 'model enable control follows visibility immediately')
  await clickProviderText('settings.unhideAllModels')
  await evaluate('window.changeLocale("zh-TW"); document.documentElement.classList.add("dark"); window.setUiStyle("squircle")')
  await pause(200)
  await providerShot('provider-detail-dark-tw')
  // On a short window, the modal footer remains in reach while the body scrolls.
  await evaluate('document.querySelector("[data-provider-detail] button").click()')
  await waitFor('!document.querySelector("[data-provider-detail]")', 'overview returns in Traditional Chinese')
  await evaluate('window.changeLocale("en")')
  await waitFor(`!!document.querySelector('button[aria-label="' + window.en['settings.viewProvider'].replace('{name}', 'Local fixture') + '"]')`, 'the custom connection returns in the English overview')
  await evaluate("window.openProvider('Local fixture')")
  await waitFor('!!document.querySelector("[data-provider-detail]")', 'custom provider reopens')
  await clickProviderText('settings.addModel')
  await waitFor('!!document.querySelector("[role=dialog]")', 'model editor reopens')
  await send('Emulation.setDeviceMetricsOverride', { width:880, height:620, deviceScaleFactor:1, mobile:false })
  await providerShot('model-editor-short-window')
  const footerBox = await evaluate('(()=>{const button=window.providerButton("settings.saveModel"),r=button.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()')
  assert(footerBox.top >= 0 && footerBox.bottom <= footerBox.height, 'the model Save action stays inside a short viewport')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true }))')
  await waitFor('!document.querySelector("[role=dialog]")', 'model editor dismisses by keyboard')
  assert.equal(await evaluate('document.body.style.overflow'), '', 'closing model windows releases scroll ownership')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: settings tabs — lazy sections, persistent drafts, stable provider settings and immediate visibility under delayed responses')
} finally {
  try { child?.kill('SIGKILL') } catch {}
  try { await server?.close() } catch {}
}
