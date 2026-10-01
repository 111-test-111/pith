import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const STANDARD_LAYERS = ['contract', 'integration', 'ui', 'native']
const LAYERS = [...STANDARD_LAYERS, 'performance', 'live']
const GROUPS = { core: ['contract', 'integration'], ui: ['ui'], native: ['native'], performance: ['performance'], live: ['live'], all: STANDARD_LAYERS }
const SKIP = /^\s*(?:\[SKIP\]|SKIP(?:\s|:|$)|(?:ok\b|[-﹣]\s).*# SKIP\b)/i
const PASS = /^\s*(?:\[PASS\]|PASS\b|✔\s|ok\s+\d+\s*-|[^\n]*\ball assertions passed\b)/i
const FAILURE_STATUSES = new Set(['fail', 'timeout', 'interrupted'])
const MAX_TAIL = 8_192
const OPTIONAL_LIVE_ENV = new Set(['PI_FFF_EXTENSION_PATH', 'TERMINAL_CLAUDE_BIN', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'GOOGLE_APPLICATION_CREDENTIALS'])
const ISOLATED_ENV = new Set(['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA'])
const execFileAsync = promisify(execFile)

export function parseArgs(args) {
  const options = { group: 'all', suiteIds: [], list: false, prepare: true, strictSkips: false, reportDir: '.test-results', help: false, explicitSelection: false }
  let explicitGroup = false
  for (let i = 0; i < args.length; i++) {
    const [key, ...inline] = args[i].split('=')
    const value = () => {
      const result = inline.length ? inline.join('=') : args[++i]
      if (!result || result.startsWith('--')) throw new Error(`${key} needs a value`)
      return result
    }
    switch (key) {
      case '--group':
        if (explicitGroup) throw new Error('Use one --group, or select individual --suite IDs')
        options.group = value()
        options.explicitSelection = true
        explicitGroup = true
        if (!Object.hasOwn(GROUPS, options.group)) throw new Error(`Unknown group: ${options.group}`)
        break
      case '--suite': options.suiteIds.push(...value().split(',').map(id => id.trim()).filter(Boolean)); options.explicitSelection = true; break
      case '--report-dir': options.reportDir = value(); break
      case '--list': options.list = true; break
      case '--no-prepare': options.prepare = false; break
      case '--strict-skips': options.strictSkips = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new Error(`Unknown argument: ${args[i]}`)
    }
    if (inline.length && !['--group', '--suite', '--report-dir'].includes(key)) throw new Error(`${key} does not accept a value`)
  }
  if (explicitGroup && options.suiteIds.length) throw new Error('Choose --group or --suite, not both')
  if (options.suiteIds.length === 0 && args.some(arg => arg === '--suite' || arg.startsWith('--suite='))) throw new Error('--suite needs at least one ID')
  return options
}

export function selectSuites(suites, options) {
  let selected
  if (options.suiteIds.length) {
    const ids = new Set(options.suiteIds)
    for (const id of ids) if (!suites.some(suite => suite.id === id)) throw new Error(`Unknown suite: ${id}`)
    selected = suites.filter(suite => ids.has(suite.id))
  } else selected = suites.filter(suite => GROUPS[options.group].includes(suite.layer))
  if (selected.length === 0) throw new Error('Selection contains no suites')
  const isolated = selected.filter(suite => suite.layer === 'performance' || suite.layer === 'live')
  if (!options.list && isolated.length && selected.some(suite => suite.layer !== isolated[0].layer)) throw new Error('Performance and live suites must run separately from other layers')
  return selected
}

export async function validateManifest(suites, repoRoot = REPO_ROOT) {
  if (!Array.isArray(suites) || suites.length === 0) throw new Error('Test manifest must contain suites')
  const ids = new Set(), files = new Set()
  const scriptRoot = await realpath(join(repoRoot, 'scripts'))
  for (const suite of suites) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(suite.id ?? '')) throw new Error(`Invalid suite ID: ${suite.id}`)
    if (ids.has(suite.id)) throw new Error(`Duplicate suite ID: ${suite.id}`)
    ids.add(suite.id)
    if (!LAYERS.includes(suite.layer)) throw new Error(`Invalid layer for ${suite.id}: ${suite.layer}`)
    if (!suite.area?.trim() || !suite.description?.trim()) throw new Error(`Missing area/description: ${suite.id}`)
    if (!Number.isSafeInteger(suite.timeoutMs) || suite.timeoutMs <= 0) throw new Error(`Invalid timeout: ${suite.id}`)
    if (suite.requiresBuild !== undefined && typeof suite.requiresBuild !== 'boolean') throw new Error(`Invalid requiresBuild: ${suite.id}`)
    if (suite.nodeArgs !== undefined && (!Array.isArray(suite.nodeArgs) || suite.nodeArgs.some(arg => typeof arg !== 'string'))) throw new Error(`Invalid nodeArgs: ${suite.id}`)
    if (suite.platforms !== undefined && (!Array.isArray(suite.platforms) || !suite.platforms.length || suite.platforms.some(platform => !['darwin', 'linux', 'win32'].includes(platform)))) throw new Error(`Invalid platforms: ${suite.id}`)
    if (typeof suite.file !== 'string' || isAbsolute(suite.file) || !suite.file.startsWith('scripts/') || suite.file.split('/').includes('..') || !suite.file.endsWith('.mjs')) throw new Error(`Invalid suite file: ${suite.id}`)
    if (files.has(suite.file)) throw new Error(`Duplicate suite file: ${suite.file}`)
    files.add(suite.file)
    let path
    try { path = await realpath(join(repoRoot, suite.file)) } catch { throw new Error(`Missing suite file: ${suite.file}`) }
    const local = relative(scriptRoot, path)
    if (local.startsWith('..') || isAbsolute(local) || !(await stat(path)).isFile()) throw new Error(`Suite file is outside scripts or not a file: ${suite.file}`)
    for (const prerequisite of suite.prerequisites ?? []) {
      if (!prerequisite.command || typeof prerequisite.command !== 'string' || !prerequisite.description || (prerequisite.args !== undefined && (!Array.isArray(prerequisite.args) || prerequisite.args.some(arg => typeof arg !== 'string')))) throw new Error(`Invalid prerequisite: ${suite.id}`)
    }
  }
  const discovered = (await readdir(scriptRoot)).filter(file => /^check-.*\.mjs$/.test(file)).map(file => `scripts/${file}`)
  const unregistered = discovered.filter(file => !files.has(file))
  if (unregistered.length) throw new Error(`Unregistered check suites: ${unregistered.join(', ')}`)
}

// Production tasks/adapters may start new process groups. Track PID/PPID plus
// process start identity while the suite runs, before its parent can disappear.
function processTreeOwner(child, cleanupGraceMs, ownerToken) {
  const owned = new Map()
  let latest = new Map(), pending, stopped = false
  const capture = () => {
    if (process.platform === 'win32' || !child.pid) return Promise.resolve()
    if (pending) return pending
    // Environment is inspected in memory only. The inherited token also finds
    // a detached child whose parent exits before the first PPID snapshot.
    pending = execFileAsync('ps', ['eww', '-axo', 'pid=,ppid=,pgid=,lstart=,command='], { timeout: 1_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).then(({ stdout }) => {
      const snapshot = new Map()
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d+)\s+(.*)$/.exec(line)
        if (match) snapshot.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4], tagged: match[5].split(/\s+/).includes(`PITH_TEST_OWNER=${ownerToken}`) })
      }
      const reachable = new Set([child.pid])
      for (const process of snapshot.values()) if (process.tagged) reachable.add(process.pid)
      for (const [pid, identity] of owned) if (snapshot.get(pid)?.started === identity.started) reachable.add(pid)
      let changed = true
      while (changed) {
        changed = false
        for (const process of snapshot.values()) if (reachable.has(process.parent) && !reachable.has(process.pid)) { reachable.add(process.pid); changed = true }
      }
      latest = new Map()
      for (const pid of reachable) {
        const process = snapshot.get(pid)
        if (!process || owned.has(pid) && owned.get(pid).started !== process.started) continue
        owned.set(pid, process)
        latest.set(pid, process)
      }
    }).finally(() => { pending = undefined })
    return pending
  }
  const poll = process.platform === 'win32' ? undefined : setInterval(() => { if (!stopped) capture().catch(() => {}) }, 250)
  if (child.pid) capture().catch(() => {})
  const signalPosix = signal => {
    const groups = new Set([child.pid])
    for (const process of latest.values()) if (owned.has(process.group)) groups.add(process.group)
    for (const group of groups) { try { process.kill(-group, signal) } catch {} }
    for (const pid of latest.keys()) { try { process.kill(pid, signal) } catch {} }
  }
  const killWindows = () => new Promise(resolveKill => {
    if (!child.pid) { resolveKill(); return }
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { try { killer.kill() } catch {}; resolveKill() }, 2_000)
    const finish = () => { clearTimeout(timer); resolveKill() }
    killer.once('error', () => { try { child.kill() } catch {}; finish() })
    killer.once('close', finish)
  })
  return {
    async cleanup() {
      stopped = true; clearInterval(poll)
      if (process.platform === 'win32') { await killWindows(); return }
      await capture()
      signalPosix('SIGTERM')
      await delay(cleanupGraceMs)
      await capture()
      signalPosix('SIGKILL')
    },
    force() { stopped = true; clearInterval(poll); if (process.platform === 'win32') return killWindows(); signalPosix('SIGKILL') },
    stop() { stopped = true; clearInterval(poll) }
  }
}

export async function runCommand({ command, args = [], cwd, env = process.env, timeoutMs = 60_000, stdoutPath, stderrPath, signal, onLine = () => {}, cleanupGraceMs = 250 }) {
  const started = Date.now()
  const streams = []
  let logError
  const makeLog = path => {
    if (!path) return undefined
    const stream = createWriteStream(path, { flags: 'wx' })
    stream.on('error', error => { logError ??= error.message })
    streams.push(stream)
    return stream
  }
  const stdoutLog = makeLog(stdoutPath), stderrLog = makeLog(stderrPath)
  let child, owner, timer, fallbackTimer, cleanupPromise, cleanupError, terminationReason, exitCode = null, exitSignal = null, spawnError
  let outputTail = '', passCount = 0, skipCount = 0
  const skips = []
  const readers = []
  const observe = (source, log, channel) => {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const line = value => {
      const skipped = SKIP.test(value)
      if (skipped) { skipCount++; if (skips.length < 100) skips.push(value.trim()) }
      if (!skipped && PASS.test(value)) passCount++
      onLine(value, channel)
    }
    const consume = text => {
      outputTail = (outputTail + text).slice(-MAX_TAIL)
      pending += text
      let end
      while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1) }
      // A pathological single output line must not accumulate in runner memory.
      if (pending.length > MAX_TAIL) { line(pending.slice(0, MAX_TAIL)); pending = pending.slice(MAX_TAIL) }
    }
    source.on('data', chunk => {
      if (log && !log.destroyed && !log.write(chunk)) { source.pause(); log.once('drain', () => source.resume()) }
      consume(decoder.write(chunk))
    })
    log?.on('error', () => source.resume())
    source.on('end', () => { consume(decoder.end()); if (pending) { line(pending); pending = '' } })
    readers.push(source)
  }
  let finish
  const closed = new Promise(resolveClose => { finish = resolveClose })
  const cleanTree = () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = owner.cleanup().catch(async error => { cleanupError = error.message; await owner.force() })
    fallbackTimer = setTimeout(async () => { await owner.force(); readers.forEach(reader => reader.destroy()); finish() }, cleanupGraceMs + 3_000)
    return cleanupPromise
  }
  const stop = reason => { if (!terminationReason) terminationReason = reason; if (child) cleanTree() }
  const abort = () => stop('interrupted')
  try {
    if (signal?.aborted) terminationReason = 'interrupted'
    else {
      const ownerToken = randomUUID()
      child = spawn(command, args, { cwd, env: { ...env, PITH_TEST_OWNER: ownerToken }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      owner = processTreeOwner(child, cleanupGraceMs, ownerToken)
      observe(child.stdout, stdoutLog, 'stdout'); observe(child.stderr, stderrLog, 'stderr')
      child.once('error', error => { spawnError = error.message; finish() })
      child.once('exit', (code, receivedSignal) => { exitCode = code; exitSignal = receivedSignal; cleanTree() })
      child.once('close', finish)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => stop('timeout'), timeoutMs)
      await closed
      await cleanTree()
    }
  } finally {
    clearTimeout(timer); clearTimeout(fallbackTimer); owner?.stop()
    signal?.removeEventListener('abort', abort)
    await Promise.all(streams.map(stream => new Promise(resolveLog => {
      if (stream.destroyed) resolveLog()
      else { stream.once('close', resolveLog); stream.end() }
    })))
  }
  const status = terminationReason ?? (spawnError || logError || cleanupError || exitCode !== 0 ? 'fail' : skipCount ? passCount ? 'partial' : 'skip' : 'pass')
  const reason = spawnError ?? (logError ? `Unable to write logs: ${logError}` : cleanupError ? `Unable to inspect subprocess tree: ${cleanupError}` : terminationReason === 'timeout' ? `Exceeded ${timeoutMs}ms wall-clock limit` : terminationReason === 'interrupted' ? 'Run interrupted' : undefined)
  return { status, exitCode, signal: exitSignal, durationMs: Date.now() - started, passCount, skipCount, skips, outputTail, ...(reason ? { reason } : {}) }
}

export async function createSuiteEnvironment(suite, inherited = process.env) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pith-test-'))
  const env = { ...inherited }
  if (suite.layer !== 'live') {
    for (const key of Object.keys(env)) {
      const normalized = key.toUpperCase()
      if (/(?:API_KEY|TOKEN)$/.test(normalized) || /^PI_JEV_LIVE_/.test(normalized) || OPTIONAL_LIVE_ENV.has(normalized) || ISOLATED_ENV.has(normalized)) delete env[key]
    }
    const home = join(temporaryRoot, 'home'), config = join(temporaryRoot, 'config'), cache = join(temporaryRoot, 'cache'), data = join(temporaryRoot, 'data'), temporary = join(temporaryRoot, 'tmp'), agent = join(temporaryRoot, 'agent'), roaming = join(data, 'roaming'), local = join(data, 'local')
    await Promise.all([home, config, cache, data, temporary, agent, roaming, local].map(path => mkdir(path, { recursive: true })))
    Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, TMPDIR: temporary, TMP: temporary, TEMP: temporary, APPDATA: roaming, LOCALAPPDATA: local })
    if (suite.layer === 'native') {
      const originalAgent = inherited.PI_CODING_AGENT_DIR ?? (inherited.HOME || inherited.USERPROFILE ? join(inherited.HOME ?? inherited.USERPROFILE, '.pi', 'agent') : undefined)
      if (originalAgent) {
        const adapters = join(originalAgent, 'debug-adapters')
        try {
          if ((await stat(adapters)).isDirectory()) {
            await symlink(adapters, join(agent, 'debug-adapters'), process.platform === 'win32' ? 'junction' : 'dir')
            const pythonBin = join(adapters, 'debugpy', process.platform === 'win32' ? 'Scripts' : 'bin')
            const python = join(pythonBin, process.platform === 'win32' ? 'python.exe' : 'python3')
            if ((await stat(python)).isFile()) {
              // Windows environment lookup ignores case. Keep one PATH entry
              // so differently cased inherited keys cannot hide this adapter.
              const pathKeys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort()
              const inheritedPath = env[pathKeys[0]] ?? ''
              for (const key of pathKeys) delete env[key]
              env.PATH = [pythonBin, inheritedPath].filter(Boolean).join(delimiter)
            }
          }
        }
        catch (error) { if (error.code !== 'ENOENT') { await rm(temporaryRoot, { recursive: true, force: true }); throw error } }
      }
    }
  }
  return { env, temporaryRoot }
}

function incomplete(result) { return result.status === 'skip' || result.status === 'partial' }
export function exitCodeFor(results, strictSkips = false) { return results.some(result => FAILURE_STATUSES.has(result.status) || strictSkips && incomplete(result)) ? 1 : 0 }

export async function runSuite(suite, { repoRoot = REPO_ROOT, runDir, signal, env = process.env, platform = process.platform, onLine } = {}) {
  const base = { id: suite.id, file: suite.file, layer: suite.layer, area: suite.area, description: suite.description, timeoutMs: suite.timeoutMs }
  if (signal?.aborted) return { ...base, status: 'interrupted', durationMs: 0, reason: 'Run interrupted before suite started', passCount: 0, skipCount: 0, skips: [] }
  if (suite.platforms && !suite.platforms.includes(platform)) return { ...base, status: 'skip', durationMs: 0, reason: `Requires ${suite.platforms.join('/')}; current platform is ${platform}`, passCount: 0, skipCount: 1, skips: [] }
  const { env: isolatedEnv, temporaryRoot } = await createSuiteEnvironment(suite, env)
  try {
    for (const [index, prerequisite] of (suite.prerequisites ?? []).entries()) {
      const probe = await runCommand({ command: prerequisite.command, args: prerequisite.args ?? [], cwd: repoRoot, env: isolatedEnv, timeoutMs: prerequisite.timeoutMs ?? 10_000, signal, stdoutPath: join(runDir, `${suite.id}.prerequisite-${index}.stdout.log`), stderrPath: join(runDir, `${suite.id}.prerequisite-${index}.stderr.log`) })
      if (probe.status !== 'pass') return { ...base, ...probe, status: probe.status === 'interrupted' ? 'interrupted' : 'skip', reason: `Missing prerequisite: ${prerequisite.description}`, skipCount: 1 }
    }
    const logs = { stdout: `${suite.id}.stdout.log`, stderr: `${suite.id}.stderr.log` }
    const result = await runCommand({ command: process.execPath, args: [...(suite.nodeArgs ?? []), join(repoRoot, suite.file)], cwd: repoRoot, env: isolatedEnv, timeoutMs: suite.timeoutMs, signal, stdoutPath: join(runDir, logs.stdout), stderrPath: join(runDir, logs.stderr), onLine })
    return { ...base, ...result, logs }
  } finally {
    // Only this runner-created temporary tree is removed; reports are retained.
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export function summarize(results) {
  const totals = { total: results.length, pass: 0, partial: 0, skip: 0, fail: 0, timeout: 0, interrupted: 0 }
  for (const result of results) totals[result.status]++
  return totals
}

export function xmlEscape(value) { return String(value ?? '').replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function junitReport(report) {
  const results = [...report.preparation, ...report.results]
  const failures = results.filter(result => FAILURE_STATUSES.has(result.status) || report.strictSkips && incomplete(result)).length
  const skipped = report.strictSkips ? 0 : results.filter(incomplete).length
  const cases = results.map(result => {
    const reason = result.reason ?? result.skips?.join('\n') ?? result.status
    const detail = `${reason}\n${result.outputTail ?? ''}`
    let outcome = ''
    if (FAILURE_STATUSES.has(result.status) || report.strictSkips && incomplete(result)) outcome = `<failure type="${xmlEscape(result.status)}" message="${xmlEscape(reason)}">${xmlEscape(detail)}</failure>`
    else if (incomplete(result)) outcome = `<skipped message="${xmlEscape(reason)}"/>`
    const properties = `<properties><property name="status" value="${xmlEscape(result.status)}"/><property name="passCount" value="${result.passCount ?? 0}"/><property name="skipCount" value="${result.skipCount ?? 0}"/></properties>`
    return `    <testcase classname="${xmlEscape(result.layer ?? 'preparation')}.${xmlEscape(result.area ?? 'build')}" name="${xmlEscape(result.id)}" time="${(result.durationMs / 1000).toFixed(3)}">${properties}${outcome}</testcase>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="pith" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}" timestamp="${xmlEscape(report.startedAt)}">\n${cases}\n</testsuite></testsuites>\n`
}

export async function writeReports(runDir, report) {
  await Promise.all([writeFile(join(runDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }), writeFile(join(runDir, 'junit.xml'), junitReport(report), { flag: 'wx' })])
}

export async function runTests({ suites, options, repoRoot = REPO_ROOT, signal, env = process.env, output = console.log }) {
  const selected = selectSuites(suites, options)
  const started = Date.now(), startedAt = new Date(started).toISOString()
  const reportRoot = resolve(repoRoot, options.reportDir)
  await mkdir(reportRoot, { recursive: true })
  const runDir = await mkdtemp(join(reportRoot, 'run-'))
  const results = [], preparation = []
  let passLines = 0
  const progress = line => { if (SKIP.test(line) || PASS.test(line) && passLines++ < 3) output(`  ${line.slice(0, 220)}`) }
  let preparationPassed = true
  if (!options.prepare && selected.some(suite => suite.requiresBuild)) {
    const required = ['out/main/index.mjs', 'out/preload/index.mjs', 'out/renderer/index.html']
    const checks = await Promise.allSettled(required.map(async file => { if (!(await stat(join(repoRoot, file))).isFile()) throw new Error('Not a file') }))
    const missing = required.filter((file, index) => checks[index].status === 'rejected')
    const reason = missing.length ? `Built app is missing: ${missing.join(', ')}. Run npm run typecheck && npm run build before --no-prepare.` : undefined
    const result = { id: 'prepare-built-output', status: reason ? 'fail' : 'pass', durationMs: 0, exitCode: reason ? 1 : 0, passCount: reason ? 0 : 1, skipCount: 0, skips: [], ...(reason ? { reason } : {}) }
    preparation.push(result)
    await Promise.all([writeFile(join(runDir, 'prepare-built-output.stdout.log'), reason ? '' : 'Built application entry points exist.\n', { flag: 'wx' }), writeFile(join(runDir, 'prepare-built-output.stderr.log'), reason ? `${reason}\n` : '', { flag: 'wx' })])
    if (reason) { preparationPassed = false; output(`[fail] ${reason}`) }
  }
  if (options.prepare) {
    const scripts = ['typecheck', ...(selected.some(suite => suite.requiresBuild || ['ui', 'native', 'live', 'performance'].includes(suite.layer)) ? ['build'] : [])]
    for (const script of scripts) {
      output(`[prepare] npm run ${script}`)
      passLines = 0
      const command = env.npm_execpath ? process.execPath : process.platform === 'win32' ? env.ComSpec ?? 'cmd.exe' : 'npm'
      const args = env.npm_execpath ? [env.npm_execpath, 'run', script] : process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script]
      const result = { id: `prepare-${script}`, ...await runCommand({ command, args, cwd: repoRoot, env, timeoutMs: 300_000, signal, stdoutPath: join(runDir, `prepare-${script}.stdout.log`), stderrPath: join(runDir, `prepare-${script}.stderr.log`), onLine: progress }) }
      preparation.push(result)
      if (result.status !== 'pass') { preparationPassed = false; output(`[${result.status}] preparation ${script}\n${result.reason ?? result.outputTail}`); break }
    }
  }
  if (preparationPassed) {
    for (const [index, suite] of selected.entries()) {
      if (signal?.aborted) break
      output(`[${index + 1}/${selected.length}] ${suite.id} (${suite.layer})`)
      passLines = 0
      let result
      try { result = await runSuite(suite, { repoRoot, runDir, signal, env, onLine: progress }) }
      catch (error) { result = { id: suite.id, file: suite.file, layer: suite.layer, area: suite.area, status: 'fail', durationMs: 0, reason: error.message, passCount: 0, skipCount: 0, skips: [] } }
      results.push(result)
      output(`[${result.status}] ${suite.id} ${(result.durationMs / 1000).toFixed(1)}s${result.reason ? ` — ${result.reason}` : ''}`)
      if (FAILURE_STATUSES.has(result.status) && result.outputTail) output(result.outputTail)
    }
  }
  const ran = new Set(results.map(result => result.id))
  for (const suite of selected) {
    if (!ran.has(suite.id)) results.push({ id: suite.id, file: suite.file, layer: suite.layer, area: suite.area, status: signal?.aborted ? 'interrupted' : 'skip', durationMs: 0, reason: signal?.aborted ? 'Run interrupted before suite started' : 'Preparation failed; suite did not run', passCount: 0, skipCount: signal?.aborted ? 0 : 1, skips: [] })
  }
  const coverage = { byArea: {}, byLayer: {} }
  for (const dimension of ['area', 'layer']) {
    for (const value of new Set(results.map(result => result[dimension]))) coverage[dimension === 'area' ? 'byArea' : 'byLayer'][value] = summarize(results.filter(result => result[dimension] === value))
  }
  const report = { schemaVersion: 1, platform: process.platform, nodeVersion: process.version, startedAt, durationMs: Date.now() - started, strictSkips: options.strictSkips, catalogCount: suites.length, excluded: suites.filter(suite => !selected.includes(suite)).map(suite => suite.id), selection: selected.map(suite => suite.id), preparation, results, totals: summarize(results), coverage }
  await writeReports(runDir, report)
  output(`Results: ${Object.entries(report.totals).map(([key, count]) => `${key}=${count}`).join(' ')}\nReports: ${runDir}`)
  return { report, runDir, exitCode: exitCodeFor([...preparation, ...results], options.strictSkips) }
}

const HELP = `Usage: npm test -- [options]\n\n  --group core|ui|native|all  Standard suites (default: all)\n  --group performance|live  Explicit, separate performance/provider runs\n  --suite id[,id]           Select registered suites; may repeat\n  --list                   List selected suites without running\n  --no-prepare             Skip typecheck/build after verifying them separately\n  --strict-skips           Fail when any suite skips all or part of its checks\n  --report-dir path        Retain logs, JSON and JUnit (default: .test-results)\n  --help                   Show this help\n\nSuites run serially. Default/all exclude performance and live provider calls.\n`

export async function main({ suites, args = process.argv.slice(2), repoRoot = REPO_ROOT, output = console.log, error = console.error }) {
  const controller = new AbortController()
  let receivedSignal
  const interrupt = signal => { receivedSignal ??= signal; controller.abort(signal) }
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    const options = parseArgs(args)
    if (options.help) { output(HELP); return 0 }
    await validateManifest(suites, repoRoot)
    const selected = options.list && !options.explicitSelection ? suites : selectSuites(suites, options)
    if (options.list) { for (const suite of selected) output(`${suite.id}\t${suite.layer}\t${suite.area}\t${suite.timeoutMs}ms\tbuild=${Boolean(suite.requiresBuild || ['ui', 'native', 'live', 'performance'].includes(suite.layer))}\t${suite.platforms?.join('/') ?? 'all platforms'}\t${suite.description}`); return 0 }
    const result = await runTests({ suites, options, repoRoot, signal: controller.signal, output })
    return receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : result.exitCode
  } catch (cause) { error(`Test runner: ${cause.message}`); return receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1 }
  finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm) }
}
