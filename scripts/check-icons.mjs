/** Real SVG adapter/interaction checks in isolated Electron. No SDK or user data.
 * PI_ICONS_SCREENSHOT_DIR retains the light/dark icon and control galleries.
 *
 * Icons use Remix in square interfaces and Hugeicons Stroke Rounded in squircle
 * interfaces; a few app-owned drawings (lib/app-artwork.tsx) cover meanings
 * Remix lacks, while file types switch from square Pierre adaptations to native Pierre and vendored
 * Lucide shortcut keycaps stay independent of style. All glyphs use the shared
 * adapter, with no Lucide dependency. Phosphor stays declared for rollback and
 * imported by nothing. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as hugeicons from '@hugeicons/core-free-icons'
import * as remix from '@remixicon/react'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// Resolve ordinary UI bindings against Stroke Rounded; the keyboard-only
// subset comes from the checked-in Lucide SVGs.
const glyphTable = source.match(/const GLYPHS = \{([\s\S]+?)\n\}/)[1]
const glyphs = [...glyphTable.matchAll(/^  (\w+): \{ rounded: ([\w.]+), square: (\w+) \},?$/gm)].map(([, name, glyph, square]) => ({ name, glyph, square }))
const keycapNames = ['Command', 'Option', 'Control', 'Shift', 'Backspace', 'KeyArrowLeft', 'KeyArrowRight', 'KeyArrowUp', 'KeyArrowDown']
// App-owned filled artwork for meanings the Remix pack does not draw (the Diff
// plus/minus mark, lib/app-artwork.tsx). The rendered gallery below still
// validates its grid, fill and geometry; every other square glyph must be a
// real Remix export.
const appSquareArtwork = new Set(['DiffArtwork'])
assert.equal(glyphs.length, expectedNames.length, 'every semantic export has an artwork binding')
assert.deepEqual(glyphs.map(glyph => glyph.name).sort(), expectedNames, 'the mapping table and the exports agree')
assert.ok(new Set(glyphs.map(glyph => glyph.glyph)).size > 150, 'the vocabulary draws from the whole family')
for (const glyph of glyphs) {
  if (keycapNames.includes(glyph.name)) {
    assert.equal(glyph.glyph, 'KEYCAP_ARTWORK.' + glyph.name, glyph.name + ': vendored keyboard artwork')
    assert.equal(glyph.square, 'null', glyph.name + ': keyboard artwork is independent of style')
    continue
  }
  assert.ok(appSquareArtwork.has(glyph.square) || typeof remix[glyph.square] === 'function', glyph.name + ': a Remix export (or app artwork) covers the square interface')
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
assert.doesNotMatch(source, /from ['"](?:lucide|@phosphor-icons|@iconify)/, 'unselected families do not enter the adapter')

// Tool rows: two bundled extensions deliberately draw ONE glyph for the whole
// family instead of one per tool, and the folded `context` group wears the same
// mark as its rows. A per-tool glyph creeping back in is the regression here.
const toolIcons = await readFile(join(repo, 'src/renderer/src/lib/tool-icons.tsx'), 'utf8')
const ctxRows = [...toolIcons.matchAll(/^  (ctx_\w+): (\w+),$/gm)]
assert.equal(ctxRows.length, 11, 'the context family keeps one row per ctx_* tool')
assert.ok(ctxRows.every(([, , glyph]) => glyph === 'Columns3Cog'), 'every ctx_* row draws the context family glyph: ' + JSON.stringify(ctxRows))
const lensGlyphs = new Set(['lens_diagnostics', 'lens_diagnostic_mark', 'symbol_search', 'read_symbol', 'read_enclosing', 'lsp_navigation', 'project_report', 'module_report', 'effective_config', 'pi_lens_activate_tools', 'ast_grep_search', 'ast_grep_replace', 'ast_grep_outline'].map((name) => new RegExp('^  ' + name + ': (\\w+),$', 'm').exec(toolIcons)?.[1]))
assert.deepEqual([...lensGlyphs], ['Codesandbox'], 'pi-lens draws one glyph for every one of its tools')
const categories = await readFile(join(repo, 'src/renderer/src/lib/tool-categories.ts'), 'utf8')
assert.match(categories, /icon: Columns3Cog,\n    prefix: 'ctx_'/, 'the folded context group wears the family glyph')

// The reverse guard: the removed packs must not creep back as a dependency, a
// map file or a public artwork directory. Phosphor is the retained rollback
// family — declared, never imported.
const packageJson = await readFile(join(repo, 'package.json'), 'utf8')
assert.match(packageJson, /"@hugeicons\/react": "/, 'the renderer is declared as a package')
assert.match(packageJson, /"@hugeicons\/core-free-icons": "/, 'the Stroke Rounded pack is declared as a package')
assert.match(packageJson, /"@remixicon\/react": "/, 'the Remix pack is declared as a package')
assert.match(packageJson, /"@phosphor-icons\/react": "/, 'the previous family stays declared for rollback')
assert.doesNotMatch(packageJson, /@carbon\/icons-react/, 'the replaced Carbon pack is removed')
assert.doesNotMatch(packageJson, /@iconify-json\/(?:vscode-icons|catppuccin)|lucide-react|lucide-static/, 'no additional UI or file-icon package is declared')
const adapters = await Promise.all(
  ['icons.tsx', 'animated-icons.tsx'].map(file => readFile(join(repo, 'src/renderer/src/lib', file), 'utf8'))
)
assert.doesNotMatch(adapters.join('\n'), /from '@phosphor-icons\/react'/, 'nothing imports the rollback family')
const rendererRoot = join(repo, 'src/renderer/src')
for (const file of await readdir(rendererRoot, { recursive: true })) {
  if (!/\.tsx?$/.test(file)) continue
  const contents = await readFile(join(rendererRoot, file), 'utf8')
  assert.doesNotMatch(contents, /from\s*['"](?:lucide-react|@phosphor-icons\/react|@iconify\/react)['"]/, file + ': glyphs use the shared adapter')
  if (file !== 'lib/icons.tsx') assert.doesNotMatch(contents, /from\s*['"]@remixicon\//, file + ': Remix imports stay in the adapter')
  if (!['lib/icons.tsx', 'lib/animated-icons.tsx', 'lib/brand-icons.ts', 'lib/keycap-artwork.ts'].includes(file)) {
    assert.doesNotMatch(contents, /from\s*['"]@hugeicons\//, file + ': Hugeicons imports stay in the adapter')
  }
}
const fileMap = JSON.parse(await readFile(join(repo, 'src/renderer/src/lib/file-icons.map.json'), 'utf8'))
const pierreMap = JSON.parse(await readFile(join(repo, 'src/renderer/src/lib/pierre-file-icons.map.json'), 'utf8'))
const pierreExtensions = JSON.parse(await readFile(join(repo, 'src/renderer/src/lib/pierre-file-icons.extensions.json'), 'utf8'))
const fileArtwork = [...new Set([fileMap.default, ...Object.values(fileMap.names), ...Object.values(fileMap.extensions)])]
const pierreArtwork = [...new Set([pierreMap.default, ...Object.values(pierreMap.names), ...Object.values(pierreMap.extensions), ...Object.values(pierreExtensions.extensions)])]
const fileSamples = [
  ['index.ts', 'typescript'], ['App.tsx', 'react'], ['index.mjs', 'javascript'],
  ['README.md', 'markdown'], ['notes.md', 'markdown'], ['package.json', 'json'],
  ['tsconfig.json', 'json'], ['styles.css', 'css'], ['styles.scss', 'sass'], ['script.py', 'python'],
  ['main.rs', 'rust'], ['Dockerfile', 'docker'], ['report.pdf', 'pith-pdf'],
  ['proposal.docx', 'pith-document'], ['legacy.doc', 'pith-document'],
  ['macro.docm', 'pith-document'], ['writing.odt', 'pith-document'], ['rich.rtf', 'pith-document'],
  ['budget.xlsx', 'pith-spreadsheet'], ['legacy.xls', 'pith-spreadsheet'],
  ['macro.xlsm', 'pith-spreadsheet'], ['budget.ods', 'pith-spreadsheet'],
  ['slides.pptx', 'pith-presentation'], ['legacy.ppt', 'pith-presentation'], ['slides.odp', 'pith-presentation'],
  ['recording.mp3', 'pith-audio'], ['sound.wav', 'pith-audio'],
  ['lossless.flac', 'pith-audio'], ['speech.opus', 'pith-audio'], ['podcast.m4a', 'pith-audio'],
  ['clip.mp4', 'pith-video'], ['take.mov', 'pith-video'], ['recording.webm', 'pith-video'],
  ['footage.mkv', 'pith-video'], ['legacy.avi', 'pith-video'],
  ['C:\\reports\\季度总结.PDF', 'pith-pdf'], ['private.key', 'default'], ['graph.dot', 'default'],
  ['photo.png', 'image'], ['archive.tar.gz', 'zip'], ['font.woff2', 'font'],
  ['src/index.d.ts', 'typescript'], ['src/index.test.ts', 'typescript'],
  ['C:\\project\\PACKAGE.JSON', 'json'], ['.eslintrc', 'eslint'],
  ['unknown.custom', 'default'], ['constructor', 'default'], ['file.__proto__', 'default']
]
const additionSamples = ['report.pdf', 'proposal.docx', 'budget.xlsx', 'slides.pptx', 'recording.mp3', 'clip.mp4']
const themeColorSamples = [
  ['index.ts', '26,133,212', '105,177,255'],
  ['styles.scss', '211,42,97', '255,103,141'],
  ['report.pdf', '213,44,54', '255,103,98'],
  ['proposal.docx', '26,133,212', '105,177,255'],
  ['budget.xlsx', '25,159,67', '94,204,113'],
  ['slides.pptx', '212,118,40', '255,163,89'],
  ['recording.mp3', '166,49,190', '213,104,234'],
  ['clip.mp4', '105,58,207', '157,106,251']
]

// Hugeicons draws every glyph on one 24 grid with its own balanced extent; the
// family's optical scale is what the check
// asserts, not a normalization.
const ICON_VIEW_BOX = '0 0 24 24'
const OPTICAL = { min: 8, max: 24, medianMin: 17, medianMax: 21 }

const fixture = `<!doctype html><html><head><style>
body{margin:0!important}main{padding:20px;max-width:1200px;margin:auto}h2{font-size:14px;margin:0 0 12px}
#gallery,#file-types{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:8px}
#file-additions{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
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
import {fileIconName} from '/src/lib/file-icons.ts';
import {FileAttachmentCard} from '/src/components/app/FileAttachmentCard.tsx';
import {PresentedFiles} from '/src/components/app/PresentedFiles.tsx';
import {PithIcon} from '/src/components/app/PithIcon.tsx';
import {ShortcutKeys} from '/src/components/app/ShortcutKeys.tsx';
import {UI_ICON_SIZE,FILE_ICON_SIZE} from '/src/lib/icon-metrics.ts';
import {setUiStyle,useUiStyle} from '/src/lib/ui-style.ts';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';
const h=React.createElement;const providers=${JSON.stringify(providers)};const fileSamples=${JSON.stringify(fileSamples)};const additionSamples=${JSON.stringify(additionSamples)};
window.fileIconName=fileIconName;
window.setUiStyle=setUiStyle;
function Fixture(){
 const [uiStyle]=useUiStyle();
 const [checked,setChecked]=React.useState(false),[mixed,setMixed]=React.useState(false);
 const ref=React.useRef(null);window.controls={setChecked,setMixed};
 React.useEffect(()=>{window.iconRef=ref;window.fixtureReady=true},[]);
 return h('main',null,
 h('h2',null,(uiStyle==='square'?'Remix · square':'Hugeicons Stroke Rounded · squircle')+' · 16 / 18 / 20 px'),
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
 h('h2',null,'File types · '+(uiStyle==='square'?'Pierre square':'Pierre Icons')+' · 16px trees/tabs / 18px cards'),h('div',{id:'file-types'},...fileSamples.map(([path])=>h('div',{key:path,className:'cell'},h('div',{className:'samples'},...Object.keys(FILE_ICON_SIZE).map(variant=>h(FileTypeIcon,{key:variant,path,variant}))),h('span',{className:'label'},path.split(/[\\\\/]/).pop())))),
 h('div',{className:'row'},h(FileAttachmentCard,{path:'/fixture/report.pdf',label:'report.pdf',onRemove:()=>{}}),h(PresentedFiles,{files:[{path:'/fixture/recording.mp3',size:120}]})),
 h('h2',null,'Document and media additions · 16px trees/tabs / 18px cards'),
 h('div',{id:'file-additions'},...additionSamples.map(path=>h('div',{key:path,className:'cell'},h('div',{className:'samples'},...Object.keys(FILE_ICON_SIZE).map(variant=>h(FileTypeIcon,{key:variant,path,variant}))),h('span',{className:'label'},path)))),
 h('h2',null,'Custom branding · Pi/Pith'),h('div',{id:'app-brands',className:'row'},h(PithIcon,{className:'size-10'}),h(PithIcon,{variant:'mark',className:'size-10 text-primary'})),
 h('h2',null,'Primary actions · send / stop'),h('div',{id:'primary-actions',className:'row'},
   h('div',{style:{width:384,flexShrink:0}},h(PromptInput,{defaultValue:'Send example',onSubmit:()=>{}})),
   h('div',{style:{width:384,flexShrink:0}},h(PromptInput,{loading:true,onStop:()=>{window.stopPressed=true}}))),
 h('div',{id:'keycaps',className:'row'},h(ShortcutKeys,{binding:'Mod+Shift+Backspace',mac:true})),
 h('div',{id:'keycap-examples',className:'row',style:{flexWrap:'wrap'}},
   h(ShortcutKeys,{binding:'Mod+Shift+KeyM',mac:true}),
   h(ShortcutKeys,{binding:'Control+Alt+Mod+Shift+KeyW',mac:true}),
   h(ShortcutKeys,{binding:'Mod+ArrowLeft',mac:true}),
   h(ShortcutKeys,{binding:'Mod+Alt+Shift+KeyM',mac:false})),
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
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  await send('Runtime.enable')
  let ready=false
  for(let i=0;i<240&&!ready;i++){ready=await evaluate('!!window.fixtureReady');if(!ready)await pause(50)}
  assert(ready,'Fixture mounted: '+JSON.stringify(exceptions))

  // The native drawings include stroke paths and small filled details. Inspect
  // actual child strokes so a default override cannot outline a filled detail.
  const gallery=async()=>evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="18"]')).map(svg=>{const box=svg.getBBox();const view=svg.getAttribute('viewBox').split(' ').map(Number);const perUnit=24/view[2];return {name:svg.dataset.sample,family:svg.dataset.iconFamily,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,viewBox:svg.getAttribute('viewBox'),hidden:svg.getAttribute('aria-hidden'),fill:svg.getAttribute('fill'),stroke:svg.getAttribute('stroke'),strokes:[...svg.querySelectorAll('[stroke]')].map(node=>({color:node.getAttribute('stroke'),width:node.getAttribute('stroke-width')})),paths:svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse').length,inkLongSide:Math.max(box.width,box.height)*perUnit,box:JSON.stringify([box.x,box.y,box.width,box.height]),html:svg.outerHTML}})`)
  const rendered=await gallery()
  const assertGallery = (rendered, style) => {
    assert.deepEqual(rendered.map(icon=>icon.name).sort(),expectedNames,'every export renders in '+style)
    for(const icon of rendered){
      const keyboard = keycapNames.includes(icon.name)
      const filled = style === 'square' && !keyboard
      assert.equal(icon.width,18,icon.name+': width')
      assert.equal(icon.height,18,icon.name+': height')
      assert.equal(icon.family,keyboard?'lucide-keycap':filled?'remix':'hugeicons',icon.name+': active family')
      assert.equal(icon.hidden,'true',icon.name+': is decorative by default')
      if(filled){
        assert.equal(icon.viewBox,ICON_VIEW_BOX,icon.name+": preserves Remix's native canvas")
        assert.equal(icon.fill,'currentColor',icon.name+': preserves filled outlines')
        assert.equal(icon.stroke,'none',icon.name+': does not double-outline filled geometry')
      }else{
        assert.equal(icon.viewBox,ICON_VIEW_BOX,icon.name+': preserves the stroke family canvas')
        assert.equal(icon.fill,'none',icon.name+': preserves stroke artwork')
        assert.ok(icon.strokes.length,icon.name+': has stroke artwork')
        for(const stroke of icon.strokes){
          assert.equal(stroke.color,'currentColor',icon.name+': follows the text colour')
          assert.equal(stroke.width,'1.5',icon.name+': draws the family default weight')
        }
      }
      assert(icon.paths>0,icon.name+': draws real geometry')
      assert(icon.inkLongSide>=OPTICAL.min&&icon.inkLongSide<=OPTICAL.max,icon.name+': ink stays inside the family canvas ('+icon.inkLongSide.toFixed(1)+')')
      assert.doesNotMatch(icon.box,/NaN|null/,icon.name+': valid geometry')
      assert.doesNotMatch(icon.html,/NaN|null/,icon.name+': valid attributes')
    }
  }
  assertGallery(rendered,'square')
  assert.equal(await evaluate('window.iconRef.current===document.querySelector("#props-icon")'),true,'forwards the SVG ref')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("aria-hidden")'),null,'a named SVG stays accessible')
  assert.equal(await evaluate('document.querySelector("#css-icon").getBoundingClientRect().width'),16,'Tailwind size overrides the SVG size')
  assert.equal(await evaluate('document.querySelector("#default-icon").getBoundingClientRect().width'),18,'normal UI defaults to 18px')
  for(const size of [16,18,20])assert.equal(await evaluate(`Array.from(document.querySelectorAll('#gallery svg[data-size="${size}"]')).every(svg=>svg.getBoundingClientRect().width===${size}&&svg.getBoundingClientRect().height===${size})`),true,size+'px gallery uses the actual canvas size')
  // Stroke props must not contaminate Remix's filled outline or its native grid.
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),null,'Remix ignores a stroke override')
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("fill")'),'currentColor','Remix retains its native filled outlines')
  const fileGallery=()=>evaluate(`Promise.all(Array.from(document.querySelectorAll('#file-types img')).map(async image=>{await image.decode();return {src:image.getAttribute('src'),width:image.naturalWidth,height:image.naturalHeight,family:image.dataset.fileIconFamily,hidden:image.getAttribute('aria-hidden'),alt:image.alt,variant:image.dataset.fileIconKind,side:image.getBoundingClientRect().width}}))`)
  const fileIcons=await fileGallery()
  assert(fileIcons.every(icon=>/^\.\/file-icons\/pierre-square\/[\w-]+\.svg$/.test(icon.src)),'file icons load square Pierre adaptations from their own public directory')
  assert(fileIcons.every(icon=>icon.width>0&&icon.height>0),'file icon SVGs decode')
  assert(fileIcons.every(icon=>icon.side===(icon.variant==='card'?18:16)),'Pierre trees/tabs are 16px and cards 18px')
  assert(fileIcons.every(icon=>icon.family==='pierre-square'&&icon.hidden==='true'&&icon.alt===''),'square file artwork stays decorative')
  assert.deepEqual(await evaluate(`${JSON.stringify(fileSamples.map(([path])=>path))}.map(path=>window.fileIconName(path))`),fileSamples.map(([,icon])=>icon),'file rows resolve names, language aliases, compound extensions, Windows paths and unknown files')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-attachment-card] [data-file-icon],[data-presented-files] [data-file-icon]')).map(image=>image.getBoundingClientRect().width)`),[18,18],'real attachment/presented file cards use 18px artwork')
  assert.equal(await evaluate(`Promise.all(Array.from(document.querySelectorAll('#app-brands img')).map(async image=>{await image.decode();return image.naturalWidth>0})).then(results=>results.every(Boolean))`),true,'custom Pi/Pith SVG decodes')
  // Style changes are live presentation changes: keep the focused button,
  // editable value and refs, while all ordinary/animated marks change together.
  await evaluate(`window.savedButton=document.querySelector('#props-button');window.savedInput=document.querySelector('input[aria-label="Success example"]');window.savedFileIcons=Array.from(document.querySelectorAll('#file-types img'));window.savedButton.focus()`)
  for(const style of ['squircle','square','squircle']){
    await evaluate(`window.setUiStyle('${style}')`)
    await pause(100)
    const current=await gallery()
    assertGallery(current,style)
    assert.equal(await evaluate('document.activeElement===window.savedButton&&window.savedButton===document.querySelector("#props-button")'),true,style+': switching preserves focus and control identity')
    assert.equal(await evaluate(`window.savedInput===document.querySelector('input[aria-label="Success example"]')&&window.savedInput.value==='Input success'`),true,style+': input stays mounted with its value')
    assert.equal(await evaluate('window.iconRef.current===document.querySelector("#props-icon")'),true,style+': SVG ref follows the active artwork')
    assert.deepEqual(current.filter(icon=>keycapNames.includes(icon.name)),rendered.filter(icon=>keycapNames.includes(icon.name)),style+': keyboard artwork stays stable')
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Success example"]').parentElement.querySelector('svg').dataset.iconFamily`),style==='square'?'remix':'hugeicons',style+': animated marks use the active family')
    const files=await fileGallery()
    assert.equal(await evaluate(`window.savedFileIcons.every((image,index)=>image===document.querySelectorAll('#file-types img')[index])`),true,style+': file rows keep the same image elements during live switching')
    assert(files.every(icon=>icon.family===(style==='square'?'pierre-square':'pierre')&&icon.hidden==='true'&&icon.alt===''),style+': the file family follows the interface preference')
    assert(files.every(icon=>icon.width>0&&icon.height>0&&icon.side===(icon.variant==='card'?18:16)),style+': tree/tab/card artwork decodes at the shared sizes')
    assert.deepEqual(await evaluate(`${JSON.stringify(fileSamples.map(([path])=>path))}.map(path=>window.fileIconName(path,'${style}'))`),fileSamples.map(([,icon])=>icon),style+': filenames, extensions, Windows paths and unknown types use the active associations')
    if(style==='square')assert.deepEqual(files.map(icon=>icon.src),fileIcons.map(icon=>icon.src),'returning to square restores the square Pierre artwork')
    else assert(files.every(icon=>/^\.\/file-icons\/pierre\/[\w-]+\.svg$/.test(icon.src)),'squircle loads the Pierre snapshot')
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-attachment-card] [data-file-icon],[data-presented-files] [data-file-icon]')).map(image=>[image.dataset.fileIconFamily,image.getBoundingClientRect().width])`),[[style==='square'?'pierre-square':'pierre',18],[style==='square'?'pierre-square':'pierre',18]],style+': real attachment/presented cards follow the same family')
    assert.equal(await evaluate(`(()=>{const svg=document.querySelector('#primary-actions [data-app-icon="Ban"]');const path=svg.querySelector('path');return getComputedStyle(path).fill===getComputedStyle(svg.closest('button')).color||getComputedStyle(path).stroke===getComputedStyle(svg.closest('button')).color})()`),true,style+': stop artwork retains the action colour')
  }
  assert.equal(await evaluate('document.querySelector("#props-icon").getAttribute("stroke-width")'),'1.5','Hugeicons still supports absoluteStrokeWidth')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#primary-actions [data-app-icon="Send"],#primary-actions [data-app-icon="Ban"]')).map(svg=>[svg.dataset.appIcon,svg.getBoundingClientRect().width])`),[['Send',20],['Ban',20]],'real primary controls use 20px canvases')
  assert.equal(await evaluate(`document.querySelector('#primary-actions [data-app-icon="Ban"]').closest('button').classList.contains('text-destructive')`),true,'stop retains its error red')
  assert.equal(await evaluate(`(()=>{const svg=document.querySelector('#primary-actions [data-app-icon="Ban"]');return getComputedStyle(svg.querySelector('path')).stroke===getComputedStyle(svg.closest('button')).color})()`),true,'the stop stroke inherits the error red')
  await evaluate(`document.querySelector('#primary-actions [data-app-icon="Ban"]').closest('button').click()`)
  assert.equal(await evaluate('window.stopPressed'),true,'the migrated stop control still acts')
  const keycaps=await evaluate(`Array.from(document.querySelectorAll('#keycaps svg')).map(svg=>({side:svg.getBoundingClientRect().width,family:svg.dataset.iconFamily,stroke:[...svg.querySelectorAll('path')].map(path=>path.getAttribute('stroke-width')||svg.getAttribute('stroke-width'))}))`)
  assert.equal(keycaps.length,3,'command, shift and backspace render as keyboard marks')
  assert(keycaps.every(mark=>mark.side>0&&mark.family==='lucide-keycap'&&mark.stroke.every(width=>width==='2')),'shortcut marks render the vendored Lucide artwork at its native stroke')
  assert.equal(await evaluate('document.querySelectorAll("#keycaps kbd").length'),3,'each shortcut key has its own cap')
  assert.equal(await evaluate('document.querySelector("#keycaps [role=group]").getAttribute("aria-label")'),'Shift+Meta+Backspace','the whole chord retains its accessible label')
  console.log('PASS: all '+expectedNames.length+' UI/keyboard glyphs, 16/18/20px galleries, primary actions, individual keycaps, CSS sizing, refs, accessibility and both corner styles')

  for(const style of ['square','squircle']){
    await evaluate(`window.setUiStyle('${style}');window.controls.setChecked(false);window.controls.setMixed(false)`)
    await pause(250)
    await evaluate('document.querySelector("#checkbox button").click()')
    await pause(style==='square'?30:80)
    const during=await evaluate(style==='square'?'getComputedStyle(document.querySelector("#checkbox svg")).opacity':'document.querySelector("#checkbox svg path").getAttribute("stroke-dasharray")')
    await pause(400)
    assert.equal(await evaluate('document.querySelector("#checkbox button").getAttribute("aria-checked")'),'true',style+': checkbox input works')
    const settled=await evaluate(style==='square'?'getComputedStyle(document.querySelector("#checkbox svg")).opacity':'document.querySelector("#checkbox svg path").getAttribute("stroke-dasharray")')
    assert.notEqual(settled,during,style+': the shared mark animates into view')
    assert.equal(await evaluate('document.querySelector("#checkbox svg").dataset.iconFamily'),style==='square'?'remix':'hugeicons',style+': checkbox uses the active artwork')
    assert.ok((await evaluate('document.querySelector("#checkbox svg path").getAttribute("d")')).length>0,style+': checkbox keeps real geometry')
    await evaluate('window.controls.setMixed(true)');await pause(400)
    assert.equal(await evaluate('document.querySelector("#checkbox button").getAttribute("aria-checked")'),'mixed',style+': mixed state works')
    assert.equal(await evaluate('document.querySelector("#checkbox svg").dataset.appIcon'),'minus',style+': mixed state uses the shared minus')
  }
  await evaluate("window.setUiStyle('square')")
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
  for(const style of ['square','squircle']){
    await evaluate(`window.setUiStyle('${style}')`);await pause(200)
    for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.classList.toggle('dark',${theme==='dark'});document.documentElement.style.colorScheme='${theme}'`)
    await pause(200)
    {
      const sampledColors=await evaluate(`Promise.all(${JSON.stringify(themeColorSamples.map(([path])=>path))}.map(async path=>{const image=Array.from(document.querySelectorAll('#file-types [data-file-icon-kind="tree"]')).find(image=>image.dataset.fileIcon===path);await image.decode();const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const context=canvas.getContext('2d');context.drawImage(image,0,0,16,16);const data=context.getImageData(0,0,16,16).data;const colors=new Set();for(let i=0;i<data.length;i+=4)if(data[i+3]===255)colors.add([data[i],data[i+1],data[i+2]].join(','));return [path,[...colors]]}))`)
      const pixelsByPath=new Map(sampledColors)
      for(const [path,light,dark] of themeColorSamples)assert(pixelsByPath.get(path).includes(theme==='light'?light:dark),theme+': '+path+' inherits the selected Pierre palette')
    }
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-provider-icon]')).backgroundColor===getComputedStyle(document.querySelector('[data-provider-icon]')).color`),true,'Brand inherits theme color')
    if(process.env.PI_ICONS_SCREENSHOT_DIR){
      await mkdir(process.env.PI_ICONS_SCREENSHOT_DIR,{recursive:true})
      const {cssContentSize}=await send('Page.getLayoutMetrics')
      const screenshot=await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}})
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,style+'-'+theme+'.png'),Buffer.from(screenshot.data,'base64'))
      const fileClip=await evaluate(`(()=>{const gallery=document.querySelector('#file-types'),title=gallery.previousElementSibling,cards=gallery.nextElementSibling;const top=title.getBoundingClientRect().top+scrollY,bottom=cards.getBoundingClientRect().bottom+scrollY;return {x:0,y:top-8,width:innerWidth,height:bottom-top+16,scale:1}})()`)
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,style+'-'+theme+'-file-types.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:fileClip})).data,'base64'))
      const additionsClip=await evaluate(`(()=>{const gallery=document.querySelector('#file-additions'),title=gallery.previousElementSibling;const top=title.getBoundingClientRect().top+scrollY,bottom=gallery.getBoundingClientRect().bottom+scrollY;return {x:0,y:top-8,width:innerWidth,height:bottom-top+16,scale:2}})()`)
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,style+'-'+theme+'-file-additions.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:additionsClip})).data,'base64'))
      const keycapClip=await evaluate(`(()=>{const bounds=document.querySelector('#keycap-examples [role=group]').getBoundingClientRect();return {x:bounds.left+scrollX-12,y:bounds.top+scrollY-12,width:bounds.width+24,height:bounds.height+24,scale:2}})()`)
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,style+'-'+theme+'-keycaps.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true,clip:keycapClip})).data,'base64'))
      await evaluate('document.querySelector("#brands").scrollIntoView({block:"end"})')
      await writeFile(join(process.env.PI_ICONS_SCREENSHOT_DIR,style+'-'+theme+'-controls.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'))
      await evaluate('window.scrollTo(0,0)')
    }
  }
  }
  assert.deepEqual(exceptions,[],'No renderer exceptions')
  console.log('PASS: '+loaded.length+' provider aliases, SVG asset decoding, light/dark themes')

  // Load the production assets from a local HTML file just as the packaged
  // renderer does. Every reachable file drawing must decode via relative URLs;
  // licenses must travel with the build, not just exist in the source checkout.
  assert.equal(await readFile(join(repo,'out/renderer/licenses/remix-icons.txt'),'utf8'),await readFile(join(repo,'src/renderer/public/licenses/remix-icons.txt'),'utf8'),'production includes the Remix license')
  const productionIcons=join(repo,'out/renderer/file-icons')
  for(const notice of ['LICENSE.txt','NOTICE.txt'])assert.equal(await readFile(join(productionIcons,notice),'utf8'),await readFile(join(repo,'resources/bearded-icons',notice),'utf8'),notice+': production retains upstream notice')
  for(const notice of ['LICENSE.txt','NOTICE.txt'])assert.equal(await readFile(join(productionIcons,'pierre',notice),'utf8'),await readFile(join(repo,'resources/pierre-icons',notice),'utf8'),notice+': production retains the Pierre notice')
  assert.equal(await readFile(join(productionIcons,'pierre/EXTENSIONS-NOTICE.txt'),'utf8'),await readFile(join(repo,'resources/pierre-icons-extensions/NOTICE.txt'),'utf8'),'production retains attribution for the app additions')
  for(const notice of ['LICENSE.txt','NOTICE.txt','UPSTREAM-NOTICE.txt','EXTENSIONS-NOTICE.txt']) {
    assert.equal(await readFile(join(productionIcons,'pierre-square',notice),'utf8'),await readFile(join(repo,'resources/pierre-icons-square',notice),'utf8'),notice+': production retains square adaptation attribution')
  }
  for(const name of ['astro','biome','browserslist','claude','docker','json','python','react','svelte','svgo','swift']) {
    assert.deepEqual(await readFile(join(productionIcons,'pierre-square',name+'.svg')),await readFile(join(productionIcons,'pierre',name+'.svg')),name+': both styles ship the complete unchanged native drawing')
  }
  const productionKeycaps=join(repo,'out/renderer/lucide-keycaps')
  for(const name of await readdir(join(repo,'src/renderer/public/lucide-keycaps'))){
    assert.deepEqual(await readFile(join(productionKeycaps,name)),await readFile(join(repo,'src/renderer/public/lucide-keycaps',name)),name+': production retains the keyboard SVGs and licenses')
  }
  await cp(productionIcons,join(temporary,'file-icons'),{recursive:true})
  const localFixture=join(temporary,'file-icons.html')
  await writeFile(localFixture,'<!doctype html><html><body></body></html>')
  await send('Page.navigate',{url:pathToFileURL(localFixture).href})
  for(let i=0;i<100;i++){
    if(await evaluate(`location.href===${JSON.stringify(pathToFileURL(localFixture).href)}&&document.readyState==='complete'`))break
    await pause(50)
  }
  const allArtwork=[...fileArtwork,...pierreArtwork.flatMap(name=>['pierre/'+name,'pierre-square/'+name])]
  const decoded=await evaluate(`Promise.all(${JSON.stringify(allArtwork)}.map(async name=>{const image=new Image();image.src='./file-icons/'+name+'.svg';await image.decode();return image.naturalWidth>0&&image.naturalHeight>0}))`)
  assert.equal(decoded.length,allArtwork.length)
  assert(decoded.every(Boolean),'every bundled file SVG decodes from file://')
  console.log('PASS: '+fileArtwork.length+' Bearded and '+pierreArtwork.length+' Pierre file icons per style, live style switching, theme colors, name/extension precedence, generic fallback, packaged file:// URLs and third-party licenses')
} finally {
  ws?.close()
  if(child && child.exitCode === null && child.signalCode === null) await new Promise(resolve=>{
    child.once('exit',resolve);child.kill();setTimeout(resolve,5000).unref()
  })
  await server?.close()
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
