/** Composer-height scroll following: isolated Electron + real ChatView/Composer.
 *
 * When the composer grows or shrinks with pasted/removed attachments, the
 * transcript viewport above it must keep a reader who is at the live edge
 * pinned to the bottom — instantly — and leave a reader who scrolled away
 * exactly where they were. Covers both directions for the image tray and the
 * file card.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-scroll-'))

// A 1x1 PNG: the image intake only needs bytes a FileReader can decode.
const pngPath = join(temporary, 'attach-a.png')
await writeFile(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
const pngPathB = join(temporary, 'attach-b.png')
await writeFile(pngPathB, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
const txtPath = join(temporary, 'notes.txt')
await writeFile(txtPath, 'attachment scroll check\n')

const fixture = String.raw`<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Composer} from '/src/components/app/Composer.tsx';
import {ChatView} from '/src/components/app/ChatView.tsx';
import {ImagePreviewProvider} from '/src/components/app/ImagePreview.tsx';
import {PiStore} from '/src/state/pi-store.ts';
import {I18nProvider} from '/src/i18n/index.tsx'; import '/src/styles.css';
const h=React.createElement;
localStorage.setItem('pi-app:locale','en');
window.sent=[];
window.plan={seq:1,mode:'normal',planId:null,latest:null,revisionPending:false,approval:null,configuredSandboxMode:'workspace-write',effectiveSandboxMode:'workspace-write',shellEnforcement:'full',blockers:{switch:[],submit:[],approve:[]}};
window.pi={
 setSessionMode:async()=>({ok:true,value:window.plan}),
 searchFiles:async()=>[],queueAction:async()=>{},onBashTask:()=>()=>{},listBashTasks:async()=>[],
 pathForFile:file=>'/tmp/'+file.name,
 readFile:async path=>({path,relPath:'src/'+path.split('/').pop(),kind:'text',size:321}),
 readPlanDocument:async()=>({ok:false,code:'not-found'}),
 approvePlan:async()=>({ok:false,code:'busy',blockers:['busy']}),
 exportPlan:async()=>({ok:true,value:{cancelled:true}})};
window.store=new PiStore();
const turns=[];
for(let i=0;i<28;i++){
 turns.push({role:'user',content:'Question '+i+' — how does the composer attachment tray behave when it grows?',timestamp:1000+i*100});
 turns.push({role:'assistant',timestamp:1050+i*100,stopReason:'stop',content:[{type:'text',text:'Answer '+i+'. The transcript needs enough rows to overflow the viewport so the scroll-following behavior is observable. Padding sentence for turn '+i+'.'}]});
}
window.store.applySnapshot({sessionPath:'/fixture.jsonl',sessionId:'fixture',cwd:'/tmp',projectless:false,model:null,thinkingLevel:'off',isStreaming:false,eventSequence:1,plan:window.plan,messages:turns});
function App(){
 const [plan]=React.useState(window.plan);
 return h(I18nProvider,null,h(ImagePreviewProvider,null,
  h('div',{style:{display:'flex',flexDirection:'column',height:'760px',width:'720px',margin:'0 auto'}},
   h('div',{style:{flex:'1 1 0%',minHeight:0,display:'flex',flexDirection:'column'}},
    h(ChatView,{store:window.store})),
   h(Composer,{models:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],busy:false,plan,sessionPath:'/fixture.jsonl',queued:{steering:[],followUp:[]},onSend:p=>window.sent.push(p),onQueue:p=>window.sent.push(p),onRecallQueue:async()=>[],onModelChange:()=>{},onThinkingLevelChange:()=>{}}))));
}
createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`

let server, app
const errors = []
try {
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temporary, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), { name: 'scroll-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__scroll.html') return next()
        res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__scroll.html', fixture))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const url = server.resolvedUrls.local[0] + '__scroll.html'
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:900,height:900,show:false,webPreferences:{contextIsolation:false}});win.loadURL(${JSON.stringify(url)});});`)
  app = await _electron.launch({ executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(url)
  const viewport = page.locator('[data-slot="message-scroller"] section')
  await viewport.waitFor()
  await page.evaluate(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    window.scrollTrace = []
    const record = kind => {
      window.scrollTrace.push({ kind, at: Math.round(performance.now()), top: v.scrollTop, height: v.scrollHeight, client: v.clientHeight, distance: v.scrollHeight - v.scrollTop - v.clientHeight })
      if (window.scrollTrace.length > 24) window.scrollTrace.shift()
    }
    v.addEventListener('scroll', () => record('scroll'))
    new ResizeObserver(() => record('resize')).observe(v)
  })
  const state = () => page.evaluate(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return { top: v.scrollTop, height: v.scrollHeight, client: v.clientHeight, distance: v.scrollHeight - v.scrollTop - v.clientHeight, thumbs: document.querySelectorAll('form img').length, cards: document.querySelectorAll('[data-attachment-card]').length }
  })
  // A DOM predicate can resolve before ResizeObserver's pre-paint delivery.
  // Sample the first painted frame, after that delivery (no smooth-scroll wait).
  const afterPaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))))
  const scrollTo = (top) => page.evaluate((next) => new Promise(resolve => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    const previous = v.scrollTop
    const painted = () => requestAnimationFrame(() => setTimeout(resolve, 0))
    // Setting scrollTop queues a native scroll event. Delivering a synthetic
    // event first leaves that native event pending until the next resize, when
    // it can mistake the new composer height for the reader scrolling away.
    const onScroll = () => painted()
    v.addEventListener('scroll', onScroll, { once: true })
    v.scrollTop = next
    if (v.scrollTop === previous) {
      v.removeEventListener('scroll', onScroll)
      painted()
    }
  }), top)

  // The transcript overflows and opens pinned to the live edge.
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return v && v.scrollHeight > v.clientHeight && v.scrollHeight - v.scrollTop - v.clientHeight <= 1
  })

  // 1. Following + grow (image paste): the live edge is kept INSTANTLY — the
  // assertion runs after the first paint with the thumbnail, so a delayed or
  // smooth follow-up scroll would still measure the gap.
  await page.setInputFiles('input[accept="image/*"]', pngPath)
  await page.waitForFunction(() => document.querySelectorAll('form img').length === 1)
  await afterPaint()
  const grown = await state()
  assert.ok(grown.distance <= 1, 'at the bottom, an attached image keeps the transcript pinned immediately: ' + JSON.stringify(grown))

  // 2. Away + grow: a reader who scrolled up keeps their exact position.
  await scrollTo(50)
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return v.scrollHeight - v.scrollTop - v.clientHeight > 56
  })
  await page.setInputFiles('input[accept="image/*"]', pngPathB)
  await page.waitForFunction(() => document.querySelectorAll('form img').length === 2)
  await afterPaint()
  const awayGrown = await state()
  assert.equal(awayGrown.top, 50, 'scrolled away, another attachment never moves the scrollbar: ' + JSON.stringify(awayGrown))

  // 3. Following + shrink (removing the last image collapses the tray): still pinned.
  await scrollTo(Number.MAX_SAFE_INTEGER)
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return v.scrollHeight - v.scrollTop - v.clientHeight <= 1
  })
  await page.getByRole('button', { name: 'Remove attach-a.png' }).click()
  await page.getByRole('button', { name: 'Remove attach-b.png' }).click()
  await page.waitForFunction(() => document.querySelectorAll('form img').length === 0)
  await afterPaint()
  const shrunk = await state()
  assert.ok(shrunk.distance <= 1, 'at the bottom, removing the attachments keeps the transcript pinned: ' + JSON.stringify(shrunk))

  // 4. Away + shrink (file card this time): the position is untouched.
  await scrollTo(50)
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return v.scrollHeight - v.scrollTop - v.clientHeight > 56
  })
  await page.setInputFiles('input[type=file]:not([accept])', txtPath)
  await page.waitForFunction(() => document.querySelectorAll('[data-attachment-card]').length === 1)
  await afterPaint()
  const fileGrown = await state()
  assert.equal(fileGrown.top, 50, 'scrolled away, an attached file card never moves the scrollbar: ' + JSON.stringify(fileGrown))
  await page.getByRole('button', { name: 'Remove src/notes.txt' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-attachment-card]').length === 0)
  await afterPaint()
  const fileShrunk = await state()
  assert.equal(fileShrunk.top, 50, 'scrolled away, removing the file card never moves the scrollbar: ' + JSON.stringify(fileShrunk))

  // 5. Back at the live edge, a fresh paste pins again (state machine recovered).
  await scrollTo(Number.MAX_SAFE_INTEGER)
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-slot="message-scroller"] section')
    return v.scrollHeight - v.scrollTop - v.clientHeight <= 1
  })
  await page.setInputFiles('input[accept="image/*"]', pngPath)
  await page.waitForFunction(() => document.querySelectorAll('form img').length === 1)
  await afterPaint()
  const regrown = await state()
  assert.ok(regrown.distance <= 1, 'returning to the bottom re-arms the instant follow: ' + JSON.stringify({ ...regrown, trace: await page.evaluate(() => window.scrollTrace) }))

  // 6. A real wheel gesture leaves follow mode. Shrinking the attachment tray
  // afterward must preserve the reader's position rather than pinning again.
  await viewport.hover()
  await page.mouse.wheel(0, -100_000)
  await page.waitForFunction(() => document.querySelector('[data-slot="message-scroller"] section').scrollTop === 0)
  await afterPaint()
  const wheelAway = await state()
  assert.ok(wheelAway.distance > 56, 'the wheel gesture moved the reader away from the live edge')
  await page.getByRole('button', { name: 'Remove attach-a.png' }).click()
  await page.waitForFunction(() => document.querySelectorAll('form img').length === 0)
  await afterPaint()
  const wheelShrunk = await state()
  assert.equal(wheelShrunk.top, wheelAway.top, 'a real wheel gesture prevents attachment resizing from re-enabling follow: ' + JSON.stringify(wheelShrunk))

  assert.deepEqual(errors, [])
  console.log('PASS: composer attachment resize keeps the transcript pinned at the live edge, untouched when scrolled away')
} finally {
  await app?.close().catch(() => {})
  await server?.close().catch(() => {})
  await rm(temporary, { recursive: true, force: true })
}
