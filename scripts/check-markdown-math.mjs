/** Real packaged/file:// Markdown math, in isolated Electron; no model calls.
 * PI_MATH_SCREENSHOT_DIR retains light/dark previews. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(repo, 'node_modules/.math-check-'))
let app
try {
  // The app runs Vite's development exports; the packaged renderer does not.
  // Only the former enables micromark's token assertions. Check BOTH with
  // the real shared plugin stack, including every possible streaming prefix.
  const commandFirst = String.raw`行内 \(\frac{\partial u}{\partial t}=\alpha\nabla^2 u\)，求和 \(\sum_{k=1}^{n}k^2\)。`
  const quantumMessage = String.raw`1. **Part 1** distributes the product into the four tensor-operator terms, proves the polarisation identity $\ketbra{x}{y} = \frac14\sum_k \ii^k \proj{x+\ii^k y}$ by expanding and using $\sum_k \ii^k = 0$ and $\sum_k \ii^{2k} = 0$ (the hint), applies it to both cross terms, and boxes the full decomposition in the compact $\frac18\sum_{k,l}\cos((k+l)\pi/2)\,P_k\otimes Q_l$ form.`
  const quantumSources = [
    String.raw`\ketbra{x}{y} = \frac14\sum_k \ii^k \proj{x+\ii^k y}`,
    String.raw`\sum_k \ii^k = 0`, String.raw`\sum_k \ii^{2k} = 0`,
    String.raw`\frac18\sum_{k,l}\cos((k+l)\pi/2)\,P_k\otimes Q_l`
  ]
  const tokenizerCases = [commandFirst, quantumMessage, String.raw`\(\)`, String.raw`\[\]`,
    String.raw`\[\alpha + \frac12\]`, String.raw`$\alpha$`, String.raw`\(\\x\)`,
    String.raw`\(x\q+\frac12\)`, String.raw`\(\]x\)`, String.raw`\[\)x\]`,
    '$5 and $x$ and $10', '$x$5', '$x $', '$\\$10$',
    '> \\[\n> \\frac12\n>\n> +x\n> \\]',
    '> $$\nx\n=\n\\frac12\n$$', '- \\[\n  \\frac12\n\n  +x\n  \\]',
    '`\\(\\frac12\\)`', '```tex\n\\(\\frac12\\)\n```']
  let sessionTexts = []
  if (process.env.PI_MATH_SESSION_PATH) {
    sessionTexts = (await readFile(process.env.PI_MATH_SESSION_PATH, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line).message).filter(message => message?.role === 'assistant')
      .flatMap(message => (Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'text').map(part => part.text))
  }
  for (const mode of ['development', 'production']) {
    const helper = join(temporary, `parser-${mode}.mjs`)
    await bundle({ stdin: { contents: `
      import {unified} from 'unified'; import remarkParse from 'remark-parse';
      import {REMARK_PLUGINS} from './src/renderer/src/lib/markdown-plugins';
      import {normalizeQuotedMath} from './src/renderer/src/lib/markdown-quoted-math';
      import {splitMarkdownBlocks} from './src/renderer/src/lib/markdown-blocks';
      const p = unified().use(remarkParse).use(REMARK_PLUGINS);
      export const parse = text => { const source = normalizeQuotedMath(text); return p.runSync(p.parse(source), source) };
      export const split = splitMarkdownBlocks;
    `, resolveDir: repo }, outfile: helper, bundle: true, format: 'esm', platform: 'node', conditions: [mode],
      banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" } })
    const { parse, split } = await import(pathToFileURL(helper))
    for (const source of [...tokenizerCases, ...sessionTexts]) {
      assert.doesNotThrow(() => parse(source), `${mode}: completed source`)
      for (let i = 0; i <= source.length; i++) {
        const { tail } = split(source.slice(0, i))
        assert.doesNotThrow(() => parse(tail), `${mode}: streaming prefix ${i}`)
      }
    }
    for (const source of [String.raw`\(\frac12\)`, String.raw`\[\frac12\]`, String.raw`$\frac12$`]) {
      const node = parse(source).children[0].children[0]
      assert.equal(node.type, 'inlineMath')
      assert.equal(node.value, String.raw`\frac12`, 'leading command remains intact after delimiter lookahead')
    }
    assert.equal(parse(String.raw`\(\)`).children[0].children[0].value, '', 'empty TeX has no empty data token')
  }
  console.log('PASS: development/production parser assertions, command-first/empty/mismatched TeX and every streaming prefix')

  await writeFile(join(temporary, 'index.html'), `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Markdown} from '@/lib/markdown';
import {FileMarkdown} from '@/components/app/FileMarkdown';
import {REMARK_PLUGINS} from '@/lib/markdown-plugins';
import {FileNotebook} from '@/components/app/FileNotebook';
import {ImagePreviewProvider} from '@/components/app/ImagePreview';
import {splitMarkdownBlocks} from '@/lib/markdown-blocks';
import {normalizeQuotedMath} from '@/lib/markdown-quoted-math';
import {I18nProvider,useI18n} from '@/i18n';
import './fixture.css';
window.caughtErrors = [];
const root = createRoot(document.getElementById('root'), {onCaughtError: error => window.caughtErrors.push(error.message)});
REMARK_PLUGINS.push(() => (_tree, file) => {
  if (String(file).includes('<!--math-check-fail-->')) throw new Error('Injected Markdown parser failure');
});
window.pi = {openExternal: async()=>{}, openPath: async()=>{}};
window.splitMarkdownBlocks = splitMarkdownBlocks;
window.normalizeQuotedMath = normalizeQuotedMath;
function LocaleBridge({children}) { window.setFixtureLocale = useI18n().setLocale; return children; }
const localized = child => React.createElement(I18nProvider,null,React.createElement(LocaleBridge,null,child));
window.renderFixture = (text, streaming = false, width = 640) => flushSync(() => root.render(
  localized(React.createElement('main',{id:'fixture',style:{width,padding:24}},
    React.createElement(Markdown,{streaming},text)))));
window.renderFileFixture = (text, copies = 1) => flushSync(() => root.render(localized(
  React.createElement('main',{id:'fixture',style:{display:'flex',gap:24}},
    Array.from({length:copies},(_,index)=>React.createElement('div',{key:index,'data-file-markdown':true,style:{width:400,height:520,padding:24,overflow:'auto'}},React.createElement(FileMarkdown,{text})))))));
window.renderNotebook = (text, width = 540) => flushSync(() => root.render(
  React.createElement(I18nProvider,null,React.createElement(ImagePreviewProvider,null,React.createElement('main',{id:'fixture',style:{width,height:850,display:'flex',flexDirection:'column'}},
    React.createElement(FileNotebook,{text,truncated:false,tab:{path:'/fixture/example.ipynb',cwd:'/fixture'},store:{open:()=>{}}}))))));
window.instrumentMath = async () => {
  const {default:temml} = await import('temml');
  const original = temml.renderToString;
  window.mathCalls = 0;
  temml.renderToString = (...args) => { window.mathCalls++; return original(...args) };
};
window.renderFixture('普通 Markdown **加粗**.');
</script></body></html>`)
  await writeFile(join(temporary, 'fixture.css'), `@import ${JSON.stringify(join(repo, 'src/renderer/src/styles.css'))};\n@source ${JSON.stringify(join(repo, 'src/renderer/src'))};`)
  await build({
    configFile: false, root: temporary, base: './', logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: { outDir: join(temporary, 'dist'), minify: true }
  })
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(temporary, 'dist/index.html'))});});
app.on('window-all-closed',()=>app.quit());`)
  app = await _electron.launch({ executablePath: electron, args: [main] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => !!window.renderFixture && document.querySelector('#fixture strong'))
  assert.equal(await page.locator('math').count(), 0)
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => /math-renderer|\.woff2/.test(r.name))), false,
    'plain Markdown does not fetch the formula engine or fonts')
  const render = async (text, streaming = false, width = 640) => {
    await page.evaluate(({text, streaming, width}) => window.renderFixture(text, streaming, width), {text, streaming, width})
  }
  const count = async n => {
    try { await page.waitForFunction(n => document.querySelectorAll('math').length === n, n) }
    catch (error) { throw new Error(`Expected ${n} math nodes, got ${await page.locator('math').count()}: ${await page.locator('#fixture').innerText()}\n${errors.join('\n')}`, {cause:error}) }
    await page.evaluate(() => document.fonts.ready)
  }

  const rich = String.raw`# 数学公式 / Math

中文行内 $E=mc^2$，以及 \(x_1^2+\alpha\)，不会影响 **加粗：**正文。

$$\frac{a+b}{c}$$

\[\sqrt{x^2+y^2}\]

$$
\begin{aligned}
a &= b+c \\

d &= \sum_{i=1}^{n} i
\end{aligned}
$$

\[
\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}
\]

` + '```math\n\\int_0^1 x^2\\,dx = \\frac13\n```' + String.raw`

| Formula | Description |
| --- | --- |
| $\beta^2$ | Table math |

> Blockquote: $\gamma$.

- List: $\delta$.
`
  await render(rich)
  await count(10)
  assert.equal(await page.locator('[data-math-rendered=inline]').count(), 5)
  assert.equal(await page.locator('[data-math-rendered=display]').count(), 5)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0)
  assert.equal(await page.locator('math').first().evaluate(e => e.namespaceURI), 'http://www.w3.org/1998/Math/MathML')
  assert.equal(await page.locator('annotation[encoding="application/x-tex"]').count(), 10)
  assert.ok(await page.locator('mfrac').first().evaluate(e => e.children[1].getBoundingClientRect().top > e.children[0].getBoundingClientRect().top), 'native fraction layout')
  assert.ok(await page.locator('mtable:not(.tml-jot) mtd').first().evaluate(e => parseFloat(getComputedStyle(e).paddingTop) > 0), 'matrix spacing survives Tailwind preflight')
  assert.ok(await page.evaluate(() => document.fonts.check('16px "Pith Math"')), 'bundled math font loads over file://')
  const familyOf = () => page.locator('math').first().evaluate(e => getComputedStyle(e).fontFamily)
  await page.evaluate(() => document.documentElement.style.setProperty('--app-font-math', "'STIX Two Math', 'Pith Math', math"))
  assert.ok((await familyOf()).includes('STIX Two Math'), 'the math font setting leads the formula stack')
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-font-math'))
  const restored = await familyOf()
  assert.ok(restored.includes('Pith Math') && !restored.includes('STIX'), 'without the setting the bundled face is the default')
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
    const colors = await page.locator('math').first().evaluate(e => [getComputedStyle(e).color, getComputedStyle(document.querySelector('#fixture > div')).color])
    assert.equal(colors[0], colors[1], 'math inherits current theme')
    if (process.env.PI_MATH_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_MATH_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({path: join(process.env.PI_MATH_SCREENSHOT_DIR, dark ? 'dark.png' : 'light.png')})
    }
  }
  console.log('PASS: all delimiters, CJK, tables/lists/quotes, native MathML, light/dark, packaged fonts')

  // This exact paragraph previously rendered only its fourth formula. The
  // first three depend on common document macros absent from the math engine.
  await render(quantumMessage)
  await count(4)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0)
  assert.deepEqual(await page.locator('annotation').allTextContents(), quantumSources)
  const quantumHTML = await page.locator('math').evaluateAll(nodes => nodes.map(node => node.outerHTML))
  await page.evaluate(source => {
    for (let i = 0; i <= source.length; i++) window.renderFixture(source.slice(0, i), true)
  }, quantumMessage)
  await count(4)
  assert.deepEqual(await page.locator('math').evaluateAll(nodes => nodes.map(node => node.outerHTML)), quantumHTML, 'all four reported quantum formulas agree after streaming')
  assert.deepEqual(await page.evaluate(() => window.caughtErrors), [], 'quantum macros do not introduce transient streaming failures')
  await page.reload()
  await page.waitForFunction(() => !!window.renderFixture)
  await render(quantumMessage)
  await count(4)
  assert.deepEqual(await page.locator('math').evaluateAll(nodes => nodes.map(node => node.outerHTML)), quantumHTML, 'all four quantum formulas render after a cold reopen')
  await page.evaluate(text => window.renderFileFixture(text), quantumMessage)
  await count(4)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'file Markdown shares the quantum defaults')
  await page.evaluate(source => window.renderNotebook(JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{cell_type: 'markdown', metadata: {}, source: [source]}]
  })), quantumMessage)
  await count(4)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'notebook Markdown shares the quantum defaults')
  if (process.env.PI_MATH_SCREENSHOT_DIR) {
    await render(quantumMessage, false, 1040)
    await count(4)
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
      await page.locator('#fixture').screenshot({path:join(process.env.PI_MATH_SCREENSHOT_DIR, `quantum-${dark?'dark':'light'}.png`)})
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
  }
  console.log('PASS: exact reported quantum paragraph renders all four formulas during streaming, cold reopen, file and notebook previews')

  // The reported historical message uses mathtools' compact fenced matrix,
  // not a code span. Preserve the original annotation and every matrix cell.
  const reportedMatrix = String.raw`\frac12\begin{psmallmatrix} p&0&p&0\\ 0&0&0&0\\ p&0&1&-(1-p)\\ 0&0&-(1-p)&1-p \end{psmallmatrix}`
  const reportedMessage = `已改为正确矩阵 $${reportedMatrix}$ 并同步修正迹验证行。`
  await render(reportedMessage)
  await count(1)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0)
  assert.equal(await page.locator('mtable > mtr').count(), 4)
  assert.equal(await page.locator('mtable > mtr > mtd').count(), 16)
  assert.equal(await page.locator('annotation').textContent(), reportedMatrix, 'compatibility retains original TeX for copying/accessibility')
  const reportedHTML = await page.locator('math').evaluate(node => node.outerHTML)
  await page.evaluate(source => {
    for (let i = 0; i <= source.length; i++) window.renderFixture(source.slice(0, i), true)
  }, reportedMessage)
  await count(1)
  assert.equal(await page.locator('math').evaluate(node => node.outerHTML), reportedHTML, 'streamed historical matrix matches the completed formula')
  await page.reload()
  await page.waitForFunction(() => !!window.renderFixture)
  await render(reportedMessage)
  await count(1)
  assert.equal(await page.locator('math').evaluate(node => node.outerHTML), reportedHTML, 'a cold reopen renders the historical matrix')
  await page.evaluate(text => window.renderFileFixture(text), reportedMessage)
  await count(1)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'file Markdown shares the compatibility layer')
  await page.evaluate(source => window.renderNotebook(JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{cell_type: 'markdown', metadata: {}, source: [source]}]
  })), reportedMessage)
  await count(1)
  assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'notebook Markdown shares the compatibility layer')

  const fences = [
    ['p', '(', ')'], ['b', '[', ']'], ['B', '{', '}'],
    ['v', '|', '|'], ['V', '‖', '‖']
  ]
  for (const [prefix, left, right] of fences) {
    for (const align of [null, 'c', 'l', 'r']) {
      const environment = `${prefix}smallmatrix${align ? '*' : ''}`
      const source = `\\begin{${environment}}${align ? `[${align}]` : ''}1&22\\\\[2pt]333&4\\end{${environment}}`
      await render(`$${source}$`)
      await count(1)
      assert.equal(await page.locator('[data-math-fallback]').count(), 0, environment)
      assert.equal(await page.locator('mtable > mtr > mtd').count(), 4)
      assert.deepEqual(await page.locator('math mo[fence=true][stretchy=true]').evaluateAll(nodes => nodes.map(node => node.textContent)), [left, right])
      assert.equal(await page.locator('annotation').textContent(), source)
      if (align === 'l' || align === 'r') {
        const expected = align === 'l' ? 'left' : 'right'
        assert.ok((await page.locator('mtable > mtr > mtd').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textAlign))).every(value => value.includes(expected)), 'starred compact matrices align every column')
      }
    }
  }
  await render(String.raw`$\begin{smallmatrix*}[r]1&22\\333&4\end{smallmatrix*}$ $\begin{pmatrix}1&22\\333&4\end{pmatrix}$`)
  await count(2)
  const matrixSizes = await page.locator('math').evaluateAll(nodes => nodes.map(node => ({
    height: node.querySelector('mtable').getBoundingClientRect().height,
    font: parseFloat(getComputedStyle(node.querySelector('mn')).fontSize)
  })))
  assert.ok(matrixSizes[0].font < matrixSizes[1].font && matrixSizes[0].height < matrixSizes[1].height, 'aligned smallmatrix retains compact glyphs and rows')
  const nestedMatrix = String.raw`\begin{bsmallmatrix*}[r]\begin{psmallmatrix}1&2\\3&4\end{psmallmatrix}&5\\6&7\end{bsmallmatrix*}`
  await render(`$${nestedMatrix}$`)
  await count(1)
  assert.equal(await page.locator('mtable').count(), 2)
  assert.equal(await page.locator('mtable > mtr > mtd').count(), 8, 'nested matrices retain their own row/cell separators')
  const commentedMatrix = '\\begin{bsmallmatrix*}[r]1&2% \\end{bsmallmatrix*}\n\\\\3&\\text{a\\&b}\\end{bsmallmatrix*}'
  await render(`$$\n${commentedMatrix}\n$$`)
  await count(1)
  assert.equal(await page.locator('mtable > mtr > mtd').count(), 4, 'comments cannot close an environment or create cells')
  assert.equal(await page.locator('mtext').textContent(), 'a&b', 'braced text retains escaped ampersands')
  assert.equal(await page.locator('annotation').textContent(), commentedMatrix)

  for (const environment of ['cases*', 'dcases*', 'rcases*', 'drcases*']) {
    const source = `\\begin{${environment}}\\frac12&if $x>0$\\\\[2pt]0&otherwise\\end{${environment}}`
    await render(`$$\n${source}\n$$`)
    await count(1)
    assert.equal(await page.locator('[data-math-fallback]').count(), 0)
    const cells = page.locator('mtable > mtr > mtd')
    assert.equal(await cells.count(), 4)
    assert.ok((await cells.nth(1).textContent()).replace(/\u00a0/g, ' ').startsWith('if '), 'starred cases retain prose spacing')
    assert.equal(await cells.nth(1).locator('mi').textContent(), 'x', 'text columns can contain inline math')
    assert.equal(await cells.nth(3).locator('mtext').textContent(), 'otherwise', 'starred cases use a text condition column')
    assert.equal(await page.locator('annotation').textContent(), source)
  }
  for (const environment of ['eqnarray', 'eqnarray*']) {
    const source = `\\begin{${environment}}a&=&b+c\\\\d&\\le&e\\end{${environment}}`
    await render(`$$\n${source}\n$$`)
    await count(1)
    assert.equal(await page.locator('mtable > mtr').count(), 2)
    assert.equal(await page.locator('[data-math-fallback]').count(), 0)
    assert.equal(await page.locator('annotation').textContent(), source)
    assert.ok((await page.locator('math > semantics > :first-child').textContent()).includes('a=b+c'))
  }
  if (process.env.PI_MATH_SCREENSHOT_DIR) {
    const family = fences.map(([prefix]) => `$\\begin{${prefix}smallmatrix}1&2\\\\3&4\\end{${prefix}smallmatrix}$`).join('　')
    const aligned = ['l','c','r'].map(align => `$\\begin{psmallmatrix*}[${align}]1&22\\\\333&4\\end{psmallmatrix*}$`).join('　')
    await render(`# Math compatibility\n\n${reportedMessage}\n\nCompact fences: ${family}\n\nLeft / center / right: ${aligned}\n\n` + String.raw`$$
f(x)=\begin{dcases*}\frac12&if $x>0$\\0&otherwise\end{dcases*}
$$

$\mathds{1}+\mathbbm{R},\quad\diag A,\quad\Cov(X,Y),\quad\esssup_x f(x)$

$$
\begin{eqnarray*}a&=&b+c\\d&\le&e\end{eqnarray*}
$$`, false, 820)
    await count(12)
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
      await page.locator('#fixture').screenshot({path:join(process.env.PI_MATH_SCREENSHOT_DIR, `compatibility-${dark?'dark':'light'}.png`)})
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
  }
  console.log('PASS: historical matrix streaming/reopen/file/notebook; compact fences and l/c/r columns, nesting, starred text cases and legacy equation arrays')

  const mathBody = () => page.locator('math').evaluate(node => {
    const copy = node.cloneNode(true)
    copy.querySelector('annotation')?.remove()
    return copy.outerHTML
  })
  const aliases = [
    [String.raw`\mathds{1}+\mathbbm{R}`, String.raw`\mathbb{1}+\mathbb{R}`],
    [String.raw`\ii^{2k}`, String.raw`i^{2k}`],
    [String.raw`\proj{x+\ii^k y}`, String.raw`\ket{x+i^k y}\!\bra{x+i^k y}`],
    [String.raw`\newcommand{\ii}{\mathrm{i}}\ii^2`, String.raw`\mathrm{i}^2`],
    [String.raw`\newcommand{\proj}[1]{\operatorname{proj}(#1)}\proj{x}`, String.raw`\operatorname{proj}(x)`],
    [String.raw`\providecommand{\proj}[1]{\ketbra{#1}{#1}}\proj{x}`, String.raw`\ketbra{x}{x}`],
    [String.raw`\mspace{2mu}x`, String.raw`\mskip{2mu}x`],
    [String.raw`\esssup_x f+\essinf_y g`, String.raw`\operatorname*{ess\,sup}_x f+\operatorname*{ess\,inf}_y g`],
    ...['diag','Diag','nullity','Var','Cov','cov','Corr','corr','Span','sech','csch','arccot','arcsec','arccsc','arcsinh','arccosh','arctanh','arsinh','arcosh','artanh','erfc']
      .map(name => [`\\${name}(x)`, `\\operatorname{${name}}(x)`]),
    [String.raw`\DeclareMathOperator{\custom}{custom}\custom(x)`, String.raw`\operatorname{custom}(x)`],
    [String.raw`\DeclareMathOperator*{\custom}{custom}\custom_x f(x)`, String.raw`\operatorname*{custom}_x f(x)`],
    [String.raw`\newcommand{\diag}{\text{custom}}\diag A`, String.raw`\text{custom}A`],
    [String.raw`\providecommand{\Cov}{\text{custom}}\Cov(X,Y)`, String.raw`\text{custom}(X,Y)`],
    [String.raw`\newcommand*{\custom}[1]{#1^2}\custom{x}`, String.raw`x^2`],
    [String.raw`\def\env{psmallmatrix}\begin{\env}1\end{psmallmatrix}`, String.raw`\begin{psmallmatrix}1\end{psmallmatrix}`]
  ]
  for (const [source, equivalent] of aliases) {
    await render(`$$\n${source}\n$$`)
    await count(1)
    assert.equal(await page.locator('[data-math-fallback]').count(), 0, source)
    assert.equal(await page.locator('annotation').textContent(), source)
    const actual = await mathBody()
    await render(`$$\n${equivalent}\n$$`)
    await count(1)
    assert.equal(await mathBody(), actual, 'compatible commands retain the equivalent native MathML')
  }
  await render(String.raw`$\gdef\Cov{\text{custom}}\Cov(X,Y)$`)
  await count(1)
  assert.equal(await page.locator('mtext').textContent(), 'custom')
  await render(String.raw`$\Cov(X,Y)$`)
  await count(1)
  assert.equal(await page.locator('mtext').count(), 0, 'a formula cannot redefine the next formula’s aliases')
  assert.equal(await page.locator('mi').first().textContent(), 'Cov')
  await render(String.raw`$\verb|\begin{psmallmatrix}|+\begin{psmallmatrix}1\end{psmallmatrix}$`)
  await count(1)
  assert.equal(await page.locator('mtext').textContent(), String.raw`\begin{psmallmatrix}`, 'verbatim TeX retains literal environment syntax')
  await render('`$' + reportedMatrix + '$`\n\n```tex\n' + reportedMatrix + '\n```')
  assert.equal(await page.locator('math').count(), 0, 'compatibility only applies to parser-produced formulas')
  assert.equal(await page.locator('[data-inline-code]').textContent(), `$${reportedMatrix}$`)
  console.log('PASS: double-struck font/spacing/operator aliases, declared operators, explicit macro precedence, formula isolation and literal code/verb')

  const syntax = `Tutor<br>Email<br />Date<BR/>Place

2. Second step

$$x^2$$

3. Third step

| Left | Right |
| :--- | ---: |
| value | 42 |

- [x] Done
- [ ] Pending

[reference](https://example.com "Link title")

\`<br>\` &lt;br&gt; <b>inert</b>`
  await render(syntax)
  await count(1)
  assert.equal(await page.locator('#fixture p').first().locator('br').count(), 3, 'only parsed bare HTML breaks become line breaks')
  assert.deepEqual(await page.locator('#fixture ol').evaluateAll(nodes => nodes.map(node => node.start)), [2, 3], 'separate ordered lists keep source start values')
  assert.equal(await page.locator('#fixture th').last().evaluate(node => getComputedStyle(node).textAlign), 'right', 'GFM header alignment survives')
  assert.equal(await page.locator('#fixture td').last().evaluate(node => getComputedStyle(node).textAlign), 'right', 'GFM cell alignment survives')
  assert.deepEqual(await page.locator('#fixture ul li').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).listStyleType, node.querySelector('input')?.checked])), [['none', true], ['none', false]], 'task items have only checkbox markers')
  assert.equal(await page.locator('#fixture a').getAttribute('title'), 'Link title', 'link titles survive the component adapter')
  assert.equal(await page.locator('#fixture code').last().textContent(), '<br>', 'code stays literal')
  assert.ok((await page.locator('#fixture').textContent()).includes('<br>'), 'escaped HTML stays literal')
  assert.equal(await page.locator('#fixture b').count(), 0, 'other raw HTML remains inert')
  await render('Before\n\n<br>\n\nAfter')
  assert.equal(await page.locator('#fixture br').count(), 1, 'standalone bare break renders')
  const syntaxNotebook = JSON.stringify({ cells: [{ cell_type: 'markdown', source: [
    'Tutor<br>\nEmail<br />\nDate\n\n',
    '1. First\n\n$$x$$\n\n2. Second\n'
  ] }] })
  await page.evaluate(text => window.renderNotebook(text), syntaxNotebook)
  assert.equal(await page.locator('[data-notebook-markdown] br').count(), 2, 'notebook cells use the same safe breaks')
  assert.deepEqual(await page.locator('[data-notebook-markdown] ol').evaluateAll(nodes => nodes.map(node => node.start)), [1, 2], 'notebook list numbering survives intervening math')
  console.log('PASS: Markdown/notebook breaks and list starts; GFM table alignment, task markers, titles and inert HTML')

  await render('X<sup>2</sup> H<sub>2</sub>O <mark>**key** <sup>3</sup></mark> <kbd>Ctrl</kbd> <ins>new</ins> <del>old</del> <u>under</u> <s>gone</s>')
  assert.equal(await page.locator('#fixture sup').first().textContent(), '2')
  assert.equal(await page.locator('#fixture sub').textContent(), '2')
  assert.equal(await page.locator('#fixture mark strong').textContent(), 'key', 'safe tags retain their parsed Markdown children')
  assert.equal(await page.locator('#fixture mark sup').textContent(), '3', 'safe inline tags nest')
  for (const [tag, text] of [['kbd','Ctrl'],['ins','new'],['del','old'],['u','under'],['s','gone']]) {
    assert.equal(await page.locator(`#fixture ${tag}`).textContent(), text)
  }
  await render('`<sup>2</sup>` &lt;sub&gt;3&lt;/sub&gt; \\<sup>escaped\\</sup> <sup onclick="window.injected=true">4</sup> <sup><sub>5</sup>6</sub>')
  assert.equal(await page.locator('#fixture sup,#fixture sub').count(), 0, 'code, escaped tags, attributes and crossed tags remain literal')
  assert.ok((await page.locator('#fixture').textContent()).includes('<sup onclick="window.injected=true">'))
  await render('x <script>window.injected=true</script> <img src="x" onerror="window.injected=true"> y')
  assert.equal(await page.locator('#fixture script,#fixture img').count(), 0, 'unsupported raw HTML remains inert')
  assert.equal(await page.evaluate(() => window.injected), undefined)
  const inlineStreaming = '<mark>left <sup>2</sup> **right**</mark>'
  await page.evaluate(source => { for(let i=0;i<=source.length;i++) window.renderFixture(source.slice(0,i),true) }, inlineStreaming)
  assert.equal(await page.locator('#fixture mark sup').textContent(), '2')
  assert.equal(await page.locator('[data-markdown-fallback]').count(), 0, 'unfinished inline tags are safe while streaming')
  console.log('PASS: balanced inline sup/sub/mark/kbd/ins/del/u/s; nested Markdown, code/attribute isolation and streaming')

  const quotes = ['NOTE','TIP','IMPORTANT','WARNING','CAUTION'].map(kind => `> [!${kind}]\n> **Body** with $x$ and [link](https://example.com)\n>\n> - item`).join('\n\n')
  await render(quotes)
  await count(5)
  assert.deepEqual(await page.locator('[data-markdown-alert]').evaluateAll(nodes=>nodes.map(node=>node.dataset.markdownAlert)), ['note','tip','important','warning','caution'])
  assert.equal(await page.locator('[data-markdown-alert] strong').count(), 5)
  assert.equal(await page.locator('[data-markdown-alert] li').count(), 5, 'alerts retain their block children')
  await page.evaluate(() => window.setFixtureLocale('zh-CN'))
  await page.waitForFunction(() => document.querySelector('[data-markdown-alert-title]')?.textContent === '提示')
  await page.evaluate(() => window.setFixtureLocale('zh-TW'))
  await page.waitForFunction(() => document.querySelector('[data-markdown-alert-title]')?.textContent === '提示')
  await page.evaluate(() => window.setFixtureLocale('en'))
  await page.waitForFunction(() => document.querySelector('[data-markdown-alert-title]')?.textContent === 'Note')
  await render('> \\[!NOTE]\n> Literal\n\n> [!UNKNOWN]\n> Literal\n\n`[!TIP]`')
  assert.equal(await page.locator('[data-markdown-alert]').count(), 0, 'escaped, unknown and code markers remain ordinary content')
  console.log('PASS: five GitHub alert kinds, localized titles, Markdown/math children and literal markers')

  const softQuote = '> **arXiv**: 1706.03762\n> **会议**: NIPS 2017\n> **版权说明**: Attribution.'
  await render(softQuote)
  assert.equal(await page.locator('#fixture blockquote br').count(), 0, 'chat keeps CommonMark soft breaks')
  await page.evaluate(text => window.renderFileFixture(text), softQuote)
  assert.equal(await page.locator('#fixture blockquote br').count(), 2, 'file prose keeps each source line')
  await page.evaluate(text => window.renderFileFixture(text), 'first<br>\nsecond\nthird\n\n`code\nline`\n\n```text\nkeep\nlines\n```\n\n$$\nx\n=\ny\n$$')
  await count(1)
  assert.equal(await page.locator('#fixture p').first().locator('br').count(), 2, 'explicit br followed by newline does not duplicate a break')
  assert.equal(await page.locator('#fixture [data-inline-code]').textContent(), 'code line', 'inline code follows parser whitespace rules')
  await page.evaluate(() => {
    window.originalClipboardWrite = navigator.clipboard.writeText
    navigator.clipboard.writeText = async text => { window.copiedCode = text }
  })
  await page.getByRole('button',{name:'Copy code',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.copiedCode), 'keep\nlines', 'copying fenced code retains its original bytes')
  await page.evaluate(() => { navigator.clipboard.writeText = window.originalClipboardWrite })
  console.log('PASS: file-only soft breaks, explicit break deduplication and code/math isolation')

  const paper = '# Paper\n\n[Methods](#methods)\n\n| Author | Unit |\n| --- | --- |\n| Ashish<sup>∗</sup>[^equal] | Brain |\n| Aidan<sup>∗ †</sup>[^affil] | Toronto |\n\n' + softQuote + '\n\n## Methods\n\nAgain[^equal].\n\n' + Array.from({length:22},(_,index)=>`Paragraph ${index}: read the paper.`).join('\n\n') + '\n\n[^equal]: Equal contribution.\n\n    Second paragraph with $q_k$.\n\n[^affil]: Work at Brain.'
  await page.evaluate(text => window.renderFileFixture(text,2), paper)
  await count(2)
  assert.equal(await page.locator('[data-file-markdown]').first().locator('td sup').count(), 4, 'author marks and footnote references both render as superscripts')
  const ids = await page.locator('#fixture [id]').evaluateAll(nodes=>nodes.map(node=>node.id))
  assert.equal(new Set(ids).size, ids.length, 'separate Markdown regions use unique footnote IDs')
  assert.equal(await page.locator('[data-footnote-ref]').count(), 6)
  assert.equal(await page.locator('[data-footnote-backref]').count(), 6, 'repeated references retain every backlink')
  const heading = page.locator('[data-footnotes] h2').first()
  assert.equal(await heading.textContent(), 'Footnotes')
  assert.ok(await heading.evaluate(node => node.getBoundingClientRect().width <= 1 && node.getBoundingClientRect().height <= 1), 'the accessibility label is visually hidden')
  assert.equal(await page.locator('[data-footnotes]').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize) < parseFloat(getComputedStyle(node.closest('[data-markdown]')).fontSize)), true, 'footnotes have an annotation scale')
  assert.equal(await page.locator('[data-footnotes]').first().locator('li').first().locator('p').count(), 2, 'multi-paragraph footnotes retain block boundaries')
  assert.equal(await page.locator('[data-footnote-ref]').first().getAttribute('aria-describedby'), await heading.getAttribute('id'))
  const second = page.locator('[data-file-markdown]').nth(1)
  await second.locator('[data-footnote-ref]').first().focus()
  await second.locator('[data-footnote-ref]').first().press('Enter')
  assert.ok(await second.evaluate(node=>node.scrollTop > 0), 'a reference scrolls its own file pane to the footnote')
  assert.equal(await page.locator('[data-file-markdown]').first().evaluate(node=>node.scrollTop), 0, 'the neighboring pane does not scroll')
  const activeFootnote = await page.evaluate(()=>document.activeElement.id)
  assert.equal(activeFootnote, await second.locator('[data-footnotes] li').first().getAttribute('id'))
  await second.locator('[data-footnote-backref]').first().focus()
  await second.locator('[data-footnote-backref]').first().press('Enter')
  assert.equal(await page.evaluate(()=>document.activeElement.id), await second.locator('[data-footnote-ref]').first().getAttribute('id'), 'a backlink restores focus to its exact reference')
  await second.locator('a[href="#methods"]').click()
  assert.equal(await page.evaluate(()=>document.activeElement.textContent), 'Methods', 'table-of-contents heading navigation still works')
  for (const [locale,label,back] of [['zh-CN','脚注','返回引用'],['zh-TW','註腳','返回引用'],['en','Footnotes','Back to reference']]) {
    await page.evaluate(locale=>window.setFixtureLocale(locale),locale)
    await page.waitForFunction(label=>document.querySelector('[data-footnotes] h2')?.textContent===label,label)
    assert.ok((await page.locator('[data-footnote-backref]').first().getAttribute('aria-label')).startsWith(back))
  }
  if (process.env.PI_MATH_SCREENSHOT_DIR) {
    for (const dark of [false,true]) {
      await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark)
      await second.screenshot({path:join(process.env.PI_MATH_SCREENSHOT_DIR,`file-markdown-${dark?'dark':'light'}.png`)})
    }
  }
  await page.evaluate(text=>window.renderFileFixture(text),paper.replaceAll('[^equal]','[^共同贡献]'))
  await page.locator('[data-footnote-ref]').first().click()
  assert.equal(await page.evaluate(()=>document.activeElement.id),await page.locator('[data-footnotes] li').first().getAttribute('id'),'encoded non-ASCII footnote IDs resolve without losing their literal form')
  await page.locator('[data-footnote-backref]').first().click()
  assert.equal(await page.evaluate(()=>document.activeElement.id),await page.locator('[data-footnote-ref]').first().getAttribute('id'),'non-ASCII footnote backlinks return to the reference')
  console.log('PASS: file author marks, footnote scale/hidden labels/localization, unique IDs, repeated references and scoped keyboard navigation')

  await page.evaluate(source => {
    for (let i = 0; i <= source.length; i++) window.renderFixture(source.slice(0, i), true)
  }, commandFirst)
  await count(2)
  assert.equal(await page.locator('[data-markdown-fallback]').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.caughtErrors), [], 'no transient failures while streaming')
  const beforeReload = await page.locator('math').evaluateAll(nodes => nodes.map(e => e.outerHTML))
  await page.reload()
  await page.waitForFunction(() => !!window.renderFixture)
  await render(commandFirst)
  await count(2)
  assert.deepEqual(await page.locator('math').evaluateAll(nodes => nodes.map(e => e.outerHTML)), beforeReload, 'cold rendering agrees with streamed rendering')
  for (const text of sessionTexts) {
    await render(text)
    assert.equal(await page.locator('[data-markdown-fallback]').count(), 0, 'reported session renders without block-level fallback')
  }
  console.log('PASS: command-first formulas stream and reopen without exceptions')

  await render('**Healthy history**\n\nnormal tail', true)
  await page.evaluate(() => { window.healthyBlock = document.querySelector('#fixture strong') })
  const broken = '<!--math-check-fail-->\n<img src=x onerror=alert(1)> $x$'
  await render('**Healthy history**\n\n' + broken, true)
  assert.equal(await page.locator('[data-markdown-fallback]').textContent(), broken, 'a failed block shows escaped original source')
  assert.equal(await page.locator('#fixture img').count(), 0)
  assert.equal(await page.evaluate(() => window.healthyBlock === document.querySelector('#fixture strong')), true, 'a bad tail does not unmount healthy history')
  await render('**Healthy history**\n\nrecovered $x$', true)
  await count(1)
  assert.equal(await page.locator('[data-markdown-fallback]').count(), 0, 'next delta resets the failed block')
  assert.equal(await page.evaluate(() => window.healthyBlock === document.querySelector('#fixture strong')), true)
  assert.deepEqual(await page.evaluate(() => window.caughtErrors), ['Injected Markdown parser failure'])
  await page.evaluate(() => { window.caughtErrors.length = 0 })
  console.log('PASS: parser failure stays local, preserves readable source/history and recovers on the next delta')

  await render('金额 $5 和 $10；$20.50–$30\n\n转义 \\$x\\$\n\n`$code$` 和 `\\(code\\)`\n\n```ts\nconst price = "$100"; // \\(literal\\)\n```\n\n    $indented$\n\n[link](https://example.com/$path$)\n\n\\\\(escaped\\\\)')
  assert.equal(await page.locator('math').count(), 0, 'currency, escapes, code and link destinations stay literal')
  assert.ok((await page.locator('#fixture').innerText()).includes('$5 和 $10'))
  await render('金额 $5 and $x$ and $10 plus $y$；$\\text{\\$10}$')
  await count(3)
  await render(String.raw`$2x$ 与 $x + y$，\(x_{a_b} + \text{中文}\)；（https://example.com/），正文`)
  await count(3)
  assert.equal(await page.locator('a').getAttribute('href'), 'https://example.com/', 'CJK autolink behavior survives')
  for (const delimiter of ['$$', '\\[']) {
    const end = delimiter === '$$' ? '$$' : '\\]'
    for (const prefix of ['', '> ', '- ']) {
      const lines = [delimiter, 'x^2', '', '+y', end]
      const value = lines.map((line, i) => (prefix === '- ' && i ? '  ' : prefix) + line).join('\n')
      await render(value, true)
      await count(1)
      assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'container display math survives blank lines')
    }
  }
  console.log('PASS: code/escape/currency isolation and nested multi-line formulas')

  const notebookQuote = String.raw`#### Prior

> $p(\theta)$: prior.

#### Likelihood

> Given independent observations $y_1,\ldots,y_n$:
>
> $$
L(\theta\mid y)
=
p(y\mid\theta)
=
\prod_{i=1}^n p(y_i\mid\theta).
$$

#### Posterior

> $p(\theta\mid y)$: posterior.

#### Evidence

> $$
p(y)
=
\int p(y\mid\theta)p(\theta)\,d\theta.
$$
>
> A normalizing constant.
`
  for (const streaming of [false, true]) {
    await render(notebookQuote, streaming, 500)
    await count(5)
    assert.equal(await page.locator('[data-math-fallback]').count(), 0)
    assert.equal(await page.locator('h4').count(), 4, 'headings after quoted math remain Markdown')
    assert.equal(await page.locator('h1,h2').count(), 0, 'formula equals signs cannot turn into setext headings')
    assert.equal(await page.locator('blockquote [data-math-rendered=display]').count(), 2)
  }
  for (const protectedSource of [
    '```md\n> $$\nx\n$$\n```', '~~~\n> $$\nx\n$$\n~~~',
    '`code\n> $$\nx\n$$\nend`', '    > $$\n    x\n    $$',
    '> $$\nunfinished\n\n## Following paragraph\n\n$$\ny\n$$'
  ]) assert.equal(await page.evaluate(source => window.normalizeQuotedMath(source), protectedSource), protectedSource,
    'quoted-math compatibility cannot rewrite code or cross paragraph boundaries')
  await render('> > \\[\nx\n=\ny\n\\]\n\n#### After nested quote')
  await count(1)
  assert.equal(await page.locator('blockquote blockquote math').count(), 1)
  assert.equal(await page.locator('h4').count(), 1)
  console.log('PASS: Jupyter lazy quote formulas, following Markdown, nested quotes and code isolation')

  for (const formula of ['x', 'p(\\theta)', 'p(y\\mid\\theta)', 'x_i^2', '\\frac{a}{b}']) {
    await render(`Text before $${formula}$ after 中文。`)
    await count(1)
    const baseline = await page.locator('[data-math-rendered=inline]').evaluate(e => {
      const marker = () => {
        const span = document.createElement('span')
        span.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'
        return span
      }
      const inner = marker(), outer = marker()
      e.firstElementChild.append(inner)
      e.after(outer)
      const offset = inner.getBoundingClientRect().top - outer.getBoundingClientRect().top
      inner.remove(); outer.remove()
      return offset
    })
    assert.ok(Math.abs(baseline) < 0.5, `${formula} shares the prose baseline (${baseline}px offset)`)
  }
  console.log('PASS: native inline baseline, including subscripts, superscripts and fractions')

  if (process.env.PI_MATH_NOTEBOOK_PATH) {
    const text = await readFile(process.env.PI_MATH_NOTEBOOK_PATH, 'utf8')
    await page.evaluate(text => window.renderNotebook(text), text)
    try { await page.waitForSelector('[data-notebook-cell="8"] math', { state: 'attached' }) }
    catch (error) { throw new Error(`${await page.locator('body').innerText()}\n${errors.join('\n')}`, { cause: error }) }
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator('[data-math-fallback]').count(), 0, 'real Notebook formulas all render')
    assert.equal(await page.locator('[data-notebook-cell="8"] h4').count(), 4)
    assert.equal(await page.locator('[data-notebook-cell="8"] math').count(), 10)
    if (process.env.PI_MATH_SCREENSHOT_DIR) {
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
        await page.locator('[data-notebook-cell="8"]').screenshot({path:join(process.env.PI_MATH_SCREENSHOT_DIR, `notebook-${dark ? 'dark' : 'light'}.png`)})
      }
    }
    console.log(`PASS: reported Notebook through FileNotebook (${await page.locator('math').count()} formulas)`)
  }

  // The blank line is inside math: no partial formula may be frozen as a
  // stable block, and its source stays readable until its delimiter arrives.
  const prefix = '$stable_{42}$\n\n'
  const partial = prefix + '$$\n\\frac{a}{b}\n\n+ c'
  await render(partial, true)
  await count(1)
  assert.ok((await page.locator('[data-math-fallback]').innerText()).includes('\\frac{a}{b}'))
  assert.deepEqual(await page.evaluate(s => window.splitMarkdownBlocks(s), partial), { stable: [prefix], tail: partial.slice(prefix.length) })
  await render(partial + '\n$$', true)
  await count(2)
  const streamingHTML = await page.locator('math').evaluateAll(nodes => nodes.map(e => e.outerHTML))
  await render(partial + '\n$$')
  await count(2)
  assert.deepEqual(await page.locator('math').evaluateAll(nodes => nodes.map(e => e.outerHTML)), streamingHTML, 'streamed and final math agree')

  await page.evaluate(() => window.instrumentMath())
  const history = Array.from({ length: 80 }, (_, i) => `$p_{${i}}=\\sqrt{${i + 2}}$\n\n`).join('')
  await render(history + 'tail', true)
  await count(80)
  assert.equal(await page.evaluate(() => window.mathCalls), 80)
  await page.evaluate(() => { window.stableMath = document.querySelector('math') })
  const timings = await page.evaluate(history => {
    const values = []
    for (let i = 0; i < 40; i++) {
      const begin = performance.now()
      window.renderFixture(history + 'tail '.repeat(i + 1), true)
      values.push(performance.now() - begin)
    }
    return values.sort((a,b) => a-b)
  }, history)
  assert.equal(await page.evaluate(() => window.mathCalls), 80, '40 deltas never re-typeset 80 historical formulas')
  assert.equal(await page.evaluate(() => window.stableMath === document.querySelector('math')), true, 'history DOM stays mounted')
  await render('switch tabs')
  await render(history)
  await count(80)
  assert.equal(await page.evaluate(() => window.mathCalls), 80, 'tab remount reuses bounded shared cache')
  console.log(`PASS: streaming/caching; 80 formulas + 40 deltas, median ${timings[20].toFixed(2)}ms, p95 ${timings[38].toFixed(2)}ms per update`)

  const wide = Array.from({length:60}, (_,i) => `x_{${i}}`).join(' + ')
  for (const display of [false, true]) for (const width of [280, 640]) {
    await render(display ? `$$\n${wide}\n$$` : `$${wide}$`, false, width)
    await count(1)
    await page.locator('[data-math-rendered]').evaluate(async e => {
      e.scrollLeft = 0
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-math-rendered]')).maskImage !== 'none')
    const dimensions = await page.locator('[data-math-rendered]').evaluate(e => {
      const fixture = document.querySelector('#fixture')
      return { width:e.clientWidth, scroll:e.scrollWidth, frame:fixture.clientWidth, overflow:fixture.scrollWidth, scrollbar:getComputedStyle(e).scrollbarWidth }
    })
    assert.ok(dimensions.scroll > dimensions.width)
    assert.ok(dimensions.overflow <= dimensions.frame + 1, 'long formulas cannot widen chat/sidebar')
    assert.equal(dimensions.scrollbar, 'none')
    await page.locator('[data-math-rendered]').evaluate(e => { e.dataset.startMask = getComputedStyle(e).maskImage; e.scrollLeft = e.scrollWidth })
    await page.waitForFunction(() => {
      const e = document.querySelector('[data-math-rendered]')
      return e.scrollLeft > 0 && getComputedStyle(e).maskImage !== e.dataset.startMask
    })
  }
  console.log('PASS: narrow/wide scrollports, hidden scrollbars and edge fades')

  for (const source of [String.raw`\notARealCommand{x}`, String.raw`\def\x{\x}\x`, 'x'.repeat(16_385),
    String.raw`\begin{psmallmatrix}1\end{bsmallmatrix}`, String.raw`\begin{psmallmatrix}1`,
    String.raw`\begin{psmallmatrix*}[z]1\end{psmallmatrix*}`, String.raw`\begin{cases*}1&a&b\end{cases*}`]) {
    await render(`$${source}$`)
    await page.waitForSelector('[data-math-fallback]')
    assert.ok((await page.locator('#fixture').textContent()).includes(source))
  }
  await render(String.raw`$\href{javascript:alert(1)}{click}$ $\includegraphics{https://example.com/leak.png}$ $\text{<img src=x onerror=alert(1)>}$`)
  await page.waitForFunction(() => document.querySelectorAll('[data-math-rendered]').length === 3)
  assert.equal(await page.locator('#fixture a, #fixture img, #fixture script').count(), 0)
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => r.name.startsWith('https://example.com/'))), false)
  assert.deepEqual(errors, [], 'no renderer exceptions')
  assert.deepEqual(await page.evaluate(() => window.caughtErrors), [], 'no hidden Markdown failures')
  console.log('PASS: malformed/oversized/macro-loop fallback, untrusted TeX, no network resources')

  const assets = join(temporary, 'dist/assets')
  const files = await readdir(assets)
  const engine = files.find(name => /^temml-.*\.js$/.test(name))
  if (engine) {
    const bytes = await readFile(join(assets, engine))
    console.log(`Math engine chunk: ${(bytes.length/1024).toFixed(1)} KiB, gzip ${(gzipSync(bytes).length/1024).toFixed(1)} KiB (lazy)`)
  }
} finally {
  await app?.close()
  await rm(temporary, {recursive:true, force:true})
}
