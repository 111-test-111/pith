/** Real preload + Electron IPC + PiManager, offline and with an isolated profile. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import electron from 'electron'
export async function checkPlanIpc() {
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'pith-plan-ipc-'))
  let app, diagnostics = ''
  try {
    const routes = join(temporary, 'routes.mjs')
    await build({ entryPoints: [join(repo, 'src/main/pi/plan-ipc.ts')], outfile: routes, bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
    const main = join(temporary, 'main.mjs')
    const output = join(temporary, 'export.md')
    await writeFile(main, `import {app,BrowserWindow,dialog} from 'electron';
import {createPlanFixture,submitFixturePlan} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/lib/plan-fixture.mjs')).href)};
import {registerPlanIpc} from './routes.mjs';
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.whenReady().then(async()=>{
const fixture=await createPlanFixture();
const ref=await submitFixturePlan(fixture);
fixture.setRespond(()=>[{type:'text',text:'Approved over IPC'}]);
globalThis.fixture=fixture;globalThis.request={sessionPath:fixture.managed.path,...ref};globalThis.cancelExport=true;
dialog.showSaveDialog=async()=>globalThis.cancelExport?{canceled:true}:{canceled:false,filePath:${JSON.stringify(output)}};
registerPlanIpc(fixture.app);
const win=new BrowserWindow({width:600,height:400,show:false,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,sandbox:false}});
await win.loadURL('data:text/html,<html><body>Plan IPC fixture</body></html>');
}).catch(error=>{console.error(error);app.exit(1)});`)
    app = await _electron.launch({ executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
    app.process().stderr?.on('data', data => { diagnostics += data.toString() })
    const page = await app.firstWindow({ timeout: 15000 }).catch(error => { throw new Error(String(error) + '\n' + diagnostics) })
    const request = await app.evaluate(() => globalThis.request)
    const state = await page.evaluate(request => window.pi.getPlanState(request.sessionPath), request)
    assert.equal(state.mode, 'plan')
    const doc = await page.evaluate(request => window.pi.readPlanDocument(request), request)
    assert(doc.ok)
    assert.deepEqual((await page.evaluate(request => window.pi.exportPlan(request), request)), { ok: true, value: { cancelled: true } })
    await app.evaluate(() => globalThis.cancelExport = false)
    assert((await page.evaluate(request => window.pi.exportPlan(request), request)).ok)
    assert.equal(await readFile(output, 'utf8'), doc.value.markdown)
    assert.equal((await page.evaluate(request => window.pi.approvePlan({ ...request, revision: 99 }), request)).ok, false)
    const approved = await page.evaluate(request => window.pi.approvePlan(request), request)
    assert(approved.ok)
    await app.evaluate(async () => globalThis.fixture.session.waitForIdle())
    assert.deepEqual(await page.evaluate(request => window.pi.approvePlan(request), request), approved)
    assert.equal((await page.evaluate(request => window.pi.getPlanState(request.sessionPath), request)).mode, 'normal')
    assert.equal((await page.evaluate(request => window.pi.resetPlanApproval(request), request)).ok, false)
    const mode = await page.evaluate(request => window.pi.setSessionMode({ sessionPath: request.sessionPath, mode: 'plan' }), request)
    assert(mode.ok)
    assert.equal(mode.value.latest, null)
    await app.evaluate(async () => globalThis.fixture.close())
    console.log('PASS: real contextBridge/preload IPC, mode/document/approve/reset and exact Save As export')
  } finally { await app?.close(); await rm(temporary, { recursive: true, force: true }) }
}
