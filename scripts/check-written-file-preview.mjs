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
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {ReviewPane} from '/src/components/app/ReviewPane.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {synthesizeWritePatch} from '/src/lib/diff.ts';
import {prefetchAgentCodeTokens} from '/src/components/agents/agent-code.tsx';
import '/src/styles.css';
const sizes = [8, 3000, 220, 7000, 3, 380, 10000, 20];
const files = sizes.map((size,i)=>({filePath:'/fixture/file-'+i+'.ts', displayPath:'src/file-'+i+'.ts', added:size,
 patch:synthesizeWritePatch('file-'+i+'.ts', Array.from({length:size},(_,n)=>
  n===size-1 && i===6 ? '\\t'.repeat(5)+'中文'.repeat(100)+'END_OF_WIDE_LINE' :
  'export const file'+i+'Line'+(n+1)+' = { value: '+n+', title: "line-'+n+'" };').join('\\n'))}));
files[4] = {filePath:'/fixture/edit.ts',displayPath:'src/edit.ts',added:1,removed:1,
 patch:'--- a/edit.ts\\n+++ b/edit.ts\\n@@ -1,2 +1,2 @@\\n-const previous = true;\\n+const updated = true;\\n unchanged'};
const coldCode = 'export const snapshot = "ready";';
files.push({filePath:'/fixture/cold.ts',displayPath:'src/cold.ts',added:1,patch:synthesizeWritePatch('cold.ts',coldCode)});
files.push({filePath:'/fixture/empty.ts',displayPath:'src/empty.ts'});
files.push({filePath:'/fixture/empty-patch.ts',displayPath:'src/empty-patch.ts',patch:'--- a/empty-patch.ts\\n+++ b/empty-patch.ts\\n@@ -0,0 +0,0 @@\\n'});
files.push({filePath:'/fixture/blank-patch.ts',displayPath:'src/blank-patch.ts',patch:'  \\n'});
window.warmCold = () => prefetchAgentCodeTokens(coldCode,'typescript');
window.checkRoot = createRoot(document.getElementById('root'));
const render = (items) => window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement('div',
 {id:'fixture',style:{width:760,margin:'400px auto 0'}},React.createElement(TurnWrittenFiles,{files:items}),
 React.createElement('div',{style:{marginTop:20}},React.createElement(TurnWrittenFiles,{files:items.slice(0,2)})))));
render(files);
window.refreshFixture=()=>render(files.map(file=>({...file})));
window.resetCheckRoot=()=>{window.checkRoot=createRoot(document.getElementById('root'))};
// Exercise the actual transcript and review consumers, including their wrappers.
const surfaceCounts = [1, 3, 8, 40];
const calls = surfaceCounts.map((count,index)=>({type:'toolCall',id:'surface-'+index,
 name:index===1?'edit':'write',arguments:{path:'surface-'+index+'.ts',
 content:Array.from({length:count},(_,line)=>'const line'+line+' = '+line+';').join('\\n')}}));
const results = calls.map((call,index)=>({role:'toolResult',toolCallId:call.id,toolName:call.name,
 content:[],isError:false,timestamp:index+2,...(call.name==='edit'?{details:{patch:files[4].patch}}:{})}));
const reviewState = {cwd:'/fixture',messages:[{role:'assistant',timestamp:1,content:calls},...results]};
const reviewStore = {subscribe:()=>()=>{},getState:()=>reviewState};
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
window.renderDiffSurfaces = () => window.checkRoot.render(React.createElement(I18nProvider,null,
 React.createElement('div',{style:{display:'flex',gap:24,padding:24}},
  React.createElement('div',{id:'transcript-diffs',style:{width:540}},...calls.map((call,index)=>
   React.createElement('div',{key:call.id,'data-line-count':surfaceCounts[index]},
    React.createElement(ToolCallView,{call,result:results[index],cwd:'/fixture'})))),
  React.createElement('div',{id:'large-tool-diffs',style:{width:540}},...largeCalls.map((call,index)=>
   React.createElement('div',{key:call.id,'data-large-tool':call.name},
    React.createElement(ToolCallView,{call,result:largeResults[index],cwd:'/fixture'})))),
  React.createElement('div',{id:'review-diffs',style:{width:540,height:850}},
   React.createElement(ReviewPane,{store:reviewStore,focusTurnId:1})))));
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
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode})
  }
  const panels=()=>evaluate(`document.querySelectorAll('[data-morph-popover-portal]').length`)
  const assertClosed=async(label)=>{
    assert.ok(await evaluate(`[...document.querySelectorAll('[data-morph-popover-portal]')].every(p=>p.inert&&getComputedStyle(p).pointerEvents==='none')`),label+': exit releases input immediately')
    for(let i=0;i<40&&await panels();i++)await pause(25)
    assert.equal(await panels(),0,label+': the visual exit finishes')
  }
  const rows=()=>evaluate(`[...document.querySelector('ul[data-plain-list]').querySelectorAll('li')].map(e=>{
    const r=e.getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2,cx:r.left+r.width/2}
  })`)
  for(let i=0;i<200;i++) {
    if (await evaluate(`!!window.fixtureReady && document.querySelectorAll('ul[data-plain-list] li').length > 0`)) break
    await pause(50)
  }
  let positions = await rows()
  assert.equal(positions.length,5,'large file lists start folded')
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
          expectedHeight:viewport?Math.min(viewport.scrollHeight,320)+2:undefined,
          same:p===window.originalPortal,height:r?.height,anchored:!!r&&!!row&&(Math.abs(r.bottom-row.top)<1||Math.abs(r.top-row.bottom)<1),
          rows:p?.querySelectorAll('[data-slot="file-diff-viewport"] .grid').length});
        window.lastFrame=t;requestAnimationFrame(sample)}requestAnimationFrame(sample)})()`)
    for(let n=0;n<40;n++) { const r=positions[n%5]; await move(r.x,r.y); await pause(25) }
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
  assert.equal(bottom.height,3000*20,'virtual rows retain the complete scroll range')
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
  await click(positions[1].cx,positions[1].y);await move(50,50);await pause(240)
  assert.equal(await panels(),1,'click pins the preview')
  await key('Escape');await pause(80)
  await assertClosed('Escape dismissal')
  await key('Tab','Tab',9);await pause(80)
  assert.equal(await panels(),1,'keyboard focus opens the next file')
  await evaluate(`const v=document.querySelector('[data-slot="file-diff-viewport"]');v.tabIndex=0;v.focus()`)
  await key('Escape');await pause(80)
  await assertClosed('Escape from the diff restores focus without reopening')
  assert.ok(await evaluate(`document.activeElement.matches('ul[data-plain-list] button')`),'focus returns to the current row')

  await move(positions[1].x,positions[1].y);await pause(700)
  await evaluate(`window.beforeRefresh=document.querySelector('[data-morph-popover-portal]');window.refreshFixture()`)
  await pause(80)
  assert.ok(await evaluate(`window.beforeRefresh===document.querySelector('[data-morph-popover-portal]')`),'equivalent transcript updates retain the portal')
  assert.equal(await evaluate(`document.querySelector('ul[data-plain-list] button[aria-expanded="true"]').textContent.includes('file-1.ts')`),true,'updated rows retain the active state')
  await click(50,50);await pause(80)
  await assertClosed('Outside pointer dismissal')

  // Expand, reach a 10,000-line write, and verify offscreen tabs/CJK width.
  await evaluate(`document.querySelector('#fixture button[aria-expanded]:not([aria-haspopup])').click()`)
  positions=await rows()
  assert.equal(positions.length,12)
  await move(positions[6].x,positions[6].y);await pause(700)
  const wide=await evaluate(`(async()=>{const v=document.querySelector('[data-slot="file-diff-viewport"]');
    const initialWidth=v.scrollWidth;v.scrollTop=v.scrollHeight;await new Promise(r=>setTimeout(r,80));
    return {initialWidth,width:v.scrollWidth,text:v.textContent,height:v.scrollHeight}})()`)
  assert.equal(wide.height,10000*20)
  assert.ok(wide.text.includes('END_OF_WIDE_LINE'))
  assert.equal(wide.initialWidth,wide.width,'widest unmounted line reserves horizontal extent')
  assert.ok(wide.width>2000,'CJK and tab columns have enough horizontal space')
  await move(positions[0].x,positions[0].y);await pause(80)
  assert.equal(await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').scrollTop`),0,'switching file resets scroll')

  // Keyboard-open before the idle prefetch: warming cannot repaint this visit.
  await key('Escape');await move(50,50)
  await evaluate(`document.querySelector('ul[data-plain-list]').querySelectorAll('button')[8].focus()`)
  await pause(40)
  const plain=await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').innerHTML`)
  assert.equal(await evaluate(`document.querySelector('[data-morph-popover-portal]').offsetHeight`),22,'one-line preview retains one 20px row plus its border throughout entrance')
  await evaluate('window.warmCold()')
  assert.equal(await evaluate(`document.querySelector('[data-slot="file-diff-viewport"]').innerHTML`),plain,'late tokens do not repaint an open preview')
  await move(positions[9].x,positions[9].y);await pause(80)
  await assertClosed('moving from a real diff to an empty write closes the previous preview')
  assert.equal(await evaluate(`document.querySelector('ul[data-plain-list]').querySelectorAll('button')[9].hasAttribute('aria-haspopup')`),false,'an empty write does not advertise a popup')
  for (const index of [9,10,11]) {
    await move(50,50);await move(positions[index].x,positions[index].y);await pause(700)
    assert.equal(await panels(),0,'hovering a missing, header-only or blank patch opens no panel')
    await click(positions[index].cx,positions[index].y);await pause(80)
    assert.equal(await panels(),0,'clicking an empty diff opens no panel')
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
  const largeOpenMs=await evaluate(`(async()=>{const start=performance.now();document.querySelectorAll('#transcript-diffs button[aria-expanded="false"],#large-tool-diffs button[aria-expanded="false"]').forEach(button=>button.click());
    for(let frame=0;frame<120;frame++){await new Promise(requestAnimationFrame);const bodies=[...document.querySelectorAll('#large-tool-diffs [data-large-tool]')];
      if(bodies.length===2&&bodies.every(host=>host.querySelector('[data-slot="file-diff-viewport"] .grid')))return performance.now()-start}return null})()`)
  assert.equal(typeof largeOpenMs,'number','large tool diffs reach a populated paint')
  const largeTools=await evaluate(`[...document.querySelectorAll('#large-tool-diffs [data-large-tool]')].map(host=>{const v=host.querySelector('[data-slot="file-diff-viewport"]');return {tool:host.dataset.largeTool,rows:v?.querySelectorAll('.grid').length,scrollHeight:v?.scrollHeight,tokenSpans:v?.querySelectorAll('[style*="--agent-code-light"]').length,footer:!!host.querySelector('[data-diff-body] > *:not([data-slot="file-diff-viewport"])'),live:v?.getAttribute('aria-live')}})`)
  assert.deepEqual(largeTools.map(item=>item.tool),['write','edit'],'both large file tools render a diff')
  assert.ok(largeTools.every(item=>item.rows>0&&item.rows<=40),'large tool diffs mount only the visible row window')
  assert.ok(largeTools.every(item=>item.scrollHeight===200000),'large tool diffs retain their complete 10,000-line scroll range')
  assert.ok(largeTools.every(item=>item.tokenSpans===0),'large tool diffs skip whole-patch Shiki tokenization')
  assert.ok(largeTools.every(item=>!item.footer),'a transcript diff card is only its viewport — no footer bar under it')
  assert.ok(largeTools.every(item=>item.live===null),'settled virtual windows are not announced again on every scroll')
  const surfaceHeights=await evaluate(`['transcript-diffs','review-diffs'].map(id=>[...document.querySelectorAll('#'+id+' [data-slot="file-diff-viewport"]')].map(v=>({height:v.getBoundingClientRect().height,scrollHeight:v.scrollHeight})))`)
  // Rounded: `getBoundingClientRect` reports fractional device pixels, and a cap
  // that lands on a sub-pixel boundary reads as 219.99997 rather than 220.
  assert.deepEqual(surfaceHeights[0].map(v=>Math.round(v.height)),[20,60,160,220],'transcript diffs shrink to content and cap only long bodies')
  assert.deepEqual(surfaceHeights[1].map(v=>Math.round(v.height)),[20,60,160,800],'review bodies use full content height with no minimum or cap')
  assert.deepEqual(surfaceHeights.map(items=>items.map(v=>v.scrollHeight)),[[20,60,160,800],[20,60,160,800]],'both views retain exactly the complete line height')
  // Only the body whose cap actually hides a line carries the ramp; an uncapped
  // review body (`maxHeightOverride={null}`) never masks.
  const surfaceFades=await evaluate(`['transcript-diffs','review-diffs'].map(id=>[...document.querySelectorAll('#'+id+' [data-slot="file-diff-viewport"]')].map(v=>v.dataset.fade))`)
  assert.deepEqual(surfaceFades[0],['none','none','none','bottom'],'only the capped transcript body masks, and only its bottom edge')
  assert.deepEqual(surfaceFades[1],['none','none','none','none'],'an uncapped review body never masks')
  await evaluate('window.checkRoot.unmount()')
  console.log('Transcript and review diffs fit 1-, 3-, 8- and 40-line content without reserved space.')
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
