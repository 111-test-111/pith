/**
 * Settings → Tools redesign regression check: namespaced tool families
 * (`ctx_*`, `web_*`) collapse into one group row that reveals its members, and
 * a long tool description sits in a bounded scroll viewport whose clipped edge
 * fades instead of cutting a line.
 *
 * Real `ToolsSection` in isolated Electron against a synthetic catalog; no SDK,
 * no model calls, no network. Run after building:
 *   node scripts/check-tool-settings.mjs
 * `PI_TOOL_SETTINGS_SCREENSHOT_DIR` retains the light/dark screenshots.
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
const temporary = await mkdtemp(join(tmpdir(), 'pith-tools-'))
const fixturePath = '/__tool_settings_check.html'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Long enough to overflow the 176px (max-h-44) description viewport.
const LONG_DESCRIPTION = Array.from(
  { length: 12 },
  (_, i) =>
    `Paragraph ${i + 1}: read a file into a sandboxed FILE_CONTENT variable and run code over it ` +
    'so only what the code prints enters the conversation, never the raw bytes of the file.'
).join(' ')

const tool = (name, description, extra = {}) => ({
  name,
  description,
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Absolute file path or relative to project root' },
      language: { type: 'string', enum: ['javascript', 'python'], description: 'Runtime language' }
    }
  },
  source: { kind: 'extension', label: 'context-mode' },
  active: true,
  disabledByExtension: false,
  ...extra
})

const CATALOG = {
  tools: [
    tool('web_search', 'Search the web for current information.', { source: { kind: 'extension', label: 'Tavily' } }),
    tool('web_fetch', 'Fetch and extract content from known URLs.', { source: { kind: 'extension', label: 'Tavily' } }),
    tool('ctx_execute', LONG_DESCRIPTION),
    tool('ctx_execute_file', 'Read a file into a sandboxed FILE_CONTENT variable.'),
    tool('ctx_index', 'Store content in a searchable knowledge base.'),
    tool('ctx_search', 'Search a unified knowledge base.'),
    tool('ctx_stats', 'Context consumption statistics.'),
    tool('ctx_batch_execute', 'Run multiple commands in one call.'),
    tool('mcp__context7', 'Query Context7 documentation.'),
    tool('read', 'Read a file from the workspace.', { source: { kind: 'builtin', label: 'built-in' }, parameters: {} }),
    tool('write', 'Write a file in the workspace.', { source: { kind: 'builtin', label: 'built-in' }, parameters: {} }),
    tool('bash', 'Run a shell command.', { source: { kind: 'builtin', label: 'built-in' }, parameters: {} }),
    tool('bash_task', 'Manage background shell tasks.', {
      source: { kind: 'builtin', label: 'built-in' },
      parameters: {},
      active: false,
      disabledByExtension: true
    })
  ],
  extensions: [],
  skills: [],
  skillDiagnostics: []
}

// A catalog that does NOT lead with families: the families still have to lead
// the rendered list.
const REORDERED_CATALOG = {
  tools: [
    tool('read', 'Read a file from the workspace.', { source: { kind: 'builtin', label: 'built-in' }, parameters: {} }),
    tool('write', 'Write a file in the workspace.', { source: { kind: 'builtin', label: 'built-in' }, parameters: {} }),
    tool('ctx_execute', LONG_DESCRIPTION),
    tool('ctx_execute_file', 'Read a file into a sandboxed FILE_CONTENT variable.'),
    tool('ctx_index', 'Store content in a searchable knowledge base.')
  ],
  extensions: [],
  skills: [],
  skillDiagnostics: []
}

const fixture = `<!doctype html><html><head><style>
body { margin: 0; } #root { padding: 24px; max-width: 1100px; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToolsSection} from '/src/components/app/settings/ToolsSection.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {buildToolList, toolPrefix, toolGroupKey, groupPrefixOf} from '/src/lib/tool-groups.ts';
import {refreshCatalog} from '/src/lib/extensions-catalog.ts';
import en from '/src/i18n/locales/en.ts';
import zhCN from '/src/i18n/locales/zh-CN.ts';
import '/src/styles.css';
const catalog = ${JSON.stringify(CATALOG)};
window.pi = { toolsCatalog: async () => catalog };
window.refreshCatalog = refreshCatalog;
// Pin the first run to English; the zh-CN pass stores its own locale first.
if (!window.localStorage.getItem('pi-app:locale')) window.localStorage.setItem('pi-app:locale','en');
window.toolGrouping = { buildToolList, toolPrefix, toolGroupKey, groupPrefixOf, entries: buildToolList(catalog.tools) };
window.locales = { en, 'zh-CN': zhCN };
const h = React.createElement;
createRoot(document.getElementById('root')).render(h(I18nProvider, null, h(ToolsSection)));
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'tools-fixture', configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== fixturePath) return next()
          try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) }
          catch (error) { next(error) }
        })
      }
    }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1180,height:900,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});
app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
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
  // Electron's own sandboxed-renderer bundle complains about a missing
  // preload's startup data in a window that has none; that is not our page.
  const ELECTRON_NOISE = /sandboxed_renderer\.bundle\.js|binding\.startupData/
  let sequence = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, (m) => (m.error ? reject(m.error) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.fixtureReady && !!document.querySelector("[role=\\"tab\\"]")')) return
      await pause(50)
    }
    throw new Error('Fixture did not mount')
  }
  const screenshot = async (name) => {
    if (!process.env.PI_TOOL_SETTINGS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_TOOL_SETTINGS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_TOOL_SETTINGS_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  // A member of a closed family keeps its own box but is clipped by the
  // reveal, so "visible" has to be settled by what the point actually hits.
  const visibleRows = () => evaluate(`(() => [...document.querySelectorAll('[role=tab]')].filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.height < 0.5) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === el || el.contains(hit);
  }).length)()` )
  const groupExpanded = (prefix) => evaluate(
    `document.querySelector('[aria-controls="tool-group-${prefix}"]').getAttribute('aria-expanded')`
  )
  const groupPanelHeight = (prefix) => evaluate(
    `document.getElementById('tool-group-${prefix}').offsetHeight`
  )
  const clickGroup = (prefix) => evaluate(
    `document.querySelector('[aria-controls="tool-group-${prefix}"]').click(); true`
  )
  const clickTool = (name) => evaluate(
    `document.querySelector('[data-tool="${name}"] [role=tab]').click(); true`
  )
  const detailName = () => evaluate(
    `document.querySelector('[data-tool-detail-name]').textContent`
  )
  const fadeState = () => evaluate(`(() => {
    const el = document.querySelector('[data-fade-scroll]');
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      fade: el.getAttribute('data-fade'),
      mask: style.maskImage || style.webkitMaskImage,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop
    };
  })()`)
  // The description sits in the same framed card as the parameters, and the
  // fade belongs to the inner viewport — the card's own border must stay crisp.
  // Its corner follows the app's own scale, so this reads the parameters frame
  // (identical card markup) as the reference and the token the radius class
  // resolves to — never a literal, which a design round-trip would falsify.
  const descriptionCard = () => evaluate(`(() => {
    const card = document.querySelector('[data-tool-description]');
    if (!card) return null;
    const style = getComputedStyle(card);
    const parameters = document.querySelector('[data-tool-parameters]');
    const root = getComputedStyle(document.documentElement);
    const viewport = card.querySelector('[data-fade-scroll]');
    const chips = document.querySelector('[data-tool-detail-name]').parentElement;
    const label = document.querySelector('[data-tool-description-label]');
    return {
      label: label.textContent,
      // Distance from the tool-name row down to the label: the section sits at
      // the detail column's own 20px rhythm (space-y-5), not flush under it.
      gapAbove: Math.round(label.getBoundingClientRect().top - chips.getBoundingClientRect().bottom),
      gapBelow: getComputedStyle(label).marginBottom,
      border: style.borderTopWidth + ' ' + style.borderTopStyle,
      corner: style.borderTopLeftRadius,
      parametersCorner: parameters ? getComputedStyle(parameters).borderTopLeftRadius : null,
      scaleToken: [
        root.getPropertyValue('--app-radius-item').trim(),
        root.getPropertyValue('--radius-xl').trim()
      ],
      surface: style.backgroundColor,
      mask: style.maskImage,
      viewportMask: viewport ? getComputedStyle(viewport).maskImage : null
    };
  })()`)
  const firstListChild = () => evaluate(`(() => {
    const row = document.querySelector('[role=tablist] > *');
    const header = row && row.querySelector('[aria-controls]');
    return header ? header.getAttribute('aria-controls') : row ? 'tool:' + row.getAttribute('data-tool') : null;
  })()`)
  const secondListChild = () => evaluate(
    `document.querySelector('[role=tablist] > *:nth-child(2)').getAttribute('data-tool')`
  )
  const scrollDescription = (top) => evaluate(
    `(() => { const el = document.querySelector('[data-fade-scroll]'); el.scrollTop = ${top}; return el.scrollTop; })()`
  )

  await ready()
  await pause(300)

  // --- pure grouping: order-preserving, family-first, lone prefixes stay plain
  const grouping = await evaluate('(() => { const g = window.toolGrouping; return { entries: g.entries, prefixes: g.entries.map(e => e.kind === "group" ? "group:" + e.prefix : "tool:" + e.tool.name), single: g.toolPrefix("read"), nested: g.toolPrefix("mcp__context7"), leading: g.toolPrefix("_x"), three: g.toolPrefix("a_b_c"), registryKey: g.toolGroupKey("mcpScript"), proxyKey: g.toolGroupKey("mcp__beui"), prefixedKey: g.toolGroupKey("ctx_execute"), plainKey: g.toolGroupKey("read"), held: g.groupPrefixOf(g.entries, "ctx_stats"), notHeld: g.groupPrefixOf(g.entries, "read"), foreign: g.buildToolList([{name:"ctx_a"},{name:"read"},{name:"ctx_b"}]).map(e => e.kind === "group" ? "group:" + e.prefix + "(" + e.tools.length + ")" : "tool:" + e.tool.name) }; })()')
  assert.deepEqual(grouping.prefixes, [
    'group:web', 'group:ctx', 'tool:mcp__context7', 'tool:read', 'tool:write', 'tool:bash', 'tool:bash_task'
  ], 'families render as one entry each at the head, then the standalone tools; a lone prefix stays a row')
  assert.equal(grouping.entries[0].tools.length, 2, 'web family holds both web tools')
  assert.equal(grouping.entries[1].tools.length, 6, 'ctx family holds all six ctx tools')
  assert.equal(grouping.single, null, 'an unnamespaced name has no prefix')
  assert.equal(grouping.nested, 'mcp', 'a double underscore still yields one prefix')
  assert.equal(grouping.leading, null, 'a leading underscore is not a prefix')
  assert.equal(grouping.three, 'a', 'only the first segment is the prefix')
  assert.equal(grouping.registryKey, 'mcp', 'the registry folds mcpScript into the mcp family')
  assert.equal(grouping.proxyKey, 'mcp', 'a server proxy lands in the same mcp family')
  assert.equal(grouping.prefixedKey, 'ctx', 'a category without a group key still groups by its prefix')
  assert.equal(grouping.plainKey, null, 'an unnamespaced built-in belongs to no family')
  assert.equal(grouping.held, 'ctx', 'groupPrefixOf resolves a member')
  assert.equal(grouping.notHeld, null, 'groupPrefixOf rejects a standalone tool')
  assert.deepEqual(grouping.foreign, ['group:ctx(2)', 'tool:read'], 'non-adjacent members still gather')
  const leading = await evaluate('window.toolGrouping.buildToolList([{name:"read"},{name:"ctx_a"},{name:"ctx_b"},{name:"write"}]).map(e => e.kind === "group" ? "group:" + e.prefix : "tool:" + e.tool.name)')
  assert.deepEqual(leading, ['group:ctx', 'tool:read', 'tool:write'], 'families lead even when the catalog does not')
  const mcpFamily = await evaluate('window.toolGrouping.buildToolList([{name:"read"},{name:"mcp"},{name:"mcpScript"},{name:"mcp__context7"}]).map(e => e.kind === "group" ? "group:" + e.prefix + "(" + e.tools.length + ")" : "tool:" + e.tool.name)')
  assert.deepEqual(mcpFamily, ['group:mcp(3)', 'tool:read'], 'gateway, script tool and server proxies fold into ONE mcp family')
  const loneProxy = await evaluate('window.toolGrouping.buildToolList([{name:"mcp__context7"},{name:"read"}]).map(e => e.kind === "group" ? "group:" + e.prefix : "tool:" + e.tool.name)')
  assert.deepEqual(loneProxy, ['tool:mcp__context7', 'tool:read'], 'a lone family member stays a plain row (no group for one click)')
  const mcpGroupOf = await evaluate('window.toolGrouping.groupPrefixOf(window.toolGrouping.buildToolList([{name:"mcp"},{name:"mcpScript"},{name:"mcp__context7"}]), "mcp__context7")')
  assert.equal(mcpGroupOf, 'mcp', 'the open-on-selection lookup resolves the mcp family')

  // --- default state: the selected tool's family is open, the rest collapsed
  assert.equal(await visibleRows(), 7, 'collapsed families hide their members (2 web + 5 standalone)')
  assert.equal(await firstListChild(), 'tool-group-web', 'the list leads with the web family')
  assert.equal(await groupExpanded('web'), 'true', 'the family holding the selected tool is open')
  assert.equal(await groupExpanded('ctx'), 'false', 'other families start collapsed')
  assert.equal(await groupPanelHeight('ctx'), 0, 'a collapsed family takes no height')
  assert.equal(
    await evaluate('document.querySelector(\'[aria-controls="tool-group-ctx"]\').getAttribute("aria-label")'),
    'ctx tools · 6', 'the group control is labelled with its family and count'
  )
  assert.equal(
    await evaluate('document.getElementById("tool-group-ctx").querySelectorAll("[role=tab]").length'),
    6, 'members stay mounted inside the closed reveal (inert, not dropped)'
  )
  assert.equal(
    await evaluate('document.querySelector(\'[aria-controls="tool-group-ctx"] [data-tool-group-count]\').textContent'),
    '6', 'the header shows the member count'
  )
  await screenshot('collapsed-light')

  // --- one honest line under the list: an extension can register its tools on
  //     its first agent turn, so a fresh launch genuinely cannot list them
  const hint = await evaluate(`(() => {
    const el = document.querySelector('[data-tools-lazy-hint]');
    if (!el) return null;
    const list = document.querySelector('[role=tablist]');
    return {
      text: el.textContent.trim(),
      insideList: !!el.closest('[role=tablist]'),
      afterList: !!(list.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      control: !!el.querySelector('button, a, [role=button], input'),
      listColumn: el.parentElement === list.parentElement
    };
  })()`)
  assert.ok(hint, 'the tools list carries the lazily-registered-tools note')
  assert.equal(
    hint.text,
    'Tools from some extensions appear here after their first use.',
    'the note says what is actually missing and when it arrives'
  )
  assert.equal(hint.insideList, false, 'the note is not a tab row')
  assert.equal(hint.afterList, true, 'it sits under the list')
  assert.equal(hint.listColumn, true, 'in the list column, not the detail pane')
  assert.equal(hint.control, false, 'and is plain text, not a control')

  // --- expansion reveals the whole family, and selection keeps it open
  await clickGroup('ctx')
  await pause(400) // the reveal is a 220ms height/clip animation
  assert.equal(await groupExpanded('ctx'), 'true', 'clicking the header expands the family')
  assert.ok((await groupPanelHeight('ctx')) > 100, 'the expanded family has real height')
  assert.equal(await visibleRows(), 13, 'every ctx member becomes visible')
  await screenshot('expanded-light')

  await clickTool('ctx_execute')
  await pause(400)
  assert.equal(await detailName(), 'ctx_execute', 'selecting a member switches the detail pane')
  assert.equal(await groupExpanded('ctx'), 'true', 'selecting inside a family keeps it open')
  assert.equal(await groupExpanded('web'), 'false', 'the family left behind folds away')

  // --- a long description is bounded and fades at the clipped edge
  const top = await fadeState()
  assert.equal(top.fade, 'bottom', 'an overflowing description fades at the bottom while at the top')
  assert.match(top.mask, /calc\(100% - 12px\)/, 'the fade sits on the edge that hides content — the bottom, here')
  assert.ok(top.scrollHeight > top.clientHeight, 'the description overflows its box')
  assert.ok(top.clientHeight <= 176 && top.clientHeight > 100, 'the box is capped at max-h-44 but not clipped to nothing')
  assert.equal(top.scrollTop, 0, 'the description starts at the top')
  const card = await descriptionCard()
  assert.equal(card.label, 'Description', 'the description carries its own label')
  assert.ok(card.gapAbove >= 18, `the label is separated from the tool-name row (got ${card.gapAbove}px)`)
  assert.equal(card.gapBelow, '8px', 'the label keeps the same gap above its frame as the parameters label')
  assert.equal(card.border, '1px solid', 'the description sits in a visible frame like the parameters')
  assert.equal(card.corner, card.parametersCorner, 'the description frame and the parameters frame share one corner')
  assert.ok(
    card.scaleToken.includes(card.corner),
    `the frame takes the app's own corner scale (${card.corner} vs --app-radius-item ${card.scaleToken[0]} / --radius-xl ${card.scaleToken[1]})`
  )
  assert.notEqual(card.surface, 'rgba(0, 0, 0, 0)', 'the frame paints a surface')
  assert.equal(card.mask, 'none', 'the fade belongs to the inner viewport, never to the frame')
  assert.match(card.viewportMask, /gradient/, 'the scrolling description is the masked element')
  await screenshot('description-light-top')

  await scrollDescription(1000)
  await frame()
  const bottom = await fadeState()
  assert.equal(bottom.fade, 'top', 'at the end the top edge is the hidden one')
  assert.match(bottom.mask, /^linear-gradient\(rgba\(0, 0, 0, 0\)/, 'the top ramp is the shared 12px one, on the top edge')
  await evaluate('document.documentElement.classList.add("dark")')
  await pause(150)
  await screenshot('description-dark-bottom')

  await scrollDescription(Math.round((top.scrollHeight - top.clientHeight) / 2))
  await frame()
  assert.equal((await fadeState()).fade, 'both', 'mid-scroll both edges fade')

  // --- a short description renders with no mask at all
  await clickTool('read')
  await frame()
  assert.equal(await detailName(), 'read', 'a standalone tool selects too')
  const short = await fadeState()
  assert.equal(short.fade, 'none', 'a description that fits gets no mask')
  assert.equal(short.mask, 'none', 'and no gradient is painted')
  assert.equal((await descriptionCard()).mask, 'none', 'a short description still sits in its frame')
  await clickTool('ctx_execute')
  await pause(300)

  // --- collapsing the family that owns the selection never blanks the detail
  await clickGroup('ctx')
  await pause(300)
  assert.equal(await groupPanelHeight('ctx'), 0, 'an open family collapses again')
  assert.equal(await detailName(), 'ctx_execute', 'the detail pane keeps the selected tool')
  await clickGroup('ctx')
  await pause(300)
  assert.equal(
    await evaluate('document.querySelector(\'[data-tool="ctx_execute"] [role=tab]\').getAttribute("aria-selected")'),
    'true', 'the selection survives the round-trip'
  )
  await clickTool('read')
  await frame()
  assert.equal(await detailName(), 'read', 'a standalone tool still selects after a collapse')

  // --- families lead the rendered list even when the catalog does not
  await evaluate(`window.pi.toolsCatalog = async () => (${JSON.stringify(REORDERED_CATALOG)}); true`)
  await evaluate('window.refreshCatalog()')
  await pause(300)
  assert.equal(await firstListChild(), 'tool-group-ctx', 'the family leads although its members came last in the catalog')
  assert.equal(await secondListChild(), 'read', 'the standalone tools follow the families')
  assert.equal(
    await evaluate('document.querySelector(\'[aria-controls="tool-group-ctx"] [data-tool-group-count]\').textContent'),
    '3', 'the reseeded family counts only its own members'
  )
  assert.equal(await visibleRows(), 5, 'the still-open family keeps its 3 members, then the 2 standalone rows')
  await screenshot('families-first-light')

  // --- both locales render the group controls
  const localeKeys = await evaluate('(() => { const l = window.locales; const pick = (o) => Object.keys(o).filter(k => k.startsWith("settings.toolGroup")); return { en: pick(l.en), zh: pick(l["zh-CN"]), zhLabel: l["zh-CN"]["settings.toolGroupAria"], enLabel: l.en["settings.toolGroupAria"] }; })()')
  assert.deepEqual(localeKeys.zh, localeKeys.en, 'both locales carry the same group keys')
  assert.notEqual(localeKeys.zhLabel, localeKeys.enLabel, 'the group label is translated')
  await evaluate('localStorage.setItem("pi-app:locale","zh-CN")')
  await send('Page.navigate', { url })
  await ready()
  await pause(300)
  assert.equal(
    await evaluate('document.querySelector(\'[aria-controls="tool-group-ctx"]\').getAttribute("aria-label")'),
    'ctx 工具 · 6', 'the Chinese label renders'
  )
  assert.equal((await descriptionCard()).label, '描述', 'the description label is translated')
  assert.ok(
    (await evaluate(`document.querySelector('[data-tools-lazy-hint]').textContent`)).trim() === '部分扩展的工具会在首次使用后出现在这里。',
    'the note is translated too'
  )
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('document.documentElement.classList.add("dark")')
  await clickGroup('ctx')
  await pause(400)
  assert.equal(await groupExpanded('ctx'), 'true', 'the family expands under reduced motion too')
  assert.ok((await groupPanelHeight('ctx')) > 100, 'reduced motion skips the reveal animation, not the content')
  await screenshot('expanded-dark-zh')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')

  console.log('tool settings check ok: families fold and reveal, long descriptions fade at the clipped edge')
} finally {
  try { ws?.close() } catch {}
  child?.kill('SIGTERM')
  await server?.close()
}
