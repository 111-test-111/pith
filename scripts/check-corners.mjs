/**
 * Native corner geometry regression check. Run: node scripts/check-corners.mjs
 * Uses actual beUI components in isolated Electron; no SDK or real sessions.
 * PI_CORNERS_SCREENSHOT_DIR optionally keeps light/dark gallery + modal images.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pi-corners-'))
const fixturePath = '/__corners_check.html'
const pause = ms => new Promise(r => setTimeout(r, ms))

// Guard the authored geometry, including animation targets and markdown chrome.
// Runtime checks below catch semantic mistakes that a source scan cannot see.
async function guard(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'previews') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await guard(path); continue }
    if (!/\.(tsx?|css)$/.test(path)) continue
    const text = await readFile(path, 'utf8')
    assert.doesNotMatch(text, /rounded(?:-[a-z]+)*-\[\d[^\]]*(?:px|rem|%)\]/, path + ': literal corner utility')
    assert.doesNotMatch(text, /border(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius:\s*(?:[1-9]\d*|["'][\d.]+px)/, path + ': literal radius')
    // The CSS form. The camelCase assertion above cannot see `border-radius:2px`
    // in a .css file, which is exactly how pdf-viewer.css's three literal 2px
    // radii survived every previous geometry sweep. Percentages stay allowed: a
    // `50%` radius is a genuine circle (a PDF's own radio widget, rounded-full's
    // circular-arc fallback), not a scale value.
    assert.doesNotMatch(text, /border-radius:\s*[1-9][\d.]*(?:px|rem)/, path + ': literal CSS radius')
    assert.doesNotMatch(text, /radius=\{[1-9]\d*\}/, path + ': numeric radius prop')
    assert.doesNotMatch(text, /["'`]inset\([^"'`]*\bround\s/, path + ': circular reveal mask overrides native geometry')
  }
}

const fixture = `<!doctype html><html><head><style>
body { overflow: auto !important; } #gallery { max-width:900px; margin:32px auto; padding:8px; }
.lab-row { display:flex; align-items:center; gap:16px; margin:20px 0; }
.lab-columns { display:grid; grid-template-columns:1fr 1fr; gap:32px; }
.lab-label { font-size:13px; opacity:.65; margin-bottom:12px; } .lab-section { margin:28px 0; }
#pseudo::before {content:'';display:block;width:8px;height:8px;background:currentColor;}
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '/src/components/motion/button';
import {Input} from '/src/components/motion/input.tsx';
import {Checkbox} from '/src/components/motion/checkbox.tsx';
import {RadioGroup,RadioGroupItem} from '/src/components/motion/radio.tsx';
import {Tabs,TabsList,TabsTrigger} from '/src/components/motion/tabs.tsx';
import {Select,SelectTrigger,SelectContent,SelectItem} from '/src/components/motion/select.tsx';
import {CenterMorphModal,CenterMorphModalTrigger,CenterMorphModalContent} from '/src/components/motion/center-morph-modal.tsx';
import {MorphPopover,MorphPopoverTrigger,MorphPopoverContent} from '/src/components/motion/popover-morph.tsx';
import {Tooltip} from '/src/components/motion/tooltip.tsx';
import {Loader} from '/src/components/motion/loader.tsx';
import {PromptInput} from '/src/components/agents/prompt-input.tsx';
import {MessageBubble,MessageBubbleContent} from '/src/components/agents/message-bubble.tsx';
import {StreamingResponse} from '/src/components/agents/streaming-response.tsx';
import {Markdown} from '/src/lib/markdown.tsx';
import {TurnWrittenFiles} from '/src/components/app/TurnWrittenFiles.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {synthesizeWritePatch} from '/src/lib/diff.ts';
import '/src/styles.css';
const h=React.createElement;
const file={filePath:'/fixture/theme.ts',displayPath:'src/theme.ts',added:2,patch:synthesizeWritePatch('theme.ts','export const appearance = "continuous";\\nexport const nativeCorners = true;')};
function Fixture(){
 const [modal,setModal]=React.useState(false),[popover,setPopover]=React.useState(false),[instant,setInstant]=React.useState(false);
 const [checked,setChecked]=React.useState(true),[select,setSelect]=React.useState(false),[tab,setTab]=React.useState('one'),[side,setSide]=React.useState('bottom');
 React.useEffect(()=>{window.controls={setModal,setPopover,setInstant,setSelect,setTab,setSide};window.fixtureReady=true},[]);
 const selectControl=h(Select,{defaultValue:'native',open:select,onOpenChange:setSelect,className:'lab-select'},
   h(SelectTrigger,null,'Corner geometry'),h(SelectContent,null,h(SelectItem,{value:'native'},'Native corners'),h(SelectItem,{value:'round'},'Circular corners')));
 return h(I18nProvider,null,h('main',{id:'gallery'},
  h('div',{className:'lab-label'},'Pith · Component geometry check'),
  h('h1',{style:{fontSize:24,fontWeight:600,marginBottom:28}},'Continuous corners'),
  h('div',{className:'lab-columns'},
   h('section',null,h('div',{className:'lab-label'},'Controls'),
    h('div',{className:'lab-row'},h(Button,{id:'primary',ripple:true},'Continue'),h(Button,{variant:'secondary'},'Cancel'),h(Button,{variant:'ghost',size:'icon','aria-label':'Icon control'},'+')),
    h(Input,{label:'Project name',defaultValue:'Pith',classNames:{field:'lab-field'}}),
    h('div',{className:'lab-row'},h(Checkbox,{id:'point-checkbox',mark:'square',checked,onCheckedChange:setChecked,'aria-label':'Enable feature'}),
     h(RadioGroup,{defaultValue:'on',orientation:'horizontal'},h(RadioGroupItem,{value:'on',label:'Enabled'})),
     h('span',{id:'status-dot',className:'size-1.5 rounded-full bg-primary'}),
     h('span',{id:'pseudo','data-drop':'before',className:'data-[drop=before]:before:rounded-full'}),h(Loader,{variant:'dots',size:16})),
    h('div',{id:'segment'},h(Tabs,{variant:'segment',value:tab,onValueChange:setTab},h(TabsList,null,h(TabsTrigger,{value:'one'},'Terminal'),h(TabsTrigger,{value:'two'},'Review')))),
    h('div',{className:'lab-section'},selectControl)),
   h('section',null,h('div',{className:'lab-label'},'Transcript and layers'),
    h(MessageBubble,{align:'end'},h(MessageBubbleContent,null,'Apply continuous corners across the interface.')),
    // Inline code is the one markdown element whose radius is authored on the
    // element itself (lib/markdown.tsx), so it is the one that can be overridden
    // by an ancestor's descendant utility — the transcript chain is the shape
    // the reader actually sees.
    h('div',{id:'md-case',className:'lab-section'},h('div',{className:'lab-label'},'Markdown inline code'),
     h(MessageBubble,{variant:'soft'},h(MessageBubbleContent,null,
      h(StreamingResponse,null,h(Markdown,null,'Inline \`code\` inside the streaming chain.')))),
     h('div',{id:'md-plain'},h(Markdown,null,'Inline \`code\` in plain markdown.'))),
    h('div',{className:'lab-row'},
     h(CenterMorphModal,{open:modal,onOpenChange:setModal},
      h(CenterMorphModalTrigger,null,h(Button,{'data-trigger':'modal',variant:'secondary'},'Open dialog')),
      h(CenterMorphModalContent,{ariaLabel:'Corner dialog',closeButtonLabel:'Close dialog',className:'max-w-xl'},
       h('div',{style:{padding:24}},h('h2',{style:{fontSize:20,fontWeight:600,marginBottom:20}},'Native dialog surface'),
        h(Input,{id:'dialog-input',label:'Name',defaultValue:'Continuous corners'}),
        h('div',{className:'lab-row'},h(Button,{onClick:()=>setModal(false)},'Done'))))),
     h(MorphPopover,{open:popover,onOpenChange:setPopover},h(MorphPopoverTrigger,null,h(Button,{'data-trigger':'popover',variant:'secondary'},'Open popover')),
      h(MorphPopoverContent,{side,align:'center',instant},h('div',{style:{padding:20,width:260}},h('div',{style:{fontWeight:600,marginBottom:12}},'Native popover'),h(Button,{id:'popover-focus',variant:'secondary'},'Focus target')))),
     h(Tooltip,{content:'Shared overlay elevation'},h(Button,{id:'tooltip-trigger',variant:'ghost',size:'icon','aria-label':'Show tooltip'},'?'))),
    h(TurnWrittenFiles,{files:[file]}))),
  h('section',{className:'lab-section'},h('div',{className:'lab-label'},'Composer'),h(PromptInput,{placeholder:'Ask anything…',defaultValue:'Refine the corners, preserve the circles.'}))));
}
createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`

let child, ws, server
try {
  await guard(join(repo, 'src/renderer/src'))
  server = await createServer({
    configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), {
      name: 'corner-fixture', configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== fixturePath) return next()
          try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) }
          catch (error) { next(error) }
        })
      }
    }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});
app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  const pending = new Map(); let sequence = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, m => m.error ? reject(m.error) : resolve(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate('!!window.fixtureReady && !!document.getElementById("primary")')) return
      await pause(50)
    }
    throw new Error('Fixture did not mount')
  }
  const key = async (key, code = key, windowsVirtualKeyCode = 27, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  const style = (selector, property) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(property)})`)
  const screenshot = async name => {
    if (!process.env.PI_CORNERS_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_CORNERS_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_CORNERS_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }
  // Hit testing distinguishes the real painted squircle from a circular inset
  // mask even when getComputedStyle(element).cornerShape claims "squircle".
  const beginFrames = async selector => evaluate(`(()=>{
    window.cornerFrames=[];window.cornerSampling=true;
    function sample(){if(!window.cornerSampling)return;
      const e=document.querySelector(${JSON.stringify(selector)});
      if(e){const c=getComputedStyle(e),r=e.getBoundingClientRect(),radius=parseFloat(c.borderTopLeftRadius)*r.width/e.offsetWidth;
        const hit=document.elementFromPoint(r.left+radius*.22,r.top+radius*.22);
        window.cornerFrames.push({shape:c.cornerShape,clip:c.clipPath,opacity:c.opacity,radius,
          inside:e===hit||e.contains(hit),transform:c.transform});}
      requestAnimationFrame(sample)}requestAnimationFrame(sample);
  })()`)
  const endFrames = async () => evaluate('window.cornerSampling=false;window.cornerFrames')

  for (const reduced of [false, true]) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
    await send('Page.navigate', { url })
    await ready(); await pause(350)
    assert.equal(await evaluate('CSS.supports("corner-shape","squircle")'), true)
    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light'
      await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
      for (const selector of ['#primary', '.lab-field', '#segment [aria-selected="true"]', '[data-slot="message-bubble"] .rounded-inherit']) {
        assert.equal(await style(selector, 'corner-shape'), 'superellipse(2)', selector + ': continuous corners')
      }
      assert.equal(await style('#status-dot', 'corner-shape'), 'superellipse(1)', '#status-dot: true circles stay circular')
      assert.equal(await evaluate('getComputedStyle(document.getElementById("pseudo"),"::before").cornerShape'), 'superellipse(1)', 'pseudo-element full-round utility')
      // The composer's send control is capsule-by-design: the shape token
      // collapses to 0px in the square style, so it stays hard-edged while
      // carrying the round corner shape that the squircle style needs.
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('[aria-label="Send prompt"]'),s=getComputedStyle(e),r=e.getBoundingClientRect();return s.cornerShape==='superellipse(1)'&&parseFloat(s.borderTopLeftRadius)===0&&r.height>0})()`), true, 'composer send control collapses to a hard edge')
      assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--app-radius-capsule").trim()'), '0px', '--app-radius-capsule collapses in the square style')
      // Inline code carries its corner on the markdown element itself, so an
      // ancestor's descendant utility wins on specificity: the vendored bubble
      // and streaming chrome kept Tailwind's bare `rounded` (a literal 0.25rem,
      // not a theme token) as `[&_code]:rounded`, which quietly re-rounded every
      // inline code box in the transcript while plain markdown stayed square.
      const detailRadius = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--app-radius-detail").trim()')
      for (const selector of ['#md-case [data-slot="message-bubble"] code', '#md-plain code']) {
        assert.equal(await style(selector, 'border-top-left-radius'), detailRadius, selector + ': inline code takes the theme detail radius')
        assert.equal(await style(selector, 'border-bottom-right-radius'), detailRadius, selector + ': every inline code corner')
        assert.equal(await style(selector, 'corner-shape'), 'superellipse(2)', selector + ': continuous corner shape')
        assert.notEqual(await style(selector, 'background-color'), 'rgba(0, 0, 0, 0)', selector + ': inline code paints its own box')
        assert.equal(await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.width>0&&r.height>0})()`), true, selector + ': inline code has a box')
      }
      // The progressive fallback changes paint, never the controls' layout.
      const bounds = await evaluate(`JSON.stringify([...document.querySelectorAll('#primary,.lab-field,#segment')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`)
      await evaluate('document.documentElement.style.setProperty("--app-corner-shape","round")')
      assert.equal(await style('#primary', 'corner-shape'), 'superellipse(1)')
      assert.equal(await evaluate(`JSON.stringify([...document.querySelectorAll('#primary,.lab-field,#segment')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`), bounds, 'fallback preserves layout')
      await evaluate('document.documentElement.style.removeProperty("--app-corner-shape")')
      await screenshot(`${theme}-${reduced ? 'reduced' : 'motion'}-gallery`)

      // The style preset must be a pure token swap: both presets pinned, and the
      // capsule site must actually change shape between them. The preset block
      // has the same specificity as :root and wins on source order alone, so
      // this is also what catches a reorder above :root.
      const CORNER_PRESETS = {
        square: { detail: '0px', inner: '0px', item: '0px', card: '0px', window: '0px', capsule: '0px' },
        squircle: { detail: '4px', inner: '10px', item: '14px', card: '20px', window: '28px', capsule: '9999px' }
      }
      for (const [preset, expected] of Object.entries(CORNER_PRESETS)) {
        await evaluate(`document.documentElement.dataset.corners = ${JSON.stringify(preset)}`)
        await pause(150)
        for (const [token, value] of Object.entries(expected)) {
          assert.equal(
            await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--app-radius-${token}").trim()`),
            value,
            preset + ': --app-radius-' + token
          )
        }
        const sendRadius = parseFloat(await style('[aria-label="Send prompt"]', 'border-top-left-radius'))
        assert.ok(
          preset === 'square' ? sendRadius === 0 : sendRadius >= 16,
          preset + ': the capsule site ' + (preset === 'square' ? 'stays a right angle' : 'is a full capsule') + ' (got ' + sendRadius + ')'
        )
        assert.equal(await style('[aria-label="Send prompt"]', 'corner-shape'), 'superellipse(1)', preset + ': the capsule keeps a round corner shape')
        // Selection controls, pinned per preset. The frames stay on the radius
        // scale and their on-state marks are capsule-by-design: a square point
        // in the square style, a fully circular point in the squircle style.
        // The checkbox frame is deliberately on the DETAIL step and NOT on the
        // control step — 14px on this 14px box would turn the frame into a full
        // circle, which is the radio's shape, so the two controls would read
        // the same. `#point-checkbox` is the fixture's point-select control
        // (`mark="square"`), targeted by id so a `mark="check"` box could
        // never satisfy the assertion silently.
        const boxOf = selector => evaluate('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return Math.min(r.width,r.height)})()')
        const checkboxBox = await boxOf('#point-checkbox')
        const checkboxFrameRadius = parseFloat(await style('#point-checkbox', 'border-top-left-radius'))
        assert.equal(checkboxBox, 14, preset + ': the point-select checkbox keeps its text-sized 14px frame')
        assert.equal(await style('#point-checkbox', 'corner-shape'), 'superellipse(2)', preset + ': continuous checkbox frame')
        assert.ok(
          preset === 'square' ? checkboxFrameRadius === 0 : checkboxFrameRadius >= 4 && checkboxFrameRadius < checkboxBox / 2,
          preset + ': the checkbox frame stays a rounded SQUARE, never a circle (radius ' + checkboxFrameRadius + ', box ' + checkboxBox + ')'
        )
        const radioBox = await boxOf('[role="radio"]')
        const radioFrameRadius = parseFloat(await style('[role="radio"]', 'border-top-left-radius'))
        assert.equal(await style('[role="radio"]', 'corner-shape'), 'superellipse(2)', preset + ': continuous radio frame')
        assert.ok(
          preset === 'square' ? radioFrameRadius === 0 : radioFrameRadius >= radioBox / 2,
          preset + ': the radio frame is a circle in the squircle style (radius ' + radioFrameRadius + ', box ' + radioBox + ')'
        )
        for (const markSelector of ['[data-checkbox-mark]', '[role="radio"] > span']) {
          const markBox = await boxOf(markSelector)
          const markRadius = parseFloat(await style(markSelector, 'border-top-left-radius'))
          assert.equal(await style(markSelector, 'corner-shape'), 'superellipse(1)', preset + ': the selection mark carries the round corner shape (' + markSelector + ')')
          assert.ok(
            preset === 'square' ? markRadius === 0 : markRadius >= markBox / 2,
            preset + ': ' + markSelector + ' is ' + (preset === 'square' ? 'a square point' : 'a fully circular point') + ' (radius ' + markRadius + ', box ' + markBox + ')'
          )
        }
        // The invariant this task exists to protect: in the squircle style a
        // checkbox must stay tellable apart from the radio beside it.
        assert.ok(
          preset !== 'squircle' || checkboxFrameRadius < radioFrameRadius,
          preset + ': the checkbox frame must stay distinguishable from the radio frame — checkbox radius ' + checkboxFrameRadius + ' must be strictly smaller than radio radius ' + radioFrameRadius
        )
        await screenshot(`${theme}-${reduced ? 'reduced' : 'motion'}-${preset}-gallery`)
      }
      await evaluate('delete document.documentElement.dataset.corners')
      await pause(150)

      // The dialog is portalled outside #root. Check entry frames, focus trap,
      // shadow, and native corners at every observed frame (not just at rest).
      const dialog = '[role="dialog"][aria-modal="true"]'
      await beginFrames(dialog)
      await evaluate(`document.querySelector('[data-trigger="modal"]').click()`); await pause(450)
      const frames = await endFrames()
      assert.ok(frames.length > 4, 'entry frame sampler ran')
      assert.ok(frames.every(f => f.shape === 'superellipse(2)' && f.clip === 'none' && f.inside), 'dialog corners stay native on every entry frame: ' + JSON.stringify(frames))
      if (reduced) assert.ok(frames.every(f => f.transform === 'none'), 'reduced motion has no scale')
      assert.notEqual(await style(dialog, 'box-shadow'), 'none')
      if (!dark && !reduced) {
        // Negative control: the original beUI mask must fail the geometric
        // oracle despite still reporting corner-shape: squircle. The mask uses
        // a fixed radius — the square-style branch's own radius is 0 and would
        // clip nothing.
        await beginFrames(dialog)
        await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(dialog)});e.style.clipPath='inset(0 round 24px)'})()`)
        await pause(80)
        assert.ok((await endFrames()).some(f => !f.inside), 'hit testing detects the old circular-mask regression')
        await evaluate(`document.querySelector(${JSON.stringify(dialog)}).style.removeProperty('clip-path')`)
      }
      assert.equal(await evaluate('document.activeElement.id'), 'dialog-input', 'dialog initially focuses its field')
      await key('Tab', 'Tab', 9, 8)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Close dialog', 'Shift+Tab traps at the last control')
      await key('Tab', 'Tab', 9)
      assert.equal(await evaluate('document.activeElement.id'), 'dialog-input', 'Tab wraps to first control')
      await screenshot(`${theme}-${reduced ? 'reduced' : 'motion'}-dialog`)
      if (!dark && !reduced) {
        await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false })
        await evaluate(`document.querySelector(${JSON.stringify(dialog)}).style.maxWidth='none'`)
        assert.equal(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(dialog)}),r=e.getBoundingClientRect(),s=e.parentElement.parentElement.getBoundingClientRect();return r.left>s.left&&r.right<s.right})()`), true, 'full-width dialog reserves shadow gutters inside its scroll viewport')
        await evaluate(`document.querySelector(${JSON.stringify(dialog)}).style.removeProperty('max-width')`)
        await send('Emulation.clearDeviceMetricsOverride')
      }
      await beginFrames(dialog)
      await key('Escape'); await pause(350)
      const exits = await endFrames()
      assert.ok(exits.every(f => f.shape === 'superellipse(2)' && f.clip === 'none'), 'exit never restores circular masks')
      assert.equal(await evaluate('document.activeElement.dataset.trigger'), 'modal', 'Escape returns focus')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(dialog)})===null`), true, 'dialog exits completely')

      for (const instant of [false, true]) {
        await evaluate(`window.controls.setInstant(${instant});window.controls.setSide(${dark ? '"top"' : '"bottom"'})`)
        await pause(30)
        const popover = '[data-morph-popover-portal] [role="dialog"]'
        await beginFrames(popover)
        await evaluate('window.controls.setPopover(true)'); await pause(500)
        const samples = await endFrames()
        assert.ok(samples.length > 4)
        assert.ok(samples.every(f => f.shape === 'superellipse(2)' && f.clip === 'none' && f.inside), 'popover corners survive every frame: ' + JSON.stringify(samples))
        await evaluate('document.getElementById("popover-focus").focus()')
        await key('Escape'); await pause(30)
        assert.equal(await evaluate('document.querySelector("[data-morph-popover-portal]")?.inert ?? true'), true, 'exit releases interaction immediately')
        for (let i = 0; i < 60; i++) {
          if (await evaluate('document.querySelector("[data-morph-popover-portal]")===null')) break
          await pause(30)
        }
        assert.equal(await evaluate('document.querySelector("[data-morph-popover-portal]")===null'), true, 'popover finishes its exit')
        assert.equal(await evaluate('document.activeElement.dataset.trigger'), 'popover')
      }
      console.log(`${theme}/${reduced ? 'reduced' : 'motion'}: ${frames.length} dialog frames; native popovers above/below, instant/reduced paths and focus passed`)
    }

    // A live token change must reach animation-owned corners and tab indicators
    // as well as ordinary CSS consumers, without remounting these components.
    await evaluate('window.controls.setSelect(true);window.controls.setModal(true)')
    await pause(750)
    await evaluate('document.documentElement.style.setProperty("--app-radius-control","23px");document.documentElement.style.setProperty("--app-radius-window","34px");document.documentElement.style.setProperty("--app-radius-inner","7px")')
    for (const selector of ['#primary', '.lab-field', '.lab-select button[aria-haspopup="listbox"]', '.lab-select [role="listbox"]']) {
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) assert.equal(await style(selector, 'border-' + corner + '-radius'), '23px', selector + ': live token on ' + corner)
    }
    assert.equal(await style('[aria-modal="true"]', 'border-top-left-radius'), '34px')
    assert.equal(await style('#segment .absolute', 'border-top-left-radius'), '7px')
    await evaluate('window.controls.setTab("two")'); await pause(500)
    assert.equal(await style('#segment .absolute', 'border-top-left-radius'), '7px', 'moving tab indicator keeps the token')
    // Reopen near the bottom edge to exercise Select's opposite corner pair.
    await evaluate('window.controls.setModal(false);window.controls.setSelect(false)'); await pause(450)
    await evaluate(`Object.assign(document.querySelector('.lab-select').style,{position:'fixed',bottom:'8px',left:'40px',width:'280px'});window.controls.setSelect(true)`)
    await pause(750)
    assert.equal(await evaluate('document.querySelector(".lab-select [role=listbox]").classList.contains("bottom-full")'), true, 'select flips upward')
    for (const selector of ['.lab-select button[aria-haspopup="listbox"]', '.lab-select [role="listbox"]']) {
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) assert.equal(await style(selector, 'border-' + corner + '-radius'), '23px', 'upward Select shares the token')
    }
    await evaluate('document.documentElement.style.removeProperty("--app-radius-control");document.documentElement.style.removeProperty("--app-radius-window");document.documentElement.style.removeProperty("--app-radius-inner")')
    await key('Escape'); await pause(450)
  }
  console.log('PASS: native corners, circular exceptions, pseudo-elements, inherited layers, live tokens, animation frames, themes and focus.')
} finally {
  ws?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(r => child.once('exit', r)), pause(3000)])
  }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
