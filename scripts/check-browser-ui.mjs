/**
 * Real-Electron E2E for the embedded browser (Task 17).
 *
 * Ruling E (binding): this launches the REAL built app (`electron .` over
 * `out/main/index.mjs`) — real preload, real main BrowserService, isolated
 * `--user-data-dir` profile plus an isolated HOME, fixed `PITH_CDP_PORT` — and
 * drives it over the app's own CDP endpoint: a raw WebSocket session for the
 * shell (Runtime.evaluate drives the real UI: sidebar picker, consent card,
 * URL toolbar, find bar, device menu, annotate mode) and playwright
 * `connectOverCDP` for the webview guests (the exact primitive set
 * BrowserService wraps). The service's orchestration semantics stay
 * mock-covered by `scripts/check-browser.mjs`; this check proves the
 * cross-process/live layer and re-proves the 13 Electron-44 iron rules from
 * the design spec §11 (docs/superpowers/specs/2026-09-17-embedded-browser-design.md).
 *
 * Group 1 output carries EXACTLY 13 iron-rule entries. Each is either
 * exercised live or printed as an explicit `[source-assertion]` — never
 * silently dropped. Group 2/3 are trimmed to what runs stably; every
 * trim/substitution is named in the output's TRIMS section. Run after
 * `npm run build`: node scripts/check-browser-ui.mjs
 *
 * Documented choices:
 * - Isolation: Electron's `appData` (and therefore the app's hardcoded
 *   `setPath('userData', <appData>/pi-app')`) ignores `HOME` on macOS, and
 *   `--user-data-dir` is clobbered by that setPath — launching the app
 *   unmodified reads AND WRITES the user's real profile. So the check copies
 *   the built `out/` tree into the temp root and redirects EXACTLY ONE path
 *   constant in `out/main/index.mjs` (`join(app.getPath("appData"),
 *   "pi-app")` → the temp profile; the replacement is asserted to hit once).
 *   Everything else is the real built app; `HOME` isolates the `~/.pi` agent
 *   dir (Node's os.homedir honors it). The only file the run may place
 *   outside the temp root is a download in the real ~/Downloads, which is
 *   content-verified and deleted at cleanup.
 * - Consent: the check DRIVES the real consent card (the isolated profile
 *   seeds `browserConsent: false`) instead of pre-seeding `true` — the grant
 *   round trip is itself part of the surface under test.
 * - Locale: the check pins `pi-app:locale=en` in localStorage and reloads the
 *   shell ONCE before any guest exists (a shell-only reload; iron rule 6 only
 *   forbids reloading GUESTS), so every label/aria-label assertion is
 *   deterministic instead of host-locale dependent.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, cp, readFile, rm, writeFile, stat, unlink, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { chromium } from 'playwright-core'

const execFileAsync = promisify(execFile)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const repo = resolve('.')
// Fixed port: with it, the app's debugging endpoint IS this script's window
// into both shell and guests (browser/cdp-port.ts appends the switch at boot).
const cdpPort = Number(process.env.PITH_CHECK_CDP_PORT) || 39999
const endpoint = `http://127.0.0.1:${cdpPort}`
const MARKER = 'about:blank#pith/'

const temporary = await mkdtemp(join(tmpdir(), 'pith-browser-ui-'))
const profile = join(temporary, 'profile')
const home = join(temporary, 'home')
const project = join(temporary, 'project')

const results = { iron: [], flow: [], ui: [] }
const assertedIronRules = new Set()
const trims = []
let server, app, ws, browser1, browser2, stderr = ''
const downloadArtifacts = []

function pass(group, message) { results[group].push(message); console.log(`PASS [${group}]: ${message}`) }
function iron(rule, mode, message) {
  assert.ok(Number.isInteger(rule) && rule >= 1 && rule <= 13, `invalid iron rule: ${rule}`)
  assert.equal(assertedIronRules.has(rule), false, `duplicate iron-rule assertion: ${rule}`)
  assertedIronRules.add(rule)
  pass('iron', `${rule}. ${message}${mode === 'source' ? ' [source-assertion]' : ''}`)
}
const read = (path) => readFile(join(repo, path), 'utf8')
/** Structural (non-iron) source assertion: reported as a trim note, not an
 *  iron-rule entry. */
async function assertSource(what, files, regex) {
  const texts = await Promise.all(files.map((path) => read(path)))
  assert.match(texts.join('\n'), regex, `source assertion missing: ${what}`)
}
const ruleSourceMessage = {
  3: 'unselected agent guests stay opacity:0 + pointer-events:none at full size; display:none is reserved for unselected human pages (BrowserPageView IRON RULE block)',
  4: 'the service forbids locator.fill() — Input.insertText is silently ignored on non-visible webview guests — and types through the keyboard-event chain (pressSequentially)',
  5: 'CDP synthetic wheel is nondeterministically swallowed by guests; the service falls back to an in-page window.scrollBy',
  6: 'guest reload is re-implemented as goto(currentUrl); CDP Page.reload kills the guest and is never sent (service reloadGuest)',
  8: 'dying/hidden guests never answer captureScreenshot, so screenshots use an explicit 5s timeout plus one 8s retry',
  9: 'DOM.getNodeForLocation is unreliable across guest navigations; element lookup runs as an in-guest elementFromPoint evaluation',
  13: 'marker target page-events race explicit registration: registerPopup waits one macro task and dedupes by page identity, and closingTargetIds grants a two-poll closing grace'
}
async function sourceIron(rule, files, regex) {
  await assertSource(`iron rule ${rule}`, files, regex)
  iron(rule, 'source', ruleSourceMessage[rule])
}
async function eventually(fn, label, timeout = 20_000) {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; last = value } catch (error) { last = error }
    await pause(100)
  }
  throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : String(last)}`)
}

// Abandoned promises are part of the design here (iron rule 2's hung close,
// unclosed second playwright connections). When the app is killed at cleanup
// they reject — expected, and it must not crash the run.
process.on('unhandledRejection', (reason) => {
  console.log(`NOTE: expected unhandled rejection from an abandoned CDP promise: ${reason instanceof Error ? reason.message : String(reason)}`)
})

try {
  // ---- Fixture server: deterministic http pages on 127.0.0.1 (the navigation
  // whitelist accepts any http/https URL; a local server needs no network). ----
  const fixture = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test')
    if (url.pathname === '/download.txt') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="browser-check.txt"'
      })
      response.end('browser download fixture')
      return
    }
    const next = url.pathname === '/next'
    const popup = url.pathname === '/popup'
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><head><title>${popup ? 'Popup fixture' : next ? 'Next fixture' : 'Browser fixture'}</title></head>
      <body><main>
        <h1 style="padding:30px;font-size:24px">${popup ? 'Popup page' : next ? 'Next page' : 'Findable browser fixture'}</h1>
        ${popup ? '' : `<input aria-label="Fixture field" value="before">
        <button id="next" onclick="location.href='/next'">Next</button>
        <button id="popup" onclick="window.open('/popup','fixture-popup')">Popup</button>
        <a id="download" href="/download.txt">Download</a>
        <p>Findable text lives here too</p>
        <div style="height:2500px">Scrollable fixture</div>`}
      </main></body></html>`)
  })
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
  server = fixture
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

  // ---- Isolated profile + patched-launch app tree. `HOME` isolates ~/.pi;
  // the userData redirection is the single built-bundle patch described in
  // the header. Settings are seeded into the temp userData only.
  await mkdir(join(profile, 'Downloads'), { recursive: true })
  await mkdir(join(home, 'Downloads'), { recursive: true })
  await mkdir(project, { recursive: true })
  const appTree = join(temporary, 'out')
  await cp(join(repo, 'out'), appTree, { recursive: true })
  // app.getAppPath() is the ENTRY's directory here, so the dev icon root
  // (`resources/icons`, src/main/index.ts:26) must exist under out/main — the
  // repo launch resolves the same tree from the repo root instead.
  await cp(join(repo, 'resources'), join(appTree, 'main', 'resources'), { recursive: true })
  // The built main imports workspace packages; node resolution walks up from
  // the temp entry, so mirror the repo's node_modules there (check-terminal
  // uses the same symlink).
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const mainEntry = join(appTree, 'main', 'index.mjs')
  const original = await readFile(mainEntry, 'utf8')
  const NEEDLE = 'join(app.getPath("appData"), "pi-app")'
  assert.equal(
    original.split(NEEDLE).length - 1, 1,
    'expected exactly one userData-rooting expression in the built main entry — update this check'
  )
  await writeFile(mainEntry, original.replace(NEEDLE, JSON.stringify(profile)))
  await writeFile(join(profile, 'app-settings.json'), JSON.stringify({
    cwd: project, folders: [project], startup: 'new',
    contextFiles: false, browserConsent: false, browserAgentToolsEnabled: false
  }, null, 2))

  const env = { ...process.env, PITH_CDP_PORT: String(cdpPort), HOME: home }
  // A surrounding dev session may export this; the check must drive the built
  // renderer under out/, not an inherited Vite URL.
  delete env.ELECTRON_RENDERER_URL
  // Fixed port, so fail fast on a squatter: an Electron left over from an
  // ABORTED earlier run (script killed before its finally) still listens on
  // PITH_CDP_PORT, and every later run would then silently drive THAT stale
  // process and profile — observed live: a stale app answered /json/version
  // with consent long granted, so the fresh-profile consent assertions could
  // never pass while /json/version looked perfectly healthy. The endpoint
  // must be dead before launch.
  let squatted
  try {
    squatted = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok
  } catch { squatted = false }
  if (squatted) throw new Error(`something already answers on ${endpoint} — a stale Electron from an aborted run is squatting on the fixed CDP port; find it with lsof -nP -i :${cdpPort} (its profile carries pith-browser-ui-) or pick another port via PITH_CHECK_CDP_PORT`)
  app = spawn(electron, [mainEntry], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] })
  app.stderr.on('data', (chunk) => { stderr += chunk })

  // ---- CDP discovery: POLL both /json/version and /json/list with bounded
  // deadlines. The first live attempt reached the endpoint before the page
  // target materialized — exactly the race check-terminal.mjs's polling
  // avoids; fetching /json/list once is not enough.
  await eventually(async () => (await fetch(`${endpoint}/json/version`)).ok, 'Electron remote debugging endpoint', 30_000)
  const shellTarget = await eventually(async () => {
    const response = await fetch(`${endpoint}/json/list`)
    if (!response.ok) return null
    const targets = await response.json()
    return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null
  }, 'app page target in /json/list', 30_000)
  assert.ok(shellTarget?.webSocketDebuggerUrl, 'CDP HTTP endpoint exposes the app page target')

  // ---- Shell CDP session (raw WebSocket, check-terminal.mjs shape). ----
  ws = new WebSocket(shellTarget.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve2, reject) => {
    const id = ++sequence
    pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve2(message.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(detail.exception?.description ?? detail.text ?? JSON.stringify(detail))
    }
    return result.result?.value
  }
  const click = (selector) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.click()})()`)
  /** Real mouse press/release at viewport coordinates (the annotate capture
   *  layer needs true pointer input, not a synthetic .click()). */
  const cdpClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await pause(60)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await pause(150)
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  // ---- Pin the UI locale to English once, before any guest exists. The seed
  // must run against the REAL shell document (file:// origin): writing during
  // the initial about:blank would land in the wrong origin's localStorage.
  await eventually(() => evaluate('document.readyState === "complete" && document.body && document.body.innerText.length > 50'), 'shell renderer', 30_000)
  await eventually(async () => { await evaluate('localStorage.setItem("pi-app:locale","en")'); return true }, 'locale seed', 10_000)
  await send('Page.reload')
  await eventually(() => evaluate('document.readyState === "complete" && document.body && document.body.innerText.length > 50'), 'shell renderer after locale reload', 30_000)
  await eventually(async () => (await evaluate('document.documentElement.lang')) === 'en', 'locale pinned to en')

  // ================= Group 3 (opening): pane opens from the sidebar ==========
  // The right rail starts closed on a fresh profile; toggle it like a human,
  // then pick Browser from the pane picker.
  if (!await evaluate('Boolean(document.querySelector("[data-panel=right]"))')) {
    await click('[aria-label="Toggle sidebar"]')
  }
  await eventually(() => evaluate('Boolean(document.querySelector("[data-panel=right]"))'), 'right rail')
  await evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-panel=right] button')];const b=rows.find((e)=>[...e.querySelectorAll('span')].some((s)=>s.textContent.trim()==='Browser'));if(!b)throw Error('Browser picker row missing');b.click()})()`)
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-pane]"))'), 'browser pane')
  // The consent card is the documented entry; the grant round trip is driven
  // live below. playwright attaches FIRST — the first-status latch creates the
  // pane's initial start page right after consent, and a guest created while
  // attached is what the flow leg observes (rule 7 keeps pre-connect guests
  // invisible to a latecomer connection).
  // The pane renders NEITHER the consent card nor pages until its own async
  // browserStatus() read lands (BrowserPane: `status === null ? null :`), so
  // the card appears one IPC round trip AFTER the pane itself mounts — race
  // observed live (the check once found no card milliseconds after the pane
  // existed). Wait for it; a profile that somehow starts consented never
  // renders the card, so the wait still fails loudly on that real bug.
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-consent]"))'), 'consent card on the fresh profile (renders once its first async status lands)', 15_000)
  browser1 = await chromium.connectOverCDP(endpoint)
  const context = await eventually(() => browser1.contexts()[0], 'default context for the playwright connection')
  pass('flow', 'playwright connectOverCDP to the app’s own PITH_CDP_PORT attaches to the live shell')
  await click('[data-browser-consent] button')
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-browser-pane] [aria-label="New page"]\'))'), 'post-consent New page control')
  pass('ui', 'pane opens from the sidebar picker; the real consent card grants into the pane (consent choice: driven, not pre-seeded)')

  // ---- The first-status latch auto-creates the pane's initial start page
  // (an empty open-pages snapshot restores `[undefined]`); its marker webview
  // completes the create-page handshake.
  const guest = await eventually(
    () => context.pages().find((page) => page.url().startsWith(MARKER)) ?? null,
    'marker guest target appearing for the attached client', 20_000
  )
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-start-page]"))'), 'start page overlay')
  const stripRows = () => evaluate('document.querySelectorAll("[data-browser-tab]").length')
  // The pending row and the registered row can overlap for one state round
  // trip; wait for the strip to settle on the single real page.
  await eventually(async () => await stripRows() === 1, 'strip settles to one row', 10_000)
  pass('flow', 'create-page handshake: the first-status latch auto-creates the start page and its marker webview materializes a guest target the connected client can see (Target.createTarget is unusable — see iron 1)')

  // ---- Human navigation through the visible URL input. ----
  const setUrl = (value) => evaluate(`(()=>{
    const input=document.querySelector('[data-browser-toolbar] input');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  })()`)
  await setUrl(fixtureUrl)
  await eventually(() => guest.url().startsWith(fixtureUrl), 'guest did-navigate to the fixture URL', 15_000)
  await guest.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  // did-navigate → recents + history in the shell's localStorage.
  await eventually(() => evaluate(`(localStorage.getItem('pi-app:browser-recents')??'').includes(${JSON.stringify(fixtureUrl)})`), 'recents', 10_000)
  await eventually(() => evaluate(`(localStorage.getItem('pi-app:browser-history')??'').includes(${JSON.stringify(fixtureUrl)})`), 'history', 10_000)
  pass('flow', 'human URL-bar navigation drives the real guest; did-navigate records recents + history')

  // ================= Iron rule 1 (live) ======================================
  // Electron's CDP endpoint does not implement Target.createTarget — pages can
  // only be created through the renderer's marker handshake (proven above: the
  // guest appeared exactly when the renderer mounted the marker webview, and
  // /json/list exposed the app target this session is driving).
  let createTargetFailed = false
  try { await send('Target.createTarget', { url: 'about:blank' }) } catch { createTargetFailed = true }
  assert.equal(createTargetFailed, true, 'Target.createTarget must be rejected over the shell CDP connection')
  iron(1, 'live', 'Target.createTarget is unavailable on Electron’s CDP endpoint and /json/list exposes the app target — page creation goes through the marker handshake, proven live by the flow above')

  // ================= Agent primitives, straight against the guest ============
  // BrowserService's action semantics are mock-covered by check-browser.mjs;
  // here we prove the PLATFORM permits the exact primitives the service wraps:
  // ariaSnapshot refs, forced clicks on aria-ref locators, goto, and
  // pressSequentially (fill is forbidden — iron rule 4).
  const aiSnapshot = async (locator) => {
    const attempts = []
    try { attempts.push(await locator.ariaSnapshot()) } catch (error) { attempts.push(`(plain failed: ${error.message})`) }
    try { attempts.push(await locator.ariaSnapshot({ mode: 'ai' })) } catch (error) { attempts.push(`(ai failed: ${error.message})`) }
    return attempts.join('\n')
  }
  const snapshot = await aiSnapshot(guest.locator('body'))
  // Refs are frame-prefixed in composite targets (e.g. [ref=f1e5]).
  assert.match(snapshot, /\[ref=[a-z]?\d*e\d+\]/, 'guest aria snapshot carries Playwright aria refs')
  const nextRef = /\[ref=([a-z]?\d*e\d+)\]/.exec(await aiSnapshot(guest.locator('#next'))) ?? /\[ref=([a-z]?\d*e\d+)\]/.exec(snapshot)
  assert.ok(nextRef, 'fixture button resolves to an aria ref')
  await guest.locator(`aria-ref=${nextRef[1]}`).click({ force: true, timeout: 10_000 })
  await guest.waitForURL(/\/next$/, { timeout: 10_000 })
  await guest.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 })
  const field = guest.locator('[aria-label="Fixture field"]')
  await field.click({ force: true, timeout: 10_000 })
  await guest.keyboard.press('ControlOrMeta+A')
  await field.pressSequentially('sequential value', { timeout: 10_000 })
  assert.equal(await field.inputValue(), 'sequential value')
  pass('flow', 'guest Playwright primitives proven live: ariaSnapshot [ref=eN], aria-ref force click, goto, pressSequentially (service orchestration itself stays check-browser.mjs mock-covered)')

  // ================= Download (flow) =========================================
  await guest.locator('#download').click({ force: true, timeout: 10_000 })
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-browser-toolbar] button[aria-label="Reveal in folder"]\'))'), 'toolbar download indicator', 20_000)
  const downloadCandidates = [join(home, 'Downloads', 'browser-check.txt'), join(homedir(), 'Downloads', 'browser-check.txt')]
  const downloadPath = await eventually(async () => {
    for (const candidate of downloadCandidates) {
      try { if ((await stat(candidate)).size > 0) return candidate } catch { /* not yet */ }
    }
    return null
  }, 'downloaded fixture file', 20_000)
  assert.equal(await readFile(downloadPath, 'utf8'), 'browser download fixture')
  // A temp-home landing dies with the temp dir; only the real-home fallback
  // needs explicit (verified) cleanup.
  if (downloadPath.startsWith(homedir())) downloadArtifacts.push(downloadPath)
  pass('flow', `guest download is intercepted by the browser session: toolbar indicator appears and the file lands complete (${downloadPath})`)

  // ================= Popup routing (flow + iron 10 live) =====================
  await guest.locator('#popup').click({ force: true, timeout: 10_000 })
  await eventually(async () => await stripRows() >= 2, 'popup strip row', 15_000)
  const popupPage = await eventually(
    () => context.pages().find((page) => page.url().endsWith('/popup')) ?? null,
    'popup guest target for the attached client', 15_000
  )
  await popupPage.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  iron(10, 'live', 'guest window.open is denied as a window and routed through browser:popup: the pane strip gains a row driven by the SAME webview pipeline — no OS popup window exists (wiring setWindowOpenHandler deny corroborates)')
  pass('flow', 'popup materializes a second strip row whose target is visible to the attached client')
  // Substitution (documented): the popup's OWNER INHERITANCE needs an
  // agent-owned opener, which this account-less check cannot mint; the
  // opener→owner mapping is asserted structurally instead.
  await assertSource(
    'popup owner inheritance mapping',
    ['src/renderer/src/components/app/BrowserPane.tsx'],
    /wcIdMapRef\.current\.get\(popup\.openerWebContentsId\)\?\.owner \?\? HUMAN_OWNER/
  )
  trims.push('popup owner inheritance: source-asserted (BrowserPane wcIdMapRef opener map); an agent-owned opener is not reachable without an SDK session')

  // ================= Iron rule 2 (live): guest page.close() hangs ============
  // Bounded race, then ABANDON the promise — awaiting it forever is precisely
  // the platform failure the rule guards against.
  const rawClose = popupPage.close()
  rawClose.catch(() => { /* abandoned on purpose; see the NOTE handler */ })
  const raced = await Promise.race([rawClose.then(() => 'closed', () => 'rejected'), pause(3_500).then(() => 'hung')])
  assert.equal(raced, 'hung', 'page.close() on a webview guest must hang (it settled — the iron rule no longer holds)')
  iron(2, 'live', 'page.close() on a webview guest never returns (3.5s bounded race timed out; the promise is abandoned) — closing is renderer-driven via the strip X')

  // ================= Find bar (ui): window-level ⌘F open, Esc close ==========
  // The popup may have taken the selection; the fixture page is the find target.
  await click('[data-browser-tab] [role="tab"]')
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-toolbar]"))'), 'fixture page selected')
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',metaKey:true,cancelable:true,bubbles:true}))`)
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-find]"))'), 'find bar opens on ⌘F')
  await evaluate(`(()=>{
    const input=document.querySelector('[data-browser-find] input');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,'Findable');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await eventually(async () => /\d+ \/ \d+/.test(String(await evaluate('document.querySelector(\'[data-browser-find] [role="status"]\')?.textContent'))), 'found-in-page count', 10_000)
  await evaluate(`document.querySelector('[data-browser-find] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  await eventually(() => evaluate('!document.querySelector("[data-browser-find]")'), 'find bar closes on Esc')
  pass('ui', 'find bar: window-level ⌘F opens, found-in-page count renders, Esc closes')

  // ================= Device emulation (trim: source-asserted) ================
  // The preset Select lives inside the portaled ⋮ MorphPopover. Three drive
  // attempts were unstable: a coordinate click reads as an outside press and
  // closes the popover before the option can take it, and the listbox's
  // roving focus never engages for synthetic keyboard input. Per the binding
  // trimming rule the assertion converts to source rather than disappearing.
  await assertSource(
    'device preset table (iPhone SE 375x667)',
    ['src/renderer/src/lib/browser/device.ts'],
    /id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667/
  )
  await assertSource(
    'device pin writes the exact preset size on the webview element',
    ['src/renderer/src/components/app/BrowserPageView.tsx'],
    /const pinWidth = Math\.min\(pinned\.width, width\)[\s\S]*?wv\.style\.width = `\$\{pinWidth\}px`/
  )
  trims.push('device emulation live measurement: trimmed after three unstable drive attempts (portaled Select + popover outside-press/focus-scope); the preset table and the element-pinning code path are source-asserted instead')

  // ================= Zoom: dom-ready reapply, proven live (flow) =============
  const zoomLabel = () => evaluate('document.querySelector("[data-browser-zoom] .tabular-nums")?.textContent?.trim()')
  await eventually(async () => (await zoomLabel()) === '100%', 'zoom label reads 100%')
  await click('[data-browser-zoom] [aria-label="Zoom in"]')
  await eventually(async () => (await zoomLabel()) === '110%', 'zoom label 110%')
  const widthAt110 = await guest.evaluate(() => window.innerWidth)
  await setUrl(`${fixtureUrl}next`) // a real guest navigation → dom-ready fires
  await eventually(() => guest.url().endsWith('/next'), 'guest navigated to /next', 15_000)
  await guest.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  await eventually(async () => Math.abs((await guest.evaluate(() => window.innerWidth)) - widthAt110) <= 3, 'zoom factor surviving dom-ready', 10_000)
  assert.equal(await zoomLabel(), '110%')
  await assertSource(
    'zoom reapplies outside the one-shot handshake latch',
    ['src/renderer/src/components/app/BrowserPageView.tsx'],
    /const onDomReady = \(\) => \{[\s\S]*?applyZoom\(wv as unknown as BrowserWebviewElement, pageZoomRef\.current\)[\s\S]*?handshakeCompleteRef/
  )
  pass('flow', 'zoom survives a real guest navigation: the 110% factor is reapplied on dom-ready (guest innerWidth unchanged, toolbar label unchanged; the onDomReady latch-exclusion corroborated in source)')
  await click('[data-browser-zoom] [aria-label="Zoom out"]')
  await eventually(async () => (await zoomLabel()) === '100%', 'zoom reset to 100%')

  // ================= Theme (iron 11 live) ====================================
  // playwright's connection pins prefers-color-scheme:light on foreign targets;
  // the service must defeat it: emulateMedia(null) reset + app theme injected
  // via Emulation.setEmulatedMedia. Drive the real ThemeButton; read the
  // guest's matchMedia through playwright.
  const themeLabel = () => evaluate('document.querySelector(\'button[aria-label^="Theme:"]\')?.getAttribute("aria-label") ?? "(missing)"')
  const originalThemeLabel = await themeLabel()
  // Each click runs a view-transition reveal; clicking faster than the reveal
  // skips the previous transition (AbortError, unhandled) — space the clicks.
  const themeStep = async () => { await click('button[aria-label^="Theme:"]'); await pause(900) }
  let themeClicks = 0
  while (!(await themeLabel()).includes('Dark') && themeClicks < 4) { await themeStep(); themeClicks += 1 }
  assert.ok((await themeLabel()).includes('Dark'), 'theme cycled to Dark')
  await eventually(() => guest.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'guest prefers dark after the app theme switch', 15_000)
  themeClicks = 0
  while (!(await themeLabel()).includes('Light') && themeClicks < 3) { await themeStep(); themeClicks += 1 }
  await eventually(async () => !(await guest.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)), 'guest prefers light after switching back', 15_000)
  iron(11, 'live', 'playwright’s forced prefers-color-scheme is defeated: driving the app theme light→dark→light flips the guest’s matchMedia both ways (emulateMedia(null) reset + Emulation.setEmulatedMedia reapply)')
  themeClicks = 0
  while ((await themeLabel()) !== originalThemeLabel && themeClicks < 3) { await themeStep(); themeClicks += 1 } // restore
  await pause(600) // let the last reveal finish before further hit-testing

  // ---- Screenshot of the populated pane (best effort). ----------------------
  if (process.env.PI_BROWSER_SCREENSHOT_DIR) {
    try {
      const dir = process.env.PI_BROWSER_SCREENSHOT_DIR
      await mkdir(dir, { recursive: true })
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(dir, 'browser-pane.png'), Buffer.from(shot.data, 'base64'))
    } catch (error) {
      console.log(`NOTE: screenshot skipped: ${error.message}`)
    }
  }

  // ================= Annotate mode (ui) ======================================
  // Back on the fixture root first (the zoom leg left the guest on /next).
  await setUrl(fixtureUrl)
  await eventually(() => guest.url().startsWith(fixtureUrl) && !guest.url().endsWith('/next'), 'guest back on fixture root', 15_000)
  await click('[data-browser-toolbar] [aria-label="Annotate page"]')
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-annotate-capture]"))'), 'annotate capture layer')
  await evaluate('window.__pithAnnotations = []; window.addEventListener("pith:browser-annotation", (e) => window.__pithAnnotations.push(e.detail))')
  // Click the h1: zoom is 1.0 here, so guest (40,40) maps to the webview
  // element's origin + (40,40) (the device pin moved the origin — measured
  // live, never assumed; BrowserAnnotate does its own inverse mapping from
  // these client coordinates). Real CDP mouse input, not a synthetic event.
  {
    const point = JSON.parse(await evaluate(`JSON.stringify((()=>{
      const wv=document.querySelector('webview'); const r=wv.getBoundingClientRect();
      return {x:r.x+40,y:r.y+40};
    })())`))
    console.log('DEBUG annotate: click point =', JSON.stringify(point),
      '| viewport =', await evaluate('JSON.stringify({w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY})'),
      '| capture rect =', await evaluate('JSON.stringify(document.querySelector(\'[data-browser-annotate-capture]\')?.getBoundingClientRect())'),
      '| shell hit =', await evaluate(`(()=>{const el=document.elementFromPoint(${point.x},${point.y});return el?(el.getAttribute('data-browser-annotate-capture')!==null?'capture':el.tagName+'.'+el.className.slice(0,40)):'null'})()`),
      '| guest hit =', await guest.evaluate(() => { const el = document.elementFromPoint(40, 40); return el ? el.tagName + '|' + String(el.textContent).slice(0, 30) : 'null' }))
    // The theme view-transition reveal hides the live DOM from hit-testing
    // while it runs; wait until the capture layer is the top hit-test target.
    await eventually(() => evaluate(`document.elementFromPoint(${point.x},${point.y})?.hasAttribute('data-browser-annotate-capture')`), 'capture layer hit-testable', 15_000)
    await cdpClick(point.x, point.y)
  }
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-annotate-highlight]"))'), 'selected-element highlight', 10_000)
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-annotate-bubble]"))'), 'annotate submit bubble')
  await evaluate(`(()=>{
    const b=[...document.querySelectorAll('[data-browser-annotate-bubble] button')].find((b)=>b.textContent.trim()==='Insert');
    if(!b)throw Error('Insert button missing'); b.click();
  })()`)
  await eventually(async () => (await evaluate('window.__pithAnnotations?.length ?? 0')) === 1, 'pith:browser-annotation event observed', 10_000)
  const annotationText = String(await evaluate('window.__pithAnnotations[0]?.text ?? ""'))
  assert.match(annotationText, /Findable browser fixture/, 'annotation text carries the resolved guest element')
  pass('ui', 'annotate mode end-to-end: capture layer up, a real click resolves the guest element (in-guest elementFromPoint), highlight + bubble render, Insert fires pith:browser-annotation with the element text')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await eventually(() => evaluate('!document.querySelector("[data-browser-annotate-capture]")'), 'annotate mode exits on Esc')

  // ================= Keep-alive (ui, Ruling H) ===============================
  await evaluate('document.querySelector("[data-browser-page]")?.setAttribute("data-keepalive-probe","1")')
  await click('[data-sidebar-tabs] button[aria-label="New tab"]')
  await eventually(() => evaluate('[...document.querySelectorAll(\'[data-panel=right] button span\')].some((s)=>s.textContent.trim()===\'Context\')'), 'picker rows')
  await evaluate(`[...document.querySelectorAll('[data-panel=right] button')].find((b)=>[...b.querySelectorAll('span')].some((s)=>s.textContent.trim()==='Context')).click()`)
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-sidebar-tab="context"] [role=tab][aria-selected="true"]\'))'), 'context tab active')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-browser-page] webview"))'), true, 'webview element survives the rail switch')
  assert.equal(await evaluate('document.querySelector("[data-browser-page]")?.getAttribute("data-keepalive-probe")'), '1', 'the SAME DOM node survives (no remount)')
  pass('ui', 'keep-alive: switching rail tabs keeps the browser layer mounted — the identical webview node persists in the hidden layer')

  // ================= Link interception (ui, documented substitution) =========
  // requestBrowserOpenLink and its pending-URL queue are module-private, so
  // the click→enqueue half cannot be driven from outside the bundle; the
  // routing from markdown links is asserted structurally, and the downstream
  // reaction (the event opens/reveals the browser rail tab) is driven live
  // through the exact window event the interceptor dispatches.
  await assertSource(
    'markdown link → requestBrowserOpenLink routing',
    ['src/renderer/src/lib/markdown.tsx'],
    /getOpenLinksInBrowserPref[\s\S]*?requestBrowserOpenLink\(href\)/
  )
  trims.push('link interception: the event→tab-open reaction is live; the markdown click→requestBrowserOpenLink→queue half is source-asserted (module-private queue)')
  await evaluate('window.dispatchEvent(new CustomEvent("pith:browser-open-link"))')
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-sidebar-tab="browser"] [role=tab][aria-selected="true"]\'))'), 'browser tab re-activated by the open-link event', 10_000)
  pass('ui', 'link interception downstream: the pith:browser-open-link event re-activates the browser rail tab (Workspace listener)')

  // ================= Iron rule 7 (live): pre-connect guest invisibility ======
  // A SECOND playwright connection must NOT see the already-existing guests in
  // context.pages() (Electron 43-measured auto-attach behavior), while the
  // app's own registry still knows them via browser:seen state-only rows.
  browser2 = await chromium.connectOverCDP(endpoint)
  const context2 = await eventually(() => browser2.contexts()[0], 'second connection context')
  const visibleToLatecomer = context2.pages().some((page) => page.url().startsWith(MARKER) || page.url().startsWith(fixtureUrl))
  assert.equal(visibleToLatecomer, false, 'pre-connect guests must not surface in a late connection’s context.pages()')
  const appKnownPages = await evaluate('window.pi.browserStatus().then((s) => s.pages.length)')
  assert.ok(appKnownPages >= 1, 'the app registry still knows the guests (state-only registration)')
  iron(7, 'live', 'a second playwright connection sees NONE of the existing guests in context.pages(), while window.pi.browserStatus() reports them — the browser:seen state-only fallback is live-required, not theoretical')

  // ================= Strip close + last-page-closes-pane (ui) ================
  await click('[data-sidebar-tab="browser"] [role="tab"]')
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-sidebar-tab="browser"] [role=tab][aria-selected="true"]\'))'), 'browser tab active again')
  assert.equal(await stripRows(), 2)
  await evaluate(`(()=>{
    const rows=[...document.querySelectorAll('[data-browser-tab]')];
    const close=rows[rows.length-1].querySelector('button[aria-label="Close page"]');
    if(!close)throw Error('row close button missing'); close.click();
  })()`)
  await eventually(async () => await stripRows() === 1, 'popup row removed', 10_000)
  await click('[data-browser-tab] button[aria-label="Close page"]')
  // Last page closes → onEmpty closes the browser rail tab (the Context tab
  // from the keep-alive leg remains, so the rail itself is still open).
  await eventually(async () => !(await evaluate('Boolean(document.querySelector("[data-sidebar-tab=browser]"))')), 'browser tab closes with its last page', 10_000)
  pass('ui', 'strip close: X removes its row; closing the last page closes the pane\'s rail tab (onEmpty)')
  // And with the final tab closed the rail folds itself away entirely.
  await click('[data-sidebar-tab="context"] button[aria-label^="Close"]')
  await eventually(async () => !(await evaluate('Boolean(document.querySelector("[data-panel=right]"))')), 'rail folds after its last tab closes', 10_000)
  pass('ui', 'closing the last remaining rail tab folds the right rail')

  // ================= Iron rule 12 (live): app outlives the clients ===========
  assert.equal(app.exitCode, null, 'app process still running')
  assert.equal(await evaluate('document.readyState'), 'complete', 'shell still responsive with the playwright clients attached')
  iron(12, 'live', 'the app stays alive the whole run with external playwright clients attached and is NOT closed by them — dispose only drops references (never Browser.close()/context.close()); the clients are dropped, never closed')

  // ---- Source-only iron rules (7 of 13; regexes verified against src). ------
  await sourceIron(3, ['src/renderer/src/components/app/BrowserPageView.tsx'], /IRON RULE: an unselected agent page must never take `display: none`[\s\S]*?opacity: 0, pointerEvents: 'none'/)
  await sourceIron(4, ['src/main/browser/service.ts'], /Input\.insertText 在非可见 webview guest 上静默无效[\s\S]*?pressSequentially/)
  await sourceIron(5, ['src/main/browser/service.ts'], /Input\.dispatchMouseEvent[\s\S]*?window\.scrollBy\(dx, dy\)/)
  await sourceIron(6, ['src/main/browser/service.ts'], /禁止 page\.reload\(\)[\s\S]*?await page\.goto\(url/)
  await sourceIron(8, ['src/main/browser/service.ts'], /await shoot\(5_000\)[\s\S]*?await shoot\(8_000\)/)
  await sourceIron(9, ['src/main/browser/service.ts'], /DOM\.getNodeForLocation 在跨进程导航后的 guest 上不可靠[\s\S]*?document\.elementFromPoint/)
  await sourceIron(13, ['src/main/browser/service.ts'], /让一个宏任务过去[\s\S]*?closingTargetIds/)

  // ---- Verdicts --------------------------------------------------------------
  // Two APP-COSMETIC exception classes are filtered from the renderer
  // exception bar; both are named by source, matched as narrowly as possible,
  // and printed with counts when they occur. Everything else still fails the
  // run.
  // 1) useThemeReveal (components/motion/theme-toggle.tsx) wraps each theme
  //    click in document.startViewTransition and only attaches `.finally` to
  //    vt.finished — when a transition is SKIPPED (a click outrunning the
  //    previous reveal; Chromium aborts it) `finished` rejects with no
  //    handler. That rejection is the skipped ANIMATION, not the toggle —
  //    the theme state is already applied (iron 11's live round trip proves
  //    it). The 900ms click spacing reduces these but cannot eliminate them
  //    (reveal duration varies with load).
  // 2) Electron 44 webview teardown, one per closed page, thrown from
  //    Electron's ISOLATED world (exceptionDetails.url
  //    node:electron/js2c/isolated_bundle — not app code, hence uncatchable
  //    app-side) inside the DESIGNED close path: service.ts closePage removes
  //    the page from the registry, the renderer unmounts <webview>, and the
  //    unmount itself destroys the guest (page.close() hangs — iron rule 2);
  //    dissociating the already-dying guest then rejects asynchronously with
  //    "Invalid guestInstanceId" via React's unmount microtask. Timing-
  //    dependent (not every run produces it), but every real close can. The
  //    close behavior itself is asserted green by the strip-close leg.
  const cosmeticException = (detail) => {
    const description = String(detail?.exception?.description ?? '')
    if ((detail?.exception?.className === 'DOMException' || detail?.exception?.name === 'AbortError') && /^AbortError: Transition was skipped/.test(description)) return 'useThemeReveal view-transition skip (AbortError: Transition was skipped)'
    if (detail?.url === 'node:electron/js2c/isolated_bundle' && detail?.exception?.className === 'Error' && /^Error: Invalid guestInstanceId: \d+/.test(description)) return 'Electron webview teardown on the designed close path (Invalid guestInstanceId)'
    return null
  }
  const cosmeticKinds = new Map()
  for (const detail of exceptions) {
    const kind = cosmeticException(detail)
    if (kind) cosmeticKinds.set(kind, (cosmeticKinds.get(kind) ?? 0) + 1)
  }
  for (const [kind, count] of cosmeticKinds) console.log(`NOTE: ${count} cosmetic renderer exception(s) filtered from the bar: ${kind}`)
  const realExceptions = exceptions.filter((detail) => !cosmeticException(detail))
  assert.deepEqual(realExceptions, [], `renderer threw exceptions: ${JSON.stringify(realExceptions).slice(0, 2000)}`)
  assert.equal(assertedIronRules.size, 13, `expected exactly 13 iron-rule entries, got ${assertedIronRules.size}: ${[...assertedIronRules].join(',')}`)
  const liveRules = [...assertedIronRules].filter((rule) => results.iron.some((line) => line.startsWith(`${rule}.`) && !line.includes('[source-assertion]')))
  console.log(`SUMMARY group1 iron: ${results.iron.length}/13 re-proven (${liveRules.length} live [${liveRules.join(',')}], ${13 - liveRules.length} explicit [source-assertion]; none silently dropped)`)
  console.log(`SUMMARY group2 flow: ${results.flow.length} assertions green (attach, marker handshake, human nav + recents/history, guest Playwright primitives, download interception, popup routing, zoom dom-ready reapply)`)
  console.log(`SUMMARY group3 ui: ${results.ui.length} assertions green (sidebar + consent entry, find bar, device preset pin, annotate end-to-end, keep-alive, link-event reaction, strip close/fold, theme round-trip)`)
  console.log('TRIMS/SUBSTITUTIONS:')
  for (const trim of trims) console.log(`  - ${trim}`)
  console.log('PASS check-browser-ui')
} catch (error) {
  console.error('FAIL check-browser-ui:', error?.stack ?? error)
  if (stderr) console.error('--- app stderr (tail) ---\n' + stderr.split('\n').slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  // Never call Playwright's Browser.close(): on a connectOverCDP browser it
  // sends CDP Browser.close and can terminate the app (iron rule 12). Both
  // clients are simply dropped; killing the spawned process closes the sockets.
  try { ws?.close() } catch { /* already gone */ }
  browser1 = undefined
  browser2 = undefined
  if (app && app.exitCode === null) {
    const exited = once(app, 'exit')
    app.kill('SIGTERM')
    await Promise.race([exited, pause(5_000)])
    if (app.exitCode === null) {
      const forced = once(app, 'exit')
      app.kill('SIGKILL')
      await Promise.race([forced, pause(3_000)])
    }
  }
  // No orphan Electron from THIS run: nothing carrying the temp root survives.
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    const orphans = stdout.split('\n').filter((line) => line.includes(temporary))
    assert.deepEqual(orphans, [], `orphan processes from this check: ${orphans.join(' | ')}`)
  } catch (error) {
    console.error('orphan check failed:', error.message)
    process.exitCode = 1
  }
  // A download into the REAL user Downloads dir is this run's only footprint
  // outside the temp root; remove exactly our verified file.
  for (const artifact of downloadArtifacts) {
    try {
      if (await readFile(artifact, 'utf8') === 'browser download fixture') await unlink(artifact)
    } catch { /* best effort */ }
  }
  await new Promise((r) => (server ? server.close(r) : r()))
  await rm(temporary, { recursive: true, force: true })
}
