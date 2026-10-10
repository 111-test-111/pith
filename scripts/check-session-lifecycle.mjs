/** Real SDK extension ownership and Electron quit, with isolated data/no model calls. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-lifecycle-'))
const agentDir = join(temporary, 'agent')
const project = join(temporary, 'project')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate) => {
  const deadline = Date.now() + 3000
  while (!predicate()) { assert(Date.now() < deadline, 'lifecycle condition timed out'); await delay(5) }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const responsive = async (promise) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('navigation waited for extension startup')), 1000)
  })]) } finally { clearTimeout(timer) }
}
const probe = globalThis.lifecycleProbe = { instances: [], errors: [], holdStart: null, holdShutdown: null }
const apps = []
try {
  await mkdir(agentDir); await mkdir(project)
  const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const outfile = join(temporary, 'modules.mjs')
  await build({ stdin: { contents: `export { PiManager } from './src/main/pi/manager';
export { PiStore } from './src/renderer/src/state/pi-store';
export * from './src/main/shutdown';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'isolated-sdk', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onResolve({ filter: /^playwright-core(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^\// }, (args) => args.path === sdk ? { path: sdk, external: true } : undefined)
      builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({ contents:
        `export const app = { getPath: () => ${JSON.stringify(temporary)} }; export const shell = {};` }))
      builder.onLoad({ filter: /^sdk$/, namespace: 'fixture' }, () => ({ contents: `
export * from ${JSON.stringify(sdk)};
import { createAgentSessionServices as create, SettingsManager, SessionManager as SDKSessionManager } from ${JSON.stringify(sdk)};
export const getAgentDir = () => ${JSON.stringify(agentDir)};
export class SessionManager extends SDKSessionManager {
  static create(cwd, dir) { return SDKSessionManager.create(cwd, dir ?? ${JSON.stringify(join(temporary, 'navigation-sessions'))}); }
  static list(cwd, dir) { return SDKSessionManager.list(cwd, dir ?? ${JSON.stringify(join(temporary, 'navigation-sessions'))}); }
}
export function createAgentSessionServices(options) {
  return create({ ...options, agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),
    resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions:true, noSkills:true,
      noPromptTemplates:true, noThemes:true, noContextFiles:true,
      extensionFactories:[pi => {
        const probe=globalThis.lifecycleProbe;
        const instance={pi,starts:0,shutdowns:[],ctx:null,timer:null}; probe.instances.push(instance);
        pi.on('session_start', async (_,ctx) => {
          instance.ctx=ctx; instance.starts++;
          // Simulate MCP initialization which returns before its async work completes.
          instance.timer=setTimeout(() => { try { pi.getActiveTools(); void ctx.cwd } catch(e) { probe.errors.push(e.message) } },80);
          if(probe.holdStart) await probe.holdStart.promise;
          pi.registerTool({name:'late_tool',label:'Late tool',description:'Startup regression probe',
            parameters:{type:'object',properties:{}},execute:async()=>({content:[]})});
        });
        pi.on('session_shutdown', async (event) => {
          clearTimeout(instance.timer);
          // The shutdown callback must run while both API and ctx are valid.
          try { pi.getActiveTools(); if(instance.ctx) void instance.ctx.cwd }
          catch(e) { probe.errors.push(e.message) }
          instance.shutdowns.push(event.reason);
          if(probe.holdShutdown) await probe.holdShutdown.promise;
        });
      }]
    }
  });
}` }))
    } }]
  })
  const { PiManager, PiStore, registerQuitHandler, SESSION_DISPOSE_TIMEOUT_MS } = await import(pathToFileURL(outfile).href)
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store'), refreshOnCreate: false })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => { throw new Error('Unexpected auth access') }
  runtime.getAvailableSnapshot = () => []
  const makeApp = () => {
    const app = new PiManager(() => {}, (error) => { throw new Error(error) })
    app.runtime = async () => runtime
    apps.push(app)
    return app
  }
  const makeSession = () => SessionManager.create(project, join(temporary, 'sessions'))
  const app = makeApp()
  const a = await app.buildSession(makeSession(), false)
  await a.lifecyclePromise
  const aExtension = probe.instances.at(-1)
  const b = await app.buildSession(makeSession(), false)
  await b.lifecyclePromise
  const bExtension = probe.instances.at(-1)
  assert.notEqual(a.resourceLoader, b.resourceLoader, 'same cwd still needs independent loaders')
  assert.notEqual(aExtension, bExtension)
  aExtension.pi.appendEntry('owner_probe', { owner: 'a' })
  bExtension.pi.appendEntry('owner_probe', { owner: 'b' })
  assert.equal(a.session.sessionManager.getEntries().filter((e) => e.customType === 'owner_probe')[0].data.owner, 'a')
  assert.equal(b.session.sessionManager.getEntries().filter((e) => e.customType === 'owner_probe')[0].data.owner, 'b')
  assert.equal((await app.buildSession(a.session.sessionManager, false)), a, 'switching reuses its live session')
  assert.equal(probe.instances.length, 2, 'switching must not reinitialize MCP')
  await app.reloadManagedSession(a)
  assert.throws(() => aExtension.ctx.cwd, /stale/)
  assert.doesNotThrow(() => bExtension.pi.getActiveTools(), 'reload must not invalidate another session API')
  assert.equal(bExtension.ctx.cwd, project)
  assert.deepEqual(aExtension.shutdowns, ['reload'])
  const reloaded = probe.instances.at(-1)
  await app.disposeManaged(a)
  assert.deepEqual(reloaded.shutdowns, ['quit'])
  bExtension.pi.appendEntry('still_live', {})
  assert.equal(bExtension.ctx.cwd, project)
  await delay(100)
  assert.deepEqual(probe.errors, [], 'async initialization must never encounter stale contexts')
  console.log('PASS: real SDK sessions in one cwd own distinct extension runtimes; navigation, reload and disposal preserve other sessions.')

  probe.holdShutdown = deferred()
  const firstReload = app.reloadManagedSession(b)
  await until(() => bExtension.shutdowns.length === 1)
  const secondReload = app.reloadManagedSession(b)
  await delay(30)
  assert.equal(bExtension.shutdowns.length, 1, 'overlapping settings reloads must serialize')
  probe.holdShutdown.resolve(); probe.holdShutdown = null
  await Promise.all([firstReload, secondReload])
  assert.deepEqual(probe.errors, [])

  probe.holdStart = deferred()
  const cManager = makeSession()
  const cFirst = await responsive(app.buildSession(cManager, false))
  await until(() => probe.instances.at(-1).ctx?.sessionManager.getSessionId() === cManager.getSessionId())
  const instanceCount = probe.instances.length
  const cSecond = await responsive(app.buildSession(cManager, false))
  assert.equal(cFirst, cSecond)
  assert.equal(cFirst.initializing, true)
  probe.holdStart.resolve(); probe.holdStart = null
  await cFirst.lifecyclePromise
  assert.equal(probe.instances.length, instanceCount, 'concurrent open must bind exactly one runtime')
  console.log('PASS: overlapping reloads serialize, and concurrent opens do not duplicate extension initialization.')

  // Exercise all public navigation entry points with a session_start hook
  // that cannot complete until explicitly released. No real session writes.
  const navigating = makeApp()
  const readiness = []
  navigating.emit = (channel, event) => { if (channel === 'pi:event') readiness.push(event) }
  probe.holdStart = deferred()
  const boot = await responsive(navigating.init(project))
  const globalChat = await responsive(navigating.newSession())
  const projectChat = await responsive(navigating.newSession(project))
  const existing = await responsive(navigating.openSession(boot.sessionPath))
  for (const snapshot of [boot, globalChat, projectChat, existing]) assert.equal(snapshot.initializing, true)
  assert.equal(globalChat.projectless, true)
  assert.equal(existing.sessionPath, boot.sessionPath)
  assert.equal(navigating.sessions.size, 3)
  const owner = navigating.activeSession
  let prompted = 0
  owner.session.prompt = async () => {
    assert(owner.session.getActiveToolNames().includes('late_tool'), 'first prompt needs lazy tools')
    prompted++
  }
  navigating.prompt({ text:'ready probe',images:[],files:[] })
  await delay(20)
  assert.equal(prompted, 0, 'prompt waits while navigation stays responsive')
  await responsive(navigating.openSession(projectChat.sessionPath))
  const waiting = [...navigating.sessions.values()].map((session) => session.lifecyclePromise)
  probe.holdStart.resolve(); probe.holdStart = null
  await Promise.all(waiting)
  await until(() => prompted === 1)
  assert.equal(navigating.activeSession.path, projectChat.sessionPath, 'late startup never steals navigation')
  assert.equal(readiness.filter((e) => e.type === 'session_initialized').length, 3)
  const ready = readiness.find((e) => e.type === 'session_initialized' && e.sessionPath === boot.sessionPath)
  const store = new PiStore()
  store.dispatch(ready)
  store.applySnapshot(boot)
  assert.equal(store.getShell().initializing, false, 'readiness before the first snapshot is replayed')
  store.applySnapshot(globalChat)
  store.applySnapshot(boot)
  assert.equal(store.getShell().initializing, false, 'an older snapshot cannot undo cached readiness')
  assert.equal(store.getState().eventSequence, ready.eventSequence)
  // The plan state the renderer holds must not keep the 'initializing'
  // blocker once the lifecycle barrier clears: initializeSession's finally
  // refreshed while lifecyclePromise was still set, so the contentKey dedupe
  // published nothing — the barrier's own release must republish.
  const planUpdates = readiness.filter((e) => e.type === 'plan_state_update' && e.sessionPath === boot.sessionPath)
  assert(planUpdates.length > 0, 'plan state publishes during initialization')
  const lastPlan = planUpdates.at(-1)
  assert(!lastPlan.plan.blockers.switch.includes('initializing'), 'the last plan publish after init must not keep the initializing blocker')
  store.dispatch(lastPlan)
  assert.equal(store.getShell().plan?.blockers.switch.includes('initializing') ?? false, false, 'the composer must never be stuck on a stale initializing blocker')
  console.log('PASS: init, global/project new chat and existing chat open without waiting; prompts wait for tools and readiness survives snapshot races.')

  probe.holdStart = deferred()
  const stoppedSnapshot = await responsive(navigating.newSession(project))
  const stopped = navigating.activeSession
  await until(() => probe.instances.at(-1).ctx?.sessionManager.getSessionId() === stoppedSnapshot.sessionId)
  let stoppedPrompts = 0
  stopped.session.prompt = async () => { stoppedPrompts++ }
  navigating.prompt({ text:'cancel before ready',images:[],files:[] })
  navigating.abort()
  probe.holdStart.resolve(); probe.holdStart = null
  await stopped.lifecyclePromise
  await delay(20)
  assert.equal(stoppedPrompts, 0, 'stopped initialization must not prompt')

  const closing = makeApp()
  probe.holdStart = deferred()
  const opening = await responsive(closing.buildSession(makeSession(), false))
  await until(() => probe.instances.at(-1).ctx?.sessionManager.getSessionId() === opening.session.sessionId)
  const startingExtension = probe.instances.at(-1)
  const disposal = closing.dispose()
  probe.holdStart.resolve(); probe.holdStart = null
  await disposal
  assert.deepEqual(startingExtension.shutdowns, ['quit'])
  assert.equal(closing.sessions.size, 0)
  await assert.rejects(closing.buildSession(makeSession(), false), /shutting down/)

  const reloading = makeApp()
  const r = await reloading.buildSession(makeSession(), false)
  await r.lifecyclePromise
  const oldExtension = probe.instances.at(-1)
  probe.holdShutdown = deferred()
  const inFlightReload = reloading.reloadManagedSession(r)
  await until(() => oldExtension.shutdowns.length === 1)
  const closeDuringReload = reloading.dispose()
  probe.holdShutdown.resolve(); probe.holdShutdown = null
  await Promise.all([inFlightReload, closeDuringReload])
  const replacement = probe.instances.at(-1)
  assert.notEqual(replacement, oldExtension)
  assert.equal(replacement.starts, 0, 'quit must not restart MCP after a pending reload')
  assert.deepEqual(replacement.shutdowns, ['quit'])

  // A tool that ignores AbortSignal must not strand a half-disposed application.
  const hung = makeApp()
  const h = await hung.buildSession(makeSession(), false)
  await h.lifecyclePromise
  const hungExtension = probe.instances.at(-1)
  h.session.abort = () => new Promise(() => {})
  const command = await hung.commandTasks.start({ sessionId:h.session.sessionId, sessionPath:h.path,
    toolCallId:'shutdown-server', command:'sleep 60', cwd:project, shell:'/bin/bash', args:['-c'], env:process.env })
  const began = Date.now()
  const quit = hung.dispose()
  assert.equal(hung.dispose(), quit, 'disposal is idempotent')
  await quit
  assert(Date.now()-began < SESSION_DISPOSE_TIMEOUT_MS+1000)
  assert.equal(hung.commandTasks.get(h.path, command.id).status, 'cancelled')
  assert.deepEqual(hungExtension.shutdowns, ['quit'])
  assert.equal(hung.sessions.size, 0)
  console.log('PASS: quit during initialization and uncooperative aborts cancels extensions/processes and finishes within the deadline.')

  // A rejection must not short-circuit another owner, and repeated Quit must
  // not bypass cleanup or dispose the managers twice.
  const target = new EventEmitter()
  let prevented = 0, exits = 0, cleaned = 0
  target.quit = () => { const event={preventDefault(){prevented++}}; const before=prevented; target.emit('before-quit',event); if(before===prevented){exits++;target.emit('quit')} }
  target.exit = () => { exits++; target.emit('quit') }
  const finish = deferred()
  registerQuitHandler(target, [() => { throw new Error('sync failure') }, async () => { cleaned++; await finish.promise }], 500)
  target.quit(); target.quit(); await delay(20)
  assert.equal(cleaned,1); assert.equal(exits,0)
  finish.resolve(); await delay(20); assert.equal(exits,1)

  // Exercise native before-input-event routing and process exit, not a mock
  // keyboard handler. A stuck cleanup forces exit; normal cleanup uses quit.
  for (const [name, modifiers, hangs] of [['ctrl',['control'],true], ['cmd',['meta'],false]]) {
    const main=join(temporary,`${name}.cjs`), marker=join(temporary,`${name}.log`)
    await build({stdin:{contents:`
import {app,BrowserWindow} from 'electron';
import {appendFileSync} from 'node:fs';
import {registerQuitHandler,registerQuitShortcut} from ${JSON.stringify(resolve('src/main/shutdown.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, name))});
app.whenReady().then(async()=>{
  const mark=t=>appendFileSync(${JSON.stringify(marker)},t+'\\n');
  registerQuitHandler(app,[async()=>{mark('cleanup');await new Promise(r=>setTimeout(r,100));},()=>${hangs ? 'new Promise(()=>{})' : 'Promise.resolve()'}],350);
  const win=new BrowserWindow({show:false}); registerQuitShortcut(win.webContents,()=>app.quit());
  await win.loadURL('data:text/html,<input autofocus>');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Q',modifiers:${JSON.stringify(modifiers)}});
  setTimeout(()=>{mark('still-cleaning');app.quit();},30);
});`,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['electron','proper-lockfile'],outfile:main})
    const child=spawn(electron,[main],{stdio:['ignore','ignore','pipe']})
    let errors=''; child.stderr.on('data',chunk=>{errors+=chunk})
    const code=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Electron quit timed out: '+errors))},10000)
      child.once('error',error=>{clearTimeout(timeout);reject(error)})
      child.once('exit',code=>{clearTimeout(timeout);resolve(code)})
    })
    assert.equal(code,0,errors)
    assert.deepEqual((await readFile(marker,'utf8')).trim().split('\n'),['cleanup','still-cleaning'])
  }
  assert.deepEqual(probe.errors, [])
  console.log('PASS: real Electron Ctrl+Q/Cmd+Q exits after cleanup or deadline; repeated Quit and rejected cleanup cannot strand the app.')
} finally {
  probe.holdStart?.resolve(); probe.holdShutdown?.resolve()
  await Promise.allSettled(apps.map(app=>app.dispose()))
  for(const instance of probe.instances) clearTimeout(instance.timer)
  delete globalThis.lifecycleProbe
  await rm(temporary,{recursive:true,force:true})
}
