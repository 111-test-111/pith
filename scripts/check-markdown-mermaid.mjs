/** Real packaged Mermaid images and interactions; no provider or remote renderer.
 * PI_MERMAID_SCREENSHOT_DIR retains complex flow/sequence images in both
 * interface styles and light/dark, plus enlarged Chinese label previews. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(repo, 'node_modules/.mermaid-check-'))
const fence = source => '```mermaid\n' + source + '\n```'
const flow = 'flowchart LR\n  A[用户输入] --> B{规划任务}\n  B -->|读取| C[收集上下文]\n  B -->|执行| D[调用工具]\n  C --> E[生成回复]\n  D --> E'
const complexFlow = (await readFile(join(repo,'scripts/fixtures/mermaid/service-flow.mmd'),'utf8')).trimEnd()
const complexSequence = (await readFile(join(repo,'scripts/fixtures/mermaid/order-sequence.mmd'),'utf8')).trimEnd()
const ordinaryImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#425eaa"/><circle cx="80" cy="40" r="24" fill="#d6e2ff"/></svg>').toString('base64')
const contrast = (a,b) => {
  const luminance=color=>color.match(/\d+/g).slice(0,3).map(channel=>{
    const value=Number(channel)/255
    return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4
  }).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0)
  const first=luminance(a),second=luminance(b)
  return (Math.max(first,second)+0.05)/(Math.min(first,second)+0.05)
}
let app
try {
  await writeFile(join(temporary, 'index.html'), `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Markdown} from '@/lib/markdown';
import {FileMarkdown} from '@/components/app/FileMarkdown';
import {ImagePreviewProvider} from '@/components/app/ImagePreview';
import {I18nProvider,useI18n} from '@/i18n';
import {applyUiStyle,setUiStyle} from '@/lib/ui-style';
import {setFontSizes} from '@/lib/typography';
import './fixture.css';
localStorage.setItem('pi-app:locale','en');
applyUiStyle('square'); window.setUiStyle=setUiStyle;
window.setFontSizes=setFontSizes;
const root = createRoot(document.getElementById('root'));
window.pi = {openExternal:async()=>{},openPath:async()=>{},readFile:async path=>({path,base64:${JSON.stringify(ordinaryImage)},mimeType:'image/svg+xml'})};
window.copiedSource = null;
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedSource=text}}});
function LocaleBridge({children}) { window.setLocale = useI18n().setLocale; return children; }
window.renderFixture = (text, options={}) => flushSync(()=>root.render(
  React.createElement(I18nProvider,null,React.createElement(LocaleBridge,null,
    React.createElement(ImagePreviewProvider,null,React.createElement('main',{id:'fixture',style:{width:options.width??720,padding:24}},
      ...(Array.isArray(text)?text:[text]).map((source,index)=>options.file
        ? React.createElement(FileMarkdown,{key:index,text:source})
        : React.createElement(Markdown,{key:index,streaming:options.streaming??false},source))))))));
window.renderFixture('Plain **Markdown**');
</script></body></html>`)
  await writeFile(join(temporary, 'fixture.css'), `@import ${JSON.stringify(join(repo, 'src/renderer/src/styles.css'))};\n@source ${JSON.stringify(join(repo, 'src/renderer/src'))};`)
  await build({ configFile:false, root:temporary, base:'./', logLevel:'error',
    resolve:{alias:{'@':join(repo,'src/renderer/src')}}, plugins:[react(),tailwindcss()],
    build:{outDir:join(temporary,'dist'),minify:true} })
  await writeFile(join(temporary, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary,'profile'))});
globalThis.mermaidDownloads=[];
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{backgroundThrottling:false}});
w.webContents.session.on('will-download',(_event,item)=>{item.setSavePath(${JSON.stringify(join(temporary,'mermaid.svg'))});item.once('done',(_event,state)=>globalThis.mermaidDownloads.push({state,name:item.getFilename(),path:item.getSavePath()}));});
w.loadFile(${JSON.stringify(join(temporary,'dist/index.html'))});});
app.on('window-all-closed',()=>app.quit());`)
  app = await _electron.launch({executablePath:electron,args:[join(temporary,'main.cjs')]})
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  const errors = [], remote = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()) })
  await page.waitForFunction(()=>window.renderFixture && document.querySelector('#fixture strong'))
  const resources = () => page.evaluate(()=>performance.getEntriesByType('resource').map(item=>item.name))
  assert.equal((await resources()).some(name=>/mermaid\.core|flowDiagram|elk\.bundled/.test(name)),false,'plain Markdown keeps Mermaid unloaded')
  const render = (text,options={}) => page.evaluate(({text,options})=>window.renderFixture(text,options),{text,options})
  const ready = async (count=1) => {
    await page.waitForFunction(count=>document.querySelectorAll('[data-mermaid-state="ready"] img').length===count,count)
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-mermaid-block] img')].every(img=>img.complete&&img.naturalWidth>0&&img.naturalHeight>0))
  }
  const image = () => page.locator('[data-mermaid-block] img').first()
  const svg = async () => decodeURIComponent((await image().getAttribute('src')).split(',').slice(1).join(','))
  const readableText = selector => image().evaluate((image,selector)=>{
    const parsed=new DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')),'image/svg+xml')
    const root=parsed.documentElement
    const host=document.createElement('div');host.style.visibility='hidden';document.body.append(host)
    host.attachShadow({mode:'closed'}).append(root)
    try {
      const font=parseFloat(getComputedStyle(root.querySelector(selector)).fontSize)
      const scale=image.getBoundingClientRect().width/root.viewBox.baseVal.width
      const css=getComputedStyle(document.documentElement)
      return {displayed:font*scale,compact:parseFloat(css.getPropertyValue('--app-text-ui-xs')),body:parseFloat(css.getPropertyValue('--app-text-ui-sm')),
        width:image.getBoundingClientRect().width,natural:image.naturalWidth}
    } finally {host.remove()}
  },selector)
  const assertReadable = async selector => {
    const text=await readableText(selector)
    assert.ok(Math.abs(text.displayed-text.compact)<0.1,`ordinary labels retain the compact interface size: ${JSON.stringify(text)}`)
    assert.ok(text.displayed<text.body,'ordinary diagram labels are one step smaller than interface body text')
    return text
  }
  const downloadSvg = async artwork => {
    const previous=await app.evaluate(()=>globalThis.mermaidDownloads.length)
    const completed=app.evaluate((_electron,previous)=>new Promise((resolve,reject)=>{
      const timer=setInterval(()=>{
        if(globalThis.mermaidDownloads.length>previous) {clearInterval(timer);clearTimeout(timeout);resolve(globalThis.mermaidDownloads.at(-1))}
      },25)
      const timeout=setTimeout(()=>{clearInterval(timer);reject(new Error('SVG download did not complete'))},10_000)
    }),previous)
    await page.getByRole('button',{name:'Download SVG image',exact:true}).click()
    const saved=await completed
    assert.equal(saved.state,'completed','Electron saves the generated image')
    assert.equal(saved.name,'mermaid.svg','download names the vector artwork as SVG')
    assert.equal(await readFile(saved.path,'utf8'),artwork,'download preserves the displayed SVG without rasterizing it')
  }
  const appearance = async update => {
    const previous = await page.locator('[data-mermaid-block] img').evaluateAll(images=>images.map(image=>image.src))
    await page.evaluate(update)
    await page.waitForFunction(previous=>[...document.querySelectorAll('[data-mermaid-block] img')].every((image,index)=>image.src!==previous[index])&&document.querySelectorAll('[data-mermaid-state="ready"]').length===previous.length,previous)
    await ready(previous.length)
  }
  // Inspect the self-contained artwork in an isolated tree, rather than
  // comparing incidental generated IDs or source implementation.
  const inspect = selectors => image().evaluate((image,selectors)=>{
    const parsed=new DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')),'image/svg+xml')
    const root=parsed.documentElement
    const host=document.createElement('div');host.style.visibility='hidden';document.body.append(host)
    host.attachShadow({mode:'closed'}).append(root)
    try { return selectors.map(selector=>{
      const node=root.querySelector(selector)
      if(!node) return null
      const frame=node.querySelector('foreignObject > div')??node.querySelector('rect.label-container,rect,path.label-container')??node
      const text=node.querySelector('text')??node
      const css=getComputedStyle(frame),label=getComputedStyle(text)
      return {fill:frame.localName==='div'?css.backgroundColor:css.fill,stroke:frame.localName==='div'?css.borderColor:css.stroke,
        text:label.fill,font:label.fontFamily,fontSize:label.fontSize,radius:css.borderRadius,corner:css.getPropertyValue('corner-shape'),
        dash:frame.localName==='div'?css.borderStyle:css.strokeDasharray,shape:frame.localName}
    }) } finally {host.remove()}
  },selectors)
  await render('```mermaid\nflowchart LR\nA[未完成',{streaming:true})
  assert.equal(await page.locator('[data-mermaid-block] img').count(),0)
  assert.equal(await page.getByRole('button',{name:'Download SVG image',exact:true}).isDisabled(),true,'streaming source cannot download an unfinished image')
  assert.equal(await page.getByRole('button',{name:'Open diagram preview',exact:true}).isDisabled(),true,'streaming source cannot open an unfinished image')
  assert.equal((await resources()).some(name=>/mermaid\.core|flowDiagram/.test(name)),false,'streaming source does not initialize the engine')
  await render(fence(flow))
  await ready()
  let artwork = await svg()
  assert.ok(artwork.includes('用户输入')&&artwork.includes('生成回复'),'CJK labels survive SVG rendering')
  assert.equal(await page.locator('[data-mermaid-measure]').count(),0,'temporary measurement DOM is removed')
  assert.equal(await page.locator('#fixture svg .node').count(),0,'diagram SVG never enters the application DOM')
  console.log('PASS: lazy loading, streaming source, settled CJK diagrams and isolated SVG images')

  const trigger = page.getByRole('button',{name:'Open diagram preview',exact:true})
  const inline = page.locator('[data-mermaid-viewport]')
  assert.equal(await inline.getAttribute('title'),null,'the canvas does not use a native title tooltip')
  assert.equal(await inline.getAttribute('aria-describedby'),null,'the canvas has no enlargement tooltip')
  const idle = await inline.screenshot()
  await inline.hover({position:{x:32,y:24}})
  await page.waitForTimeout(200)
  assert.equal(await page.getByRole('tooltip').count(),0,'hovering the diagram has no tooltip')
  assert.equal(await image().evaluate(element=>getComputedStyle(element).cursor),'grab','hovering the diagram shows a grab cursor')
  assert.ok(idle.equals(await inline.screenshot()),'hovering the diagram does not retint its artwork')
  await inline.click({position:{x:32,y:24}})
  assert.equal(await page.getByRole('dialog').count(),0,'clicking the canvas does not open the enlarged preview')
  await inline.dblclick({position:{x:32,y:24}})
  assert.equal(await page.getByRole('dialog').count(),0,'double-clicking the canvas also leaves it inline')
  await page.mouse.move(0,0)

  const wrap=page.getByRole('button',{name:'Wrap lines',exact:true})
  assert.equal(await wrap.isDisabled(),true,'preview leaves source wrapping disabled')
  await downloadSvg(artwork)
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  assert.equal(await page.locator('[data-mermaid-block] img').count(),0)
  assert.equal(await trigger.isDisabled(),false,'the header can preview already-rendered artwork while showing source')
  assert.ok((await page.locator('[data-code-block-pre] code').innerText()).includes('A[用户输入] --> B{规划任务}'))
  assert.equal(await wrap.isDisabled(),false)
  await wrap.click()
  assert.equal(await wrap.getAttribute('aria-pressed'),'true')
  assert.equal(await page.locator('[data-code-block-pre] code > span').first().locator('span').last().evaluate(element=>getComputedStyle(element).whiteSpace),'pre-wrap','the external header controls wrapping in the shared CodeBlock')
  await page.getByRole('button',{name:'Copy Mermaid source',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.copiedSource),flow,'copy retains original source, rather than SVG or rendered labels')
  await page.getByRole('tab',{name:'Preview',exact:true}).click()
  await ready()
  assert.equal(await wrap.isDisabled(),true)
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  assert.equal(await wrap.getAttribute('aria-pressed'),'true','view changes retain the source wrap preference')
  await wrap.click()
  assert.equal(await wrap.getAttribute('aria-pressed'),'false')
  await page.getByRole('tab',{name:'Preview',exact:true}).click()
  await ready()
  await trigger.focus()
  await trigger.press('Enter')
  await page.getByRole('dialog',{name:'Mermaid diagram',exact:true}).waitFor()
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] img')?.naturalWidth>0)
  await page.getByRole('button',{name:'Zoom in',exact:true}).click()
  const vectorImage=page.locator('[role="dialog"] img')
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] img')?.offsetWidth>0)
  const enlarged=await vectorImage.evaluate(element=>({width:element.offsetWidth,transform:getComputedStyle(element).transform}))
  assert.ok(enlarged.transform==='none'||Number(enlarged.transform.match(/matrix\(([^,]+)/)?.[1])===1,'vector zoom changes paint size instead of scaling an existing raster')
  await page.getByRole('button',{name:'Reset zoom',exact:true}).click()
  assert.ok((await vectorImage.evaluate(element=>element.offsetWidth))<enlarged.width/1.5,'reset restores the fixed fit size')
  await page.keyboard.press('Escape')
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'))
  assert.equal(await trigger.evaluate(element=>document.activeElement===element),true,'closing the zoom overlay restores keyboard focus')
  console.log('PASS: source/preview switching, source-only wrapping, exact copy, real SVG download, keyboard enlargement, vector zoom and focus restoration')

  assert.equal(await page.getByRole('button',{name:'Diagram style',exact:true}).count(),0,'the sole style needs no preset picker')
  await render(fence(complexFlow)); await ready()
  await assertReadable('.node text')
  const extent=await inline.evaluate(element=>({x:element.scrollWidth-element.clientWidth,y:element.scrollHeight-element.clientHeight}))
  assert.ok(extent.x>100&&extent.y>60,'complex diagrams retain native scale inside a two-dimensional canvas')
  await inline.evaluate(element=>{
    element.scrollLeft=0; element.scrollTop=0
    element.addEventListener('pointerdown',event=>window.dragPointer=event.pointerId)
  })
  const box=await inline.boundingBox(),start={x:box.x+box.width/2,y:box.y+120}
  await page.mouse.move(start.x,start.y)
  await page.mouse.down()
  assert.equal(await inline.evaluate(element=>getComputedStyle(element).cursor),'grabbing','holding the canvas uses the grabbing cursor')
  assert.ok(await inline.evaluate(element=>element.hasPointerCapture(window.dragPointer)),'the canvas captures the active pointer')
  await page.mouse.move(start.x-100,start.y-60,{steps:4})
  const dragged=await inline.evaluate(element=>({x:element.scrollLeft,y:element.scrollTop}))
  assert.ok(Math.abs(dragged.x-100)<1&&Math.abs(dragged.y-60)<1,'dragging follows both pointer axes without scaling the diagram')
  await assertReadable('.node text')
  await inline.evaluate(element=>element.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.dragPointer,bubbles:true})))
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-mermaid-viewport]')).cursor==='grab')
  await page.mouse.move(start.x-140,start.y-90)
  assert.deepEqual(await inline.evaluate(element=>({x:element.scrollLeft,y:element.scrollTop})),dragged,'a cancelled pointer cannot keep panning')
  await page.mouse.up()
  await inline.evaluate(element=>{element.scrollLeft=0;element.scrollTop=0})
  await page.mouse.move(start.x,start.y)
  await page.mouse.down()
  await page.mouse.move(box.x-16,box.y-16,{steps:4})
  assert.ok(await inline.evaluate(element=>element.scrollLeft>100&&element.scrollTop>100),'captured dragging continues outside the canvas')
  await page.mouse.up()
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-mermaid-viewport]')).cursor==='grab')
  assert.equal(await inline.evaluate(element=>element.hasPointerCapture(window.dragPointer)),false,'release outside ends pointer capture')
  assert.equal(await page.getByRole('dialog').count(),0,'dragging never opens the image viewer')
  await inline.evaluate(element=>{element.scrollLeft=0;element.scrollTop=0})
  await page.mouse.move(start.x,start.y)
  await page.mouse.down()
  await page.mouse.move(start.x-40,start.y-30)
  const beforeLoss=await inline.evaluate(element=>({x:element.scrollLeft,y:element.scrollTop}))
  await inline.evaluate(element=>element.releasePointerCapture(window.dragPointer))
  // Chromium processes pending capture changes before the next pointer event.
  await page.mouse.move(start.x-100,start.y-60)
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-mermaid-viewport]')).cursor==='grab')
  assert.deepEqual(await inline.evaluate(element=>({x:element.scrollLeft,y:element.scrollTop})),beforeLoss,'lost capture stops the gesture')
  await page.mouse.up()
  await page.mouse.move(start.x,start.y)
  await page.mouse.down()
  await page.getByRole('tab',{name:'Source',exact:true}).evaluate(element=>element.click())
  await page.mouse.up()
  await page.getByRole('tab',{name:'Preview',exact:true}).click()
  await ready()
  assert.equal(await inline.evaluate(element=>getComputedStyle(element).cursor),'grab','switching view clears an active gesture')
  console.log('PASS: neutral Mermaid hover, click without enlargement, direct two-axis dragging, cancellation, lost capture and release outside')
  const selectors=['[id*="-flowchart-QSVC-"]','[id*="-flowchart-E401-"]','[id*="-flowchart-DB-"]','[id*="-flowchart-ROUTE-"]']
  const blue=await inspect(selectors)
  assert.equal(blue[1].fill,'rgb(61, 31, 37)','explicit class fill survives the app theme')
  assert.equal(blue[1].text,'rgb(255, 220, 215)','explicit class text color survives the app theme')
  assert.equal(blue[2].fill,'rgb(23, 58, 44)','cylinders retain their source color and semantics')
  assert.notEqual(blue[3].dash,'none','decision frames remain visibly distinct')
  assert.ok(await image().evaluate(image=>{
    const root=new DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')),'image/svg+xml').documentElement
    const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'closed'}).append(root)
    try { return [...root.querySelectorAll('.edgeLabel .label')].filter(label=>label.textContent.trim()).every(label=>{
      const node=label.querySelector('text'),text=node.getBBox(),frame=label.querySelector('rect.background').getBBox()
      const font=parseFloat(getComputedStyle(node).fontSize)
      return frame.width>=text.width+font*1.2&&frame.height>=text.height+font*0.4
    }) } finally {host.remove()}
  }),'edge label frames reserve readable padding around the text')
  await render(fence('flowchart LR\n A{指定颜色} --> B[默认颜色]\n classDef explicit fill:#173a2c,stroke:#3fb950,color:#c9f7d8\n class A explicit'))
  await ready()
  const explicitDecision=(await inspect(['[id*="-flowchart-A-"]']))[0]
  assert.equal(explicitDecision.fill,'rgb(23, 58, 44)','decision styling preserves an explicit source fill')
  await render(fence(complexFlow)); await ready()
  await appearance(()=>document.documentElement.dataset.accent='emerald')
  const green=await inspect(selectors)
  assert.notEqual(green[0].fill,blue[0].fill,'uncolored nodes follow the app accent')
  assert.equal(green[1].fill,blue[1].fill,'accent changes do not retint explicit fills')
  assert.equal(green[2].fill,blue[2].fill,'accent changes do not retint explicit cylinder fills')
  const samples={}
  for(const dark of [false,true]) for(const style of ['square','squircle']) {
    // Switch away and back to also exercise a cached theme/corner result.
    await render('Plain Markdown')
    await page.evaluate(({dark,style})=>{document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.accent='blue';window.setUiStyle(style)},{dark,style})
    for(const [kind,source] of [['flow',complexFlow],['sequence',complexSequence]]) {
      await render(fence(source)); await ready()
      await assertReadable(kind==='flow'?'.node text':'.messageText')
      samples[`${kind}-${dark?'dark':'light'}-${style}`]=await image().getAttribute('src')
      artwork=await svg()
      assert.ok(artwork.includes(kind==='flow'?'可观测性':'释放库存并标记 FAILED'),'complex diagram retains Chinese labels and nested groups')
      const frames=await inspect(kind==='flow'?selectors:['rect.actor','foreignObject'])
      const first=kind==='flow'?frames[0]:frames.find(Boolean)
      assert.ok(first,'participant/node artwork exists')
      if(style==='squircle') {
        assert.equal(first.shape,'div','rectangular frames use native CSS geometry')
        const appCorner=await page.getByRole('tab',{name:'Preview',exact:true}).evaluate(element=>getComputedStyle(element).getPropertyValue('corner-shape'))
        assert.equal(first.corner,appCorner,'the diagram uses the same native corner shape as the app')
        assert.notEqual(first.radius,'0px')
      } else assert.notEqual(first.shape,'div','square frames retain crisp SVG rectangles')
      if(kind==='sequence') {
        const [number,badge]=await inspect(['.sequenceNumber','marker[id$="-sequencenumber"] circle'])
        assert.ok(contrast(number.fill,badge.fill)>=4.5,'autonumber labels remain readable in both color modes')
      }
      if(kind==='flow'&&!dark&&style==='squircle') await downloadSvg(artwork)
      if(process.env.PI_MERMAID_SCREENSHOT_DIR) {
        await mkdir(process.env.PI_MERMAID_SCREENSHOT_DIR,{recursive:true})
        const inline=page.locator('[data-mermaid-viewport]')
        await page.mouse.move(0,0)
        await page.evaluate(()=>document.activeElement instanceof HTMLElement&&document.activeElement.blur())
        await page.waitForFunction(()=>!document.querySelector('[role="tooltip"]'))
        await inline.evaluate(element=>{element.scrollLeft=0;element.scrollTop=0})
        await inline.screenshot({path:join(process.env.PI_MERMAID_SCREENSHOT_DIR,`${kind}-${dark?'dark':'light'}-${style}.png`)})
        await writeFile(join(process.env.PI_MERMAID_SCREENSHOT_DIR,`${kind}-${dark?'dark':'light'}-${style}.svg`),artwork)
        if(!dark&&style==='squircle') {
          await trigger.click()
          await page.locator('[role="dialog"] img').waitFor()
          await page.getByRole('button',{name:'Zoom in',exact:true}).click()
          await page.getByRole('button',{name:'Zoom in',exact:true}).click()
          await page.getByRole('button',{name:'Zoom in',exact:true}).click()
          const viewport=page.getByRole('group',{name:'Zoomable image preview',exact:true})
          await viewport.screenshot({path:join(process.env.PI_MERMAID_SCREENSHOT_DIR,`${kind}-enlarged.png`)})
          await viewport.evaluate(element=>element.dispatchEvent(new WheelEvent('wheel',{deltaX:40,deltaY:30,deltaMode:0,bubbles:true,cancelable:true})))
          const limits=await page.locator('[role="dialog"] img').evaluate(element=>{
            const box=element.parentElement, matrix=new DOMMatrix(getComputedStyle(element).transform)
            return {x:matrix.e,y:matrix.f,limitX:Math.max(0,(element.offsetWidth-box.clientWidth)/2),limitY:Math.max(0,(element.offsetHeight-box.clientHeight)/2)}
          })
          assert.ok(Math.abs(limits.x)<=limits.limitX+1&&Math.abs(limits.y)<=limits.limitY+1,'vector pan limits use the fitted basis without multiplying zoom twice')
          assert.ok(limits.x<0&&limits.y<0,'enlarged diagrams pan in both axes')
          await page.keyboard.press('Escape')
          await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'))
        }
      }
    }
  }
  await render(fence(complexFlow)); await ready()
  await appearance(()=>{document.documentElement.style.setProperty('--app-font-ui','"PingFang SC", sans-serif');window.setFontSizes({ui:18,content:14,code:12})})
  let typography=(await inspect(selectors))[0]
  assert.ok(typography.font.includes('PingFang SC'),'the graph uses the configured interface font')
  assert.equal(typography.fontSize,'15px','the graph follows the compact size when interface body text changes to 18px')
  await assertReadable('.node text')
  await render(fence(complexSequence)); await ready()
  const [messageTypography,numberTypography]=await inspect(['.messageText','.sequenceNumber'])
  assert.ok(messageTypography.font.includes('PingFang SC'),'sequence messages use the configured interface font too')
  assert.ok(numberTypography.font.includes('PingFang SC'),'sequence numbers use the configured interface font too')
  await assertReadable('.messageText')
  await render(fence(complexFlow)); await ready()
  await appearance(()=>document.documentElement.style.setProperty('--app-font-ui','monospace'))
  typography=(await inspect(selectors))[0]
  assert.equal(typography.font,'monospace','changing interface font regenerates existing previews')
  await appearance(()=>{document.documentElement.style.removeProperty('--app-font-ui');window.setFontSizes({ui:14,content:14,code:12})})
  if(process.env.PI_MERMAID_SCREENSHOT_DIR) await writeFile(join(process.env.PI_MERMAID_SCREENSHOT_DIR,'styles.json'),JSON.stringify(samples))
  await appearance(()=>document.documentElement.classList.remove('dark'))
  console.log('PASS: complex ELK flow/sequence diagrams, square/native squircle, restrained app accents, explicit colors and live interface fonts')

  await render('---\ntitle: 示例\n---\n\n# Markdown 文件\n\n'+fence(flow),{file:true,width:360})
  await ready()
  assert.equal(await page.locator('[data-file-frontmatter]').count(),1)
  assert.ok(await page.locator('#fixture').evaluate(element=>element.scrollWidth<=element.clientWidth),'narrow file previews retain bounded geometry')
  const readable=await assertReadable('.node text')
  const savedSource=await image().getAttribute('src')
  assert.equal(await inline.evaluate(element=>element.scrollWidth>element.clientWidth),true,'a wide diagram scrolls inside its frame instead of shrinking labels')
  await inline.evaluate(element=>element.scrollLeft=0)
  await inline.evaluate(element=>element.dispatchEvent(new WheelEvent('wheel',{deltaX:60,deltaY:0,deltaMode:0,bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>document.querySelector('[data-mermaid-viewport]').scrollLeft>0)
  await inline.evaluate(element=>element.scrollLeft=0)
  await inline.evaluate(element=>element.dispatchEvent(new WheelEvent('wheel',{deltaX:0,deltaY:60,deltaMode:0,shiftKey:true,bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>document.querySelector('[data-mermaid-viewport]').scrollLeft>0)
  await inline.evaluate(element=>element.scrollLeft=0)
  await inline.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(()=>document.querySelector('[data-mermaid-viewport]').scrollLeft>0)
  await render(fence(flow),{file:true,width:900}); await ready()
  assert.equal(await image().getAttribute('src'),savedSource,'pane resizing reuses the existing artwork')
  const wider=await assertReadable('.node text')
  assert.equal(wider.width,readable.width,'pane width cannot change displayed diagram scale')
  await render(fence(flow),{file:true,width:360}); await ready()
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  await page.getByRole('tab',{name:'Preview',exact:true}).click()
  await ready()
  await inline.evaluate(element=>element.scrollLeft=0)
  await inline.evaluate(element=>element.dispatchEvent(new WheelEvent('wheel',{deltaX:60,deltaY:0,deltaMode:0,bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>document.querySelector('[data-mermaid-viewport]').scrollLeft>0)
  if(process.env.PI_MERMAID_SCREENSHOT_DIR) {
    await inline.evaluate(element=>element.scrollLeft=0)
    await inline.screenshot({path:join(process.env.PI_MERMAID_SCREENSHOT_DIR,'readable-narrow.png')})
  }
  assert.ok(await page.getByRole('button',{name:'Copy Mermaid source',exact:true}).evaluate(element=>{
    const header=element.closest('[data-mermaid-block]').firstElementChild
    const button=element.getBoundingClientRect(),row=header.getBoundingClientRect()
    return button.right<=row.right&&button.top>=row.top&&button.bottom<=row.bottom
  }),'all header actions fit the same row in a narrow file pane')
  if(process.env.PI_MERMAID_SCREENSHOT_DIR) await page.locator('[data-mermaid-block] > div').first().screenshot({path:join(process.env.PI_MERMAID_SCREENSHOT_DIR,'toolbar-narrow.png')})
  await page.getByRole('tab',{name:'Source',exact:true}).click()
  const codeViewport=page.locator('[data-code-block-pre]').locator('..')
  const narrowSource=flow+'\n%% '+ '保持中文源码原样并自动换行 '.repeat(24)
  await render(fence(narrowSource),{file:true,width:360})
  assert.equal(await codeViewport.evaluate(element=>element.scrollWidth>element.clientWidth),true,'unwrapped long source scrolls inside its code viewport')
  await wrap.click()
  assert.equal(await codeViewport.evaluate(element=>element.scrollWidth<=element.clientWidth),true,'wrapped source fits a narrow pane without horizontal overflow')
  await page.getByRole('button',{name:'Copy Mermaid source',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.copiedSource),narrowSource,'wrapping does not modify copied source bytes')
  const sequence='sequenceDiagram\n  participant U as 用户\n  participant A as 助手\n  U->>A: 请解释代码\n  A-->>U: 返回结果'
  await render([fence(flow),fence(sequence)])
  await ready(2)
  assert.ok(decodeURIComponent(await page.locator('[data-mermaid-block]').nth(1).locator('img').getAttribute('src')).includes('返回结果'),'concurrent blocks retain their own diagram types')
  console.log('PASS: readable compact labels, pane resizing without rerender, wheel/Shift/keyboard scrolling, file frontmatter and concurrent flow/sequence diagrams')

  await render(fence('flowchart LR\n A[broken --> B'))
  await page.waitForFunction(()=>document.querySelector('[data-mermaid-state="failed"]'))
  assert.equal(await page.locator('[data-code-block-pre]').count(),1,'invalid diagrams remain readable as source')
  assert.equal(await trigger.isDisabled(),true,'failed diagrams cannot open the image viewer')
  assert.equal(await page.locator('[data-mermaid-measure]').count(),0,'failed render containers are disposed')
  await render(fence(flow))
  await ready()
  await render(fence('flowchart LR\n A[stale] --> B'))
  await render(fence(sequence))
  await ready()
  assert.ok((await svg()).includes('返回结果')&&!(await svg()).includes('stale'),'superseded requests cannot replace a newer diagram')
  await render(fence('flowchart LR\n'+ '%% oversized\n'.repeat(5000)))
  assert.equal(await image().count(),0,'oversized diagrams stay as bounded source')
  assert.equal(await trigger.isDisabled(),true,'oversized source cannot open a stale image')
  await render(fence('%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"@import url(https://invalid.example/style.css)","themeVariables":{"primaryTextColor":"#ff0000"}}}%%\nflowchart LR\n A["<img src=x onerror=alert(1)>"] --> B[Safe]\n click B "javascript:alert(1)"'))
  await ready()
  artwork=await svg()
  assert.ok(!/<script|<image|<a[\s>]|onerror=|@import|javascript:/i.test(artwork),'source directives and labels do not add executable or external SVG content')
  assert.ok(await image().evaluate(image=>{
    const svg=new DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')),'image/svg+xml')
    return [...svg.querySelectorAll('foreignObject')].every(frame=>frame.hasAttribute('data-mermaid-frame')&&frame.children.length===1&&frame.firstElementChild.localName==='div'&&frame.firstElementChild.children.length===0&&!frame.textContent.trim())
  }),'only trusted empty frames, never source HTML, can use native corner geometry')
  assert.deepEqual(remote,[],'ordinary diagrams and malicious directives need no network renderer')
  console.log('PASS: invalid/oversized fallbacks, recovery, stale-result cancellation and directive confinement')

  await render('![First](first.svg)\n\n'+fence(flow)+'\n\n![Second](second.svg)')
  await ready()
  const photo=page.getByRole('button',{name:'Preview image First',exact:true})
  await page.waitForFunction(()=>[...document.querySelectorAll('#fixture img')].every(image=>image.complete&&image.naturalWidth>0))
  await photo.hover()
  assert.equal(await photo.evaluate(element=>getComputedStyle(element).cursor),'zoom-in','ordinary images retain their preview cursor')
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Preview image First"] span')).backgroundColor!=='rgba(0, 0, 0, 0)')
  await photo.click()
  await page.getByRole('dialog',{name:'First',exact:true}).waitFor()
  await page.getByLabel('Image 1 of 3',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Next image',exact:true}).click()
  await page.getByRole('dialog',{name:'Mermaid diagram',exact:true}).waitFor()
  await page.getByLabel('Image 2 of 3',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Next image',exact:true}).click()
  await page.getByRole('dialog',{name:'Second',exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'))
  assert.equal(await photo.evaluate(element=>document.activeElement===element),true,'ordinary image previews still restore thumbnail focus')
  await trigger.click()
  await page.getByRole('dialog',{name:'Mermaid diagram',exact:true}).waitFor()
  await page.getByLabel('Image 2 of 3',{exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'))
  assert.equal(await trigger.evaluate(element=>document.activeElement===element),true,'the toolbar remains the Mermaid preview focus target')
  console.log('PASS: ordinary image hover/click/focus and mixed image-gallery navigation remain unchanged')

  for (const [locale,sourceLabel,previewLabel] of [['zh-CN','源码','放大预览'],['zh-TW','原始碼','放大預覽'],['en','Source','Open diagram preview']]) {
    await page.evaluate(locale=>window.setLocale(locale),locale)
    await page.getByRole('tab',{name:sourceLabel,exact:true}).waitFor()
    await page.getByRole('button',{name:previewLabel,exact:true}).waitFor()
  }
  assert.deepEqual(errors,[],'no uncaught renderer errors')
  console.log('PASS: English, Simplified Chinese and Taiwan Traditional Chinese labels')
} finally {
  await app?.close()
  await rm(temporary,{recursive:true,force:true})
}
