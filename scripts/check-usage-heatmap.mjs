/**
 * Settings → Usage → Token activity now renders its daily calendar through
 * beUI's `heat-calendar`: same usage-view pipeline, peak-relative intensities,
 * localized readout, and the daily grid is the only view (no switcher, no
 * weekly blocks). This runs the real panel in isolated Electron with a stub
 * stats DTO and checks the grid geometry, the exact counts, the localized
 * tooltip, that a hover animates only the hovered particle, that every chart
 * dot lies on its curve and that the readout follows the pointer. No model
 * calls, no user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-usage-heat-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixturePath = '/__usage-heat-check.html'
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import {TokenActivityPanel} from '/src/components/app/settings/usage/TokenActivityPanel.tsx';
import {UsageTrendsPanel} from '/src/components/app/settings/usage/UsageTrendsPanel.tsx';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const day=(tokens)=>({tokens,cost:0,requests:1});
window.stats={generatedAt:Date.now(),firstDay:'2026-09-01',lastDay:'2026-09-15',
 models:[{key:'a/b',provider:'a',model:'b',days:{'2026-09-01':day(100),'2026-09-10':day(500),'2026-09-15':day(250)},totalTokens:850,totalCost:0,totalRequests:3}],
 totalTokens:850,totalCost:0,totalRequests:3,records:[
  {startTs:Date.UTC(2026,8,10,1,0),endTs:Date.UTC(2026,8,10,1,5),models:[{provider:'a',model:'b',tokens:600}],requests:2,tokens:600,cost:0.01},
  {startTs:Date.UTC(2026,8,14,2,0),endTs:Date.UTC(2026,8,14,2,9),models:[{provider:'a',model:'b',tokens:150},{provider:'a',model:'c',tokens:100}],requests:3,tokens:250,cost:0.02}
 ],recordsTruncated:false};
function Fixture(){const {setLocale}=useI18n();window.setLocale=setLocale;return React.createElement('div',{style:{width:900,padding:20}},React.createElement(TokenActivityPanel,{stats:window.stats,today:'2026-09-15'}),React.createElement('div',{style:{height:16}}),React.createElement(UsageTrendsPanel,{stats:window.stats,today:'2026-09-15'}))}
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
window.fixtureReady=true;
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
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:900,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`)});});app.on('window-all-closed',()=>app.quit());`)
  child = spawn(electron, [main], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]) }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  assert(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), exceptions = []
  ws.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) } if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Runtime.enable')
  const waitFor = async (expression) => { for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100) } throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(exceptions)) }
  const screenshot = async (name) => {
    if (!process.env.PI_USAGE_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_USAGE_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_USAGE_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }

  await waitFor('window.fixtureReady && document.querySelectorAll("[data-heat-cell]").length > 300')
  const cells = await evaluate(`document.querySelectorAll('[data-heat-cell]').length`)
  assert.ok(cells >= 357 && cells <= 371, 'a whole Monday-first week grid is rendered: ' + cells)
  const labels = await evaluate(`Array.from(document.querySelectorAll('[data-heat-cell]')).map(c=>c.getAttribute('aria-label'))`)
  assert.ok(labels.some((l) => l.startsWith('500 ')), 'the peak day carries its exact token count: ' + labels.find((l) => l.includes('500')))
  assert.ok(labels.some((l) => l.startsWith('100 ')) && labels.some((l) => l.startsWith('250 ')), 'every nonzero day keeps its count')
  assert.ok(labels.some((l) => l.startsWith('0 ')), 'idle days render as empty contribution cells')
  // Future days stay out of the grid: 2026-09-15 is a Tuesday, so the last
  // (Monday-first) column ends at day index 1.
  const edge = await evaluate(`(()=>{const cells=[...document.querySelectorAll('[data-heat-cell]')].map(c=>c.getAttribute('data-heat-cell').split('-').map(Number));const maxW=Math.max(...cells.map(c=>c[0]));return{maxD:Math.max(...cells.filter(c=>c[0]===maxW).map(c=>c[1]))}})()`)
  assert.equal(edge.maxD, 1, 'future days are not rendered')

  // The localized readout hangs off the cell on hover.
  await evaluate(`(()=>{const cell=[...document.querySelectorAll('[data-heat-cell]')].find(c=>c.getAttribute('aria-label').startsWith('500 '));cell.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}));cell.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))})()`)
  await waitFor(`document.querySelector('[data-heat-tooltip]')`)
  const english = await evaluate(`document.querySelector('[data-heat-tooltip]').textContent`)
  assert.match(english, /500/, 'the tooltip reads the exact count')
  await evaluate(`window.setLocale('zh-CN')`)
  await waitFor(`document.querySelector('[data-heat-tooltip]') && /Token/.test(document.querySelector('[data-heat-tooltip]').textContent)`)
  const chinese = await evaluate(`document.querySelector('[data-heat-tooltip]').textContent`)
  assert.match(chinese, /500/, 'the zh-CN tooltip keeps the count')
  assert.match(chinese, /：/, 'the tooltip is composed from the app dictionary, not vendored English')
  // The calendar's own month labels follow the interface language too: the
  // vendored formatters were pinned to en-US, which left the daily header
  // English inside a localized interface.
  const monthLabels = async () => evaluate(`(()=>{const grid=document.querySelector('[data-heat-cell]').closest('.grid');return [...grid.children].filter(node=>node.tagName==='SPAN'&&getComputedStyle(node).gridRow==='1').map(node=>node.textContent)})()`)
  const zhMonths = await monthLabels()
  assert.ok(zhMonths.length > 0 && zhMonths.every((month) => /月/.test(month)), 'the daily month labels are localized: ' + zhMonths.join(','))
  await screenshot('daily-zh')
  await evaluate(`window.setLocale('en')`)
  const enMonths = await monthLabels()
  assert.ok(enMonths.some((month) => /^[A-Z][a-z]{2}$/.test(month)), 'and back to English when the interface is: ' + enMonths.join(','))
  // The daily grid is the only view: the daily/weekly switcher is gone with it.
  assert.equal(
    await evaluate(`[...document.querySelectorAll('button')].filter((b)=>/^(Daily|Weekly|按日|按周)$/.test(b.textContent.trim())).length`),
    0,
    'the daily/weekly switcher is gone'
  )
  assert.equal(await evaluate(`document.querySelectorAll('[data-activity-week]').length`), 0, 'the weekly blocks are gone')

  // Hover treatment: the header carries its month labels and the hovered
  // particle is the ONLY particle that reacts. It recolours and draws a
  // highlight ring that hugs its own shape — it must not grow, and every
  // neighbour must stay untouched.
  const dailyLabels = await evaluate(`(()=>{const grid=document.querySelector('[data-heat-cell]').closest('.grid');return [...grid.children].filter(node=>node.tagName==='SPAN'&&getComputedStyle(node).gridRow==='1').length})()`)
  assert.ok(dailyLabels > 0, 'the daily header carries month labels')
  // Let the entrance wave land before measuring a hover.
  await waitFor(`(()=>{const cells=[...document.querySelectorAll('[data-heat-cell]')];const visual=cells[cells.length-1].firstElementChild;const t=getComputedStyle(visual).transform;return getComputedStyle(visual).opacity==='1'&&(t==='none'||Math.abs(new DOMMatrix(t).a-1)<0.01)})()`)
  // Pick an interior cell, so all four neighbours exist to be measured.
  const hotCell = await evaluate(`(()=>{const cells=[...document.querySelectorAll('[data-heat-cell]')];const inner=(cell)=>{const [w,d]=cell.getAttribute('data-heat-cell').split('-').map(Number);return w>=2&&w<=40&&d>=1&&d<=5};const cell=cells.find(inner);return cell.getAttribute('data-heat-cell')})()`)
  const [hotW, hotD] = hotCell.split('-').map(Number)
  const restFill = await evaluate(`(()=>getComputedStyle(document.querySelector('[data-heat-cell="${hotCell}"]').firstElementChild).backgroundColor)()`)
  await evaluate(`(()=>{const cell=document.querySelector('[data-heat-cell="${hotCell}"]');cell.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}));cell.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))})()`)
  await waitFor(`(()=>{const cell=document.querySelector('[data-heat-cell][aria-describedby]');return !!cell && !!cell.firstElementChild?.querySelector(':scope > span')})()`)
  await pause(400)
  const hoverTreatment = await evaluate(`(()=>{
    const view=document.querySelector('[data-heat-cell="${hotCell}"]').firstElementChild;
    const t=getComputedStyle(view).transform;
    const ring=view.querySelector(':scope > span');
    const vr=view.getBoundingClientRect();const rr=ring?ring.getBoundingClientRect():null;
    const neighbour=(id)=>{const cell=document.querySelector('[data-heat-cell="'+id+'"]');if(!cell)return null;const vt=getComputedStyle(cell.firstElementChild).transform;return {scale:vt==='none'?1:new DOMMatrix(vt).a,ring:!!cell.firstElementChild.querySelector(':scope > span')}};
    return {scale:t==='none'?1:new DOMMatrix(t).a,ring:!!ring,ringBox:rr?[Math.round(rr.width*100)/100,Math.round(rr.height*100)/100]:null,box:[Math.round(vr.width*100)/100,Math.round(vr.height*100)/100],fill:getComputedStyle(view).backgroundColor,neighbours:['${hotW - 1}-${hotD}','${hotW + 1}-${hotD}','${hotW}-${hotD - 1}','${hotW}-${hotD + 1}'].map(neighbour)};
  })()`)
  assert.ok(Math.abs(hoverTreatment.scale - 1) < 0.01, 'the hovered particle does not grow: ' + JSON.stringify(hoverTreatment))
  assert.ok(hoverTreatment.ring, 'the hovered particle shows a highlight ring: ' + JSON.stringify(hoverTreatment))
  assert.deepEqual(hoverTreatment.ringBox, hoverTreatment.box, 'and the ring hugs the particle exactly: ' + JSON.stringify(hoverTreatment))
  assert.notEqual(hoverTreatment.fill, restFill, 'the hovered particle recolours on hover: ' + JSON.stringify({ rest: restFill, hover: hoverTreatment.fill }))
  assert.ok(
    hoverTreatment.neighbours.every((n) => n !== null && Math.abs(n.scale - 1) < 0.01 && n.ring === false),
    'and the hover leaves every neighbour untouched: ' + JSON.stringify(hoverTreatment.neighbours)
  )
  await screenshot('daily')

  // ── usage trends ──────────────────────────────────────────────────────────
  // The token total lives once: the trends summary carries only the
  // range-scoped requests/cost pair, rolling in on NumberTicker.
  await evaluate(`window.scrollTo(0, document.body.scrollHeight)`)
  await waitFor(`document.querySelectorAll('[data-usage-stat]').length === 2`)
  await pause(900)
  const statCards = await evaluate(`(()=>{const cards=[...document.querySelectorAll('[data-usage-stat]')];return cards.map((card)=>({label:card.dataset.usageStat,text:card.textContent}))})()`)
  assert.ok(statCards.every((card) => /Requests|Est\. cost/.test(card.label)), 'two range summary cards, no duplicated total: ' + JSON.stringify(statCards))
  assert.ok(statCards.some((card) => card.label === 'Requests' && /3/.test(card.text)), 'and the request count rolls in: ' + JSON.stringify(statCards))
  await evaluate(`document.querySelectorAll('[role="tooltip"]').forEach((tip)=>tip.remove())`)
  // The range switcher's fill box must not depend on its state. The hover fill
  // is painted by the trigger itself, so the selected indicator has to cover
  // exactly that box: the wrapper's line box used to be ~2px taller than its
  // inline-flex button (baseline strut), and the selected 7d/30d pill then sat
  // 1px proud of the hovered one on each side.
  const rangeFills = await evaluate(`(()=>{
    const texts=['7d','30d','MTD','Last month','All'];
    return [...document.querySelectorAll('[role="tab"]')].filter(t=>texts.includes(t.textContent.trim())).map(t=>{
      const wrapper=t.parentElement;
      const button=t.getBoundingClientRect(),box=wrapper.getBoundingClientRect();
      const indicator=wrapper.querySelector(':scope > span');
      const fill=indicator?indicator.getBoundingClientRect():null;
      const same=(a,b)=>Math.abs(a-b)<=0.5;
      return {label:t.textContent.trim(),selected:t.getAttribute('aria-selected')==='true',
        boxed:same(box.height,button.height)&&same(box.top,button.top)&&same(box.width,button.width),
        filled:!fill||(same(fill.height,button.height)&&same(fill.top,button.top))};
    });
  })()`)
  assert.equal(rangeFills.length, 5, 'the usage range switcher renders every range: ' + JSON.stringify(rangeFills))
  assert.ok(rangeFills.every((tab) => tab.boxed), 'every range tab boxes its fill on the trigger: ' + JSON.stringify(rangeFills))
  assert.ok(rangeFills.some((tab) => tab.selected), 'one range is selected: ' + JSON.stringify(rangeFills))
  assert.ok(rangeFills.every((tab) => tab.filled), 'the selected fill matches the hover fill box: ' + JSON.stringify(rangeFills))

  // The stacked areas draw themselves in through the animated clip: switching
  // the range remounts the chart — sampled at the next animation frame the
  // reveal is still at its start (the click's remount lands between frames).
  const revealStart = await evaluate(`(async()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='All');btn.click();await new Promise(requestAnimationFrame);const svg=document.querySelector('svg linearGradient').closest('svg');const rect=svg.querySelector('clipPath rect');return {svgWidth:svg.getBoundingClientRect().width,clip:rect?rect.getAttribute('width'):null}})()`)
  assert.ok(revealStart.clip !== null && parseFloat(revealStart.clip) < revealStart.svgWidth * 0.5, `the stack draws in from the left: ${JSON.stringify(revealStart)}`)
  await pause(1200)
  const revealDone = await evaluate(`(()=>{const svg=document.querySelector('svg linearGradient').closest('svg');const rect=svg.querySelector('clipPath rect');return {svgWidth:svg.getBoundingClientRect().width,clip:rect.getAttribute('width')}})()`)
  assert.ok(parseFloat(revealDone.clip) >= revealDone.svgWidth - 2, `and the reveal completes: ${JSON.stringify(revealDone)}`)
  assert.ok(parseFloat(revealStart.clip) < 3, `the remounted clip starts at zero: ${JSON.stringify(revealStart)}`)

  // The crosshair glides on a spring: rest at the left edge, jump to the right
  // edge, and the line is strictly between the two a frame into the flight.
  const crossX = () => evaluate(`(()=>{const line=document.querySelector('svg line[stroke-dasharray="3 3"]');return line?parseFloat(line.getAttribute('x1')):null})()`)
  const svgRect = await evaluate(`document.querySelector('svg linearGradient').closest('svg').getBoundingClientRect().toJSON()`)
  await evaluate(`(()=>{const svg=document.querySelector('svg linearGradient').closest('svg');const rect=svg.querySelector('rect[fill="transparent"]');rect.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${svgRect.left + 60},clientY:${svgRect.top + 120}}))})()`)
  await pause(500)
  const leftX = await crossX()
  assert.ok(leftX !== null && leftX < svgRect.width * 0.35, 'the crosshair rests at the left edge: ' + leftX)
  const glide = await evaluate(`(async()=>{const svg=document.querySelector('svg linearGradient').closest('svg');const rect=svg.querySelector('rect[fill="transparent"]');const r=svg.getBoundingClientRect();rect.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${svgRect.left + svgRect.width - 60},clientY:r.top+120}));for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);const line=document.querySelector('svg line[stroke-dasharray="3 3"]');return parseFloat(line.getAttribute('x1'))})()`)
  await pause(700)
  const rightX = await crossX()
  assert.ok(rightX > svgRect.width * 0.65, 'and lands at the right edge: ' + rightX)
  assert.ok(glide > leftX + 5 && glide < rightX - 5, `having glided there instead of stepping: left ${leftX} → mid ${glide} → right ${rightX}`)

  // The crosshair readout carries the exact series counts and the Total row.
  await waitFor(`[...document.querySelectorAll('[role="tooltip"]')].some((tip)=>/Total/.test(tip.textContent))`)
  const readout = await evaluate(`[...document.querySelectorAll('[role="tooltip"]')].find((t)=>/Total/.test(t.textContent)).textContent`)
  assert.match(readout, /600/, 'the readout lists the series counts: ' + readout)
  assert.match(readout, /Total/, 'with the total row')

  // The boundary dot sits exactly ON the line it marks. The drawing used to be a
  // quadratic-midpoint spline that only touched the midpoints between days, so a
  // dot anchored to a day's value floated above or below the curve.
  await pause(500)
  const dotOnCurve = await evaluate(`(()=>{const svg=document.querySelector('svg linearGradient').closest('svg');const dot=[...svg.querySelectorAll('circle')].find((c)=>c.getAttribute('fill'));if(!dot)return null;const color=dot.getAttribute('fill');const path=[...svg.querySelectorAll('path')].find((p)=>p.getAttribute('stroke')===color);if(!path)return null;const x=parseFloat(dot.getAttribute('cx'));const y=parseFloat(dot.getAttribute('cy'));let lo=0,hi=path.getTotalLength();for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(path.getPointAtLength(mid).x<x)lo=mid;else hi=mid}return {x,y,curveY:path.getPointAtLength((lo+hi)/2).y}})()`)
  assert.ok(dotOnCurve, 'the hovered day is marked with a boundary dot')
  assert.ok(
    Math.abs(dotOnCurve.curveY - dotOnCurve.y) < 0.75,
    `the dot lies on its curve: ${JSON.stringify({ ...dotOnCurve, delta: Math.abs(dotOnCurve.curveY - dotOnCurve.y) })}`
  )

  // The readout follows the pointer instead of hanging off one fixed spot above
  // the plot: moving the pointer down a column moves the bubble by the same
  // distance, and it is never parked at the plot's top edge.
  const pointerX = svgRect.left + svgRect.width / 2
  const pointerYs = [svgRect.top + 90, svgRect.top + 200]
  const readoutBox = () => evaluate(`(()=>{const tip=[...document.querySelectorAll('[role="tooltip"]')].find((t)=>/Total/.test(t.textContent));if(!tip)return null;const r=tip.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  const movePointer = (x, y) => evaluate(`(()=>{const svg=document.querySelector('svg linearGradient').closest('svg');const rect=svg.querySelector('rect[fill="transparent"]');rect.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${x},clientY:${y}}))})()`)
  await movePointer(pointerX, pointerYs[0])
  await pause(220)
  const readoutHigh = await readoutBox()
  await movePointer(pointerX, pointerYs[1])
  await pause(220)
  const readoutLow = await readoutBox()
  assert.ok(readoutHigh && readoutLow, 'the readout stays mounted while the pointer is on the plot')
  assert.ok(
    Math.abs((readoutLow.y - readoutHigh.y) - (pointerYs[1] - pointerYs[0])) < 20,
    `the readout tracks the pointer instead of a fixed spot: ${JSON.stringify({ readoutHigh, readoutLow, pointerYs })}`
  )
  assert.ok(readoutLow.y > svgRect.top, `and it is not parked at the top of the plot: ${JSON.stringify({ readoutLow, svgTop: svgRect.top })}`)
  await screenshot('trends-hover')

  // The turn records table still renders its rows for the selected range.
  assert.equal(await evaluate(`document.querySelectorAll('tbody tr').length`), 2, 'both fixture turns are listed')

  assert.deepEqual(exceptions, [], 'no uncaught renderer exceptions')
  console.log('PASS: token activity — heat-calendar daily grid (the only view), exact counts, bilingual readout, a hover that recolours the hovered particle under a shape-hugging ring and leaves neighbours untouched; usage trends — clip reveal, spring crosshair, boundary dots exactly on their curve, a pointer-following readout, no duplicated total')
} finally {
  ws?.close()
  if (child && child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited }
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
