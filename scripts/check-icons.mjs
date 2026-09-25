/** Real SVG adapter/interaction checks in isolated Electron. No SDK or user data.
 * PI_ICONS_SCREENSHOT_DIR retains the light/dark icon and control galleries.
 *
 * Icons are pack-free by design: Phosphor for UI glyphs and Catppuccin for file
 * types in BOTH interface styles, so this check asserts one gallery instead of
 * flipping a pack. The source guards at the top fail if a second icon family is
 * ever reintroduced. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-icons-'))
const fixturePath = '/__icons_check.html'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const source = await readFile(join(repo, 'src/renderer/src/lib/icons.tsx'), 'utf8')
const expectedNames = [...source.matchAll(/export const (\w+) =/g)].map(match => match[1]).sort()
const providersSource = await readFile(join(repo, 'src/renderer/src/components/app/ProviderIcon.tsx'), 'utf8')
const providerMap = providersSource.match(/const PROVIDER_ICONS[^=]+=[^{]*\{([\s\S]+?)\n\}/)[1]
const providers = [...providerMap.matchAll(/^  (?:'([^']+)'|([\w]+)): /gm)].map(match => match[1] || match[2])

// One family, one grid: every Phosphor glyph draws on its native 256 view box,
// which proves the adapter passes the library's artwork through rather than
// rescaling paths itself.
const PHOSPHOR_VIEW_BOX = '0 0 256 256'
const glyphs = [...source.matchAll(/^  (\w+): (Phosphor\.\w+),$/gm)]
assert.equal(glyphs.length, expectedNames.length, 'every export has exactly one Phosphor glyph')
assert.deepEqual(glyphs.map(match => match[1]).sort(), expectedNames, 'the mapping table and the exports agree')
assert.doesNotMatch(source, /Carbon|Huge|Remix/, 'the adapter names one icon family only')

// The reverse guard: the removed packs must not creep back as a dependency, a
// map file or a public artwork directory.
const packageJson = await readFile(join(repo, 'package.json'), 'utf8')
assert.doesNotMatch(packageJson, /@carbon\/icons-react|@iconify-json\/vscode-icons/, 'no second UI or file-icon package is declared')
assert.doesNotMatch(await readFile(join(repo, 'src/renderer/src/lib/file-icons.ts'), 'utf8'), /vscode|iconPack|IconPack/, 'the file-icon lookup has one family and no pack parameter')
assert.deepEqual(
  (await readFile(join(repo, 'src/renderer/src/lib/file-icons.map.json'), 'utf8').then(JSON.parse)).source.match(/Catppuccin/)?.[0],
  'Catppuccin',
  'the committed file-icon map is the Catppuccin one'
)

const fixture = `<!doctype html><html><head><style>
body{margin:0!important}main{padding:20px;max-width:1200px;margin:auto}h2{font-size:14px;margin:0 0 12px}
#gallery{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:8px}
.cell{height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
.samples{display:flex;align-items:center;gap:10px}.label{font-size:10px;opacity:.65}
.row{display:flex;gap:20px;align-items:center;margin:16px 0}#brands{display:flex;flex-wrap:wrap;gap:14px}
</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import * as icons from '/src/lib/icons.tsx';
import {Checkbox} from '/src/components/motion/checkbox.tsx';
import {Input} from '/src/components/motion/input.tsx';
import {Button,StatefulButton} from '/src/components/motion/button';
import {Loader} from '/src/components/motion/loader.tsx';
import {TodoList} from '/src/components/agents/todo-list.tsx';
import {ProviderIcon} from '/src/components/app/ProviderIcon.tsx';
import {FileTypeIcon} from '/src/components/app/FileTypeIcon.tsx';
import '/src/styles.css';
const h=React.createElement;const providers=${JSON.stringify(providers)};
function Fixture(){
 const [checked,setChecked]=React.useState(false),[mixed,setMixed]=React.useState(false);
 const ref=React.useRef(null);window.controls={setChecked,setMixed};
 React.useEffect(()=>{window.iconRef=ref;window.fixtureReady=true},[]);
 return h('main',null,
 h('h2',null,'Phosphor · 12 / 16 / 24 px'),
 h('div',{id:'gallery'},Object.entries(icons).map(([name,Icon])=>h('div',{key:name,className:'cell'},
   h('div',{className:'samples'},...[12,16,24].map(size=>h(Icon,{key:size,size,'data-sample':name,'data-size':size}))),h('span',{className:'label'},name)))),
 h('div',{className:'row'},h('div',{id:'checkbox'},h(Checkbox,{checked,indeterminate:mixed,onCheckedChange:setChecked,label:'Checkbox'})),
 h(Input,{success:true,defaultValue:'Input success','aria-label':'Success example'}),
 h(StatefulButton,{state:'loading'},'Save'),h(Loader,{size:24,label:'Working'})),
 h('div',{className:'row'},h(Button,{id:'props-button',variant:'outline'},h(icons.Search,{ref,id:'props-icon',size:48,className:'text-primary',strokeWidth:3,absoluteStrokeWidth:true,'aria-label':'Search example'})),
 h(icons.Check,{id:'css-icon',size:48,className:'size-4 text-primary'}),
 h('div',{style:{width:420}},h(TodoList,{title:'Task states',defaultOpen:true,items:[
 {id:'pending',title:'Pending',status:'pending'},
 {id:'running',title:'In progress',status:'in-progress',progress:42},
 {id:'complete',title:'Completed',status:'completed'},
 {id:'cancelled',title:'Cancelled',status:'cancelled'}]})),
 h('div',{style:{width:300}},h(TodoList,{title:'Complete',defaultOpen:true,items:[{id:'done',title:'Finished',status:'completed'}]}))),
 h('h2',null,'File types · Catppuccin public SVG'),h('div',{id:'file-types',className:'row'},...['index.ts','package.json','README.md','styles.css'].map(path=>h(FileTypeIcon,{key:path,path,className:'size-6'}))),
 h('h2',null,'Provider brands · bundled SVG'),h('div',{id:'brands'},...providers.map(providerId=>h(ProviderIcon,{key:providerId,providerId,size:22}))));
}
createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`

let server, child, ws
try {
  server = await createServer({ configFile:false,root:join(repo,'src/renderer'),logLevel:'error',cacheDir:join(temporary,'vite'),
    resolve:{alias:{'@':join(repo,'src/renderer/src')}},plugins:[react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }),tailwindcss(),{
      name:'icons-fixture',configureServer(server){server.middlewares.use(fixturePath,async(_req,res,next)=>{
        try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(fixturePath,fixture))}catch(error){next(error)}
      })}
    }],server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}}
  })
  await server.listen()
  const main=join(temporary,'main.cjs')
  const url=`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  await writeFile(main,`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1240,height:1250,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  child=spawn(electron,[main],{env,stdio:['ignore','ignore','pipe']})
  const endpoint=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(Error(output||'Debugger timeout')),15000)
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Electron exited: '+code))})
    child.stderr.on('data',chunk=>{output+=chunk;const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1])}})
  })
  let page
  for(let i=0;i<100&&!page;i++){page=(await(await fetch(endpoint+'/json/list')).json()).find(p=>p.type==='page');if(!page)await pause(50)}
  assert(page,'Electron page created')
  ws=new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}))
  let sequence=0;const pending=new Map();const exceptions=[]
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  await send('Runtime.enable')
  let ready=false
  for(let i=0;i<240&&!ready;i++){ready=await evaluate('!!window.fixtureReady');if(!ready)await pause(50)}
  assert(ready,'Fixture mounted')

  const gallery=async()=>evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="24"]')).map(svg=>({name:svg.dataset.sample,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,viewBox:svg.getAttribute('viewBox'),hidden:svg.getAttribute('aria-hidden'),paths:svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse').length,box:JSON.stringify([svg.getBBox().x,svg.getBBox().y,svg.getBBox().width,svg.getBBox().height]),html:svg.outerHTML}))`)
  const rendered=await gallery()
  assert.deepEqual(rendered.map(icon=>icon.name).sort(),expectedNames,'every export renders')
  for(const icon of rendered){
    assert.equal(icon.width,24,icon.name+': width')
    assert.equal(icon.height,24,icon.name+': height')
    assert.equal(icon.viewBox,PHOSPHOR_VIEW_BOX,icon.name+': keeps the native 256 grid')
    assert.equal(icon.hidden,'true',icon.name+': is decorative by default')
    assert(icon.paths>0,icon.name+': draws real geometry')
    assert.doesNotMatch(icon.box,/NaN|null/,icon.name+': has no NaN/null geometry')
    assert.doesNotMatch(icon.html,/NaN|null/,icon.name+': has no NaN/null attribute')
  }
  assert.equal(await evaluate('window.iconRef.current===document.querySelector("#props-icon")'),true,'forwards the SVG ref')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("aria-hidden")'),null,'a named SVG stays accessible')
  assert.equal(await evaluate('document.querySelector("#css-icon").getBoundingClientRect().width'),16,'Tailwind size overrides the SVG size')
  for(const arrow of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']){
    const paths=await evaluate(`document.querySelectorAll('[data-sample="${arrow}"][data-size="24"] path').length`)
    assert.ok(paths>=1,arrow+' renders line artwork')
  }
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),null,'stroke-only props are dropped')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("fill")'),'currentColor','regular fill artwork follows currentColor')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("viewBox")'),PHOSPHOR_VIEW_BOX,'keeps the native 256 grid for every size')
  const fileIcons=await evaluate(`Promise.all(Array.from(document.querySelectorAll('#file-types img')).map(async image=>{await image.decode();return {src:image.getAttribute('src'),width:image.naturalWidth,height:image.naturalHeight}}))`)
  assert(fileIcons.every(icon=>/^\.\/file-icons\/[^/]+\.svg$/.test(icon.src)),'file icons load Catppuccin artwork from the flat public directory')
  assert(fileIcons.every(icon=>icon.width>0&&icon.height>0),'file icon SVGs decode')
  console.log('PASS: all '+expectedNames.length+' icons in the one Phosphor gallery, native SVG props, CSS sizing, ref and accessibility')

  await evaluate('document.querySelector("#checkbox button").click()')
  await pause(80)
  const during=await evaluate('document.querySelector("#checkbox svg path").getAttribute("stroke-dasharray")')
  await pause(400)
  assert.equal(await evaluate('document.querySelector("#checkbox button").getAttribute("aria-checked")'),'true')
  assert.notEqual(await evaluate('document.querySelector("#checkbox svg path").getAttribute("stroke-dasharray")'),during,'beUI check still draws in')
  assert.ok((await evaluate('document.querySelector("#checkbox svg path").getAttribute("d")')).length>0,'Animated check keeps its draw-in geometry')
  assert.ok((await evaluate('document.querySelector("#css-icon path").getAttribute("d")')).length>0,'Static check renders line artwork')
  await evaluate('window.controls.setMixed(true)');await pause(400)
  assert.equal(await evaluate('document.querySelector("#checkbox button").getAttribute("aria-checked")'),'mixed')
  assert.equal(await evaluate('document.querySelector("#checkbox svg").dataset.appIcon'),'minus')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await evaluate('window.fixtureReady=false')
  await send('Page.reload')
  ready=false
  for(let i=0;i<240&&!ready;i++){ready=await evaluate('!!window.fixtureReady');if(!ready)await pause(50)}
  assert(ready,'Reduced motion fixture mounted')
  await evaluate('document.querySelector("#checkbox button").click()');await pause(80)
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#checkbox svg")).opacity'),'1','Reduced motion settles immediately')
  console.log('PASS: checkbox input, mixed state, shared glyph drawing and reduced motion')

  const loaded=await evaluate(`Promise.all(Array.from(document.querySelectorAll('[data-provider-icon]')).map(async element=>{const source=getComputedStyle(element).maskImage.slice(5,-2);const image=new Image();image.src=source;await image.decode();return {id:element.dataset.providerIcon,width:image.naturalWidth,height:image.naturalHeight}}))`)
  assert.equal(loaded.length,providers.length)
  assert(loaded.every(image=>image.width>0&&image.height>0),'All bundled provider masks decode')
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'});document.documentElement.style.colorScheme='${theme}'`)
    await pause(200)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-provider-icon]')).backgroundColor===getComputedStyle(document.querySelector('[data-provider-icon]')).color`),true,'Brand inherits theme color')
    if(process.env.PI_ICONS_SCREENSHOT_DIR){
      await mkdir(process.env.PI_ICONS_SCREENSHOT_DIR,{recursive:true})
      const {cssContentSize}=await send('Page.getLayoutMetrics')
      const screenshot=await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}})
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,theme+'.png'),Buffer.from(screenshot.data,'base64'))
      await evaluate('document.querySelector("#brands").scrollIntoView({block:"end"})')
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,theme+'-controls.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
      await evaluate('window.scrollTo(0,0)')
    }
  }
  assert.deepEqual(exceptions,[],'No renderer exceptions')
  console.log('PASS: '+loaded.length+' provider aliases, SVG asset decoding, light/dark themes')
} finally {
  ws?.close()
  if(child && child.exitCode === null && child.signalCode === null) await new Promise(resolve=>{
    child.once('exit',resolve);child.kill();setTimeout(resolve,5000).unref()
  })
  await server?.close()
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
