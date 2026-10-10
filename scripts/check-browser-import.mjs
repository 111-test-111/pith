/** Offline Chrome-cookie import checks: synthetic databases and injected keys,
 * followed by the real BrowserSection in isolated Electron with mocked IPC.
 * Covers crypto, safe timestamps, mapping, manifests, errors and both locales.
 * No build is required; use Node >=23.6 for native TypeScript imports.
 * PI_BROWSER_IMPORT_SCREENSHOT_DIR retains screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const mod = await import('../src/main/browser/import-cookies.ts')

const FIXTURE_PASSPHRASE = 'fixture-safe-storage-pass'
const FIXTURE_KEY = pbkdf2Sync(FIXTURE_PASSPHRASE, 'saltysalt', 1003, 16, 'sha1')
const IV = Buffer.alloc(16, 0x20)
function encryptValue(plain, prefix = 'v10', hostKey = null) {

  const payload = hostKey
    ? Buffer.concat([createHash('sha256').update(hostKey, 'utf8').digest(), Buffer.from(plain, 'utf8')])
    : Buffer.from(plain, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', FIXTURE_KEY, IV)
  return Buffer.concat([
    Buffer.from(prefix, 'latin1'),
    cipher.update(payload),
    cipher.final()
  ])
}

// The corresponding WebKit microseconds exceed 2^53; SQL must perform the conversion.
const FUTURE_UNIX = 4102444800
const PAST_UNIX = 1000000000 // 2001-09-09
const toWebkitMicro = (unix) => BigInt(unix + 11644473600) * 1000000n

function buildCookiesDb(file, rows, { withSameSite = true } = {}) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE cookies (
    creation_utc INTEGER NOT NULL DEFAULT 0,
    host_key TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    encrypted_value BLOB DEFAULT NULL,
    path TEXT NOT NULL DEFAULT '/',
    expires_utc INTEGER NOT NULL DEFAULT 0,
    is_secure INTEGER NOT NULL DEFAULT 0,
    is_httponly INTEGER NOT NULL DEFAULT 0,
    is_persistent INTEGER NOT NULL DEFAULT 0,
    has_expires INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 1,
    ${withSameSite ? 'samesite INTEGER NOT NULL DEFAULT -1,' : ''}
    source_scheme INTEGER NOT NULL DEFAULT 0,
    source_port INTEGER NOT NULL DEFAULT -1,
    last_update_utc INTEGER NOT NULL DEFAULT 0
  )`)
  const cols = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'is_persistent']
  if (withSameSite) cols.push('samesite')
  const insert = db.prepare(`INSERT INTO cookies (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  for (const row of rows) {
    const encrypted = row.blob ?? (row.plain !== undefined ? Buffer.alloc(0) : encryptValue(row.value ?? '', row.prefix, row.hostKey ?? null))
    const args = [
      row.host,
      row.name,
      row.plain ?? '',
      encrypted,
      row.path ?? '/',
      toWebkitMicro(row.expiresUnix ?? FUTURE_UNIX),
      row.secure ? 1 : 0,
      row.httpOnly ? 1 : 0,
      row.persistent ? 1 : 0
    ]
    if (withSameSite) args.push(row.samesite ?? -1)
    insert.run(...args)
  }
  db.close()
}

const temporary = await mkdtemp(join(tmpdir(), 'pith-browser-import-'))
const chromeRoot = join(temporary, 'chrome')
const recordPath = join(temporary, 'browser-import.json')
const getKey = async () => FIXTURE_PASSPHRASE

try {

  await mkdir(join(chromeRoot, 'Default', 'Network'), { recursive: true })
  await mkdir(join(chromeRoot, 'Profile 3'), { recursive: true })
  await mkdir(join(chromeRoot, 'Profile 5'), { recursive: true })
  await mkdir(join(chromeRoot, 'Corrupt'), { recursive: true })
  await mkdir(join(chromeRoot, 'NoCookies'), { recursive: true })
  await mkdir(join(chromeRoot, '.snapshot'), { recursive: true })
  await writeFile(
    join(chromeRoot, 'Local State'),
    JSON.stringify({
      profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 3': { name: '工作' } } }
    }),
    'utf8'
  )

  buildCookiesDb(
    join(chromeRoot, 'Default', 'Network', 'Cookies'),
    [

      { host: '.example.com', name: 'sid', value: 'sess-1', path: '/', expiresUnix: FUTURE_UNIX, secure: true, httpOnly: true, persistent: true, samesite: 1 },

      { host: 'www.plain.test', name: 'theme', plain: 'plain-val', persistent: true },

      { host: 'api.bank.test', name: '__Host-csrf', value: 'tok', path: '/deep/path', secure: true, persistent: true, samesite: 2 },

      { host: '.old.test', name: 'dead', value: 'x', expiresUnix: PAST_UNIX, persistent: true },

      { host: '.agg.test', name: 'tracker', value: 't', expiresUnix: 0, persistent: false },

      { host: '.win.test', name: 'ab', blob: encryptValue('x', 'v20'), persistent: true },

      { host: '.bad.test', name: 'broken', blob: Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.alloc(32, 0xab)]), persistent: true },
      // samesite=0 + secure → no_restriction
      { host: '.none.test', name: 'ns', value: 'v', secure: true, persistent: true, samesite: 0 },

      { host: '.down.test', name: 'd', value: 'v', persistent: true, samesite: 0 },

      { host: 'legacy.site', name: '__Secure-pre', value: 'v', persistent: true },

      { host: '.bound.test', name: 'sess', value: 'bound-value-1', hostKey: '.bound.test', path: '/', expiresUnix: FUTURE_UNIX, secure: true, persistent: true, samesite: 1 },
      { host: 'api2.bank.test', name: '__Host-bound', value: 'bound-2', hostKey: 'api2.bank.test', secure: true, persistent: true }
    ],
    { withSameSite: true }
  )
  buildCookiesDb(
    join(chromeRoot, 'Profile 3', 'Cookies'),
    [

      { host: '.example.com', name: 'sid', value: 'sess-1-b', path: '/', expiresUnix: FUTURE_UNIX, secure: true, persistent: true },
      { host: '.new.test', name: 'extra', value: 'e', persistent: true }
    ],
    { withSameSite: false }
  )
  buildCookiesDb(join(chromeRoot, 'Profile 5', 'Cookies'), [
    { host: '.a.test', name: 'k1', value: 'v', persistent: true },
    { host: '.b.test', name: 'k2', value: 'v', persistent: true }
  ])
  await writeFile(join(chromeRoot, 'Corrupt', 'Cookies'), 'this is not a sqlite database at all', 'utf8')

  const sources = mod.listChromeProfiles(chromeRoot)
  assert.deepEqual(
    sources.map((s) => s.id),
    ['Default', 'Corrupt', 'Profile 3', 'Profile 5'],
    'profiles: Default first, Profile N numeric, no-Cookies and dot dirs excluded'
  )
  assert.deepEqual(
    sources.map((s) => s.label),
    ['Person 1', 'Corrupt', '工作', 'Profile 5'],
    'labels come from Local State info_cache, falling back to the dir name'
  )
  assert.deepEqual(mod.listChromeProfiles(join(temporary, 'no-such-root')), [], 'missing root lists nothing')

  assert.equal(mod.chromeRootStatus(join(temporary, 'gone')), 'absent', 'a missing root classifies as absent')
  assert.equal(mod.chromeRootStatus(chromeRoot), 'ok', 'a root with cookie DBs classifies as ok')
  const emptyRoot = join(temporary, 'empty-chrome')
  await mkdir(emptyRoot, { recursive: true })
  assert.equal(mod.chromeRootStatus(emptyRoot), 'none', 'an installed-but-empty Chrome classifies as none')
  const epermReaddir = () => {
    const error = new Error('Operation not permitted')
    error.code = 'EPERM'
    throw error
  }
  assert.equal(mod.chromeRootStatus(chromeRoot, epermReaddir), 'blocked', 'a TCC EPERM readdir classifies as blocked')
  assert.deepEqual(
    mod.discoverChrome(chromeRoot, epermReaddir),
    { status: 'blocked', profiles: [] },
    'discovery carries no profiles when blocked'
  )
  const blockedImport = await mod.importChromeCookies({
    profileId: 'Default',
    chromeRoot,
    recordPath,
    getKey: async () => {
      throw new Error('the keychain must not be touched while blocked')
    },
    apply: async () => {
      throw new Error('apply must not run while blocked')
    },
    readdirImpl: epermReaddir
  })
  assert.equal(blockedImport.result.ok, false, 'a blocked root fails the import')
  assert.equal(blockedImport.result.code, 'permission', 'the failure carries the permission code')
  assert.equal(existsSync(recordPath), false, 'a blocked import writes no record')

  const applied = []
  const first = await mod.importChromeCookies({
    profileId: 'Default',
    chromeRoot,
    recordPath,
    getKey,
    apply: async (details) => {
      applied.push(...details)
      return { results: details.map(() => true) }
    }
  })
  assert.equal(first.result.ok, true, 'import Default succeeds')
  assert.equal(first.result.total, 12, 'twelve rows read')
  assert.equal(first.result.imported, 9, 'nine cookies mapped and applied (incl. domain-bound)')
  assert.equal(first.result.failed, 1, 'the corrupted v10 blob counts as failed')
  assert.equal(first.result.skippedExpired, 1, 'the expired cookie is skipped')
  assert.equal(first.result.skippedUndecryptable, 1, 'the v20 blob is skipped as undecryptable')

  const byName = new Map(applied.map((d) => [d.name, d]))
  const sid = byName.get('sid')
  assert.deepEqual(
    { ...sid },
    {
      url: 'https://example.com/',
      name: 'sid',
      value: 'sess-1',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: FUTURE_UNIX,
      sameSite: 'lax'
    },
    'domain cookie maps exactly (leading-dot domain, https, exact int64-safe expiry)'
  )
  const theme = byName.get('theme')
  assert.equal(theme.url, 'http://www.plain.test/', 'host-only non-secure cookie uses an http url')
  assert.equal(theme.domain, undefined, 'host-only cookie carries no domain')
  assert.equal(theme.value, 'plain-val', 'an empty encrypted_value falls back to the plaintext column')
  assert.equal(theme.sameSite, 'unspecified', 'samesite -1 maps to unspecified')
  const csrf = byName.get('__Host-csrf')
  assert.equal(csrf.path, '/', '__Host- forces path /')
  assert.equal(csrf.domain, undefined, '__Host- stays host-only')
  assert.equal(csrf.url, 'https://api.bank.test/', '__Host- url is https with the forced path')
  assert.equal(csrf.sameSite, 'strict', 'samesite 2 maps to strict')
  assert.equal(byName.get('tracker').expirationDate, undefined, 'a session cookie gets no expirationDate')
  assert.equal(byName.get('ns').sameSite, 'no_restriction', 'samesite 0 + secure maps to no_restriction')
  assert.equal(byName.get('d').sameSite, 'unspecified', 'samesite 0 without secure downgrades to unspecified')
  assert.equal(byName.get('__Secure-pre').secure, true, '__Secure- prefix forces secure even if the column says 0')
  assert.equal(byName.get('__Secure-pre').url.startsWith('https://'), true, 'the forced cookie also sets over https')
  assert.equal(byName.get('sess').value, 'bound-value-1', 'the domain-bound v10 value strips its sha256(host) prefix')
  assert.equal(byName.get('__Host-bound').value, 'bound-2', 'a host-only domain-bound value strips too')
  assert.equal(byName.has('dead'), false, 'the expired cookie never reaches apply')
  assert.equal(byName.has('ab'), false, 'the v20 blob never reaches apply')

  const second = await mod.importChromeCookies({
    profileId: 'Profile 3',
    chromeRoot,
    recordPath,
    getKey,
    apply: async (details) => ({

      results: details.map((_detail, index) => index !== 0),
      firstError: 'synthetic set failure'
    })
  })
  assert.equal(second.result.ok, true, 'import Profile 3 succeeds (legacy Cookies location)')
  assert.equal(second.result.imported, 1, 'only the applied half of a partially failed import counts')
  assert.equal(second.result.failed, 1, 'the failed write is reported in the result')
  assert.equal(second.result.firstError, 'synthetic set failure', 'the first technical error surfaces for diagnosis')
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(record.imports.length, 2, 'both imports are recorded')
  assert.equal(record.imports[1].profileLabel, '工作', 'the label resolves through Local State')
  const uniqueKeys = new Set(record.cookies.map((c) => `${c[3]}|${c[0]}|${c[1]}|${c[2]}`))
  assert.equal(record.cookies.length, 10, '9 applied + 1 new identity; the duplicate sid and the failed write stay out')
  assert.equal(uniqueKeys.size, 10, 'recorded identities are unique')

  const status = mod.readImportStatus(recordPath)
  assert.equal(status.present, true, 'status is present after imports')
  assert.equal(status.profileLabel, '工作', 'status names the latest import')
  assert.equal(status.cookieCount, 10, 'status counts the merged applied identities')

  const removals = []
  const cleared = await mod.clearImportedCookies(recordPath, async (url, name) => {
    removals.push([url, name])
  })
  assert.equal(cleared.removed, 10, 'every recorded applied identity got a removal call')
  assert.deepEqual(
    removals.find(([url, name]) => name === 'sid'),
    ['https://example.com/', 'sid'],
    'domain identity removes over https at the dot-less host'
  )
  assert.deepEqual(
    removals.find(([url, name]) => name === '__Host-csrf'),
    ['https://api.bank.test/', '__Host-csrf'],
    '__Host- removal url keeps the forced path'
  )
  assert.deepEqual(
    removals.find(([url, name]) => name === 'theme'),
    ['http://www.plain.test/', 'theme'],
    'non-secure identity removes over http'
  )
  assert.equal(existsSync(recordPath), false, 'clearing deletes the record')
  assert.equal(mod.readImportStatus(recordPath).present, false, 'status is absent after clearing')
  assert.deepEqual(await mod.clearImportedCookies(recordPath, async () => {}), { removed: 0, failed: 0 }, 'clearing again is a no-op')

  assert.equal(mod.removalUrlFor(['.x.test', 'n', '', 0]), 'http://x.test/', 'an empty path falls back to /')

  assert.deepEqual(mod.decryptCookieValue(undefined, FIXTURE_KEY), { status: 'ok', value: '' }, 'missing blob decrypts to empty')
  assert.deepEqual(mod.decryptCookieValue(Buffer.alloc(0), FIXTURE_KEY), { status: 'ok', value: '' }, 'empty blob decrypts to empty')
  const v11 = mod.decryptCookieValue(encryptValue('v11-value', 'v11'), FIXTURE_KEY)
  assert.deepEqual(v11, { status: 'ok', value: 'v11-value' }, 'the v11 prefix decrypts too')
  assert.equal(mod.decryptCookieValue(Buffer.from('v1'), FIXTURE_KEY).status, 'unsupported', 'a too-short blob is unsupported')
  assert.deepEqual(
    mod.decryptCookieValue(encryptValue('legacy-plain'), FIXTURE_KEY),
    { status: 'ok', value: 'legacy-plain' },
    'a legacy no-prefix value passes through unchanged'
  )
  const boundBlob = encryptValue('the-value', 'v10', '.x.test')
  assert.deepEqual(
    mod.decryptCookieValue(boundBlob, FIXTURE_KEY, '.x.test'),
    { status: 'ok', value: 'the-value' },
    'the sha256(host) domain binding is verified and stripped'
  )
  assert.notEqual(
    mod.decryptCookieValue(boundBlob, FIXTURE_KEY, '.other.test').value,
    'the-value',
    'a mismatched host hash is left in place (no blind strip)'
  )

  const escape = await mod.importChromeCookies({ profileId: '../etc', chromeRoot, recordPath, getKey })
  assert.equal(escape.result.code, 'profile-not-found', 'a path-traversal profile id is rejected')
  const unknown = await mod.importChromeCookies({ profileId: 'Nope', chromeRoot, recordPath, getKey })
  assert.equal(unknown.result.code, 'profile-not-found', 'an unknown profile id is rejected')
  const corrupt = await mod.importChromeCookies({ profileId: 'Corrupt', chromeRoot, recordPath, getKey })
  assert.equal(corrupt.result.code, 'database', 'a non-sqlite Cookies file reports database')
  const noRoot = await mod.importChromeCookies({ profileId: 'Default', chromeRoot: join(temporary, 'gone'), recordPath, getKey })
  assert.equal(noRoot.result.code, 'chrome-not-found', 'a missing chrome root reports chrome-not-found')

  const wrongKey = await mod.importChromeCookies({
    profileId: 'Profile 5',
    chromeRoot,
    recordPath,
    getKey: async () => 'a-wrong-passphrase',
    apply: async (details) => ({ results: details.map(() => true) })
  })
  assert.equal(wrongKey.result.ok, false, 'a wrong keychain passphrase fails the import')
  assert.equal(wrongKey.result.code, 'keychain', 'the failure is attributed to the keychain')
  assert.equal(wrongKey.result.imported, 0, 'nothing is imported with the wrong key')
  assert.equal(existsSync(recordPath), false, 'a failed import writes no record')

  const invalid = mod.mapCookieRow({ host_key: '', name: 'x', value: '', path: '/', is_secure: 0, is_httponly: 0, is_persistent: 1, samesite: -1, expires_unix: FUTURE_UNIX }, 'v', FUTURE_UNIX)
  assert.deepEqual(invalid, { kind: 'skipped', reason: 'invalid' }, 'a row without a host is skipped as invalid')

  console.log('check-browser-import: part 1 (module) passed')
} finally {
  await rm(temporary, { recursive: true, force: true }).catch(() => {})
}

const fixturePath = '/__browser_import_check.html'
const fixture = `<!doctype html><html><head><style>
body { margin: 0; background: var(--background); }
#root { padding: 24px; max-width: 900px; }
</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserSection} from '/src/components/app/settings/BrowserSection.tsx';
import {ToastProvider} from '/src/components/app/ToastProvider.tsx';
import {I18nProvider} from '/src/i18n/index.tsx';
import '/src/styles.css';

const params = new URLSearchParams(location.search);
window.calls = [];
window.state = { present: false, profileLabel: null, cookieCount: 0 };
const fail = params.get('fail');
const status = params.get('blocked') === '1' ? 'blocked'
  : params.get('absent') === '1' ? 'absent'
  : params.get('sources') === 'none' ? 'none'
  : 'ok';
// Full Disk Access fixture: development by default; ?installed=1 simulates a packaged app.
const devMode = params.get('installed') !== '1';
const profiles = status !== 'ok' ? [] : [
  { id: 'Default', label: 'Person 1' },
  { id: 'Profile 1', label: 'Work' }
];
window.pi = {
  appInfo: async () => ({
    version: '9.9.9', checkpointsEnabled: true, startup: 'resume', subagentsEnabled: true,
    subagentMaxConcurrent: 4, bashMaxWaitMs: 10000, askUserTimeoutSeconds: 120,
    sandboxMode: 'workspace-write',
    sandbox: { support: 'ready', backend: 'seatbelt', enforcement: 'full', unsandboxed: false },
    cwd: null, folders: [], contextFiles: true,
    browserConsent: true, browserAgentToolsEnabled: false, browserSearchEngine: 'google'
  }),
  setBrowserAgentTools: async (v) => v,
  setBrowserSearchEngine: async (v) => v,
  onBrowserSearchEngineChanged: () => () => {},
  browserImportSources: async () => ({ status, profiles, devMode }),
  browserOpenPrivacySettings: async () => { window.calls.push(['openPrivacySettings']); },
  browserImportCookies: async (profileId) => {
    window.calls.push(['import', profileId]);
    await new Promise((r) => setTimeout(r, 120));
    if (fail === 'write') {
      window.state = { present: true, profileLabel: 'Person 1', cookieCount: 2 };
      return { ok: true, total: 5, imported: 2, failed: 2, firstError: 'synthetic set failure', skippedExpired: 1, skippedUndecryptable: 0 };
    }
    if (fail) return { ok: false, code: fail, total: 5, imported: 0, failed: 5, skippedExpired: 0, skippedUndecryptable: 0 };
    window.state = { present: true, profileLabel: 'Person 1', cookieCount: 2 };
    return { ok: true, total: 5, imported: 2, failed: 0, skippedExpired: 1, skippedUndecryptable: 1 };
  },
  browserImportStatus: async () => ({
    present: window.state.present,
    source: window.state.present ? 'chrome' : undefined,
    profileLabel: window.state.profileLabel ?? undefined,
    importedAt: window.state.present ? 1700000000000 : undefined,
    cookieCount: window.state.cookieCount
  }),
  browserClearImported: async () => {
    const removed = window.state.cookieCount;
    window.state = { present: false, profileLabel: null, cookieCount: 0 };
    window.calls.push(['clearImported', removed]);
    return { removed, failed: 0 };
  },
  browserClearData: async () => {
    window.calls.push(['clearData']);
    window.state = { present: false, profileLabel: null, cookieCount: 0 };
  }
};
if (!localStorage.getItem('pi-app:locale')) localStorage.setItem('pi-app:locale', 'en');
window.q = (sel) => document.querySelector(sel);
window.click = (sel) => { const el = window.q(sel); if (!el) return false; el.click(); return true; };
window.importNote = (attr) => window.q('[data-browser-import-status="' + attr + '"]')?.textContent?.trim() ?? null;
window.toastText = () => document.querySelector('.app-toast-region')?.textContent ?? '';
window.rowDesc = (sel) => {
  const control = window.q(sel);
  if (!control) return null;
  const row = control.parentElement.parentElement;
  const ps = row.querySelectorAll('p');
  return ps.length > 1 ? ps[1].textContent.trim() : null;
};
const h = React.createElement;
createRoot(document.getElementById('root')).render(h(I18nProvider, null, h(ToastProvider, null, h(BrowserSection))));
window.fixtureReady = true;
</script></body></html>`

let child, ws, server
const electronTmp = await mkdtemp(join(tmpdir(), 'pith-browser-import-ui-'))
try {
  server = await createServer({
    configFile: false,
    root: join(repo, 'src/renderer'),
    logLevel: 'error',
    cacheDir: join(electronTmp, 'vite'),
    resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [
      react({ exclude: /(?:node_modules|\/vite\/deps\/)/ }),
      tailwindcss(),
      {
        name: 'browser-import-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== fixturePath) return next()
            try {
              res.setHeader('Content-Type', 'text/html')
              res.end(await server.transformIndexHtml(fixturePath, fixture))
            } catch (error) {
              next(error)
            }
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}${fixturePath}`
  const main = join(electronTmp, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(electronTmp, 'profile'))});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1180,height:1000,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});
app.on('window-all-closed',()=>app.quit());`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [main], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start: ' + output)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('Electron exited: ' + code))
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve('http://127.0.0.1:' + match[1])
      }
    })
  })
  let page
  for (let i = 0; i < 100 && !page; i++) {
    page = (await (await fetch(endpoint + '/json/list')).json()).find((p) => p.type === 'page')
    if (!page) await pause(50)
  }
  assert.ok(page, 'Electron page created')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const pending = new Map()
  const exceptions = []
  const ELECTRON_NOISE = /sandboxed_renderer\.bundle\.js|binding\.startupData/
  let sequence = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description).join(' ')
      if (!ELECTRON_NOISE.test(text)) exceptions.push({ console: text })
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, (m) => (m.error ? reject(m.error) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const load = async (query) => {
    await send('Page.navigate', { url: origin + (query ?? '') })
    for (let i = 0; i < 200; i++) {
      const ready = await evaluate('!!window.fixtureReady && !!window.q("[data-browser-section]") && !!window.q("[data-browser-import]")')
      if (ready) return
      await pause(50)
    }
    throw new Error('Fixture did not mount')
  }
  const click = (sel) => evaluate(`window.click(${JSON.stringify(sel)})`)
  const screenshot = async (name) => {
    if (!process.env.PI_BROWSER_IMPORT_SCREENSHOT_DIR) return
    await mkdir(process.env.PI_BROWSER_IMPORT_SCREENSHOT_DIR, { recursive: true })
    const capture = await send('Page.captureScreenshot')
    await writeFile(join(process.env.PI_BROWSER_IMPORT_SCREENSHOT_DIR, name + '.png'), Buffer.from(capture.data, 'base64'))
  }

  await load()
  await pause(300)
  assert.equal(await evaluate('window.q("[data-browser-import]") !== null'), true, 'the import row renders')
  assert.equal(await evaluate('window.q("[data-browser-import]").disabled'), false, 'the import button is enabled with profiles present')
  assert.equal(await evaluate('window.q("[data-browser-import-profile] button").textContent'), 'Person 1', 'the trigger shows the first profile label')
  assert.equal(await evaluate('window.q("[data-browser-import-profile] button").getAttribute("aria-label")'), 'Chrome profile', 'the trigger carries its localized aria-label')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").disabled'), true, 'clear-import is disabled without an import record')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").textContent'), 'Clear imported login state', 'the clear-import row is labelled')
  assert.equal(await evaluate('window.importNote("none")'), null, 'the no-chrome note stays hidden when profiles exist')

  assert.equal(await click('[data-browser-import]'), true)
  await frame()
  assert.equal(await evaluate('window.q("[data-browser-import]").dataset.browserImport'), 'busy', 'the button enters its busy state')
  assert.equal(await evaluate('window.q("[data-browser-import]").disabled'), true, 'the button is disabled while importing')
  await pause(400)
  await frame()
  assert.deepEqual(await evaluate('window.calls'), [['import', 'Default']], 'the import uses the selected profile id')
  const doneToast = await evaluate('window.toastText()')
  assert.equal(doneToast.includes('Imported 2 cookies from Chrome.'), true, 'the bottom-right toast reports the imported count')
  assert.equal(doneToast.includes('2 cookies skipped (expired or unreadable).'), true, 'the toast description carries the skipped summary')
  assert.equal(await evaluate('window.importNote("done")'), null, 'no inline done note — after-action feedback lives in the toast')
  assert.equal(await evaluate('window.importNote("skipped")'), null, 'no inline skipped note either')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").disabled'), false, 'clear-import enables once a record exists')
  assert.equal(
    await evaluate('window.rowDesc("[data-browser-clear-import]")'),
    'Imported from Person 1 · 2 cookies',
    'the clear-import hint names the profile and count'
  )
  await screenshot('browser-import-done-light')

  assert.equal(await click('[data-browser-clear-import]'), true)
  await frame()
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").dataset.browserClearImport'), 'confirm', 'the first click arms the confirm state')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").textContent'), 'Click again to remove', 'the confirm label replaces the idle one')
  assert.equal(await click('[data-browser-clear-import]'), true)
  await pause(100)
  await frame()
  assert.deepEqual(await evaluate('window.calls'), [['import', 'Default'], ['clearImported', 2]], 'the second click clears the record')
  assert.equal((await evaluate('window.toastText()')).includes('Removed 2 imported cookies.'), true, 'the removal reports its count in a toast')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").disabled'), true, 'clear-import disables again after clearing')

  await load('?fail=keychain')
  await pause(300)
  assert.equal(await click('[data-browser-import]'), true)
  await pause(400)
  await frame()
  assert.equal(
    (await evaluate('window.toastText()')).includes('macOS keychain access was denied'),
    true,
    'a keychain failure surfaces its localized reason as an error toast'
  )

  await load('?fail=write')
  await pause(300)
  assert.equal(await click('[data-browser-import]'), true)
  await pause(400)
  await frame()
  const writeToast = await evaluate('window.toastText()')
  assert.equal(writeToast.includes('Imported 2 cookies from Chrome.'), true, 'the success toast still reports the successes')
  assert.equal(writeToast.includes('2 cookies could not be written (synthetic set failure).'), true, 'the toast description carries the failed count and the first technical error')
  assert.equal(await evaluate('window.importNote("failedwrite")'), null, 'no inline failedwrite note remains')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").disabled'), false, 'clear-import tracks only applied cookies')

  await load('?sources=none')
  await pause(300)
  assert.equal(await evaluate('window.q("[data-browser-import-profile]")'), null, 'no profile select renders without Chrome')
  assert.equal(await evaluate('window.q("[data-browser-import]").disabled'), true, 'the import button is disabled without Chrome')
  assert.equal(await evaluate('window.importNote("none")'), 'No Chrome profiles found on this Mac.', 'the no-chrome note renders')
  assert.equal(await evaluate('window.importNote("absent")'), null, 'the absent note stays hidden for none')

  await load('?blocked=1')
  await pause(300)
  assert.equal(await evaluate('window.q("[data-browser-import]").disabled'), true, 'the import button is disabled while blocked')
  assert.equal(await evaluate('window.q("[data-browser-import-profile]")'), null, 'no profile select renders while blocked')
  assert.equal(await evaluate('window.q("[data-browser-import-permission]") !== null'), true, 'the permission guidance row renders')
  assert.equal(
    (await evaluate('window.q("[data-browser-import-permission]").textContent')).includes('Full Disk Access'),
    true,
    'the guidance names Full Disk Access'
  )
  assert.equal(await click('[data-browser-import-permission] button'), true)
  await frame()
  assert.deepEqual(await evaluate('window.calls'), [['openPrivacySettings']], 'the button routes through the open-privacy-settings bridge')

  assert.equal(
    await evaluate('window.q("[data-browser-import-fda-guide]")?.getAttribute("data-browser-import-fda-guide")'),
    'dev',
    'the dev guidance variant renders (unpacked build)'
  )
  const devGuide = await evaluate('window.q("[data-browser-import-fda-guide]").textContent')
  assert.equal(devGuide.includes('terminal'), true, 'the dev guidance grants Full Disk Access to the launching terminal')
  assert.equal(devGuide.includes('no need to add the app itself'), true, 'the dev guidance passes on that the app itself is not needed')
  assert.equal(await evaluate('window.q("[data-browser-import-fda-path]")'), null, 'the path chip and the ⌘⇧G paste steps are gone (one line, in passing)')
  assert.equal(await evaluate('window.importNote("none")'), null, 'no misleading none-note while blocked')

  await load('?blocked=1&installed=1')
  await pause(300)
  assert.equal(
    await evaluate('window.q("[data-browser-import-fda-guide]")?.getAttribute("data-browser-import-fda-guide")'),
    'installed',
    'the installed guidance variant renders'
  )
  const installedGuide = await evaluate('window.q("[data-browser-import-fda-guide]").textContent')
  assert.equal(installedGuide.includes('Full Disk Access'), true, 'the installed guidance names Full Disk Access')
  assert.equal(installedGuide.includes('terminal'), false, 'the installed guidance does not send the user down the terminal path')

  await load('?absent=1')
  await pause(300)
  assert.equal(await evaluate('window.importNote("absent")'), 'Chrome is not installed on this Mac.', 'the absent note is distinct')
  assert.equal(await evaluate('window.importNote("none")'), null, 'the none note stays hidden for absent')

  await evaluate('localStorage.setItem("pi-app:locale","zh-CN")')
  await load()
  await pause(300)
  assert.equal(await evaluate('document.body.textContent.includes("从 Chrome 导入登录态")'), true, 'the zh import row renders')
  assert.equal(await evaluate('window.q("[data-browser-import-profile] button").getAttribute("aria-label")'), 'Chrome 档案', 'the trigger aria-label is localized')
  assert.equal(await click('[data-browser-import]'), true)
  await pause(400)
  await frame()
  assert.equal((await evaluate('window.toastText()')).includes('已从 Chrome 导入 2 条 Cookie。'), true, 'the zh toast reports the count')
  assert.equal(await evaluate('window.rowDesc("[data-browser-clear-import]")'), '来自 Person 1 · 2 条 Cookie', 'the zh active hint names the profile and count')
  assert.equal(await evaluate('window.q("[data-browser-clear-import]").textContent'), '清除已导入的登录态', 'the zh clear row is labelled')
  await evaluate('document.documentElement.classList.add("dark")')
  await frame()
  await screenshot('browser-import-done-dark-zh')

  await load('?blocked=1')
  await pause(300)
  const zhDevGuide = await evaluate('window.q("[data-browser-import-fda-guide]").textContent')
  assert.equal(zhDevGuide.includes('终端'), true, 'the zh dev guidance names the launching terminal')
  assert.equal(zhDevGuide.includes('无需添加应用本身'), true, 'the zh dev guidance passes on that the app itself is not needed')
  assert.equal(zhDevGuide.includes('⌘⇧G'), false, 'the zh guidance carries no paste-steps ritual')

  assert.deepEqual(exceptions, [], 'no renderer exceptions during the fixture')
  console.log('check-browser-import: part 2 (settings UI) passed')
} finally {
  try {
    ws?.close()
  } catch {}
  child?.kill('SIGKILL')
  await server?.close().catch(() => {})
  await rm(electronTmp, { recursive: true, force: true }).catch(() => {})
}

console.log('check-browser-import: PASS')
