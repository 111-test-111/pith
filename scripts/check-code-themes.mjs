/** Live theme selection must recolor cached blocks and worker source without replacing panes. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { _electron } from 'playwright-core'
import electron from 'electron'
import { bundledThemesInfo, createHighlighter } from 'shiki'

const repo = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-code-themes-'))
const fixturePath = '/__code-themes.html'
const defaults = { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' }
const code = 'const message: string = "Pith"\nexport function square(value: number) {\n  return value * value\n}'
const source = Array.from({ length: 800 }, (_, i) => `const row${i}: string = "source ${i}"`).join('\n')
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ThemeProvider,useTheme} from 'next-themes';
import {I18nProvider,useI18n} from '/src/i18n/index.tsx';
import en from '/src/i18n/locales/en.ts';import zh from '/src/i18n/locales/zh-CN.ts';import tw from '/src/i18n/locales/zh-TW.ts';
import {AppearanceSection} from '/src/components/app/settings/AppearanceSection.tsx';
import {AgentCode,getCachedAgentCodeTokens} from '/src/components/agents/agent-code.tsx';
import {CodeBlock} from '/src/components/agents/code-block.tsx';
import {FileDiff} from '/src/components/agents/file-diff.tsx';
import {FileSource} from '/src/components/app/FileSource.tsx';
import {FileNotebook} from '/src/components/app/FileNotebook.tsx';
import {ToolFileOutput} from '/src/components/app/ToolFileOutput.tsx';
import {FileBrowserStore} from '/src/state/file-browser-store.ts';
import {Markdown} from '/src/lib/markdown.tsx';
import {getCodeThemes,setCodeThemes} from '/src/lib/code-theme-settings.ts';
import '/src/styles.css';
window.pi={platform:'darwin',openPath:async()=>{},openExternal:async()=>{}};
window.bootThemes=getCodeThemes();window.getCodeThemes=getCodeThemes;window.setCodeThemes=setCodeThemes;
window.dictionaries={en,'zh-CN':zh,'zh-TW':tw};window.cached=()=>getCachedAgentCodeTokens(${JSON.stringify(code)},'typescript');
const h=React.createElement,store=new FileBrowserStore(),code=${JSON.stringify(code)},source=${JSON.stringify(source)};
const lines=code.split('\\n').map((content,i)=>({id:String(i),content,type:'added',newLine:i+1}));
const tab={cwd:'/fixture',path:'/fixture/source.ts',view:'source',visit:0,treeOpen:false};
const notebook=JSON.stringify({metadata:{language_info:{name:'typescript'}},cells:[{cell_type:'code',source:code,outputs:[]}]});
function Shell(){const {setTheme}=useTheme(),{setLocale}=useI18n();window.setMode=setTheme;window.setLocale=setLocale;
return h('main',{style:{display:'grid',gridTemplateColumns:'560px minmax(0,1fr)',gap:20,padding:16,height:'100vh'}},
 h('section',{id:'settings',style:{overflow:'auto'}},h(AppearanceSection,{accent:'indigo',onAccentChange:()=>{},uiStyle:'square',onUiStyleChange:()=>{}})),
 h('section',{id:'surfaces',style:{overflow:'auto',display:'flex',flexDirection:'column',gap:12}},
 h('div',{id:'agent'},h(AgentCode,{code,language:'typescript'})),
 h('div',{id:'block'},h(CodeBlock,{code,language:'typescript',copyable:false})),
 h('div',{id:'markdown'},h(Markdown,null,'\`\`\`typescript\\n'+code+'\\n\`\`\`')),
 h('div',{id:'diff'},h(FileDiff,{file:'sample.ts',lines,status:'complete',open:true,headerless:true})),
 h('div',{id:'notebook'},h(FileNotebook,{text:notebook,truncated:false,tab,store})),
 h('div',{id:'read'},h(ToolFileOutput,{tool:'read',text:'const readFile: string = "read.ts"',args:{path:'/fixture/read.ts'},cwd:'/fixture'})),
 h('div',{id:'source',style:{height:180,minHeight:180,display:'flex'}},h(FileSource,{text:source,tab,store,wrap:false})),
 h('div',{id:'plain'},h(AgentCode,{code,language:'typescript',highlight:false})),
 h('div',{id:'streaming'},h(CodeBlock,{code,language:'typescript',status:'streaming',copyable:false}))));}
flushSync(()=>createRoot(document.getElementById('root')).render(h(ThemeProvider,{attribute:'class',defaultTheme:'light',enableSystem:false},h(I18nProvider,null,h(Shell)))));
window.ready=true;
</script></body></html>`

let server, app, highlighter
const errors = []
try {
  // Exercise every offered palette with real Shiki, rather than asserting a list of theme names.
  highlighter = await createHighlighter({ themes: bundledThemesInfo.map(theme => theme.id), langs: ['typescript'] })
  for (const theme of bundledThemesInfo) {
    const result = highlighter.codeToTokens(code, { lang: 'typescript', theme: theme.id })
    assert.ok(result.tokens.flat().some(token => token.color), theme.id + ' supplies readable colors')
  }
  server = await createServer({ configFile: false, root: join(repo, 'src/renderer'), cacheDir: join(temporary, 'vite'), logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), tailwindcss(), { name: 'code-theme-fixture', configureServer(server) {
      server.middlewares.use(fixturePath, async (_req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(fixturePath, fixture)) }
        catch (error) { next(error) }
      })
    } }], server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(temporary, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.whenReady().then(()=>{for(const url of ${JSON.stringify([url, url + '?mirror'])}){const win=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{backgroundThrottling:false}});win.loadURL(url)}});app.on('window-all-closed',()=>app.quit());`)
  app = await _electron.launch({ executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  app.on('window', page => page.on('pageerror', error => errors.push(String(error))))
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => window.ready)
  if (app.windows().length < 2) await app.waitForEvent('window', { timeout: 15_000 })
  const mirror = app.windows().find(window => window !== page)
  assert.ok(mirror, 'the auxiliary window opens')
  await mirror.waitForFunction(() => window.ready)

  const selectors = ['#agent', '#block', '#markdown', '#diff', '#notebook', '#read', '#source']
  const colors = themes => {
    const token = highlighter.codeToTokensWithThemes(code, { lang: 'typescript', themes })[0][0]
    return { light: token.variants.light.color, dark: token.variants.dark.color }
  }
  const assertPaint = async (target, themes) => {
    await target.waitForFunction(({ selectors, colors }) => selectors.every(selector => {
      const el = document.querySelector(selector)?.querySelector('span[style*="--agent-code-light"]')
      return el && ['light', 'dark'].every(mode => el.style.getPropertyValue('--agent-code-' + mode).toLowerCase() === colors[mode].toLowerCase())
    }), { selectors, colors: colors(themes) })
    assert.ok(await target.evaluate(({ selectors, colors }) => {
      const probe = document.createElement('span')
      probe.style.color = colors[document.documentElement.classList.contains('dark') ? 'dark' : 'light']
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      const painted = selectors.every(selector => getComputedStyle(document.querySelector(selector).querySelector('span[style*="--agent-code-light"]')).color === expected)
      probe.remove()
      return painted
    }, { selectors, colors: colors(themes) }), 'the active interface mode paints the selected palette in every surface')
    const previewCode = await target.locator('[data-code-theme-preview="light"] pre').innerText()
    assert.equal(await target.locator('[data-code-theme-preview="dark"] pre').innerText(), previewCode, 'both modes preview the same code')
    const preview = highlighter.codeToTokensWithThemes(previewCode, { lang: 'typescript', themes }).flat().map(token => ({
      content: token.content, light: token.variants.light.color, dark: token.variants.dark.color
    }))
    await target.waitForFunction(expected => {
      return ['light', 'dark'].every(mode => {
        const spans = [...document.querySelectorAll('[data-code-theme-preview="' + mode + '"] [data-agent-code-token]')]
        return spans.length === expected.length && spans.every((el, index) => el.textContent === expected[index].content &&
          el.style.getPropertyValue('--agent-code-light') === expected[index].light && el.style.getPropertyValue('--agent-code-dark') === expected[index].dark)
      })
    }, preview)
    assert.ok(await target.evaluate(expected => {
      const probe = document.createElement('span'); document.body.append(probe)
      const painted = ['light', 'dark'].every(mode => [...document.querySelectorAll('[data-code-theme-preview="' + mode + '"] [data-agent-code-token]')].every((el, index) => {
        probe.style.color = expected[index][mode]
        return getComputedStyle(el).color === getComputedStyle(probe).color
      }))
      probe.remove(); return painted
    }, preview), 'each preview paints its own palette independently of the app theme')
  }
  const choose = async (mode, label) => {
    const trigger = page.locator('[data-code-theme-mode="' + mode + '"] button[aria-haspopup="listbox"]')
    await trigger.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await page.waitForFunction(({ mode, label }) => document.querySelector('[data-code-theme-mode="' + mode + '"] button[aria-haspopup="listbox"]').textContent.trim() === label, { mode, label })
  }

  await assertPaint(page, defaults)
  await assertPaint(mirror, defaults)
  assert.ok(await page.locator('[data-code-theme-reset]').isDisabled())
  assert.equal(await page.locator('[data-code-theme-mode] input').count(), 0, 'theme selectors are ordinary buttons without search inputs')
  assert.ok(await page.evaluate(() => {
    const light = document.querySelector('[data-code-theme-preview="light"]').getBoundingClientRect()
    const dark = document.querySelector('[data-code-theme-preview="dark"]').getBoundingClientRect()
    return light.width > 0 && dark.width > 0 && light.top === dark.top && light.right <= dark.left
  }), 'light and dark previews appear side by side')
  const previewBackgrounds = await page.evaluate(() => ['light', 'dark'].map(mode => {
    const style = getComputedStyle(document.querySelector('[data-code-theme-preview="' + mode + '"]'))
    return { mode: style.colorScheme, background: style.backgroundColor }
  }))
  assert.equal(previewBackgrounds[0].mode, 'light')
  assert.equal(previewBackgrounds[1].mode, 'dark')
  assert.notEqual(previewBackgrounds[0].background, previewBackgrounds[1].background, 'dark preview has its own dark background in a light app')
  await page.evaluate(() => {
    window.sourceNode = document.querySelector('[data-file-source]')
    sourceNode.scrollTop = 1008
    sourceNode.dispatchEvent(new Event('scroll'))
    window.sourceTop = sourceNode.scrollTop
  })
  await choose('light', 'Solarized Light')
  await choose('dark', 'Nord')
  const selected = { light: 'solarized-light', dark: 'nord' }
  await assertPaint(page, selected)
  await assertPaint(mirror, selected)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-app:code-themes'))), selected)
  assert.ok(await page.evaluate(() => sourceNode === document.querySelector('[data-file-source]') && sourceNode.scrollTop === sourceTop), 'changing palettes keeps the source pane and reading position')
  assert.equal(await page.locator('#plain span[style*="--agent-code-light"], #streaming span[style*="--agent-code-light"]').count(), 0, 'plain and streaming blocks remain unhighlighted')
  assert.equal(await page.locator('#agent code').innerText(), code, 'color changes preserve source bytes')
  await page.evaluate(() => setMode('dark'))
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await assertPaint(page, selected)
  assert.deepEqual(await page.evaluate(() => ['light', 'dark'].map(mode => {
    const style = getComputedStyle(document.querySelector('[data-code-theme-preview="' + mode + '"]'))
    return { mode: style.colorScheme, background: style.backgroundColor }
  })), previewBackgrounds, 'switching the app to dark preserves both preview color modes')

  await page.evaluate(async () => {
    for (const pair of [{light:'one-light',dark:'one-dark-pro'}, {light:'catppuccin-latte',dark:'catppuccin-mocha'}, {light:'min-light',dark:'vesper'}]) {
      setCodeThemes(pair)
      await new Promise(requestAnimationFrame)
    }
  })
  const last = { light: 'min-light', dark: 'vesper' }
  await assertPaint(page, last)
  await assertPaint(mirror, last)
  await page.waitForTimeout(200)
  await assertPaint(page, last)
  // Revisit a warm pair to catch caches that identify results only by code/language.
  await page.evaluate(pair => setCodeThemes(pair), selected)
  await assertPaint(page, selected)
  await page.reload()
  await page.waitForFunction(() => window.ready)
  assert.deepEqual(await page.evaluate(() => bootThemes), selected, 'reload restores the stored pair before mount')
  await assertPaint(page, selected)

  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    await page.evaluate(locale => setLocale(locale), locale)
    await page.waitForFunction(locale => document.querySelector('[data-code-theme-mode="light"] button[aria-haspopup="listbox"]').getAttribute('aria-label') === dictionaries[locale]['settings.codeThemeLight'], locale)
    assert.equal(await page.locator('[data-code-theme-reset]').innerText(), await page.evaluate(locale => dictionaries[locale]['settings.codeThemeReset'], locale))
  }
  await page.locator('[data-code-theme-reset]').click()
  await assertPaint(page, defaults)
  await assertPaint(mirror, defaults)

  await page.evaluate(() => localStorage.setItem('pi-app:code-themes', JSON.stringify({ light: 'dracula', dark: 'solarized-dark' })))
  await page.reload(); await page.waitForFunction(() => window.ready)
  const validated = { ...defaults, dark: 'solarized-dark' }
  assert.deepEqual(await page.evaluate(() => getCodeThemes()), validated, 'wrong-mode themes fall back independently')
  await assertPaint(page, validated)
  await page.evaluate(() => localStorage.setItem('pi-app:code-themes', JSON.stringify({ light: 'unknown-theme', dark: null })))
  await page.reload(); await page.waitForFunction(() => window.ready)
  assert.deepEqual(await page.evaluate(() => getCodeThemes()), defaults, 'unknown themes fall back safely')
  await page.evaluate(() => localStorage.setItem('pi-app:code-themes', 'broken JSON'))
  await page.reload(); await page.waitForFunction(() => window.ready)
  assert.deepEqual(await page.evaluate(() => getCodeThemes()), defaults, 'malformed storage boots safely')
  await assertPaint(page, defaults)

  if (process.env.PI_CODE_THEMES_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_CODE_THEMES_SCREENSHOT_DIR, { recursive: true })
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => { setLocale('zh-CN'); setMode(mode); document.getElementById('settings').scrollTop = 0 }, mode)
      await page.waitForFunction(mode => document.documentElement.classList.contains('dark') === (mode === 'dark'), mode)
      await page.locator('#settings').screenshot({ path: join(process.env.PI_CODE_THEMES_SCREENSHOT_DIR, mode + '.png') })
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS: button dropdowns and simultaneous light/dark previews; all bundled palettes recolor code/Markdown/diffs/notebooks/read outputs/source workers, preserve panes, reject stale caches, synchronize windows, persist and validate choices in all locales')
} finally {
  await app?.close()
  await server?.close()
  highlighter?.dispose()
  await rm(temporary, { recursive: true, force: true })
}
