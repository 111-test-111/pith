/** Actual Electron/preload/IPC/worker/gallery, using only offline fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Resvg } from '@resvg/resvg-js'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'pith-library-ui-'))
const screenshots = process.env.PI_LIBRARY_SCREENSHOT_DIR
function thumbnailPdf(rotate = 0) {
  const stream = '0.12 0.4 0.75 rg 32 590 300 110 re f\n0 g\nBT /F1 24 Tf 32 550 Td (Library PDF preview) Tj ET\nBT /F1 14 Tf 32 520 Td (Actual first page content) Tj ET\n0.8 0.12 0.12 rg 32 24 300 54 re f\n0 g\nBT /F1 14 Tf 32 96 Td (End of first page) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 720] /Rotate ' + rotate + ' /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream']
  let text = '%PDF-1.7\n', offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += (i + 1) + ' 0 obj\n' + object + '\nendobj\n' }
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(text + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}
let server, application
try {
  if (screenshots) await mkdir(screenshots, { recursive: true })
  const otherProjectName = 'a-very-long-project-name-for-library-layout-check'
  const agentDir = join(temp, 'agent'), profile = join(temp, 'profile'), project = join(temp, 'project'), otherProject = join(temp, otherProjectName)
  for (const path of [join(agentDir, 'sessions', 'one'), profile, project, otherProject]) await mkdir(path, { recursive: true })
  const report = join(project, 'original report.txt'), reportBytes = 'Complete delivered report\n' + 'long-unbroken-source-path-'.repeat(40) + '\n' + 'unchanged bytes\n'.repeat(4000)
  await writeFile(report, reportBytes)
  const notes = join(project, 'delivery notes.md'), pdf = join(project, 'delivered document.pdf'), table = join(project, 'inventory.csv'), htmlFile = join(project, 'delivered page.html')
  const frontmatter = 'title: Delivery notes\nauthors: Example team'
  const notesBytes = '---\n' + frontmatter + '\n---\n\n# Delivery notes\n\nThis is **actual Markdown** from the retained file.\n\n| Task | Status |\n| --- | --- |\n| First task | Ready |\n\n[Reference](https://example.invalid/reference with spaces)\n![No network image](https://example.invalid/no-thumb-image.png)\n\n```js\nconst count = 42\n```\n\nInline $E=mc^2$.\n'
  await writeFile(notes, notesBytes)
  await writeFile(pdf, thumbnailPdf())
  const landscape = join(project, 'landscape document.pdf'), shortText = join(project, 'quick note.txt')
  await writeFile(landscape, thumbnailPdf(90))
  await writeFile(shortText, 'A short retained note.\n')
  await writeFile(table, 'Product,Count,Status\nNotebook,12,Ready\nPencil,24,Ordered\nPaper,100,Ready\n')
  await writeFile(htmlFile, '<!doctype html><meta charset="utf-8"><style>body{background:#fff;font-family:system-ui;padding:12px;margin:0}h1{font-size:18px;color:#206040}.chart{background:#d8eee2;padding:12px}</style><h1>Delivered HTML page</h1><p>Real confined document preview</p><div class="chart">42 completed tasks</div>')
  const deliveries = [report, notes, pdf, table, htmlFile, landscape, shortText]
  const pngs = Array.from({ length: 8 }, (_, index) => new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="' + (100 + index * 24) + '"><rect width="160" height="400" fill="' + (index === 0 || index === 7 ? '#fff' : 'hsl(' + index * 45 + ',60%,55%)') + '"/>' + (index === 0 || index === 7 ? '<rect x="25" y="28" width="90" height="35" fill="#333"/>' : '') + '</svg>').render().asPng())
  const entries = [{ type: 'session', id: 'ui-one', cwd: project }]
  for (let index = 0; index < 120; index++) entries.push({ type: 'message', id: 'image-' + index, message: { role: 'user', timestamp: 100 + index, content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(pngs[index % 8]).toString('base64') }] } })
  entries.push({ type: 'message', id: 'calls', message: { role: 'assistant', timestamp: 300, content: [{ type: 'toolCall', id: 'deliver', name: 'present', arguments: { files: deliveries.map(path => ({ path })) } }, { type: 'toolCall', id: 'fetch', name: 'web_fetch', arguments: { url: 'https://example.org/manual' } }] } })
  entries.push({ type: 'message', id: 'delivery', message: { role: 'toolResult', toolName: 'present', toolCallId: 'deliver', timestamp: 301, isError: false, content: [], details: { kind: 'pith-present-v1', files: deliveries.map(path => ({ path, size: path === report ? Buffer.byteLength(reportBytes) : 100 })) } } })
  entries.push({ type: 'message', id: 'fetch', message: { role: 'toolResult', toolName: 'web_fetch', toolCallId: 'fetch', timestamp: 302, isError: false, content: [{ type: 'text', text: 'Offline preserved website text\nUseful reference material' }] } })
  const unavailable = join(project, 'unavailable.pdf')
  entries.push({ type: 'message', id: 'missing-call', message: { role: 'assistant', timestamp: 303, content: [{ type: 'toolCall', id: 'missing', name: 'present', arguments: { files: [{ path: unavailable }] } }] } })
  entries.push({ type: 'message', id: 'missing-result', message: { role: 'toolResult', toolName: 'present', toolCallId: 'missing', timestamp: 304, isError: false, content: [], details: { kind: 'pith-present-v1', files: [{ path: unavailable, size: 100 }] } } })
  entries.push({ type: 'message', id: 'invalid-image', message: { role: 'user', timestamp: 305, content: [{ type: 'image', mimeType: 'image/png', data: 'not-base64' }] } })
  entries.push({ type: 'session_info', name: 'Gallery source' })
  const sessionPath = join(agentDir, 'sessions', 'one', 'chat.jsonl')
  await writeFile(sessionPath, entries.map(v => JSON.stringify(v)).join('\n') + '\n')
  await writeFile(join(agentDir, 'sessions', 'one', 'other.jsonl'), [{ type: 'session', id: 'ui-two', cwd: otherProject }, { type: 'message', id: 'other', message: { role: 'user', timestamp: 400, content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(pngs[0]).toString('base64') }] } }].map(v => JSON.stringify(v)).join('\n') + '\n')
  await build({ stdin: { contents: "export {startLibraryService} from './src/main/library/service';export {registerLibraryIpc} from './src/main/library/ipc';export {installMediaProtocol,registerMediaScheme} from './src/main/media-protocol';export {readPdfStat,readPdfRange} from './src/main/pdf';export {readTableStat,readTableSlice,readTableRange} from './src/main/table';export {htmlPreviews} from './src/main/html-preview';export {readFileDocument,listFileDirectory,readFileGitDiff} from './src/main/file-browser';export {installHtmlPreviewWiring} from './src/main/html-preview-wiring';", resolveDir: repo }, outfile: join(temp, 'routes.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'],
    plugins: [{ name: 'absolute-dependencies', setup(builder) { builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$|^proper-lockfile$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })) } }] })
  await symlink(join(repo, 'out/main/library-worker.mjs'), join(temp, 'library-worker.mjs'))
  const html = `<!doctype html><html><head><style>body{margin:0}#root{height:100vh}</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {LibraryPage} from '/src/components/app/LibraryPage.tsx';import {LibrarySection} from '/src/components/app/settings/LibrarySection.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';import {ToastProvider} from '/src/components/app/ToastProvider.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {setUiStyle} from '/src/lib/ui-style.ts';import '/src/styles.css';
window.setUiStyle=setUiStyle;setUiStyle('squircle');
localStorage.setItem('pi-app:locale','en');window.sessions=[];
const h=React.createElement;function App(){const [open,setOpen]=React.useState(true),[settings,setSettings]=React.useState(false);const {setLocale}=useI18n();window.setLocale=setLocale;window.openLibrary=()=>{setSettings(false);setOpen(true)};return h('div',{style:{height:'100%',position:'relative'}},
h(LibraryPage,{open,onBack:()=>setOpen(false),onSettings:()=>{setOpen(false);setSettings(true)},onOpenSession:async path=>window.sessions.push(path)}),
settings?h('div',{style:{padding:24}},h(LibrarySection)):null)}
createRoot(document.getElementById('root')).render(h(I18nProvider,null,h(ToastProvider,null,h(ImagePreviewProvider,null,h(App)))));
</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temp, 'vite'), logLevel: 'error', resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'library-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/__slow-image?')) {
        const index = Number(new URL(req.url, 'http://localhost').searchParams.get('i'))
        res.setHeader('Cache-Control', 'no-store')
        setTimeout(() => { if (index % 7 === 0) { res.statusCode = 404; res.end() } else { res.setHeader('Content-Type', 'image/png'); res.end(pngs[index % pngs.length]) } }, 320 + index % 5 * 100)
        return
      }
      if (req.url !== '/__library.html') return next()
      res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__library.html',html))
    }) } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__library.html', saved = join(temp, 'saved-report.txt'), chosen = join(temp, 'chosen')
  await mkdir(chosen)
  await writeFile(join(temp, 'main.mjs'), `import {app,BrowserWindow,dialog,ipcMain} from 'electron';import {rm} from 'node:fs/promises';
import {startLibraryService,registerLibraryIpc,installMediaProtocol,registerMediaScheme,readPdfStat,readPdfRange,readTableStat,readTableSlice,readTableRange,htmlPreviews,installHtmlPreviewWiring,readFileDocument,listFileDirectory,readFileGitDiff} from './routes.mjs';
registerMediaScheme();app.setPath('userData',${JSON.stringify(profile)});
app.whenReady().then(async()=>{const library=startLibraryService((channel,payload)=>{for(const win of BrowserWindow.getAllWindows())win.webContents.send(channel,payload)},()=>null);globalThis.library=library;
globalThis.htmlCapturePreferences=[];app.on('browser-window-created',(_event,win)=>{if(win.webContents.isOffscreen())globalThis.htmlCapturePreferences.push(win.webContents.getLastWebPreferences())});
globalThis.libraryQueries=[];globalThis.libraryPageDelays={};globalThis.libraryInFlight=0;const originalPage=library.page.bind(library);library.page=async query=>{globalThis.libraryInFlight++;try{const delay=globalThis.libraryPageDelays[query.kind]??0;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));if(query.kind==='file'&&query.before)await new Promise(resolve=>setTimeout(resolve,350));const result=await originalPage(query);globalThis.libraryQueries.push({query,count:result.items.length,next:result.next});return result}finally{globalThis.libraryInFlight--}};
registerLibraryIpc(library);installMediaProtocol();globalThis.external=[];ipcMain.handle('shell:openExternal',(_e,url)=>globalThis.external.push(url));ipcMain.handle('shell:openPath',()=> '');ipcMain.handle('shell:showInFolder',()=>{});
globalThis.documentReads=[];ipcMain.handle('files:document',async(_e,request)=>{globalThis.documentReads.push(request.path);await new Promise(resolve=>setTimeout(resolve,100));return readFileDocument(request)});ipcMain.handle('files:directory',(_e,request,offset)=>listFileDirectory(request,offset));ipcMain.handle('files:gitDiff',(_e,request)=>readFileGitDiff(request));
ipcMain.handle('files:pdfStat',(_e,request)=>readPdfStat(request));ipcMain.handle('files:pdfRange',(_e,request,begin,end)=>readPdfRange(request,begin,end));
ipcMain.handle('files:tableStat',(_e,request)=>readTableStat(request));ipcMain.handle('files:tableSlice',(_e,request,offset,maxBytes)=>readTableSlice(request,offset,maxBytes));ipcMain.handle('files:tableRange',(_e,request,begin,end)=>readTableRange(request,begin,end));
ipcMain.handle('files:htmlPreview',(_e,request)=>htmlPreviews.open(request));
globalThis.saveOptions=[];dialog.showSaveDialog=async(_win,options)=>{globalThis.saveOptions.push(options);return {canceled:false,filePath:${JSON.stringify(saved)}}};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(chosen)}]});
for(let i=0;i<1000;i++){const status=await library.status();if(!status.scanning&&status.total>=131)break;await new Promise(r=>setTimeout(r,20))};for(const path of ${JSON.stringify(deliveries)})await rm(path);
const win=new BrowserWindow({width:1180,height:820,show:false,webPreferences:{preload:${JSON.stringify(join(repo,'out/preload/index.mjs'))},contextIsolation:true,sandbox:false,webviewTag:true}});installHtmlPreviewWiring(win);await win.loadURL(${JSON.stringify(url)});});`)
  application = await _electron.launch({ executablePath: electron, args: [join(temp, 'main.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PI_CODING_AGENT_DIR: agentDir } })
  let diagnostics = ''
  application.process().stderr?.on('data', data => { diagnostics += data.toString() })
  const page = await application.firstWindow({ timeout: 60000 }).catch(error => { throw new Error(String(error) + '\n' + diagnostics) })
  const errors = []; page.on('pageerror', error => errors.push(error.stack ?? String(error)))
  // Playwright's injected poller treats a Promise as truthy; await IPC in Node
  // before checking the predicate so backend checks cannot pass prematurely.
  const waitUntil = async work => {
    const deadline = Date.now() + 30000
    while(Date.now() < deadline) { if(await work())return;await page.waitForTimeout(50) }
    throw new Error('Timed out waiting for Library IPC state')
  }
  const waitForBackend = predicate => waitUntil(()=>page.evaluate(predicate))

  await page.getByText('121 records', { exact: true }).waitFor()
  const hideUnavailable = page.getByRole('checkbox', { name: 'Hide unavailable content', exact: true })
  assert(await hideUnavailable.isChecked(), 'unavailable content is hidden by default')
  const imageCard = page.locator('[data-library-item]').first()
  const imageButton = imageCard.getByRole('button', { name: 'Image information: Attached image', exact: true })
  const gallery = page.getByRole('region', { name: 'Library', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-library-item] img')].some(img => img.complete && img.naturalWidth > 0))
  assert.equal(await imageCard.textContent(), '', 'readable image cards contain only the image, without captions or action rows')
  assert.equal(await imageCard.getByRole('button').count(), 1, 'image actions live in the shared information popover')
  const canvasStyle = await gallery.evaluate(node => ({ color: getComputedStyle(node).backgroundColor, pattern: getComputedStyle(node).backgroundImage }))
  assert.equal(canvasStyle.color, 'rgba(0, 0, 0, 0)', 'the image canvas has no solid white fill')
  assert(canvasStyle.pattern.includes('gradient'), 'transparent and white images have a visible alpha canvas between them')
  const cardBefore = await imageCard.boundingBox(), scrollBefore = await gallery.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }))
  const assertCardSpacing = async () => {
    const lanes = await gallery.evaluate(node => {
      const lanes = new Map()
      for (const card of node.querySelectorAll('[data-library-item]')) {
        const rect = card.getBoundingClientRect(), key = Math.round(rect.left)
        const lane = lanes.get(key) ?? []; lane.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }); lanes.set(key, lane)
      }
      return [...lanes.values()].map(lane => lane.sort((a, b) => a.top - b.top)).sort((a, b) => a[0].left - b[0].left)
    })
    for (let i = 1; i < lanes.length; i++) assert(lanes[i][0].left - lanes[i - 1][0].right >= 20, 'adjacent columns leave room between cards and selection frames')
    for (const lane of lanes) for (let i = 1; i < lane.length; i++) assert(lane[i].top - lane[i - 1].bottom >= 20, 'variable-height cards retain vertical spacing in each masonry lane')
  }
  await assertCardSpacing()
  const plainShadow = await imageButton.evaluate(node => getComputedStyle(node).boxShadow)
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-images-en.png') })
  await page.evaluate(() => {
    document.addEventListener('click', () => { window.imageClickedAt = performance.now() }, { once: true, capture: true })
    window.singleClickObserver = new MutationObserver(() => {
      if (document.querySelector('[data-library-image-info]')) {
        window.imageInfoLatency = performance.now() - window.imageClickedAt; window.singleClickObserver.disconnect()
      }
    })
    window.singleClickObserver.observe(document.body, { childList: true, subtree: true })
  })
  await imageButton.click()
  const information = page.getByRole('dialog', { name: 'Image information: Attached image', exact: true })
  await information.waitFor()
  assert(await page.evaluate(() => window.imageInfoLatency < 400), 'a pointer single-click no longer waits half a second for information')
  await information.getByText('160 × 100 pixels', { exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1, 'a single click shows information instead of the enlarged viewer')
  assert.equal(await imageButton.getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('[data-library-item][data-selected]').count(), 1)
  assert.notEqual(await imageButton.evaluate(node => getComputedStyle(node).boxShadow), plainShadow, 'selection paints a fine highlight without changing the image geometry')
  assert.deepEqual(await imageCard.boundingBox(), cardBefore)
  assert.deepEqual(await gallery.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight })), scrollBefore)
  for (const name of ['Preview Attached image', 'Save as', 'Open source conversation', 'Remove from library']) assert(await information.getByRole('button', { name, exact: true }).isEnabled())
  await page.waitForTimeout(220)
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-image-information-en.png') })
  await information.getByRole('button', { name: 'Save as', exact: true }).click()
  await page.waitForTimeout(100)
  assert.deepEqual(await readFile(saved), Buffer.from(pngs[0]), 'image popover Save As preserves every original image byte')
  await information.getByRole('button', { name: 'Open source conversation', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.sessions), [join(agentDir, 'sessions', 'one', 'other.jsonl')])
  await imageButton.click()
  await information.waitFor()
  await information.getByRole('button', { name: 'Remove from library', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Remove from library', exact: true })
  await confirmation.waitFor()
  assert(await page.locator('[data-library-image-info]').evaluate(node => node.closest('[role="dialog"]').inert), 'the parent information panel stays mounted and suspended while confirming deletion')
  await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await information.waitFor()
  assert(!await information.evaluate(node => node.inert))
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Remove from library')
  assert.equal(await page.locator('[data-library-item][data-selected]').count(), 1, 'cancelling deletion retains the selected image and its information')
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-library-page]').isVisible(), 'Escape closes image information before leaving the library')
  await imageButton.focus(); await imageButton.press('Enter')
  await information.waitFor()
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-library-image-info'))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Image information: Attached image')
  const rightCard = page.locator('[data-library-item]').nth(3)
  await rightCard.getByRole('button').click()
  await information.waitFor(); await page.waitForTimeout(220)
  const infoBounds = await information.boundingBox(), rightBounds = await rightCard.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert(infoBounds.x + infoBounds.width <= rightBounds.x, 'the information panel flips to the left for a right-edge image')
  assert(infoBounds.x >= 8 && infoBounds.y >= 8 && infoBounds.x + infoBounds.width <= viewport.width - 8 && infoBounds.y + infoBounds.height <= viewport.height - 8, 'image information stays within the viewport')
  assert.equal(await page.locator('[data-library-item][data-selected]').count(), 1, 'selecting another image moves the highlight and reuses one popover')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-image-information-flipped-en.png') })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-library-image-info]'))
  await page.evaluate(() => {
    window.imageInfoFlashes = 0
    window.infoFlashObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && (node.matches('[data-library-image-info]') || node.querySelector('[data-library-image-info]'))) window.imageInfoFlashes++
    })
    window.infoFlashObserver.observe(document.body, { childList: true, subtree: true })
  })
  await imageButton.dblclick({ delay: 150 })
  const viewer = page.getByRole('dialog', { name: 'Attached image', exact: true })
  await viewer.waitFor()
  await page.waitForTimeout(600)
  const initialLoaded = Number((await viewer.locator('[data-image-preview-navigation] span[aria-live]').textContent()).split('/')[1])
  assert.equal(await viewer.locator('[data-image-preview-navigation] span[aria-live]').textContent(),'1/'+initialLoaded)
  const originalPreviewSource = await viewer.locator('img').getAttribute('src')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(total => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent === '2/'+total,initialLoaded)
  assert.notEqual(await viewer.locator('img').getAttribute('src'),originalPreviewSource,'library navigation follows the current result order')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(total => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent === '1/'+total,initialLoaded)
  assert.equal(await page.evaluate(() => { window.infoFlashObserver.disconnect(); return window.imageInfoFlashes }), 0, 'even a slower double-click never mounts an information popup before or after the viewer')
  assert.equal(await imageButton.getAttribute('aria-expanded'), 'false', 'double-click opens the shared enlarged viewer directly')
  assert.equal(await page.locator('[role="dialog"]').evaluateAll(nodes => nodes.filter(node => !node.closest('[inert]')).length), 1, 'only the enlarged viewer owns interaction while the information panel finishes its visual exit')
  const radius = await imageCard.locator('img').evaluate(node => getComputedStyle(node).borderRadius)
  assert.equal(await viewer.locator('img').evaluate(node => getComputedStyle(node).borderRadius), radius, 'thumbnails use the same corner size as enlarged images')
  assert.notEqual(radius, '0px', 'the squircle style rounds the image itself')
  await page.evaluate(() => window.setUiStyle('square'))
  assert.equal(await viewer.locator('img').evaluate(node => getComputedStyle(node).borderRadius), await imageCard.locator('img').evaluate(node => getComputedStyle(node).borderRadius), 'both image surfaces follow the live interface-style setting')
  await page.evaluate(() => window.setUiStyle('squircle'))
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-image-preview-en.png') })
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  // A second native press still wins after information has already appeared.
  // Keeping that press on the original card preserves slow double-click input.
  await imageButton.dblclick({ delay: 350 })
  await viewer.waitFor()
  assert.equal(await imageButton.getAttribute('aria-expanded'), 'false')
  for(let index=1;index<initialLoaded;index++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(current => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent?.startsWith(current+'/'),index+1)
  }
  assert(await viewer.getByRole('button',{name:'Next image',exact:true}).isEnabled(),'the current page boundary can request more images')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(current => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent?.startsWith(current+'/'),initialLoaded+1)
  await page.waitForFunction(() => {const image=document.querySelector('[role=dialog][aria-modal=true] img');return image?.complete&&image.naturalWidth>0})
  for(let index=initialLoaded+1;index<121;index++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(current => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent?.startsWith(current+'/'),index+1)
  }
  await page.waitForFunction(() => document.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent === '121/121')
  assert(await viewer.getByRole('button',{name:'Next image',exact:true}).isDisabled(),'the final filtered result stays inside the collection')
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await rightCard.getByRole('button').click()
  await information.waitFor()
  const firstId = await imageCard.getAttribute('data-library-item')
  await page.evaluate(() => {
    window.switchedInfoIds = []
    window.switchInfoObserver = new MutationObserver(() => {
      const id = document.querySelector('[data-library-info]')?.getAttribute('data-library-info-item')
      if (id) window.switchedInfoIds.push(id)
    })
    window.switchInfoObserver.observe(document.body, { childList: true, attributes: true, subtree: true })
  })
  await imageButton.dblclick({ delay: 150 })
  await viewer.waitFor(); await page.waitForTimeout(600)
  assert(!(await page.evaluate(() => { window.switchInfoObserver.disconnect(); return window.switchedInfoIds })).includes(firstId), 'double-clicking another image cannot replace an exiting information panel with the new image details')
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await imageButton.click()
  await gallery.evaluate(node => { node.scrollTop = 400 })
  await page.waitForTimeout(650)
  assert.equal(await page.locator('[data-library-image-info]').count(), 0, 'scrolling cancels a deferred single-click instead of opening stale image information')
  await gallery.evaluate(node => { node.scrollTop = 0 })
  let imagePages
  for (let attempt=0;attempt<12;attempt++) {
    await gallery.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight })
    await page.waitForTimeout(100)
    imagePages=await application.evaluate(()=>globalThis.libraryQueries.filter(record=>record.query.kind==='image'))
    if(imagePages.at(-1)?.next===null)break
  }
  assert(imagePages.some(record=>record.query.before),'scrolling the photo wall fetches the next production cursor')
  assert.equal(imagePages.reduce((count,record)=>count+record.count,0),121,'every image is reachable through photo-wall pagination')
  await page.waitForFunction(() => { const node=document.querySelector('section[aria-label="Library"]');return node&&node.scrollHeight>3000 })
  assert(await page.locator('[data-library-item]').count() < 100, 'the photo wall virtualizes cards rather than retaining every image node')
  const queryCount=await application.evaluate(()=>globalThis.libraryQueries.length)
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(940,720))
  await page.waitForTimeout(150)
  assert.equal(await application.evaluate(()=>globalThis.libraryQueries.length),queryCount,'width changes lay out existing items without refetching the library')
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1180,820))
  await page.waitForTimeout(200)
  await page.evaluate(async () => {
    await document.fonts.ready
    window.slowImages = { started: 0, loaded: 0, failed: 0 }
    const delayImages = () => { for (const img of document.querySelectorAll('[data-library-item] img')) {
      if (img.dataset.delayed) continue
      img.dataset.delayed = 'true'
      const index = window.slowImages.started++
      img.addEventListener('load', () => window.slowImages.loaded++, { once: true })
      img.addEventListener('error', () => window.slowImages.failed++, { once: true })
      img.src = '/__slow-image?i=' + index
    } }
    window.slowImageObserver = new MutationObserver(delayImages)
    window.slowImageObserver.observe(document.querySelector('section[aria-label="Library"]'), { childList: true, subtree: true })
    delayImages()
  })
  const geometry = () => gallery.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight,
    cards: [...node.querySelectorAll('[data-library-item]')].map(card => { const bounds = card.getBoundingClientRect(); return { id: card.dataset.libraryItem, top: bounds.top, left: bounds.left, height: bounds.height } }) }))
  for (const top of [2000, 4500, 1200, 6000]) {
    await gallery.evaluate((node, top) => { node.scrollTop = top }, top)
    await page.waitForTimeout(100)
    const before = await geometry()
    await page.waitForTimeout(850)
    assert.deepEqual(await geometry(), before, 'late decoding and image failures preserve card geometry, scroll offset and scroll range')
  }
  const delayed = await page.evaluate(() => { window.slowImageObserver.disconnect(); return window.slowImages })
  assert(delayed.loaded > 0 && delayed.failed > 0, 'scroll stability covers both slow images and broken image placeholders')
  await gallery.evaluate(node => { node.scrollTop = 0 })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-library-item] img')].some(img => img.complete && img.naturalWidth > 0))
  const retryImageId = await gallery.locator('[data-library-item]').filter({ has: page.locator('img') }).first().evaluate(card => {
    card.querySelector('img').dispatchEvent(new Event('error'))
    return card.dataset.libraryItem
  })
  const retryImage = page.locator('[data-library-item="' + retryImageId + '"]')
  await retryImage.getByText('Could not save copy', { exact: true }).waitFor()
  const queriesBeforeImageRefresh = await application.evaluate(() => globalThis.libraryQueries.length)
  await page.getByRole('button', { name: /^(Refresh|Show new records)$/ }).click()
  await waitUntil(() => application.evaluate((_electron, before) => globalThis.libraryQueries.length > before && globalThis.libraryInFlight === 0, queriesBeforeImageRefresh))
  await retryImage.locator('img').waitFor()
  await retryImage.locator('img').evaluate(img => img.decode())
  await page.getByText('121 records', { exact: true }).waitFor()
  const headerGeometry = () => page.locator('[data-library-filters]').evaluate(node => ({
    height: node.getBoundingClientRect().height,
    project: node.querySelector('[aria-label="Filter by project"]').getBoundingClientRect().width,
    search: node.querySelector('input').getBoundingClientRect().width
  }))
  const allProjectsHeader = await headerGeometry()
  await page.getByRole('button', { name: 'Filter by project', exact: true }).click()
  await page.getByRole('option', { name: otherProjectName + ' · 1', exact: true }).click()
  await page.getByText('1 records', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-library-item]').count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Filter by project', exact: true }).innerText(), otherProjectName, 'the selected project displays only its name')
  const selectedHeader = await headerGeometry()
  assert.equal(selectedHeader.height, allProjectsHeader.height, 'a long project name stays on the same header row')
  assert(selectedHeader.project > allProjectsHeader.project && selectedHeader.search < allProjectsHeader.search, 'a long project name borrows space from the search field')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-long-project-en.png') })
  await page.getByRole('button', { name: 'Filter by project', exact: true }).click()
  await page.getByRole('option', { name: 'All projects', exact: true }).click()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  const fileList = page.locator('[data-library-file-list] section')
  const reportRow = page.locator('[data-library-file-row]').filter({ hasText: 'original report.txt' })
  const fileGeometry = () => fileList.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight,
    rows: [...node.querySelectorAll('[data-library-item]')].map(row => { const bounds = row.getBoundingClientRect(); return { id: row.dataset.libraryItem, top: bounds.top, left: bounds.left, height: bounds.height } }) }))
  await reportRow.waitFor()
  const assertFileIconAlignment = async () => {
    const centers = await page.locator('[data-library-file-row]').evaluateAll(rows => rows.map(row => {
      const icon = row.querySelector('[data-file-icon]').getBoundingClientRect()
      const title = row.querySelector('[data-library-file-name]').getBoundingClientRect()
      return { name: row.textContent, difference: Math.abs(icon.top + icon.height / 2 - title.top - title.height / 2) }
    }))
    for (const row of centers) assert(row.difference < 1, 'file artwork aligns with the filename center: ' + row.name)
  }
  const assertCategoryTabAlignment = async () => {
    const centers = await page.locator('[data-library-filters] [role="tab"]').evaluateAll(tabs => tabs.map(tab => {
      const icon = tab.querySelector('svg').getBoundingClientRect()
      const label = [...tab.children].find(child => child.tagName === 'SPAN' && child.textContent.trim()).getBoundingClientRect()
      return { name: tab.textContent, difference: Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) }
    }))
    assert.equal(centers.length, 3)
    for (const tab of centers) assert(tab.difference < 1, 'category icon and label share a center: ' + tab.name)
  }
  await assertFileIconAlignment()
  await assertCategoryTabAlignment()
  assert.equal(await page.locator('[data-library-file-row]').count(),7,'retained files are listed after every original is removed')
  assert.equal(await reportRow.locator('img:not([data-file-icon]), pre, canvas').count(),0,'file rows contain filename and metadata without thumbnails')
  assert.match(await reportRow.textContent(),/Gallery source/,'the second row shows project and source conversation')
  assert.match(await reportRow.textContent(),/Delivered/,'the third row shows delivery, size and date')
  assert.equal(await application.evaluate(()=>globalThis.documentReads.length),0,'listing files never reads their bodies')
  const detail = page.locator('[data-library-file-detail]')
  await reportRow.getByRole('button').click()
  const pendingTextGeometry=await fileGeometry()
  await detail.locator('[data-file-source]').getByText('Complete delivered report',{exact:true}).waitFor()
  assert.deepEqual(await fileGeometry(),pendingTextGeometry,'a delayed full text read preserves list positions')
  assert.equal(await page.locator('[data-library-file-list]').isVisible(),true,'preview leaves the list visible')
  assert(await page.locator('[data-library-page]').isVisible(), 'list selection keeps Library open beside its preview')
  await assertFileIconAlignment()
  const fileToolbar = detail.locator('[data-file-toolbar]')
  assert.equal(await fileToolbar.count(), 1, 'file and Library actions share one toolbar')
  assert.equal(await detail.getByText('Gallery source', { exact: true }).count(), 0, 'metadata no longer occupies the preview header')
  for (const name of ['Refresh files', 'Open in default app', 'Open enclosing folder', 'Save as', 'File information: original report.txt', 'Open source conversation', 'Remove from library', 'Close file preview']) {
    assert.equal(await fileToolbar.getByRole('button', { name, exact: true }).count(), 1, 'the merged toolbar contains ' + name)
  }
  assert.equal(await detail.getByRole('button', { name: 'Save as…', exact: true }).count(), 0, 'export is not duplicated')
  const toolbarBounds = await fileToolbar.evaluate(node => {
    const toolbar = node.getBoundingClientRect()
    return [...node.querySelectorAll('button')].map(button => {
      const bounds = button.getBoundingClientRect()
      return { label: button.getAttribute('aria-label'), centered: Math.abs(bounds.top + bounds.height / 2 - toolbar.top - toolbar.height / 2) < 1, inside: bounds.left >= toolbar.left && bounds.right <= toolbar.right }
    })
  })
  for (const button of toolbarBounds) assert(button.centered && button.inside, 'a single visible action row contains ' + button.label)
  await detail.locator('[data-file-source]').evaluate(node => { window.librarySourceNode = node })
  const beforeInformation = await fileGeometry()
  const sourceReadsBeforeInformation = await application.evaluate(() => globalThis.documentReads.length)
  const fileInformation = page.getByRole('dialog', { name: 'File information: original report.txt', exact: true })
  await fileToolbar.getByRole('button', { name: 'File information: original report.txt', exact: true }).press('Enter')
  await fileInformation.getByText('Gallery source', { exact: true }).waitFor()
  await fileInformation.getByText('Copy saved', { exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-library-file-info'))
  await page.waitForFunction(() => { const portal = document.querySelector('[data-library-file-info]')?.closest('[data-morph-popover-portal]'); return portal && Number(getComputedStyle(portal).opacity) >= 0.99 })
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-file-information.png') })
  assert.deepEqual(await fileGeometry(), beforeInformation, 'opening information does not move list rows')
  assert(await page.evaluate(() => window.librarySourceNode === document.querySelector('[data-file-source]')), 'information retains the same complete file reader')
  assert.equal(await application.evaluate(() => globalThis.documentReads.length), sourceReadsBeforeInformation, 'information never re-reads the file body')
  await fileToolbar.getByRole('button', { name: 'Remove from library', exact: true }).click()
  const fileConfirmation = page.getByRole('dialog', { name: 'Remove from library', exact: true })
  await fileConfirmation.waitFor()
  assert(await page.locator('[data-library-file-info]').evaluate(node => node.closest('[role="dialog"]').inert), 'file information stays mounted and inert during confirmation')
  await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel')
  await fileConfirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await fileInformation.waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Remove from library')
  await fileInformation.getByRole('button', { name: 'Close file information', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'File information: original report.txt')
  await fileToolbar.getByRole('button', { name: 'File information: original report.txt', exact: true }).press('Enter')
  await fileInformation.waitFor()
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-library-page]').isVisible(), 'Escape dismisses information before leaving Library')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'File information: original report.txt')
  const retainedReport = await page.evaluate(()=>window.pi.libraryPage({kind:'file',query:'original report.txt',hideUnavailable:true}))
  assert.equal(await readFile(retainedReport.value.items[0].archivedPath,'utf8'),reportBytes,'the full pane reads the complete retained copy')
  await page.waitForFunction(()=>{const source=document.querySelector('[data-file-source]');return source&&source.scrollWidth<=source.clientWidth+1&&source.querySelector('[data-source-line="2"]')?.getBoundingClientRect().height>40})
  const beforePreview = await fileGeometry()
  const indexReads = await application.evaluate(()=>globalThis.libraryQueries.length)
  await detail.getByRole('button',{name:'Find in file',exact:true}).click()
  await detail.getByRole('textbox').fill('unchanged bytes')
  await detail.getByRole('button',{name:'Close find',exact:true}).click()
  await page.locator('[data-library-file-row]').filter({hasText:'delivery notes.md'}).getByRole('button').click()
  await detail.locator('[data-file-source]').getByText('# Delivery notes',{exact:true}).waitFor()
  assert.equal(await detail.getByRole('tab',{name:'Source',exact:true}).getAttribute('aria-selected'),'true','Markdown opens on literal source')
  assert.equal(await detail.locator('[data-file-markdown]').count(),0)
  await detail.getByRole('tab',{name:'Preview',exact:true}).click()
  await detail.locator('[data-file-markdown] h1').getByText('Delivery notes',{exact:true}).waitFor()
  await detail.getByRole('tab',{name:'Source',exact:true}).click()
  await page.locator('[data-library-file-row]').filter({hasText:'delivered document.pdf'}).getByRole('button').click()
  await detail.locator('[data-file-pdf]').waitFor()
  await detail.getByRole('button',{name:'Fit page',exact:true}).click()
  await page.waitForFunction(()=>{const canvas=document.querySelector('[data-file-pdf] canvas');return canvas?.width>0&&canvas?.height>0})
  const pdfPixels = await detail.locator('[data-file-pdf] canvas').first().evaluate(canvas=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
    let blue=0,red=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i+2]>pixels[i]+70)blue++;if(pixels[i]>pixels[i+2]+70)red++}
    return {blue,red}
  })
  assert(pdfPixels.blue>50&&pdfPixels.red>50,'the full PDF engine paints both ends of the first page')
  await detail.locator('[data-file-pdf]').evaluate(node=>{window.libraryPdfNode=node})
  const resize = page.getByRole('separator',{name:'Resize file list and preview',exact:true})
  await resize.focus();await resize.press('ArrowRight')
  assert.equal(await detail.locator('[data-file-pdf]').count(),1)
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(940,720))
  await page.waitForTimeout(150)
  await assertFileIconAlignment()
  await assertCategoryTabAlignment()
  assert.equal(await application.evaluate(()=>globalThis.libraryQueries.length),indexReads,'split and window resize do not refetch the Library')
  assert(await page.evaluate(()=>window.libraryPdfNode===document.querySelector('[data-file-pdf]')),'resize retains the same file engine')
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1180,820))
  if(screenshots)await page.screenshot({path:join(screenshots,'library-file-list-pdf.png')})
  await page.locator('[data-library-file-row]').filter({hasText:'inventory.csv'}).getByRole('button').click()
  await detail.locator('[data-file-table]').getByText('Notebook',{exact:true}).waitFor()
  await page.locator('[data-library-file-row]').filter({hasText:'delivered page.html'}).getByRole('button').click()
  await detail.locator('webview').waitFor()
  await page.waitForFunction(()=>{const guest=document.querySelector('[data-file-html] webview');try{return guest?.getURL().includes('.localhost:')&&!guest.isLoading()}catch{return false}})
  assert.match(await detail.locator('webview').evaluate(guest=>guest.executeJavaScript('document.body.innerText')),/Delivered HTML page/,'the retained HTML document actually loads before its guest is switched')
  assert.equal(await detail.locator('webview').evaluate(guest=>guest.getAttribute('partition')),'pith-html-preview','HTML uses the same confined, memory-only guest')
  await detail.locator('[data-file-html]').evaluate(node => { window.libraryHtmlNode = node })
  const listWidthBeforeNarrowPreview = await page.locator('[data-library-file-list]').evaluate(node => node.getBoundingClientRect().width)
  await resize.focus()
  for (let step = 0; step < 25; step++) await resize.press('Shift+ArrowRight')
  const narrowToolbar = await fileToolbar.evaluate(node => {
    const toolbar = node.getBoundingClientRect()
    return [...node.querySelectorAll('button')].map(button => {
      const bounds = button.getBoundingClientRect()
      return { name: button.getAttribute('aria-label'), inside: bounds.left >= toolbar.left && bounds.right <= toolbar.right,
        centered: Math.abs(bounds.top + bounds.height / 2 - toolbar.top - toolbar.height / 2) < 1 }
    })
  })
  for (const button of narrowToolbar) assert(button.inside && button.centered, 'the narrowest preview keeps every action on one visible row: ' + button.name)
  assert(await page.evaluate(() => window.libraryHtmlNode === document.querySelector('[data-file-html]')), 'toolbar fitting never remounts the confined HTML preview')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-file-toolbar-narrow.png') })
  const handleBounds = await resize.boundingBox()
  const fittedListWidth = await page.locator('[data-library-file-list]').evaluate(node => node.getBoundingClientRect().width)
  const handleX = handleBounds.x + handleBounds.width / 2, handleY = handleBounds.y + handleBounds.height / 2
  await page.mouse.move(handleX, handleY); await page.mouse.down()
  await page.mouse.move(handleX + listWidthBeforeNarrowPreview - fittedListWidth, handleY); await page.mouse.up()
  await fileList.evaluate((node,top)=>{node.scrollTop=top},beforePreview.top)
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.deepEqual(await fileGeometry(),beforePreview,'late document reads and preview engines never move list rows or the scroll range')
  await reportRow.getByRole('button').click()
  await detail.locator('[data-file-source]').getByText('Complete delivered report',{exact:true}).waitFor()
  if(screenshots)await page.screenshot({path:join(screenshots,'library-file-list-text.png')})
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  if(screenshots)await page.screenshot({path:join(screenshots,'library-file-list-dark.png')})
  await page.evaluate(()=>document.documentElement.classList.remove('dark'))
  await hideUnavailable.click()
  await page.getByText('8 records',{exact:true}).waitFor()
  await page.locator('[data-library-file-row]').filter({hasText:'unavailable.pdf'}).getByRole('button').click()
  await detail.getByText('Preview unavailable',{exact:true}).waitFor()
  assert(await detail.getByRole('button',{name:'Save as',exact:true}).isDisabled())
  assert(await detail.getByRole('button',{name:'Refresh files',exact:true}).isDisabled())
  await detail.getByRole('button', { name: 'File information: unavailable.pdf', exact: true }).click()
  await page.getByRole('dialog', { name: 'File information: unavailable.pdf', exact: true }).getByText('Original unavailable', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close file information', exact: true }).click()
  assert.equal(await detail.locator('[data-files-pane]').count(),0,'unavailable selection never retains the previous file canvas')
  await page.reload()
  await page.getByText('122 records',{exact:true}).waitFor()
  assert(!await hideUnavailable.isChecked(),'availability preference survives reload')
  await hideUnavailable.click();await page.getByText('121 records',{exact:true}).waitFor()
  await page.getByRole('tab',{name:'Files',exact:true}).click();await page.getByText('7 records',{exact:true}).waitFor()
  await reportRow.getByRole('button').press('Enter')
  await detail.locator('[data-file-source]').getByText('Complete delivered report',{exact:true}).waitFor()
  for(const name of ['Save as','Open source conversation','Remove from library'])assert(await detail.getByRole('button',{name,exact:true}).isEnabled())
  await detail.getByRole('button',{name:'Close file preview',exact:true}).click()
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Preview original report.txt')
  await reportRow.getByRole('button').click()
  await detail.getByRole('button',{name:'Save as',exact:true}).click();await page.waitForTimeout(150)
  assert.equal(await readFile(saved,'utf8'),reportBytes,'Save As retains every original byte')
  await detail.getByRole('button',{name:'Open source conversation',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.sessions),[sessionPath])
  await page.getByRole('tab', { name: 'Web', exact: true }).click()
  const webRow = page.locator('[data-library-web-row]').filter({ hasText: 'https://example.org/manual' })
  await webRow.waitFor()
  assert.equal(await page.locator('[data-library-web-list]').count(), 1, 'Web uses the same single-column list as Files')
  assert.equal(await page.locator('[data-library-file-row]').count(), 0, 'switching categories does not reuse file rows or selection')
  assert.equal(await page.locator('[data-library-web-detail]').count(), 0, 'the web list starts without a stale file preview')
  assert.equal(await webRow.getByRole('button').count(), 1, 'web rows open the adjacent preview instead of carrying card actions')
  await webRow.getByRole('button').press('Enter')
  const webDetail = page.locator('[data-library-web-detail]')
  const webPath = (await page.evaluate(() => window.pi.libraryPage({ kind: 'web' }))).value.items[0].archivedPath
  assert(webPath.endsWith('.json'), 'saved web sources open as JSON')
  const webSnapshot = JSON.parse(await readFile(webPath, 'utf8'))
  assert.equal(webSnapshot.url, 'https://example.org/manual')
  assert.equal(webSnapshot.excerpt, 'Offline preserved website text\nUseful reference material')
  assert.equal(webSnapshot.provenance.sessionId, 'ui-one')
  const webPreview = webDetail
  await webPreview.getByRole('tab', { name: 'Preview', exact: true }).waitFor()
  assert.equal(await webPreview.getByRole('tab', { name: 'Preview', exact: true }).getAttribute('aria-selected'), 'true', 'the ordinary JSON preview is selected on opening')
  await webPreview.getByText('Offline preserved website text', { exact: false }).waitFor()
  assert(await page.locator('[data-library-web-list]').isVisible(), 'the JSON preview leaves the web list visible')
  await webDetail.getByRole('tab', { name: 'Source', exact: true }).click()
  await webDetail.locator('[data-file-source]').getByText('"excerpt":', { exact: false }).waitFor()
  await webDetail.getByRole('tab', { name: 'Preview', exact: true }).click()
  const webInfoButton = webDetail.getByRole('button', { name: 'Web source information: example.org', exact: true })
  await webInfoButton.press('Enter')
  const webInformation = page.getByRole('dialog', { name: 'Web source information: example.org', exact: true })
  await webInformation.getByText('Gallery source', { exact: true }).waitFor()
  await webInformation.getByRole('button', { name: 'https://example.org/manual', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await webInformation.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Web source information: example.org')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-web-json-preview.png') })
  await webDetail.getByRole('button', { name: 'Save as', exact: true }).click()
  await waitUntil(async () => (await application.evaluate(() => globalThis.saveOptions.at(-1).defaultPath)).endsWith('.json'))
  await waitUntil(async () => (await readFile(saved, 'utf8')).startsWith('{'))
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), webSnapshot, 'Save As exports the full JSON document')
  await webDetail.getByRole('button', { name: 'Open source website', exact: true }).click()
  assert.deepEqual(await application.evaluate(() => globalThis.external), ['https://example.org/manual'])
  const webReadCount = await application.evaluate(() => globalThis.documentReads.length)
  await webDetail.locator('[data-file-preview]').evaluate(node => { window.webPreviewNode = node })
  await page.getByRole('separator', { name: 'Resize web source list and preview', exact: true }).press('ArrowRight')
  assert(await webDetail.locator('[data-file-preview]').evaluate(node => node === window.webPreviewNode), 'web list resize keeps the reader mounted')
  assert.equal(await application.evaluate(() => globalThis.documentReads.length), webReadCount, 'web list resize does not read the document again')
  await webDetail.getByRole('button', { name: 'Close web source preview', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Preview example.org')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search name, source or content' }).fill('no-such-record')
  await page.getByText('No files here yet', { exact: true }).waitFor()
  await application.evaluate(() => { globalThis.libraryPageDelays = { image: 400, file: 400, web: 400 } })
  await page.evaluate(() => {
    window.tabSwitchViolations = []
    const check = () => {
      const library = document.querySelector('[data-library-page]')
      const tabs = [...library.querySelectorAll('[data-library-filters] [role="tab"]')]
      const kind = ['image', 'file', 'web'][tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')]
      for (const card of library.querySelectorAll('[data-library-item]')) {
        if (card.dataset.libraryKind !== kind) window.tabSwitchViolations.push({ kind, recordKind: card.dataset.libraryKind })
      }
      const empty = library.querySelector('[data-library-empty]')
      if (empty && empty.dataset.libraryEmpty !== kind) window.tabSwitchViolations.push({ kind, emptyKind: empty.dataset.libraryEmpty })
      if (library.querySelector('.animate-pulse')) window.tabSwitchViolations.push({ kind, placeholder: true })
    }
    window.tabSwitchObserver = new MutationObserver(check)
    window.tabSwitchObserver.observe(document.querySelector('[data-library-page]'), { subtree: true, childList: true, attributes: true })
    window.tabSwitchRecording = true
    const frame = () => { check(); if (window.tabSwitchRecording) window.tabSwitchFrame = requestAnimationFrame(frame) }
    window.tabSwitchFrame = requestAnimationFrame(frame)
  })
  for (const [tab, kind, title, hint] of [
    ['Web', 'web', 'No web sources here yet', 'download sources'],
    ['Images', 'image', 'No images here yet', 'screenshots'],
    ['Files', 'file', 'No files here yet', 'explicitly delivered files']
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await page.locator('[data-library-empty="' + kind + '"]').getByText(title, { exact: true }).waitFor()
    assert.match(await page.locator('[data-library-empty="' + kind + '"]').textContent(), new RegExp(hint), 'the empty hint describes ' + tab)
  }
  for (const [tab, kind] of [['Images', 'image'], ['Web', 'web'], ['Files', 'file']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    assert(await page.locator('[data-library-empty="' + kind + '"]').isVisible(), 'a known empty tab remains visible during delayed revalidation: ' + tab)
    assert.equal(await page.locator('[data-library-loading]').count(), 0, 'returning to a known empty tab never replaces it with loading UI')
  }
  await waitUntil(() => application.evaluate(() => globalThis.libraryInFlight === 0))
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-empty-files.png') })
  await application.evaluate(() => { globalThis.libraryPageDelays = {} })
  await page.getByRole('textbox', { name: 'Search name, source or content' }).fill('report')
  await page.getByText('original report.txt', { exact: true }).waitFor()
  await application.evaluate(() => { globalThis.libraryPageDelays = { image: 400, file: 400, web: 400 } })
  for (const [tab, kind, title] of [['Images', 'image', 'No images here yet'], ['Web', 'web', 'No web sources here yet']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    assert.equal(await page.locator('[data-library-item]').count(), 0, 'another category never borrows the report row while its query is delayed')
    await page.locator('[data-library-empty="' + kind + '"]').getByText(title, { exact: true }).waitFor()
    if (screenshots) await page.screenshot({ path: join(screenshots, 'library-empty-' + kind + '.png') })
  }
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  assert(await reportRow.isVisible(), 'a known populated tab returns immediately while its index read is delayed')
  assert.equal(await page.locator('[data-library-loading]').count(), 0)
  await waitUntil(() => application.evaluate(() => globalThis.libraryInFlight === 0))
  await application.evaluate(() => { globalThis.libraryPageDelays = {} })
  await page.evaluate(() => { window.tabSwitchRecording = false; cancelAnimationFrame(window.tabSwitchFrame); window.tabSwitchObserver.disconnect() })
  assert.deepEqual(await page.evaluate(() => window.tabSwitchViolations), [], 'every mutation and painted frame uses the current category without empty loading cards')
  await reportRow.getByRole('button').click()
  await page.getByRole('button', { name: 'Remove from library', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.locator('[data-library-item]').count(),1,'cancelling deletion retains the record')
  for (const locale of ['zh-CN','zh-TW','en']) {
    await page.evaluate(locale => window.setLocale(locale), locale)
    await page.waitForTimeout(60)
    await assertFileIconAlignment()
    await assertCategoryTabAlignment()
    assert(!/library\.(?:title|source|storage|preview)/.test(await page.locator('[data-library-page]').textContent()), 'all library prose resolves through the selected locale')
    if(screenshots)await page.screenshot({path:join(screenshots,'library-files-'+locale+'.png')})
  }
  await page.getByRole('button', { name: 'Library settings', exact: true }).click()
  await page.locator('[data-library-settings]').waitFor()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-settings-en.png') })
  const toggle = page.getByRole('checkbox', { name: 'Collect automatically', exact: true })
  await toggle.click(); await waitForBackend(async()=>!(await window.pi.libraryStatus()).value.preferences.enabled)
  await toggle.click(); await waitForBackend(async()=>(await window.pi.libraryStatus()).value.preferences.enabled)
  const input = page.getByRole('textbox', { name: 'Maximum archive size', exact: true })
  await input.fill('0'); assert(await page.getByRole('button',{name:'Apply',exact:true}).isDisabled())
  await input.fill('4'); await page.getByRole('button',{name:'Apply',exact:true}).click()
  await waitForBackend(async()=>(await window.pi.libraryStatus()).value.preferences.maxBytes===4*1024**2)
  await page.getByRole('button',{name:'Choose directory',exact:true}).click()
  await waitForBackend(async()=>(await window.pi.libraryStatus()).value.directory.endsWith('/chosen/pith-library'))
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-library-settings] button')].some(button=>button.textContent==='Choose directory'&&!button.disabled))
  const prefs=JSON.parse(await readFile(join(profile,'app-settings.json'),'utf8')).library
  assert(prefs.directory.endsWith('/chosen/pith-library'))
  assert.equal(prefs.maxBytes,4*1024**2)
  await page.evaluate(()=>window.openLibrary())
  await reportRow.waitFor()
  await waitUntil(()=>application.evaluate(()=>globalThis.documentReads.at(-1)?.includes('/chosen/pith-library/objects/')))
  await detail.locator('[data-file-source]').getByText('Complete delivered report',{exact:true}).waitFor()
  await reportRow.getByRole('button').click()
  await detail.locator('[data-file-source]').getByText('Complete delivered report',{exact:true}).waitFor()
  await detail.getByRole('button',{name:'Refresh files',exact:true}).click()
  const movedPreview=(await page.evaluate(()=>window.pi.libraryPage({kind:'file',query:'original report.txt',hideUnavailable:true}))).value.items[0].archivedPath
  assert(movedPreview.includes('/chosen/pith-library/objects/'))
  assert.equal(await readFile(movedPreview,'utf8'),reportBytes)
  await reportRow.getByRole('button').click()
  await page.getByRole('button',{name:'Remove from library',exact:true}).click()
  const dialog=page.getByRole('dialog', { name: 'Remove from library', exact: true });await dialog.getByRole('button',{name:'Remove from library',exact:true}).click()
  await page.getByText('No files here yet',{exact:true}).waitFor()
  const removed=await page.evaluate(()=>window.pi.libraryPage({kind:'file',query:'report',hideUnavailable:true}));assert.equal(removed.value.total,0)
  // Explicit deliveries exercise virtual file-list paging through the
  // production worker and IPC, including a delayed append to an exact layout.
  const preservedHtml = await page.evaluate(() => window.pi.libraryPage({ kind: 'file', query: 'delivered page.html', hideUnavailable: true }))
  const pageBytes = await readFile(preservedHtml.value.items[0].archivedPath)
  const extraFiles = Array.from({ length: 66 }, (_, index) => join(project, 'pagination-' + index + '.html'))
  await Promise.all(extraFiles.map(path => writeFile(path, pageBytes)))
  await application.evaluate((_electron, data) => {
    const session = { id: 'ui-one', path: data.sessionPath, cwd: data.project, title: 'Gallery source' }
    for(let start=0;start<data.files.length;start+=8) {
      const id='pagination-'+start, paths=data.files.slice(start,start+8), files=paths.map(path=>({path}))
      globalThis.library.toolStarted(session.path,id,'present',{files})
      globalThis.library.committed(session,id+'-call',{role:'assistant',timestamp:1000,content:[{type:'toolCall',id,name:'present',arguments:{files}}]})
      globalThis.library.committed(session,id+'-result',{role:'toolResult',toolName:'present',toolCallId:id,timestamp:1001,isError:false,content:[],details:{kind:'pith-present-v1',files:paths.map(path=>({path,size:100}))}})
    }
  }, { sessionPath, project, files: extraFiles })
  await waitForBackend(async () => (await window.pi.libraryStatus()).value.total === 196)
  await page.getByRole('textbox', { name: 'Search name, source or content' }).fill('pagination-')
  await page.getByText('66 records', { exact: true }).waitFor()
  await page.waitForFunction(()=>document.querySelector('[data-library-file-list] section')?.scrollHeight>5000)
  await fileList.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight })
  await page.waitForTimeout(100)
  const beforeAppend = await fileGeometry()
  await page.waitForFunction(() => document.querySelector('[data-library-file-list] section')?.getAttribute('aria-busy') === 'false')
  const afterAppend = await fileGeometry()
  assert.equal(afterAppend.top, beforeAppend.top, 'delayed file paging does not move the scroll offset')
  for (const before of beforeAppend.rows) {
    const after = afterAppend.rows.find(card => card.id === before.id)
    if (after) assert.deepEqual(after, before, 'appending file rows keeps earlier visible rows in place')
  }
  const filePages = await application.evaluate(() => globalThis.libraryQueries.filter(record => record.query.kind === 'file' && record.query.query === 'pagination-' && record.count ))
  assert.deepEqual(filePages.map(record => record.count), [60, 6], 'every file is reached through bounded cursor pages')
  const clearFiles = page.getByRole('button',{name:'Clear all Files',exact:true})
  await clearFiles.click()
  let clearConfirmation = page.getByRole('dialog',{name:'Clear all Files',exact:true})
  await clearConfirmation.waitFor()
  await page.waitForFunction(()=>document.activeElement?.textContent==='Cancel')
  assert.match(await clearConfirmation.textContent(),/every project.*hidden by the current filters/)
  await clearConfirmation.getByRole('button',{name:'Cancel',exact:true}).click()
  assert.equal((await page.evaluate(()=>window.pi.libraryPage({kind:'file',query:'pagination-'}))).value.total,66,'cancel leaves all records and copies intact')
  await clearFiles.click();await clearConfirmation.getByRole('button',{name:'Clear',exact:true}).click()
  await page.getByText('No files here yet',{exact:true}).waitFor()
  const afterFileClear = await page.evaluate(async()=>({files:(await window.pi.libraryPage({kind:'file'})).value.total,images:(await window.pi.libraryPage({kind:'image'})).value.total,web:(await window.pi.libraryPage({kind:'web'})).value.total}))
  assert.deepEqual(afterFileClear,{files:0,images:122,web:1},'file clear includes unavailable and search-hidden records while retaining other categories')
  assert.deepEqual(await readFile(extraFiles[0]),pageBytes,'clearing only removes archived copies, never original files')
  await page.getByRole('textbox',{name:'Search name, source or content'}).fill('')
  await page.getByRole('tab',{name:'Images',exact:true}).click()
  await page.getByRole('button',{name:'Filter by project',exact:true}).click()
  await page.getByRole('option',{name:otherProjectName+' · 1',exact:true}).click()
  await page.getByText('1 records',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Clear all Images',exact:true}).click()
  clearConfirmation = page.getByRole('dialog',{name:'Clear all Images',exact:true})
  await clearConfirmation.getByRole('button',{name:'Clear',exact:true}).click()
  await waitForBackend(async()=>(await window.pi.libraryPage({kind:'image'})).value.total===0)
  await page.getByRole('tab',{name:'Web',exact:true}).click()
  // Web shares the file list's bounded paging and opens retained JSON in the
  // adjacent pane. These captures use production IPC without remote requests.
  await page.getByRole('button', { name: 'Filter by project', exact: true }).click()
  await page.getByRole('option', { name: 'All projects', exact: true }).click()
  await application.evaluate((_electron, data) => {
    const session = { id: 'ui-one', path: data.sessionPath, cwd: data.project, title: 'Gallery source' }
    for (let index = 0; index < 66; index++) {
      const id = 'web-pagination-' + index, url = 'https://example.org/web-pagination-' + index
      globalThis.library.toolStarted(session.path, id, 'web_fetch', { url })
      globalThis.library.committed(session, id + '-call', { role: 'assistant', timestamp: 1100, content: [{ type: 'toolCall', id, name: 'web_fetch', arguments: { url } }] })
      globalThis.library.committed(session, id + '-result', { role: 'toolResult', toolName: 'web_fetch', toolCallId: id, timestamp: 1101, isError: false,
        content: [{ type: 'text', text: 'Returned web pagination source ' + index }], details: { url, title: 'Web pagination source ' + index } })
    }
  }, { sessionPath, project })
  await waitForBackend(async () => (await window.pi.libraryPage({ kind: 'web' })).value.total === 67)
  await page.getByRole('textbox', { name: 'Search name, source or content' }).fill('web-pagination-')
  await page.getByText('66 records', { exact: true }).waitFor()
  const webList = page.locator('[data-library-web-list] section')
  await page.waitForFunction(() => document.querySelector('[data-library-web-list] section')?.scrollHeight > 5000)
  await webList.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight })
  await waitUntil(() => application.evaluate(() => globalThis.libraryQueries.filter(record => record.query.kind === 'web' && record.query.query === 'web-pagination-' && record.count).length === 2))
  const webPages = await application.evaluate(() => globalThis.libraryQueries.filter(record => record.query.kind === 'web' && record.query.query === 'web-pagination-' && record.count))
  assert.deepEqual(webPages.map(record => record.count), [60, 6], 'every web source is reached through bounded list pages')
  assert(await page.locator('[data-library-web-row]').count() < 66, 'the web list renders a bounded row window')
  await webList.evaluate(node => { node.scrollTop = 0 })
  await page.locator('[data-library-web-row]').first().getByRole('button').press('Enter')
  await page.locator('[data-library-web-detail]').getByText('Returned web pagination source', { exact: false }).waitFor()
  assert(await webList.isVisible(), 'paged web selection opens beside the list')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'library-web-list-json.png') })
  await page.getByRole('button',{name:'Clear all Web',exact:true}).click()
  clearConfirmation=page.getByRole('dialog',{name:'Clear all Web',exact:true})
  await clearConfirmation.waitFor()
  if(screenshots)await page.screenshot({path:join(screenshots,'library-clear-confirmation.png')})
  await clearConfirmation.getByRole('button',{name:'Clear',exact:true}).click()
  await waitForBackend(async()=>{const status=(await window.pi.libraryStatus()).value;return status.total===0&&status.usedBytes===0})
  await page.getByRole('textbox', { name: 'Search name, source or content' }).fill('')
  const invalidClear=await page.evaluate(()=>window.pi.libraryClear('invalid-kind'));assert.deepEqual(invalidClear,{ok:false,code:'invalid'})
  await page.evaluate(()=>window.pi.libraryRescan())
  await waitForBackend(async() => { const status=(await window.pi.libraryStatus()).value;return !status.scanning&&status.total===0 })
  const localizedEmpties = [
    { locale: 'zh-CN', cases: [['图片', 'image', '这里还没有图片', '截图'], ['文件', 'file', '这里还没有文件', '主动交付的文件'], ['网络', 'web', '这里还没有网络资料', '下载来源']] },
    { locale: 'zh-TW', cases: [['圖片', 'image', '這裡還沒有圖片', '截圖'], ['檔案', 'file', '這裡還沒有檔案', '主動交付的檔案'], ['網路', 'web', '這裡還沒有網路資料', '下載來源']] },
    { locale: 'en', cases: [['Images', 'image', 'No images here yet', 'screenshots'], ['Files', 'file', 'No files here yet', 'explicitly delivered files'], ['Web', 'web', 'No web sources here yet', 'download sources']] }
  ]
  for (const { locale, cases } of localizedEmpties) {
    await page.evaluate(locale => window.setLocale(locale), locale)
    for (const [tab, kind, title, hint] of cases) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      const empty = page.locator('[data-library-empty="' + kind + '"]')
      await empty.getByText(title, { exact: true }).waitFor()
      assert.match(await empty.textContent(), new RegExp(hint), 'localized empty hints describe the selected category')
    }
    if (screenshots) await page.screenshot({ path: join(screenshots, 'library-empty-web-' + locale + '.png') })
  }
  // Match the existing HTML/browser UI suites' bounded Electron isolated-world
  // detach allowance. The guest's actual document was verified above.
  const guestDetach = error => /^Error: Invalid guestInstanceId: \d+\n/.test(error) && error.includes('at WebViewElement.disconnectedCallback (node:electron/js2c/isolated_bundle:')
  const detachErrors=errors.filter(guestDetach)
  assert(detachErrors.length<=3,'bounded Electron guest teardown noise')
  if(detachErrors.length)console.log('NOTE: '+detachErrors.length+' known Electron guest detach exceptions (same allowance as HTML preview checks)')
  assert.deepEqual(errors.filter(error=>!guestDetach(error)),[])
  await application.evaluate(()=>globalThis.library.dispose())
  console.log('PASS library-ui: stable categories and localized empties, spaced images, shared file/web lists and JSON preview/export, unified toolbars, stable resize/loading/pagination, focus, filters, settings, migration and confirmed clearing')
} finally { await application?.close();await server?.close();await rm(temp,{recursive:true,force:true}) }
