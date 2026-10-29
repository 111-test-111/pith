/** Media preview: the `pith-media` Range protocol, real image/video/audio
 * decoding in the app's file pane, image zoom, and unsupported-format handling.
 * Isolated data, no model calls, no network.
 * Run after building: node scripts/check-media-preview.mjs
 * `PI_MEDIA_SCREENSHOT_DIR` retains image/video/audio screenshots. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, copyFile, stat, symlink } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-media-'))
const project = join(temporary, 'project')
const exec = promisify(execFile)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** A 16-bit mono PCM WAV, built by hand so the audio leg needs no tooling. */
function wavFixture(seconds = 1, rate = 8000) {
  const samples = rate * seconds
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]) }
/** An incompressible PNG, so the abort storm has a body that is still streaming
 * when the element is torn down — and so a multi-megabyte image is covered. */
function noisePng(width, height) {
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  let seed = 12345
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[y * stride + 1 + x] = (seed >>> 13) & 0xff }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
let server, child, ws
/** `[fd] n [media] m` samples from the main process, and every document read. */
const samples = []
const docPaths = []
try {
  await mkdir(project)
  await copyFile(join(repo, 'resources/icons/64x64.png'), join(project, 'still.png'))
  await writeFile(join(project, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="#0f0"/></svg>')
  await writeFile(join(project, 'tone.wav'), wavFixture(6))
  await writeFile(join(project, 'broken.wav'), 'not a decodable wave file')
  await writeFile(join(project, 'large.png'), noisePng(1200, 1200))
  await writeFile(join(project, 'notes.txt'), 'plain text source\n')
  // A recognized medium Chromium cannot decode: never read as text, never mounted.
  await writeFile(join(project, 'still.heic'), Buffer.alloc(1024 * 1024, 7))
  if (hasFfmpeg) await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'clip.mp4'], { cwd: project })
  const pngSize = (await stat(join(project, 'still.png'))).size

  // 0. The URL contract both halves share, before anything is spawned: every
  //    awkward file name has to survive encode → Chromium → decode unchanged.
  await build({ entryPoints: [join(repo, 'src/shared/media.ts')], outfile: join(temporary, 'media.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { mediaUrl, mediaPathFromUrl, mediaKindOf, isUnsupportedMedia } = await import(pathToFileURL(join(temporary, 'media.mjs')).href)
  for (const path of ['/Users/me/a b.png', '/tmp/file#25%.png', '/tmp/ünïcode 中文/图?.png', "/tmp/quo'te+plus.png", '/tmp/percent%20name.jpg', 'C:/Users/me/clip.mp4'])
    assert.equal(mediaPathFromUrl(mediaUrl(path)), path, 'URL round trip: ' + path)
  for (const path of ['/tmp/a b.png', '/tmp/file#25%.png', "/tmp/quo'te+plus.png"]) {
    const url = mediaUrl(path)
    // A raw delimiter would truncate the URL; a raw space relies on
    // canonicalization we should not depend on.
    assert.ok(!/[#?]/.test(url), 'no URL delimiter survives in ' + url)
    assert.ok(!/ /.test(url), 'no raw space survives in ' + url)
    assert.equal(decodeURIComponent(new URL(url).pathname), path, 'Chromium reads back the same path from ' + url)
  }
  assert.equal(mediaPathFromUrl('pith-media://mediaX/x.png'), null, 'host prefix is not enough')
  assert.equal(mediaPathFromUrl('pith-media://other/x.png'), null, 'other hosts are rejected')
  assert.equal(mediaPathFromUrl('pith-media://media/%00.png'), null, 'NUL is rejected')
  assert.equal(mediaPathFromUrl('pith-media://media/%E0%A4%A.png'), null, 'invalid escapes are rejected')
  assert.equal(mediaKindOf('/a/b.still.PNG'), 'image', 'extension matching is case-insensitive')
  assert.equal(mediaKindOf('/a/b.mkv'), 'video', 'mkv is previewable')
  assert.equal(mediaKindOf('/a/b.flac'), 'audio', 'flac is previewable')
  assert.equal(mediaKindOf('/a/b.ts'), null, 'an undecodable container is not a media kind')
  // Extensions that are also source must never be claimed as media: a file on
  // the unsupported list can no longer be opened as text at all.
  for (const path of ['/a/b.ts', '/a/b.mts', '/a/b.dts', '/a/b.txt', '/a/b.dat', '/a/b.custom'])
    assert.equal(isUnsupportedMedia(path), false, 'a source/text extension is never media: ' + path)
  assert.equal(isUnsupportedMedia('/a/b.HEIC'), true, 'heic is recognized as unsupported')
  assert.equal(isUnsupportedMedia('/a/b.avi'), true, 'avi is recognized as unsupported')
  assert.equal(isUnsupportedMedia('/a/b.txt'), false, 'text is not reported as unsupported media')
  console.log('PASS: media URL contract (odd names, hosts, escapes) and extension mapping')

  const fixturePath = '/__media_check.html'
  const fixture = `<!doctype html><html lang="en"><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {FilesPane} from '/src/components/app/FilesPane.tsx';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';import {FileBrowserStore} from '/src/state/file-browser-store.ts';import {DebugStore} from '/src/state/debug-store.ts';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';import tw from '/src/i18n/locales/zh-TW.ts';
import {setUiStyle} from '/src/lib/ui-style.ts';import {setReduceMotion} from '/src/lib/reduce-motion.ts';
import {mediaUrl as buildMediaUrl} from '/@fs${join(repo, 'src/shared/media.ts')}';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const cwd=${JSON.stringify(project)};
const files=new FileBrowserStore(),pi=new PiStore(),debug=new DebugStore();
pi.applySnapshot({cwd,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
const App=()=>{window.setLocale=useI18n().setLocale;const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);return React.createElement(FilesPane,{files,store:pi,filePath:state.active,debug})};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(App))));
window.cwd=cwd;window.files=files;window.en=en;window.zh=zh;window.tw=tw;window.setUiStyle=setUiStyle;window.setReduceMotion=setReduceMotion;
window.openFile=name=>files.open(cwd,{path:cwd+'/'+name});
window.mediaUrl=name=>buildMediaUrl(cwd+'/'+name);
// Page JS must not be able to read local bytes through the scheme: the response
// is opaque to the renderer (no supportFetchAPI privilege, no CORS headers).
window.__xorigin=fetch(window.mediaUrl('still.png')).then(()=>'readable',()=>'blocked');
// A player aborts loads constantly (seeking, switching, unmounting), so each
// element here is torn down while its body is still streaming. Media elements
// are used instead of fetch: a custom scheme is not readable by page JS, but
// elements load it for real.
window.__storm=async count=>{const url=window.mediaUrl('large.png');const nodes=[];
  for(let i=0;i<count;i++){const img=new Image();img.src=url+'?n='+i;nodes.push(img)}
  await new Promise(r=>setTimeout(r,150));
  for(const img of nodes)img.removeAttribute('src');
  await new Promise(r=>setTimeout(r,1500));return count};
window.__ready=true;</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'media-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== fixturePath) return next(); try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) } catch (error) { next(error) } }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))

  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain,net,protocol} from 'electron';import fs from 'node:fs';
import {listFileDirectory,readFileDocument} from ${JSON.stringify(join(repo, 'src/main/file-browser.ts'))};
import {registerMediaScheme,installMediaProtocol,mediaRequestHandler} from ${JSON.stringify(join(repo, 'src/main/media-protocol.ts'))};
import {mediaUrl} from ${JSON.stringify(join(repo, 'src/shared/media.ts'))};
registerMediaScheme();
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const project=${JSON.stringify(project)},pngSize=${pngSize};
let mediaRequests=0;
app.whenReady().then(async()=>{
  installMediaProtocol();
  // Count requests without reimplementing the handler, so an abort storm can be
  // shown to have really gone through it.
  protocol.unhandle('pith-media');
  protocol.handle('pith-media',request=>{mediaRequests++;return mediaRequestHandler(request)});
  // The protocol contract is probed from the main process: net.fetch reaches a
  // custom scheme without the renderer's CORS filtering, so status codes and
  // Content-Range are readable exactly as the media elements see them.
  const probe={};
  try{
    const url=mediaUrl(project+'/still.png');
    const full=await net.fetch(url);probe.full=[full.status,full.headers.get('content-type'),Number(full.headers.get('content-length')),full.headers.get('accept-ranges')];probe.fullBytes=(await full.arrayBuffer()).byteLength;
    const ranged=await net.fetch(url,{headers:{Range:'bytes=10-19'}});probe.range=[ranged.status,ranged.headers.get('content-range')];probe.rangeBytes=(await ranged.arrayBuffer()).byteLength;
    const suffix=await net.fetch(url,{headers:{Range:'bytes=-16'}});probe.suffix=[suffix.status,suffix.headers.get('content-range')];probe.suffixBytes=(await suffix.arrayBuffer()).byteLength;
    const past=await net.fetch(url,{headers:{Range:'bytes='+(pngSize+10)+'-'}});probe.past=[past.status,past.headers.get('content-range')];
    probe.text=(await net.fetch(mediaUrl(project+'/notes.txt'))).status;
    probe.otherHost=(await net.fetch(url.replace('pith-media://media/','pith-media://other/'))).status;
    probe.missing=(await net.fetch(mediaUrl(project+'/nope.png'))).status;
    probe.traversal=(await net.fetch('pith-media://media/%2e%2e%2fnotes.txt')).status;
    probe.foreignHost=(await net.fetch('pith-media://mediaX/still.png')).status;
  }catch(error){probe.error=String(error)}
  console.log('[probe]',JSON.stringify(probe));
  ipcMain.handle('app:info',()=>({cwd:project,folders:[project],contextFiles:true,version:'test',bashMaxWaitMs:10000,checkpointsEnabled:false}));
  ipcMain.handle('files:directory',(_,r,offset)=>listFileDirectory(r,offset));
  ipcMain.handle('files:document',(_,r)=>{console.log('[doc]',r.path);return readFileDocument(r)});
  ipcMain.handle('files:gitDiff',()=>({gitRoot:null,patch:'',binary:false}));
  ipcMain.handle('files:saveCopy',()=>({status:'cancelled'}));ipcMain.handle('shell:showInFolder',()=>{});ipcMain.handle('shell:openPath',()=>'');
  setInterval(()=>console.log('[fd]',fs.readdirSync('/dev/fd').length,'[media]',mediaRequests),400);
  // Keep HTML Fullscreen real without starting a macOS Space transition for
  // this hidden test window; its native transition cannot complete offscreen.
  const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false,disableHtmlFullscreenWindowResize:true}});
  w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});
app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })

  child = spawn(electron, [main], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    for (const match of String(chunk).matchAll(/\[fd\] (\d+) \[media\] (\d+)/g)) samples.push({ fds: Number(match[1]), media: Number(match[2]) })
    for (const match of String(chunk).matchAll(/\[doc\] (.+)/g)) docPaths.push(match[1].trim())
  })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ' ' + stderr)) })
    child.stderr.on('data', (chunk) => { stderr += chunk; const match = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pendingMessages = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id) { pendingMessages.get(m.id)?.(m); pendingMessages.delete(m.id) } else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pendingMessages.set(id, (m) => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression, userGesture = false) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
  await send('Runtime.enable')
  const waitFor = async (expression, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await pause(50) } await shot('failure'); throw new Error('Timeout: ' + label + ' :: ' + await evaluate(`JSON.stringify({text:document.body.innerText,media:Array.from(document.querySelectorAll('audio,video')).map(m=>({time:m.currentTime,volume:m.volume,paused:m.paused,error:m.error?.message})),controls:Array.from(document.querySelectorAll('[data-media-controls] [role="slider"]')).map(s=>{const r=s.parentElement.getBoundingClientRect();return {label:s.getAttribute('aria-label'),value:s.getAttribute('aria-valuenow'),rect:{x:r.x,y:r.y,w:r.width,h:r.height},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,300)}})})`) + ' ' + JSON.stringify(exceptions)) }
  const open = async (name) => { await evaluate(`window.openFile(${JSON.stringify(name)})`); await pause(150) }
  const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, true); await pause(120) }
  const sliderKey = async (label, key, code) => {
    await evaluate(`document.querySelector('[data-media-controls] [role="slider"][aria-label=${JSON.stringify(label)}]').focus()`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  const dragSlider = async (label, from, to) => {
    const rect = await evaluate(`(()=>{const r=document.querySelector('[data-media-controls] [role="slider"][aria-label=${JSON.stringify(label)}]').parentElement.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`)
    const at = ratio => ({ x: rect.x + rect.w * ratio, y: rect.y + rect.h / 2 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at(from) })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...at(to) })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at(to) })
  }
  const shot = async (name) => { const dir = process.env.PI_MEDIA_SCREENSHOT_DIR; if (!dir) return; await mkdir(dir, { recursive: true }); const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(dir, name + '.png'), Buffer.from(image.data, 'base64')) }

  await waitFor('window.__ready', 'fixture ready')

  // 1. Protocol: the exact Range contract the media elements depend on. A 200
  //    with no Content-Range is what makes `<video>` unseekable, so every form
  //    the element sends is pinned here.
  const probeLine = stdout.split('\n').find((line) => line.startsWith('[probe]'))
  assert.ok(probeLine, 'the protocol probe reported: ' + stdout.slice(0, 400) + stderr.slice(0, 400))
  const probe = JSON.parse(probeLine.slice('[probe]'.length))
  assert.ok(!probe.error, 'protocol probe ran without throwing: ' + probe.error)
  assert.deepEqual(probe.full.slice(0, 4), [200, 'image/png', pngSize, 'bytes'], 'plain read: 200 + exact type + length + accept-ranges')
  assert.equal(probe.fullBytes, pngSize, 'plain read returns the whole file')
  assert.deepEqual(probe.range, [206, `bytes 10-19/${pngSize}`], 'byte range answer')
  assert.equal(probe.rangeBytes, 10, 'byte range returns exactly those bytes')
  assert.deepEqual(probe.suffix, [206, `bytes ${pngSize - 16}-${pngSize - 1}/${pngSize}`], 'suffix range answer')
  assert.equal(probe.suffixBytes, 16, 'suffix range returns exactly those bytes')
  assert.deepEqual(probe.past, [416, `bytes */${pngSize}`], 'out-of-range is 416')
  assert.equal(probe.text, 403, 'a non-media extension is refused, not served')
  assert.equal(probe.otherHost, 400, 'another host is refused')
  assert.equal(probe.missing, 404, 'a missing file is 404')
  assert.equal(probe.traversal, 403, 'a non-media file cannot be smuggled in behind `..`')
  assert.equal(probe.foreignHost, 400, 'a host that merely starts with the real one is refused')
  assert.equal(await evaluate('window.__xorigin'), 'blocked', 'renderer JS cannot read local bytes through the scheme')
  console.log('PASS: Range protocol (200/206/suffix/416), non-media 403, host 400, traversal 400, missing 404, renderer read blocked')

  // 2. Images: decoded by Chromium, zoomed through the shared hook.
  await open('still.png')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.complete`, 'png decoded')
  const image = await evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');return {w:img.naturalWidth,h:img.naturalHeight,src:img.getAttribute('src'),tabs:document.querySelectorAll('[data-file-preview] [role=tab]').length}})()`)
  assert.equal(image.w, 64, 'png natural width')
  assert.equal(image.h, 64, 'png natural height')
  assert.ok(image.src.startsWith('pith-media://media/'), 'the image loads through the media scheme: ' + image.src)
  assert.equal(image.tabs, 0, 'a media tab has no source/preview/diff row')
  assert.ok(!docPaths.includes(join(project, 'still.png')), 'media is never read as a text document')
  const zoomed = async () => evaluate(`(()=>{const box=document.querySelector('[data-file-media=image]');return {percent:box.querySelector('[aria-label="Reset zoom"]').textContent,scale:new DOMMatrixReadOnly(getComputedStyle(box.querySelector('img')).transform).a,cursor:getComputedStyle(box).cursor}})()`)
  await click('[data-file-media=image] [aria-label="Zoom in"]')
  await pause(600)
  const afterZoom = await zoomed()
  assert.equal(afterZoom.percent, '160%', 'zoom-in steps the zoom')
  assert.ok(afterZoom.scale > 1.5, 'the image is really scaled: ' + afterZoom.scale)
  assert.equal(afterZoom.cursor, 'grab', 'a zoomed image is pannable')
  await shot('image-zoomed')
  await click('[data-file-media=image] [aria-label="Reset zoom"]')
  await pause(600)
  const afterReset = await zoomed()
  assert.equal(afterReset.percent, '100%', 'reset returns to fit')
  assert.ok(Math.abs(afterReset.scale - 1) < 0.02, 'the reset transform is at fit: ' + afterReset.scale)
  await shot('image-fit')
  // The range reaches below fit: two steps down reach half size, which stops
  // zoom-out without disabling reset (off fit is not the same as pannable).
  await click('[data-file-media=image] [aria-label="Zoom out"]')
  await pause(600)
  await click('[data-file-media=image] [aria-label="Zoom out"]')
  await pause(600)
  const shrunk = await zoomed()
  assert.equal(shrunk.percent, '50%', 'zoom-out reaches half the fit size')
  assert.ok(Math.abs(shrunk.scale - 0.5) < 0.02, 'the image is really shrunk: ' + shrunk.scale)
  assert.equal(shrunk.cursor, 'zoom-in', 'a shrunk image offers no pan')
  assert.equal(await evaluate(`document.querySelector('[data-file-media=image] [aria-label="Zoom out"]').disabled`), true, 'the floor disables further zoom-out')
  assert.equal(await evaluate(`document.querySelector('[data-file-media=image] [aria-label="Reset zoom"]').disabled`), false, 'a shrunk image can still reset')
  await shot('image-shrunk')
  // The picture carries the app's radius step, and the base `corner-shape` rule
  // turns that radius into a continuous corner: hard-edged in the square style,
  // a superellipse (never a circular arc) in the squircle style.
  await click('[data-file-media=image] [aria-label="Reset zoom"]')
  await pause(600)
  const imageCorners = async () => evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');const root=getComputedStyle(document.documentElement);return {radius:getComputedStyle(img).borderTopLeftRadius,shape:getComputedStyle(img).cornerShape,step:root.getPropertyValue('--app-radius-window').trim(),corners:document.documentElement.dataset.corners||'(none)'}})()`)
  const originalCorners = await evaluate(`document.documentElement.dataset.corners || ''`)
  await evaluate(`document.documentElement.dataset.corners='square'`)
  await pause(400)
  const squareImage = await imageCorners()
  assert.equal(squareImage.step, '0px', 'the square preset collapses the window step')
  assert.equal(squareImage.radius, '0px', `the square style leaves the picture hard-edged: ${squareImage.radius}`)
  assert.equal(squareImage.shape, 'superellipse(2)', `the picture carries the app's corner shape: ${squareImage.shape}`)
  await evaluate(`document.documentElement.dataset.corners='squircle'`)
  await pause(400)
  const squircleImage = await imageCorners()
  assert.equal(squircleImage.step, '28px', 'the squircle preset really moved the window step')
  assert.equal(squircleImage.radius, '28px', `the squircle style rounds the picture: ${squircleImage.radius}`)
  assert.equal(squircleImage.shape, 'superellipse(2)', 'the rounded corner is a superellipse, not a circular arc')
  // The floor is the point of the choice: macOS window corners are 26pt on Tahoe
  // (20 on the next release, 10 before those), and a CSS px is a point there.
  assert.ok(parseFloat(squircleImage.radius) >= 26, `the picture is never less round than the macOS window corner: ${squircleImage.radius}`)
  await shot('image-squircle')
  await evaluate(originalCorners ? `document.documentElement.dataset.corners=${JSON.stringify(originalCorners)}` : `delete document.documentElement.dataset.corners`)
  console.log('PASS: image decodes over the scheme, mounts no view tabs, zoom in/reset/shrink-to-50% drive the transform, corners follow the interface style')

  // Diagonal swipes pan both axes, including accelerated trackpad momentum.
  await open('large.png')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.naturalWidth===1200`, 'large image decoded for gesture checks')
  await click('[data-file-media=image] [aria-label="Zoom in"]')
  await click('[data-file-media=image] [aria-label="Zoom in"]')
  await pause(600)
  const imageView=()=>evaluate(`(()=>{const box=document.querySelector('[data-file-media=image]'),m=new DOMMatrixReadOnly(getComputedStyle(box.querySelector('img')).transform);return {scale:m.a,x:m.e,y:m.f,percent:box.querySelector('[aria-label="Reset zoom"]').textContent}})()`)
  const imageWheel=events=>evaluate(`(()=>{const box=document.querySelector('[data-file-media=image]'),r=box.getBoundingClientRect();for(const event of ${JSON.stringify(events)})box.dispatchEvent(new WheelEvent('wheel',{...event,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}))})()`)
  const beforeSwipe=await imageView()
  await imageWheel([{deltaX:8,deltaY:6},{deltaX:6,deltaY:9},{deltaX:90,deltaY:100}])
  await pause(600)
  const horizontalSwipe=await imageView()
  assert.equal(horizontalSwipe.percent,beforeSwipe.percent,'horizontal image swipe never turns into zoom during momentum')
  assert(horizontalSwipe.x<beforeSwipe.x-90,'horizontal image swipe pans')
  assert(horizontalSwipe.y<beforeSwipe.y-90,'the same image swipe also pans vertically')
  await imageWheel([{deltaX:6,deltaY:8},{deltaX:9,deltaY:6},{deltaX:100,deltaY:90}])
  await pause(600)
  const verticalSwipe=await imageView()
  assert.equal(verticalSwipe.percent,horizontalSwipe.percent,'vertical swipe retains pan mode while accelerating')
  assert(verticalSwipe.y<horizontalSwipe.y-90,'vertical image swipe pans')
  assert(verticalSwipe.x<horizontalSwipe.x-90,'the same image swipe also pans horizontally')
  await imageWheel([{deltaX:100,deltaY:-10,ctrlKey:true}])
  await pause(600)
  const pinched=await imageView()
  assert(pinched.scale>verticalSwipe.scale,'pinch overrides scrolling and zooms the image')
  await imageWheel([{deltaX:0,deltaY:-120}])
  await pause(600)
  assert((await imageView()).scale>pinched.scale,'a vertical notched mouse wheel still zooms')
  console.log('PASS: image free diagonal panning, accelerated momentum, pinch and notched wheel zoom')

  // 3. Another decodable image format, and a recognized format with no decoder.
  await open('vector.svg')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.complete`, 'svg decoded')
  const svg = await evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');return [img.naturalWidth,img.naturalHeight]})()`)
  assert.deepEqual(svg, [48, 24], 'svg decodes as an image')
  await open('still.heic')
  await waitFor(`document.querySelector('[data-file-preview]')?.innerText.includes(window.en['files.media.unsupported'])`, 'unsupported notice')
  const heic = await evaluate(`(()=>({media:document.querySelectorAll('[data-file-media]').length,tabs:document.querySelectorAll('[data-file-preview] [role=tab]').length}))()`)
  assert.equal(heic.media, 0, 'no media view for an unsupported format')
  assert.equal(heic.tabs, 0, 'no view tabs for an unsupported medium')
  assert.ok(!docPaths.includes(join(project, 'still.heic')), 'a recognized non-previewable medium is never read as text')
  console.log('PASS: svg decodes; an unsupported recognized format shows the notice and is never read as text')

  // 4. Text keeps the old path (regression guard for the media branch).
  await open('notes.txt')
  await waitFor(`document.querySelectorAll('[data-file-preview] [role=tab]').length > 0`, 'text tabs')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-media]').length`), 0, 'a text file still renders its source view')
  assert.ok(docPaths.includes(join(project, 'notes.txt')), 'a text file is still read as a document')
  console.log('PASS: text files still read as documents and show their view tabs')

  // 5. Audio and video: metadata, seekability and a decoded frame through the
  //    protocol — the whole point of the hand-written Range handler.
  await open('tone.wav')
  await waitFor(`document.querySelector('[data-file-media=audio] audio')?.duration > 0`, 'wav metadata')
  const audio = await evaluate(`(()=>{const a=document.querySelector('[data-file-media=audio] audio');return {duration:a.duration,seekable:a.seekable.length?a.seekable.end(0):null,controls:a.controls}})()`)
  assert.ok(Math.abs(audio.duration - 6) < 0.05, 'wav duration: ' + audio.duration)
  assert.ok(audio.seekable !== null && Math.abs(audio.seekable - audio.duration) < 0.05, 'wav is fully seekable')
  assert.equal(audio.controls, false, 'the native control bar is replaced')
  const audioElement = 'document.querySelector("[data-file-media=audio] audio")'
  await waitFor(`document.querySelector('[data-media-controls] [aria-label="Play"]')?.disabled === false`, 'audio play control ready')
  await sliderKey('Playback position', 'ArrowRight', 39)
  await waitFor(`${audioElement}.currentTime > 0.05`, 'keyboard seek changes the media time')
  await dragSlider('Playback position', 0.2, 0.65)
  await waitFor(`Math.abs(${audioElement}.currentTime - 3.9) < 0.15`, 'pointer dragging seeks the audio')
  assert.equal(await evaluate(`${audioElement}.paused`), true, 'seeking a paused player leaves it paused')
  await dragSlider('Volume', 0.9, 0.5)
  await waitFor(`Math.abs(${audioElement}.volume - 0.5) < 0.02`, 'pointer volume control changes the media volume')
  await click('[data-media-controls] [aria-label="Mute"]')
  assert.equal(await evaluate(`${audioElement}.muted`), true, 'mute controls the media element')
  await click('[data-media-controls] [aria-label="Unmute"]')
  assert.equal(await evaluate(`${audioElement}.volume`), 0.5, 'unmute retains the previous volume')
  await sliderKey('Volume', 'Home', 36)
  await waitFor(`${audioElement}.volume === 0 && ${audioElement}.muted`, 'zero volume is muted')
  await click('[data-media-controls] [aria-label="Unmute"]')
  assert.equal(await evaluate(`${audioElement}.volume`), 0.5, 'unmute from zero restores the last audible volume')
  await click('[data-media-controls] [aria-label="Playback speed"]')
  await evaluate(`Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find(n=>n.textContent.trim()==='1.5×').click()`, true)
  await waitFor(`${audioElement}.playbackRate === 1.5`, 'speed picker changes the playback rate')

  // An admission failure from play() remains recoverable, with no false
  // playing indicator or unhandled rejection.
  await evaluate(`window.realPlay=${audioElement}.play;${audioElement}.play=()=>Promise.reject(new DOMException('Denied','NotAllowedError'))`)
  await click('[data-media-controls] [aria-label="Play"]')
  await waitFor(`document.querySelector('[data-media-controls] [role="alert"]')?.textContent === window.en['files.media.playFailed']`, 'play rejection is visible')
  assert.equal(await evaluate(`${audioElement}.paused`), true, 'a rejected play does not show a playing state')
  await evaluate(`${audioElement}.play=window.realPlay`)
  await sliderKey('Playback position', 'Home', 36)
  await click('[data-media-controls] [aria-label="Play"]')
  await waitFor(`${audioElement}.currentTime > 0.1 && !${audioElement}.paused`, 'play button starts actual audio playback')
  await click('[data-media-controls] [aria-label="Pause"]')
  assert.equal(await evaluate(`${audioElement}.paused`), true, 'pause stops playback')
  assert.equal(await evaluate(`document.querySelector('[data-media-controls] [role="alert"]')`), null, 'successful retry clears the play failure')
  await evaluate(`${audioElement}.currentTime=5.9`)
  await click('[data-media-controls] [aria-label="Play"]')
  await waitFor(`${audioElement}.ended && document.querySelector('[data-media-controls] [aria-label="Play"]')`, 'completion returns to the play control')
  await click('[data-media-controls] [aria-label="Play"]')
  await waitFor(`${audioElement}.currentTime < 2 && !${audioElement}.paused`, 'play after the end restarts from zero')
  await click('[data-media-controls] [aria-label="Pause"]')

  // Query the pane width through CSS while retaining the exact media element.
  await evaluate(`window.retainedMedia=${audioElement};window.retainedTime=${audioElement}.currentTime;window.originalPaneStyle=document.querySelector('[data-files-pane]').getAttribute('style');document.querySelector('[aria-label="Hide file tree"]')?.click()`)
  const controlsFit = async () => evaluate(`(()=>{const c=document.querySelector('[data-media-controls]'),r=c.getBoundingClientRect();return Array.from(c.querySelectorAll('button,[role="slider"]')).filter(n=>!n.closest('[aria-hidden="true"]')).every(n=>{const b=n.getBoundingClientRect();return b.width>0&&b.x>=r.x-1&&b.right<=r.right+1})})()`)
  for (const width of [220, 320, 720]) {
    await evaluate(`document.querySelector('[data-files-pane]').style.width='${width}px';document.querySelector('[data-files-pane]').style.height='620px'`)
    await pause(150)
    assert.ok(await controlsFit(), `every playback control fits a ${width}px pane`)
    assert.equal(await evaluate(`${audioElement}===window.retainedMedia`), true, 'resize retains the audio element')
    assert.ok(await evaluate(`Math.abs(${audioElement}.currentTime-window.retainedTime)<0.01`), 'resize retains the paused position')
    await shot('audio-' + width)
  }
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const dictionary = locale === 'en' ? 'en' : locale === 'zh-CN' ? 'zh' : 'tw'
    await evaluate(`window.setLocale(${JSON.stringify(locale)})`)
    await waitFor(`document.querySelector('[data-media-controls] [role="slider"]').getAttribute('aria-label')===window.${dictionary}['files.media.seek']`, 'live localized controls: ' + locale)
    assert.equal(await evaluate(`${audioElement}===window.retainedMedia`), true, 'locale changes retain the media element')
    await shot('audio-' + locale)
  }
  for (const style of ['square', 'squircle']) {
    await evaluate(`window.setUiStyle(${JSON.stringify(style)});document.documentElement.classList.toggle('dark',${style === 'squircle'});window.setReduceMotion(true)`)
    await pause(150)
    assert.ok(await controlsFit(), 'controls remain reachable in ' + style)
    await shot('audio-' + style)
  }
  await evaluate(`window.setUiStyle('square');window.setReduceMotion(false);document.documentElement.classList.remove('dark');const pane=document.querySelector('[data-files-pane]');if(window.originalPaneStyle===null)pane.removeAttribute('style');else pane.setAttribute('style',window.originalPaneStyle)`)
  await shot('audio')
  console.log('PASS: audio metadata, real play/pause/replay, pointer and keyboard seeking/volume, mute restoration, speed, recoverable play rejection, responsive controls and live locales/themes')

  await open('broken.wav')
  await waitFor(`document.querySelector('[data-file-preview] [role="status"]')?.textContent.includes(window.en['files.media.failed'])`, 'decode failure notice')
  assert.equal(await evaluate(`document.querySelector('[data-media-controls]')`), null, 'decode failure removes unusable controls')

  if (hasFfmpeg) {
    await open('clip.mp4')
    await waitFor(`document.querySelector('[data-file-media=video] video')?.readyState >= 1`, 'mp4 metadata')
    const video = await evaluate(`(()=>{const v=document.querySelector('[data-file-media=video] video');return {duration:v.duration,seekable:v.seekable.length?v.seekable.end(0):null,w:v.videoWidth,h:v.videoHeight,controls:v.controls}})()`)
    assert.ok(Math.abs(video.duration - 6) < 0.5, 'mp4 duration: ' + video.duration)
    assert.ok(video.seekable !== null && Math.abs(video.seekable - video.duration) < 0.5, 'mp4 is fully seekable, not a zero-length range')
    assert.deepEqual([video.w, video.h], [320, 180], 'mp4 metadata decodes')
    assert.equal(video.controls, false, 'video uses the shared beUI control bar')
    const seeked = await evaluate(`(async()=>{const v=document.querySelector('[data-file-media=video] video');v.currentTime=4;await new Promise(r=>{v.onseeked=r;setTimeout(r,8000)});await new Promise(r=>setTimeout(r,500));return {time:v.currentTime,frames:v.webkitDecodedFrameCount,readyState:v.readyState}})()`)
    assert.ok(Math.abs(seeked.time - 4) < 0.5, 'the seek lands where it was asked instead of snapping to 0: ' + seeked.time)
    assert.ok(seeked.readyState >= 2, 'the sought frame is available')
    assert.ok(seeked.frames > 0, 'the decoder produced frames: ' + seeked.frames)
    await sliderKey('Playback position', 'Home', 36)
    await click('[data-media-controls] [aria-label="Mute"]')
    await click('[data-media-controls] [aria-label="Play"]')
    await waitFor(`document.querySelector('video').currentTime>0.1&&!document.querySelector('video').paused`, 'beUI video play control starts playback')
    await click('[data-media-controls] [aria-label="Pause"]')
    await evaluate(`window.retainedVideo=document.querySelector('video');window.videoPosition=window.retainedVideo.currentTime`)
    await click('[data-media-controls] [aria-label="Full screen"]')
    await waitFor(`document.fullscreenElement?.classList.contains('file-media-player')`, 'full screen includes the controls')
    await click('[data-media-controls] [aria-label="Playback speed"]')
    assert.equal(await evaluate(`document.fullscreenElement.contains(document.querySelector('.file-media-speed [role="listbox"]'))`), true, 'full-screen speed options remain in the visible surface')
    await evaluate(`Array.from(document.fullscreenElement.querySelectorAll('[role="option"]')).find(n=>n.textContent.trim()==='2×').click()`, true)
    await waitFor(`document.querySelector('video').playbackRate===2`, 'full-screen speed picker works')
    await shot('video-fullscreen')
    await click('[data-media-controls] [aria-label="Exit full screen"]')
    await waitFor(`document.fullscreenElement===null`, 'exit full screen')
    assert.equal(await evaluate(`document.querySelector('video')===window.retainedVideo`), true, 'full-screen transitions retain the video element')
    assert.ok(await evaluate(`Math.abs(document.querySelector('video').currentTime-window.videoPosition)<0.01`), 'full-screen transitions retain the paused position')
    assert.ok(await controlsFit(), 'video controls fit after exiting full screen')
    await shot('video')
    console.log('PASS: video is seekable and decodes over the scheme (seek to 4s, ' + seeked.frames + ' frames)')
  } else {
    console.log('SKIP: mp4 seek/decode (no ffmpeg available for the fixture)')
  }

  await open('large.png')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.complete`, 'large png decoded')
  assert.deepEqual(await evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');return [img.naturalWidth,img.naturalHeight]})()`), [1200, 1200], 'a multi-megabyte image streams through the scheme')
  // 6. Locale parity, and descriptors after an abort storm.
  const locale = await evaluate(`(()=>{const keys=Object.keys(window.en).filter(k=>k.startsWith('files.media.'));return {keys,missing:keys.filter(k=>typeof window.zh[k]!=='string'||typeof window.tw[k]!=='string'),translated:keys.filter(k=>window.zh[k]!==window.en[k]&&window.tw[k]!==window.en[k]).length}})()`)
  assert.deepEqual(locale.missing, [], 'every media string exists in both Chinese dictionaries')
  assert.equal(locale.translated, locale.keys.length, 'media strings are translated, not copied: ' + locale.keys.join(', '))
  assert.ok(samples.length > 2, 'the main process reports its descriptor count')
  const before = samples[samples.length - 1]
  const storm = await evaluate('window.__storm(300)')
  assert.equal(storm, 300, 'the abort storm ran')
  await pause(1200)
  const after = samples[samples.length - 1]
  assert.ok(after.media - before.media >= 250, `aborted loads really reached the handler (${before.media} → ${after.media})`)
  assert.ok(after.fds <= before.fds + 8, `aborted streams must not leak descriptors (${before.fds} → ${after.fds})`)
  // The handler is still healthy afterwards.
  await open('still.png')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.complete`, 'image after the storm')
  console.log(`PASS: locales complete; ${after.media - before.media} aborted media loads left descriptors stable (${before.fds} → ${after.fds})`)

  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log('\nmedia preview check passed')
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
