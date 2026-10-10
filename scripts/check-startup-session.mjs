/** Startup preference: which session a boot opens.
 *
 * Runs PiManager's real init()/rememberFolder()/setStartupMode() against real
 * SDK session files, with the Electron-side settings and the agent dir kept in
 * a temporary directory (no credentials, extensions or model calls).
 *
 * Run after editing: node scripts/check-startup-session.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-startup-'))
const agentDir = join(temporary, 'agent')
const userData = join(temporary, 'userData')
const project = join(temporary, 'project')
const other = join(temporary, 'other')
mkdirSync(project, { recursive: true })
mkdirSync(other, { recursive: true })
mkdirSync(userData, { recursive: true })
// Session files (and everything else the SDK writes) stay inside the temp dir.
process.env.PI_CODING_AGENT_DIR = agentDir

const settingsFile = () => join(userData, 'app-settings.json')
const readSettings = () => JSON.parse(readFileSync(settingsFile(), 'utf8'))

try {
  const outfile = join(temporary, 'manager.mjs')
  await build({
    stdin: {
      contents: "export { PiManager } from './src/main/pi/manager'; export { loadSettings } from './src/main/settings';",
      resolveDir: resolve('.')
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [{
      name: 'isolated-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
          path: import.meta.resolve('@earendil-works/pi-coding-agent'),
          external: true
        }))
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
        builder.onResolve({ filter: /^playwright-core(\/|$)|^chromium-bidi(\/|$)/ }, args => ({
          path: import.meta.resolve(args.path), external: true
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const app = { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' };
export const shell = {};`
        }))
      }
    }]
  })
  const { PiManager, loadSettings } = await import(pathToFileURL(outfile).href)

  /** A fresh manager, constructed the way the app constructs it (settings
   * read from disk), with the heavy session build replaced by file tracking. */
  const launch = () => {
    const manager = Object.create(PiManager.prototype)
    const settings = loadSettings()
    manager.checkoutCoordinator = { initialize() {}, ready: async () => {}, needsRecovery: () => false }
    manager.navigationEpoch = 0
    manager.folders = settings.folders
    manager.cwd = null
    manager.activeSession = null
    manager.startup = settings.startup
    manager.snapshot = () => ({ active: manager.activeSession.path })
    // Mirrors real buildSession's first job: put the session header on disk.
    manager.buildSession = async (sessionManager) => {
      manager.materializeSession(sessionManager)
      manager.activeSession = { path: sessionManager.getSessionFile(), cwd: sessionManager.getCwd(), session: { sessionManager } }
      return manager.activeSession
    }
    return manager
  }

  /** A real session file in `cwd`, as a materialized launch would leave it. */
  const makeSession = (cwd) => {
    const session = SessionManager.create(cwd)
    const path = session.getSessionFile()
    const manager = launch()
    manager.materializeSession(session)
    assert.ok(existsSync(path), 'materialize writes the session header')
    return path
  }

  // --- resume: the saved session wins over a newer file in the folder -------
  const first = makeSession(project)
  const second = makeSession(project)
  const newest = (await SessionManager.list(project))[0].path
  assert.notEqual(first, second)
  const manager = launch()
  manager.activeSession = { path: first }
  manager.cwd = project
  manager.rememberFolder(project)
  assert.equal(readSettings().startupSession, first, 'activation persists the active session')
  assert.equal(readSettings().cwd, project, 'and the folder it belongs to')

  // A later, unrelated write makes `second` the newest file on disk: the resume
  // preference must still open the session the user was in.
  assert.equal(newest, second, 'the other session is the newest file')
  assert.equal((await launch().init(project)).active, first, 'resume opens the saved session')

  // --- new: always a fresh session -----------------------------------------
  assert.equal(launch().setStartupMode('new'), 'new')
  assert.equal(readSettings().startup, 'new', 'the choice is persisted')
  const fresh = await launch().init(project)
  assert.ok(fresh.active !== first && fresh.active !== second, 'a new session is created')
  assert.ok(existsSync(fresh.active), 'the new session is materialized')

  // Launching again stays deterministic: another brand-new session.
  const again = await launch().init(project)
  assert.ok(again.active !== fresh.active, 'every launch starts a new session')

  // --- resume ignores a session the user deleted --------------------------
  launch().setStartupMode('resume')
  await rm(fresh.active, { force: true })
  const manager2 = launch()
  manager2.activeSession = { path: fresh.active }
  manager2.cwd = project
  manager2.rememberFolder(project)
  const afterDelete = await launch().init(project)
  assert.ok(afterDelete.active !== first && afterDelete.active !== second,
    'a missing saved session starts fresh instead of resurrecting an older one')

  // --- resume falls back when the saved session belongs elsewhere ----------
  const elsewhere = makeSession(other)
  const manager3 = launch()
  manager3.activeSession = { path: elsewhere }
  manager3.cwd = other
  manager3.rememberFolder(other)
  const crossFolder = await launch().init(project)
  assert.notEqual(crossFolder.active, elsewhere, 'a session of another folder is not resumed into this one')
  assert.equal(SessionManager.open(crossFolder.active).getHeader().cwd, project, 'the fallback stays in the requested folder')
  assert.equal(crossFolder.active, (await SessionManager.list(project))[0].path, 'and is that folder\'s newest session')

  // --- settings round-trip / back-compat ----------------------------------
  launch().setStartupMode('resume')
  assert.equal(loadSettings().startup, 'resume')
  assert.throws(() => launch().setStartupMode('sometimes'), /Invalid startup preference/)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(settingsFile(), JSON.stringify({ cwd: project, folders: [project] }))
  assert.equal(loadSettings().startup, 'resume', 'settings written before this preference resume')
  assert.equal(loadSettings().startupSession, null, 'and carry no stale session')

  console.log('PASS: startup preference — resume wins over the newest file, new always starts fresh, missing/foreign sessions fall back deterministically')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
