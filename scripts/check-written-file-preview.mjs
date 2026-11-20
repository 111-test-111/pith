/**
 * Real Chromium regression check for changed-file hover previews.
 * Run: node scripts/check-written-file-preview.mjs
 * Uses an isolated Electron profile and synthetic edit/write patches; no SDK,
 * real sessions, model calls, or test framework. Requires a graphical session.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pi-diff-preview-'))
const fixturePath = '/__diff_preview_check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TurnWrittenFiles} from '/src/components/app/TurnWrittenFiles.tsx';
import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {ReviewPane} from '/src/components/app/ReviewPane.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {synthesizeWritePatch} from '/src/lib/diff.ts';
import {setDiffStyle} from '/src/lib/diff-style.ts';
import {setUiStyle} from '/src/lib/ui-style.ts';
import {Markdown} from '/src/lib/markdown.tsx';
import {setCodeThemes} from '/src/lib/code-theme-settings.ts';
import {prefetchAgentCodeTokens} from '/src/components/agents/agent-code.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const sizes = [8, 3000, 220, 7000, 3, 380, 10000, 20];
const files = sizes.map((size,i)=>({filePath:'/fixture/file-'+i+'.ts', displayPath:'src/file-'+i+'.ts', added:size,
 patch:synthesizeWritePatch('file-'+i+'.ts', Array.from({length:size},(_,n)=>
  n===size-1 && i===6 ? '\\t'.repeat(5)+'中文'.repeat(100)+'END_OF_WIDE_LINE' :
  'export const file'+i+'Line'+(n+1)+' = { value: '+n+', title: "line-'+n+'" };').join('\\n'))}));
files[4] = {filePath:'/fixture/edit.ts',displayPath:'src/edit.ts',added:1,removed:1,
 patch:'--- a/edit.ts\\n+++ b/edit.ts\\n@@ -1,2 +1,2 @@ setup\\n-const retryDelay = 1000;\\n+const retryDelay = 2000;\\n unchanged'};
const coldCode = 'export const snapshot = "ready";';
files.push({filePath:'/fixture/cold.ts',displayPath:'src/cold.ts',added:1,patch:synthesizeWritePatch('cold.ts',coldCode)});
files.push({filePath:'/fixture/empty.ts',displayPath:'src/empty.ts'});
files.push({filePath:'/fixture/empty-patch.ts',displayPath:'src/empty-patch.ts',patch:'--- a/empty-patch.ts\\n+++ b/empty-patch.ts\\n@@ -0,0 +0,0 @@\\n'});
files.push({filePath:'/fixture/blank-patch.ts',displayPath:'src/blank-patch.ts',patch:'  \\n'});
window.warmCold = () => prefetchAgentCodeTokens(coldCode,'typescript');
// Every row is wrapped in the rail's navigation provider, so a click's hand-off
// is observable without mounting the pane itself.
window.railOpens = [];
window.fileActions = [];
const railed = (items) => React.createElement(FileNavigationProvider,
 {cwd:'/fixture',openFile:(target,view)=>window.railOpens.push({path:target.path,view})},
 React.createElement(TurnWrittenFiles,{files:items,onReview:()=>window.fileActions.push('review'),onUndo:()=>window.fileActions.push('undo')}));
window.checkRoot = createRoot(document.getElementById('root'));
const render = (items) => window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement('div',
 {id:'fixture',style:{width:760,margin:'400px auto 0'}},railed(items),
 React.createElement('div',{style:{marginTop:20}},railed(items.slice(0,2))))));
render(files);
window.refreshFixture=()=>render(files.map(file=>({...file})));
window.resetCheckRoot=()=>{window.checkRoot=createRoot(document.getElementById('root'))};
// Exercise the actual transcript and review consumers, including their wrappers.
window.setDiffStyle=setDiffStyle;
window.setUiStyle=setUiStyle;
window.renderFencedDiff=()=>{
 const fence=String.fromCharCode(96).repeat(3);
 window.fencedPatch=files[4].patch+'\\n--- /dev/null\\n+++ b/second.ts\\n@@ -0,0 +1 @@\\n+const added = true;';
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPatch=text}}});
 window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement('div',{style:{width:580}},
  React.createElement(Markdown,null,fence+'diff\\n'+window.fencedPatch+'\\n'+fence))));
};
const surfaceCounts = [1, 6, 8, 40];
const wideText = 'unbroken'.repeat(80);
const multiPatch=files[4].patch+'\\n@@ -30,2 +30,2 @@ request\\n-/* Requests are enabled by default. */\\n+/* Requests are disabled by default. */\\n const payload = "'+wideText+'";';
const calls = surfaceCounts.map((count,index)=>({type:'toolCall',id:'surface-'+index,
 name:index===1?'edit':'write',arguments:{path:'surface-'+index+'.ts',
 content:Array.from({length:count},(_,line)=>line===0?'const line0 = "'+wideText+'";':'const line'+line+' = '+line+';').join('\\n')}}));
const results = calls.map((call,index)=>({role:'toolResult',toolCallId:call.id,toolName:call.name,
 content:[],isError:false,timestamp:index+2,...(call.name==='edit'?{details:{patch:multiPatch}}:{})}));
const reviewState = {cwd:'/fixture',messages:[{role:'assistant',timestamp:1,content:calls},...results]};
const reviewStore = {subscribe:()=>()=>{},getState:()=>reviewState};
function ReviewFixture() {
  const [wrapLines,onWrapLinesChange] = React.useState(true);
  return React.createElement(ReviewPane,{store:reviewStore,focusTurnId:1,wrapLines,onWrapLinesChange});
}
const largeContent = Array.from({length:10000},(_,line)=>'export const largeLine'+line+' = '+line+';').join('\\n');
const largePatch = synthesizeWritePatch('large-edit.ts',largeContent);
const largeCalls = [
 {type:'toolCall',id:'large-write',name:'write',arguments:{path:'large-write.ts',content:largeContent}},
 {type:'toolCall',id:'large-edit',name:'edit',arguments:{path:'large-edit.ts'}}
];
const largeResults = [
 {role:'toolResult',toolCallId:'large-write',toolName:'write',content:[],isError:false,timestamp:20},
 {role:'toolResult',toolCallId:'large-edit',toolName:'edit',content:[],isError:false,timestamp:21,details:{patch:largePatch}}
];
window.renderDiffSurfaces = () => {
 setCodeThemes({light:'ayu-light',dark:'ayu-dark'});
 window.checkRoot.render(React.createElement(I18nProvider,null,
 React.createElement('div',{style:{display:'flex',gap:24,padding:24}},
  React.createElement('div',{id:'transcript-diffs',style:{width:540}},...calls.map((call,index)=>
   React.createElement('div',{key:call.id,'data-line-count':surfaceCounts[index]},
    React.createElement(ToolCallView,{call,result:results[index],cwd:'/fixture'})))),
  React.createElement('div',{id:'large-tool-diffs',style:{width:540}},...largeCalls.map((call,index)=>
   React.createElement('div',{key:call.id,'data-large-tool':call.name},
    React.createElement(ToolCallView,{call,result:largeResults[index],cwd:'/fixture'})))),
  React.createElement('div',{id:'review-diffs',style:{width:540,height:850}},
   React.createElement(FileNavigationProvider,{cwd:'/fixture',openFile:(target,view)=>window.railOpens.push({path:target.path,view})},
    React.createElement(ReviewFixture))))));
};
window.fixtureReady=true;
</script></body></html>`
let child, ws, server
const pause = ms => new Promise(r => setTimeout(r, ms))
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'diff-preview-fixture', configureServer(server) {
        server.middlewares.use(async (req,res,next) => {
          if (req.url !== fixturePath) return next()
          try {
            res.setHeader('Content-Type','text/html')
            res.end(await server.transformIndexHtml(fixturePath, fixture))
          } catch (error) { next(error) }
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:1000,title:'Diff preview regression',webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});
app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron,[main],{stdio:['ignore','ignore','pipe']})
  const endpoint = await new Promise((resolve,reject) => {
    let output = ''
    const timer = setTimeout(()=>reject(new Error('Electron debugger did not start: '+output)),15000)
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Electron exited: '+code))})
    child.stderr.on('data',chunk=>{
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]) }
    })
  })
  let page
  for (let attempt=0;attempt<100&&!page;attempt++) {
    page=(await (await fetch(endpoint+'/json/list')).json()).find(p=>p.type==='page')
    if (!page) await pause(50)
  }
  assert.ok(page,'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r=>ws.addEventListener('open',r,{once:true}))
  const pending = new Map()
  let sequence=0
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data)
    if (message.id) {pending.get(message.id)?.(message);pending.delete(message.id)}
  })
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence
    pending.set(id,m=>m.error?reject(m.error):resolve(m.result))
    ws.send(JSON.stringify({id,method,params}))
  })
  const evaluate=async expression=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const countsFollowPaths = selector => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), counts=>{
    const label=document.createRange();
    label.selectNodeContents(counts.previousElementSibling);
    const gap=counts.getBoundingClientRect().left-label.getBoundingClientRect().right;
    return gap>=0 && gap<=10;
  })`)
  // Native pointer movement must not interrupt the CDP hover sequence while
  // the user works. The hidden window still renders and receives CDP input.
  await send('Emulation.setFocusEmulationEnabled',{enabled:true})
  const move=(x,y)=>send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
  const click=async(x,y)=>{
    await move(x,y)
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1})
  }
  const key=async(key,code=key,windowsVirtualKeyCode=27)=>{
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r'}:{})})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode})
  }
  const panels=()=>evaluate(`document.querySelectorAll('[data-morph-popover-portal]').length`)
  const assertClosed=async(label)=>{
    assert.ok(await evaluate(`[...document.querySelectorAll('[data-morph-popover-portal]')].every(p=>p.inert&&getComputedStyle(p).pointerEvents==='none')`),label+': exit releases input immediately')
    for(let i=0;i<40&&await panels();i++)await pause(25)
    assert.equal(await panels(),0,label+': the visual exit finishes')
  }
  const rows=()=>evaluate(`[...document.querySelector('ul[data-plain-list]').querySelectorAll('li[data-written-file]')].map(e=>{
    const r=e.getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2,cx:r.left+r.width/2}
  })`)
  for(let i=0;i<200;i++) {
    if (await evaluate(`!!window.fixtureReady && !!document.querySelector('[data-written-files-header]')`)) break
    await pause(50)
  }
  assert.equal((await rows()).length,3,'settled changes show the first three files immediately')
  assert.deepEqual(await countsFollowPaths('ul[data-plain-list] [data-written-file] button > span:last-child'),[true,true,true,true,true],'each written-file count follows its path')
  assert.match(await evaluate(`document.querySelector('[data-written-files-header]').textContent`), /\+20630/, 'historical change totals are final on the first render')
  await evaluate(`document.querySelector('[data-written-files-header]').click()`)
  assert.equal((await rows()).length,3,'the header itself does not expand the list')
  await evaluate(`document.querySelector('[data-written-files-action="review"]').click();document.querySelector('[data-written-files-action="undo"]').click()`)
  assert.deepEqual(await evaluate('window.fileActions'),['review','undo'],'review and undo retain their actions')
  await evaluate(`document.querySelector('[data-written-files-more]').focus()`)
  await key('Enter','Enter',13)
  await pause(80)
  assert.equal((await rows()).length,12,'the show-more button expands with the keyboard')
  await key('Enter','Enter',13)
  await pause(80)
  let positions = await rows()
  assert.equal(positions.length,3,'the show-less button restores the first three files')
  await move(50,50);await pause(80)
  await evaluate(`(()=>{window.firstOpenFrames=[];window.sampleFirstOpen=true;
    function sample(){if(!window.sampleFirstOpen)return;const row=document.querySelector('ul[data-plain-list] button[aria-expanded="true"]');
      if(row){const p=document.querySelector('[data-morph-popover-portal]');const v=p?.querySelector('[data-slot="file-diff-viewport"]');
        window.firstOpenFrames.push({portal:!!p,visible:!!p&&getComputedStyle(p).visibility==='visible',viewport:!!v,rows:v?.querySelectorAll('.grid').length??0})}
      requestAnimationFrame(sample)}requestAnimationFrame(sample)})()`)
  await move(positions[0].x,positions[0].y)
  for(let attempt=0;attempt<100 && await panels()!==1;attempt++) await pause(30)
  assert.equal(await panels(),1,'hover opens one preview')
  await pause(50)
  const firstOpenFrames=await evaluate('window.sampleFirstOpen=false;window.firstOpenFrames')
  assert.ok(firstOpenFrames.length>0,'first-open frame sampler observed the active row')
  assert.ok(firstOpenFrames.every(frame=>frame.portal&&frame.visible&&frame.viewport&&frame.rows>0),
    'the first expanded-row frame already contains a visible populated preview')
  const hoverWrap = '[data-written-diff-toolbar] button[aria-label="Wrap lines"]'
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(hoverWrap)}).getAttribute('aria-pressed')`),'true','written-file previews default to wrapping')
  await evaluate(`document.querySelector(${JSON.stringify(hoverWrap)}).click()`)

  for (const {theme, top} of [{theme:'light',top:400},{theme:'dark',top:400},{theme:'light',top:40}]) {
    await key('Escape');await move(50,50)
    await evaluate(`document.getElementById('fixture').style.marginTop='${top}px'`)
    positions=await rows()
    await move(positions[0].x,positions[0].y);await pause(700)
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'})`)
    if (process.env.PI_DIFF_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_DIFF_SCREENSHOT_DIR,{recursive:true})
      const capture=await send('Page.captureScreenshot')
      await writeFile(join(process.env.PI_DIFF_SCREENSHOT_DIR,`${theme}-${top}-short.png`),Buffer.from(capture.data,'base64'))
    }
    await evaluate(`(()=>{const token=window.sampleToken=(window.sampleToken??0)+1;window.originalPortal=document.querySelector('[data-morph-popover-portal]');
      window.samples=[];window.sampleFrames=true;window.lastFrame=performance.now();
      function sample(t){if(!window.sampleFrames||token!==window.sampleToken)return;
        const p=document.querySelector('[data-morph-popover-portal]'),r=p?.getBoundingClientRect();
        const viewport=p?.querySelector('[data-slot="file-diff-viewport"]');
        const row=document.querySelector('ul[data-plain-list] button[aria-expanded="true"]')?.getBoundingClientRect();
        window.samples.push({dt:t-window.lastFrame,visible:!!p&&getComputedStyle(p).visibility==='visible',
          expectedHeight:viewport?Math.min(viewport.scrollHeight,320)+p.querySelector('[data-written-diff-toolbar]').offsetHeight+2:undefined,
          same:p===window.originalPortal,height:r?.height,anchored:!!r&&!!row&&(Math.abs(r.bottom-row.top)<1||Math.abs(r.top-row.bottom)<1),
          rows:p?.querySelectorAll('[data-slot="file-diff-viewport"] .grid').length});
        window.lastFrame=t;requestAnimationFrame(sample)}requestAnimationFrame(sample)})()`)
    for(let n=0;n<40;n++) { const r=positions[n%positions.length]; await move(r.x,r.y); await pause(25) }
    const samples=await evaluate('window.sampleFrames=false;window.samples')
    assert.ok(samples.length>10,'frame sampler ran')
    assert.ok(samples.every(s=>s.visible&&s.same),'every frame retains the same visible portal')
    assert.ok(samples.every(s=>s.anchored),'content and row anchor change before the same paint')
    assert.ok(samples.every(s=>Math.abs(s.height-s.expectedHeight)<1),'each frame fits its diff content up to the height cap, without blank space')
    assert.ok(new Set(samples.map(s=>s.height)).size>1,'short and long diffs use different natural heights')
    assert.ok(samples.every(s=>s.rows<=40),'mounted diff DOM stays bounded')
    // Timing is diagnostic, not a flaky machine-speed assertion.
    console.log(`${theme}/${top===400?'above':'below'}: ${samples.length} frames, 0 blanks, max ${Math.max(...samples.map(s=>s.dt)).toFixed(1)}ms, <=40 mounted rows`)
  }

  await move(positions[1].x,positions[1].y)
  await pause(80)
  const rect=await evaluate(`(()=>{const r=document.querySelector('[data-morph-popover-portal]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+150}})()`)
  await move(rect.x,rect.y);await pause(240)
  assert.equal(await panels(),1,'entering the portalled panel keeps it open')
  const bottom=await evaluate(`(async()=>{const v=document.querySelector('[data-slot="file-diff-viewport"]');v.scrollTop=v.scrollHeight;
    await new Promise(r=>setTimeout(r,80));return {height:v.scrollHeight,text:v.textContent,rows:v.querySelectorAll('.grid').length}})()`)
  assert.equal(bottom.height,3001*20,'virtual rows include the hunk heading in the scroll range')
  assert.ok(bottom.text.includes('file1Line3000'),'last line is reachable')
  assert.ok(bottom.rows<=40,'scrolling does not expand the mounted window')
  // The hover preview owns no edge fade: its diff viewport cuts at the cap
  // rather than laying a shadow gradient over the code at either end.
  const fadeAtEnd=await evaluate(`(()=>{const v=document.querySelector('[data-slot="file-diff-viewport"]');const s=getComputedStyle(v);return {fade:v.dataset.fade,mask:s.maskImage==='none'?'':s.maskImage,overflow:v.scrollHeight-v.clientHeight,top:v.scrollTop}})()`)
  assert.ok(fadeAtEnd.overflow>0,'the preview body is taller than its cap')
  assert.equal(fadeAtEnd.fade,'none','the preview viewport carries no edge fade')
  assert.equal(fadeAtEnd.mask,'','and no mask ramp, scrolled to the end')
  const fadeAtTop=await evaluate(`(async()=>{const v=document.querySelector('[data-slot="file-diff-viewport"]');v.scrollTop=0;await new Promise(r=>setTimeout(r,80));return {fade:v.dataset.fade,mask:getComputedStyle(v).maskImage}})()`)
  assert.equal(fadeAtTop.fade,'none','scrolling back to the top does not reinstate a fade')
  assert.equal(fadeAtTop.mask,'none','and the mask stays off there too')
  await move(positions[1].cx,positions[1].y);await pause(240)
  assert.equal(await panels(),1,'returning from panel to row keeps it open')
  // The row's own activation is navigation: the hover preview closes and the
  // file's diff opens in the rail instead of being pinned as a popover.
  await evaluate('window.railOpens=[]')
  await click(positions[1].cx,positions[1].y)
  await assertClosed('clicking a row closes the hover preview')
  assert.deepEqual(await evaluate('window.railOpens'),[{path:'/fixture/file-1.ts',view:'diff'}],'the clicked row hands its own file to the rail on the diff view')
  assert.equal((await rows()).length,3,'activating a file row leaves the list at its default three files')
  // Hover keeps its own contract: leaving and returning reopens the preview.
  await move(50,50);await pause(80)
  await move(positions[1].x,positions[1].y);await pause(700)
  assert.equal(await panels(),1,'hover still opens the preview after a click navigated away')
  await key('Escape');await pause(80)
  await assertClosed('Escape dismissal')
  await key('Tab','Tab',9);await pause(80)
  assert.equal(await panels(),1,'keyboard focus opens the next file')
  await evaluate(`const v=document.querySelector('[data-slot="file-diff-viewport"]');v.tabIndex=0;v.focus()`)
  await key('Escape');await pause(80)
  await assertClosed('Escape from the diff restores focus without reopening')
  assert.ok(await evaluate(`document.activeElement.matches('ul[data-plain-list] button')`),'focus returns to the current row')

  // Leave the list first: the pointer is sitting on row 1 already, and a hover
  // only opens the preview on an actual enter.
  await move(50,50);await pause(80)
  await move(positions[1].x,positions[1].y);await pause(700)
  await evaluate(`window.beforeRefresh=document.querySelector('[data-morph-popover-portal]');window.refreshFixture()`)
  await pause(80)
  assert.ok(await evaluate(`window.beforeRefresh===document.querySelector('[data-morph-popover-portal]')`),'equivalent transcript updates retain the portal')
  assert.equal(await evaluate(`document.querySelector('ul[data-plain-list] button[aria-expanded="true"]').textContent.includes('file-1.ts')`),true,'updated rows retain the active state')
  await click(50,50);await pause(80)
  await assertClosed('Outside pointer dismissal')

  // Expand, reach a 10,000-line write, and verify offscreen tabs/CJK width.
  await evaluate(`document.querySelector('[data-written-files-more]').click()`)
  positions=await rows()
  assert.equal(positions.length,12)
  await move(positions[6].x,positions[6].y);await pause(700)
  const wide=await evaluate(`(async()=>{const v=document.querySelector('[data-slot="file-diff-viewport"]');
    const initialWidth=v.scrollWidth;v.scrollTop=v.scrollHeight;await new Promise(r=>setTimeout(r,80));
    return {initialWidth,width:v.scrollWidth,text:v.textContent,height:v.scrollHeight}})()`)
  assert.equal(wide.height,10001*20)
  assert.ok(wide.text.includes('END_OF_WIDE_LINE'))
  assert.equal(wide.initialWidth,wide.width,'widest unmounted line reserves horizontal extent')
  assert.ok(wide.width>2000,'CJK and tab columns have enough horizontal space')
  await move(positions[0].x,positions[0].y);await pause(80)
  assert.equal(await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').scrollTop`),0,'switching file resets scroll')
  await move(positions[4].x,positions[4].y);await pause(100)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-morph-popover-portal] [data-diff-inline]')].map(mark=>mark.textContent)`), ['1000','2000'], 'the hover preview highlights the actual replacement')
  const hoverToggle = '[data-morph-popover-portal] [data-diff-layout-toggle]'
  await evaluate(`window.hoverLayoutButton=document.querySelector('${hoverToggle}');hoverLayoutButton.click()`)
  await pause(100)
  assert.ok(await evaluate(`hoverLayoutButton===document.querySelector('${hoverToggle}') && hoverLayoutButton.getAttribute('aria-pressed')==='true' && document.querySelector('[data-diff-side="before"]').textContent.includes('1000') && document.querySelector('[data-diff-side="after"]').textContent.includes('2000')`), 'the hover preview swaps layouts without replacing its control')
  await evaluate('hoverLayoutButton.click()')

  // Keyboard-open before the idle prefetch: warming cannot repaint this visit.
  await key('Escape');await move(50,50)
  await evaluate(`document.querySelector('ul[data-plain-list]').querySelectorAll('button')[8].focus()`)
  await pause(40)
  const plain=await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').innerHTML`)
  assert.equal(await evaluate(`(()=>{const panel=document.querySelector('[data-morph-popover-portal]');return panel.offsetHeight-panel.querySelector('[data-written-diff-toolbar]').offsetHeight})()`),42,'the one-line preview fits the toolbar, heading and source row throughout entrance')
  await evaluate('window.warmCold()')
  assert.equal(await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').innerHTML`),plain,'late tokens do not repaint an open preview')
  await move(positions[9].x,positions[9].y);await pause(80)
  await assertClosed('moving from a real diff to an empty write closes the previous preview')
  assert.equal(await evaluate(`document.querySelector('ul[data-plain-list]').querySelectorAll('button')[9].hasAttribute('aria-expanded')`),false,'an empty write advertises no preview')
  for (const index of [9,10,11]) {
    await move(50,50);await move(positions[index].x,positions[index].y);await pause(700)
    assert.equal(await panels(),0,'hovering a missing, header-only or blank patch opens no panel')
    await evaluate('window.railOpens=[]')
    await click(positions[index].cx,positions[index].y);await pause(80)
    assert.equal(await panels(),0,'clicking an empty diff opens no panel')
    assert.deepEqual(await evaluate('window.railOpens'),[{path:'/fixture/'+['empty.ts','empty-patch.ts','blank-patch.ts'][index-9],view:'diff'}],'a row without a preview still opens its file in the rail')
    await key('Tab','Tab',9)
    await evaluate(`document.querySelector('ul[data-plain-list]').querySelectorAll('button')[${index}].focus()`)
    await pause(80)
    await assertClosed('keyboard focus on an empty diff opens no panel')
  }

  await evaluate(`document.querySelectorAll('ul[data-plain-list]')[1].querySelector('button').focus()`)
  await pause(80)
  const owners=await evaluate(`[...document.querySelectorAll('[data-morph-popover-portal]')].map(p=>({inert:p.inert,pointer:getComputedStyle(p).pointerEvents}))`)
  assert.equal(owners.filter(p=>!p.inert&&p.pointer==='auto').length,1,'moving to another turn retains only one interactive preview owner')
  assert.ok(owners.filter(p=>p.inert).every(p=>p.pointer==='none'),'the previous owner releases input throughout its visual exit')
  for(let i=0;i<40&&(await panels())>1;i++)await pause(25)
  assert.equal(await panels(),1,'the previous owner finishes its visual exit')
  await evaluate('window.checkRoot.unmount()');await pause(80)
  assert.equal(await panels(),0,'unmounting the transcript releases the preview')
  await evaluate('window.resetCheckRoot();window.renderDiffSurfaces()')
  await pause(120)
  const toolDiffButtons = '#transcript-diffs [data-diff-layout-toggle], #transcript-diffs button[aria-label="Wrap lines"]'
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(toolDiffButtons)}).length`),0,'collapsed tool rows have no layout or wrap controls')
  assert.deepEqual(await countsFollowPaths('#transcript-diffs [data-diff-counts]'),[true,true,true,true],'collapsed tool row counts follow the left-hand paths')
  assert.deepEqual(await countsFollowPaths('#review-diffs [data-review-stats]'),[true,true,true,true],'Review file counts follow the paths')
  const reviewButton = '#review-diffs button[aria-label="Wrap lines"]'
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(reviewButton)}).getAttribute('aria-pressed')`),'true','Review defaults to wrapping')
  await evaluate(`document.querySelector(${JSON.stringify(reviewButton)}).click()`)
  await evaluate('window.railOpens=[]')
  await evaluate(`document.querySelector('#review-diffs [data-review-file-header] button[aria-label="Open surface-0.ts"]').click()`)
  assert.deepEqual(await evaluate(`window.railOpens.map(item=>item.path)`),['/fixture/surface-0.ts'],'the review open action opens the file in the rail preview instead of the system app')
  const largeOpenMs=await evaluate(`(async()=>{const start=performance.now();document.querySelectorAll('#transcript-diffs button[aria-expanded="false"],#large-tool-diffs button[aria-expanded="false"]').forEach(button=>button.click());
    for(let frame=0;frame<120;frame++){await new Promise(requestAnimationFrame);const bodies=[...document.querySelectorAll('#large-tool-diffs [data-large-tool]')];
      if(bodies.length===2&&bodies.every(host=>host.querySelector('[data-slot="file-diff-viewport"] .grid')))return performance.now()-start}return null})()`)
  assert.equal(typeof largeOpenMs,'number','large tool diffs reach a populated paint')
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(toolDiffButtons)}).length`),8,'both controls appear on every expanded tool row')
  const largeTools=await evaluate(`[...document.querySelectorAll('#large-tool-diffs [data-large-tool]')].map(host=>{
    const v=host.querySelector('[data-slot="file-diff-viewport"]');
    return {tool:host.dataset.largeTool,rows:v.querySelectorAll('.grid').length,scrollHeight:v.scrollHeight,overflows:v.scrollWidth>v.clientWidth+1,
      wrap:host.querySelector('button[aria-label="Wrap lines"]').getAttribute('aria-pressed'),heading:!!v.querySelector('[data-diff-hunk]'),
      tokenSpans:v.querySelectorAll('[style*="--agent-code-light"]').length,footer:!!host.querySelector('[data-diff-body] > *:not([data-slot="file-diff-viewport"])'),live:v.getAttribute('aria-live')};
  })`)
  assert.deepEqual(largeTools.map(item=>item.tool),['write','edit'],'both large file tools render a diff')
  assert.ok(largeTools.every(item=>item.rows>0&&item.rows<=40),'large tool diffs mount only the visible row window')
  assert.ok(largeTools.every(item=>item.wrap==='true' && !item.overflows && item.scrollHeight>=200020 && item.heading),'large diffs start wrapped with the complete scroll range and hunk heading')
  assert.ok(largeTools.every(item=>item.tokenSpans===0),'large tool diffs skip whole-patch Shiki tokenization')
  assert.ok(largeTools.every(item=>!item.footer),'a transcript diff card is only its viewport — no footer bar under it')
  assert.ok(largeTools.every(item=>item.live===null),'settled virtual windows are not announced again on every scroll')
  const largeViewports = '[data-large-tool] [data-slot="file-diff-viewport"]'
  await evaluate(`document.querySelectorAll(${JSON.stringify(largeViewports)}).forEach(v=>v.scrollTop=v.scrollHeight)`)
  await pause(80)
  assert.ok(await evaluate(`[...document.querySelectorAll(${JSON.stringify(largeViewports)})].every(v=>v.textContent.includes('largeLine9999'))`),'the last source line is reachable while wrapped')
  await evaluate(`document.querySelectorAll('#large-tool-diffs button[aria-label="Wrap lines"]').forEach(button=>button.click())`)
  await pause(80)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(largeViewports)})].map(v=>v.scrollHeight)`),[200020,200020],'unwrapping restores the 10,000 lines and hunk heading to their original height')
  const transcriptWrap = '#transcript-diffs button[aria-label="Wrap lines"]'
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(transcriptWrap)}), button=>button.getAttribute('aria-pressed'))`), ['true','true','true','true'], 'every transcript diff starts wrapped')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('#transcript-diffs [data-slot="file-diff-viewport"]')).every(v=>v.scrollWidth<=v.clientWidth+1)`),'the default wraps long tool diff lines')
  await evaluate(`document.querySelectorAll(${JSON.stringify(transcriptWrap)}).forEach(button=>button.click())`)
  await pause(100)
  const surfaceHeights=await evaluate(`['transcript-diffs','review-diffs'].map(id=>[...document.querySelectorAll('#'+id+' [data-slot="file-diff-viewport"]')].map(v=>({height:v.getBoundingClientRect().height,scrollHeight:v.scrollHeight})))`)
  // Rounded: `getBoundingClientRect` reports fractional device pixels, and a cap
  // that lands on a sub-pixel boundary reads as 219.99997 rather than 220.
  assert.deepEqual(surfaceHeights[0].map(v=>Math.round(v.height)),[40,160,180,220],'headings follow the transcript row geometry and height cap')
  assert.deepEqual(surfaceHeights[1].map(v=>Math.round(v.height)),[40,160,180,820],'review bodies use full content height with no minimum or cap')
  assert.deepEqual(surfaceHeights.map(items=>items.map(v=>v.scrollHeight)),[[40,160,180,820],[40,160,180,820]],'both views include the hunk heading rows in the scroll height')
  const detailRows = `['transcript-diffs','review-diffs'].map(id=>{
    const edit=document.querySelectorAll('#'+id+' [data-slot="file-diff-viewport"]')[1];
    return {headings:Array.from(edit.querySelectorAll('[data-diff-hunk]'),node=>node.textContent),
      marks:Array.from(edit.querySelectorAll('[data-diff-inline]'),mark=>[mark.closest('[data-diff-change]').dataset.diffChange,mark.textContent])};
  })`
  const detailed = { headings: ['@@ -1,2 +1,2 @@ setup','@@ -30,2 +30,2 @@ request'], marks: [['removed','1000'],['added','2000'],['removed','enabled'],['added','disabled']] }
  assert.deepEqual(await evaluate(detailRows), [detailed,detailed], 'both surfaces preserve hunk boundaries and mark only changed words')
  const commentTokens = `Array.from(document.querySelectorAll('#review-diffs [data-diff-inline] [data-agent-code-token]')).filter(token=>['enabled','disabled'].includes(token.textContent))`
  for (let attempt = 0; attempt < 80 && (await evaluate(`${commentTokens}.length`)) < 2; attempt++) await pause(25)
  for (const dark of [false,true]) {
    await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
    const colors = await evaluate(`Array.from(document.querySelectorAll('#review-diffs [data-diff-inline]'), mark=>({
      mark:getComputedStyle(mark).backgroundColor, row:getComputedStyle(mark.closest('[data-diff-change]')).backgroundColor
    }))`)
    assert.ok(colors.length === 4 && colors.every(({mark,row})=>mark!==row && mark!=='rgba(0, 0, 0, 0)'), 'inline highlights have a distinct background in both themes')
    assert.notEqual(colors[0].mark, colors[1].mark, 'deletions and additions have different marks')
    const commentContrast = await evaluate(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const paint = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); };
      const luminance = () => Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).reduce((sum, byte, channel) => {
        const value = byte / 255;
        const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][channel];
      }, 0);
      return ${commentTokens}.map(token => {
        const layers = [];
        for (let node = token; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor);
        paint('#fff');
        layers.forEach(paint);
        const background = luminance();
        paint(getComputedStyle(token).color);
        const ink = luminance();
        return (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05);
      });
    })()`)
    assert.ok(commentContrast.length === 2 && commentContrast.every(ratio=>ratio >= 4.5), `muted comments are readable on both ${dark?'dark':'light'} marks: ${commentContrast}`)
    if (process.env.PI_DIFF_SCREENSHOT_DIR) {
      const capture = await send('Page.captureScreenshot')
      await writeFile(join(process.env.PI_DIFF_SCREENSHOT_DIR,`detailed-${dark?'dark':'light'}.png`),Buffer.from(capture.data,'base64'))
    }
  }
  await evaluate(`document.documentElement.classList.remove('dark'); window.setDiffStyle('simple')`)
  await pause(80)
  const simple = { headings: [], marks: [] }
  assert.deepEqual(await evaluate(detailRows),[simple,simple],'simple mode restores continuous rows in both views')
  assert.equal(await evaluate(`document.querySelector('#review-diffs [data-slot="file-diff-viewport"]').scrollHeight`),20,'a simple one-line diff uses its original height')
  await evaluate(`window.setDiffStyle('detailed')`)
  await pause(80)
  assert.deepEqual(await evaluate(detailRows),[detailed,detailed],'toggling detail restores the same sections and spans')
  // Only the body whose cap actually hides a line carries the ramp; an uncapped
  // review body (`maxHeightOverride={null}`) never masks.
  const surfaceFades=await evaluate(`['transcript-diffs','review-diffs'].map(id=>[...document.querySelectorAll('#'+id+' [data-slot="file-diff-viewport"]')].map(v=>v.dataset.fade))`)
  assert.deepEqual(surfaceFades[0],['none','none','none','bottom'],'only the capped transcript body masks, and only its bottom edge')
  assert.deepEqual(surfaceFades[1],['none','none','none','none'],'an uncapped review body never masks')
  const reviewBodies = '#review-diffs [data-slot="file-diff-viewport"]'
  const fileToggles = '#review-diffs [data-review-file-header] button[aria-expanded]'
  const readReview = () => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(reviewBodies)}), v => ({
    height: v.scrollHeight, overflows: v.scrollWidth > v.clientWidth + 1
  }))`)
  const toggleReviewWrap = async () => {
    await evaluate(`document.querySelector(${JSON.stringify(reviewButton)}).click()`)
    await pause(120)
  }
  const beforeWrap = await readReview()
  assert.ok(beforeWrap.every(v => v.overflows), 'each review file starts with a wide line')
  await evaluate(`window.reviewBody = document.querySelector(${JSON.stringify(reviewBodies)}); document.querySelectorAll(${JSON.stringify(fileToggles)})[1].click()`)
  await pause(120)
  await toggleReviewWrap()
  const wrapped = await readReview()
  assert.equal(wrapped.length, 3, 'wrap keeps the disclosure state')
  assert.ok(wrapped.every((v, i) => !v.overflows && v.height > beforeWrap[[0, 2, 3][i]].height), 'one toggle wraps every open file')
  assert.ok(await evaluate('reviewBody.isConnected'), 'wrapping does not remount open files')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(reviewButton)}).getAttribute('aria-pressed')`), 'true')
  await evaluate(`document.querySelectorAll(${JSON.stringify(fileToggles)})[1].click()`)
  await pause(120)
  const reopened = await readReview()
  assert.equal(reopened.length, 4)
  assert.ok(!reopened[1].overflows && reopened[1].height > beforeWrap[1].height, 'a reopened file inherits the pane wrap state')
  await toggleReviewWrap()
  assert.deepEqual(await readReview(), beforeWrap, 'unwrapping restores horizontal scrolling in all files')

  assert.equal(await evaluate(`document.querySelectorAll('#review-diffs [data-diff-layout-toggle]').length`),1,'the Review toolbar owns the only layout button')
  await evaluate(`document.querySelector(${JSON.stringify(fileToggles)}).click();window.comparisonButtons=[document.querySelectorAll('#transcript-diffs [data-diff-layout-toggle]')[1],document.querySelector('#review-diffs [data-diff-layout-toggle]')];comparisonButtons.forEach(button=>button.click())`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelectorAll('#review-diffs [data-diff-layout="side-by-side"]').length`),3,'every open Review diff changes together')
  const comparison = await evaluate(`['transcript-diffs','review-diffs'].map(id=>{
    const view=[...document.getElementById(id).querySelectorAll('[data-diff-layout="side-by-side"]')].find(node=>node.querySelector('[data-diff-change="removed"]'));
    const before=view.querySelector('[data-diff-side="before"]'),after=view.querySelector('[data-diff-side="after"]');
    const left=before.querySelector('[data-diff-change="removed"]'),right=after.querySelector('[data-diff-change="added"]');
    return {aligned:Math.abs(left.getBoundingClientRect().top-right.getBoundingClientRect().top)<1,rightward:after.getBoundingClientRect().left>before.getBoundingClientRect().left,
      sharedContext:before.textContent.includes('unchanged')&&after.textContent.includes('unchanged'), marks:[...view.querySelectorAll('[data-diff-split] [data-diff-inline]')].map(mark=>mark.textContent)};
  })`)
  assert.ok(comparison.every(view=>view.aligned && view.rightward && view.sharedContext), 'split views align the sides and repeat their unchanged context')
  assert.deepEqual(comparison.map(view=>view.marks),[['1000','enabled','2000','disabled'],['1000','enabled','2000','disabled']],'split views preserve both hunks and their word highlights')
  await evaluate(`document.querySelector(${JSON.stringify(fileToggles)}).click()`);await pause(80)
  assert.equal(await evaluate(`document.querySelectorAll('#review-diffs [data-diff-layout="side-by-side"]').length`),4,'the reopened file inherits the Review layout')
  assert.ok(await evaluate(`Boolean(document.querySelector('#review-diffs [data-diff-side="before"] [data-diff-blank]'))`),'an insertion has a blank original cell')
  for (const style of ['square','rounded','squircle']) {
    await evaluate(`window.setUiStyle('${style}')`);await pause(50)
    const icon = `(()=>{const svg=comparisonButtons[0].querySelector('svg'),[first,second]=[...svg.querySelectorAll('rect')].slice(-2);return {split:first.getAttribute('y')===second.getAttribute('y'),rounded:svg.querySelector('rect[stroke]')!==null,colors:[getComputedStyle(first).fill,getComputedStyle(second).fill]}})()`
    const splitIcon = await evaluate(icon)
    assert.equal(splitIcon.split,true)
    assert.equal(splitIcon.rounded,style!=='square')
    assert.notEqual(splitIcon.colors[0],splitIcon.colors[1], 'the original and revised areas have different colors')
    await evaluate('comparisonButtons[0].click()');await pause(50)
    assert.equal((await evaluate(icon)).split,false,'the same button changes to the stacked glyph')
    await evaluate('comparisonButtons[0].click()');await pause(50)
  }
  assert.equal(await evaluate(`comparisonButtons.every(button=>button.isConnected&&button.getAttribute('aria-pressed')==='true')`),true, 'switching layouts retains one button per diff')
  const editTool = '#transcript-diffs [data-line-count="6"]'
  const toggleEditTool = async () => {
    await evaluate(`document.querySelector('${editTool} [data-agent-trigger]').click()`)
    await pause(80)
  }
  await toggleEditTool()
  assert.equal(await evaluate(`document.querySelectorAll('${editTool} :is([data-diff-layout-toggle],[aria-label="Wrap lines"])').length`),0,'collapsing the tool removes both controls')
  await toggleEditTool()
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${editTool} :is([data-diff-layout-toggle],[aria-label="Wrap lines"])'), button=>button.getAttribute('aria-pressed'))`),['true','false'],'reopening restores the selected layout and wrap')
  await evaluate('window.renderFencedDiff()');await pause(150)
  assert.ok(await evaluate(`document.querySelector('[data-code-block-pre]').textContent.includes('+++ b/edit.ts')`),'a fenced diff opens with its source intact')
  assert.equal(await evaluate(`document.querySelector('[data-markdown] [aria-label="Wrap lines"]').getAttribute('aria-pressed')`),'true','fenced diffs start wrapped')
  await evaluate(`document.querySelector('[data-markdown] [data-diff-layout-toggle]').click()`);await pause(120)
  assert.ok(await evaluate(`document.querySelector('[data-markdown] [data-diff-side="after"]').textContent.includes('2000')`),'fenced Markdown diffs offer a column view')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-markdown] [data-diff-file]'), file=>file.dataset.diffFile)`),['edit.ts','second.ts'],'adjacent bare file headers split the patch into file sections')
  await evaluate(`document.querySelector('[data-markdown] [aria-label="Copy code"]').click()`);await pause(50)
  assert.ok(await evaluate('window.copiedPatch===window.fencedPatch'),'copy still produces the original patch in the split view')
  await evaluate('window.checkRoot.unmount()')
  console.log('Transcript and review diffs preserve hunk headings, correctly color changed words and switch to the original simple layout.')
  console.log(`Large write/edit diffs populate on first paint in ${largeOpenMs.toFixed(1)}ms, keep a bounded DOM, and skip whole-patch highlighting.`)
  console.log('Passed first-paint hover, frame geometry, scroll, pin, keyboard, cold-token, cross-turn and cleanup checks.')
} finally {
  ws?.close()
  if (child && child.exitCode===null) {
    const exited=new Promise(r=>child.once('exit',r));child.kill();await exited
  }
  await server?.close()
  await rm(temporary,{recursive:true,force:true})
}
