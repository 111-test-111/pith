/** Production resource IPC/preload/worker in Electron and the real settings
 * shell. Offline, isolated data and a real app-owned CPU/memory child. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'pith-resources-ui-'))
const screenshots = process.env.PI_RESOURCES_SCREENSHOT_DIR
let application, server
try {
  const profile = join(temp, 'profile'), agentData = join(temp, 'agent'), library = join(temp, 'external archive')
  for (const path of [profile, join(agentData, 'sessions', 'one'), join(library, 'objects'), join(temp, 'logs'), join(temp, 'crashes')]) await mkdir(path, { recursive: true })
  const session = join(agentData, 'sessions', 'one', 'chat.jsonl'), sessionBytes = '会话 fixture\n'.repeat(300)
  await writeFile(session, sessionBytes)
  await writeFile(join(library, 'objects', 'copy.bin'), Buffer.alloc(8193, 1))
  await writeFile(join(profile, 'trajectory.sqlite-wal'), Buffer.alloc(4097, 1))
  await writeFile(join(profile, 'app-settings.json'), JSON.stringify({ library: { enabled: true, directory: library, maxBytes: 1024 ** 3 } }))
  // Use the built worker and its generated shared chunks, preserving relative
  // URLs. Only the small main fixture is separately bundled for isolation.
  await cp(join(repo, 'out/main'), join(temp, 'main'), { recursive: true })
  await build({ stdin: { contents: "export {registerResourceIpc} from './src/main/resources/service';", resolveDir: repo },
    outfile: join(temp, 'main', 'resource-service.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'],
    plugins: [{ name: 'absolute-sdk', setup(builder) { builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })) } }] })
  const fixturePath = '/__resources_check.html'
  const fixture = `<!doctype html><html><head><style>body{margin:0}#root{height:100vh;position:relative}</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {SettingsPage} from '/src/components/app/settings/SettingsPage.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {setUiStyle} from '/src/lib/ui-style.ts';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');setUiStyle('square');window.setUiStyle=setUiStyle;
function App(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement(SettingsPage,{open:true,onBack:()=>{},accent:'violet',onAccentChange:()=>{},uiStyle:'square',onUiStyleChange:setUiStyle})}
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(App)));
</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temp, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react(), tailwindcss(), {
      name: 'resources-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== fixturePath) return next()
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      }) }
    }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  await writeFile(join(temp, 'main.mjs'), `import {app,BrowserWindow,ipcMain} from 'electron';import {spawn} from 'node:child_process';import {registerResourceIpc} from './main/resource-service.mjs';
app.setPath('userData',${JSON.stringify(profile)});app.setPath('logs',${JSON.stringify(join(temp, 'logs'))});app.setPath('crashDumps',${JSON.stringify(join(temp, 'crashes'))});
globalThis.resourceCalls={runtime:0,storage:0};globalThis.resourceFailures={runtime:false,storage:false,allocation:false};
app.whenReady().then(()=>{const resources=registerResourceIpc();globalThis.resources=resources;
const runtime=resources.runtime.bind(resources),storage=resources.storage.bind(resources);
resources.runtime=async()=>{globalThis.resourceCalls.runtime++;if(globalThis.resourceFailures.runtime)return {ok:false,code:'unavailable'};const result=await runtime();globalThis.lastRuntime=result;return result};
resources.storage=async()=>{globalThis.resourceCalls.storage++;if(globalThis.resourceFailures.storage)return {ok:false,code:'unavailable'};const result=await storage();globalThis.lastStorage=result;if(globalThis.resourceFailures.allocation&&result.ok)return {ok:true,value:{...result.value,allocatedBytes:null,entries:result.value.entries.map(row=>({...row,allocatedBytes:null}))}};return result};
ipcMain.handle('app:info',()=>({version:'fixture',bashMaxWaitMs:10000,askUserTimeoutSeconds:300,responseTimeoutSeconds:120,startup:'resume',checkpointsEnabled:true,sandboxMode:'workspace-write',sandbox:{support:'ready',backend:'fixture'}}));
const helper=spawn(process.execPath,['-e','const bytes=Buffer.alloc(8*1024*1024,1);setInterval(()=>{const end=Date.now()+25;while(Date.now()<end){};void bytes[0]},100)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'});globalThis.helper=helper;globalThis.helperPid=helper.pid;
const window=new BrowserWindow({width:1200,height:960,show:false,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},sandbox:false,backgroundThrottling:false}});window.loadURL(${JSON.stringify(origin)});
});app.on('before-quit',()=>{globalThis.helper?.kill();void globalThis.resources?.dispose()});app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentData }; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: electron, args: [join(temp, 'main.mjs')], env })
  const page = await application.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.stack ?? String(error)))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.getByRole('tab', { name: 'Resources', exact: true }).waitFor()
  await page.waitForTimeout(200)
  assert.deepEqual(await application.evaluate(() => globalThis.resourceCalls), { runtime: 0, storage: 0 }, 'unvisited resource settings do no work')
  await page.getByRole('tab', { name: 'Resources', exact: true }).click()
  await page.locator('[data-resource-logical]').waitFor()
  const panel = page.locator('[data-resource-settings]')
  const storageDetails = panel.locator('button[aria-controls="resource-storage-details"]')
  assert.equal(await page.locator('[data-resource-storage]').count(), 0, 'storage categories start collapsed while totals remain visible')
  await page.waitForFunction(() => !document.querySelector('[data-resource-cpu]')?.textContent.includes('Sampling'))
  const initial = await application.evaluate(() => ({ runtime: globalThis.lastRuntime, storage: globalThis.lastStorage, helper: globalThis.helperPid }))
  assert.equal(initial.runtime.ok, true); assert.equal(initial.runtime.value.partial, false)
  assert(initial.runtime.value.processes.some(row => row.pid === initial.helper && row.kind === 'child' && row.residentBytes > 0), 'actual app child processes reach the typed preload')
  assert(initial.runtime.value.cpuPercent > 0, 'actual CPU workload reaches the resource display')
  assert.equal(initial.storage.value.entries.find(row => row.category === 'sessions').logicalBytes, Buffer.byteLength(sessionBytes))
  assert.equal(initial.storage.value.entries.find(row => row.category === 'library').logicalBytes, 8193, 'configured external archive is included by production service')
  assert.equal(initial.storage.value.entries.find(row => row.category === 'trajectory').logicalBytes, 4097)
  await storageDetails.click()
  await page.locator('[data-resource-storage]').waitFor()
  assert(await page.locator('[data-resource-category="sessions"]').innerText().then(text => text.includes(new Intl.NumberFormat('en').format(Buffer.byteLength(sessionBytes)) + ' B')))
  const concurrent = await page.evaluate(() => Promise.all([window.pi.resourceStorage(), window.pi.resourceStorage()]))
  assert.deepEqual(concurrent[0], concurrent[1], 'concurrent windows share one completed disk scan')
  await panel.getByRole('button', { name: 'Details', exact: true }).first().click()
  await page.locator('[data-resource-pid="' + initial.helper + '"]').waitFor()
  const storageCalls = await application.evaluate(() => globalThis.resourceCalls.storage)
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.waitForTimeout(100)
  const hiddenCalls = await application.evaluate(() => globalThis.resourceCalls.runtime)
  await page.waitForTimeout(2300)
  assert.equal(await application.evaluate(() => globalThis.resourceCalls.runtime), hiddenCalls, 'inactive settings panels stop polling')
  await page.getByRole('tab', { name: 'Resources', exact: true }).click()
  await page.locator('[data-resource-processes]').waitFor({ state: 'visible' })
  await page.locator('[data-resource-storage]').waitFor({ state: 'visible' })
  assert.equal(await application.evaluate(() => globalThis.resourceCalls.storage), storageCalls, 'tab return preserves disk snapshot and expanded details')
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(100)
  const backgroundCalls = await application.evaluate(() => globalThis.resourceCalls.runtime)
  await page.waitForTimeout(2300)
  assert.equal(await application.evaluate(() => globalThis.resourceCalls.runtime), backgroundCalls, 'background windows stop polling too')
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(() => document.visibilityState === 'visible')
  await page.waitForTimeout(200)
  assert((await application.evaluate(() => globalThis.resourceCalls.runtime)) > backgroundCalls)
  await appendFile(session, '新数据')
  await panel.getByRole('button', { name: 'Rescan', exact: true }).click()
  await page.waitForFunction(count => document.querySelector('[data-resource-category="sessions"]')?.textContent.includes(count + ' B'), new Intl.NumberFormat('en').format(Buffer.byteLength(sessionBytes + '新数据')))
  const exactBeforeFailure = await page.locator('[data-resource-logical]').innerText()
  await application.evaluate(() => { globalThis.resourceFailures.storage = true })
  await panel.getByRole('button', { name: 'Rescan', exact: true }).click()
  await panel.getByRole('alert').filter({ hasText: 'Could not scan storage' }).waitFor()
  assert.equal(await page.locator('[data-resource-logical]').innerText(), exactBeforeFailure, 'failed refresh retains previous measured snapshot with an error')
  await application.evaluate(() => { globalThis.resourceFailures.storage = false; globalThis.resourceFailures.allocation = true })
  await panel.getByRole('button', { name: 'Rescan', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-resource-allocated]')?.textContent === 'Unavailable')
  assert.equal(await page.locator('[data-resource-logical]').innerText(), exactBeforeFailure, 'unsupported allocation does not change exact file byte lengths')
  assert.equal(await panel.getByRole('alert').count(), 0)
  await application.evaluate(() => { globalThis.resourceFailures.allocation = false })
  await panel.getByRole('button', { name: 'Rescan', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-resource-allocated]')?.textContent !== 'Unavailable')
  await panel.getByRole('button', { name: 'Details', exact: true }).last().click()
  await page.locator('#resource-storage-paths').waitFor()
  assert((await page.locator('#resource-storage-paths').innerText()).includes('external archive'))
  const memoryBeforeFailure = await page.locator('[data-resource-memory]').innerText()
  await application.evaluate(() => { globalThis.resourceFailures.runtime = true })
  await panel.getByRole('alert').filter({ hasText: 'Could not refresh running resources' }).waitFor()
  assert.equal(await page.locator('[data-resource-memory]').innerText(), memoryBeforeFailure, 'runtime refresh failures preserve the last measurement with an error')
  await application.evaluate(() => { globalThis.resourceFailures.runtime = false })
  await panel.getByRole('alert').filter({ hasText: 'Could not refresh running resources' }).waitFor({ state: 'hidden' })
  await panel.getByRole('button', { name: 'Details', exact: true }).first().click()
  for (const [locale, style, dark] of [['en', 'square', false], ['zh-CN', 'square', false], ['zh-TW', 'squircle', true]]) {
    await page.evaluate(([locale, style, dark]) => { window.setLocale(locale); window.setUiStyle(style); document.documentElement.classList.toggle('dark', dark) }, [locale, style, dark])
    await page.waitForTimeout(200)
    assert.equal(await page.locator('[data-resource-storage] tbody tr').count(), 12, 'all storage categories remain rendered in each locale')
    assert.equal(await page.locator('[data-resource-settings]').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'resource page fits its settings column')
    if (screenshots) {
      await storageDetails.click()
      assert.equal(await page.locator('[data-resource-storage]').count(), 0, 'storage details can collapse independently of the totals')
      await mkdir(screenshots, { recursive: true }); await page.locator('[data-settings-scrollport]').evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0 }))
      await page.screenshot({ path: join(screenshots, `resources-${locale}-${style}.png`) })
      await storageDetails.click()
      await page.locator('[data-resource-storage]').evaluate(node => node.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: join(screenshots, `resources-storage-${locale}-${style}.png`) })
    }
  }
  assert.deepEqual(errors, [], 'resource settings have no renderer exceptions')
  console.log('PASS resources-ui: production worker/IPC, real CPU/memory, external archive, exact bytes, polling lifetimes, refresh recovery and localized settings layout')
} finally {
  await application?.close()
  await server?.close()
  await rm(temp, { recursive: true, force: true })
}
