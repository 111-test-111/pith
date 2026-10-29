/** Independent typography settings in real Chromium, including live virtual rows and emulators. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-font-sizes-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixturePath = '/__font-sizes.html'
const markdown = '# Heading 标题 `inline()`\n\nBody 中文 with `inline()` and $x^2$.\n\n'
  + [2,3,4,5,6].map(level => '#'.repeat(level)+' Heading 标题 `inline()`').join('\n\n')
  + '\n\n**Strong 中文 `inline()`**, *emphasis `inline()`*, [link `inline()`](https://example.test).'
  + '\n\nLong code `'+ 'long_token_中文_'.repeat(80) +'` tail.\n\n```js\nconst answer = 42;\n```'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {I18nProvider} from '/src/i18n/index.tsx';
import {FontSizesGroup} from '/src/components/app/settings/FontSizesGroup.tsx';
import {Button} from '/src/components/motion/button';
import {PromptInput} from '/src/components/agents/prompt-input';
import {FileSource} from '/src/components/app/FileSource';
import {FileTable} from '/src/components/app/FileTable';
import {FileDiff} from '/src/components/agents/file-diff';
import {ReviewDiffBody} from '/src/components/app/ReviewDiff';
import {Markdown} from '/src/lib/markdown';
import {FileBrowserStore} from '/src/state/file-browser-store';
import {TerminalRuntime} from '/src/lib/terminal-runtime';
import {initFonts} from '/src/lib/fonts';
import {initFontSizes,getFontSizes,setFontSizes} from '/src/lib/typography';
import '/src/styles.css';
window.pi={platform:'darwin',terminalResize:()=>{},terminalInput:()=>{},terminalAck:()=>{}};
initFonts();initFontSizes();window.bootSizes=getFontSizes();window.setSizes=setFontSizes;
const mirror=location.search.includes('mirror'),h=React.createElement,store=new FileBrowserStore();
const source=Array.from({length:2500},(_,i)=>'line '+(i+1)+' '+('source text 中文 '.repeat(5))).join('\\n');
const lines=Array.from({length:2500},(_,i)=>({id:String(i),newLine:i+1,content:'diff '+(i+1),type:'added'}));
const patch='@@ -0,0 +1,2500 @@\\n'+lines.map(line=>'+'+line.content).join('\\n');
const tableTab={cwd:'/fixture',path:'/fixture/data.csv',view:'preview',visit:0,treeOpen:false};
store.cache.setTable(${JSON.stringify('/fixture\0/fixture/data.csv\0' + '0')},{rows:[['name','value'],...Array.from({length:2500},(_,i)=>['row '+i,String(i)])],rowNumbers:null,columns:2,sheets:[],sheet:null,totalRows:2501,truncated:false,eof:true,offset:0,delimiter:',',size:0});
const reviewRef=React.createRef();
function Shell(){const [wrap,setWrap]=React.useState(false);window.wrapSource=setWrap;return h(I18nProvider,null,h('main',{style:{padding:16}},
 h('div',{id:'settings',style:{maxWidth:520}},h(FontSizesGroup)),
 mirror?null:h(React.Fragment,null,
 h('div',{id:'ui'},h(Button,null,'UI action'),h('span',{id:'caption',className:'text-caption leading-ui'},'Status'),h('span',{id:'path',className:'font-mono text-xs'},'/fixture/example.txt')),
 h('div',{id:'markdown'},h(Markdown,null,${JSON.stringify(markdown)})),
 h('div',{id:'composer',style:{width:500}},h(PromptInput,{defaultValue:'draft 中文',minRows:2,maxRows:8})),
 h('div',{id:'source-host',style:{width:500,height:200,display:'flex'}},h(FileSource,{text:source,tab:{cwd:'/fixture',path:'/fixture/example.txt',view:'source',visit:0,treeOpen:false},store,wrap})),
 h('div',{id:'diff'},h(FileDiff,{file:'example.txt',lines,status:'complete',open:true,headerless:true,virtualize:true,highlight:false,maxHeight:200})),
 h('div',{id:'review',ref:reviewRef,style:{height:200,overflow:'auto',overflowAnchor:'none'}},h(ReviewDiffBody,{patch,displayPath:'example.txt',scrollRootRef:reviewRef})),
 h('div',{id:'table',style:{height:220,width:500,display:'flex'}},h(FileTable,{tab:tableTab,format:'csv',store,generation:0})),
 h('div',{id:'terminal',style:{height:150,width:500}})
 )))}
flushSync(()=>createRoot(document.getElementById('root')).render(h(Shell)));
if(!mirror){window.runtime=new TerminalRuntime('fixture',()=>{});runtime.attach(document.getElementById('terminal'));runtime.write('typography scrollback\\r\\n');}
window.ready=true;
window.read=()=>{
 const font=selector=>{const el=document.querySelector(selector);return el?parseFloat(getComputedStyle(el).fontSize):null};
 const line=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).lineHeight);
 return {sizes:getFontSizes(),fields:Object.fromEntries([...document.querySelectorAll('[data-font-size-field]')].map(el=>[el.dataset.fontSizeField,el.value])),
 ui:font('#ui button'),caption:font('#caption'),path:font('#path'),content:font('#markdown p'),heading:font('#markdown h1'),inline:font('#markdown p code'),fenced:font('#markdown [data-code-block-pre]'),
 source:font('[data-file-source] pre'),sourceHeight:line('[data-file-source] pre'),diff:font('[data-slot="file-diff-viewport"] > div'),diffHeight:line('[data-slot="file-diff-viewport"] > div'),
 table:font('[data-file-table-viewport]'),editor:font('#composer [contenteditable]'),terminal:window.runtime?.terminal.options.fontSize,
 rem:parseFloat(getComputedStyle(document.documentElement).fontSize),stored:localStorage.getItem('pi-app:font-sizes')};
};
window.draft=(kind,value)=>{const el=document.querySelector('[data-font-size-field="'+kind+'"]');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
window.finish=(kind,key)=>{const el=document.querySelector('[data-font-size-field="'+kind+'"]');if(key)el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));else el.blur();};
window.scrollRows=()=>{for(const selector of ['[data-file-source]','[data-slot="file-diff-viewport"]','#review','[data-file-table-viewport]']){const el=document.querySelector(selector);el.scrollTop=4008;el.dispatchEvent(new Event('scroll'));}};
window.anchors=()=>{const source=document.querySelector('[data-file-source]'),diff=document.querySelector('[data-slot="file-diff-viewport"]'),review=document.getElementById('review'),body=review.querySelector('[data-review-diff]'),table=document.querySelector('[data-file-table-viewport]');return {source:(source.scrollTop-8)/window.read().sourceHeight,diff:diff.scrollTop/window.read().diffHeight,review:(review.getBoundingClientRect().top-body.getBoundingClientRect().top)/window.read().diffHeight,table:table.scrollTop/table.querySelector('[data-table-row]').getBoundingClientRect().height,sourceCount:source.querySelectorAll('[data-source-line]').length,diffCount:diff.querySelectorAll('[class*=grid-cols]').length};};
// Native inline baseline markers plus actual glyph metrics: unlike line-box
// centres, these reveal a monospace run sitting below the surrounding type.
window.inlineAlignment=()=>{
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 const marker=()=>{const el=document.createElement('span');el.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';return el};
 return [...document.querySelectorAll('#markdown code')].filter(code=>code.textContent==='inline()').map(code=>{
  const prose=code.parentElement,proseMarker=marker(),codeMarker=marker();prose.insertBefore(proseMarker,code);code.append(codeMarker);
  const centre=(el,baseline)=>{const style=getComputedStyle(el);ctx.font=[style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(' ');const ink=ctx.measureText('H');return baseline+(ink.actualBoundingBoxDescent-ink.actualBoundingBoxAscent)/2};
  const sizes=[prose,code].map(el=>parseFloat(getComputedStyle(el).fontSize));
  const offset=centre(code,codeMarker.getBoundingClientRect().top)-centre(prose,proseMarker.getBoundingClientRect().top);
  proseMarker.remove();codeMarker.remove();return {tag:prose.tagName,sizes,offset};
 });
};
</script></body></html>`

let child, server
const sockets = []
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'typography-fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => { try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) } })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{for(const url of ${JSON.stringify([url,url+'?mirror'])}){const w=new BrowserWindow({show:false,width:1100,height:1100,webPreferences:{backgroundThrottling:false}});w.loadURL(url)}});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited '+code+stderr)) })
    child.stderr.on('data', chunk => { stderr += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]) } })
  })
  const connect = async mirror => {
    let page
    for(let i=0;i<200&&!page;i++){page=(await(await fetch(endpoint+'/json/list')).json()).find(p=>p.type==='page'&&p.url===url+(mirror?'?mirror':''));if(!page)await pause(50)}
    assert(page,'both isolated windows load');const ws=new WebSocket(page.webSocketDebuggerUrl);sockets.push(ws);
    await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));let sequence=0;const pending=new Map(),exceptions=[];
    ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails)});
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,m=>m.error?reject(new Error(method+' '+String(params.expression??'').slice(0,180)+' '+JSON.stringify(m.error))):resolve(m.result));ws.send(JSON.stringify({id,method,params}))});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value};
    const waitFor=async expression=>{
      for(let i=0;i<300;i++){
        try { if(await evaluate('Boolean('+expression+')'))return }
        catch(error){if(!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(error.message))throw error}
        await pause(50)
      }
      throw Error('Timeout: '+expression+' '+JSON.stringify(exceptions))
    };
    await send('Runtime.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});await send('Page.enable');await waitFor('window.ready===true');return {send,evaluate,waitFor,exceptions};
  }
  const primary=await connect(false),mirror=await connect(true)
  const {evaluate,waitFor,send}=primary
  await waitFor(`document.querySelector('[data-table-row]') && document.querySelector('#markdown [data-code-block-pre]')`)
  await pause(250)
  const initial=await evaluate('read()')
  assert.deepEqual(initial.sizes,{ui:14,content:14,code:12})
  for(const key of ['ui','content','editor','terminal'])assert.equal(initial[key],14,key+' preserves default density')
  for(const key of ['inline','fenced','source','diff','table','path'])assert.equal(initial[key],12,key+' preserves default density')
  assert.equal(initial.rem,16,'rem geometry stays fixed')
  assert.equal(initial.caption,11)
  assert.equal(initial.sourceHeight,20)
  assert.equal(initial.diffHeight,20)

  if(process.env.PI_FONT_SIZES_SCREENSHOT_DIR){
    await mkdir(process.env.PI_FONT_SIZES_SCREENSHOT_DIR,{recursive:true})
    const clip=await evaluate(`(()=>{const r=document.getElementById('settings').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`)
    const shot=await send('Page.captureScreenshot',{format:'png',clip})
    await writeFile(join(process.env.PI_FONT_SIZES_SCREENSHOT_DIR,'font-fields-default.png'),Buffer.from(shot.data,'base64'))
  }

  const assertInlineAlignment=async label=>{
    const samples=await evaluate('inlineAlignment()')
    assert.equal(samples.length,10,label+': body, all six headings and nested emphasis/link code render')
    const {content,code}=await evaluate('read().sizes')
    for(const sample of samples){
      const [proseSize,codeSize]=sample.sizes
      assert.ok(Math.abs(codeSize-proseSize*code/content)<0.01,label+': inline code scales with '+sample.tag+' '+JSON.stringify(sample))
      assert.ok(Math.abs(sample.offset)<0.4,label+': inline code shares the prose type centre '+JSON.stringify(sample))
    }
    const wrapping=await evaluate(`(()=>{const code=[...document.querySelectorAll('#markdown code')].find(el=>el.textContent.startsWith('long_token_'));return {fragments:code.getClientRects().length,scroll:code.parentElement.scrollWidth,width:code.parentElement.clientWidth}})()`)
    assert.ok(wrapping.fragments>1&&wrapping.scroll<=wrapping.width+1,label+': long inline code retains native wrapping '+JSON.stringify(wrapping))
  }
  await assertInlineAlignment('default sizes')

  const edit=async(kind,value,key)=>{await evaluate(`draft(${JSON.stringify(kind)},${JSON.stringify(value)})`);await pause(20);await evaluate(`finish(${JSON.stringify(kind)},${JSON.stringify(key)})`);await pause(80)}
  await evaluate(`draft('ui','18')`);await pause(30)
  assert.equal((await evaluate('read()')).ui,14,'uncommitted draft does not change typography')
  await evaluate(`finish('ui','Enter')`);await waitFor(`read().ui===18`)
  let state=await evaluate('read()')
  assert.equal(state.content,14);assert.equal(state.source,12);assert.equal(state.terminal,14);assert.equal(state.path,15);assert.equal(state.caption,14);assert.equal(state.rem,16)
  await mirror.waitFor(`document.querySelector('[data-font-size-field="ui"]').value==='18'`)
  assert.deepEqual(await mirror.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--app-text-ui-sm").trim()'),'18px','other window receives storage event')

  await evaluate(`window.editor=document.querySelector('#composer [contenteditable]');editor.focus();const range=document.createRange();range.setStart(editor.firstChild,2);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.savedSelection=selection.anchorOffset;setSizes({content:20})`)
  await waitFor(`read().content===20 && read().table===17`)
  state=await evaluate('read()');assert.equal(state.heading,23);assert.equal(state.ui,18);assert.equal(state.source,12);assert.equal(state.inline,12);assert.equal(state.editor,20)
  assert.ok(await evaluate(`editor===document.querySelector('#composer [contenteditable]') && editor.textContent==='draft 中文' && getSelection().anchorOffset===savedSelection`),'content update preserves native editor and selection')
  await assertInlineAlignment('larger content')

  await evaluate('scrollRows()');await pause(120)
  const before=await evaluate('anchors()');assert.ok(await evaluate(`document.querySelector('#review [data-slot="file-diff-viewport"]').textContent.includes('diff 201')`),'page-scrolled review mounts the reading window')
  await edit('code','24','Enter');await waitFor(`read().source===24 && read().terminal===26`);await pause(180)
  const after=await evaluate('anchors()');state=await evaluate('read()')
  for(const key of ['source','diff','review'])assert.ok(Math.abs(before[key]-after[key])<0.1,key+' preserves reading line: '+JSON.stringify({before,after}))
  assert.equal(state.inline,24);assert.equal(state.fenced,24);assert.equal(state.content,20);assert.equal(state.path,15);assert.equal(state.sourceHeight,40);assert.equal(state.diffHeight,40)
  await assertInlineAlignment('larger code')
  assert.ok(after.sourceCount<100&&after.diffCount<100,'large files remain windowed')
  await evaluate(`(()=>{const viewport=document.querySelector('[data-file-source]');viewport.scrollTop=48008;viewport.dispatchEvent(new Event('scroll'));})()`)
  await pause(100)
  assert.ok(await evaluate(`(()=>{const gutters=[...document.querySelectorAll('[data-source-line] > span:first-child')].filter(el=>el.textContent.length>=4);return gutters.length>0&&gutters.every(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getBoundingClientRect().left>=el.getBoundingClientRect().left})})()`),'four-digit source line numbers fit at maximum code size')
  assert.ok(await evaluate(`runtime.terminal.buffer.active.getLine(0).translateToString().includes('typography scrollback')`),'live terminal keeps its buffer')
  await edit('content','24');await waitFor('read().table===21');await pause(100)
  assert.ok(Math.abs((await evaluate('anchors()')).table-after.table)<0.1,'table preserves row when content size changes')

  await evaluate(`setSizes({code:12});wrapSource(true)`);await pause(250)
  await evaluate(`const viewport=document.querySelector('[data-file-source]');viewport.scrollTop=6008;viewport.dispatchEvent(new Event('scroll'));`);await pause(100)
  const sourceAnchor=await evaluate(`(()=>{const viewport=document.querySelector('[data-file-source]'),top=viewport.getBoundingClientRect().top+8;return +[...viewport.querySelectorAll('[data-source-line]')].find(row=>row.getBoundingClientRect().bottom>top).dataset.sourceLine})()`)
  await evaluate(`setSizes({code:24})`);await pause(250)
  assert.ok(await evaluate(`!!document.querySelector('[data-source-line="'+${sourceAnchor}+'"]')`),'wrapped source keeps its logical reading line')
  assert.ok(await evaluate(`(()=>{const viewport=document.querySelector('[data-file-source]');return viewport.scrollWidth<=viewport.clientWidth+1&&viewport.querySelectorAll('[data-source-line]').length<100})()`),'large wrapped code fits its pane and stays bounded')

  await edit('code','99','Enter');assert.equal((await evaluate('read()')).sizes.code,24,'upper range clamps')
  await edit('code','1');assert.equal((await evaluate('read()')).sizes.code,10,'lower range clamps')
  await edit('content','','Enter');assert.equal((await evaluate('read()')).sizes.content,24,'empty draft restores saved value')
  await edit('content','16','Escape');assert.equal((await evaluate('read()')).sizes.content,24,'Escape cancels draft')
  assert.equal((await evaluate('read()')).fields.content,'24')

  await evaluate('window.ready=false');await send('Page.reload');await waitFor('window.ready===true && !!document.querySelector("[data-table-row]")')
  assert.deepEqual(await evaluate('window.bootSizes'),{ui:18,content:24,code:10},'stored sizes apply before React mounts')
  assert.equal((await evaluate('read()')).terminal,12,'terminal starts from stored code size')
  await evaluate(`localStorage.setItem('pi-app:font-sizes',JSON.stringify({ui:'18',content:20,code:999}));`)
  await evaluate('window.ready=false');await send('Page.reload');await waitFor('window.ready===true && !!document.querySelector("[data-table-row]")')
  assert.deepEqual((await evaluate('read()')).sizes,{ui:14,content:20,code:12},'invalid stored fields independently fall back')
  await evaluate(`localStorage.setItem('pi-app:font-sizes','broken JSON')`)
  await evaluate('window.ready=false');await send('Page.reload');await waitFor('window.ready===true && !!document.querySelector("[data-table-row]")')
  assert.deepEqual((await evaluate('read()')).sizes,{ui:14,content:14,code:12},'malformed storage boots safely')

  const originalFonts=await evaluate(`['--app-font-ui','--app-font-mono'].map(key=>document.documentElement.style.getPropertyValue(key))`)
  for(const [content,code,family] of [[12,24,'Arial'],[24,10,'Times New Roman'],[24,24,'Arial']]){
    await evaluate(`setSizes({content:${content},code:${code}});document.documentElement.style.setProperty('--app-font-ui',${JSON.stringify(family)});document.documentElement.style.setProperty('--app-font-mono','Courier New, monospace')`)
    await pause(60)
    await assertInlineAlignment('font '+family+' at '+content+'/'+code)
  }
  await evaluate(`['--app-font-ui','--app-font-mono'].forEach((key,i)=>document.documentElement.style.setProperty(key,${JSON.stringify(originalFonts)}[i]))`)

  await evaluate(`setSizes({ui:20,content:24,code:24});document.getElementById('settings').style.width='320px'`);await pause(150)
  assert.ok(await evaluate(`(()=>{const box=document.getElementById('settings');return box.scrollWidth<=box.clientWidth+1&&[...box.querySelectorAll('input')].every(el=>el.type==='text'&&el.getBoundingClientRect().right<=box.getBoundingClientRect().right+1)})()`),'numeric rows fit a narrow panel at maximum sizes without native spinners')
  if(process.env.PI_FONT_SIZES_SCREENSHOT_DIR){await mkdir(process.env.PI_FONT_SIZES_SCREENSHOT_DIR,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(join(process.env.PI_FONT_SIZES_SCREENSHOT_DIR,'large-fonts.png'),Buffer.from(shot.data,'base64'))}
  await evaluate(`document.querySelector('[data-font-size-reset]').click()`);await waitFor('read().ui===14 && read().content===14 && read().source===12')
  await mirror.waitFor(`document.querySelector('[data-font-size-field="ui"]').value==='14' && document.querySelector('[data-font-size-field="content"]').value==='14'`)
  assert.ok(await evaluate(`document.querySelector('[data-font-size-reset]').disabled`),'reset returns to defaults')
  assert.deepEqual(primary.exceptions,[]);assert.deepEqual(mirror.exceptions,[])
  console.log('PASS: independent sizes, heading/inline-code scale and type centres, native wrapping, draft validation, startup/storage sync, editor identity, bounded source/diff reading anchors, table density and persistent terminal')
} finally {
  for(const ws of sockets)ws.close()
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000)})}
  await server?.close();await rm(temporary,{recursive:true,force:true})
}
