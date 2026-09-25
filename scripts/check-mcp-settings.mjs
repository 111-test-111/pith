/**
 * Settings → MCP regression check: the section owns the pi-mcp-adapter's
 * config files and the merged server roster.
 *
 * - Registry: the nav gains an MCP entry between Extensions and Skills.
 * - Roster: merged servers render with status dot, transport/scope badges and
 *   tool counts; external servers have no edit/delete buttons.
 * - Toggle: the row checkbox calls `mcpSetServerDisabled` and re-renders.
 * - Live status: a pushed `pi:mcp-status` snapshot re-marks the row.
 * - Visual editor: edit populates from the entry and saves through
 *   `mcpUpsertServer` (targetPath + originalName); adding goes through scope;
 *   validation blocks an empty name without any IPC write.
 * - Tools viewer: `mcpServerDetail` feeds the tools/resources/prompts lists.
 * - JSON editors: valid edits save after a debounce via `mcpWriteConfig`;
 *   invalid JSON shows the parse error and never saves.
 * - Both locales; no renderer exceptions.
 *
 * Real `SettingsPage` in isolated Electron against a mocked `window.pi`; no
 * SDK, no network. Run after building is NOT required (vite serves the
 * source): `node scripts/check-mcp-settings.mjs`.
 * `PI_MCP_SETTINGS_SCREENSHOT_DIR` retains screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-mcp-settings-'))
const fixturePath = '/__mcp_settings_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { height: 100vh; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from '/src/components/app/settings/SettingsPage.tsx';
import {I18nProvider, useI18n} from '/src/i18n/index.tsx';
import '/src/styles.css';

window.calls = [];
localStorage.setItem('pi-app:locale', 'en');
const count = (name, value) => { window.calls.push([name, value]); return Promise.resolve(value) };

const appInfo = {
  version: '9.9.9', checkpointsEnabled: true, startup: 'resume',
  subagentsEnabled: true, subagentMaxConcurrent: 4, subagentReuseEnabled: false, subagentCommsEnabled: false, bashMaxWaitMs: 10000,
  sandboxMode: 'workspace-write', sandbox: { support: 'ready', backend: 'seatbelt' }
};

let globalContent = JSON.stringify({ mcpServers: {
  beui: { url: 'https://mcp.beui.dev/mcp' },
  context7: { url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'x' } }
} }, null, 2) + '\\n';
let projectContent = JSON.stringify({ mcpServers: {
  'local-server': { command: 'npx', args: ['-y', 'local-mcp'] }
} }, null, 2) + '\\n';

const roster = () => [
  { name: 'beui', transport: 'http', summary: 'https://mcp.beui.dev/mcp', disabled: state.beuiDisabled,
    scope: 'global', sourcePath: '/agent/mcp.json', editable: true,
    status: state.beuiStatus, toolCount: 4, cachedAt: 1790330000000,
    entry: { url: 'https://mcp.beui.dev/mcp', ...(state.beuiDisabled ? { disabled: true } : {}) } },
  { name: 'context7', transport: 'http', summary: 'https://mcp.context7.com/mcp', disabled: false,
    scope: 'global', sourcePath: '/agent/mcp.json', editable: true,
    status: 'cached', toolCount: 2, cachedAt: 1790330000000,
    entry: { url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'x' } } },
  { name: 'local-server', transport: 'stdio', summary: 'npx -y local-mcp', disabled: false,
    scope: 'project', sourcePath: '/proj/.mcp.json', editable: true,
    status: state.localStatus, toolCount: state.localTools, cachedAt: null,
    entry: { command: 'npx', args: ['-y', 'local-mcp'] } },
  { name: 'shared-server', transport: 'http', summary: 'https://shared.example.com/mcp', disabled: false,
    scope: 'external', sourcePath: '/other/mcp.json', editable: false,
    status: 'failed', toolCount: 1, cachedAt: 1790330000000,
    entry: { url: 'https://shared.example.com/mcp' } }
];
const state = { beuiDisabled: false, beuiStatus: 'connected', localStatus: 'not-connected', localTools: null };
const stateDTO = () => ({
  adapterInstalled: true, adapterVersion: '2.34.0', projectCwd: '/proj',
  global: { path: '/agent/mcp.json', exists: true, content: globalContent, parseError: null },
  project: { path: '/proj/.mcp.json', exists: true, content: projectContent, parseError: null },
  servers: roster()
});
const detail = {
  name: 'beui',
  tools: [
    { name: 'list_components', description: 'List every beUI component.' },
    { name: 'get_component', description: 'Fetch one component source.' }
  ],
  resources: [{ uri: 'beui://registry', name: 'registry', description: 'The registry.' }],
  prompts: [{ name: 'build-page', description: 'Build a page.' }],
  cachedAt: 1790330000000
};

window.pi = {
  appInfo: () => count('appInfo', appInfo),
  openExternal: (url) => count('openExternal', url),
  showInFolder: (path) => count('showInFolder', path),
  mcpState: () => count('mcpState', stateDTO()),
  mcpWriteConfig: (scope, content) => {
    window.calls.push(['mcpWriteConfig', scope, content]);
    if (scope === 'global') globalContent = content; else projectContent = content;
    return Promise.resolve(stateDTO());
  },
  mcpSetServerDisabled: (name, disabled) => {
    window.calls.push(['mcpSetServerDisabled', name, disabled]);
    if (name === 'beui') { state.beuiDisabled = disabled; state.beuiStatus = disabled ? 'disabled' : 'connected'; }
    return Promise.resolve(stateDTO());
  },
  mcpUpsertServer: (payload) => { window.calls.push(['mcpUpsertServer', payload]); return Promise.resolve(stateDTO()); },
  mcpDeleteServer: (path, name) => { window.calls.push(['mcpDeleteServer', path, name]); return Promise.resolve(stateDTO()); },
  mcpServerDetail: (name) => count('mcpServerDetail', { ...detail, name }),
  onMcpStatus: (listener) => { window.mcpStatusListener = listener; return () => { window.mcpStatusListener = null; } }
};

// The beUI Input renders a <label htmlFor>, not aria-label — resolve dialog
// fields through their visible label text.
window.fieldByLabel = (label) => {
  const lab = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent.trim() === label);
  return lab ? document.getElementById(lab.htmlFor) : null;
};

const h = React.createElement;
const LocaleBridge = () => { const { setLocale } = useI18n(); window.setLocale = setLocale; return null; };
createRoot(document.getElementById('root')).render(
  h(I18nProvider, null, h(LocaleBridge), h(SettingsPage, { open: true, onBack: () => {}, accent: 'violet', onAccentChange: () => {}, uiStyle: 'square', onUiStyleChange: () => {} }))
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
        name: 'mcp-settings-fixture',
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
  const screenshot = async (name) => {
    if (!process.env.PI_MCP_SETTINGS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_MCP_SETTINGS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_MCP_SETTINGS_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  const click = async (selector) => {
    assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'exists: ' + selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await pause(120)
  }
  const typeInto = async (selector, value) => {
    await evaluate(`(()=>{
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await pause(80)
  }
  const typeField = async (label, value) => {
    await evaluate(`(function(){
      const el = window.fieldByLabel(${JSON.stringify(label)});
      if (!el) throw new Error('no dialog field: ' + ${JSON.stringify(label)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await pause(80)
  }
  const rowSelector = (name) => `[data-mcp-server="${name}"]`

  for (let i = 0; i < 200; i++) {
    if (await evaluate(`!!window.fixtureReady && !!document.querySelector('[role=tablist]')`)) break
    await pause(50)
  }
  assert.ok(await evaluate(`!!document.querySelector('[role=tablist]')`), 'fixture mounted')
  await pause(400)

  // 1. Registry: MCP sits between Extensions and Skills.
  const order = await evaluate(`[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`)
  const mcpAt = order.indexOf('MCP')
  assert.ok(mcpAt > 0, 'MCP tab exists: ' + order.join(','))
  assert.equal(order[mcpAt - 1], 'Extensions', 'MCP follows Extensions: ' + order.join(','))
  assert.equal(order[mcpAt + 1], 'Skills', 'Skills follows MCP: ' + order.join(','))

  // 2. Open the section: the roster renders every merged server.
  await evaluate(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === 'MCP').click()`)
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(rowSelector('beui'))})`)) break
    await pause(50)
  }
  for (const name of ['beui', 'context7', 'local-server', 'shared-server']) {
    assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(rowSelector(name))})`), name + ' row renders')
  }
  const beuiRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))}).textContent`)
  assert.ok(beuiRow.includes('HTTP'), 'beui carries the HTTP badge')
  assert.ok(beuiRow.includes('Global'), 'beui carries the Global badge')
  assert.ok(beuiRow.includes('4 tools'), 'beui carries its tool count')
  assert.ok(
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui') + ' [data-mcp-status]')})?.classList.contains('bg-emerald-500')`),
    'beui shows the connected dot'
  )
  assert.ok(
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector('shared-server') + ' [data-mcp-status]')})?.classList.contains('bg-destructive')`),
    'shared-server shows the failed dot'
  )
  // External rows are read-only: no edit/delete, toggle stays.
  assert.equal(
    await evaluate(`document.querySelectorAll(${JSON.stringify(rowSelector('shared-server') + ' button[aria-label="Edit"]')}).length`),
    0,
    'external server has no edit button'
  )
  assert.equal(
    await evaluate(`document.querySelectorAll(${JSON.stringify(rowSelector('shared-server') + ' button[aria-label="Delete"]')}).length`),
    0,
    'external server has no delete button'
  )
  await screenshot('roster')

  // 3. Toggle: the checkbox writes through and the roster re-renders.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' [role=checkbox]').click()`)
  await pause(200)
  const toggleCall = await evaluate(`window.calls.find((c) => c[0] === 'mcpSetServerDisabled')`)
  assert.deepEqual(toggleCall, ['mcpSetServerDisabled', 'beui', true], 'toggle writes the disabled flag')
  assert.ok(
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui') + ' [data-mcp-status]')})?.classList.contains('bg-muted-foreground/40')`),
    'the disabled dot replaces connected'
  )

  // 4. A pushed live snapshot re-marks a row without a reload.
  await evaluate(`window.mcpStatusListener({ cwd: '/proj', servers: [{ name: 'local-server', status: 'connected', toolCount: 7, disabled: false }] })`)
  await pause(200)
  assert.ok(
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server') + ' [data-mcp-status]')})?.classList.contains('bg-emerald-500')`),
    'the push re-marks local-server connected'
  )
  const localRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server'))}).textContent`)
  assert.ok(localRow.includes('7 tools'), 'the push updates the tool count')

  // 5. Edit: fields populate from the entry; a rename saves via mcpUpsertServer.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' button[aria-label="Edit"]').click()`)
  await pause(250)
  assert.ok(await evaluate(`!!document.querySelector('[role=dialog]')`), 'editor dialog opens')
  assert.equal(await evaluate(`window.fieldByLabel('Name')?.value`), 'beui', 'name field is populated')
  await evaluate(`(()=>{
    const el = window.fieldByLabel('Name');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'beui2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await pause(80)
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(250)
  const upsertCall = await evaluate(`window.calls.find((c) => c[0] === 'mcpUpsertServer')`)
  assert.ok(upsertCall, 'save calls mcpUpsertServer')
  assert.equal(upsertCall[1].targetPath, '/agent/mcp.json', 'upsert targets the defining file')
  assert.equal(upsertCall[1].originalName, 'beui', 'upsert carries the rename source')
  assert.equal(upsertCall[1].name, 'beui2', 'upsert carries the new name')
  // Step 3 disabled beui; the editor round-trips the flag rather than
  // silently re-enabling the server on save.
  assert.deepEqual(upsertCall[1].entry, { url: 'https://mcp.beui.dev/mcp', disabled: true }, 'upsert carries the form entry')
  assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`), false, 'the dialog closes on save')

  // 6. Add: validation first (no IPC), then a valid stdio server saves by scope.
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add server').click()`)
  await pause(250)
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(200)
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('A server name is required')`), 'empty name is blocked')
  assert.equal(await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer').length`), 1, 'no IPC write for an invalid form')
  await typeField('Name', 'newone')
  await typeField('Command', 'npx test-server')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(250)
  const addCall = (await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer')`)).at(-1)
  assert.equal(addCall[1].scope, 'global', 'a new server saves by scope')
  assert.equal(addCall[1].originalName, null, 'a new server has no rename source')
  assert.deepEqual(addCall[1].entry, { command: 'npx test-server' }, 'the stdio form builds the entry')

  // 7. Tools viewer: tools/resources/prompts render from the detail read.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' button[aria-label="Browse tools"]').click()`)
  await pause(300)
  const toolsDialog = await evaluate(`document.querySelector('[role=dialog]')?.textContent ?? ''`)
  assert.ok(toolsDialog.includes('Tools (2)'), 'tools section lists the count')
  assert.ok(toolsDialog.includes('list_components'), 'tool names render')
  assert.ok(toolsDialog.includes('Resources (1)'), 'resources section renders')
  assert.ok(toolsDialog.includes('Prompts (1)'), 'prompts section renders')
  await evaluate(`document.querySelector('[role=dialog]')?.closest('[data-morphing-modal]')`) // existence only
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(300)
  await screenshot('tools')

  // 8. JSON editor: invalid text shows the parse error and never saves; a
  //    valid edit saves after the debounce.
  await typeInto('textarea[aria-label="Global config"]', '{ broken')
  await pause(1000)
  assert.ok(
    await evaluate(`document.body.textContent.includes('Invalid JSON')`),
    'the parse error shows'
  )
  assert.equal(await evaluate(`window.calls.filter((c) => c[0] === 'mcpWriteConfig').length`), 0, 'invalid JSON never saves')
  await typeInto('textarea[aria-label="Global config"]', '{"mcpServers":{}}')
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`window.calls.filter((c) => c[0] === 'mcpWriteConfig').length > 0`)) break
    await pause(100)
  }
  const writeCall = await evaluate(`window.calls.find((c) => c[0] === 'mcpWriteConfig')`)
  assert.deepEqual(writeCall, ['mcpWriteConfig', 'global', '{"mcpServers":{}}'], 'valid JSON saves after the debounce')

  // 9. zh-CN renders the section.
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(300)
  const zhRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))})?.textContent ?? ''`)
  assert.ok(zhRow.includes('全局'), 'zh-CN scope badge renders')
  assert.ok(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '添加服务器')`), 'zh-CN add button renders')
  await screenshot('zh-CN')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: registry, roster + statuses, toggle write, live push, visual editor (edit/add/validation), tools viewer, JSON debounce save, both locales')
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
