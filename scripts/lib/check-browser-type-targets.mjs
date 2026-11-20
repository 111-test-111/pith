/** Real Electron layout/input regression using production BrowserService/tools.
 * The marker window supplies Chromium geometry without an account or live site. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { _electron } from 'playwright-core'
import { buildMarkerUrl } from '../../src/shared/browser.ts'
import { BrowserService } from '../../src/main/browser/service.ts'
import { createBrowserTools } from '../../src/main/browser/tools.ts'

export async function checkBrowserTypeTargets() {
  const temporary = await mkdtemp(join(tmpdir(), 'pith-browser-type-'))
  const owner = 'agent:type-fixture'
  let application, service
  try {
    const main = join(temporary, 'main.cjs')
    await writeFile(main, `const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({show: false, width: 719, height: 734, useContentSize: true,
    webPreferences: {backgroundThrottling: false}});
  window.loadURL(${JSON.stringify(buildMarkerUrl(owner, 'p-type-fixture'))});
});`)
    application = await _electron.launch({
      executablePath: electron, args: [main], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    const page = await application.firstWindow()
    await page.waitForURL(buildMarkerUrl(owner, 'p-type-fixture'))
    await page.setContent(`<!doctype html><html><body>
      <button id="expand" onclick="document.getElementById('q').style.width='180px'">Expand search</button>
      <input id="q" aria-label="Search" value="original"
        style="position:absolute;left:300px;top:20px;width:0;height:20px;padding:0;border:0">
      <script>
        window.inputEvents = [];
        document.addEventListener('keydown', e => window.inputEvents.push('key:' + e.key));
        for (const name of ['click', 'input']) document.getElementById('q').addEventListener(name,
          () => window.inputEvents.push(name));
      </script>
    </body></html>`)
    service = new BrowserService({
      cdpPort: 1, consent: { get: () => true, grant: () => {} },
      connectElectronFn: async () => ({ contexts: () => [application.context()], on: () => {} }),
      settle: { warmupMs: 0, sampleMs: 10, budgetMs: 100 },
    })
    await service.reconcileElectronTargets()
    const tools = new Map(createBrowserTools({ ownerId: 'type-fixture', service }).map(tool => [tool.name, tool]))
    const type = args => tools.get('browser_type').execute('type-fixture', args)
    const zero = await type({ selector: '#q', text: 'HKBN', submit: true })
    assert.equal(zero.structuredContent.error.code, 'TYPE_TARGET_NOT_INTERACTABLE')
    assert.match(zero.content[0].text, /zero width \(0×20 CSS px in a 719×734 CSS px frame viewport\)/)
    assert.deepEqual(await page.evaluate(() => window.inputEvents), [], 'Zero-width typing sends no pointer or key events')
    assert.equal(await page.locator('#q').inputValue(), 'original', 'Zero-width rejection preserves the existing value')

    const visibleOnly = await type({ selector: '#q:visible', text: 'HKBN' })
    assert.equal(visibleOnly.structuredContent.error.code, 'INVALID_SELECTOR_TARGET')
    assert.match(visibleOnly.content[0].text, /does not support ax.*collapsed or zero-size/s)
    assert.doesNotMatch(visibleOnly.content[0].text, /ax: \{ name:/)
    const unsupported = await type({ ax: { name: 'Search', role: 'textbox' }, text: 'HKBN' })
    assert.equal(unsupported.structuredContent.error.code, 'INVALID_ARGUMENTS')
    assert.deepEqual(await page.evaluate(() => window.inputEvents), [], 'Invalid recovery attempts also leave input untouched')

    const expanded = await tools.get('browser_click').execute('expand', { selector: '#expand' })
    assert.equal(expanded.isError, false)
    const ref = expanded.content[0].text.match(/textbox "Search".*\[ref=([^\]]+)\]/)?.[1]
    assert.ok(ref, 'Expanding the input exposes a current snapshot ref')
    assert.equal((await type({ ref, text: 'HKBN', submit: true })).isError, false)
    assert.equal(await page.locator('#q').inputValue(), 'HKBN', 'A visible input still accepts real keyboard replay')
    assert.ok((await page.evaluate(() => window.inputEvents)).includes('key:Enter'))

    await page.evaluate(() => {
      document.getElementById('q').style.visibility = 'hidden';
      window.inputEvents = [];
    })
    const hidden = await type({ selector: '#q', text: 'changed' })
    assert.equal(hidden.structuredContent.error.code, 'TYPE_TARGET_NOT_INTERACTABLE')
    assert.match(hidden.content[0].text, /input is hidden/)
    assert.deepEqual(await page.evaluate(() => window.inputEvents), [])
    assert.equal(await page.locator('#q').inputValue(), 'HKBN')

    await page.evaluate(() => {
      document.getElementById('q').style.visibility = 'visible';
      document.getElementById('q').style.top = '1600px';
      document.body.style.height = '2200px';
    })
    assert.equal((await type({ selector: '#q', text: 'scrolled' })).isError, false)
    assert.equal(await page.locator('#q').inputValue(), 'scrolled', 'Ordinary offscreen inputs remain scrollable and usable')
  } finally {
    service?.dispose()
    await application?.close().catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }
}
