/**
 * Real-Electron E2E for the embedded browser.
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
 * docs/architecture/embedded-browser.md.
 * A source-served StrictMode fixture first checks async pane mounting with a
 * mocked bridge; real guest registration is exercised by the built app below.
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
 *   the built `out/` tree into the temp root and redirects the userData path
 *   in `out/main/index.mjs` (`join(app.getPath("appData"), "pi-app")` → the
 *   temp profile; the replacement is asserted to hit once). The fixture also
 *   sets Electron's native downloads path inside that same temporary tree.
 *   Everything else is the real built app; `HOME` isolates the `~/.pi` agent
 *   dir (Node's os.homedir honors it). Download bytes and completion events
 *   still pass through the production browser-session handler.
 * - Rejection policy: unhandled rejections are allowed ONLY when they match
 *   playwright's connection-teardown family (the deliberately abandoned
 *   guest close and the dropped clients at app kill) — counted NOTEs. Any
 *   other unhandled rejection fails the run (exit 1).
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
import { mkdtemp, mkdir, cp, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { chromium } from 'playwright-core'
import { LIBRARY_WEB_SNAPSHOT_SCHEMA } from '../src/shared/library.ts'
import { checkBrowserLifecycle } from './lib/check-browser-lifecycle.mjs'

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
const downloads = join(temporary, 'downloads')

const results = { iron: [], flow: [], ui: [] }
const assertedIronRules = new Set()
const trims = []
let server, app, ws, browser1, browser2, stderr = ''
/** Set immediately before the app is killed. The unhandled-rejection allowlist
 *  below only applies from here on: a rejection BEFORE teardown begins is never
 *  benign (a mid-run browser.close()/context.close() would otherwise be counted
 *  as a NOTE inside a green run — see the iron-12 section). */
let teardownStarted = false

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
  4: 'the service forbids locator.fill() — Input.insertText is silently ignored on non-visible webview guests — and types through the keyboard-event chain (pressSequentially)',
  5: 'CDP synthetic wheel is nondeterministically swallowed by guests; the service falls back to an in-page window.scrollBy',
  6: 'guest reload is re-implemented as goto(currentUrl); CDP Page.reload kills the guest and is never sent (service reloadGuest)',
  8: 'dying/hidden guests never answer captureScreenshot, so screenshots use an explicit 5s timeout plus one 8s retry',
  9: 'DOM.getNodeForLocation is unreliable across guest navigations — so element lookup runs as an in-guest elementFromPoint evaluation, and the ONE exception (the ax hit-test, which must see inside closed shadow roots) is confined to cdpNodeAt and used only to verify, never to locate',
  13: 'non-marker targets (real popup windows, the shell window, unnamed external targets) are never registered as pages — the page-event path only skips them and closesTargetIds still grants a two-poll closing grace to marker targets'
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

// Abandoned promises are part of the design here (iron rule 2's deliberately
// hung page.close(), the two connectOverCDP clients dropped un-closed at
// cleanup). When the app is killed in `finally` they reject with playwright's
// connection-teardown family — expected, and each match below is COUNTED and
// printed as a NOTE in `finally` (rejections from the app kill land during
// that teardown). ANY OTHER unhandled rejection is a harness defect (a
// floating promise in helper code): it prints a FAIL line and sets the exit
// code immediately, so it can never end a green run. The allowlist matches
// playwright-core's exact teardown messages, prefix-gated; an upstream
// rewording resurfaces as a failure, never as a silent pass.
const benignRejectionKind = (reason) => {
  // Teardown-scoped allowlist: before the app is killed, NO rejection is benign.
  if (!teardownStarted) return null
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/^Target page, context or browser has been closed/.test(message)) return 'playwright: target/context/browser closed (dropped client / abandoned guest close at app kill)'
  if (/^Target browser or context has been closed/.test(message)) return 'playwright: browser or context closed (dropped client at app kill)'
  if (/^Browser has been closed/.test(message)) return 'playwright: browser closed (dropped client at app kill)'
  if (/^Target closed/.test(message)) return 'playwright: target closed (protocol channel died at app kill)'
  if (/^Session closed/.test(message)) return 'playwright: session closed (CDP session died at app kill)'
  if (/^Protocol error /.test(message) && / (Target closed|Browser[^"]*closed|Session closed|Connection closed)/.test(message)) return 'playwright: protocol error against the dead connection (app kill)'
  return null
}
const benignRejectionKinds = new Map()
let unexpectedRejections = 0
process.on('unhandledRejection', (reason) => {
  const kind = benignRejectionKind(reason)
  if (kind) {
    benignRejectionKinds.set(kind, (benignRejectionKinds.get(kind) ?? 0) + 1)
    return
  }
  unexpectedRejections += 1
  console.error(`FAIL unhandled rejection (not in the abandoned-promise allowlist): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  process.exitCode = 1
})

try {
  await checkBrowserLifecycle(repo)
  pass('ui', 'development StrictMode opens an empty browser with one about:blank tab, reconstructs saved tabs, and ignores unmounted restore receipts')
  // ---- Fixture server: deterministic http pages on 127.0.0.1 (the navigation
  // whitelist accepts any http/https URL; a local server needs no network). ----
  // Unique download filename, verified through the real download handler.
  const downloadName = `browser-check-${process.pid}-${Date.now()}.txt`
  // keep-alive leg state: the heartbeat page pings /tick every 350ms; the
  // server counts pings and tracks the highest n — continuity of n across a
  // rail fold proves the page INSTANCE survived (a reload would restart n at 1).
  let tickCount = 0
  let tickLastN = 0
  const pendingLoadResources = new Set()
  const fixture = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test')
    if (url.pathname === '/loading-redirect') {
      response.writeHead(302, { Location: '/loading', 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (url.pathname === '/loading') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      response.end('<!doctype html><html><head><title>Loading fixture</title></head><body><h1>Loading fixture</h1><img src="/loading-resource" alt="Pending resource"></body></html>')
      return
    }
    if (url.pathname === '/loading-resource') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
      pendingLoadResources.add(response)
      const deadline = setTimeout(() => response.end(), 20_000)
      response.on('close', () => { clearTimeout(deadline); pendingLoadResources.delete(response) })
      return
    }
    if (url.pathname === '/tick') {
      tickCount += 1
      tickLastN = Math.max(tickLastN, Number(url.searchParams.get('n') ?? 0) || 0)
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('ok')
      return
    }
    if (url.pathname === '/tick-count') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ count: tickCount, lastN: tickLastN }))
      return
    }
    if (url.pathname === '/keepalive') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><html><head><title>Keep-alive heartbeat</title></head><body><main>
        <h1 style="padding:30px;font-size:24px">Keep-alive heartbeat page</h1>
      </main><script>
        window.__n = 0
        setInterval(() => { window.__n += 1; fetch('/tick?n=' + window.__n) }, 350)
      </script></body></html>`)
      return
    }
    if (url.pathname === '/download.txt') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': `attachment; filename="${downloadName}"`
      })
      response.end('browser download fixture')
      return
    }
    const next = url.pathname === '/next'
    const popup = url.pathname === '/popup'
    // A WINDOW-shaped popup target: window.open WITH features (Chromium reads that
    // as a real window, not a tab — the disposition the app must honor).
    if (url.pathname === '/popup-window') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><html><head><title>Window popup fixture</title></head><body><h1>Popup window</h1></body></html>')
      return
    }
    // A deliberately large document: the small fixture cannot show whether the
    // find STEP cost scales with the page (the lag felt on a real page), so the
    // check measures the same step on ~3000 matches as well.
    if (url.pathname === '/big') {
      const rows = []
      for (let i = 0; i < 3000; i += 1) rows.push(`<p>Findable row ${i} filler filler filler filler filler</p>`)
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><html><head><title>Big fixture</title></head><body><main>${rows.join('')}</main></body></html>`)
      return
    }
    // Matches INSIDE a subframe: Chromium focuses the frame that holds the
    // matched text, so this is the shape that can steal focus from the find
    // field after the first step (the field then gets no further keydowns).
    if (url.pathname === '/frame') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><html><head><title>Frame fixture</title></head><body><main>
        <iframe srcdoc="<p>Findable in a subframe one</p><p>Findable in a subframe two</p><p>Findable in a subframe three</p>"></iframe>
      </main></body></html>`)
      return
    }
    // The shape the `ax` target exists for: a control inside a CLOSED shadow root.
    // Playwright's selectors and its aria snapshot both stop at the closed boundary, so
    // the only ways in are the native AX tree and CDP — which the live leg below proves.
    if (url.pathname === '/shadow') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><html><head><title>Shadow fixture</title></head><body><main>
        <p>The button lives in a closed shadow root; the page records whether it was clicked.</p>
        <div id="closedHost"></div>
        <span id="closed-effect">pending</span>
      </main><script>
        const root = document.getElementById('closedHost').attachShadow({ mode: 'closed' })
        root.innerHTML = '<button id="closedDeep">closedDeep</button>'
        root.querySelector('button').addEventListener('click', () => {
          document.getElementById('closed-effect').textContent = 'clicked'
        })
      </script></body></html>`)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><head><title>${popup ? 'Popup fixture' : next ? 'Next fixture' : 'Browser fixture'}</title></head>
      <body><main>
        <h1 style="padding:30px;font-size:24px">${popup ? 'Popup page' : next ? 'Next page' : 'Findable browser fixture'}</h1>
        ${popup ? '' : `<input aria-label="Fixture field" value="before">
        <button id="next" onclick="location.href='/next'">Next</button>
        <button id="popup" onclick="window.open('/popup','fixture-popup')">Popup</button>
        <button id="popup-window" onclick="window.open('/popup-window','fixture-window','width=420,height=360,left=0,top=0')">Popup window</button>
        <a id="download" href="/download.txt">Download</a>
        <input type="file" id="upload" aria-label="Fixture upload" onchange="document.getElementById('upload-name').textContent=this.files[0]?.name??'(none)'">
        <span id="upload-name">(none)</span>
        <input type="file" id="hidden-upload" style="display:none" onchange="document.getElementById('hidden-upload-name').textContent=this.files[0]?.name??'(none)'">
        <button id="upload-trigger" onclick="document.getElementById('hidden-upload').click()">Choose hidden</button>
        <span id="hidden-upload-name">(none)</span>
        <p>Findable text lives here too</p>
        <p>Findable again, so Enter has somewhere to go</p>
        <div style="height:2500px">Scrollable fixture</div>`}
      </main></body></html>`)
  })
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
  server = fixture
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

  // ---- Isolated profile + patched-launch app tree. `HOME` isolates ~/.pi;
  // the userData/downloads redirection is the fixture-only built-bundle patch
  // described in the header. Settings are seeded into the temp userData only.
  await mkdir(profile, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(downloads)
  await mkdir(project, { recursive: true })
  const appTree = join(temporary, 'out')
  // Fail HERE, loudly, if the build is missing: without the renderer entry the
  // app boots to ERR_FILE_NOT_FOUND and the check dies 30s later on "timed out
  // waiting for shell renderer", which reads like a product bug (and `out/` gets
  // wiped by a dev watcher rebuilding this tree).
  await stat(join(repo, 'out', 'renderer', 'index.html')).catch(() => {
    throw new Error('out/renderer/index.html is missing — run `npm run build` immediately before this check')
  })
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
  const NEEDLE = 'app.setPath("userData", join(app.getPath("appData"), "pi-app"));'
  assert.equal(
    original.split(NEEDLE).length - 1, 1,
    'expected exactly one userData-rooting expression in the built main entry — update this check'
  )
  await writeFile(mainEntry, original.replace(NEEDLE, `app.setPath("userData", ${JSON.stringify(profile)});\napp.setPath("downloads", ${JSON.stringify(downloads)});`))
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
  // Watch actual overlay insertions before any guest exists, including the
  // initial about:blank marker handshake; a final hidden-state assertion
  // alone would miss a brief flash on a blank page.
  await evaluate(`(() => {
    window.__browserProgressShows = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        window.__browserProgressShows += Number(node.matches('[data-browser-loading-progress]'))
          + node.querySelectorAll('[data-browser-loading-progress]').length;
      }
    }).observe(document.body, { childList: true, subtree: true });
  })()`)
  const progressShows = () => evaluate('window.__browserProgressShows')
  const resetProgressShows = () => evaluate('window.__browserProgressShows = 0')
  // Documented substitution — must appear in the run's TRIMS section: the en
  // pin is a shell-only reload BEFORE any guest exists (rule 6 forbids
  // reloading GUESTS, never the shell), so label assertions stay
  // host-locale-independent.
  trims.push('locale: pinned to en via localStorage + ONE shell-only reload before any guest exists (rule 6 forbids guest reloads, not shell reloads); label/aria-label assertions run against the pinned en UI')

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
  await guest.waitForLoadState('load')
  assert.equal(await progressShows(), 0, 'creating an about:blank marker never flashes a progress bar')
  await click('[data-browser-toolbar] button[aria-label="Reload"]')
  await guest.waitForLoadState('load')
  await pause(350)
  assert.equal(await progressShows(), 0, 'reloading the blank start page never flashes a progress bar')
  pass('flow', 'create-page handshake: the first-status latch auto-creates the start page and its marker webview materializes a guest target the connected client can see (Target.createTarget is unusable — see iron 1)')

  // ================= Iron rule 3 (LIVE): the three-state visibility rule =====
  // The rule's judged site is the renderer, and both directions are driven live
  // here: an unselected HUMAN page (created through the real IPC; the start page
  // keeps the selection, so it lands unselected) may take display:none, while an
  // unselected AGENT page (registered through the real browser:seen IPC with an
  // agent owner) must stay hosted at full size with opacity:0 + pointer-events:
  // none. A display:none agent guest times out clicks, never answers a
  // screenshot and silently swallows text input.
  const humanId = await evaluate('window.pi.browserCreatePage().then((meta) => meta.id)')
  await eventually(() => evaluate(`Boolean(document.querySelector('[data-browser-page=${JSON.stringify(humanId)}]'))`), 'unselected human page row', 15_000)
  const agentId = 'p-iron3-agent'
  await evaluate(`window.pi.browserSeen({ id: ${JSON.stringify(agentId)}, owner: 'agent:check', url: 'https://example.test/iron3-agent' })`)
  await eventually(() => evaluate(`Boolean(document.querySelector('[data-browser-page=${JSON.stringify(agentId)}]'))`), 'agent-owned page row', 15_000)
  const visibility = await evaluate(`(() => {
    const read = (id) => {
      const el = document.querySelector('[data-browser-page="' + id + '"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents, width: el.getBoundingClientRect().width };
    };
    return { human: read(${JSON.stringify(humanId)}), agent: read(${JSON.stringify(agentId)}) };
  })()`)
  assert.ok(visibility.human && visibility.agent, 'both rows render a page container')
  assert.equal(visibility.human.display, 'none', 'unselected HUMAN page takes display:none')
  assert.notEqual(visibility.agent.display, 'none', 'unselected AGENT page must never take display:none')
  assert.equal(visibility.agent.opacity, '0', 'unselected agent page is hidden with opacity')
  assert.equal(visibility.agent.pointerEvents, 'none', 'unselected agent page is pointer-transparent')
  assert.ok(visibility.agent.width > 0, `unselected agent page stays hosted at full size (width ${visibility.agent.width})`)
  // The source half pins the guard itself, so flipping it is caught even
  // without a live agent row: the predicate must stay owner-based AND the
  // hidden class must stay conditional on it.
  const pageViewNoComments = (await read('src/renderer/src/components/app/BrowserPageView.tsx'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.match(pageViewNoComments, /backgroundAgent = !selected && page\.owner !== HUMAN_OWNER/, 'the visibility predicate is owner-based, not a constant')
  assert.match(pageViewNoComments, /!selected && !backgroundAgent && 'hidden'/, "display:none is applied only when the page is NOT a background agent page")
  assert.doesNotMatch(pageViewNoComments, /display: 'none'/, 'no inline display:none escapes the guard')
  // Both rows go away again: later legs count strip rows.
  await evaluate(`window.pi.browserClosePage(${JSON.stringify(agentId)})`)
  await evaluate(`window.pi.browserClosePage(${JSON.stringify(humanId)})`)
  await eventually(async () => await stripRows() === 1, 'strip back to the single start page', 15_000)
  iron(3, 'live', 'unselected agent guests stay opacity:0 + pointer-events:none at full size while an unselected human page takes display:none — driven live through browserCreatePage + browser:seen, with the owner-based guard and its conditional hidden pinned as the regression half')

  // ---- Human navigation through the visible URL input. ----
  const submitBrowserInput = (selector, value) => evaluate(`(()=>{
    const input=document.querySelector(${JSON.stringify(selector)});
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  })()`)
  const setUrl = (value) => submitBrowserInput('[data-browser-toolbar] input', value)
  // The address bar's REST state trims the scheme/www (the focused field
  // shows the full url) — mirror the app's trim for value comparisons.
  const pretty = (u) => u.replace(/^https?:\/\/(?:www\.)?/i, '')

  // Search stays offline: fulfill only search navigations on this real guest.
  const searchRoute = /^https:\/\/(?:www\.google\.com\/search|www\.bing\.com\/search|duckduckgo\.com\/|www\.baidu\.com\/s)\?/
  await guest.route(searchRoute, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Search fixture</title><h1>Search fixture</h1>' }))
  assert.equal(await evaluate('window.pi.appInfo().then(info => info.browserSearchEngine)'), 'google', 'missing saved preference defaults to Google')
  const startQuery = '内嵌浏览器 C++ & a=b'
  await submitBrowserInput('[data-browser-start-page] input', startQuery)
  await eventually(() => guest.url().startsWith('https://www.google.com/search?'), 'start page searches with Google')
  assert.equal(new URL(guest.url()).searchParams.get('q'), startQuery)
  await guest.waitForLoadState('load')
  const query = 'site:example.com react'
  for (const [engine, label, origin, parameter] of [
    ['bing', 'Bing', 'https://www.bing.com', 'q'],
    ['duckduckgo', 'DuckDuckGo', 'https://duckduckgo.com', 'q'],
    ['baidu', 'Baidu', 'https://www.baidu.com', 'wd'],
    ['google', 'Google', 'https://www.google.com', 'q'],
  ]) {
    await click('button[aria-label="Settings"]')
    await eventually(() => evaluate('Boolean(document.querySelector(".z-40 [role=tab]"))'), 'settings open for search preference')
    await evaluate(`[...document.querySelectorAll('.z-40 [role=tab]')].find(el => el.textContent.trim() === 'Browser').click()`)
    await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-search-engine] button"))'), 'search provider picker')
    await click('[data-browser-search-engine] button')
    await eventually(() => evaluate(`[...document.querySelectorAll('[role=option]')].some(el => el.textContent.trim() === ${JSON.stringify(label)})`), 'search provider options')
    await evaluate(`[...document.querySelectorAll('[role=option]')].find(el => el.textContent.trim() === ${JSON.stringify(label)}).click()`)
    await eventually(() => evaluate(`window.pi.appInfo().then(info => info.browserSearchEngine === ${JSON.stringify(engine)})`), 'search preference persisted through production IPC')
    assert.equal(JSON.parse(await readFile(join(profile, 'app-settings.json'), 'utf8')).browserSearchEngine, engine)
    await click('button[aria-label="Back to chat"]')
    await eventually(() => evaluate('!document.querySelector(".z-40")'), 'settings closed after search choice')
    await setUrl(query)
    await eventually(() => guest.url().startsWith(`${origin}/`) && new URL(guest.url()).searchParams.get(parameter) === query, `${engine} search from the address bar`)
    await guest.waitForLoadState('load')
    await eventually(() => evaluate(`document.querySelector('[data-browser-toolbar] input').value.startsWith(${JSON.stringify(pretty(origin))})`), 'address bar releases the query draft to the committed URL')
  }
  assert.equal(await evaluate(`window.pi.setBrowserSearchEngine('invalid').then(() => false, () => true)`), true, 'invalid IPC preferences are rejected')
  assert.equal(await evaluate('window.pi.appInfo().then(info => info.browserSearchEngine)'), 'google', 'rejected preference leaves the selection intact')
  await guest.unroute(searchRoute)
  pass('ui', 'start-page and address-bar searches encode queries; all four providers save through Settings and take effect in the mounted guest')

  await setUrl(fixtureUrl)
  await eventually(() => guest.url().startsWith(fixtureUrl), 'guest did-navigate to the fixture URL', 15_000)
  await guest.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  // did-navigate → recents + history in the shell's localStorage.
  await eventually(() => evaluate(`(localStorage.getItem('pi-app:browser-recents')??'').includes(${JSON.stringify(fixtureUrl)})`), 'recents', 10_000)
  await eventually(() => evaluate(`(localStorage.getItem('pi-app:browser-history')??'').includes(${JSON.stringify(fixtureUrl)})`), 'history', 10_000)
  pass('flow', 'human URL-bar navigation drives the real guest; did-navigate records recents + history')

  // Hold a real subresource across DOM readiness to prove progress cannot
  // finish early, and compare layout before/during the absolute overlay.
  const pageLayout = () => evaluate(`(() => {
    const toolbar = document.querySelector('[data-browser-toolbar]');
    const guest = toolbar.closest('[data-browser-page]').querySelector('webview');
    const rect = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] };
    return { toolbar: rect(toolbar), guest: rect(guest) };
  })()`)
  const progressValue = () => evaluate(`document.querySelector('[data-browser-loading-progress] [role=progressbar]')?.getAttribute('aria-valuenow') ?? null`)
  const releaseLoading = () => { for (const response of pendingLoadResources) response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') }
  await eventually(async () => (await progressValue()) == null, 'previous navigation progress clears')
  await resetProgressShows()
  const layoutBeforeLoad = await pageLayout()
  await setUrl(`${fixtureUrl}loading`)
  await eventually(() => pendingLoadResources.size > 0, 'held image request begins')
  const initialProgress = await eventually(async () => Number(await progressValue()) || false, 'progress visible during navigation')
  assert(initialProgress < 100, 'an unfinished resource keeps progress below completion')
  await eventually(async () => Number(await progressValue()) > initialProgress, 'estimated progress advances while waiting')
  assert.deepEqual(await pageLayout(), layoutBeforeLoad, 'the loading bar never moves the toolbar or webview')
  const progressPlacement = await evaluate(`(() => {
    const bar = document.querySelector('[data-browser-loading-progress]');
    const guest = bar.parentElement.querySelector('webview');
    return { top: bar.getBoundingClientRect().top, pageTop: guest.getBoundingClientRect().top, pointerEvents: getComputedStyle(bar).pointerEvents };
  })()`)
  assert.equal(progressPlacement.top, progressPlacement.pageTop, 'bar overlays the top of the page')
  assert.equal(progressPlacement.pointerEvents, 'none', 'bar cannot intercept page input')
  releaseLoading()
  await eventually(async () => (await progressValue()) == null, 'progress clears when all resources finish')
  assert.equal(await progressShows(), 1, 'one main-document navigation shows progress once')

  // Chromium emits fresh spinner events for a dynamically added iframe
  // after the main document has finished. These must not restart its bar.
  await evaluate(`(() => {
    window.__browserLoadingEvents = [];
    const wv = document.querySelector('[data-browser-toolbar]').closest('[data-browser-page]').querySelector('webview');
    for (const type of ['did-start-loading', 'did-stop-loading', 'did-start-navigation']) {
      wv.addEventListener(type, event => window.__browserLoadingEvents.push({ type, isMainFrame: event.isMainFrame, isInPlace: event.isInPlace }));
    }
  })()`)
  await guest.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'late-loading-frame'
    frame.src = '/loading?iframe'
    document.body.append(frame)
  })
  await eventually(() => pendingLoadResources.size > 0, 'late iframe holds a real resource')
  await eventually(() => evaluate(`window.__browserLoadingEvents.some(event => event.type === 'did-start-loading') && window.__browserLoadingEvents.some(event => event.type === 'did-start-navigation' && event.isMainFrame === false)`), 'late iframe emits another Chromium loading cycle')
  assert.equal(await progressValue(), null, 'subframe loading cannot reopen completed main-document progress')
  assert.equal(await progressShows(), 1, 'late iframe never inserts a second progress bar')
  releaseLoading()
  await eventually(() => guest.evaluate(() => document.querySelector('#late-loading-frame').contentDocument.readyState === 'complete'), 'late iframe completes')

  await resetProgressShows()
  await click('[data-browser-toolbar] button[aria-label="Reload"]')
  await eventually(() => pendingLoadResources.size > 0, 'reload starts a fresh resource request')
  await eventually(async () => Number(await progressValue()) > 0 && Number(await progressValue()) < 100, 'progress returns for a real toolbar reload')
  releaseLoading()
  await eventually(async () => (await progressValue()) == null, 'reload progress clears')
  assert.equal(await progressShows(), 1, 'a real reload shows one fresh progress bar')

  await resetProgressShows()
  await setUrl(`${fixtureUrl}loading-redirect`)
  await eventually(() => pendingLoadResources.size > 0, 'redirect destination holds a real resource')
  await eventually(async () => Number(await progressValue()) > 0 && Number(await progressValue()) < 100, 'redirect keeps progress active')
  releaseLoading()
  await eventually(async () => (await progressValue()) == null, 'redirect progress clears')
  assert.equal(await progressShows(), 1, 'a server redirect shares one main-document progress bar')
  await guest.evaluate(() => { location.hash = 'in-page-navigation' })
  await eventually(() => evaluate(`window.__browserLoadingEvents.some(event => event.type === 'did-start-navigation' && event.isMainFrame === true && event.isInPlace === true)`), 'same-document navigation reaches the webview')
  assert.equal(await progressShows(), 1, 'hash navigation never starts new progress')

  await resetProgressShows()
  await setUrl('about:blank')
  await eventually(() => guest.url() === 'about:blank', 'explicit navigation to the blank start page')
  await guest.waitForLoadState('load')
  await pause(350)
  assert.equal(await progressValue(), null, 'about:blank has no progress')
  assert.equal(await progressShows(), 0, 'navigating to about:blank never flashes progress')
  await guest.route(`${fixtureUrl}load-failure`, route => route.abort('failed'))
  const loadFailure = guest.waitForEvent('requestfailed', { predicate: request => request.url() === `${fixtureUrl}load-failure`, timeout: 10_000 })
  await setUrl(`${fixtureUrl}load-failure`)
  await loadFailure
  await eventually(async () => (await progressValue()) == null && await evaluate(`!document.querySelector('[data-browser-toolbar]').closest('[data-browser-page]').querySelector('webview').isLoading()`), 'failed navigation leaves no stuck progress')
  await guest.unroute(`${fixtureUrl}load-failure`)
  await setUrl(fixtureUrl)
  await eventually(() => guest.url() === fixtureUrl, 'guest returns to the fixture after progress checks')
  await guest.waitForLoadState('load')
  pass('ui', 'blank pages never show progress; each main-document navigation, redirect and reload shows one advancing page-top bar without layout shifts; late iframes and hash changes never restart it; completion and failure clear it')

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

  // ================= File upload (flow) ======================================
  // browser_upload rests on two platform primitives; both are proven HERE, on the
  // real webview guest (the service orchestration itself stays mock-covered):
  //   1. DOM.setFileInputFiles reaches the guest — including a display:none input,
  //      which is the common styled-widget shape the direct path exists for;
  //   2. subscribing to `filechooser` makes Playwright turn on CDP interception,
  //      so a clicked trigger hands US the chooser instead of opening the OS panel.
  const uploadName = `browser-upload-${process.pid}.png`
  const uploadPath = join(temporary, uploadName)
  await writeFile(uploadPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await guest.locator('#upload').setInputFiles(uploadPath, { timeout: 10_000 })
  await eventually(async () => (await guest.locator('#upload-name').textContent()) === uploadName, 'guest received the file through setInputFiles', 10_000)
  const held = await guest.locator('#upload').evaluate((el) => el.files?.[0]?.name ?? '')
  assert.equal(held, uploadName, 'the guest file input really holds the uploaded bytes (its own file list says so)')
  const [chooser] = await Promise.all([
    guest.waitForEvent('filechooser', { timeout: 10_000 }),
    guest.locator('#upload-trigger').click({ force: true, timeout: 10_000 })
  ])
  await chooser.setFiles(uploadPath)
  await eventually(async () => (await guest.locator('#hidden-upload-name').textContent()) === uploadName, 'trigger path handed the file to the hidden input', 10_000)
  pass('flow', `file upload on the real guest: setInputFiles fills a file input and a clicked trigger delivers the filechooser to us (interception on, no OS panel) — asserted through the page's own file list (${uploadName})`)

  // ================= Closed shadow root (flow) ===============================
  // The `ax` target rests on three platform primitives, all proven HERE on the real
  // guest (the service orchestration stays mock-covered by check-browser.mjs):
  //   1. the AX tree names a control that lives in a CLOSED shadow root, while
  //      Playwright's selector AND its aria snapshot both stop at that boundary
  //      (both asserted below, so the premise cannot rot silently);
  //   2. DOM.getBoxModel returns that node's box although no selector reaches it;
  //   3. the CDP hit-test maps the box centre back to that very node, and a real
  //      Input.dispatchMouseEvent click reaches it — asserted through the page's
  //      own effect (the button rewrites the page's text).
  await setUrl(`${fixtureUrl}shadow`)
  await eventually(() => guest.url().startsWith(`${fixtureUrl}shadow`), 'shadow fixture page loaded', 20_000)
  assert.equal(await guest.locator('#closedDeep').count(), 0, 'premise: no selector reaches into a closed shadow root')
  assert.doesNotMatch(await aiSnapshot(guest.locator('body')), /closedDeep/, 'premise: the aria snapshot stops at the closed boundary too')
  const guestCdp = await guest.context().newCDPSession(guest)
  try {
    await guestCdp.send('DOM.enable')
    await guestCdp.send('Accessibility.enable')
    const axTree = await guestCdp.send('Accessibility.getFullAXTree')
    const axButton = (axTree.nodes ?? []).find((node) => node.role?.value === 'button' && node.name?.value === 'closedDeep')
    assert.ok(axButton?.backendDOMNodeId, 'the native AX tree exposes the closed-shadow button by role + name')
    const model = await guestCdp.send('DOM.getBoxModel', { backendNodeId: axButton.backendDOMNodeId })
    const quad = model.model.border
    const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4)
    const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4)
    const hit = await guestCdp.send('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true })
    assert.equal(hit.backendNodeId, axButton.backendDOMNodeId, 'the CDP hit-test resolves the box centre to that very node (integer coordinates required)')
    for (const type of ['mousePressed', 'mouseReleased']) {
      await guestCdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    await eventually(
      async () => (await guest.evaluate(() => document.getElementById('closed-effect').textContent)) === 'clicked',
      'closed-shadow button received the real click',
      10_000
    )
    pass('flow', 'closed shadow root on the real guest: the AX tree names the button, getBoxModel boxes it, the CDP hit-test maps the point back to it, and a real pointer event clicks it — while the selector and the aria snapshot both stop at the closed boundary (asserted, not assumed)')
  } finally {
    await guestCdp.detach().catch(() => { /* best effort */ })
  }
  await setUrl(fixtureUrl)
  await eventually(() => guest.url().startsWith(fixtureUrl) && !guest.url().includes('shadow'), 'guest back on the fixture root', 15_000)

  // ================= Agent keys stay in the page (flow) ======================
  // The platform fact behind `focusGuest`: a key dispatched to a guest is offered to the
  // window's focused widget first, so while the SHELL owns focus the key also lands in the
  // shell's DOM — in real use an agent pressing Escape (the app's stop key) ended the run.
  // Once the <webview> holds DOM focus the same key never reaches the shell. That is why the
  // service hands focus to the guest before every keyboard action instead of calling
  // `Page.bringToFront` (measured: it leaves focus alone and keys still leak).
  await evaluate(`window.__pitoKeys = []; window.addEventListener('keydown', (e) => window.__pitoKeys.push(e.key), true)`)
  const shellOwnsFocus = await evaluate(`(() => { const b = document.querySelector('[data-browser-toolbar] button'); if (!b) throw new Error('no toolbar button'); b.focus(); return document.activeElement === b && document.activeElement.tagName !== 'WEBVIEW' })()`)
  assert.equal(shellOwnsFocus, true, 'premise: the shell (not the webview) owns DOM focus')
  await guest.keyboard.press('Shift')
  await pause(300)
  const leaked = await evaluate('JSON.stringify(window.__pitoKeys)')
  assert.match(leaked, /Shift/, `premise: a key aimed at the guest reaches the shell DOM while the shell owns focus (${leaked})`)
  const guestFocused = await evaluate(`(() => { const w = document.querySelector('webview'); if (!w) throw new Error('no webview'); w.focus(); return document.activeElement && document.activeElement.tagName })()`)
  assert.equal(guestFocused, 'WEBVIEW', 'focusing the <webview> element hands DOM focus to the guest')
  await evaluate('window.__pitoKeys = []')
  await guest.keyboard.press('Shift')
  await pause(300)
  assert.equal(await evaluate('JSON.stringify(window.__pitoKeys)'), '[]', 'with the <webview> focused the same key reaches the shell DOM zero times')

  await evaluate(`(() => { const w = document.querySelector('webview'); w && w.blur && w.blur(); const b = document.querySelector('[data-browser-toolbar] button'); b && b.focus(); return 1 })()`)
  pass('flow', 'agent keys stay in the page: while the shell owned focus a guest-bound Shift also fired in the shell DOM; after the <webview> took DOM focus the same key reached the shell zero times — the fact BrowserService.focusGuest uses before every keyboard action')
  await assertSource('agent keys focus the guest before dispatch (main awaits the renderer)', ['src/main/ipc.ts'], /target\.webContents\.send\('browser:focus-guest', payload\)/)
  await assertSource('the pane focuses the guest <webview> and acks', ['src/renderer/src/components/app/BrowserPane.tsx'], /element\?\.focus\(\)[\s\S]{0,120}browserFocusGuestDone\(requestId\)/)

  // ================= Download (flow) =========================================
  await guest.locator('#download').click({ force: true, timeout: 10_000 })
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-browser-toolbar] button[aria-label="Reveal in folder"]\'))'), 'toolbar download indicator', 20_000)
  const downloadPath = join(downloads, downloadName)
  await eventually(async () => {
    try { return (await stat(downloadPath)).size > 0 } catch { return false }
  }, 'downloaded fixture file', 20_000)
  assert.equal(await readFile(downloadPath, 'utf8'), 'browser download fixture')
  pass('flow', `guest download is intercepted by the browser session: toolbar indicator appears and the file lands complete (${downloadPath})`)
  const downloadSource = await eventually(() => evaluate(`(async()=>{const result=await window.pi.libraryPage({query:${JSON.stringify(downloadName)}});return result.ok?result.value.items.find(item=>item.source==='download'&&item.name===${JSON.stringify(downloadName)}):null})()`), 'completed browser download source', 20_000)
  assert.equal(downloadSource.kind, 'web'); assert(downloadSource.url.endsWith('/download.txt'))
  assert(!downloadSource.originalPath, 'download bytes do not enter Files without an attachment or present declaration')
  assert(downloadSource.archivedPath?.endsWith('.json'), 'Web downloads retain the current JSON source snapshot')
  const downloadSnapshot = JSON.parse(await readFile(downloadSource.archivedPath, 'utf8'))
  assert.equal(downloadSnapshot.schema, LIBRARY_WEB_SNAPSHOT_SCHEMA)
  assert.equal(downloadSnapshot.url, downloadSource.url)
  assert.equal(downloadSnapshot.source, 'download')
  assert.equal(downloadSnapshot.excerpt, '', 'a download reference does not invent page content')
  assert.equal(await evaluate(`window.pi.libraryPage({kind:'file',query:${JSON.stringify(downloadName)}}).then(result => result.ok && result.value.total)`), 0)
  assert(downloadSource.sessionPath, 'human browser download URLs retain the originating conversation')
  pass('flow', 'completed download retains its source URL in a Web JSON snapshot; library Files remain limited to attachments and present')

  // ================= Popup routing (flow + iron 10 live) =====================
  await guest.locator('#popup').click({ force: true, timeout: 10_000 })
  await eventually(async () => await stripRows() >= 2, 'popup strip row', 15_000)
  const popupPage = await eventually(
    () => context.pages().find((page) => page.url().endsWith('/popup')) ?? null,
    'popup guest target for the attached client', 15_000
  )
  await popupPage.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  iron(10, 'live', 'guest window.open is split by SYSTEM-BROWSER disposition: a TAB-shaped call is routed through browser:popup into the pane strip (asserted here: the strip row and its attached-client target), while a WINDOW-shaped call is allowed as a real BrowserWindow (asserted below: same partition, real window.opener, no strip row, closed with its opener) — and a non-marker target is never registered as a page')
  pass('flow', 'popup materializes a second strip row whose target is visible to the attached client')
  // The window half is pinned as CODE here (its live leg runs later in the
  // script, where the tab helpers exist): the allow branch and the partition
  // must stay explicit.
  await assertSource('popup window allow path', ['src/main/browser/wiring.ts'], /action: 'allow', overrideBrowserWindowOptions: popupWindowOptions\(details\.features\)/)
  await assertSource('popup window keeps the browser partition', ['src/main/browser/wiring.ts'], /partition: BROWSER_PARTITION/)
  await assertSource('popup windows stay out of the page registry', ['src/main/browser/service.ts'], /private skipForeignTarget\(page: PageLike\)/)
  // Substitution (documented): the popup's OWNER INHERITANCE needs an
  // agent-owned opener, which this account-less check cannot mint; the
  // opener→owner mapping is asserted structurally instead.
  await assertSource(
    'popup owner inheritance mapping',
    ['src/renderer/src/components/app/BrowserPane.tsx'],
    /wcIdMapRef\.current\.get\(popup\.openerWebContentsId\)\?\.owner \?\? HUMAN_OWNER/
  )
  trims.push('popup owner inheritance: source-asserted (BrowserPane wcIdMapRef opener map); an agent-owned opener is not reachable without an SDK session')

  // Esc precedence: both capture-phase Esc handlers must yield to an open modal
  // before fencing the keystroke. They preventDefault + stopPropagation, and
  // CenterMorphModal's own handler bails on `defaultPrevented` — fencing a
  // modal's Escape would leave the dialog open while annotate mode / the
  // overflow popover closed underneath it. Pinned as CODE (not prose); no live
  // modal-during-annotate leg exists.
  await assertSource('annotate Esc yields to an open modal', ['src/renderer/src/components/app/BrowserAnnotate.tsx'], /if \(document\.querySelector\('\[aria-modal="true"\]'\)\) return/)
  await assertSource('overflow-menu Esc yields to an open modal', ['src/renderer/src/components/app/BrowserOverlays.tsx'], /if \(document\.querySelector\('\[aria-modal="true"\]'\)\) return/)
  trims.push('annotate/overflow Esc modal precedence: source-asserted (the [aria-modal="true"] guard, pinned as code); no live modal-during-annotate leg')

  // ================= Iron rule 2 (live): guest page.close() hangs ============
  // Bounded race, then ABANDON the promise — awaiting it forever is precisely
  // the platform failure the rule guards against.
  const rawClose = popupPage.close()
  rawClose.catch(() => { /* abandoned on purpose; see the NOTE handler */ })
  const raced = await Promise.race([rawClose.then(() => 'closed', () => 'rejected'), pause(3_500).then(() => 'hung')])
  assert.equal(raced, 'hung', 'page.close() on a webview guest did not settle inside the 3.5s bounded window (it settled — the iron rule no longer holds)')
  iron(2, 'live', 'page.close() on a webview guest never returns (3.5s bounded race timed out; the promise is abandoned) — closing is renderer-driven via the strip X')

  // ================= Find bar (ui): window-level ⌘F open, Esc close ==========
  // The popup may have taken the selection; the fixture page is the find target.
  await click('[data-browser-tab] [role="tab"]')
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-toolbar]"))'), 'fixture page selected')
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',metaKey:true,cancelable:true,bubbles:true}))`)
  await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-find]"))'), 'find bar opens on ⌘F')
  // Probe the guest's raw found-in-page payloads (the app's own listener still
  // runs): the ordinal sequence is the evidence for the findNext semantics, so
  // it is printed with the settled state instead of being guessed at.
  await evaluate(`(() => {
    const wv = document.querySelector('[data-browser-page]:not(.hidden) webview');
    window.__findLog = [];
    wv.addEventListener('found-in-page', (event) => {
      const r = event.result || {};
      window.__findLog.push({ o: r.activeMatchOrdinal, m: r.matches, f: r.finalUpdate === true });
    });
  })()`)
  await evaluate(`(()=>{
    const input=document.querySelector('[data-browser-find] input');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,'Findable');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const findState = () => evaluate(`(() => {
    const el = document.querySelector('[data-browser-find] [role="status"]');
    return el ? { text: String(el.textContent || ''), final: el.dataset.findFinal === 'true' } : null;
  })()`)
  // Capture what the counter actually reports before asserting: the find target
  // depends on where the earlier legs left the guest, so a mismatch here must
  // name the page and the observed states instead of just timing out.
  const seenStates = []
  const settleDeadline = Date.now() + 8_000
  let firstFind = null
  while (Date.now() < settleDeadline) {
    const state = await findState()
    if (state && !seenStates.includes(`${state.text}|${state.final}`)) seenStates.push(`${state.text}|${state.final}`)
    if (state && state.final && state.text) { firstFind = state; break }
    await pause(150)
  }
  const findTargetUrl = String(await evaluate('document.querySelector("[data-browser-toolbar] input").value'))
  const rawFindLog = await evaluate('JSON.stringify(window.__findLog || [])')
  assert.ok(firstFind, `find count never settled (states seen: ${JSON.stringify(seenStates)}, target ${findTargetUrl})`)
  // The counter renders "x / y". The STARTING ordinal belongs to Chromium's
  // continuation rule (it can be >1 when the document carries a selection), so
  // it is recorded, not assumed — what must hold is that a step MOVES it.
  const ordinalOf = (state) => Number(String(state.text).split('/')[0].trim())
  const totalOf = (state) => Number(String(state.text).split('/')[1] ?? '')
  const startOrdinal = ordinalOf(firstFind)
  const matchTotal = totalOf(firstFind)
  assert.match(firstFind.text, /^\d+ \/ \d+$/, `the counter renders "x / y" (got "${firstFind.text}")`)
  assert.ok(startOrdinal >= 1 && matchTotal >= 2, `a search settles on an active match out of ≥2 (got "${firstFind.text}" on ${findTargetUrl})`)
  // Enter must move the active match. The suite never exercised stepping before
  // — this is the assertion that pins it (and, with it, that a follow-up
  // CONTINUES the running finding session instead of restarting it).
  const pressInFind = (key, shift = false) => evaluate(
    `document.querySelector('[data-browser-find] input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},shiftKey:${shift},bubbles:true,cancelable:true}))`
  )
  /** ⌘F inside the field = "search again" (findStep), which is how the new
   *  document gets a session after a navigation. */
  const restartFind = () => evaluate(
    `document.querySelector('[data-browser-find] input').dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',metaKey:true,bubbles:true,cancelable:true}))`
  )
  const stepStartedAt = Date.now()
  await pressInFind('Enter')
  await eventually(async () => {
    const state = await findState()
    return state !== null && state.final && ordinalOf(state) !== startOrdinal
  }, `Enter moves the active match off ${startOrdinal}`, 15_000)
  const stepMs = Date.now() - stepStartedAt
  const afterEnter = await findState()
  await pressInFind('Enter', true)
  await eventually(async () => {
    const state = await findState()
    return state !== null && state.final && ordinalOf(state) === startOrdinal
  }, `Shift+Enter returns the active match to ${startOrdinal}`, 15_000)
  // Diagnostics that make the next regression self-explaining: the raw payload
  // sequence, where focus ended up (findInPage can hand it to the guest, which
  // the code takes back), and what one step cost.
  const focusAfterFind = String(await evaluate('(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() : "none" })()'))
  console.log(`DEBUG find: target=${findTargetUrl} states=${JSON.stringify(seenStates)} raw=${rawFindLog} start=${firstFind.text} afterEnter=${afterEnter.text} step=${stepMs}ms focus=${focusAfterFind}`)
  assert.ok(Number.isFinite(stepMs), 'a find step is a bounded wait, never a hang')

  // ---- Rapid presses must not be swallowed ---------------------------------
  // Chromium drops find-next requests that arrive while a search is in flight:
  // measured before the step queue, a tight burst of 5 presses produced 3
  // payloads and advanced 2 matches, while the same presses paced 60ms apart
  // produced 5 and advanced 5. The pane therefore serialises presses — every
  // press must issue exactly one request and move the active match by one.
  const burstFrom = await findState()
  const BURST = 5
  await evaluate(`(() => { document.querySelector('[data-browser-find] input').focus(); window.__findLog = [] })()`)
  await evaluate(`(() => {
    const input = document.querySelector('[data-browser-find] input');
    for (let i = 0; i < ${BURST}; i += 1) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`)
  // What must hold: every press ISSUES a request (the queue's job — before it,
  // 5 presses produced 3 payloads) and the burst moves the active match. The
  // per-press advance is reported by the payload ordinals, which can lag a
  // request, so the exact end ordinal is not asserted here — the guest-selection
  // probe below measures the highlight itself.
  await eventually(async () => {
    const ordinals = JSON.parse(String(await evaluate('JSON.stringify((window.__findLog || []).map((entry) => entry.o))')))
    const state = await findState()
    return ordinals.length >= BURST && state !== null && state.final && ordinalOf(state) !== ordinalOf(burstFrom)
  }, `a tight burst of ${BURST} presses issues ${BURST} requests and moves the active match`, 20_000)
  const burstOrdinals = String(await evaluate('JSON.stringify((window.__findLog || []).map((entry) => entry.o))'))
  const burstState = await findState()
  const burstRequests = JSON.parse(burstOrdinals)
  const ordinalChanges = burstRequests.filter((ordinal, index) => index > 0 && ordinal !== burstRequests[index - 1]).length
  console.log(`DEBUG find: tight burst of ${BURST} → ${burstState && burstState.text} ordinals=${burstOrdinals} (requests=${burstRequests.length}, ordinal changes=${ordinalChanges})`)

  // Measured, and recorded as a limitation: Chromium paints find matches WITHOUT
  // leaving a DOM selection — `window.getSelection()` inside the guest stays
  // empty (sampled after 4 paced presses on the flat and subframe fixtures). The
  // highlight itself is therefore not observable through the guest, and the
  // counter's ordinal payloads are the only signal (they may repeat one ordinal
  // on a page with few matches, see the burst line above). That is why the burst
  // assertion above checks requests-issued + movement, not one-advance-per-press.
  trims.push('find highlight liveness: not observable (Chromium leaves no guest DOM selection, so the ordinal payload is the only signal and can repeat an ordinal on a small page) — asserted instead: every press issues a request and the burst moves the match')
  const focusAfterBurst = String(await evaluate('(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() : "none" })()'))
  assert.equal(focusAfterBurst, 'input', 'the burst leaves focus in the find field (the next keystroke belongs to the bar)')

  // ---- Platform fact, measured live: `findNext: false` emits NO
  // `found-in-page` payload on a webview guest — with or without a preceding
  // stopFindInPage. That is why the app must keep `findNext: true` (a session
  // opened with `false` leaves the counter blank forever), and why this pair is
  // asserted rather than described: if a future Electron makes `false` report,
  // the assertion flips the decision back into view instead of letting the
  // "obvious" fix (start at match 1) silently blank the readout again.
  const probeFind = (stopFirst) => evaluate(`(async () => {
    const wv = document.querySelector('[data-browser-page]:not(.hidden) webview');
    const seen = [];
    const onFound = (event) => { const r = event.result || {}; seen.push([r.activeMatchOrdinal, r.matches, r.finalUpdate === true]) };
    wv.addEventListener('found-in-page', onFound);
    ${stopFirst ? "wv.stopFindInPage('clearSelection'); await new Promise((r) => setTimeout(r, 120));" : ''}
    wv.findInPage('Findable', { findNext: false });
    await new Promise((r) => setTimeout(r, 900));
    wv.removeEventListener('found-in-page', onFound);
    wv.stopFindInPage('clearSelection');
    return JSON.stringify(seen);
  })()`)
  const falseAfterStop = await probeFind(true)
  const falseWithoutStop = await probeFind(false)
  console.log(`DEBUG find: findNext:false after stop=${falseAfterStop} without stop=${falseWithoutStop}`)
  assert.equal(falseAfterStop, '[]', 'findNext:false after a stop emits no found-in-page payload (measured platform fact — re-decide the findNext shape if this changes)')
  assert.equal(falseWithoutStop, '[]', 'findNext:false without a stop also emits nothing (so the stop call is not what swallows it)')

  // ---- Does the step cost scale with the document? ---------------------------------
  // The three-match fixture cannot reproduce the lag felt on a real page, so the
  // same step is measured again on a ~3000-match document: the delta is the
  // guest's find/scroll/paint cost, not the host's (the host side of a step is
  // one findInPage call plus one small state update).
  await setUrl(`${fixtureUrl}big`)
  await eventually(() => guest.url().startsWith(`${fixtureUrl}big`), 'big fixture page loaded', 20_000)
  await guest.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  await evaluate('window.__findLog = []')
  await restartFind()
  await eventually(async () => {
    const state = await findState()
    return state !== null && state.final && totalOf(state) >= 1000
  }, 'big-page match count settles', 25_000)
  const bigStart = await findState()
  const bigStepStartedAt = Date.now()
  await pressInFind('Enter')
  await eventually(async () => {
    const state = await findState()
    return state !== null && state.final && ordinalOf(state) !== ordinalOf(bigStart)
  }, 'big-page Enter moves the active match', 25_000)
  const bigStepMs = Date.now() - bigStepStartedAt
  const bigAfterEnter = await findState()
  const rawBigLog = await evaluate('JSON.stringify(window.__findLog || [])')
  console.log(`DEBUG find: big page (${bigStart.text}) → Enter ${bigAfterEnter.text} in ${bigStepMs}ms raw=${rawBigLog}`)
  assert.ok(bigStepMs < 5_000, `a step on a 3000-match page stays bounded (was ${bigStepMs}ms)`)

  // ---- Burst ON THE BIG PAGE (the user-visible case) ------------------------
  // The 3-match fixture measured ~4 of 5 presses advancing, so a burst there
  // does not reproduce "rapid presses only move once". Measure the same burst on
  // a 3000-match page, and again with a 150ms human-ish gap, to see whether the
  // step queue's own gap is what the guest needs (or whether Chromium collapses
  // requests regardless).
  await evaluate('window.__findLog = []')
  await evaluate(`(() => {
    const input = document.querySelector('[data-browser-find] input');
    for (let i = 0; i < 5; i += 1) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`)
  await pause(3_000)
  const bigBurstLog = String(await evaluate('JSON.stringify((window.__findLog || []).map((entry) => entry.o))'))
  const bigBurstState = await findState()
  console.log(`DEBUG find: big-page tight burst of 5 → ${bigBurstState && bigBurstState.text} ordinals=${bigBurstLog}`)
  await evaluate('window.__findLog = []')
  await evaluate(`(async () => {
    const input = document.querySelector('[data-browser-find] input');
    for (let i = 0; i < 5; i += 1) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 150));
    }
  })()`)
  await pause(3_000)
  const bigPacedLog = String(await evaluate('JSON.stringify((window.__findLog || []).map((entry) => entry.o))'))
  const bigPacedState = await findState()
  console.log(`DEBUG find: big-page paced burst of 5 (150ms apart) → ${bigPacedState && bigPacedState.text} ordinals=${bigPacedLog}`)

  // ---- Subframe matches: does the guest steal focus after a step? ----------
  // "Rapid presses only advance once" did NOT reproduce on flat fixtures (5
  // presses advanced 5 matches on the 3000-match page), so measure the shape
  // where Chromium focuses the matched FRAME: matches inside an iframe. If focus
  // leaves the field, later Enters never reach the bar at all.
  await setUrl(`${fixtureUrl}frame`)
  await eventually(() => guest.url().startsWith(`${fixtureUrl}frame`), 'frame fixture page loaded', 20_000)
  await guest.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  await evaluate('window.__findLog = []')
  await restartFind()
  await eventually(async () => {
    const state = await findState()
    return state !== null && state.final && totalOf(state) >= 2
  }, 'subframe match count settles', 25_000)
  const frameFocusAfterFirst = String(await evaluate('(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() : "none" })()'))
  await evaluate('window.__findLog = []')
  await evaluate(`(() => {
    const input = document.querySelector('[data-browser-find] input');
    input.focus();
    for (let i = 0; i < 5; i += 1) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`)
  await pause(3_000)
  const frameLog = String(await evaluate('JSON.stringify((window.__findLog || []).map((entry) => entry.o))'))
  const frameState = await findState()
  const frameFocusAfterBurst = String(await evaluate('(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() : "none" })()'))
  console.log(`DEBUG find: subframe burst of 5 → ${frameState && frameState.text} ordinals=${frameLog} focusAfterFirstStep=${frameFocusAfterFirst} focusAfterBurst=${frameFocusAfterBurst}`)

  await evaluate(`document.querySelector('[data-browser-find] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  await eventually(() => evaluate('!document.querySelector("[data-browser-find]")'), 'find bar closes on Esc')
  pass('ui', `find bar: window-level ⌘F opens, the counter renders (${firstFind.text}), Enter/Shift+Enter move and return the active match (${stepMs}ms on 3 matches, ${bigStepMs}ms on 3000), findNext:false emits nothing, Esc closes`)

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
  trims.push('device emulation live measurement: trimmed after three unstable drive attempts (popover outside-press/focus-scope); the preset table and the element-pinning code path are source-asserted instead. The panel itself is an in-panel ROW LIST — the vendored Select rendered its options inline (no portal) and clipped at the popover edge')

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
  pass('flow', 'zoom survives a real guest navigation: the 110% factor is reapplied on dom-ready (guest innerWidth unchanged, toolbar label unchanged)')

  // ================= Toolbar reload goes through the service (iron 6) ========
  // The doc specifies `goto(currentUrl)` (reloadGuest) for a page the service
  // drives — the CDP Page.reload command kills a webview guest. The toolbar used
  // to call the element API directly; assert the service path keeps the guest,
  // its row and its registry entry alive and lands back on the same URL.
  const rowsBeforeReload = await stripRows()
  const urlBeforeReload = String(await evaluate('document.querySelector("[data-browser-toolbar] input").value'))
  await click('[data-browser-toolbar] button[aria-label="Reload"]')
  await eventually(async () => {
    const url = String(await evaluate('document.querySelector("[data-browser-toolbar] input").value'))
    return url === urlBeforeReload
  }, 'reload settles back on the same URL', 15_000)
  assert.equal(await stripRows(), rowsBeforeReload, 'reload keeps the page row')
  assert.ok(!guest.isClosed(), 'the guest survives a toolbar reload (a CDP Page.reload would have killed it)')
  const registryAfterReload = await evaluate('window.pi.browserStatus().then((s) => s.pages.length)')
  assert.ok(registryAfterReload >= 1, 'the registry still holds the page after reload')
  pass('flow', 'toolbar reload is driven by the service (goto(currentUrl)): the guest target, its row and its registry entry all survive — the CDP Page.reload shape is the one that kills a guest')
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
  const annotationWidth=await guest.evaluate(()=>{const previous=document.body.style.minWidth;document.body.style.minWidth='2000px';window.scrollTo(0,0);return previous})
  await evaluate(`(()=>{const wv=document.querySelector('webview'),capture=document.querySelector('[data-browser-annotate-capture]'),rect=wv.getBoundingClientRect();window.__annotateWheels=[];const original=wv.sendInputEvent.bind(wv);wv.sendInputEvent=event=>{window.__annotateWheels.push(event);return original(event)};window.__restoreAnnotateWheel=()=>{wv.sendInputEvent=original};for(const [deltaX,deltaY] of [[18,12],[12,20],[8,90]])capture.dispatchEvent(new WheelEvent('wheel',{deltaX,deltaY,clientX:rect.x+40,clientY:rect.y+40,bubbles:true,cancelable:true}))})()`)
  const annotationWheels=await evaluate('window.__annotateWheels.map(event=>({x:event.deltaX,y:event.deltaY}))')
  assert.deepEqual(annotationWheels,[{x:-18,y:-12},{x:-12,y:-20},{x:-8,y:-90}],'annotation forwarding preserves both axes and inverted pixel deltas')
  await evaluate('window.__restoreAnnotateWheel()')
  await eventually(()=>guest.evaluate(()=>window.scrollX>0&&window.scrollY>0),'annotate diagonal input scrolls both guest axes')
  await guest.evaluate(previous=>{document.body.style.minWidth=previous;window.scrollTo(0,0)},annotationWidth)
  await eventually(()=>guest.evaluate(()=>window.scrollX===0&&window.scrollY===0),'guest returns to the annotation target')
  pass('ui','annotate diagonal swipe forwards both axes through momentum')
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
  assert.match(annotationText, /Element: h1/, 'the annotation names the resolved element itself (not an ancestor), through the localized payload')
  pass('ui', 'annotate mode end-to-end: capture layer up, a real click resolves the guest element (in-guest elementFromPoint), highlight + bubble render, Insert fires pith:browser-annotation with the element text')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await eventually(() => evaluate('!document.querySelector("[data-browser-annotate-capture]")'), 'annotate mode exits on Esc')

  // ================= Keep-alive (ui, Ruling H) ===============================
  await evaluate('document.querySelector("[data-browser-page] webview")?.setAttribute("data-keepalive-probe","1")')
  await click('[data-sidebar-tabs] button[aria-label="New tab"]')
  await eventually(() => evaluate('[...document.querySelectorAll(\'[data-panel=right] button span\')].some((s)=>s.textContent.trim()===\'Context\')'), 'picker rows')
  await evaluate(`[...document.querySelectorAll('[data-panel=right] button')].find((b)=>[...b.querySelectorAll('span')].some((s)=>s.textContent.trim()==='Context')).click()`)
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-sidebar-tab="context"] [role=tab][aria-selected="true"]\'))'), 'context tab active')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-browser-page] webview"))'), true, 'webview element survives the rail switch')
  assert.equal(await evaluate('document.querySelector("[data-browser-page] webview")?.getAttribute("data-keepalive-probe")'), '1', 'the SAME webview element survives (an inner remount would lose the probe attribute)')
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
  // Positive precondition FIRST: if the latecomer attached to nothing, the
  // negative below is vacuously true (`.some()` on an empty list is false) and
  // a broken second connection would read as a green iron-rule re-proof.
  assert.ok(
    context2.pages().length >= 1,
    `the late connection must at least see the shell window, else the negative is vacuous (saw ${JSON.stringify(context2.pages().map((page) => page.url()))})`,
  )
  const visibleToLatecomer = context2.pages().some((page) => page.url().startsWith(MARKER) || page.url().startsWith(fixtureUrl))
  assert.equal(visibleToLatecomer, false, 'pre-connect guests must not surface in a late connection’s context.pages()')
  const appKnownPages = await evaluate('window.pi.browserStatus().then((s) => s.pages.length)')
  assert.ok(appKnownPages >= 1, 'the app registry still knows the guests (state-only registration)')
  iron(7, 'live', 'a second playwright connection sees NONE of the existing guests in context.pages(), while window.pi.browserStatus() reports them — the browser:seen state-only fallback is live-required, not theoretical')

  const restoreTabsSelector = '[data-browser-section] [role=checkbox][aria-label="Restore tabs after closing the browser"]'
  const setRestoreTabsThroughSettings = async (enabled) => {
    await click('button[aria-label="Settings"]')
    await eventually(() => evaluate('Boolean(document.querySelector(".z-40 [role=tab]"))'), 'settings open for restore-tabs preference')
    await evaluate(`[...document.querySelectorAll('.z-40 [role=tab]')].find(el => el.textContent.trim() === 'Browser').click()`)
    await eventually(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(restoreTabsSelector)}))`), 'restore-tabs checkbox')
    const checked = await evaluate(`document.querySelector(${JSON.stringify(restoreTabsSelector)}).getAttribute('aria-checked')`)
    if (await evaluate('localStorage.getItem("pi-app:browser-restore-tabs")') === null) {
      assert.equal(checked, 'true', 'restore-tabs defaults to existing behavior')
    }
    if (checked !== String(enabled)) await click(restoreTabsSelector)
    await eventually(() => evaluate(`document.querySelector(${JSON.stringify(restoreTabsSelector)}).getAttribute('aria-checked') === ${JSON.stringify(String(enabled))}`), 'restore-tabs setting applied')
    assert.equal(await evaluate('localStorage.getItem("pi-app:browser-restore-tabs")'), String(enabled), 'restore-tabs preference persists')
    await click('button[aria-label="Back to chat"]')
    await eventually(() => evaluate('!document.querySelector(".z-40")'), 'settings closed after restore-tabs choice')
  }
  // Disable close/reopen restoration before both fold checks. The live
  // reconstruction and keep-alive legs must remain independent of it.
  await setRestoreTabsThroughSettings(false)

  // ================= Open-pages snapshot restore after a rail fold (ui) =====
  // A rail fold unmounts the pane and DESTROYS the guests (the keep-alive layer
  // only spans rail TAB switches); the folded window lets the service sweep
  // the dead targets, so the store's stale status still lists pages that can
  // no longer exist. Expanding must repaint the strip from the open-pages
  // snapshot in the pane's FIRST commit (no blank interlude, no seconds-long
  // handshake gap), and an AGENT-owned page must restore under its original
  // owner so its session's tools find it again (activeByOwner addressing).
  // The agent row is materialized through the pane's own popup path (a
  // browserSeen with marker url + navigateTo; the service performs the goto
  // after registration) so it is a REAL loaded page at snapshot time.
  const agentRestoreOwner = 'agent:check-restore'
  // A DISTINCT pathname (the fixture serves its main page for any unmatched
  // path) so the active-tab assertions below discriminate THIS row from a
  // human row parked on the fixture root.
  const agentRestoreUrl = `${fixtureUrl}restore-agent`
  await evaluate(`window.pi.browserSeen({ id: 'p-fold-agent', owner: ${JSON.stringify(agentRestoreOwner)}, url: ${JSON.stringify(`${MARKER}${agentRestoreOwner}/p-fold-agent`)}, navigateTo: ${JSON.stringify(agentRestoreUrl)} })`)
  await eventually(() => evaluate(`Boolean(document.querySelector('[data-browser-page=p-fold-agent]'))`), 'agent-owned page row before the fold', 15_000)
  await eventually(async () => {
    const status = await evaluate('window.pi.browserStatus()')
    return status.pages.some((page) => page.id === 'p-fold-agent' && page.url.startsWith(agentRestoreUrl))
  }, 'agent page navigated to the fixture (pendingNavigate goto)', 20_000)
  const rowsBeforeFold = await stripRows()
  assert.ok(rowsBeforeFold >= 2, `expected the open rows plus the agent row before folding (saw ${rowsBeforeFold})`)
  // Make the AGENT row (the LAST one) the active tab and capture the strip
  // labels: after the fold→expand the SAME tab must be active (not row 0) and
  // the labels must already read as titles (prewritten), not raw urls.
  await click('[data-browser-tab=p-fold-agent] [role=tab]')
  await eventually(async () => String(await evaluate('document.querySelector("[data-browser-toolbar] input")?.value')) === pretty(agentRestoreUrl), 'agent row selected (toolbar shows its url)', 10_000)
  const labelsBeforeFold = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
  assert.ok(labelsBeforeFold.every((label) => label.length > 0), `every tab has a label before folding: ${JSON.stringify(labelsBeforeFold)}`)
  await click('button[aria-label="Toggle sidebar"]')
  await eventually(async () => !(await evaluate('Boolean(document.querySelector("[data-panel=right]"))')), 'rail folds away (pane unmounts, guests destroyed)', 10_000)
  // Let the service sweep the dead targets: the store now holds a stale
  // status full of dead-world rows — exactly what the restore must not be
  // fooled by (the pre-fix behavior rendered those rows, then dropped them,
  // then rebuilt through a seconds-long createPage handshake).
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await click('button[aria-label="Toggle sidebar"]')
  // The restored strip must exist within the pane's first commits — far
  // under one status round trip (the pane polls at 2.5s) — with the same
  // row count, the same labels (titles, not urls) and the SAME active tab.
  await eventually(async () => {
    if (!(await evaluate('Boolean(document.querySelector("[data-browser-pane]"))'))) return false
    if ((await stripRows()) !== rowsBeforeFold) return false
    const labels = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
    if (JSON.stringify(labels) !== JSON.stringify(labelsBeforeFold)) return false
    return String(await evaluate('document.querySelector("[data-browser-toolbar] input")?.value')) === pretty(agentRestoreUrl)
  }, `strip restored at once when the rail expands (${rowsBeforeFold} rows, same labels, same active tab — no blank interlude, no url-as-title flash)`, 1_500)
  await eventually(async () => {
    const status = await evaluate('window.pi.browserStatus()')
    return status.pages.some((page) => page.owner === agentRestoreOwner && page.url.startsWith(agentRestoreUrl))
  }, 'restored agent page re-registers under its ORIGINAL owner and reloads its url', 20_000)
  pass('ui', 'rail fold → expand: the strip repaints from the open-pages snapshot in the pane’s first commit — same rows, same titles, same active tab — and an agent page restores under its original owner (findable via activeByOwner again)')

  // ---- Second fold cycle: repeated teardown/spawn must stay stable (count,
  // selection) and EVERY row must actually navigate off its marker — the
  // marker-stuck failure (a restored tab stays blank forever, reload only
  // reloads the marker, a fresh tab with the same url works) is exactly what
  // the pane's seen-retry self-heal exists for.
  await click('button[aria-label="Toggle sidebar"]')
  await eventually(async () => !(await evaluate('Boolean(document.querySelector("[data-panel=right]"))')), 'rail folds away (second cycle)', 10_000)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await click('button[aria-label="Toggle sidebar"]')
  await eventually(async () => {
    if (!(await evaluate('Boolean(document.querySelector("[data-browser-pane]"))'))) return false
    if ((await stripRows()) !== rowsBeforeFold) return false
    return String(await evaluate('document.querySelector("[data-browser-toolbar] input")?.value')) === pretty(agentRestoreUrl)
  }, 'second expand restores the same rows and the same active tab', 5_000)
  // Watchdog through the reload window: the strip labels must NEVER dip back
  // to raw urls while the guests navigate (the title/favicon flash — the
  // favicon flickers logo → generic → logo on the same mechanism), and every
  // row must end up registered and off its marker. The fixture titles are
  // static, so prewritten and freshly delivered labels are identical — any
  // dip IS the flash.
  {
    let diverged = false
    let navigated = false
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const labels = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
      if (JSON.stringify(labels) !== JSON.stringify(labelsBeforeFold)) { diverged = true; break }
      const status = await evaluate('window.pi.browserStatus()')
      if (status.pages.length === rowsBeforeFold && status.pages.every((page) => !page.url.startsWith(MARKER))) { navigated = true; break }
      await pause(120)
    }
    assert.ok(!diverged, `strip labels dipped during the reload (title/favicon flash): expected ${JSON.stringify(labelsBeforeFold)}`)
    assert.ok(navigated, 'every restored row registers and navigates off its marker (no marker-stuck blank tab)')
  }
  pass('ui', 'second rail fold → expand keeps count/selection stable and every restored guest navigates off its marker')
  // The self-heal itself is pinned at the source: a navigateTo row that stays
  // at its marker must re-report browserSeen (both service paths heal it).
  assert.match(await read('src/renderer/src/components/app/BrowserPane.tsx'), /PENDING_NAVIGATE_RETRY_MS/, 'the marker-stuck self-heal (seen re-report) exists in the pane')

  // Leave the strip as the next leg expects it: close the restored agent row
  // by its NEW id (restore rows get fresh ids — the old ones were retired).
  const restoredAgentId = await evaluate(`window.pi.browserStatus().then((s) => s.pages.find((p) => p.owner === ${JSON.stringify(agentRestoreOwner)})?.id ?? null)`)
  await evaluate(`window.pi.browserClosePage(${JSON.stringify(restoredAgentId)})`)
  await eventually(async () => (await stripRows()) === rowsBeforeFold - 1, 'agent row removed again', 10_000)

  // ================= Keep-alive across rail folds (ui, Settings pref) ========
  // The keep-alive pref (Settings → Browser, localStorage `pi-app:browser-keep-alive`,
  // default OFF): with it on, folding the rail keeps the pane's aside mounted at
  // width 0/opacity 0 — the webviews survive the fold exactly as they survive a
  // rail TAB switch, in-progress page activity never pauses, and the expand is
  // the identical DOM (no snapshot restore, no reload). The heartbeat page
  // proves liveness server-side: its ticks continue while folded and the
  // counter's continuity proves the page instance never reloaded. Pref off
  // (including flipped off WHILE folded) takes the ordinary exit path again.
  {
    const tickState = async () => (await fetch(`${fixtureUrl}tick-count`)).json()
    // urlField is declared below for the history leg; this block runs first, so
    // it owns its local read (same expression).
    const toolbarUrl = () => evaluate('document.querySelector("[data-browser-toolbar] input")?.value')
    const keepAliveRowLabel = 'Keep pages alive when the panel is folded'
    const setKeepAliveThroughSettings = async (enabled) => {
      await click('button[aria-label="Settings"]')
      await eventually(() => evaluate('Boolean(document.querySelector(".z-40 [role=tab]"))'), 'settings page renders', 10_000)
      // Scope to the settings overlay: the workspace's own rail strip has its
      // own tabs (one of them also labelled “Browser”).
      await evaluate(`[...document.querySelectorAll('[role="tab"]')].filter((t) => t.closest('.z-40')).find((t) => t.textContent.trim() === 'Browser')?.click()`)
      await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-section]"))'), 'browser section renders', 10_000)
      await evaluate(`[...document.querySelectorAll('[data-browser-section] [aria-label]')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(keepAliveRowLabel)})?.click()`)
      await eventually(() => evaluate(`(localStorage.getItem("pi-app:browser-keep-alive") ?? "") === ${enabled ? '"true"' : '"false"'}`), `the pref row wrote localStorage (${enabled ? 'on' : 'off'})`, 10_000)
      await click('button[aria-label="Back to chat"]')
      await eventually(() => evaluate('!document.querySelector(".z-40")'), 'settings closed', 10_000)
    }

    await setUrl(`${fixtureUrl}keepalive`)
    await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-toolbar] input")) && document.querySelector("[data-browser-toolbar] input").value.includes("keepalive")'), 'keepalive url in the toolbar', 10_000)
    await new Promise((resolve) => setTimeout(resolve, 900))
    const ticksBeforeFold = await tickState()
    assert.ok(ticksBeforeFold.count >= 2, `heartbeat page is ticking (saw ${ticksBeforeFold.count})`)
    // Probe EVERY webview, not just the selected one: the whole pane must keep
    // its nodes through the fold.
    await evaluate('[...document.querySelectorAll("[data-browser-page] webview")].forEach((w, i) => w.setAttribute("data-fold-probe", String(i)))')
    const rowsBeforeKeepFold = await stripRows()
    const labelsBeforeKeepFold = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
    const urlBeforeKeepFold = await toolbarUrl()

    await setKeepAliveThroughSettings(true)
    await click('button[aria-label="Toggle sidebar"]')
    await eventually(() => evaluate('Boolean(document.querySelector("[data-panel=right]")) && document.querySelector("[data-panel=right]").getBoundingClientRect().width < 2'), 'the folded rail KEEPS the aside mounted at width ~0 (pref on)', 5_000)
    assert.equal(await evaluate('Boolean(document.querySelector("[data-browser-pane]"))'), true, 'the browser pane stays mounted through the fold')
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-browser-page] webview")].every((w) => w.getAttribute("data-fold-probe") !== null)'),
      true,
      'every webview node survives the fold'
    )
    assert.equal(await evaluate('document.querySelector("[data-panel=right]").getAttribute("aria-hidden")'), 'true', 'the folded aside is aria-hidden')
    // In-progress activity must not pause: the heartbeat keeps ticking while folded.
    await new Promise((resolve) => setTimeout(resolve, 1_400))
    const ticksWhileFolded = await tickState()
    assert.ok(ticksWhileFolded.count >= ticksBeforeFold.count + 3, `the folded page kept running — activity not paused (count ${ticksBeforeFold.count} → ${ticksWhileFolded.count})`)
    assert.ok(ticksWhileFolded.lastN > ticksBeforeFold.lastN, 'the heartbeat counter is continuous (same page instance, not a fresh one)')

    await click('button[aria-label="Toggle sidebar"]')
    await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-pane]")) && document.querySelector("[data-panel=right]").getBoundingClientRect().width > 100'), 'rail expands with the same pane', 10_000)
    assert.equal(
      await evaluate('[...document.querySelectorAll("[data-browser-page] webview")].every((w) => w.getAttribute("data-fold-probe") !== null)'),
      true,
      'expand found the identical webview nodes — no restore, no reload'
    )
    assert.equal(await stripRows(), rowsBeforeKeepFold, 'same row count after the fold→expand cycle')
    assert.equal(
      JSON.stringify(await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')),
      JSON.stringify(labelsBeforeKeepFold),
      'same strip labels after the cycle'
    )
    assert.equal(await toolbarUrl(), urlBeforeKeepFold, 'same page selected with the same url after the cycle')
    // A tick lands every 350ms — poll for the next one instead of racing it
    // (the expand animation + the DOM assertions above can finish inside one
    // tick interval).
    await eventually(async () => (await tickState()).lastN > ticksWhileFolded.lastN, 'the same page instance keeps ticking after the expand (never reloaded)', 3_000)

    // Pref OFF takes the exit path again: a folded held-alive aside unmounts
    // the moment the pref flips (default behavior restored), and the next
    // expand goes through the snapshot restore (fresh page ids).
    await click('button[aria-label="Toggle sidebar"]')
    await eventually(() => evaluate('Boolean(document.querySelector("[data-panel=right]")) && document.querySelector("[data-panel=right]").getBoundingClientRect().width < 2'), 'folded again under keep-alive', 5_000)
    await setKeepAliveThroughSettings(false)
    await eventually(() => evaluate('!document.querySelector("[data-panel=right]")'), 'turning the pref off while folded unmounts the held aside', 10_000)
    await click('button[aria-label="Toggle sidebar"]')
    await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-pane]"))'), 'pane remounts through the restore path', 10_000)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    pass('ui', 'keep-alive pref: a folded rail keeps the pane mounted — same webview nodes, page activity unpaused, expand pixel-identical; pref off while folded unmounts it again')
  }

  // ================= Back/Forward enablement + address-bar no-flash (ui) =====
  // A fresh tab's Back must be disabled: the spawn jump (marker → first real
  // url) is the handshake, not history — clearHistory erases it at the first
  // commit, so Back can never navigate into the blank marker (the page empties
  // and the title falls back to the raw url). Back/Forward enable only when
  // the guest's own canGoBack/canGoForward say so. And a submitted url KEEPS
  // the field's text through the load: releasing the draft at Enter used to
  // flash the PREVIOUS url (or about:blank) back into the field until
  // did-navigate committed.
  await click('[data-sidebar-tab="browser"] [role="tab"]')
  await eventually(() => evaluate('Boolean(document.querySelector(\'[data-sidebar-tab="browser"] [role=tab][aria-selected="true"]\'))'), 'browser tab active for the history leg')
  const rowsBeforeHistory = await stripRows()
  const nextUrl = `${fixtureUrl}next`
  const backDisabled = () => evaluate(`document.querySelector('[data-browser-toolbar] button[aria-label="Back"]').disabled`)
  const forwardDisabled = () => evaluate(`document.querySelector('[data-browser-toolbar] button[aria-label="Forward"]').disabled`)
  const urlField = () => evaluate(`document.querySelector('[data-browser-toolbar] input').value`)
  await evaluate(`document.querySelector('button[aria-label="New page"]').click()`)
  await eventually(async () => (await stripRows()) === rowsBeforeHistory + 1, 'strip gains the fresh blank tab', 10_000)
  await eventually(async () => (await urlField()) === 'about:blank', 'fresh blank tab selected with its blank field', 10_000)
  assert.equal(await backDisabled(), true, 'Back disabled on a fresh blank tab')
  assert.equal(await forwardDisabled(), true, 'Forward disabled on a fresh blank tab')
  // First load: the field must hold the typed url (never about:blank) and
  // Back must STAY disabled once it lands (the spawn jump was cleared).
  await setUrl(fixtureUrl)
  {
    let flashed = false
    let loaded = false
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const value = await urlField()
      if (value !== fixtureUrl && value !== pretty(fixtureUrl)) { flashed = true; break }
      const labels = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
      if (labels.includes('Browser fixture')) { loaded = true; break }
      await pause(100)
    }
    assert.ok(!flashed, 'address bar keeps the submitted url through the first load (no about:blank flash)')
    assert.ok(loaded, 'fresh tab loads the fixture page')
  }
  await eventually(async () => (await urlField()) === pretty(fixtureUrl), 'rest state trims the scheme/www prefix', 5_000)
  assert.equal(await backDisabled(), true, 'Back stays disabled after the first load (the spawn jump is not history)')
  // Second navigation: Back becomes meaningful; the field never flashes the
  // previous url between Enter and the commit.
  await setUrl(nextUrl)
  {
    let flashed = false
    let loaded = false
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const value = await urlField()
      if (value === fixtureUrl || value === pretty(fixtureUrl)) { flashed = true; break }
      if (value === nextUrl || value === pretty(nextUrl)) {
        const labels = await evaluate('[...document.querySelectorAll("[data-browser-tab]")].map((r) => r.textContent.trim())')
        if (labels.includes('Next fixture')) { loaded = true; break }
      }
      await pause(100)
    }
    assert.ok(!flashed, 'address bar never flashes back the previous url after Enter')
    assert.ok(loaded, 'second page loads')
  }
  await eventually(async () => (await backDisabled()) === false, 'Back enabled once a real page precedes', 10_000)
  assert.equal(await forwardDisabled(), true, 'Forward disabled at the newest entry')
  // Back returns to the first page; Forward enables, Back disables again at
  // the oldest real entry.
  await evaluate(`document.querySelector('[data-browser-toolbar] button[aria-label="Back"]').click()`)
  await eventually(async () => (await urlField()) === pretty(fixtureUrl), 'Back returns to the first page', 10_000)
  assert.equal(await forwardDisabled(), false, 'Forward enabled after going back')
  assert.equal(await backDisabled(), true, 'Back disabled again at the oldest real entry')
  pass('ui', 'history: Back/Forward enable only when meaningful (a fresh tab stays disabled — the spawn marker is cleared from history), and a submitted url keeps the field through the load')
  // Leave the strip as the next leg expects it, and cover follow-scroll on
  // the way: when the strip overflows, a newly added tab (the + appends and
  // selects) must scroll into view. The X click is RETRIED while the row is
  // still there — a re-render can swap the row node between the query and the
  // dispatch (detached target, silent no-op); re-delivering the user gesture
  // is what a user does, the count assertions are unchanged.
  // Close one strip row BY INDEX, retrying the click while the row is still
  // there (a re-render can swap the row node between the query and the
  // dispatch — detached target, silent no-op; re-delivering the user gesture
  // is what a user does).
  const closeTabAt = async (index) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const before = await stripRows()
      await evaluate(`(()=>{ const rows=[...document.querySelectorAll('[data-browser-tab]')]; const close=rows[${index}]?.querySelector('button[aria-label="Close page"]'); if(close) close.click(); })()`)
      await pause(400)
      if ((await stripRows()) < before) return true
      await pause(600)
    }
    return false
  }
  const closeLastTab = async (targetCount) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if ((await stripRows()) <= targetCount) return true
      if (!(await closeTabAt((await stripRows()) - 1))) return false
    }
    return false
  }
  const stripScroll = () => evaluate(`(()=>{ const sc=document.querySelector('[data-browser-strip-scroll]'); const rows=[...document.querySelectorAll('[data-browser-tab]')]; const last=rows[rows.length-1]; if(!sc||!last) return null; const sr=sc.getBoundingClientRect(); const rr=last.getBoundingClientRect(); return { scrollLeft: sc.scrollLeft, scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth, maxScroll: sc.scrollWidth - sc.clientWidth, rowRight: rr.right, scrollerRight: sr.right, rows: rows.length, overflow: sc.scrollWidth > sc.clientWidth + 1, visible: rr.right <= sr.right + 1 }; })()`)
  {
    let guard = 0
    while (guard++ < 8) {
      const state = await stripScroll()
      if (state?.overflow) break
      const before = await stripRows()
      await evaluate(`document.querySelector('button[aria-label="New page"]').click()`)
      await eventually(async () => (await stripRows()) === before + 1, 'new tab row appears', 10_000)
    }
    const state = await stripScroll()
    assert.ok(state?.overflow, 'strip overflows after enough new tabs')
    // One more + WHILE overflowing: the newest row must be followed into
    // view (the app scrolls in a rAF after the commit and re-scrolls on the
    // later ResizeObserver pass — wait for convergence, don't race frames).
    const beforeMore = await stripRows()
    await evaluate(`document.querySelector('button[aria-label="New page"]').click()`)
    await eventually(async () => (await stripRows()) === beforeMore + 1, 'another new tab row appears', 10_000)
    await eventually(async () => {
      const s = await stripScroll()
      return Boolean(s && s.scrollLeft > 0 && s.visible)
    }, 'the strip auto-scrolled to keep the newest tab fully visible', 5_000)
    pass('ui', 'strip follow-scroll: a newly added tab scrolls into view when the strip overflows')
    while ((await stripRows()) > rowsBeforeHistory) {
      assert.ok(await closeLastTab(rowsBeforeHistory), `closing back down to ${rowsBeforeHistory} rows (stuck at ${await stripRows()})`)
    }
  }

  // Tab-close return selection: closing a tab returns to the tab selected
  // when it was opened; a gone opener falls back to the first tab LEFT of
  // the closed one; closing a background tab keeps the selection. The strip
  // sits at rowsBeforeHistory rows (A=0, B=1) with A selected.
  const activeTabIndex = () => evaluate(`[...document.querySelectorAll('[data-browser-tab]')].findIndex((r) => r.querySelector('[role="tab"][aria-selected="true"]'))`)
  const openNewTab = async () => {
    const before = await stripRows()
    await evaluate(`document.querySelector('button[aria-label="New page"]').click()`)
    await eventually(async () => (await stripRows()) === before + 1, 'new tab row appears', 10_000)
    return evaluate(`document.querySelector('[data-browser-tab]:last-child').getAttribute('data-browser-tab')`)
  }
  {
    assert.equal(await activeTabIndex(), 0, 'premise: the first tab is selected')
    // D opens from A; closing D returns to A (the opener rule).
    await openNewTab()
    assert.equal(await activeTabIndex(), 2, 'the new tab opens selected')
    assert.ok(await closeTabAt(2), 'closing the newest tab')
    await eventually(async () => (await stripRows()) === rowsBeforeHistory, 'row removed', 10_000)
    assert.equal(await activeTabIndex(), 0, 'closing a tab returns to the tab selected when it was opened')
    // E opens from A; selecting B and closing E in the background keeps B.
    const backgroundTabId = await openNewTab()
    await evaluate(`(()=>{ const rows=[...document.querySelectorAll('[data-browser-tab]')]; rows[1].querySelector('[role="tab"]').click(); })()`)
    await eventually(async () => (await activeTabIndex()) === 1, 'second tab selected by click', 10_000)
    await eventually(() => evaluate(`window.pi.browserStatus().then(status => status.pages.some(page => page.id === ${JSON.stringify(backgroundTabId)}) && !status.pendingCreates.some(page => page.id === ${JSON.stringify(backgroundTabId)}))`), 'background tab create receipt settles', 15_000)
    assert.equal(await activeTabIndex(), 1, 'a late create receipt preserves the human tab selection')
    assert.ok(await closeTabAt(2), 'closing the background tab')
    await eventually(async () => (await stripRows()) === rowsBeforeHistory, 'background row removed', 10_000)
    assert.equal(await activeTabIndex(), 1, 'closing a background tab keeps the selection')
    // F opens from B; B closes in the background (selection stays F); closing
    // F then finds its opener gone → the first tab LEFT of F (A).
    await openNewTab()
    assert.equal(await activeTabIndex(), 2, 'the third throwaway tab opens selected')
    assert.ok(await closeTabAt(1), 'closing the opener in the background')
    await eventually(async () => (await stripRows()) === rowsBeforeHistory, 'opener row removed', 10_000)
    assert.equal(await activeTabIndex(), 1, 'the selection survives the background close')
    assert.ok(await closeTabAt(1), 'closing the tab whose opener is gone')
    await eventually(async () => (await stripRows()) === 1, 'row removed again', 10_000)
    assert.equal(await activeTabIndex(), 0, 'a gone opener falls back to the first tab to the LEFT')
    // Replenish so the strip-close leg finds its expected two rows.
    await openNewTab()
    await eventually(async () => (await stripRows()) === rowsBeforeHistory, 'strip back to two rows', 10_000)
    pass('ui', 'tab-close return: the opener tab first, left-neighbor fallback, background close keeps selection')
  }

  // ============ Popup WINDOW disposition (ui): a real BrowserWindow =========
  // A window-shaped window.open is `allow`ed: Electron creates a real BrowserWindow —
  // same partition (the cookie jar is the point), a REAL opener relationship
  // (SIWA/Google hand the result back by postMessage to it), no page-registry row
  // (the pane strip must not grow) and closed with its opener (a window left
  // pointing at a dead opener is the failure mode).
  //
  // Identity discipline, learned the hard way: a playwright Page cannot be mapped
  // onto a pane row, and the strip orders by registry (not creation), so driving this
  // by row INDEX silently closed an unrelated leftover tab while the real opener
  // lived on. The opener is therefore a THROWAWAY tab addressed by page id from the
  // DOM (`data-browser-tab` / `data-browser-page` carry the id), driven through its
  // OWN webview element, marked, and the marker is read back out of the popup's
  // `window.opener`. A throwaway also keeps the strip count intact for the later
  // legs: opening one and closing it is net zero.
  const rowIds = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-browser-tab]')].map((r) => r.dataset.browserTab))`))
  const idsBefore = await rowIds()
  await openNewTab()
  const openerId = await eventually(async () => (await rowIds()).find((id) => !idsBefore.includes(id)) ?? null, 'throwaway tab row', 10_000)
  const openerWebview = `document.querySelector('[data-browser-page=${JSON.stringify(openerId)}] webview')`
  await eventually(() => evaluate(`Boolean(${openerWebview}?.getWebContentsId())`), 'throwaway tab guest mounted', 15_000)
  // Navigate through the guest element itself (the pane's own address-bar path does
  // exactly this for a live page). Driving the toolbar input instead races the
  // selection: `+` selects its tab a beat later, and setUrl navigates whatever is
  // selected at that moment.
  await evaluate(`${openerWebview}.loadURL(${JSON.stringify(fixtureUrl)})`)
  await eventually(() => evaluate(`${openerWebview}.getURL().startsWith(${JSON.stringify(fixtureUrl)})`), 'throwaway tab on the fixture', 20_000)
  const rowsBeforeWindowPopup = await stripRows()
  // The opener must be the VISIBLE page: a hidden row is 0×0 and would make the
  // measurement meaningless (an earlier probe run sampled a hidden webview). Select
  // it and let the strip's indicator spring settle BEFORE the probe starts — the
  // first probe run recorded its own selection animation as if it were the popup's.
  await evaluate(`document.querySelector('[data-browser-tab=${JSON.stringify(openerId)}] [role="tab"]').click()`)
  await eventually(() => evaluate(`${openerWebview}.getBoundingClientRect().width > 100`), 'opener page visible (non-zero rect)', 10_000)
  await pause(1_500)
  // Mark the opener so the popup can prove WHO opened it (a playwright Page cannot be
  // mapped onto a pane row, so the marker travels through `window.opener`).
  await evaluate(`${openerWebview}.executeJavaScript("window.__pithOpenerMark='OPENER-A'; document.cookie='pith_probe=1; path=/'; 'marked'")`)
  await evaluate(`${openerWebview}.executeJavaScript("document.getElementById('popup-window').click(); 'clicked'")`)
  const windowPopup = await eventually(
    () => context.pages().find((page) => page.url().includes('/popup-window')) ?? null,
    'real popup window target', 15_000,
  )
  await windowPopup.waitForLoadState('domcontentloaded', { timeout: 10_000 })
  // Reading a property through `window.opener` needs the real relationship AND a
  // same-origin opener: a re-created tab (the old browser:popup path) would answer
  // null here.
  assert.equal(
    await windowPopup.evaluate('window.opener ? window.opener.__pithOpenerMark : null'),
    'OPENER-A',
    'the popup’s window.opener IS the pane page that called window.open (a real opener relationship)',
  )
  assert.match(await windowPopup.evaluate('document.cookie'), /pith_probe=1/, 'the popup shares the pane partition (same cookie jar)')
  // Geometry: the call asks for left=0,top=0 (Apple's SIWA popup does exactly that).
  // The size is honored; the position must NOT be the screen corner.
  const placement = await windowPopup.evaluate('({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })')
  assert.equal(placement.w, 420, 'the size the call asked for is honored')
  assert.ok(placement.x > 100 && placement.y > 100, `left=0,top=0 must not park the popup in the screen corner (got x=${placement.x} y=${placement.y})`)
  assert.equal(await stripRows(), rowsBeforeWindowPopup, 'a real popup window NEVER becomes a pane row')
  pass('ui', 'window-shaped window.open opens a real BrowserWindow: real window.opener, same partition (cookie jar), no pane row, requested size honored and centred')
  // Closing the opener's row destroys its guest, and the popup window must go with it.
  const closedOpenerRow = await evaluate(`(() => {
    const row = document.querySelector('[data-browser-tab=${JSON.stringify(openerId)}]')
    const button = row?.querySelector('button[aria-label="Close page"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(closedOpenerRow, 'the opener row exposes its close button and was clicked')
  await eventually(async () => !(await evaluate(`Boolean(document.querySelector('[data-browser-tab=${JSON.stringify(openerId)}]'))`)), 'opener row removed', 10_000)
  // Assert on the Page's OWN closed flag (the platform fact) rather than on the URL
  // text in context.pages(): a stale page object keeps its last URL forever and would
  // read as "the window is still open" when it is not.
  const popupGone = await eventually(() => windowPopup.isClosed(), 'popup window closed flag', 15_000).then(() => true, () => false)
  if (!popupGone) {
    const rows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-browser-tab]')].map((r) => r.dataset.browserTab))`)
    const registry = await evaluate(`window.pi.browserStatus().then((s) => JSON.stringify(s.pages.map((p) => p.id + ' ' + p.url)))`)
    const listed = context.pages().map((page) => `${page.url()}${page.isClosed() ? ' (closed)' : ''}`).join(' | ')
    console.log(`DEBUG popup-window: popupClosed=${windowPopup.isClosed()} rows=${rows} registry=${registry} pages=${listed}`)
  }
  assert.ok(popupGone, 'the popup window closes with its opener (lifetime bound to the opener)')
  pass('ui', 'closing the opener guest closes its popup window (lifetime is bound to the opener, like a real browser)')

  // ================= Strip close + last-page-closes-pane (ui) ================
  await setRestoreTabsThroughSettings(true)
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

  // Explicit browser rail-tab closure has its own preference. Keep another
  // rail tab open first, then repeat with browser as the last tab so exit
  // animations cannot write the cleared snapshot back.
  // Track these added teardowns separately: each destroyed guest may emit
  // Electron's existing Invalid guestInstanceId cleanup exception, while the
  // original suite retains its fixed exception budget.
  await evaluate(`(() => {
    let count = 0;
    const removed = new WeakSet();
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const guests = node.matches('webview') ? [node] : [...node.querySelectorAll('webview')];
        for (const guest of guests) if (!removed.has(guest)) { removed.add(guest); count += 1; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__finishRestoreGuestTeardowns = () => { observer.disconnect(); return count; };
  })()`)
  const reopenBrowser = async () => {
    await evaluate('window.dispatchEvent(new CustomEvent("pith:browser-open-link"))')
    await eventually(() => evaluate('Boolean(document.querySelector("[data-browser-pane]"))'), 'browser reopened')
  }
  const openPagesSnapshot = () => evaluate('JSON.parse(localStorage.getItem("pi-app:browser-open-pages") ?? "[]")')
  const openReadyTab = async () => {
    const id = await openNewTab()
    await eventually(() => evaluate(`Boolean(document.querySelector('[data-browser-tab=${JSON.stringify(id)}] [role=tab][aria-selected="true"]')) && window.pi.browserStatus().then(status => status.pages.some(page => page.id === ${JSON.stringify(id)}) && !status.pendingCreates.some(page => page.id === ${JSON.stringify(id)}))`), 'new page selected and registered before navigation')
  }
  const expectBlankBrowser = async () => {
    await eventually(async () => (await stripRows()) === 1 && (await urlField()) === 'about:blank', 'browser reopens with one blank page')
    let observedStatus
    await eventually(async () => {
      observedStatus = await evaluate('window.pi.browserStatus()')
      return observedStatus.pages.length === 1 && !observedStatus.pendingCreates.length
    }, 'only the new blank guest is registered').catch(async (error) => {
      console.log(`DEBUG blank reopen: status=${JSON.stringify(observedStatus)} rows=${await stripRows()} snapshot=${JSON.stringify(await openPagesSnapshot())}`)
      console.log(`DEBUG blank guests: ${JSON.stringify(await evaluate(`[...document.querySelectorAll('webview')].map(wv => { try { return { src: wv.getAttribute('src'), url: wv.getURL(), webContentsId: wv.getWebContentsId() } } catch (error) { return { src: wv.getAttribute('src'), error: String(error) } } })`))}`)
      throw error
    })
    assert.equal(await stripRows(), 1, 'closed tabs do not reappear after registration')
  }
  await setRestoreTabsThroughSettings(true)
  assert.deepEqual(await openPagesSnapshot(), [], 'closing the final page leaves no restorable tabs')
  await reopenBrowser()
  await expectBlankBrowser()
  await openReadyTab()
  const reopenUrl = `${fixtureUrl}restore-after-close`
  await setUrl(reopenUrl)
  await eventually(() => evaluate(`window.pi.browserStatus().then(status => status.pages.some(page => page.url === ${JSON.stringify(reopenUrl)}))`), 'page loaded before explicit close')
  await eventually(async () => (await openPagesSnapshot()).some(page => page.url === reopenUrl && page.selected), 'selected page saved before close')
  const savedOnClose = await openPagesSnapshot()
  assert.equal(savedOnClose.length, 2, 'two pages are open before explicit close')
  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  await eventually(() => evaluate('!document.querySelector("[data-browser-pane]")'), 'browser closes while another rail tab stays open')
  assert.deepEqual(await openPagesSnapshot(), savedOnClose, 'enabled restoration retains the snapshot after close')
  await reopenBrowser()
  await eventually(async () => (await stripRows()) === 2 && (await urlField()) === pretty(reopenUrl), 'enabled restoration reopens both pages with the selected URL')
  await eventually(() => evaluate(`window.pi.browserStatus().then(status => status.pages.length === 2 && status.pages.some(page => page.url === ${JSON.stringify(reopenUrl)}))`), 'restored page finishes navigating')
  pass('ui', 'restore-tabs enabled: explicit browser rail-tab close/reopen retains blank pages, count and selection')

  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  await eventually(() => evaluate('!document.querySelector("[data-browser-pane]")'), 'browser closed before changing restoration preference')
  await setRestoreTabsThroughSettings(false)
  await reopenBrowser()
  await expectBlankBrowser()
  pass('ui', 'restore-tabs disabled while the browser is already closed: reopening discards the previously retained tabs')

  await setRestoreTabsThroughSettings(true)
  await openReadyTab()
  await setUrl(reopenUrl)
  await eventually(async () => (await openPagesSnapshot()).some(page => page.url === reopenUrl), 'live tabs ready before disabling restoration')
  await setRestoreTabsThroughSettings(false)
  assert.equal(await stripRows(), 2, 'disabling restoration leaves live tabs intact')
  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  assert.deepEqual(await openPagesSnapshot(), [], 'disabled restoration clears the snapshot immediately on close')
  await eventually(() => evaluate('!document.querySelector("[data-browser-pane]")'), 'browser unmounted after disabled close')
  await reopenBrowser()
  await expectBlankBrowser()
  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  await eventually(() => evaluate('!document.querySelector("[data-browser-pane]")'), 'blank browser closed')
  pass('ui', 'restore-tabs disabled: changing the setting preserves live pages, while explicit close/reopen starts blank; fold reconstruction and keep-alive remain covered with the setting off')

  // And with the final tab closed the rail folds itself away entirely.
  await click('[data-sidebar-tab="context"] button[aria-label^="Close"]')
  await eventually(async () => !(await evaluate('Boolean(document.querySelector("[data-panel=right]"))')), 'rail folds after its last tab closes', 10_000)
  pass('ui', 'closing the last remaining rail tab folds the right rail')

  await reopenBrowser()
  await expectBlankBrowser()
  await setUrl(reopenUrl)
  await eventually(async () => (await openPagesSnapshot()).some(page => page.url === reopenUrl), 'last rail-tab page saved')
  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  assert.deepEqual(await openPagesSnapshot(), [], 'last rail-tab closure clears the snapshot before the exit animation')
  await eventually(() => evaluate('!document.querySelector("[data-panel=right]")'), 'browser as the last rail tab finishes closing')
  assert.deepEqual(await openPagesSnapshot(), [], 'exiting pane effects do not restore the cleared snapshot')
  await reopenBrowser()
  await expectBlankBrowser()
  await setUrl(reopenUrl)
  await eventually(async () => (await openPagesSnapshot()).some(page => page.url === reopenUrl), 'page ready before rapid close/reopen')
  const rapidCloseIds = await rowIds()
  // Reopen before AnimatePresence can finish the last-tab exit. An explicit
  // close must start a fresh pane even if the same aside DOM is reused.
  await evaluate(`document.querySelector('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]').click(); window.dispatchEvent(new CustomEvent("pith:browser-open-link"))`)
  await expectBlankBrowser()
  assert.ok((await rowIds()).every(id => !rapidCloseIds.includes(id)), 'rapid reopening creates new pages instead of reviving the exiting pane')
  pass('ui', 'restore-tabs disabled: immediate close/reopen during the rail exit starts a fresh blank pane')
  await click('[data-sidebar-tab="browser"] button[aria-label="Close Browser"]')
  await eventually(() => evaluate('!document.querySelector("[data-panel=right]")'), 'final browser fixture cleanup')
  pass('ui', 'restore-tabs disabled: closing the last rail tab survives the exit animation and still reopens blank')
  const restoreGuestTeardowns = await evaluate('window.__finishRestoreGuestTeardowns()')

  // ================= Iron rule 12 (live + app-side source) ==================
  assert.equal(app.exitCode, null, 'app process still running')
  assert.equal(await evaluate('document.readyState'), 'complete', 'shell still responsive with the playwright clients attached')
  // The APP-side half of the rule, source-asserted: the dispose path must DROP
  // references, never close. The needle pins dispose()'s exact shape
  // (handleProcessExit + clearStateNotify) and the deliberate no-close
  // comment, and the body — comments stripped — is negatively asserted to
  // contain no .close( call at all (Browser.close() over CDP can kill the
  // Electron shell).
  const serviceSource = await read('src/main/browser/service.ts')
  const disposeBody = /dispose\(\): void \{[\s\S]*?\n  \}/.exec(serviceSource)?.[0]
  assert.ok(disposeBody, 'BrowserService.dispose() found in service.ts')
  assert.match(disposeBody, /this\.handleProcessExit\(\)/, 'dispose hands lifecycle back to ipc.ts/shutdown.ts (references dropped)')
  assert.match(disposeBody, /this\.clearStateNotify\(\)/, 'dispose tears down the notify timer (references dropped)')
  // The negative guard spans the WHOLE file (comments stripped — block
  // comments first, then line comments): dispose() is the one place a close
  // could hide today, but any future method joining it must trip the same alarm.
  const serviceNoComments = serviceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(serviceNoComments, /\.close\(/, 'service.ts must contain NO executable close call anywhere — Browser.close() over CDP can kill the app (iron 12)')
  iron(12, 'live', 'the app stays alive the whole run with external playwright clients attached and is NOT closed by them — and the app-side half is source-asserted: dispose() only drops references (handleProcessExit + clearStateNotify, no .close() call, electronBrowser.close() prohibition pinned in source); the clients are dropped, never closed')

  // ---- Source-only iron rules: asserted against COMMENT-STRIPPED source, and
  // every rule whose subject is a FORBIDDEN mechanism is additionally asserted
  // NEGATIVELY (a reintroduced page.reload()/.fill()/mouse.wheel() must trip the
  // check even while the prose comment still explains why it is forbidden — the
  // old prose-spanning regexes failed on a harmless comment edit and passed on a
  // behavioural regression). Positive behaviour is covered by check-browser.mjs
  // against the structural mock: keyboard chain, CDP-wheel + scrollBy fallback,
  // 5s→8s screenshot retry, the annotate budget, elementFromPoint. --------------
  assert.match(serviceNoComments, /pressSequentially\(/, 'rule 4: text entry goes through pressSequentially')
  assert.doesNotMatch(serviceNoComments, /\.fill\(/, 'rule 4: locator.fill() appears nowhere in the service')
  iron(4, 'source', ruleSourceMessage[4])
  assert.match(serviceNoComments, /Input\.dispatchMouseEvent/, 'rule 5: the synthetic wheel goes through CDP')
  assert.match(serviceNoComments, /window\.scrollBy\(dx, dy\)/, 'rule 5: the in-page scrollBy fallback is present')
  assert.doesNotMatch(serviceNoComments, /mouse\.wheel\(/, 'rule 5: Playwright mouse.wheel is never used')
  iron(5, 'source', ruleSourceMessage[5])
  assert.match(serviceNoComments, /await page\.goto\(url/, 'rule 6: reloadGuest navigates with goto')
  assert.doesNotMatch(serviceNoComments, /page\.reload\(/, 'rule 6: the CDP Page.reload command is never sent (it kills the guest)')
  iron(6, 'source', ruleSourceMessage[6])
  assert.match(serviceNoComments, /await shoot\(5_000\)/, 'rule 8: the first screenshot carries a 5s timeout')
  assert.match(serviceNoComments, /await shoot\(8_000\)/, 'rule 8: the single retry carries 8s')
  assert.match(serviceNoComments, /annotateDeadline/, 'rule 8: the annotate ref loop is bounded by one deadline (boundingBox never rides the 30s default)')
  assert.match(serviceNoComments, /AGENT_SNAPSHOT_TIMEOUT_MS/, 'snapshots carry an explicit timeout instead of the 30s default')
  iron(8, 'source', ruleSourceMessage[8])
  assert.match(serviceNoComments, /document\.elementFromPoint/, 'rule 9: element lookup runs inside the page')

  // AX hit verification is the sole CDP hit-test exception, confined to cdpNodeAt.
  const hitTestCalls = [...serviceNoComments.matchAll(/DOM\.getNodeForLocation/g)]
  assert.equal(hitTestCalls.length, 1, 'rule 9: DOM.getNodeForLocation appears exactly once — the ax hit-test')
  const hitTestHelperStart = serviceNoComments.indexOf('private async cdpNodeAt(')
  const hitTestHelperEnd = serviceNoComments.indexOf('private async nodeCoversTarget(')
  assert.ok(
    hitTestHelperStart !== -1 && hitTestHelperEnd > hitTestHelperStart
      && hitTestCalls[0].index > hitTestHelperStart && hitTestCalls[0].index < hitTestHelperEnd,
    'rule 9: the single getNodeForLocation call sits inside cdpNodeAt — verification only, never the coordinate source',
  )
  assert.match(serviceNoComments, /DOM\.getBoxModel/, 'rule 9: ax coordinates come from DOM.getBoxModel, read immediately before the hit-test')
  iron(9, 'source', ruleSourceMessage[9])
  assert.match(serviceNoComments, /ELECTRON_RECONCILE_INTERVAL_MS \* 2/, 'rule 13: closingTargetIds grants a two-poll grace')
  // The page-event path must SKIP foreign targets (real popup windows included) and
  // never register one: the registry holds only marker/seen-reported pane pages.
  const foreignSkipStart = serviceNoComments.indexOf('private skipForeignTarget(')
  assert.ok(foreignSkipStart !== -1, 'rule 13: the page-event path skips foreign targets')
  assert.doesNotMatch(
    serviceNoComments.slice(foreignSkipStart, foreignSkipStart + 1_200),
    /registerRuntimePage\(/,
    'rule 13: a foreign target (popup window) is never registered as a page',
  )
  iron(13, 'source', ruleSourceMessage[13])

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
  // A capped filter: these classes are timing-dependent and harmless in ones and
  // twos, but a regression that throws one on EVERY webview teardown must not
  // hide behind the filter forever.
  // Two rail-fold cycles (3 webviews each) + strip closes + agent-row closes +
  // remount teardowns legitimately produce more per run than the original 12;
  // the cap still catches a per-teardown blow-up (every guest dying on spawn).
  const COSMETIC_EXCEPTION_CAP = 24
  for (const [kind, count] of cosmeticKinds) {
    const cap = kind === 'Electron webview teardown on the designed close path (Invalid guestInstanceId)'
      ? COSMETIC_EXCEPTION_CAP + restoreGuestTeardowns : COSMETIC_EXCEPTION_CAP
    assert.ok(count <= cap, `cosmetic exception class fired ${count} times (> ${cap}) — that is a regression, not teardown noise: ${kind}`)
  }
  const realExceptions = exceptions.filter((detail) => !cosmeticException(detail))
  assert.deepEqual(realExceptions, [], `renderer threw exceptions: ${JSON.stringify(realExceptions).slice(0, 2000)}`)
  assert.equal(assertedIronRules.size, 13, `expected exactly 13 iron-rule entries, got ${assertedIronRules.size}: ${[...assertedIronRules].join(',')}`)
  const liveRules = [...assertedIronRules].filter((rule) => results.iron.some((line) => line.startsWith(`${rule}.`) && !line.includes('[source-assertion]')))
  console.log(`SUMMARY group1 iron: ${results.iron.length}/13 re-proven (${liveRules.length} live [${liveRules.join(',')}], ${13 - liveRules.length} explicit [source-assertion]; none silently dropped)`)
  console.log(`SUMMARY group2 flow: ${results.flow.length} assertions green (attach, marker handshake, human nav + recents/history, guest Playwright primitives, file upload, download interception, popup routing, zoom dom-ready reapply)`)
  console.log(`SUMMARY group3 ui: ${results.ui.length} assertions green (pane entry + driven consent grant, find bar, annotate end-to-end, keep-alive, link-event reaction, strip close + last-page closes the rail tab, rail fold, keep-alive fold pref)`)
  console.log('TRIMS/SUBSTITUTIONS:')
  for (const trim of trims) console.log(`  - ${trim}`)
  console.log('PASS check-browser-ui')
} catch (error) {
  console.error('FAIL check-browser-ui:', error?.stack ?? error)
  if (stderr) console.error('--- app stderr (tail) ---\n' + stderr.split('\n').slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  // From here on, rejections from the dying app (dropped clients, the
  // deliberately abandoned guest close) are expected and filtered; before this
  // point none are (the allowlist predicate is gated on this flag).
  teardownStarted = true
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
  // Fail-visible accounting for the unhandledRejection filter: benign
  // teardown rejections from the app kill land DURING this teardown, so the
  // filtered counts (and any unexpected one) are reported here.
  for (const [kind, count] of benignRejectionKinds) console.log(`NOTE: ${count} benign unhandled rejection(s) (abandoned-promise allowlist): ${kind}`)
  if (unexpectedRejections > 0) console.error(`FAIL: ${unexpectedRejections} unexpected unhandled rejection(s) — not in the abandoned-promise allowlist (exit code already set)`)
  // No orphan Electron from THIS run: nothing carrying the temp root survives.
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    const orphans = stdout.split('\n').filter((line) => line.includes(temporary))
    assert.deepEqual(orphans, [], `orphan processes from this check: ${orphans.join(' | ')}`)
  } catch (error) {
    console.error('orphan check failed:', error.message)
    process.exitCode = 1
  }
  await new Promise((r) => (server ? server.close(r) : r()))
  await rm(temporary, { recursive: true, force: true })
}
