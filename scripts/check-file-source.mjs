/** Real Chromium source wrapping: text fidelity, bounded long-line DOM and find. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-file-source-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, child, ws
try {
  const samples = {
    'AGENTS.md': await readFile(join(repo, 'AGENTS.md'), 'utf8'),
    'unicode.md': '# Unicode\r\n\r\n' + '**中文 😀 café**\tSDK '.repeat(80) + '\r\nlast line',
    'long.json': '{\n"body": "' + 'token '.repeat(60000) + 'NEEDLE ' + 'end '.repeat(1000) + '"\n}\n"last line"',
  }
  const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {FileSource} from '/src/components/app/FileSource.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {FileBrowserStore} from '/src/state/file-browser-store.ts';
import {searchFile} from '/src/lib/file-search.ts';import '/src/styles.css';
window.samples=${JSON.stringify(samples)};window.files=new FileBrowserStore();
window.state={name:'AGENTS.md',wrap:false,search:undefined,visit:0};
const root=createRoot(document.getElementById('root'));
window.show=(patch={})=>{Object.assign(state,patch);const text=samples[state.name];window.sourceText=text;
root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,
React.createElement('div',{id:'pane',style:{width:500,height:720,display:'flex',flexDirection:'column'}},
React.createElement(FileSource,{key:state.mount,text,store:files,tab:{path:'/fixture/'+state.name,cwd:'/fixture',view:'source',visit:state.visit,treeOpen:true,line:state.line},wrap:state.wrap,search:state.search})))))};
window.find=query=>show({search:{result:searchFile(sourceText,query,{matchCase:true,wholeWord:false,regex:false}),current:0}});
show();</script></body></html>`
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'source-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/fixture.html') return next(); try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/fixture.html', fixture)) } catch (error) { next(error) } }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:850,height:850,webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:${server.httpServer.address().port}/fixture.html')});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr)), 15000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code + stderr)) })
    child.stderr.on('data', chunk => { stderr += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find(page => page.type === 'page'); if (!page) await pause(50) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  let seq = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, message => message.error ? reject(message.error) : resolve(message.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value }
  const waitFor = async (expression, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(50) } throw new Error('Timeout: ' + label + JSON.stringify(exceptions)) }
  const fidelity = async () => {
    const result = await evaluate(`(()=>{const lines=sourceText.split('\\n');return [...document.querySelectorAll('[data-source-line]')].map(row=>{const line=lines[+row.dataset.sourceLine-1],text=row.lastElementChild.textContent,offset=+(row.dataset.sourceOffset||0);return {line:+row.dataset.sourceLine,actual:text,expected:line.slice(offset,offset+text.length),missing:!!line&&!text}}).filter(row=>row.missing||row.actual!==row.expected)})()`)
    assert.deepEqual(result, [], 'every mounted source segment preserves its exact original text')
  }
  const highlight = `document.querySelector('[data-file-source] [style*=agent-code-light]')!==null`
  await send('Runtime.enable')
  await waitFor(highlight, 'real Markdown worker tokens')
  await fidelity()
  await evaluate('show({wrap:true})'); await pause(250)
  await fidelity()
  for (const dark of [false, true]) {
    await evaluate(`document.documentElement.classList.toggle('dark',${dark})`)
    for (const width of [360, 650, 500]) {
      await evaluate(`document.getElementById('pane').style.width='${width}px'`); await pause(250)
      await fidelity()
      assert.ok(await evaluate(`(()=>{const s=document.querySelector('[data-file-source]');return s.scrollWidth<=s.clientWidth+1})()`), 'wrapped text fits the pane')
    }
    if (process.env.PI_FILES_SCREENSHOT_DIR) { await mkdir(process.env.PI_FILES_SCREENSHOT_DIR, { recursive: true }); const shot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(process.env.PI_FILES_SCREENSHOT_DIR, `files-wrap-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64')) }
  }
  const coverage = await evaluate(`(async()=>{const s=document.querySelector('[data-file-source]'),lines=sourceText.split('\\n'),covered=lines.map(line=>new Uint8Array(line.length));const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let top=0;top<s.scrollHeight+s.clientHeight;top+=s.clientHeight/2){s.scrollTop=top;await frame();for(const row of s.querySelectorAll('[data-source-line]')){const index=+row.dataset.sourceLine-1,offset=+(row.dataset.sourceOffset||0),text=row.lastElementChild.textContent;if(text!==lines[index].slice(offset,offset+text.length))return 'wrong text on line '+(index+1);covered[index].fill(1,offset,offset+text.length)}}s.scrollTop=0;await frame();return covered.flatMap((chars,index)=>chars.includes(0)?[index+1]:[])})()`)
  assert.deepEqual(coverage, [], 'scrolling the entire wrapped file exposes every original character')
  console.log('PASS: AGENTS.md wrapped token fidelity, resizing and both themes')
  await evaluate(`show({name:'unicode.md',visit:1})`); await pause(300); await waitFor(highlight, 'Unicode tokens'); await fidelity()
  await evaluate(`show({name:'long.json',wrap:false,visit:2})`); await waitFor(highlight, 'long-line tokens'); await pause(250)
  const performance = await evaluate(`new Promise(resolve=>{const start=performance.now(),frames=[];let last=start;const tick=now=>{frames.push(now-last);last=now;if(now-start<600)requestAnimationFrame(tick);else resolve({maxFrame:Math.max(...frames),elements:document.querySelector('[data-file-source]').querySelectorAll('*').length})};requestAnimationFrame(tick);show({wrap:true})})`)
  console.log('PERF: long-line wrap ' + JSON.stringify(performance))
  assert.ok(performance.elements < 2000, 'wrapping a long line mounts only viewport segments')
  // Timing is reported for diagnosis; the dedicated performance group owns
  // timing gates. Shared CI load must not fail this text/windowing contract.
  await fidelity()
  await evaluate('find("NEEDLE")')
  await waitFor(`(()=>{const ranges=CSS.highlights.get('file-search-active');if(!ranges?.size)return false;const r=[...ranges][0],b=r.getBoundingClientRect(),s=document.querySelector('[data-file-source]').getBoundingClientRect();return r.toString()==='NEEDLE'&&b.top>=s.top&&b.bottom<=s.bottom})()`, 'far wrapped match is visible')
  await fidelity()
  await evaluate(`document.getElementById('pane').style.width='380px'`); await pause(250)
  assert.equal(await evaluate(`[...CSS.highlights.get('file-search-active')][0].toString()`), 'NEEDLE', 'resize rebuilds search ranges on segmented text')
  await fidelity()
  await evaluate(`show({search:undefined});document.querySelector('[data-file-source]').scrollTop=1e9`); await pause(150)
  assert.ok(await evaluate(`document.querySelector('[data-file-source]').textContent.includes('last line')`), 'last line remains reachable')
  await evaluate('show({wrap:false})'); await pause(150)
  assert.ok(await evaluate(`document.querySelector('[data-file-source]').textContent.includes('last line')`), 'unwrapping at the end keeps readable content')
  await evaluate(`show({name:'AGENTS.md',wrap:true,line:100,visit:3,mount:1})`); await pause(250)
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('[data-source-line="100"]'),s=document.querySelector('[data-file-source]').getBoundingClientRect();if(!row)return false;const r=row.getBoundingClientRect();return r.top>=s.top&&r.top<s.bottom})()`), 'a cold wrapped mount reveals the requested line after measuring columns')
  assert.deepEqual(exceptions, [])
  console.log('PASS: Unicode/CRLF, bounded long-line wrapping, far-match navigation, resize highlights and end-of-file toggle')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
