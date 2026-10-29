/**
 * Settings → Subagents regression check: the section owns the delegation
 * switch and concurrency limit (moved out of General), lists every subagent
 * profile as an ordinary file, and edits a profile's enabled tools in place.
 *
 * - Registry: the nav gains a Subagents entry after Tools; General no longer
 *   renders the enable checkbox or the concurrency field.
 * - The toggle flips through `setSubagentsEnabled`; the concurrency input
 *   disables while subagents are off.
 * - Profiles: list/detail from `subagents:profiles` — scope badge, file path,
 *   frontmatter fields, system prompt preview.
 * - Frontmatter fields: not presented at all — the file is their only
 *   editor; even the path rides the open-file button's hover tooltip. The
 *   debugger is an ordinary tool grant (all, or an explicit debug entry),
 *   with no dedicated switch.
 * - Tool editor: SDK built-ins + extension tools from the shared catalog, the
 *   MCP section collapsed into ONE family row (a tri-state select-all beside
 *   the still-independent per-tool grants), every namespaced family in a section
 *   collapsed into one tri-state row (select-all/clear in one gesture, members
 *   still individually checkable), profile-carried unknown names preserved on
 *   save, empty selection blocked, Reset returning to the saved state, and the
 *   save payload in canonical order.
 * - Annotations: `tool_preset` resolution states read on screen.
 * - Both locales; no renderer exceptions.
 *
 * Real `SettingsPage` in isolated Electron against a mocked `window.pi`; no
 * SDK, no model calls, no network. Run after building is NOT required (vite
 * serves the source): `node scripts/check-subagent-settings.mjs`.
 * `PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR` retains screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-subagent-settings-'))
const fixturePath = '/__subagent_settings_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ENABLE_LABEL = 'Subagents'
const CONCURRENCY_LABEL = 'Concurrent delegations'
const REUSE_LABEL = 'Reuse finished subagents'
const COMMS_LABEL = 'Parent–subagent communication'
const TURN_OVERRIDE_LABEL = 'Let the parent set turn limits'
const MAX_TURNS_LABEL = 'Default turn limit'

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { height: 100vh; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from '/src/components/app/settings/SettingsPage.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';

window.calls = [];
window.failProfileTools = false;
window.failCreate = false;
const count = (name, value) => { window.calls.push([name, value]); return Promise.resolve(value) };
const appInfo = {
  version: '9.9.9', checkpointsEnabled: true, startup: 'resume',
  subagentsEnabled: true, subagentMaxConcurrent: 4, subagentReuseEnabled: false, subagentCommsEnabled: false, bashMaxWaitMs: 10000,
  subagentTurnLimitOverrideEnabled: false, subagentMaxTurns: null,
  sandboxMode: 'workspace-write', sandbox: { support: 'ready', backend: 'seatbelt' }
};
const catalog = {
  tools: [
    { name: 'read', description: 'Read a file.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'bash', description: 'Run a command.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'edit', description: 'Edit a file.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'write', description: 'Write a file.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'grep', description: 'Grep.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'find', description: 'Find files.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'ls', description: 'List a directory.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'todo_write', description: 'Write the todo list.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'debug', description: 'Debug a session.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'browser_navigate', description: 'Open a page.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'browser_click', description: 'Click an element.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'browser_type', description: 'Type into a field.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'ctx_one', description: 'Extension tool one.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false },
    { name: 'ctx_two', description: 'Extension tool two.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false },
    { name: 'ffgrep', description: 'pi-fff grep.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/fff', label: 'pi-fff' }, active: true, disabledByExtension: false },
    { name: 'lens_diagnostics', description: 'Run LSP diagnostics.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/lens', label: 'pi-lens' }, active: true, disabledByExtension: false },
    { name: 'read_symbol', description: 'Read one symbol body.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/lens', label: 'pi-lens' }, active: true, disabledByExtension: false },
    { name: 'mcp', description: 'MCP gateway.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false },
    { name: 'mcpScript', description: 'MCP scripting.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false },
    { name: 'mcp__beui', description: 'One server proxy.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false },
    { name: 'mcp__beui__get_component', description: 'Get one component.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/native-mcp', label: 'MCP' }, active: false, disabledByExtension: false },
    { name: 'mcp__context7__resolve_library_id', description: 'Resolve a library.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/native-mcp', label: 'MCP' }, active: false, disabledByExtension: false },
    { name: 'list_mcp_resources', description: 'List resources.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/native-mcp', label: 'MCP' }, active: false, disabledByExtension: false },
    { name: 'codemode', description: 'Run a tool script.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/native-mcp', label: 'MCP' }, active: true, disabledByExtension: false },
    { name: 'tool_search', description: 'Find tools.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/native-mcp', label: 'MCP' }, active: true, disabledByExtension: false }
  ],
  extensions: [],
  skills: [],
  skillDiagnostics: []
};
let profiles = [
  { name: 'general-purpose', displayName: 'General Purpose', description: 'Versatile assistant.', systemPrompt: 'You are a general-purpose subagent.',
    tools: 'all', toolsSource: 'explicit', inheritContext: true, runInBackground: false, enabled: true, scope: 'global', filePath: '/agents/general-purpose.md' },
  { name: 'explore', displayName: 'Explorer', description: 'Read-only researcher.', systemPrompt: 'You are a research subagent.',
    tools: ['read', 'grep', 'find', 'ls', 'legacy-tool'], toolsSource: 'explicit', model: 'deepseek/chat', thinking: 'low', maxTurns: 12,
    inheritContext: false, runInBackground: false, enabled: true, scope: 'project', filePath: '/proj/.pi/agents/explore.md' },
  { name: 'piweb-agent', displayName: 'pi-web agent', description: 'Preset-based agent.', systemPrompt: 'You are preset-driven.',
    tools: ['read', 'grep', 'find', 'ls'], toolsSource: 'unresolved-preset', toolPreset: 'nope',
    inheritContext: true, runInBackground: false, enabled: true, scope: 'global', filePath: '/agents/piweb-agent.md' },
  { name: 'preset-agent', displayName: 'Preset agent', description: 'Resolved preset agent.', systemPrompt: 'You are preset-driven.',
    tools: ['find', 'grep', 'ls', 'read'], toolsSource: 'preset', toolPreset: 'piweb-agent-explore',
    inheritContext: true, runInBackground: false, enabled: false, scope: 'global', filePath: '/agents/preset-agent.md' }
];
const listDTO = () => ({ profiles, globalDir: '/agents', projectDir: '/proj/.pi/agents' });
window.pi = {
  appInfo: () => count('appInfo', appInfo),
  setStartup: (v) => count('setStartup', v),
  setSubagentsEnabled: (v) => count('setSubagentsEnabled', v),
  setSubagentMaxConcurrent: (v) => count('setSubagentMaxConcurrent', v),
  setSubagentReuseEnabled: (v) => count('setSubagentReuseEnabled', v),
  setSubagentCommsEnabled: (v) => count('setSubagentCommsEnabled', v),
  setSubagentTurnLimitOverrideEnabled: (v) => window.failTurnOverride ? Promise.reject(new Error('disk failure')) : count('setSubagentTurnLimitOverrideEnabled', v),
  setSubagentMaxTurns: (v) => window.failMaxTurns ? Promise.reject(new Error('disk failure')) : count('setSubagentMaxTurns', v),
  models: () => Promise.resolve([
    { providerId: 'fixture', id: 'standard', name: 'Fixture Standard', providerName: 'Fixture', reasoning: false,
      thinkingLevels: ['off'], input: ['text'], contextWindow: 32000, maxTokens: 4096, available: true, costInputPerM: 0, costOutputPerM: 0 },
    { providerId: 'deepseek', id: 'chat', name: 'Fixture Reasoning', providerName: 'DeepSeek', reasoning: true,
      thinkingLevels: ['off', 'low', 'high'], input: ['text'], contextWindow: 32000, maxTokens: 4096, available: true, costInputPerM: 0, costOutputPerM: 0 }
  ]),
  setSubagentProfileDefaults: (filePath, defaults) => {
    if (window.failDefaults) return Promise.reject(new Error('disk failure'));
    profiles = profiles.map(p => p.filePath === filePath ? {...p, ...defaults, model: defaults.model ?? undefined, thinking: defaults.thinking ?? undefined} : p);
    return count('setSubagentProfileDefaults', {filePath, defaults}).then(listDTO);
  },
  subagentProfiles: () => count('subagentProfiles', listDTO()),
  createSubagentProfile: (payload) => {
    if (window.failCreate) return Promise.reject(new Error('disk on fire'));
    const dir = payload.scope === 'project' ? '/proj/.pi/agents' : '/agents';
    // Mirror the loader: a same-name file in the new scope shadows the old row.
    profiles = [...profiles.filter((profile) => profile.name !== payload.name), {
      name: payload.name, displayName: payload.name, description: payload.description,
      systemPrompt: payload.systemPrompt, tools: ['read', 'grep', 'find', 'ls'], toolsSource: 'default',
      inheritContext: true, runInBackground: false, enabled: true, scope: payload.scope,
      filePath: dir + '/' + payload.name + '.md'
    }];
    return count('createSubagentProfile', payload).then(() => listDTO());
  },
  setSubagentProfileTools: (filePath, tools) => {
    if (window.failProfileTools) return Promise.reject(new Error('disk on fire'));
    return count('setSubagentProfileTools', { filePath, tools }).then(() => listDTO());
  },
  toolsCatalog: () => count('toolsCatalog', catalog),
  setBashMaxWaitMs: (v) => count('setBashMaxWaitMs', v),
  setCheckpointsEnabled: (v) => count('setCheckpointsEnabled', v),
  setSandboxMode: (v) => count('setSandboxMode', v),
  openExternal: () => count('openExternal', undefined),
  openPath: (p) => count('openPath', p),
  showInFolder: (p) => count('showInFolder', p)
};
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale', 'en');

window.tab = (label) => [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === label);
window.openTab = async (label) => { window.tab(label).click(); await new Promise((r) => setTimeout(r, 350)); };
window.profileRow = (name) => document.querySelector('[data-subagent-profile="' + name + '"] [role=tab]');
window.radioOf = (text) => [...document.querySelectorAll('[data-subagents-section] [role=radio]')].find((r) => r.closest('label')?.textContent.includes(text));
window.toolBox = (label) => document.querySelector('[data-subagent-tool="' + label + '"] button[role=checkbox]');
window.boxState = (label) => { const b = window.toolBox(label); return b ? b.getAttribute('aria-checked') : null };
window.checkedTools = () => [...document.querySelectorAll('[data-subagent-tool]')].filter((row) => row.querySelector('button[role=checkbox]').getAttribute('aria-checked') === 'true').map((row) => row.dataset.subagentTool);
window.familyBox = (prefix) => document.querySelector('[data-subagent-tool-family="' + prefix + '"] button[role=checkbox]');
window.familyState = (prefix) => { const b = window.familyBox(prefix); return b ? b.getAttribute('aria-checked') : null };
window.familyCount = (prefix) => document.querySelector('[data-subagent-tool-family="' + prefix + '"] [data-subagent-tool-family-count]')?.textContent.trim();
window.familyToggle = (prefix) => document.querySelector('[data-subagent-tool-family="' + prefix + '"] [data-subagent-tool-family-toggle]');
window.familyMembers = (prefix) => [...document.querySelectorAll('[data-subagent-tool-family="' + prefix + '"] [data-subagent-tool]')].map((r) => r.dataset.subagentTool);
window.callsOf = (name) => window.calls.filter((c) => c[0] === name).length;
window.type = (label, value) => {
  const el = document.querySelector('input[aria-label="' + label + '"], textarea[aria-label="' + label + '"]');
  if (!el) return null;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
};
window.createRadio = (label) => [...document.querySelectorAll('[data-subagent-create-form] [role=radio]')].find((r) => r.closest('label')?.textContent.includes(label));
window.typeConcurrent = (value) => {
  const el = document.querySelector('input[aria-label="' + ${JSON.stringify(CONCURRENCY_LABEL)} + '"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.blur();
  return el.value;
};

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
        name: 'subagent-settings-fixture',
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
    const timer = setTimeout(() => reject(new Error(`Electron debugger did not start: ${output}`)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Electron exited: ${code}`))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(`${endpoint}/json/list`)).json()).find((p) => p.type === 'page')
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
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const screenshot = async (name) => {
    if (!process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR, `${name}.png`), Buffer.from(capture.data, 'base64'))
  }
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`!!window.fixtureReady && !!document.querySelector('[role=tablist]')`)) break
    await pause(50)
  }
  assert.ok(await evaluate(`!!document.querySelector('[role=tablist]')`), 'fixture mounted')
  await pause(400)

  // 1. Registry: Subagents sits after Tools, and General no longer carries the
  //    subagent rows.
  const order = await evaluate(`[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`)
  const toolsIndex = order.indexOf('Tools')
  assert.ok(toolsIndex >= 0, 'the Tools section remains in the settings registry')
  assert.equal(order[toolsIndex + 1], 'Subagents', 'the Subagents entry follows Tools in the registry order')
  assert.equal(order.filter(label => label === 'Subagents').length, 1, 'the Subagents section appears once')
  assert.equal(await evaluate(`!!document.querySelector('button[role=checkbox][aria-label="${ENABLE_LABEL}"]')`), false, 'General no longer renders the subagents enable checkbox')
  assert.equal(await evaluate(`!!document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]')`), false, 'General no longer renders the concurrency field')

  // 2. The section owns the switch and the limit.
  await evaluate(`window.openTab('Subagents')`)
  await frame()
  assert.ok(await evaluate(`!!document.querySelector('[data-subagents-section]')`), 'the section renders')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]')?.value`), '4', 'the concurrency field shows the saved value')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${ENABLE_LABEL}"]').getAttribute('aria-checked')`), 'true', 'the switch is on')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${REUSE_LABEL}"]')?.getAttribute('aria-checked')`), 'false', 'the reuse switch defaults off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${COMMS_LABEL}"]')?.getAttribute('aria-checked')`), 'false', 'the communications switch defaults off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]')?.getAttribute('aria-checked')`), 'false', 'the model turn-limit grant defaults off')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').value`), '', 'the unlimited limit is rendered as a blank field')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').placeholder`), 'Unlimited')
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${ENABLE_LABEL}"]').click()`)
  await frame()
  assert.deepEqual((await evaluate('window.calls')).find((c) => c[0] === 'setSubagentsEnabled')?.[1], false, 'turning it off reaches the setter')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]').disabled`), true, 'the limit disables while subagents are off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${REUSE_LABEL}"]').disabled`), true, 'reuse disables while subagents are off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${COMMS_LABEL}"]').disabled`), true, 'communications disables while subagents are off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').disabled`), true, 'turn-limit permission disables with delegation')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').disabled`), true, 'the user turn limit disables with delegation')
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${ENABLE_LABEL}"]').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]').disabled`), false, 'and re-enables with it')
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${REUSE_LABEL}"]').click()`)
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${COMMS_LABEL}"]').click()`)
  await frame()
  assert.deepEqual(
    (await evaluate('window.calls')).filter((c) => c[0] === 'setSubagentReuseEnabled' || c[0] === 'setSubagentCommsEnabled'),
    [['setSubagentReuseEnabled', true], ['setSubagentCommsEnabled', true]],
    'both switches reach their own setters'
  )
  await evaluate(`window.typeConcurrent('99')`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]').value`), '16', 'the limit still clamps on blur')

  const typeTurns = async value => {
    await evaluate(`window.type(${JSON.stringify(MAX_TURNS_LABEL)}, ${JSON.stringify(value)})`)
    await frame()
    await evaluate(`(()=>{const el=document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]'); el.focus(); el.blur()})()`)
    await frame()
  }
  await typeTurns('12')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').value`), '12', 'the user can save a limit while the override permission is off')
  assert.equal(await evaluate(`window.calls.filter(c=>c[0]==='setSubagentMaxTurns').at(-1)[1]`), 12)
  await typeTurns('999')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').value`), '200', 'the limit clamps at 200')
  await typeTurns('0')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').value`), '1', 'zero clamps to one; only blank means unlimited')
  await typeTurns('')
  assert.equal(await evaluate(`window.calls.filter(c=>c[0]==='setSubagentMaxTurns').at(-1)[1]`), null, 'clearing saves unlimited')
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').click()`)
  await frame()
  assert.deepEqual(await evaluate(`window.calls.filter(c=>c[0]==='setSubagentTurnLimitOverrideEnabled').at(-1)`), ['setSubagentTurnLimitOverrideEnabled', true])
  await evaluate(`window.failTurnOverride=true; document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').getAttribute('aria-checked')`), 'true', 'a failed permission save retains the saved state')
  assert.match(await evaluate(`document.querySelector('[data-subagent-turn-limit-override-row] [role=alert]').textContent`), /Could not save/)
  await evaluate(`window.failTurnOverride=false; document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${TURN_OVERRIDE_LABEL}"]').getAttribute('aria-checked')`), 'false', 'the grant can be revoked')
  await evaluate(`window.failMaxTurns=true`)
  await typeTurns('5')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${MAX_TURNS_LABEL}"]').value`), '', 'a failed limit save restores the saved unlimited value')
  assert.match(await evaluate(`document.querySelector('[data-subagent-max-turns-row] [role=alert]').textContent`), /Could not save/)
  await evaluate(`window.failMaxTurns=false`)
  await typeTurns('8')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-max-turns-row] [role=alert]')`), false, 'successful retry clears the error')
  await screenshot('subagents-en')

  // 3. The profile list and the first detail (a tools: all profile).
  const listed = await evaluate(`[...document.querySelectorAll('[data-subagent-profile]')].map((r) => r.dataset.subagentProfile)`)
  assert.deepEqual(listed, ['general-purpose', 'explore', 'piweb-agent', 'preset-agent'], 'every profile is one row, in list order')
  assert.ok(!await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('/agents/general-purpose.md')`), 'the file path no longer renders as text')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('Global')`), 'the scope badge reads')
  assert.equal(await evaluate(`window.radioOf('All tools')?.getAttribute('data-state')`), 'checked', 'an all-tools profile selects the all radio')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagents-section] dl')`), false, 'no field list renders in the detail')
  assert.equal(await evaluate(`window.radioOf('Choose tools')?.getAttribute('data-state')`), 'unchecked', 'not the explicit radio')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), true, 'a pristine editor offers no Save')

  // The debugger is an ordinary tool grant now: no dedicated switch, and the
  // tools list (all, or an explicit debug entry) is the only place it lives.
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-debug]')`), false, 'no dedicated debug switch remains')
  assert.equal(await evaluate(`window.callsOf('setSubagentProfileDebug')`), 0, 'the page never writes a separate debug grant')

  // Model, thinking and the other frontmatter fields are not presented at
  // all — the file is their only editor, and the path rides the open-file
  // button's tooltip instead of a field row.
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-defaults]')`), false, 'no defaults editing area renders')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-edit-defaults]')`), false, 'no edit entry remains')
  const detailText = await evaluate(`document.querySelector('[data-subagents-section]').textContent`)
  for (const label of ['File', 'Model', 'Thinking', 'Inherit parent context', 'Run in background']) {
    assert.ok(!detailText.includes(label), `the ${label} label is gone`)
  }
  assert.equal(await evaluate(`window.callsOf('setSubagentProfileDefaults')`), 0, 'the page never writes the defaults')
  // The open-file button names its full target on hover.
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-subagents-section] button')].find(e=>e.textContent.trim()==='Open file'); b.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse'}))})()`)
  await pause(300)
  assert.ok(await evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(e=>e.textContent.includes('/agents/general-purpose.md'))`), 'the open-file button shows the full path on hover')
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-subagents-section] button')].find(e=>e.textContent.trim()==='Open file'); b.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse'}))})()`)
  await frame()
  await screenshot('subagent-defaults-en')

  // Switching to explicit starts from everything; Reset returns to the saved state.
  await evaluate(`window.radioOf('Choose tools').click()`)
  await frame()
  assert.equal(await evaluate(`window.checkedTools().length`), 25, 'explicit mode starts from the full universe, with each MCP and scripting tool separate')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-reset]').disabled`), false, 'an edit in progress can be reset')
  await evaluate(`document.querySelector('[data-subagent-tools-reset]').click()`)
  await frame()
  assert.equal(await evaluate(`window.radioOf('All tools')?.getAttribute('data-state')`), 'checked', 'reset restores the saved mode')

  // 4. The explore profile: MCP tool grants stay separate, unknown preserved.
  await evaluate(`window.profileRow('explore').click()`)
  await frame()
  assert.ok(!await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('/proj/.pi/agents/explore.md')`), 'the project path no longer renders as text either')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('Project')`), 'the project scope badge reads')
  // The path rides the open-file button's tooltip instead.
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-subagents-section] button')].find(e=>e.textContent.trim()==='Open file'); b.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse'}))})()`)
  await pause(300)
  assert.ok(await evaluate(`[...document.querySelectorAll('[role=tooltip]')].some(e=>e.textContent.includes('/proj/.pi/agents/explore.md'))`), 'the open-file tooltip carries the project path')
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-subagents-section] button')].find(e=>e.textContent.trim()==='Open file'); b.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse'}))})()`)
  await frame()
  const exploreText = await evaluate(`document.querySelector('[data-subagents-section]').textContent`)
  assert.ok(!exploreText.includes('deepseek/chat'), 'the model is not presented')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagents-section] dl')`), false, 'no field list renders for a project profile either')
  const mcpRow = await evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-subagent-tool]')].map((r)=>r.dataset.subagentTool);return {mcp:rows.filter((n)=>n==='mcp'||n==='mcpScript'||n.startsWith('mcp__')||n==='list_mcp_resources'),codemode:rows.includes('codemode'),search:rows.includes('tool_search'),ctx:rows.includes('ctx_one'),fff:rows.includes('ffgrep'),legacy:rows.includes('legacy-tool'),todo:rows.includes('todo_write')}})()`)
  assert.deepEqual(mcpRow.mcp, ['mcp', 'mcpScript', 'list_mcp_resources', 'mcp__beui', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id'], 'native and historical MCP names have independent rows')
  assert.equal(mcpRow.codemode, true, 'codemode has its own row')
  assert.equal(mcpRow.search, true, 'tool search has its own row')
  assert.equal(mcpRow.ctx, true, 'extension tools list under their group')
  assert.equal(mcpRow.fff, true, 'a second extension lists too')
  assert.equal(mcpRow.legacy, true, 'a profile-carried unknown name is shown, never dropped')
  assert.equal(mcpRow.todo, true, 'app tools list with the built-ins')
  assert.equal(await evaluate(`window.boxState('mcp__beui__get_component')`), 'false', 'MCP starts unchecked for this profile')
  assert.equal(await evaluate(`window.boxState('codemode')`), 'false', 'codemode starts unchecked independently')
  assert.equal(await evaluate(`window.boxState('legacy-tool')`), 'true', 'the unknown name stays checked')

  const groups = await evaluate(`[...document.querySelectorAll('[data-subagent-tool-group]')].map((g) => g.dataset.subagentToolGroup)`)
  assert.deepEqual(groups, ['mcp', 'builtin', 'extension', 'unknown'], 'the picker groups render mcp-first with an unknown group')

  // Enable exactly one native MCP tool and save: no gateway, codemode or
  // sibling server is granted through the section's visual grouping.
  await evaluate(`window.toolBox('mcp__beui__get_component').click()`)
  await frame()
  assert.equal(await evaluate(`window.boxState('mcp')`), 'false', 'the old gateway is not implicitly granted')
  assert.equal(await evaluate(`window.boxState('mcp__context7__resolve_library_id')`), 'false', 'another server stays unselected')
  assert.equal(await evaluate(`window.boxState('list_mcp_resources')`), 'false', 'resource access stays unselected')
  assert.equal(await evaluate(`window.boxState('codemode')`), 'false', 'codemode stays unselected')
  assert.equal(await evaluate(`window.boxState('tool_search')`), 'false', 'tool search stays unselected')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), false, 'a real change enables Save')
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  const saved = await evaluate(`window.calls.filter((c) => c[0] === 'setSubagentProfileTools').map((c) => c[1])`)
  assert.deepEqual(
    saved.at(-1),
    {
      filePath: '/proj/.pi/agents/explore.md',
      tools: ['read', 'grep', 'find', 'ls', 'mcp__beui__get_component', 'legacy-tool']
    },
    'one MCP tool reaches the saved role without broadening to its siblings'
  )
  await screenshot('subagents-explore')

  // The MCP section is one family row, exactly like an extension family:
  // collapsed by default, one tri-state checkbox selecting every server, and
  // the per-tool grants still independent underneath.
  assert.equal(await evaluate(`window.familyToggle('mcp').getAttribute('aria-expanded')`), 'false', 'the MCP family starts collapsed')
  assert.equal(await evaluate(`window.familyState('mcp')`), 'false', 'with no MCP grant the family box reads unchecked')
  assert.equal(await evaluate(`window.familyCount('mcp')`), '0/6', 'the family counts its selected members')
  await evaluate(`window.familyBox('mcp').click()`)
  await frame()
  for (const name of ['mcp', 'mcpScript', 'list_mcp_resources', 'mcp__beui', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id']) {
    assert.equal(await evaluate(`window.boxState(${JSON.stringify(name)})`), 'true', `the family box selects ${name}`)
  }
  assert.equal(await evaluate(`window.familyState('mcp')`), 'true', 'a full family reads checked')
  assert.equal(await evaluate(`window.familyCount('mcp')`), '6/6', 'the count follows')
  await evaluate(`window.familyToggle('mcp').click()`)
  await frame()
  assert.equal(await evaluate(`window.familyToggle('mcp').getAttribute('aria-expanded')`), 'true', 'the disclosure opens the individual grants')
  await evaluate(`window.toolBox('mcp').click()`)
  await frame()
  assert.equal(await evaluate(`window.familyState('mcp')`), 'mixed', 'a partial family reads mixed')
  assert.equal(await evaluate(`window.familyCount('mcp')`), '5/6', 'with an honest count')
  await evaluate(`window.familyBox('mcp').click()`)
  await frame()
  assert.equal(await evaluate(`window.familyCount('mcp')`), '6/6', 'clicking a mixed box completes the selection')
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  assert.deepEqual(
    (await evaluate(`window.calls.filter((c) => c[0] === 'setSubagentProfileTools').map((c) => c[1])`)).at(-1),
    { filePath: '/proj/.pi/agents/explore.md', tools: ['read', 'grep', 'find', 'ls', 'mcp', 'mcpScript', 'list_mcp_resources', 'mcp__beui', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id', 'legacy-tool'] },
    'the whole MCP family reaches the saved CSV in canonical order'
  )
  assert.equal(await evaluate(`window.checkedTools().join(',')`), 'read,grep,find,ls,legacy-tool', 'the save clears the draft back to the saved set')

  // The debugger grant is an ordinary tool row: checking it (or All tools)
  // is the whole switch, with the parent session still the real ceiling.
  assert.equal(await evaluate(`window.boxState('debug')`), 'false', 'debug starts as an ordinary unchecked row')
  await evaluate(`window.toolBox('debug').click()`)
  await frame()
  assert.equal(await evaluate(`window.boxState('debug')`), 'true', 'debug checks like any other tool')
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  assert.deepEqual(
    (await evaluate(`window.calls.filter((c) => c[0] === 'setSubagentProfileTools').map((c) => c[1])`)).at(-1),
    { filePath: '/proj/.pi/agents/explore.md', tools: ['debug', 'read', 'grep', 'find', 'ls', 'legacy-tool'] },
    'the debug grant rides the tools: line in canonical order'
  )

  // Unchecking everything blocks the save.
  for (const name of await evaluate(`window.checkedTools()`)) {
    await evaluate(`window.toolBox(${JSON.stringify(name)}).click()`)
    await frame()
  }
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), true, 'an empty selection cannot be saved')
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-editor]').textContent.includes('Enable at least one tool.')`), 'the empty hint reads')
  await evaluate(`document.querySelector('[data-subagent-tools-reset]').click()`)
  await frame()
  assert.equal(await evaluate(`window.checkedTools().join(',')`), 'read,grep,find,ls,legacy-tool', 'reset restores the saved set')

  // 4b. Same-series tools collapse into ONE family row inside their section:
  //     a tri-state checkbox for the whole series beside its disclosure, with
  //     every member still individually checkable underneath.
  const families = await evaluate(`(()=>{const inSection=(section)=>[...document.querySelectorAll('[data-subagent-tool-group="'+section+'"] [data-subagent-tool-family]')].map((f)=>f.dataset.subagentToolFamily);return {builtin:inSection('builtin'),extension:inSection('extension'),unknown:inSection('unknown'),mcp:inSection('mcp')}})()`)
  assert.deepEqual(families.extension, ['ctx', 'pi-lens'], 'the extension section groups a declared family by its key and one extension as one family')
  assert.deepEqual(families.builtin, ['browser'], 'a namespaced app tool family groups under the built-ins')
  assert.deepEqual(families.unknown, [], 'the unknown group has no family of its own')
  assert.deepEqual(families.mcp, ['mcp'], 'the MCP section is one collapsible family row')
  assert.deepEqual(await evaluate(`window.familyMembers('pi-lens')`), ['lens_diagnostics', 'read_symbol'], 'an extension whose tool names share no prefix is ONE family row')
  assert.deepEqual(
    await evaluate(`[...document.querySelector('[data-subagent-tool-family="pi-lens"] [data-subagent-tool-family-toggle]').querySelectorAll('span')].map((s) => s.textContent)`),
    ['pi-lens', '0/2'],
    'a family named after its extension does not repeat that name as a source chip'
  )
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-tool="ffgrep"]').closest('[data-subagent-tool-family]')`), false, 'a lone prefix member stays a plain row')
  assert.deepEqual(await evaluate(`window.familyMembers('mcp')`), ['mcp', 'mcpScript', 'list_mcp_resources', 'mcp__beui', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id'], 'the MCP family holds every grant in section order')
  assert.deepEqual(await evaluate(`window.familyMembers('ctx')`), ['ctx_one', 'ctx_two'], 'the family holds its members')
  assert.deepEqual(await evaluate(`window.familyMembers('browser')`), ['browser_click', 'browser_navigate', 'browser_type'], 'in the section sort order, not reshuffled')
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('[data-subagent-tool-family="ctx"] [data-subagent-tool-family-label]')).fontFamily`),
    await evaluate(`getComputedStyle(document.querySelector('[data-subagent-tool="ctx_one"] label > span')).fontFamily`),
    'the family name wears the UI font, exactly like the tool rows it collapses'
  )

  // Collapsed by default: the rows are mounted (so a save never loses them)
  // but the panel has no height until the disclosure is opened.
  assert.equal(await evaluate(`window.familyToggle('ctx').getAttribute('aria-expanded')`), 'false', 'a family starts collapsed')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tool-family-members="ctx"]').style.height`), '0px', 'the collapsed panel takes no height')
  assert.equal(await evaluate(`window.familyState('ctx')`), 'false', 'a family with nothing selected reads unchecked')
  assert.equal(await evaluate(`window.familyCount('ctx')`), '0/2', 'the row counts what is selected out of what it holds')

  await evaluate(`window.familyToggle('ctx').click()`)
  await frame()
  assert.equal(await evaluate(`window.familyToggle('ctx').getAttribute('aria-expanded')`), 'true', 'the disclosure opens the members')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tool-family-members="ctx"]').style.height`), 'auto', 'an open family shows its members')
  // The reveal is instant: one frame after the press the panel already sits at
  // its rest clip, so nothing is tweening the rows below it around. (Chrome
  // normalizes `inset(0 0 0% 0)` to three tokens, so this reads the bottom
  // inset rather than string-matching the whole value.)
  const restClip = await evaluate(`(()=>{const c=getComputedStyle(document.querySelector('[data-subagent-tool-family-members="ctx"]')).clipPath;const m=/inset\(([^)]+)\)/.exec(c);return m?m[1].trim().split(/\\s+/):null})()`)
  assert.ok(restClip, 'the open panel carries a clip-path')
  assert.equal(restClip[2], '0%', 'the family reveal does not animate')
  // And the row itself is a quiet toggle: pressing it must not pulse it.
  const pressedTransform = await evaluate(`(()=>{const b=window.familyToggle('ctx');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,isPrimary:true,button:0}));const t=b.style.transform;b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,isPrimary:true,button:0}));return t})()`)
  assert.equal(/scale\(/.test(pressedTransform), false, 'the family toggle has no press spring')

  // The family checkbox is one gesture for the whole series.
  await evaluate(`window.familyBox('ctx').click()`)
  await frame()
  assert.equal(await evaluate(`window.boxState('ctx_one')`), 'true', 'the family checkbox selects a member')
  assert.equal(await evaluate(`window.boxState('ctx_two')`), 'true', 'and every other member with it')
  assert.equal(await evaluate(`window.familyState('ctx')`), 'true', 'the family row follows')
  assert.equal(await evaluate(`window.familyCount('ctx')`), '2/2', 'and its count follows')
  assert.equal(await evaluate(`window.checkedTools().includes('ffgrep')`), false, 'a sibling family row is untouched')

  // Selecting members one by one is the same path, one click deeper: a partial
  // family must read MIXED, not "off" and not "on".
  await evaluate(`window.toolBox('ctx_one').click()`)
  await frame()
  assert.equal(await evaluate(`window.boxState('ctx_two')`), 'true', 'unchecking one member leaves its sibling alone')
  assert.equal(await evaluate(`window.familyState('ctx')`), 'mixed', 'a partial family reads as a mixed box')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tool-family="ctx"]').dataset.familyState`), 'some', 'and reports its partial state for checks')
  assert.equal(await evaluate(`window.familyCount('ctx')`), '1/2', 'with an honest count')
  await evaluate(`window.toolBox('ctx_one').click()`)
  await frame()
  assert.equal(await evaluate(`window.familyState('ctx')`), 'true', 're-selecting it restores the full box')

  // A family clears in one gesture too, and a browser family rides the same
  // path into the saved CSV.
  await evaluate(`window.familyBox('ctx').click()`)
  await frame()
  assert.equal(await evaluate(`window.checkedTools().join(',')`), 'read,grep,find,ls,legacy-tool', 'the family checkbox clears the whole series')
  assert.equal(await evaluate(`window.familyState('ctx')`), 'false', 'and the row is unchecked again')
  await evaluate(`window.familyBox('browser').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), false, 'a family selection enables Save')
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  assert.deepEqual(
    (await evaluate(`window.calls.filter((c) => c[0] === 'setSubagentProfileTools').map((c) => c[1])`)).at(-1),
    { filePath: '/proj/.pi/agents/explore.md', tools: ['browser_click', 'browser_navigate', 'browser_type', 'read', 'grep', 'find', 'ls', 'legacy-tool'] },
    'every member of a checked family reaches the payload, in canonical order'
  )
  await evaluate(`document.querySelector('[data-subagent-tools-reset]').click()`)
  await frame()
  assert.equal(await evaluate(`window.checkedTools().join(',')`), 'read,grep,find,ls,legacy-tool', 'reset drops the family selection with the rest of the draft')

  // 5. A failing save keeps the draft and reports.
  await evaluate(`window.toolBox('mcp__beui__get_component').click()`)
  await frame()
  await evaluate(`window.failProfileTools = true`)
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-editor]').textContent.includes('Could not save the tool set.')`), 'a failed save reports inline')
  assert.equal(await evaluate(`window.boxState('mcp__beui__get_component')`), 'true', 'the draft survives the failure')
  await evaluate(`window.failProfileTools = false`)
  await evaluate(`document.querySelector('[data-subagent-tools-reset]').click()`)
  await frame()

  // 6. Preset annotations read on screen.
  await evaluate(`window.profileRow('piweb-agent').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-source]')?.dataset.subagentToolsSource`), 'unresolved', 'an unresolved preset is annotated')
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-source]').textContent.includes('nope')`), 'the annotation names the preset')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-subagent-tools-source]')).color`), await evaluate(`getComputedStyle(document.querySelector('.text-destructive')).color`), 'an unresolved preset reads as an error tone')
  assert.equal(await evaluate(`window.radioOf('Choose tools')?.getAttribute('data-state')`), 'checked', 'the fallback set is still editable as an explicit list')
  await evaluate(`window.profileRow('preset-agent').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-source]')?.dataset.subagentToolsSource`), 'preset', 'a resolved preset is annotated')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-enabled]').dataset.subagentEnabled`), 'false', 'a disabled profile states it')

  // 7. Creating a profile: inline validation, target-path preview, scope
  //    shadowing, and the new file landing as the selected detail.
  await evaluate(`window.profileRow('explore').click()`)
  await frame()
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-create-form]')`), false, 'the creation form is closed by default')
  await evaluate(`document.querySelector('[data-subagent-new]').click()`)
  await frame()
  assert.ok(await evaluate(`!!document.querySelector('[data-subagent-create-form]')`), 'the New button opens the form')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-tools-editor]')`), false, 'the form replaces the detail panel')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-new]').disabled`), true, 'the New button is disabled while the form is open')

  // The create panel follows the app's create/edit form standard: a 16px panel
  // title, flush 14px field titles in one colour, a 10px title-to-control gap,
  // 14px controls, and 20px between editing items (lib/form-standard.ts).
  const formFacts = await evaluate(`(()=>{const root=document.querySelector('[data-subagent-create-form]'),titles=[...root.querySelectorAll('label.text-sm.font-medium,p.text-sm.font-medium,span.text-sm.font-medium')],box=e=>({l:e.getBoundingClientRect().left,p:parseFloat(getComputedStyle(e).paddingLeft)}),inset=e=>{const a=box(e),b=box(e.parentElement);return Math.round(a.l+a.p-b.l-b.p)},gap=e=>Math.round(e.nextElementSibling.getBoundingClientRect().top-e.getBoundingClientRect().bottom),heading=root.querySelector('p.text-base'),items=[...root.children];return{title:heading?{size:getComputedStyle(heading).fontSize,weight:Number(getComputedStyle(heading).fontWeight)}:null,titles:titles.map(e=>e.textContent.trim()),insets:[...new Set(titles.map(inset))],colors:[...new Set(titles.map(e=>getComputedStyle(e).color))],sizes:[...new Set(titles.map(e=>getComputedStyle(e).fontSize))],gaps:[...new Set(titles.map(gap))],controls:[...new Set([...root.querySelectorAll('input,textarea')].map(e=>getComputedStyle(e).fontSize))],columns:getComputedStyle(root).gridTemplateColumns.split(' ').length,itemGaps:[...new Set(items.slice(1).map((el,i)=>Math.round(el.getBoundingClientRect().top-items[i].getBoundingClientRect().bottom)).filter(gap=>gap>0))]}})()`)
  assert.ok(formFacts.title?.size === '16px' && formFacts.title.weight >= 600, `the create form has a 16px semibold panel title: ${JSON.stringify(formFacts.title)}`)
  assert.ok(formFacts.titles.length >= 4 && formFacts.insets.length === 1 && formFacts.insets[0] === 0, `create form titles are flush with their controls: ${JSON.stringify(formFacts)}`)
  assert.deepEqual(formFacts.sizes, ['14px'], `create form titles share the form type scale: ${JSON.stringify(formFacts.sizes)}`)
  assert.equal(formFacts.colors.length, 1, `create form titles share one colour: ${JSON.stringify(formFacts.colors)}`)
  assert.ok(formFacts.gaps.length === 1 && formFacts.gaps[0] === 10, `every create form title sits 10px above its control: ${JSON.stringify(formFacts.gaps)}`)
  assert.ok(formFacts.itemGaps.every(gap => gap >= 16) && formFacts.itemGaps.includes(20), `create form items keep the 20px rhythm: ${JSON.stringify(formFacts.itemGaps)}`)
  assert.equal(formFacts.columns, 2, `the create form lays out in two columns: ${formFacts.columns}`)

  // An invalid name is explained live and never reaches the IPC.
  assert.equal(await evaluate(`window.type('Name', 'My Agent!')`), 'My Agent!', 'the name field accepts typing')
  await frame()
  assert.match(String(await evaluate(`document.querySelector('[data-subagent-name-error]')?.textContent`)), /lowercase/, 'an invalid name is explained inline')
  await evaluate(`document.querySelector('[data-subagent-create]').click()`)
  await frame()
  assert.equal(await evaluate(`window.callsOf('createSubagentProfile')`), 0, 'an invalid name never reaches the IPC')

  // A valid name with an empty description reveals the requirement on attempt.
  await evaluate(`window.type('Name', 'docs-writer')`)
  await frame()
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-name-error]')`), false, 'a valid name clears the error')
  assert.ok(await evaluate(`document.querySelector('[data-subagent-create-form]').textContent.includes('/agents/docs-writer.md')`), 'the target path previews the global file')
  await evaluate(`document.querySelector('[data-subagent-create]').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-create-form]').textContent.includes('A description is required')`), 'the empty description is explained after the attempt')
  assert.equal(await evaluate(`window.callsOf('createSubagentProfile')`), 0, 'an empty description never reaches the IPC either')

  // A taken name in the SAME scope is refused; the other scope is free.
  await evaluate(`window.type('Name', 'preset-agent')`)
  await frame()
  assert.ok(await evaluate(`!!document.querySelector('[data-subagent-name-error]')`), 'a taken name in the same scope is refused')
  await evaluate(`window.createRadio('Project').click()`)
  await frame()
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-name-error]')`), false, 'the same name is free in the other scope (shadowing is a feature)')
  assert.ok(await evaluate(`document.querySelector('[data-subagent-create-form]').textContent.includes('/proj/.pi/agents/preset-agent.md')`), 'the preview follows the scope')
  await evaluate(`window.type('Description', 'Writes and polishes docs.')`)
  await evaluate(`window.type('System prompt', 'You write documentation.')`)
  await frame()
  await evaluate(`document.querySelector('[data-subagent-create]').click()`)
  await frame()
  const created = await evaluate(`window.calls.filter((c) => c[0] === 'createSubagentProfile').map((c) => c[1])`)
  assert.deepEqual(
    created.at(-1),
    { name: 'preset-agent', description: 'Writes and polishes docs.', systemPrompt: 'You write documentation.', scope: 'project' },
    'Create sends exactly the form as its payload'
  )
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-create-form]')`), false, 'success closes the form')
  assert.equal(await evaluate(`document.querySelectorAll('[data-subagent-profile]').length`), 4, 'the project file shadows the same-name global row, exactly as the loader does')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('Writes and polishes docs.')`), 'the new profile becomes the selected detail')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-source]')?.dataset.subagentToolsSource`), 'default', 'a new profile starts least-privileged (no tools: line)')
  await screenshot('subagents-created')

  // A failing create keeps the form open and reports; Cancel discards.
  await evaluate(`document.querySelector('[data-subagent-new]').click()`)
  await frame()
  await evaluate(`window.type('Name', 'another')`)
  await evaluate(`window.type('Description', 'x')`)
  await evaluate(`window.failCreate = true`)
  await evaluate(`document.querySelector('[data-subagent-create]').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-create-form]').textContent.includes('Could not create the profile.')`), 'a failed create reports inline')
  assert.ok(await evaluate(`!!document.querySelector('[data-subagent-create-form]')`), 'the form stays open on failure')
  const callsBeforeCancel = await evaluate(`window.callsOf('createSubagentProfile')`)
  await evaluate(`document.querySelector('[data-subagent-cancel]').click()`)
  await frame()
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-create-form]')`), false, 'Cancel closes the form')
  assert.equal(await evaluate(`window.callsOf('createSubagentProfile')`), callsBeforeCancel, 'Cancel sends nothing')
  await evaluate(`window.failCreate = false`)

  // 8. Chinese locale.
  await evaluate(`localStorage.setItem('pi-app:locale','zh-CN')`)
  await send('Page.navigate', { url: origin })
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`!!window.fixtureReady && !!document.querySelector('[role=tablist]')`)) break
    await pause(50)
  }
  await pause(400)
  await evaluate(`window.openTab('子代理')`)
  await frame()
  assert.ok(await evaluate(`!!document.querySelector('[data-subagents-section]')`), 'the section opens under its Chinese label')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('复用已完成的子代理')`), 'the reuse switch label is localized')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('主-子代理通信')`), 'the communications switch label is localized')
  assert.ok(await evaluate(`document.querySelector('[data-subagent-turn-limit-override-row]').textContent.includes('允许父代理设置轮数上限')`), 'the turn-limit grant is localized')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="默认轮数上限"]').placeholder`), '不限制', 'unlimited is localized')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagents-section] dl')`), false, 'no field list renders in Chinese either')
  const zhText = await evaluate(`document.querySelector('[data-subagents-section]').textContent`)
  // (No label sweep here: the delegation prose legitimately contains 模型.)
  assert.ok(!zhText.includes('继承父会话上下文') && !zhText.includes('思考等级'), 'the defaults labels stay hidden in Chinese')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-debug]')`), false, 'no dedicated debug switch in Chinese either')
  await screenshot('subagent-defaults-zh')
  await evaluate(`window.profileRow('explore').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('内置工具')`), 'the built-in group title is localized')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('扩展工具')`), 'the extension group title is localized')
  assert.equal(await evaluate(`window.boxState('mcp__beui__get_component')`), 'false', 'MCP grants stay individual in Chinese')
  await evaluate(`window.profileRow('piweb-agent').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-source]').textContent.includes('nope')`), 'the Chinese annotation still names the preset')
  await evaluate(`document.documentElement.classList.add('dark')`)
  await frame()
  await screenshot('subagents-dark-zh')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: subagent settings — defaults stay hidden, debug is an ordinary tool grant, the MCP family collapses beside its individual grants, unknowns preserved in both locales')
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
