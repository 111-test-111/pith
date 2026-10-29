/**
 * Settings → MCP regression check for Pi's built-in MCP files and tool roster.
 *
 * - Registry: the nav gains an MCP entry between Extensions and Skills.
 * - Roster: merged servers render with status dot, transport/scope badges and
 *   tool counts; external servers have no edit/delete buttons.
 * - Toggle: the row checkbox calls `mcpSetServerDisabled` and re-renders.
 * - Live status: a pushed `pi:mcp-status` snapshot re-marks the row.
 * - Visual editor: edit populates from the entry and saves through
 *   `mcpUpsertServer` (targetPath + originalName); adding goes through scope;
 *   validation blocks an empty name without any IPC write.
 * - Tools viewer: `mcpServerDetail` feeds live SDK-registered tools.
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
    status: state.beuiStatus, toolCount: 4, exposure: 'codemode',
    entry: { url: 'https://mcp.beui.dev/mcp', ...(state.beuiDisabled ? { enabled: false } : {}) } },
  { name: 'context7', transport: 'http', summary: 'https://mcp.context7.com/mcp', disabled: false,
    scope: 'global', sourcePath: '/agent/mcp.json', editable: true,
    status: 'configured', toolCount: 2, exposure: 'direct',
    entry: { url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'x' }, description: 'Context documentation', auth: { provider: 'anthropic' }, oauth: { clientId: 'existing-id', clientSecret: 'existing-secret', clientName: 'Pith', scope: 'read', authServerMetadataUrl: 'https://auth.example/metadata' } } },
  { name: 'local-server', transport: 'stdio', summary: 'npx -y local-mcp', disabled: false,
    scope: 'project', sourcePath: '/proj/.pi/mcp.json', editable: true,
    status: state.localStatus, toolCount: state.localTools, exposure: 'deferred',
    entry: { command: 'npx', args: ['-y', 'local-mcp'] } },
  { name: 'shared-server', transport: 'registered', summary: '—', disabled: false,
    scope: 'external', editable: false,
    status: 'failed', toolCount: 1, exposure: 'codemode',
    entry: {} },
  ...(state.extra ? [{ name: 'empty-external', transport: 'registered', summary: '—', disabled: false,
    scope: 'external', editable: false, status: 'connected', toolCount: 0, exposure: 'codemode', entry: {} }] : [])
];
const state = { sessionPath: '/sessions/first.jsonl', extra: false,
  beuiDisabled: false, beuiStatus: 'connected', localStatus: 'connecting', localTools: 0 };
const stateDTO = () => ({
  projectCwd: '/proj', sessionPath: state.sessionPath, projectTrusted: true,
  global: { path: '/agent/mcp.json', exists: true, content: globalContent, parseError: null },
  project: { path: '/proj/.pi/mcp.json', exists: true, content: projectContent, parseError: null },
  servers: roster(), configIssues: []
});
const detail = {
  name: 'beui',
  tools: [
    { name: 'list_components', description: 'List every beUI component.', exposure: 'codemode' },
    { name: 'get_component', description: 'Fetch one component source.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'Component slug.' } }, required: ['slug'] } }
  ],
  resources: [],
  prompts: [],
  cachedAt: null
};

window.pi = {
  appInfo: () => count('appInfo', appInfo),
  openExternal: (url) => count('openExternal', url),
  showInFolder: (path) => count('showInFolder', path),
  mcpState: () => {
    const snapshot = stateDTO();
    window.calls.push(['mcpState', snapshot]);
    if (!window.holdMcpRead) return Promise.resolve(snapshot);
    window.holdMcpRead = false;
    return new Promise(resolve => { window.finishMcpRead = () => { resolve(snapshot); window.finishMcpRead = null; }; });
  },
  mcpWriteConfig: (scope, content) => {
    window.calls.push(['mcpWriteConfig', scope, content]);
    if (scope === 'global') globalContent = content; else projectContent = content;
    return Promise.resolve(stateDTO());
  },
  mcpSetServerDisabled: (name, disabled) => {
    window.calls.push(['mcpSetServerDisabled', name, disabled]);
    if (name === 'beui') { state.beuiDisabled = disabled; state.beuiStatus = disabled ? 'disabled' : 'connected'; }
    const snapshot = stateDTO();
    if (!window.holdMcpAction) return Promise.resolve(snapshot);
    window.holdMcpAction = false;
    return new Promise(resolve => { window.finishMcpAction = () => { resolve(snapshot); window.finishMcpAction = null; }; });
  },
  mcpUpsertServer: (payload) => { window.calls.push(['mcpUpsertServer', payload]); return Promise.resolve(stateDTO()); },
  mcpDeleteServer: (path, name) => { window.calls.push(['mcpDeleteServer', path, name]); return Promise.resolve(stateDTO()); },
  mcpServerDetail: (name) => count('mcpServerDetail', { ...detail, name,
    tools: detail.tools.map(tool => ({ ...tool, description: tool.description + ' ' + state.sessionPath })) }),
  onMcpStatus: (listener) => { window.mcpStatusListener = listener; return () => { window.mcpStatusListener = null; } }
};
window.emitMcpStatus = patch => {
  Object.assign(state, patch);
  window.mcpStatusListener({ cwd: '/proj', sessionPath: state.sessionPath,
    servers: roster().map(({ name, status, toolCount, disabled }) => ({ name, status, toolCount, disabled })) });
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

  const configChecks = await evaluate(`(async () => {
    const m = await import('/src/lib/mcp-config.ts');
    const form = m.serverEntryToForm('legacy-name', { url:'https://fixture.example/mcp', exposure:'codemode-deferred', toolExposure:{'read-*':'codemode-deferred'}, auth:{provider:'anthropic'}, oauth:{clientName:'Pith',authServerMetadataUrl:'https://auth.example/metadata'} });
    return { exposures:m.MCP_EXPOSURES, formExposure:form.exposure, toolExposure:form.toolExposure[0].value,
      collision:m.validateMcpServerForm({...form,name:'local_server',originalName:undefined},['local-server']),
      project:m.validateMcpServerForm(form,[],'project'),
      config:m.validateMcpConfigDocument({mcpServers:{credentials:m.formToServerEntry(form)}},'project') };
  })()`)
  assert.deepEqual(configChecks.exposures, ['codemode','deferred','direct','hidden'])
  assert.equal(configChecks.formExposure, 'codemode')
  assert.equal(configChecks.toolExposure, 'codemode')
  assert(configChecks.collision.includes('duplicate'))
  assert(configChecks.project.includes('authScope'))
  assert.equal(configChecks.config, 'credentials.auth')

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
  // Extension-registered rows are read-only and have no config toggle.
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
  assert.equal(
    await evaluate(`document.querySelectorAll(${JSON.stringify(rowSelector('shared-server') + ' [role=checkbox]')}).length`),
    0,
    'extension-registered server has no config toggle'
  )
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(rowSelector('shared-server'))}).textContent`)).includes('Extension'), 'registered transport is accurate')
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
  await evaluate(`window.emitMcpStatus({ localStatus: 'connected', localTools: 7 })`)
  await pause(200)
  assert.ok(
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server') + ' [data-mcp-status]')})?.classList.contains('bg-emerald-500')`),
    'the push re-marks local-server connected'
  )
  const localRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server'))}).textContent`)
  assert.ok(localRow.includes('7 tools'), 'the push updates the tool count')

  // A details dialog follows every native state transition while it stays open.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server'))} + ' button[aria-label="Browse tools"]').click()`)
  await pause(200)
  for (const [status, label] of [['connecting', 'Connecting'], ['connected', 'Connected'],
    ['disconnected', 'Disconnected'], ['failed', 'Connection failed'],
    ['needs-auth', 'Sign-in required'], ['disabled', 'Disabled']]) {
    await evaluate(`window.emitMcpStatus({ localStatus: ${JSON.stringify(status)} })`)
    await pause(100)
    assert.ok((await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server') + ' [data-mcp-status]')}).getAttribute('aria-label')`)).includes(label),
      'the roster reports ' + status)
    assert.ok((await evaluate(`document.querySelector('[role=dialog]').textContent`)).includes(label),
      'the open details dialog reports ' + status)
    await screenshot('status-' + status)
  }
  const firstOwner = '/sessions/first.jsonl'
  const secondOwner = '/sessions/second.jsonl'
  await evaluate(`window.emitMcpStatus({ sessionPath: ${JSON.stringify(secondOwner)} })`)
  await pause(200)
  const switchedTools = await evaluate(`document.querySelector('[role=dialog]').textContent`)
  assert.ok(switchedTools.includes(secondOwner) && !switchedTools.includes(firstOwner),
    'an open dialog refreshes its tools when switching sessions with identical status and count')
  await evaluate(`document.querySelector('button[aria-label="Close modal"]').click()`)
  await pause(250)
  await evaluate(`window.emitMcpStatus({ sessionPath: ${JSON.stringify(firstOwner)} })`)
  await pause(150)

  // A state read made before the connected push must not overwrite that push.
  await evaluate(`window.emitMcpStatus({ localStatus: 'connecting' }); window.holdMcpRead = true;
    void import('/src/lib/mcp-store.ts').then(m => m.refreshMcpState());`)
  await pause(100)
  assert.ok(await evaluate(`!!window.finishMcpRead`), 'the fixture holds a connecting snapshot in flight')
  await evaluate(`window.emitMcpStatus({ localStatus: 'connected' }); window.finishMcpRead();`)
  await pause(200)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server') + ' [data-mcp-status]')}).getAttribute('aria-label')`),
    'Connected', 'an older read cannot replace a new connection observation')

  // A pending action returns the old session snapshot after a same-cwd switch.
  const beforeRace = await evaluate(`window.calls.filter(c => c[0] === 'mcpSetServerDisabled').length`)
  await evaluate(`window.holdMcpAction = true;
    void import('/src/lib/mcp-store.ts').then(m => m.setMcpServerDisabled('beui', true));`)
  await pause(100)
  assert.ok(await evaluate(`!!window.finishMcpAction`), 'the fixture holds a mutating reply in flight')
  await evaluate(`window.emitMcpStatus({ sessionPath: '/sessions/second.jsonl', localStatus: 'connecting', localTools: 0 }); window.finishMcpAction();`)
  await pause(250)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(rowSelector('local-server') + ' [data-mcp-status]')}).getAttribute('aria-label')`),
    'Connecting', 'a same-cwd session switch supersedes an old action snapshot')
  assert.equal(await evaluate(`window.calls.filter(c => c[0] === 'mcpSetServerDisabled').length`), beforeRace + 1,
    'reading the new session never repeats the mutating call')

  await evaluate(`window.emitMcpStatus({ extra: true })`)
  await pause(200)
  assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(rowSelector('empty-external'))})`),
    'a live external server with zero tools joins the roster')
  await evaluate(`window.emitMcpStatus({ extra: false })`)
  await pause(200)
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(rowSelector('empty-external'))})`), false,
    'a removed external server leaves the roster')

  // 5. Edit: fields populate from the entry; a rename saves via mcpUpsertServer.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' button[aria-label="Edit"]').click()`)
  await pause(250)
  assert.ok(await evaluate(`!!document.querySelector('[role=dialog]')`), 'editor dialog opens')
  assert.equal(await evaluate(`window.fieldByLabel('Name')?.value`), 'beui', 'name field is populated')
  // One form row for the whole visual editor: every field title — beUI Input
  // labels and the hand-rolled headings over radio groups and key/value lists —
  // reads at the form's 14px, sits flush with its control (no label inset of its
  // own), shares one colour, and keeps one 10px gap to that control. Insets are
  // measured against the parent's CONTENT box, so a padded body never reads as an
  // indent.
  const editorTitleFacts = await evaluate(`(()=>{const d=document.querySelector('[role=dialog]'),titles=[...d.querySelectorAll('label.text-sm.font-medium,p.text-sm.font-medium')],box=e=>({l:e.getBoundingClientRect().left,p:parseFloat(getComputedStyle(e).paddingLeft)}),inset=e=>{const a=box(e),b=box(e.parentElement);return Math.round(a.l+a.p-b.l-b.p)},gap=e=>Math.round(e.nextElementSibling.getBoundingClientRect().top-e.getBoundingClientRect().bottom);return{titles:titles.map(e=>e.textContent?.trim()),insets:[...new Set(titles.map(inset))],colors:[...new Set(titles.map(e=>getComputedStyle(e).color))],gaps:[...new Set(titles.map(gap))]}})()`)
  assert.ok(editorTitleFacts.titles.length >= 5 && editorTitleFacts.insets.length === 1 && editorTitleFacts.insets[0] === 0, `every editor field title is flush with its control: ${JSON.stringify(editorTitleFacts)}`)
  assert.equal(editorTitleFacts.colors.length, 1, `every editor field title shares one colour: ${JSON.stringify(editorTitleFacts.colors)}`)
  assert.ok(editorTitleFacts.gaps.length === 1 && editorTitleFacts.gaps[0] >= 8, `every editor field title keeps one gap to its control: ${JSON.stringify(editorTitleFacts.gaps)}`)
  // Edit items are separated by one roomier rhythm (20px), the body's only
  // spacing source.
  const itemGaps = await evaluate(`(()=>{const items=[...document.querySelectorAll('[data-form-items] > *')].map(e=>e.getBoundingClientRect()),steps=[];for(const r of items){const next=items.filter(o=>o.top>=r.bottom-1).sort((a,b)=>a.top-b.top)[0];if(next)steps.push(Math.round(next.top-r.bottom))}return{count:items.length,steps:[...new Set(steps)]}})()`)
  assert.ok(
    itemGaps.count >= 4 && itemGaps.steps.length === 1 && itemGaps.steps[0] >= 16,
    `edit items keep one roomier rhythm: ${JSON.stringify(itemGaps)}`
  )
  const editorColumns = await evaluate(`(()=>{const body=document.querySelector('[data-form-items]');return{columns:getComputedStyle(body).gridTemplateColumns.split(' ').length,scroll:body.scrollHeight,client:body.clientHeight}})()`)
  assert.equal(editorColumns.columns, 2, `the MCP editor lays out in two columns: ${JSON.stringify(editorColumns)}`)
  assert.ok(
    editorColumns.scroll <= editorColumns.client + 2,
    `every MCP editor item shows at once, nothing clipped: ${JSON.stringify(editorColumns)}`
  )
  await screenshot('editor')
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
  // Step 3 disabled beui; the editor round-trips the native flag rather than
  // silently re-enabling the server on save.
  assert.deepEqual(upsertCall[1].entry, { url: 'https://mcp.beui.dev/mcp', enabled: false }, 'upsert carries the native form entry')
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

  // The same visual add flow can target the native project file.
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add server').click()`)
  await pause(150)
  await evaluate(`[...document.querySelectorAll('[role=dialog] [role=radio]')].find((r) => r.closest('label')?.textContent.trim() === 'Project').click()`)
  await typeField('Name', 'project-one')
  await typeField('Command', 'node project-server.mjs')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(200)
  const projectAdd = (await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer')`)).at(-1)
  assert.equal(projectAdd[1].scope, 'project', 'visual add targets .pi/mcp.json')

  // Pi 1.0 native fields round-trip through the actual visual editor.
  const beforeNativeEdit = await evaluate(`window.calls.filter(c => c[0] === 'mcpUpsertServer').length`)
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('context7'))} + ' button[aria-label="Edit"]').click()`)
  await pause(250)
  assert.equal(await evaluate(`window.fieldByLabel('Description')?.value`), 'Context documentation')
  assert.equal(await evaluate(`window.fieldByLabel('Provider authentication')?.value`), 'anthropic')
  assert.equal(await evaluate(`window.fieldByLabel('OAuth client name')?.value`), 'Pith')
  assert.equal(await evaluate(`window.fieldByLabel('Authorization server metadata URL')?.value`), 'https://auth.example/metadata')
  await screenshot('native-editor')
  await typeField('Authorization server metadata URL', 'http://remote.example/metadata')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Save').click()`)
  await pause(150)
  assert.equal(await evaluate(`window.calls.filter(c => c[0] === 'mcpUpsertServer').length`), beforeNativeEdit, 'unsafe metadata URL never reaches IPC')
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('must use HTTPS')`))
  await typeField('Authorization server metadata URL', 'https://auth.example/new-metadata')
  await typeField('OAuth client name', 'Pith 1.0')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Save').click()`)
  await pause(250)
  const nativeEdit = (await evaluate(`window.calls.filter(c => c[0] === 'mcpUpsertServer')`)).at(-1)[1]
  assert.deepEqual(nativeEdit.entry, {
    url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'x' }, description: 'Context documentation',
    auth: { provider: 'anthropic' }, oauth: { clientId: 'existing-id', clientSecret: 'existing-secret', clientName: 'Pith 1.0',
      scope: 'read', authServerMetadataUrl: 'https://auth.example/new-metadata' }
  }, 'editing new OAuth fields preserves existing credentials and provider auth')

  // 6b. JSON paste mode: invalid snippets are rejected without an IPC write;
  //     both documented shapes save with the raw entry preserved verbatim.
  const upsertCount = await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer').length`)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add server').click()`)
  await pause(250)
  // The mode picker offers Visual / JSON radios when adding.
  await evaluate(`[...document.querySelectorAll('[role=dialog] [role=radio]')].find((r) => r.closest('label')?.textContent.trim() === 'JSON').click()`)
  await pause(150)
  assert.ok(await evaluate(`!!document.querySelector('[role=dialog] textarea')`), 'JSON mode renders the snippet editor')
  await typeInto('[role=dialog] textarea', '{ nope')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(150)
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('not valid JSON')`), 'an invalid snippet is rejected')
  // A duplicate name is blocked before the write.
  await typeInto('[role=dialog] textarea', '{"mcpServers":{"beui":{"url":"https://x.test/mcp"}}}')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(150)
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('already exists')`), 'a duplicate name is rejected')
  assert.equal(
    await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer').length`),
    upsertCount,
    'invalid snippets never reach the IPC write'
  )
  // Adapter-only fields are rejected before IPC, then a native exposure
  // override survives the JSON snippet exactly.
  await typeInto('[role=dialog] textarea', '{"mcpServers":{"pasted":{"url":"https://x.test/mcp","customField":42}}}')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(150)
  assert.equal(await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer').length`), upsertCount, 'unsupported field is not written')
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('not supported')`), 'legacy field gets actionable error')
  await typeInto('[role=dialog] textarea', '{"mcpServers":{"pasted":{"url":"https://x.test/mcp","description":42}}}')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(150)
  assert.equal(await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer').length`), upsertCount, 'invalid native field is not written')
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('Unsupported or invalid field: pasted.description')`), 'an invalid new field value does not claim the supported field is retired')
  await typeInto('[role=dialog] textarea', '{"mcpServers":{"pasted":{"url":"https://x.test/mcp","exposure":"direct","toolExposure":{"write_*":"hidden"}}}}')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(250)
  const topCall = (await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer')`)).at(-1)
  assert.equal(topCall[1].scope, 'global', 'a pasted server lands global')
  assert.equal(topCall[1].originalName, null, 'a pasted server has no rename source')
  assert.equal(topCall[1].name, 'pasted', 'the snippet name wins')
  assert.deepEqual(topCall[1].entry, { url: 'https://x.test/mcp', exposure: 'direct', toolExposure: { 'write_*': 'hidden' } }, 'native entry is preserved verbatim')
  assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`), false, 'the dialog closes on save')
  // From the bare name map.
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add server').click()`)
  await pause(250)
  await evaluate(`[...document.querySelectorAll('[role=dialog] [role=radio]')].find((r) => r.closest('label')?.textContent.trim() === 'JSON').click()`)
  await pause(150)
  await typeInto('[role=dialog] textarea', '{"pasted2":{"command":"npx","args":["-y","srv"]}}')
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save').click()`)
  await pause(250)
  const bareCall = (await evaluate(`window.calls.filter((c) => c[0] === 'mcpUpsertServer')`)).at(-1)
  assert.equal(bareCall[1].name, 'pasted2', 'the bare name map unwraps')
  assert.deepEqual(bareCall[1].entry, { command: 'npx', args: ['-y', 'srv'] }, 'the bare entry is preserved verbatim')

  // 7. Tools viewer: current SDK tools and exposure render from the detail read.
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' button[aria-label="Browse tools"]').click()`)
  await pause(300)
  const toolsDialog = await evaluate(`document.querySelector('[role=dialog]')?.textContent ?? ''`)
  assert.ok(toolsDialog.includes('Tools (2)'), 'tools section lists the count')
  assert.ok(toolsDialog.includes('list_components'), 'tool names render')
  assert.ok(toolsDialog.includes('Codemode'), 'per-tool exposure renders')
  assert.ok(toolsDialog.includes('slug'), 'input schema parameters render')
  assert.ok(toolsDialog.includes('Component slug.'), 'parameter descriptions render')
  // Reopening the SAME server hits the store cache: content renders on the
  // first frame instead of flashing the loading line (the background refresh
  // then replaces it silently).
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(300)
  await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))} + ' button[aria-label="Browse tools"]').click()`)
  const reopenFrame = await evaluate(`document.querySelector('[role=dialog]')?.textContent ?? ''`)
  assert.ok(reopenFrame.includes('list_components'), 'the reopened panel renders from cache instantly')
  assert.ok(!reopenFrame.includes('Loading MCP configuration'), 'no loading flash on a cache hit')
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
  assert.ok(await evaluate(`!!document.querySelector('textarea[aria-label="Project config"]')`), 'native project JSON editor uses .pi/mcp.json')

  // 9. zh-CN renders the section.
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(300)
  const zhRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))})?.textContent ?? ''`)
  assert.ok(zhRow.includes('全局'), 'zh-CN scope badge renders')
  assert.ok(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '添加服务器')`), 'zh-CN add button renders')
  await screenshot('zh-CN')

  // 9b. zh-TW renders the section in Traditional Chinese.
  await evaluate(`window.setLocale('zh-TW')`)
  await pause(300)
  const twRow = await evaluate(`document.querySelector(${JSON.stringify(rowSelector('beui'))})?.textContent ?? ''`)
  assert.ok(twRow.includes('全域'), 'zh-TW scope badge renders')
  assert.ok(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '新增伺服器')`), 'zh-TW add button renders')
  await screenshot('zh-TW')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: native roster + statuses, toggle, live push, visual editor, exposure, tool viewer, JSON editors, all three locales')
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
