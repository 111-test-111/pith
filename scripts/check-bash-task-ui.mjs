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
import { checkContinueUi } from './lib/check-continue-ui.mjs'
import { checkTurnFoldUi } from './lib/check-turn-fold-ui.mjs'
import { checkCompactionUi } from './lib/check-compaction-ui.mjs'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-bash-ui-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__bash-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {Composer} from '/src/components/app/Composer.tsx';
import {QueuePanel} from '/src/components/app/QueuePanel.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {extractReviewTurns} from '/src/lib/turn-written-files.ts';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {BashTasksProvider} from '/src/lib/bash-tasks.tsx';
import {BashTaskRow} from '/src/components/app/BashTaskView.tsx';
import {SessionTasks} from '/src/components/app/SessionTasks.tsx';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {ToolGroupView} from '/src/components/app/ToolGroupView.tsx';
import {CustomItem} from '/src/components/app/MessageItems.tsx';
import {GeneralSection} from '/src/components/app/settings/GeneralSection.tsx';
import {TOOL_CATEGORIES} from '/src/lib/tool-categories.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
let listener;window.outputReads=0;window.stops=0;window.savedWait=10000;window.openedSessions=[];window.openPaths=[];window.subagentActions=[];window.subagentActionMode='resolve';window.resolveSubagentAction=null;
window.task={id:'ui-task',sessionId:'ui-session',sessionPath:'/ui/session',toolCallId:'ui-call',command:'npm run build',cwd:'/ui',status:'running',background:true,reason:'wait_threshold',startedAt:Date.now()-1000,lastOutputAt:Date.now(),outputChars:11,logPath:'/ui/task.log',logTruncated:false,revision:1};
window.pi={onBashTask:fn=>{listener=fn;return()=>{listener=undefined}},listBashTasks:async path=>path==='/ui/session'?[window.task]:[],
 bashTaskOutput:async request=>{window.outputReads++;const output='build 中文😀';return{task:window.task,output:request.cursor===undefined?output:'',cursor:output.length,truncated:false}},
 stopBashTask:async()=>{window.stops++;window.task={...window.task,status:'cancelled',endedAt:Date.now(),revision:window.task.revision+1};listener?.(window.task);return window.task},
 subagentAction:request=>{window.subagentActions.push(structuredClone(request));if(window.subagentActionMode==='reject')return Promise.reject(new Error('RAW_MAIN_ERROR'));if(window.subagentActionMode==='pending')return new Promise(resolve=>{window.resolveSubagentAction=()=>{window.resolveSubagentAction=null;resolve()}});return Promise.resolve()},
 openPath:async path=>{window.openPaths.push(path);return ''},appInfo:async()=>({version:'fixture',bashMaxWaitMs:window.savedWait}),setBashMaxWaitMs:async value=>window.savedWait=value,openExternal:async()=>{}};
const call={type:'toolCall',id:'ui-call',name:'bash',arguments:{command:'npm run build'}};
const result={role:'toolResult',toolCallId:'ui-call',toolName:'bash',content:[],details:{bashTask:window.task},isError:false,timestamp:1};
const second={type:'toolCall',id:'read-call',name:'bash',arguments:{command:'pwd'}};
const secondResult={role:'toolResult',toolCallId:'read-call',toolName:'bash',content:[{type:'text',text:'/ui'}],isError:false,timestamp:2};
const completedSubagent={runId:'notice-run',sessionId:'notice-child',sessionPath:'/ui/children/notice.jsonl',parentSessionPath:'/ui/session',profile:'reviewer',model:'gpt-mini',description:'Review alignment',task:'Review alignment',status:'completed',runInBackground:true,createdAt:'2025-01-01T00:00:00.000Z',completedAt:'2025-01-01T00:00:02.000Z'};
const subagentCompletion={role:'custom',customType:'subagent_completion',content:'MODEL_COMPLETION',display:true,details:{subagent:completedSubagent},timestamp:4};
const subagentMessage={role:'custom',customType:'subagent_message',content:'MODEL_MESSAGE',display:true,details:{kind:'pi-app-subagent-message',sessionId:'notice-child',runId:'notice-run',description:'Review alignment',profile:'reviewer',message:'Alignment note',sentAt:'2025-01-01T00:00:03.000Z'},timestamp:5};
function Fixture(){const [todos,setTodos]=React.useState(null),[busy,setBusy]=React.useState(false),[taskSession,setTaskSession]=React.useState("a"),[subagents,setSubagents]=React.useState([]);window.setTodos=setTodos;window.setBusy=setBusy;window.setTaskSession=setTaskSession;window.setSubagents=setSubagents;const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement('div',{style:{width:800,margin:'20px auto'}},
 React.createElement('div',{id:'tasks'},React.createElement(BashTasksProvider,{sessionPath:'/ui/session'},
 React.createElement(SessionTasks,{key:taskSession,todos,busy,subagents,sessionPath:'/ui/session',onOpenSession:path=>window.openedSessions.push(path)}),React.createElement('div',{id:'original'},React.createElement(ToolCallView,{call,result})),
 React.createElement('div',{id:'group'},React.createElement(ToolGroupView,{category:TOOL_CATEGORIES[1],calls:[call,second],toolResults:new Map([['ui-call',result],['read-call',secondResult]]),toolRuns:{}})),
 React.createElement('div',{id:'notice'},React.createElement(CustomItem,{message:{role:'custom',customType:'bash_task_completion',content:'INTERNAL_MODEL_INSTRUCTIONS',display:true,details:{bashTask:{...window.task,id:'completed-ui-task',toolCallId:'completed-call',status:'succeeded'}},timestamp:3}})),
 React.createElement('div',{id:'subagent-completion'},React.createElement(CustomItem,{message:subagentCompletion})),
 React.createElement('div',{id:'subagent-message'},React.createElement(CustomItem,{message:subagentMessage})))),
 React.createElement('div',{id:'settings',style:{marginTop:24}},React.createElement(GeneralSection)));}
window.checkRoot=createRoot(document.getElementById('root'));window.checkRoot.render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
window.finishTask=()=>{window.task={...window.task,status:'succeeded',exitCode:0,endedAt:Date.now(),revision:window.task.revision+1};listener?.(window.task)};window.runForever=()=>{window.task={...window.task,status:'running',endedAt:undefined,revision:window.task.revision+1};listener?.(window.task)};
window.startStartupFixture=()=>{
 window.turnStore=null;window.startupStore=new PiStore();window.startupSends=[];
 window.startupStore.applySnapshot({sessionId:'startup',sessionPath:'/ui/startup',cwd:'/ui',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false,initializing:true,eventSequence:0});
 function Startup(){const shell=React.useSyncExternalStore(window.startupStore.subscribe,window.startupStore.getShell);const {setLocale}=useI18n();window.setLocale=setLocale;
  return React.createElement(Composer,{start:{projectName:'fixture',cwd:'/ui',projects:[],onProjectChange:()=>{}},models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy:false,initializing:shell.initializing,
   queued:{steering:[],followUp:[]},onSend:p=>window.startupSends.push(p),onQueue:()=>{throw Error('unexpected queue')},onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}});}
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'startup'},React.createElement(ImagePreviewProvider,null,React.createElement('div',{id:'startup-fixture',style:{width:800,margin:'20px auto'}},React.createElement(Startup))))));
};
window.startQueueFixture=(initialCompaction=false)=>{
 window.turnStore=null;window.queueActions=[];
 function Queued(){const {setLocale}=useI18n();window.setLocale=setLocale;
  const [compactionQueued,setCompactionQueued]=React.useState(initialCompaction),[queue,setQueue]=React.useState({
   steering:[{text:'current steer',imageCount:1,filePaths:['a.ts','b.ts']}],
   followUp:[{text:'duplicate draft',imageCount:0,filePaths:[]},{text:'duplicate draft',imageCount:0,filePaths:[]}]});
  window.setQueueCompaction=setCompactionQueued;window.setQueueMessages=setQueue;
  return React.createElement(QueuePanel,{...queue,compactionQueued,
  onPromote:index=>window.queueActions.push({action:'promote',index}),
  onRemove:(kind,index)=>window.queueActions.push({action:'remove',kind,index}),
  onRecall:()=>window.queueActions.push({action:'recall'})});}
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'queue'},React.createElement('div',{id:'queue-fixture',style:{width:800,margin:'20px auto'}},React.createElement(Queued)))));
};
window.addTasks=(count)=>{for(let i=0;i<count;i++)listener?.({...window.task,id:'bulk-'+i,toolCallId:'bulk-call-'+i,command:'echo bulk task '+i,status:'succeeded',background:true,exitCode:0,endedAt:Date.now(),revision:1})};
window.startControlFixture=()=>{
 localStorage.setItem('pi-app:locale','en');
 window.task={...window.task,id:'silent-stopped',toolCallId:'silent-call',status:'cancelled',outputChars:0,startedAt:1000,endedAt:66500,lastOutputAt:66500};
 window.pi.bashTaskOutput=async()=>({task:window.task,output:'',cursor:0,truncated:false});
 const calls=['list','status','output','stop'].map(action=>({type:'toolCall',id:'control-'+action,name:'bash_task',arguments:{action,taskId:window.task.id}}));
 const results=new Map(calls.map(call=>[call.id,{role:'toolResult',toolName:'bash_task',toolCallId:call.id,timestamp:2,isError:false,content:[{type:'text',text:'snapshot'}],details:{bashTask:{...window.task,status:call.arguments.action==='stop'?'cancelled':'running'}}}]));
 const runs=Object.fromEntries(calls.map(call=>[call.id,{toolCallId:call.id,toolName:'bash_task',status:'success',startedAt:1000,endedAt:1001}]));
 function Controls(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement(BashTasksProvider,{sessionPath:'/ui/session'},
  React.createElement('div',{id:'silent-task'},React.createElement(BashTaskRow,{task:window.task})),
  React.createElement('div',{id:'controls-group'},React.createElement(ToolGroupView,{category:TOOL_CATEGORIES[1],calls,toolResults:results,toolRuns:runs})),
  ...calls.map(call=>React.createElement('div',{id:call.id,key:call.id},React.createElement(ToolCallView,{call,result:results.get(call.id),run:runs[call.id]}))));}
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'control-fixture'},React.createElement('div',{style:{width:800,margin:'20px auto'}},React.createElement(Controls)))));
};
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
 // A command longer than the expansion's header cap: it has to scroll inside
 // the header instead of pushing the output's fold down.
 const longCommand=Array.from({length:14},(_,i)=>'echo step '+(i+1)).join('\\n');
 const longCall={...call,id:'foreground-long',arguments:{command:longCommand}};
 const longTask={...task,id:'foreground-long',toolCallId:longCall.id,command:longCommand};
 const longResult={...result,toolCallId:longCall.id,details:{bashTask:longTask},content:[{type:'text',text:JSON.stringify({...envelope,id:'foreground-long',toolCallId:longCall.id,command:longCommand,output:'long stdout'})}]};
 const row=(id,props)=>React.createElement('div',{id},React.createElement(ToolCallView,props));
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'foreground-fixture'},React.createElement('div',{id:'foreground-fixture',style:{width:800,margin:'20px auto'}},
  React.createElement(BashTasksProvider,{sessionPath:'/ui/session'},
   row('foreground-success',{call,result}),row('foreground-error',{call:errorCall,result:errorResult}),
   row('foreground-timeout',{call:timeoutCall,result:timeoutResult}),row('foreground-json',{call:plainCall,result:plainResult}),
   row('foreground-long',{call:longCall,result:longResult}),
   row('foreground-live',{call:liveCall,run}))))));
};
window.startTurnFixture=(locale='en')=>{
 localStorage.setItem('pi-app:locale',locale);
 window.turnStore=new PiStore();window.turnSequence=0;window.frameFailures=[];window.frameCount=0;window.expectedCards=0;
 const user={role:'user',timestamp:10,content:'original request'};
 window.round=(timestamp,content,scope='scope-a')=>({role:'assistant',timestamp,content,changeScopeId:scope,stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop'});
 window.writeCall=(id,path)=>({type:'toolCall',name:'write',id,arguments:{path,content:'created\\n'}});
 window.result=(id)=>({role:'toolResult',toolCallId:id,toolName:'write',timestamp:21,content:[],isError:false});
 window.prose=value=>[{type:'text',text:value}];
 window.notice=(timestamp)=>({role:'custom',customType:'bash_task_completion',timestamp,display:true,content:'MODEL_ONLY_NOTICE',details:{bashTask:{...window.task,id:'notice-'+timestamp,status:'succeeded',background:true}}});
 // A command long enough to out-measure the transcript column, with and
 // without spaces, so the notice row must truncate instead of widening.
 const longCommand='git log --oneline --decorate --graph --all --pretty=format:%h_%ad_%an_%s --date=iso-strict src/main/pi/manager.ts src/renderer/src/components/app/BashTaskView.tsx | head -n 200 | grep -v merge | sort | uniq -c | sort -rn | head -n 50';
 window.longNotice=(timestamp)=>({...window.notice(timestamp),details:{bashTask:{...window.task,id:'notice-long-'+timestamp,command:longCommand,status:'succeeded'}}});
 window.initialTurnMessages=[user,window.round(20,[window.writeCall('write-a','a.ts')]),window.result('write-a')];
 window.turnSnapshot=(messages,isStreaming=true)=>({sessionId:'ui-session',sessionPath:'/ui/session',cwd:'/ui',projectless:false,messages,isStreaming,activeChangeScopeId:'scope-a',model:null,thinkingLevel:'off',eventSequence:++window.turnSequence});
 window.resetTurn=()=>{window.expectedCards=0;flushSync(()=>window.turnStore.applySnapshot(window.turnSnapshot(window.initialTurnMessages.map(m=>({...m})))))};
 window.resetTurn();
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'turn-fixture:'+locale},React.createElement(ImagePreviewProvider,null,
  React.createElement('div',{id:'turn-fixture',style:{height:900,display:'flex',flexDirection:'column'}},React.createElement(ChatView,{store:window.turnStore,onDismissError:()=>{},onResend:m=>window.menuResends.push(m),onContinue:m=>window.menuContinues.push(m),onEditMessage:m=>window.menuEdits.push(m),onRewindMessage:m=>window.menuRewinds.push(m),onFork:m=>window.menuForks.push(m),onReview:()=>{}}))))));
 window.menuResends=[];window.menuEdits=[];window.menuRewinds=[];window.menuForks=[];window.menuContinues=[];
 window.turnStep=(event,count=0)=>{window.expectedCards=count;flushSync(()=>window.turnStore.dispatch({...event,sessionPath:'/ui/session',eventSequence:++window.turnSequence}));};
 window.turnRead=()=>({cards:document.querySelectorAll('#turn-fixture ul[data-plain-list]').length,
  paths:[...document.querySelectorAll('#turn-fixture ul[data-plain-list]')].map(list=>list.textContent),
  groups:document.querySelectorAll('[data-assistant-group]').length,
  notices:document.querySelectorAll('[data-turn-process] [data-bash-task-id]').length,
  reviews:extractReviewTurns(window.turnStore.getState().messages,'/ui').map(turn=>({id:turn.id,files:turn.files.map(f=>f.displayPath)}))});
 const frame=()=>{if(!window.turnStore)return;window.frameCount++;const state=window.turnRead();if(state.cards!==window.expectedCards)window.frameFailures.push({...state,expected:window.expectedCards});requestAnimationFrame(frame)};requestAnimationFrame(frame);
};
window.startJevFixture=()=>{
 window.turnStore=null;window.jevReads=0;window.jevDetailReads=0;
 const previousList=window.pi.listBashTasks;window.pi.listBashTasks=async path=>path==='/ui/jev'?[{...window.task,id:'jev-background',sessionPath:'/ui/jev',status:'running',background:true}]:previousList(path);
 const trace={id:'trace-1',stage:'verifier',timestamp:1,status:'completed',choice:'stop',effectiveChoice:'continue',override:'missing_evidence',target:{id:'verify_layout',requirement:'Change the layout',instruction:'Inspect the modified settings layout',evidenceIds:['edit-1']}};
 window.pi.jevTraces=async()=>{window.jevReads++;return{items:[trace],nextCursor:null}};
 window.pi.jevTrace=async()=>{window.jevDetailReads++;return{...trace,request:{state:JSON.stringify({request:'Change the layout',attachmentsOmitted:true}),questions:{action:{type:'choice',instructions:'Verify actual changes',criteria:{stop:'Complete',continue:'Incomplete'}}}},evaluation:{model:'jev-fixture',elapsedMs:123,inputTokens:30,outputTokens:5,answers:{action:{type:'choice',choice:'stop',confidence:0.92,probabilities:{stop:0.96,continue:0.04}}}}}};
 function JevFixture(){
  const [todos,setTodos]=React.useState(null);window.jevSetTodos=setTodos;
  const {setLocale}=useI18n();window.setLocale=setLocale;
  const [state,setState]=React.useState({seq:1,phase:'verifying',route:'act',corrections:4,requests:31,jevInput:300,jevOutput:50,mainInput:100,mainOutput:20,cacheRead:500,cacheWrite:0});window.jevSetState=setState;
  return React.createElement('div',{id:'jev-fixture',style:{height:700,width:900,margin:'20px auto',display:'flex',flexDirection:'column'}},
   React.createElement(BashTasksProvider,{sessionPath:'/ui/jev'},React.createElement(SessionTasks,{todos,subagents:[],busy:true,sessionPath:'/ui/jev',jevState:state})),
   React.createElement('div',{id:'jev-transcript',style:{flex:1}},'TRANSCRIPT'));
 }
 flushSync(()=>window.checkRoot.render(React.createElement(I18nProvider,{key:'jev'},React.createElement(JevFixture))));
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
  const assertToolMetaAlignment = async (selectors, label) => {
    const rows = await evaluate(`(()=>{const group=document.querySelector('#group .items-baseline'),groupTitle=group?.children[0],groupMeta=group?.children[1],gt=groupTitle?.getBoundingClientRect(),gm=groupMeta?.getBoundingClientRect(),expected=gt&&gm?gm.top-gt.top:null;return ${JSON.stringify(selectors)}.map(selector=>{const host=document.querySelector(selector),title=host?.querySelector('[data-tool-result-title]'),meta=host?.querySelector('[data-tool-result-meta]'),parent=title?.parentElement,tr=title?.getBoundingClientRect(),mr=meta?.getBoundingClientRect();return {selector,found:!!title&&!!meta,parentAlign:parent?getComputedStyle(parent).alignItems:null,titleAlign:title?getComputedStyle(title).alignSelf:null,metaAlign:meta?getComputedStyle(meta).alignSelf:null,offset:tr&&mr?mr.top-tr.top:null,expected}})})()`)
    assert.equal(rows.length, selectors.length)
    for (const row of rows) {
      assert.equal(row.found, true, `${label} renders title and meta: ${JSON.stringify(row)}`)
      assert.equal(row.parentAlign, 'baseline', `${label} shares one text baseline: ${JSON.stringify(row)}`)
      assert.equal(row.titleAlign, 'auto', `${label} title does not override the shared baseline: ${JSON.stringify(row)}`)
      assert.equal(row.metaAlign, 'auto', `${label} meta does not override the shared baseline: ${JSON.stringify(row)}`)
      assert.ok(Math.abs(row.offset - row.expected) < 0.6, `${label} matches the grouped-row title/meta offset: ${JSON.stringify(row)}`)
    }
  }
  const clickSelector = async (selector) => {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    await send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, x:point.x, y:point.y })
    await send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, x:point.x, y:point.y })
  }
  await send('Runtime.enable')
  // The window is not frontmost while the check runs, and `navigator.clipboard`
  // refuses a document that is not focused: the menu's copy assertions need
  // the emulated focus the other CDP checks already ask for.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 200; i++) { if (await evaluate(`!!document.querySelector('#original [data-bash-task-id]')`)) break; await pause(50) }
  assert.equal(await evaluate(`document.querySelector('#original [data-bash-task-id]')?.dataset.bashTaskStatus`), 'running')
  assert.match(await evaluate(`document.querySelector('#original').innerText`), /Running in background/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#group').innerText`), /completed,.*failed/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#notice').innerText`), /INTERNAL_MODEL_INSTRUCTIONS/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#subagent-completion').innerText`), /MODEL_COMPLETION/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#subagent-message').innerText`), /MODEL_MESSAGE/)
  await assertToolMetaAlignment(['#original', '#notice', '#subagent-completion', '#subagent-message'], 'tool and steer rows')
  assert.equal(await evaluate('window.outputReads'), 0, 'closed rows never read logs')
  // The expanded list is an overlay: opening it must move nothing in the page.
  const pageGeometry = `JSON.stringify(['#original','#group','#notice'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}))`
  const beforeExpand = await evaluate(pageGeometry)
  const rowHeight = await evaluate(`document.querySelector('#tasks').getBoundingClientRect().height`)
  await evaluate(`document.querySelector('[data-session-tasks] button[aria-expanded]').click()`)
  await pause(400)
  assert.equal(await evaluate(pageGeometry), beforeExpand, 'opening the task panel pushes no content down')
  assert.equal(await evaluate(`document.querySelector('#tasks').getBoundingClientRect().height`), rowHeight, 'the open panel adds no height to its container')
  const panel = await evaluate(`(()=>{const p=document.querySelector('[data-task-panel]'),r=p.getBoundingClientRect(),root=document.querySelector('[data-session-tasks]').getBoundingClientRect(),o=document.querySelector('#original').getBoundingClientRect();return {top:Math.round(r.top),rootBottom:Math.round(root.bottom),left:Math.round(r.left),rootLeft:Math.round(root.left),right:Math.round(r.right),rootRight:Math.round(root.right),overlapsTranscript:r.top<o.bottom&&r.bottom>o.top,shadow:getComputedStyle(p.parentElement).boxShadow}})()`)
  assert.equal(panel.top, panel.rootBottom, 'the panel hangs from the summary row')
  assert.ok(panel.overlapsTranscript, 'the panel covers the transcript instead of displacing it: ' + JSON.stringify(panel))
  // No elevation either: any shadow the drawer cast would spill a soft band
  // over the neighbouring sidebar/rail, past the very lines its box coincides
  // with. Its own surface colour and bottom rule are what separate it.
  assert.equal(panel.shadow, 'none', 'the drawer casts nothing past the column lines')
  // AgentDisclosure still owns its reveal clip, and the wrapper that positions
  // the drawer clips nothing of it.
  assert.match(await evaluate(`getComputedStyle(document.querySelector('[data-task-panel]')).clipPath`), /^inset\(0px 0px 0%\)/, 'the disclosure still owns its reveal clip')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-task-panel]').parentElement).overflow`), 'visible', 'the positioning wrapper clips nothing')
  await assertToolMetaAlignment(['[data-task-panel] [data-bash-task-id]'], 'background-task panel rows')
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
  // Full-bleed: the panel's own box coincides with the chat column, so its
  // left/right edges ARE the column's side lines (the sidebar's right rule and
  // the rail's left rule) — it draws no side border of its own, squares every
  // corner and leaves the top rule to the strip.
  assert.equal(panel.left, panel.rootLeft, 'the panel is flush with the column left edge')
  assert.equal(panel.right, panel.rootRight, 'the panel is flush with the column right edge')
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-task-panel]'));return [s.borderTopWidth,s.borderLeftWidth,s.borderBottomWidth,s.borderRightWidth,s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius]})()`), ['0px', '0px', '1px', '0px', '0px', '0px', '0px', '0px'], 'only the strip rules above and below the drawer; it never draws a side line or a rounded corner')
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
  // A trigger is a quiet toggle: pressing one must not scale its label, and
  // activating it must not resize the pill. Only the active variant carries a
  // border, so the transparent one keeps every pill exactly where it was.
  const triggers = `[...document.querySelectorAll('[data-task-trigger]')].map(b=>{const r=b.getBoundingClientRect();return [b.dataset.taskTrigger,Math.round(r.x*100)/100,Math.round(r.width*100)/100]})`
  const beforePress = await evaluate(triggers)
  const bashPoint = await evaluate(`(()=>{const r=document.querySelector('[data-task-trigger=bash]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  const sampleTrigger = `new Promise(resolve=>{const el=document.querySelector('[data-task-trigger=bash]');const seen=new Set();let n=0;const frame=()=>{seen.add(getComputedStyle(el).transform);if(++n<12)requestAnimationFrame(frame);else resolve([...seen])};requestAnimationFrame(frame)})`
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bashPoint.x,y:bashPoint.y})
  const hoverFrames = await evaluate(sampleTrigger)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:bashPoint.x,y:bashPoint.y})
  const pressFrames = await evaluate(sampleTrigger)
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:bashPoint.x,y:bashPoint.y})
  const releaseFrames = await evaluate(sampleTrigger)
  await pause(250)
  assert.deepEqual([...new Set([...hoverFrames,...pressFrames,...releaseFrames])],['none'],'hovering or pressing a trigger never animates it')
  assert.deepEqual(await evaluate(triggers),beforePress,'activating a trigger moves no pill: ' + JSON.stringify(await evaluate(triggers)))
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(350)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/1 of 4 completed.*1 cancelled/s)
  assert.match(await evaluate(`document.querySelector('[data-task-panel]').innerText`),/Paused/)
  // Each status owns a colour: done is green, cancelled is rose, waiting stays neutral.
  const tones = await evaluate(`(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const rgb=value=>{ctx.fillStyle=value;ctx.fillRect(0,0,1,1);const [r,g,b]=ctx.getImageData(0,0,1,1).data;return{r,g,b}};
    const green=c=>c.g>c.r+24&&c.g>c.b+24, rose=c=>c.r>c.g+24&&c.r>c.b+24;
    const read=id=>{const li=document.querySelector('[data-todo-id='+JSON.stringify(id)+']').closest('li');
      const glyph=rgb(getComputedStyle(li.querySelector('svg')).color), label=rgb(getComputedStyle(li.lastElementChild).color);
      return {glyph,label,greenGlyph:green(glyph),greenLabel:green(label),roseGlyph:rose(glyph),roseLabel:rose(label)}};
    return {done:read('a'),waiting:read('c'),cancelled:read('d')}})()`)
  assert.ok(tones.done.greenGlyph && tones.done.greenLabel, 'a completed task paints its glyph and label green: ' + JSON.stringify(tones))
  assert.ok(!tones.waiting.greenGlyph && !tones.waiting.greenLabel, 'a waiting task stays neutral: ' + JSON.stringify(tones))
  assert.ok(tones.cancelled.roseGlyph && tones.cancelled.roseLabel, 'a cancelled task paints its glyph and label rose: ' + JSON.stringify(tones))
  // One drawer, one rhythm: every panel carries the bash list's fixed 16.5rem
  // height, 4px edge padding, 8px row gaps and 44px row pitch.
  const rhythm = `(()=>{const p=document.querySelector('[data-task-panel]');const list=p.querySelector('[data-bash-tasks-list]')||p.querySelector('[data-subagents-list]');const container=list??p.querySelector('ol');const rows=[...container.children],box=(list??container.parentElement).getBoundingClientRect(),rects=rows.map(r=>r.getBoundingClientRect()),icon=rows[0].querySelector('svg').getBoundingClientRect();return {panel:Math.round(p.getBoundingClientRect().height),list:Math.round(box.height),pad:Math.round(rects[0].top-box.top),side:Math.round(rects[0].left-box.left),pitch:Math.round(rects[1].top-rects[0].top),row:Math.round(rects[0].height),iconLeft:Math.round(icon.left-box.left),iconSize:Math.round(icon.width)}})()`
  const todoRhythm = await evaluate(rhythm)
  await evaluate(`document.querySelector('[data-task-trigger=bash]').click()`)
  await pause(250)
  const bashRhythm = await evaluate(rhythm)
  await evaluate(`window.setSubagents([
    {runId:'run-a',sessionId:'child-a',sessionPath:'/ui/children/a.jsonl',parentSessionPath:'/ui/session',profile:'explore',model:'gpt-mini',description:'Summarize module A',task:'Summarize module A',status:'completed',runInBackground:true,createdAt:'2025-01-01T00:00:05.000Z',completedAt:'2025-01-01T00:00:09.000Z',tokens:1200,toolUses:3},
    {runId:'run-b',sessionId:'child-b',sessionPath:'/ui/children/b.jsonl',parentSessionPath:'/ui/session',profile:'explore',model:'gpt-mini',description:'Summarize module B',task:'Summarize module B',status:'running',runInBackground:true,createdAt:'2025-01-01T00:00:05.000Z',tokens:300,toolUses:1},
    {runId:'run-c',sessionId:'child-c',sessionPath:'/ui/children/c.jsonl',parentSessionPath:'/ui/session',profile:'explore',model:'gpt-mini',description:'Summarize module C',task:'Summarize module C',status:'interrupted',runInBackground:true,createdAt:'2025-01-01T00:00:05.000Z',completedAt:'2025-01-01T00:00:07.000Z'}])`)
  await pause(250)
  await evaluate(`document.querySelector('[data-task-trigger=agents]').click()`)
  await pause(300)
  const agentRhythm = await evaluate(rhythm)
  const shared = ({ iconLeft, iconSize, pad, side, pitch, row }) => ({ iconLeft, iconSize, pad, side, pitch, row })
  assert.deepEqual([shared(todoRhythm),shared(agentRhythm)],[shared(bashRhythm),shared(bashRhythm)],'every panel shares the row rhythm and icon geometry: ' + JSON.stringify({todoRhythm,bashRhythm,agentRhythm}))
  assert.deepEqual([todoRhythm.iconLeft,bashRhythm.iconLeft,todoRhythm.iconSize,bashRhythm.iconSize],[10,10,16,16],'all three panels put one size-4 icon on the todo panel’s 10px inset')
  assert.equal(bashRhythm.list,264,'a long list stops at the shared 16.5rem cap')
  assert.ok(todoRhythm.list < bashRhythm.list,'a short list grows row by row instead of holding the cap: ' + JSON.stringify(todoRhythm))
  assert.deepEqual([todoRhythm.panel-todoRhythm.list,agentRhythm.panel-agentRhythm.list],[bashRhythm.panel-bashRhythm.list,bashRhythm.panel-bashRhythm.list],'one header height across the three panels')
  await assertToolMetaAlignment(['[data-subagents-list] [data-subagent-id=child-a]'], 'subagent panel rows')
  // Open-session is an entry-level link, not a disclosure control: every
  // collapsed row shows it with no resting surface, and it holds the header's
  // own 36px line — which is what keeps the shared
  // row pitch the rhythm check above just pinned down.
  const collapsed = await evaluate(`[...document.querySelectorAll('[data-subagents-list] [data-subagent-id]')].map(row=>row.querySelector('button[aria-expanded]').getAttribute('aria-expanded'))`)
  assert.deepEqual(collapsed, ['false', 'false', 'false'], 'the roster starts collapsed: ' + JSON.stringify(collapsed))
  const links = await evaluate(`[...document.querySelectorAll('[data-subagents-list] [data-subagent-open]')].map(node=>{const r=node.getBoundingClientRect(),row=node.closest('[data-subagent-id]'),rr=row.getBoundingClientRect(),head=row.querySelector('button[aria-expanded]').getBoundingClientRect(),s=getComputedStyle(node);return {id:node.dataset.subagentOpen,text:node.innerText.trim(),box:[Math.round(r.width),Math.round(r.height)],headLine:[Math.round(head.top),Math.round(head.bottom)],line:[Math.round(r.top),Math.round(r.bottom)],right:Math.round(rr.right-r.right),background:s.backgroundColor,borderWidth:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth].join('/'),shadow:s.boxShadow,transition:s.transitionProperty,duration:s.transitionDuration,radius:s.borderTopLeftRadius,decoration:s.textDecorationLine,weight:s.fontWeight}})`)
  assert.equal(links.length, 3, 'every entry carries its own open-session link: ' + JSON.stringify(links))
  assert.deepEqual(links.map((link) => link.id), ['child-a', 'child-b', 'child-c'])
  assert.deepEqual([...new Set(links.map((link) => link.text))], ['Open session'], 'the link keeps the localized label')
  for (const link of links) {
    assert.ok(link.box[0] > 0 && link.box[1] > 0, 'the link is laid out without expanding anything: ' + JSON.stringify(link))
    assert.deepEqual(link.line, link.headLine, 'the link rides its entry’s own 36px header line: ' + JSON.stringify(link))
    assert.ok(link.right >= 0, 'the link stays inside its entry: ' + JSON.stringify(link))
    assert.equal(link.background, 'rgba(0, 0, 0, 0)', 'the link paints no surface: ' + JSON.stringify(link))
    assert.equal(link.borderWidth, '0px/0px/0px/0px', 'the link draws no frame: ' + JSON.stringify(link))
    assert.equal(link.shadow, 'none', 'the link casts no box: ' + JSON.stringify(link))
    assert.ok(!link.transition.split(', ').includes('all') && !link.transition.split(', ').includes('transform'), 'the link only transitions paint properties: ' + JSON.stringify(link))
    assert.equal(link.decoration, 'none', 'the link has no resting underline: ' + JSON.stringify(link))
  }
  // Hovering fills it without a frame, and a press opens that row's
  // own child session without touching the disclosure.
  const linkPoint = await evaluate(`(()=>{const r=document.querySelector('[data-subagent-open=child-a]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:linkPoint.x,y:linkPoint.y})
  await pause(150)
  const hoveredLink = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-subagent-open=child-a]'));return {background:s.backgroundColor,decoration:s.textDecorationLine,border:s.borderColor}})()`)
  assert.notEqual(hoveredLink.background, 'rgba(0, 0, 0, 0)', 'hovering the entry link fills it: ' + JSON.stringify(hoveredLink))
  assert.equal(hoveredLink.decoration, 'none', 'the hover cue is fill, not underline: ' + JSON.stringify(hoveredLink))
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:linkPoint.x,y:linkPoint.y})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:linkPoint.x,y:linkPoint.y})
  await pause(150)
  assert.deepEqual(await evaluate('window.openedSessions'), ['/ui/children/a.jsonl'], 'the link opens its own child session')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-id=child-a] button[aria-expanded]').getAttribute('aria-expanded')`), 'false', 'opening a session never expands the roster row')
  // Expanding a row grows it below the link: the link stays on the first line.
  await evaluate(`document.querySelector('[data-subagent-id=child-b] button[aria-expanded]').click()`)
  await pause(300)
  const openedRow = await evaluate(`(()=>{const n=document.querySelector('[data-subagent-open=child-b]'),row=n.closest('[data-subagent-id]'),r=n.getBoundingClientRect(),rr=row.getBoundingClientRect();return {top:Math.round(r.top),headTop:Math.round(row.querySelector('button[aria-expanded]').getBoundingClientRect().top),rowTop:Math.round(rr.top),rowBottom:Math.round(rr.bottom)}})()`)
  assert.equal(openedRow.top, openedRow.headTop, 'the link keeps to the first line with the row open: ' + JSON.stringify(openedRow))
  assert.equal(openedRow.top, openedRow.rowTop, 'the link never drifts to the row foot: ' + JSON.stringify(openedRow))
  assert.ok(openedRow.rowBottom > openedRow.top + 40, 'the open row really grew below the link: ' + JSON.stringify(openedRow))

  // Running cards expose Guide + Stop. Guide owns a multiline, focus-trapped
  // editor; plain Enter is a newline and Ctrl+Enter submits exactly once.
  const runningActions = await evaluate(`Array.from(document.querySelectorAll('[data-subagent-id=child-b] [data-subagent-actions] button'),button=>({action:button.dataset.subagentAction??null,text:button.innerText.trim()}))`)
  assert.deepEqual(runningActions, [{ action: 'steer', text: 'Guide' }, { action: null, text: 'Stop' }])
  await evaluate(`document.querySelector('[data-subagent-id=child-b] [data-subagent-action=steer]').click()`)
  await pause(300)
  const actionFocus = await evaluate(`(()=>{const input=document.querySelector('[data-subagent-action-dialog=steer] textarea'),active=document.activeElement;return {same:input===active,active:active?.tagName,aria:active?.getAttribute?.('aria-label')}})()`)
  assert.equal(actionFocus.same, true, 'the action editor receives initial focus: ' + JSON.stringify(actionFocus))
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] [data-subagent-action=steer]').disabled`), true, 'blank instructions cannot submit')
  // The portalled modal owns Escape ahead of the task panel underneath.
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog]')`), null)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=agents]').getAttribute('aria-expanded')`), 'true', 'modal Escape keeps the task panel open')
  assert.equal(await evaluate(`document.activeElement.dataset.subagentAction`), 'steer', 'modal Escape restores the action trigger')
  await evaluate(`document.querySelector('[data-subagent-id=child-b] [data-subagent-action=steer]').click()`)
  await pause(250)
  await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] textarea').focus()`)
  await send('Input.insertText', { text:'first line' })
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await send('Input.insertText', { text:'second line' })
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] textarea').value`), 'first line\nsecond line')
  assert.equal(await evaluate('window.subagentActions.length'), 0, 'plain Enter never submits a multiline instruction')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  await pause(350)
  assert.deepEqual(await evaluate('window.subagentActions[0]'), { sessionPath: '/ui/session', sessionId: 'child-b', expectedRunId: 'run-b', action: 'steer', message: 'first line\nsecond line' })
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog]')`), null, 'a successful action closes the dialog')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-id=child-b]').dataset.subagentStatus`), 'running', 'the renderer never invents a roster transition')
  assert.equal(await evaluate(`document.activeElement.dataset.subagentAction`), 'steer', 'closing returns focus to the invoking action')

  // Main-process failures stay localized and keep the draft available for retry.
  await evaluate(`window.subagentActionMode='reject';document.querySelector('[data-subagent-id=child-b] [data-subagent-action=steer]').click()`)
  await pause(250)
  await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] textarea').focus()`)
  await send('Input.insertText', { text:'keep this draft' })
  await clickSelector('[data-subagent-action-dialog=steer] [data-subagent-action=steer]')
  await pause(150)
  const failedAction = await evaluate(`(()=>{const dialog=document.querySelector('[data-subagent-action-dialog=steer]');return {text:dialog.innerText,value:dialog.querySelector('textarea').value}})()`)
  assert.match(failedAction.text, /The subagent action failed\./)
  assert.doesNotMatch(failedAction.text, /RAW_MAIN_ERROR/, 'raw main-process errors never reach the UI')
  assert.equal(failedAction.value, 'keep this draft')
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=agents]').getAttribute('aria-expanded')`), 'true', 'real pointer Submit never dismisses the task panel')
  await clickSelector('[data-subagent-action-dialog] [data-subagent-action-cancel]')
  await evaluate(`window.subagentActionMode='resolve'`)
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=agents]').getAttribute('aria-expanded')`), 'true', 'real pointer Cancel never dismisses the task panel')

  // A roster update can invalidate an open action. The draft remains, but the
  // old operation cannot submit and never changes its semantics automatically.
  await evaluate(`document.querySelector('[data-subagent-id=child-b] [data-subagent-action=steer]').click()`)
  await pause(250)
  await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] textarea').focus()`)
  await send('Input.insertText', { text:'stale draft' })
  const actionsBeforeStale = await evaluate('window.subagentActions.length')
  await evaluate(`window.setSubagents(current=>current.map(run=>run.sessionId==='child-b'?{...run,status:'completed',completedAt:new Date().toISOString()}:run))`)
  await pause(150)
  assert.match(await evaluate(`document.querySelector('[data-subagent-action-dialog=steer]').innerText`), /run changed/)
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] textarea').value`), 'stale draft')
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog=steer] [data-subagent-action=steer]').disabled`), true)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  assert.equal(await evaluate('window.subagentActions.length'), actionsBeforeStale, 'a stale Steer never turns into Resume')
  await clickSelector('[data-subagent-action-dialog] [data-subagent-action-cancel]')
  await pause(300)
  await evaluate(`window.setSubagents(current=>current.map(run=>run.sessionId==='child-b'?{...run,status:'running',completedAt:undefined}:run))`)
  await pause(150)

  // Terminal cards resume the same session. Pending state blocks duplicate
  // keyboard submission, and success still waits for the roster to change.
  await evaluate(`document.querySelector('[data-subagent-id=child-a] button[aria-expanded]').click()`)
  await pause(250)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-subagent-id=child-a] [data-subagent-actions] button'),button=>({action:button.dataset.subagentAction??null,text:button.innerText.trim()}))`), [{ action: 'resume', text: 'Continue' }])
  await evaluate(`window.subagentActionMode='pending';document.querySelector('[data-subagent-id=child-a] [data-subagent-action=resume]').click()`)
  await pause(250)
  await evaluate(`document.querySelector('[data-subagent-action-dialog=resume] textarea').focus()`)
  await send('Input.insertText', { text:'continue with tests' })
  const actionsBeforeResume = await evaluate('window.subagentActions.length')
  await clickSelector('[data-subagent-action-dialog=resume] [data-subagent-action=resume]')
  await pause(100)
  assert.equal(await evaluate('window.subagentActions.length'), actionsBeforeResume + 1)
  assert.equal(await evaluate(`document.querySelector('[data-subagent-action-dialog=resume] [data-subagent-action=resume]').disabled`), true, 'pending submit disables the primary action')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2})
  assert.equal(await evaluate('window.subagentActions.length'), actionsBeforeResume + 1, 'pending keyboard activation cannot submit twice')
  assert.deepEqual(await evaluate('window.subagentActions.at(-1)'), { sessionPath: '/ui/session', sessionId: 'child-a', expectedRunId: 'run-a', action: 'resume', message: 'continue with tests' })
  await evaluate(`window.resolveSubagentAction();window.subagentActionMode='resolve'`)
  await pause(350)
  assert.equal(await evaluate(`document.querySelector('[data-subagent-id=child-a]').dataset.subagentStatus`), 'completed', 'Resume success is not rendered optimistically')
  assert.equal(await evaluate(`document.activeElement.dataset.subagentAction`), 'resume')

  // Both locale dictionaries own the complete action surface.
  await evaluate(`window.setLocale('zh-CN');document.querySelector('[data-subagent-id=child-a] [data-subagent-action=resume]').click()`)
  await pause(250)
  const localizedAction = await evaluate(`(()=>{const dialog=document.querySelector('[data-subagent-action-dialog=resume]');return {text:dialog.innerText,aria:dialog.querySelector('textarea').getAttribute('aria-label'),button:dialog.querySelector('[data-subagent-action=resume]').innerText.trim()}})()`)
  assert.match(localizedAction.text, /继续子代理/)
  assert.deepEqual({ aria: localizedAction.aria, button: localizedAction.button }, { aria: '给子代理的指令', button: '继续' })
  await clickSelector('[data-subagent-action-dialog] [data-subagent-action-cancel]')
  await evaluate(`window.setLocale('en')`)
  await pause(300)
  await evaluate(`document.querySelector('[data-subagent-id=child-a] button[aria-expanded]').click()`)
  await pause(200)

  await evaluate(`document.querySelector('[data-subagent-id=child-b] button[aria-expanded]').click()`)
  await pause(200)
  // The panel's inset is the panel's alone: a background bash row in the
  // transcript keeps the shared `ToolResult` inset beside every other tool row.
  assert.equal(await evaluate(`(()=>{const w=document.querySelector('#original [data-bash-task-id]'),i=w.querySelector('button svg');return Math.round(i.getBoundingClientRect().left-w.getBoundingClientRect().left)})()`),0,'a transcript bash row is never inset like a task panel row')
  await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
  await pause(250)
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
  const spinningAngles = await evaluate(`new Promise(resolve=>{const arc=document.querySelector('[data-todo-id=b]').closest('li').querySelector('[data-todo-progress]');const seen=new Set();let n=0;const frame=()=>{seen.add(getComputedStyle(arc).transform);if(++n<12)requestAnimationFrame(frame);else resolve(Array.from(seen))};requestAnimationFrame(frame)})`)
  assert.ok(spinningAngles.length > 1, 'a running task ring really turns: ' + JSON.stringify(spinningAngles))
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
  // The emulated preference reaches the page's media listeners asynchronously; a row
  // mounted before that would keep the preference it read at mount.
  await pause(200)
  await evaluate(`window.setBusy(true);window.setTodos({toolCallId:'long',items:Array.from({length:40},(_,i)=>({id:'long-'+i,content:i===0?'长任务说明'.repeat(24):'检查任务 '+i,status:i===0?'in_progress':'pending'}))});document.querySelector('#tasks').parentElement.style.width='340px'`)
  await pause(250)
  for(let i=0;i<40;i++){if(await evaluate(`document.querySelectorAll('[data-task-panel] [data-todo-id]').length===40`))break;await pause(50)}
  const reduceAngle = await evaluate(`getComputedStyle(document.querySelector('[data-task-panel] [data-todo-id]').closest('li').querySelector('[data-todo-progress]')).transform`)
  await pause(300)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-task-panel] [data-todo-id]').closest('li').querySelector('[data-todo-progress]')).transform`),reduceAngle,'reduced motion keeps a running ring still')
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
  // A completed title that wraps is struck line by line: the strike is real text
  // decoration on the title's wrapper — the browser paints it across every line
  // box — never an overlaid strip, which could only sit at one height.
  await evaluate(`window.setTodos({toolCallId:'wrap-strike',items:[{id:'wrap',content:'长任务说明'.repeat(24),status:'completed'},{id:'plain',content:'检查任务',status:'pending'}]})`)
  await pause(250)
  const strike = await evaluate(`(()=>{const node=document.querySelector('[data-todo-id=wrap]');const wrap=node.parentElement;const style=getComputedStyle(wrap);const range=document.createRange();range.selectNodeContents(node);const rows=new Set(Array.from(range.getClientRects(),rect=>Math.round(rect.top))).size;const pending=getComputedStyle(document.querySelector('[data-todo-id=plain]').parentElement);return{line:style.textDecorationLine,colour:style.textDecorationColor,rows,children:wrap.childElementCount,pendingColour:pending.textDecorationColor}})()`)
  assert.ok(strike.rows>1,'the completed title really wraps: '+JSON.stringify(strike))
  assert.equal(strike.line,'line-through')
  assert.equal(strike.children,1,'no overlaid strip survives beside the title')
  assert.notEqual(strike.colour,'rgba(0, 0, 0, 0)','a completed strike is visible on every wrapped row')
  assert.equal(strike.pendingColour,'rgba(0, 0, 0, 0)','an unfinished row keeps its strike invisible')
  if(process.env.PI_BASH_SCREENSHOT_DIR){
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR,'todo-wrap-strike.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
  }
  // Opening the panel positions the list on the row that matters — the running
  // task, centred — and never parks it on the bottom of the plan the way the
  // vendored list did. Each scenario re-opens the panel, so the list mounts
  // fresh exactly like a user's click on the entry.
  const todoProbe = (id) => `(() => {
    const viewport = document.querySelector('[data-task-panel] ol').parentElement;
    const box = viewport.getBoundingClientRect();
    const node = document.querySelector('[data-todo-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    const rect = node ? node.closest('li').getBoundingClientRect() : null;
    return {scrollTop:Math.round(viewport.scrollTop),max:Math.round(viewport.scrollHeight-viewport.clientHeight),
      offset:rect?Math.round((rect.top+rect.height/2)-(box.top+box.height/2)):null,
      visible:rect?rect.top>=box.top-1&&rect.bottom<=box.bottom+1:false};
  })()`
  const reopenTodoPanel = async () => {
    await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
    await pause(150)
    await evaluate(`document.querySelector('[data-task-trigger=todo]').click()`)
    await pause(350)
  }
  const setPlan = (statusAt) => evaluate(`window.setTodos(${JSON.stringify({ toolCallId: 'placement', items: Array.from({ length: 40 }, (_, i) => ({ id: `pick-${i}`, content: `task ${i}`, status: statusAt(i) })) })})`)
  await setPlan((i) => (i === 24 ? 'in_progress' : 'pending'))
  await reopenTodoPanel()
  const runningRow = await evaluate(todoProbe('pick-24'))
  assert.ok(runningRow.visible, 'opening shows the running task: ' + JSON.stringify(runningRow))
  assert.ok(Math.abs(runningRow.offset) <= 2, 'the running task is centred in the panel: ' + JSON.stringify(runningRow))
  assert.ok(runningRow.scrollTop < runningRow.max, 'opening never parks on the bottom: ' + JSON.stringify(runningRow))
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'todo-panel-running.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  // Nothing running: the newest completed task takes its place.
  await setPlan((i) => (i <= 29 ? 'completed' : 'pending'))
  await reopenTodoPanel()
  const finishedRow = await evaluate(todoProbe('pick-29'))
  assert.ok(finishedRow.visible, 'opening shows the newest completed task: ' + JSON.stringify(finishedRow))
  assert.ok(Math.abs(finishedRow.offset) <= 2, 'the newest completed task is centred: ' + JSON.stringify(finishedRow))
  assert.ok(finishedRow.scrollTop < finishedRow.max, 'a completed target never parks on the bottom either: ' + JSON.stringify(finishedRow))
  // Neither running nor completed: no target, so the list stays where it starts.
  await setPlan(() => 'pending')
  await reopenTodoPanel()
  assert.equal((await evaluate(todoProbe('pick-0'))).scrollTop, 0, 'a plan with nothing running or completed is left at the top')
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
  // The wait threshold is a plain range-limited input: typing is filtered, the
  // value is committed by the row's own Save button.
  await evaluate(`(()=>{const input=document.querySelector('#settings input[aria-label="最大阻塞时长（秒）"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'10.1');input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()`)
  await pause(150)
  await evaluate(`[...document.querySelectorAll('#settings button')].find(b=>b.textContent==='保存').click()`)
  await pause(150)
  assert.equal(await evaluate('window.savedWait'), 10100)
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
  assert.match(await evaluate(`document.querySelector('#group').innerText`), /1 已完成，0 失败.*1 个已取消/s)
  assert.match(await evaluate(`document.querySelector('#original').innerText`), /Cancelled/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#original').innerText`), /Failed/)
  await evaluate(`document.querySelector('#original button[aria-expanded]').click()`)
  const stoppedReads = await evaluate('window.outputReads')
  await pause(1200)
  assert.equal(await evaluate('window.outputReads'), stoppedReads)
  await evaluate('window.startControlFixture()')
  await pause(150)
  await evaluate(`document.querySelector('#silent-task button[aria-expanded]').click()`)
  await pause(150)
  assert.match(await evaluate(`document.querySelector('#silent-task').innerText`),/65s elapsed/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#silent-task').innerText`),/65\.5s elapsed/,'elapsed time reads whole seconds only')
  assert.match(await evaluate(`document.querySelector('#silent-task').innerText`),/Cancelled/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#silent-task').innerText`),/Failed|Output .* ago/,'legacy empty decoder timestamps are not displayed as output')
  assert.match(await evaluate(`document.querySelector('#controls-group').innerText`),/4 completed, 0 failed/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#controls-group').innerText`),/unavailable/,'successful control queries remain available even when their snapshots refer to a running process')
  for(const [action,label] of [['list','List tasks'],['status','Check status'],['output','Read output'],['stop','Stop task']]){
    assert.match(await evaluate(`document.querySelector('#control-${action}').innerText`),new RegExp(label))
    assert.match(await evaluate(`document.querySelector('#control-${action}').innerText`),/0.1s|0.1 s/,'control duration is independent of the process lifetime')
  }
  await evaluate(`window.setLocale('zh-CN')`)
  await pause(100)
  assert.match(await evaluate(`document.querySelector('#control-status').innerText`),/查看状态/)
  assert.match(await evaluate(`document.querySelector('#control-output').innerText`),/读取输出/)
  assert.match(await evaluate(`document.querySelector('#control-stop').innerText`),/停止任务/)
  assert.match(await evaluate(`document.querySelector('#silent-task').innerText`),/已运行 65 秒/)
  assert.doesNotMatch(await evaluate(`document.querySelector('#silent-task').innerText`),/65\.5/,'elapsed time reads whole seconds only')
  assert.doesNotMatch(await evaluate(`document.querySelector('#silent-task').innerText`),/秒前有输出/)
  console.log('PASS: stopped tasks remain cancelled with their full runtime, empty output has no invented timestamp, and successful control calls retain their own action/status/duration.')
  await evaluate('window.startForegroundFixture()')
  await pause(100)
  const foregroundReads = await evaluate('window.outputReads')
  for (const id of ['success', 'error', 'timeout', 'json', 'long', 'live']) {
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
  // The expansion's command header is bounded: a command that fits gets no
  // ramp at all, and a longer one scrolls inside the header with the shared
  // 12px ramp on the edge that really hides lines — bottom at the top, both
  // mid-scroll, top once the reader reaches the end.
  const commandHeader = () => evaluate(`(() => {
    const header = document.querySelector('#foreground-long [data-bash-command]');
    if (!header) return null;
    return { fade: header.dataset.fade, cap: Math.round(header.getBoundingClientRect().height), max: Number.parseFloat(getComputedStyle(header).maxHeight), scroll: header.scrollHeight, short: document.querySelector('#foreground-success [data-bash-command]').dataset.fade };
  })()`)
  const scrollHeader = (top) => evaluate(`document.querySelector('#foreground-long [data-bash-command]').scrollTop = ${top}`)
  const header = await commandHeader()
  assert.equal(header.cap, Math.round(header.max), `the command header stops at its cap: ${JSON.stringify(header)}`)
  assert.ok(header.scroll > header.max * 1.5, `a long command genuinely overflows the header: ${JSON.stringify(header)}`)
  assert.equal(header.short, 'none', 'a command that fits gets no ramp')
  assert.equal(header.fade, 'bottom', 'the hidden bottom edge fades while the header sits at its top')
  await scrollHeader(Math.round((header.scroll - header.cap) / 2))
  await pause(100)
  const midHeader = await commandHeader()
  assert.equal(midHeader.fade, 'both', 'mid-scroll both edges fade')
  await scrollHeader(1e6)
  await pause(100)
  const endHeader = await commandHeader()
  assert.equal(endHeader.fade, 'top', 'the top edge fades once the command is scrolled to its end')
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

  // The "Task finished · <command>" row is fit-width inside an `items-start`
  // column, so a long command used to give the ROW a max-content width: it
  // grew past the column and the transcript's horizontal clip cut its trailing
  // status mark and disclosure off with the overflow. Every row is capped at
  // the column now, and the title absorbs the length by truncating.
  await evaluate('window.resetTurn()')
  await step(`{type:'agent_start',changeScopeId:'scope-a'}`)
  await step(`{type:'message_end',message:window.longNotice(30)}`)
  const longRow = await evaluate(`(()=>{
    const root=document.querySelector('#turn-fixture [data-bash-task-id]');
    const trigger=root.querySelector('[data-agent-trigger]');
    const column=trigger.closest('.overflow-x-clip');
    const title=root.querySelector('[data-tool-result-title]');
    const marks=[...trigger.children].filter(node=>node!==trigger.firstElementChild&&/shrink-0/.test(String(node.className)));
    const box=(node)=>{const r=node.getBoundingClientRect();return {right:Math.round(r.right*10)/10,width:Math.round(r.width*10)/10}};
    return {column:box(column),row:box(trigger),titleTruncated:title.scrollWidth>title.clientWidth+1,
      marks:marks.map(node=>({...(box(node)),text:node.textContent.slice(0,10)}))};
  })()`)
  assert.ok(longRow.row.width <= longRow.column.width + 0.5, 'a long completion title does not widen the row: ' + JSON.stringify(longRow))
  assert.equal(longRow.titleTruncated, true, 'the command truncates inside the row: ' + JSON.stringify(longRow))
  assert.ok(longRow.marks.length >= 2, 'the row keeps its status mark and disclosure: ' + JSON.stringify(longRow))
  assert.ok(
    longRow.marks.every((mark) => mark.width > 0 && mark.right <= longRow.column.right + 0.5),
    'and both stay inside the clipped column: ' + JSON.stringify(longRow)
  )
  await finish(40)
  turnState = await evaluate('window.turnRead()')
  assert.equal(turnState.notices, 1, 'the long notice settles into the fold')
  await evaluate('window.resetTurn()')
  await step(`{type:'message_end',message:window.notice(30)}`)
  await finish(40)

  // Transcript context menu: one menu for the whole surface, its target
  // resolved from the row marker under the pointer, so no row owns a trigger.
  const openRowMenu = async (selector) => {
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const r=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.x+12),clientY:Math.round(r.y+12)}))})()`)
    await pause(150)
  }
  const menuItems = () => evaluate(`Array.from(document.querySelectorAll('[data-context-menu-portal]')).filter(p=>p.getAttribute('aria-hidden')==='false').flatMap(p=>Array.from(p.querySelectorAll('[role=menuitem]'))).map(i=>({label:i.textContent.trim(),disabled:i.disabled}))`)
  const menuOpen = () => evaluate(`Array.from(document.querySelectorAll('[data-context-menu-portal]')).some(p=>p.getAttribute('aria-hidden')==='false')`)
  await openRowMenu('#turn-fixture [data-rail-id]')
  assert.deepEqual(await menuItems(), [
    { label: 'Copy message', disabled: false },
    { label: 'Edit and resend', disabled: false },
    { label: 'Rewind', disabled: false }
  ], 'a user row opens the message menu')
  await evaluate(`(()=>{const p=Array.from(document.querySelectorAll('[data-context-menu-portal]')).find(p=>p.getAttribute('aria-hidden')==='false');Array.from(p.querySelectorAll('[role=menuitem]')).find(i=>i.textContent.trim()==='Copy message').click()})()`)
  await pause(80)
  assert.equal(await evaluate('navigator.clipboard.readText()'), 'original request', 'Copy message writes the user text')
  assert.equal(await evaluate(`document.querySelectorAll('#turn-fixture [data-context-menu-portal]').length`), 0, 'the transcript menu is portalled outside the transcript container')
  await openRowMenu('#turn-fixture [data-assistant-group]')
  assert.deepEqual(await menuItems(), [
    { label: 'Copy reply', disabled: false },
    { label: 'Retry response', disabled: false },
    { label: 'Fork from here', disabled: false }
  ], 'an assistant row opens the reply menu')
  await evaluate(`(()=>{const p=Array.from(document.querySelectorAll('[data-context-menu-portal]')).find(p=>p.getAttribute('aria-hidden')==='false');Array.from(p.querySelectorAll('[role=menuitem]')).find(i=>i.textContent.trim()==='Retry response').click()})()`)
  await pause(80)
  assert.equal(await evaluate('window.menuResends.length'), 1, 'Retry targets the turn-opening user message')
  assert.equal(await evaluate('window.menuResends[0].timestamp'), 10)
  // A right-click that resolves no message row must not open an empty panel.
  await openRowMenu('#turn-fixture [data-slot="message-group"]')
  assert.equal(await menuOpen(), false, 'a row with no actions opens no menu')
  // Escape closes and the menu bubble is gone even since the row it named.
  await openRowMenu('#turn-fixture [data-rail-id]')
  assert.equal(await menuOpen(), true)
  await evaluate(`(()=>{const p=Array.from(document.querySelectorAll('[data-context-menu-portal]')).find(p=>p.getAttribute('aria-hidden')==='false');p.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`)
  await pause(80)
  assert.equal(await menuOpen(), false, 'Escape closes the transcript menu')
  console.log('PASS: transcript context menu — row-resolved target, copy/retry/fork, no empty panel, Escape.')
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

  // A run that ENDED on a failure is prose about the turn, not a status banner:
  // the text renders inside the turn, unframed, at body size in the error
  // colour, directly ABOVE the retry/fork row it explains. In-flight notices
  // keep the framed status row below the transcript.
  await evaluate('window.resetTurn()')
  await step(`{type:'agent_start',changeScopeId:'scope-a'}`)
  await step(`{type:'message_end',message:{role:'user',timestamp:100,content:'rate limited request'}}`)
  await step(`{type:'message_start',message:window.round(110,[],'scope-a')}`)
  await step(`{type:'message_end',message:{...window.round(110,[],'scope-a'),stopReason:'error',errorMessage:'429 rate limited'}}`)
  await step(`{type:'agent_end'}`)
  await step(`{type:'agent_settled'}`, 1)
  await step(`{type:'auto_retry_end',success:false,finalError:'429 rate limited'}`, 1)
  assert.equal(await evaluate(`document.querySelector('#turn-fixture [data-turn-failure]').closest('[data-turn-process]').parentElement.getAttribute('aria-hidden')`), 'true', 'terminal retry failures belong inside the collapsed process')
  await evaluate(`document.querySelector('#turn-fixture [data-turn-failure]').closest('[data-turn-process]').parentElement.previousElementSibling.querySelector('button').click()`)
  await pause(260)
  const failure = await evaluate(`(() => {
    const node = document.querySelector('#turn-fixture [data-turn-failure]');
    if (!node) return null;
    const retry = node.closest('[data-assistant-group]').querySelector('button[aria-label="Retry response"]');
    const style = getComputedStyle(node);
    const boxes = [];
    for (let el = node; el && !el.hasAttribute('data-assistant-group'); el = el.parentElement) {
      const s = getComputedStyle(el);
      boxes.push({ tag: el.tagName, bg: s.backgroundColor, border: s.borderTopWidth, pad: s.paddingTop });
    }
    return { tag: node.tagName, text: node.innerText, color: style.color, size: style.fontSize, leading: style.lineHeight,
      shadow: style.boxShadow, top: Math.round(node.getBoundingClientRect().top),
      retryTop: retry ? Math.round(retry.getBoundingClientRect().top) : null,
      count: document.querySelectorAll('#turn-fixture [data-turn-failure]').length, boxes };
  })()`)
  const failureTone = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = ${JSON.stringify(failure.color)}; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  })()`)
  assert.ok(failure, 'the failed turn renders its failure text')
  assert.equal(failure.tag, 'P', 'the failure is plain prose, not a banner element')
  assert.equal(failure.count, 1, 'the failure text is rendered once, by the turn itself')
  assert.match(failure.text, /Request failed after retries · 429 rate limited/)
  assert.ok(failureTone.r > failureTone.g + 24 && failureTone.r > failureTone.b + 24, 'the failure text wears the error colour: ' + JSON.stringify({ color: failure.color, tone: failureTone }))
  assert.equal(failure.size, '14px', 'the failure uses body size')
  assert.equal(failure.leading, '24px', 'the failure uses the body line height')
  assert.equal(failure.shadow, 'none')
  assert.notEqual(failure.retryTop, null, 'the failed turn keeps its retry row')
  assert.ok(failure.top < failure.retryTop, `the failure sits above the retry row (${failure.top} < ${failure.retryTop})`)
  for (const box of failure.boxes) {
    assert.equal(box.border, '0px', 'no frame around the failure text: ' + JSON.stringify(box))
    assert.equal(box.bg, 'rgba(0, 0, 0, 0)', 'no surface behind the failure text: ' + JSON.stringify(box))
  }
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_BASH_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'turn-failure.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await step(`{type:'auto_retry_start',attempt:1,maxAttempts:3}`, 1)
  assert.equal(await evaluate(`document.querySelectorAll('#turn-fixture [data-turn-failure]').length`), 0, 'an in-flight retry is not turn prose')
  const retrying = await evaluate(`(() => {
    const node = document.querySelector('#turn-fixture [data-turn-notice]');
    if (!node) return { found: false, text: document.querySelector('#turn-fixture').innerText };
    const style = getComputedStyle(node);
    return { found: true, text: node.innerText, bg: style.backgroundColor, radius: style.borderTopLeftRadius };
  })()`)
  assert.ok(retrying.found, 'an in-flight notice renders: ' + JSON.stringify(retrying))
  assert.match(retrying.text, /retrying \(attempt 1 of 3\)/, 'the in-flight sentence is the retrying one')
  assert.notEqual(retrying.bg, 'rgba(0, 0, 0, 0)', 'an in-flight notice keeps its framed status row: ' + JSON.stringify(retrying))
  // The frame's corner comes from the theme token, so assert it against the
  // token itself: the square-style branch resolves every step to 0, and a
  // hardcoded non-zero radius would fail there for the wrong reason.
  const controlRadius = await evaluate(`(() => { const probe = document.createElement('div'); probe.style.borderRadius = 'var(--app-radius-control)'; document.body.appendChild(probe); const value = getComputedStyle(probe).borderTopLeftRadius; probe.remove(); return value })()`)
  assert.equal(retrying.radius, controlRadius, 'the status row keeps the theme radius token: ' + JSON.stringify({ radius: retrying.radius, controlRadius }))
  await step(`{type:'auto_retry_end',success:true}`, 1)

  // A compaction reads as a tool row, because that is what it is: one job runs
  // over the conversation, the row waits on it, and the summary is its result.
  const summaryRows = (kind, state) =>
    `#turn-fixture [data-summary-row="${kind}"]` + (state ? `[data-state="${state}"]` : '')
  const rowCount = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const press = async (selector) => {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pause(300)
  }
  await step(`{type:'compaction_start',reason:'manual'}`, 1)
  assert.equal(await rowCount(summaryRows('compaction', 'running')), 1, 'a running compaction shows a running row')
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(summaryRows('compaction', 'running'))}).firstElementChild.getAttribute('aria-busy')`),
    'true',
    'the running row reports itself busy, like any tool execution'
  )
  await step(`{type:'compaction_end',errorMessage:'context window exhausted'}`, 1)
  const failedCompaction = await evaluate(`(()=>{
    const row = document.querySelector(${JSON.stringify(summaryRows('compaction', 'error'))});
    return row ? { text: row.innerText, busy: row.firstElementChild.getAttribute('aria-busy') } : null;
  })()`)
  assert.ok(failedCompaction, 'a failed compaction renders an error row: ' + JSON.stringify(failedCompaction))
  assert.equal(failedCompaction.busy, 'false')
  assert.match(failedCompaction.text, /Summarize context/, 'the row names the job')
  assert.match(failedCompaction.text, /context window exhausted/, 'the reason is readable without a click: ' + failedCompaction.text)
  assert.equal(await rowCount('#turn-fixture [data-turn-failure]'), 0, 'a compaction failure is not turn prose')
  assert.equal(await rowCount('#turn-fixture [data-turn-notice]'), 0, 'and not the framed retry status row either')
  await step(`{type:'compaction_end'}`, 1)
  assert.equal(await rowCount('#turn-fixture [data-summary-row="compaction"]'), 0, 'a compaction that produced no summary leaves no row')

  // A settled compaction is known through the session entry the SDK writes, and
  // it must read at the BOTTOM. The context array opens with the summary — every
  // entry it replaced is gone and only the kept tail follows it — so rendering
  // that order verbatim pinned the row above the very conversation it
  // summarizes. It is placed by time instead, after the tail it kept.
  //
  // The summary carries the SDK's own trailing file sections, one path per line
  // between `<read-files>`/`<modified-files>` tags — a convention between the
  // SDK and the model that markdown cannot render, so the row draws them as
  // lists of file links. The fenced block quotes the same tags and must be left
  // exactly as it was written.
  await evaluate(`window.summaryText = [
    '## Kept decisions', '', 'The attachment intake was unified.', '',
    '~~~', '<read-files>', 'src/quoted.ts', '</read-files>', '~~~', '',
    '<read-files>', 'src/a.ts', '/tmp/shot.png', '</read-files>', '',
    '<modified-files>', 'AGENTS.md', '</modified-files>'
  ].join('\\n')`)
  await step(`{type:'compaction_end',messages:[
    {role:'compactionSummary',summary:window.summaryText,tokensBefore:120000,timestamp:900},
    {role:'user',timestamp:10,content:'original request'},
    window.round(20,[window.writeCall('write-a','a.ts')]),
    window.result('write-a'),
    window.round(25,window.prose('kept answer'))
  ]}`, 1)
  const settled = await evaluate(`(()=>{
    const row = document.querySelector(${JSON.stringify(summaryRows('compaction', 'success'))});
    if (!row) return null;
    const trigger = row.querySelector('button');
    const turns = [...document.querySelectorAll('#turn-fixture [data-assistant-group]')].map((node) => node.getBoundingClientRect().top);
    return {
      top: row.getBoundingClientRect().top,
      height: row.getBoundingClientRect().height,
      lowestTurn: turns.length ? Math.max(...turns) : null,
      open: trigger.getAttribute('aria-expanded'),
      text: row.innerText,
      hasBody: row.textContent.includes('Kept decisions')
    };
  })()`)
  assert.ok(settled, 'the settled compaction renders its summary row: ' + JSON.stringify(settled))
  assert.equal(settled.open, 'false', 'a summary stays collapsed until it is asked for')
  assert.equal(settled.hasBody, false, 'the summary body is not mounted while collapsed')
  assert.match(settled.text, /Summarize context/, `the row names the job: ${settled.text}`)
  assert.match(settled.text, /120\.0k tokens before summarization/, `the row carries the preceding context size: ${settled.text}`)
  assert.ok(settled.height < 60, `the row is one tool row tall: ${settled.height}`)
  assert.ok(
    settled.lowestTurn !== null && settled.top > settled.lowestTurn,
    `the summary sits BELOW the tail it kept (${settled.top} > ${settled.lowestTurn})`
  )
  await evaluate(`document.querySelector(${JSON.stringify(summaryRows('compaction', 'success'))}).scrollIntoView({ block: 'center' })`)
  await pause(150)
  await press(summaryRows('compaction', 'success') + ' button')
  const expanded = await evaluate(`(()=>{
    const row = document.querySelector(${JSON.stringify(summaryRows('compaction', 'success'))});
    return { open: row.querySelector('button').getAttribute('aria-expanded'), hasBody: row.textContent.includes('Kept decisions') };
  })()`)
  assert.equal(expanded.open, 'true', 'the trigger expands the row')
  assert.equal(expanded.hasBody, true, 'expanding mounts the summary itself')

  // The trailing file sections render as two bulleted lists of file links, and
  // the quoted copy inside the fence is none of their business.
  const files = await evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(summaryRows('compaction', 'success'))});
    const groups = [...row.querySelectorAll('[data-summary-file-group]')];
    const links = [...row.querySelectorAll('[data-file-link]')];
    const list = row.querySelector('ul');
    const style = links.length ? getComputedStyle(links[0]) : null;
    return {
      labels: groups.map((group) => group.querySelector('p').textContent),
      links: links.map((link) => link.textContent),
      hrefs: [...row.querySelectorAll('ul li')].length,
      bullet: list ? getComputedStyle(list).listStyleType : null,
      underline: style ? style.textDecorationLine : null,
      colour: style ? style.color : null,
      quoted: row.textContent.includes('src/quoted.ts')
    };
  })()`)
  assert.deepEqual(files.labels, ['Files read', 'Files modified'], `the sections are labelled in the UI language: ${JSON.stringify(files.labels)}`)
  assert.deepEqual(files.links, ['src/a.ts', '/tmp/shot.png', 'AGENTS.md'], `read then modified, in the summary's order: ${JSON.stringify(files.links)}`)
  assert.equal(files.hrefs, 3)
  assert.equal(files.bullet, 'disc', `the sections are unordered lists: ${files.bullet}`)
  assert.equal(files.underline, 'none', `a file action has no resting underline: ${files.underline}`)
  assert.notEqual(files.colour, 'rgb(0, 0, 0)', 'the link wears the theme colour')
  assert.ok(files.quoted, 'the fenced quote of the same tags is still rendered as code')
  const fileLinkPoint = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(summaryRows('compaction', 'success') + ' [data-file-link]')}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:fileLinkPoint.x, y:fileLinkPoint.y })
  await pause(180)
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(summaryRows('compaction', 'success') + ' [data-file-link]')})).backgroundColor`), 'rgba(0, 0, 0, 0)', 'hovering the file action fills it')
  await press(summaryRows('compaction', 'success') + ' [data-file-link]')
  assert.deepEqual(
    await evaluate('window.openPaths.map((path) => path.endsWith("src/a.ts"))'),
    [true],
    'clicking a path opens it, like any other file link: ' + JSON.stringify(await evaluate('window.openPaths'))
  )
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'compaction-row.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await step(`{type:'compaction_end',aborted:true,result:{tokensBefore:90000,estimatedTokensAfter:10000}}`, 1)
  assert.equal(await rowCount('#turn-fixture [data-summary-row="compaction"]'), 1, 'an aborted compaction is not a completion and adds nothing')

  // A branch summary is the same kind of entry and reads the same way.
  await step(`{type:'compaction_end',messages:[
    {role:'branchSummary',summary:'Abandoned that branch.',fromId:null,timestamp:950},
    {role:'user',timestamp:10,content:'original request'}
  ]}`, 0)
  assert.equal(await rowCount(summaryRows('branch', 'success')), 1, 'a branch summary renders a row of the same shape')

  // Compaction is an ordinary process row immediately before the live spinner,
  // both between tool rounds and before the first assistant response exists.
  const compactionPlacement = () => evaluate(`(() => {
    const root = document.querySelector('#turn-fixture');
    const summary = root.querySelector('[data-summary-row="compaction"]');
    const spinners = [...root.querySelectorAll('[data-spinner-loader]')];
    const spinner = spinners[0];
    const title = summary?.querySelector('[data-tool-result-title]');
    const toolTitle = [...root.querySelectorAll('[data-tool-result-title]')].find(node => !node.closest('[data-summary-row]'));
    const geometry = node => {
      if (!node) return null;
      const box = node.closest('[data-agent-trigger]').getBoundingClientRect();
      const style = getComputedStyle(node);
      return { width:box.width, height:box.height, left:box.left, font:style.fontSize, weight:style.fontWeight, color:style.color };
    };
    return { spinners:spinners.length, summary:Boolean(summary), hosted:Boolean(summary?.closest('[data-assistant-group]')),
      before:!!summary&&!!spinner&&summary.getBoundingClientRect().bottom<=spinner.getBoundingClientRect().top,
      summaryGeometry:geometry(title), toolGeometry:geometry(toolTitle), text:summary?.innerText };
  })()`)
  await evaluate(`window.turnStore.applySnapshot(window.turnSnapshot([
    {role:'user',timestamp:10,content:'inspect before compaction'},
    window.round(20,[{type:'toolCall',name:'bash',id:'compaction-bash',arguments:{command:'true'}}]),
    {role:'toolResult',toolCallId:'compaction-bash',toolName:'bash',timestamp:21,content:[{type:'text',text:'done'}],isError:false}
  ]))`)
  await step(`{type:'compaction_start',reason:'manual'}`)
  let placement = await compactionPlacement()
  assert.equal(placement.spinners, 1, 'compaction keeps exactly one live spinner')
  assert.equal(placement.hosted, true, 'between-round compaction belongs to the live assistant group')
  assert.equal(placement.before, true, 'the compaction row sits above the live spinner')
  assert.deepEqual(placement.summaryGeometry, placement.toolGeometry, 'compaction shares ordinary tool width, height and title styling')
  assert.equal(await rowCount('#turn-fixture [data-turn-process]'), 0, 'compaction does not fold the live process')
  if (process.env.PI_BASH_SCREENSHOT_DIR) {
    await pause(300)
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, 'compaction-before-spinner.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }
  await step(`{type:'compaction_end',errorMessage:'summary provider failed'}`)
  placement = await compactionPlacement()
  assert.equal(placement.before, true, 'an error row also stays above the live spinner')
  assert.match(placement.text, /summary provider failed/, 'changing from running to failure opens the reason')
  await step(`{type:'compaction_end'}`)
  assert.equal((await compactionPlacement()).summary, false, 'completion clears the transient process row')
  assert.equal((await compactionPlacement()).spinners, 1, 'completion keeps the ongoing turn spinner')
  await step(`{type:'message_start',message:window.round(30,[])}`)
  assert.equal((await compactionPlacement()).spinners, 1, 'the next streaming response retains one spinner')
  await step(`{type:'agent_settled'}`)
  assert.equal((await compactionPlacement()).spinners, 0, 'settlement removes the live spinner')

  await evaluate(`window.turnStore.applySnapshot(window.turnSnapshot([{role:'user',timestamp:40,content:'compact before a response'}]))`)
  await step(`{type:'compaction_start',reason:'manual'}`)
  placement = await compactionPlacement()
  assert.equal(placement.hosted, false, 'before a response the compaction uses the standalone slot')
  assert.equal(placement.spinners, 1)
  assert.equal(placement.before, true, 'the standalone compaction also precedes the spinner')
  await step(`{type:'compaction_end'}`)
  await step(`{type:'agent_settled'}`)
  await step(`{type:'compaction_start',reason:'manual'}`)
  assert.equal((await compactionPlacement()).spinners, 0, 'idle compaction does not invent an agent turn spinner')
  assert.equal((await compactionPlacement()).summary, true, 'idle compaction retains its ordinary tool row')
  await step(`{type:'compaction_end'}`)
  console.log('PASS: compaction uses ordinary tool geometry above one spinner in live and standalone paths, with readable errors and clean continuation.')

  assert((await evaluate('window.frameCount')) > 20)
  assert.deepEqual(await evaluate('window.frameFailures'), [], 'no painted frame may expose an intermediate file list')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS: real ChatView/PiStore frame-by-frame steer, idle server continuation, cumulative files/review, distinct user folds and snapshot restoration without flashing cards.')
  await checkContinueUi(evaluate, pause)
  await checkTurnFoldUi(evaluate, pause, async name => {
    if (!process.env.PI_BASH_SCREENSHOT_DIR) return
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  })
  await checkCompactionUi(evaluate, pause, clickSelector, async name => {
    if (!process.env.PI_BASH_SCREENSHOT_DIR) return
    await writeFile(join(process.env.PI_BASH_SCREENSHOT_DIR, name + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  })
  await evaluate('window.startStartupFixture()')
  await evaluate(`window.setLocale('en')`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('#startup-fixture [role="status"]').getAttribute('aria-label')`), 'Preparing session tools…')
  assert.equal(await evaluate(`!document.querySelector('#startup-fixture [data-prompt-editor]').isContentEditable`), false, 'startup keeps draft editing available')
  await evaluate(`document.querySelector('#startup-fixture [data-prompt-editor]').focus()`)
  await send('Input.insertText', { text:'preserve my draft' })
  assert.equal(await evaluate(`document.querySelector('#startup-fixture button[type="submit"]').disabled`), true)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await evaluate('window.startupSends.length'), 0, 'Enter cannot submit before tools are ready')
  assert.equal(await evaluate(`document.querySelector('#startup-fixture [data-prompt-editor]').textContent`), 'preserve my draft')
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
  await evaluate('window.startJevFixture()'); await pause(150)
  await evaluate(`window.setLocale('en')`)
  assert.equal(await evaluate('window.jevReads'), 0, 'closed taskbar entry never fetches audit')
  const transcriptTop = await evaluate(`document.querySelector('#jev-transcript').getBoundingClientRect().top`)
  assert.equal(await evaluate(`document.querySelector('#jev-fixture [role=group] [data-jev-trigger]').getAttribute('data-task-trigger')`), 'jev', 'Jev belongs to the shared task toolbar')
  assert.equal(await evaluate(`document.querySelector('[data-task-trigger=jev]').getBoundingClientRect().top === document.querySelector('[data-task-trigger=bash]').getBoundingClientRect().top`), true, 'Jev sits on the background-task row')
  await clickSelector('[data-jev-trigger]'); await pause(350)
  assert.equal(await evaluate(`document.querySelector('#jev-transcript').getBoundingClientRect().top`), transcriptTop, 'Jev overlay never pushes chat')
  assert.equal(await evaluate(`document.querySelector('[data-task-panel="jev"]').getAttribute('aria-hidden')`), 'false')
  assert.equal(await evaluate('window.jevDetailReads'), 0, 'full evidence is loaded lazily')
  await clickSelector('[data-jev-judgment] [data-agent-trigger]'); await pause(350)
  assert.equal(await evaluate('window.jevDetailReads'), 1)
  const judgment = await evaluate(`document.querySelector('[data-jev-judgment]').textContent`)
  assert.match(judgment, /Original Jev output/); assert.match(judgment, /0.92/); assert.match(judgment, /attachmentsOmitted/)
  assert.match(judgment, /App correction/); assert.match(judgment, /Change the layout/)
  assert.match(judgment, /Inspect the modified settings layout/)
  await evaluate(`window.jevSetState(state=>({...state,seq:state.seq+1,phase:'paused',reason:'no_progress'}))`); await pause(120)
  assert.match(await evaluate(`document.querySelector('[data-task-panel="jev"]').textContent`), /Review did not converge/)
  assert.equal(await evaluate(`document.querySelector('#jev-transcript').getBoundingClientRect().top`), transcriptTop)
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
    await pause(100)
    const scroll = await evaluate(`(()=>{const el=document.querySelector('#jev-fixture [data-fade-scroll]');return{height:el.clientHeight,width:getComputedStyle(el).scrollbarWidth,fade:el.dataset.fade}})()`)
    assert(scroll.height <= 264); assert.equal(scroll.width, 'none'); assert.notEqual(scroll.fade, 'none')
    if (process.env.PI_JEV_SCREENSHOT_DIR) { await mkdir(process.env.PI_JEV_SCREENSHOT_DIR, {recursive:true}); const shot=await send('Page.captureScreenshot',{format:'png'}); await writeFile(join(process.env.PI_JEV_SCREENSHOT_DIR,'jev-panel-'+theme+'.png'),Buffer.from(shot.data,'base64')) }
  }
  await evaluate(`window.setLocale('zh-CN')`); await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-jev-judgment]').textContent`), /Jev 原始输出/)
  assert.match(await evaluate(`document.querySelector('[data-task-panel="jev"]').textContent`), /校验未收敛/)
  assert.equal(await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`), false, 'closing Jev consumes Escape before stop')
  await pause(250)
  assert.equal(await evaluate(`document.activeElement.hasAttribute('data-jev-trigger')`), true, 'Escape restores taskbar focus')
  assert.equal(await evaluate(`document.querySelector('[data-jev-trigger]').getAttribute('aria-expanded')`), 'false')
  await evaluate(`window.jevSetTodos({items:[{id:'todo',content:'Task',status:'pending'}],retainedItems:[]})`); await pause(150)
  await clickSelector('[data-task-trigger="todo"]'); await pause(250)
  await clickSelector('[data-jev-trigger]'); await pause(250)
  assert.equal(await evaluate(`document.querySelector('[data-task-panel]').dataset.taskPanel`), 'jev', 'Jev replaces existing task overlay')
  await clickSelector('[data-task-trigger="todo"]'); await pause(250)
  assert.equal(await evaluate(`document.querySelector('[data-jev-trigger]').getAttribute('aria-expanded')`), 'false')
  assert.equal(await evaluate(`document.querySelector('[data-task-panel]').dataset.taskPanel`), 'todo', 'task trigger closes Jev')
  await clickSelector('[data-jev-trigger]'); await pause(250)
  await clickSelector('[data-jev-trigger]'); await pause(250)
  assert.equal(await evaluate(`document.querySelector('[data-jev-trigger]').getAttribute('aria-expanded')`), 'false', 'taskbar button toggles Jev closed')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS: Jev taskbar entry, shared overlay exclusivity, fixed chat geometry, lazy audit detail, original/corrected decisions, bilingual output, both themes and Escape focus.')
  // Consolidated queue coverage: test action dispatch and duplicate-message
  // identity in this existing browser, without a second style-only harness.
  await evaluate('window.startQueueFixture()')
  await evaluate(`window.setLocale('en')`); await pause(100)
  const queueRows = await evaluate(`Array.from(document.querySelectorAll('#queue-fixture [data-queue-row]')).map(row=>({text:row.textContent,actions:Array.from(row.querySelectorAll('button')).map(button=>button.getAttribute('aria-label'))}))`)
  assert.equal(queueRows.length, 3, 'duplicate queued messages keep separate rows')
  assert.deepEqual(queueRows[0].actions, ['Remove from queue'], 'steers only offer removal')
  assert.deepEqual(queueRows[1].actions, ['Send now', 'Remove from queue'])
  assert.deepEqual(queueRows[2].actions, queueRows[1].actions)
  await evaluate(`document.querySelectorAll('#queue-fixture [data-queue-row]')[0].querySelector('button').click();document.querySelectorAll('#queue-fixture [data-queue-row]')[2].querySelector('button[aria-label="Send now"]').click();document.querySelectorAll('#queue-fixture [data-queue-row]')[2].querySelector('button[aria-label="Remove from queue"]').click();document.querySelector('#queue-fixture button[aria-label="Recall to input"]').click()`)
  assert.deepEqual(await evaluate('window.queueActions'), [
    {action:'remove',kind:'steering',index:0}, {action:'promote',index:1},
    {action:'remove',kind:'followUp',index:1}, {action:'recall'}
  ], 'actions identify the correct kind and duplicate-message index')
  await evaluate(`window.setLocale('zh-CN')`); await pause(100)
  assert.match(await evaluate(`document.querySelector('#queue-fixture').textContent`), /已排队 · 3/)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#queue-fixture [data-queue-row]')[1].querySelectorAll('button')).map(button=>button.getAttribute('aria-label'))`), ['立即发送', '移出队列'])
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS: queued message removal, promotion, recall and duplicate indices in both locales.')
  await evaluate('window.startQueueFixture(true)')
  await evaluate(`window.setLocale('en')`); await pause(250)
  assert.equal(await evaluate(`document.querySelectorAll('#queue-fixture [data-queue-row]').length`), 3, 'pending compaction does not become a user message row')
  assert.match(await evaluate(`document.querySelector('#queue-fixture').textContent`), /Queued · 4/)
  assert.match(await evaluate(`document.querySelector('[data-queue-compaction]').textContent`), /Context compaction queued.*Runs after the current reply and tool calls finish/)
  assert.equal(await evaluate(`document.querySelector('[data-queue-compaction] svg[data-app-icon]').dataset.appIcon`), 'Minimize2', 'the action has its own compaction glyph')
  assert.equal(await evaluate(`document.querySelector('[data-queue-compaction]').querySelectorAll('button').length`), 0, 'system action has no message controls')
  await evaluate(`document.querySelector('#queue-fixture button[aria-label="Recall to input"]').click();window.setQueueMessages({steering:[],followUp:[]})`)
  await pause(250)
  assert.deepEqual(await evaluate('window.queueActions'), [{action:'recall'}])
  assert.match(await evaluate(`document.querySelector('#queue-fixture').textContent`), /Queued · 1/)
  assert.equal(await evaluate(`document.querySelector('#queue-fixture').querySelectorAll('button').length`), 0, 'after message recall the action stays without an empty recall control')
  await evaluate(`window.setLocale('zh-CN')`); await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-queue-compaction]').textContent`), /等待压缩上下文.*当前回复与工具调用完成后执行/)
  await evaluate(`window.setLocale('zh-TW')`); await pause(100)
  assert.match(await evaluate(`document.querySelector('[data-queue-compaction]').textContent`), /等待壓縮上下文.*目前回覆與工具呼叫完成後執行/)
  await evaluate('window.setQueueCompaction(false)'); await pause(300)
  assert.equal(await evaluate(`document.querySelector('[data-queue-panel]')===null`), true, 'clearing the last pending action removes the queue panel')
  console.log('PASS: specialized compaction row coexists with messages, survives message recall, clears on execution and renders all three locales.')
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
