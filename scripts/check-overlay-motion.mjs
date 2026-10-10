/**
 * Floating surfaces measured in isolated Electron, with real app/beUI panels.
 * Compare rendered trajectories and usable row geometry, not authored tokens.
 * No SDK, provider calls or user profiles. PI_OVERLAY_MOTION_SCREENSHOT_DIR
 * optionally retains local/portal and top/bottom galleries.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-overlay-motion-'))
const fixturePath = '/__overlay-motion.html'
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AnimatePresence} from 'motion/react';
import {I18nProvider} from '@/i18n';
import {ToastProvider} from '@/components/app/ToastProvider';
import {ModelPicker} from '@/components/app/ModelPicker';
import {SandboxModePicker} from '@/components/app/SandboxModePicker';
import {Select,SelectTrigger,SelectContent,SelectItem} from '@/components/motion/select';
import {Combobox,ComboboxTrigger,ComboboxInput,ComboboxContent,ComboboxList,ComboboxItem} from '@/components/motion/combobox';
import {MultiSelect,MultiSelectTrigger,MultiSelectInput,MultiSelectContent,MultiSelectList,MultiSelectItem} from '@/components/motion/multi-select';
import {MorphPopover,MorphPopoverTrigger,MorphPopoverContent} from '@/components/motion/popover-morph';
import {ContextMenu,ContextMenuTrigger,ContextMenuContent,ContextMenuItem} from '@/components/motion/context-menu';
import {TooltipSurface} from '@/components/motion/tooltip-surface';
import {CenterMorphModal,CenterMorphModalContent} from '@/components/motion/center-morph-modal';
import {MorphingModal} from '@/components/motion/morphing-modal';
import {CommandPalette} from '@/components/motion/command-palette';
import {initReduceMotion,setReduceMotion} from '@/lib/reduce-motion';
import '@/styles.css';
const h=React.createElement;
localStorage.setItem('pi-app:locale','en');initReduceMotion();
window.pi={platform:'darwin'};
window.picks=[];
const models=Array.from({length:3},(_,i)=>({providerId:'fixture',providerName:'Fixture',id:'m'+i,name:'Model '+i,reasoning:true,available:true,input:['text']}));
function Fixture({side,portal}){
 const [open,setOpen]=React.useState(false);window.changeOpen=setOpen;
 const [model,setModel]=React.useState('fixture/m0');
 const [level,setLevel]=React.useState('high');
 const row=(i)=>h('span',{'data-motion-row':''},'Option '+i);
 return h('div',null,
  h('div',{id:'stage',style:{position:'absolute',left:24,right:24,[side==='top'?'bottom':'top']:64,display:'flex',gap:20,alignItems:'start'}},
   h('div',{id:'model-holder'},h(ModelPicker,{models,value:model,thinkingLevel:level,availableThinkingLevels:['off','high','max'],portal,panelId:'motion-model',onChange:m=>setModel(m.providerId+'/'+m.id),onThinkingLevelChange:l=>{setLevel(l);window.picks.push(l)}})),
   h('div',{id:'sandbox-holder'},h(SandboxModePicker,{mode:'workspace-write',status:null,sessionPath:null,portal,onModeChange:m=>window.picks.push(m)})),
   h(Select,{open,value:'0',className:'w-40'},h(SelectTrigger,null,'Long list'),h(SelectContent,{portal},Array.from({length:37},(_,i)=>h(SelectItem,{key:i,value:String(i)},row(i))))),
   h(Combobox,{open,className:'w-40'},h(ComboboxTrigger,null,h(ComboboxInput,{'aria-label':'Combo'})),h(ComboboxContent,{side},h(ComboboxList,{ariaLabel:'Combo options'},[0,1,2].map(i=>h(ComboboxItem,{key:i,value:String(i)},row(i)))))),
   h(MultiSelect,{open,className:'w-40'},h(MultiSelectTrigger,null,h(MultiSelectInput,{'aria-label':'Multi'})),h(MultiSelectContent,{side},h(MultiSelectList,{ariaLabel:'Multi options'},[0,1,2].map(i=>h(MultiSelectItem,{key:i,value:String(i)},row(i)))))),
   h(MorphPopover,{open},h(MorphPopoverTrigger,null,h('button',{id:'popover-trigger'},'Popover')),h(MorphPopoverContent,{side,className:'w-40 p-2'},h('button',null,'Popover action')))),
  h(ContextMenu,{open},h(ContextMenuTrigger,null,h('button',{id:'context-trigger',style:{position:'absolute',left:24,top:400}},'Context')),h(ContextMenuContent,{ariaLabel:'Motion menu'},h(ContextMenuItem,null,'Context action'))),
  h(AnimatePresence,null,open?h(TooltipSurface,{key:'tip',side,className:'pointer-events-none',style:{position:'fixed',left:280,top:420}},'Tooltip'):null),
  h(CenterMorphModal,{open},h(CenterMorphModalContent,{ariaLabel:'Motion center',showCloseButton:false},h('button',null,'Center action'))),
  h(MorphingModal,{viewId:open?'motion':null,onClose:()=>{},placement:'center',className:'motion-modal'},h('button',null,'Modal action')),
  h(CommandPalette,{open,shortcut:null,items:[{id:'one',label:'Palette action',onSelect:()=>{}}]})
 );
}
const root=createRoot(document.getElementById('root'));
window.mount=(side,portal)=>flushSync(()=>root.render(h(I18nProvider,null,h(ToastProvider,null,h(Fixture,{key:side+portal,side,portal})))));
const trigger=(id)=>document.querySelector('#'+id+' button[aria-haspopup=listbox]');
window.toggle=(open)=>flushSync(()=>{
 for(const id of ['model-holder','sandbox-holder']){const t=trigger(id);if((t.getAttribute('aria-expanded')==='true')!==open)t.click()}
 window.changeOpen(open);
});
function nodes(){
 const sandbox=trigger('sandbox-holder');
 const long=[...document.querySelectorAll('button[aria-haspopup=listbox]')].find(n=>n.textContent.includes('Long list'));
 return {
  model:document.getElementById('motion-model'),sandbox:document.getElementById(sandbox?.getAttribute('aria-controls')),
  long:document.getElementById(long?.getAttribute('aria-controls')),
  combo:document.querySelector('[data-combobox-content]'),multi:document.querySelector('[data-multi-select-content]'),
  popover:document.querySelector('[data-morph-popover-portal]'),context:document.querySelector('[data-context-menu-portal] [role=menu]'),
  tooltip:document.querySelector('[role=tooltip]'),center:document.querySelector('[aria-label="Motion center"]'),
  modal:document.querySelector('.motion-modal'),palette:document.querySelector('[data-shortcut-passthrough=commandPalette]')
 };
}
window.sample=()=>Object.fromEntries(Object.entries(nodes()).map(([name,node])=>{
 if(!node)return[name,null];
 const css=getComputedStyle(node),matrix=new DOMMatrixReadOnly(css.transform==='none'?undefined:css.transform);
 const rows=[...node.querySelectorAll('[role=option]')];
 return[name,{opacity:+css.opacity,scale:matrix.a,x:matrix.e,y:matrix.f,filter:css.filter,
  width:node.offsetWidth,height:node.offsetHeight,visible:css.visibility,originY:parseFloat(css.transformOrigin.split(' ')[1]),
  inert:!!node.closest('[inert]'),pointer:css.pointerEvents,
  rows:rows.map(row=>{const c=getComputedStyle(row);return{opacity:+c.opacity,filter:c.filter,transform:c.transform}})}];
}));
window.story=(open)=>new Promise(done=>{
 window.toggle(open);const start=performance.now();const frames=[{ms:0,panels:window.sample()}];
 const tick=()=>{frames.push({ms:performance.now()-start,panels:window.sample()});if(performance.now()-start<360)requestAnimationFrame(tick);else done(frames)};
 requestAnimationFrame(tick);
});
window.reduce=(on)=>flushSync(()=>setReduceMotion(on));
window.mount('bottom',false);
</script></body></html>`

let server, child, ws
try {
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'overlay-motion-fixture', configureServer(vite) {
      vite.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(fixturePath, fixture)) }
        catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1500,height:1100,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((done, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger: ' + output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); done('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find(entry => entry.type === 'page')
    if (!page) await pause(50)
  }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(done => ws.addEventListener('open', done, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    pending.set(id, message => message.error ? reject(message.error) : done(message.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await pause(50) }
    throw new Error('Fixture did not become ready: ' + expression + '\n' + JSON.stringify(exceptions))
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await waitFor(`typeof window.sample==='function' && Object.values(window.sample()).filter(Boolean).length>=6`)
  await evaluate('document.fonts.ready')

  const assertStory = (frames, open, label) => {
    const last = frames.at(-1).panels
    const names = Object.keys(frames[0].panels)
    for (const name of names) {
      const samples = frames.map(frame => frame.panels[name]).filter(Boolean)
      assert(samples.length, `${label}: ${name} is mounted during the transition`)
      for (const sample of samples) {
        assert.equal(sample.width, samples[0].width, `${label}: ${name} has resting width throughout`)
        assert.equal(sample.height, samples[0].height, `${label}: ${name} has resting height throughout`)
        assert.equal(sample.filter, 'none', `${label}: ${name} has no independent blur`)
        assert(sample.scale >= 0.979 && sample.scale <= 1.001, `${label}: ${name} does not overshoot`)
        for (const row of sample.rows) {
          assert.equal(row.opacity, 1, `${label}: ${name} rows arrive as one surface`)
          assert.equal(row.filter, 'none', `${label}: ${name} rows remain clear`)
          assert.equal(row.transform, 'none', `${label}: ${name} rows keep their layout`)
        }
      }
      if (open) {
        assert.equal(last[name]?.opacity, 1, `${label}: ${name} finishes open`)
        assert.equal(last[name]?.scale, 1, `${label}: ${name} finishes at resting scale`)
        assert(samples.some(sample => sample.opacity > 0.05 && sample.opacity < 0.99), `${label}: ${name} animates its entrance`)
      } else {
        assert(!last[name] || last[name].opacity === 0, `${label}: ${name} finishes closed`)
        if (name !== 'tooltip') {
          const first = frames[0].panels[name]
          assert(first.inert, `${label}: ${name} immediately releases focus`)
          assert.equal(first.pointer, 'none', `${label}: ${name} immediately releases pointers`)
        }
      }
    }
    // Compare the actual poses on the same rendered frames. A one-frame
    // scheduling allowance avoids pinning a machine-specific frame rate.
    for (const frame of frames) {
      const short = frame.panels.sandbox
      for (const name of ['model', 'long', 'combo', 'multi']) {
        const panel = frame.panels[name]
        assert(Math.abs(short.opacity - panel.opacity) < 0.2, `${label}: ${name} and permission picker share progress at ${frame.ms}ms`)
        assert(Math.abs(short.scale - panel.scale) < 0.0041, `${label}: ${name} and permission picker share scale at ${frame.ms}ms`)
      }
    }
  }

  for (const side of ['bottom', 'top']) for (const portal of [false, true]) {
    const label = `${side}/${portal ? 'portal' : 'local'}`
    await evaluate(`window.mount(${JSON.stringify(side)},${portal})`)
    await pause(250)
    const opening = await evaluate('window.story(true)')
    assertStory(opening, true, label)
    assert.equal(opening.at(-1).panels.long.rows.length, 37, `${label}: the complete long list is ready`)
    for (const name of ['model', 'sandbox']) {
      const panel = opening.at(-1).panels[name]
      assert.equal(panel.originY, side === 'top' ? panel.height : 0, `${label}: ${name} scales from the edge facing its trigger`)
    }
    const directory = process.env.PI_OVERLAY_MOTION_SCREENSHOT_DIR
    if (directory) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, label.replace('/', '-') + '.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
    }
    assertStory(await evaluate('window.story(false)'), false, label)
    await evaluate('window.toggle(true)')
    await pause(40)
    await evaluate('window.toggle(false)')
    await pause(30)
    await evaluate('window.toggle(true)')
    await pause(300)
    assert(Object.values(await evaluate('window.sample()')).every(panel => panel?.opacity === 1), `${label}: interrupted exits reopen every surface`)
    await evaluate('window.toggle(false)')
    await pause(200)
  }

  // The thinking cascade uses the same motion and cannot hold focus during exit.
  await evaluate(`window.toggle(true)`)
  await pause(250)
  await evaluate(`document.querySelector('[data-model-option="fixture/m0"]').click()`)
  await waitFor(`Boolean(document.querySelector('[data-thinking-panel]'))`)
  await pause(250)
  const levelClose = await evaluate(`(()=>{const row=document.querySelector('[data-thinking-option=max]');row.focus();row.click();const panel=document.querySelector('[data-thinking-panel]');return{inert:panel.inert,pointer:getComputedStyle(panel).pointerEvents,focus:document.activeElement===document.querySelector('#model-holder button[aria-haspopup=listbox]'),picks:window.picks}})()`)
  assert.equal(levelClose.picks.at(-1), 'max', 'the thinking selection still acts')
  await pause(30)
  assert(await evaluate(`document.querySelector('[data-thinking-panel]')?.inert===true`), 'the exiting thinking panel releases keyboard ownership')
  assert(await evaluate(`getComputedStyle(document.querySelector('[data-thinking-panel]')).pointerEvents==='none'`), 'the exiting thinking panel releases pointers')
  assert(levelClose.focus, 'thinking selection returns focus without waiting for exit')
  await evaluate('window.toggle(false)')
  await pause(200)

  await evaluate('window.toggle(true)')
  await pause(35)
  await evaluate('window.reduce(true)')
  await pause(50)
  const reducedPanels = await evaluate('window.sample()')
  assert(Object.values(reducedPanels).every(panel => panel?.opacity === 1 && panel.scale === 1 && panel.x === 0 && panel.y === 0), 'live application reduced motion lands every open surface immediately: ' + JSON.stringify(reducedPanels))
  await evaluate('window.toggle(false)')
  await pause(50)
  assert(Object.values(await evaluate('window.sample()')).every(panel => !panel || panel.opacity === 0), 'application reduced motion closes every surface immediately')
  await evaluate('window.reduce(false)')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(`window.mount('bottom',true)`)
  await pause(100)
  await evaluate('window.toggle(true)')
  await pause(50)
  const systemReducedPanels = await evaluate('window.sample()')
  assert(Object.values(systemReducedPanels).every(panel => panel?.opacity === 1 && panel.scale === 1 && panel.x === 0 && panel.y === 0), 'OS reduced motion also lands every surface without transforms: ' + JSON.stringify(systemReducedPanels))
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await evaluate('window.toggle(false)')
  await pause(250)
  await evaluate('window.toggle(true)')
  await pause(35)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pause(50)
  assert(Object.values(await evaluate('window.sample()')).every(panel => panel?.opacity === 1 && panel.scale === 1), 'live OS preference changes also finish active entrances without remounting')
  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('PASS: shared floating-surface entrances/exits, full rows, portal/placement parity, interrupted transitions, focus release and application/OS reduced motion')
} finally {
  ws?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(done => {
      const timeout = setTimeout(done, 3000)
      child.once('exit', () => { clearTimeout(timeout); done() })
      child.kill('SIGTERM')
    })
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
