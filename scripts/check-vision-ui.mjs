/** Real settings picker, localized status and attachment rejection in isolated Electron. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-vision-ui-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixturePath = '/__vision-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {ProvidersSection} from '/src/components/app/settings/ProvidersSection.tsx';
import {Composer} from '/src/components/app/Composer.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {TurnStatus,TurnStatusLabelContext} from '/src/components/app/TurnStatus.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const models=[
 {providerId:'fixture',providerName:'Fixture',id:'text',name:'Text Model',reasoning:false,available:true,input:['text']},
 {providerId:'fixture',providerName:'Fixture',id:'vision',name:'Vision Model',reasoning:false,available:true,input:['text','image']},
 {providerId:'fixture',providerName:'Fixture',id:'unavailable',name:'Unavailable Vision',reasoning:false,available:false,input:['text','image']}];
window.writes=[];window.prompts=[];window.fixtureEpoch=crypto.randomUUID();
window.pi={models:async()=>models,providers:async()=>[],modelsConfig:async()=>({providers:{}}),
 defaultModel:async()=>({providerId:'fixture',modelId:'text'}),
 sessionNamingModel:async()=>null,
 visionModel:async()=>JSON.parse(localStorage.getItem('fixture:vision')||'null'),
 setVisionModel:async value=>{window.writes.push(value);localStorage.setItem('fixture:vision',JSON.stringify(value));return value},
 toolsCatalog:async()=>({tools:[],extensions:[],skills:[],skillDiagnostics:[]}),
 pathForFile:()=>'',searchFiles:async()=>[],
 prompt:async payload=>{window.prompts.push(payload);await new Promise(r=>setTimeout(r,100));return {accepted:false,visionError:{kind:'vision',code:'not-configured'}}}};
const store=new PiStore();window.store=store;
store.applySnapshot({sessionId:'fixture',sessionPath:'/fixture/vision',cwd:'/fixture',projectless:false,messages:[],model:null,thinkingLevel:'off',isStreaming:false});
function Fixture(){
 const {t,setLocale}=useI18n();window.locale=setLocale;
 const state=React.useSyncExternalStore(store.subscribe,store.getState);
 const [busy,setBusy]=React.useState(false);window.busy=setBusy;
 return React.createElement(ImagePreviewProvider,null,
  React.createElement('div',{style:{padding:20,maxWidth:750,margin:'auto'}},
   React.createElement(ProvidersSection),
   React.createElement('div',{id:'status',style:{marginTop:20}},React.createElement(TurnStatusLabelContext.Provider,{value:state.vision.progress?t('vision.analyzing',{count:state.vision.progress.imageCount,model:state.vision.progress.modelId}):null},React.createElement(TurnStatus))),
   React.createElement('div',{id:'composer',style:{marginTop:20}},React.createElement(Composer,{models,model:models[0],thinkingLevel:'off',availableThinkingLevels:['off'],busy,
    sessionPath:'/fixture/vision',queued:{steering:[],followUp:[]},onSend:p=>store.sendPrompt(p),onQueue:p=>store.sendPrompt(p),
    onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}})),
   React.createElement('div',{id:'error'},state.error?.kind==='vision'?t('vision.error.'+state.error.code):'')));
}
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
</script></body></html>`

let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>new BrowserWindow({width:980,height:1000,webPreferences:{backgroundThrottling:false}}).loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)}));app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', event => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, msg => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  const waitFor = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(50) }
    const state = await evaluate(`({prompts:window.prompts?.length,error:document.querySelector('#error')?.textContent,editor:document.querySelector('[data-prompt-editor]')?.textContent,focus:document.activeElement?.outerHTML.slice(0,400)})`)
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify({ state, exceptions }))
  }
  await send('Runtime.enable')
  // Native Enter must reach the fixture independently of desktop focus.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const trigger = `document.querySelector('[data-default-model-slot="vision"] button[aria-haspopup="listbox"]')`
  const panel = `document.getElementById(${trigger}.getAttribute('aria-controls'))`
  await waitFor(`${trigger} && !${trigger}.disabled && document.querySelector('[data-prompt-editor]')`)
  assert.equal(await evaluate(`document.querySelector('[data-default-model-slot="advisor"] button').disabled`), true)
  await evaluate(`${trigger}.click()`)
  await waitFor(`${panel}.getAttribute('aria-hidden')==='false'`)
  assert.deepEqual(await evaluate(`[...${panel}.querySelectorAll('[data-model-option]')].map(row=>row.dataset.modelOption)`), ['fixture/vision'])
  await evaluate(`${panel}.querySelector('[data-model-option="fixture/vision"]').click()`)
  await waitFor(`${trigger}.textContent.includes('Vision Model')`)
  assert.deepEqual(await evaluate('window.writes'), [{ providerId: 'fixture', modelId: 'vision' }])
  const epoch = await evaluate('window.fixtureEpoch')
  await send('Page.reload')
  await waitFor(`typeof window.fixtureEpoch==='string' && window.fixtureEpoch!==${JSON.stringify(epoch)}`)
  await waitFor(`${trigger} && ${trigger}.textContent.includes('Vision Model') && !${trigger}.disabled`)
  await evaluate(`${trigger}.click()`)
  await waitFor(`${panel}.getAttribute('aria-hidden')==='false'`)
  await evaluate(`[...${panel}.querySelectorAll('[role=option]')].find(row=>row.textContent.trim()==='Not configured').click()`)
  await waitFor(`${trigger}.textContent.includes('Not configured') && ${panel}.getAttribute('aria-hidden')==='true'`)
  assert.equal(await evaluate('window.pi.visionModel()'), null)

  // Paste a pathless image, submit and verify the exact draft is restored.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  const draft = '请分析这张图片，保留我的输入'
  await evaluate(`(()=>{const el=document.querySelector('[data-prompt-editor]');el.focus();el.textContent=${JSON.stringify(draft)};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0))],'shot.png',{type:'image/png'}));const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev)})()`)
  await waitFor(`document.querySelector('#composer img[alt="shot.png"]')`)
  await send('Page.bringToFront')
  await evaluate(`document.querySelector('[data-prompt-editor]').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`window.prompts.length===1 && document.querySelector('#error').textContent.includes('cannot read images')`)
  await waitFor(`document.querySelector('[data-prompt-editor]').textContent===${JSON.stringify(draft)} && document.querySelector('#composer img[alt="shot.png"]')`)
  assert.equal(await evaluate('window.prompts[0].images[0].data'), png)
  assert.equal(await evaluate('window.store.getState().messages.length'), 0)
  await evaluate('window.busy(true)')
  await pause(100)
  await evaluate(`document.querySelector('[data-prompt-editor]').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`window.prompts.length===2 && document.querySelector('[data-prompt-editor]').textContent===${JSON.stringify(draft)} && document.querySelector('#composer img[alt="shot.png"]')`)
  assert(['steer', 'followUp'].includes(await evaluate('window.prompts[1].streamingBehavior')))

  await evaluate(`window.store.dispatch({type:'vision_update',sessionPath:'/fixture/vision',vision:{revision:1,progress:{id:'progress',providerId:'fixture',modelId:'Vision Model',imageCount:2}}})`)
  for (const [locale, word] of [['en', 'Analyzing'], ['zh-CN', '分析 2 张图片'], ['zh-TW', '分析 2 張圖片']]) {
    await evaluate(`window.locale(${JSON.stringify(locale)})`)
    await waitFor(`document.querySelector('#status [data-vision-progress]').textContent.includes(${JSON.stringify(word)})`)
    const text = await evaluate(`document.querySelector('#status').textContent`)
    assert(text.includes('Vision Model') && !text.includes('{count}'))
  }
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log('PASS vision-ui: image-capable model filtering, save/clear/reload, send/queue draft restoration, localized progress and errors')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000) }) }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
