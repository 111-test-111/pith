/** The window is never a document viewer: our own document reloads, everything
 * else goes to the system browser. Real Electron, no app data. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-navigation-'))
let child
try {
  const main = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
import { app, BrowserWindow, shell } from 'electron';
import { createServer } from 'node:http';
import { guardExternalNavigation, isOwnDocument } from ${JSON.stringify(join(repo, 'src/main/navigation.ts'))};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opened = [];
shell.openExternal = (url) => { opened.push(url); return Promise.resolve(); };
// Exactly like the app: the announced dev URL has no trailing slash, and the
// page that loads is its origin root.
const DEV = 'http://localhost:5173';
const FILE = 'file:///Applications/Pith/out/renderer/index.html';
const PURE = [
  [DEV, DEV, true, 'the announced dev URL (no trailing slash) is our document'],
  [DEV + '/', DEV, true, 'its loaded href carries the trailing slash'],
  [DEV + '/#turn-3', DEV, true, 'a hash is the same document'],
  [DEV + '/?x=1', DEV, true, 'a query is the same document'],
  [DEV + '/other', DEV, false, 'another path on the dev host is not our document'],
  ['http://localhost:5174/', DEV, false, 'another dev port is not our document'],
  [FILE, FILE, true, 'the packaged document is itself'],
  [FILE + '#fragment', FILE, true, 'its fragment is itself'],
  ['https://example.com/', FILE, false, 'a web page is external'],
  ['mailto:someone@example.invalid', DEV, false, 'a mailto link is external']
];
app.whenReady().then(async () => {
  const pure = PURE.map(([candidate, own, expected, label]) => ({ label, expected, actual: isOwnDocument(candidate, own) }));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body>fixture</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const document = 'http://127.0.0.1:' + server.address().port;
  const subPath = document + '/other';
  const external = 'https://example.com/';
  const window = new BrowserWindow({ show: false });
  guardExternalNavigation(window.webContents, document);
  await window.loadURL(document + '/');
  const state = async () => ({ requests, opened: [...opened], href: await window.webContents.executeJavaScript('location.href'), body: await window.webContents.executeJavaScript('document.body.innerText') });
  // 1. A page-initiated reload of our own document must reload it.
  await window.webContents.executeJavaScript('location.reload()');
  await pause(700);
  const afterReload = await state();
  // 2. A sub-path on our own host is still not our document.
  await window.webContents.executeJavaScript('location.href = ' + JSON.stringify(subPath));
  await pause(600);
  const afterSubPath = await state();
  // 3. An external page must never take the window over.
  await window.webContents.executeJavaScript('location.href = ' + JSON.stringify(external));
  await pause(700);
  const afterExternal = await state();
  console.log('RESULT ' + JSON.stringify({ pure, document: document + '/', subPath, external, afterReload, afterSubPath, afterExternal }));
  server.close();
  app.quit();
});
app.on('window-all-closed', () => app.quit());`, resolveDir: repo, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: main })
  child = spawn(electron, [main], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out:\n' + output)), 30000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited (' + code + '):\n' + output)) })
    const poll = setInterval(() => {
      const match = /RESULT (\{.*\})/.exec(output)
      if (match) { clearInterval(poll); clearTimeout(timer); resolve(JSON.parse(match[1])) }
    }, 50)
  })
  for (const item of result.pure) assert.equal(item.actual, item.expected, item.label)
  assert.equal(result.afterReload.requests, 2, 'a reload of our own document reloads it')
  assert.deepEqual(result.afterReload.opened, [], 'a reload of our own document never opens a browser')
  assert.equal(result.afterReload.href, result.document, 'the window kept its own document')
  assert.equal(result.afterReload.body, 'fixture', 'the reloaded page is the app document')
  assert.deepEqual(result.afterSubPath.opened, [result.subPath], 'another path on the dev host goes to the system browser')
  assert.equal(result.afterSubPath.requests, 2, 'another path on the dev host does not navigate the window')
  assert.equal(result.afterSubPath.href, result.document, 'the window stayed on its own document')
  assert.deepEqual(result.afterExternal.opened, [result.subPath, result.external], 'an external page goes to the system browser')
  assert.equal(result.afterExternal.requests, 2, 'an external page does not navigate the window')
  assert.equal(result.afterExternal.href, result.document, 'the window stayed on its own document')
  console.log('PASS: our own document reloads (announced dev URL without a trailing slash) while sub-paths, other ports and external pages go to the system browser')
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) }) }
  await rm(temporary, { recursive: true, force: true })
}
