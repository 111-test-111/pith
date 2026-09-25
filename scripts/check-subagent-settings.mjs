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
 * - Tool editor: SDK built-ins + extension tools from the shared catalog, the
 *   MCP family collapsed into ONE row, every namespaced family in a section
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
    { name: 'browser_navigate', description: 'Open a page.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'browser_click', description: 'Click an element.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'browser_type', description: 'Type into a field.', parameters: { type: 'object' }, source: { kind: 'builtin', label: 'Built-in' }, active: true, disabledByExtension: false },
    { name: 'ctx_one', description: 'Extension tool one.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false },
    { name: 'ctx_two', description: 'Extension tool two.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/ctx', label: 'context-mode' }, active: true, disabledByExtension: false },
    { name: 'ffgrep', description: 'pi-fff grep.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/fff', label: 'pi-fff' }, active: true, disabledByExtension: false },
    { name: 'mcp', description: 'MCP gateway.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false },
    { name: 'mcpScript', description: 'MCP scripting.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false },
    { name: 'mcp__beui', description: 'One server proxy.', parameters: { type: 'object' }, source: { kind: 'extension', extensionId: '/ext/mcp', label: 'mcp-adapter' }, active: true, disabledByExtension: false }
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
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const screenshot = async (name) => {
    if (!process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_SUBAGENT_SETTINGS_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
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
  assert.deepEqual(
    order,
    ['General', 'Notifications', 'Prompt', 'Appearance', 'Shortcuts', 'Providers', 'Tools', 'Subagents', 'Extensions', 'MCP', 'Skills', 'Browser', 'Usage', 'JevBeta'],
    'the Subagents entry follows Tools in the registry order'
  )
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
  await evaluate(`document.querySelector('button[role=checkbox][aria-label="${ENABLE_LABEL}"]').click()`)
  await frame()
  assert.deepEqual((await evaluate('window.calls')).find((c) => c[0] === 'setSubagentsEnabled')?.[1], false, 'turning it off reaches the setter')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="${CONCURRENCY_LABEL}"]').disabled`), true, 'the limit disables while subagents are off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${REUSE_LABEL}"]').disabled`), true, 'reuse disables while subagents are off')
  assert.equal(await evaluate(`document.querySelector('button[role=checkbox][aria-label="${COMMS_LABEL}"]').disabled`), true, 'communications disables while subagents are off')
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
  await screenshot('subagents-en')

  // 3. The profile list and the first detail (a tools: all profile).
  const listed = await evaluate(`[...document.querySelectorAll('[data-subagent-profile]')].map((r) => r.dataset.subagentProfile)`)
  assert.deepEqual(listed, ['general-purpose', 'explore', 'piweb-agent', 'preset-agent'], 'every profile is one row, in list order')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('/agents/general-purpose.md')`), 'the detail shows the file path')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('Global')`), 'the scope badge reads')
  assert.equal(await evaluate(`window.radioOf('All tools')?.getAttribute('data-state')`), 'checked', 'an all-tools profile selects the all radio')
  assert.equal(await evaluate(`window.radioOf('Choose tools')?.getAttribute('data-state')`), 'unchecked', 'not the explicit radio')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), true, 'a pristine editor offers no Save')

  // Switching to explicit starts from everything; Reset returns to the saved state.
  await evaluate(`window.radioOf('Choose tools').click()`)
  await frame()
  assert.equal(await evaluate(`window.checkedTools().length`), 15, 'explicit mode starts from the full universe (11 built-ins + 3 extensions + MCP as one)')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-reset]').disabled`), false, 'an edit in progress can be reset')
  await evaluate(`document.querySelector('[data-subagent-tools-reset]').click()`)
  await frame()
  assert.equal(await evaluate(`window.radioOf('All tools')?.getAttribute('data-state')`), 'checked', 'reset restores the saved mode')

  // 4. The explore profile: MCP as one whole, unknown preserved, canonical save.
  await evaluate(`window.profileRow('explore').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('/proj/.pi/agents/explore.md')`), 'the project file path reads')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('Project')`), 'the project scope badge reads')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('deepseek/chat')`), 'the model field reads')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('12')`), 'the turn limit reads')
  const mcpRow = await evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-subagent-tool]')].map((r)=>r.dataset.subagentTool);return {mcp:rows.filter((n)=>n==='MCP'||n.startsWith('mcp')).join(','),ctx:rows.includes('ctx_one'),fff:rows.includes('ffgrep'),legacy:rows.includes('legacy-tool'),todo:rows.includes('todo_write')}})()`)
  assert.equal(mcpRow.mcp, 'MCP', 'the three MCP tools answer one row')
  assert.equal(mcpRow.ctx, true, 'extension tools list under their group')
  assert.equal(mcpRow.fff, true, 'a second extension lists too')
  assert.equal(mcpRow.legacy, true, 'a profile-carried unknown name is shown, never dropped')
  assert.equal(mcpRow.todo, true, 'app tools list with the built-ins')
  assert.equal(await evaluate(`window.boxState('MCP')`), 'false', 'MCP starts unchecked for this profile')
  assert.equal(await evaluate(`window.boxState('legacy-tool')`), 'true', 'the unknown name stays checked')

  const groups = await evaluate(`[...document.querySelectorAll('[data-subagent-tool-group]')].map((g) => g.dataset.subagentToolGroup)`)
  assert.deepEqual(groups, ['mcp', 'builtin', 'extension', 'unknown'], 'the picker groups render mcp-first with an unknown group')

  // Enable MCP and save: canonical order, unknown preserved.
  await evaluate(`window.toolBox('MCP').click()`)
  await frame()
  assert.equal(await evaluate(`document.querySelector('[data-subagent-tools-save]').disabled`), false, 'a real change enables Save')
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  const saved = await evaluate(`window.calls.filter((c) => c[0] === 'setSubagentProfileTools').map((c) => c[1])`)
  assert.deepEqual(
    saved.at(-1),
    {
      filePath: '/proj/.pi/agents/explore.md',
      tools: ['read', 'grep', 'find', 'ls', 'mcp', 'mcpScript', 'mcp__beui', 'legacy-tool']
    },
    'the whole MCP family rides one check, in canonical order, keeping the unknown name'
  )
  await screenshot('subagents-explore')

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
  assert.deepEqual(families.extension, ['ctx'], 'the extension section groups ctx_* into one family row')
  assert.deepEqual(families.builtin, ['browser'], 'a namespaced app tool family groups under the built-ins')
  assert.deepEqual(families.unknown, [], 'the unknown group has no family of its own')
  assert.deepEqual(families.mcp, [], 'the MCP whole is deliberately not a family (the gateway reaches every server)')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-tool="ffgrep"]').closest('[data-subagent-tool-family]')`), false, 'a lone prefix member stays a plain row')
  assert.equal(await evaluate(`!!document.querySelector('[data-subagent-tool="MCP"]').closest('[data-subagent-tool-family]')`), false, 'the MCP row is not nested in a family')
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
  await evaluate(`window.toolBox('MCP').click()`)
  await frame()
  await evaluate(`window.failProfileTools = true`)
  await evaluate(`document.querySelector('[data-subagent-tools-save]').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-editor]').textContent.includes('Could not save the tool set.')`), 'a failed save reports inline')
  assert.equal(await evaluate(`window.boxState('MCP')`), 'true', 'the draft survives the failure')
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
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('/proj/.pi/agents/preset-agent.md')`), 'the new profile becomes the selected detail')
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
  await evaluate(`window.profileRow('explore').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('内置工具')`), 'the built-in group title is localized')
  assert.ok(await evaluate(`document.querySelector('[data-subagents-section]').textContent.includes('扩展工具')`), 'the extension group title is localized')
  assert.equal(await evaluate(`window.boxState('MCP')`), 'false', 'MCP stays one row in Chinese')
  await evaluate(`window.profileRow('piweb-agent').click()`)
  await frame()
  assert.ok(await evaluate(`document.querySelector('[data-subagent-tools-source]').textContent.includes('nope')`), 'the Chinese annotation still names the preset')
  await evaluate(`document.documentElement.classList.add('dark')`)
  await frame()
  await screenshot('subagents-dark-zh')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: subagent settings — section owns the switch + limit, profiles list/edit with MCP-as-one, per-section tool families (select-all / clear / mixed), unknown preservation, both locales')
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
