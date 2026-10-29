/**
 * Accent color in isolated Electron; no model calls or user data.
 * Settings → Appearance renders the twelve hue-wheel presets plus the custom
 * color well; a preset click swaps `data-accent` (and clears the custom inline
 * tokens). The well opens the app-built picker (MorphPopover + drag tracks +
 * hex field — beUI ships no color picker): picking is a DRAFT that only moves
 * the preview, Cancel/Escape discards it, and solely Apply stores the hex,
 * activates the 'custom' slot and writes the four derived light/dark token
 * values as inline custom properties on <html>. Dark mode flips to the derived
 * dark pair, the pick survives a reload with the boot path re-deriving the
 * tokens, a preset switch keeps the remembered pick, and garbage stored values
 * fall back to the defaults. The fixture mounts the real AppearanceSection
 * wired through the real useAccent/useCustomAccent stores exactly like
 * App.tsx, so the check exercises the production store, derivation, picker and
 * section markup.
 *
 * PI_ACCENT_SCREENSHOT_DIR retains the light/dark gallery.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve('.')
const temporary = await mkdtemp(join(tmpdir(), 'pith-accent-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__accent-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ThemeProvider} from 'next-themes';
import {I18nProvider} from '/src/i18n/index.tsx';
import {AppearanceSection} from '/src/components/app/settings/AppearanceSection.tsx';
import {useAccent,useCustomAccent,applyAccent,deriveCustomAccent,ACCENT_PRESETS} from '/src/lib/accent.ts';
import '/src/styles.css';
window.pi={platform:'darwin'};
window.derive=deriveCustomAccent;
function Shell(){
  const [accent,setAccent]=useAccent();
  const [customAccent]=useCustomAccent();
  React.useLayoutEffect(()=>{applyAccent(accent,customAccent)},[accent,customAccent]);
  return React.createElement(I18nProvider,null,
    React.createElement(ThemeProvider,{attribute:'class',defaultTheme:'light'},
      React.createElement('div',{style:{maxWidth:720,padding:24}},
        React.createElement(AppearanceSection,{accent,onAccentChange:setAccent,uiStyle:'square',onUiStyleChange:()=>{}}))));
}
window.checkRoot=createRoot(document.getElementById('root'));flushSync(()=>window.checkRoot.render(React.createElement(Shell)));
window.token=(name)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
window.read=()=>{
  const well=document.querySelector('[data-accent-custom-well]');
  const picker=document.querySelector('[data-accent-picker]');
  const preview=picker?picker.querySelector('[data-accent-picker-preview]'):null;
  const hex=picker?picker.querySelector('input'):null;
  return {
    accent:document.documentElement.dataset.accent||null,
    storedAccent:(()=>{try{return localStorage.getItem('pi-app:accent')}catch{return null}})(),
    storedCustom:(()=>{try{return localStorage.getItem('pi-app:accent-custom')}catch{return null}})(),
    customVars:Array.from(document.documentElement.style).filter((name)=>name.startsWith('--custom')).sort(),
    primary:window.token('--primary'),
    primaryForeground:window.token('--primary-foreground'),
    ring:window.token('--ring'),
    swatches:Array.from(document.querySelectorAll('button[aria-pressed]')).map((button)=>button.getAttribute('aria-label')),
    well:(()=>{if(!well)return null;const computed=getComputedStyle(well);return{label:well.getAttribute('aria-label'),backgroundImage:computed.backgroundImage,backgroundColor:computed.backgroundColor}})(),
    picker:picker?{preview:preview?getComputedStyle(preview).backgroundColor:null,hex:hex?hex.value:null}:null
  };
};
window.openPicker=()=>{document.querySelector('[data-accent-custom-well]').click();};
window.setPickerHex=(hex)=>{
  const input=document.querySelector('[data-accent-picker] input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,hex);
  input.dispatchEvent(new Event('input',{bubbles:true}));
};
window.pressPickerHue=(fraction)=>{
  const strip=document.querySelector('[data-accent-picker-hue]');
  const rect=strip.getBoundingClientRect();
  strip.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+rect.width*fraction,clientY:rect.top+rect.height/2,pointerId:1}));
};
window.clickPickerControl=(name)=>{document.querySelector('[data-accent-picker-'+name+']').click();};
window.pickerGeometry=()=>{
  const well=document.querySelector('[data-accent-custom-well]');
  const portal=document.querySelector('[data-morph-popover-portal]');
  if(!well||!portal)return null;
  const w=well.getBoundingClientRect();
  const p=portal.getBoundingClientRect();
  return {wellTop:w.top,wellLeft:w.left,pickerBottom:p.bottom,pickerLeft:p.left,visibility:getComputedStyle(portal).visibility};
};
window.escape=()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));};
window.clickPreset=(id)=>{
  const button=Array.from(document.querySelectorAll('button[aria-pressed]')).find((candidate)=>(candidate.getAttribute('aria-label')||'').includes(id));
  if(!button) throw new Error('no preset well for '+id);
  button.click();
};
</script></body></html>`

let child, ws, server
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error',
    cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:860,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  await send('Page.enable')
  const waitFor = async (expression) => { for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await pause(50) } throw new Error('fixture never settled: ' + expression) }
  await waitFor(`!!document.querySelector('[data-accent-custom-well]') && typeof window.read === 'function'`)
  await pause(300)

  const shotDir = process.env.PI_ACCENT_SCREENSHOT_DIR
  const shoot = async (name) => {
    if (!shotDir) return
    const image = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(shotDir, name), Buffer.from(image.data, 'base64'))
  }
  if (shotDir) await mkdir(shotDir, { recursive: true })

  // 1. Default (no stored preference): indigo, twelve hue-wheel swatches plus
  //    the custom well as the hue wheel over the default fill, no inline
  //    tokens, no picker open.
  const initial = await evaluate('window.read()')
  assert.equal(initial.accent, 'indigo', 'fresh profile boots on the default accent')
  assert.equal(initial.storedAccent, null, 'fresh profile has nothing stored yet')
  assert.equal(initial.storedCustom, null)
  assert.equal(initial.swatches.length, 12, 'twelve preset wells render: ' + initial.swatches.join(', '))
  assert.ok(initial.swatches[0].includes('indigo'), 'the hue walk starts at the default')
  assert.ok(initial.well, 'the custom color well renders')
  // The fixture's I18nProvider follows the system locale; both dictionaries
  // must carry the label, so accept either rendering.
  assert.ok(['Custom accent color', '自定义强调色'].includes(initial.well.label), 'the well is labelled through i18n: ' + initial.well.label)
  assert.match(initial.well.backgroundImage, /conic-gradient/, 'the idle custom well is the hue wheel')
  assert.equal(initial.picker, null, 'the picker starts closed')
  assert.deepEqual(initial.customVars, [], 'no inline custom tokens on a preset')
  assert.equal(initial.primary, 'oklch(0.52 0.185 275)', 'indigo light primary from :root')
  assert.equal(initial.ring, initial.primary, 'the ring follows the primary')
  await shoot('light-default.png')

  // 2. A preset (one added with this change) applies its hand-tuned tokens and
  //    persists the id.
  await evaluate(`window.clickPreset('sky')`)
  await pause(150)
  const sky = await evaluate('window.read()')
  assert.equal(sky.accent, 'sky')
  assert.equal(sky.storedAccent, 'sky', 'the preset choice persists')
  assert.equal(sky.primary, 'oklch(0.55 0.13 235)', 'sky light primary from its preset block')
  assert.deepEqual(sky.customVars, [], 'a preset still has no inline custom tokens')

  // 3. Opening the well changes NOTHING yet: the picker is a draft surface.
  //    Typing a hex moves only the preview; Cancel discards it.
  await evaluate(`window.openPicker()`)
  await waitFor(`!!document.querySelector('[data-accent-picker]')`)
  await pause(300)
  const opened = await evaluate('window.read()')
  assert.equal(opened.accent, 'sky', 'opening the picker does not change the accent')
  assert.equal(opened.picker.preview, 'rgb(78, 87, 209)', 'the draft seeds from the remembered (default) fill')
  // The accent group sits low on the Settings page: the panel must open ABOVE
  // the well, or it lands off-viewport and forces a scroll to reach.
  const geometry = await evaluate('window.pickerGeometry()')
  assert.ok(geometry, 'the picker portal mounted')
  assert.equal(geometry.visibility, 'visible')
  assert.ok(geometry.pickerBottom <= geometry.wellTop, 'the picker opens above the well: ' + JSON.stringify(geometry))
  await evaluate(`window.setPickerHex('#ff8800')`)
  await pause(150)
  const typed = await evaluate('window.read()')
  assert.equal(typed.picker.preview, 'rgb(255, 136, 0)', 'the hex edit moves the preview')
  assert.equal(typed.picker.hex, '#ff8800')
  assert.equal(typed.accent, 'sky', 'a draft edit never reaches the accent')
  assert.equal(typed.storedAccent, 'sky')
  assert.equal(typed.storedCustom, null, 'a draft edit never reaches storage')
  assert.deepEqual(typed.customVars, [], 'a draft edit writes no tokens')
  await shoot('light-picker.png')
  await evaluate(`window.clickPickerControl('cancel')`)
  await waitFor(`!document.querySelector('[data-accent-picker]')`)
  await pause(200)
  const cancelled = await evaluate('window.read()')
  assert.equal(cancelled.accent, 'sky', 'cancel keeps the accent')
  assert.equal(cancelled.storedCustom, null, 'cancel discards the draft')

  // 4. Reopening re-seeds (the discard stuck); Escape discards the same way.
  await evaluate(`window.openPicker()`)
  await waitFor(`!!document.querySelector('[data-accent-picker]')`)
  await pause(200)
  assert.equal((await evaluate('window.read()')).picker.preview, 'rgb(78, 87, 209)', 'a discarded draft never leaks into the next open')
  await evaluate(`window.setPickerHex('#00c853')`)
  await pause(150)
  await evaluate(`window.escape()`)
  await waitFor(`!document.querySelector('[data-accent-picker]')`)
  await pause(200)
  const escaped = await evaluate('window.read()')
  assert.equal(escaped.accent, 'sky', 'Escape keeps the accent')
  assert.equal(escaped.storedCustom, null, 'Escape discards the draft')

  // 5. The hue track drags (a press applies immediately), and solely Apply
  //    commits: stores the hex, activates 'custom', writes the four derived
  //    tokens inline — resolved in BOTH modes.
  await evaluate(`window.openPicker()`)
  await waitFor(`!!document.querySelector('[data-accent-picker]')`)
  await pause(200)
  await evaluate(`window.pressPickerHue(0.25)`)
  await pause(150)
  const dragged = await evaluate('window.read()')
  assert.notEqual(dragged.picker.preview, 'rgb(78, 87, 209)', 'the hue track retinted the draft')
  assert.equal(dragged.accent, 'sky', 'a track drag is still a draft')
  await evaluate(`window.setPickerHex('#ff8800')`)
  await pause(150)
  await evaluate(`window.clickPickerControl('apply')`)
  await waitFor(`!document.querySelector('[data-accent-picker]')`)
  await pause(200)
  const applied = await evaluate('window.read()')
  const expected = await evaluate(`window.derive('#ff8800')`)
  assert.equal(applied.accent, 'custom', 'apply activates the custom accent')
  assert.equal(applied.storedAccent, 'custom', 'the custom choice persists')
  assert.equal(applied.storedCustom, '#ff8800', 'the pick persists')
  assert.deepEqual(applied.customVars, ['--custom-primary', '--custom-primary-dark', '--custom-primary-foreground', '--custom-primary-foreground-dark'], 'the four derived tokens land inline')
  assert.equal(applied.primary, expected.lightPrimary, 'light mode resolves the derived light primary')
  assert.equal(applied.primaryForeground, expected.lightForeground, 'light mode resolves the derived foreground')
  assert.equal(applied.ring, applied.primary)
  assert.equal(applied.well.backgroundImage, 'none', 'the active well wears the pick, not the wheel')
  assert.equal(applied.well.backgroundColor, 'rgb(255, 136, 0)')
  await evaluate(`document.documentElement.classList.add('dark')`)
  await pause(100)
  const appliedDark = await evaluate('window.read()')
  assert.equal(appliedDark.primary, expected.darkPrimary, 'dark mode flips to the derived dark primary')
  assert.equal(appliedDark.primaryForeground, expected.darkForeground, 'dark mode flips the foreground')
  await shoot('dark-custom.png')
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await pause(100)

  // 6. Back to a preset: the inline tokens are cleared, the pick remembered.
  await evaluate(`window.clickPreset('rose')`)
  await pause(150)
  const rose = await evaluate('window.read()')
  assert.equal(rose.accent, 'rose')
  assert.deepEqual(rose.customVars, [], 'the custom inline tokens are removed off-custom')
  assert.equal(rose.primary, 'oklch(0.55 0.175 15)')
  assert.equal(rose.storedCustom, '#ff8800', 'the custom pick is remembered while a preset runs')
  assert.match(rose.well.backgroundImage, /conic-gradient/, 'the idle well returns to the hue wheel')

  // 7. Boot path: seed the custom pair, reload — the store's lazy init plus the
  //    layout effect re-derive the inline tokens before the first paint.
  await evaluate(`localStorage.setItem('pi-app:accent','custom')`)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('[data-accent-custom-well]') && typeof window.read === 'function'`)
  await pause(300)
  const rebooted = await evaluate('window.read()')
  const expectedAfterReload = await evaluate(`window.derive('#ff8800')`)
  assert.equal(rebooted.accent, 'custom', 'the custom accent survives the reload')
  assert.equal(rebooted.primary, expectedAfterReload.lightPrimary, 'the boot path re-derives the tokens')
  assert.equal(rebooted.well.backgroundColor, 'rgb(255, 136, 0)', 'the well shows the remembered pick')

  // 8. A garbage accent id falls back to the default preset.
  await evaluate(`localStorage.setItem('pi-app:accent','banana')`)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('[data-accent-custom-well]') && typeof window.read === 'function'`)
  await pause(300)
  const garbage = await evaluate('window.read()')
  assert.equal(garbage.accent, 'indigo', 'a garbage accent id reads as the default')
  assert.equal(garbage.primary, 'oklch(0.52 0.185 275)')

  // 9. A garbage custom hex under 'custom' falls back to the default fill, and
  //    the derived tokens still land (the CSS fallbacks are never needed).
  await evaluate(`localStorage.setItem('pi-app:accent','custom');localStorage.setItem('pi-app:accent-custom','banana')`)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('[data-accent-custom-well]') && typeof window.read === 'function'`)
  await pause(300)
  const garbageHex = await evaluate('window.read()')
  const expectedDefault = await evaluate(`window.derive('#4e57d1')`)
  assert.equal(garbageHex.accent, 'custom')
  assert.equal(garbageHex.primary, expectedDefault.lightPrimary, 'the default fill derives valid tokens')
  assert.equal(garbageHex.well.backgroundColor, 'rgb(78, 87, 209)', 'a garbage hex reads as the default fill')

  // 10. No renderer exceptions through the whole run.
  assert.deepEqual(exceptions, [], 'no renderer exceptions: ' + JSON.stringify(exceptions.map((entry) => entry.exceptionDetails?.exception?.description ?? entry)))

  console.log('check-accent: all assertions passed')
} finally {
  try { ws?.close() } catch { /* already closed */ }
  child?.kill('SIGTERM')
  await server?.close()
}
