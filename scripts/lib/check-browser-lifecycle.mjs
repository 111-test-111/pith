/** Development React replays mount effects; verify the real pane's async
 * auto-fill and restore still complete once, and stop after a true unmount.
 * Guest registration is covered by check-browser-ui's production IPC cases. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { _electron } from 'playwright-core'

export async function checkBrowserLifecycle(repo) {
  const temporary = await mkdtemp(join(tmpdir(), 'pith-browser-lifecycle-'))
  const fixturePath = '/__browser_lifecycle.html'
  const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPane} from '/src/components/app/BrowserPane.tsx';
import {BrowserStore} from '/src/lib/browser/store.ts';
import {readOpenBrowserPages, writeOpenBrowserPages} from '/src/lib/browser/session.ts';
import {I18nProvider} from '/src/i18n/index.tsx';
localStorage.setItem('pi-app:locale', 'en');
const h = React.createElement;
const status = {available: true, consentRequired: false, pages: [], pendingCreates: []};
const noop = () => () => {};
window.ensureWaiters = [];
window.effectSetups = 0;
window.effectCleanups = 0;
window.emptyCalls = 0;
window.pi = {
  browserStatus: async () => status,
  browserEnsureService: () => new Promise(resolve => window.ensureWaiters.push(resolve)),
  browserSetActive: async () => {},
  browserTheme: async () => {},
  onBrowserGuestShortcut: noop,
  onBrowserFocusGuest: noop,
  onBrowserGuestPointer: noop,
  onBrowserSearchEngineChanged: noop,
  appInfo: async () => ({browserSearchEngine: 'google'})
};
function Witness() {
  React.useEffect(() => {
    window.effectSetups++;
    return () => { window.effectCleanups++; };
  }, []);
  return null;
}
let root;
window.mountBrowser = entries => {
  writeOpenBrowserPages(entries);
  window.store = new BrowserStore();
  root = createRoot(document.getElementById('root'));
  root.render(h(React.StrictMode, null, h(Witness), h(I18nProvider, null,
    h(BrowserPane, {store: window.store, active: true, onEmpty: () => {window.emptyCalls++;}}))));
};
window.unmountBrowser = () => root.unmount();
window.readSnapshot = readOpenBrowserPages;
window.fixtureReady = true;
</script></body></html>`
  let server, application
  const errors = []
  try {
    server = await createServer({
      configFile: false, root: join(repo, 'src/renderer'),
      cacheDir: join(temporary, 'vite'), logLevel: 'error',
      resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
      plugins: [react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }), {
        name: 'browser-lifecycle-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== fixturePath) return next()
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) { next(error) }
          })
        }
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
    })
    await server.listen()
    const url = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
    const main = join(temporary, 'main.cjs')
    await writeFile(main, `const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({show: false, webPreferences: {contextIsolation: false, backgroundThrottling: false}});
  window.loadURL(${JSON.stringify(url)});
});`)
    application = await _electron.launch({
      executablePath: electron, args: [main],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
    })
    const page = await application.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await page.waitForFunction(() => window.fixtureReady)

    await page.evaluate(() => window.mountBrowser([]))
    await page.waitForFunction(() => window.ensureWaiters.length === 1 && window.effectSetups === 2)
    assert.equal(await page.evaluate(() => window.effectCleanups), 1, 'development StrictMode replays mount effects')
    assert.equal(await page.locator('[data-browser-tab]').count(), 0, 'auto-fill waits for service readiness')
    await page.evaluate(() => window.ensureWaiters[0]())
    await page.waitForFunction(() => document.querySelectorAll('[data-browser-tab]').length === 1, null, { timeout: 5_000 })
    assert.equal(await page.locator('[data-browser-tab] [role=tab]').innerText(), 'about:blank', 'empty opening auto-creates one blank tab')
    assert.equal(await page.locator('[data-browser-toolbar] input').inputValue(), 'about:blank')
    assert.equal(await page.evaluate(() => window.ensureWaiters.length), 1, 'effect replay never duplicates auto-fill')

    // A true fold/remount still reconstructs the saved strip, including its
    // selected blank tab, instead of adding another default blank page.
    await page.evaluate(() => {
      window.unmountBrowser();
      window.mountBrowser([
        {owner: 'human', url: 'https://fixture.test/restored', title: 'Restored page'},
        {owner: 'human', selected: true}
      ]);
    })
    await page.waitForFunction(() => window.ensureWaiters.length === 2)
    await page.evaluate(() => window.ensureWaiters[1]())
    await page.waitForFunction(() => document.querySelectorAll('[data-browser-tab]').length === 2)
    assert.deepEqual(await page.locator('[data-browser-tab] [role=tab]').allInnerTexts(), ['Restored page', 'about:blank'])
    assert.equal(await page.locator('[data-browser-tab] [role=tab][aria-selected=true]').innerText(), 'about:blank')

    // A delayed ensure receipt from a genuinely unmounted pane must still be
    // ignored; the next pane completes its own ensure and creates one page.
    await page.evaluate(() => { window.unmountBrowser(); window.mountBrowser([]) })
    await page.waitForFunction(() => window.ensureWaiters.length === 3)
    await page.evaluate(() => { window.unmountBrowser(); window.mountBrowser([]) })
    await page.waitForFunction(() => window.ensureWaiters.length === 4)
    await page.evaluate(async () => { window.ensureWaiters[2](); await new Promise(resolve => requestAnimationFrame(resolve)) })
    assert.equal(await page.locator('[data-browser-tab]').count(), 0, 'late unmounted restore cannot populate the new pane')
    assert.deepEqual(await page.evaluate(() => window.readSnapshot()), [])
    await page.evaluate(() => window.ensureWaiters[3]())
    await page.waitForFunction(() => document.querySelectorAll('[data-browser-tab]').length === 1)
    assert.equal(await page.evaluate(() => window.emptyCalls), 0, 'initial empty state does not close the browser')
    await page.evaluate(() => window.unmountBrowser())
    assert.deepEqual(errors, [], 'development browser lifecycle has no renderer errors')
  } finally {
    await application?.close().catch(() => {})
    await server?.close().catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }
}
