/** Real Chromium + built preload + IPC + real SDK/SQLite worker, offline. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pith-trajectory-ui-'))
let server, app
const errors = []
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {TrajectoryPane} from '/src/components/app/TrajectoryPane.tsx';
import {PresentedFiles} from '/src/components/app/PresentedFiles.tsx';
import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';
localStorage.setItem('pi-app:locale','en');
const h=React.createElement,path=new URL(location.href).searchParams.get('session');
const store={getShell:()=>({sessionPath:path}),subscribe:()=>()=>{}};
window.previewPaths=[];
function App(){const {setLocale}=useI18n();window.setLocale=setLocale;return h('div',{style:{display:'flex',height:'740px',gap:'20px',padding:'12px'}},
 h('div',{style:{width:'400px',height:'100%'}},h(TrajectoryPane,{store})),
 h('div',{style:{width:'460px'}},h(FileNavigationProvider,{cwd:'/fixture',openFile:target=>window.previewPaths.push(target.path)},h(PresentedFiles,{files:window.files}))))}
window.mount=files=>{window.files=files;window.root=createRoot(document.getElementById('root'));window.root.render(h(I18nProvider,null,h(App)))};
</script></body></html>`
try {
  await build({ entryPoints: [join(repo, 'src/main/pi/trajectory/ipc.ts')], outfile: join(temp, 'routes.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temp, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'trajectory-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__trajectory.html') return next()
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__trajectory.html', fixture))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__trajectory.html'
  const out = join(temp, 'request.json')
  await writeFile(join(temp, 'main.mjs'), `import {app,BrowserWindow,dialog,ipcMain} from 'electron';
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {createPlanFixture} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/lib/plan-fixture.mjs')).href)};
import {registerTrajectoryIpc} from './routes.mjs';
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});
app.whenReady().then(async()=>{
const f=await createPlanFixture({providerCallbacks:true});globalThis.fixture=f;
await f.managed.lifecyclePromise;
const path=join(f.project,'report # 你好.txt');await writeFile(path,'delivered');
for(let i=0;i<120;i++)await f.session.prompt('question '+i);
await f.managed.trajectory.flush();
globalThis.files=[{path,size:9,description:'report'}];globalThis.cancel=true;globalThis.saved=[];globalThis.opened=[];
dialog.showSaveDialog=async()=>globalThis.cancel?{canceled:true}:{canceled:false,filePath:${JSON.stringify(out)}};
registerTrajectoryIpc(f.app);
ipcMain.handle('files:saveCopy',(_e,path)=>{globalThis.saved.push(path);return {status:'ok'}});
ipcMain.handle('shell:openPath',(_e,path)=>{globalThis.opened.push(path);return ''});
const win=new BrowserWindow({width:980,height:800,show:false,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,sandbox:false}});
await win.loadURL(${JSON.stringify(url)}+'?session='+encodeURIComponent(f.managed.path));
}).catch(error=>{console.error(error);app.exit(1)});`)
  app = await _electron.launch({ executablePath: electron, args: [join(temp, 'main.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  let diagnostics = ''
  app.process().stderr?.on('data', data => { diagnostics += data.toString() })
  const page = await app.firstWindow({ timeout: 30000 }).catch(error => { throw new Error(String(error) + '\n' + diagnostics) })
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => typeof window.mount === 'function')
  const files = await app.evaluate(() => globalThis.files)
  await page.evaluate(files => window.mount(files), files)
  await page.locator('[data-trajectory-record]').first().waitFor()
  assert.equal(await page.locator('[data-trajectory-record]').count(), 80)
  const firstId = await page.locator('[data-trajectory-record]').first().getAttribute('data-trajectory-record')
  await page.getByRole('button', { name: 'Older', exact: true }).click()
  await page.waitForFunction(firstId => document.querySelector('[data-trajectory-record]')?.getAttribute('data-trajectory-record') !== firstId, firstId)
  assert.equal(await page.locator('[data-trajectory-record]').count(), 80)
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-trajectory-inspector]'))
  if (process.env.PI_TRAJECTORY_SCREENSHOT) await page.screenshot({ path: process.env.PI_TRAJECTORY_SCREENSHOT })
  const filename = page.locator('[data-presented-file]').getByText('report # 你好.txt', { exact: true })
  assert.deepEqual(await filename.evaluate(node => ({ tag: node.tagName, tabIndex: node.getAttribute('tabindex') })), { tag: 'SPAN', tabIndex: null })
  await filename.click()
  assert.deepEqual(await page.evaluate(() => window.previewPaths), [])
  const cardButtons = page.locator('[data-presented-file] button')
  assert.equal(await cardButtons.last().getAttribute('aria-label'), 'Preview report # 你好.txt')
  const previewBox = await cardButtons.last().boundingBox(), nameBox = await filename.boundingBox(), saveBox = await cardButtons.nth(1).boundingBox()
  assert(previewBox.y > nameBox.y && previewBox.x > saveBox.x, 'preview is the bottom-right card action')
  await page.getByRole('button', { name: /Preview report/ }).click()
  assert.deepEqual(await page.evaluate(() => window.previewPaths), [files[0].path])
  await page.getByRole('button', { name: 'Save as…', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.saved), [files[0].path])
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.opened), [files[0].path])
  await page.getByRole('button', { name: 'Export complete record…', exact: true }).click()
  await app.evaluate(() => globalThis.cancel = false)
  await page.getByRole('button', { name: 'Export complete record…', exact: true }).click()
  for (let i = 0; i < 100; i++) {
    try { JSON.parse(await readFile(out, 'utf8')); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  const exported = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(exported.record.kind, 'request')
  assert(exported.documents.payload)
  const sessionPath = await app.evaluate(() => globalThis.fixture.managed.path)
  await assert.rejects(page.evaluate(sessionPath => window.pi.trajectoryNode({ sessionPath, recordId: 'bad', trail: ['0'.repeat(64)] }), sessionPath))
  // Both appearance presets preserve controls, status marks and focusability.
  for (const corners of ['square', 'squircle']) {
    await page.evaluate(corners => document.documentElement.dataset.corners = corners, corners)
    assert.equal(await page.locator('[data-status-ring]').count(), 80)
    const roots = await page.locator('[data-trajectory-fields] button').count()
    assert(roots <= 40)
  }
  await page.evaluate(() => window.setLocale('zh-CN'))
  await page.getByRole('button', { name: '另存为…', exact: true }).waitFor()
  await page.getByRole('button', { name: '预览 report # 你好.txt', exact: true }).waitFor()
  assert(await page.getByPlaceholder('搜索工具、模型或供应商').count())
  await page.getByPlaceholder('搜索工具、模型或供应商').fill('not-a-model')
  await page.waitForFunction(() => document.querySelectorAll('[data-trajectory-record]').length === 0)
  await page.getByText('此分支和筛选条件下暂无记录。', { exact: true }).waitFor()
  await page.evaluate(() => window.root.unmount())
  assert.deepEqual(errors, [])
  await app.evaluate(async () => { await globalThis.fixture.close() })
  console.log('PASS UI/IPC: 120 SDK turns, ≤80 ledger rows / ≤40 fields, page controls, search, i18n, corners, exact file paths, native export/cancel, unauthorized-node rejection')
} finally {
  await app?.close()
  await server?.close()
  await rm(temp, { recursive: true, force: true })
}
