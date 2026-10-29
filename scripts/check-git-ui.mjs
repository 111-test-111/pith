/** Real pane + production preload + Git IPC against disposable repositories. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { chromium } from 'playwright-core'

const repo = resolve('.'), temporary = await mkdtemp(join(tmpdir(), 'pith-git-ui-'))
const project = join(temporary, 'project'), second = join(temporary, 'second')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temporary, 'global-config') }, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
let server, child, browser, page
try {
  await writeFile(join(temporary, 'global-config'), '')
  for (const directory of [project, second]) {
    await mkdir(directory); git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'UI Fixture'); git(directory, 'config', 'user.email', 'ui@example.invalid'); git(directory, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(directory, 'README.md'), 'original\n'); git(directory, 'add', 'README.md'); git(directory, 'commit', '-m', 'Initial UI commit')
  }
  await writeFile(join(project, 'README.md'), 'working change\n'); await writeFile(join(project, 'new file.txt'), 'new content\n')
  const fixturePath = '/__git_workbench.html'
  const fixture = `<!doctype html><html><head><style>body{margin:0}#root{height:100vh}</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {SidebarPanel} from '/src/components/app/SidebarPanel.tsx';import {GitStore} from '/src/state/git-store.ts';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const git=new GitStore();window.git=git;const listeners=new Set();let shell={cwd:${JSON.stringify(project)},projectless:false,subagentChild:false,scheduledTaskSession:false};
const store={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getShell:()=>shell};
window.bind=async(cwd,readonly=false)=>{await window.gitFixture.workspace(cwd,readonly);shell={...shell,cwd,subagentChild:readonly};for(const fn of listeners)fn()};
const pane={git,store,files:{subscribeOpen:()=>()=>{},select:()=>{}},terminals:{},onNewTerminal:()=>{},onTerminalsEmpty:()=>{},debug:{},reviewTurnId:null,sideChat:null,sideChatDraft:'',onSideChatDraftChange:()=>{},sideChatOnCurrentSession:true,onSideChatRebind:()=>{},agentRuns:new Map(),onOpenSessionInChat:()=>{}};
function Fixture(){const {setLocale}=useI18n();window.locale=setLocale;const [active,setActive]=React.useState('git'),[hidden,setHidden]=React.useState(false);window.tab=setActive;window.hide=setHidden;return hidden?null:React.createElement('div',{id:'rail',style:{width:420,height:'100vh',display:'flex','--panel-right':'420px'}},React.createElement(SidebarPanel,{pane,open:true,width:420,resizing:true,tabs:['git'],activeTab:active,onSelectTab:setActive,onOpenTab:setActive,onCloseTab:()=>{},onCloseOtherTabs:()=>{},onCloseAllTabs:()=>{}}))}
window.root=createRoot(document.getElementById('root'));flushSync(()=>window.root.render(React.createElement(I18nProvider,null,React.createElement(Fixture))));
window.resize=width=>{const node=document.querySelector('#rail');node.style.width=width+'px';node.style.setProperty('--panel-right',width+'px')};
</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) { server.middlewares.use(fixturePath, async (_req, res, next) => { try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) } }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const modules = join(temporary, 'git-ipc.mjs')
  await build({ stdin: { contents: `export {registerGitIpc} from './src/main/git/ipc';export {CheckoutCoordinator} from './src/main/rewind/coordinator';`, resolveDir: repo }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: modules })
  const preload = join(temporary, 'preload.mjs')
  await writeFile(preload, (await readFile(join(repo, 'out/preload/index.mjs'), 'utf8')) + `\nimport {contextBridge as fixtureBridge,ipcRenderer as fixtureIpc} from 'electron';fixtureBridge.exposeInMainWorld('gitFixture',{workspace:(cwd,readonly)=>fixtureIpc.invoke('fixture:workspace',cwd,readonly),block:(kind)=>fixtureIpc.invoke('fixture:block',kind),diffReads:()=>fixtureIpc.invoke('fixture:diff-reads'),graphReads:()=>fixtureIpc.invoke('fixture:graph-reads'),readCounts:()=>fixtureIpc.invoke('fixture:read-counts'),holdBranches:hold=>fixtureIpc.invoke('fixture:hold-branches',hold)});`)
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=${JSON.stringify(join(temporary, 'global-config'))};let service;app.whenReady().then(async()=>{const {registerGitIpc,CheckoutCoordinator}=await import(${JSON.stringify(modules)});const coordinator=new CheckoutCoordinator();let cwd=${JSON.stringify(project)},writable=true,release;service=registerGitIpc({checkoutCoordinator:coordinator,gitWorkspace:()=>({cwd,writable})});let diffReads=0;const readDiff=service.diff.bind(service);service.diff=request=>{diffReads++;return readDiff(request)};ipcMain.handle('fixture:diff-reads',()=>diffReads);let graphReads=0,branchGate=null,releaseBranches;const readGraph=service.graph.bind(service),readBranches=service.branches.bind(service);service.graph=request=>{graphReads++;return readGraph(request)};service.branches=async request=>{const result=await readBranches(request);if(branchGate)await branchGate;return result};ipcMain.handle('fixture:graph-reads',()=>graphReads);const readCounts={history:0,commits:0};for(const name of ['history','commitFiles','commitDetails']){const read=service[name].bind(service);service[name]=request=>{readCounts[name==='history'?'history':'commits']++;return read(request)}}ipcMain.handle('fixture:read-counts',()=>({...readCounts,diffs:diffReads}));ipcMain.handle('fixture:hold-branches',(_,hold)=>{releaseBranches?.();branchGate=hold?new Promise(resolve=>{releaseBranches=resolve}):null});ipcMain.handle('fixture:workspace',(_,next,readonly)=>{if(!${JSON.stringify([project, second])}.includes(next))throw new Error('fixture path');cwd=next;writable=!readonly});ipcMain.handle('fixture:block',(_,kind)=>{release?.();release=kind?coordinator.acquire(cwd,kind):null});const w=new BrowserWindow({width:1400,height:900,show:false,webPreferences:{preload:${JSON.stringify(preload)},sandbox:false,contextIsolation:true,backgroundThrottling:false}});await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',async()=>{await service?.dispose();app.quit()});`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error(output)), 20000); child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited '+code+' '+output)) }); child.stderr.on('data', chunk => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]) } }) })
  browser = await chromium.connectOverCDP(endpoint)
  for (let i=0;i<100&&!page;i++){page=browser.contexts()[0]?.pages().find(page=>page.url().includes(fixturePath));if(!page)await new Promise(resolve=>setTimeout(resolve,50))} assert(page)
  const errors=[];page.on('pageerror',error=>errors.push(String(error)))
  const capture=async name=>{if(!process.env.PI_GIT_SCREENSHOT_DIR)return;await page.mouse.move(1380,20);await page.waitForTimeout(300);await mkdir(process.env.PI_GIT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.PI_GIT_SCREENSHOT_DIR,name+'.png')})}
  const assertSplit=async(detailSelector,wide)=>{
    const master=await page.locator('.git-content > .git-master').boundingBox(),detail=await page.locator(detailSelector).boundingBox()
    assert(master&&detail)
    if(wide){assert(master.x+master.width<=detail.x+1,'details sit to the right of the original list');assert(Math.abs(master.y-detail.y)<=1,'wide columns share their top edge')}
    else{assert(master.y+master.height<=detail.y+1,'narrow panes stack details below the original list');assert(Math.abs(master.x-detail.x)<=1)}
  }
  const resizeSplit=async view=>{
    await page.evaluate(()=>{window.git.setVisible(false);window.resize(1000)});await page.waitForTimeout(80)
    const container=view==='graph'?'.git-graph-body':'.git-content',master=page.locator(`${container} > [data-git-master]`),handle=page.getByRole('separator',{name:'Resize Git list and details',exact:true})
    const masterNode=await master.elementHandle(),diffNode=await page.locator('[data-git-diff]').elementHandle()
    const selected=await page.evaluate(()=>window.git.getState().selection),draftBefore=await page.evaluate(()=>window.git.getState().draft),reads=await page.evaluate(()=>window.gitFixture.readCounts()),graphReads=await page.evaluate(()=>window.gitFixture.graphReads())
    const width=async()=> (await master.boundingBox()).width
    const dragBy=async delta=>{const box=await handle.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+Math.min(box.height/2,80));await page.mouse.down();await page.mouse.move(box.x+box.width/2+delta,box.y+Math.min(box.height/2,80),{steps:3})}
    assert.equal(await handle.getAttribute('aria-orientation'),'vertical');const before=await width(),oldPreference=await page.evaluate(view=>window.git.getState().splitWidths[view],view)
    await dragBy(88);assert(Math.abs(await width()-before-88)<2,'pointer dragging moves the divider')
    assert.equal(await page.evaluate(view=>window.git.getState().splitWidths[view],view),oldPreference,'drag frames do not publish GitStore updates')
    await page.mouse.up();await page.waitForFunction(view=>window.git.getState().splitWidths[view]!==undefined,view)
    assert(Math.abs((await page.evaluate(view=>window.git.getState().splitWidths[view],view))-await width())<2)
    await handle.focus();const beforeKey=await width();await handle.press('ArrowLeft');assert(Math.abs(await width()-beforeKey+10)<2)
    await handle.press('Shift+ArrowRight');assert(Math.abs(await width()-beforeKey-30)<2,'Shift uses the larger keyboard step')
    await dragBy(-1500);await page.mouse.up();assert(Math.abs(await width()-Number(await handle.getAttribute('aria-valuemin')))<2,'the source list retains its minimum width')
    await dragBy(1500);await page.mouse.up();assert(Math.abs(await width()-Number(await handle.getAttribute('aria-valuemax')))<2,'the inspector retains its minimum width')
    await dragBy(-40);await page.mouse.up();const preferred=await page.evaluate(view=>window.git.getState().splitWidths[view],view)
    await page.evaluate(()=>window.resize(780));await page.waitForTimeout(80);assert(await width()<preferred,'a smaller wide pane fits the preference')
    assert.equal(await page.evaluate(view=>window.git.getState().splitWidths[view],view),preferred,'fitting does not overwrite the preferred width')
    await page.evaluate(()=>window.resize(420));await page.waitForTimeout(80);assert.equal(await handle.isVisible(),false,'narrow panes have no vertical drag handle')
    await page.evaluate(()=>window.resize(1000));await page.waitForTimeout(80);assert(Math.abs(await width()-preferred)<2,'widening restores the preferred split')
    assert.equal(await masterNode.evaluate((node,selector)=>node===document.querySelector(selector),`${container} > [data-git-master]`),true)
    assert.equal(await diffNode.evaluate(node=>node===document.querySelector('[data-git-diff]')),true)
    assert.deepEqual(await page.evaluate(()=>window.git.getState().selection),selected);assert.equal(await page.evaluate(()=>window.git.getState().draft),draftBefore)
    assert.deepEqual(await page.evaluate(()=>window.gitFixture.readCounts()),reads);assert.equal(await page.evaluate(()=>window.gitFixture.graphReads()),graphReads,'resizing never reads Git data')
    await capture(`git-${view}-resized`);await page.evaluate(()=>window.resize(420));return preferred
  }
  await page.waitForSelector('[data-git-path="README.md"]')
  assert.equal(await page.locator('[data-git-root]').innerText(), await import('node:fs/promises').then(fs=>fs.realpath(project)))
  const counts=async selector=>{const node=page.locator(selector);return [Number(await node.getAttribute('data-git-added')),Number(await node.getAttribute('data-git-removed'))]}
  assert.deepEqual(await counts('[data-git-summary] [data-git-file-stats]'),[2,1])
  assert.deepEqual(await counts('[data-git-path="README.md"] [data-git-file-stats]'),[1,1])
  assert.deepEqual(await counts('[data-git-path="new file.txt"] [data-git-file-stats]'),[1,0])
  if(process.env.PI_GIT_SCREENSHOT_DIR){await page.evaluate(()=>window.locale('zh-CN'));await capture('git-changes-zh-CN');await page.evaluate(()=>window.locale('en'))}
  const statusColor = async code => page.locator(`[data-git-status="${code}"]`).first().evaluate(node=>getComputedStyle(node).color)
  const modifiedColor = await statusColor('M'), addedColor = await statusColor('?'); assert.notEqual(modifiedColor, addedColor)
  assert.equal(await page.locator('[data-git-upstream]').innerText(),'No upstream','an unconfigured upstream must not imply synchronized zero counts')
  const switchBranch=page.locator('[data-git-toolbar]').getByRole('button',{name:'Switch branch',exact:true})
  const branchPicker=page.getByRole('combobox',{name:'Search branches…'})
  const selectMainWithKeyboard=async()=>{
    await branchPicker.fill('mai')
    await page.waitForFunction(()=>{const input=document.querySelector('[data-git-branches] [role="combobox"]'),id=input?.getAttribute('aria-activedescendant'),option=id&&document.getElementById(id);return option&&!option.disabled&&option.textContent.trim()==='main'})
    await branchPicker.press('Enter')
    await page.waitForFunction(()=>window.git.getState().repository.branch==='main'&&!window.git.getState().busy)
  }
  await switchBranch.click();await page.waitForSelector('[data-git-branches]')
  await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='combobox')
  assert.equal(await page.getByRole('option',{name:'main Current',exact:true}).isDisabled(),true)
  assert.equal(await page.locator('[data-git-confirm]').count(),0,'branch selection opens directly without a confirmation modal')
  const anchor=await switchBranch.boundingBox(),popup=await page.locator('[data-git-branches]').boundingBox()
  assert(popup.y>=anchor.y+anchor.height && popup.y-anchor.y<80,'branch dropdown is anchored to the toolbar')
  await capture('git-switch-current');await branchPicker.press('Escape');await page.waitForSelector('[data-git-branches]',{state:'hidden'})
  assert.equal(await switchBranch.evaluate(button=>button===document.activeElement),true,'branch dropdown restores focus')
  // Deleting from the index and recreating a path creates two layers of one file.
  git(project,'rm','--cached','README.md');await page.evaluate(()=>window.git.refresh())
  assert.equal(await page.locator('[data-git-path="README.md"]').count(),2)
  assert.match(await page.locator('[data-git-summary]').innerText(),/2 changed files/)
  assert.deepEqual(await counts('[data-git-path="README.md"][data-git-area="staged"] [data-git-file-stats]'),[0,1])
  assert.deepEqual(await counts('[data-git-path="README.md"][data-git-area="untracked"] [data-git-file-stats]'),[1,0])
  const deletedColor = await statusColor('D'); assert.notEqual(deletedColor, modifiedColor); assert.notEqual(deletedColor, addedColor)
  git(project,'restore','--staged','--','README.md');await page.evaluate(()=>window.git.refresh())
  await page.locator('[data-git-path="README.md"]').click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('working change'))
  const draft=page.getByRole('textbox',{name:'Commit message'}), commitMessage='UI commit draft\n\nDetailed commit body';await draft.fill(commitMessage)
  const changesSplit=await resizeSplit('changes')
  // Container width does not change selected path/draft or trigger a new diff read.
  const selection=await page.evaluate(()=>window.git.getState().selection),initialDiffReads=await page.evaluate(()=>window.gitFixture.diffReads()),changesCanvas=await page.locator('[data-git-diff]').elementHandle(),composerNode=await draft.elementHandle()
  for(const width of [300,780,1000,420]){
    await page.evaluate(width=>window.resize(width),width);await page.waitForTimeout(80)
    assert.deepEqual(await page.evaluate(()=>window.git.getState().selection),selection);assert.equal(await draft.inputValue(),commitMessage)
    assert.equal(await changesCanvas.evaluate(node=>node===document.querySelector('[data-git-diff]')),true);assert.equal(await composerNode.evaluate(node=>node===document.querySelector('[data-git-composer] textarea')),true)
    await assertSplit('.git-content > [data-git-diff]',width>=768)
    const composer=await page.locator('[data-git-composer]').boundingBox(),diff=await page.locator('[data-git-diff]').boundingBox()
    if(width>=768){assert(composer.x+composer.width<=diff.x+1);assert(diff.y+diff.height>=composer.y+composer.height-1,'wide diff uses the height beside the composer')}
    else assert(diff.y+diff.height<=composer.y+1,'the compact composer stays at the bottom in narrow panes')
    await capture('git-diff-'+width)
  }
  assert.equal(await page.evaluate(()=>window.gitFixture.diffReads()),initialDiffReads,'width changes do not re-read the diff')
  await page.locator('[data-git-path="new file.txt"]').click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('new content'))
  const coldDiffReads=await page.evaluate(()=>window.gitFixture.diffReads())
  await page.locator('[data-git-path="README.md"]').click();assert.equal(await page.evaluate(()=>window.git.getState().diffLoading),false)
  assert.equal(await page.evaluate(()=>window.gitFixture.diffReads()),coldDiffReads,'revisiting a file at the same revision uses cached bytes')
  await page.getByRole('button',{name:'Stage README.md',exact:true}).click()
  await page.waitForFunction(()=>window.git.getState().repository.files.find(file=>file.path==='README.md')?.index==='M'&&!window.git.getState().busy)
  assert.equal(git(project,'show',':README.md'),'working change');assert.deepEqual(await counts('[data-git-path="README.md"][data-git-area="staged"] [data-git-file-stats]'),[1,1]);assert.deepEqual(await counts('[data-git-summary] [data-git-file-stats]'),[2,1])
  await page.getByRole('button',{name:'Unstage README.md',exact:true}).click()
  await page.waitForFunction(()=>window.git.getState().repository.files.find(file=>file.path==='README.md')?.index==='.'&&!window.git.getState().busy)
  assert.equal(git(project,'diff','--cached'),'')
  await page.getByRole('button',{name:'Discard working changes in README.md',exact:true}).click()
  await page.waitForSelector('[role="dialog"]')
  await page.waitForFunction(()=>document.activeElement?.textContent.trim()==='Cancel')
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent.trim()),'Cancel','discard defaults to Cancel')
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForSelector('[role="dialog"]',{state:'hidden'});assert.equal(await readFile(join(project,'README.md'),'utf8'),'working change\n')
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Discard working changes in README.md','Cancel restores the originating control')
  await page.getByRole('button',{name:'Discard working changes in README.md',exact:true}).click();await page.getByRole('button',{name:'Discard changes',exact:true}).click()
  await page.waitForFunction(()=>!window.git.getState().repository.files.some(file=>file.path==='README.md')&&!window.git.getState().busy)
  assert.equal(await readFile(join(project,'README.md'),'utf8'),'original\n')
  await page.getByRole('button',{name:'Stage new file.txt',exact:true}).click();await page.waitForFunction(()=>window.git.getState().repository.files.find(file=>file.path==='new file.txt')?.index==='A'&&!window.git.getState().busy)
  assert.equal(await statusColor('A'), addedColor, 'added and untracked entries share green')
  await page.getByRole('button',{name:'Commit',exact:true}).click();await page.waitForFunction(()=>window.git.getState().repository.files.length===0&&!window.git.getState().busy)
  assert.equal(git(project,'log','-1','--format=%s'),'UI commit draft');assert.equal(git(project,'log','-1','--format=%b'),'Detailed commit body');assert.equal(await draft.inputValue(),'')
  await page.getByRole('tab',{name:'History',exact:true}).click();await page.waitForFunction(()=>!window.git.getState().historyLoading)
  const listSelector='[data-git-history][data-mode="list"]',historyList=await page.locator(listSelector).elementHandle(),historyHead=git(project,'rev-parse','HEAD'),historyRoot=git(project,'rev-parse','HEAD^')
  const historyRows=await page.locator(`${listSelector} [data-git-commit]`).count()
  await page.evaluate(()=>window.resize(1000));await page.locator(`[data-git-commit="${historyHead}"]`).click();await page.waitForFunction(()=>!window.git.getState().commitFilesLoading)
  assert.equal(await page.locator(`${listSelector} [data-git-commit]`).count(),historyRows,'opening a commit preserves the history list')
  assert.equal(await historyList.evaluate(node=>node===document.querySelector('[data-git-history][data-mode="list"]')),true)
  assert.equal(await page.locator(`[data-git-commit="${historyHead}"]`).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-git-diff]').count(),0)
  await assertSplit('.git-content > [data-git-commit-details]',true)
  await page.getByRole('button',{name:'View changes in new file.txt',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('new content'))
  await capture('git-history-wide')
  // A different commit changes only the inspector, without returning through another screen.
  await page.locator(`[data-git-commit="${historyRoot}"]`).click();await page.getByRole('button',{name:'View changes in README.md',exact:true}).waitFor()
  assert.equal(await page.locator('[data-git-diff]').count(),0);assert.equal(await page.locator(`[data-git-commit="${historyRoot}"]`).getAttribute('aria-pressed'),'true')
  await page.getByRole('button',{name:'View changes in README.md',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('original'))
  await page.getByRole('button',{name:'Close diff',exact:true}).click();assert.equal(await page.locator('[data-git-commit-details]').count(),1)
  const beforeClose=await page.evaluate(()=>window.gitFixture.readCounts());await page.getByRole('button',{name:'Close commit details',exact:true}).click()
  assert.equal(await page.locator('[data-git-commit-details]').count(),0);assert.equal(await page.locator(`${listSelector} [data-git-commit]`).count(),historyRows)
  assert.equal(await historyList.evaluate(node=>node===document.querySelector('[data-git-history][data-mode="list"]')),true);assert.deepEqual(await page.evaluate(()=>window.gitFixture.readCounts()),beforeClose,'closing details does not reread history')
  await page.locator(`[data-git-commit="${historyHead}"]`).click();await page.getByRole('button',{name:'View changes in new file.txt',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('new content'))
  const historySplit=await resizeSplit('history');assert.equal(await page.evaluate(()=>window.git.getState().splitWidths.changes),changesSplit,'each view keeps its own split preference')
  const inspector=await page.locator('[data-git-commit-details]').elementHandle(),historyDiff=await page.locator('[data-git-diff]').elementHandle(),historyReadCounts=await page.evaluate(()=>window.gitFixture.readCounts()),historySelection=await page.evaluate(()=>window.git.getState().selection)
  for(const width of [300,780,1000,420]){await page.evaluate(width=>window.resize(width),width);await page.waitForTimeout(80);await assertSplit('.git-content > [data-git-commit-details]',width>=768);assert.equal(await historyList.evaluate(node=>node===document.querySelector('[data-git-history][data-mode="list"]')),true);assert.equal(await inspector.evaluate(node=>node===document.querySelector('[data-git-commit-details]')),true);assert.equal(await historyDiff.evaluate(node=>node===document.querySelector('[data-git-diff]')),true);assert.deepEqual(await page.evaluate(()=>window.git.getState().selection),historySelection);await capture('git-history-'+width)}
  assert.deepEqual(await page.evaluate(()=>window.gitFixture.readCounts()),historyReadCounts,'history width changes preserve requests and selected diffs')
  await page.evaluate(()=>window.hide(true));await page.waitForSelector('[data-git-pane]',{state:'hidden'});await page.evaluate(()=>window.hide(false));await page.waitForSelector('[data-git-history]');assert.equal(await page.getByRole('tab',{name:'History',exact:true}).getAttribute('aria-selected'),'true');await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('new content'))
  await capture('git-history')
  assert.equal(await page.evaluate(()=>window.git.getState().splitWidths.history),historySplit,'pane remounts preserve the history split')
  // Multi-file rename patches and mode-only metadata never become bogus hunk rows.
  await page.getByRole('tab',{name:'Changes',exact:true}).click();await rename(join(project,'new file.txt'),join(project,'renamed file.txt'));git(project,'add','-A');await page.evaluate(()=>window.git.refresh())
  await page.locator('[data-git-path="renamed file.txt"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-git-diff] [data-review-diff]').length===2)
  assert.equal(await page.locator('[data-git-diff] [data-review-diff]').allTextContents().then(text=>text.every(text=>text.includes('new content')&&!text.includes('diff --git'))),true)
  await capture('git-rename');git(project,'mv','renamed file.txt','new file.txt')
  if(process.platform!=='win32'){
    await chmod(join(project,'new file.txt'),0o755);await page.evaluate(()=>window.git.refresh());await page.locator('[data-git-path="new file.txt"]').click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('new mode 100755'))
    assert.equal(await page.locator('[data-git-diff] [data-review-diff]').count(),0);await chmod(join(project,'new file.txt'),0o644)
  }
  await page.evaluate(()=>window.git.refresh());await page.waitForFunction(()=>window.git.getState().repository.files.length===0)
  // Upstream counts describe the last fetched tracking ref, not an unknown zero.
  git(project,'remote','add','origin',second);git(project,'update-ref','refs/remotes/origin/main',git(project,'rev-parse','HEAD'));git(project,'config','branch.main.remote','origin');git(project,'config','branch.main.merge','refs/heads/main');await page.evaluate(()=>window.git.refresh())
  assert.match(await page.locator('[data-git-upstream]').getAttribute('aria-label'),/origin\/main: 0 commits ahead, 0 commits behind/)
  // A main-owned lease disables real write controls and clears after release.
  await page.evaluate(async()=>{await window.gitFixture.block('process');await window.git.refresh()})
  assert.equal(await switchBranch.isDisabled(),true)
  await page.evaluate(async()=>{await window.gitFixture.block(null);await window.git.refresh()})
  await switchBranch.click();await page.getByRole('button',{name:'Create branch',exact:true}).click();await page.waitForSelector('[data-git-create-branch]');assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').count(),0)
  const branchName = page.getByRole('textbox',{name:'Branch name'});assert.equal(await branchName.evaluate(input=>input===document.activeElement),true)
  await branchName.fill('cancel-me');await branchName.press('Escape');await page.waitForSelector('[data-git-create-branch]',{state:'hidden'});assert.equal(await branchPicker.evaluate(input=>input===document.activeElement),true)
  await page.getByRole('button',{name:'Create branch',exact:true}).click();await branchName.fill('bad name');await branchName.press('Enter');await page.waitForFunction(()=>!!window.git.getState().actionError&&!window.git.getState().busy)
  assert.equal(await branchName.inputValue(),'bad name','a rejected creation keeps its input');assert.equal(git(project,'branch','--show-current'),'main')
  await branchName.fill('ui-feature');await capture('git-create-branch');await branchName.press('Enter');await page.waitForFunction(()=>window.git.getState().repository.branch==='ui-feature'&&!window.git.getState().busy)
  assert.equal(git(project,'branch','--show-current'),'ui-feature')
  // Search, Escape and outside dismissal do not switch; choosing a row switches immediately.
  await page.evaluate(async()=>{await window.git.loadBranches();await window.gitFixture.holdBranches(true)})
  await switchBranch.click();await page.waitForFunction(()=>window.git.getState().branchesLoading)
  assert.equal(await page.getByRole('option',{name:'main',exact:true}).count(),1,'cached branches appear without awaiting Git')
  assert.equal(await page.getByRole('option',{name:'ui-feature Current',exact:true}).isDisabled(),true)
  assert(!await page.locator('[data-git-branches]').innerText().then(text=>text.includes('Loading')))
  await page.evaluate(()=>window.gitFixture.holdBranches(false));await page.waitForFunction(()=>!window.git.getState().branchesLoading)
  await branchPicker.fill('no-such-branch')
  await page.getByText('No matching branches.',{exact:true}).waitFor();assert.equal(git(project,'branch','--show-current'),'ui-feature')
  await branchPicker.fill('mai')
  await page.evaluate(async()=>{await window.git.refresh();await window.git.loadBranches();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})
  assert.equal(await branchPicker.inputValue(),'mai');assert.equal(await branchPicker.getAttribute('aria-expanded'),'true')
  assert.equal(await branchPicker.evaluate(input=>input===document.activeElement),true,'repository refresh preserves dropdown search focus')
  await capture('git-switch-branch');await branchPicker.press('Escape');await page.waitForSelector('[data-git-branches]',{state:'hidden'})
  assert.equal(git(project,'branch','--show-current'),'ui-feature')
  await switchBranch.click();await branchPicker.fill('mai');await page.getByRole('textbox',{name:'Commit message'}).click();await page.waitForSelector('[data-git-branches]',{state:'hidden'})
  assert.equal(git(project,'branch','--show-current'),'ui-feature')
  await switchBranch.click();await selectMainWithKeyboard()
  assert.equal(git(project,'branch','--show-current'),'main')
  await switchBranch.click();await page.getByRole('option',{name:'ui-feature',exact:true}).click();await page.waitForFunction(()=>window.git.getState().repository.branch==='ui-feature'&&!window.git.getState().busy)
  assert.equal(git(project,'branch','--show-current'),'ui-feature','pointer selection switches directly too')
  await switchBranch.click();await selectMainWithKeyboard()
  // A read-only child view cannot write, even if it shares the same cwd.
  await page.evaluate(cwd=>window.bind(cwd,true),project);await page.evaluate(()=>window.git.refresh());assert.equal(await switchBranch.isDisabled(),true)
  await page.evaluate(cwd=>window.bind(cwd,false),project);await page.evaluate(()=>window.git.refresh())
  await draft.fill('Persist me');await page.evaluate(cwd=>window.bind(cwd),second);await page.waitForFunction(cwd=>window.git.getState().repository?.root===cwd,await import('node:fs/promises').then(fs=>fs.realpath(second)))
  assert.equal(await draft.inputValue(),'');await page.evaluate(cwd=>window.bind(cwd),project);await page.waitForFunction(()=>window.git.getState().draft==='Persist me');assert.equal(await draft.inputValue(),'Persist me')
  // A graph replaces the checkout controls and reads every public tip, including merges.
  git(project,'checkout','-b','graph-feature');await writeFile(join(project,'graph.txt'),'graph payload\n');git(project,'add','graph.txt');git(project,'commit','-m','Graph feature','-m','Graph feature body')
  const graphFeature = git(project,'rev-parse','HEAD');git(project,'checkout','main')
  let graphParent=git(project,'rev-parse','HEAD');const graphTree=git(project,'rev-parse','HEAD^{tree}')
  for(let i=0;i<60;i++)graphParent=git(project,'commit-tree',graphTree,'-p',graphParent,'-m',`Graph UI ${i}`)
  git(project,'update-ref','HEAD',graphParent);git(project,'merge','--no-ff','-m','Graph merge','graph-feature')
  const graphHead=git(project,'rev-parse','HEAD'),graphOrphan=git(project,'commit-tree',graphTree,'-m','Graph disconnected'),privateGraph=git(project,'commit-tree',graphTree,'-m','Private graph checkpoint')
  git(project,'tag','v-graph',graphFeature);git(project,'update-ref','refs/remotes/origin/feature',graphFeature);git(project,'update-ref','refs/remotes/origin/orphan',graphOrphan);git(project,'update-ref','refs/pith/checkpoints/private',privateGraph)
  for(const name of ['aaa-head','aab-head','aac-head'])git(project,'update-ref',`refs/heads/${name}`,graphHead)
  await page.evaluate(()=>window.git.refresh());await page.waitForFunction(()=>!window.git.getState().busy)
  const graphToggle=page.getByRole('button',{name:'Git graph',exact:true})
  assert.deepEqual(await graphToggle.evaluate(button=>Array.from(button.closest('[data-git-pane]').firstElementChild.querySelectorAll('button'),node=>node.getAttribute('aria-label'))),['Git graph','Refresh Git'],'graph toggle immediately precedes refresh')
  await graphToggle.click();await page.waitForFunction(()=>!!window.git.getState().graph&&!window.git.getState().graphLoading)
  assert.equal(await graphToggle.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-git-toolbar]').count(),0);assert.equal(await draft.count(),0)
  assert.equal(await page.getByText('Git operation completed.',{exact:true}).count(),0,'old mutation notices do not intrude into graph mode')
  assert.equal(await page.locator('[data-git-graph-ref="HEAD"]').count(),1,'HEAD remains visible when many refs share its commit')
  assert.equal(await page.getByText('All branches and tags',{exact:true}).count(),1)
  await page.getByRole('button',{name:'Load more commits',exact:true}).click();await page.waitForFunction(()=>window.git.getState().graph?.next===null&&!window.git.getState().graphLoading)
  const graphFacts=await page.evaluate(()=>window.git.getState().graph)
  assert.equal(new Set(graphFacts.commits.map(row=>row.id)).size,graphFacts.commits.length);assert(graphFacts.commits.some(row=>row.id===graphOrphan));assert(!graphFacts.commits.some(row=>row.id===privateGraph))
  assert.deepEqual(graphFacts.commits.find(row=>row.id===graphFeature).refs.map(ref=>ref.name).sort(),['graph-feature','origin/feature','v-graph'])
  assert.equal(graphFacts.commits.find(row=>row.id===graphHead).parents.length,2)
  assert(await page.locator('[data-git-graph-commit]').count()<graphFacts.commits.length,'graph rows and nodes are windowed')
  await page.evaluate(()=>window.git.setVisible(false));const graphReadCount=await page.evaluate(()=>window.gitFixture.graphReads())
  const canvas=await page.locator('[data-git-graph-canvas]').elementHandle()
  for(const width of [300,1000,420]){await page.evaluate(width=>window.resize(width),width);await page.waitForTimeout(80);assert.equal(await graphToggle.getAttribute('aria-pressed'),'true');assert.equal(await canvas.evaluate(node=>node===document.querySelector('[data-git-graph-canvas]')),true);await capture('git-graph-'+width)}
  assert.equal(await page.evaluate(()=>window.gitFixture.graphReads()),graphReadCount,'resizing graph does not issue reads')
  await page.evaluate(id=>{const rows=window.git.getState().graph.commits;document.querySelector('[data-git-graph-scroll]').scrollTop=rows.findIndex(row=>row.id===id)*60},graphFeature)
  await page.locator(`[data-git-graph-commit="${graphFeature}"]`).click();await page.waitForSelector('[data-git-graph-details]');await page.getByText('Graph feature body',{exact:true}).waitFor()
  await page.getByRole('button',{name:'View changes in graph.txt',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-git-diff]')?.textContent.includes('graph payload'))
  const graphSplit=await resizeSplit('graph');assert.equal(await page.evaluate(()=>window.git.getState().splitWidths.history),historySplit)
  await page.evaluate(()=>window.git.setVisible(false));const detailReads=await page.evaluate(()=>window.gitFixture.diffReads()),detailCanvas=await page.locator('[data-git-diff]').elementHandle()
  for(const width of [1000,300,420]){await page.evaluate(width=>window.resize(width),width);await page.waitForTimeout(80);assert.equal(await detailCanvas.evaluate(node=>node===document.querySelector('[data-git-diff]')),true);assert.equal(await page.locator(`[data-git-graph-commit="${graphFeature}"]`).getAttribute('aria-pressed'),'true');await capture('git-graph-detail-'+width)}
  assert.equal(await page.evaluate(()=>window.gitFixture.diffReads()),detailReads,'graph detail resize preserves the diff and its IPC cache')
  assert.equal(git(project,'rev-parse','HEAD'),graphHead);assert.equal(git(project,'branch','--show-current'),'main','graph navigation never checks out a branch')
  await capture('git-graph-detail');await page.getByRole('button',{name:'Back to graph',exact:true}).click();assert.equal(await page.locator('[data-git-graph-details]').count(),0)
  await page.evaluate(()=>window.hide(true));await page.waitForSelector('[data-git-pane]',{state:'hidden'});await page.evaluate(()=>window.hide(false));await page.waitForSelector('[data-git-graph]');assert.equal(await graphToggle.getAttribute('aria-pressed'),'true')
  assert.equal(await page.evaluate(()=>window.git.getState().splitWidths.graph),graphSplit)
  for(const locale of ['zh-CN','zh-TW']){await page.evaluate(locale=>window.locale(locale),locale);await capture('git-graph-'+locale)}await page.evaluate(()=>window.locale('en'))
  await graphToggle.click();await page.waitForSelector('[data-git-toolbar]');assert.equal(await page.getByRole('tab',{name:'Changes',exact:true}).getAttribute('aria-selected'),'true');assert.equal(await draft.inputValue(),'Persist me')
  await page.getByRole('tab',{name:'History',exact:true}).click();await graphToggle.click();await graphToggle.click();assert.equal(await page.getByRole('tab',{name:'History',exact:true}).getAttribute('aria-selected'),'true')
  // Pagination and selection remain independent; the mounted list retains its scroll.
  await page.evaluate(()=>window.git.setVisible(false));await page.evaluate(()=>window.resize(1000));await page.waitForFunction(()=>!window.git.getState().historyLoading)
  const longList=await page.locator(listSelector).elementHandle(),longScroll=page.locator(`${listSelector} [data-git-history-scroll]`)
  const olderCommit=await page.evaluate(()=>window.git.getState().history.commits[12].id)
  await longScroll.evaluate(node=>{node.scrollTop=12*64});const beforeSelectionScroll=await longScroll.evaluate(node=>node.scrollTop)
  await page.locator(`[data-git-commit="${olderCommit}"]`).click();await page.waitForFunction(()=>!window.git.getState().commitFilesLoading)
  assert.equal(await longScroll.evaluate(node=>node.scrollTop),beforeSelectionScroll,'opening an inspector does not reset history scroll')
  await assertSplit('.git-content > [data-git-commit-details]',true)
  for(const [locale,label,splitLabel] of [['zh-CN','关闭提交详情','调整 Git 列表与详情宽度'],['zh-TW','關閉提交詳細資料','調整 Git 清單與詳細資料寬度'],['en','Close commit details','Resize Git list and details']]){await page.evaluate(locale=>window.locale(locale),locale);assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),1);assert.equal(await page.getByRole('separator',{name:splitLabel,exact:true}).count(),1)}
  const commitBeforeMore=await page.evaluate(()=>window.git.getState().commit.id),readsBeforeMore=await page.evaluate(()=>window.gitFixture.readCounts())
  await page.locator(listSelector).getByRole('button',{name:'Load more commits',exact:true}).click();await page.waitForFunction(()=>window.git.getState().history.next===null&&!window.git.getState().historyLoading)
  assert.equal(await page.evaluate(()=>window.git.getState().commit.id),commitBeforeMore);assert.equal((await page.evaluate(()=>window.gitFixture.readCounts())).commits,readsBeforeMore.commits)
  const beforeCloseScroll=await longScroll.evaluate(node=>node.scrollTop);await page.getByRole('button',{name:'Close commit details',exact:true}).click()
  assert.equal(await longScroll.evaluate(node=>node.scrollTop),beforeCloseScroll);assert.equal(await longList.evaluate(node=>node===document.querySelector('[data-git-history][data-mode="list"]')),true)
  await capture('git-history-paginated');await page.evaluate(()=>window.resize(420));await page.getByRole('tab',{name:'Changes',exact:true}).click()
  for(const locale of ['zh-CN','zh-TW','en']){
    await page.evaluate(locale=>window.locale(locale),locale);await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.querySelector('[data-git-pane]').textContent.includes('git.error.')),false)
    if(process.env.PI_GIT_SCREENSHOT_DIR && locale!=='en'){
      await capture('git-'+locale);await page.locator('[data-git-toolbar] button').first().click()
      const picker=page.getByRole('combobox');await picker.click();await capture('git-switch-'+locale);await picker.press('Escape')
      await page.waitForSelector('[data-git-branches]',{state:'hidden'})
    }
  }
  if(process.env.PI_GIT_SCREENSHOT_DIR){await mkdir(process.env.PI_GIT_SCREENSHOT_DIR,{recursive:true});for(const width of [300,1000]){await page.evaluate(width=>window.resize(width),width);await page.screenshot({path:join(process.env.PI_GIT_SCREENSHOT_DIR,`git-${width}.png`)})}}
  assert.deepEqual(errors,[])
  console.log('Git UI: production preload/IPC, line counts, diff cache, staging/discard/commit/history with persistent list and side inspector/multi-branch graph/instant branch dropdown/inline creation, draggable splits and keyboard/minimum widths, focus, locale, width and workspace persistence passed')
} catch (error) {
  if (page) {
    console.error(await page.evaluate(()=>({state:window.git?.getState(),html:document.querySelector('[data-git-history]')?.innerHTML})).catch(()=>null))
    if(process.env.PI_GIT_SCREENSHOT_DIR){await mkdir(process.env.PI_GIT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.PI_GIT_SCREENSHOT_DIR,'failure.png')}).catch(()=>{})}
  }
  throw error
} finally {
  await browser?.close().catch(()=>{})
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  await server?.close()
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
