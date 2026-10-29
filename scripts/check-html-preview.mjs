/** Full HTML bytes, scoped resources and real production Electron UI/IPC.
 * Run after npm run build. Uses a temporary HOME/profile; never model calls.
 * PI_HTML_SCREENSHOT_DIR optionally retains light/dark preview screenshots. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-html-'))
const project = join(temporary, 'project')
const profile = join(temporary, 'profile')
const home = join(temporary, 'home')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let service, child, ws
let stderr = ''
const exceptions = []
const html = label => `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<link rel="stylesheet" href="/assets/style.css"></head><body>
<h1>${label}</h1><img id="picture" src="assets/picture.svg"><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>
<a id="next" href="second.htm">Next page</a><a id="new" target="_blank" href="second.htm">New page</a>
<script type="module" src="assets/main.js"></script>
<!--${'padding '.repeat(75_000)}--><p id="tail">Complete HTML beyond the source limit</p></body></html>`

// Node DNS need not resolve *.localhost; Chromium does. Probe the server with
// the capability Host header while connecting directly to its loopback socket.
function request(url, path, headers = {}, method = 'GET') {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: target.port, path: path ?? target.pathname,
      method, headers: { Host: target.host, ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject); req.end()
  })
}

try {
  await mkdir(join(project, 'assets'), { recursive: true })
  await mkdir(profile); await mkdir(home)
  await writeFile(join(project, 'index.html'), html('HTML fixture'))
  await writeFile(join(project, 'second.htm'), '<!doctype html><h1>Second page</h1>')
  await writeFile(join(project, 'assets/style.css'), 'h1{color:rgb(12,34,56)} body{font-family:sans-serif;background:#fff;color:#123;padding:20px} #tail{margin-top:1200px}')
  await writeFile(join(project, 'assets/picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>')
  await writeFile(join(project, 'assets/data.json'), '{"value":42}')
  await writeFile(join(project, 'assets/module.js'), 'export const value=7;')
  await writeFile(join(project, 'assets/main.js'), "import {value} from './module.js';window.moduleValue=value;fetch('./assets/data.json').then(r=>r.json()).then(v=>window.dataValue=v.value)")
  await writeFile(join(project, '.env'), 'PRIVATE_SENTINEL')
  await writeFile(join(temporary, 'secret.json'), 'OUTSIDE_SENTINEL')
  await symlink(join(temporary, 'secret.json'), join(project, 'assets/escape.json'))
  await symlink(temporary, join(project, 'outside'))
  await writeFile(join(project, 'space #中文%.HTML'), '<h1>Encoded path</h1>')
  await writeFile(join(project, 'empty.html'), '')
  execFileSync('git', ['init', '-q', project])
  execFileSync('git', ['-C', project, 'add', 'second.htm'])
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  await writeFile(join(project, 'second.htm'), '<!doctype html><h1>Second page updated</h1>')

  await build({ entryPoints: [join(repo, 'src/main/html-preview.ts')], outfile: join(temporary, 'service.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { HtmlPreviewService } = await import(pathToFileURL(join(temporary, 'service.mjs')))
  service = new HtmlPreviewService()
  const open = path => service.open({ cwd: project, path })
  const preview = await open('index.html')
  assert.ok(preview.url)
  assert.equal((await open('second.htm')).url.replace('/second.htm', ''), new URL(preview.url).origin)
  assert.equal((await request(preview.url)).body, html('HTML fixture'))
  assert.equal((await request(preview.url, '/assets/main.js')).headers['content-type'], 'text/javascript')
  assert.equal((await request(preview.url, '/assets/data.json')).body, '{"value":42}')
  const encoded = await open('space #中文%.HTML')
  assert.equal((await request(encoded.url)).body, '<h1>Encoded path</h1>')
  for (const path of ['/.env', '/%2e%2e/secret.json', '/assets/escape.json', '/outside/secret.json', '/assets%2fescape.json', '/%5c..%5csecret.json', '/C:/secret.json']) {
    assert.equal((await request(preview.url, path)).status, 403, `blocked ${path}`)
  }
  assert.equal((await request(preview.url, '/', { Host: 'attacker.invalid' })).status, 403)
  assert.equal((await request(preview.url, '/', { Origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await request(preview.url, '/', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await request(preview.url, '/assets/main.js', { 'Service-Worker': 'script' })).status, 403)
  assert.equal((await request(preview.url, '/', {}, 'POST')).status, 405)
  assert.equal((await request(preview.url, '/missing.html')).status, 404)
  assert.equal((await request(preview.url, '/assets/data.json', { Range: 'bytes=0-4' })).body, '{"val')
  assert.equal((await request(preview.url, '/assets/data.json', { Range: 'bytes=999-' })).status, 416)
  assert.equal((await request(preview.url, '/assets/data.json', {}, 'HEAD')).body, '')
  assert.equal((await open('assets/data.json')).error, 'unreadable')
  assert.equal((await open('missing.html')).error, 'missing')
  const alias = join(temporary, 'alias')
  await symlink(project, alias)
  assert.equal((await service.open({ cwd: alias, path: 'index.html' })).url, preview.url, 'canonical roots share one grant')
  await service.dispose()
  assert.equal((await open('index.html')).error, 'unreadable')
  console.log('PASS: full HTML, MIME/ranges/HEAD, encoded paths, aliases, confinement, request isolation and disposal')

  // Launch the production app, changing only its userData path as the browser
  // integration check does. Real main handlers, preload, FilesPane, BrowserPane.
  const appTree = join(temporary, 'out')
  await cp(join(repo, 'out'), appTree, { recursive: true })
  await cp(join(repo, 'resources'), join(appTree, 'main/resources'), { recursive: true })
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const entry = join(appTree, 'main/index.mjs')
  const source = await readFile(entry, 'utf8')
  const needle = 'join(app.getPath("appData"), "pi-app")'
  assert.equal(source.split(needle).length - 1, 1)
  await writeFile(entry, source.replace(needle, JSON.stringify(profile)))
  await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ cwd: project, folders: [project], startup: 'new', contextFiles: false, browserConsent: false, browserAgentToolsEnabled: false }))
  const portProbe = createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const endpoint = `http://127.0.0.1:${port}`
  const env = { ...process.env, HOME: home, PITH_CDP_PORT: String(port) }
  delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [entry], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', data => { stderr += data })
  const until = async (predicate, label, timeout = 20_000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await predicate()) return; await pause(80) }
    throw new Error(`Timeout: ${label}\n${exceptions.join('\n')}\n${stderr.slice(-3000)}`)
  }
  let target
  await until(async () => {
    try { target = (await (await fetch(endpoint + '/json/list')).json()).find(t => t.type === 'page' && t.url.startsWith('file:')); return !!target } catch { return false }
  }, 'app startup', 30_000)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data)
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id) }
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 15_000)
    pending.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result?.value
  }
  const wait = (expression, label) => until(() => evaluate(`Boolean(${expression})`), label)
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  let expectedGuestPath
  const guest = async expression => {
    let value
    // Switching views and refreshing files can replace the webview after a
    // DOM predicate matched its predecessor. Reacquire the attached, loaded
    // guest on each attempt; never invoke a method on a missing/remounting node.
    await until(async () => {
      const result = await evaluate(`(async()=>{
        const view=document.querySelector('[data-file-html] webview');
        if(!view)return {ready:false};
        try{const url=new URL(view.getURL());if(url.protocol!=='http:'||view.isLoading())return {ready:false};if(${JSON.stringify(expectedGuestPath ?? null)}!==null&&decodeURIComponent(url.pathname)!==${JSON.stringify(expectedGuestPath ?? null)})return {ready:false}}catch{return {ready:false}};
        try{return await view.executeJavaScript(${JSON.stringify(`(()=>{if(document.readyState==='loading')return {ready:false};return {ready:true,value:(${expression})}})()`)})}
        catch(error){if(!view.isConnected||/The WebView must be attached|Object has been destroyed|Invalid guestInstanceId/.test(String(error)))return {ready:false};throw error}
      })()`)
      if (!result?.ready) return false
      value = result.value
      return true
    }, 'HTML guest attached and loaded')
    return value
  }
  await send('Runtime.enable')
  await wait('document.body.innerText.length > 50', 'shell')
  await evaluate('localStorage.setItem("pi-app:locale","en");localStorage.setItem("pi-app:reduce-motion","true")')
  await send('Page.reload') // shell only, before any guest
  await wait(`document.documentElement?.lang === 'en' && document.querySelector('[aria-label="Toggle sidebar"]')`, 'English shell')
  if (!await evaluate('!!document.querySelector("[data-panel=right]")')) await click('[aria-label="Toggle sidebar"]')
  await evaluate(`Array.from(document.querySelectorAll('[data-panel=right] button')).find(b=>Array.from(b.querySelectorAll('span')).some(s=>s.textContent.trim()==='Files')).click()`)
  await wait('document.querySelector("[data-file-tree]")?.textContent.includes("index.html")', 'file tree')
  const openTreeFile = async name => {
    await evaluate(`Array.from(document.querySelectorAll('[data-file-tree] [role=treeitem]')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)} || b.textContent.trim()===${JSON.stringify(name)}).click()`)
    expectedGuestPath = '/' + name
  }
  await openTreeFile('index.html')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'HTML preview')
  await until(() => guest('window.moduleValue === 7 && window.dataValue === 42 && document.querySelector("#picture").naturalWidth === 40'), 'modules, fetch and image')
  assert.equal(await guest('getComputedStyle(document.querySelector("h1")).color'), 'rgb(12, 34, 56)')
  assert.equal(await guest('!!document.querySelector("#tail")'), true)
  assert.deepEqual(await guest('[typeof window.pi,typeof require,typeof process]'), ['undefined', 'undefined', 'undefined'])
  assert.equal(await guest('getComputedStyle(document.body).scrollbarWidth'), 'none')
  await guest('document.querySelector("#counter").click()')
  assert.equal(await guest('document.querySelector("#counter").textContent'), '1')
  assert.equal(await evaluate('document.querySelector("[data-file-view-tabs] [aria-selected=true]").textContent'), 'Preview')
  assert.equal(await evaluate('document.querySelector("[data-files-pane]").innerText.includes("Showing the first")'), false)
  const url = await guest('location.href')
  await guest('localStorage.setItem("preview-only","isolated")')
  assert.equal((await evaluate('window.pi.browserStatus()')).consentRequired, true, 'file preview does not grant browser consent')
  console.log('PASS: production IPC/UI renders full HTML, modules, CSS, images and interactions without the app bridge or scrollbar chrome')

  const view = name => evaluate(`Array.from(document.querySelectorAll('[data-file-view-tabs] [role=tab]')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
  await view('Source')
  await wait('document.querySelector("[data-file-source]")', 'source')
  await wait('document.querySelector("[data-files-pane]").innerText.includes("Showing the first")', 'source truncation only')
  await openTreeFile('second.htm')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'HTM preview')
  await view('Diff')
  await wait('document.querySelector("[data-file-diff]")?.textContent.includes("Second page updated")', 'HTML git diff')
  await openTreeFile('index.html')
  await wait('document.querySelector("[data-file-source]")', 'remembered source view')
  await view('Preview')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'return to preview')
  await writeFile(join(project, 'index.html'), html('Refreshed HTML'))
  await writeFile(join(project, 'assets/style.css'), 'h1{color:rgb(78,90,12)} body{font-family:sans-serif;padding:20px} #tail{margin-top:1200px}')
  await click('[aria-label="Refresh files"]')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'refresh')
  await until(() => guest('document.querySelector("h1")?.textContent === "Refreshed HTML" && getComputedStyle(document.querySelector("h1")).color === "rgb(78, 90, 12)"'), 'fresh HTML and stylesheet')
  if (process.env.PI_HTML_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_HTML_SCREENSHOT_DIR, { recursive: true })
    for (const dark of [false, true]) {
      await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
      await pause(120)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(process.env.PI_HTML_SCREENSHOT_DIR, `html-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'))
    }
  }
  console.log('PASS: source/preview/diff, remembered selection, source cap and refresh of HTML plus assets')

  await click('[aria-label="Open in embedded browser"]')
  await wait('document.querySelector("[data-browser-consent]")', 'browser consent preserves pending URL')
  // Consent remains the browser's existing one-time user action.
  await evaluate('document.querySelector("[data-browser-consent] button").click()')
  await until(async () => {
    const status = await evaluate('window.pi.browserStatus()')
    return status.pages?.some(p => p.url === url)
  }, 'preview opened in browser', 30_000)
  const browserGuestExpression = `Array.from(document.querySelectorAll('[data-browser-pane] webview')).find(w=>{try{return w.getURL()===${JSON.stringify(url)}}catch{return false}})`
  await wait(browserGuestExpression, 'browser guest finished attaching')
  // Closing/unmounting the file pane cannot revoke the browser's resource URL.
  assert.equal((await request(url)).status, 200)
  assert.equal(await evaluate(`${browserGuestExpression}.executeJavaScript('localStorage.getItem("preview-only")')`), null, 'file preview storage is separate from the signed-in browser')
  console.log('PASS: one-click handoff survives first-use consent and file-pane unmount in the real embedded browser')

  const returnToFile = async () => {
    await click(`[data-sidebar-tab="file:${project}/index.html"] [role=tab]`)
    await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'return from browser')
  }
  for (const linkId of ['next', 'new']) {
    await returnToFile()
    const before = (await evaluate('window.pi.browserStatus()')).pages.length
    await evaluate('window.__htmlLinks=[];window.pi.onHtmlPreviewLink(link=>window.__htmlLinks.push(link))')
    await evaluate('window.__htmlConsole=[];document.querySelector("[data-file-html] webview").addEventListener("console-message",e=>window.__htmlConsole.push(e.message))')
    await guest(`document.querySelector('#${linkId}').click()`)
    await until(async () => {
      const status = await evaluate('window.pi.browserStatus()')
      return status.pages.length > before && status.pages.some(p => p.url === new URL('second.htm', url).href)
    }, `${linkId} link opens in browser`, 30_000).catch(async error => {
      console.log('Link diagnostics', await evaluate('JSON.stringify({links:window.__htmlLinks,html:document.querySelector("[data-file-html]")?.innerText})'))
      console.log('Browser status', await evaluate('window.pi.browserStatus()'))
      console.log('Guest diagnostics', await evaluate('JSON.stringify({console:window.__htmlConsole,url:document.querySelector("[data-file-html] webview")?.getURL()})'))
      throw error
    })
    assert.equal(await evaluate('location.protocol'), 'file:', 'the app shell never navigates')
  }
  await returnToFile()
  await openTreeFile('empty.html')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'empty HTML')
  assert.equal(await guest('document.body.innerText'), '')
  await openTreeFile('space #中文%.HTML')
  await wait('document.querySelector("[data-file-html] webview") && !document.querySelector("[data-file-html] [role=status]")', 'encoded path preview')
  assert.equal(await guest('document.querySelector("h1").textContent'), 'Encoded path')
  await rm(join(project, 'space #中文%.HTML'))
  await click('[aria-label="Refresh files"]')
  await wait('document.querySelector("[data-file-html][role=status]")', 'missing file state')
  console.log('PASS: same-window/new-window links hand off, empty/encoded HTML works, deleted file reports an error')

  // Same narrow, capped Electron isolated-world teardown allowance as
  // check-browser-ui. Every visible guest was independently proved loaded above.
  const cosmetic = detail => detail.url === 'node:electron/js2c/isolated_bundle' &&
    detail.exception?.className === 'Error' && /^Error: Invalid guestInstanceId: \d+/.test(detail.exception.description ?? '')
  const teardown = exceptions.filter(cosmetic)
  assert.ok(teardown.length <= 24, 'bounded Electron teardown noise')
  if (teardown.length) console.log(`NOTE: ${teardown.length} known Electron guest teardown exceptions (same allowance as browser UI checks)`)
  assert.deepEqual(exceptions.filter(detail => !cosmetic(detail)), [])
  assert.equal(stderr.includes('[Pith] Unhandled rejection:'), false, stderr.slice(-3000))
  console.log('All HTML preview checks passed.')
} finally {
  await service?.dispose()
  try { ws?.close() } catch {}
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(4000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await rm(temporary, { recursive: true, force: true }).catch(() => {})
}
