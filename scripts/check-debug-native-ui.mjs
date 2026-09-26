/** Real LLDB + production manager/registry + built preload IPC + real beUI.
 * Run after npm run build. This is runtime coverage, not the fake UI suite. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { _electron } from 'playwright-core'
const repo=resolve('.'),temp=await mkdtemp(join(tmpdir(),'pith-native-ui-')),owner='/native-ui'
const screenshots=process.env.PI_DEBUG_SCREENSHOT_DIR
let app, server
try {
  let available=true
  try {execFileSync(process.platform==='darwin'?'xcrun':'lldb-dap',process.platform==='darwin'?['-f','lldb-dap']:['--version'],{stdio:'pipe'})}catch{available=false}
  if (!available) console.log('[SKIP] real native UI requires LLDB DAP')
  else {
    assert.ok(existsSync(join(repo,'out/preload/index.mjs')),'build before running native UI acceptance')
    const source=join(temp,'gone.c'),binary=join(temp,'native')
    await writeFile(source,'volatile int value=7; __attribute__((noinline)) void probe(void){__builtin_debugtrap();value+=1;value+=2;value+=3;} int main(void){probe();return 0;}\n')
    execFileSync(process.platform==='darwin'?'xcrun':'clang',[...(process.platform==='darwin'?['clang']:[]),'-O0',source,'-o',binary],{timeout:30000})
    execFileSync('strip',process.platform==='darwin'?[binary]:['--strip-all',binary]);await unlink(source)
    const module=join(temp,'debug.mjs')
    await build({stdin:{contents:`export * from './src/main/debug/manager'; export * from './src/main/debug/action-registry'`,resolveDir:repo},bundle:true,platform:'node',format:'esm',outfile:module,plugins:[{name:'sdk',setup(b){b.onResolve({filter:/^(@earendil-works\/pi-coding-agent|typebox)$/},a=>({path:fileURLToPath(import.meta.resolve(a.path)),external:true}))}}]})
    const html=`<!doctype html><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {DebugPane} from '/src/components/app/DebugPane.tsx';import {DebugStore} from '/src/state/debug-store.ts';import {I18nProvider} from '/src/i18n/index.tsx';import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');const shell={sessionPath:${JSON.stringify(owner)},subagents:[],cwd:${JSON.stringify(temp)}};const store={getShell:()=>shell,subscribe:()=>()=>{}};const debug=new DebugStore();
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(FileNavigationProvider,{cwd:shell.cwd,openFile:()=>{}},React.createElement(DebugPane,{store,debug}))));</script>`
    server=await createServer({configFile:false,root:repo+'/src/renderer',cacheDir:temp+'/vite',logLevel:'error',resolve:{alias:{'@':repo+'/src/renderer/src'}},plugins:[react(),tailwindcss(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!='/check.html')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/check.html',html))})}}],server:{host:'127.0.0.1',port:0,fs:{allow:[repo,temp]}}})
    await server.listen()
    const url='http://127.0.0.1:'+server.httpServer.address().port+'/check.html'
    await writeFile(join(temp,'main.mjs'),`import {app,BrowserWindow,ipcMain} from 'electron';import {DebugManager,dispatchDebugPanel,dispatchDebugAction} from './debug.mjs';
app.setPath('userData',${JSON.stringify(join(temp,'profile'))});let win;const manager=new DebugManager(dto=>win?.webContents.send('debug:event',dto));globalThis.nativeManager=manager;
ipcMain.handle('debug:list',(_,owner)=>manager.list(owner));ipcMain.handle('debug:action',(_,request)=>dispatchDebugPanel(manager,request));ipcMain.handle('debug:source',(_,r)=>dispatchDebugAction({manager,sessionPath:r.sessionPath,debugId:r.debugId,stopId:r.stopId},{action:'source',sourceReference:r.sourceReference,sourceVersion:r.sourceVersion}));
app.whenReady().then(async()=>{globalThis.nativeSession=await manager.start({sessionId:${JSON.stringify(owner)},sessionPath:${JSON.stringify(owner)},workspaceCwd:${JSON.stringify(temp)},cwd:${JSON.stringify(temp)},program:${JSON.stringify(binary)},kind:'launch',adapterId:'lldb-dap'});win=new BrowserWindow({show:false,width:520,height:1000,webPreferences:{preload:${JSON.stringify(join(repo,'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});await win.loadURL(${JSON.stringify(url)})});`)
    app=await _electron.launch({executablePath:electron,args:[join(temp,'main.mjs')]})
    const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message))
    await page.waitForSelector('[data-debug-pc="true"]',{timeout:30000})
    const firstPC=await page.locator('[data-debug-pc="true"]').innerText()
    const firstStop=Number(await page.locator('[data-debug-pane]').getAttribute('data-debug-stop'))
    await page.getByRole('button',{name:'Step over',exact:true}).click()
    await page.waitForFunction(before=>Number(document.querySelector('[data-debug-pane]')?.dataset.debugStop)>before,firstStop)
    await page.waitForSelector('[data-debug-pc="true"]')
    assert.notEqual(await page.locator('[data-debug-pc="true"]').innerText(),firstPC)
    const selected=await app.evaluate(()=>globalThis.nativeManager.get('/native-ui',globalThis.nativeSession.id))
    assert.equal(selected.status,'stopped');assert.ok(selected.location.instructionPointerReference)
    assert.equal(selected.location.source.kind,'adapter')
    // Real virtual-source request crosses the built preload and DAP transport.
    await page.getByRole('tab',{name:'Source',exact:true}).click()
    await page.waitForSelector('[data-debug-source-line]')
    assert.ok((await page.locator('[data-debug-source]').innerText()).length>40)
    await page.getByRole('tab',{name:'Assembly',exact:true}).click()
    await page.waitForSelector('[data-debug-assembly]')
    const point=page.locator('[data-debug-assembly] button[aria-label^="Set instruction breakpoint"]').nth(2)
    const address=(await point.getAttribute('aria-label')).split(' ').at(-1)
    await point.click()
    await page.waitForFunction(address=>document.querySelector('[data-debug-native-breakpoints]')?.textContent.includes(address),address)
    const stop=Number(await page.locator('[data-debug-pane]').getAttribute('data-debug-stop'))
    await page.getByRole('button',{name:'Continue',exact:true}).click()
    await page.waitForFunction(before=>Number(document.querySelector('[data-debug-pane]')?.dataset.debugStop)>before,stop)
    await page.waitForSelector('[data-debug-pc="true"]')
    const hit=await app.evaluate(()=>globalThis.nativeManager.get('/native-ui',globalThis.nativeSession.id))
    assert.equal(BigInt(hit.location.instructionPointerReference),BigInt(address))
    assert.ok(hit.hitBreakpointIds?.length)
    await page.getByRole('button',{name:'Inspect memory at '+address,exact:true}).click()
    await page.waitForSelector('[data-debug-memory] pre')
    assert.ok((await page.locator('[data-debug-memory] pre').innerText()).length>40)
    await page.getByRole('button',{name:'Registers',exact:true}).click()
    await page.getByRole('button',{name:/^General Purpose Registers/}).click()
    await page.waitForFunction(()=>document.querySelector('[aria-label="Registers"]')?.textContent.includes('pc'))
    await page.getByRole('tab',{name:'Modules',exact:true}).click()
    await page.waitForSelector('[data-debug-modules] li')
    assert.ok(await page.locator('[data-debug-modules] li').count()>0)
    if(screenshots){await mkdir(screenshots,{recursive:true});await page.locator('#root').screenshot({path:join(screenshots,'real-lldb-native.png')})}
    assert.deepEqual(errors,[])
    console.log('[PASS] real Electron + built preload IPC + LLDB: stripped binary, virtual source, instruction step, instruction breakpoint hit, memory, register groups and modules')
  }
} finally {
  if(app){await app.evaluate(async()=>{await globalThis.nativeManager?.dispose()}).catch(()=>{});await app.close()}
  await server?.close();await rm(temp,{recursive:true,force:true})
}
