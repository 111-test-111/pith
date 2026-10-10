/** Table preview: the stat/slice/range IPC contract, real grid rendering for
 * delimited text and a hand-built multi-sheet workbook, streaming, zoom and the
 * failure paths. Isolated data, no network.
 * Run after building: node scripts/check-table-preview.mjs
 * `PI_TABLE_SCREENSHOT_DIR` retains the rendered views. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { build } from 'esbuild'
import { createServer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-table-'))
const project = join(temporary, 'project')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Small ZIP writer: the workbook fixture must be bytes this repository wrote,
 * so the reader is exercised against a real archive without any tooling. */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const compressed = deflateRawSync(raw)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(raw), 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    parts.push(header, name, compressed)
    central.push({ name, crc: crc32(raw), compressed: compressed.length, size: raw.length, offset })
    offset += 30 + name.length + compressed.length
  }
  const directoryStart = offset
  for (const entry of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.compressed, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt32LE(entry.offset, 42)
    parts.push(header, entry.name)
    offset += 46 + entry.name.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - directoryStart, 12)
  end.writeUInt32LE(directoryStart, 16)
  parts.push(end)
  return Buffer.concat(parts)
}

/** Excel's serial for a UTC date, 1900 system (with its phantom leap day). */
const excelSerial = (year, month, day) => Math.round(Date.UTC(year, month - 1, day) / 86_400_000) + 25569

const BIG_SHEET_ROWS = 30_000
const CSV_ROWS = 12_000

function peopleCsv() {
  return ['id,name,note', '1,Alice,"hello, world"', '2,Bob,"line one', 'line two"', '3,李雷,plain'].join('\r\n') + '\r\n'
}
function bigCsv() {
  const rows = ['id,name,note']
  for (let index = 1; index <= CSV_ROWS; index++) rows.push(`${index},"name ${index}","first part of ${index}`, `second part of ${index}"`)
  return rows.join('\n') + '\n'
}
function workbookParts() {
  const shared = ['Name', 'Amount', 'Date', 'Flag', 'Note', 'Alice', 'Bob']
  const worksheet = (body, dimension) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`
  const people = worksheet([
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>',
    `<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"><v>${excelSerial(2024, 3, 5)}</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="inlineStr"><is><t>inline &amp; text</t></is></c></row>`,
    '<row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3"><v>7</v></c><c r="D3" t="b"><v>0</v></c></row>',
    '<row r="9"><c r="A9" t="str"><v>formula result</v></c></row>'
  ].join(''), 'A1:E9')
  const big = ['<row r="1"><c r="A1"><v>0</v></c></row>']
  for (let index = 2; index <= BIG_SHEET_ROWS; index++) big.push(`<row r="${index}"><c r="A${index}"><v>${index}</v></c><c r="B${index}" t="inlineStr"><is><t>${randomBytes(24).toString('hex')}</t></is></c></row>`)
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook><workbookPr date1904="0"/><sheets><sheet name="People" sheetId="1" r:id="rId1"/><sheet name="Big" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>` },
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst count="${shared.length}">${shared.map(text => `<si><t>${text}</t></si>`).join('')}</sst>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: people },
    { name: 'xl/worksheets/sheet2.xml', data: worksheet(big.join(''), `A1:B${BIG_SHEET_ROWS}`) }
  ]
}

function singleSheetWorkbook() {
  const cell = (reference, text) => `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`
  return zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Only" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?><worksheet><dimension ref="A1:B3"/><sheetData><row r="1">${cell('A1', 'Key')}${cell('B1', 'Value')}</row><row r="2">${cell('A2', 'a')}<c r="B2"><v>1</v></c></row><row r="3">${cell('A3', 'b')}<c r="B3"><v>2</v></c></row></sheetData></worksheet>` }
  ])
}

const docPaths = { csv: join(project, 'people.csv'), big: join(project, 'big.csv'), tsv: join(project, 'data.tsv'), semi: join(project, 'semi.csv'), book: join(project, 'book.xlsx'), single: join(project, 'single.xlsx'), broken: join(project, 'broken.xlsx'), text: join(project, 'notes.txt') }
let server, child, ws
/** `[table]` samples: slice/range IPC contract and documents read as text. */
const samples = []
const projectFiles = []
try {
  await mkdir(project)
  await writeFile(docPaths.csv, peopleCsv())
  await writeFile(docPaths.big, bigCsv())
  await writeFile(docPaths.tsv, 'id\tname\n1\tAlice\n2\tBob\n')
  await writeFile(docPaths.semi, 'id;name\n1;Alice\n2;Bob\n')
  await writeFile(docPaths.book, zip(workbookParts()))
  await writeFile(docPaths.single, singleSheetWorkbook())
  await writeFile(docPaths.broken, Buffer.from('this is not a spreadsheet at all', 'utf8'))
  await writeFile(docPaths.text, 'plain text source\n')
  const bookSize = (await stat(docPaths.book)).size
  projectFiles.push(...Object.values(docPaths))

  const fixturePath = '/__table_check.html'
  const fixture = `<!doctype html><html lang="en"><head><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {FilesPane} from '/src/components/app/FilesPane.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import {PiStore} from '/src/state/pi-store.ts';import {FileBrowserStore} from '/src/state/file-browser-store.ts';import {DebugStore} from '/src/state/debug-store.ts';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';
import '/src/styles.css';
localStorage.setItem('pi-app:locale','en');
const cwd=${JSON.stringify(project)};
const files=new FileBrowserStore(),pi=new PiStore(),debug=new DebugStore();
pi.applySnapshot({cwd,sessionId:crypto.randomUUID(),messages:[],model:null,thinkingLevel:'off',availableThinkingLevels:['off'],isStreaming:false});
const App=()=>{const state=React.useSyncExternalStore(files.subscribe,files.getSnapshot);return React.createElement(FilesPane,{files,store:pi,filePath:state.active,debug})};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(App))));
window.en=en;window.zh=zh;window.cwd=cwd;
window.openFile=name=>files.open(cwd,{path:cwd+'/'+name});
window.__viewport=()=>document.querySelector('[data-file-table-viewport]');
window.__status=()=>document.querySelector('[data-file-table]')?.dataset.fileTableStatus;
window.__count=()=>document.querySelector('[data-file-table-count]')?.textContent;
window.__notice=()=>document.querySelector('[data-file-table] p[role=status]')?.textContent;
window.__sheet=()=>{const strip=document.querySelector('[data-file-table-sheets]');if(!strip)return null;const active=strip.querySelector('[role=tab][aria-selected=true]');return active?active.textContent:null};
window.__sheets=()=>[...document.querySelectorAll('[data-file-table-sheets] [role=tab]')].map(node=>node.textContent);
window.__layout=()=>{const rect=selector=>{const node=document.querySelector(selector);if(!node)return null;const box=node.getBoundingClientRect();return {top:Math.round(box.top),bottom:Math.round(box.bottom)}};return {bar:rect('[data-file-table-bar]'),viewport:rect('[data-file-table-viewport]'),sheets:rect('[data-file-table-sheets]'),zoom:!!document.querySelector('[data-file-table-zoom]')}};
window.__rows=()=>[...document.querySelectorAll('[data-table-row]')].map(row=>({number:Number(row.dataset.tableRow),gutter:row.firstElementChild.textContent,cells:[...row.children].slice(1).map(cell=>cell.textContent)}));
window.__header=()=>{const header=document.querySelector('[data-table-header]');const viewport=window.__viewport();if(!header||!viewport)return null;const style=getComputedStyle(header);return {cells:[...header.children].slice(1).map(cell=>cell.textContent),position:style.position,background:style.backgroundColor,top:Math.round(header.getBoundingClientRect().top),viewportTop:Math.round(viewport.getBoundingClientRect().top),gutterPosition:getComputedStyle(header.firstElementChild).position}};
window.__zoom=()=>({label:document.querySelector('[data-file-table-scale]').textContent,font:getComputedStyle(window.__viewport()).fontSize,row:Math.round(document.querySelector('[data-table-row]').getBoundingClientRect().height)});
window.__clickZoom=key=>document.querySelector('[data-file-table-zoom] button[aria-label="'+window.en[key]+'"]').click();
window.__pickSheet=async name=>{const tab=[...document.querySelectorAll('[data-file-table-sheets] [role=tab]')].find(node=>node.textContent.includes(name));if(!tab)return false;tab.click();await new Promise(r=>setTimeout(r,260));return true};
window.__scrollToEnd=async()=>{const viewport=window.__viewport();viewport.scrollTop=viewport.scrollHeight;await new Promise(r=>setTimeout(r,180))};
window.__loadAll=async max=>{let previous=-1,stable=0;for(let round=0;round<90;round++){const viewport=window.__viewport();if(!viewport)return -1;viewport.scrollTop=viewport.scrollHeight;await new Promise(r=>setTimeout(r,280));const count=window.__count();if(count===previous){stable++;if(stable>=2)return round}else{stable=0}previous=count}return 90};
window.__frames=async ms=>{const viewport=window.__viewport();const frames=[];let last=performance.now();const start=performance.now();while(performance.now()-start<ms){await new Promise(requestAnimationFrame);const now=performance.now();frames.push(now-last);last=now;viewport.scrollTop+=140}return frames};
window.__scrollSamples=async steps=>{const seen=[];const viewport=window.__viewport();for(let step=0;step<steps;step++){viewport.scrollTop+=420;await new Promise(r=>setTimeout(r,70));seen.push(...window.__rows())}return seen};
window.__diag=()=>{const v=window.__viewport();const wrapper=v.firstElementChild;const children=[...wrapper.children].map(node=>({tag:node.tagName,role:node.dataset.tableRow??node.getAttribute('data-table-header')!==null?'header':'spacer',h:Math.round(node.getBoundingClientRect().height)}));return {count:window.__count(),scrollTop:Math.round(v.scrollTop),scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,offsetHeight:v.offsetHeight,wrapperHeight:Math.round(wrapper.getBoundingClientRect().height),first:children[0],last:children[children.length-1],spacers:children.filter(c=>c.role==='spacer').map(c=>c.h),mounted:children.length}};
window.__alignment=()=>{const header=document.querySelector('[data-table-header]');const row=document.querySelector('[data-table-row]');if(!header||!row)return null;const left=node=>[...node.children].map(cell=>Math.round(cell.getBoundingClientRect().left));const width=node=>[...node.children].map(cell=>Math.round(cell.getBoundingClientRect().width));return {headerLeft:left(header),bodyLeft:left(row),headerWidth:width(header),bodyWidth:width(row)}};
window.__clipped=()=>[...document.querySelectorAll('[data-table-header] span.truncate, [data-table-row] span.truncate')].filter(span=>span.scrollWidth>span.clientWidth+1).map(span=>span.textContent);
window.__flashProbe=async ms=>{const rows=[];const start=performance.now();window.dispatchEvent(new Event('focus'));while(performance.now()-start<ms){await new Promise(requestAnimationFrame);rows.push(document.querySelectorAll('[data-table-row]').length)}return {min:Math.min(...rows),frames:rows.length}};
window.__reopenProbe=async name=>{window.openFile(name);await new Promise(r=>setTimeout(r,50));return {status:window.__status(),rows:document.querySelectorAll('[data-table-row]').length,count:window.__count()}};
window.__sheetIndicator=()=>{const tab=document.querySelector('[data-file-table-sheets] [role=tab][aria-selected=true]');if(!tab)return null;const mark=tab.querySelector('span.bg-primary');const strip=document.querySelector('[data-file-table-sheets]');const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom)}};return {tab:box(tab),mark:mark?box(mark):null,strip:box(strip),label:tab.textContent}};
window.__ready=true;</script></body></html>`

  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), logLevel: 'error', cacheDir: join(temporary, 'vite'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } }, plugins: [tailwindcss(), { name: 'table-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== fixturePath) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) }) } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))

  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain} from 'electron';
import {listFileDirectory,readFileDocument,readFileGitDiff} from ${JSON.stringify(join(repo, 'src/main/file-browser.ts'))};
import {readTableRange,readTableSlice,readTableStat} from ${JSON.stringify(join(repo, 'src/main/table.ts'))};
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.commandLine.appendSwitch('remote-debugging-port','0');
const io={slices:[],ranges:[],documents:[],lastRange:0,lastSlice:0};globalThis.tableIo=io;
const stat=list=>list.length?{count:list.length,bytes:list.reduce((sum,item)=>sum+item,0),max:list.reduce((max,item)=>Math.max(max,item),0)}:{count:0,bytes:0,max:0};
app.whenReady().then(()=>{
  ipcMain.handle('app:info',()=>({cwd:${JSON.stringify(project)},folders:[${JSON.stringify(project)}],contextFiles:true,version:'test',bashMaxWaitMs:10000,checkpointsEnabled:false}));
  ipcMain.handle('files:directory',(_,r,offset)=>listFileDirectory(r,offset));
  ipcMain.handle('files:document',(_,r)=>{io.documents.push(r.path);return readFileDocument(r)});
  ipcMain.handle('files:gitDiff',(_,r)=>readFileGitDiff(r));
  ipcMain.handle('files:tableStat',(_,r)=>readTableStat(r));
  ipcMain.handle('files:tableSlice',async(_,r,offset,maxBytes)=>{const result=await readTableSlice(r,offset,maxBytes);if(!result.error){io.slices.push(Buffer.byteLength(result.text,'utf8'));io.lastSlice=Date.now()}return result});
  ipcMain.handle('files:tableRange',async(_,r,begin,end)=>{io.ranges.push(end-begin);io.lastRange=Date.now();return readTableRange(r,begin,end)});
  setInterval(()=>console.log('[table]',JSON.stringify({slices:stat(io.slices),ranges:stat(io.ranges),documents:io.documents.length,lastRange:io.lastRange,lastSlice:io.lastSlice})),300);
  const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:${JSON.stringify(join(repo, 'out/preload/index.mjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  w.loadURL('http://127.0.0.1:${server.httpServer.address().port}${fixturePath}');});
app.on('window-all-closed',()=>app.quit());`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })

  child = spawn(electron, [main], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', (chunk) => { for (const match of String(chunk).matchAll(/\[table\] (\{.*\})/g)) samples.push(JSON.parse(match[1])) })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr.slice(0, 1500))), 20000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ' ' + stderr.slice(0, 1500))) })
    child.stderr.on('data', (chunk) => { stderr += chunk; const match = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/.exec(stderr); if (match) { clearTimeout(timer); resolve('http://' + match[1]) } })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) { page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page'); if (!page) await pause(50) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push(m.params.args.map((a) => a.description ?? a.value).join(' ').slice(0, 300))
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value }
  await send('Runtime.enable')
  const waitFor = async (expression, label) => { const end = Date.now() + 25000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true; await pause(100) } throw new Error('Timeout: ' + label + ' :: status=' + await evaluate('window.__status()').catch(() => '?') + ' body=' + JSON.stringify(await evaluate('document.body.innerText').catch(() => '?')) + ' ' + JSON.stringify(exceptions.slice(0, 4))) }
  const openTable = async (name) => { await evaluate(`window.openFile(${JSON.stringify(name)})`); await waitFor(`window.__status()==='ready'`, `table ready: ${name}`) }
  /** Waits until two consecutive main-process samples are identical, so a
   * counter comparison cannot race a read that is still in flight. */
  const settle = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const previous = samples[samples.length - 2]
      const last = samples[samples.length - 1]
      if (previous && last && previous.ranges.count === last.ranges.count && previous.slices.count === last.slices.count) return last
      await pause(200)
    }
    return samples[samples.length - 1]
  }
  const shot = async (name) => { const dir = process.env.PI_TABLE_SCREENSHOT_DIR; if (!dir) return; await mkdir(dir, { recursive: true }); const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(dir, name + '.png'), Buffer.from(image.data, 'base64')) }

  await waitFor('window.__ready', 'fixture ready')

  // 1. Delimited text: real quoting, a record that spans two lines, and a
  //    delimiter the extension does not imply.
  await openTable('people.csv')
  const csv = await evaluate(`(()=>{const header=window.__header();return {header:header.cells,position:header.position,background:header.background,gutter:header.gutterPosition,rows:window.__rows(),count:window.__count()}})()`)
  assert.deepEqual(csv.header, ['id', 'name', 'note'], `the first record is the header: ${JSON.stringify(csv)}`)
  assert.equal(csv.position, 'sticky', 'the header stays pinned over the scrolled rows')
  assert.equal(csv.gutter, 'sticky', 'the row-number gutter does not scroll away sideways')
  assert.ok(!/rgba\([^)]*,\s*0?\.\d+\)/.test(csv.background), `a sticky header needs an opaque fill: ${csv.background}`)
  assert.equal(csv.rows.length, 3, `every record is rendered: ${JSON.stringify(csv.rows)}`)
  assert.equal(csv.rows[0].cells[2], 'hello, world', 'a quoted comma stays inside its cell')
  assert.equal(csv.rows[1].cells[2], 'line one\nline two', 'a quoted newline stays inside its cell')
  assert.equal(csv.rows[2].cells[1], '李雷', 'multi-byte text survives the slice decode')
  assert.equal(csv.count, `3 rows × 3 columns`, `the bar reports the loaded shape: ${csv.count}`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-view-tabs] [role=tab]').length`), 2, 'a delimited file keeps its source and preview views')
  // One grid: the header and the body columns must line up exactly (a `ch`
  // differs with font weight, which shifted every header column right), and a
  // value that fits its measured column must not be ellipsised.
  const alignment = await evaluate('window.__alignment()')
  for (let index = 0; index < alignment.headerLeft.length; index++) {
    assert.ok(Math.abs(alignment.headerLeft[index] - alignment.bodyLeft[index]) <= 1, `header and body columns share one grid (column ${index}): ${JSON.stringify(alignment)}`)
    assert.ok(Math.abs(alignment.headerWidth[index] - alignment.bodyWidth[index]) <= 1, `header and body cells share one width (column ${index}): ${JSON.stringify(alignment)}`)
  }
  assert.deepEqual(await evaluate('window.__clipped()'), [], 'a value that fits its column is not ellipsised')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-table-sheets]').length`), 0, 'a delimited file has no sheet strip')
  const csvLayout = await evaluate('window.__layout()')
  assert.ok(csvLayout.zoom && csvLayout.bar.bottom <= csvLayout.viewport.top, `the table bar sits above the grid: ${JSON.stringify(csvLayout)}`)
  console.log('PASS: CSV quoting, embedded newlines and the sticky header')
  await shot('table-csv')

  // 2. The delimiter is sniffed, not assumed: tabs and semicolons both split.
  for (const [name, expected] of [['data.tsv', ['id', 'name']], ['semi.csv', ['id', 'name']]]) {
    await openTable(name)
    const header = await evaluate('window.__header().cells')
    assert.deepEqual(header, expected, `${name} splits on its own delimiter: ${JSON.stringify(header)}`)
  }
  assert.equal(await evaluate('window.__count()'), '2 rows × 2 columns', 'semicolon-delimited rows are counted')
  console.log('PASS: TSV and semicolon-delimited files are sniffed correctly')

  // 3. Zoom scales the font and the row height; zoom out returns to 100%.
  const zoomBefore = await evaluate('window.__zoom()')
  await evaluate(`window.__clickZoom('files.table.zoomIn')`)
  await pause(120)
  const zoomAfter = await evaluate('window.__zoom()')
  assert.ok(Number.parseFloat(zoomAfter.font) > Number.parseFloat(zoomBefore.font), `zoom in grows the font: ${zoomBefore.font} → ${zoomAfter.font}`)
  assert.ok(zoomAfter.row > zoomBefore.row, `zoom in grows the row: ${zoomBefore.row} → ${zoomAfter.row}`)
  assert.notEqual(zoomAfter.label, zoomBefore.label, 'the percentage label follows the zoom')
  await evaluate(`window.__clickZoom('files.table.zoomOut')`)
  await pause(120)
  assert.equal((await evaluate('window.__zoom()')).font, zoomBefore.font, 'zoom out returns to 100%')
  console.log(`PASS: zoom ${zoomBefore.font} → ${zoomAfter.font} (row ${zoomBefore.row} → ${zoomAfter.row}px) and back`)

  // 4. A large delimited file streams: bounded slices, bounded DOM, and record
  //    identity holds across every slice boundary (no duplicated or lost row).
  await pause(350)
  const beforeBig = samples[samples.length - 1]
  await openTable('big.csv')
  await pause(350)
  const paint = samples[samples.length - 1]
  const painted = { slices: paint.slices.count - beforeBig.slices.count, bytes: paint.slices.bytes - beforeBig.slices.bytes }
  assert.ok(painted.slices >= 1, 'the first rows arrive over the slice IPC')
  assert.ok(paint.slices.max <= 320 * 1024, `a slice stays bounded: max ${paint.slices.max} bytes`)
  assert.ok(painted.bytes < 1_200_000, `the first paint does not read the whole file: ${painted.bytes} bytes`)
  const mounted = await evaluate(`document.querySelectorAll('[data-table-row]').length`)
  assert.ok(mounted > 0 && mounted < 80, `only the visible window is mounted: ${mounted} rows`)
  const samplesRows = await evaluate('window.__scrollSamples(14)')
  assert.ok(samplesRows.length > 100, `scrolling sampled many rows: ${samplesRows.length}`)
  for (const row of samplesRows) assert.equal(Number(row.cells[0]), Number(row.gutter) - 1, `row identity must survive slice joins: ${JSON.stringify(row)}`)
  const frames = await evaluate('window.__frames(1200)')
  const worst = Math.max(...frames)
  assert.ok(frames.length > 20, `frames really ran while scrolling: ${frames.length}`)
  assert.ok(worst < 100, `no stall frame while scrolling: max ${Math.round(worst)}ms`)
  const loaded = await evaluate('window.__loadAll()')
  assert.ok(loaded <= 90, 'the file loads to its end')
  assert.equal(await evaluate('window.__count()'), `${CSV_ROWS} rows × 3 columns`, 'every record of the stream is loaded exactly once')
  const tail = await evaluate('window.__rows()')
  assert.equal(Number(tail[tail.length - 1].cells[0]), CSV_ROWS, `the last record is the file's last: ${JSON.stringify(tail[tail.length - 1])}`)
  const bigSlices = samples[samples.length - 1].slices
  assert.ok(bigSlices.count - beforeBig.slices.count > painted.slices, 'the rest of the file arrived over later slices, not the first one')
  console.log(`PASS: ${CSV_ROWS} streamed rows over ${bigSlices.count - beforeBig.slices.count} slices (max ${bigSlices.max} bytes), scroll max frame ${Math.round(worst)}ms, DOM rows < 80`)
  await shot('table-big')
  // Exercise FilesPane's shared DOM-scroll adapter with both axes available.
  await evaluate(`(()=>{const v=window.__viewport();v.style.width='140px';v.style.height='150px';v.style.flex='none';v.scrollLeft=40;v.scrollTop=200})()`)
  await pause(250)
  const tablePosition=()=>evaluate(`(()=>{const v=window.__viewport();return {left:v.scrollLeft,top:v.scrollTop,scale:window.__zoom().label}})()`)
  const tableWheel=events=>evaluate(`(()=>{const v=window.__viewport();for(const event of ${JSON.stringify(events)})v.dispatchEvent(new WheelEvent('wheel',{...event,bubbles:true,cancelable:true}))})()`)
  const beforeWheel=await tablePosition()
  await tableWheel([{deltaX:8,deltaY:6},{deltaX:6,deltaY:9},{deltaX:5,deltaY:80}])
  const horizontal=await tablePosition()
  assert.equal(horizontal.left,beforeWheel.left+19,'table retains horizontal diagonal motion')
  assert.equal(horizontal.top,beforeWheel.top+95,'table retains vertical diagonal motion')
  await tableWheel([{deltaX:-6,deltaY:8},{deltaX:-9,deltaY:6},{deltaX:-10,deltaY:5}])
  const vertical=await tablePosition()
  assert.equal(vertical.top,horizontal.top+19,'table continues vertical motion without an idle gap')
  assert.equal(vertical.left,horizontal.left-25,'table immediately reverses horizontal direction')
  assert.equal(vertical.scale,beforeWheel.scale,'scrolling never changes table zoom')
  await tableWheel([{deltaX:1,deltaY:16,shiftKey:true}])
  assert.equal((await tablePosition()).left,vertical.left+16,'Shift still maps table wheel to horizontal scrolling')
  assert.equal((await tablePosition()).top,vertical.top,'Shift only scrolls horizontally')
  await evaluate(`(()=>{const v=window.__viewport();for(const property of ['width','height','flex'])v.style.removeProperty(property)})()`)
  console.log('PASS: table free diagonal scrolling, immediate direction changes and Shift horizontal scrolling')

  // 5. A workbook: sheet list, shared strings, numbers, dates, booleans,
  //    inline strings, sparse rows and a row cap that stops the inflate early.
  await openTable('book.xlsx')
  assert.equal(await evaluate('window.__sheet()'), 'People', 'the first worksheet is selected')
  // A spreadsheet has no text view: no source/preview tabs and no find/wrap/copy
  // cluster, only the grid and its own footer.
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-view-tabs]').length`), 0, 'a spreadsheet takes the pane without the text view tabs')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-table-sheets] [role=tab]').length`), 2, 'the worksheets are tabs in the bottom strip')
  assert.deepEqual(await evaluate('window.__sheets()'), ['People', 'Big'], 'every worksheet is listed')
  const bookLayout = await evaluate('window.__layout()')
  assert.ok(bookLayout.bar.bottom <= bookLayout.viewport.top && bookLayout.viewport.bottom <= bookLayout.sheets.top, `bar above the grid, worksheets below it: ${JSON.stringify(bookLayout)}`)
  const indicator = await evaluate('window.__sheetIndicator()')
  assert.ok(indicator.mark, `the active worksheet is underlined: ${JSON.stringify(indicator)}`)
  assert.equal(indicator.label, 'People')
  assert.ok(Math.abs(indicator.mark.left - indicator.tab.left) <= 1 && Math.abs(indicator.mark.right - indicator.tab.right) <= 1, `the underline spans its own tab: ${JSON.stringify(indicator)}`)
  assert.ok(Math.abs(indicator.mark.top - indicator.strip.top) <= 2, `the underline rides the divider above the strip: ${JSON.stringify(indicator)}`)
  console.log(`PASS: worksheet underline at ${indicator.mark.left}-${indicator.mark.right}px on the strip's ${indicator.strip.top}px edge`)
  const sheet = await evaluate(`(()=>{const header=window.__header();return {header:header.cells,rows:window.__rows(),count:window.__count()}})()`)
  assert.deepEqual(sheet.header, ['Name', 'Amount', 'Date', 'Flag', 'Note'], `shared strings fill the header: ${JSON.stringify(sheet.header)}`)
  assert.equal(sheet.rows[0].cells[0], 'Alice')
  assert.equal(sheet.rows[0].cells[1], '12.5', 'a number cell keeps its raw value (no cell styles)')
  assert.equal(sheet.rows[0].cells[2], '2024-03-05', `a date-formatted serial renders as a date: ${sheet.rows[0].cells[2]}`)
  assert.equal(sheet.rows[0].cells[3], 'TRUE', 'a boolean cell renders as TRUE')
  assert.equal(sheet.rows[0].cells[4], 'inline & text', 'an inline string is decoded')
  assert.equal(sheet.rows[1].cells[1], '7')
  assert.equal(sheet.rows[1].cells[3], 'FALSE')
  assert.equal(sheet.rows[2].gutter, '9', `a sparse row keeps the sheet's own numbering: ${JSON.stringify(sheet.rows[2])}`)
  assert.equal(sheet.rows[2].cells[0], 'formula result', 'a cached formula result is shown')
  // Four parsed records: the header, two data rows and a sparse row 9 — the
  // bar counts data rows, so three.
  assert.equal(sheet.count, '3 rows × 5 columns')
  // The counters are sampled from the main process every 300ms, so wait for
  // the read that just happened instead of reading a stale sample.
  let workbookRanges = samples[samples.length - 1].ranges
  for (let attempt = 0; attempt < 40 && workbookRanges.count === 0; attempt++) { await pause(120); workbookRanges = samples[samples.length - 1].ranges }
  assert.ok(workbookRanges.count > 0, 'a workbook is read over byte ranges')
  assert.ok(workbookRanges.max <= 256 * 1024, `range reads stay chunked: max ${workbookRanges.max} bytes`)
  assert.ok(workbookRanges.bytes < bookSize * 0.5, `opening a ${bookSize}-byte workbook read only ${workbookRanges.bytes} bytes (a ZIP is walked, not loaded)`)
  console.log(`PASS: workbook over ${workbookRanges.count} range reads (${workbookRanges.bytes} of ${bookSize} bytes), dates/booleans/inline strings/sparse rows`)
  await shot('table-xlsx')

  // 6. Switching sheets parses another part, capped and reported.
  assert.ok(await evaluate(`window.__pickSheet('Big')`), 'the sheet selector lists the other worksheets')
  await waitFor(`window.__count()?.startsWith('4999 ')`, 'the second worksheet is parsed')
  const capped = await evaluate(`({count:window.__count(),notice:window.__notice(),rows:document.querySelectorAll('[data-table-row]').length})`)
  assert.equal(capped.count, '4999 rows × 2 columns', `a large worksheet is capped: ${JSON.stringify(capped)}`)
  assert.ok(capped.notice.includes('4999'), `the cap is reported in the UI: ${capped.notice}`)
  assert.ok(capped.rows < 80, `the capped sheet still mounts only its window: ${capped.rows}`)
  assert.equal(await evaluate('window.__sheet()'), 'Big', 'the selector reflects the active worksheet')
  console.log(`PASS: sheet switch to a ${BIG_SHEET_ROWS}-row worksheet (${capped.count}, ${capped.notice})`)
  await shot('table-xlsx-sheet')

  // 7. Revalidating (a window focus, a settled run) re-reads in the background:
  //    the rows on screen must never be replaced by a spinner.
  const flash = await evaluate('window.__flashProbe(1200)')
  assert.ok(flash.frames > 30, `frames ran during the revalidation: ${JSON.stringify(flash)}`)
  assert.ok(flash.min > 0, `the grid never blanks while revalidating: ${JSON.stringify(flash)}`)
  assert.equal(await evaluate('window.__status()'), 'ready', 'the pane stays ready through a revalidation')
  console.log(`PASS: a revalidation keeps the grid painted (${flash.frames} frames, minimum ${flash.min} rows)`)

  // A single worksheet needs no chooser at all: no strip, just the grid with
  // its own shape/zoom bar above it.
  await openTable('single.xlsx')
  const single = await evaluate(`({layout:window.__layout(),sheets:window.__sheets(),count:window.__count()})`)
  assert.equal(single.sheets.length, 0, `a single worksheet shows no sheet strip: ${JSON.stringify(single)}`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-table-sheets]').length`), 0, 'a single worksheet mounts no strip')
  assert.ok(single.layout.zoom && single.layout.bar.bottom <= single.layout.viewport.top, `the shape and zoom stay above the grid: ${JSON.stringify(single.layout)}`)
  assert.equal(single.count, '2 rows × 2 columns', `the single worksheet is parsed: ${single.count}`)
  console.log('PASS: a single-sheet workbook has no sheet strip')

  // 8. Revisiting a table repaints from the pane cache instead of re-reading:
  //    the grid must be painted on the first frames after the switch (a re-read
  //    would still be in its loading state) and no read may follow the marker.
  //    The pane caches per generation, so warm this file first — the focus probe
  //    above bumped the generation, and revalidating once after it is its point.
  const warm = await evaluate(`window.__reopenProbe('people.csv')`)
  await settle()
  const marker = Date.now()
  await evaluate(`window.openFile('notes.txt')`)
  await waitFor(`document.querySelectorAll('[data-file-view-tabs]').length > 0`, 'text tab')
  const revisited = await evaluate(`window.__reopenProbe('people.csv')`)
  const afterRevisit = (await settle()) ?? samples[samples.length - 1]
  assert.equal(revisited.status, 'ready', `a revisited table is served from cache, not reloaded: ${JSON.stringify(revisited)}`)
  assert.ok(revisited.rows > 0, `the cached rows are painted on the first frames: ${JSON.stringify(revisited)}`)
  assert.equal(revisited.count, warm.count, `the cached table keeps its shape: ${JSON.stringify({ warm, revisited })}`)
  assert.ok(afterRevisit.lastRange <= marker, `a revisited workbook must not re-open its ZIP: ${JSON.stringify({ marker, lastRange: afterRevisit.lastRange })}`)
  assert.ok(afterRevisit.lastSlice <= marker, `a revisited table must not re-read its slices: ${JSON.stringify({ marker, lastSlice: afterRevisit.lastSlice })}`)
  console.log('PASS: a revisited table is served from the pane cache')

  // 9. Failure paths and the text preview regression.
  await evaluate(`window.openFile('broken.xlsx')`)
  await waitFor(`window.__status()==='error'`, 'broken workbook notice')
  const failure = await evaluate(`document.querySelector('[data-file-table]').innerText`)
  assert.ok(failure.includes((await evaluate("window.en['files.error.unreadable']"))), `a broken workbook fails in the localized words: ${failure}`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-pdf]').length`), 0, 'a workbook never mounts the PDF viewer')
  await evaluate(`window.openFile('notes.txt')`)
  await waitFor(`document.querySelectorAll('[data-file-view-tabs]').length > 0`, 'text tabs again')
  assert.equal(await evaluate(`document.querySelectorAll('[data-file-table]').length`), 0, 'a text file does not mount the table grid')
  console.log('PASS: a broken workbook shows the localized failure; text files still open as text')

  const locale = await evaluate(`(()=>{const keys=Object.keys(window.en).filter(key=>key.startsWith('files.table.'));return {keys,missing:keys.filter(key=>typeof window.zh[key]!=='string'),translated:keys.filter(key=>window.zh[key]!==window.en[key]).length}})()`)
  assert.deepEqual(locale.missing, [], 'every table string exists in zh-CN')
  assert.equal(locale.translated, locale.keys.length, 'table strings are translated, not copied')
  assert.deepEqual(exceptions, [], 'no renderer exceptions')
  console.log(`PASS: ${locale.keys.length} table strings in both locales; no renderer exceptions`)
  console.log('\ntable preview check passed')
} finally {
  try { ws?.close() } catch {}
  try { child?.kill() } catch {}
  try { await server?.close() } catch {}
}
