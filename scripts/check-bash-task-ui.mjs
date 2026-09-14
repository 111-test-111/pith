/** Real beUI rows/settings in isolated Electron; no model calls or user data. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-bash-ui-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__bash-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {Composer} from '/src/components/app/Composer.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {extractReviewTurns} from '/src/lib/turn-written-files.ts';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {BashTasksProvider} from '/src/lib/bash-tasks.tsx';
import {SessionTasks} from '/src/components/app/SessionTasks.tsx';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {ToolGroupView} from '/src/components/app/ToolGroupView.tsx';
import {CustomItem} from '/src/components/app/MessageItems.tsx';
import {GeneralSection} from '/src/components/app/settings/GeneralSection.tsx';
import {TOOL_CATEGORIES} from '/src/lib/tool-categories.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
let listener;window.outputReads=0;window.stops=0;window.savedWait=10000;
window.task={id:'ui-task',sessionId:'ui-session',sessionPath:'/ui/session',toolCallId:'ui-call',command:'npm run build',cwd:'/ui',status:'running',background:true,reason:'wait_threshold',startedAt:Date.now()-1000,lastOutputAt:Date.now(),outputChars:11,logPath:'/ui/task.log',logTruncated:false,revision:1};
window.pi={onBashTask:fn=>{listener=fn;return()=>{listener=undefined}},listBashTasks:async path=>path==='/ui/session'?[window.task]:[],
 bashTaskOutput:async request=>{window.outputReads++;const output='build 中文😀';return{task:window.task,output:request.cursor===undefined?output:'',cursor:output.length,truncated:false}},
 stopBashTask:async()=>{window.stops++;window.task={...window.task,status:'cancelled',endedAt:Date.now(),revision:window.task.revision+1};listener?.(window.task);return window.task},
 openPath:async()=>'',appInfo:async()=>({version:'fixture',bashMaxWaitMs:window.savedWait}),setBashMaxWaitMs:async value=>window.savedWait=value,openExternal:async()=>{}};
const call={type:'toolCall',id:'ui-call',name:'bash',arguments:{command:'npm run build'}};
const result={role:'toolResult',toolCallId:'ui-call',toolName:'bash',content:[],details:{bashTask:window.task},isError:false,timestamp:1};
const second={type:'toolCall',id:'read-call',name:'bash',arguments:{command:'pwd'}};
const secondResult={role:'toolResult',toolCallId:'read-call',toolName:'bash',content:[{type:'text',text:'/ui'}],isError:false,timestamp:2};
function Fixture(){const [todos,setTodos]=React.useState(null),[busy,setBusy]=React.useState(false),[taskSession,setTaskSession]=React.useState("a");window.setTodos=setTodos;window.setBusy=setBusy;window.setTaskSession=setTaskSession;const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement('div',{style:{width:800,margin:'20px auto'}},
 React.createElement('div',{id:'tasks'},React.createElement(BashTasksProvider,{sessionPath:'/ui/session'},
 React.createElement(SessionTasks,{key:taskSession,todos,busy}),React.createElement('div',{id:'original'},React.createElement(ToolCallView,{call,result})),
 React.createElement('div',{id:'group'},React.createElement(ToolGroupView,{category:TOOL_CATEGORIES[1],calls:[call,second],toolResults:new Map([['ui-call',result],['read-call',secondResult]]),toolRuns:{}})),
 React.createElement('div',{id:'notice'},React.createElement(CustomItem,{message:{role:'custom',customType:'bash_task_completion',content:'INTERNAL_MODEL_INSTRUCTIONS',display:true,details:{bashTask:{...window.task,id:'completed-ui-task',toolCallId:'completed-call',status:'succeeded'}},timestamp:3}})))),
 React.createElement('div',{id:'settings',style:{marginTop:24}},React.createElement(GeneralSection)));}
window.checkRoot=createRoot(document.getElementById('root'));window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
window.finishTask=()=>{window.task={...window.task,status:'succeeded',exitCode:0,endedAt:Date.now(),revision:window.task.revision+1};listener?.(window.task)};window.runForever=()=>{window.task={...window.task,status:'running',endedAt:undefined,revision:window.task.revision+1};listener?.(window.task)};
window.startStartupFixture=()=>{
 window.turnStore=null;window.startupStore=new PiStore();window.startupSends=[];
 window.startupStore.applySnapshot({sessionId:'startup',sessionPath:'/ui/startup',cwd:'/ui',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false,initializing:true,eventSequence:0});
 function Startup(){const shell=React.useSyncExternalStore(window.startupStore.subscribe,window.startupStore.getShell);const {setLocale}=useI18n();window.setLocale=setLocale;
  return React.createElement(Composer,{start:{projectName:'fixture'},models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy:false,initializing:shell.initializing,
   queued:{steering:[],followUp:[]},onSend:p=>window.startupSends.push(p),onQueue:()=>{throw Error('unexpected queue')},onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}});}
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'startup'},React.createElement(ImagePreviewProvider,null,React.createElement('div',{id:'startup-fixture',style:{width:800,margin:'20px auto'}},React.createElement(Startup))))));
};
window.addTasks=(count)=>{for(let i=0;i<count;i++)listener?.({...window.task,id:'bulk-'+i,toolCallId:'bulk-call-'+i,command:'echo bulk task '+i,status:'succeeded',background:true,exitCode:0,endedAt:Date.now(),revision:1})};
window.startForegroundFixture=()=>{
 localStorage.setItem('pi-app:locale','en');
 const task={...window.task,id:'foreground-task',toolCallId:'foreground-call',background:false,status:'succeeded',exitCode:0,command:'printf foreground'};
 const call={type:'toolCall',id:task.toolCallId,name:'bash',arguments:{command:task.command}};
 const envelope={...task,output:'foreground stdout 中文',cursor:20,truncated:false};
 const result={role:'toolResult',toolName:'bash',toolCallId:call.id,timestamp:1,isError:false,details:{bashTask:task},content:[{type:'text',text:JSON.stringify(envelope)}]};
 const errorCall={...call,id:'foreground-error'};
 const errorResult={...result,toolCallId:errorCall.id,isError:true,details:undefined,content:[{type:'text',text:JSON.stringify({...envelope,id:'failed-task',toolCallId:errorCall.id,status:'failed',exitCode:7,output:'command failed'})}]};
 const timeoutCall={...call,id:'foreground-timeout'};
 const timeoutResult={...errorResult,toolCallId:timeoutCall.id,content:[{type:'text',text:JSON.stringify({...envelope,id:'timeout-task',toolCallId:timeoutCall.id,status:'timed_out',exitCode:null,output:'',truncated:true})}]};
 const plainCall={...call,id:'plain-json'};
 const plainResult={...result,toolCallId:plainCall.id,details:undefined,content:[{type:'text',text:'{"output":"keep this JSON","status":"ok"}'}]};
 const liveCall={...call,id:'foreground-live'};
 const liveTask={...task,id:'live-task',toolCallId:liveCall.id,status:'running',revision:1};
 const run={toolCallId:liveCall.id,toolName:'bash',args:liveCall.arguments,status:'running',startedAt:Date.now(),partial:{content:[{type:'text',text:'streaming stdout'}],details:{bashTask:liveTask}}};
 window.promoteForeground=()=>listener?.({...liveTask,background:true,reason:'wait_threshold',revision:2});
 const row=(id,props)=>React.createElement('div',{id},React.createElement(ToolCallView,props));
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'foreground-fixture'},React.createElement('div',{id:'foreground-fixture',style:{width:800,margin:'20px auto'}},
  React.createElement(BashTasksProvider,{sessionPath:'/ui/session'},
   row('foreground-success',{call,result}),row('foreground-error',{call:errorCall,result:errorResult}),
   row('foreground-timeout',{call:timeoutCall,result:timeoutResult}),row('foreground-json',{call:plainCall,result:plainResult}),
   row('foreground-live',{call:liveCall,run}))))));
};
window.startTurnFixture=()=>{
 localStorage.setItem('pi-app:locale','en');
 window.turnStore=new PiStore();window.turnSequence=0;window.frameFailures=[];window.frameCount=0;window.expectedCards=0;
 const user={role:'user',timestamp:10,content:'original request'};
 window.round=(timestamp,content,scope='scope-a')=>({role:'assistant',timestamp,content,changeScopeId:scope,stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop'});
 window.writeCall=(id,path)=>({type:'toolCall',name:'write',id,arguments:{path,content:'created\\n'}});
 window.result=(id)=>({role:'toolResult',toolCallId:id,toolName:'write',timestamp:21,content:[],isError:false});
 window.prose=value=>[{type:'text',text:value}];
 window.notice=(timestamp)=>({role:'custom',customType:'bash_task_completion',timestamp,display:true,content:'MODEL_ONLY_NOTICE',details:{bashTask:{...window.task,id:'notice-'+timestamp,status:'succeeded',background:true}}});
 window.initialTurnMessages=[user,window.round(20,[window.writeCall('write-a','a.ts')]),window.result('write-a')];
 window.turnSnapshot=(messages,isStreaming=true)=>({sessionId:'ui-session',sessionPath:'/ui/session',cwd:'/ui',projectless:false,messages,isStreaming,activeChangeScopeId:'scope-a',model:null,thinkingLevel:'off',eventSequence:++window.turnSequence});
 window.resetTurn=()=>{window.expectedCards=0;flushSync(()=>window.turnStore.applySnapshot(window.turnSnapshot(window.initialTurnMessages.map(m=>({...m})))))};
 window.resetTurn();
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'turn-fixture'},React.createElement(ImagePreviewProvider,null,
  React.createElement('div',{id:'turn-fixture',style:{height:900,display:'flex',flexDirection:'column'}},React.createElement(ChatView,{store:window.turnStore,onDismissError:()=>{},onResend:()=>{},onEditMessage:()=>{},onFork:()=>{},onReview:()=>{}}))))));
 window.turnStep=(event,count=0)=>{window.expectedCards=count;flushSync(()=>window.turnStore.dispatch({...event,sessionPath:'/ui/session',eventSequence:++window.turnSequence}));};
 window.turnRead=()=>({cards:document.querySelectorAll('#turn-fixture ul[data-plain-list]').length,
  paths:[...document.querySelectorAll('#turn-fixture ul[data-plain-list]')].map(list=>list.textContent),
  groups:document.querySelectorAll('[data-assistant-group]').length,
  notices:document.querySelectorAll('[data-turn-process] [data-bash-task-id]').length,
  reviews:extractReviewTurns(window.turnStore.getState().messages,'/ui').map(turn=>({id:turn.id,files:turn.files.map(f=>f.displayPath)}))});
 const frame=()=>{if(!window.turnStore)return;window.frameCount++;const state=window.turnRead();if(state.cards!==window.expectedCards)window.frameFailures.push({...state,expected:window.expectedCards});requestAnimationFrame(frame)};requestAnimationFrame(frame);
};
window.fixtureReady=true;
</script></body></html>`
let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:1100,title:'Bash task regression',webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  for (let i = 0; i < 200; i++) { if (await evaluate(`!!document.querySelector('#original [data-bash-task-id]')`)) break; await pause(50) }
  assert.equal(await evaluate(`document.querySelector('#original [data-bash-task-id]')?.dataset.bashTaskStatus`), 'running')
  assert.match(await evaluate(`document.querySelector('#original').innerText`), /Running in background/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#group').innerText`), /completed,.*failed/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#notice').innerText`), /INTERNAL_MODEL_INSTRUCTIONS/)
  assert.equal(await evaluate('window.outputReads'), 0, 'closed rows never read logs')
  // The expanded list is an overlay: opening it must move nothing in the page.
  const pageGeometry = `JSON.stringify(['#original','#group','#notice'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}))`
  const beforeExpand = await evaluate(pageGeometry)
  const rowHeight = await evaluate(`document.querySelector('#tasks').getBoundingClientRect().height`)
  await evaluate(`document.querySelector('[data-session-tasks] button[aria-expanded]').click()`)
  await pause(400)
  assert.equal(await evaluate(pageGeometry), beforeExpand, 'opening the task panel pushes no content down')
  assert.equal(await evaluate(`document.querySelector('#tasks').getBoundingClientRect().height`), rowHeight, 'the open panel adds no height to its container')
  const panel = await evaluate(`(()=>{const p=document.querySelector('[data-task-panel]'),r=p.getBoundingClientRect(),root=document.querySelector('[data-session-tasks]').getBoundingClientRect(),o=document.querySelector('#original').getBoundingClientRect();return {top:Math.round(r.top),rootBottom:Math.round(root.bottom),left:Math.round(r.left),rootLeft:Math.round(root.left),right:Math.round(r.right),rootRight:Math.round(root.right),overlapsTranscript:r.top<o.bottom&&r.bottom>o.top,shadow:getComputedStyle(p.parentElement).boxShadow!=='none'}})()`)
  assert.equal(panel.top, panel.rootBottom, 'the panel hangs from the summary row')
  assert.ok(panel.overlapsTranscript, 'the panel covers the transcript instead of displacing it: ' + JSON.stringify(panel))
  assert.ok(panel.shadow, 'the floating panel carries the overlay elevation')
  // The elevation must ride on an unclipped wrapper: AgentDisclosure's rest
  // clip-path squares a shadow drawn on the element it clips.
  assert.match(await evaluate(`getComputedStyle(document.querySelector('[data-task-panel]')).clipPath`), /^inset\(0px 0px 0%\)/, 'the disclosure still owns its reveal clip')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-task-panel]').parentElement).overflow`), 'visible', 'the shadowed wrapper clips nothing')
  const list = `(()=>{const l=document.querySelector('[data-bash-tasks-list]'),box=l.getBoundingClientRect(),pad=parseFloat(getComputedStyle(l).paddingTop),rows=[...l.children].map(r=>r.getBoundingClientRect());const cut=e=>rows.filter(r=>r.top<e-0.5&&r.bottom>e+0.5).length;const style=getComputedStyle(l);return {limit:Math.round(box.height),scrollHeight:l.scrollHeight,rows:rows.length,pitch:rows.length>1?Math.round(rows[1].top-rows[0].top):0,rowHeight:rows.length?Math.round(rows[0].height):0,pad,cutTop:cut(box.top+pad),cutBottom:cut(box.bottom-pad),overflow:style.overflowY,mask:style.maskImage==='none'?null:'mask'}})()`
  assert.equal((await evaluate(list)).cutBottom, 0, 'one task fits whole: ' + JSON.stringify(await evaluate(list)))
  // Whole rows at any count: the cap lands on a row boundary, never mid-row.
  await evaluate('window.addTasks(12)')
  await pause(200)
  assert.equal(await evaluate(pageGeometry), beforeExpand, 'a full-height panel still pushes no content down')
  const full = await evaluate(list)
  assert.equal(full.cutTop + full.cutBottom, 0, 'a settled list shows whole rows only: ' + JSON.stringify(full))
  assert.equal(full.limit % full.pitch, 0, 'the cap is a whole number of row pitches: ' + JSON.stringify(full))
  assert.equal(full.mask, null, 'whole rows are never masked')
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_BASH_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'tasks-panel-open.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  // A half row is faded (BeUI's capped-list mask), never chopped off, and the
  // fade clears as soon as the edge lands on a row boundary again.
  await evaluate(`document.querySelector('[data-bash-tasks-list]').scrollTop=20`)
  await pause(120)
  const half = await evaluate(list)
  assert.ok(half.cutTop + half.cutBottom > 0, 'the test scroll really cuts rows: ' + JSON.stringify(half))
  assert.equal(half.mask, 'mask', 'a cut row fades out instead of ending in a hard chop')
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'tasks-panel-scrolling.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  const probe = await evaluate(`(()=>{const p=document.querySelector('[data-task-panel]'),r=p.getBoundingClientRect(),o=document.querySelector('#original').getBoundingClientRect();const x=Math.round((r.left+r.right)/2),y=Math.round(Math.max(r.top+4,o.top+4));const hit=document.elementFromPoint(x,y);const chain=[];for(let e=hit;e&&chain.length<8;e=e.parentElement)chain.push(e.tagName+(e.id?'#'+e.id:'')+(e.getAttribute&&e.getAttribute('data-task-panel')!==null?'[panel]':''));const s=getComputedStyle(p);return {z:s.zIndex,position:s.position,opacity:s.opacity,bg:s.backgroundColor,inside:p.contains(hit),chain}})()`)
  assert.ok(probe.inside, 'the panel is painted above the transcript: ' + JSON.stringify(probe))
  await evaluate(`document.querySelector('[data-bash-tasks-list]').scrollTop=0`)
  await pause(120)
  const back = await evaluate(list)
  assert.equal(back.cutTop + back.cutBottom, 0, 'returning to a boundary restores whole rows: ' + JSON.stringify(back))
  assert.equal(back.mask, null, 'the fade clears with the cut')
  assert.equal(panel.left, panel.rootLeft + 16, 'the panel insets mirror the summary row padding')
  assert.equal(panel.right, panel.rootRight - 16, 'the panel insets mirror the summary row padding')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-session-tasks] button[aria-expanded]').getAttribute('aria-expanded')`), 'false', 'Escape dismisses the floating panel')
  await evaluate(`document.querySelector('[data-session-tasks] button[aria-expanded]').click()`)
  await pause(350)
  await evaluate(`document.querySelector('#original').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-session-tasks] button[aria-expanded]').getAttribute('aria-expanded')`), 'false', 'a press outside dismisses the floating panel')
  assert.equal(await evaluate(pageGeometry), beforeExpand, 'dismissing the panel restores the same layout')
  // Both options share one overlay and preserve transcript geometry on every frame.
  await evaluate(`window.setTodos({toolCallId:'todo-fixture',items:[
    {id:'a',content:'Review the current implementation',status:'completed'},
    {id:'b',content:'Integrate task tracking with background command completion',status:'in_progress',activeForm:'Verifying state transitions'},
    {id:'c',content:'Document the final behaviour',status:'pending'},
    {id:'d',content:'Discard the previous approach',status:'cancelled'}]})`)
  await pause(120)
  assert.equal(await evaluate(`document.querySelectorAll('[data-task-trigger]').length`),2)
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(350)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/1 of 4 completed.*1 cancelled/s)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/Paused/)
  assert.equal(await evaluate(pageGeometry),beforeExpand)
  await evaluate(`window.setTodos(previous=>{window.unfinishedTodoFixture=previous;window.finishedTodoItems=previous.items.map(item=>({...item,status:'completed'}));return{toolCallId:'finished',items:window.finishedTodoItems}});window.setBusy(false)`)
  await pause(350)
  assert.match(await evaluate(`document.querySelector('[data-task-trigger=todo]').innerText`),/4\/4/,'all-completed entry stays visible')
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]').getAttribute('aria-expanded')`),'true','completion does not close an open panel')
  await evaluate(`window.setTodos({toolCallId:'cleared-after-finish',items:[],retainedItems:window.finishedTodoItems})`)
  await pause(150)
  assert.equal(await evaluate(`document.querySelectorAll('[data-todo-status=completed]').length`),4)
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(200)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]').getAttribute('aria-expanded')`),'false')
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(250)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/4 of 4 completed/,'completed history can be reopened after clearing active work')
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/Paused|Working/)
  assert.equal(await evaluate(pageGeometry),beforeExpand)
  // Clearing before every item finishes must keep the same review entry and statuses.
  await evaluate(`window.setTodos({toolCallId:'cleared-before-finish',items:[],retainedItems:window.unfinishedTodoFixture.items});window.setBusy(true)`)
  await pause(350)
  assert.match(await evaluate(`document.querySelector('[data-task-trigger=todo]').innerText`),/1\/4/)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-todo-status]'),node=>node.dataset.todoStatus)`),['completed','in_progress','pending','cancelled'],'clearing never relabels unfinished or cancelled work as completed')
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/History · before clearing/)
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/Working|Verifying state transitions/,'another active run never animates retained task progress')
  const retainedTransform = await evaluate(`getComputedStyle(document.querySelector('[data-todo-id=b]').closest('li').querySelector('[data-todo-progress]')).transform`)
  await pause(250)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-todo-id=b]').closest('li').querySelector('[data-todo-progress]')).transform`),retainedTransform)
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(150)
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click();window.setLocale('zh-CN')`)
  await pause(200)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]').getAttribute('aria-expanded')`),'true','unfinished cleared history remains clickable')
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/历史记录 · 清空前/)
  assert.equal(await evaluate(pageGeometry),beforeExpand)
  if(process.env.PI_BASH_SCREENSHOT_DIR){
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR,'retained-todos.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
  }
  await evaluate(`window.setLocale('en');window.setBusy(false)`)
  await evaluate(`window.setTodos(window.unfinishedTodoFixture)`)
  await pause(150)
  await evaluate(`window.todoNode=document.querySelector('[data-todo-id=b]').closest('li');window.taskPanelNode=document.querySelector('[data-task-panel]');undefined`)
  await evaluate(`window.setTodos({toolCallId:'renamed',items:[{id:'b',content:'Verify task tracking',status:'in_progress'},{id:'a',content:'Review the current implementation',status:'completed'}]});window.setBusy(true)`)
  await pause(250)
  assert.equal(await evaluate(`window.todoNode===document.querySelector('[data-todo-id=b]').closest('li')`),true,'task rename/reorder keeps the native row')
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/Working/)
  const swapFrames = await evaluate(`new Promise(resolve=>{const baseline=${pageGeometry};const failures=[];let n=0;const frame=()=>{if(${pageGeometry}!==baseline)failures.push(n);if(++n<30)requestAnimationFrame(frame);else resolve(failures)};requestAnimationFrame(frame);document.querySelector('[data-task-trigger=bash]').click()})`)
  assert.deepEqual(swapFrames,[],'switching panels moves no transcript frame')
  assert.equal(await evaluate(`window.taskPanelNode===document.querySelector('[data-task-panel]')`),true,'switching reuses the overlay')
  assert.equal(await evaluate(`document.querySelectorAll('[data-task-panel][aria-hidden=false]').length`),1)
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click();window.setBusy(false)`)
  await pause(250)
  const stoppedTransform = await evaluate(`getComputedStyle(document.querySelector('[data-todo-id=b]').closest('li').querySelector('[data-todo-progress]')).transform`)
  await pause(250)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-todo-id=b]').closest('li').querySelector('[data-todo-progress]')).transform`),stoppedTransform,'idle task ring stops animating')
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/已暂停/)
  assert.match(await evaluate(`document.querySelector('[data-task-trigger=todo]').innerText`),/任务清单/)
  await evaluate(`window.escapeStopped=0;window.stopProbe=e=>{if(e.key==='Escape'&&!e.defaultPrevented)window.escapeStopped++};window.addEventListener('keydown',window.stopProbe);document.querySelector('[data-task-panel] button').focus()`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await pause(200)
  assert.equal(await evaluate('window.escapeStopped'),0,'Escape is claimed before stop-run')
  assert.equal(await evaluate(`document.activeElement.dataset.taskTrigger`),'todo','Escape returns focus to the selected entry')
  await evaluate(`window.removeEventListener('keydown',window.stopProbe)`)
  // Native Button keyboard activation and cleared/session-switched panel cleanup.
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await pause(250)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]').getAttribute('aria-expanded')`),'true')
  if(process.env.PI_BASH_SCREENSHOT_DIR){
    for(const theme of ['light','dark']){
      await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'})`)
      await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR,`unified-tasks-${theme}.png`),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
    }
  }
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await evaluate(`window.setBusy(true);window.setTodos({toolCallId:'long',items:Array.from({length:40},(_,i)=>({id:'long-'+i,content:i===0?'长任务说明'.repeat(24):'检查任务 '+i,status:i===0?'in_progress':'pending'}))});document.querySelector('#tasks').parentElement.style.width='340px'`)
  await pause(250)
  for(let i=0;i<40;i++){if(await evaluate(`document.querySelectorAll('[data-task-panel] [data-todo-id]').length===40`))break;await pause(50)}
  const narrow = await evaluate(`(()=>{const panel=document.querySelector('[data-task-panel]');const list=panel.querySelector('ol').parentElement;return{overflow:panel.scrollWidth>panel.clientWidth,height:list.clientHeight,scrollHeight:list.scrollHeight,scrollbar:getComputedStyle(list).scrollbarWidth,items:panel.querySelectorAll('[data-todo-id]').length}})()`)
  assert.equal(narrow.overflow,false,'long task titles fit narrow conversation panes')
  assert(narrow.height<=264&&narrow.scrollHeight>narrow.height)
  assert.equal(narrow.scrollbar,'none')
  assert.equal(narrow.items,40)
  // Wait for native row entry/exit layout before measuring a user scroll.
  await pause(600)
  await evaluate(`document.querySelector('[data-task-panel] ol').parentElement.scrollTo({top:0,behavior:'instant'})`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('[data-task-panel] ol').parentElement.scrollTop`),0,'long task lists remain scrollable')
  await evaluate(`document.querySelector('[data-task-trigger=bash]').click()`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('[data-task-panel]').getAttribute('aria-hidden')`),'false')
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click();document.querySelector('#tasks').parentElement.style.width='800px'`)
  await send('Emulation.setEmulatedMedia',{features:[]})
  await evaluate(`window.setTaskSession('b')`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]').getAttribute('aria-expanded')`),'false','session change closes the previous panel')
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click();window.setTodos({toolCallId:'clear',items:[]})`)
  await pause(200)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=todo]')===null`),true)
  assert.equal(await evaluate(`document.querySelector('[data-task-panel]').getAttribute('aria-hidden')`),'true','a branch without any task history has no todo panel')
  await evaluate(`window.setLocale('en');document.documentElement.classList.remove('dark')`)
  console.log('PASS: unified todo/background controls, stable rows, cancelled counts, paused motion, locale switching, keyboard/focus, exclusive overlays and session/clear cleanup.')
  await evaluate(`document.querySelector('#original button[aria-expanded]').click()`)
  await pause(300)
  assert.match(await evaluate(`document.querySelector('#original').innerText`), /build 中文😀/)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#original .overflow-auto')).scrollbarWidth`), 'none')
  const reads = await evaluate('window.outputReads')
  await pause(1150)
  assert(await evaluate('window.outputReads') > reads, 'open running task polls incrementally')
  await evaluate('window.setLocale("zh-CN")')
  await pause(200)
  assert.match(await evaluate(`document.querySelector('#original').innerText`), /后台运行中/)
  assert.match(await evaluate(`document.querySelector('#settings').innerText`), /最大阻塞时长/)
  await evaluate(`(()=>{const input=document.querySelector('#settings input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2.5');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await pause(100)
  await evaluate(`[...document.querySelectorAll('#settings button')].find(b=>b.textContent==='保存').click()`)
  await pause(150)
  assert.equal(await evaluate('window.savedWait'), 2500)
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_BASH_SCREENSHOT_DIR, { recursive: true })
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`)
      await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, `${theme}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    }
  }
  await evaluate(`[...document.querySelectorAll('#original button')].find(b=>b.textContent==='停止任务').click()`)
  await pause(300)
  assert.equal(await evaluate('window.stops'), 1)
  assert.equal(await evaluate(`document.querySelector('#original [data-bash-task-id]').dataset.bashTaskStatus`), 'cancelled')
  assert.match(await evaluate(`document.querySelector('#group').innerText`), /1 已完成，1 失败/)
  await evaluate(`document.querySelector('#original button[aria-expanded]').click()`)
  const stoppedReads = await evaluate('window.outputReads')
  await pause(1200)
  assert.equal(await evaluate('window.outputReads'), stoppedReads)
  await evaluate('window.startForegroundFixture()')
  await pause(100)
  const foregroundReads = await evaluate('window.outputReads')
  for (const id of ['success', 'error', 'timeout', 'json', 'live']) {
    await evaluate(`document.querySelector('#foreground-${id} button[aria-expanded]').click()`)
  }
  await pause(200)
  const foregroundText = await evaluate(`document.querySelector('#foreground-fixture').innerText`)
  assert.doesNotMatch(foregroundText, /Task |Open log|Stop task|foreground-task|failed-task|timeout-task|logPath|toolCallId/)
  assert.match(foregroundText, /foreground stdout 中文/)
  assert.match(foregroundText, /command failed[\s\S]*Exit code 7/)
  assert.match(foregroundText, /Timed out[\s\S]*output truncated/)
  assert.match(foregroundText, /\{"output":"keep this JSON","status":"ok"\}/)
  assert.match(foregroundText, /streaming stdout/)
  assert.equal(await evaluate(`document.querySelectorAll('#foreground-fixture [data-bash-task-id]').length`), 0)
  assert.equal(await evaluate('window.outputReads'), foregroundReads, 'foreground history and partials never fetch task logs')
  await evaluate('window.promoteForeground()')
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('#foreground-live [data-bash-task-id]')?.dataset.bashTaskId`), 'live-task')
  assert.match(await evaluate(`document.querySelector('#foreground-live').innerText`), /Running in background/)
  assert.equal(await evaluate(`document.querySelectorAll('#foreground-success [data-bash-task-id]').length`), 0)
  console.log('PASS: foreground bash uses ordinary tool rows and stdout/errors without task metadata/log reads; only actual background promotion switches to task UI.')
  // Drive the real store/transcript one IPC event at a time, with a painted
  // frame between every event. A final-state-only assertion misses flashing
  // file cards between a steer and its first assistant partial.
  await evaluate('window.startTurnFixture()')
  const step = async (code, expected = 0) => {
    await evaluate(`window.turnStep(${code},${expected})`)
    await pause(50)
    assert.equal((await evaluate('window.turnRead()')).cards, expected, JSON.stringify({code,state:await evaluate('window.turnRead()'),exceptions}))
  }
  const finish = async (timestamp, expected = 1) => {
    await step(`{type:'message_start',message:window.round(${timestamp},[])}`)
    await step(`{type:'message_end',message:window.round(${timestamp},window.prose('done'))}`)
    await step(`{type:'agent_end'}`)
    await step(`{type:'agent_settled'}`, expected)
  }
  await step(`{type:'message_end',message:window.notice(30)}`)
  await finish(40)
  let turnState = await evaluate('window.turnRead()')
  assert.equal(turnState.groups, 1, 'task steer stays inside one fold')
  assert.equal(turnState.notices, 1, 'task completion belongs inside folded process')
  assert.match(turnState.paths[0], /a.ts/)
  // A still-running server does not block the card. A later wake removes it
  // at agent_start, before the notice, then restores all prior changes even
  // though the new reply never calls write/edit.
  await evaluate('window.runForever()')
  await pause(100)
  assert.equal((await evaluate('window.turnRead()')).cards, 1, 'a live background process cannot hide a settled file card')
  await step(`{type:'agent_start',changeScopeId:'scope-a'}`)
  await step(`{type:'message_end',message:window.notice(50)}`)
  await finish(60)
  turnState = await evaluate('window.turnRead()')
  assert.equal(turnState.groups, 1)
  assert.equal(turnState.notices, 2)
  assert.deepEqual(turnState.reviews, [{ id: 20, files: ['a.ts'] }])
  await evaluate('window.resetTurn()')
  await step(`{type:'message_end',message:{role:'user',timestamp:30,content:'user steer'}}`)
  await step(`{type:'message_start',message:window.round(40,[])}`)
  await step(`{type:'message_end',message:window.round(40,[window.writeCall('write-b','b.ts')])}`)
  await step(`{type:'message_end',message:window.result('write-b')}`)
  await step(`{type:'agent_end'}`)
  await step(`{type:'agent_settled',continuing:true}`)
  await step(`{type:'agent_start',changeScopeId:'scope-a'}`)
  await step(`{type:'message_end',message:window.notice(50)}`)
  await finish(60)
  turnState = await evaluate('window.turnRead()')
  assert.equal(turnState.groups, 2, 'user steer opens a separate fold')
  assert.equal(turnState.cards, 1, 'all steered groups have only one cumulative card')
  assert.match(turnState.paths[0], /a.ts.*b.ts/)
  assert.deepEqual(turnState.reviews, [{ id: 20, files: ['a.ts', 'b.ts'] }])
  await evaluate(`window.turnStore.applySnapshot(window.turnSnapshot(JSON.parse(JSON.stringify(window.turnStore.getState().messages)),false))`)
  await pause(100)
  assert.deepEqual((await evaluate('window.turnRead()')).reviews, turnState.reviews, 'snapshot reload preserves merged changes')
  await step(`{type:'agent_start',changeScopeId:'scope-new'}`, 1)
  await step(`{type:'message_end',message:{role:'user',timestamp:70,content:'new request'}}`, 1)
  await step(`{type:'message_start',message:window.round(80,[],'scope-new')}`, 1)
  await step(`{type:'message_end',message:window.round(80,window.prose('new reply'),'scope-new')}`, 1)
  await step(`{type:'agent_settled'}`, 1)
  assert.deepEqual((await evaluate('window.turnRead()')).reviews, turnState.reviews, 'an unrelated turn leaves the previous card intact')
  assert((await evaluate('window.frameCount')) > 20)
  assert.deepEqual(await evaluate('window.frameFailures'), [], 'no painted frame may expose an intermediate file list')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS: real ChatView/PiStore frame-by-frame steer, idle server continuation, cumulative files/review, distinct user folds and snapshot restoration without flashing cards.')
  await evaluate('window.startStartupFixture()')
  await evaluate(`window.setLocale('en')`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('#startup-fixture [role="status"]').getAttribute('aria-label')`), 'Preparing session tools…')
  assert.equal(await evaluate(`document.querySelector('#startup-fixture textarea').disabled`), false, 'startup keeps draft editing available')
  await evaluate(`document.querySelector('#startup-fixture textarea').focus()`)
  await send('Input.insertText', { text:'preserve my draft' })
  assert.equal(await evaluate(`document.querySelector('#startup-fixture button[type="submit"]').disabled`), true)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await evaluate('window.startupSends.length'), 0, 'Enter cannot submit before tools are ready')
  assert.equal(await evaluate(`document.querySelector('#startup-fixture textarea').value`), 'preserve my draft')
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('#startup-fixture [role="status"]').getAttribute('aria-label')`), '正在准备会话工具…')
  await evaluate(`window.startupStore.dispatch({type:'session_initialized',sessionPath:'/ui/startup',eventSequence:1,model:null,thinkingLevel:'off',availableThinkingLevels:['off']})`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('#startup-fixture [role="status"]')`), null)
  assert.equal(await evaluate(`document.querySelector('#startup-fixture button[type="submit"]').disabled`), false)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await evaluate('window.startupSends[0].text'), 'preserve my draft')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS: startup shows localized tool preparation, preserves editable drafts and disables click/Enter submit until the readiness event.')
  console.log('PASS: native beUI background rows/group status, completion localization, bounded incremental output, stop action, threshold settings, themes and invisible scrollbars.')
} finally {
  ws?.close()
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
