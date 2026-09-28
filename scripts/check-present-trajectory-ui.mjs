/** Real Chromium + built preload + IPC + real SDK/SQLite worker, offline. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pith-trajectory-ui-'))
const screenshots = process.env.PI_PANE_SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
let server, app
const errors = []
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {TrajectoryPane} from '/src/components/app/TrajectoryPane.tsx';
import {TrajectoryTimeline} from '/src/components/app/TrajectoryTimeline.tsx';
import {TrajectoryRecordRow} from '/src/components/app/TrajectoryRecordRow.tsx';
import {ToolResult} from '/src/components/agents/tool-result.tsx';
import {ToolIcon} from '/src/lib/tool-icons.tsx';
import {PresentedFiles} from '/src/components/app/PresentedFiles.tsx';
import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';
localStorage.setItem('pi-app:locale','en');
const h=React.createElement,path=new URL(location.href).searchParams.get('session');
const store={getShell:()=>({sessionPath:path}),subscribe:()=>()=>{}};
window.previewPaths=[];
function App(){const {setLocale}=useI18n();window.setLocale=setLocale;return h('div',{style:{display:'flex',height:'740px',gap:'20px',padding:'12px'}},
 h('div',{id:'trajectory-wrap',style:{width:'400px',height:'100%',flexShrink:0}},h(TrajectoryPane,{store,agentRuns:new Map([['/fixture/child',{description:'Child agent',profile:'researcher'}]])})),
 h('div',{style:{width:'460px'}},h(FileNavigationProvider,{cwd:'/fixture',openFile:target=>window.previewPaths.push(target.path)},h(PresentedFiles,{files:window.files}))))}
window.mount=files=>{window.files=files;window.root=createRoot(document.getElementById('root'));window.root.render(h(I18nProvider,null,h(App)))};
function TimelineFixture(){const [records,setRecords]=React.useState(window.timelineRecords),[selected,setSelected]=React.useState(null);window.setTimelineRecords=setRecords;const {setLocale}=useI18n();window.setLocale=setLocale;return h('div',{id:'timeline-wrap',style:{width:'900px',padding:'12px'}},h(TrajectoryTimeline,{records,selectedId:selected?.id,onSelect:record=>{window.timelineSelected=record.id;setSelected(record)}}),h('div',{'data-timeline-following':true,style:{height:'20px'}}))}
window.mountTimeline=records=>{window.timelineRecords=records;window.root=createRoot(document.getElementById('root'));window.root.render(h(I18nProvider,null,h(TimelineFixture)))};
function RecordFixture(){const [selected,setSelected]=React.useState(null);const {setLocale}=useI18n();window.setLocale=setLocale;return h('div',{id:'record-wrap',style:{width:'400px'}},
 h('div',{id:'tool-reference',style:{display:'none'}},window.rowRecords.map(record=>h('div',{key:record.id,'data-reference':record.id},h(ToolResult,{title:record.name,status:record.status==='running'?'running':record.status==='completed'?'success':record.status==='failed'?'error':'cancelled',icon:h(ToolIcon,{name:record.name})})))),
 window.rowRecords.map(record=>h(TrajectoryRecordRow,{key:record.id,record,selected:selected===record.id,reduce:false,onSelect:record=>setSelected(record.id),onToolSelect:call=>{window.lastToolJump=call;setSelected(window.rowRecords.find(record=>record.parentId===call.recordId&&record.toolCallId===call.callId)?.id)}}))) }
window.mountRecords=records=>{window.rowRecords=records;window.root=createRoot(document.getElementById('root'));window.root.render(h(I18nProvider,null,h(RecordFixture)))};
</script></body></html>`
try {
  await build({ entryPoints: [join(repo, 'src/main/pi/trajectory/ipc.ts')], outfile: join(temp, 'routes.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temp, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'trajectory-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__trajectory.html') return next()
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__trajectory.html', fixture))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__trajectory.html'
  const out = join(temp, 'request.json')
  await writeFile(join(temp, 'main.mjs'), `import {app,BrowserWindow,dialog,ipcMain} from 'electron';
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {createPlanFixture} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/lib/plan-fixture.mjs')).href)};
import {registerTrajectoryIpc} from './routes.mjs';
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});
app.whenReady().then(async()=>{
const f=await createPlanFixture({providerCallbacks:true,respond:n=>[{type:'text',text:'Completed round '+n+'. '+('模型输出的内容摘要，用于快速查看本次执行的结果与后续步骤。 '.repeat(30))}]});globalThis.fixture=f;
await f.managed.lifecyclePromise;
const path=join(f.project,'report # 你好.txt');await writeFile(path,'delivered');
for(let i=0;i<120;i++)await f.session.prompt('question '+i);
await f.managed.trajectory.flush();
globalThis.files=[{path,size:9,description:'report'}];globalThis.cancel=true;globalThis.saved=[];globalThis.opened=[];
dialog.showSaveDialog=async()=>globalThis.cancel?{canceled:true}:{canceled:false,filePath:${JSON.stringify(out)}};
registerTrajectoryIpc(f.app);
ipcMain.handle('files:saveCopy',(_e,path)=>{globalThis.saved.push(path);return {status:'ok'}});
ipcMain.handle('shell:openPath',(_e,path)=>{globalThis.opened.push(path);return ''});
const win=new BrowserWindow({width:980,height:800,show:false,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,sandbox:false}});
await win.loadURL(${JSON.stringify(url)}+'?session='+encodeURIComponent(f.managed.path));
}).catch(error=>{console.error(error);app.exit(1)});`)
  app = await _electron.launch({ executablePath: electron, args: [join(temp, 'main.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  let diagnostics = ''
  app.process().stderr?.on('data', data => { diagnostics += data.toString() })
  const page = await app.firstWindow({ timeout: 30000 }).catch(error => { throw new Error(String(error) + '\n' + diagnostics) })
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => typeof window.mount === 'function')
  const files = await app.evaluate(() => globalThis.files)
  await page.evaluate(files => window.mount(files), files)
  await page.locator('[data-trajectory-record]').first().waitFor()
  assert.equal(await page.locator('[data-trajectory-record]').count(), 80)
  const firstId = await page.locator('[data-trajectory-record]').first().getAttribute('data-trajectory-record')
  await page.getByRole('button', { name: 'Older', exact: true }).click()
  await page.waitForFunction(firstId => document.querySelector('[data-trajectory-record]')?.getAttribute('data-trajectory-record') !== firstId, firstId)
  assert.equal(await page.locator('[data-trajectory-record]').count(), 80)
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-trajectory-inspector]'))
  if (process.env.PI_TRAJECTORY_SCREENSHOT) await page.screenshot({ path: process.env.PI_TRAJECTORY_SCREENSHOT })
  const filename = page.locator('[data-presented-file]').getByText('report # 你好.txt', { exact: true })
  assert.deepEqual(await filename.evaluate(node => ({ tag: node.tagName, tabIndex: node.getAttribute('tabindex') })), { tag: 'SPAN', tabIndex: null })
  await filename.click()
  assert.deepEqual(await page.evaluate(() => window.previewPaths), [])
  const cardButtons = page.locator('[data-presented-file] button')
  assert.equal(await cardButtons.last().getAttribute('aria-label'), 'Preview report # 你好.txt')
  const previewBox = await cardButtons.last().boundingBox(), nameBox = await filename.boundingBox(), saveBox = await cardButtons.nth(1).boundingBox()
  assert(previewBox.y > nameBox.y && previewBox.x > saveBox.x, 'preview is the bottom-right card action')
  await page.getByRole('button', { name: /Preview report/ }).click()
  assert.deepEqual(await page.evaluate(() => window.previewPaths), [files[0].path])
  await page.getByRole('button', { name: 'Save as', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.saved), [files[0].path])
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.opened), [files[0].path])
  await page.getByRole('button', { name: 'Export complete record…', exact: true }).click()
  await app.evaluate(() => globalThis.cancel = false)
  await page.getByRole('button', { name: 'Export complete record…', exact: true }).click()
  for (let i = 0; i < 100; i++) {
    try { JSON.parse(await readFile(out, 'utf8')); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  const exported = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(exported.record.kind, 'request')
  assert(exported.documents.payload)
  const sessionPath = await app.evaluate(() => globalThis.fixture.managed.path)
  const summaries = await page.evaluate(sessionPath => window.pi.trajectoryPage({sessionPath}), sessionPath)
  assert(summaries.items.some(record => record.kind==='request' && record.preview?.startsWith('Completed round')), 'real model output accompanies the existing record page')
  assert(summaries.items.every(record => !record.preview || record.preview.length<=512), 'list excerpts are bounded at the IPC boundary')
  await page.waitForSelector('[data-trajectory-preview]')
  assert.equal(await page.locator('[data-trajectory-timing] p').count(),1,'the timeline retains its overview label without either explanatory line')
  assert(await page.locator('[data-trajectory-preview]').first().textContent(), 'list rows render their content excerpts')
  await assert.rejects(page.evaluate(sessionPath => window.pi.trajectoryNode({ sessionPath, recordId: 'bad', trail: ['0'.repeat(64)] }), sessionPath))
  // Both appearance presets preserve controls, status marks and focusability.
  for (const corners of ['square', 'squircle']) {
    await page.evaluate(corners => document.documentElement.dataset.corners = corners, corners)
    assert.equal(await page.locator('[data-status-ring]').count(), 80)
    const roots = await page.locator('[data-trajectory-fields] button').count()
    assert(roots <= 40)
  }
  // A scalar detail uses the exact resting fill and padding of a hovered
  // parameter row. The document title stays opaque through node reads.
  await app.evaluate(async () => {
    const f=globalThis.fixture
    await f.app.trajectory.write({sessionId:f.session.sessionId,anchor:f.manager.getLeafId(),
      record:{id:'fixture-event',kind:'notification',name:'fixture-event',startedAt:Date.now(),status:'completed',captured:true},
      documents:{event:{model:'deepseek-flash',nested:{value:'sample'}}}})
  })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.locator('[data-trajectory-record=fixture-event]').waitFor()
  await page.locator('[data-trajectory-record=fixture-event]').click()
  await page.locator('[data-trajectory-document=event]').waitFor()
  await page.locator('[data-trajectory-fields] button').first().waitFor()
  await page.evaluate(()=>{window.setLocale('zh-CN');document.documentElement.classList.remove('dark')})
  const eventTab=page.locator('[data-trajectory-document=event]')
  await page.waitForFunction(()=>document.querySelector('[data-trajectory-document=event]')?.textContent?.startsWith('事件'))
  const eventTitle=await eventTab.textContent()
  await page.locator('[data-trajectory-fields] button').first().hover()
  await page.waitForTimeout(200)
  const hoverStyle=await page.locator('[data-trajectory-fields] button').first().evaluate(el=>({fill:getComputedStyle(el).backgroundColor,left:getComputedStyle(el).paddingLeft,top:getComputedStyle(el).paddingTop}))
  await page.evaluate(()=>{
    const tab=document.querySelector('[data-trajectory-document=event]')
    const inspector=document.querySelector('[data-trajectory-inspector]')
    window.eventTab=tab;window.eventTitleSamples=[];window.eventTitleActive=true
    window.eventContentSamples=[]
    const sample=()=>{
      window.eventTitleSamples.push({text:tab.textContent,disabled:tab.disabled,opacity:getComputedStyle(tab).opacity,y:tab.getBoundingClientRect().y})
      const field=inspector.querySelector('[data-trajectory-fields] button'),value=inspector.querySelector('[data-trajectory-value]')
      window.eventContentSamples.push({field:!!field,value:!!value,fieldDisabled:field?.disabled,fieldOpacity:field?getComputedStyle(field).opacity:null})
      if(window.eventTitleActive)requestAnimationFrame(sample)
    }
    window.eventTitleObserver=new MutationObserver(sample)
    window.eventTitleObserver.observe(inspector,{attributes:true,attributeFilter:['disabled','class','style'],childList:true,subtree:true,characterData:true})
    sample()
  })
  for(let round=0;round<4;round++){
    await page.locator('[data-trajectory-fields] button').first().click()
    const value=page.locator('[data-trajectory-value]')
    await value.waitFor()
    if(round===0){
      const style=await value.evaluate(el=>({fill:getComputedStyle(el).backgroundColor,left:getComputedStyle(el).paddingLeft,top:getComputedStyle(el).paddingTop,border:getComputedStyle(el).borderTopWidth}))
      assert.deepEqual(style,{...hoverStyle,border:'0px'},'scalar detail matches the hovered field fill and inner padding without a border')
      if(screenshots)await page.locator('[data-trajectory-inspector]').screenshot({path:join(screenshots,'trajectory-scalar-detail.png')})
    }
    await page.locator('[data-trajectory-up]').click()
    await page.locator('[data-trajectory-fields] button').first().waitFor()
  }
  const titleSamples=await page.evaluate(()=>{window.eventTitleActive=false;window.eventTitleObserver.disconnect();return {same:window.eventTab===document.querySelector('[data-trajectory-document=event]'),states:window.eventTitleSamples,content:window.eventContentSamples}})
  assert(titleSamples.same&&titleSamples.states.length>4,'the event title remains mounted while entering and leaving fields')
  assert(titleSamples.states.every(state=>state.text===eventTitle&&!state.disabled&&Number(state.opacity)>0.99),'the event size/title never dims or changes while a node loads')
  assert(Math.max(...titleSamples.states.map(state=>state.y))-Math.min(...titleSamples.states.map(state=>state.y))<0.5,'the event title stays vertically fixed during parameter navigation')
  assert(titleSamples.content.every(state=>state.field||state.value),'parameter navigation never leaves a blank interval between list and detail')
  assert(titleSamples.content.every(state=>!state.field||(!state.fieldDisabled&&Number(state.fieldOpacity)>0.99)),'the parameter list remains fully opaque and enabled while its destination loads')
  await page.evaluate(() => window.setLocale('zh-CN'))
  await page.getByRole('button', { name: '另存为', exact: true }).waitFor()
  await page.getByRole('button', { name: '预览 report # 你好.txt', exact: true }).waitFor()
  assert(await page.getByPlaceholder('搜索工具、模型或供应商').count())
  await page.getByPlaceholder('搜索工具、模型或供应商').fill('not-a-model')
  await page.waitForFunction(() => document.querySelectorAll('[data-trajectory-record]').length === 0)
  await page.getByText('此分支和筛选条件下暂无记录。', { exact: true }).waitFor()
  await page.getByPlaceholder('搜索工具、模型或供应商').fill('')
  await page.waitForSelector('[data-trajectory-fields] button')
  // Timeline clicks reveal/select the matching row; document selection is a
  // separate persistent choice, including while inspecting a nested field.
  await page.locator('[data-trajectory-span][data-trajectory-kind=request]').first().click()
  await page.waitForSelector('[data-trajectory-document=context]:not(:disabled)')
  const contextDocument = page.locator('[data-trajectory-document=context]')
  await contextDocument.click()
  await page.waitForSelector('[data-trajectory-fields] button')
  await page.locator('[data-trajectory-fields] button').first().click()
  await page.waitForSelector('[data-trajectory-document=context]:not(:disabled)')
  assert.equal(await contextDocument.getAttribute('aria-pressed'), 'true', 'a nested SDK field keeps its document selected')
  const selectedId = await page.locator('[data-trajectory-record][aria-pressed=true]').getAttribute('data-trajectory-record')
  assert.equal(await page.locator('[data-trajectory-span][aria-pressed=true]').getAttribute('data-trajectory-span'), selectedId)
  const revealed = await page.locator('[data-trajectory-record][aria-pressed=true]').evaluate(row => {
    const bounds = row.closest('[data-trajectory-list]').getBoundingClientRect(), item = row.getBoundingClientRect()
    return {visible:item.top >= bounds.top-1 && item.bottom <= bounds.bottom+1,top:item.top,bottom:item.bottom,viewportTop:bounds.top,viewportBottom:bounds.bottom,scrollTop:row.closest('[data-trajectory-list]').scrollTop}
  })
  assert(revealed.visible, `a timeline click reveals its selected row without scrolling the inspector: ${JSON.stringify(revealed)}`)
  // A different record loads its first parameter node before replacing the
  // inspector. There must be no empty frame between the old and new details.
  await page.waitForSelector('[data-trajectory-inspector] [data-trajectory-fields], [data-trajectory-inspector] [data-trajectory-value]')
  const alternate=page.locator('[data-trajectory-record][aria-pressed=false]:has([data-trajectory-content-icon=request])').first()
  const alternateId=await alternate.getAttribute('data-trajectory-record')
  await page.evaluate(()=>{
    const workspace=document.querySelector('[data-trajectory-workspace]')
    window.recordSwitchSamples=[];window.recordSwitchActive=true
    const sample=()=>{
      const inspector=workspace.querySelector('[data-trajectory-inspector]')
      window.recordSwitchSamples.push({id:inspector?.dataset.trajectoryInspector,body:!!inspector?.querySelector('[data-trajectory-fields], [data-trajectory-value]')})
      if(window.recordSwitchActive)requestAnimationFrame(sample)
    }
    window.recordSwitchObserver=new MutationObserver(sample)
    window.recordSwitchObserver.observe(workspace,{childList:true,subtree:true})
    sample()
  })
  await alternate.click()
  await page.waitForFunction(id=>document.querySelector('[data-trajectory-inspector]')?.dataset.trajectoryInspector===id,alternateId)
  const switchSamples=await page.evaluate(()=>{window.recordSwitchActive=false;window.recordSwitchObserver.disconnect();return window.recordSwitchSamples})
  assert(switchSamples.length>1&&switchSamples.every(state=>state.id&&state.body),'switching records preserves a populated inspector until the next one is ready')
  // Change only pane CSS width in a fixed wide window, as a panel drag does.
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1900, 900))
  const split=page.locator('.trajectory-split-handle')
  const splitGeometry=()=>page.evaluate(()=>{const master=document.querySelector('[data-trajectory-master]').getBoundingClientRect(),detail=document.querySelector('[data-trajectory-inspector]').getBoundingClientRect();return{master:{width:master.width,height:master.height},detail:{width:detail.width,height:detail.height}}})
  const dragSplit=async(dx,dy)=>{const box=await split.boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:4});await page.mouse.up()}
  await page.evaluate(()=>{document.getElementById('trajectory-wrap').style.width='400px';window.splitInspector=document.querySelector('[data-trajectory-inspector]')})
  await page.waitForFunction(()=>document.querySelector('.trajectory-split-handle')?.getAttribute('aria-orientation')==='horizontal')
  const narrowBefore=await splitGeometry()
  await dragSplit(0,80)
  const narrowAfter=await splitGeometry()
  assert(narrowAfter.master.height>narrowBefore.master.height+10&&narrowAfter.detail.height<narrowBefore.detail.height-10,'horizontal divider resizes narrow list and detail vertically')
  await dragSplit(0,180)
  assert((await splitGeometry()).detail.height>=159,'narrow detail retains its minimum height')
  await dragSplit(0,-300)
  const narrowMin=await splitGeometry()
  assert(narrowMin.master.height>=127&&narrowMin.master.height<=130,'narrow list stops at its minimum height')
  await split.focus();await page.keyboard.press('ArrowDown')
  assert((await splitGeometry()).master.height>narrowMin.master.height+9,'horizontal divider supports keyboard adjustment')
  await page.evaluate(()=>document.getElementById('trajectory-wrap').style.width='1200px')
  await page.waitForFunction(()=>document.querySelector('.trajectory-split-handle')?.getAttribute('aria-orientation')==='vertical')
  const wideBefore=await splitGeometry()
  await dragSplit(80,0)
  const wideAfter=await splitGeometry()
  assert(wideAfter.master.width>wideBefore.master.width+50&&wideAfter.detail.width<wideBefore.detail.width-50,'vertical divider resizes wide list and detail horizontally')
  await dragSplit(500,0)
  assert((await splitGeometry()).detail.width>=319,'wide detail retains its minimum width')
  await dragSplit(-500,0);await dragSplit(-250,0)
  const wideMin=await splitGeometry()
  assert(wideMin.master.width>=223&&wideMin.master.width<=226,'wide list stops at its minimum width')
  await split.focus();await page.keyboard.press('ArrowRight')
  assert((await splitGeometry()).master.width>wideMin.master.width+9,'vertical divider supports keyboard adjustment')
  assert(await page.evaluate(()=>window.splitInspector===document.querySelector('[data-trajectory-inspector]')),'dragging either divider preserves the inspector DOM')
  const savedSplit=await page.evaluate(()=>JSON.parse(localStorage.getItem('pi-app:trajectory-split')))
  assert(savedSplit.narrow>0&&savedSplit.wide>0,'both orientations persist their own divider position')
  await page.evaluate(files=>{window.root.unmount();window.mount(files)},files)
  await page.locator('[data-trajectory-inspector]').waitFor()
  await page.evaluate(()=>document.getElementById('trajectory-wrap').style.width='1200px')
  await page.waitForFunction(()=>document.querySelector('.trajectory-split-handle')?.getAttribute('aria-orientation')==='vertical')
  assert(Math.abs((await splitGeometry()).master.width-savedSplit.wide)<1,'reopening the trajectory restores the wide divider')
  await page.evaluate(()=>document.getElementById('trajectory-wrap').style.width='400px')
  await page.waitForFunction(()=>document.querySelector('.trajectory-split-handle')?.getAttribute('aria-orientation')==='horizontal')
  assert(Math.abs((await splitGeometry()).master.height-savedSplit.narrow)<1,'reopening the trajectory restores the narrow divider independently')
  await page.evaluate(()=>{localStorage.removeItem('pi-app:trajectory-split');const workspace=document.querySelector('[data-trajectory-workspace]');workspace.style.removeProperty('--trajectory-master-height');workspace.style.removeProperty('--trajectory-master-width')})
  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate(locale => window.setLocale(locale), locale)
    for (const corners of ['square', 'squircle']) {
      for (const dark of [false, true]) {
        await page.evaluate(({corners,dark}) => {
          document.documentElement.dataset.corners = corners
          document.documentElement.classList.toggle('dark', dark)
          window.inspectorBefore = document.querySelector('[data-trajectory-inspector]')
          window.selectedBefore = document.querySelector('[data-trajectory-record][aria-pressed=true]')
        }, {corners,dark})
        // Inspect resting selection fills after beUI's color transition.
        await page.waitForTimeout(200)
        for (const width of [260, 400, 575, 576, 767, 768, 1200, 1800]) {
          await page.evaluate(width => document.getElementById('trajectory-wrap').style.width = width+'px', width)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const geometry = await page.evaluate(() => {
            const pane = document.querySelector('[data-trajectory-pane]')
            const master = document.querySelector('[data-trajectory-master]').getBoundingClientRect()
            const inspector = document.querySelector('[data-trajectory-inspector]').getBoundingClientRect()
            const toolbar = document.querySelector('[data-trajectory-toolbar]')
            const list = document.querySelector('[data-trajectory-list]')
            const timing = document.querySelector('[data-trajectory-timing]').getBoundingClientRect()
            const choice = document.querySelector('[data-trajectory-record][aria-pressed=true]')
            const other = document.querySelector('[data-trajectory-record][aria-pressed=false]')
            const doc = document.querySelector('[data-trajectory-document][aria-pressed=true]')
            const colors = [...pane.querySelectorAll('[data-trajectory-legend] [data-trajectory-kind]')].map(el => getComputedStyle(el).backgroundColor)
            const previews = [...pane.querySelectorAll('[data-trajectory-preview]')].map(el => ({
              clipped:el.scrollWidth>el.clientWidth+1,mask:getComputedStyle(el).maskImage,height:el.getBoundingClientRect().height,
              whitespace:getComputedStyle(el).whiteSpace,text:el.textContent,rowHeight:el.closest('[data-trajectory-record]').getBoundingClientRect().height
            }))
            return { master: {x:master.x,y:master.y,width:master.width,height:master.height},
              inspector: {x:inspector.x,y:inspector.y,width:inspector.width,height:inspector.height},
              timing: {x:timing.x,bottom:timing.bottom,width:timing.width},
              choiceFill:getComputedStyle(choice).backgroundColor,otherFill:getComputedStyle(other).backgroundColor,
              docFill:getComputedStyle(doc).backgroundColor,choiceBorderWidth:getComputedStyle(choice).borderTopWidth,
              docBorderWidth:getComputedStyle(doc).borderTopWidth,colors,previews,
              overflow: [pane, toolbar, list, ...pane.querySelectorAll('[data-trajectory-fields], [data-trajectory-pagination]')].some(el => el.scrollWidth > el.clientWidth+1),
              listHeight:list.clientHeight,toolbarHeight:toolbar.clientHeight,
              sameInspector:window.inspectorBefore===document.querySelector('[data-trajectory-inspector]'),
              sameSelected:window.selectedBefore===document.querySelector('[data-trajectory-record][aria-pressed=true]') }
          })
          assert(!geometry.overflow, `no horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`)
          assert(geometry.listHeight >= 64, `at least two records fit at ${width}px`)
          assert(geometry.previews.some(preview => preview.clipped && preview.text.startsWith('Completed round')), 'long model output is visible as a clipped excerpt')
          assert(geometry.previews.some(preview => !preview.clipped && preview.text.startsWith('question')), 'short message excerpts fit without fading')
          for (const preview of geometry.previews) {
            assert.equal(preview.mask!=='none',preview.clipped,`fade only an actually clipped excerpt at ${width}px`)
            assert.equal(preview.whitespace,'nowrap','excerpts remain one line')
            assert(preview.height<=18 && preview.rowHeight<=48,'contentful rows remain compact')
          }
          assert(geometry.sameInspector && geometry.sameSelected, 'resizing preserves the selected record and inspector DOM')
          assert(geometry.timing.bottom <= geometry.master.y+1 && geometry.timing.bottom <= geometry.inspector.y+1, 'timeline is above the records and inspector')
          assert.equal(Math.round(geometry.timing.width), width, 'timeline spans the full pane')
          assert.equal(new Set(geometry.colors).size, geometry.colors.length, 'each visible record type has a distinct legend color')
          assert(geometry.colors.length>=2, 'timeline includes messages and requests')
          assert.equal(await page.locator('[data-trajectory-timing] [data-trajectory-kind=run]').count(), 0, 'run has no axis block or legend')
          assert.notEqual(geometry.choiceFill, geometry.otherFill, 'selected record has a persistent background')
          assert.equal(geometry.docFill, geometry.choiceFill, 'record and document choices share their selected background')
          assert.equal(geometry.choiceBorderWidth, '0px', 'selected record has no border')
          assert.equal(geometry.docBorderWidth, '0px', 'selected document has no border')
          if (width >= 768) {
            assert(Math.abs(geometry.master.y-geometry.inspector.y)<1, 'wide master and inspector share their top edge')
            assert(geometry.inspector.x>=geometry.master.x+geometry.master.width-1, 'wide inspector is beside the list')
            assert(geometry.master.width<=384, 'navigation has a bounded width in fullscreen')
            assert(geometry.toolbarHeight<=50, 'wide filters fit one compact row')
          } else {
            assert(Math.abs(geometry.master.x-geometry.inspector.x)<1, 'narrow master and inspector share their left edge')
            assert(geometry.inspector.y>=geometry.master.y+geometry.master.height-1, 'narrow inspector is below the list')
          }
        }
      }
    }
    if (screenshots) {
      await page.locator('[data-trajectory-pane]').screenshot({path:join(screenshots,`trajectory-wide-${locale}.png`)})
      await page.evaluate(() => document.getElementById('trajectory-wrap').style.width = '400px')
      await page.locator('[data-trajectory-pane]').screenshot({path:join(screenshots,`trajectory-narrow-${locale}.png`)})
    }
  }
  // Real model calls through preload/IPC: filter out the destination tools,
  // then use each wrench to reveal/select the exact same-named execution.
  const liveCalls = await app.evaluate(async () => {
    const f=globalThis.fixture
    f.setRespond(n=>n===121?Array.from({length:3},(_,i)=>({type:'toolCall',id:'ui-read-'+i,name:'read',arguments:{path:'report # 你好.txt'}})):[{type:'text',text:'Read all three files'}])
    await f.session.prompt('Read these three copies');await f.managed.trajectory.flush()
    const records=(await f.app.trajectoryPage({sessionPath:f.managed.path})).items
    return {source:records.find(record=>record.toolCalls?.length),tools:records.filter(record=>record.toolCallId?.startsWith('ui-read-'))}
  })
  await page.evaluate(()=>{window.setLocale('en');document.getElementById('trajectory-wrap').style.width='400px'})
  const search=page.getByPlaceholder('Search tool, model or provider')
  await search.fill(liveCalls.source.model)
  await page.waitForFunction(()=>document.querySelector('[data-trajectory-tool-call=ui-read-2]')&&!document.querySelector('[data-trajectory-content-icon=read]'))
  assert.equal(await page.locator('[data-trajectory-tool-call]').count(),3,'one wrench per real model tool-use')
  for(let i=0;i<3;i++){
    if(i>0){await search.fill(liveCalls.source.model);await page.waitForFunction(i=>document.querySelector('[data-trajectory-tool-call=ui-read-'+i+']')&&!document.querySelector('[data-trajectory-content-icon=read]'),i)}
    assert.equal(await page.locator('[data-trajectory-content-icon=read]').count(),0,'model filter hides actual tool rows before the jump')
    await page.locator('[data-trajectory-tool-call=ui-read-'+i+']').click()
    const id=liveCalls.tools.find(record=>record.toolCallId==='ui-read-'+i).id
    await page.waitForFunction(id=>document.querySelector('[data-trajectory-record][aria-pressed=true]')?.dataset.trajectoryRecord===id,id)
    assert.equal(await search.inputValue(),'','jump clears filters that would hide its destination')
    assert.equal(await page.locator('[data-trajectory-record]').count(),80,'reveal keeps a full bounded page of surrounding records')
    const visible=await page.locator('[data-trajectory-record][aria-pressed=true]').evaluate(row=>{const item=row.getBoundingClientRect(),viewport=row.closest('[data-trajectory-list]').getBoundingClientRect();return item.top>=viewport.top-1&&item.bottom<=viewport.bottom+1})
    assert(visible,'jump reveals the selected execution inside the list')
  }
  await page.evaluate(()=>window.firstBeforeJump=document.querySelector('[data-trajectory-record]'))
  await page.locator('[data-trajectory-tool-call=ui-read-0]').click()
  await page.waitForFunction(id=>document.querySelector('[data-trajectory-record][aria-pressed=true]')?.dataset.trajectoryRecord===id,liveCalls.tools.find(record=>record.toolCallId==='ui-read-0').id)
  assert(await page.evaluate(()=>window.firstBeforeJump===document.querySelector('[data-trajectory-record]')),'an already loaded tool selects in place, preserving the list DOM')
  if(screenshots)await page.locator('[data-trajectory-pane]').screenshot({path:join(screenshots,'trajectory-tool-call-jump.png')})
  await page.evaluate(() => window.root.unmount())
  const rowRecords=['bash','read','edit','mcp__fixture','unknown-extension','bash_task'].map((name,index)=>({
    id:'row-'+index,seq:index,kind:'tool',name,status:['running','completed','failed','cancelled','interrupted','unavailable'][index],captured:true,
    startedAt:1000,...(index===1||index===2?{finishedAt:1100}:{}),preview:index===0||index===5?'git status --short && pnpm run build':'Useful details about this record'
  }))
  await page.evaluate(records=>window.mountRecords(records),rowRecords)
  await page.locator('[data-trajectory-record=row-0]').waitFor()
  for(const locale of ['en','zh-CN'])for(const dark of [false,true]){
    await page.evaluate(({locale,dark})=>{window.setLocale(locale);document.documentElement.classList.toggle('dark',dark)},{locale,dark})
    for(const width of [260,400]){
      await page.evaluate(width=>document.getElementById('record-wrap').style.width=width+'px',width)
      const rows=await page.locator('[data-trajectory-record]').evaluateAll(els=>els.map(row=>{
        const icon=row.querySelector('[data-trajectory-content-icon]'),status=row.querySelector('[data-trajectory-status]'),ring=status.querySelector('[data-status-ring]'),reference=document.querySelector('[data-reference="'+row.dataset.trajectoryRecord+'"]'),preview=row.querySelector('[data-trajectory-preview]')
        const refRing=reference.querySelector('[data-status-ring]'),refIcon=reference.querySelector('svg:not([data-status-ring])')
        return {name:icon.dataset.trajectoryContentIcon,iconMatches:icon.innerHTML===refIcon.innerHTML,statusMatches:ring.innerHTML===refRing.innerHTML,
          colorMatches:getComputedStyle(status).color===getComputedStyle(refRing.parentElement).color,
          statusRight:status.getBoundingClientRect().x>icon.getBoundingClientRect().right,
          hiddenLabel:getComputedStyle(status.querySelector('.sr-only')).position==='absolute',font:getComputedStyle(preview).fontFamily,
          overflow:row.scrollWidth>row.clientWidth+1,ringSize:parseFloat(getComputedStyle(ring).width),duration:row.querySelector('[data-trajectory-duration]')?.textContent}
      }))
      for(const row of rows){
        assert(row.iconMatches&&row.statusMatches&&row.colorMatches,'content and outcome artwork/colors match the real conversation tool row: '+row.name)
        assert(row.statusRight&&row.hiddenLabel&&!row.overflow,'status is at the right, localized text is screen-reader-only, and compact rows fit')
        assert.equal(row.font.includes('monospace'),row.name==='bash'||row.name==='bash_task','only shell excerpts use the monospace font')
        assert.equal(row.ringSize,12,'status uses the conversation tool-row scale')
      }
      assert.equal(rows[1].duration,'0.10 s','duration remains beside the status')
    }
  }
  await page.locator('[data-trajectory-record=row-1]').click()
  assert.equal(await page.locator('[data-trajectory-record=row-1]').getAttribute('aria-pressed'),'true','content/status changes preserve row selection')
  if(screenshots)await page.locator('#record-wrap').screenshot({path:join(screenshots,'trajectory-tool-records.png')})
  await page.evaluate(() => window.root.unmount())
  const modelRows=[
    {id:'captured-output',seq:1,kind:'request',name:'fixture-model',model:'fixture-model',status:'completed',captured:true,startedAt:1000,finishedAt:1100,preview:'Same model output'},
    {id:'historical-output',seq:2,kind:'assistant',name:'assistant',model:'fixture-model',status:'completed',captured:false,startedAt:1000,finishedAt:1100,preview:'Same model output'}
  ]
  await page.evaluate(records=>window.mountRecords(records),modelRows)
  await page.locator('[data-trajectory-record=historical-output]').waitFor()
  for(const locale of ['en','zh-CN']){
    await page.evaluate(locale=>window.setLocale(locale),locale)
    const presentation=await page.locator('[data-trajectory-record]').evaluateAll(rows=>rows.map(row=>({text:row.textContent,icon:row.querySelector('[data-trajectory-content-icon]').outerHTML,kind:row.querySelector('[data-trajectory-content-icon]').dataset.trajectoryContentIcon})))
    assert.deepEqual(presentation[1],presentation[0],'captured and historical model output share the same label and glyph in '+locale)
    assert(presentation[0].text.includes(locale==='en'?'Model request':'模型请求'),'both model-output sources use the model-request label')
    assert.equal(presentation[0].kind,'request')
  }
  await page.evaluate(() => window.root.unmount())
  const linkedRows=[{id:'model-calls',seq:100,kind:'request',name:'fixture-model',model:'fixture-model',status:'completed',captured:true,startedAt:1000,finishedAt:1100,
    preview:'read · duplicated arguments must never be visible',toolCalls:Array.from({length:24},(_,i)=>({id:'row-call-'+i,name:'read'}))},
    ...rowRecords.map((record,index)=>({...record,parentId:'model-calls',toolCallId:'row-call-'+index}))]
  await page.evaluate(records=>window.mountRecords(records),linkedRows)
  await page.waitForSelector('[data-trajectory-tool-call=row-call-23]')
  for(const locale of ['en','zh-CN'])for(const dark of [false,true])for(const corners of ['square','squircle']){
    await page.evaluate(({locale,dark,corners})=>{window.setLocale(locale);document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.corners=corners},{locale,dark,corners})
    const model=page.locator('[data-trajectory-record=model-calls]'),call=page.locator('[data-trajectory-tool-call=row-call-0]')
    assert((await model.textContent()).includes(locale==='en'?'Model tool calls':'模型工具调用'),'first line explicitly identifies model tool calls')
    assert.equal(await model.locator('[data-trajectory-preview]').count(),0,'no duplicate argument excerpt')
    assert.equal(await page.locator('[data-trajectory-tool-call]').count(),24,'all tool-use buttons remain available beyond one line of width')
    const geometry=await page.locator('#record-wrap').evaluate(wrap=>{
      const row=wrap.querySelector('[data-trajectory-record=model-calls]'),links=wrap.querySelector('[data-trajectory-tool-calls]'),preview=wrap.querySelector('[data-trajectory-preview]'),entry=row.closest('[data-trajectory-entry]'),last=wrap.querySelectorAll('[data-trajectory-entry]')[window.rowRecords.length-1]
      return {row:row.getBoundingClientRect().height,textRow:preview.closest('[data-trajectory-record]').getBoundingClientRect().height,
        links:links.getBoundingClientRect().height,text:preview.getBoundingClientRect().height,nestedButtons:wrap.querySelectorAll('button button').length,
        divider:getComputedStyle(entry).borderBottomWidth,lastDivider:getComputedStyle(last).borderBottomWidth,dividerColor:getComputedStyle(entry).borderBottomColor,
        overflow:wrap.scrollWidth>wrap.clientWidth+1,fade:getComputedStyle(links).maskImage,scrollbar:getComputedStyle(links,'::-webkit-scrollbar').display}
    })
    assert.equal(geometry.row,geometry.textRow,'tool-use actions keep the existing two-line row height')
    assert.equal(geometry.links,geometry.text,'wrench line matches the text preview line height exactly')
    assert.equal(geometry.nestedButtons,0,'selection and wrench actions are sibling beUI buttons')
    assert.equal(geometry.divider,'1px');assert.equal(geometry.lastDivider,'0px','subtle dividers appear only between records')
    const divider=await page.locator('#record-wrap').evaluate(wrap=>{const sample=document.createElement('div');sample.className='border-b border-border/50';wrap.append(sample);const expected=getComputedStyle(sample).borderBottomColor;sample.remove();return expected})
    assert.equal(geometry.dividerColor,divider,'the divider uses the slightly stronger half-strength theme border')
    assert(!geometry.overflow&&geometry.fade!=='none'&&geometry.scrollbar==='none','overflowing tool-use actions stay on one faded line with invisible scrollbars')
    await model.click()
    const resting=await call.evaluate(button=>({color:getComputedStyle(button).color,background:getComputedStyle(button).backgroundColor,border:getComputedStyle(button).borderWidth}))
    await call.hover();await page.waitForTimeout(200)
    const hovered=await call.evaluate(button=>({color:getComputedStyle(button).color,background:getComputedStyle(button).backgroundColor,border:getComputedStyle(button).borderWidth}))
    assert.notEqual(hovered.color,resting.color,'hover changes the wrench color')
    assert.equal(hovered.background,resting.background);assert.equal(hovered.background,'rgba(0, 0, 0, 0)','hover has no background fill')
    assert.equal(hovered.border,'0px','hover has no frame')
    await page.mouse.move(900,700)
  }
  const wheelStart=await page.evaluate(()=>{const wrap=document.getElementById('record-wrap'),links=document.querySelector('[data-trajectory-tool-calls]');wrap.style.height='200px';wrap.style.overflowY='auto';wrap.scrollTop=0;links.scrollLeft=0;links.dispatchEvent(new WheelEvent('wheel',{deltaX:40,deltaY:4,bubbles:true,cancelable:true}));return {x:links.scrollLeft,y:wrap.scrollTop}})
  const wheelNoise=await page.evaluate(()=>{const wrap=document.getElementById('record-wrap'),links=document.querySelector('[data-trajectory-tool-calls]');links.dispatchEvent(new WheelEvent('wheel',{deltaX:2,deltaY:60,bubbles:true,cancelable:true}));return {x:links.scrollLeft,y:wrap.scrollTop}})
  assert(wheelStart.x>0&&wheelNoise.x>wheelStart.x&&wheelNoise.y===0,'a diagonal horizontal gesture scrolls wrench actions and ignores vertical noise')
  await page.waitForTimeout(220)
  const wheelVertical=await page.evaluate(()=>{const wrap=document.getElementById('record-wrap'),links=document.querySelector('[data-trajectory-tool-calls]');links.dispatchEvent(new WheelEvent('wheel',{deltaX:4,deltaY:40,bubbles:true,cancelable:true}));return {x:links.scrollLeft,y:wrap.scrollTop}})
  assert(wheelVertical.y>0&&wheelVertical.x===wheelNoise.x,'a new vertical gesture scrolls the containing list without moving the wrench line')
  await page.evaluate(()=>{const wrap=document.getElementById('record-wrap');wrap.style.height='';wrap.style.overflowY='';wrap.scrollTop=0;document.querySelector('[data-trajectory-tool-calls]').scrollLeft=0})
  await page.locator('[data-trajectory-tool-call=row-call-1]').focus()
  await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(()=>window.lastToolJump),{recordId:'model-calls',callId:'row-call-1'},'keyboard activation carries the exact source/call identity')
  assert.equal(await page.locator('[data-trajectory-record=row-1]').getAttribute('aria-pressed'),'true')
  if(screenshots)await page.locator('#record-wrap').screenshot({path:join(screenshots,'trajectory-model-tool-calls.png')})
  await page.evaluate(() => window.root.unmount())
  // Deterministic dense timings and day-long gaps, independent of how quickly
  // the offline SDK fixture happens to execute on this machine.
  const timed = (id, kind, turnId, startedAt, elapsed = 1) => ({id,kind,turnId,startedAt,finishedAt:startedAt+elapsed,seq:0,name:id,status:'completed',captured:true})
  const base = 1700000000000
  const timelineRecords = [
    timed('run-a','run',undefined,base,3000),timed('user-a','user','a',base,0),
    ...Array.from({length:20},(_,i)=>timed(`request-${i}`,'request','a',base+i*2)),
    ...Array.from({length:20},(_,i)=>timed(`tool-${i}`,'tool','a',base+100+i*2)),
    timed('assistant-a','assistant','a',base+150,0),
    timed('run-b','run',undefined,base+86400000,3000),
    {...timed('request-b','request','b',base+86400000,3000),firstTokenAt:base+86401000},
    timed('parallel-a','tool','b',base+86400200,2000),timed('parallel-b','tool','b',base+86400400,1000),
    timed('retry','retry','b',base+86402600,0),timed('compact','compaction','b',base+86402800,100),timed('notice','notification','b',base+86403000,0)
  ].map((record,seq)=>({...record,seq}))
  await page.evaluate(records=>window.mountTimeline(records),timelineRecords)
  const axis = page.locator('[data-trajectory-axis]')
  await axis.waitFor()
  const model = await axis.evaluate(el=>({width:el.scrollWidth,viewport:el.clientWidth,zoom:Number(el.dataset.trajectoryZoom),scrollbar:getComputedStyle(el).scrollbarWidth,
    turns:document.querySelectorAll('[data-trajectory-turn]').length,separators:document.querySelectorAll('[data-trajectory-separator]').length,
    widths:[...document.querySelectorAll('[data-trajectory-span]')].map(el=>el.getBoundingClientRect().width)}))
  assert(model.width>model.viewport*1.5, 'dense records scroll instead of shrinking to fit')
  assert.equal(model.turns,2)
  assert.equal(model.separators,1)
  assert.equal(model.scrollbar,'none')
  assert(model.widths.every(width=>width>=24), 'real buttons retain 24px hit width')
  assert.equal(await page.locator('[data-trajectory-span][title]').count(),0,'timeline blocks do not use native title tooltips')
  const tooltipTarget=page.locator('[data-trajectory-span=request-0]')
  await tooltipTarget.hover()
  const tooltip=page.getByRole('tooltip')
  await tooltip.waitFor()
  assert.equal(await tooltip.textContent(),await tooltipTarget.getAttribute('aria-label'),'beUI tooltip displays the complete localized block description')
  assert.equal(await tooltipTarget.getAttribute('aria-describedby'),await tooltip.getAttribute('id'),'the visual tooltip describes its keyboard-accessible block')
  const tooltipBox=await tooltip.boundingBox(),viewport=await page.evaluate(()=>({width:window.innerWidth,height:window.innerHeight}))
  assert(tooltipBox.x>=0&&tooltipBox.x+tooltipBox.width<=viewport.width&&tooltipBox.width<=320,'the wrapped tooltip stays within the window near a timeline edge')
  if(screenshots)await page.screenshot({path:join(screenshots,'trajectory-tooltip.png')})
  await page.mouse.move(0,0)
  await tooltip.waitFor({state:'hidden'})
  await page.keyboard.press('Tab');await tooltipTarget.focus()
  await tooltip.waitFor()
  await page.locator('[data-trajectory-axis]').focus()
  await tooltip.waitFor({state:'hidden'})
  assert.equal(await page.locator('[data-trajectory-kind=run]').count(),0)
  assert.equal(await page.locator('[data-trajectory-span=assistant-a]').getAttribute('data-trajectory-kind'),'request','historical model output uses the request tone')
  assert.equal(await page.locator('[data-trajectory-span=assistant-a]').evaluate(el=>el.closest('[data-trajectory-lane]').dataset.trajectoryLane),'request','historical model output shares the request lane')
  assert.equal(await page.locator('[data-trajectory-legend] [data-trajectory-kind=request]').count(),1,'the legend has one model-request category')
  const laneLabels=await page.locator('[data-trajectory-timing]').evaluate(timing=>{
    const center=key=>{const box=timing.querySelector('[data-trajectory-lane-label="'+key+'"] span').getBoundingClientRect();return box.y+box.height/2}
    const tool=timing.querySelector('[data-trajectory-lane=tool]')
    return {request:center('request'),tool:center('tool'),events:center('events'),toolHeight:tool.getBoundingClientRect().height}
  })
  assert(laneLabels.toolHeight>28,'the fixture has overlapping tools on multiple tracks')
  assert(Math.abs((laneLabels.tool-laneLabels.request)-(laneLabels.events-laneLabels.tool))<0.5,'messages/events and tools have the same apparent label spacing as requests and tools')
  const extent = model.width
  await page.evaluate(records=>window.setTimelineRecords(records.map(record=>record.startedAt>=1700086400000 ? {...record,startedAt:record.startedAt+29*86400000,finishedAt:record.finishedAt+29*86400000,firstTokenAt:record.firstTokenAt===undefined?undefined:record.firstTokenAt+29*86400000}:record)),timelineRecords)
  await page.waitForFunction(()=>Number(document.querySelector('[data-trajectory-separator]').dataset.trajectoryGap)>29*86400000)
  assert.equal(await axis.evaluate(el=>el.scrollWidth),extent,'a 30-day turn gap has exactly the same horizontal extent')
  await axis.evaluate(el=>el.scrollLeft=400)
  const anchoredBlock=page.locator('[data-trajectory-span=tool-10]')
  const anchorBefore=await anchoredBlock.boundingBox()
  await page.mouse.move(anchorBefore.x+anchorBefore.width/2,anchorBefore.y+anchorBefore.height/2)
  const beforeWheel=await axis.evaluate(el=>({zoom:Number(el.dataset.trajectoryZoom),top:window.scrollY}))
  await page.mouse.wheel(0,-180)
  await page.waitForFunction(()=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)>1.5)
  const afterZoom=await axis.evaluate(el=>({zoom:Number(el.dataset.trajectoryZoom),left:el.scrollLeft,top:window.scrollY,width:el.scrollWidth}))
  const anchorAfter=await anchoredBlock.boundingBox()
  assert(Math.abs(anchorBefore.x+anchorBefore.width/2-anchorAfter.x-anchorAfter.width/2)<1.5,'wheel zoom holds the pointed short block under the cursor')
  assert(afterZoom.width>extent,'vertical wheel expands dense blocks')
  assert.equal(afterZoom.top,beforeWheel.top,'zoom does not scroll the surrounding pane')
  await page.waitForTimeout(250) // a new horizontal gesture after zoom inertia
  await page.mouse.wheel(200,0)
  await page.waitForFunction(left=>document.querySelector('[data-trajectory-axis]').scrollLeft>left+100,afterZoom.left)
  const afterPan=await axis.evaluate(el=>({left:el.scrollLeft,zoom:Number(el.dataset.trajectoryZoom)}))
  assert.equal(afterPan.zoom,afterZoom.zoom,'horizontal wheel pans without changing scale')
  await page.keyboard.down('Shift');await page.mouse.wheel(0,160);await page.keyboard.up('Shift')
  await page.waitForFunction(left=>document.querySelector('[data-trajectory-axis]').scrollLeft>left+80,afterPan.left)
  assert.equal(await axis.getAttribute('data-trajectory-zoom'),String(afterZoom.zoom),'Shift + wheel pans without zoom')
  await page.locator('[data-trajectory-zoom-reset]').click()
  const request=page.locator('[data-trajectory-span=request-b]')
  const requestColors=()=>request.evaluate(el=>({body:getComputedStyle(el).backgroundColor,wait:getComputedStyle(el.querySelector('.trajectory-wait')).backgroundColor}))
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme)
    for(const selected of [false,true]){
      if(selected)await request.click()
      await page.mouse.move(5,5);await page.waitForTimeout(200)
      const resting=await requestColors()
      await request.hover();await page.waitForTimeout(200)
      const hovered=await requestColors()
      assert.notEqual(hovered.body,resting.body,`${theme}: request body responds to hover`)
      assert.notEqual(hovered.wait,resting.wait,`${theme}: first-output wait responds to hover with the body`)
      assert.notEqual(hovered.body,hovered.wait,'hover retains the two timing segments')
    }
    await page.locator('[data-trajectory-span=tool-10]').click()
  }
  await page.locator('[data-trajectory-zoom-reset]').click()
  await axis.evaluate(el=>el.scrollLeft=400)
  const gestureBox=await axis.boundingBox()
  await page.mouse.move(gestureBox.x+gestureBox.width/2,gestureBox.y+35)
  await page.waitForTimeout(250)
  const beforeDiagonalPan=await axis.evaluate(el=>({zoom:Number(el.dataset.trajectoryZoom),left:el.scrollLeft}))
  for(const [x,y] of [[18,12],[12,20],[8,90]])await page.mouse.wheel(x,y)
  await page.waitForFunction(left=>document.querySelector('[data-trajectory-axis]').scrollLeft>left+20,beforeDiagonalPan.left)
  assert.equal(Number(await axis.getAttribute('data-trajectory-zoom')),beforeDiagonalPan.zoom,'a horizontal diagonal swipe never switches to zoom')
  await page.waitForTimeout(250)
  for(const [x,y] of [[12,-18],[20,-12],[70,-6]]){
    const before=Number(await axis.getAttribute('data-trajectory-zoom'))
    await page.mouse.wheel(x,y)
    await page.waitForFunction(before=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)!==before,before)
  }
  assert(Math.abs(Number(await axis.getAttribute('data-trajectory-zoom'))-beforeDiagonalPan.zoom*Math.exp(36*0.003))<0.001,'a vertical diagonal swipe zooms using only its locked axis')
  await page.locator('[data-trajectory-zoom-reset]').click()
  await page.waitForFunction(()=>document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom==='1')
  await axis.focus();await page.keyboard.press('+')
  await page.waitForFunction(()=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)>1)
  await page.keyboard.press('0');await page.keyboard.press('End')
  await page.waitForFunction(()=>{const el=document.querySelector('[data-trajectory-axis]');return el.scrollLeft>=el.scrollWidth-el.clientWidth-1})
  assert((await axis.evaluate(el=>getComputedStyle(el).maskImage)).includes('to right'),'horizontal fade marks hidden content')
  await page.keyboard.press('Home')
  await page.locator('[data-trajectory-span=tool-10]').click()
  assert.equal(await page.evaluate(()=>window.timelineSelected),'tool-10','short blocks can select their exact record')
  assert.equal(await page.locator('[data-trajectory-span=tool-10]').getAttribute('aria-pressed'),'true')
  assert.equal(await page.locator('[data-trajectory-span=tool-10]').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px')
  const parallelBoxes=await page.locator('[data-trajectory-span^=parallel-]').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().y))
  assert.notEqual(parallelBoxes[0],parallelBoxes[1],'overlapping tool blocks have separate rows')
  await axis.focus()
  await axis.evaluate(el=>el.dispatchEvent(new WheelEvent('wheel',{deltaY:-10000,clientX:el.getBoundingClientRect().x+40,bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)===8)
  assert(await page.locator('[data-trajectory-zoom-in]').isDisabled(),'zoom has an upper bound')
  await axis.evaluate(el=>el.dispatchEvent(new WheelEvent('wheel',{deltaY:10000,clientX:el.getBoundingClientRect().x+40,bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)===0.25)
  assert(await page.locator('[data-trajectory-zoom-out]').isDisabled(),'zoom has a lower bound')
  assert((await page.locator('[data-trajectory-span]').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width))).every(width=>width>=24),'zoom-out keeps every block clickable')
  await page.locator('[data-trajectory-zoom-reset]').click()
  for(const locale of ['en','zh-CN']){
    await page.evaluate(locale=>window.setLocale(locale),locale)
    await page.locator('[data-trajectory-zoom-in]').click()
    await page.locator('[data-trajectory-zoom-out]').click()
    for(const width of [260,900]){
      await page.evaluate(width=>document.getElementById('timeline-wrap').style.width=width+'px',width)
      assert(await axis.evaluate(el=>el.clientWidth>80),'axis remains usable in a narrow pane')
      assert(!(await page.locator('#timeline-wrap').evaluate(el=>el.scrollWidth>el.clientWidth+1)),'scroll extent is contained in the axis')
      if(screenshots)await page.locator('#timeline-wrap').screenshot({path:join(screenshots,`trajectory-dense-${width}-${locale}.png`)})
    }
  }
  // Adjacent intervals and identical-timestamp message markers reproduce the
  // fractional-scale row flicker. Sample actual frames during native wheels,
  // including the content below the overview, so intermediate jumps fail too.
  const jitterRecords=[
    timed('point-user','user','jitter',base,0),
    ...Array.from({length:24},(_,i)=>timed(`point-assistant-${i}`,'assistant','jitter',base,0)),
    timed('point-notice','notification','jitter',base,0),
    ...Array.from({length:24},(_,i)=>timed(`adjacent-tool-${i}`,'tool','jitter',base+100+i,1)),
    timed('overlap-tool-a','tool','jitter',base+500,2000),timed('overlap-tool-b','tool','jitter',base+600,1000)
  ].map((record,seq)=>({...record,seq}))
  await page.evaluate(records=>window.setTimelineRecords(records),jitterRecords)
  await page.locator('[data-trajectory-span=point-user]').waitFor()
  const wheelDeltas=[...Array.from({length:4},()=>[-8,-12,8,12]).flat(),-180,-180,200,300,-160,120,-80,80,-140,140]
  for(const locale of ['en','zh-CN']){
    await page.evaluate(locale=>window.setLocale(locale),locale)
    for(const width of [400,900]){
      await page.evaluate(width=>document.getElementById('timeline-wrap').style.width=width+'px',width)
      await page.locator('[data-trajectory-zoom-reset]').click()
      await page.waitForFunction(()=>document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom==='1')
      await page.evaluate(()=>{
        window.timelineZoomFrames=[]
        let active=true
        const sample=()=>{
          const selectors=['[data-trajectory-timing]','[data-trajectory-axis]','[data-timeline-following]','[data-trajectory-lane-label]','[data-trajectory-lane]','[data-trajectory-span]']
          const geometry=selectors.flatMap(selector=>[...document.querySelectorAll(selector)].map(el=>{
            const rect=el.getBoundingClientRect();return {selector,id:el.dataset.trajectorySpan??el.dataset.trajectoryLaneLabel??el.dataset.trajectoryLane??'',y:rect.y,height:rect.height}
          }))
          window.timelineZoomFrames.push({zoom:Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom),geometry})
          if(active)requestAnimationFrame(sample)
        }
        window.stopTimelineZoomFrames=()=>{active=false}
        sample()
      })
      const box=await axis.boundingBox()
      await page.mouse.move(box.x+box.width/2,box.y+34)
      for(const delta of wheelDeltas){
        const before=Number(await axis.getAttribute('data-trajectory-zoom'))
        await page.mouse.wheel(0,delta)
        await page.waitForFunction(before=>Number(document.querySelector('[data-trajectory-axis]').dataset.trajectoryZoom)!==before,before)
      }
      const frames=await page.evaluate(()=>{window.stopTimelineZoomFrames();return window.timelineZoomFrames})
      assert(frames.length>=wheelDeltas.length,'continuous zoom samples rendered frames')
      assert(Math.max(...frames.map(frame=>frame.zoom))>2 && Math.min(...frames.map(frame=>frame.zoom))<0.8,'regression exercises both sides of minimum-width scaling')
      const baseline=frames[0].geometry
      for(const frame of frames){
        assert.equal(frame.geometry.length,baseline.length,'zoom keeps the same tracks and buttons')
        frame.geometry.forEach((rect,index)=>{
          assert.equal(rect.id,baseline[index].id)
          assert(Math.abs(rect.y-baseline[index].y)<0.1 && Math.abs(rect.height-baseline[index].height)<0.1,`${locale}/${width}px: ${rect.selector} ${rect.id} moves vertically at ${frame.zoom}x`)
        })
      }
    }
  }
  await page.evaluate(() => window.root.unmount())
  assert.deepEqual(errors, [])
  await app.evaluate(async () => { await globalThis.fixture.close() })
  console.log('PASS UI/IPC: 120 SDK turns, exact same-name tool-use jumps through filters/paging, compact wrench hover/keyboard/dividers, bounded records/fields, paging/search/export, 30-day idle folding, dense/parallel hit targets, continuous wheel zoom with stable overview/track/button/content heights, pan, invisible horizontal scrollbar/fade, persistent selection, 260–1800px layouts, both locales/themes/corners')
} finally {
  await app?.close()
  await server?.close()
  await rm(temp, { recursive: true, force: true })
}
