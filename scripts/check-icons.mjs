/** Real SVG adapter/interaction checks in isolated Electron. No SDK or user data.
 * PI_ICONS_SCREENSHOT_DIR retains the light/dark icon and control galleries.
 *
 * Icons use Hugeicons Stroke Rounded for UI glyphs and Catppuccin for file
 * types in BOTH interface styles, so this check asserts one gallery instead of
 * flipping a pack. The source guards at the top fail if a second icon family is
 * ever reintroduced — @phosphor-icons/react is the ONE exception, kept in
 * package.json as the pre-migration family so a revert stays a one-line
 * declaration change, and imported by nothing. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as hugeicons from '@hugeicons/core-free-icons'
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
const expectedNames = [...source.matchAll(/^export const (\w+) = /gm)].map(match => match[1]).sort()
const providersSource = await readFile(join(repo, 'src/renderer/src/components/app/ProviderIcon.tsx'), 'utf8')
const providerMap = providersSource.match(/const PROVIDER_ICONS[^=]+=[^{]*\{([\s\S]+?)\n\}/)[1]
const providers = [...providerMap.matchAll(/^  (?:'([^']+)'|([\w]+)): /gm)].map(match => match[1] || match[2])

// Resolve every binding against the installed Stroke Rounded pack. The custom
// Agent brand is the sole app-owned drawing in this table.
const glyphTable = source.match(/const GLYPHS = \{([\s\S]+?)\n\}/)[1]
const glyphs = [...glyphTable.matchAll(/^  (\w+): (\w+),?$/gm)].map(([, name, glyph]) => ({ name, glyph }))
const brandNames = ['Bot', 'Subagent']
const keycapNames = ['Backspace']
assert.equal(glyphs.length, expectedNames.length, 'every export has exactly one drawing')
assert.deepEqual(glyphs.map(glyph => glyph.name).sort(), expectedNames, 'the mapping table and the exports agree')
assert.ok(new Set(glyphs.map(glyph => glyph.glyph)).size > 150, 'the vocabulary draws from the whole family')
for (const glyph of glyphs) {
  if (brandNames.includes(glyph.name)) {
    assert.equal(glyph.glyph, 'AgentBrandGlyph', glyph.name + ': custom Agent SVG')
    continue
  }
  if (keycapNames.includes(glyph.name)) {
    assert.equal(glyph.glyph, 'BackspaceKeycapGlyph', glyph.name + ': keyboard geometry')
    continue
  }
  const artwork = hugeicons[glyph.glyph]
  assert.ok(Array.isArray(artwork) && artwork.length, glyph.name + ': ' + glyph.glyph + ' is a Hugeicons export')
  for (const [, attributes] of artwork) {
    // The pack encodes Wrench's tiny handle dot as a 2px stroke. The adapter
    // normalizes that stroke-only drawing; the browser check below pins 1.5.
    const dot = glyph.glyph === 'Wrench01Icon' && attributes.key === '2'
    if (attributes.stroke) assert.equal(Number(attributes.strokeWidth), dot ? 2 : 1.5, glyph.name + ': native stroke geometry')
  }
}
assert.match(source, /^const GLYPHS = \{$/m, 'the adapter keeps its one reviewable table')
assert.doesNotMatch(source, /from ['"](?:lucide|@phosphor-icons|@carbon|@iconify)/, 'the adapter imports one icon family only')

// The reverse guard: the removed packs must not creep back as a dependency, a
// map file or a public artwork directory. Phosphor is the retained rollback
// family — declared, never imported.
const packageJson = await readFile(join(repo, 'package.json'), 'utf8')
assert.match(packageJson, /"@hugeicons\/react": "/, 'the renderer is declared as a package')
assert.match(packageJson, /"@hugeicons\/core-free-icons": "/, 'the Stroke Rounded pack is declared as a package')
assert.match(packageJson, /"@phosphor-icons\/react": "/, 'the previous family stays declared for rollback')
assert.doesNotMatch(packageJson, /@carbon\/icons-react|@iconify-json\/vscode-icons|lucide-react|lucide-static/, 'no third UI or file-icon package is declared')
const adapters = await Promise.all(
  ['icons.tsx', 'animated-icons.tsx'].map(file => readFile(join(repo, 'src/renderer/src/lib', file), 'utf8'))
)
assert.doesNotMatch(adapters.join('\n'), /from '@phosphor-icons\/react'/, 'nothing imports the rollback family')
const rendererRoot = join(repo, 'src/renderer/src')
for (const file of await readdir(rendererRoot, { recursive: true })) {
  if (!/\.tsx?$/.test(file)) continue
  const contents = await readFile(join(rendererRoot, file), 'utf8')
  assert.doesNotMatch(contents, /from\s*['"](?:lucide-react|@phosphor-icons\/react|@carbon\/icons-react|@iconify\/react)['"]/, file + ': glyphs use the shared adapter')
  if (!['lib/icons.tsx', 'lib/animated-icons.tsx', 'lib/brand-icons.ts', 'lib/keycap-artwork.ts'].includes(file)) {
    assert.doesNotMatch(contents, /from\s*['"]@hugeicons\//, file + ': Hugeicons imports stay in the adapter')
  }
}
assert.doesNotMatch(await readFile(join(repo, 'src/renderer/src/lib/file-icons.ts'), 'utf8'), /vscode|iconPack|IconPack/, 'the file-icon lookup has one family and no pack parameter')
assert.deepEqual(
  (await readFile(join(repo, 'src/renderer/src/lib/file-icons.map.json'), 'utf8').then(JSON.parse)).source.match(/Catppuccin/)?.[0],
  'Catppuccin',
  'the committed file-icon map is the Catppuccin one'
)

// Hugeicons draws every glyph on one 24 grid with its own balanced extent; the
// family's optical scale is what the check
// asserts, not a normalization.
const ICON_VIEW_BOX = '0 0 24 24'
const OPTICAL = { min: 8, max: 24, medianMin: 17, medianMax: 21 }

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
import {PromptInput} from '/src/components/agents/prompt-input.tsx';
import {ProviderIcon} from '/src/components/app/ProviderIcon.tsx';
import {FileTypeIcon} from '/src/components/app/FileTypeIcon.tsx';
import {FileAttachmentCard} from '/src/components/app/FileAttachmentCard.tsx';
import {PresentedFiles} from '/src/components/app/PresentedFiles.tsx';
import {PithIcon} from '/src/components/app/PithIcon.tsx';
import {ShortcutKeys} from '/src/components/app/ShortcutKeys.tsx';
import {UI_ICON_SIZE,FILE_ICON_SIZE} from '/src/lib/icon-metrics.ts';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';
const h=React.createElement;const providers=${JSON.stringify(providers)};
function Fixture(){
 const [checked,setChecked]=React.useState(false),[mixed,setMixed]=React.useState(false);
 const ref=React.useRef(null);window.controls={setChecked,setMixed};
 React.useEffect(()=>{window.iconRef=ref;window.fixtureReady=true},[]);
 return h('main',null,
 h('h2',null,'Hugeicons Stroke Rounded · 16 / 18 / 20 px · stroke 1.5'),
 h('div',{id:'gallery'},Object.entries(icons).map(([name,Icon])=>h('div',{key:name,className:'cell'},
   h('div',{className:'samples'},...Object.values(UI_ICON_SIZE).map(size=>h(Icon,{key:size,size,'data-sample':name,'data-size':size}))),h('span',{className:'label'},name)))),
 h('div',{className:'row'},h('div',{id:'checkbox'},h(Checkbox,{checked,indeterminate:mixed,onCheckedChange:setChecked,label:'Checkbox'})),
 h(Input,{success:true,defaultValue:'Input success','aria-label':'Success example'}),
 h(StatefulButton,{state:'loading'},'Save'),h(Loader,{size:24,label:'Working'})),
 h('div',{className:'row'},h(Button,{id:'props-button',variant:'outline'},h(icons.Search,{ref,id:'props-icon',size:48,className:'text-primary',strokeWidth:3,absoluteStrokeWidth:true,'aria-label':'Search example'})),
 h(icons.Check,{id:'css-icon',size:48,className:'size-4 text-primary'}),
 h(icons.Search,{id:'default-icon'}),
 h('div',{style:{width:420}},h(TodoList,{title:'Task states',defaultOpen:true,items:[
 {id:'pending',title:'Pending',status:'pending'},
 {id:'running',title:'In progress',status:'in-progress',progress:42},
 {id:'complete',title:'Completed',status:'completed'},
 {id:'cancelled',title:'Cancelled',status:'cancelled'}]})),
 h('div',{style:{width:300}},h(TodoList,{title:'Complete',defaultOpen:true,items:[{id:'done',title:'Finished',status:'completed'}]}))),
 h('h2',null,'File types · Catppuccin · 16px trees/tabs / 18px cards'),h('div',{id:'file-types',className:'row'},...Object.keys(FILE_ICON_SIZE).flatMap(variant=>['index.ts','package.json','README.md','styles.css'].map(path=>h(FileTypeIcon,{key:variant+path,path,variant})))),
 h('div',{className:'row'},h(FileAttachmentCard,{path:'/fixture/index.ts',label:'index.ts',onRemove:()=>{}}),h(PresentedFiles,{files:[{path:'/fixture/result.ts',size:120}]})),
 h('h2',null,'Custom branding · Pi/Pith and Agent'),h('div',{id:'app-brands',className:'row'},h(PithIcon,{className:'size-10'}),h(icons.Bot),h(icons.Subagent)),
 h('h2',null,'Primary actions · send / stop'),h('div',{id:'primary-actions',className:'row'},
   h('div',{style:{width:384,flexShrink:0}},h(PromptInput,{defaultValue:'Send example',onSubmit:()=>{}})),
   h('div',{style:{width:384,flexShrink:0}},h(PromptInput,{loading:true,onStop:()=>{window.stopPressed=true}}))),
 h('div',{id:'keycaps',className:'row'},h(ShortcutKeys,{binding:'Mod+Shift+Backspace',mac:true})),
 h('h2',null,'Provider brands · bundled SVG'),h('div',{id:'brands'},...providers.map(providerId=>h(ProviderIcon,{key:providerId,providerId,size:22}))));
}
createRoot(document.getElementById('root')).render(h(I18nProvider,null,h(Fixture)));
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
  assert(ready,'Fixture mounted: '+JSON.stringify(exceptions))

  // The native drawings include stroke paths and small filled details. Inspect
  // actual child strokes so a default override cannot outline a filled detail.
  const gallery=async()=>evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="18"]')).map(svg=>{const box=svg.getBBox();const view=svg.getAttribute('viewBox').split(' ').map(Number);const perUnit=24/view[2];return {name:svg.dataset.sample,family:svg.dataset.iconFamily,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,viewBox:svg.getAttribute('viewBox'),hidden:svg.getAttribute('aria-hidden'),fill:svg.getAttribute('fill'),strokes:[...svg.querySelectorAll('[stroke]')].map(node=>({color:node.getAttribute('stroke'),width:node.getAttribute('stroke-width')})),paths:svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse').length,inkLongSide:Math.max(box.width,box.height)*perUnit,box:JSON.stringify([box.x,box.y,box.width,box.height]),html:svg.outerHTML}})`)
  const rendered=await gallery()
  assert.deepEqual(rendered.map(icon=>icon.name).sort(),expectedNames,'every export renders')
  for(const icon of rendered){
    assert.equal(icon.width,18,icon.name+': width')
    assert.equal(icon.height,18,icon.name+': height')
    assert.equal(icon.family,brandNames.includes(icon.name)?'brand':keycapNames.includes(icon.name)?'keycap':'hugeicons',icon.name+': belongs to the expected family')
    assert.equal(icon.viewBox,ICON_VIEW_BOX,icon.name+': draws on the family canvas')
    assert.equal(icon.hidden,'true',icon.name+': is decorative by default')
    assert.equal(icon.fill,'none',icon.name+': is stroke artwork, not fill')
    assert.ok(icon.strokes.length,icon.name+': has stroke artwork')
    for(const stroke of icon.strokes){
      assert.equal(stroke.color,'currentColor',icon.name+': follows the text colour')
      assert.equal(stroke.width,'1.5',icon.name+': draws the family default weight')
    }
    assert(icon.paths>0,icon.name+': draws real geometry')
    assert(icon.inkLongSide>=OPTICAL.min&&icon.inkLongSide<=OPTICAL.max,icon.name+': ink stays inside the family canvas ('+icon.inkLongSide.toFixed(1)+')')
    assert.doesNotMatch(icon.box,/NaN|null/,icon.name+': has no NaN/null geometry')
    assert.doesNotMatch(icon.html,/NaN|null/,icon.name+': has no NaN/null attribute')
  }
  const longSides=rendered.map(icon=>icon.inkLongSide).sort((a,b)=>a-b)
  const median=longSides[Math.floor(longSides.length/2)]
  assert.ok(median>=OPTICAL.medianMin&&median<=OPTICAL.medianMax,'the vocabulary\'s median glyph lands on the family\'s optical scale ('+median.toFixed(2)+')')
  assert.equal(await evaluate('window.iconRef.current===document.querySelector("#props-icon")'),true,'forwards the SVG ref')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("aria-hidden")'),null,'a named SVG stays accessible')
  assert.equal(await evaluate('document.querySelector("#css-icon").getBoundingClientRect().width'),16,'Tailwind size overrides the SVG size')
  assert.equal(await evaluate('document.querySelector("#default-icon").getBoundingClientRect().width'),18,'normal UI defaults to 18px')
  for(const size of [16,18,20])assert.equal(await evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="${size}"]')).every(svg=>svg.getBoundingClientRect().width===${size}&&svg.getBoundingClientRect().height===${size})`),true,size+'px gallery uses the actual canvas size')
  for(const arrow of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']){
    const paths=await evaluate(`document.querySelectorAll('[data-sample="${arrow}"][data-size="18"] path').length`)
    assert.ok(paths>=1,arrow+' renders line artwork')
  }
  // A stroke family makes these props mean what Hugeicons says: an absolute stroke
  // is scaled to hold its pixel width at any rendered size.
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),'1.5','absoluteStrokeWidth scales the stroke to size')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("fill")'),'none','the family is stroke artwork')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("viewBox")'),ICON_VIEW_BOX,'every size keeps the family canvas')
  const fileIcons=await evaluate(`Promise.all(Array.from(document.querySelectorAll('#file-types img')).map(async image=>{await image.decode();return {src:image.getAttribute('src'),width:image.naturalWidth,height:image.naturalHeight,variant:image.dataset.fileIconKind,side:image.getBoundingClientRect().width}}))`)
  assert(fileIcons.every(icon=>/^\.\/file-icons\/[^/]+\.svg$/.test(icon.src)),'file icons load Catppuccin artwork from the flat public directory')
  assert(fileIcons.every(icon=>icon.width>0&&icon.height>0),'file icon SVGs decode')
  assert(fileIcons.every(icon=>icon.side===(icon.variant==='card'?18:16)),'Catppuccin trees/tabs are 16px and cards 18px')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-attachment-card] [data-file-icon],[data-presented-files] [data-file-icon]')).map(image=>image.getBoundingClientRect().width)`),[18,18],'real attachment/presented file cards use 18px artwork')
  assert.equal(await evaluate(`Promise.all(Array.from(document.querySelectorAll('#app-brands img')).map(async image=>{await image.decode();return image.naturalWidth>0})).then(results=>results.every(Boolean))`),true,'custom Pi/Pith SVG decodes')
  for(const style of ['square','squircle']){
    await evaluate(`document.documentElement.dataset.corners='${style}'`)
    assert.deepEqual(await gallery(),rendered,style+': corner style keeps the same artwork')
  }
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#primary-actions [data-app-icon="Send"],#primary-actions [data-app-icon="CircleOff"]')).map(svg=>[svg.dataset.appIcon,svg.getBoundingClientRect().width])`),[['Send',20],['CircleOff',20]],'real primary controls use 20px canvases')
  assert.equal(await evaluate(`document.querySelector('#primary-actions [data-app-icon="CircleOff"]').closest('button').classList.contains('text-destructive')`),true,'stop retains its error red')
  assert.equal(await evaluate(`(()=>{const svg=document.querySelector('#primary-actions [data-app-icon="CircleOff"]');return getComputedStyle(svg.querySelector('path')).stroke===getComputedStyle(svg.closest('button')).color})()`),true,'the stop stroke inherits the error red')
  await evaluate(`document.querySelector('#primary-actions [data-app-icon="CircleOff"]').closest('button').click()`)
  assert.equal(await evaluate('window.stopPressed'),true,'the migrated stop control still acts')
  const keycaps=await evaluate(`Array.from(document.querySelectorAll('#keycaps svg')).map(svg=>({side:svg.getBoundingClientRect().width,stroke:[...svg.querySelectorAll('path')].map(path=>path.getAttribute('stroke-width')||svg.getAttribute('stroke-width'))}))`)
  assert.equal(keycaps.length,3,'command, shift and backspace render as keyboard marks')
  assert(keycaps.every(mark=>mark.side===16&&mark.stroke.every(width=>width==='1.5')),'keyboard marks use the compact canvas and 1.5 stroke')
  console.log('PASS: all '+expectedNames.length+' Hugeicons/custom-brand glyphs, 16/18/20px canvases, 1.5 stroke, primary actions, keyboard marks, CSS sizing, refs, accessibility and both corner styles')

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
