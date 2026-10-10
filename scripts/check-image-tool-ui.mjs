/** Real beUI generation cards, shared preview and file navigation in Electron. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'
import { Resvg } from '@resvg/resvg-js'
const repo=fileURLToPath(new URL('..',import.meta.url))
const temporary=await mkdtemp(join(tmpdir(),'pith-image-ui-'))
const fixturePath='/__image_generation_check.html'
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#425eaa"/><circle cx="640" cy="360" r="180" fill="#d6e2ff"/></svg>').render().asPng().toString('base64')
const portrait=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#425eaa"/><circle cx="384" cy="512" r="180" fill="#d6e2ff"/></svg>').render().asPng().toString('base64')
const fixture=`<!doctype html><html><body><div id="root" class="p-6 max-w-3xl"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {ToolCallView} from '/src/components/app/ToolCallView.tsx';
import {PresentedFiles} from '/src/components/app/PresentedFiles.tsx';
import {ImageReplaysProvider} from '/src/lib/image-replays.tsx';
import {ImagePreviewProvider,ImagePreviewGroup,PreviewThumb} from '/src/components/app/ImagePreview.tsx';
import {UserItem,CustomItem} from '/src/components/app/MessageItems.tsx';
import {Markdown} from '/src/lib/markdown.tsx';
import {FileNotebook} from '/src/components/app/FileNotebook.tsx';
import {FileNavigationProvider} from '/src/lib/file-navigation.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {initReduceMotion,setReduceMotion} from '/src/lib/reduce-motion.ts';
import '/src/styles.css';
const params=new URLSearchParams(location.search);
localStorage.setItem('pi-app:locale',params.get('locale')??'en');
localStorage.setItem('pi-app:reduce-motion',params.get('instant')??'on');initReduceMotion();
document.documentElement.dataset.corners=params.get('style')??'squircle';
document.documentElement.classList.toggle('dark',params.has('dark'));
window.pi={openPath:async path=>{window.__external=path},openExternal:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[]};
const replayListeners=new Set();
let replaySnapshot=JSON.parse(localStorage.getItem('image-replay-fixture')??'null')??{sessionPath:'/fixture/session.jsonl',revision:0,items:[]};
window.__retryCalls=[];
const publishReplay=()=>{localStorage.setItem('image-replay-fixture',JSON.stringify(replaySnapshot));for(const listener of replayListeners)listener(replaySnapshot)};
const updateReplay=item=>{replaySnapshot={...replaySnapshot,revision:replaySnapshot.revision+1,items:[...replaySnapshot.items.filter(value=>value.id!==item.id),item]};publishReplay()};
window.pi.imageReplays=async()=>replaySnapshot;
window.pi.onImageReplays=listener=>{replayListeners.add(listener);return()=>replayListeners.delete(listener)};
window.pi.retryPresentedImage=async request=>{
 window.__retryCalls.push(request);
 if(window.rejectRetry)throw new Error('Fixture retry unavailable');
 const previous=request.restoreId===null?undefined:replaySnapshot.items.find(value=>value.id===request.restoreId);
 const variant=replaySnapshot.items.filter(value=>value.status==='complete').length+2;
 const item={version:1,id:'retry-'+replaySnapshot.revision,generationId:request.generationId,sourcePath:request.path,restoreId:request.restoreId,status:'queued',startedAt:Date.now(),previousResult:previous?.status==='complete'&&previous.result?.files.length?previous.result:previous?.previousResult};
 updateReplay(item);
 await new Promise(resolve=>{window.startReplay=()=>updateReplay({...item,status:'generating'});
 window.finishReplay=()=>{updateReplay({...item,status:'complete',endedAt:Date.now(),result:{kind:'pi-app-image',action:'generate',model:'fixture/image',protocol:'chat',prompt:'A blue circle on a blue background',files:[{path:'/fixture/blue-circle-'+variant+'.png',mimeType:'image/png',size:2510,width:1280,height:720}],usage:{inputTokens:10,outputTokens:0,totalTokens:10,costUsd:0.009}}});resolve()};
 window.cancelReplay=()=>{updateReplay({...item,status:'error',cancelled:true,endedAt:Date.now(),error:'Fixture retry cancelled'});resolve()};
 window.failReplay=()=>{updateReplay({...item,status:'error',endedAt:Date.now(),error:'Fixture retry generation failure',result:{kind:'pi-app-image',action:'generate',model:'fixture/image',protocol:'chat',prompt:'A blue circle on a blue background',files:[],error:'Fixture retry generation failure',usage:{inputTokens:10,outputTokens:0,totalTokens:10,costUsd:0.003}}});resolve()};
 });
};
window.pi.cancelImageReplay=async(sessionPath,id)=>{window.__cancelCall={sessionPath,id};window.cancelReplay()};
const root=createRoot(document.getElementById('root'));
const image={type:'image',data:${JSON.stringify(png)},mimeType:'image/png'};
const portraitImage={...image,data:${JSON.stringify(portrait)}};
let props;
window.show=(state='running',prompt='A blue circle on a blue background',n)=>{
 const active=state==='running'||state==='queued';
 const files=state==='error'||active?[]:[{path:'/fixture/generated.png',mimeType:'image/png',size:2401,width:1280,height:720}];
 if(state==='portrait')Object.assign(files[0],{path:'/fixture/elderly_sailor_fishing_boat.png',width:768,height:1024});
 if(state==='multi'||state==='partial'||state==='many')files.push({...files[0],path:'/fixture/second image.png',size:16512,width:768,height:1024});
 if(state==='many')for(let index=2;index<5;index++)files.push({...files[0],path:'/fixture/generated-'+index+'.png'});
 const content=state==='broken'?[{...image,data:'bm90LWFuLWltYWdl'}]:files.map(file=>file.width===768?portraitImage:image);
 const failed=state==='error'||state==='partial';
 props={call:{id:'image-call',type:'toolCall',name:'image',arguments:{action:'generate',prompt,model:'fixture/image',aspect_ratio:'16:9',...(n===undefined?{}:{n})}},
 run:{status:active?'running':failed?'error':'success',startedAt:state==='queued'?undefined:Date.now(),endedAt:active?undefined:Date.now()+1500}};
 if(!active)props.result={role:'toolResult',toolName:'image',toolCallId:'image-call',timestamp:Date.now(),isError:failed,content:[{type:'text',text:'upstream diagnostic'},...content],details:{kind:'pi-app-image',action:'generate',model:'fixture/image',protocol:'chat',prompt,files,ignoredParameters:['background'],usage:{inputTokens:10,outputTokens:0,totalTokens:10,costUsd:0.014},...(failed?{error:'Fixture provider failure'}:{})}};
 flushSync(()=>root.render(React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement(FileNavigationProvider,{cwd:'/fixture',openFile:target=>window.__opened=target.path},React.createElement(ToolCallView,{...props,cwd:'/fixture'}))))));
};
window.setInstant=value=>flushSync(()=>setReduceMotion(value));
window.showPresent=(ordinary=false,footer=true,disabled=false,separate=false,renamed=false)=>{
 window.show('multi');
 const generation={id:'image-call',result:props.result.details,aspectRatio:'16:9'};
 const files=props.result.details.files.map((file,index)=>({path:file.path,size:file.size,...(ordinary?{}:{generation:separate?{...generation,id:'generation-'+index,result:{...generation.result,prompt:'Unique prompt '+index}}:generation})}));
 if(renamed)for(const [index,file] of files.entries()){
   const path='/fixture/renamed-'+index+'.png';file.path=path;
   file.generation={...generation,result:{...generation.result,files:generation.result.files.map((image,i)=>i===index?{...image,path}:image)}};
 }
 const content=footer?React.createElement(PresentedFiles,{files}):React.createElement(ToolCallView,{call:{type:'toolCall',id:'present-call',name:'present',arguments:{files:files.map(file=>({path:file.path}))}},result:{role:'toolResult',toolName:'present',toolCallId:'present-call',content:[{type:'text',text:'Presented files'}],isError:false,timestamp:Date.now(),details:{kind:'pith-present-v1',files}},cwd:'/fixture'});
 flushSync(()=>root.render(React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement(FileNavigationProvider,{cwd:'/fixture',openFile:target=>window.__opened=target.path},React.createElement(ImageReplaysProvider,{sessionPath:'/fixture/session.jsonl',disabled},content))))));
};
window.showCollections=()=>{
 const h=React.createElement;
 window.pi.readFile=path=>path.endsWith('/fast.png')?Promise.resolve({path,base64:${JSON.stringify(png)},mimeType:'image/png'}):new Promise(resolve=>{window.resolveMarkdown=()=>resolve({path,base64:${JSON.stringify(portrait)},mimeType:'image/png'})});
 const user=timestamp=>h(UserItem,{message:{role:'user',timestamp,content:[image,portraitImage]}});
 const notebook=JSON.stringify({cells:[{cell_type:'code',source:'',outputs:[{data:{'image/png':image.data}},{data:{'image/png':portraitImage.data}}]}]});
 function Reorder(){const [reverse,setReverse]=React.useState(false);window.reorder=()=>setReverse(value=>!value);
  return h(ImagePreviewGroup,null,(reverse?['B','A']:['A','B']).map(name=>h(PreviewThumb,{key:name,src:'data:image/png;base64,'+image.data,alt:name})));}
 flushSync(()=>root.render(h(React.StrictMode,null,h(I18nProvider,null,h(ImagePreviewProvider,null,
  h(FileNavigationProvider,{cwd:'/fixture',openFile:()=>{}},
   h('div',{id:'user-group'},user(1)),h('div',{id:'other-user'},user(2)),
   h('div',{id:'custom-group'},h(CustomItem,{message:{role:'custom',customType:'fixture',content:[image,portraitImage],timestamp:3}})),
   h('div',{id:'tool-group'},h(ToolCallView,{call:{type:'toolCall',id:'read',name:'read',arguments:{path:'/fixture/a.png'}},result:{role:'toolResult',toolCallId:'read',toolName:'read',isError:false,content:[image,portraitImage],timestamp:4}})),
   h('div',{id:'markdown-group'},h(Markdown,null,'![First](slow.png)\\n\\n![Second](fast.png)')),
   h('div',{id:'notebook-group'},h(FileNotebook,{text:notebook,truncated:false,tab:{cwd:'/fixture',path:'/fixture/book.ipynb'},store:{open:()=>{}}})),
   h('div',{id:'duplicate-group'},h(Reorder)),h('div',{id:'single-image'},h(PreviewThumb,{src:'data:image/png;base64,'+image.data,alt:'Standalone'}))))))));
};
window.show();window.fixtureReady=true;
</script></body></html>`
let child, ws, server
try {
  server = await createServer({
    configFile: false,
    root: join(repo, 'src/renderer'),
    logLevel: 'error',
    cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [
      react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }),
      tailwindcss(),
      {
        name: 'rhythm-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== fixturePath) return next()
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) {
              next(error)
            }
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow,protocol}=require('electron');
protocol.registerSchemesAsPrivileged([{scheme:'pith-media',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{protocol.handle('pith-media',request=>new Response(Buffer.from(decodeURIComponent(request.url).includes('second image')?${JSON.stringify(portrait)}:${JSON.stringify(png)},'base64'),{headers:{'content-type':'image/png'}}));const w=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  const exceptions = []
  // Electron's own sandboxed-renderer bundle complains about missing preload
  // startup data in a window that has none; that is not our page.
  const ELECTRON_NOISE = /sandboxed_renderer\.bundle\.js|binding\.startupData/
  let sequence = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (m) => (m.error ? reject(m.error) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const load = async (query) => {
    await send('Page.navigate', { url: origin + (query ?? '') })
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.fixtureReady && !!document.querySelector("[data-image-result]")')) return
      await pause(50)
    }
    throw new Error(
      'Fixture did not mount: ' +
        JSON.stringify({
          ready: await evaluate('!!window.fixtureReady'),
          body: await evaluate('document.body.innerText.slice(0, 200)'),
          exceptions: exceptions.slice(0, 2).map((entry) => entry.exception?.description ?? entry.console ?? String(entry))
        })
    )
  }
  const screenshot = async (name) => {
    if (!process.env.PI_IMAGE_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_IMAGE_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_IMAGE_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  const cardBounds = () => evaluate(`[...document.querySelectorAll('[data-slot=image-generation]')].map(card=>{
    const {left,right,top,bottom}=card.getBoundingClientRect();return {left,right,top,bottom};
  })`)
  const closeInfo = async () => {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await pause(180)
  }
  const openInfo = async (index=0) => {
    if(await evaluate("!!document.querySelector('[data-image-information]')"))await closeInfo()
    await evaluate(`[...document.querySelectorAll('[data-image-actions] button[aria-haspopup=dialog]')][${index}].click()`)
    await pause(200)
    assert.equal(await evaluate("document.querySelectorAll('[data-image-information]').length"),1,'one complete information panel opens on request')
  }
  const assertPure = async () => {
    assert.equal(await evaluate("document.querySelectorAll('[data-image-information],[data-image-prompt],[data-slot=image-generation-details]').length"),0,'default results contain only images and their floating actions')
    const cards=await evaluate(`[...document.querySelectorAll('[data-slot=image-generation]')].map(card=>{
      const media=card.querySelector('[role=group]').getBoundingClientRect(),frame=card.getBoundingClientRect();
      return {same:Math.abs(frame.height-media.height)<1,overflow:card.scrollWidth>card.clientWidth};
    })`)
    assert(cards.length&&cards.every(card=>card.same&&!card.overflow),'hidden information never reserves layout space')
  }
  const retryButtons=()=>evaluate("[...document.querySelectorAll('[data-image-actions] button')].filter(button=>button.getAttribute('aria-label')?.startsWith('Retry ')).map(button=>({label:button.getAttribute('aria-label'),disabled:button.disabled}))")
  const clickRetry=()=>evaluate("[...document.querySelectorAll('[data-image-actions] button')].find(button=>button.getAttribute('aria-label')?.startsWith('Retry ')).click()")
  const previousImage=async()=>{await evaluate("document.querySelector('[data-image-tile]').querySelectorAll('[data-image-history-actions] button')[0].click()");await pause(100)}
  const nextImage=async()=>{await evaluate("document.querySelector('[data-image-tile]').querySelectorAll('[data-image-history-actions] button')[1].click()");await pause(100)}
  const currentFile=()=>evaluate("document.querySelector('[data-image-tile]').dataset.imageFile")
  const historyButtons=()=>evaluate("[...document.querySelector('[data-image-tile]').querySelectorAll('[data-image-history-actions] button')].map(button=>({disabled:button.disabled,label:button.getAttribute('aria-label')}))")
  const press = async key => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key })
    await pause(100)
  }
  const preview = () => evaluate(`(()=>{const dialog=document.querySelector('[role=dialog][aria-modal=true]');return {
    label:dialog?.getAttribute('aria-label'),src:dialog?.querySelector('img')?.getAttribute('src'),
    position:dialog?.querySelector('[data-image-preview-navigation] span[aria-live]')?.textContent,
    disabled:[...dialog?.querySelectorAll('[data-image-preview-navigation] button')??[]].map(button=>button.disabled),
    zoom:dialog?.querySelector('button[aria-label="Reset zoom"]')?.textContent,
    focus:dialog?.contains(document.activeElement)};})()`)
  const openPreview = async (selector, index = 0) => {
    await evaluate(`(()=>{const node=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!node)throw new Error('Missing preview image: '+${JSON.stringify(selector)}+' at '+${index});const button=node.closest('button')??node;button.focus({preventScroll:true});button.click()})()`)
    await pause(200)
  }
  await load('')
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation]').length"),1,'omitting n reserves one image')
  assert.equal(await evaluate("document.querySelector('[data-slot=image-generation]').dataset.state"),'generating')
  assert.equal(await evaluate("document.querySelector('[data-slot=image-generation]').getAttribute('aria-busy')"),'true')
  await assertPure()
  const canvas=()=>evaluate("document.querySelector('canvas')?.toDataURL()")
  await pause(250);const still=await canvas();await pause(100);assert.equal(await canvas(),still,'app reduced motion stops dither')
  await openInfo()
  assert((await evaluate('document.body.innerText')).includes('Generating image'))
  assert(!(await evaluate('document.body.innerText')).includes('1024'),'pending information never invents dimensions')
  await closeInfo()
  for(const n of [2,5,10]) {
    await evaluate(`window.show('running',undefined,${n})`);await pause(100)
    assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation][data-state=generating][aria-busy=true]').length"),n,`n=${n} reserves exactly n images`)
    assert.equal(await evaluate("document.querySelectorAll('[data-image-result] img').length"),0,'pending images have no invented outputs')
    await assertPure()
    if(n===5) {
      const cards=await cardBounds()
      assert(cards[1].left>cards[0].left&&cards.some(card=>card.top>cards[0].top),'pending images arrange horizontally and wrap')
      await screenshot('image-generating-multi')
    }
  }
  await evaluate("window.show('queued',undefined,3)");await pause(100)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation][data-state=queued]').length"),3)
  await evaluate("window.show('running',undefined,1000000000)");await pause(100)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation]').length"),1,'historical counts remain bounded')
  await evaluate("window.show('complete',undefined,3)");await pause(100)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation]').length"),1,'settled requests show actual outputs only')
  await evaluate("window.show('multi')");await pause(250)
  await assertPure()
  const wideCards=await cardBounds()
  assert(Math.abs(wideCards[0].top-wideCards[1].top)<1&&wideCards[1].left>=wideCards[0].right,'wide content places images side by side')
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-result] img')).objectFit"),'contain')
  const hover=await evaluate(`(()=>{const tile=document.querySelector('[data-image-tile]'),r=tile.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,opacity:getComputedStyle(tile.querySelector('[data-image-actions]')).opacity};})()`)
  assert.equal(hover.opacity,'0','floating controls stay hidden at rest')
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:hover.x,y:hover.y});await pause(100)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-actions]')).opacity"),'1','hover reveals floating controls')
  await screenshot('image-complete')
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await pause(100)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-actions]')).opacity"),'0','leaving the image hides controls')
  await evaluate("document.querySelector('[data-image-actions] button').focus()")
  await pause(80)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-actions]')).opacity"),'1','keyboard focus also exposes controls')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(200)
  assert.equal(await evaluate("document.querySelectorAll('[data-image-information]').length"),1,'keyboard activation opens information')
  const text=await evaluate("document.querySelector('[data-image-information]').innerText")
  for(const value of ['generated.png','/fixture/generated.png','1280 × 720','2.3 KB','image/png','A blue circle on a blue background','fixture/image','$0.0140','background'])assert(text.includes(value),value)
  assert.equal(text.match(/A blue circle on a blue background/g)?.length,1,'shared batch prompt appears once in information')
  assert.equal(text.match(/\$0\.0140/g)?.length,1,'batch billing appears once')
  assert.equal(await evaluate("document.querySelectorAll('[data-image-warning]').length"),1)
  await screenshot('image-information')
  const fileAction=await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-image-information] button')].find(button=>button.innerText==='generated.png');
    const style=getComputedStyle(button);return {underline:getComputedStyle(button.querySelector('span')).textDecorationLine,background:style.backgroundColor,border:parseFloat(style.borderTopWidth)};})()`)
  assert(fileAction.underline.includes('underline'));assert.equal(fileAction.background,'rgba(0, 0, 0, 0)');assert.equal(fileAction.border,0)
  await evaluate("[...document.querySelectorAll('[data-image-information] button')].find(button=>button.innerText==='generated.png').click()");await pause(180)
  assert.equal(await evaluate('window.__opened'),'/fixture/generated.png')
  await assertPure()
  await openInfo(1)
  const other=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(other.includes('second image.png')&&other.includes('768 × 1024')&&other.includes('16.1 KB'),'each image exposes its own receipt')
  await closeInfo()
  await evaluate("document.querySelector('[data-image-result] img').closest('button').click()");await pause(250)
  assert.equal(await evaluate("document.querySelector('[role=dialog] img')?.naturalWidth"),1280)
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button=>button.innerText==='Open file').click()")
  assert.equal(await evaluate('window.__external'),'/fixture/generated.png')
  await press('+');assert.equal((await preview()).zoom,'160%')
  await press('ArrowRight')
  assert.equal((await preview()).label,'second image.png')
  assert.equal((await preview()).position,'2/2')
  assert.equal((await preview()).zoom,'100%','switching an image resets zoom while retaining the modal')
  assert((await preview()).focus,'keyboard navigation keeps focus inside the viewer')
  await screenshot('image-preview-group')
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button=>button.innerText==='Open file').click()")
  assert.equal(await evaluate('window.__external'),'/fixture/second image.png','file actions follow the selected group image')
  await press('ArrowRight');assert.equal((await preview()).label,'second image.png','the final image never crosses into another group')
  await press('ArrowLeft');assert.equal((await preview()).label,'generated.png')
  await closeInfo()
  await evaluate("window.__imageNodes=[...document.querySelectorAll('[data-image-result] img')];document.getElementById('root').style.width='340px'");await pause(150)
  const narrow=await cardBounds()
  assert(narrow[1].top>=narrow[0].bottom&&Math.abs(narrow[0].left-narrow[1].left)<1,'narrow content stacks images')
  assert(await evaluate("[...document.querySelectorAll('[data-image-result] img')].every((image,index)=>image===window.__imageNodes[index])"),'resizing retains media nodes')
  await assertPure();await screenshot('image-multi-narrow-content')
  await evaluate("document.getElementById('root').style.width='';window.show('many')");await pause(150)
  const wrapped=await cardBounds()
  assert.equal(wrapped.length,5);assert(wrapped[1].left>wrapped[0].left&&wrapped.some(card=>card.top>wrapped[0].top),'larger batches use horizontal rows and wrapping')
  await assertPure();await screenshot('image-multi-wrapped')
  const longPrompt=Array.from({length:24},(_,index)=>`Scene ${index+1}: keep the full composition, lighting, colors and texture details.`).join('\n')+'\n'+'texture'.repeat(70)+'\nEnd of the complete prompt.'
  await evaluate(`window.show('multi',${JSON.stringify(longPrompt)})`);await pause(150)
  const beforeInfo=await cardBounds()
  await assertPure();await openInfo()
  assert.equal(await evaluate("document.querySelector('[data-image-prompt]').textContent"),longPrompt,'information retains the complete prompt and all line breaks')
  assert.deepEqual(await cardBounds(),beforeInfo,'opening information never changes gallery layout')
  const info=await evaluate(`(()=>{const node=document.querySelector('[data-image-information]'),r=node.getBoundingClientRect();return {height:r.height,max:innerHeight-32,scroll:node.scrollHeight>node.clientHeight,overflow:node.scrollWidth>node.clientWidth};})()`)
  assert(info.height<=info.max+1&&info.scroll&&!info.overflow,'long information is bounded, vertically scrollable and wraps words')
  await screenshot('image-long-prompt')
  await evaluate("document.querySelector('[data-image-information]').focus()")
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35})
  const atEnd=()=>evaluate("(()=>{const node=document.querySelector('[data-image-information]');return node.scrollTop>0&&node.scrollTop+node.clientHeight>=node.scrollHeight-1})()")
  for(let attempt=0;attempt<20&&!await atEnd();attempt++)await pause(50)
  assert(await atEnd(),'keyboard can reach the complete information ending: '+JSON.stringify(await evaluate("(()=>{const node=document.querySelector('[data-image-information]');return {top:node.scrollTop,height:node.clientHeight,total:node.scrollHeight,focus:document.activeElement===node}})()")))
  await screenshot('image-long-prompt-end');await closeInfo()
  assert(await evaluate("document.activeElement.matches('[data-image-actions] button[aria-haspopup=dialog]')"),'Escape restores focus to Information')
  await evaluate("window.show('partial',undefined,5)");await pause(250)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation]').length"),2,'partial failure retains actual saved images')
  await openInfo();assert((await evaluate('document.body.innerText')).includes('Fixture provider failure'));await closeInfo()
  await evaluate("window.show('error',undefined,5)");await pause(250)
  assert.equal(await evaluate("document.querySelector('[data-slot=image-generation]').dataset.state"),'error')
  await openInfo();assert((await evaluate('document.body.innerText')).includes('$0.0140'));await closeInfo()
  await load('?locale=zh-TW&dark=1');await evaluate("window.show('complete')");await pause(150)
  await assertPure();await openInfo()
  assert((await evaluate('document.body.innerText')).includes('圖片已產生')&&(await evaluate('document.body.innerText')).includes('費用'))
  await screenshot('image-complete-zh-TW');await closeInfo()
  await evaluate("window.show('portrait')");await pause(150);await assertPure();await screenshot('image-portrait')
  await evaluate("window.show('broken')");await pause(200)
  assert.equal(await evaluate("document.querySelectorAll('[data-image-result] button.cursor-zoom-in img').length"),0)
  await openInfo();assert((await evaluate('document.body.innerText')).includes('generated.png'));await closeInfo()
  await load('');await evaluate("window.show('multi')");await pause(200)
  const shape=()=>evaluate(`[...document.querySelectorAll('[data-slot=image-generation]')].map(card=>{const media=card.querySelector('[role=group]');return {width:media.getBoundingClientRect().width,height:media.getBoundingClientRect().height,ratio:getComputedStyle(media).aspectRatio};})`)
  const generationShape=await shape()
  await evaluate('window.showPresent(false,false)');await pause(200)
  assert.equal(await evaluate("document.querySelectorAll('[data-image-result]').length"),0,'present tool disclosure keeps its original result')
  await evaluate("const trigger=document.querySelector('[data-agent-trigger]');if(trigger.getAttribute('aria-expanded')!=='true')trigger.click()");await pause(150)
  assert((await evaluate('document.body.innerText')).includes('Presented files'),'expanded present keeps its original tool prose')
  await evaluate('window.showPresent()');await pause(200)
  assert.equal(await evaluate("document.querySelectorAll('[data-presented-generation] [data-slot=image-generation]').length"),2)
  assert.deepEqual(await shape(),generationShape,'bottom delivery shares the generation media geometry')
  await assertPure()
  assert.equal((await retryButtons()).length,2,'each delivered image has a floating retry action')
  await evaluate('window.showPresent(false,true,false,false,true)');await pause(150)
  assert.equal(await evaluate("document.querySelectorAll('[data-presented-generation] [data-slot=image-generation]').length"),2,'a recovered batch uses each delivery’s renamed image metadata')
  await openInfo();assert((await evaluate("document.querySelector('[data-image-information]').innerText")).includes('/fixture/renamed-0.png'));await closeInfo()
  await evaluate('window.showPresent(false,true,false,true)');await pause(150)
  const separate=await cardBounds()
  assert(Math.abs(separate[0].top-separate[1].top)<1&&separate[1].left>separate[0].left,'different prompts and generation records do not force vertical layout')
  await screenshot('present-images-separate-prompts')
  await openPreview('[data-image-result] img',0)
  await press('ArrowRight')
  assert.equal((await preview()).label,'second image.png','one delivery group spans its separate generation records')
  await closeInfo()
  await evaluate('window.showPresent()');await pause(150)
  await clickRetry();await pause(150)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation][data-state=queued][aria-busy=true]').length"),1)
  assert.equal(await evaluate('window.__retryCalls.length'),1)
  assert.deepEqual(await evaluate('window.__retryCalls[0]'),{sessionPath:'/fixture/session.jsonl',generationId:'image-call',path:'/fixture/generated.png',restoreId:null},'renderer submits identity and selected history only')
  assert((await retryButtons()).every(button=>button.disabled),'duplicate retries remain disabled')
  await openInfo()
  const queuedInformation=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(queuedInformation.includes('Waiting to generate')&&queuedInformation.includes('A blue circle on a blue background'))
  assert(!queuedInformation.includes('.png')&&!queuedInformation.includes('$')&&!queuedInformation.includes('image/png'))
  await closeInfo()
  await evaluate('window.startReplay()');await pause(150)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation][data-state=generating][aria-busy=true]').length"),1)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation][data-state=complete]').length"),1)
  assert(await evaluate("[...document.querySelectorAll('[data-image-actions] button')].some(button=>button.getAttribute('aria-label')==='Cancel retry'&&!button.disabled)"),'waiting image has a working cancel action')
  await assertPure();await screenshot('present-image-retry-generating')
  await openInfo()
  const waitingInformation=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(waitingInformation.includes('Generating image')&&waitingInformation.includes('A blue circle on a blue background'))
  for(const value of ['generated.png','/fixture/','1280','720','KB','image/png','fixture/image','$','background.'])assert(!waitingInformation.includes(value),`waiting information omits the old receipt: ${value}`)
  assert(await evaluate("document.querySelector('[data-image-tile]').querySelector('img') === null"),'waiting media contains no stale preview')
  await screenshot('present-image-retry-information');await closeInfo()
  await evaluate('window.finishReplay()');await pause(250)
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').dataset.imageFile"),'/fixture/blue-circle-2.png')
  assert((await retryButtons()).every(button=>!button.disabled))
  await openInfo();assert((await evaluate('document.body.innerText')).includes('Retry cost $0.0090'));await closeInfo()
  await screenshot('present-image-retry-complete')
  assert.deepEqual(await historyButtons(),[{disabled:false,label:'Previous image'},{disabled:true,label:'Next image'}])
  await evaluate('document.activeElement.blur()');await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await pause(100)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-actions]')).opacity"),'0','the entire history toolbar is hidden at rest')
  const hoverHistory=await evaluate("(()=>{const r=document.querySelector('[data-image-tile]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverHistory});await pause(100)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-image-actions]')).opacity"),'1')
  assert(await evaluate("(()=>{const tile=document.querySelector('[data-image-tile]'),bar=tile.querySelector('[data-image-actions]'),r=bar.getBoundingClientRect(),m=tile.getBoundingClientRect();return bar.contains(tile.querySelector('[data-image-history-actions]'))&&bar.contains(tile.querySelector('[data-image-history-position]'))&&r.top>=m.top&&r.top<m.top+16&&r.right<=m.right&&r.left>=m.left})()"),'arrows, position and actions share one toolbar inside the top of the image')
  await screenshot('present-image-history-toolbar')
  await previousImage();assert.equal(await currentFile(),'/fixture/generated.png','the original stays accessible beside its retry')
  assert.deepEqual(await historyButtons(),[{disabled:true,label:'Previous image'},{disabled:false,label:'Next image'}])
  await openInfo()
  const originalInformation=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(originalInformation.includes('generated.png')&&originalInformation.includes('$0.0140')&&!originalInformation.includes('$0.0090'),'information follows the selected original')
  await closeInfo();await nextImage();assert.equal(await currentFile(),'/fixture/blue-circle-2.png')
  await clickRetry();await pause(100)
  await openPreview('[data-image-result] img')
  assert.equal((await preview()).label,'second image.png')
  assert.equal((await preview()).position,'3/3','unfinished retries add no navigable image')
  await evaluate('window.finishReplay()');await pause(150)
  assert.equal((await preview()).label,'second image.png','an arriving retry does not change the selected image')
  assert.equal((await preview()).position,'4/4','successful retries update an already open group')
  await press('ArrowLeft');assert.equal((await preview()).label,'blue-circle-3.png')
  await press('ArrowLeft');assert.equal((await preview()).label,'blue-circle-2.png')
  await press('ArrowLeft');assert.equal((await preview()).label,'generated.png')
  await press('ArrowLeft');assert.equal((await preview()).label,'generated.png')
  assert.deepEqual((await preview()).disabled,[true,false])
  await closeInfo()
  assert.equal(await currentFile(),'/fixture/blue-circle-3.png','repeated retries append distinct variants')
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').dataset.imageHistoryCount"),'3')
  assert.equal(await evaluate("document.querySelectorAll('[data-image-history-actions]').length"),1,'history belongs only to the retried image in a batch')
  await previousImage();assert.equal(await currentFile(),'/fixture/blue-circle-2.png')
  await previousImage();assert.equal(await currentFile(),'/fixture/generated.png')
  await nextImage();await nextImage();assert.equal(await currentFile(),'/fixture/blue-circle-3.png')
  await load('');await evaluate('window.showPresent()');await pause(200)
  assert.equal(await currentFile(),'/fixture/blue-circle-3.png','cold UI restores the latest successful variant')
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').dataset.imageHistoryCount"),'3','cold UI retains every older variant')
  await evaluate('window.rejectRetry=true');await clickRetry();await pause(150)
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').hasAttribute('data-image-file')"),false,'a rejected retry shows no old image')
  assert(await evaluate("document.querySelector('[data-image-tile]').querySelector('img') === null"))
  assert((await evaluate("document.querySelector('[data-image-retry-error]').innerText")).includes('Fixture retry unavailable'))
  await openInfo();assert((await evaluate('document.body.innerText')).includes('Fixture retry unavailable'));await closeInfo()
  await evaluate('window.rejectRetry=false');await clickRetry();await pause(150)
  await evaluate("[...document.querySelectorAll('[data-image-actions] button')].find(button=>button.getAttribute('aria-label')==='Cancel retry').click()");await pause(150)
  assert.equal(await currentFile(),'/fixture/blue-circle-3.png','manual stop restores its last successful preview')
  assert(await evaluate("document.querySelector('[data-image-retry-error]') === null"))
  await openInfo();assert((await evaluate('document.body.innerText')).includes('Retry stopped. The previous image is restored.'));await closeInfo()
  await load('');await evaluate('window.showPresent()');await pause(200)
  assert.equal(await currentFile(),'/fixture/blue-circle-3.png','stopped retry restores the prior image after reload')
  await clickRetry();await evaluate('window.startReplay()');await pause(150)
  await openInfo()
  const laterWaitingInformation=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(!laterWaitingInformation.includes('blue-circle')&&!laterWaitingInformation.includes('$0.0090'),'waiting never leaks the previous successful retry receipt')
  await closeInfo();await evaluate('window.failReplay()');await pause(150)
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').hasAttribute('data-image-file')"),false)
  assert(await evaluate("document.querySelector('[data-image-tile]').querySelector('img') === null"),'a failed generation renders an empty image surface')
  assert.equal(await evaluate("document.querySelector('[data-slot=image-generation]').dataset.state"),'error')
  assert((await evaluate("document.querySelector('[data-image-retry-error]').innerText")).includes('Fixture retry generation failure'))
  await screenshot('present-image-retry-failed');await openInfo()
  const failedInformation=await evaluate("document.querySelector('[data-image-information]').innerText")
  assert(failedInformation.includes('Fixture retry generation failure')&&failedInformation.includes('$0.0030'))
  assert(!failedInformation.includes('.png')&&!failedInformation.includes('$0.0090')&&!failedInformation.includes('$0.0140'),'failure information only describes the failed attempt')
  await screenshot('present-image-retry-failed-information');await closeInfo()
  await load('');await evaluate('window.showPresent()');await pause(200)
  assert(await evaluate("document.querySelector('[data-image-tile]').querySelector('img') === null"),'failure remains empty after reload')
  assert((await evaluate("document.querySelector('[data-image-retry-error]').innerText")).includes('Fixture retry generation failure'))
  await openPreview('[data-image-result] img')
  assert.equal((await preview()).position,'4/4','cold groups retain successful versions and omit errors/cancellations')
  await press('ArrowLeft');assert.equal((await preview()).label,'blue-circle-3.png')
  await closeInfo()
  await clickRetry();await pause(150)
  await evaluate("[...document.querySelectorAll('[data-image-actions] button')].find(button=>button.getAttribute('aria-label')==='Cancel retry').click()");await pause(150)
  assert.equal(await currentFile(),'/fixture/blue-circle-3.png','cancellation after a failure still restores the last successful image')
  await previousImage()
  assert(await evaluate("document.querySelector('[data-image-tile]').querySelector('img') === null"),'failed attempts remain browsable in history')
  await openInfo();assert((await evaluate("document.querySelector('[data-image-information]').innerText")).includes('Fixture retry generation failure'));await closeInfo()
  while(!(await historyButtons())[0].disabled)await previousImage()
  assert.equal(await currentFile(),'/fixture/generated.png')
  await clickRetry();await pause(100)
  assert.equal(await evaluate('window.__retryCalls.at(-1).restoreId'),null,'retrying the selected original keeps its cancellation identity')
  await previousImage()
  assert(await evaluate("[...document.querySelectorAll('[data-image-actions] button')].some(button=>button.getAttribute('aria-label')==='Cancel retry')"),'browsing older images during generation retains cancellation')
  await evaluate("[...document.querySelectorAll('[data-image-actions] button')].find(button=>button.getAttribute('aria-label')==='Cancel retry').click()");await pause(100)
  assert.equal(await currentFile(),'/fixture/generated.png','stopping while browsing still restores the image selected before retry')
  await load('');await evaluate('window.showPresent()');await pause(200)
  assert.equal(await currentFile(),'/fixture/generated.png','stopping a retry of the original restores the original after reload')
  assert.equal(await evaluate("document.querySelector('[data-image-tile]').dataset.imageHistoryCount"),'7','successes, failures and cancellations all remain recorded')
  while(!(await historyButtons())[0].disabled)await previousImage()
  await nextImage();assert.equal(await currentFile(),'/fixture/blue-circle-2.png')
  const selectedOlderId=await evaluate("document.querySelector('[data-image-tile]').dataset.imageVersion")
  await clickRetry();await pause(100)
  assert.equal(await evaluate('window.__retryCalls.at(-1).restoreId'),selectedOlderId)
  await evaluate("[...document.querySelectorAll('[data-image-actions] button')].find(button=>button.getAttribute('aria-label')==='Cancel retry').click()");await pause(100)
  assert.equal(await currentFile(),'/fixture/blue-circle-2.png','stopping restores the selected older successful image')
  await evaluate('window.showPresent(true)');await pause(150)
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=image-generation]').length"),0)
  assert.equal(await evaluate("document.querySelectorAll('[data-presented-file]').length"),2,'ordinary image file cards remain unchanged')
  await evaluate('window.showPresent(false,true,true)');await pause(150)
  assert((await retryButtons()).every(button=>button.disabled),'read-only views refuse retries')
  await load('?locale=zh-TW');await evaluate('window.showPresent()');await pause(150)
  assert(await evaluate("[...document.querySelectorAll('[data-image-actions] button')].some(button=>button.getAttribute('aria-label')?.startsWith('重新生成'))"))
  await load('?locale=zh-CN&instant=off');await evaluate('window.setInstant(false)')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await pause(300)
  const nativeStill=await canvas();await pause(100);assert.equal(await canvas(),nativeStill,'OS reduced motion stops dither')
  await send('Emulation.setDeviceMetricsOverride',{width:340,height:700,deviceScaleFactor:1,mobile:false});await pause(150)
  await evaluate("window.show('running',undefined,3)");await pause(150)
  const narrowPending=await cardBounds()
  assert(narrowPending.every((card,index)=>!index||card.top>=narrowPending[index-1].bottom),'narrow panes stack all placeholders')
  await assertPure();await screenshot('image-generating-narrow')
  await evaluate("window.show('portrait')");await pause(150);await assertPure();await screenshot('image-portrait-narrow')
  await openInfo();assert((await evaluate('document.body.innerText')).includes('提示词'));await closeInfo()
  await evaluate("window.show('multi')");await pause(150)
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'narrow batches stay within the pane')
  await assertPure();await screenshot('image-multi-narrow-window')
  await openPreview('[data-image-result] img')
  assert(await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog][aria-modal=true]'),frame=dialog.getBoundingClientRect();return [...dialog.querySelectorAll('button')].every(button=>{const rect=button.getBoundingClientRect();return rect.left>=frame.left&&rect.right<=frame.right})})()`),'preview navigation and zoom controls remain reachable in a narrow window')
  await closeInfo()
  await load('');await evaluate('window.showCollections()');await pause(250)
  await evaluate("document.querySelector('#tool-group [data-agent-trigger]').click()");await pause(100)
  for (const id of ['user-group','custom-group','tool-group','notebook-group']) {
    await openPreview('#'+id+' img',1)
    assert.equal((await preview()).position,'2/2',id+' opens at the clicked image')
    await press('ArrowRight');assert.equal((await preview()).position,'2/2',id+' respects its own boundary')
    await press('ArrowLeft');assert.equal((await preview()).position,'1/2')
    assert.equal(await evaluate("document.querySelector('[role=dialog] img').naturalWidth"),1280)
    await press('ArrowRight');assert.equal(await evaluate("document.querySelector('[role=dialog] img').naturalWidth"),768)
    await closeInfo()
  }
  await openPreview('#markdown-group img')
  assert.equal((await preview()).label,'Second')
  assert.equal((await preview()).position,undefined)
  await evaluate('window.resolveMarkdown()');await pause(150)
  assert.equal((await preview()).position,'2/2','late-resolved Markdown images use source order')
  await press('ArrowLeft');assert.equal((await preview()).label,'First')
  await closeInfo()
  await openPreview('#duplicate-group img',1)
  assert.equal((await preview()).label,'B');assert.equal((await preview()).position,'2/2')
  await evaluate('window.reorder()');await pause(100)
  assert.equal((await preview()).label,'B');assert.equal((await preview()).position,'1/2','reordering retains image identity, even with identical bytes')
  await press('ArrowRight');assert.equal((await preview()).label,'A')
  await closeInfo()
  assert(await evaluate("document.activeElement===document.querySelector('#duplicate-group img[alt=B]').closest('button')"),'closing restores the original thumbnail focus')
  await openPreview('#single-image img')
  assert.equal((await preview()).position,undefined,'independent images never acquire adjacent groups')
  await press('ArrowRight');assert.equal((await preview()).label,'Standalone')
  await closeInfo()
  assert.deepEqual(exceptions,[])
  console.log('PASS: original and complete retry history, unified hover toolbar, repeated/cold navigation, selected-image cancellation, waiting-only information, failure records, accessible popovers, unchanged ordinary cards, responsive batches, locales and motion.')
} finally {
  try { ws?.close() } catch {}
  if(child && child.exitCode===null) {
    const exited=new Promise(resolve=>child.once('exit',resolve))
    child.kill('SIGTERM');await exited
  }
  await server?.close()
  await rm(temporary,{recursive:true,force:true,maxRetries:3})
}
