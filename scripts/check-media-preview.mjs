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
  await writeFile(join(project, 'tone.wav'), wavFixture())
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
import {I18nProvider} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';import {FileBrowserStore} from '/src/state/file-browser-store.ts';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';
import {mediaUrl as buildMediaUrl} from '/@fs${join(repo, 'src/shared/media.ts')}';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const cwd=${JSON.stringify(project)};
const files=new FileBrowserStore(),pi=new PiStore();
pi.applySnapshot({cwd,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
const App=()=>{const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);return React.createElement(FilesPane,{files,store:pi,filePath:state.active})};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(App))));
window.cwd=cwd;window.files=files;window.en=en;window.zh=zh;
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
  const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
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
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
  const waitFor = async (expression, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await pause(50) } throw new Error('Timeout: ' + label + ' :: ' + await evaluate('document.body.innerText') + ' ' + JSON.stringify(exceptions)) }
  const open = async (name) => { await evaluate(`window.openFile(${JSON.stringify(name)})`); await pause(150) }
  const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(120) }
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
  console.log('PASS: image decodes over the scheme, mounts no view tabs, zoom in/reset drive the transform')

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
  assert.ok(Math.abs(audio.duration - 1) < 0.05, 'wav duration: ' + audio.duration)
  assert.ok(audio.seekable !== null && Math.abs(audio.seekable - audio.duration) < 0.05, 'wav is fully seekable')
  assert.equal(audio.controls, true, 'native controls are mounted')
  await shot('audio')
  console.log('PASS: audio metadata and a seekable range over the scheme')

  if (hasFfmpeg) {
    await open('clip.mp4')
    await waitFor(`document.querySelector('[data-file-media=video] video')?.readyState >= 1`, 'mp4 metadata')
    const video = await evaluate(`(()=>{const v=document.querySelector('[data-file-media=video] video');return {duration:v.duration,seekable:v.seekable.length?v.seekable.end(0):null,w:v.videoWidth,h:v.videoHeight}})()`)
    assert.ok(Math.abs(video.duration - 6) < 0.5, 'mp4 duration: ' + video.duration)
    assert.ok(video.seekable !== null && Math.abs(video.seekable - video.duration) < 0.5, 'mp4 is fully seekable, not a zero-length range')
    assert.deepEqual([video.w, video.h], [320, 180], 'mp4 metadata decodes')
    const seeked = await evaluate(`(async()=>{const v=document.querySelector('[data-file-media=video] video');v.currentTime=4;await new Promise(r=>{v.onseeked=r;setTimeout(r,8000)});await new Promise(r=>setTimeout(r,500));return {time:v.currentTime,frames:v.webkitDecodedFrameCount,readyState:v.readyState}})()`)
    assert.ok(Math.abs(seeked.time - 4) < 0.5, 'the seek lands where it was asked instead of snapping to 0: ' + seeked.time)
    assert.ok(seeked.readyState >= 2, 'the sought frame is available')
    assert.ok(seeked.frames > 0, 'the decoder produced frames: ' + seeked.frames)
    await shot('video')
    console.log('PASS: video is seekable and decodes over the scheme (seek to 4s, ' + seeked.frames + ' frames)')
  } else {
    console.log('SKIP: mp4 seek/decode (no ffmpeg available for the fixture)')
  }

  await open('large.png')
  await waitFor(`document.querySelector('[data-file-media=image] img')?.complete`, 'large png decoded')
  assert.deepEqual(await evaluate(`(()=>{const img=document.querySelector('[data-file-media=image] img');return [img.naturalWidth,img.naturalHeight]})()`), [1200, 1200], 'a multi-megabyte image streams through the scheme')
  // 6. Locale parity, and descriptors after an abort storm.
  const locale = await evaluate(`(()=>{const keys=Object.keys(window.en).filter(k=>k.startsWith('files.media.'));return {keys,missing:keys.filter(k=>typeof window.zh[k]!=='string'),translated:keys.filter(k=>window.zh[k]!==window.en[k]).length}})()`)
  assert.deepEqual(locale.missing, [], 'every media string exists in zh-CN')
  assert.equal(locale.translated, 3, 'media strings are translated, not copied: ' + locale.keys.join(', '))
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
