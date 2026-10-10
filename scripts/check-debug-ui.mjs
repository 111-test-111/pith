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
window.fileReads=[];window.sourceCalls=[];window.nativeLongSource=false;window.nativePoints={instruction:[],function:[]};window.nativeSource={kind:'adapter',sourceReference:1,name:'virtual.asm',path:'/not-a-file'};window.calls=[];window.values={a:'1',b:'other'};window.consoleText='';window.listeners=[];window.listCalls=[];
const base={sessionPath:'/review',sessionId:'chat',adapterId:'fake',adapterLabel:'Fake',kind:'launch',status:'stopped',activeThreadId:1,outputChars:0,revision:1,stopId:1,location:{file:'/tmp/demo.c',line:7,name:'main'}};
window.sessions=[{...base,id:'a',target:'Alpha',startedAt:1},{...base,id:'b',target:'Beta',startedAt:2}];
window.pi={onDebugEvent:fn=>{listeners.push(fn);return()=>{}},debugList:async path=>{listCalls.push(path);return sessions.filter(s=>s.sessionPath===path)},openExternal:()=>{},openPath:()=>{},readFileDocument:async r=>(fileReads.push(r.path),r.path==='/missing.c'?{error:'missing'}:{path:r.path,relativePath:'demo.c',gitRoot:null,size:100,truncated:false,text:Array.from({length:20},(_,i)=>'int value'+i+' = '+i+';').join('\\n')}),debugSource:async r=>{sourceCalls.push(r);if(window.nativeNearSource){const start=r.offset===0?1:40;return{debugId:r.debugId,sourceReference:r.sourceReference,sourceVersion:r.sourceVersion,content:Array.from({length:12},(_,i)=>'VIRTUAL SOURCE '+(start+i)).join('\\n'),offset:start===1?0:390,nextOffset:start===1?120:510,totalChars:1500,startLine:start,previousOffset:0,truncated:true}}if(nativeLongSource){const later=r.offset!==undefined;const content=Array.from({length:20},(_,i)=>'VIRTUAL SOURCE '+((later?12021:11991)+i)).join('\\n');return{debugId:r.debugId,sourceReference:r.sourceReference,sourceVersion:r.sourceVersion,content,offset:later?r.offset:300000,nextOffset:later?r.offset+512:300512,totalChars:400000,startLine:later?12021:11991,truncated:true}}return{debugId:r.debugId,sourceReference:r.sourceReference,sourceVersion:r.sourceVersion,content:Array.from({length:12},(_,i)=>'VIRTUAL SOURCE '+(i+1)).join('\\n'),truncated:false}},debugAction:async r=>{calls.push(r);const dto=sessions.find(s=>s.id===r.debugId);if(!dto||dto.sessionPath!==r.sessionPath)throw Error('Missing target or wrong owner');if(dto.native){switch(r.action){
case 'stack':return [{id:r.threadId,name:'native_frame',source:window.nativeSource,file:window.nativeSource.kind==='file'?window.nativeSource.path:undefined,line:dto.location?.line??3,instructionPointerReference:'0x2000000000000001',moduleId:'native-module'}];
case 'scopes':return [{name:'General registers',presentationHint:'registers',variablesReference:500}];
case 'variables':{const value=window.nativeValue??'0x2000000000000001';if(window.nativeDelay)await new Promise(done=>setTimeout(done,window.nativeDelay));return {variables:Array.from({length:r.start?1:50},(_,i)=>({name:r.start?'r50':i?'r'+i:'pc',value,memoryReference:i?undefined:'opaque:memory',variablesReference:0})),truncated:!r.start};}
case 'disassemble':return {memoryReference:r.memoryReference,instructionOffset:r.instructionOffset,instructions:Array.from({length:8},(_,i)=>({address:'0x'+(0x2000000000000001n+BigInt((r.instructionOffset??0)+i)*4n).toString(16),instruction:'mov x0, x1',instructionBytes:'00000000'}))};
case 'memory.read':return {address:r.memoryReference,data:'AQIDBA==',hex:'01 02 03 04',bytesRead:4,requestedCount:r.count,unreadableBytes:r.count-4,truncated:true};
case 'modules':return {modules:Array.from({length:r.start?1:20},(_,i)=>({id:(r.start??0)+i,name:'module-'+((r.start??0)+i),path:'/lib/native.so',symbolStatus:'Symbols loaded'})),totalModules:21,truncated:!r.start};
case 'breakpoints.native':return nativePoints;
case 'breakpoints.instruction.toggle':nativePoints={...nativePoints,instruction:nativePoints.instruction.length?[]:[{instructionReference:r.instructionReference,verified:true,id:1}]};return nativePoints;
case 'breakpoints.instruction':nativePoints={...nativePoints,instruction:r.items.map((p,i)=>({...p,verified:true,id:i+1}))};return nativePoints;
case 'breakpoints.function.update':nativePoints={...nativePoints,function:r.enabled?[...nativePoints.function.filter(p=>p.name!==r.name),{name:r.name,verified:true,id:101}]:nativePoints.function.filter(p=>p.name!==r.name)};return nativePoints;
case 'breakpoints.instruction.update':nativePoints={...nativePoints,instruction:nativePoints.instruction.filter(p=>p.instructionReference!==r.instructionReference)};return nativePoints;
case 'breakpoints.function':nativePoints={...nativePoints,function:r.items.map((p,i)=>({...p,verified:true,id:i+101}))};return nativePoints;
}}switch(r.action){
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
  // The same stopped target, expanded variable and watch draft survive
  // container breakpoints without issuing debugger requests.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1400,900))
  await page.getByRole('textbox',{name:'Expression to evaluate on each stop'}).fill('draft.member')
  await page.evaluate(()=>{window.resizePane=document.querySelector('[data-debug-pane]');window.resizeCalls=calls.length})
  for(const locale of ['en','zh-CN']) {
    await page.evaluate(locale=>setLocale(locale),locale)
    for(const corners of ['square','squircle']) {
      for(const dark of [false,true]) {
        await page.evaluate(({corners,dark})=>{document.documentElement.dataset.corners=corners;document.documentElement.classList.toggle('dark',dark)},{corners,dark})
        for(const width of [260,400,767,768,1200]) {
          await page.evaluate(width=>document.getElementById('root').style.width=width+'px',width)
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
          const layout=await page.evaluate(()=>{
            const nav=document.querySelector('[data-debug-navigation]').getBoundingClientRect(),detail=document.querySelector('[data-debug-inspection]').getBoundingClientRect(),pane=document.querySelector('[data-debug-pane]')
            return {nav:{x:nav.x,y:nav.y,right:nav.right,width:nav.width},detail:{x:detail.x,y:detail.y},overflow:pane.scrollWidth>pane.clientWidth+1,
              same:pane===window.resizePane,calls:calls.length,draft:document.querySelector('[data-debug-inspection] input').value,expanded:document.querySelector('[aria-expanded=true]')!==null}
          })
          assert(!layout.overflow,`debug fits ${width}px: ${JSON.stringify(layout)}`)
          assert(layout.same&&layout.expanded,'resize preserves the target DOM and expanded variables')
          assert.equal(layout.draft,'draft.member','watch input survives resize')
          assert.equal(layout.calls,await page.evaluate(()=>window.resizeCalls),'resize does not query the adapter')
          if(width>=768) {assert(Math.abs(layout.nav.y-layout.detail.y)<1);assert(layout.detail.x>=layout.nav.right-1);assert(layout.nav.width<=384)}
          else {assert(Math.abs(layout.nav.x-layout.detail.x)<1);assert(layout.detail.y>layout.nav.y)}
        }
      }
    }
  }
  // Wide dividers share drag/keyboard behavior without changing stopped state.
  await page.evaluate(()=>{setLocale('en');document.documentElement.classList.remove('dark');document.getElementById('root').style.width='1200px'})
  const split=page.getByRole('separator',{name:'Resize debug navigation and inspection',exact:true}),navigation=page.locator('[data-debug-navigation]'),inspection=page.locator('[data-debug-inspection]'),inspectionNode=await inspection.elementHandle()
  const splitWidth=async()=> (await navigation.boundingBox()).width
  const dragSplit=async delta=>{const box=await split.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+20);await page.mouse.down();await page.mouse.move(box.x+box.width/2+delta,box.y+20,{steps:3})}
  const requestsBeforeSplit=await page.evaluate(()=>calls.length),startWidth=await splitWidth()
  await dragSplit(90);assert(Math.abs(await splitWidth()-startWidth-90)<2)
  assert.equal(await page.evaluate(()=>localStorage.getItem('pi-app:debug-split')),null,'drag frames do not save a preference')
  await page.mouse.up();await split.focus();const beforeKey=await splitWidth();await split.press('ArrowLeft');assert(Math.abs(await splitWidth()-beforeKey+10)<2)
  await split.press('Shift+ArrowRight');assert(Math.abs(await splitWidth()-beforeKey-30)<2)
  await dragSplit(-2000);await page.mouse.up();assert(Math.abs(await splitWidth()-Number(await split.getAttribute('aria-valuemin')))<2)
  await dragSplit(2000);await page.mouse.up();assert(Math.abs(await splitWidth()-Number(await split.getAttribute('aria-valuemax')))<2)
  await dragSplit(600-await splitWidth());await page.mouse.up();const preferredSplit=await page.evaluate(()=>Number(localStorage.getItem('pi-app:debug-split')))
  // A plain press must not leave the sizing observer stuck or save a fitted size.
  await split.click()
  for(const width of [768,400,1200]){
    await page.evaluate(width=>document.getElementById('root').style.width=width+'px',width)
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.equal(await split.isVisible(),width>=768)
    if(width===768){assert(await splitWidth()<preferredSplit);assert.equal(Number(await split.getAttribute('aria-valuenow')),Math.round(await splitWidth()),'the breakpoint follows the named container despite scrollport padding')}
    if(width===1200)assert(Math.abs(await splitWidth()-preferredSplit)<2)
    assert.equal(await page.evaluate(()=>Number(localStorage.getItem('pi-app:debug-split'))),preferredSplit)
    assert.equal(await inspectionNode.evaluate(node=>node===document.querySelector('[data-debug-inspection]')),true)
    assert.equal(await page.evaluate(()=>calls.length),requestsBeforeSplit,'dragging and fitting never query the debug adapter')
    assert.equal(await page.locator('[data-debug-inspection] input').inputValue(),'draft.member')
  }
  for(const [locale,label] of [['zh-CN','调整调试导航与详情宽度'],['zh-TW','調整除錯導覽與詳細資料寬度'],['en','Resize debug navigation and inspection']]){await page.evaluate(locale=>setLocale(locale),locale);assert.equal(await page.getByRole('separator',{name:label,exact:true}).count(),1)}
  if(screenshots)await page.locator('#root').screenshot({path:join(screenshots,'responsive-wide.png')})
  await page.evaluate(()=>{document.getElementById('root').style.width='';setLocale('en');document.documentElement.classList.remove('dark')})
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(700,900))
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
  // Source-less inspection uses the selected child's owner and exact stop token.
  await page.evaluate(()=>{
    const dto={...sessions.find(s=>s.id==='child-b'),id:'native-child',sessionPath:'/native-child',native:true,revision:1,sourceVersion:1,stopId:1,status:'stopped',kind:'launch',target:'Stripped native target',location:{name:'native_frame',line:3,source:nativeSource,instructionPointerReference:'0x2000000000000001'},capabilities:{supportsDisassembleRequest:true,supportsReadMemoryRequest:true,supportsSteppingGranularity:true,supportsInstructionBreakpoints:true,supportsFunctionBreakpoints:true,supportsModulesRequest:true}};
    sessions.push(dto);listeners.forEach(fn=>fn(dto));setShell({sessionPath:'/native-parent',subagents:[{sessionPath:'/native-child',profile:'debugger',description:'Native crash'}]});showDebug();document.getElementById('root').style.width='320px';
  })
  const native=page.locator('[data-debug-native]')
  await page.waitForSelector('[data-debug-pc="true"]')
  assert.match(await page.getByRole('button',{name:'Stepping mode',exact:true}).innerText(),/Instruction/)
  const virtualReads=await page.evaluate(()=>fileReads.length)
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  await page.waitForSelector('[data-debug-source-line="3"]')
  assert.match(await page.locator('[data-debug-source-line="3"]').innerText(),/VIRTUAL SOURCE 3/)
  assert.equal(await page.evaluate(()=>fileReads.length),virtualReads,'virtual source must never reach disk file IPC')
  assert.deepEqual(await page.evaluate(()=>sourceCalls.at(-1)),{sessionPath:'/native-child',debugId:'native-child',stopId:1,sourceReference:1,sourceVersion:1,startLine:1,limit:8192})
  // An initial window near the stop can have an earlier page at offset zero.
  await page.evaluate(()=>{window.nativeNearSource=true;publish('native-child',{sourceVersion:2,location:{...sessions.find(s=>s.id==='native-child').location,line:50}})})
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  await page.waitForSelector('[data-debug-source-line="50"]')
  assert.equal(await native.getByRole('button',{name:'Previous page',exact:true}).isDisabled(),false)
  await native.getByRole('button',{name:'Previous page',exact:true}).click()
  await page.waitForSelector('[data-debug-source-line="1"]')
  assert.equal(await native.getByRole('button',{name:'Previous page',exact:true}).isDisabled(),true)
  await page.evaluate(()=>{window.nativeNearSource=false;nativeLongSource=true;publish('native-child',{stopId:2,sourceVersion:2,location:{...sessions.find(s=>s.id==='native-child').location,line:12001}})})
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  await page.waitForSelector('[data-debug-source-line="12001"]')
  assert.ok((await page.evaluate(()=>sourceCalls.at(-1).startLine))===11991)
  await native.getByRole('button',{name:'Next page',exact:true}).click()
  await page.waitForFunction(()=>sourceCalls.at(-1)?.offset===300512)
  await page.waitForSelector('[data-debug-source-line="12021"]')
  await native.getByRole('button',{name:'Next page',exact:true}).click()
  await page.waitForFunction(()=>sourceCalls.at(-1)?.offset===301024)
  await native.getByRole('button',{name:'Previous page',exact:true}).click()
  await page.waitForFunction(()=>sourceCalls.at(-1)?.offset===300512)
  await native.getByRole('button',{name:'Previous page',exact:true}).click()
  await page.waitForFunction(()=>sourceCalls.at(-1)?.offset===300000)
  await page.evaluate(()=>{nativeLongSource=false;publish('native-child',{stopId:3,sourceVersion:3,location:{...sessions.find(s=>s.id==='native-child').location,line:3}})})
  await page.getByRole('tab',{name:'Assembly',exact:true}).click()
  await native.getByRole('button',{name:'Set instruction breakpoint at 0x2000000000000001',exact:true}).click()
  await page.waitForFunction(()=>nativePoints.instruction.length===1)
  assert.deepEqual(await page.evaluate(()=>{const r=calls.filter(c=>c.action==='breakpoints.instruction.toggle').at(-1);return [r.sessionPath,r.debugId,r.stopId,r.instructionReference]}),['/native-child','native-child',3,'0x2000000000000001'])
  await page.getByRole('textbox',{name:'Function name',exact:true}).fill('checkpoint')
  await page.getByRole('button',{name:'Add function breakpoint',exact:true}).click()
  await page.waitForFunction(()=>nativePoints.function.length===1)
  await native.getByRole('button',{name:'Inspect memory at 0x2000000000000001',exact:true}).click()
  await page.waitForSelector('[data-debug-memory] pre')
  assert.match(await page.locator('[data-debug-memory]').innerText(),/4 of 128.*124 unreadable/)
  assert.match(await page.locator('[data-debug-memory] pre').innerText(),/01 02 03 04/)
  assert.ok(!(await page.locator('[data-debug-memory] pre').innerText()).includes('00 00'),'unreadable bytes must not become zeros')
  await page.getByRole('button',{name:'General registers',exact:true}).click()
  await page.getByRole('button',{name:'Load more variables',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.action==='variables'&&c.start===50))
  await page.waitForFunction(()=>document.querySelector('[aria-label="Registers"]')?.textContent.includes('r50'))
  await page.getByRole('button',{name:'Inspect memory of pc',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.action==='memory.read'&&c.memoryReference==='opaque:memory'))
  await page.getByRole('tab',{name:'Modules',exact:true}).click()
  await page.waitForSelector('[data-debug-modules]')
  await native.getByRole('button',{name:'Next page',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.action==='modules'&&c.start===20))
  await page.getByRole('tab',{name:'Assembly',exact:true}).click()
  await native.getByRole('button',{name:'Next page',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.action==='disassemble'&&c.instructionOffset===32))
  assert.ok(await native.evaluate(e=>e.scrollWidth<=e.clientWidth),'native inspection stays inside the 320px rail')
  await page.getByRole('button',{name:'Step over',exact:true}).click()
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='control').at(-1).granularity),'instruction')
  await page.evaluate(()=>publish('native-child',{stopId:4,sourceVersion:4}))
  await page.waitForSelector('[data-debug-pc="true"]')
  assert.match(await page.getByRole('button',{name:'Stepping mode',exact:true}).innerText(),/Instruction/)
  if(screenshots)await page.locator('#root').screenshot({path:join(screenshots,'native-light-en.png')})
  await page.evaluate(()=>{document.documentElement.classList.add('dark');setLocale('zh-CN')})
  await page.waitForTimeout(300)
  if(screenshots)await page.locator('#root').screenshot({path:join(screenshots,'native-dark-zh.png')})
  await page.evaluate(()=>{setLocale('en');document.documentElement.classList.remove('dark');nativeSource={kind:'file',path:'/missing.c',name:'missing.c'};publish('native-child',{sourceVersion:3})})
  await page.waitForFunction(()=>fileReads.includes('/missing.c'))
  await page.waitForSelector('[data-debug-assembly]')
  assert.match(await native.innerText(),/Source unavailable/)
  await page.evaluate(()=>publish('native-child',{kind:'core',stopId:3,sourceVersion:4}))
  await page.waitForSelector('[data-debug-assembly]')
  assert.equal(await page.getByRole('button',{name:'Step over',exact:true}).isDisabled(),true)
  assert.equal(await native.locator('[data-debug-native-breakpoints]').count(),0)
  assert.equal(await native.getByRole('button',{name:'Remove instruction breakpoint at 0x2000000000000001',exact:true}).isDisabled(),true)
  // Unsupported capabilities remove native operations rather than invoking an adapter anyway.
  await page.evaluate(()=>{nativeSource={kind:'file',path:'/missing.c'};publish('native-child',{capabilities:{},sourceVersion:5})})
  await page.waitForFunction(()=>!document.querySelector('[data-debug-assembly]'))
  assert.equal(await page.getByRole('tab',{name:'Assembly',exact:true}).count(),0)
  await page.evaluate(()=>{nativeValue='OLD_FRAME';nativeDelay=200;publish('native-child',{stopId:4})})
  await page.getByRole('button',{name:'General registers',exact:true}).click()
  await page.evaluate(()=>{nativeValue='NEW_FRAME';nativeDelay=0})
  await page.getByRole('button',{name:'worker',exact:true}).click()
  await page.waitForFunction(()=>calls.some(c=>c.debugId==='native-child'&&c.stopId===4&&c.action==='scopes'&&c.frameId===2))
  await page.getByRole('button',{name:'General registers',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[aria-label="Registers"]')?.textContent.includes('NEW_FRAME'))
  await page.waitForTimeout(220)
  assert.ok(!(await page.locator('[aria-label="Registers"]').innerText()).includes('OLD_FRAME'),'late variables cannot populate reused references in a different frame')
  console.log('[PASS] native debug UI: virtual-source IPC, missing-file assembly fallback, PC/high addresses, instruction step/breakpoints, register memory, gaps, modules paging, owner/stop routing, 320px, core and capability gating')
  assert.deepEqual(errors,[])
  console.log('[PASS] debug UI: parent/subagent target selection, child refresh/roster isolation, owning-path controls/gutter/restart, watches and completed output, both locales/themes, stop/frame freshness, keyboard variables and gutter, condition diagnostics, core controls')
} finally {await app?.close();await server?.close();await rm(temp,{recursive:true,force:true})}
