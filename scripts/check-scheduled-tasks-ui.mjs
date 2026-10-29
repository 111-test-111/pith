/**
 * Built-app smoke check for the scheduled view, editor and menus.
 * Uses an isolated Electron profile and synthetic IPC; no user tasks run.
 * Run after npm run build. PI_SCHEDULED_SCREENSHOT_DIR retains screenshots.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-scheduled-ui-'))
const samplePrompt = ['## Overview', '', 'A **rendered** task instruction.', '', ...Array.from({ length: 48 }, (_, index) => `- Item ${index + 1}: Review the scheduled task output.`)].join('\n')
const sampleRunOutput = ['## Full output', '', 'A **rendered** run result.', '', ...Array.from({ length: 180 }, (_, index) => `Paragraph ${index + 1}: This complete scheduled run paragraph is retained beyond the shortened history excerpt.`), '', 'FINAL_OUTPUT_SENTINEL'].join('\n\n')
assert.ok(sampleRunOutput.length > 12_000)
const runDate = (daysAgo, hour) => {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString()
}
const runDates = { latest: runDate(0, 2), earlier: runDate(0, 1), yesterday: runDate(1, 2), oldest: runDate(2, 2) }
const localDateKey = (iso) => {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child, ws

try {
  const main = join(temporary, 'main.cjs')
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, `import {contextBridge,ipcRenderer} from 'electron';
import ${JSON.stringify(join(repo, 'out/preload/index.mjs'))};
contextBridge.exposeInMainWorld('__scheduledFixture',{mutationCalls:()=>ipcRenderer.invoke('fixture:mutationCalls')});`)
  await build({ stdin: { contents: `
import {app,BrowserWindow,ipcMain} from 'electron';
import {windowChromeOptions,setWindowTheme} from ${JSON.stringify(join(repo, 'src/main/window-chrome.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{
 const model={providerId:'fixture',providerName:'Fixture',id:'reasoning',name:'Reasoning model',reasoning:true,thinkingLevels:['off','low','high'],input:['text'],contextWindow:128000,maxTokens:8192,available:true,costInputPerM:0,costOutputPerM:0};
 const models=[model,...Array.from({length:63},(_,index)=>({...model,id:'extra-'+index,name:'Fixture model '+(index+1),reasoning:index%2===0,thinkingLevels:index%2===0?['off','low','high']:['off']}))];
 const snapshot=(path='/fixture/session.jsonl')=>({sessionId:path==='/fixture/run.jsonl'?'fixture-run-session':'fixture',sessionPath:path,cwd:'/workspace/pi-app',projectless:false,messages:path==='/fixture/run.jsonl'?[{role:'user',content:'Scheduled task',timestamp:Date.now()-2000},{role:'assistant',content:[{type:'text',text:'## Run conversation'}],provider:'fixture',model:'reasoning',stopReason:'stop',timestamp:Date.now()-1000}]:[],model,thinkingLevel:'high',availableThinkingLevels:['off','low','high'],isStreaming:false,scheduledTaskSession:path==='/fixture/run.jsonl',eventSequence:0});
 const sampleTask={id:'fixture-task',revision:1,name:'Fixture task',prompt:${JSON.stringify(samplePrompt)},target:{type:'new_session',cwd:'/workspace/pi-app',environment:'local'},schedule:{type:'interval',minutes:60},status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nextRunAt:new Date(Date.now()+3600000).toISOString()};
 const runDates=${JSON.stringify(runDates)};
 const sampleRun={id:'fixture-run',taskId:'fixture-task',taskName:'Fixture task',status:'succeeded',trigger:'manual',scheduledFor:runDates.latest,createdAt:runDates.latest,startedAt:runDates.latest,finishedAt:runDates.latest,sessionId:'fixture-run-session',sessionPath:'/fixture/run.jsonl',cwd:'/workspace/pi-app',summary:${JSON.stringify(sampleRunOutput.slice(0, 12_000))}};
 const olderRun=(id,time)=>({...sampleRun,id,taskName:id,scheduledFor:time,createdAt:time,startedAt:time,finishedAt:time,sessionId:undefined,sessionPath:undefined,summary:'Older result',readAt:time});
 const runs=[olderRun('fixture-oldest',runDates.oldest),sampleRun,olderRun('fixture-yesterday',runDates.yesterday),olderRun('fixture-earlier',runDates.earlier)];
 const tasks=()=>({tasks:[sampleTask],runs,serverTime:new Date().toISOString(),defaultPermissionMode:'workspace-write',dedicatedRoot:'/fixture/home/pi-workspace/scheduled_tasks',unreadCount:1});
 ipcMain.handle('app:info',()=>({cwd:'/workspace/pi-app',folders:['/workspace/pi-app'],version:'fixture',contextFiles:true,bashMaxWaitMs:10000}));
 ipcMain.handle('pi:init',()=>snapshot());
 ipcMain.handle('pi:newSession',()=>snapshot());
 ipcMain.handle('pi:openSession',(_,path)=>snapshot(path));
 ipcMain.handle('pi:listSessions',()=>[]);
 ipcMain.handle('pi:models',()=>models);
 ipcMain.handle('pi:providers',()=>[]);
 ipcMain.handle('bash:list',()=>[]);
 ipcMain.handle('pi:searchSessions',()=>({sessions:[],groups:[],total:0,hasMore:false}));
 ipcMain.handle('scheduled:snapshot',()=>({ok:true,value:tasks()}));
 ipcMain.handle('scheduled:runOutput',(_,runId)=>({ok:true,value:{text:runId==='fixture-run'?${JSON.stringify(sampleRunOutput)}:'Older result'}}));
 ipcMain.handle('scheduled:pickDirectory',()=>({path:'/fixture/picked-folder'}));
 ipcMain.handle('files:read',(_,path)=>({path,relPath:path,kind:'text',size:12}));
 const mutations=[];
 ipcMain.handle('fixture:mutationCalls',()=>[...mutations]);
 for(const channel of ['pi:compact','pi:reload','pi:prompt','pi:setModel','pi:setThinkingLevel','sandbox:setMode','pi:resendMessage','rewind:restore']){
   ipcMain.handle(channel,()=>{mutations.push(channel);throw new Error('Read-only scheduled conversation attempted '+channel)});
 }
 const w=new BrowserWindow({...windowChromeOptions(),width:1280,height:800,minWidth:760,minHeight:560,title:'Scheduled UI check',backgroundColor:'#0b0b0d',webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 ipcMain.on('window:setTheme',(event,theme)=>setWindowTheme(BrowserWindow.fromWebContents(event.sender),theme));
 w.loadFile(${JSON.stringify(join(repo, 'out/renderer/index.html'))});
});app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let index = 0; index < 100 && !page; index++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((entry) => entry.type === 'page')
    if (!page) await pause(50)
  }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, (message) => message.error ? reject(message.error) : resolve(message.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression) => {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(`Boolean(${expression})`)) return
      await pause(100)
    }
    throw new Error(`Timed out: ${expression}\n${JSON.stringify(exceptions)}\n${JSON.stringify(await evaluate("({body:document.body.innerText.slice(0,500),buttons:[...document.querySelectorAll('button')].map(b=>({aria:b.getAttribute('aria-label'),text:b.textContent?.trim().slice(0,50)})).slice(0,30)})"))}\n${output.slice(-2000)}`)
  }
  const click = async (expression) => {
    const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const screenshot = async (name) => {
    if (!process.env.PI_SCHEDULED_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_SCHEDULED_SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(process.env.PI_SCHEDULED_SCREENSHOT_DIR, `${name}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  }

  await send('Runtime.enable')
  await waitFor(`document.querySelector('button[aria-label="Scheduled tasks"],button[aria-label="定时任务"]')`)
  await click(`document.querySelector('button[aria-label="Scheduled tasks"],button[aria-label="定时任务"]')`)
  await waitFor(`[...document.querySelectorAll('button')].some(b=>/^(New task|新建任务)$/.test(b.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('[data-scheduled-prompt] h2')`)
  const promptFacts = await evaluate(`(()=>{const p=document.querySelector('[data-scheduled-prompt]'),r=p.getBoundingClientRect();return{client:p.clientHeight,scroll:p.scrollHeight,tabIndex:p.tabIndex,label:p.getAttribute('aria-label'),heading:p.querySelector('h2')?.textContent,strong:p.querySelector('strong')?.textContent,items:p.querySelectorAll('li').length,runHistoryVisible:!!document.querySelector('[data-scheduled-run-detail]'),x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  assert.ok(promptFacts.scroll > promptFacts.client + 300 && promptFacts.client < 800, `long prompt is independently scrollable: ${JSON.stringify(promptFacts)}`)
  assert.ok(promptFacts.tabIndex === 0 && promptFacts.label && promptFacts.heading === 'Overview' && promptFacts.strong === 'rendered' && promptFacts.items === 48 && !promptFacts.runHistoryVisible, `task detail contains rendered instructions without run history: ${JSON.stringify(promptFacts)}`)
  await screenshot('task-prompt-top')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: promptFacts.x, y: promptFacts.y, deltaX: 0, deltaY: 420 })
  await waitFor(`document.querySelector('[data-scheduled-prompt]').scrollTop > 50`)
  await screenshot('task-prompt')
  await pause(250)
  const start = await evaluate('performance.now()')
  await click(`[...document.querySelectorAll('button')].find(b=>/^(New task|新建任务)$/.test(b.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('[role="dialog"][aria-modal="true"]')`)
  const openMs = (await evaluate('performance.now()')) - start
  await pause(350)
  await screenshot('editor')

  const modal = `[role="dialog"][aria-modal="true"]`
  const layout = await evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(modal)}),s=d.querySelector('[data-fade-scroll]'),r=d.getBoundingClientRect();return{width:r.width,height:r.height,scroll:s.scrollHeight,client:s.clientHeight,model:!!d.querySelector('button[aria-controls="scheduled-model-picker-panel"]'),sandbox:!!d.querySelector('button[aria-label="Sandbox mode"],button[aria-label="沙箱模式"]')}})()`)
  assert.ok(layout.width > 800 && layout.height < 700, `compact wide dialog: ${JSON.stringify(layout)}`)
  assert.ok(layout.scroll <= layout.client + 2, `default editor fits without body scrolling: ${JSON.stringify(layout)}`)
  assert.ok(layout.model && layout.sandbox, 'editor uses the shared composer model and permission controls')
  // Field titles sit flush with the control below them (no label inset of their
  // own), share one colour, and keep one gap to that control; edit items keep one
  // roomier rhythm, measured from each field wrapper to the next one that starts
  // below it (a side-by-side pair is not a vertical step). Insets are measured
  // against the parent's CONTENT box, so a padded column never reads as an indent.
  const titleFacts = await evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(modal)}),titles=[...d.querySelectorAll('[data-scheduled-field-title]')],box=e=>({l:e.getBoundingClientRect().left,p:parseFloat(getComputedStyle(e).paddingLeft)}),inset=e=>{const a=box(e),b=box(e.parentElement);return Math.round(a.l+a.p-b.l-b.p)},gap=e=>Math.round(e.nextElementSibling.getBoundingClientRect().top-e.getBoundingClientRect().bottom),fields=titles.map(t=>({name:t.textContent?.trim(),r:t.parentElement.getBoundingClientRect()})),steps=[];for(const f of fields){const next=fields.filter(o=>o.r.top>=f.r.bottom-1).sort((a,b)=>a.r.top-b.r.top)[0];if(next)steps.push({from:f.name,to:next.name,gap:Math.round(next.r.top-f.r.bottom)})};return{count:titles.length,insets:[...new Set(titles.map(inset))],colors:[...new Set(titles.map(e=>getComputedStyle(e).color))],gaps:[...new Set(titles.map(gap))],steps}})()`)
  assert.ok(titleFacts.count >= 6 && titleFacts.insets.length === 1 && titleFacts.insets[0] === 0, `every field title is flush with its control: ${JSON.stringify(titleFacts)}`)
  assert.equal(titleFacts.colors.length, 1, `every field title shares one colour: ${JSON.stringify(titleFacts.colors)}`)
  assert.ok(titleFacts.gaps.length === 1 && titleFacts.gaps[0] >= 8, `every field title keeps one gap to its control: ${JSON.stringify(titleFacts.gaps)}`)
  const byGap = new Map()
  for (const step of titleFacts.steps) byGap.set(step.gap, (byGap.get(step.gap) ?? 0) + 1)
  const commonGap = [...byGap.entries()].sort((a, b) => b[1] - a[1])[0][0]
  // The model field sits behind a divider, so its own step is the one wider one
  // (rhythm + the divider's 12px padding); everything else is the shared rhythm.
  assert.ok([...byGap.keys()].every(gap => gap >= 16) && commonGap === 20, `edit items keep a 20px rhythm: ${JSON.stringify(titleFacts.steps)}`)
  const editorAlignment = () => evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(modal)}),labels=[...d.querySelectorAll('span')],top=(en,zh)=>labels.find(e=>[en,zh].includes(e.textContent?.trim()))?.getBoundingClientRect().top;return{target:top('Run in','执行位置'),permission:top('Permissions','权限'),project:top('Project directory','项目目录'),status:top('Save as','保存状态'),projectHint:/Each run uses a folder named|每次运行使用当天日期命名的子目录/.test(d.textContent??'')}})()`)
  const assertAligned = async (schedule) => {
    const rows = await editorAlignment()
    assert.ok(Number.isFinite(rows.target) && Number.isFinite(rows.permission) && Math.abs(rows.target - rows.permission) <= 2, `${schedule}: permission aligns with run location: ${JSON.stringify(rows)}`)
    assert.ok(Number.isFinite(rows.project) && Number.isFinite(rows.status) && Math.abs(rows.project - rows.status) <= 2, `${schedule}: save status aligns with project directory: ${JSON.stringify(rows)}`)
    assert.equal(rows.projectHint, false, `${schedule}: project selector has no explanatory line`)
  }
  await assertAligned('daily')

  const recurringTrigger = `document.querySelector(${JSON.stringify(`${modal} [data-scheduled-time] button[aria-haspopup="dialog"]`)})`
  assert.equal(await evaluate(`getComputedStyle(${recurringTrigger}).fontSize`), '14px')
  await evaluate(`(()=>{window.__timeFrames=[];const until=performance.now()+500;const sample=()=>{if(performance.now()>until)return;const p=[...document.querySelectorAll('[data-morph-popover-portal]')].find(e=>e.querySelector('[data-time-picker-grid]'));if(p){const surface=p.querySelector('[role=dialog]');window.__timeFrames.push({visible:getComputedStyle(p).visibility==='visible',width:surface.offsetWidth,height:surface.offsetHeight,populated:p.querySelectorAll('[data-time-picker-grid=hour] button').length,opacity:+getComputedStyle(p).opacity})}requestAnimationFrame(sample)};requestAnimationFrame(sample)})()`)
  await click(recurringTrigger)
  await waitFor(`document.querySelector('[data-time-picker-grid="hour"]')`)
  await pause(520)
  const timeFrames = await evaluate(`window.__timeFrames.filter(frame=>frame.visible)`)
  assert.ok(timeFrames.length > 1 && timeFrames.every((frame) => frame.width===timeFrames[0].width && frame.height===timeFrames[0].height && frame.populated===24), `time picker has complete content and resting layout from its first frame: ${JSON.stringify(timeFrames.slice(0,3))}`)
  assert.equal(timeFrames.at(-1).opacity, 1, 'the time picker finishes its shared entrance')
  assert.equal(await evaluate(`document.querySelectorAll('[data-time-picker-grid="hour"] button').length`), 24)
  const minuteStart = await evaluate('performance.now()')
  await click(`document.querySelectorAll('[data-time-picker-grid="hour"] button')[10]`)
  await waitFor(`document.querySelector('[data-time-picker-grid="minute"]')`)
  const minuteMs = (await evaluate('performance.now()')) - minuteStart
  assert.ok(minuteMs < 700, `60-minute grid responds promptly (${Math.round(minuteMs)}ms)`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-time-picker-grid="minute"] button').length`), 60)
  await click(`document.querySelectorAll('[data-time-picker-grid="minute"] button')[15]`)
  await waitFor(`${recurringTrigger}.textContent.includes('10:15')`)
  assert.ok(await evaluate(`!document.querySelector(${JSON.stringify(modal)}).querySelector('[data-scheduled-time] input,[data-scheduled-time] button[aria-haspopup="listbox"]')`), 'recurring time uses one dedicated picker')

  const menuFacts = async (trigger) => {
    await evaluate(`(()=>{const t=${trigger},p=document.getElementById(t.getAttribute('aria-controls'));window.__scheduledMenuFrames=[];const until=performance.now()+550;const sample=()=>{if(performance.now()>until)return;const inner=p.firstElementChild;window.__scheduledMenuFrames.push({visible:getComputedStyle(p).visibility!=='hidden'&&p.getAttribute('aria-hidden')==='false',width:p.offsetWidth,naturalHeight:inner?.offsetHeight??0});requestAnimationFrame(sample)};requestAnimationFrame(sample)})()`)
    await click(trigger)
    await pause(570)
    return evaluate(`(()=>{const t=${trigger},p=document.getElementById(t.getAttribute('aria-controls')),m=document.querySelector(${JSON.stringify(modal)}),r=p.getBoundingClientRect(),b=m?.getBoundingClientRect(),hit=document.elementFromPoint(r.left+Math.min(20,r.width/2),r.top+Math.min(20,r.height/2)),frames=window.__scheduledMenuFrames.filter(f=>f.visible);return{open:p.getAttribute('aria-hidden')==='false',outside:b?r.bottom>b.bottom||r.top<b.top:null,topmost:!!hit&&p.contains(hit),position:getComputedStyle(p).position,width:r.width,height:r.height,first:frames[0],last:frames.at(-1)}})()`)
  }
  const stableFirstFrame = (name, facts) => {
    assert.ok(facts.first && facts.last, `${name}: sampled first visible frame`)
    assert.ok(Math.abs(facts.first.width - facts.last.width) <= 1, `${name}: width does not flash on first open: ${JSON.stringify(facts)}`)
    assert.ok(Math.abs(facts.first.naturalHeight - facts.last.naturalHeight) <= 1, `${name}: content height does not flash on first open: ${JSON.stringify(facts)}`)
  }
  const permissionTrigger = `document.querySelector(${JSON.stringify(`${modal} button[aria-label="Sandbox mode"],${modal} button[aria-label="沙箱模式"]`)})`

  // The project directory is a plain dropdown — no typing surface — and the
  // folder dialog is its own row, set apart from the known folders.
  const projectTrigger = `document.querySelector(${JSON.stringify(`${modal} button[aria-label="Project directory"],${modal} button[aria-label="项目目录"]`)})`
  const projectField = await evaluate(`(()=>{const t=${projectTrigger};return{tag:t.tagName,typed:!!document.querySelector(${JSON.stringify('input[aria-label="Project directory"],input[aria-label="项目目录"]')}),font:getComputedStyle(t).fontSize}})()`)
  assert.ok(projectField.tag === 'BUTTON' && !projectField.typed && projectField.font === '14px', `project directory is a dropdown button, not a text field: ${JSON.stringify(projectField)}`)
  const projectMenu = await menuFacts(projectTrigger)
  assert.ok(projectMenu.open && projectMenu.topmost && projectMenu.position === 'fixed', `project directory menu escapes the dialog: ${JSON.stringify(projectMenu)}`)
  stableFirstFrame('project directory', projectMenu)
  const projectRows = await evaluate(`(()=>{const p=document.getElementById(${projectTrigger}.getAttribute('aria-controls')),rows=[...p.querySelectorAll('[role="option"]')],browse=rows.at(-1);return{options:rows.map(r=>r.textContent?.trim()),separated:browse?.parentElement?.previousElementSibling?.getAttribute('role')==='separator',folders:rows.length-1}})()`)
  assert.ok(projectRows.folders >= 1 && projectRows.separated && /^(Choose a folder|选择目录)/.test(projectRows.options.at(-1) ?? ''), `folder picker is a separated row below the known folders: ${JSON.stringify(projectRows)}`)
  await screenshot('project-directory')
  await click(`[...document.querySelectorAll('[role="listbox"] button[role="option"]')].find(b=>/^(Choose a folder|选择目录)/.test(b.textContent?.trim()??''))`)
  await waitFor(`${projectTrigger}.textContent.includes('/fixture/picked-folder')`)
  const permission = await menuFacts(permissionTrigger)
  assert.ok(permission.open && permission.topmost && permission.position === 'fixed', `permission menu escapes the dialog: ${JSON.stringify(permission)}`)
  stableFirstFrame('permissions', permission)
  await screenshot('permissions')
  await click(permissionTrigger)

  // The project directory and schedule selects are both listbox buttons, so the
  // schedule one is addressed by name rather than by form order.
  const scheduleTrigger = `document.querySelector(${JSON.stringify(`${modal} button[aria-label="Schedule"],${modal} button[aria-label="时间规则"]`)})`
  const schedule = await menuFacts(scheduleTrigger)
  assert.ok(schedule.open && schedule.topmost && schedule.position === 'fixed', `schedule select escapes the dialog: ${JSON.stringify(schedule)}`)
  stableFirstFrame('schedule', schedule)
  const scheduleOptions = await evaluate(`[...document.getElementById(${scheduleTrigger}.getAttribute('aria-controls')).querySelectorAll('[role="option"]')].map(e=>e.textContent?.trim())`)
  assert.ok(!scheduleOptions.some(label => /^(Weekly|每周)$/.test(label ?? '')), `new tasks offer no weekly schedule: ${JSON.stringify(scheduleOptions)}`)
  await click(`[...document.querySelectorAll('[role="listbox"] button[role="option"]')].find(b=>/^(Once|单次)$/.test(b.textContent?.trim()??''))`)
  await waitFor(`document.querySelector(${JSON.stringify(modal)})?.querySelector('[data-scheduled-datetime]')`)
  await assertAligned('once')
  const dateTimeTrigger = `document.querySelector(${JSON.stringify(`${modal} [data-scheduled-datetime] button[aria-haspopup="dialog"]`)})`
  assert.equal(await evaluate(`getComputedStyle(${dateTimeTrigger}).fontSize`), '14px')
  assert.ok(await evaluate(`!document.querySelector(${JSON.stringify(modal)}).querySelector('[data-scheduled-datetime] input,[data-scheduled-datetime] button[aria-haspopup="listbox"]')`), 'one-time date and HH:mm use one dedicated picker')
  await click(dateTimeTrigger)
  await waitFor(`document.querySelector('[data-scheduled-calendar]')`)
  // The beUI calendar always renders a 6×7 grid of cells; only real dates get buttons.
  assert.equal(await evaluate(`document.querySelectorAll('[data-scheduled-calendar] td[role="gridcell"]').length`), 42)
  await click(`document.querySelector('button[data-scheduled-datetime-tab="time"]')`)
  await waitFor(`document.querySelector('[data-time-picker-grid="hour"]')`)
  await click(`document.querySelectorAll('[data-time-picker-grid="hour"] button')[11]`)
  await waitFor(`document.querySelector('[data-time-picker-grid="minute"]')`)
  await pause(250)
  await screenshot('date-time')
  await click(`document.querySelectorAll('[data-time-picker-grid="minute"] button')[20]`)
  await waitFor(`${dateTimeTrigger}.textContent.includes('11:20')`)

  const modelTrigger = `document.querySelector(${JSON.stringify(`${modal} button[aria-controls="scheduled-model-picker-panel"]`)})`
  const modelStart = await evaluate('performance.now()')
  await click(modelTrigger)
  await waitFor(`document.getElementById('scheduled-model-picker-panel')?.getAttribute('aria-hidden')==='false'&&getComputedStyle(document.getElementById('scheduled-model-picker-panel')).visibility==='visible'`)
  const modelMs = (await evaluate('performance.now()')) - modelStart
  const modelFacts = await evaluate(`(()=>{const p=document.getElementById('scheduled-model-picker-panel'),r=p.getBoundingClientRect(),hit=document.elementFromPoint(r.left+20,r.top+20);return{count:p.querySelectorAll('[data-model-option]').length,height:r.height,topmost:!!hit&&p.contains(hit),position:getComputedStyle(p).position}})()`)
  assert.ok(modelFacts.count === 64 && modelFacts.topmost && modelFacts.position === 'fixed', `shared model picker opens above the dialog with the full catalog: ${JSON.stringify(modelFacts)}`)
  assert.ok(modelMs < 700, `64-model picker becomes visible promptly (${Math.round(modelMs)}ms)`)
  await screenshot('model')
  await click(`[...document.querySelector(${JSON.stringify(modal)}).querySelectorAll('button')].find(b=>/^(Cancel|取消)$/.test(b.textContent?.trim()??''))`)
  await waitFor(`!document.querySelector(${JSON.stringify(modal)})`)
  await click(`[...document.querySelectorAll('nav button')].find(b=>/^(History|历史)/.test(b.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('button[aria-label="Filter runs"],button[aria-label="筛选运行记录"]')`)
  const history = await menuFacts(`document.querySelector('button[aria-label="Filter runs"],button[aria-label="筛选运行记录"]')`)
  assert.ok(history.open && history.topmost && history.position === 'fixed', `history filter opens outside its clipped view: ${JSON.stringify(history)}`)
  stableFirstFrame('history', history)
  await click(`document.querySelector('button[aria-label="Filter runs"],button[aria-label="筛选运行记录"]')`)
  const groupOrder = async () => evaluate(`[...document.querySelectorAll('[data-scheduled-run-group]')].map(group=>({key:group.getAttribute('data-scheduled-run-group'),label:group.querySelector('h3')?.textContent,ids:[...group.querySelectorAll('[data-scheduled-run]')].map(row=>row.getAttribute('data-scheduled-run'))}))`)
  const expectedNewest = [
    { key: localDateKey(runDates.latest), ids: ['fixture-run', 'fixture-earlier'] },
    { key: localDateKey(runDates.yesterday), ids: ['fixture-yesterday'] },
    { key: localDateKey(runDates.oldest), ids: ['fixture-oldest'] }
  ]
  const newestGroups = await groupOrder()
  assert.deepEqual(newestGroups.map(({ key, ids }) => ({ key, ids })), expectedNewest, `history groups local dates newest first: ${JSON.stringify(newestGroups)}`)
  assert.ok(newestGroups.every(({ label }) => label?.trim()), 'every date group has a visible localized heading')
  const sortTrigger = `document.querySelector('button[aria-label="Sort runs by date"],button[aria-label="按日期排序运行记录"]')`
  const sortMenu = await menuFacts(sortTrigger)
  assert.ok(sortMenu.open && sortMenu.topmost && sortMenu.position === 'fixed', `history sort opens above the view: ${JSON.stringify(sortMenu)}`)
  stableFirstFrame('history sort', sortMenu)
  await screenshot('run-history-sort-menu')
  await click(`[...document.querySelectorAll('[role="listbox"] button[role="option"]')].find(button=>/^(Oldest first|最早优先)$/.test(button.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('[data-scheduled-run-group]')?.getAttribute('data-scheduled-run-group')===${JSON.stringify(localDateKey(runDates.oldest))}`)
  const oldestGroups = await groupOrder()
  assert.deepEqual(oldestGroups.map(({ key, ids }) => ({ key, ids })), [...expectedNewest].reverse().map(({ key, ids }) => ({ key, ids: [...ids].reverse() })), `history groups and rows sort oldest first: ${JSON.stringify(oldestGroups)}`)
  await screenshot('run-history-oldest-first')
  const newestMenu = await menuFacts(sortTrigger)
  assert.ok(newestMenu.open && newestMenu.topmost, `history sort reopens: ${JSON.stringify(newestMenu)}`)
  await click(`[...document.querySelectorAll('[role="listbox"] button[role="option"]')].find(button=>/^(Newest first|最新优先)$/.test(button.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('[data-scheduled-run-group]')?.getAttribute('data-scheduled-run-group')===${JSON.stringify(localDateKey(runDates.latest))}`)
  await waitFor(`document.querySelector('[data-scheduled-run-output]')?.textContent?.includes('FINAL_OUTPUT_SENTINEL')`)
  const historyFacts = await evaluate(`(()=>{const row=document.querySelector('[data-scheduled-run="fixture-run"]'),detail=document.querySelector('[data-scheduled-run-detail="fixture-run"]'),output=detail?.querySelector('[data-scheduled-run-output]'),a=row?.getBoundingClientRect(),b=detail?.getBoundingClientRect();return{row:!!row,detail:!!detail,split:!!a&&!!b&&a.right<=b.left+1,heading:output?.querySelector('h2')?.textContent,strong:output?.querySelector('strong')?.textContent,full:output?.textContent?.includes('FINAL_OUTPUT_SENTINEL'),scroll:output?.scrollHeight,client:output?.clientHeight}})()`)
  assert.ok(historyFacts.row && historyFacts.detail && historyFacts.split && historyFacts.heading === 'Full output' && historyFacts.strong === 'rendered' && historyFacts.full && historyFacts.scroll > historyFacts.client, `history uses list/detail layout and full markdown output: ${JSON.stringify(historyFacts)}`)
  await screenshot('run-history')
  await click(`[...document.querySelectorAll('nav button')].find(b=>/^(Tasks|任务)/.test(b.textContent?.trim()??''))`)
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 560, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('[data-scheduled-task="fixture-task"]')`)
  await click(`document.querySelector('[data-scheduled-task="fixture-task"]')`)
  await waitFor(`document.querySelector('[data-scheduled-prompt]')?.getBoundingClientRect().height > 0`)
  const narrow = await evaluate(`(()=>{const p=document.querySelector('[data-scheduled-prompt]'),r=p.getBoundingClientRect();return{client:p.clientHeight,scroll:p.scrollHeight,top:r.top,bottom:r.bottom,viewport:innerHeight,runHistoryVisible:!!document.querySelector('[data-scheduled-run-detail]')}})()`)
  assert.ok(narrow.scroll > narrow.client && narrow.top >= 0 && narrow.bottom < narrow.viewport && !narrow.runHistoryVisible, `narrow task detail retains an independent prompt scrollport without run history: ${JSON.stringify(narrow)}`)
  await screenshot('task-prompt-narrow')
  await click(`[...document.querySelectorAll('nav button')].find(b=>/^(History|历史)/.test(b.textContent?.trim()??''))`)
  await waitFor(`document.querySelector('[data-scheduled-run="fixture-run"]')`)
  await click(`document.querySelector('[data-scheduled-run="fixture-run"]')`)
  await waitFor(`document.querySelector('[data-scheduled-run-detail="fixture-run"]')?.getBoundingClientRect().height > 0`)
  await click(`[...document.querySelectorAll('[data-scheduled-run-detail="fixture-run"] button')].find(b=>/^(View conversation|查看对话)$/.test(b.textContent?.trim()??''))`)
  await waitFor(`!document.querySelector('[data-scheduled-tasks-view]') && document.querySelector('[data-composer-readonly]')`)
  // The checkpoint entry lives behind the pocket's chevron now, so the pocket
  // has to be open for its absence to mean anything: a scheduled run owns its
  // conversation and must show no rewind affordance at all.
  await click(`document.querySelector('[data-titlebar-more]')`)
  await waitFor(`document.querySelector('[data-titlebar-overflow] [data-titlebar-action="compact"]')`)
  const conversation = await evaluate(`(()=>{const action=id=>document.querySelector('[data-titlebar-overflow] [data-titlebar-action="'+id+'"]'),editor=document.querySelector('[data-prompt-editor]'),send=document.querySelector('button[aria-label="Send prompt"]'),model=document.querySelector('button[aria-label="Choose model"],button[aria-label="选择模型"]'),permission=document.querySelector('button[aria-label="Sandbox mode"],button[aria-label="沙箱模式"]'),messageActions=[...document.querySelectorAll('[data-message-actions] button')].map(button=>button.getAttribute('aria-label'));return{mainReadonly:document.querySelector('[data-composer-readonly]')?.textContent?.includes('Read-only')||document.querySelector('[data-composer-readonly]')?.textContent?.includes('只读'),mainTranscript:document.body.textContent?.includes('Run conversation'),title:document.body.textContent?.includes('Scheduled run conversation')||document.body.textContent?.includes('定时任务会话'),mutatingActions:['compact','reload'].map(id=>({id,disabled:action(id)?.disabled===true})),inspectionEnabled:action('system-prompt')?.disabled===false,editorDisabled:!!editor&&editor.contentEditable==='false'&&editor.getAttribute('aria-disabled')==='true',sendDisabled:send?.disabled===true,modelDisabled:model?.disabled===true,permissionDisabled:permission?.disabled===true,messageMutations:messageActions.filter(label=>/^(Edit and resend|Retry response|Continue response|Fork from here|Rewind|编辑并重新发送|重试此回答|从中断处继续|从此处分叉会话|回退)$/.test(label??'')),copyAvailable:messageActions.some(label=>/^(Copy message|复制消息)$/.test(label??'')),rewind:!!action('rewind'),rail:!!document.querySelector('[data-scheduled-pane]')}})()`)
  assert.ok(conversation.mainReadonly && conversation.mainTranscript && conversation.title && !conversation.rewind && !conversation.rail, `View conversation opens the main read-only transcript without a checkpoint entry: ${JSON.stringify(conversation)}`)
  assert.deepEqual(conversation.mutatingActions, [{ id: 'compact', disabled: true }, { id: 'reload', disabled: true }], 'scheduled conversations disable compaction and reload independently of harmless titlebar additions')
  assert.ok(conversation.editorDisabled && conversation.sendDisabled && conversation.modelDisabled && conversation.permissionDisabled, `scheduled conversations prevent prompt and configuration changes: ${JSON.stringify(conversation)}`)
  assert.deepEqual(conversation.messageMutations, [], 'scheduled transcript offers no edit, retry, continue, fork or rewind actions')
  assert.ok(conversation.copyAvailable && conversation.inspectionEnabled, 'read-only conversations retain copy and inspection actions')
  await evaluate(`(()=>{for(const selector of ['[data-titlebar-action="compact"]','[data-titlebar-action="reload"]','button[aria-label="Send prompt"]','button[aria-label="Choose model"],button[aria-label="选择模型"]','button[aria-label="Sandbox mode"],button[aria-label="沙箱模式"]'])document.querySelector(selector)?.click();document.querySelector('[data-prompt-editor]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
  await pause(100)
  assert.deepEqual(await evaluate('window.__scheduledFixture.mutationCalls()'), [], 'disabled controls and Enter cannot dispatch scheduled-session mutations')
  await click(`document.querySelector('[data-titlebar-more]')`)
  await screenshot('run-conversation')
  assert.deepEqual(exceptions, [], 'no renderer exception while opening editor and dropdowns')
  console.log(`ok   scheduled editor: ${Math.round(openMs)}ms to mount, ${Math.round(layout.width)}×${Math.round(layout.height)}, 64-model menu ${Math.round(modelMs)}ms, 60-minute grid ${Math.round(minuteMs)}ms, stable first frames`)
} finally {
  ws?.close()
  child?.kill()
  await rm(temporary, { recursive: true, force: true })
}
