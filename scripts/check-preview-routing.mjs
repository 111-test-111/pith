/** The file pane's preview routing table and the families it gained: one
 * `previewKindOf` decides the reader, patch files render as diffs, notebooks,
 * JSON documents, subtitles and fonts get their own bodies, and no non-text
 * kind can reach `files:document`. Isolated data, no model calls, no network.
 * Run after building: node scripts/check-preview-routing.mjs
 * `PI_PREVIEW_SCREENSHOT_DIR` retains screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, symlink } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-preview-'))
const project = join(temporary, 'project')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A 1×1 transparent PNG: the notebook's inline image output has to really
 * decode, and decoding is what proves the data URL was assembled right. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const PATCH = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export {}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const created = true
+export {}
`
const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello <i>world</i>

2
00:00:04,000 --> 00:00:06,000
Second line
continues here
`
const VTT = `WEBVTT

NOTE this block is a comment, not a cue

cue-1
00:01.000 --> 00:03.000 align:start position:0%
First cue

00:04.000 --> 00:06.000
Second cue
`
const LRC = `\ufeff[ti:Preview fixture]
[ar:Example]
[00:12.34][00:42.345]重复的歌词
[00:06.5]第一行歌词
[00:06.500]First lyric line
[01:02]<01:02.00>逐字<01:02.50>歌词
[00:08.00]
[00:99.00]invalid seconds
untimed text
[offset:+250]
`.replaceAll('\n', '\r\n')
function notebook() {
  return JSON.stringify({
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Notebook title\n\nA **bold** claim.\n'] },
      {
        cell_type: 'code',
        execution_count: 7,
        metadata: {},
        source: ["print('hi')\n", 'answer'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
          { output_type: 'execute_result', data: { 'text/plain': ['42'] }, metadata: {}, execution_count: 7 },
          { output_type: 'display_data', data: { 'image/png': TINY_PNG }, metadata: {} },
          { output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['Traceback (most recent call last):', 'ValueError: boom'] }
        ]
      },
      { cell_type: 'code', execution_count: 8, metadata: {}, source: ['no_output = 1'], outputs: [] }
    ],
    metadata: { kernelspec: { language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5
  }, null, 1)
}

/** The JSON fixture exercises every value kind, a folded long string, a
 * paginated wide array and a depth-2 container — and it carries a BOM, which
 * the pane must strip before `JSON.parse` can read the document at all. */
const DATA_JSON = '\uFEFF' + JSON.stringify({
  name: 'preview-fixture',
  version: 1.5,
  stable: true,
  archived: false,
  meta: null,
  tags: ['alpha', 'beta'],
  empty_object: {},
  empty_array: [],
  nested: { deep: { deeper: { value: 'bottom' } } },
  long_string: 'x'.repeat(600),
  wide: Array.from({ length: 150 }, (_, index) => ({ index })),
  unicode: '结构化预览 🌳'
}, null, 2)

/** A bushy three-level document (~100k values, kept compact): even the
 * default view exceeds the full-render limit, and "expand all" flattens past
 * the row budget — so a huge file gets the virtual window and the cutoff row
 * instead of an unbounded DOM. Shared references serialize per occurrence. */
const HUGE_LEAF = Array.from({ length: 10 }, (_, n) => n)
const HUGE_BRANCH = Object.fromEntries(Array.from({ length: 100 }, (_, m) => [`m${m}`, HUGE_LEAF]))
const HUGE_JSON = JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`k${k}`, HUGE_BRANCH])))

let server, child, ws
const docPaths = []
try {
  await mkdir(project)
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  await writeFile(join(project, 'changes.patch'), PATCH)
  await writeFile(join(project, 'notes.ipynb'), notebook())
  await writeFile(join(project, 'data.json'), DATA_JSON)
  await writeFile(join(project, 'broken.json'), '{ "cut": ')
  await writeFile(join(project, 'huge.json'), HUGE_JSON)
  await writeFile(join(project, 'captions.srt'), SRT)
  await writeFile(join(project, 'captions.vtt'), VTT)
  await writeFile(join(project, 'lyrics.lrc'), LRC)
  await writeFile(join(project, 'untimed.lrc'), '[ti:Untimed]\n没有时间戳的歌词\n')
  await writeFile(join(project, 'diagram.svgz'), gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="#0f0"/></svg>')))
  // Extension-only fixtures: the protocol answers from its MIME table, and the
  // pane must never read them as text.
  await writeFile(join(project, 'audiobook.m4b'), Buffer.alloc(4096, 3))
  await writeFile(join(project, 'still.apng'), Buffer.alloc(4096, 4))
  await writeFile(join(project, 'cursor.cur'), Buffer.alloc(4096, 5))
  await writeFile(join(project, 'still.heic'), Buffer.alloc(4096, 6))
  // A real font, so the preview proves it loaded rather than merely mounted.
  const fontSource = fileURLToPath(import.meta.resolve('temml/dist/Temml.woff2'))
  await copyFile(fontSource, join(project, 'Temml.woff2'))
  const fontBytes = (await readFile(join(project, 'Temml.woff2'))).byteLength

  // 0. The routing table itself, before anything is spawned: this is the one
  //    place the pane, the document reader and the protocol agree.
  await build({ entryPoints: [join(repo, 'src/shared/preview.ts')], outfile: join(temporary, 'preview.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const preview = await import(pathToFileURL(join(temporary, 'preview.mjs')).href)
  const { previewKindOf, isMediaKind, readsAsText, hasPreviewView, isInlineOnly, textReadLimit, opensOnPreview, opensInFilePane, TEXT_READ_BYTES, JSON_READ_BYTES } = preview
  // [kind, opens on the rendered view, read as text, takes the pane alone].
  // `hasPreviewView(kind)` is asserted to agree with the second column in every
  // row, which is what keeps "owns a preview view" a single fact.
  const textRow = ['text', false, true, false]
  const rendered = (kind) => [kind, true, true, false]
  const inline = (kind) => [kind, false, kind === 'text', true]
  const expected = {
    '/a/b.ts': textRow, '/a/b.txt': textRow, '/a/b.xls': textRow, '/a/env': textRow, '/a/Makefile': textRow, '/a/.env': textRow,
    '/a/b.md': rendered('markdown'), '/a/b.markdown': rendered('markdown'), '/a/b.mdx': rendered('markdown'),
    '/a/b.html': rendered('html'), '/a/b.HTM': rendered('html'),
    '/a/b.csv': rendered('table'), '/a/b.tsv': rendered('table'), '/a/b.psv': rendered('table'),
    '/a/b.xlsx': inline('spreadsheet'), '/a/b.xlsm': inline('spreadsheet'), '/a/b.pdf': inline('pdf'),
    '/a/b.png': inline('image'), '/a/b.apng': inline('image'), '/a/b.jpe': inline('image'),
    '/a/b.cur': inline('image'), '/a/b.svgz': inline('image'), '/a/b.mkv': inline('video'),
    '/a/b.m4b': inline('audio'), '/a/b.flac': inline('audio'),
    '/a/b.patch': rendered('diff'), '/a/b.diff': rendered('diff'),
    '/a/b.ipynb': rendered('notebook'), '/a/b.json': rendered('json'), '/a/b.JSON': rendered('json'), '/a/b.srt': rendered('subtitle'), '/a/b.vtt': rendered('subtitle'),
    '/a/b.jsonc': rendered('structured'), '/a/b.jsonl': rendered('structured'), '/a/b.ndjson': rendered('structured'),
    '/a/b.yaml': rendered('structured'), '/a/b.yml': rendered('structured'), '/a/b.toml': rendered('structured'), '/a/b.xml': rendered('structured'),
    '/a/b.zip': inline('archive'), '/a/b.tar': inline('archive'), '/a/b.tar.gz': inline('archive'), '/a/b.tgz': inline('archive'), '/a/b.gz': inline('archive'),
    '/a/b.parquet': inline('data'), '/a/b.sqlite': inline('data'), '/a/b.sqlite3': inline('data'), '/a/b.db': inline('data'),
    '/a/b.lrc': rendered('subtitle'), '/a/b.LRC': rendered('subtitle'),
    '/a/b.ttf': inline('font'), '/a/b.otf': inline('font'), '/a/b.woff': inline('font'), '/a/b.woff2': inline('font'),
    '/a/b.heic': inline('unplayable'), '/a/b.avi': inline('unplayable')
  }
  for (const [path, [kind, openOnPreview, readAsText, alone]] of Object.entries(expected)) {
    assert.equal(previewKindOf(path), kind, `kind of ${path}`)
    assert.equal(opensOnPreview(path), openOnPreview, `default view of ${path}`)
    assert.equal(hasPreviewView(previewKindOf(path)), openOnPreview, `preview view of ${path}`)
    assert.equal(readsAsText(previewKindOf(path)), readAsText, `text read of ${path}`)
    assert.equal(isInlineOnly(previewKindOf(path)), alone, `inline-only of ${path}`)
  }
  // A path with no extension, and a dotfile, stay text: the fallback has to be
  // the text reader, which is what reports "binary" for bytes it cannot decode.
  assert.equal(previewKindOf('/a/thing'), 'text')
  assert.equal(previewKindOf('/a/.gitignore'), 'text')
  for (const path of ['/a/b.jsonl', '/a/b.jsonc']) assert.equal(previewKindOf(path), 'structured', `${path} has a structured preview and source`)
  assert.equal(previewKindOf('/a/b.PNG'), 'image', 'matching stays case-insensitive')
  assert.equal(isMediaKind(previewKindOf('/a/b.mp4')), true)
  assert.equal(isMediaKind(previewKindOf('/a/b.pdf')), false)
  assert.equal(textReadLimit('notebook'), JSON_READ_BYTES, 'a notebook is read whole')
  assert.equal(textReadLimit('json'), JSON_READ_BYTES, 'a JSON document is read whole')
  assert.equal(textReadLimit('text'), TEXT_READ_BYTES)
  // The unplayable list must never claim an extension that is also source.
  for (const path of ['/a/b.ts', '/a/b.mts', '/a/b.dts', '/a/b.tif.psd.txt']) assert.equal(previewKindOf(path), 'text', 'never unplayable: ' + path)
  assert.equal(opensInFilePane('/a/b.md'), true, 'a text link opens in the pane')
  assert.equal(opensInFilePane('/a/b.heic'), false, 'an unplayable medium goes to the system')
  console.log('PASS: previewKindOf routes every family, and only text kinds are readable as text')

  const fixturePath = '/__preview_check.html'
  const fixture = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {FilesPane} from '/src/components/app/FilesPane.tsx';
import {parseCues} from '/src/components/app/FileSubtitle.tsx';
import {initFonts,useFontSettings} from '/src/lib/fonts.ts';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';import {FileBrowserStore} from '/src/state/file-browser-store.ts';
import {DebugStore} from '/src/state/debug-store.ts';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';
import '/src/styles.css';
initFonts();
// Only seed the locale: overwriting it on every load would undo a switch that
// survives through a real reload.
if(!localStorage.getItem('pi-app:locale'))localStorage.setItem('pi-app:locale','en');
const cwd=${JSON.stringify(project)};
const files=new FileBrowserStore(),pi=new PiStore(),debug=new DebugStore();
pi.applySnapshot({cwd,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
const App=()=>{const [,setFonts]=useFontSettings();window.setFonts=setFonts;const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);return React.createElement(FilesPane,{files,store:pi,filePath:state.active,debug})};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement(App)))));
window.cwd=cwd;window.files=files;window.en=en;window.zh=zh;
window.parseCues=parseCues;
window.openFile=name=>files.open(cwd,{path:cwd+'/'+name});
window.setLocale=value=>{localStorage.setItem('pi-app:locale',value);location.reload()};
window.__ready=true;</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'preview-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== fixturePath) return next(); try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) } }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()

  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain,net,protocol} from 'electron';import fs from 'node:fs';
import {listFileDirectory,readFileDocument} from ${JSON.stringify(join(repo, 'src/main/file-browser.ts'))};
import {readFontData} from ${JSON.stringify(join(repo, 'src/main/font.ts'))};
import {registerMediaScheme,installMediaProtocol} from ${JSON.stringify(join(repo, 'src/main/media-protocol.ts'))};
import {mediaUrl} from ${JSON.stringify(join(repo, 'src/shared/media.ts'))};
import {previewKindOf,isMediaKind} from ${JSON.stringify(join(repo, 'src/shared/preview.ts'))};
registerMediaScheme();
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const project=${JSON.stringify(project)};
app.whenReady().then(async()=>{
  installMediaProtocol();
  // The protocol is probed from the main process: net.fetch reaches a custom
  // scheme without the renderer's filtering, so a media element's own answer is
  // readable here.
  const probe={};
  for (const name of ['still.apng','cursor.cur','audiobook.m4b','diagram.svgz']) {
    try { const r=await net.fetch(mediaUrl(project+'/'+name)); const body=Buffer.from(await r.arrayBuffer()); probe[name]=[r.status,r.headers.get('content-type'),r.headers.get('content-encoding'),r.headers.get('accept-ranges'),body.length,body.subarray(0,16).toString('utf8')] }
    catch(error){ probe[name]=String(error) }
  }
  // The same MIME table has to be what the pane routes on, for every extension.
  probe.kinds=Object.fromEntries(['still.apng','cursor.cur','audiobook.m4b','diagram.svgz'].map(name=>[name,[previewKindOf(project+'/'+name),isMediaKind(previewKindOf(project+'/'+name))]]));
  console.log('[probe]',JSON.stringify(probe));
  ipcMain.handle('app:info',()=>({cwd:project,folders:[project],contextFiles:true,version:'test',bashMaxWaitMs:10000,checkpointsEnabled:false}));
  ipcMain.handle('files:directory',(_,r,offset)=>listFileDirectory(r,offset));
  ipcMain.handle('files:document',(_,r)=>{console.log('[doc]',r.path);return readFileDocument(r)});
  ipcMain.handle('files:fontData',(_,r)=>{console.log('[font]',r.path);return readFontData(r)});
  ipcMain.handle('files:gitDiff',()=>({gitRoot:null,patch:'',binary:false}));
  ipcMain.handle('files:saveCopy',()=>({status:'cancelled'}));ipcMain.handle('shell:showInFolder',()=>{});ipcMain.handle('shell:openPath',()=>'');
  const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});
app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })

  child = spawn(electron, [main], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let probe = null
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    for (const match of String(chunk).matchAll(/\[doc\] (.+)/g)) docPaths.push(match[1].trim())
    const found = /\[probe\] (.+)/.exec(String(chunk))
    if (found) probe = JSON.parse(found[1])
  })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ' ' + stderr)) })
    child.stderr.on('data', (chunk) => { stderr += chunk; const match = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pendingMessages = new Map()
  const exceptions = []
  // A React render error tears the root down without necessarily raising a
  // runtime exception, so console errors are collected too — otherwise a blank
  // page reports only "Timeout".
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.id) { pendingMessages.get(m.id)?.(m); pendingMessages.delete(m.id) }
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push(m.params.args.map(arg => arg.description ?? arg.value).join(' '))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pendingMessages.set(id, (m) => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
  const waitFor = async (expression, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await pause(50) } throw new Error('Timeout: ' + label + ' :: ' + await evaluate('document.body.innerText') + ' ' + JSON.stringify(exceptions)) }
  const open = async (name) => { await evaluate(`window.openFile(${JSON.stringify(name)})`); await pause(200) }
  const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(120) }
  /** Switch locale through a real reload. Waiting on `__ready` alone would be
   * satisfied by the page being torn down — the old document still answers
   * until the navigation commits — so the load event is what is awaited. */
  const reload = async (locale) => {
    const loaded = new Promise((resolve) => {
      const handler = (event) => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', handler); resolve() } }
      ws.addEventListener('message', handler)
    })
    await evaluate(`window.setLocale(${JSON.stringify(locale)})`)
    await loaded
    await waitFor('window.__ready && document.querySelector("[data-files-pane]")', 'reloaded in ' + locale)
  }
  const paneText = () => evaluate('document.querySelector("[data-file-preview]").innerText')
  await waitFor('window.__ready && document.querySelector("[data-files-pane]")', 'pane mounted')

  // 1. Every extension the media table gained is served by the protocol with
  //    the exact content type the element needs.
  assert.equal(probe['still.apng'][0], 200, 'apng is served')
  assert.equal(probe['still.apng'][1], 'image/apng', 'apng content type')
  assert.equal(probe['cursor.cur'][1], 'image/x-icon', 'cur is served as an icon')
  assert.equal(probe['audiobook.m4b'][1], 'audio/mp4', 'm4b is an audio book')
  assert.equal(probe['diagram.svgz'][1], 'image/svg+xml', 'svgz is SVG')
  // The stored bytes must NOT be handed over with `content-encoding: gzip`:
  // Chromium ignores that header on a custom-scheme response, so the <img>
  // receives a gzip stream and fails to decode. The handler inflates it.
  assert.equal(probe['diagram.svgz'][2], null, 'svgz is not served gzip-encoded')
  assert.equal(probe['diagram.svgz'][3], null, 'an inflated medium offers no ranges')
  assert.ok(String(probe['diagram.svgz'][5]).startsWith('<svg'), 'svgz arrives as the SVG it stores: ' + JSON.stringify(probe['diagram.svgz'][5]))
  assert.notEqual(probe['diagram.svgz'][4], (await readFile(join(project, 'diagram.svgz'))).byteLength, 'the inflated bytes are not the stored bytes')
  assert.equal(probe['still.apng'][3], 'bytes', 'a plain medium still honours ranges')
  for (const name of ['still.apng', 'cursor.cur', 'audiobook.m4b', 'diagram.svgz']) {
    const [kind, media] = probe.kinds[name]
    assert.equal(media, true, name + ' routes to a media element')
    assert.equal(kind, name.endsWith('.svgz') || name.endsWith('.apng') || name.endsWith('.cur') ? 'image' : 'audio', name + ' kind')
  }
  console.log('PASS: apng/cur/m4b served with their own MIME, svgz inflated and decoded')

  // 2. A gzip-stored medium has to reach the element as a decodable image — the
  //    protocol answer above is only half the claim, and the half that let a
  //    `content-encoding: gzip` response look correct while every <img> failed.
  await open('diagram.svgz')
  await waitFor('document.querySelector("[data-file-media=image] img")', 'svgz image mounted')
  const svgz = await evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');return {w:img.naturalWidth,h:img.naturalHeight,failed:document.querySelector('[data-file-preview]').innerText.includes(window.en['files.media.failed'])}})()`)
  assert.ok(svgz.w > 0 && svgz.h > 0, 'the gzipped SVG really decodes: ' + JSON.stringify(svgz))
  assert.equal(svgz.failed, false, 'and never lands on the decode-failure notice')
  // A medium with no decoder in this engine keeps its own notice and never
  // mounts an element that could only fail.
  await open('still.heic')
  await waitFor(`document.querySelector('[data-file-preview]').innerText.includes(window.en['files.media.unsupported'])`, 'unsupported notice')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-media]').length`), 0, 'an unplayable medium mounts no element')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-view-tabs]').length`), 0, 'and takes the pane without view tabs')
  console.log('PASS: .svgz decodes in the pane; an unplayable medium shows its notice and mounts nothing')

  // 3. A patch file opens on its rendered diff, split per file, with counts and
  //    a working collapse.
  await open('changes.patch')
  await waitFor('document.querySelector("[data-file-diff-preview]")', 'patch preview')
  const selected = await evaluate(`document.querySelector('[data-file-view-tabs] [role=tab][aria-selected=true]').textContent`)
  assert.equal(selected, await evaluate('window.en["files.preview"]'), 'a patch opens on its preview view')
  const files = await evaluate(`[...document.querySelectorAll('[data-diff-file]')].map(section=>[...section.querySelectorAll('[data-review-file-header]')].map(h=>h.innerText))`)
  assert.equal(files.length, 2, 'one section per file in the patch')
  assert.ok(files[0][0].includes('src/app.ts'), 'first section names its file: ' + files[0][0])
  assert.ok(files[1][0].includes('src/new.ts'), 'second section names its file: ' + files[1][0])
  const stats = await evaluate(`[...document.querySelectorAll('[data-review-stats]')].map(node=>node.innerText.replace(/\\s+/g,''))`)
  assert.deepEqual(stats, ['+2−1', '+2'], 'each file keeps its own counts, and a zero side is not printed: ' + JSON.stringify(stats))
  const lines = await evaluate(`document.querySelectorAll('[data-review-diff] [data-file-diff], [data-review-diff]').length`)
  assert.ok(lines >= 2, 'both bodies are mounted')
  await click('[data-diff-file] [data-review-file-header] button')
  assert.equal(await evaluate(`document.querySelector('[data-diff-file] [data-review-file-header] button').getAttribute('aria-expanded')`), 'false', 'a section header collapses its body')
  assert.equal(await evaluate(`document.querySelectorAll('[data-diff-file]')[0].querySelectorAll('[data-review-diff]').length`), 0, 'the collapsed body is gone, not hidden')
  await click('[data-diff-file] [data-review-file-header] button')
  await waitFor(`document.querySelectorAll('[data-diff-file]')[0].querySelectorAll('[data-review-diff]').length === 1`, 'section expands again')
  console.log('PASS: .patch renders per-file diff sections with counts and collapse')

  // 4. A notebook renders its cells: Markdown through the app's renderer, code
  //    through its highlighter, and every output kind including a real image.
  await open('notes.ipynb')
  await waitFor('document.querySelector("[data-file-notebook]")', 'notebook preview')
  assert.equal(await evaluate(`document.querySelector('[data-file-view-tabs] [role=tab][aria-selected=true]').textContent`), await evaluate('window.en["files.preview"]'), 'a notebook opens on its preview')
  assert.equal(await evaluate(`document.querySelectorAll('[data-notebook-cell]').length`), 3, 'every cell is rendered')
  assert.equal(await evaluate(`document.querySelector('[data-notebook-markdown] strong')?.textContent`), 'bold', 'the Markdown cell is rendered, not printed')
  assert.ok(await evaluate(`document.querySelector('[data-notebook-cell="1"] [data-notebook-code]') !== null`), 'the code cell renders through the app code component')
  // Shiki runs asynchronously, so its tokens are waited for: a styled token span
  // is what proves the cell was really highlighted, not printed raw.
  await waitFor(`document.querySelector('[data-notebook-code] [style*="agent-code-"]') !== null`, 'python tokens')
  assert.ok((await paneText()).includes("print('hi')"), 'the code cell keeps its source')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-notebook-output]')].some(node=>node.innerText.includes('hi'))`), 'the stream output is shown')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-notebook-output]')].some(node=>node.innerText.includes('42'))`), 'the execute_result is shown')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-notebook-output]')].some(node=>node.innerText.includes('ValueError: boom'))`), 'the traceback is shown')
  const image = await evaluate(`(()=>{const img=document.querySelector('[data-file-notebook] img');return img&&{src:img.getAttribute('src').slice(0,22),w:img.naturalWidth,h:img.naturalHeight}})()`)
  assert.ok(image && image.src.startsWith('data:image/png'), 'the image output is inlined as a data URL: ' + JSON.stringify(image))
  assert.equal(image.w, 1, 'the inline image really decodes')
  assert.equal(await evaluate(`document.querySelector('[data-notebook-cell="2"] [data-notebook-outputs]') === null`), true, 'a cell without outputs renders none')
  console.log('PASS: .ipynb renders Markdown, code, stream/result/error outputs and a decoded image')

  // 5. A JSON file renders as a collapsible tree: typed values, folded
  //    containers and strings, paged children — and a broken file gets its own
  //    notice instead of a parse error.
  await open('data.json')
  await waitFor('document.querySelector("[data-file-json]")', 'json preview')
  assert.equal(await evaluate(`document.querySelector('[data-file-view-tabs] [role=tab][aria-selected=true]').textContent`), await evaluate('window.en["files.preview"]'), 'a JSON file opens on its preview')
  assert.equal(await evaluate(`document.querySelector('[data-json-summary]').textContent`), await evaluate(`window.en['files.json.keys'].replace('{count}','12')`), 'the summary counts the root keys')
  // Every value kind is rendered, typed for its colour. The fixture's BOM
  // would have killed `JSON.parse`, so this tree existing already proves it
  // was stripped.
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-json-value="string"]')].some(n=>n.textContent.includes('preview-fixture'))`), 'a string value is shown')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-json-value="number"]')].some(n=>n.textContent.trim()==='1.5')`), 'a number value is shown')
  assert.ok(await evaluate(`document.querySelectorAll('[data-json-value="boolean"]').length >= 2`), 'both booleans are shown')
  assert.equal(await evaluate(`document.querySelector('[data-json-value="null"]')?.textContent`), 'null', 'null is shown')
  assert.ok((await paneText()).includes('结构化预览 🌳'), 'a unicode string survives')
  // Depth: the root and its children start open, a grandchild container stays
  // folded, and an empty container renders inline.
  assert.ok(!(await paneText()).includes('bottom'), 'a depth-2 container starts folded')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-json-entry]')].some(n=>n.textContent.includes('{}'))`), 'an empty object renders inline')
  // A long string folds behind its button and unfolds on demand.
  assert.ok(!(await paneText()).includes('x'.repeat(600)), 'a long string is folded')
  await click('[data-json-string]')
  assert.ok((await paneText()).includes('x'.repeat(600)), 'the string unfolds on demand')
  // A wide container pages its children, 100 at a time: the 2 tags plus the
  // first page of the wide array.
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-index]').length`), 102, 'arrays page their children')
  assert.ok(await evaluate(`document.querySelector('[data-json-more]')?.textContent.includes('50')`), 'the pager names the next page')
  await click('[data-json-more]')
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-index]').length`), 152, 'the next page is revealed')
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-more]').length`), 0, 'no pager past the end')
  // Folding one container removes its children from the DOM, not just the screen.
  await evaluate(`[...document.querySelectorAll('[data-json-toggle]')].find(b=>b.textContent.startsWith('tags'))?.click()`)
  await pause(120)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-json-toggle]')].find(b=>b.textContent.startsWith('tags'))?.getAttribute('aria-expanded')`), 'false', 'a container folds')
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-index]').length`), 150, 'folded children leave the DOM')
  // Expand-all reaches every depth; collapse-all folds the root itself.
  await click('[data-json-expand-all]')
  await waitFor(`[...document.querySelectorAll('[data-json-entry]')].some(n=>n.textContent.includes('bottom'))`, 'expand all reaches the deepest value')
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-json-toggle]')].every(b=>b.getAttribute('aria-expanded')==='true')`), 'every container is open')
  await click('[data-json-collapse-all]')
  await pause(150)
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-entry]').length`), 0, 'collapse all folds the root')
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-toggle]').length`), 1, 'only the root toggle remains')
  // A broken JSON file gets its own notice, and stays readable in source.
  await open('broken.json')
  await waitFor('document.querySelector("[data-file-json-invalid]")', 'invalid json notice')
  assert.equal(await evaluate(`document.querySelector('[data-file-json-invalid]').textContent`), await evaluate(`window.en['files.json.invalid']`), 'the invalid notice is shown')
  console.log('PASS: .json renders as a collapsible typed tree with paging, folding and an invalid-file notice')

  // A huge document stays usable: even its default view is past the
  // full-render limit, so the virtual window must keep the DOM small — and
  // expand-all is stopped by the row budget instead of eating memory.
  await open('huge.json')
  await waitFor('document.querySelector("[data-file-json]")', 'huge json preview')
  const initialEntries = await evaluate(`document.querySelectorAll('[data-json-entry]').length`)
  assert.ok(initialEntries > 0 && initialEntries < 300, `the window renders only what is on screen: ${initialEntries}`)
  // Scrolling reaches deep into the document without mounting it.
  await evaluate(`(()=>{const el=document.querySelector('[data-file-json-tree]');el.scrollTop=el.scrollHeight/2})()`)
  await pause(200)
  const midEntries = await evaluate(`document.querySelectorAll('[data-json-entry]').length`)
  assert.ok(midEntries > 0 && midEntries < 300, `scrolling keeps the window small: ${midEntries}`)
  await click('[data-json-expand-all]')
  await waitFor(`document.querySelector('[data-file-json-tree]').scrollHeight > 500000`, 'expand all flattens to the budget')
  assert.ok(await evaluate(`document.querySelectorAll('[data-json-entry]').length < 300`), 'expand all still renders only a window')
  await evaluate(`(()=>{const el=document.querySelector('[data-file-json-tree]');el.scrollTop=el.scrollHeight})()`)
  await waitFor('document.querySelector("[data-json-cutoff]")', 'the budget cutoff row')
  assert.equal(await evaluate(`document.querySelector('[data-json-cutoff]').textContent`), await evaluate(`window.en['files.json.capped'].replace('{count}','50000')`), 'the cutoff names the budget')
  await click('[data-json-collapse-all]')
  await pause(150)
  assert.equal(await evaluate(`document.querySelectorAll('[data-json-entry]').length`), 0, 'collapse recovers from the budget')
  console.log('PASS: a huge .json stays in a small virtual window and expand-all is budget-capped')

  // 6. Subtitle cues: both formats, tags stripped, VTT header/NOTE skipped and
  //    the times normalized.
  await open('captions.srt')
  await waitFor('document.querySelector("[data-file-subtitle]")', 'srt preview')
  assert.equal(await evaluate(`document.querySelectorAll('[data-subtitle-cue]').length`), 2, 'both SRT cues')
  assert.ok((await paneText()).includes('Hello world'), 'inline markup is stripped')
  assert.ok((await paneText()).includes('Second line\ncontinues here'), 'a multi-line cue keeps its lines')
  assert.ok(await evaluate(`document.querySelector('[data-subtitle-cue="1"]').innerText.includes('00:00:01.000 → 00:00:03.500')`), 'SRT times are normalized')
  await open('captions.vtt')
  await waitFor('document.querySelector("[data-file-subtitle]")', 'vtt preview')
  assert.equal(await evaluate(`document.querySelectorAll('[data-subtitle-cue]').length`), 2, 'WEBVTT and NOTE blocks are not cues')
  assert.ok((await paneText()).includes('First cue'), 'the first VTT cue is shown')
  assert.ok(await evaluate(`document.querySelector('[data-subtitle-cue="1"]').innerText.includes('00:00:01.000 → 00:00:03.000')`), 'MM:SS times expand to HH:MM:SS')
  assert.ok(await evaluate(`document.querySelector('[data-file-subtitle-bar]').innerText.includes('2')`), 'the cue count is shown')
  console.log('PASS: .srt/.vtt render cues with normalized times and no header blocks')

  // The preview inherits the interface face, including live preference edits;
  // its 14px text and 12px/medium controls intentionally have different metrics.
  // Application is debounced (fonts.ts collapses a typing burst into one
  // document-wide recalc), so the read waits out the trailing edge.
  for (const ui of ['', 'serif']) {
    await evaluate(`window.setFonts({ui:${JSON.stringify(ui)}})`)
    await pause(250)
    const fonts = await evaluate(`(()=>{const text=getComputedStyle(document.querySelector('[data-subtitle-cue] > span:last-child'));const bar=getComputedStyle(document.querySelector('[data-file-subtitle-bar]'));return [text.fontFamily,bar.fontFamily,getComputedStyle(document.body).fontFamily,text.fontSize,text.fontWeight]})()`)
    assert.equal(fonts[0], fonts[1], 'subtitle and interface label share the font stack')
    assert.equal(fonts[0], fonts[2], 'subtitle follows the interface preference')
    assert.deepEqual(fonts.slice(3), ['14px', '400'])
  }
  await evaluate('window.setFonts({ui:""})')
  console.log('PASS: subtitle text inherits the default and custom interface fonts')

  await open('lyrics.lrc')
  await waitFor('document.querySelector("[data-file-subtitle]")', 'LRC preview')
  const lyricRows = await evaluate(`Array.from(document.querySelectorAll('[data-subtitle-cue]'),row=>[row.firstElementChild.textContent,row.lastElementChild.textContent])`)
  assert.deepEqual(lyricRows, [
    ['00:00:06.250', '第一行歌词'], ['00:00:06.250', 'First lyric line'],
    ['00:00:12.090', '重复的歌词'], ['00:00:42.095', '重复的歌词'], ['00:01:01.750', '逐字歌词']
  ], 'LRC expands repeated times, preserves translation order, applies offset and strips word tags')
  assert.equal(await evaluate(`document.querySelector('[data-file-subtitle-bar]').textContent`), '5 lyric lines')
  await evaluate(`window.files.setView(window.cwd+'/lyrics.lrc','source')`)
  await waitFor('document.querySelector("[data-file-source]")', 'LRC source')
  assert.ok((await paneText()).includes('[00:12.34][00:42.345]'), 'the original lyric timestamps remain in source')
  await evaluate(`window.files.setView(window.cwd+'/lyrics.lrc','preview')`)
  await waitFor('document.querySelector("[data-file-subtitle]")', 'LRC preview restored')
  await open('untimed.lrc')
  await waitFor('document.querySelector("[data-file-subtitle-empty]")', 'untimed LRC notice')
  assert.equal(await evaluate(`document.querySelector('[data-file-subtitle-empty]').textContent`), await evaluate(`window.en['files.lyrics.empty']`))
  const parseLrc = text => evaluate(`window.parseCues(${JSON.stringify(text)},'lrc')`)
  assert.deepEqual(await parseLrc('[offset:-1500]\n[00:01]Later'), [{ start: '00:00:02.500', end: null, text: 'Later' }])
  assert.deepEqual(await parseLrc('[offset:2500]\n[00:01]Early'), [{ start: '00:00:00.000', end: null, text: 'Early' }])
  assert.deepEqual(await parseLrc('[ti:Only metadata]\n[00:xx]Bad\n[00:01.0000]Bad\n[00:03]'), [])
  assert.equal((await parseLrc('[00:01]'.repeat(5002) + 'Bounded')).length, 5000, 'LRC cue count stays bounded even on one line')
  assert.equal((await parseLrc('[00:01]' + '字'.repeat(4001)))[0].text.length, 4000, 'LRC text stays bounded')
  console.log('PASS: .lrc opens on timed lyrics, retains source, bounds output and explains untimed files')

  // 7. A font preview takes the pane, loads the real face and renders with it.
  {
    await open('Temml.woff2')
    await waitFor('document.querySelector("[data-file-font]")', 'font preview')
    await waitFor(`document.fonts.check('16px "' + getComputedStyle(document.querySelector('[data-font-sample]')).fontFamily.replace(/"/g,'') + '"')`, 'the face is registered')
    assert.equal(await evaluate(`document.querySelectorAll('[data-file-view-tabs]').length`), 0, 'a font takes the pane without view tabs')
    assert.equal(await evaluate(`document.querySelectorAll('[data-font-sample]').length`), 4, 'the specimen sets several sizes')
    assert.equal(await evaluate(`document.querySelectorAll('[data-font-glyphs]').length`), 1, 'a glyph run is shown')
    // Temml's shipped face contains Mathematical Script capitals rather than
    // ASCII. Use those glyphs so a missing face cannot pass via text fallback.
    const metrics = await evaluate(`(()=>{const node=document.querySelector('[data-font-sample]');const probe=document.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:'+getComputedStyle(node).fontFamily;probe.textContent='𝒜𝒟𝒲𝒴';document.body.append(probe);const loaded=probe.getBoundingClientRect().width;probe.style.fontFamily='monospace';const fallback=probe.getBoundingClientRect().width;probe.remove();return {loaded:Math.round(loaded),fallback:Math.round(fallback)}})()`)
    assert.notEqual(metrics.loaded, metrics.fallback, 'the sample renders in the loaded face, not the fallback: ' + JSON.stringify(metrics))
    assert.ok((await paneText()).includes('WOFF2'), 'the format is reported: ' + (await paneText()))
    assert.ok((await paneText()).includes(`${Math.round(fontBytes / 1024)}`), 'the file size is reported')
    const before = await evaluate(`getComputedStyle(document.querySelector('[data-font-sample]')).fontSize`)
    // Selected by its accessible name, not by position: beUI's Tooltip wraps the
    // button, so `:last-child` would match both controls' inner buttons.
    await click(`[data-file-font-zoom] button[aria-label="${await evaluate('window.en["imagePreview.zoomIn"]')}"]`)
    assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('[data-font-sample]')).fontSize`), before, 'zoom resizes the specimen')
    assert.equal(await evaluate(`document.querySelector('[data-file-font-scale]').textContent`), '120%', 'the scale label follows the ladder')
    await evaluate(`(()=>{const input=document.querySelector('[data-file-font-toolbar] input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'Hamburgefonstiv 0123');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await pause(150)
    assert.ok(await evaluate(`document.querySelector('[data-font-sample]').textContent.includes('Hamburgefonstiv')`), 'the sample text is editable')
    // The face must not stay registered once its tab is gone.
    await open('changes.patch')
    await pause(200)
    assert.equal(await evaluate(`[...document.fonts].filter(f=>f.family.startsWith('pith-font')).length`), 0, 'the face is removed with the tab')
    console.log('PASS: font preview loads the real face, zooms, edits its sample and unregisters on close')
  }

  // 8. No non-text family may reach `files:document` — the guard is the main
  //    process's, not a renderer convention.
  for (const name of ['notes.ipynb', 'captions.srt', 'changes.patch', 'data.json', 'huge.json']) {
    assert.ok(docPaths.some(path => path.endsWith('/' + name)), name + ' is read as a document')
  }
  for (const name of ['Temml.woff2', 'audiobook.m4b', 'still.apng', 'cursor.cur', 'diagram.svgz', 'still.heic']) {
    assert.equal(docPaths.some(path => path.endsWith('/' + name)), false, name + ' is never read as a document')
  }
  // And the reader refuses one anyway, if a caller ever asked directly. The
  // claim is that no `text` field is produced at all, so absence is what is
  // tested — an array element would turn `undefined` into `null` on the way out.
  const refused = await evaluate(`(async()=>{const r=await window.pi.readFileDocument({cwd:window.cwd,path:window.cwd+'/Temml.woff2'});return [r.error,'text' in r]})()`)
  assert.equal(refused[0], 'binary', 'a font read as a document is refused')
  assert.equal(refused[1], false, 'and carries no bytes')
  console.log('PASS: non-text families never reach files:document, and the reader refuses them by itself')

  // 9. Both locales carry every new string (the Messages type covers the
  //    compile-time half; this is the rendered half).
  for (const key of [...Object.keys(await evaluate('window.en')), ...Object.keys(await evaluate('window.zh'))]) {
    if (!key.startsWith('files.notebook') && !key.startsWith('files.json') && !key.startsWith('files.subtitle') && !key.startsWith('files.lyrics') && !key.startsWith('files.font') && !key.startsWith('files.diffPreview')) continue
    assert.ok(await evaluate(`Object.prototype.hasOwnProperty.call(window.en,${JSON.stringify(key)})`), 'en has ' + key)
    assert.ok(await evaluate(`Object.prototype.hasOwnProperty.call(window.zh,${JSON.stringify(key)})`), 'zh has ' + key)
  }
  await reload('zh-CN')
  await open('captions.srt')
  await waitFor('document.querySelector("[data-file-subtitle]")', 'Chinese srt preview')
  const countLabel = await evaluate(`document.querySelector('[data-file-subtitle-bar]').innerText`)
  const expectedLabel = await evaluate(`window.zh['files.subtitle.count'].replace('{count}','2')`)
  assert.equal(countLabel, expectedLabel, 'the cue count is localized')
  await open('lyrics.lrc')
  await waitFor('document.querySelector("[data-file-subtitle]")', 'Chinese LRC preview')
  assert.equal(await evaluate(`document.querySelector('[data-file-subtitle-bar]').textContent`), '共 5 行歌词')
  /** Light/dark captures of the current view, when a screenshot dir is set. */
  const shoot = async (name) => {
    if (!process.env.PI_PREVIEW_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_PREVIEW_SCREENSHOT_DIR, { recursive: true })
    for (const dark of [false, true]) {
      await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
      await pause(100)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(process.env.PI_PREVIEW_SCREENSHOT_DIR, `${name}-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'))
    }
    await evaluate(`document.documentElement.classList.remove('dark')`)
  }
  await shoot('lyrics')
  await open('data.json')
  await waitFor('document.querySelector("[data-file-json]")', 'Chinese json preview')
  assert.equal(await evaluate(`document.querySelector('[data-json-summary]').textContent`), await evaluate(`window.zh['files.json.keys'].replace('{count}','12')`), 'the JSON summary is localized')
  await shoot('json')
  await open('changes.patch')
  await waitFor('document.querySelector("[data-file-diff-preview]")', 'Chinese patch preview')
  assert.ok(await evaluate(`document.querySelector('[data-file-view-tabs] [role=tab][aria-selected=true]').textContent === window.zh['files.preview']`), 'the preview tab is localized')
  console.log('PASS: new preview strings exist in both locales and render translated')

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('\nAll preview-routing checks passed.')
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { child?.kill('SIGKILL') } catch { /* already gone */ }
  try { await server?.close() } catch { /* already closed */ }
}
