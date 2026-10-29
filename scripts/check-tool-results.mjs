/** Expanded file-tool behavior in real Chromium, without providers or sessions. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-tool-results-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixturePath = '/__tool_results_check.html'
// pi-fff's shipped formatGrepOutput: repo-relative file headings, optional
// Git/frecency annotations, indented match/context rows and blank separators.
const groupedGrepText = [
  'src/renderer/src/i18n/locales/zh-TW.ts  [untracked in git]',
  ' 532- // Copy in context',
  ' 533: "rewind.noMessageCheckpoint": "這條訊息沒有對應備份。",',
  " 824: 'workspace.sessionIdCopyFailed': '無法複製會話 ID。',",
  " 905: 'chat.messageCopy': '複製訊息',",
  " 1196: 'contextDetail.category.userText': '使用者文字',",
  '',
  'src/renderer/src/components/app/Toolbar.tsx  [modified in git]',
  ' 5: import { Wrap, Text, LoaderCircle, CircleCheck, Copy } from "@/lib/icons";',
  '',
  '[Continue with cursor="fff_c1"]'
].join('\n')
const groupedCssText = [
  'src/renderer/src/sidebar-pane-layout.css  [modified in git]',
  ' 12: .file-media-toolbar {',
  ' 18: .file-media-playback { grid-column: 1 / -1; grid-row: 1; }',
  ' 19: .file-media-volume { grid-column: 1 / -1; grid-row: 3; }',
  ' 20: .file-media-speed { grid-column: 1 / -1; grid-row: 2; }',
  ' 21: .file-media-fullscreen { grid-column: 3; grid-row: 2; }',
  '',
  'src/renderer/src/components/app/Media.tsx',
  ' 42: <div className="file-media-toolbar file-media-playback" />'
].join('\n')
const groupedPagingText = Array.from({ length: 3 }, (_, file) => [
  'src/group-' + file + '.ts  [modified in git]',
  ...Array.from({ length: file === 2 ? 90 : 80 }, (_, row) => ' ' + (row + 1) + ': const VALUE = ' + row + ';')
].join('\n')).join('\n\n') + '\n\n[Continue with cursor="fff_c2"]'
let server, child, ws

try {
  // Exercise the production result hook against real filesystem roots. It
  // must preserve the result envelope and leave overridden/failed tools alone.
  const bundle = join(temporary, 'search-results.mjs')
  await build({ entryPoints: [join(repo, 'src/main/pi/search-results.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const { createSearchResultExtension } = await import(pathToFileURL(bundle).href)
  const project = join(temporary, 'project with spaces')
  await mkdir(project)
  const file = join(project, 'source#?.ts')
  await writeFile(file, 'const value = 1;')
  let hook, source = 'builtin:grep'
  createSearchResultExtension().factory({
    on: (name, handler) => { assert.equal(name, 'tool_result'); hook = handler },
    getAllTools: () => ['grep', 'find', 'ls'].map(name => ({ name, sourceInfo: { path: name === 'grep' ? source : `builtin:${name}` } }))
  })
  const content = [{ type: 'text', text: 'source#?.ts:1: const value = 1;' }]
  const event = Object.freeze({ toolName: 'grep', input: { path: 'source#?.ts' }, content,
    structuredContent: { matches: 1 }, details: { matchLimitReached: 1 }, isError: false })
  assert.deepEqual(await hook(event, { cwd: project }), { details: { matchLimitReached: 1, piAppSearchRoot: { path: file, kind: 'file' } } })
  assert.deepEqual(event.structuredContent, { matches: 1 }, 'root metadata never replaces structured output')
  assert.equal(event.content, content, 'root metadata never replaces tool text')
  assert.equal(await hook({ ...event, isError: true }, { cwd: project }), undefined)
  assert.equal(await hook({ ...event, input: { path: 'missing' } }, { cwd: project }), undefined)
  source = '/extension/custom-grep.ts'
  assert.equal(await hook(event, { cwd: project }), undefined, 'extension overrides never acquire speculative local roots')
  source = 'builtin:grep'
  for (const toolName of ['grep', 'find', 'ls']) {
    const stamped = await hook({ ...event, toolName, input: {} }, { cwd: project })
    assert.deepEqual(stamped.details.piAppSearchRoot, { path: project, kind: 'directory' })
  }
  console.log('PASS: built-in root stamps preserve results and distinguish files, directories, overrides and failures')

  const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {initReduceMotion} from '/src/lib/reduce-motion.ts';
import {setUiStyle} from '/src/lib/ui-style.ts';import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');localStorage.setItem('pi-app:reduce-motion','on');initReduceMotion();
window.__errors=[];window.__opened=[];
window.addEventListener('error',event=>window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection',event=>window.__errors.push(String(event.reason)));
window.pi={openPath:async()=>{},openExternal:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[]};
const root=createRoot(document.getElementById('root'));
const make=(id,name,args,text,details={},isError=false)=>({id,call:{type:'toolCall',id,name,arguments:args},
  result:{role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text}],details,isError,timestamp:1}});
const searchRoot={piAppSearchRoot:{path:'/fixture/src',kind:'directory'}};
const cases={
 grep:make('grep','grep',{path:'src',pattern:'value',literal:true,ignoreCase:true},
  'value.ts-9- // value in context\\nvalue.ts:10: const VALUE = "value";\\nnested/foo.py:4: value = "value"\\n\\n[2 matches limit reached]',searchRoot),
 find:make('find','find',{path:'src',pattern:'*'},'path with spaces#?.ts\\nconfig.json\\nassets/image.png\\nDocs/\\n\\n[4 results limit reached]',searchRoot),
 ls:make('ls','ls',{path:'/fixture/data'},'.env\\nnotes.md\\nscripts/',{piAppSearchRoot:{path:'/fixture/data',kind:'directory'}}),
 read:make('read','read',{path:'src/value.ts',offset:41,limit:2},'const value = 1;\\n// value\\n\\n[Showing lines 41-42 of 200. Use offset=43 to continue.]',
  {piAppRead:{offset:41,endLine:42,totalLines:200}}),
 failed:make('failed','grep',{pattern:'value'},'value.ts:10: upstream error\\npermission denied',{},true),
 generic:make('generic','extension_tool',{pattern:'value'},'value.ts:10: const value = 1;'),
 single:make('single','grep',{path:'src/value.ts',pattern:'value',literal:true},'value.ts:10: const value = 1;',
  {piAppSearchRoot:{path:'/fixture/src/value.ts',kind:'file'}}),
 literal:make('literal','grep',{pattern:'a+b[0]',literal:true},'a.ts:2: a+b[0] a+b[0]'),
 regex:make('regex','grep',{pattern:'^const (value|other)',ignoreCase:true},'a.ts:2: CONST VALUE = 1;\\na.ts-3- const other = 3;\\na.ts:4: const other = 2;'),
 fff:make('fff','grep',{path:'src/renderer/src',pattern:'Wrap|Text|LoaderCircle|Check|Copy'},${JSON.stringify(groupedGrepText)}),
 fffCss:make('fffCss','grep',{path:'src/renderer/src/sidebar-pane-layout.css',pattern:'file-media-toolbar|file-media-playback|file-media-volume|file-media-speed|file-media-fullscreen'},${JSON.stringify(groupedCssText)}),
 fffSmart:make('fffSmart','grep',{path:'*.ts',pattern:'value'},'src/[value].ts  [often touched file]\\n 2: const VALUE = "value";'),
 fffCase:make('fffCase','grep',{path:'/fixture/src',pattern:'value',caseSensitive:true},'src/value.ts  [VERY often touched file]\\n 2: const VALUE = "value";'),
 fffUpper:make('fffUpper','grep',{pattern:'Value'},'src/value.ts\\n 2: Value value VALUE'),
 fffLiteral:make('fffLiteral','grep',{pattern:'[value'},'src/value.ts\\n 2: [value [value'),
 fffExternal:make('fffExternal','grep',{path:'../outside',pattern:'value'},'nested/value.ts\\n 2: const VALUE = 1;'),
 fffPaging:make('fffPaging','grep',{path:'src/',pattern:'value'},${JSON.stringify(groupedPagingText)}),
 flatSeparated:make('flatSeparated','grep',{path:'src',pattern:'value'},'a.ts:2: const value = 1;\\n\\nb.ts:4: const value = 2;\\n\\n[2 matches limit reached]',searchRoot),
 malformed:make('malformed','grep',{pattern:'value'},'not a path\\n 9007199254740992: value\\na.ts:0: value\\n\\n[unrecognized output]'),
 unsupported:make('unsupported','grep',{pattern:'(?i)value'},'a.ts:2: VALUE = 1;'),
 zero:make('zero','grep',{pattern:'^|$'},'a.ts:2: const value = 1;'),
 pathological:make('pathological','grep',{pattern:'(a+)+$'},'a.ts:2: '+'a'.repeat(40)+'!'),
 legacy:make('legacy','grep',{path:'src/value.ts',pattern:'value'},'value.ts:10: const value = 1;'),
 byte:make('byte','read',{path:'data.json',byteOffset:50},'{"name":"value"}'),
 readFailed:make('readFailed','read',{path:'data.json'},'Cannot read file',{},true),
 html:make('html','read',{path:'page.html'},'<img src=x onerror="window.__unsafe=true">', {piAppRead:{offset:1,endLine:1,totalLines:1}}),
 paging:make('paging','find',{path:'src',pattern:'*'},Array.from({length:250},(_,index)=>'nested/long-directory-name/file-'+index+'.ts').join('\\n')+'\\n\\n[250 results limit reached]',searchRoot),
 noMatch:make('noMatch','grep',{pattern:'x'},'No matches found'),
 noFiles:make('noFiles','find',{pattern:'x'},'No files found matching pattern'),
 empty:make('empty','ls',{},'(empty directory)')
};
function Fixture({names}){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement(FileNavigationProvider,
 {cwd:'/fixture',openFile:target=>window.__opened.push(target)},React.createElement('div',{id:'fixture',style:{width:660,maxWidth:'100%',margin:'24px auto'}},
 names.map(name=>React.createElement('div',{key:name,'data-case':name},React.createElement(ToolCallView,{...cases[name],cwd:'/fixture'})))));}
window.show=names=>{
 const view=React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(Fixture,{names})));
 flushSync(()=>root.render(view));
};
window.setStyle=setUiStyle;
window.show(['grep','find','ls','read','failed','generic','single']);window.fixtureReady=true;
</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'tool-results-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (req.url !== fixturePath) return next()
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      }) }
    }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:1000,webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:${server.httpServer.address().port}${fixturePath}')});app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code + stderr)) })
    child.stderr.on('data', chunk => { stderr += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let attempt = 0; attempt < 100 && !page; attempt++) { page = (await (await fetch(endpoint + '/json/list')).json()).find(page => page.type === 'page'); if (!page) await pause(50) }
  assert.ok(page, 'Electron renderer created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  const pending = new Map()
  let sequence = 0
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, message => message.error ? reject(message.error) : resolve(message.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value }
  const waitFor = async (expression, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(50) } throw new Error('Timeout: ' + label + ': ' + JSON.stringify(await evaluate('window.__errors'))) }
  const caseSelector = name => `[data-case="${name}"]`
  const expand = async name => { await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(caseSelector(name) + ' button[aria-expanded]')});if(button.getAttribute('aria-expanded')==='false')button.click()})()`); await waitFor(`!!document.querySelector(${JSON.stringify(caseSelector(name) + ' [data-tool-body]')})`, name + ' expanded') }
  const show = async names => { await evaluate(`window.show(${JSON.stringify(names)})`); for (const name of names) await expand(name) }
  const marks = name => evaluate(`[...document.querySelectorAll(${JSON.stringify(caseSelector(name) + ' mark')})].map(mark=>mark.textContent)`)
  const lastOpened = () => evaluate('window.__opened.at(-1)')
  const fileClick = (name, displayPath) => evaluate(`[...document.querySelectorAll(${JSON.stringify(caseSelector(name) + ' [data-file-link]')})].find(button=>button.title===${JSON.stringify(displayPath)}).click()`)

  await waitFor('window.fixtureReady && document.querySelectorAll("[data-case]").length===7', 'fixture mount')
  assert.equal(await evaluate('document.querySelectorAll("[data-tool-output]").length'), 0, 'collapsed rows mount no parsers or workers')
  for (const name of ['grep','find','ls','read','failed','generic','single']) await expand(name)
  await waitFor('document.querySelectorAll("[data-case=grep] mark").length===4', 'real literal search worker')
  assert.deepEqual(await marks('grep'), ['VALUE','value','value','value'], 'literal ignoreCase highlights only source matches')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=grep] [data-tool-search-match=false] mark").length'), 0, 'context and filename matches never acquire marks')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=grep] [data-tool-search-file]").length'), 2, 'matches group by file')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-case=grep] [data-tool-search-line] code")].map(code=>code.textContent)'), ['// value in context','const VALUE = "value";','value = "value"'], 'parsed source preserves every returned character')
  await evaluate(`document.querySelector('[data-case=grep] [data-tool-search-line="10"] button').click()`)
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/value.ts', line: 10 })
  await evaluate(`document.querySelector('[data-case=single] [data-tool-search-line="10"] button').click()`)
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/value.ts', line: 10 }, 'single-file grep does not append its basename twice')
  await fileClick('find', 'path with spaces#?.ts')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/path with spaces#?.ts' }, 'special filename characters stay literal')
  await fileClick('ls', '.env')
  assert.deepEqual(await lastOpened(), { path: '/fixture/data/.env' })
  assert.equal(await evaluate('document.querySelectorAll("[data-case=find] [data-file-icon]").length'), 3, 'directories use folder glyphs, files retain their own artwork')
  await waitFor('[...document.querySelectorAll("[data-file-icon]")].every(image=>image.complete && image.naturalWidth>0)', 'decodable offline artwork')
  assert.equal(await evaluate('document.querySelector("[data-case=find]").textContent.includes("4 results limit reached")'), true, 'SDK list notices remain visible')
  await waitFor('!!document.querySelector("[data-case=read] [style*=agent-code-light]")', 'real source syntax worker')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-case=read] [data-tool-read-line] code")].map(code=>code.textContent)'), ['const value = 1;','// value'], 'read notes stay outside exact source lines')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-case=read] [data-tool-read-line]")].map(row=>Number(row.dataset.toolReadLine))'), [41,42])
  await evaluate(`document.querySelector('[data-case=read] [data-tool-read-line="42"] button').click()`)
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/value.ts', line: 42 })
  assert.equal(await evaluate('document.querySelector("[data-case=failed] [data-tool-output]")'), null, 'failed searches keep their error output')
  assert.ok(await evaluate('document.querySelector("[data-case=failed] .text-destructive").textContent.includes("permission denied")'))
  assert.equal(await evaluate('document.querySelector("[data-case=generic] [data-tool-output]")'), null, 'unknown tools retain plain text')
  console.log('PASS: grouped source matches, context, exact roots, file icons, source syntax and error fallbacks')

  await show(['literal','regex'])
  await waitFor('document.querySelectorAll("[data-case=literal] mark").length===2 && document.querySelectorAll("[data-case=regex] mark").length===2', 'literal and anchored regex')
  assert.deepEqual(await marks('literal'), ['a+b[0]','a+b[0]'])
  assert.deepEqual(await marks('regex'), ['CONST VALUE','const other'], 'anchors apply to source rather than path prefixes')
  await show(['fff','fffCss'])
  await waitFor('document.querySelectorAll("[data-case=fff] mark").length===9 && document.querySelectorAll("[data-case=fffCss] mark").length===7', 'screenshot-format grouped grep')
  assert.deepEqual(await marks('fff'), ['Check','Copy','Copy','Text','Wrap','Text','LoaderCircle','Check','Copy'])
  assert.deepEqual(await marks('fffCss'), ['file-media-toolbar','file-media-playback','file-media-volume','file-media-speed','file-media-fullscreen','file-media-toolbar','file-media-playback'])
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-case=fff] [data-tool-search-file]")].map(group=>group.dataset.toolSearchFile)'),
    ['src/renderer/src/i18n/locales/zh-TW.ts','src/renderer/src/components/app/Toolbar.tsx'], 'blank separators retain every grouped file')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-case=fff] [data-tool-search-annotation]")].map(tag=>tag.textContent.trim())'), ['[untracked in git]','[modified in git]'])
  assert.equal(await evaluate('document.querySelectorAll("[data-case=fff] [data-tool-search-match=false] mark").length'), 0)
  assert.ok(await evaluate('document.querySelector("[data-case=fff]").textContent.includes("Continue with cursor")'))
  await fileClick('fff', 'src/renderer/src/i18n/locales/zh-TW.ts')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/renderer/src/i18n/locales/zh-TW.ts' }, 'grouped paths use cwd rather than append the directory constraint twice')
  await evaluate('document.querySelector("[data-case=fff] [data-tool-search-line=\\"824\\"] button").click()')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/renderer/src/i18n/locales/zh-TW.ts', line: 824 })
  await fileClick('fffCss', 'src/renderer/src/sidebar-pane-layout.css')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/renderer/src/sidebar-pane-layout.css' }, 'grouped file constraints never become navigation roots')
  await show(['fffSmart','fffCase','fffUpper','fffLiteral','fffExternal','flatSeparated','malformed'])
  await waitFor('document.querySelectorAll("[data-case=fffSmart] mark").length===2 && document.querySelectorAll("[data-case=fffCase] mark").length===1 && document.querySelectorAll("[data-case=fffUpper] mark").length===1 && document.querySelectorAll("[data-case=fffLiteral] mark").length===2 && document.querySelectorAll("[data-case=fffExternal] mark").length===1 && document.querySelectorAll("[data-case=flatSeparated] mark").length===2', 'grouped search semantics')
  assert.deepEqual(await marks('fffSmart'), ['VALUE','value'], 'pi-fff lowercase queries use smart-case')
  assert.deepEqual(await marks('fffCase'), ['value'], 'pi-fff caseSensitive is respected')
  assert.deepEqual(await marks('fffUpper'), ['Value'], 'uppercase queries retain smart-case sensitivity')
  assert.deepEqual(await marks('fffLiteral'), ['[value','[value'], 'invalid auto-detected regex uses pi-fff literal fallback')
  await fileClick('fffSmart', 'src/[value].ts')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/[value].ts' }, 'glob constraints and bracketed filenames do not alter paths')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=fffExternal] [data-tool-output] button").length'), 0, 'unstamped auxiliary-index paths have no speculative navigation')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=malformed] [data-tool-search-line], [data-case=malformed] mark").length'), 0, 'invalid line numbers remain plain output')
  assert.ok(await evaluate('document.querySelector("[data-case=malformed]").textContent.includes("9007199254740992: value")'))
  console.log('PASS: real pi-fff grouped format, multiple files, Git annotations, contexts, smart-case, literal fallback and exact navigation')
  await show(['unsupported','zero','legacy','byte','readFailed','html'])
  await waitFor('!!document.querySelector("[data-case=html] [style*=agent-code-light]")', 'HTML syntax')
  await pause(250)
  assert.deepEqual(await marks('unsupported'), [], 'unsupported ripgrep regex remains readable without invented spans')
  assert.equal(await evaluate('document.querySelector("[data-case=unsupported] [data-tool-search-match=true] code").textContent'), 'VALUE = 1;')
  assert.deepEqual(await marks('zero'), [], 'zero-width matches do not consume source')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=legacy] [data-tool-output] button").length'), 0, 'ambiguous legacy roots have no speculative links')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=byte] [data-tool-read-line]").length'), 0, 'byte reads invent no line numbers')
  assert.equal(await evaluate('document.querySelector("[data-case=readFailed] [data-tool-output]")'), null)
  assert.equal(await evaluate('document.querySelector("[data-case=html] code").textContent'), '<img src=x onerror="window.__unsafe=true">')
  assert.equal(await evaluate('!!window.__unsafe || !!document.querySelector("[data-case=html] img")'), false, 'source HTML is escaped, never executed')
  await show(['pathological'])
  await fileClick('pathological', 'a.ts')
  assert.deepEqual(await lastOpened(), { path: '/fixture/a.ts' }, 'file navigation works while a pathological regex runs in its worker')
  await pause(1200)
  assert.equal(await evaluate('document.querySelector("[data-case=pathological] code").textContent.length'), 41, 'worker timeout leaves the entire source line readable')
  console.log('PASS: literal metacharacters, regex anchors, unsupported/zero-width/pathological regexes, legacy and byte reads, escaped HTML')

  await show(['paging'])
  const links = () => evaluate('document.querySelectorAll("[data-case=paging] [data-tool-output] [data-file-link]").length')
  assert.equal(await links(), 100, 'large results start with bounded DOM')
  assert.equal(await evaluate(`(()=>{const viewport=document.querySelector('[data-case=paging] [role=log]'),edge=viewport.getBoundingClientRect().bottom;
    return [...viewport.querySelectorAll('[data-file-link]')].filter(button=>{const box=button.getBoundingClientRect();return box.top<edge-.5&&box.bottom>edge+.5}).length})()`), 0,
    'the output cap never cuts a file row in half')
  assert.ok(await evaluate('document.querySelector("[data-case=paging]").textContent.includes("250 results limit reached")'), 'paging does not hide limit notices')
  for (const expected of [200,250]) {
    await evaluate('document.querySelector("[data-case=paging] [data-tool-output] button:not([data-file-link])").click()')
    await waitFor(`document.querySelectorAll("[data-case=paging] [data-tool-output] [data-file-link]").length===${expected}`, 'show more rows')
  }
  await fileClick('paging', 'nested/long-directory-name/file-249.ts')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/nested/long-directory-name/file-249.ts' }, 'paging exposes results past the former 4000-character cutoff')
  await show(['fffPaging'])
  const groupedRows = () => evaluate('document.querySelectorAll("[data-case=fffPaging] [data-tool-search-line]").length')
  await waitFor('document.querySelectorAll("[data-case=fffPaging] mark").length===100', 'initial grouped page highlights')
  assert.equal(await groupedRows(), 100, 'grep paging counts source rows rather than headers')
  assert.equal(await evaluate('document.querySelectorAll("[data-case=fffPaging] [data-tool-search-file]").length'), 2)
  assert.ok(await evaluate('document.querySelector("[data-case=fffPaging]").textContent.includes("Continue with cursor")'), 'grouped paging keeps cursor notices visible')
  for (const expected of [200,250]) {
    await evaluate('document.querySelector("[data-case=fffPaging] [data-tool-output] > button").click()')
    await waitFor(`document.querySelectorAll("[data-case=fffPaging] [data-tool-search-line]").length===${expected} && document.querySelectorAll("[data-case=fffPaging] mark").length===${expected}`, 'more grouped rows and highlights')
  }
  await evaluate('document.querySelector("[data-case=fffPaging] [data-tool-search-file=\\"src/group-2.ts\\"] [data-tool-search-line=\\"90\\"] button").click()')
  assert.deepEqual(await lastOpened(), { path: '/fixture/src/group-2.ts', line: 90 }, 'late grouped results retain exact line navigation')
  console.log('PASS: bounded initial rendering, whole-line paging, persistent notices and late-result navigation')

  for (const locale of ['en','zh-CN','zh-TW']) {
    await evaluate(`window.setLocale(${JSON.stringify(locale)})`)
    await show(['grep','find','ls','read','noMatch','noFiles','empty'])
    await waitFor('document.querySelectorAll("[data-case=grep] mark").length===4', 'localized worker output')
    const expected = { en: 'No matches found', 'zh-CN': '未找到匹配内容', 'zh-TW': '找不到符合的內容' }[locale]
    assert.ok(await evaluate(`document.querySelector('[data-case=noMatch]').textContent.includes(${JSON.stringify(expected)})`))
    for (const style of ['square','squircle']) {
      await evaluate(`window.setStyle(${JSON.stringify(style)})`)
      for (const dark of [false,true]) {
        await evaluate(`document.documentElement.classList.toggle('dark',${dark});document.getElementById('fixture').style.width='360px'`)
        await pause(100)
        assert.ok(await evaluate('document.getElementById("fixture").scrollWidth<=document.getElementById("fixture").clientWidth+1'), 'narrow output keeps reachable controls and wraps source')
        const family = style === 'square' ? 'pierre-square' : 'pierre'
        await waitFor(`[...document.querySelectorAll('[data-file-icon]')].every(image=>image.dataset.fileIconFamily==='${family}' && image.complete && image.naturalWidth>0)`, 'active artwork family')
        if (process.env.PI_TOOL_RESULTS_SCREENSHOT_DIR) {
          await mkdir(process.env.PI_TOOL_RESULTS_SCREENSHOT_DIR, { recursive: true })
          await evaluate('document.getElementById("fixture").style.width="660px";window.scrollTo(0,0)')
          const shot = await send('Page.captureScreenshot', { format: 'png' })
          await writeFile(join(process.env.PI_TOOL_RESULTS_SCREENSHOT_DIR, `${locale}-${style}-${dark?'dark':'light'}.png`), Buffer.from(shot.data, 'base64'))
          await show(['fff','fffCss'])
          await waitFor('document.querySelectorAll("[data-case=fff] mark").length===9 && document.querySelectorAll("[data-case=fffCss] mark").length===7', 'grouped screenshot marks')
          const groupedShot = await send('Page.captureScreenshot', { format: 'png' })
          await writeFile(join(process.env.PI_TOOL_RESULTS_SCREENSHOT_DIR, `${locale}-${style}-${dark?'dark':'light'}-grouped.png`), Buffer.from(groupedShot.data, 'base64'))
          await show(['grep','find','ls','read','noMatch','noFiles','empty'])
          await waitFor('document.querySelectorAll("[data-case=grep] mark").length===4', 'restore native screenshot cases')
        }
      }
    }
  }
  assert.deepEqual(await evaluate('window.__errors'), [], 'no renderer exceptions or unhandled worker errors')
  console.log('PASS: both themes, both icon families, three locales and narrow layouts')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
