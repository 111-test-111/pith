/** Production preload/main worker + real renderer interactions. No model or
 * external service. Set PI_FILE_PREVIEW_SCREENSHOT_DIR to retain the gallery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, symlink, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright-core'
import electron from 'electron'
import { previewFixtures, zipFixture, gbkArchiveFolder, gbkArchiveImage, big5ArchiveFolder } from './lib/file-preview-fixtures.mjs'
import { pointerHoverStory, assertHoverSettles } from './lib/pointer-hover.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'pith-preview-ui-'))
const project = join(temp, 'project'), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, child, browser, page
const errors = []
try {
  await previewFixtures(project)
  await writeFile(join(project, 'many.zip'), zipFixture(Array.from({ length: 4800 }, (_, i) => ({ name: `src/deep/file-${String(i).padStart(4, '0')}.ts`, data: `export const number = ${i}\n` }))))
  await symlink(join(repo, 'node_modules'), join(temp, 'node_modules'))
  const fixturePath = '/__file_preview.html'
  const fixture = `<!doctype html><html lang="en"><body><div id="root" style="height:100vh;width:650px"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {ThemeProvider} from 'next-themes';
import {FilePreviewPane} from '/src/components/app/FilesPane.tsx';import {FileBrowserStore} from '/src/state/file-browser-store.ts';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';import {ToastProvider} from '/src/components/app/ToastProvider.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {initFonts} from '/src/lib/fonts.ts';import '/src/styles.css';
import {Button} from '/src/components/motion/button';import {MENU_ITEM_CLASS} from '/src/lib/menu-item.ts';
localStorage.setItem('pi-app:locale','en');initFonts();const files=new FileBrowserStore();files.toggleTree();
window.files=files;window.openFile=name=>files.open(${JSON.stringify(project)},{path:${JSON.stringify(project)}+'/'+name});
const App=()=>{window.setLocale=useI18n().setLocale;const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);return React.createElement(FilePreviewPane,{files,filePath:state.active,cwd:${JSON.stringify(project)}})};
function HoverReference(){const [show,setShow]=React.useState(false);window.showHoverReference=setShow;return show?React.createElement('div',{'data-menu-reference':'',className:'fixed left-[666px] top-4 w-56 rounded-card border border-border bg-background p-1.5'},React.createElement(Button,{'data-menu-reference-item':'',variant:'ghost',size:'sm',className:MENU_ITEM_CLASS+' text-foreground'},'Reference action')):null}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'light'},React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement(ToastProvider,null,React.createElement(App),React.createElement(HoverReference)))))));
window.ready=true;</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', optimizeDeps: { include: ['jsonc-parser', 'yaml', 'smol-toml', 'fast-xml-parser'] }, cacheDir: join(temp, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'preview-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== fixturePath) return next(); try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) } }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const main = join(temp, 'main.mjs')
  await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain} from 'electron';import {pathToFileURL} from 'node:url';
import {listFileDirectory,readFileDocument,readFileGitDiff} from ${JSON.stringify(join(repo, 'src/main/file-browser.ts'))};
import {readTableStat,readTableSlice,readTableRange} from ${JSON.stringify(join(repo, 'src/main/table.ts'))};
import {FilePreviewService} from ${JSON.stringify(join(repo, 'src/main/file-preview/service.ts'))};
const previews=new FilePreviewService(pathToFileURL(${JSON.stringify(join(repo, 'out/main/file-preview-worker.mjs'))}));
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const io={documents:[],previews:[],cancels:[],saves:[]};app.whenReady().then(()=>{
ipcMain.handle('app:info',()=>({io}));ipcMain.handle('files:directory',(_,r,offset)=>listFileDirectory(r,offset));
ipcMain.handle('files:document',(_,r)=>{io.documents.push(r);return readFileDocument(r)});ipcMain.handle('files:gitDiff',(_,r)=>readFileGitDiff(r));
ipcMain.handle('files:binaryPreview',(event,r)=>{io.previews.push(r);return previews.read(event.sender.id,r)});ipcMain.on('files:cancelBinaryPreview',(event,id)=>{io.cancels.push(id);previews.cancel(event.sender.id,id)});
ipcMain.handle('files:tableStat',(_,r)=>readTableStat(r));ipcMain.handle('files:tableSlice',(_,r,o,n)=>readTableSlice(r,o,n));ipcMain.handle('files:tableRange',(_,r,b,e)=>readTableRange(r,b,e));
ipcMain.handle('files:saveCopy',(_,path)=>{io.saves.push(path);return {status:'cancelled'}});ipcMain.handle('shell:showInFolder',()=>{});ipcMain.handle('shell:openPath',()=>'');
const w=new BrowserWindow({show:false,width:900,height:720,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});w.on('closed',()=>void previews.dispose());});app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, outfile: main, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr)), 15000); child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code + stderr)) }); child.stderr.on('data', chunk => { stderr += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } }) })
  browser = await chromium.connectOverCDP(endpoint)
  for (let i = 0; i < 100 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await pause(50) }
  assert.ok(page, 'Electron page exists'); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => window.ready && window.setLocale)
  const open = async name => { await page.evaluate(name => window.openFile(name), name) }
  const view = async label => { await page.locator('[data-file-view-tabs]').getByRole('tab', { name: label, exact: true }).click() }
  const screenshot = async name => { if (!process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR) return; await mkdir(process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR, name + '.png') }) }
  for (const [name, format] of [['config.jsonc', 'jsonc'], ['events.jsonl', 'jsonl'], ['config.yaml', 'yaml'], ['config.toml', 'toml'], ['config.xml', 'xml']]) {
    await open(name); await view('Preview')
    await page.locator(`[data-file-structured="${format}"] [data-file-json-tree]`).waitFor()
    assert.match(await page.locator('[data-file-json-tree]').innerText(), format === 'jsonl' ? /opened/ : /Pith/)
    await view('Source'); await page.locator('[data-file-source]').waitFor()
    await view('Preview')
  }
  await screenshot('structured')
  await open('bad.yaml'); await view('Preview'); await page.locator('[data-file-structured-invalid]').waitFor()
  console.log('PASS: worker-parsed JSONC/JSONL/YAML/TOML/XML trees, source switching and invalid syntax notice')

  for (const [name, text] of [['gbk.txt', '这是一个中文'], ['big5.txt', '這是一個中文']]) {
    await open(name); await page.waitForFunction(text => document.querySelector('[data-file-source]')?.textContent.includes(text), text)
    assert.equal(await page.getByRole('button', { name: 'Text encoding' }).count(), 0, 'source previews use automatic decoding without exposing a picker')
  }
  await open('legacy.csv'); await view('Preview'); await page.waitForFunction(() => document.querySelector('[data-file-table]')?.textContent.includes('这是一个中文'))
  console.log('PASS: GBK/Big5 automatic decoding without an encoding picker and legacy CSV grid')

  await open('bundle.zip'); await page.locator('[data-file-archive="zip"] [data-file-archive-list]').waitFor()
  const tree = page.locator('[data-file-archive-list]')
  const archiveItem = name => tree.getByRole('treeitem', { name, exact: true })
  const search = () => page.getByRole('textbox', { name: 'Search archive files', exact: true })
  const back = async () => page.getByRole('button', { name: 'Back to archive files', exact: true }).click()
  const geometry = () => page.evaluate(() => ({ toolbar: document.querySelector('[data-file-archive-toolbar]').getBoundingClientRect().height, search: document.querySelector('[data-file-archive] input').getBoundingClientRect().top }))
  const entryReads = () => page.evaluate(async () => (await window.pi.appInfo()).io.previews.filter(request => request.query.type === 'archive-entry').length)
  const away = { x: 880, y: 680 }
  const archiveHover = await pointerHoverStory(page, archiveItem('src'), away)
  assertHoverSettles(archiveHover, 'archive folder')
  const nextBox = await archiveItem('settings.jsonc').boundingBox()
  const archiveMove = await pointerHoverStory(page, archiveItem('src'), { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 })
  assertHoverSettles(archiveMove, 'archive row transfer')
  const diskTree = page.locator('[data-file-tree]')
  const diskFolder = diskTree.getByRole('treeitem').first()
  const diskHover = await pointerHoverStory(page, diskFolder, away)
  assertHoverSettles(diskHover, 'filesystem folder')
  assert.deepEqual(archiveHover.hovered, diskHover.hovered, 'filesystem and archive folders paint the same gray hover')
  const rowAppearance = item => item.evaluate(node => {
    const css = getComputedStyle(node)
    return { height: node.offsetHeight, color: css.color, font: css.font, gap: css.gap, padding: css.padding, radius: css.borderRadius }
  })
  assert.deepEqual(await rowAppearance(archiveItem('src')), await rowAppearance(diskFolder), 'archive and filesystem rows share their UI')
  await page.evaluate(() => window.showHoverReference(true))
  const reference = page.locator('[data-menu-reference-item]')
  const normalHover = await pointerHoverStory(page, reference, away)
  assertHoverSettles(normalHover, 'ordinary menu action')
  await diskTree.getByRole('treeitem', { name: 'bundle.zip', exact: true }).click({ button: 'right' })
  const fileMenu = page.getByRole('menu', { name: 'File actions', exact: true })
  const contextHover = await pointerHoverStory(page, fileMenu.getByRole('menuitem', { name: 'Save as…', exact: true }), away)
  assertHoverSettles(contextHover, 'context menu action')
  const copyBox = await fileMenu.getByRole('menuitem', { name: 'Copy path', exact: true }).boundingBox()
  assertHoverSettles(await pointerHoverStory(page, fileMenu.getByRole('menuitem', { name: 'Save as…', exact: true }), { x: copyBox.x + copyBox.width / 2, y: copyBox.y + copyBox.height / 2 }), 'context menu row transfer')
  assert.deepEqual(contextHover.hovered, normalHover.hovered, 'ordinary and right-click menus paint the same hover')
  assert.deepEqual(await rowAppearance(fileMenu.getByRole('menuitem', { name: 'Save as…', exact: true })), await rowAppearance(reference), 'ordinary and right-click menus share row geometry and typography')
  await fileMenu.getByRole('menuitem', { name: 'Save as…', exact: true }).press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Copy path', 'menu retains keyboard navigation after pointer exit')
  await page.keyboard.press('Escape')
  await diskTree.getByRole('treeitem', { name: 'bundle.zip', exact: true }).click({ button: 'right' })
  await fileMenu.getByRole('menuitem', { name: 'Save as…', exact: true }).press('Enter')
  await fileMenu.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(async () => (await window.pi.appInfo()).io.saves.at(-1)), join(project, 'bundle.zip'), 'keyboard selection runs the right-clicked file action and closes the menu')
  await page.evaluate(() => window.showHoverReference(false))
  console.log('PASS: painted mouse enter/leave/row transfer without flashes, identical archive/filesystem rows and ordinary/context menu actions')
  assert.equal(await archiveItem('pointer').isDisabled(), true)
  assert.equal(await archiveItem('src').count(), 1, 'implicit/explicit directory entries form one branch')
  const origin = await geometry(), readsBefore = await entryReads()
  await archiveItem('src').click()
  assert.equal(await archiveItem('src').getAttribute('aria-expanded'), 'true')
  assert.equal(await archiveItem('src').getAttribute('aria-selected'), 'false', 'folders expand without acquiring persistent selection, like the sidebar tree')
  await archiveItem('nested').click()
  assert.equal(await archiveItem('util.ts').getAttribute('aria-level'), '3')
  assertHoverSettles(await pointerHoverStory(page, archiveItem('nested'), away), 'expanded archive folder after activation')
  assert.deepEqual(await geometry(), origin, 'folder expansion never shifts the toolbar or search')
  assert.equal(await entryReads(), readsBefore, 'folders only expand, without reading file content')
  await archiveItem('nested').press('ArrowLeft')
  assert.equal(await archiveItem('util.ts').count(), 0)
  await archiveItem('nested').press('ArrowRight'); await archiveItem('nested').press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'util.ts', 'keyboard enters the expanded branch')
  await screenshot('archive-tree')
  await archiveItem('main.ts').click()
  await page.waitForFunction(() => document.querySelector('[data-file-archive-content] [data-file-source]')?.textContent.includes('answer = 42'))
  assert.equal(await page.locator('[data-file-archive-toolbar]').evaluate(node => node.getBoundingClientRect().height), origin.toolbar, 'preview toolbar keeps the same height')
  await back()
  assert.equal(await archiveItem('src').getAttribute('aria-expanded'), 'true', 'expansion survives a file preview')
  assert.equal(await archiveItem('main.ts').getAttribute('aria-selected'), 'false', 'return clears file selection without collapsing folders')
  await search().fill('util')
  assert.equal(await archiveItem('src').count(), 1); assert.equal(await archiveItem('nested').count(), 1)
  assert.equal(await archiveItem('util.ts').getAttribute('aria-level'), '3', 'search retains matching ancestors')
  await archiveItem('src').click(); assert.equal(await archiveItem('util.ts').count(), 0, 'filtered branches can collapse')
  await archiveItem('src').click(); await archiveItem('util.ts').click()
  await page.waitForFunction(() => document.querySelector('[data-file-source]')?.textContent.includes('utility = true'))
  await back(); assert.equal(await search().inputValue(), 'util', 'query survives preview')
  await search().fill('settings'); await archiveItem('settings.jsonc').click()
  await page.locator('[data-file-archive-content] [data-file-structured]').waitFor()
  await screenshot('archive-entry')
  await back(); await search().fill('图片')
  await archiveItem('图片.png').click(); await page.locator('[data-file-archive-image] img').waitFor()
  await back(); await search().fill('short'); await archiveItem('short.txt').click()
  await page.locator('[data-file-archive-content] [data-file-preview-notice="unsupported"]').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Text encoding' }).count(), 0, 'archive text previews also omit the encoding picker')
  await back(); await search().fill('')
  await screenshot('archive-list')
  await open('legacy-gbk.zip'); await archiveItem(gbkArchiveFolder).waitFor()
  assert.equal(await page.locator('[data-file-tree]').getByRole('treeitem', { name: gbkArchiveImage, exact: true }).getAttribute('data-tree-value'), join(project, gbkArchiveImage), 'filesystem tree keeps native Unicode filenames')
  for (const width of [380, 800, 650]) {
    await page.evaluate(width => { document.getElementById('root').style.width = width + 'px' }, width)
    const before = await geometry()
    await archiveItem(gbkArchiveFolder).click(); assert.deepEqual(await geometry(), before)
    await archiveItem(gbkArchiveFolder).click(); assert.deepEqual(await geometry(), before)
  }
  await archiveItem(gbkArchiveFolder).click(); await archiveItem('data').click()
  await archiveItem('数据.csv').waitFor(); await screenshot('archive-gbk-tree')
  await archiveItem(gbkArchiveImage).click(); await page.locator('[data-file-archive-image] img').waitFor()
  assert.equal(await page.locator('[data-file-archive-location]').innerText(), gbkArchiveFolder + '/' + gbkArchiveImage)
  await back(); await search().fill('教程'); await archiveItem(gbkArchiveImage).waitFor()
  await open('legacy-utf8.zip'); await archiveItem(gbkArchiveFolder).click(); await archiveItem('data').click()
  await archiveItem(gbkArchiveImage).waitFor(); await screenshot('archive-utf8-tree')
  await archiveItem(gbkArchiveImage).click(); await page.locator('[data-file-archive-image] img').waitFor()
  assert.equal(await page.locator('[data-file-archive-location]').innerText(), gbkArchiveFolder + '/' + gbkArchiveImage, 'unmarked UTF-8 reproduces the reported ZIP names')
  await open('legacy-big5.zip'); await archiveItem(big5ArchiveFolder).click()
  await archiveItem('許功蓋.txt').click(); await page.waitForFunction(() => document.querySelector('[data-file-source]')?.textContent.includes('Big5 backslash trail bytes'))
  assert.equal(await page.locator('[data-file-archive-location]').innerText(), big5ArchiveFolder + '/許功蓋.txt')
  for (const name of ['bundle.tar', 'bundle.tar.gz', 'note.txt.gz']) {
    await open(name); await page.locator('[data-file-archive-list]').waitFor()
    if (name !== 'note.txt.gz') await archiveItem('src').click()
    await archiveItem(name === 'note.txt.gz' ? 'note.txt' : 'main.ts').click()
    await page.locator('[data-file-archive-content] [data-file-source]').waitFor()
  }
  await open('corrupt.zip'); await archiveItem('bad.txt').click(); await page.locator('[data-file-preview-notice="invalid"]').waitFor()
  console.log('PASS: archive tree expansion/keyboard/search, stable toolbar, GBK/Big5 names, source/image previews and TAR/TGZ/GZ')

  await open('many.zip'); await archiveItem('src').click(); await archiveItem('deep').click()
  assert.ok(await tree.getByRole('treeitem').count() < 80, 'expanded archive tree is windowed')
  await archiveItem('deep').press('End')
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'file-4799.ts')
  await archiveItem('file-4799.ts').press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-file-source]')?.textContent.includes('number = 4799'))
  await back()
  await page.waitForFunction(() => document.querySelector('[data-file-archive-list]')?.scrollTop > 100000)
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'file-4799.ts', undefined, { timeout: 2000 })
  assert.equal(await archiveItem('file-4799.ts').getAttribute('tabindex'), '0', 'preview return retains the keyboard anchor')
  assert.equal(await archiveItem('file-4799.ts').getAttribute('aria-selected'), 'false', 'restoring distant focus does not restore file selection')
  const archiveBefore = await page.evaluate(async () => { window.archiveViewport = document.querySelector('[data-file-archive-list]'); window.archiveSearch = document.querySelector('[data-file-archive] input'); return { reads: (await window.pi.appInfo()).io.previews.length, top: window.archiveViewport.scrollTop } })
  for (const width of [380, 800, 500, 650]) { await page.evaluate(width => { document.getElementById('root').style.width = width + 'px' }, width); await pause(100) }
  assert.deepEqual(await page.evaluate(async () => ({ reads: (await window.pi.appInfo()).io.previews.length, top: document.querySelector('[data-file-archive-list]').scrollTop })), archiveBefore)
  assert.equal(await page.evaluate(() => window.archiveViewport === document.querySelector('[data-file-archive-list]') && window.archiveSearch === document.querySelector('[data-file-archive] input')), true)
  await open('config.yaml'); await open('many.zip')
  await page.waitForFunction(() => document.querySelector('[data-file-archive-list]')?.scrollTop > 100000)
  assert.ok(await tree.getByRole('treeitem').count() < 80)
  assert.equal(await archiveItem('file-4799.ts').getAttribute('aria-selected'), 'false', 'revisiting keeps the cleared file selection')
  await archiveItem('file-4799.ts').press('Home'); await archiveItem('src').press('ArrowLeft')
  assert.equal(await archiveItem('src').getAttribute('aria-expanded'), 'false')
  assert.equal(await tree.getByRole('treeitem').count(), 1, 'collapsed descendants leave the collection')
  console.log('PASS: 4,800-entry archive windowing, distant keyboard focus and scroll/expansion survival through preview, resize and revisit')

  await open('people.sqlite'); await page.locator('[data-file-data="sqlite"] [data-file-table-status="ready"]').waitFor()
  await page.getByRole('button', { name: 'Table' }).click(); await page.getByRole('option', { name: 'people', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-file-table]')?.textContent.includes('9007199254740993'))
  await page.getByRole('tab', { name: 'Schema', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[data-file-table]')?.textContent.includes('INTEGER'))
  await page.getByRole('tab', { name: 'Data', exact: true }).click()
  await page.waitForFunction(() => parseInt(document.querySelector('[data-file-table-count]')?.textContent ?? '0', 10) >= 300)
  await page.evaluate(() => { const node = document.querySelector('[data-file-table-viewport]'); node.scrollTop = node.scrollHeight })
  await page.waitForFunction(() => /600|900|901/.test(document.querySelector('[data-file-table-count]')?.textContent ?? ''))
  assert.ok(await page.locator('[data-table-row]').count() < 800, 'data rows are windowed')
  await page.getByRole('button', { name: 'Table' }).click(); await page.getByRole('option', { name: 'notes', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-file-table]')?.textContent.includes('second table'))
  await open('people.parquet'); await page.waitForFunction(() => document.querySelector('[data-file-data="parquet"]')?.textContent.includes('9007199254740993'))
  await screenshot('parquet')
  const before = await page.evaluate(async () => { window.grid = document.querySelector('[data-file-table-viewport]'); return (await window.pi.appInfo()).io.previews.length })
  for (const width of [380, 800, 500, 650]) { await page.evaluate(width => { document.getElementById('root').style.width = width + 'px' }, width); await pause(100) }
  assert.equal(await page.evaluate(() => window.grid === document.querySelector('[data-file-table-viewport]')), true)
  assert.equal(await page.evaluate(async () => (await window.pi.appInfo()).io.previews.length), before, 'resize causes no read or remount')
  await page.getByRole('tab', { name: 'Schema', exact: true }).click(); await screenshot('parquet-schema')
  await open('config.yaml'); await open('people.parquet')
  assert.equal(await page.getByRole('tab', { name: 'Schema', exact: true }).getAttribute('aria-selected'), 'true', 'view survives revisit')
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click(); await page.locator('[data-file-data="parquet"] [data-file-table-status="ready"]').waitFor()
  console.log('PASS: SQLite table/schema selection, Parquet BigInt cells, incremental windowed rows and resize/revisit state')

  for (const [locale, schema] of [['zh-CN', '结构'], ['zh-TW', '結構']]) {
    await page.evaluate(locale => window.setLocale(locale), locale)
    await page.getByRole('tab', { name: schema, exact: true }).waitFor()
  }
  await page.evaluate(() => window.setLocale('en'))
  const io = await page.evaluate(async () => (await window.pi.appInfo()).io)
  assert.ok(!io.documents.some(request => /\.(zip|tar|gz|sqlite|parquet)$/.test(request.path)), 'binary formats never use text IPC')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS: localized preview controls, specialized read routing and no renderer exceptions')
} catch (error) {
  console.error('UI failure state:', await page?.locator('body').innerText().catch(() => ''), await page?.evaluate(() => ({active:window.files?.getSnapshot().active})).catch(() => null), errors)
  if (page && process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR) { await mkdir(process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.PI_FILE_PREVIEW_SCREENSHOT_DIR, 'failure.png') }).catch(() => {}) }
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  await server?.close()
  await rm(temp, { recursive: true, force: true })
}
