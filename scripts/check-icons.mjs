/** Real SVG adapter/interaction checks in isolated Electron. No SDK or user data.
 * PI_ICONS_SCREENSHOT_DIR retains the light/dark icon and control galleries of
 * both packs. */
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

// PACKS — both packs must render every semantic export. The adapter's icon-pack
// context selects the artwork; this check flips it live and asserts each pass.
// The packs differ in artwork style (Carbon fill, HugeIcons stroke) and Carbon
// does not share one grid: its utility glyphs (arrows, carets, search, settings,
// user, view, upload, …) are drawn on 16 and a few on 20, the rest on 32, so the
// square pack asserts that each glyph keeps the view box ITS module declares —
// which is what proves the adapter passes the artwork through untouched instead
// of rescaling it onto one grid.
// (The former "no @hugeicons dependency" guard was removed by explicit owner
// decision — the reason is recorded in AGENTS.md.)
const PACKS = ['carbon', 'hugeicons']
const HUGE_VIEW_BOX = '0 0 24 24'
// The pack table is the only place mapping a semantic name to Carbon's export.
const carbonExportOf = {}
for (const [, name, ident] of source.matchAll(/^  (\w+): \{ carbon: Carbon\.([\w]+), huge: /gm)) {
  carbonExportOf[name] = ident
}
assert.equal(Object.keys(carbonExportOf).length, expectedNames.length, 'every export has a Carbon glyph')
/** The view box each Carbon module actually draws, read from the installed
 * package. 84 of Carbon's components pick their artwork by the `size` prop
 * (defaulting to 16) and fall back to a canonical drawing otherwise; the adapter
 * deliberately does NOT forward `size` — it passes the box as width/height,
 * because the app styles 454 icon call sites with Tailwind size classes and only
 * a dozen with a numeric size, so Carbon's 16px-drawn artwork is the right
 * default. That makes the drawn artwork the `size === 16` branch when the module
 * has one, and otherwise the unconditional final return. */
const declaredViewBox = {}
for (const [name, ident] of Object.entries(carbonExportOf)) {
  const module = await readFile(join(repo, 'node_modules/@carbon/icons-react/es', `${ident}.js`), 'utf8')
  const matches = [...module.matchAll(/viewBox: "([^"]+)"/g)]
  assert(matches.length, `carbon: ${ident} declares a view box`)
  const sixteen = /if \(size === 16[\s\S]{0,600}?viewBox: "([^"]+)"/.exec(module)
  declaredViewBox[name] = sixteen ? sixteen[1] : matches[matches.length - 1][1]
}

const fixture = `<!doctype html><html><head><style>
body{margin:0!important}main{padding:20px;max-width:1200px;margin:auto}h2{font-size:14px;margin:0 0 12px}
#gallery{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:8px}
.cell{height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
.samples{display:flex;align-items:center;gap:10px}.label{font-size:10px;opacity:.65}
.row{display:flex;gap:20px;align-items:center;margin:16px 0}#brands{display:flex;flex-wrap:wrap;gap:14px}
</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import * as icons from '/src/lib/icons.tsx';
import {IconPackProvider} from '/src/lib/icon-pack.tsx';
import {Checkbox} from '/src/components/motion/checkbox.tsx';
import {Input} from '/src/components/motion/input.tsx';
import {Button,StatefulButton} from '/src/components/motion/button';
import {Loader} from '/src/components/motion/loader.tsx';
import {TodoList} from '/src/components/agents/todo-list.tsx';
import {ProviderIcon} from '/src/components/app/ProviderIcon.tsx';
import '/src/styles.css';
const h=React.createElement;const providers=${JSON.stringify(providers)};
function Fixture(){
 const [checked,setChecked]=React.useState(false),[mixed,setMixed]=React.useState(false);
 const [pack,setPack]=React.useState('carbon');
 const ref=React.useRef(null);window.controls={setChecked,setMixed,setPack};
 React.useEffect(()=>{window.iconRef=ref;window.fixtureReady=true},[]);
 return h(IconPackProvider,{pack},
 h('main',null,
 h('h2',null,pack+' pack · 12 / 16 / 24 px'),
 h('div',{id:'gallery','data-pack':pack},Object.entries(icons).map(([name,Icon])=>h('div',{key:name,className:'cell'},
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
 h('h2',null,'Provider brands · bundled SVG'),h('div',{id:'brands'},...providers.map(providerId=>h(ProviderIcon,{key:providerId,providerId,size:22})))));
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
  const setPack=async pack=>{
    await evaluate(`window.controls.setPack(${JSON.stringify(pack)})`)
    for(let i=0;i<40;i++){if(await evaluate('document.querySelector("#gallery").dataset.pack')===pack)break;await pause(25)}
    assert.equal(await evaluate('document.querySelector("#gallery").dataset.pack'),pack,pack+': active pack reflected in the fixture')
    await pause(60)
  }
  const gallery=async()=>evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="24"]')).map(svg=>({name:svg.dataset.sample,pack:svg.closest('[data-pack]').dataset.pack,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,viewBox:svg.getAttribute('viewBox'),hidden:svg.getAttribute('aria-hidden'),paths:svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse').length,box:JSON.stringify([svg.getBBox().x,svg.getBBox().y,svg.getBBox().width,svg.getBBox().height]),html:svg.outerHTML}))`)
  const signatures={}
  for(const pack of PACKS){
    await setPack(pack)
    const rendered=await gallery()
    assert.deepEqual(rendered.map(icon=>icon.name).sort(),expectedNames,pack+': every export renders')
    for(const icon of rendered){
      assert.equal(icon.pack,pack,pack+': '+icon.name+' rendered by the active pack')
      assert.equal(icon.width,24,pack+': '+icon.name+' width')
      assert.equal(icon.height,24,pack+': '+icon.name+' height')
      assert.equal(icon.viewBox,pack==='carbon'?declaredViewBox[icon.name]:HUGE_VIEW_BOX,pack+': '+icon.name+' keeps its own view box')
      assert.equal(icon.hidden,'true',pack+': '+icon.name+' is decorative by default')
      assert(icon.paths>0,pack+': '+icon.name+' draws real geometry')
      assert.doesNotMatch(icon.box,/NaN|null/,pack+': '+icon.name+' has no NaN/null geometry')
      assert.doesNotMatch(icon.html,/NaN|null/,pack+': '+icon.name+' has no NaN/null attribute')
    }
    signatures[pack]=rendered.map(icon=>icon.html).join('')
    assert.equal(await evaluate('window.iconRef.current===document.querySelector("#props-icon")'),true,pack+': forwards the SVG ref')
    assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("aria-hidden")'),null,pack+': a named SVG stays accessible')
    assert.equal(await evaluate('document.querySelector("#css-icon").getBoundingClientRect().width'),16,pack+': Tailwind size overrides the SVG size')
    for(const arrow of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']){
      const paths=await evaluate(`document.querySelectorAll('[data-sample="${arrow}"][data-size="24"] path').length`)
      assert.ok(paths>=1,pack+': '+arrow+' renders line artwork')
    }
    if(pack==='carbon'){
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),null,'carbon: stroke-only props are dropped')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("fill")'),'currentColor','carbon: fill artwork follows currentColor')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("viewBox")'),declaredViewBox.Search,'carbon: keeps the artwork\'s own view box')
    }else{
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),'3','hugeicons: the requested stroke width is applied')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke")'),'currentColor','hugeicons: stroke follows currentColor')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-linecap")'),'round','hugeicons: round caps')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-linejoin")'),'round','hugeicons: round joins')
      assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("fill")'),'none','hugeicons: stroke artwork is unfilled')
      assert.equal(await evaluate('document.querySelector("#css-icon").getAttribute("stroke-width")'),'1.5','hugeicons: the default stroke is 1.5')
    }
  }
  assert.notEqual(signatures.carbon,signatures.hugeicons,'the two packs draw different artwork')
  // Live switch: the same tree, flipped in place, must change the drawn artwork
  // and flip back — that is what proves no reload/remount is involved.
  await setPack('carbon')
  const carbonPath=await evaluate('document.querySelector("#props-icon path").getAttribute("d")')
  await setPack('hugeicons')
  const hugePath=await evaluate('document.querySelector("#props-icon path").getAttribute("d")')
  assert.notEqual(carbonPath,hugePath,'flipping the pack changes the drawn path live')
  await setPack('carbon')
  assert.equal(await evaluate('document.querySelector("#props-icon path").getAttribute("d")'),carbonPath,'flipping back restores the Carbon artwork')
  console.log('PASS: all '+expectedNames.length+' icons in both packs, live pack switch, native SVG props, CSS sizing, ref and accessibility')

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
  for(const pack of PACKS){
    await setPack(pack)
    for(const theme of ['light','dark']){
      await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'});document.documentElement.style.colorScheme='${theme}'`)
      await pause(200)
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-provider-icon]')).backgroundColor===getComputedStyle(document.querySelector('[data-provider-icon]')).color`),true,'Brand inherits theme color')
      if(process.env.PI_ICONS_SCREENSHOT_DIR){
        await mkdir(process.env.PI_ICONS_SCREENSHOT_DIR,{recursive:true})
        const {cssContentSize}=await send('Page.getLayoutMetrics')
        const screenshot=await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}})
        await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,theme+'-'+pack+'.png'),Buffer.from(screenshot.data,'base64'))
        await evaluate('document.querySelector("#brands").scrollIntoView({block:"end"})')
        await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,theme+'-'+pack+'-controls.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
        await evaluate('window.scrollTo(0,0)')
      }
    }
  }
  await setPack('carbon')
  assert.deepEqual(exceptions,[],'No renderer exceptions')
  console.log('PASS: '+loaded.length+' provider aliases, SVG asset decoding, both packs in light/dark themes')
} finally {
  ws?.close()
  if(child && child.exitCode === null && child.signalCode === null) await new Promise(resolve=>{
    child.once('exit',resolve);child.kill();setTimeout(resolve,5000).unref()
  })
  await server?.close()
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
