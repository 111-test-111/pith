/** Real beUI DebugPane in isolated Electron; no adapters or model calls. */
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { _electron } from 'playwright-core'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const repo = resolve('.'), temp = await mkdtemp(join(tmpdir(), 'pith-debug-ui-'))
const screenshots = process.env.PI_DEBUG_SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
let server, app
const html = `<!doctype html><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {DebugPane} from '/src/components/app/DebugPane.tsx';import {DebugStore} from '/src/state/debug-store.ts';import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';import '/src/styles.css';
import {FileSource} from '/src/components/app/FileSource.tsx';import {FilesPane} from '/src/components/app/FilesPane.tsx';import {FileBrowserStore} from '/src/state/file-browser-store.ts';
localStorage.setItem('pi-app:locale','en');
window.calls=[];window.values={a:'1',b:'other'};window.consoleText='';window.listeners=[];window.listCalls=[];
const base={sessionPath:'/review',sessionId:'chat',adapterId:'fake',adapterLabel:'Fake',kind:'launch',status:'stopped',activeThreadId:1,outputChars:0,revision:1,stopId:1,location:{file:'/tmp/demo.c',line:7,name:'main'}};
window.sessions=[{...base,id:'a',target:'Alpha',startedAt:1},{...base,id:'b',target:'Beta',startedAt:2}];
window.pi={onDebugEvent:fn=>{listeners.push(fn);return()=>{}},debugList:async path=>{listCalls.push(path);return sessions.filter(s=>s.sessionPath===path)},openExternal:()=>{},openPath:()=>{},readFileDocument:async r=>({path:r.path,relativePath:'demo.c',gitRoot:null,size:100,truncated:false,text:Array.from({length:20},(_,i)=>'int value'+i+' = '+i+';').join('\\n')}),debugAction:async r=>{calls.push(r);const dto=sessions.find(s=>s.id===r.debugId);if(!dto||dto.sessionPath!==r.sessionPath)throw Error('Missing target or wrong owner');switch(r.action){
case 'restart': {publish(dto.id,{status:'terminated'});const next={...dto,id:dto.id+'-restart',replacesId:dto.id,revision:1,stopId:1,status:'stopped',startedAt:Date.now()};sessions.push(next);values[next.id]='restarted';return next;}
case 'threads':return [{id:1,name:'main'},{id:2,name:'worker'}];case 'stack':return [{id:r.threadId===1?1:2,name:r.threadId===1?'main':'worker',file:'/tmp/demo.c',line:r.threadId===1?7:9}];case 'scopes':return [{name:'Locals',variablesReference:100}];case 'variables':return {variables:[{name:'value',value:values[r.debugId],variablesReference:200}],truncated:false};case 'breakpoints':return [{file:'/tmp/demo.c',line:12,verified:true}];case 'output':return{session:dto,output:consoleText.slice(-r.maxChars),cursor:consoleText.length,truncated:consoleText.length>r.maxChars};case 'evaluate':return {result:'frame:'+r.frameId,variablesReference:0};default:return{};}}};
window.publish=(id,patch)=>{const i=sessions.findIndex(s=>s.id===id);sessions[i]={...sessions[i],...patch,revision:sessions[i].revision+1};for(const fn of listeners)fn(sessions[i])};
window.shell={sessionPath:'/review',subagents:[],cwd:'/tmp',isStreaming:false};const shellListeners=new Set();const store={subscribe:fn=>{shellListeners.add(fn);return()=>shellListeners.delete(fn)},getShell:()=>shell};window.setShell=patch=>{window.shell={...shell,...patch};shellListeners.forEach(fn=>fn())};window.debug=new DebugStore();
function LanguageControl(){window.setLocale=useI18n().setLocale;return null}
const root=createRoot(document.getElementById('root'));window.showDebug=()=>root.render(React.createElement(I18nProvider,null,React.createElement(LanguageControl),React.createElement(FileNavigationProvider,{cwd:'/tmp',openFile:t=>{window.opened=t}},React.createElement(DebugPane,{store,debug}))));showDebug();
const files=new FileBrowserStore();files.open('/tmp',{path:'/tmp/demo.c'});files.toggleTree('/tmp/demo.c');window.showFiles=()=>root.render(React.createElement(I18nProvider,null,React.createElement(FilesPane,{files,store,filePath:'/tmp/demo.c',debug})));
window.gutterToggles=[];window.showSource=()=>root.render(React.createElement(I18nProvider,null,React.createElement('div',{style:{height:600,display:'flex',flexDirection:'column'}},React.createElement(FileSource,{text:Array.from({length:1000},(_,i)=>'int value'+i+' = '+i+';').join('\\n'),store:new FileBrowserStore(),tab:{path:'/tmp/demo.c',cwd:'/tmp',view:'source',visit:1,treeOpen:true},wrap:false,debugBreakpoints:[{file:'/tmp/demo.c',line:7,verified:true}],onToggleBreakpoint:line=>gutterToggles.push(line)}))));
</script>`
try {
  server=await createServer({configFile:false,root:repo+'/src/renderer',cacheDir:temp+'/vite',logLevel:'error',resolve:{alias:{'@':repo+'/src/renderer/src'}},plugins:[react(),tailwindcss(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!='/check.html')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/check.html',html))})}}],server:{host:'127.0.0.1',port:0,fs:{allow:[repo,temp]}}})
  await server.listen()
  const url='http://127.0.0.1:'+server.httpServer.address().port+'/check.html'
  await writeFile(temp+'/main.cjs',`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(temp+'/profile')});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:700,height:900,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)})});`)
  app=await _electron.launch({executablePath:electron,args:[temp+'/main.cjs']})
  const page=await app.firstWindow(), errors=[];page.on('pageerror',e=>errors.push(e.message))
  const locals=()=>page.getByRole('button',{name:'Locals',exact:true})
  await locals().click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Variables"]').textContent.includes('value1'))
  const value=page.getByRole('button',{name:/^value\s*1$/});await value.focus();await page.keyboard.press('Enter')
  await page.waitForFunction(()=>calls.some(c=>c.action==='variables'&&c.variablesReference===200))
  await page.evaluate(()=>{debug.addWatch('a','value')})
  await page.waitForFunction(()=>calls.some(c=>c.action==='evaluate'))
  assert.ok(await page.evaluate(()=>calls.filter(c=>c.action==='evaluate').every(c=>c.context==='watch'&&c.frameId===1)))
  const before=await page.evaluate(()=>calls.filter(c=>c.action==='evaluate').length)
  await page.evaluate(()=>publish('a',{outputChars:10}));await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='evaluate').length),before)
  await page.getByRole('button',{name:'worker',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.action==='evaluate'&&c.frameId===2))
  // A new stop may arrive without a render of the intermediate running state.
  await page.evaluate(()=>{values.a='2';publish('a',{stopId:2})});await locals().click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Variables"]').textContent.includes('value2'))
  assert.equal(await page.locator('[aria-label="Variables"]').innerText().then(t=>t.includes('value1')),false)
  await page.getByRole('button',{name:/main \/tmp\/demo.c:7/}).first().click()
  assert.deepEqual(await page.evaluate(()=>opened),{path:'/tmp/demo.c',line:7})
  await page.evaluate(()=>publish('a',{status:'terminated'}))
  await page.waitForTimeout(50)
  assert.equal(await page.locator('[data-debug-pane]').getAttribute('data-debug-id'),'a', 'ending the selected target must not silently select another live target')
  await page.getByRole('button',{name:'Debug session',exact:true}).click()
  await page.getByRole('option',{name:/Beta/}).click()
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='b')
  await page.getByRole('button',{name:'Continue',exact:true}).click()
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='control').at(-1).debugId),'b')
  await page.evaluate(()=>{consoleText='x'.repeat(80000)+'TAIL';publish('b',{status:'terminated',outputChars:consoleText.length})})
  await page.waitForFunction(()=>document.querySelector('pre')?.textContent.endsWith('TAIL'))
  assert.equal(await page.locator('pre').evaluate(e=>e.textContent.length),65536)
  await page.evaluate(()=>publish('b',{kind:'core',status:'stopped',stopId:2}))
  assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true)
  assert.equal(await page.locator('[aria-label="Watch"]').count(),0)
  await page.evaluate(()=>{debug.select('/review','a');publish('a',{status:'stopped'})})
  await page.getByRole('button',{name:'Restart',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='a-restart')
  assert.deepEqual(await page.evaluate(()=>debug.watchList('a-restart')),['value'])
  await page.getByRole('button',{name:'Continue',exact:true}).click()
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='control').at(-1).debugId),'a-restart')
  // A model-initiated restart follows the same event path; an explicit switch wins.
  await page.evaluate(()=>{debug.select('/review','b');const dto={...sessions.find(s=>s.id==='a-restart'),id:'model-restart',replacesId:'a-restart',revision:1};sessions.push(dto);listeners.forEach(fn=>fn(dto))})
  assert.equal(await page.evaluate(()=>debug.selectedFor('/review').id),'b')
  assert.deepEqual(await page.evaluate(()=>debug.watchList('model-restart')),['value'])
  await page.evaluate(()=>{debug.select('/review','a-restart');publish('a-restart',{adapterId:'lldb-dap',conditionError:true,stopDescription:'breakpoint 1.1',stopDiagnostics:'error evaluating condition of breakpoint 1.1: unknown return type'})})
  await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('not a confirmed match'))
  assert.match(await page.locator('[role="alert"]').innerText(),/unknown return type/)

  // Children already debugging before the panel opens are recovered by owner;
  // broadcasts from an unrelated chat never enter this chat's selector.
  await page.evaluate(()=>{
    const base=sessions[0];
    for(const [id,owner,target] of [['child-a','/child-a','Child alpha'],['child-b','/child-b','Child beta'],['foreign','/other','Unrelated target']]) {
      const dto={...base,id,sessionId:owner,sessionPath:owner,target,revision:1,stopId:1,status:'stopped',startedAt:10+sessions.length,conditionError:false,stopDiagnostics:undefined};
      sessions.push(dto);values[id]=id;if(id==='foreign')listeners.forEach(fn=>fn(dto));
    }
    setShell({subagents:[{sessionPath:'/child-a',profile:'debugger',description:'Investigate crash'},{sessionPath:'/child-b',profile:'reviewer',description:'Inspect worker'}]});
  })
  await page.waitForFunction(()=>listCalls.includes('/child-a')&&listCalls.includes('/child-b'))
  await page.getByRole('button',{name:'Debug session',exact:true}).click()
  assert.equal(await page.getByRole('option',{name:/Unrelated target/}).count(),0)
  await page.getByRole('option',{name:/Subagent debugger: Investigate crash.*Child alpha/}).click()
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='child-a')
  await page.evaluate(()=>{document.getElementById('root').style.width='320px'})
  const selector=page.getByRole('button',{name:'Debug session',exact:true})
  assert.ok(await selector.evaluate(e=>e.scrollWidth<=e.clientWidth&&e.firstElementChild.getBoundingClientRect().height<=e.clientHeight),'long child labels stay inside a narrow trigger')
  await selector.click()
  await page.waitForTimeout(600)
  assert.ok(await page.getByRole('listbox').evaluate(e=>e.scrollWidth<=e.clientWidth),'child options wrap inside the rail')
  if(screenshots)await page.locator('#root').screenshot({path:join(screenshots,'subagents-light-en.png')})
  await page.keyboard.press('Escape')
  await locals().click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Variables"]').textContent.includes('child-a'))
  await page.getByRole('button',{name:'Continue',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>{const r=calls.filter(c=>c.action==='control').at(-1);return [r.sessionPath,r.debugId,r.stopId]}),['/child-a','child-a',1])
  const listCount=await page.evaluate(()=>listCalls.length)
  await page.evaluate(()=>setShell({subagents:shell.subagents.map(r=>({...r,tokens:1234}))}))
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>listCalls.length),listCount,'roster progress must not refetch every owner')

  // The actual file pane must use the selected child's owning path for its
  // breakpoint IPC, not the parent chat whose transcript is still visible.
  await page.evaluate(()=>showFiles())
  await page.getByRole('button',{name:'Toggle breakpoint at line 7',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>{const r=calls.filter(c=>c.action==='breakpoint-toggle').at(-1);return [r.sessionPath,r.debugId,r.line]}),['/child-a','child-a',7])
  await page.evaluate(()=>{showDebug();debug.addWatch('child-a','value')})
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='child-a')
  await page.getByRole('button',{name:'Restart',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='child-a-restart')
  assert.deepEqual(await page.evaluate(()=>debug.watchList('child-a-restart')),['value'])
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='restart').at(-1).sessionPath),'/child-a')
  await page.evaluate(()=>{consoleText='CHILD FINAL OUTPUT';publish('child-a-restart',{status:'terminated',outputChars:consoleText.length})})
  await page.waitForFunction(()=>document.querySelector('pre')?.textContent==='CHILD FINAL OUTPUT')
  assert.equal(await page.locator('[data-debug-pane]').getAttribute('data-debug-id'),'child-a-restart')
  assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true)

  await page.evaluate(()=>{document.documentElement.classList.add('dark');setLocale('zh-CN')})
  await page.getByRole('button',{name:'调试会话',exact:true}).click()
  assert.equal(await page.getByRole('option',{name:/子代理 debugger：Investigate crash/}).count(),2)
  await page.waitForTimeout(600)
  if(screenshots)await page.locator('#root').screenshot({path:join(screenshots,'subagents-dark-zh.png')})
  await page.keyboard.press('Escape')
  await page.evaluate(()=>{document.getElementById('root').style.width='';setLocale('en');document.documentElement.classList.remove('dark');setShell({sessionPath:'/other',subagents:[]})})
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='foreign')
  await page.getByRole('button',{name:'Debug session',exact:true}).click()
  assert.equal(await page.getByRole('option',{name:/Child alpha|Child beta/}).count(),0)
  await page.keyboard.press('Escape')
  await page.evaluate(()=>setShell({sessionPath:'/review',subagents:[{sessionPath:'/child-a',profile:'debugger',description:'Investigate crash'},{sessionPath:'/child-b',profile:'reviewer',description:'Inspect worker'}]}))
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='child-a-restart')
  await page.evaluate(()=>setShell({subagents:[{sessionPath:'/child-b',profile:'reviewer',description:'Inspect worker'}]}))
  await page.waitForFunction(()=>!document.querySelector('[data-debug-pane]')?.dataset.debugId.startsWith('child-a'))
  await page.getByRole('button',{name:'Debug session',exact:true}).click()
  assert.equal(await page.getByRole('option',{name:/Child alpha/}).count(),0,'removed roster members stay outside the view even if cached')
  await page.keyboard.press('Escape')

  // A parent with no debugger still gets a stable automatic child selection;
  // a later sibling must not steal it when that first child finishes.
  await page.evaluate(()=>setShell({sessionPath:'/parent-without-debugger',subagents:[{sessionPath:'/child-b',profile:'reviewer',description:'Inspect worker'}]}))
  await page.waitForFunction(()=>document.querySelector('[data-debug-pane]')?.dataset.debugId==='child-b')
  await page.evaluate(()=>{
    const dto={...sessions.find(s=>s.id==='child-b'),id:'late-child',sessionPath:'/late-child',revision:1,startedAt:Date.now()};sessions.push(dto);listeners.forEach(fn=>fn(dto));
    setShell({subagents:[...shell.subagents,{sessionPath:'/late-child',profile:'debugger',description:'Late child'}]});
    publish('child-b',{status:'terminated'});
  })
  await page.waitForTimeout(100)
  assert.equal(await page.locator('[data-debug-pane]').getAttribute('data-debug-id'),'child-b')
  await page.evaluate(()=>showSource())
  const gutter=page.getByRole('button',{name:'Toggle breakpoint at line 7',exact:true})
  await gutter.focus();await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(()=>gutterToggles),[7])
  assert.equal(await gutter.getAttribute('aria-pressed'),'true')
  assert.ok(await gutter.evaluate(e=>e.tabIndex>=0))
  assert.equal(await page.locator('[data-source-line="7"]').evaluate(e=>e.getBoundingClientRect().height),20)
  assert.ok(await page.locator('[data-source-line]').count()<100, 'gutter controls remain windowed')
  assert.deepEqual(errors,[])
  console.log('[PASS] debug UI: parent/subagent target selection, child refresh/roster isolation, owning-path controls/gutter/restart, watches and completed output, both locales/themes, stop/frame freshness, keyboard variables and gutter, condition diagnostics, core controls')
} finally {await app?.close();await server?.close();await rm(temp,{recursive:true,force:true})}
