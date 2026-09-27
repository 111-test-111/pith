import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright-core'
import electron from 'electron'

export async function electronSample({ repo, modulesPath, directory, url, turns, workload, timeoutMs }) {
  const main = join(directory, 'electron-main.mjs')
  await writeFile(main, `import {app,BrowserWindow,ipcMain} from 'electron';
import {readFile} from 'node:fs/promises';
import {TrajectoryClient} from ${JSON.stringify(pathToFileURL(modulesPath).href)};
app.setPath('userData',${JSON.stringify(join(directory, 'electron-profile'))});
app.commandLine.appendSwitch('force-prefers-reduced-motion','reduce');
const access={sessionPath:${JSON.stringify(join(directory, 'session.jsonl'))},sessionId:'long-session-benchmark-v1'};
const client=new TrajectoryClient(${JSON.stringify(join(directory, 'trajectory.sqlite'))});
globalThis.closeBenchmark=()=>client.dispose();
globalThis.readSnapshot=async()=>JSON.parse(await readFile(${JSON.stringify(join(directory, 'snapshot.json'))},'utf8'));
ipcMain.handle('trajectory:page',(_e,q)=>client.page(access,q));
ipcMain.handle('trajectory:detail',(_e,_path,id)=>client.detail(access,id));
ipcMain.handle('trajectory:node',(_e,q)=>client.node(access,q));
ipcMain.handle('bash:list',()=>[]);
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1220,height:800,show:false,webPreferences:{
  preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,sandbox:false,backgroundThrottling:false}});
await win.loadURL(${JSON.stringify(url)});
}).catch(error=>{console.error(error);app.exit(1)});`)
  let app, deadline, timedOut = false, stage = 'launch', diagnostics = ''
  const pageErrors = []
  const checks = [], metrics = {}, counts = {}
  const check = (name, actual, limit, relation = 'lte') => {
    const passed = relation === 'eq' ? actual === limit : actual <= limit
    checks.push({ name, actual, limit, relation, passed })
    assert(passed, `${name}: ${actual} ${relation} ${limit}`)
  }
  try {
    app = await _electron.launch({ executablePath: electron, args: [main],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: timeoutMs })
    // A deadline also covers hung page.evaluate calls, which Playwright's
    // locator timeout alone cannot bound.
    deadline = setTimeout(() => { timedOut = true; app.process().kill('SIGKILL') }, timeoutMs)
    app.process().stderr?.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-16000) })
    const page = await app.firstWindow({ timeout: timeoutMs })
    page.setDefaultTimeout(timeoutMs)
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
    await page.waitForFunction(() => typeof window.benchmark?.mount === 'function', null, { timeout: timeoutMs })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    stage = 'snapshot-transfer'
    const snapshot = await app.evaluate(() => globalThis.readSnapshot())
    stage = 'mount-transcript'
    const start = await page.evaluate(snapshot => window.benchmark.mount(snapshot), snapshot)
    metrics.firstScreenMs = start.firstScreenMs
    check('rendererAssistantRows', start.assistantRows, turns, 'eq')
    // The transcript currently keeps full DOM with content-visibility. This is
    // a per-turn growth bound, NOT a claim that the transcript is virtualized.
    check('rendererChatElementsPerTurn', start.chatElements, turns * 200 + 1000)
    stage = 'trajectory-first-page'
    await page.waitForFunction(() => document.querySelectorAll('[data-trajectory-record]').length === 80)
    await page.evaluate(() => window.benchmark.settle())
    const initial = await page.evaluate(() => window.benchmark.metrics())
    check('rendererTrajectoryRows', initial.trajectoryRows, 80)
    check('rendererTrajectoryFields', initial.trajectoryFields, 40)
    check('rendererTrajectoryElements', initial.trajectoryElements, 2500)
    Object.assign(counts, initial)
    const firstId = await page.locator('[data-trajectory-record]').first().getAttribute('data-trajectory-record')
    stage = 'trajectory-older-page'
    const startOlder = performance.now()
    await page.getByRole('button', { name: 'Older', exact: true }).click()
    await page.waitForFunction(id => document.querySelector('[data-trajectory-record]')?.getAttribute('data-trajectory-record') !== id, firstId)
    await page.evaluate(() => window.benchmark.settle())
    metrics.trajectoryOlderInteractionMs = performance.now() - startOlder
    check('rendererOlderRows', await page.locator('[data-trajectory-record]').count(), 80)
    // Expand the latest turn's real execution disclosure and the 1 MiB legacy
    // bash result. Its current AgentCode keeps one DOM row per output line;
    // report that cost instead of treating a height cap as DOM virtualization.
    stage = 'expand-large-result'
    const last = page.locator('[data-assistant-group]').last()
    const reveal = last.locator('button[aria-expanded]').first()
    const startExpand = performance.now()
    if (await reveal.count()) await reveal.click()
    const command = last.getByRole('button').filter({ hasText: `node check-${turns - 1}.mjs` }).first()
    await command.waitFor()
    await command.click()
    await page.evaluate(() => window.benchmark.settle())
    metrics.expandLargeToolMs = performance.now() - startExpand
    counts.expandedToolElements = await last.locator('*').count()
    check('rendererExpandedElementsPerOutputLine', counts.expandedToolElements, workload.largeResultLines * 4 + 1000)
    stage = 'live-delta'
    Object.assign(metrics, await page.evaluate(() => window.benchmark.liveDelta()))
    counts.afterInteractions = await page.evaluate(() => window.benchmark.metrics())
    stage = 'memory-endpoint'
    const perf = await cdp.send('Performance.getMetrics')
    const values = Object.fromEntries(perf.metrics.map(value => [value.name, value.value]))
    const dom = await cdp.send('Memory.getDOMCounters')
    check('rendererPageErrors', pageErrors.length, 0, 'eq')
    stage = 'cleanup'
    await page.evaluate(() => window.benchmark.unmount())
    await app.evaluate(() => globalThis.closeBenchmark())
    return { metrics, counts, checks, runtime: await app.evaluate(() => process.versions),
      memory: { jsHeapUsedBytes: values.JSHeapUsedSize ?? null, jsHeapTotalBytes: values.JSHeapTotalSize ?? null,
        domNodes: dom.nodes, documents: dom.documents, listeners: dom.jsEventListeners,
        note: 'CDP endpoint values after page/large-result/live-delta interactions, without forced GC. Includes the synthetic messages kept by PiStore; no OS RSS or GPU/native allocation measurement. Two animation frames are rendering opportunities, not proof of hardware presentation.' } }
  } catch (error) {
    const failure = new Error(`${timedOut ? `Electron sample timed out after ${timeoutMs} ms during ${stage}.\n` : ''}${error.message}\nElectron diagnostics:\n${diagnostics}`, { cause: error })
    failure.measurement = { stage, timedOut, metrics, counts, checks }
    throw failure
  } finally {
    try { await app?.close() }
    finally { clearTimeout(deadline) }
  }
}
