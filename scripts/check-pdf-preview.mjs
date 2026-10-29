/** PDF preview: the range IPC contract, real pdf.js rendering in the file pane,
 * both view modes, zoom and the failure paths. Isolated data, no network.
 * Run after building: node scripts/check-pdf-preview.mjs
 * `PI_PDF_SCREENSHOT_DIR` retains the rendered views. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, writeFile, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-pdf-'))
const project = join(temporary, 'project')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A deterministic multi-page PDF with text and vector ink (uncompressed, so
 * byte ranges actually matter). Written by hand: no tooling, no network. */
function buildPdf(pages) {
  const lines = 40
  const escape = (text) => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = (page) => {
    const parts = [`BT /F1 20 Tf 56 740 Td (Check page ${page + 1}) Tj ET`]
    for (let line = 0; line < lines; line++) parts.push(`BT /F1 10 Tf 56 ${712 - line * 15} Td (${escape(`Line ${line + 1} of page ${page + 1}: the quick brown fox jumps over the lazy dog 0123456789`)} ) Tj ET`)
    for (let row = 0; row < 6; row++) for (let col = 0; col < 12; col++) parts.push(`0.2 0.3 0.8 rg ${56 + col * 42} ${56 + row * 14} 36 8 re f`)
    return parts.join('\n')
  }
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const catalog = add('')
  const pagesRef = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids = []
  for (let page = 0; page < pages; page++) {
    const stream = content(page)
    const streamRef = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${streamRef} 0 R >>`))
  }
  // Page 1 carries the two links the preview has to handle: an in-document
  // destination (jump to page 5) and an external URI.
  const dest = add(`<< /Type /Annot /Subtype /Link /Rect [56 700 260 724] /Border [0 0 0] /Dest [${kids[Math.min(4, kids.length - 1)]} 0 R /Fit] >>`)
  const uri = add('<< /Type /Annot /Subtype /Link /Rect [56 660 260 684] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/doc) >> >>')
  objects[kids[0] - 1] = objects[kids[0] - 1].replace(' /Contents', ` /Annots [${dest} 0 R ${uri} 0 R] /Contents`)
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`
  objects[pagesRef - 1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.map((ref) => `${ref} 0 R`).join(' ')}] >>`
  let pdf = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets = [0]
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const PAGES = 200
const docPath = join(project, 'doc.pdf')
const homePdfPath = join(project, 'Assignment 1.pdf')
const homePdfHref = encodeURI('~/' + relative(homedir(), homePdfPath).replaceAll('\\', '/'))
let server, child, ws
/** `[range] calls bytes max` samples and every rejected range. */
const samples = []
const violations = []
const docPaths = []
try {
  await mkdir(project)
  await writeFile(docPath, buildPdf(PAGES))
  await writeFile(join(project, 'single-page.pdf'), buildPdf(1))
  await copyFile(docPath, homePdfPath)
  await writeFile(join(project, 'broken.pdf'), Buffer.from('this is not a pdf at all, not even close', 'latin1'))
  await writeFile(join(project, 'notes.txt'), 'plain text source\n')
  await writeFile(join(project, 'notes.md'), '# Markdown delivery\n\nThe preview stays inside the file pane.\n')
  const pdfSize = (await stat(docPath)).size

  const fixturePath = '/__pdf_check.html'
  const fixture = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {FilesPane} from '/src/components/app/FilesPane.tsx';
import {SidebarPanel, fileTabId, filePathForTab} from '/src/components/app/SidebarPanel.tsx';
import {BrowserStore} from '/src/lib/browser/store.ts';
import {localFileTarget} from '/src/lib/file-navigation.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';import {FileBrowserStore} from '/src/state/file-browser-store.ts';import {DebugStore} from '/src/state/debug-store.ts';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const cwd=${JSON.stringify(project)};
const files=new FileBrowserStore(),pi=new PiStore(),debug=new DebugStore(),browserStore=new BrowserStore();
pi.applySnapshot({cwd,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
const App=()=>{
  const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);
  const [rail,setRail]=React.useState(null);window.showRail=setRail;
  if(!rail)return React.createElement(FilesPane,{files,store:pi,filePath:state.active,debug});
  // Clipped sibling content makes the workspace scrollable to scripts, as
  // retained/overflowing chat content can do in the real workspace. The PDF
  // must keep its own scroll boundary even when that ancestor can scroll.
  return React.createElement('div',{'data-pdf-workspace':true,className:'relative flex h-full min-h-0 overflow-hidden'},
    React.createElement('div',{className:'min-w-0 flex-1'},React.createElement('div',{style:{height:2000}})),
    React.createElement(SidebarPanel,{open:true,width:rail.width,fullscreen:rail.fullscreen,tabs:state.tabs.map(tab=>fileTabId(tab.path)),activeTab:state.active?fileTabId(state.active):null,
      onSelectTab:id=>files.select(filePathForTab(id)),onOpenTab:()=>{},onCloseTab:id=>files.close(filePathForTab(id)),onCloseOtherTabs:()=>{},onCloseAllTabs:()=>{},
      pane:{files,store:pi,debug,browserStore,agentRuns:new Map(),reviewTurnId:null,sideChat:null}}));
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(App))));
window.en=en;window.zh=zh;window.cwd=cwd;
window.openFile=name=>files.open(cwd,{path:cwd+'/'+name});
window.openPdfHref=href=>files.open(cwd,localFileTarget(href,cwd));window.files=files;
window.__frames=[];window.__collectScrollFrames=async(ms)=>{
  const scroller=document.querySelector('[data-pdf-scroller]');
  const frames=[];let last=performance.now();const start=performance.now();
  while(performance.now()-start<ms){
    await new Promise(requestAnimationFrame);
    const now=performance.now();frames.push(now-last);last=now;
    scroller.scrollTop+=140;
  }
  return frames;
};
window.__goto=async number=>{const scroller=document.querySelector('[data-pdf-scroller]');const page=scroller&&scroller.querySelector('.page[data-page-number="'+number+'"]');if(page)scroller.scrollTop=page.offsetTop-40;await new Promise(r=>setTimeout(r,300))};
window.__pagesHost=()=>document.querySelector('[data-pdf-scroller]');
window.__pagePainted=number=>{const page=document.querySelector('[data-pdf-scroller] .page[data-page-number="'+number+'"]');const canvas=page&&page.querySelector('canvas');return Boolean(canvas&&canvas.width>0)};
window.__ready=true;</script></body></html>`

  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [tailwindcss(), { name: 'pdf-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== fixturePath) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))

  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain} from 'electron';
import {listFileDirectory,readFileDocument} from ${JSON.stringify(join(repo, 'src/main/file-browser.ts'))};
import {readPdfStat,readPdfRange} from ${JSON.stringify(join(repo, 'src/main/pdf.ts'))};
import {resolveFilePath} from ${JSON.stringify(join(repo, 'src/main/file-path.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const io={ranges:[],violations:[],documents:[],external:[]};globalThis.pdfIo=io;
app.whenReady().then(()=>{
  ipcMain.handle('app:info',()=>({cwd:${JSON.stringify(project)},folders:[${JSON.stringify(project)}],contextFiles:true,version:'test',bashMaxWaitMs:10000,checkpointsEnabled:false}));
  ipcMain.handle('files:directory',(_,r,offset)=>listFileDirectory(r,offset));
  ipcMain.handle('files:document',(_,r)=>{io.documents.push(r.path);return readFileDocument(r)});
  ipcMain.handle('files:gitDiff',()=>({gitRoot:null,patch:'',binary:false}));
  ipcMain.handle('shell:openExternal',(_e,url)=>{io.external.push(url)});
  ipcMain.handle('files:pdfStat',(_,r)=>readPdfStat(r));
  ipcMain.handle('files:resolvePath',(_,r)=>resolveFilePath(r));
  ipcMain.handle('files:pdfRange',async(_,r,begin,end)=>{
    // Record the contract: end must be exclusive, in range, and chunk-aligned.
    io.ranges.push({begin,end,length:end-begin});
    if(end<=begin||begin<0) io.violations.push('bad range '+begin+'-'+end);
    try{ return await readPdfRange(r,begin,end) }catch(error){ io.violations.push(String(error.message||error)); throw error }
  });
  setInterval(()=>{const ranges=io.ranges;console.log('[range]',JSON.stringify({calls:ranges.length,bytes:ranges.reduce((s,r)=>s+r.length,0),max:ranges.reduce((m,r)=>Math.max(m,r.length),0),aligned:ranges.every(r=>r.begin%65536===0),violations:io.violations.slice(0,3),documents:io.documents.length,external:io.external}))},400);
  const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  w.loadURL('http://127.0.0.1:${server.httpServer.address().port}${fixturePath}');});
app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })

  child = spawn(electron, [main], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk); for (const match of String(chunk).matchAll(/\[range\] (\{.*\})/g)) samples.push(JSON.parse(match[1])) })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr.slice(0, 1500))), 20000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ' ' + stderr.slice(0, 1500))) })
    child.stderr.on('data', (chunk) => { stderr += chunk; const match = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push(m.params.args.map((a) => a.description ?? a.value).join(' ').slice(0, 300))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value }
  await send('Runtime.enable')
  const waitFor = async (expression, label) => { const end = Date.now() + 25000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true; await pause(100) } throw new Error('Timeout: ' + label + ' :: viewer=' + await evaluate(`document.querySelector('[data-file-pdf]')?.dataset.pdfError ?? 'none'`).catch(() => '?') + ' body=' + await evaluate('document.body.innerText').catch(() => '?') + ' ' + JSON.stringify(exceptions.slice(0, 4))) }
  const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(120) }
  const shot = async (name) => { const dir = process.env.PI_PDF_SCREENSHOT_DIR; if (!dir) return; await mkdir(dir, { recursive: true }); const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(dir, name + '.png'), Buffer.from(image.data, 'base64')) }

  await waitFor('window.__ready', 'fixture ready')

  // 1. The document streams: pdf.js pulls chunks, never the whole file at once.
  await evaluate(`window.openPdfHref(${JSON.stringify(homePdfHref)})`)
  await waitFor(`files.getSnapshot().active===${JSON.stringify(homePdfPath)}`, 'home PDF tab resolves to its absolute path')
  await pause(1500)
  const containerState = await evaluate(`(()=>{const el=document.querySelector('[data-pdf-scroller]');return {position:getComputedStyle(el).position,error:document.querySelector('[data-file-pdf]').dataset.pdfError??''}})()`)
  assert.equal(containerState.position, 'absolute', `the pdf.js container must be absolutely positioned: ${JSON.stringify(containerState)}`)
  assert.equal(containerState.error, '', `the viewer must not report a failure: ${JSON.stringify(containerState)}`)
  assert.equal(containerState.position, 'absolute', `the pdf.js container must be absolutely positioned: ${JSON.stringify(containerState)}`)
  assert.equal(containerState.error, '', `the viewer must not report a failure: ${JSON.stringify(containerState)}`)
  await waitFor(`(()=>{const c=document.querySelector('[data-pdf-scroller] .page[data-page-number="1"] canvas');return Boolean(c&&c.width>0)})()`, 'first page painted')
  const geometry = await evaluate(`(()=>{const page=document.querySelector('[data-pdf-scroller] .page[data-page-number="1"]');const canvas=page.querySelector('canvas');const box=page.getBoundingClientRect();const labels=[...document.querySelectorAll('[data-file-preview] [role=tab]')].map(tab=>tab.textContent);return {pageWidth:Math.round(box.width),pageHeight:Math.round(box.height),canvasWidth:canvas.width,canvases:document.querySelectorAll('[data-pdf-scroller] canvas').length,pageViews:document.querySelectorAll('[data-pdf-scroller] .page').length,textSpans:document.querySelectorAll('[data-pdf-scroller] .textLayer span').length,toolbar:!!document.querySelector('[data-file-pdf-toolbar]'),textTabs:labels.filter(label=>label===window.en['files.source']||label===window.en['files.preview']||label===window.en['files.diff']).length}})()`)
  assert.ok(geometry.pageWidth > 100 && geometry.pageHeight > 100, `a page is laid out for real: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.canvasWidth >= geometry.pageWidth, 'the canvas is rendered at the layout size (HiDPI aware)')
  assert.equal(geometry.pageViews, PAGES, 'every page of the document has a page view')
  assert.ok(geometry.toolbar, 'the PDF toolbar is mounted')
  assert.equal(geometry.textTabs, 0, 'a PDF takes the pane without the text view tabs')
  assert.ok(geometry.textSpans > 50, `the text layer is built for selection: ${geometry.textSpans} spans`)
  // The overlays must sit exactly on the canvas: Tailwind's global border-box
  // reset shrank the canvas by the page border while the layers kept the full
  // size, which drifted every highlight a few percent off its glyph.
  const layerAlignment = await evaluate(`(()=>{const page=document.querySelector('[data-pdf-scroller] .page[data-page-number="1"]');const rect=node=>{const b=node.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)]};return {boxSizing:getComputedStyle(page).boxSizing,canvas:rect(page.querySelector('canvas')),text:rect(page.querySelector('.textLayer')),annot:rect(page.querySelector('.annotationLayer'))}})()`)
  assert.equal(layerAlignment.boxSizing, 'content-box', `pdf.js pages must keep their content-box model: ${JSON.stringify(layerAlignment)}`)
  assert.deepEqual(layerAlignment.text, layerAlignment.canvas, `the text layer must sit exactly on the canvas: ${JSON.stringify(layerAlignment)}`)
  assert.deepEqual(layerAlignment.annot, layerAlignment.canvas, `the annotation layer must sit exactly on the canvas: ${JSON.stringify(layerAlignment)}`)
  const first = samples[samples.length - 1]
  assert.ok(first.calls > 0, 'the document was fetched over range reads')
  assert.ok(first.max <= 4 * 1024 * 1024, `reads arrive as chunks, not one giant message: max ${first.max} bytes`)
  assert.ok(first.aligned, 'every read starts on the pdf.js chunk grid')
  assert.deepEqual(first.violations, [], 'every range was inside the file')
  console.log(`PASS: page laid out (${geometry.pageWidth}x${geometry.pageHeight}), canvas ${geometry.canvasWidth}px, ${geometry.textSpans} text spans, ${first.calls} range reads / ${first.bytes} bytes of ${pdfSize}`)

  // 2. Scroll mode stays smooth and keeps the page count bounded.
  const frames = await evaluate('window.__collectScrollFrames(3000)')
  const sorted = [...frames].sort((a, b) => a - b)
  const scroll = {
    frames: frames.length,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
    max: Math.round(Math.max(...frames) * 10) / 10,
    over32: frames.filter((f) => f > 32).length,
    canvases: await evaluate(`document.querySelectorAll('[data-pdf-scroller] canvas').length`),
    pageViews: await evaluate(`document.querySelectorAll('[data-pdf-scroller] .page').length`)
  }
  assert.ok(scroll.frames > 60, `frames actually ran during the scroll: ${scroll.frames}`)
  assert.ok(scroll.canvases <= 12, `offscreen pages release their canvas: ${scroll.canvases} canvases for ${scroll.pageViews} pages`)
  console.log(`PASS: scroll frames=${scroll.frames} median=${scroll.median}ms p95=${scroll.p95}ms max=${scroll.max}ms over-32ms=${scroll.over32}; canvases bounded at ${scroll.canvases}/${scroll.pageViews}`)
  await shot('pdf-scroll')

  // 3. Links: an in-document destination navigates, and nothing else ever
  //    navigates the app away (a linked PDF used to replace the whole window).
  await evaluate(`window.__goto(1)`).catch(() => {})
  await pause(1500)
  const linkCount = await evaluate(`document.querySelectorAll('[data-pdf-scroller] .page[data-page-number="1"] .annotationLayer a').length`)
  assert.ok(linkCount >= 2, `the fixture PDF exposes its link annotations: ${linkCount}`)
  const hrefBefore = await evaluate('location.href')
  await evaluate(`document.querySelectorAll('[data-pdf-scroller] .page[data-page-number="1"] .annotationLayer a')[0].click()`)
  await waitFor(`Number(document.querySelector('[data-pdf-page]').textContent) === 5`, 'the table-of-contents link jumps to page 5')
  assert.equal(await evaluate('location.href'), hrefBefore, 'an in-document link never navigates the app')
  console.log('PASS: an in-document link jumps to its destination page')
  await evaluate(`document.querySelectorAll('[data-pdf-scroller] .page[data-page-number="1"] .annotationLayer a')[1].click()`)
  await pause(600)
  assert.equal(await evaluate('location.href'), hrefBefore, 'an external link never navigates the app')
  let externalCalls = []
  for (let attempt = 0; attempt < 20 && !externalCalls.length; attempt++) { await pause(150); externalCalls = samples[samples.length - 1]?.external ?? [] }
  assert.deepEqual(externalCalls, ['https://example.invalid/doc'], 'an external link goes to the system browser')
  console.log('PASS: an external link opens externally without touching the app window')
  await shot('pdf-links')
  const toolbarBox = await evaluate(`(()=>{const rect=document.querySelector('[data-file-pdf-toolbar]').getBoundingClientRect();return {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}})()`)
  assert.ok(toolbarBox.w > 200 && toolbarBox.h >= 36, `the toolbar has a real box: ${JSON.stringify(toolbarBox)}`)
  if (process.env.PI_PDF_SCREENSHOT_DIR) { await mkdir(process.env.PI_PDF_SCREENSHOT_DIR, { recursive: true }); const image = await send('Page.captureScreenshot', { format: 'png', clip: { x: toolbarBox.x, y: toolbarBox.y, width: toolbarBox.w, height: toolbarBox.h, scale: 3 } }); await writeFile(join(process.env.PI_PDF_SCREENSHOT_DIR, 'pdf-toolbar.png'), Buffer.from(image.data, 'base64')) }

  // 4. Zoom controls drive the real scale.
  const currentPage = await evaluate(`Number(document.querySelector('[data-pdf-page]').textContent)`)
  const before = await evaluate(`document.querySelector('[data-pdf-scale]').textContent`)
  await click('[aria-label="Zoom in"]')
  await pause(400)
  const zoomed = await evaluate(`(()=>{const label=document.querySelector('[data-pdf-scale]');const canvas=document.querySelector('[data-pdf-scroller] .page[data-page-number="${currentPage}"] canvas');return {label:label.textContent,width:canvas?canvas.width:0}})()`)
  assert.ok(Number.parseInt(zoomed.label, 10) > Number.parseInt(before, 10), `zoom in raises the scale: ${before} → ${zoomed.label}`)
  await click('[aria-label="Fit page"]')
  await pause(400)
  // pdf.js scales the page's content box; the 9px transparent page border is
  // the gap between pages, so it is the content height that has to fit.
  const fitted = await evaluate(`(()=>{const page=document.querySelector('[data-pdf-scroller] .page[data-page-number="${currentPage}"]');const scroller=document.querySelector('[data-pdf-scroller]');return {content:page.clientHeight,outer:Math.round(page.getBoundingClientRect().height),viewHeight:Math.round(scroller.clientHeight)}})()`)
  assert.ok(fitted.content <= fitted.viewHeight + 2, `fit page makes the page fit the viewport: ${JSON.stringify(fitted)}`)
  console.log(`PASS: zoom (${before} → ${zoomed.label}) and fit page (${fitted.content}px content in ${fitted.viewHeight}px viewport, ${fitted.outer}px with its border)`)
  // The same FilesPane scroll policy applies to the pdf.js-owned pages.
  await evaluate(`(()=>{const v=document.querySelector('[data-pdf-scroller]');v.style.width='180px';v.scrollTop=100;v.scrollLeft=20})()`)
  await pause(250)
  const pdfPosition=()=>evaluate(`(()=>{const v=document.querySelector('[data-pdf-scroller]');return {left:v.scrollLeft,top:v.scrollTop}})()`)
  const pdfWheel=events=>evaluate(`(()=>{const v=document.querySelector('[data-pdf-scroller]');for(const event of ${JSON.stringify(events)})v.dispatchEvent(new WheelEvent('wheel',{...event,bubbles:true,cancelable:true}))})()`)
  const pdfBefore=await pdfPosition()
  await pdfWheel([{deltaX:8,deltaY:6},{deltaX:6,deltaY:9},{deltaX:5,deltaY:80}])
  const pdfHorizontal=await pdfPosition()
  assert.equal(pdfHorizontal.left,pdfBefore.left+19,'PDF retains horizontal diagonal motion')
  assert.equal(pdfHorizontal.top,pdfBefore.top+95,'PDF retains vertical diagonal motion')
  await pdfWheel([{deltaX:-6,deltaY:8},{deltaX:-9,deltaY:6},{deltaX:-10,deltaY:5}])
  const pdfVertical=await pdfPosition()
  assert.equal(pdfVertical.top,pdfHorizontal.top+19,'PDF continues vertical motion without an idle gap')
  assert.equal(pdfVertical.left,pdfHorizontal.left-25,'PDF immediately reverses horizontal direction')
  await evaluate(`document.querySelector('[data-pdf-scroller]').style.removeProperty('width')`)
  console.log('PASS: PDF free diagonal scrolling and immediate direction changes')

  // 5. A file that is not a PDF at all fails with the localized notice.
  await evaluate(`window.openFile('broken.pdf')`)
  await waitFor(`document.querySelector('[data-file-pdf]')?.innerText.includes(window.en['files.pdf.failed'])`, 'broken PDF notice')
  assert.equal(samples[samples.length - 1].documents, 0, 'a PDF is never read as a text document')
  const failedRanges = samples[samples.length - 1]
  assert.deepEqual(failedRanges.violations, [], 'no range escaped the file while failing')
  await shot('pdf-failed')
  console.log('PASS: an unreadable PDF shows the localized failure notice')

  await evaluate(`window.openFile('missing.pdf')`)
  await waitFor(`document.querySelector('[data-file-pdf]')?.dataset.pdfError==='missing'`, 'missing PDF is distinguished from a decoding failure')
  assert.ok(await evaluate(`document.querySelector('[data-file-pdf]').innerText.includes(window.en['files.error.missing'])`))
  assert.ok(!await evaluate(`document.querySelector('[data-file-pdf]').innerText.includes(window.en['files.pdf.failed'])`),'missing files do not suggest a PDF decoder failure')
  console.log('PASS: missing PDFs show the file-not-found notice')

  // 6. Text and media tabs still behave (regression guard for the PDF branch).
  await evaluate(`window.openFile('notes.txt')`)
  await waitFor(`document.querySelectorAll('[data-file-preview] [role=tab]').length > 0`, 'text tabs')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-pdf]').length`), 0, 'a text file does not mount the PDF viewer')
  // The document counter is sampled from the main process, so give it a beat.
  let documentsRead = 0
  for (let attempt = 0; attempt < 30 && documentsRead < 1; attempt++) { await pause(150); documentsRead = samples[samples.length - 1]?.documents ?? 0 }
  assert.ok(documentsRead >= 1, 'a text file is still read as a document')
  console.log('PASS: text files still open in the text pane')

  // A short PDF fits the docked pane. Its initial scale, zoom and links must
  // never scroll the containing workspace and move the rail chrome offscreen.
  const assertRailChrome = async label => {
    const geometry = await evaluate(`(()=>{
      const workspace=document.querySelector('[data-pdf-workspace]').getBoundingClientRect();
      const rail=document.querySelector('[data-panel=right]').getBoundingClientRect();
      const scroller=document.querySelector('[data-pdf-scroller]');
      const chrome=['[data-sidebar-tabs]','[data-file-toolbar]','[data-file-pdf-toolbar]'].map(selector=>{
        const rect=document.querySelector(selector).getBoundingClientRect();return {selector,top:rect.top,bottom:rect.bottom,height:rect.height};
      });
      const outsideScroll=[];for(let node=scroller.parentElement;node;node=node.parentElement){
        if(node.scrollTop||node.scrollLeft)outsideScroll.push({tag:node.tagName,classes:node.className,top:node.scrollTop,left:node.scrollLeft});
      }
      return {workspaceTop:workspace.top,workspaceBottom:workspace.bottom,railTop:rail.top,chrome,outsideScroll};
    })()`)
    assert.deepEqual(geometry.outsideScroll,[],label+': only the PDF viewport may scroll')
    assert.equal(geometry.railTop,geometry.workspaceTop,label+': the rail stays aligned with the workspace')
    assert.equal(geometry.chrome[0].top,geometry.railTop,label+': the tab strip stays at the top of the panel')
    for(const bar of geometry.chrome)assert.ok(bar.height>0&&bar.top>=geometry.workspaceTop&&bar.bottom<=geometry.workspaceBottom,label+': toolbar remains visible: '+JSON.stringify(bar))
  }
  await evaluate(`window.showRail({width:400,fullscreen:false});window.openFile('notes.md')`)
  await waitFor(`document.querySelector('[data-file-markdown]')?.textContent.includes('Markdown delivery')`, 'Markdown in the docked rail')
  await evaluate(`window.openFile('single-page.pdf')`)
  await waitFor(`document.querySelector('[data-pdf-scroller] canvas')?.width > 0`, 'single-page PDF in the docked rail')
  await pause(600)
  assert.ok(await evaluate(`document.querySelector('[data-pdf-scroller] .page').clientHeight < document.querySelector('[data-pdf-scroller]').clientHeight`),'the regression PDF fits entirely inside the docked viewport')
  await assertRailChrome('opening a single-page PDF from Markdown')
  await shot('pdf-docked-single-page')
  for(const label of ['Zoom in','Zoom out','Fit page','Fit width']){
    await click('[data-file-pdf-toolbar] button[aria-label='+JSON.stringify(label)+']')
    await pause(250)
    await assertRailChrome('docked '+label)
  }
  await click('[data-pdf-scroller] .annotationLayer a')
  await pause(350)
  await assertRailChrome('a short PDF internal destination')
  await evaluate(`window.showRail({width:500,fullscreen:false})`)
  await pause(350)
  await click('[data-file-pdf-toolbar] button[aria-label="Fit width"]')
  await assertRailChrome('resizing the docked PDF pane')
  await evaluate(`window.showRail({width:500,fullscreen:true})`)
  await pause(350)
  await click('[data-file-pdf-toolbar] button[aria-label="Fit page"]')
  await assertRailChrome('fullscreen Fit page')
  await shot('pdf-fullscreen-single-page')
  await evaluate(`window.showRail({width:400,fullscreen:false})`)
  await pause(350)
  await click('[data-file-pdf-toolbar] button[aria-label="Fit width"]')
  await assertRailChrome('returning to the docked PDF pane')
  await click('[data-sidebar-tab='+JSON.stringify('file:'+join(project,'notes.md'))+'] [role=tab]')
  await waitFor(`document.querySelector('[data-file-markdown]')?.textContent.includes('Markdown delivery')`, 'switching back to Markdown through the rail tab strip')
  await click('[data-sidebar-tab='+JSON.stringify('file:'+join(project,'single-page.pdf'))+'] [role=tab]')
  await waitFor(`document.querySelector('[data-pdf-scroller] canvas')?.width > 0`, 'returning to the PDF through the rail tab strip')
  await pause(350)
  await assertRailChrome('returning to the PDF tab')
  console.log('PASS: short PDF opening, zoom, fit, links, resize, fullscreen and Markdown tab switches keep rail chrome visible and confine scrolling to the PDF viewport')

  const locale = await evaluate(`(()=>{const keys=Object.keys(window.en).filter(k=>k.startsWith('files.pdf.'));return {keys,missing:keys.filter(k=>typeof window.zh[k]!=='string'),translated:keys.filter(k=>window.zh[k]!==window.en[k]).length}})()`)
  assert.deepEqual(locale.missing, [], 'every PDF string exists in zh-CN')
  assert.equal(locale.translated, locale.keys.length, 'PDF strings are translated, not copied')
  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log(`PASS: ${locale.keys.length} PDF strings in both locales; no renderer exceptions`)
  console.log('\npdf preview check passed')
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
