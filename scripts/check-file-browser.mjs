/** File browser IO + actual Workspace/Chromium. Isolated data, no model calls.
 * Run after building: node scripts/check-file-browser.mjs */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-files-'))
const project = join(temporary, 'project 中文')
const outside = join(temporary, 'outside')
const homePath = path => '~/' + relative(homedir(), path).replaceAll('\\', '/')
const perfOnly = process.env.PI_FILES_PERF_ONLY === '1'
const deepRelative = Array.from({length:10}, (_,i)=>'level'+i).join('/') + '/deep.ts'
const deepPath = join(project, deepRelative)
const exec = promisify(execFile)
const git = args => exec('git', args, { cwd: project })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, child, ws
try {
  await mkdir(project); await mkdir(outside)
  await mkdir(join(project, 'src')); await mkdir(join(project, 'docs')); await mkdir(join(project, 'many'))
  if(perfOnly) {
    await mkdir(dirname(deepPath),{recursive:true})
    await writeFile(deepPath,Array.from({length:2400},(_,i)=>`export const deepPreview${i} = { value: ${i}, title: "Hello world" };`).join('\n'))
    for(let depth=1;depth<=10;depth++) {
      const folder=join(project,...Array.from({length:depth},(_,i)=>'level'+i))
      await Promise.all(Array.from({length:24},(_,i)=>writeFile(join(folder,`sibling${i}.txt`),'file')))
    }
  }
  await writeFile(join(project, 'src/AuthenticationProviderWithAVeryLongName.tsx'), 'export const authentication = true;\n')
  await writeFile(join(project, 'src/App.tsx'), 'export const original = true;\n')
  const longDiffPath=join(project,'long-diff.ts')
  const longDiffText=prefix=>Array.from({length:1200},(_,i)=>i===400
    ? `export const ${prefix}${i} = "${'长'.repeat(140)}${prefix === 'original' ? 'OLD' : 'NEW'}_TAIL_OF_DIFF";`
    : `export const ${prefix}${i} = ${i};`).join('\n')+'\n'
  await writeFile(longDiffPath,longDiffText('original'))
  await writeFile(join(project, 'README.md'), '# File preview\n\n**中文粗体**\n\n打开[Open source](src/App.tsx:2)查看。\n\n[Guide](docs/guide.md) · [Website](https://example.com) · [Section](#file-preview)\n\n```python\nprint("hello")\n```\n')
  const skillFrontmatter = 'name: preview-example\ndescription: |\n  Use the preview to read a longer description that wraps naturally within the narrow sidebar while keeping the YAML block scalar indentation and all original line breaks.\n  Second line.'
  const skillPreview = `---\n${skillFrontmatter}\n---\n\n# Preview example\n\n<outer>\n  <inner>\n    Keep the original indentation.\n  </inner>\n</outer>\n\n**Rendered Markdown**\n\n\`\`\`xml\n<code-tag>\n  remains code\n</code-tag>\n\`\`\`\n`
  await writeFile(join(project, 'SKILL.md'), skillPreview)
  await writeFile(join(project, 'find.txt'), 'SDK SDK sdk SDKish\n中文 SDK sdk 文档\n'+'long '.repeat(200)+'SDK\n'+Array.from({length:1000},(_,i)=>'row '+i).join('\n')+'\n'+'a'.repeat(10000)+'!\nSDK')
  await writeFile(join(project, 'package.json'), '{}\n')
  await writeFile(join(project, 'data.json'), '{}\n')
  await writeFile(join(project, 'docs/guide.md'), '# Guide\n\n[Relative source](../src/App.tsx#L2)\n\n[New relative source](../src/new.ts)\n')
  await writeFile(join(project, 'src/new.ts'), 'export const followLink = true;\n')
  await writeFile(join(project, 'My Notes.md'), '# Spaced name\n\n**带空格的文件**\n')
  await writeFile(join(project, 'literal[1].txt'), 'before literal\n')
  await writeFile(join(project, 'literal1.txt'), 'unchanged sibling\n')
  await writeFile(join(project, 'deleted.txt'), 'deleted text\n')
  await mkdir(join(project, 'vanished'))
  await writeFile(join(project, 'vanished/old.md'), 'removed with its folder\n')
  await git(['init', '-q']); await git(['add', '.']); await git(['-c', 'user.name=File Check', '-c', 'user.email=files@example.invalid', 'commit', '-qm', 'fixture'])
  await writeFile(join(project, 'src/App.tsx'), 'export const staged = true;\n'); await git(['add', 'src/App.tsx'])
  await writeFile(join(project, 'src/App.tsx'), 'export const updated = true;\nexport const secondLine = "中文";\n')
  await writeFile(longDiffPath,longDiffText('updated'))
  await writeFile(join(project, 'literal[1].txt'), 'after literal\n')
  await rm(join(project, 'deleted.txt'))
  await rm(join(project, 'vanished'), { recursive: true })
  await writeFile(join(project, 'untracked.py'), 'print("new file")\n')
  await writeFile(join(project, 'empty.txt'), '')
  await writeFile(join(project, 'file#25%.txt'), 'literal attachment path')
  await writeFile(join(project, 'binary.dat'), Buffer.from([0, 1, 2, 255]))
  await writeFile(join(project, 'unknown.custom'), 'readable unknown extension\n')
  await writeFile(join(project, 'utf16.txt'), Buffer.concat([Buffer.from([255,254]), Buffer.from('中文 UTF16\n', 'utf16le')]))
  await writeFile(join(project, 'large.ts'), Array.from({length:14000}, (_,i) => `export const line${i+1} = "${i}";`).join('\n'))
  await writeFile(join(project, 'truncated.txt'), '中'.repeat(180000))
  await writeFile(join(outside, 'plain.md'), '# Outside project\n')
  await writeFile(join(outside, 'README.md'), '# A different workspace\n')
  await mkdir(join(project, '~'))
  await writeFile(join(project, '~/literal.txt'), 'literal tilde directory\n')
  await Promise.all(Array.from({length:305}, (_,i)=>writeFile(join(project, 'many', `${i}.txt`), 'x')))
  await symlink(project, join(project, 'cycle'))
  await build({ stdin: { contents: `export * from './src/main/file-browser';export {resolveFilePath} from './src/main/file-path';export {FileIndex,readAttachment} from './src/main/pi/files';`, resolveDir: repo, loader: 'ts' }, outfile: join(temporary,'files.mjs'), bundle:true, platform:'node',format:'esm' })
  const { listFileDirectory, readFileDocument, readFileGitDiff, resolveFilePath, FileIndex, readAttachment } = await import(pathToFileURL(join(temporary,'files.mjs')))
  assert.equal(resolveFilePath({cwd:'/project',path:'~/资料/Assignment 1#%.pdf'},{homeDir:'/home/user',platform:'linux'}),'/home/user/资料/Assignment 1#%.pdf')
  assert.equal(resolveFilePath({cwd:'/project',path:'~'},{homeDir:'/home/user',platform:'linux'}),'/home/user')
  assert.equal(resolveFilePath({cwd:'/project',path:'~/../other/file.txt'},{homeDir:'/home/user',platform:'linux'}),'/home/other/file.txt')
  assert.equal(resolveFilePath({cwd:'/project',path:'./~/literal.txt'},{homeDir:'/home/user',platform:'linux'}),'/project/~/literal.txt')
  assert.equal(resolveFilePath({cwd:'/project',path:'~other/file.txt'},{homeDir:'/home/user',platform:'linux'}),'/project/~other/file.txt')
  assert.equal(resolveFilePath({cwd:'C:\\project',path:'~\\资料\\Assignment 1.pdf'},{homeDir:'C:\\Users\\Test User',platform:'win32'}),'C:/Users/Test User/资料/Assignment 1.pdf')
  assert.equal(resolveFilePath({cwd:'C:\\project',path:'\\\\server\\share\\file.txt'},{homeDir:'C:\\Users\\Test User',platform:'win32'}),'//server/share/file.txt')
  assert.throws(()=>resolveFilePath({cwd:'relative',path:'~/file.txt'}))
  assert.throws(()=>resolveFilePath({cwd:project,path:'~/bad\0.txt'}))
  const outsideHome={cwd:project,path:homePath(join(outside,'plain.md'))}
  assert.equal((await readFileDocument(outsideHome)).text,'# Outside project\n','home text paths resolve outside the active workspace')
  assert.equal((await listFileDirectory({cwd:project,path:homePath(outside)})).path,outside)
  assert.ok((await readFileGitDiff({cwd:project,path:homePath(join(project,'src/App.tsx'))})).patch.includes('+export const updated'))
  const attachment=await readAttachment(new FileIndex(project),outsideHome.path)
  assert.equal(attachment.path,join(outside,'plain.md'));assert.equal(attachment.text,'# Outside project\n')
  assert.equal((await readFileDocument({cwd:project,path:'./~/literal.txt'})).text,'literal tilde directory\n')
  await build({ entryPoints: [join(repo, 'src/renderer/src/lib/file-markdown.ts')], outfile: join(temporary,'file-markdown.mjs'), bundle:true, platform:'node',format:'esm' })
  const { splitFileMarkdown } = await import(pathToFileURL(join(temporary,'file-markdown.mjs')))
  assert.equal(splitFileMarkdown(skillPreview).frontmatter, skillFrontmatter)
  assert.equal(splitFileMarkdown('---\nname: unfinished\n# Body').frontmatter, null,'an unclosed frontmatter fence stays Markdown')
  assert.equal(splitFileMarkdown('---\nordinary prose\n---\n').frontmatter, null,'a horizontal rule is not metadata')
  assert.deepEqual(splitFileMarkdown('<unclosed>\n<complete>\n  child\n</complete>').sections.map(section=>section.kind),['markdown','tag-block'],'a later complete tag block survives an unmatched opener')
  assert.deepEqual(splitFileMarkdown('```xml\n<code>\n  child\n</code>\n```').sections.map(section=>section.kind),['markdown'],'fenced tags stay Markdown code')
  const request = path => ({cwd:project,path})
  const beforeIndex = await readFile(join(project, '.git/index'))
  assert.equal((await readFileDocument(request('unknown.custom'))).text, 'readable unknown extension\n')
  assert.equal((await readFileDocument(request('utf16.txt'))).text, '中文 UTF16\n')
  assert.equal((await readFileDocument(request('binary.dat'))).error, 'binary')
  assert.equal((await readFileDocument(request('src'))).error, 'directory')
  assert.equal((await readFileDocument(request('empty.txt'))).text, '')
  const truncated = await readFileDocument(request('truncated.txt'))
  assert.equal(truncated.truncated, true); assert.ok(!truncated.text.includes('\ufffd'))
  assert.equal((await readFileDocument({cwd:outside,path:'plain.md'})).gitRoot, null)
  const doc = await readFileDocument(request('src/App.tsx')); assert.equal(doc.gitRoot, await realpath(project))
  const diff = await readFileGitDiff(request('src/App.tsx'))
  assert.ok(diff.patch.includes('-export const original'))
  assert.ok(diff.patch.includes('+export const updated'))
  assert.ok(diff.patch.includes('+export const secondLine'))
  const literal = await readFileGitDiff(request('literal[1].txt'))
  assert.ok(literal.patch.includes('+after literal')); assert.ok(!literal.patch.includes('unchanged sibling'))
  assert.ok((await readFileGitDiff(request('deleted.txt'))).patch.includes('-deleted text'))
  assert.ok((await readFileGitDiff(request('untracked.py'))).patch.includes('+print'))
  assert.equal((await readFileGitDiff(request('README.md'))).patch, '')
  assert.ok((await readFileGitDiff(request('empty.txt'))).patch.includes('new file mode'))
  assert.equal((await readFileGitDiff(request('binary.dat'))).binary, true)
  assert.equal((await readFileGitDiff(request('truncated.txt'))).error, 'tooLarge')
  const entries = await listFileDirectory(request('.'))
  assert.ok(!entries.entries.some(e=>e.name==='.git'))
  assert.ok(entries.entries.find(e=>e.name==='cycle').symlink)
  const firstPage = await listFileDirectory(request('many'))
  const lastPage = await listFileDirectory(request('many'), firstPage.nextOffset)
  assert.equal(firstPage.entries.length,300); assert.equal(lastPage.entries.length,5)
  assert.deepEqual(await readFile(join(project,'.git/index')), beforeIndex)
  const unborn=join(temporary,'unborn');await mkdir(unborn);await exec('git',['init','-q'],{cwd:unborn});await writeFile(join(unborn,'new.txt'),'unborn\n')
  assert.ok((await readFileGitDiff({cwd:unborn,path:'new.txt'})).patch.includes('+unborn'))
  await exec('git', ['add','new.txt'], {cwd:unborn})
  await rm(join(unborn,'new.txt'))
  assert.deepEqual(await readFileGitDiff({cwd:unborn,path:'new.txt'}), {gitRoot:await realpath(unborn),patch:'',binary:false}, 'a removed staged addition has no net diff from HEAD')
  console.log('PASS: bounded text, UTF encodings, binary/missing/directories, lazy pages, literal Git paths, HEAD/staged/unstaged/untracked/deleted/unborn and unchanged index')

  // Save-a-copy fidelity (moved here from the removed openers check): copies
  // the full original bytes through a stubbed native dialog, never truncates
  // the source on a same-file save, and reports cancellation as data.
  const saveBytes=Buffer.alloc(800_000,123), saveSource=join(temporary,'save source $(literal).bin'), savedCopy=join(temporary,'saved copy.bin')
  await writeFile(saveSource,saveBytes)
  globalThis.saveFixture={dialog:{canceled:false,filePath:savedCopy}}
  await build({entryPoints:[join(repo,'src/main/file-actions.ts')],outfile:join(temporary,'actions.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'save-dialog-fixture',setup(builder){
    builder.onResolve({filter:/^electron$/},args=>({path:args.path,namespace:'fixture'}))
    builder.onLoad({filter:/./,namespace:'fixture'},()=>({contents:'export const dialog={showSaveDialog:async()=>globalThis.saveFixture.dialog};'}))
  }}]})
  const {saveFileCopy}=await import(pathToFileURL(join(temporary,'actions.mjs')))
  assert.deepEqual(await saveFileCopy({},saveSource),{status:'ok'})
  assert.deepEqual(await readFile(savedCopy),saveBytes,'save full file, not truncated preview')
  globalThis.saveFixture.dialog={canceled:false,filePath:saveSource}
  assert.deepEqual(await saveFileCopy({},saveSource),{status:'ok'})
  assert.deepEqual(await readFile(saveSource),saveBytes,'same-file save never truncates source')
  globalThis.saveFixture.dialog={canceled:true}
  assert.deepEqual(await saveFileCopy({},saveSource),{status:'cancelled'})
  delete globalThis.saveFixture
  console.log('PASS: save-copy full bytes, same-file safety, cancellation')

  const fixturePath='/__files_check.html'
  const fixture=`<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {ThemeProvider} from 'next-themes';
import {Workspace} from '/src/components/app/Workspace.tsx';import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';import {ToastProvider} from '/src/components/app/ToastProvider.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';import {PiStore} from '/src/state/pi-store.ts';
import {FileBrowserStore} from '/src/state/file-browser-store.ts';import {localFileTarget} from '/src/lib/file-navigation.tsx';
import {initFonts} from '/src/lib/fonts.ts';import {setUiStyle} from '/src/lib/ui-style.ts';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');localStorage.setItem('pi-app:panel-layout',JSON.stringify({left:200,right:650}));initFonts();
const LocaleBridge=()=>{window.setLocale=useI18n().setLocale;return null};
window.resolveFile=localFileTarget;window.setFixtureUiStyle=setUiStyle;window.store=new PiStore();
// Most assertions exercise the foreground preview. Retained layers are
// intentionally still in the DOM, and a collapsed rail can still host them.
window.shownAll=selector=>Array.from(document.querySelectorAll(selector)).filter(node=>!node.closest('[data-sidebar-file-preview=retained], [data-panel=right][aria-hidden=true]'));
window.shown=selector=>window.shownAll(selector)[0]??null;
const open=FileBrowserStore.prototype.open;FileBrowserStore.prototype.open=function(...args){window.files=this;return open.apply(this,args)};
window.setSession=async (cwd,id=cwd)=>{await window.pi.init(cwd);store.applySnapshot({cwd,sessionId:id,sessionPath:'/fixture/'+encodeURIComponent(id),messages:[{role:'user',timestamp:0,content:'<file path="'+cwd+'/file#25%.txt">literal attachment path</file>'},{role:'assistant',timestamp:1,content:[{type:'text',text:'[Deep source](${deepRelative}) · [Open README](README.md) · [Open source](src/App.tsx:2) · [URL file](file://'+cwd+'/README.md) · [Spaced note](My Notes.md) · '+${JSON.stringify('[Home file]('+encodeURI(homePath(join(outside,'plain.md')))+')')}}]}],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false})};
window.escalate=(requests)=>store.dispatch({type:'sandbox_escalation',requests});
await setSession(${JSON.stringify(project)});window.root=createRoot(document.getElementById('root'));
root.render(React.createElement(React.StrictMode,null,React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'light'},React.createElement(I18nProvider,null,React.createElement(LocaleBridge),React.createElement(ImagePreviewProvider,null,React.createElement(ToastProvider,null,React.createElement(Workspace,{store,accent:'indigo',onAccentChange:()=>{}})))))));
window.fixtureReady=true;</script></body></html>`
  server=await createServer({configFile:false,root:join(repo,'src/renderer'),logLevel:'error',cacheDir:join(temporary,'vite'),resolve:{alias:{'@':join(repo,'src/renderer/src')}},plugins:[react({exclude:/(?:node_modules|\/vite\/deps\/)/}),tailwindcss(),{name:'files-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!==fixturePath)return next();try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(fixturePath,fixture))}catch(error){next(error)}})}}],server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}}})
  await server.listen()
  await symlink(join(repo,'node_modules'),join(temporary,'node_modules'))
  const main=join(temporary,'main.cjs')
  await build({stdin:{contents:`import {app,BrowserWindow,ipcMain} from 'electron';import {listFileDirectory,readFileDocument,readFileGitDiff} from ${JSON.stringify(join(repo,'src/main/file-browser.ts'))};
import {resolveFilePath} from ${JSON.stringify(join(repo,'src/main/file-path.ts'))};
import {registerGitIpc} from ${JSON.stringify(join(repo,'src/main/git/ipc.ts'))};import {CheckoutCoordinator} from ${JSON.stringify(join(repo,'src/main/rewind/coordinator.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const io={directories:[],documents:[],diffs:[],gitTrees:[],opened:[],saved:[],revealed:[],escalationAnswers:[]};let diffGate,releaseDiff,active,git;app.whenReady().then(async()=>{ipcMain.handle('app:info',()=>({fileIo:io,cwd:${JSON.stringify(project)},folders:[${JSON.stringify(project)}],contextFiles:true,version:'test'}));ipcMain.handle('pi:models',()=>[]);ipcMain.handle('pi:listSessions',()=>[]);
ipcMain.handle('pi:init',(_,cwd)=>{active=cwd});git=registerGitIpc({checkoutCoordinator:new CheckoutCoordinator(),gitWorkspace:()=>({cwd:active,writable:true})});const treeStatus=git.treeStatus.bind(git);git.treeStatus=async request=>{const result=await treeStatus(request);io.gitTrees.push({cwd:request.cwd,ok:result.ok});return result};
ipcMain.handle('files:directory',async(_,r,offset)=>{io.directories.push({path:r.path,offset,time:Date.now()});if(${perfOnly})await new Promise(r=>setTimeout(r,30));return listFileDirectory(r,offset)});ipcMain.handle('files:document',(_,r)=>{io.documents.push({path:r.path,time:Date.now()});return readFileDocument(r)});
ipcMain.handle('files:gitDiff',async(_,r)=>{if(r.path==='__hold_diff__'){diffGate=new Promise(resolve=>releaseDiff=resolve);return {gitRoot:null,patch:'',binary:false}}if(r.path==='__release_diff__'){releaseDiff?.();diffGate=null;return {gitRoot:null,patch:'',binary:false}}io.diffs.push(r);if(diffGate)await diffGate;return readFileGitDiff(r)});
ipcMain.handle('files:resolvePath',(_,request)=>resolveFilePath(request));
ipcMain.handle('files:defaultApp',()=>null);
ipcMain.handle('files:saveCopy',(_,path)=>{io.saved.push(path);return {status:'cancelled'}});ipcMain.handle('shell:showInFolder',(_,path)=>{io.revealed.push(path)});ipcMain.handle('shell:openPath',(_,path)=>{io.opened.push(path);return io.opened.length===1?'failed to open':''});ipcMain.handle('shell:openExternal',()=>{});
ipcMain.handle('sandbox:respondEscalation',(_,requestId,sessionPath,decision)=>{io.escalationAnswers.push({requestId,sessionPath,decision});return true});
ipcMain.handle('browser:theme',()=>{});
const w=new BrowserWindow({show:false,width:1500,height:950,webPreferences:{preload:${JSON.stringify(join(repo,'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',async()=>{await git?.dispose();app.quit()});`,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:main})
  child=spawn(electron,[main],{stdio:['ignore','ignore','pipe']})
  let stderr=''
  const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr)),15000);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Electron exited '+code+' '+stderr))});child.stderr.on('data',chunk=>{stderr+=chunk;const m=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}})})
  let page;for(let i=0;i<100&&!page;i++){page=(await(await fetch(endpoint+'/json/list')).json()).find(p=>p.type==='page');if(!page)await pause(50)}
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}))
  let seq=0;const pending=new Map();const exceptions=[]
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails)})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value}
  const waitFor=async(expression,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await evaluate(`Boolean(${expression})`))return;await pause(50)}throw new Error('Timeout '+label+' '+await evaluate('document.body.innerText')+'\n'+JSON.stringify(exceptions))}
  const click=async selector=>{
    const clicked=await evaluate(`(()=>{const element=shown(${JSON.stringify(selector)});if(!element)return false;element.click();return true})()`)
    assert.ok(clicked, `Missing click target ${selector}`)
    await pause(80)
  }
  const view=async name=>{await evaluate(`Array.from(shownAll('[data-file-preview] [role=tab]')).find(b=>b.textContent===${JSON.stringify(name)}).click()`);await pause(80)}
  const selectTab=async name=>{await evaluate(`Array.from(shownAll('[data-sidebar-tabs] [role=tab]')).find(b=>b.textContent===${JSON.stringify(name)}).click()`);await pause(80)}
  const wrapDiffButton = '[data-file-view-tabs] button[aria-label="Wrap lines"]'
  const diffOverflows = `Array.from(shownAll('[data-file-diff], [data-file-diff] [data-review-diff], [data-file-diff] [data-slot="file-diff-viewport"]')).some(v => v.scrollWidth > v.clientWidth + 1)`
  const holdDiff=()=>evaluate(`window.pi.readFileGitDiff({cwd:${JSON.stringify(project)},path:'__hold_diff__'})`)
  const releaseDiff=()=>evaluate(`window.pi.readFileGitDiff({cwd:${JSON.stringify(project)},path:'__release_diff__'})`)
  // Observe every frame while real Git IPC is deliberately pending. Warm
  // switches must paint rows immediately, including a restored virtual window.
  const diffFrames=action=>evaluate(`new Promise(resolve=>{const samples=[];const tick=()=>{const viewport=shown('[data-file-diff]'),bounds=viewport?.getBoundingClientRect();samples.push({present:!!viewport,top:viewport?.scrollTop,rows:viewport?[...viewport.querySelectorAll('[data-slot="file-diff-viewport"] .grid')].filter(row=>{const r=row.getBoundingClientRect();return r.bottom>bounds.top&&r.top<bounds.bottom}).length:0});if(samples.length<12)requestAnimationFrame(tick);else resolve(samples)};${action};requestAnimationFrame(tick)})`)
  const press=async(key,code)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});await pause(80)}
  const selectedTreeVisible=`(()=>{const tree=shown('[data-file-tree]'),row=tree?.querySelector('[aria-selected=true]');if(!tree||!row)return false;const viewport=tree.getBoundingClientRect(),bounds=row.getBoundingClientRect();return bounds.top>=viewport.top&&bounds.bottom<=viewport.bottom})()`
  await send('Runtime.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});await waitFor('window.shown?.("a[href=\\"README.md\\"]")','workspace')
  if(perfOnly) {
    await pause(200)
    // Conversation links open the file without rearranging the tree, so no
    // selected row ever appears for them; a browsing open (the tree path, i.e.
    // the store default) still reveals deep paths, and that reveal
    // must keep its old no-waterfall timing.
    const measure=async(name,action,reveal=false)=>{
      const before=(await evaluate('window.pi.appInfo()')).fileIo
      const sample=await evaluate(`new Promise(resolve=>{const start=performance.now(),frames=[];let last=start,source=null,selection=null,highlight=null;const tick=now=>{frames.push(now-last);last=now;const pane=shown('[data-file-source]'),tree=shown('[data-file-tree]'),selected=tree?.querySelector('[aria-selected=true]');if(source===null&&pane)source=now-start;if(highlight===null&&pane?.querySelector('[style*=agent-code-light]'))highlight=now-start;if(selection===null&&selected){const row=selected.getBoundingClientRect(),bounds=tree.getBoundingClientRect();if(row.top>=bounds.top&&row.bottom<=bounds.bottom&&getComputedStyle(selected.parentElement.parentElement).opacity==='1')selection=now-start}if(now-start<1800)requestAnimationFrame(tick);else resolve({source,selection,highlight,maxFrame:Math.max(...frames),slowFrames:frames.filter(ms=>ms>32).length,rows:tree?.querySelectorAll('[role=treeitem]').length})};requestAnimationFrame(tick);${action}})`)
      const after=(await evaluate('window.pi.appInfo()')).fileIo
      const result={name,...sample,directories:after.directories.length-before.directories.length,documents:after.documents.length-before.documents.length}
      console.log('PERF: '+JSON.stringify(result))
      assert.equal(result.documents,1,'one document validation per visit, including StrictMode')
      if(reveal) {
        assert.ok(result.selection!==null&&result.selection<300,'deep path has no sequential directory/animation waterfall')
        assert.equal(await evaluate(`shown('[data-file-tree] [aria-selected=true]').tabIndex`),0,'persistent tree follows file-tab keyboard entry')
      } else {
        assert.equal(result.selection,null,'conversation navigation leaves the tree as the user arranged it')
      }
      if(name==='warm deep tab')assert.equal(result.directories,0,'warm tab restores cached directories without IO')
    }
    await measure('cold deep link',`shown('a[href="${deepRelative}"]').click()`)
    // The deep link opens preview-first, so expand its tree once — outside the
    // measurement — before the warm revisit, whose cached directories must
    // still restore without IO.
    await evaluate(`shown('[aria-label="Show file tree"]').click()`)
    await waitFor('shown("[data-file-tree-column]")','the linked deep tab shows its tree on request')
    await measure('other file',`shown('a[href="src/App.tsx:2"]').click()`)
    if(process.env.PI_FILES_PROFILE){await send('Profiler.enable');await send('Profiler.start')}
    await measure('warm deep tab',`Array.from(shownAll('[data-sidebar-tabs] [role=tab]')).find(tab=>tab.textContent==='deep.ts').click()`)
    if(process.env.PI_FILES_PROFILE){const {profile}=await send('Profiler.stop');await writeFile(process.env.PI_FILES_PROFILE,JSON.stringify(profile))}
    await measure('revealing open',`files.open(${JSON.stringify(project)},{path:${JSON.stringify(deepPath)}})`,true)
  } else {
  assert.deepEqual(await evaluate('resolveFile("README.md:12", "/project")'),{path:'/project/README.md',line:12})
  assert.deepEqual(await evaluate('resolveFile("file:///project/file%23name.md#L2", "/project")'),{path:'/project/file#name.md',line:2})
  assert.equal(await evaluate('resolveFile("https://example.com/page", "/project")'),null)
  await click(`a[href=${JSON.stringify(encodeURI(homePath(join(outside,'plain.md'))))}]`)
  await waitFor('shown("[data-file-markdown]")?.textContent.includes("Outside project")','home link opens the actual file')
  assert.equal(await evaluate('files.getSnapshot().active'),join(outside,'plain.md'),'home link stores the absolute host path')
  assert.equal(await evaluate('files.getSnapshot().tabs.find(tab=>tab.path===files.getSnapshot().active).cwd'),project,'home link retains its originating workspace')
  console.log('PASS: actual Markdown home link resolves through production preload IPC')
  // The sent file chip wears the file's own artwork rather than a generic glyph,
  // at the compact tree size, and its public URL decodes inside the transcript.
  assert.deepEqual(await evaluate(`(()=>{const image=shown('[data-from="user"] [data-file-icon]');return image?{path:image.dataset.fileIcon,kind:image.dataset.fileIconKind,side:image.getBoundingClientRect().width,decoded:image.complete&&image.naturalWidth>0}:null})()`),{path:join(project,'file#25%.txt'),kind:'tree',side:16,decoded:true},'the sent attachment chip shows the file-type artwork')
  await evaluate(`Array.from(shownAll('button')).find(button=>button.textContent==='file#25%.txt').click()`)
  await waitFor('shown("[data-file-source]")?.textContent.includes("literal attachment path")','literal attachment path in sidebar')
  await click('a[href="README.md"]')
  await waitFor('shown("[data-file-markdown] strong")','markdown by conversation link')
  assert.equal(await evaluate('shown("[data-file-markdown] strong").textContent'),'中文粗体'); console.log('PASS: conversation link opens Markdown')
  assert.deepEqual(await evaluate(`['https://example.com', '#file-preview'].map(href => {
    const anchor = shown('[data-file-markdown] a[href="' + href + '"]')
    return anchor?.querySelector('[data-file-icon]') === null
  })`), [true, true], 'web and fragment links have no file icons')
  const hoverLink = async (link, target = link) => {
    const point = await evaluate(`(() => {
      const { x, y, width, height } = ${target}.getClientRects()[0]
      return { x: x + width / 2, y: y + height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await waitFor(`${link}.matches(':hover')`, `hovered ${link}`)
  }
  for (const region of ['[data-from="assistant"]', '[data-file-markdown]']) {
    const link = `shown(${JSON.stringify(`${region} a[href="src/App.tsx:2"]`)})`
    const icon = `${link}.querySelector('[data-file-icon]')`
    await waitFor(`${icon}?.naturalWidth > 0`, `${region} file icon decoded`)
    assert.equal(await evaluate(`${icon}.getAttribute('src')`), './file-icons/pierre-square/react.svg', `${region} icon uses the file type and active style`)
    const { clips, ...gaps } = await evaluate(`(() => {
      const anchor = ${link}
      const image = ${icon}
      const box = image.getBoundingClientRect()
      const beforeLink = anchor.previousSibling
      const preceding = beforeLink.textContent.trimEnd() ? beforeLink : beforeLink.previousSibling
      const text = anchor.lastChild
      const measure = document.createRange()
      const character = (node, index) => {
        measure.setStart(node, index)
        measure.setEnd(node, index + 1)
        return measure.getBoundingClientRect()
      }
      const proseEnd = character(preceding, preceding.data.trimEnd().length - 1).right
      const labelStart = character(text, 0).left
      const artworkEnd = box.right - parseFloat(getComputedStyle(image).paddingRight)
      const clips = [(proseEnd + box.left) / 2, box.left + 1.5, (artworkEnd + labelStart) / 2]
        .map(x => ({ x: Math.floor(x), y: Math.ceil(box.top) + 1, width: 1, height: 1, scale: 1 }))
      return {
        left: box.left - proseEnd, right: labelStart - artworkEnd,
        space: character(text, text.data.indexOf(' ')).width, clips
      }
    })()`)
    assert.ok(Math.abs(gaps.left - gaps.space) < 0.75 && Math.abs(gaps.right - gaps.space) < 0.75, `${region} icon gaps each match one space: ${JSON.stringify(gaps)}`)

    const captureSelection = async () => {
      const samples = []
      for (const clip of clips) samples.push((await send('Page.captureScreenshot', { format: 'png', clip })).data)
      return samples
    }
    const unselected = await captureSelection()
    const selectedText = await evaluate(`(() => {
      const selection = getSelection()
      selection.selectAllChildren(${link})
      return selection.toString()
    })()`)
    assert.equal(selectedText, 'Open source', `${region} selection retains the original link text`)
    await evaluate(`getSelection().selectAllChildren(${link}.parentElement)`)
    const selected = await captureSelection()
    for (const [index, part] of ['leading space', 'icon', 'trailing space'].entries()) {
      assert.notEqual(selected[index], unselected[index], `${region} native selection paints the ${part}`)
    }
    await evaluate('getSelection().removeAllRanges()')

    const decorationLine = () => evaluate(`getComputedStyle(${link}).textDecorationLine`)
    assert.equal(await decorationLine(), 'none', `${region} link has no underline at rest`)
    const labelRange = `(() => {
      const range = document.createRange()
      range.selectNode(${link}.lastChild)
      return range
    })()`
    for (const [part, target] of [['icon', icon], ['label', labelRange]]) {
      await hoverLink(link, target)
      assert.equal(await decorationLine(), 'none', `${region} hovering the ${part} leaves the file link without an underline`)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    await waitFor(`!${link}.matches(':hover')`, `${region} link hover ends`)
  }
  const webLink = `shown('[data-file-markdown] a[href="https://example.com"]')`
  await hoverLink(webLink)
  assert.deepEqual(await evaluate(`(() => {
    const style = getComputedStyle(${webLink})
    return [style.textDecorationLine, style.textDecorationStyle, style.textUnderlineOffset]
  })()`), ['underline', 'dotted', '3px'], 'web links retain the dotted underline on hover')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  for (const [style, pack] of [['rounded', 'pierre'], ['squircle', 'pierre'], ['square', 'pierre-square']]) {
    await evaluate(`setFixtureUiStyle(${JSON.stringify(style)})`)
    await waitFor(`(() => {
      const icons = [...shownAll('[data-markdown] a[href="src/App.tsx:2"] [data-file-icon]')]
      return icons.length === 2 && icons.every(icon => icon.getAttribute('src') === './file-icons/${pack}/react.svg' && icon.naturalWidth > 0)
    })()`, `both file links show ${style} artwork`)
  }
  console.log('PASS: Markdown file links share file-type artwork, single-space gaps, native selection and hover decoration')
  // A conversation link opens the preview on its own: the tab's tree column
  // stays folded, and showing it is the toolbar's own action for that tab.
  assert.equal(await evaluate('!!shown("[data-file-tree-column]")'),false,'a conversation link does not expand the file tree')
  assert.equal(await evaluate(`files.getSnapshot().tabs.find(tab=>tab.path===files.getSnapshot().active).treeOpen`),false,'the linked tab keeps its tree folded')
  assert.ok(await evaluate(`!!shown('[aria-label="Show file tree"]')`),'the folded tree stays one toolbar action away')
  await click('[aria-label="Show file tree"]')
  await waitFor('shown("[data-file-tree-column]")','the toolbar expands the tree for this tab')
  assert.equal(await evaluate(`files.getSnapshot().tabs.find(tab=>tab.path===files.getSnapshot().active).treeOpen`),true,'that expansion belongs to this tab')
  assert.equal(await evaluate('!!shown("[data-file-tabs]")'),false,'no nested file tabs')
  assert.ok(await evaluate('Array.from(shownAll("[data-sidebar-tabs] [role=tab]")).some(tab=>tab.textContent==="README.md")'))
  assert.ok(await evaluate('!Array.from(shownAll("[data-sidebar-tabs] [role=tab]")).some(tab=>tab.textContent==="Files")'))
  // A conversation link whose path contains a space is bracketed before parsing,
  // so it is a real link here and opens the file its author named — the href
  // carries the encoded space and the click path decodes it back.
  assert.deepEqual(await evaluate('resolveFile("My%20Notes.md", "/project")'),{path:'/project/My Notes.md'})
  assert.equal(await evaluate(`shown('a[href="My%20Notes.md"]').textContent`),'Spaced note','spaced destination renders as a link')
  await click('a[href="My%20Notes.md"]')
  await waitFor(`files.getSnapshot().active===${JSON.stringify(join(project,'My Notes.md'))}`,'spaced-name link opens its file')
  assert.equal(await evaluate('shown("[data-file-markdown] strong").textContent'),'带空格的文件'); console.log('PASS: spaced link destination opens its file')
  assert.equal(await evaluate(`getComputedStyle(shown('[data-file-preview] [role=tab][aria-selected=true]')).backgroundColor`),'rgba(0, 0, 0, 0)','view switch uses underline with no filled segment')
  assert.equal(await evaluate(`shown('[data-file-preview] [role=tab][aria-selected=true] > span').getBoundingClientRect().height`),1,'native beUI underline indicator')
  await click('[aria-label="Show file tree"]')
  await waitFor('shown("[data-file-tree] [data-file-icon$=\\"package.json\\"]")','file type icons')
  assert.deepEqual(await evaluate(`['README.md','package.json','data.json','file#25%.txt'].map(name=>shown('[data-file-tree] [data-file-icon$="'+name+'"]').getAttribute('src').split('/').pop())`),['markdown.svg','json.svg','json.svg','text.svg'],'file rows render the selected Pierre filename and extension associations')
  // The icons are separate SVG files in the public directory, so this also
  // proves the relative URL resolves in the packaged file:// renderer.
  assert.equal(await evaluate(`Array.from(shownAll('[data-file-tree] [data-file-icon]')).filter(img=>!(img.complete&&img.naturalWidth>0)).length`),0,'file-type icons decode')
  await click('[aria-label="New tab"]')
  await click('a[href="README.md"]')
  await waitFor('shown("[data-file-markdown]")','file link dismisses pane picker')
  // Conversation links open the file without rearranging the tree: the new
  // tab's tree column stays folded, and a nested target's ancestors stay
  // collapsed, so its row never enters the tree DOM. The browsing path (the
  // tree, i.e. the store's default open) re-expands the tree column
  // and reveals the same file by expanding its ancestors and showing the
  // selection.
  await click('[data-from="assistant"] a[href="src/App.tsx:2"]')
  await waitFor('shown("[data-source-line=\\"2\\"]")','conversation source link opens its file')
  assert.equal(await evaluate('!!shown("[data-file-tree-column]")'),false,'a conversation link folds the tree for the new tab')
  assert.equal(await evaluate(`files.getSnapshot().expanded.includes(${JSON.stringify(join(project,'src'))})`),false,'conversation links leave the tree as the user arranged it')
  assert.equal(await evaluate('!!shown("[data-file-tree] [aria-selected=true]")'),false,'an unrevealed file has no selected tree row')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'src/App.tsx'))}})`)
  await waitFor(`files.getSnapshot().expanded.includes(${JSON.stringify(join(project,'src'))})`,'browsing opens reveal the file in the tree')
  await waitFor('shown("[data-file-tree] [aria-selected=true]")','revealed file shows its selected row')
  await selectTab('README.md')
  await waitFor('shown("[data-file-markdown]")','back to the markdown tab')
  await view('Source');await waitFor('shown("[data-file-source] [style*=agent-code-light]")','markdown source highlighting')
  await view('Diff');await waitFor('shown("[data-file-preview]").textContent.includes("No changes from HEAD")','clean diff')
  await view('Preview');await click('[data-file-markdown] a[href="src/App.tsx:2"]')
  await waitFor('shown("[data-source-line=\\"2\\"]")','line link')
  assert.equal(await evaluate('files.getSnapshot().tabs.find(t=>t.path===files.getSnapshot().active).line'),2)
  await view('Diff');await waitFor('shown("[data-file-diff]")','source diff')
  assert.equal(await evaluate(`shown(${JSON.stringify(wrapDiffButton)}).getAttribute('aria-pressed')`), 'true', 'working diffs default to wrapping')
  await click(wrapDiffButton)
  assert.ok(await evaluate('shown("[data-file-diff]").innerText.includes("original")'))
  await waitFor('shown("[data-file-diff] [data-agent-code-token]")','diff highlighting')
  await view('Source');await holdDiff()
  const warmFrames=await diffFrames(`Array.from(shownAll('[data-file-view-tabs] [role=tab]')).find(tab=>tab.textContent==='Diff').click()`)
  assert.ok(warmFrames.every(frame=>frame.present&&frame.rows>0),'each warm Diff frame paints the cached rows while validating')
  const unchangedBody=await evaluate(`shown('[data-file-diff]').innerHTML`)
  await releaseDiff();await pause(100)
  assert.equal(await evaluate(`shown('[data-file-diff]').innerHTML`),unchangedBody,'unchanged validation preserves highlighted diff content')
  await holdDiff()
  await writeFile(join(project,'src/App.tsx'),`export const updated = true;\nexport const secondLine = "中文";\nexport const refreshedDiff = "${'unbroken'.repeat(100)}";\n`)
  const refreshFrames=await diffFrames(`shown('[aria-label="Refresh files"]').click()`)
  assert.ok(refreshFrames.every(frame=>frame.present&&frame.rows>0),'refresh keeps diff rows painted while the read is pending')
  await releaseDiff();await waitFor('shown("[data-file-diff]")?.textContent.includes("refreshedDiff")','diff refresh discovers disk edits')
  await waitFor(diffOverflows, 'unwrapped diff overflows')
  await evaluate(`window.longDiffRow = Array.from(shownAll('[data-file-diff] .grid')).find(row => row.textContent.includes('refreshedDiff')); void 0`)
  await click(wrapDiffButton)
  await waitFor(`!(${diffOverflows}) && longDiffRow.offsetHeight > 20`, 'single-file diff wraps a long line in place')
  assert.equal(await evaluate(`shown(${JSON.stringify(wrapDiffButton)}).getAttribute('aria-pressed')`), 'true')
  assert.ok(await evaluate(`longDiffRow.isConnected && !!longDiffRow.querySelector('[data-agent-code-token]')`), 'wrapped diff retains the highlighted logical row')
  await click(wrapDiffButton)
  await waitFor(`${diffOverflows} && longDiffRow.offsetHeight === 20`, 'single-file diff restores horizontal scrolling')
  await selectTab('README.md');await holdDiff()
  const revisitFrames=await diffFrames(`Array.from(shownAll('[data-sidebar-tabs] [role=tab]')).find(tab=>tab.textContent==='App.tsx').click()`)
  assert.ok(revisitFrames.every(frame=>frame.present&&frame.rows>0),'revisiting a file tab paints its cached diff before Git responds')
  await releaseDiff()

  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(longDiffPath)}})`)
  await waitFor('shown("[data-file-source]")?.textContent.includes("updated0")','long diff source')
  await view('Diff');await waitFor('Number(shown("[data-review-diff]")?.dataset.reviewLines)>400','virtual diff')
  await evaluate(`shown('[data-file-diff]').scrollTop=32020`)
  await waitFor('shown("[data-file-diff]")?.textContent.includes("updated400")','distant diff rows')
  await evaluate(`(() => {
    const viewport = shown('[data-file-diff]')
    const anchor = shownAll('[data-file-diff] .grid').find(row => row.textContent.includes('updated400'))
    viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })()`)
  const diffTop=await evaluate(`shown('[data-file-diff]').scrollTop`)
  await view('Source');await holdDiff()
  const distantFrames=await diffFrames(`Array.from(shownAll('[data-file-view-tabs] [role=tab]')).find(tab=>tab.textContent==='Diff').click()`)
  assert.ok(distantFrames.every(frame=>frame.present&&frame.rows>0&&frame.top===diffTop),'restored distant diffs never paint an empty virtual window: '+JSON.stringify(distantFrames))
  await releaseDiff()
  await click(wrapDiffButton)
  await waitFor(`!(${diffOverflows}) && shown('[data-file-diff]').textContent.includes('TAIL_OF_DIFF')`, 'windowed diff wraps distant CJK text and retains the line ending')
  assert.ok(await evaluate(`Array.from(shown('[data-file-diff]').querySelectorAll('[data-diff-inline]'), mark=>mark.textContent).join('').includes('NEW_TAIL_OF_DIFF')`), 'the changed suffix is highlighted in a wrapped continuation of a virtual row')
  const wrappedDiff = await evaluate(`(() => {
    const viewport = shown('[data-file-diff]')
    const rows = Array.from(viewport.querySelectorAll('[data-slot="file-diff-viewport"] .grid'))
    const anchor = rows.find(row => row.textContent.includes('updated400'))
    return { count: rows.length, top: anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top, height: viewport.scrollHeight }
  })()`)
  assert.ok(wrappedDiff.count < 110, 'wrapped rows keep a bounded window')
  assert.ok(Math.abs(wrappedDiff.top) <= 1, 'wrapping keeps the distant logical line at the top')
  await click('[data-file-toolbar] button[aria-label="Hide file tree"]')
  await waitFor(`shown('[data-file-diff]').scrollHeight < ${wrappedDiff.height} && !(${diffOverflows})`, 'widening the pane reflows wrapped virtual rows')
  await click('[data-file-toolbar] button[aria-label="Show file tree"]')
  await waitFor(`shown('[data-file-diff]').scrollHeight === ${wrappedDiff.height}`, 'narrowing the pane restores the wrapped row heights')
  await click(wrapDiffButton)
  await waitFor(`${diffOverflows} && shown('[data-file-diff]').scrollTop === ${diffTop}`, 'unwrapping restores the same reading line and horizontal scrolling')
  const diffLayoutButton = '[data-file-view-tabs] [data-diff-layout-toggle]'
  await click(diffLayoutButton)
  await waitFor(`shown('[data-diff-side="before"]')?.textContent.includes('original400') && shown('[data-diff-side="after"]')?.textContent.includes('updated400')`, 'split diff keeps the distant change in the viewport')
  const aligned = await evaluate(`(() => {
    const viewport = shown('[data-file-diff]')
    const before = shownAll('[data-diff-side="before"] .grid').find(row => row.textContent.includes('original400'))
    const after = shownAll('[data-diff-side="after"] .grid').find(row => row.textContent.includes('updated400'))
    return {left: before.getBoundingClientRect().top, right: after.getBoundingClientRect().top, top: viewport.getBoundingClientRect().top}
  })()`)
  assert.ok(Math.abs(aligned.left - aligned.right) <= 1 && Math.abs(aligned.right - aligned.top) <= 1, 'matched change rows stay aligned at the reading position')
  await click(wrapDiffButton)
  await waitFor(`shownAll('[data-diff-side]').every(side => side.scrollWidth <= side.clientWidth + 1) && shown('[data-diff-side="after"]').textContent.includes('NEW_TAIL_OF_DIFF')`, 'the split view wraps both long lines and keeps the changed suffix')
  assert.ok(await evaluate(`shownAll('[data-diff-side] .grid').length < 220`), 'both columns stay windowed when wrapped')
  await click(wrapDiffButton)
  await click(diffLayoutButton)
  await waitFor('!shown("[data-diff-side]")', 'switching back uses the stacked view')
  await selectTab('App.tsx');await click('[aria-label="Close long-diff.ts"]')
  console.log('PASS: cached diff frames survive source switches, pending refreshes and rail revisits; wrapping preserves the window and reflows on resize')
  await view('Source');await waitFor('shown("[data-file-source]")','source')
  await waitFor('shown(\'[aria-label="Open in default app"]\')','default-open toolbar button')
  assert.equal(await evaluate(`!!shown('[data-file-open-menu]')`),false,'open-with menu removed')
  assert.ok(await evaluate(`shown('[aria-label="Refresh files"]').getBoundingClientRect().right<=shown('[aria-label="Open in default app"]').getBoundingClientRect().left`),'Refresh precedes open control')
  // The composer carries the session-scoped sandbox switcher next to the model
  // picker. This fixture's snapshot records no mode, so the store's default
  // (workspace-write) is what the control must show.
  const modeTrigger = await evaluate(`(()=>{const node=shown('[aria-label="Sandbox mode"]');return node?node.textContent.trim():null})()`)
  assert.ok(modeTrigger, 'the composer offers a sandbox mode switcher')
  assert.match(modeTrigger, /Workspace write/, `the switcher shows the session's mode: ${modeTrigger}`)
  // Every entry leads with its own glyph, and full access — the one mode that
  // runs unconfined — wears the warning colour in the list and in the trigger.
  // The panel stays mounted while closed, so the options are readable without
  // opening it.
  const modeList = await evaluate(`(()=>{const probe=document.createElement('span');probe.className='text-amber-600 dark:text-amber-400';document.body.appendChild(probe);const warning=getComputedStyle(probe).color;probe.remove();const icons=[...shownAll('[data-sandbox-mode-option]')];const trigger=shown('[data-sandbox-mode-icon]');return {warning,triggerMode:trigger.dataset.sandboxModeIcon,trigger:getComputedStyle(trigger).color,options:icons.map(node=>({mode:node.dataset.sandboxModeOption,label:node.textContent.trim(),color:getComputedStyle(node.querySelector('svg')).color}))}})()`)
  assert.deepEqual(
    modeList.options.map((option) => option.mode),
    ['read-only', 'workspace-write', 'danger-full-access'],
    `every mode has an entry with its own glyph: ${JSON.stringify(modeList.options)}`
  )
  assert.ok(modeList.options.every((option) => option.label), `entries stay labelled: ${JSON.stringify(modeList.options)}`)
  const fullAccess = modeList.options.find((option) => option.mode === 'danger-full-access')
  assert.equal(fullAccess.color, modeList.warning, `full access wears the warning colour: ${JSON.stringify(modeList)}`)
  assert.ok(
    modeList.options.filter((option) => option.mode !== 'danger-full-access').every((option) => option.color !== modeList.warning),
    `the confined modes do not: ${JSON.stringify(modeList)}`
  )
  assert.equal(modeList.triggerMode, 'workspace-write', `the trigger shows the selected mode's own glyph: ${JSON.stringify(modeList)}`)
  assert.notEqual(modeList.trigger, modeList.warning, `that glyph is not the warning tone: ${JSON.stringify(modeList)}`)

  // A pending escalation renders as beUI's approval card right above the
  // composer, and answering it goes back through IPC carrying the question's own
  // identity — never a bare "approve" anyone could replay.
  await evaluate(`window.escalate([{requestId:'req-1',sessionId:'fixture',sessionPath:'/ui/fixture',toolCallId:'call',toolName:'edit',currentMode:'workspace-write',requestedMode:'danger-full-access',justification:'needs to write outside the workspace',createdAt:Date.now(),operation:{cwd:${JSON.stringify(project)},parameters:{path:${JSON.stringify(join(outside,'plain.md'))},edits:[{oldText:'Outside project',newText:'Edited outside project'}]}}}])`)
  await waitFor('!!shown("[data-sandbox-escalation]")','the escalation card appears')
  const escalationText = await evaluate(`shown('[data-sandbox-escalation]').textContent`)
  assert.match(escalationText, /Sandbox escalation/, `the card names the request: ${escalationText}`)
  assert.match(escalationText, /needs to write outside the workspace/, 'the model\'s own reason is shown, not a paraphrase')
  assert.match(escalationText, /Full access/, 'the card names the mode being requested')
  const escalationButtons = await evaluate(`[...shownAll('[data-sandbox-escalation] button')].map(node=>node.textContent.trim())`)
  assert.ok(
    escalationButtons.some((label) => /Allow once/i.test(label)),
    `the card offers a one-shot approval: ${JSON.stringify(escalationButtons)}`
  )
  // DSH's escalation is one call at a time: there is no standing grant to click,
  // and offering one would outlive the question the user is answering.
  assert.equal(
    escalationButtons.some((label) => /always/i.test(label)),
    false,
    `no standing grant is offered: ${JSON.stringify(escalationButtons)}`
  )
  const approved = await evaluate(`(()=>{const button=[...shownAll('[data-sandbox-escalation] button')].find(node=>/Allow once/i.test(node.textContent));if(!button)return false;button.click();return true})()`)
  assert.ok(approved, 'the one-shot approval is clickable')
  await waitFor('window.pi.appInfo().then(info=>info.fileIo.escalationAnswers.length===1)','the answer reaches main')
  assert.deepEqual(
    (await evaluate('window.pi.appInfo()')).fileIo.escalationAnswers,
    [{ requestId: 'req-1', sessionPath: '/ui/fixture', decision: 'approve' }],
    'the answer carries the question identity and the decision'
  )
  await evaluate(`window.escalate([])`)
  await waitFor('!shown("[data-sandbox-escalation]")','answering clears the card')
  if(process.env.PI_FILES_SCREENSHOT_DIR){
    await mkdir(process.env.PI_FILES_SCREENSHOT_DIR,{recursive:true})
    for(const dark of [false,true]){await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);await pause(300);const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.PI_FILES_SCREENSHOT_DIR,`files-toolbar-${dark?'dark':'light'}.png`),Buffer.from(shot.data,'base64'))}
    await evaluate("document.documentElement.classList.remove('dark')")
  }
  await click('[aria-label="Open in default app"]')
  await waitFor('shown(".app-toast-region")?.textContent.includes("Could not complete")','open failure localized as a toast')
  assert.equal((await evaluate('window.pi.appInfo()')).fileIo.opened.at(-1),join(project,'src/App.tsx'),'default open passes the literal file path')
  await click('[aria-label="Open in default app"]')
  await waitFor('!shown(".app-toast-region")?.textContent.includes("Could not complete")','retry clears the previous failure toast')
  await click('[aria-label="Open enclosing folder"]')
  assert.equal((await evaluate('window.pi.appInfo()')).fileIo.revealed.at(-1),join(project,'src/App.tsx'),'reveal passes the literal file path')
  await click('[aria-label="Save as…"]')
  assert.equal((await evaluate('window.pi.appInfo()')).fileIo.saved.at(-1),join(project,'src/App.tsx'),'save copy invoked')
  await pause(300)
  const ioBeforeResize=(await evaluate('window.pi.appInfo()')).fileIo
  await evaluate(`window.resizeProbe={source:shown('[data-file-source]'),lines:[...shownAll('[data-source-line]')],frames:[],blank:0,changed:0,last:performance.now(),running:true};function sampleResize(now){const p=resizeProbe,source=shown('[data-file-source]');p.frames.push(now-p.last);p.last=now;if(source!==p.source||p.lines.some(line=>!line.isConnected))p.changed++;if(!source?.textContent||getComputedStyle(source).opacity==='0'||source.getBoundingClientRect().width<139)p.blank++;if(p.running)requestAnimationFrame(sampleResize)}requestAnimationFrame(sampleResize)`)
  const handle=await evaluate(`(()=>{const r=shown('[data-files-pane] [role=separator][aria-orientation=vertical]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+120,width:shown('[data-file-tree-column]').getBoundingClientRect().width}})()`)
  const captureInfo=await evaluate(`(()=>{const source=shown('[data-file-source]').getBoundingClientRect(),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(shown('[data-files-pane]')).backgroundColor;ctx.fillRect(0,0,1,1);return {width:innerWidth,height:innerHeight,y:source.y+8,background:[...ctx.getImageData(0,0,1,1).data].slice(0,3)}})()`)
  const frames=[]
  const capture=event=>{const message=JSON.parse(event.data);if(message.method==='Page.screencastFrame'){frames.push(message.params.data);void send('Page.screencastFrameAck',{sessionId:message.params.sessionId})}}
  ws.addEventListener('message',capture)
  await send('Page.startScreencast',{format:'png',everyNthFrame:1})
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y})
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:handle.x,y:handle.y})
  for(let i=1;i<=24;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:handle.x+Math.sin(i/24*Math.PI*2)*90,y:handle.y});await pause(16)}
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:handle.x+50,y:handle.y})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:handle.x+50,y:handle.y})
  await pause(100)
  await send('Page.stopScreencast');ws.removeEventListener('message',capture)
  const probe=await evaluate(`(()=>{resizeProbe.running=false;return {blank:resizeProbe.blank,changed:resizeProbe.changed,maxFrame:Math.max(...resizeProbe.frames),width:shown('[data-file-tree-column]').getBoundingClientRect().width,saved:files.getSnapshot().treeWidth}})()`)
  assert.equal(probe.blank,0,'preview stays visible throughout drag');assert.equal(probe.changed,0,'drag retains source and token DOM');assert.ok(Math.abs(probe.width-handle.width-50)<2);assert.equal(probe.width,probe.saved)
  const ink=[]
  for(const frame of frames)ink.push(await evaluate(`(async()=>{const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,${frame}')).blob());const canvas=document.createElement('canvas');canvas.width=90;canvas.height=40;const ctx=canvas.getContext('2d');const sx=bitmap.width/${captureInfo.width},sy=bitmap.height/${captureInfo.height};ctx.drawImage(bitmap,${handle.x+155}*sx,${captureInfo.y}*sy,90*sx,40*sy,0,0,90,40);bitmap.close();const data=ctx.getImageData(0,0,90,40).data,bg=${JSON.stringify(captureInfo.background)};let count=0;for(let i=0;i<data.length;i+=4)if(Math.max(...bg.map((v,j)=>Math.abs(data[i+j]-v)))>50)count++;return count/3600})()`))
  assert.ok(frames.length>=8,'captured multiple compositor frames');assert.ok(ink.every(value=>value>0.01&&value<0.75),'rendered code never disappears: '+JSON.stringify(ink))
  console.log('PASS: no blank preview in '+frames.length+' compositor frames; minimum ink '+Math.min(...ink).toFixed(3))
  const ioAfterResize=(await evaluate('window.pi.appInfo()')).fileIo
  assert.equal(ioAfterResize.documents.length,ioBeforeResize.documents.length,'drag never reloads the document');assert.equal(ioAfterResize.directories.length,ioBeforeResize.directories.length,'drag never reloads the tree')
  console.log('PASS: default-open/reveal/save-copy toolbar; live drag '+JSON.stringify(probe))
  await evaluate('files.setTreeWidth(160)')
  const ellipsis=await evaluate(`(()=>{const row=[...shownAll('[data-file-tree] [role=treeitem]')].find(row=>row.getAttribute('aria-label')==='AuthenticationProviderWithAVeryLongName.tsx'),label=row.querySelector('[data-middle-ellipsis]'),head=label.firstElementChild,tail=label.lastElementChild;return {height:row.offsetHeight,name:label.textContent,head:head.textContent,tail:tail.textContent,clipped:head.scrollWidth>head.clientWidth,ellipsis:getComputedStyle(head).textOverflow,tailFits:tail.getBoundingClientRect().right<=row.getBoundingClientRect().right,headWidth:head.clientWidth}})()`)
  assert.equal(ellipsis.height,32);assert.equal(ellipsis.name,'AuthenticationProviderWithAVeryLongName.tsx');assert.equal(ellipsis.tail,'.tsx');assert.ok(ellipsis.clipped&&ellipsis.tailFits&&ellipsis.headWidth>20);assert.equal(ellipsis.ellipsis,'ellipsis')
  await evaluate('files.setTreeWidth(208)')

  // Context menu on a tree row: the app renders one menu for the whole tree and
  // resolves the row under the pointer. The vendored menu keeps its portal
  // mounted and dismisses by hiding it (`aria-hidden` + `inert` +
  // `pointer-events: none`), so "closed" means exactly that — and reading the
  // items requires the portal that is actually open. Assertions use the mock's
  // reveal record so they prove the right-clicked row was passed, not merely
  // that a panel opened.
  // Two menus can be mounted at once (the rail strip and the file tree), and
  // the vendored menu keeps every portal in the document. "The menu" therefore
  // means the one that is not hidden — a bare querySelector returns whichever
  // renders first, which is how this check silently read the wrong portal.
  const menuState = () => evaluate(`(()=>{const portals=[...shownAll('[data-context-menu-portal]')];const shown=portals.find(p=>p.getAttribute('aria-hidden')!=='true'&&!p.hasAttribute('inert')&&getComputedStyle(p).pointerEvents!=='none');const portal=shown??portals[0];if(!portal)return {open:false,items:[]};return {open:Boolean(shown),items:Array.from(portal.querySelectorAll('[role=menuitem]')).map(node=>node.textContent.trim())}})()`)
  const settleMenu = async (wantOpen, label) => {
    for (let i = 0; i < 60; i++) { if ((await menuState()).open === wantOpen) return; await pause(50) }
    assert.fail(`${label}: the context menu did not ${wantOpen ? 'open' : 'close'}`)
  }
  const openRowMenu = async (label) => {
    await evaluate(`(()=>{const row=[...shownAll('[data-file-tree] [role=treeitem]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)});if(!row)throw new Error('no tree row: '+${JSON.stringify(label)});const box=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.x+8,clientY:box.y+6}))})()`)
    await settleMenu(true, `the menu for ${label}`)
  }
  const clickMenuItem = async (text) => {
    const clicked = await evaluate(`(()=>{const portals=[...shownAll('[data-context-menu-portal]')];const portal=portals.find(p=>p.getAttribute('aria-hidden')!=='true'&&!p.hasAttribute('inert'))??portals[0];const item=[...portal.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.trim()===${JSON.stringify(text)});if(!item)return false;item.click();return true})()`)
    assert.ok(clicked, `menu item "${text}" exists`)
  }

  await openRowMenu('package.json')
  const fileMenu = (await menuState()).items
  for (const label of ['Open in default app', 'Open enclosing folder', 'Save as…', 'Copy path']) {
    assert.ok(fileMenu.includes(label), `a file row offers "${label}": ${JSON.stringify(fileMenu)}`)
  }
  await clickMenuItem('Open enclosing folder')
  assert.equal((await evaluate('window.pi.appInfo()')).fileIo.revealed.at(-1), join(project, 'package.json'), 'the menu acted on the right-clicked row, not on the open tab')
  await settleMenu(false, 'choosing an item')

  // A folder row is not a file, and Escape dismisses without acting.
  await openRowMenu('src')
  const folderMenu = (await menuState()).items
  assert.ok(folderMenu.includes('Copy path'), `a folder row offers its path: ${JSON.stringify(folderMenu)}`)
  assert.equal(folderMenu.includes('Save as…'), false, `a folder row does not offer save-as: ${JSON.stringify(folderMenu)}`)
  // Escape is handled by the menu's own container, so it must be dispatched
  // from inside it — which is also how a keyboard user dismisses it.
  // Escape must reach the menu that is actually open — with two menus mounted
  // the first portal in the document is the rail strip's, so dispatching there
  // dismissed the wrong one and left this one on screen.
  await evaluate(`(()=>{const portals=[...shownAll('[data-context-menu-portal]')];const portal=portals.find(p=>p.getAttribute('aria-hidden')!=='true'&&!p.hasAttribute('inert'));if(!portal)return;const item=portal.querySelector('[role=menuitem]:not([disabled])');const target=item??portal;target.focus();target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`)
  await settleMenu(false, 'Escape')

  await click('[aria-label="Hide file tree"]');assert.equal(await evaluate('!!shown("[data-file-tree]")'),false)
  await click('[aria-label="Show file tree"]');await waitFor('shown("[role=treeitem][aria-selected=true]")','selection')
  assert.ok(await evaluate('shown("[role=treeitem][aria-selected=true]").querySelector("[data-file-icon]").dataset.fileIcon.endsWith("App.tsx")'))
  await evaluate(`shown('[role=treeitem][aria-selected=true]').focus()`)
  await press('ArrowLeft',37)
  assert.equal(await evaluate('document.activeElement.textContent'),'src','native tree goes to parent')
  await press('ArrowLeft',37)
  await waitFor('document.activeElement.getAttribute("aria-expanded")==="false"','native tree collapses folder')
  await press('ArrowRight',39)
  await waitFor('document.activeElement.getAttribute("aria-expanded")==="true"','native tree expands folder')
  await press('ArrowRight',39)
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'App.tsx','native tree enters folder')
  await press('Home',36)
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-level")'),'1','native tree Home')
  await press('End',35)
  await press('Enter',13)
  await waitFor('shown("[data-file-source]")?.textContent.includes("中文 UTF16")','native tree opens focused file')
  assert.equal(await evaluate('shown("[data-sidebar-tabs] [aria-selected=true]").textContent'),'utf16.txt','keyboard open uses one top-level file tab')
  await click('[aria-label="Close utf16.txt"]')
  await waitFor('shown("[data-file-source]")?.textContent.includes("secondLine")','closing active file selects left neighbour')
  await click('[aria-label="Hide file tree"]')
  await selectTab('README.md')
  await waitFor('shown("[data-file-markdown]") && shown("[data-file-tree]")','each file keeps its view and tree toggle')
  await selectTab('App.tsx')
  await waitFor('shown("[data-file-source]") && !shown("[data-file-tree]")','source file tree stays collapsed')
  await click('[aria-label="Show file tree"]')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'many/304.txt'))}})`)
  await waitFor('shown("[role=treeitem][aria-selected=true]")?.querySelector("[data-file-icon]").dataset.fileIcon.endsWith("/many/304.txt")','linked file beyond directory page')
  await waitFor(selectedTreeVisible,'paged tree reveals selected file')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'large.ts'))},line:13000})`)
  await waitFor('shown("[data-source-line=\\"13000\\"]")','far line')
  assert.ok(await evaluate('shownAll("[data-source-line]").length<150'))
  assert.ok(await evaluate('shown("[data-file-source]").scrollTop>200000'))
  await waitFor('shown("[data-file-source] [style*=agent-code-light]")','large source worker highlight')
  // Wrapping must survive a live tree drag without flicker: re-segmentation is
  // settle-debounced, so the gesture itself performs zero row re-renders.
  await click('[aria-label="Wrap lines"]')
  await waitFor(`(()=>{const s=shown('[data-file-source]');return s.scrollWidth<=s.clientWidth+1})()`,'large file wraps without overflow')
  await evaluate(`window.wrapDrag={frames:[],last:performance.now(),blank:0,changed:0,running:true,source:shown('[data-file-source]'),lines:[...shownAll('[data-source-line]')]};function sampleWrapDrag(now){const p=window.wrapDrag,source=shown('[data-file-source]');p.frames.push(now-p.last);p.last=now;if(source!==p.source||p.lines.some(line=>!line.isConnected))p.changed++;if(!source?.textContent||getComputedStyle(source).opacity==='0')p.blank++;if(p.running)requestAnimationFrame(sampleWrapDrag)}requestAnimationFrame(sampleWrapDrag)`)
  const wrapHandle=await evaluate(`(()=>{const r=shown('[data-files-pane] [role=separator][aria-orientation=vertical]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+120}})()`)
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:wrapHandle.x,y:wrapHandle.y})
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:wrapHandle.x,y:wrapHandle.y})
  for(let i=1;i<=24;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:wrapHandle.x+Math.sin(i/24*Math.PI*2)*90,y:wrapHandle.y});await pause(16)}
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:wrapHandle.x+50,y:wrapHandle.y})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:wrapHandle.x+50,y:wrapHandle.y})
  await pause(30)
  const wrapDrag=await evaluate('window.wrapDrag.running=false;({blank:wrapDrag.blank,changed:wrapDrag.changed,maxFrame:Math.max(...wrapDrag.frames)})')
  assert.equal(wrapDrag.blank,0,'wrapped preview stays painted throughout the drag')
  assert.equal(wrapDrag.changed,0,'drag under wrap never remounts or disconnects source rows')
  console.log('DIAGNOSTIC: wrapped file resize '+JSON.stringify(wrapDrag))
  await pause(250)
  assert.ok(await evaluate(`shown('[data-file-source]').scrollWidth<=shown('[data-file-source]').clientWidth+1`),'settled drag re-segments to the final width')
  await click('[aria-label="Wrap lines"]')
  await evaluate('shown("[data-file-source]").scrollTop=180000')
  await pause(80)
  await click('[aria-label="Toggle sidebar"][aria-pressed]');await pause(350)
  await click('[aria-label="Toggle sidebar"][aria-pressed]')
  await waitFor('shown("[data-file-source]")?.scrollTop===180000','manual scroll survives rail after line navigation')
  await waitFor(`(()=>{const tab=shown('[data-sidebar-tabs] [aria-selected=true]'),bounds=tab.getBoundingClientRect(),viewport=tab.closest('.overflow-x-auto').getBoundingClientRect();return bounds.left>=viewport.left&&bounds.right<=viewport.right})()`,'active top-level tab remains visible in overflow')
  await evaluate(`window.keptSource=shown('[data-file-source]');window.keptFiles=files`)
  await selectTab('README.md')
  await waitFor(`keptSource.isConnected && keptSource.closest('[inert]')`, 'inactive source stays mounted and inert')
  await selectTab('large.ts')
  await waitFor(`shown('[data-file-source]')===keptSource && keptSource.scrollTop===180000`, 'source tab restores the same reading position')
  await evaluate(`setSession(${JSON.stringify(project)},'same-project-second-chat')`)
  await waitFor(`!shown('[data-files-pane]') && keptSource.isConnected`, 'a second chat starts with its own rail')
  await click('a[href="README.md"]')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'large.ts'))}})`)
  await waitFor(`shown('[data-file-source]') && shown('[data-file-source]')!==keptSource && shown('[data-file-source]').scrollTop===0`, 'the same path starts at an independent position in the second chat')
  await evaluate(`setSession(${JSON.stringify(project)})`)
  await waitFor(`shown('[data-file-source]')===keptSource && keptSource.scrollTop===180000`, 'the original chat restores the same source and scroll')
  await evaluate('window.files=keptFiles;delete window.keptSource;delete window.keptFiles')
  console.log('PASS: source viewport survives tab and conversation switches, with independent state for the same path')
  await evaluate(`files.open(${JSON.stringify(outside)},{path:${JSON.stringify(join(outside,'plain.md'))}})`)
  await waitFor('shown("[data-file-markdown]")?.textContent.includes("Outside project")','outside document')
  assert.ok(await evaluate('!Array.from(shownAll("[data-file-preview] [role=tab]")).some(t=>t.textContent==="Diff")'))
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'README.md'))}})`)
  await waitFor('shown("[data-file-markdown]")','return markdown')
  await click('[data-file-markdown] a[href="docs/guide.md"]')
  await waitFor('shown("[data-file-markdown] a")?.textContent==="Relative source"','relative guide')
  await click('[data-file-markdown] a')
  await waitFor('files.getSnapshot().active.endsWith("/src/App.tsx") && shown("[data-file-source]")','relative source')
  await click('[aria-label="Find in file"]')
  await evaluate(`const input=shown('[data-file-find] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'secondLine');input.dispatchEvent(new Event('input',{bubbles:true}));`)
  await waitFor('shown("[data-file-find] [role=status]")?.textContent.includes("1 / 1")','find matching line')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await waitFor('!shown("[data-file-find]")','Escape closes find')
  assert.equal(await evaluate('CSS.highlights.has("file-search-matches")'),false,'closing find removes native highlights')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'find.txt'))}})`)
  await waitFor('shown("[data-file-source]")?.textContent.includes("SDK SDK")','search fixture')
  await click('[aria-label="Find in file"]')
  const setQuery=async query=>evaluate(`(()=>{const input=shown('[data-file-find] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const findCount=async count=>waitFor(`shown('[data-file-find-count]').textContent===${JSON.stringify(count)}`,'occurrence count '+count)
  const activeMatch=()=>evaluate(`(()=>{const r=[...(CSS.highlights.get('file-search-active')??[])][0];return r?{text:r.toString(),offset:r.startOffset,left:r.getBoundingClientRect().left}:null})()`)
  await setQuery('SDK');await findCount('1 / 8')
  const countSlot=await evaluate(`shown('[data-file-find-count]').getBoundingClientRect().width`)
  const findInputWidth=async()=>evaluate(`shown('[data-file-find] input').getBoundingClientRect().width`)
  const initialInputWidth=await findInputWidth()
  const geometry=await evaluate(`(()=>{const bar=shown('[data-file-find]'),input=bar.querySelector('input'),mode=bar.querySelector('[aria-label="Match case"]'),b=bar.getBoundingClientRect(),f=input.parentElement.getBoundingClientRect(),i=input.getBoundingClientRect();return {height:bar.offsetHeight,fullyVisible:i.top>=f.top&&i.bottom<=f.bottom&&f.top>=b.top&&f.bottom<=b.bottom,modeVisible:mode.getBoundingClientRect().width,overflow:bar.scrollWidth>bar.clientWidth}})()`)
  assert.ok(geometry.fullyVisible,'find input fits its field and toolbar');assert.equal(geometry.overflow,false);assert.ok(geometry.modeVisible>0)
  const firstMatch=await activeMatch();assert.equal(firstMatch.text,'SDK')
  await evaluate('shown("[data-file-find] input").focus()');await press('Enter',13);await findCount('2 / 8')
  assert.equal(await findInputWidth(),initialInputWidth,'count digits never resize the input')
  assert.ok((await activeMatch()).left>firstMatch.left,'next occurrence on the same line has distinct bounds')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',modifiers:8});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await findCount('1 / 8')
  await click('[aria-label="Match case"]');await findCount('1 / 6')
  assert.equal(await findInputWidth(),initialInputWidth,'mode totals never resize the input')
  assert.equal(await evaluate(`shown('[data-file-find-count]').getBoundingClientRect().width`),countSlot,'count slot keeps a fixed width')
  await click('[aria-label="Match whole word"]');await findCount('1 / 5')
  await click('[aria-label="Match case"]');await findCount('1 / 7')
  for(let i=0;i<5;i++)await click('[aria-label="Next match"]')
  await findCount('6 / 7');assert.ok(await evaluate('shown("[data-file-source]").scrollLeft>500'),'long-line match scrolls horizontally into view')
  await click('[aria-label="Next match"]');await findCount('7 / 7')
  assert.ok(await evaluate('shown("[data-file-source]").scrollTop>15000'),'far match reveals a virtualized line')
  assert.equal((await activeMatch()).text,'SDK')
  await click('[aria-label="Next match"]');await findCount('1 / 7')
  assert.equal(await evaluate('shown("[data-file-source]").scrollLeft'),0,'return to first match restores line-number gutter')
  await click('[aria-label="Use regular expression"]');await setQuery('^SDK$');await findCount('1 / 1')
  await setQuery('[');await waitFor('shown("[data-file-find] input").getAttribute("aria-invalid")==="true"','invalid regex stays compact')
  assert.equal(await evaluate('shown("[data-file-find]").offsetHeight'),geometry.height,'invalid expressions do not move the find toolbar')
  await setQuery('SDK');await findCount('1 / 7')
  await evaluate(`window.searchFrames=[];window.searchLast=performance.now();window.searchSampling=true;function sampleSearch(now){searchFrames.push(now-searchLast);searchLast=now;if(searchSampling)requestAnimationFrame(sampleSearch)}requestAnimationFrame(sampleSearch)`)
  await setQuery('(a+)+$');await pause(180);await setQuery('SDK');await findCount('1 / 7')
  await setQuery('(a+)+$');await waitFor('shown("[data-file-find-count] [aria-label]")?.getAttribute("aria-label").includes("taking too long")','pathological regex times out outside renderer')
  const searchFrameMax=await evaluate('searchSampling=false;Math.max(...searchFrames)');assert.ok(searchFrameMax<150,'pathological regex does not freeze typing or rendering')
  await setQuery('SDK');await findCount('1 / 7');await pause(150);assert.equal((await activeMatch()).text,'SDK','canceled worker cannot overwrite newer results')
  await click('[aria-label="Use regular expression"]');await findCount('1 / 7')
  if(process.env.PI_FILES_SCREENSHOT_DIR)for(const dark of [false,true]){await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);await pause(150);const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.PI_FILES_SCREENSHOT_DIR,`files-find-${dark?'dark':'light'}.png`),Buffer.from(shot.data,'base64'))}
  await evaluate("document.documentElement.classList.remove('dark');files.setTreeWidth(480)");await pause(100)
  assert.equal(await evaluate('shown("[data-file-find]").offsetHeight'),geometry.height,'narrow search controls preserve the toolbar height')
  assert.ok(await evaluate('shown("[data-file-find]").scrollWidth<=shown("[data-file-find]").clientWidth'),'narrow find row stays within the preview')
  await click('[aria-label="Search options"]');await waitFor('Array.from(shownAll("[role=dialog] button")).some(b=>b.textContent.includes("Match whole word"))','narrow toolbar exposes all options')
  await press('Escape',27);assert.ok(await evaluate('!!shown("[data-file-find]")'),'Escape closes nested options before find')
  await evaluate('files.setTreeWidth(208)');await click('[aria-label="Close find"]')
  assert.equal(await evaluate('CSS.highlights.has("file-search-active")'),false,'highlight lifetime follows find')
  await click('[aria-label="Wrap lines"]')
  await waitFor(`(()=>{const s=shown('[data-file-source]');return s&&s.scrollWidth<=s.clientWidth+1})()`,'wrap removes horizontal overflow')
  const wrappedRows=await evaluate(`(()=>{const rows=[...shownAll('[data-source-line]')];return {tall:rows.filter(r=>r.offsetHeight>20).length,count:rows.length}})()`)
  assert.ok(wrappedRows.tall>0,'long lines wrap into taller fixed-height segments')
  assert.ok(wrappedRows.count<150,'wrap keeps the source windowed')
  await click('[aria-label="Find in file"]')
  // The earlier section leaves whole-word pressed; normalize the modes.
  await evaluate(`(()=>{const b=shown('[aria-label="Match whole word"]');if(b?.getAttribute('aria-pressed')==='true')b.click()})()`);await pause(80)
  await setQuery('SDK');await findCount('1 / 8')
  assert.equal(await evaluate('CSS.highlights.has("file-search-matches")'),true,'highlights paint across wrapped segments')
  await evaluate('shown("[data-file-find] input").focus()');await press('Enter',13);await findCount('2 / 8')
  await click('[aria-label="Close find"]')
  await click('[aria-label="Wrap lines"]')
  assert.ok(await evaluate(`shown('[data-file-source]').scrollWidth>shown('[data-file-source]').clientWidth`),'unwrap restores horizontal scrolling')
  await selectTab('App.tsx');await click('[aria-label="Close find.txt"]')
  console.log('PASS: 36px search, per-occurrence/Unicode highlights, case/whole-word/regex, horizontal/virtual navigation, cancellation/timeout; max frame '+searchFrameMax.toFixed(1)+'ms')

  await click('[aria-label="Toggle sidebar"][aria-pressed]');await pause(350)
  await click('[aria-label="Toggle sidebar"][aria-pressed]');await waitFor('shown("[data-file-source]")','rail restores file')
  await waitFor(selectedTreeVisible,'selected row stays visible after preceding expanded directories load')
  await click('[aria-label="New tab"]')
  await evaluate(`Array.from(shownAll('[data-panel=right] button')).find(button=>button.querySelector('span')&&button.textContent.startsWith('Browser')).click()`)
  await waitFor('shown("[data-sidebar-tabs] [aria-selected=true]").textContent==="Browser"','file and other pane tabs coexist')
  await click('[aria-label="Close README.md"]')
  assert.equal(await evaluate('shown("[data-sidebar-tabs] [aria-selected=true]").textContent'),'Browser','closing inactive file preserves other pane')
  await click('a[href="README.md"]')
  await waitFor('shown("[data-file-markdown]")','conversation link reopens closed file at top level')
  await click('[aria-label="Close README.md"]')
  await waitFor('shown("[data-sidebar-tabs] [aria-selected=true]").textContent==="Browser"','closing active file restores adjacent non-file pane')
  await selectTab('App.tsx')
  await waitFor('shown("[data-file-source]")?.textContent.includes("secondLine")','file selection independent of store neighbour after close')
  await waitFor(selectedTreeVisible,'reselect after other pane reveals file')
  await evaluate(`setSession(${JSON.stringify(outside)})`)
  await waitFor('!shown("[data-files-pane]")','another project starts with its own empty rail')
  await click('a[href="README.md"]')
  await waitFor('shown("[data-file-markdown]")?.textContent.includes("A different workspace")', 'the same relative filename opens in the new project')
  assert.deepEqual(await evaluate('files.getSnapshot().tabs.map(tab=>tab.path)'), [join(outside, 'README.md')])
  await click('[aria-label="Show file tree"]')
  await waitFor('shown("[data-file-tree] [data-file-icon]")','plain project file tree')
  assert.equal(await evaluate('!!shown("[data-file-tree-git], [aria-label=\\"Show Git changes in file tree\\"]")'), false, 'a non-repository has no Git marks or toggle')
  await evaluate(`setSession(${JSON.stringify(project)})`)
  await waitFor('shown("[data-file-source]")?.textContent.includes("secondLine")','returning restores the original selected file')
  await selectTab('guide.md')
  await waitFor('shown("[data-file-markdown] a[href=\\"../src/new.ts\\"]")','original document after session switch')
  await click('[data-file-markdown] a[href="../src/new.ts"]')
  await waitFor('shown("[data-file-source]")?.textContent.includes("followLink")','relative link after session switch')
  assert.equal(await evaluate('files.getSnapshot().tabs.find(tab=>tab.path.endsWith("/src/new.ts")).cwd'),project,'relative document links retain originating workspace')
  await selectTab('App.tsx')
  await waitFor('shown("[data-file-source]")?.textContent.includes("secondLine")','return original source')
  await waitFor(selectedTreeVisible,'selected source visible before screenshots')
  const treeRow = path => `shown(${JSON.stringify(`[data-file-tree] [data-tree-value=${JSON.stringify(join(project,path))}]`)})`
  const gitMark = path => `${treeRow(path)}?.querySelector('[data-file-tree-git]')`
  const gitToggle = '[aria-label="Show Git changes in file tree"]'
  await waitFor(`${gitMark('src/App.tsx')}`, 'modified file decoration')
  assert.deepEqual(await evaluate(`[${gitMark('src/App.tsx')}, ${gitMark('untracked.py')}, ${gitMark('deleted.txt')}, ${gitMark('vanished')}].map(mark=>mark?.dataset.fileTreeGit)`), ['modified','untracked','deleted','folder'])
  assert.equal(await evaluate(`${gitMark('deleted.txt')}.dataset.appIcon`), 'FileX')
  assert.match(await evaluate(`${treeRow('src/App.tsx')}.getAttribute('aria-description')`), /Modified · 4 added lines, 2 deleted lines/)
  const readCount = (await evaluate('window.pi.appInfo()')).fileIo.gitTrees.length
  const treeWidth = await evaluate(`shown('[data-file-tree-column]').style.getPropertyValue('--file-tree-width')`)
  await evaluate(`shown('[data-file-tree-column]').style.setProperty('--file-tree-width','280px')`)
  await waitFor(`${treeRow('src/App.tsx')}.querySelector('[data-git-file-stats]').getBoundingClientRect().width > 0`, 'wide tree displays line counts')
  assert.ok(await evaluate(`(() => {
    const stats=${treeRow('long-diff.ts')}.querySelector('[data-git-file-stats]'), mark=${gitMark('long-diff.ts')}
    return stats.getBoundingClientRect().width>0 && stats.getBoundingClientRect().right<mark.getBoundingClientRect().left
  })()`), 'large counts fit before the icon at a wide tree size')
  const markColors = []
  for (const theme of ['light','dark']) {
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'})`)
    for (const [style, family] of [['square','remix'],['rounded','hugeicons'],['squircle','hugeicons']]) {
      await evaluate(`setFixtureUiStyle(${JSON.stringify(style)})`)
      await waitFor(`${gitMark('src/App.tsx')}?.dataset.iconFamily === ${JSON.stringify(family)}`, `${style} Git glyph family`)
      assert.deepEqual(await evaluate(`[${gitMark('src/App.tsx')},${gitMark('untracked.py')},${gitMark('deleted.txt')}].map(mark=>mark.dataset.iconFamily)`), [family,family,family])
      assert.equal(await evaluate(`parseFloat(getComputedStyle(shown(${JSON.stringify(gitToggle)})).borderTopLeftRadius)===0`), style === 'square')
      if (process.env.PI_FILES_SCREENSHOT_DIR && style !== 'squircle') {
        const clip = await evaluate(`(() => {
          const tree = shown('[data-file-tree-column]').getBoundingClientRect()
          const top = Math.max(tree.top, ${treeRow('src')}.getBoundingClientRect().top - 4)
          const bottom = Math.min(tree.bottom, ${treeRow('deleted.txt')}.getBoundingClientRect().bottom + 4)
          return {x:tree.x,y:top,width:tree.width,height:bottom-top,scale:1}
        })()`)
        const { data } = await send('Page.captureScreenshot', { format: 'png', clip })
        await writeFile(join(process.env.PI_FILES_SCREENSHOT_DIR,`git-tree-${style}-${theme}.png`), Buffer.from(data,'base64'))
      }
    }
    const palette = await evaluate(`(() => {
      const modifiedRow = ${treeRow('src/App.tsx')}
      const [addedLines, removedLines] = modifiedRow.querySelector('[data-git-file-stats]').children
      const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      const color = element => {
        canvas.fillStyle = getComputedStyle(element).color
        canvas.fillRect(0,0,1,1)
        return Array.from(canvas.getImageData(0,0,1,1).data).slice(0,3)
      }
      return {
        modified: color(${gitMark('src/App.tsx')}), modifiedName: color(modifiedRow.querySelector('[data-middle-ellipsis]')),
        added: color(${gitMark('untracked.py')}), removed: color(${gitMark('deleted.txt')}), folder: color(${gitMark('vanished')}),
        addedLines: color(addedLines), removedLines: color(removedLines)
      }
    })()`)
    assert.ok(palette.modified[2] > palette.modified[1] && palette.modified[1] > palette.modified[0], `${theme} modified files are blue`)
    assert.ok(palette.folder[2] > palette.folder[1] && palette.folder[1] > palette.folder[0], `${theme} changed folders have blue dots`)
    assert.notDeepEqual(palette.folder, palette.modified, 'folder dots have their own tone')
    assert.ok(palette.added[1] > Math.max(palette.added[0], palette.added[2]), `${theme} additions are green`)
    assert.ok(palette.removed[0] > Math.max(palette.removed[1], palette.removed[2]), `${theme} deletions are red`)
    assert.deepEqual(palette.modifiedName, palette.modified)
    assert.deepEqual(palette.addedLines, palette.added)
    assert.deepEqual(palette.removedLines, palette.removed)
    markColors.push(palette.modified)
  }
  assert.notDeepEqual(...markColors, 'Git colors adapt to light and dark themes')
  await evaluate(`setFixtureUiStyle('square'); document.documentElement.classList.remove('dark'); shown('[data-file-tree-column]').style.setProperty('--file-tree-width','112px')`)
  assert.ok(await evaluate(`(() => {
    const row=${treeRow('src/App.tsx')}, mark=${gitMark('src/App.tsx')}
    return row.querySelector('[data-git-file-stats]').getBoundingClientRect().width===0 && mark.getBoundingClientRect().right<=row.getBoundingClientRect().right
  })()`), 'a narrow branch retains its icon and gives the filename the space from the counts')
  await evaluate(`shown('[data-file-tree-column]').style.setProperty('--file-tree-width',${JSON.stringify(treeWidth)})`)
  assert.equal((await evaluate('window.pi.appInfo()')).fileIo.gitTrees.length, readCount, 'theme and width changes do not request Git')
  await click(gitToggle)
  await waitFor('!shown("[data-file-tree-git]")', 'hide Git changes')
  assert.equal(await evaluate(`!!${treeRow('deleted.txt')}`), false, 'hidden indicators also remove the Git-only rows')
  await click(gitToggle)
  await waitFor(`${gitMark('vanished')}`, 'restore Git changes and missing folder')
  await evaluate(`${treeRow('vanished')}.click()`)
  await waitFor(`${gitMark('vanished/old.md')}`, 'deleted file appears beneath its missing directory')
  await evaluate(`${treeRow('vanished/old.md')}.click()`)
  await waitFor('shown("[data-file-diff]")?.textContent.includes("removed with its folder")','deleted tree file opens its diff')
  await click('[aria-label="Close old.md"]')
  await selectTab('App.tsx')
  await waitFor('shown("[data-file-source]")','return to the open source')
  console.log('PASS: Git tree statuses, accessible counts, deleted branches and diffs, Git-only toggle, theme families and narrow layouts')
  // A cached body remains visible during refresh, but must not hide real edits.
  await writeFile(join(project,'src/App.tsx'),'export const secondLine = "updated on disk";\nexport const freshFromDisk = true;\n')
  await writeFile(join(project,'src/added.ts'),'export const added = true;\n')
  await evaluate(`shown('[aria-label="Refresh files"]').click()`)
  assert.ok(await evaluate(`!!shown('[data-file-source]')`),'refresh retains the current source frame')
  await waitFor('shown("[data-file-source]")?.textContent.includes("freshFromDisk")','refresh validates cached source')
  await waitFor('shown("[data-file-tree] [data-file-icon$=\\"/added.ts\\"]")','refresh discovers new directory entries')
  await waitFor(`${gitMark('src/added.ts')}?.dataset.fileTreeGit === 'untracked'`, 'refresh also updates Git decorations')
  await selectTab('guide.md')
  await writeFile(join(project,'src/App.tsx'),'export const secondLine = "validated on revisit";\n')
  await selectTab('App.tsx')
  await waitFor('shown("[data-file-source]")?.textContent.includes("validated on revisit")','cached source revalidated on tab revisit')
  await rm(join(project,'src/added.ts'))
  await click('[aria-label="Refresh files"]')
  await waitFor('!shown("[data-file-tree] [data-file-icon$=\\"/added.ts\\"]")','refresh removes deleted directory entries')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'README.md'))}});setTimeout(()=>files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'src/App.tsx'))}}),0)`)
  await waitFor('shown("[data-sidebar-tabs] [aria-selected=true]").textContent==="App.tsx" && shown("[data-file-source]")?.textContent.includes("validated on revisit")','rapid navigation keeps final file and ignores older reads')
  const screenshotDir=process.env.PI_FILES_SCREENSHOT_DIR
  if(screenshotDir)await mkdir(screenshotDir,{recursive:true})
  for(const theme of ['light','dark']) {
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'})`);await pause(250)
    const geometry=await evaluate(`(()=>{const pane=shown('[data-files-pane]'),tree=shown('[data-file-tree-column]'),preview=shown('[data-file-preview]');return {background:getComputedStyle(pane).backgroundColor,tree:getComputedStyle(tree).backgroundColor,preview:getComputedStyle(preview).backgroundColor,border:getComputedStyle(tree).borderRightColor,overflow:pane.scrollWidth>pane.clientWidth,bar:getComputedStyle(shown('[data-file-source]')).scrollbarWidth}})()`)
    assert.equal(geometry.tree,'rgba(0, 0, 0, 0)');assert.equal(geometry.preview,'rgba(0, 0, 0, 0)');assert.equal(geometry.overflow,false);assert.equal(geometry.bar,'none')
    if(screenshotDir){const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(screenshotDir,`files-${theme}.png`),Buffer.from(shot.data,'base64'))}
  }
  await evaluate(`shown('[data-panel=right]').style.width='260px';shown('[data-panel=right]').firstElementChild.style.width='260px'`)
  await pause(100)
  assert.ok(await evaluate('shown("[data-files-pane]").scrollWidth<=262'))
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'binary.dat'))}})`)
  await waitFor('shown("[data-file-preview]").textContent.includes("Only text files")','binary notice')
  await evaluate("setLocale('zh-CN')")
  await waitFor('shown("[data-file-preview]").textContent.includes("当前阶段仅支持预览文本文件")','live Chinese locale')
  assert.ok(await evaluate(`!!shown('[aria-label="收起文件树"]')`))
  assert.ok(await evaluate(`!!shown('[aria-label="自动换行"]')`),'wrap label localized')
  await evaluate("setLocale('en')")
  await waitFor('shown("[aria-label=\\"Hide file tree\\"]")','restore locale')
  // AnimatePresence retains the final tab during rail exit; never click that
  // stale close button repeatedly and keep restarting its exit transition.
  const openTabCount=await evaluate('shownAll("[data-sidebar-tabs] [role=tab]").length')
  for(let index=0;index<openTabCount;index++) {
    await click('[data-sidebar-tabs] button[aria-label^="Close "]')
    if(index<openTabCount-1)await waitFor(`shownAll('[data-sidebar-tabs] [role=tab]').length===${openTabCount-index-1}`,'closed top-level tab removed')
  }
  await waitFor('!shown("[data-panel=right]")','closing last top-level tab folds rail')
  assert.equal(await evaluate('files.getSnapshot().tabs.length'),0,'closing all top-level files releases their metadata')
  await evaluate(`setSession(${JSON.stringify(project)})`)
  await click('[aria-label="Toggle sidebar"][aria-pressed]')
  await waitFor('Array.from(shownAll("[data-panel=right] button")).some(button=>button.textContent.startsWith("Files"))','empty rail picker')
  await evaluate(`Array.from(shownAll('[data-panel=right] button')).find(button=>button.textContent.startsWith('Files')).click()`)
  await waitFor('shown("[data-file-tree] [data-file-icon$=\\"/README.md\\"]")','native file chooser')
  assert.ok(await evaluate(`!!shown('[aria-label="Hide file tree"]')`),'the Files tab is born with its tree expanded')
  await evaluate(`shown('[data-file-tree] [data-file-icon$="/README.md"]').closest('[role=treeitem]').click()`)
  await waitFor('shown("[data-file-markdown]")','first chooser file opens preview')
  assert.deepEqual(await evaluate('Array.from(shownAll("[data-sidebar-tabs] [role=tab]")).map(tab=>tab.textContent)'),['README.md'],'chosen file replaces Files chooser without nesting')
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'SKILL.md'))}})`)
  await waitFor('shown("[data-file-frontmatter]") && shown("[data-file-tag-block]")','SKILL.md preview formatting')
  assert.equal(await evaluate('shown("[data-file-frontmatter]").textContent'),skillFrontmatter,'frontmatter is a literal metadata block without delimiters')
  assert.ok(await evaluate('(()=>{const block=shown("[data-file-frontmatter]");return block.scrollWidth<=block.clientWidth})()'),'frontmatter wraps within the narrow file preview')
  assert.equal(await evaluate('shown("[data-file-markdown] h1")?.textContent'),'Preview example','frontmatter does not become a heading')
  assert.equal(await evaluate('shown("[data-file-tag-block]").textContent'),'<outer>\n  <inner>\n    Keep the original indentation.\n  </inner>\n</outer>','nested tags keep their source indentation')
  assert.equal(await evaluate('getComputedStyle(shown("[data-file-tag-block]")).whiteSpace'),'pre-wrap','tag indentation is visible')
  assert.equal(await evaluate('shown("[data-file-markdown] strong")?.textContent'),'Rendered Markdown','ordinary Markdown still renders')
  assert.ok(await evaluate('shown("[data-code-block-pre]")?.textContent.includes("<code-tag>")'),'fenced tags stay in beUI CodeBlock')
  if (process.env.PI_FILE_MARKDOWN_SCREENSHOT_PATH) {
    const wasDark = await evaluate('document.documentElement.classList.contains("dark")')
    await evaluate('document.documentElement.classList.remove("dark")')
    await pause(80)
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.PI_FILE_MARKDOWN_SCREENSHOT_PATH, Buffer.from(data, 'base64'))
    if (wasDark) await evaluate('document.documentElement.classList.add("dark")')
  }
  await view('Source')
  await waitFor('shown("[data-file-source]")?.textContent.includes("name: preview-example")','SKILL.md source view')
  assert.ok(await evaluate('shown("[data-file-source]").textContent.includes("---")'),'source keeps frontmatter delimiters')
  console.log('PASS: SKILL.md frontmatter and nested tags display with literal indentation; source remains intact')
  assert.equal(exceptions.length,0,JSON.stringify(exceptions))

  // Right-rail tab menu: one menu for the strip, resolved from the tab under the
  // pointer. "Close other tabs" is the action the strip never had, so that is
  // what this pins — each tab keeps its own teardown (a side chat destroyed, a
  // terminal disposed, a file closed), which a list replacement would skip.
  // Kept at the end of the Workspace section: closing other tabs destroys rail
  // state, and the packaged-worker section below navigates the page away.
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'src/App.tsx'))}})`)
  await evaluate(`files.open(${JSON.stringify(project)},{path:${JSON.stringify(join(project,'package.json'))}})`)
  await pause(150)
  const railTabCount = () => evaluate(`shownAll('[data-sidebar-tabs] [role=tab]').length`)
  assert.ok((await railTabCount()) >= 2, `the rail has several tabs to work with: ${await railTabCount()}`)
  await evaluate(`(()=>{const tab=shown('[data-sidebar-tabs] [role=tab]');const box=tab.getBoundingClientRect();tab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.x+8,clientY:box.y+6}))})()`)
  await settleMenu(true, 'the rail tab context menu')
  const railTabMenu = (await menuState()).items
  for (const label of ['Close tab', 'Close other tabs', 'Close all tabs']) {
    assert.ok(railTabMenu.includes(label), `the tab menu offers "${label}": ${JSON.stringify(railTabMenu)}`)
  }
  await clickMenuItem('Close other tabs')
  await settleMenu(false, 'choosing a tab action')
  assert.equal(await railTabCount(), 1, 'close-others leaves exactly the tab that was right-clicked')
  console.log('PASS: rail tab context menu — resolved from the right-clicked tab, offers close/close-others/close-all, and close-others leaves one tab')
  const savedTab = await evaluate('shown("[data-sidebar-tabs] [role=tab][aria-selected=true]").textContent')
  await click('[data-titlebar-action="sidebar-fullscreen"]')
  await evaluate('window.beforePaneReload = true')
  await send('Page.reload')
  await waitFor(`!window.beforePaneReload && window.shown?.("[data-panel-fullscreen=true] [data-files-pane]") &&
    shown("[data-sidebar-tabs] [role=tab][aria-selected=true]")?.textContent === ${JSON.stringify(savedTab)}`,
  'the session restores its file, selection and fullscreen rail after reload')
  console.log('PASS: each workspace restores its own file tabs, active file and fullscreen state')
  // Validate Vite's emitted worker and grammar chunks from packaged file://,
  // since a dev-server-only worker check misses origin and output-format bugs.
  const workerAsset=(await readdir(join(repo,'out/renderer/assets'))).find(name=>/^file-highlight-worker-.*\.js$/.test(name))
  assert.ok(workerAsset,'built highlight worker')
  const workerHTML=join(temporary,'worker.html')
  await writeFile(workerHTML,`<script>window.workerResult=null;const worker=new Worker(${JSON.stringify(pathToFileURL(join(repo,'out/renderer/assets',workerAsset)).href)},{type:'module'});worker.onmessage=e=>{window.workerResult=e.data;worker.terminate()};worker.onerror=e=>window.workerError=e.message;worker.postMessage({code:'const builtWorker = true;',language:'typescript'});</script>`)
  await send('Page.navigate',{url:pathToFileURL(workerHTML).href})
  await waitFor('window.workerResult?.[0]?.some(token=>token.light)','packaged worker and grammar chunks')
  const searchAsset=(await readdir(join(repo,'out/renderer/assets'))).find(name=>/^file-search-worker-.*\.js$/.test(name))
  assert.ok(searchAsset,'built search worker')
  await evaluate(`new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(pathToFileURL(join(repo,'out/renderer/assets',searchAsset)).href)},{type:'module'});worker.onmessage=e=>{worker.terminate();window.packagedSearch=e.data;resolve(true)};worker.onerror=reject;worker.postMessage({text:'SDK SDK sdk',query:'SDK',options:{matchCase:false,wholeWord:true,regex:false}})})`)
  assert.equal(await evaluate('window.packagedSearch.matches.length'),3,'packaged file:// search worker')
  console.log('PASS: actual Workspace links, Markdown/source/diff, highlighting, relative links, top-level file tab/chooser lifecycle, native tree keyboard/selection/reveal, file-type icon sources and decoding, 14k-line virtualization, find/Escape, session/rail persistence, themes and narrow geometry')

  }
} finally {
  ws?.close();child?.kill('SIGKILL');await server?.close();await rm(temporary,{recursive:true,force:true})
}
