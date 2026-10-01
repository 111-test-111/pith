import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createSuiteEnvironment, exitCodeFor, junitReport, main, parseArgs, runCommand, runSuite, runTests, selectSuites, validateManifest } from './runner.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pith-runner-fixture-'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'logs'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function descriptor(id, overrides = {}) {
  return { id, file: `scripts/check-${id}.mjs`, layer: 'contract', area: 'fixture', description: `Fixture ${id}`, timeoutMs: 3_000, requiresBuild: false, ...overrides }
}

async function script(root, id, source, overrides) {
  const suite = descriptor(id, overrides)
  await writeFile(join(root, suite.file), source)
  return suite
}

async function execute(root, id, source, options = {}) {
  const suite = await script(root, id, source, options.suite)
  return runSuite(suite, { repoRoot: root, runDir: join(root, 'logs'), ...options })
}

test('selection is explicit, rejects typos, and keeps performance/live outside standard runs', () => {
  const suites = ['contract', 'integration', 'ui', 'native', 'performance', 'live'].map(layer => descriptor(layer, { layer }))
  assert.deepEqual(selectSuites(suites, parseArgs([])).map(suite => suite.layer), ['contract', 'integration', 'ui', 'native'])
  assert.deepEqual(selectSuites(suites, parseArgs(['--group=core'])).map(suite => suite.layer), ['contract', 'integration'])
  assert.deepEqual(selectSuites(suites, parseArgs(['--group', 'live'])).map(suite => suite.layer), ['live'])
  assert.deepEqual(selectSuites(suites, parseArgs(['--suite', 'ui,contract', '--suite=ui'])).map(suite => suite.id), ['contract', 'ui'])
  assert.equal(parseArgs(['--no-prepare', '--strict-skips', '--report-dir', 'a b']).reportDir, 'a b')
  for (const args of [['--bad'], ['--group', 'typo'], ['--suite'], ['--suite=,'], ['--list=true'], ['--group', 'ui', '--suite', 'ui'], ['--group', 'core', '--group', 'ui']]) assert.throws(() => parseArgs(args))
  assert.throws(() => selectSuites(suites, parseArgs(['--suite', 'typo'])), /Unknown suite/)
  assert.throws(() => selectSuites(suites, parseArgs(['--suite', 'ui,performance'])), /separately/)
  assert.throws(() => selectSuites(suites, parseArgs(['--suite', 'performance,live'])), /separately/)
  assert.equal(selectSuites(suites, parseArgs(['--list', '--suite', 'performance,live'])).length, 2)
})

test('manifest rejects duplicate/missing/unregistered files and invalid metadata', async t => {
  const root = await fixture(t)
  const one = await script(root, 'one', '')
  await validateManifest([one], root)
  await assert.rejects(validateManifest([one, one], root), /Duplicate suite ID/)
  await assert.rejects(validateManifest([one, { ...one, id: 'two' }], root), /Duplicate suite file/)
  await assert.rejects(validateManifest([descriptor('missing')], root), /Missing suite file/)
  await script(root, 'two', '')
  await assert.rejects(validateManifest([one], root), /Unregistered.*check-two/)
  await assert.rejects(validateManifest([{ ...one, timeoutMs: 0 }], root), /Invalid timeout/)
  await assert.rejects(validateManifest([{ ...one, file: 'scripts/../outside.mjs' }], root), /Invalid suite file/)
})

test('stdout and stderr logs retain exact bytes; exit failures and spawn failures fail', async t => {
  const root = await fixture(t)
  const result = await execute(root, 'failure', `process.stdout.write('hello 中\\n'); process.stderr.write('error <&"\\n'); process.exitCode = 7`)
  assert.equal(result.status, 'fail')
  assert.equal(result.exitCode, 7)
  assert.equal(await readFile(join(root, 'logs', result.logs.stdout), 'utf8'), 'hello 中\n')
  assert.equal(await readFile(join(root, 'logs', result.logs.stderr), 'utf8'), 'error <&"\n')
  const missing = await runCommand({ command: join(root, 'missing-executable'), cwd: root, timeoutMs: 500 })
  assert.equal(missing.status, 'fail')
  assert.match(missing.reason, /ENOENT/)
})

test('SKIP markers distinguish skipped from partial coverage and strict mode fails both', async t => {
  const root = await fixture(t)
  const skipped = await execute(root, 'skip', `console.log('[SKIP] adapter absent')`)
  const partial = await execute(root, 'partial', `process.stdout.write('PA'); setTimeout(() => { process.stdout.write('SS: contract\\n'); console.error('SKIP: native adapter') }, 10)`)
  const pass = await execute(root, 'pass', `console.log('This skip word is ordinary prose'); console.log('PASS fixture')`)
  const tap = await execute(root, 'tap-skip', `console.log('ok 1 - optional adapter # SKIP')`)
  const tapPartial = await execute(root, 'tap-partial', `console.log('ok 1 - fixture contract'); console.log('ok 2 - optional adapter # SKIP')`)
  const specPartial = await execute(root, 'spec-partial', `console.log('✔ fixture contract (1ms)'); console.log('﹣ optional adapter (0ms) # SKIP')`)
  assert.equal(skipped.status, 'skip')
  assert.equal(partial.status, 'partial')
  assert.equal(partial.passCount, 1)
  assert.equal(partial.skipCount, 1)
  assert.equal(pass.status, 'pass')
  assert.equal(tap.status, 'skip')
  assert.equal(tapPartial.status, 'partial')
  assert.equal(tapPartial.passCount, 1)
  assert.equal(specPartial.status, 'partial')
  assert.equal(specPartial.passCount, 1)
  assert.equal(exitCodeFor([pass, skipped, partial]), 0)
  assert.equal(exitCodeFor([pass, skipped, partial], true), 1)
})

test('list includes the entire catalog without executing performance or live suites', async t => {
  const root = await fixture(t)
  const suites = [await script(root, 'ordinary-list', `throw new Error('must not run')`), await script(root, 'performance-list', `throw new Error('must not run')`, { layer: 'performance' }), await script(root, 'live-list', `throw new Error('must not run')`, { layer: 'live' })]
  const lines = []
  assert.equal(await main({ suites, args: ['--list'], repoRoot: root, output: line => lines.push(line) }), 0)
  assert.equal(lines.length, 3)
  assert.match(lines[2], /live-list\tlive/)
  const filtered = []
  assert.equal(await main({ suites, args: ['--list', '--group', 'core'], repoRoot: root, output: line => filtered.push(line) }), 0)
  assert.equal(filtered.length, 1)
})

test('unsupported platforms and missing prerequisites record skips without running the suite', async t => {
  const root = await fixture(t)
  const suite = await script(root, 'platform', `throw new Error('must not run')`, { platforms: ['darwin'] })
  const skipped = await runSuite(suite, { repoRoot: root, runDir: join(root, 'logs'), platform: 'win32' })
  assert.equal(skipped.status, 'skip')
  assert.match(skipped.reason, /darwin.*win32/)
  const prerequisite = await execute(root, 'prerequisite', `throw new Error('must not run')`, { suite: { prerequisites: [{ command: join(root, 'missing'), description: 'fixture adapter' }] } })
  assert.equal(prerequisite.status, 'skip')
  assert.match(prerequisite.reason, /fixture adapter/)
})

test('ordinary suites isolate user configuration and disable inherited live credentials', async t => {
  const inherited = { PATH: process.env.PATH, HOME: '/real/home', USERPROFILE: '/real/user', PI_CODING_AGENT_DIR: '/real/pi', APPDATA: '/real/roaming', LOCALAPPDATA: '/real/local', AppData: '/real/mixed-roaming', home: '/real/mixed-home', OPENAI_API_KEY: 'secret', OpenAI_Api_Key: 'mixed-secret', COPILOT_GITHUB_TOKEN: 'secret', HF_TOKEN: 'secret', AWS_ACCESS_KEY_ID: 'secret', Aws_Access_Key_Id: 'mixed-secret', PI_JEV_LIVE_KEY_FILE: '/real/key', Pi_Jev_Live_Key_File: '/real/mixed-key', PI_FFF_EXTENSION_PATH: '/real/extension', Pi_Fff_Extension_Path: '/real/mixed-extension', TERMINAL_CLAUDE_BIN: '/real/bin', PI_UI_SCREENSHOT_DIR: '/retained/screenshots' }
  const ordinary = await createSuiteEnvironment(descriptor('ordinary'), inherited)
  const live = await createSuiteEnvironment(descriptor('live', { layer: 'live' }), inherited)
  t.after(() => Promise.all([ordinary.temporaryRoot, live.temporaryRoot].map(path => rm(path, { recursive: true, force: true }))))
  assert.notEqual(ordinary.env.HOME, inherited.HOME)
  assert.notEqual(ordinary.env.PI_CODING_AGENT_DIR, inherited.PI_CODING_AGENT_DIR)
  assert.ok(ordinary.env.APPDATA.startsWith(ordinary.temporaryRoot))
  assert.ok(ordinary.env.LOCALAPPDATA.startsWith(ordinary.temporaryRoot))
  assert.deepEqual(await readdir(ordinary.env.APPDATA), [])
  assert.deepEqual(await readdir(ordinary.env.LOCALAPPDATA), [])
  assert.equal(ordinary.env.AppData, undefined)
  assert.equal(ordinary.env.home, undefined)
  assert.equal(ordinary.env.PATH, inherited.PATH)
  assert.equal(ordinary.env.PI_UI_SCREENSHOT_DIR, inherited.PI_UI_SCREENSHOT_DIR)
  for (const key of ['OPENAI_API_KEY', 'OpenAI_Api_Key', 'COPILOT_GITHUB_TOKEN', 'HF_TOKEN', 'AWS_ACCESS_KEY_ID', 'Aws_Access_Key_Id', 'PI_JEV_LIVE_KEY_FILE', 'Pi_Jev_Live_Key_File', 'PI_FFF_EXTENSION_PATH', 'Pi_Fff_Extension_Path', 'TERMINAL_CLAUDE_BIN']) assert.equal(ordinary.env[key], undefined, key)
  assert.equal(live.env.HOME, inherited.HOME)
  assert.equal(live.env.OPENAI_API_KEY, inherited.OPENAI_API_KEY)
  assert.equal(live.env.OpenAI_Api_Key, inherited.OpenAI_Api_Key)
  assert.equal(live.env.APPDATA, inherited.APPDATA)
})

test('process ownership snapshots force C locale despite the caller locale', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'ps'), '#!/bin/sh\nif [ "$LC_ALL" != "C" ] || [ "$LANG" != "C" ]; then echo "snapshot locale was not normalized" >&2; exit 2; fi\nexec /bin/ps "$@"\n')
  await chmod(join(bin, 'ps'), 0o755)
  const original = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
  try {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    process.env.LC_ALL = 'de_DE.UTF-8'
    process.env.LANG = 'de_DE.UTF-8'
    const result = await execute(root, 'locale', 'console.log("PASS locale-safe cleanup")')
    assert.equal(result.status, 'pass', result.reason)
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('native isolation exposes only installed adapter code, never host auth or sessions', async t => {
  const root = await fixture(t), originalAgent = join(root, 'original-agent')
  await mkdir(join(originalAgent, 'debug-adapters'), { recursive: true })
  await writeFile(join(originalAgent, 'debug-adapters', 'adapter.js'), 'adapter code')
  await writeFile(join(originalAgent, 'auth.json'), 'secret')
  await mkdir(join(originalAgent, 'sessions'))
  const native = await createSuiteEnvironment(descriptor('native', { layer: 'native' }), { PI_CODING_AGENT_DIR: originalAgent, PATH: process.env.PATH })
  t.after(() => rm(native.temporaryRoot, { recursive: true, force: true }))
  assert.deepEqual(await readdir(native.env.PI_CODING_AGENT_DIR), ['debug-adapters'])
  assert.equal(await readFile(join(native.env.PI_CODING_AGENT_DIR, 'debug-adapters', 'adapter.js'), 'utf8'), 'adapter code')
})

test('native suites use an optional installed debugpy environment while ordinary suites retain their PATH', async t => {
  const root = await fixture(t), originalAgent = join(root, 'original-agent'), pythonBin = join(originalAgent, 'debug-adapters', 'debugpy', process.platform === 'win32' ? 'Scripts' : 'bin')
  await mkdir(pythonBin, { recursive: true })
  const inherited = { Path: '/fixture/original-path', PI_CODING_AGENT_DIR: originalAgent }
  const absent = await createSuiteEnvironment(descriptor('native-missing-python', { layer: 'native' }), inherited)
  t.after(() => rm(absent.temporaryRoot, { recursive: true, force: true }))
  assert.equal(absent.env.Path, inherited.Path)
  assert.equal(absent.env.PATH, undefined)
  await writeFile(join(pythonBin, process.platform === 'win32' ? 'python.exe' : 'python3'), 'fixture preinstalled interpreter')
  const native = await createSuiteEnvironment(descriptor('native-python', { layer: 'native' }), inherited)
  const ordinary = await createSuiteEnvironment(descriptor('ordinary-python'), inherited)
  t.after(() => Promise.all([native.temporaryRoot, ordinary.temporaryRoot].map(path => rm(path, { recursive: true, force: true }))))
  assert.deepEqual(native.env.PATH.split(delimiter), [pythonBin, inherited.Path])
  assert.equal(native.env.Path, undefined)
  assert.deepEqual(Object.keys(native.env).filter(key => key.toUpperCase() === 'PATH'), ['PATH'])
  assert.equal(ordinary.env.Path, inherited.Path)
  assert.equal(ordinary.env.PATH, undefined)
  assert.deepEqual(await readdir(ordinary.env.PI_CODING_AGENT_DIR), [])
})

const treeSource = (heartbeat, parentExits = false) => `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`) }], { stdio: 'ignore' });
console.log('PASS ready child=' + child.pid);
process.on('SIGTERM', () => {});
${parentExits ? 'setTimeout(() => process.exit(0), 150)' : 'setInterval(() => {}, 1000)'};
`

const detachedTreeSource = heartbeat => {
  const writer = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`
  const child = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  return `import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }); process.on('SIGTERM', () => {}); console.log('PASS detached ready'); setInterval(() => {}, 1000)`
}

async function stoppedHeartbeat(path) {
  const first = await readFile(path, 'utf8')
  await delay(150)
  assert.equal(await readFile(path, 'utf8'), first, 'descendant must stop writing after process-tree cleanup')
}

test('timeout kills a signal-resistant descendant and remains bounded', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), heartbeat = join(root, 'heartbeat')
  const result = await execute(root, 'timeout', treeSource(heartbeat), { suite: { timeoutMs: 300 } })
  assert.equal(result.status, 'timeout')
  assert.ok(result.durationMs < 3_000)
  await stoppedHeartbeat(heartbeat)
})

test('ordinary parent exit also cleans up surviving descendants', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), heartbeat = join(root, 'heartbeat')
  const result = await execute(root, 'orphan', treeSource(heartbeat, true))
  assert.equal(result.status, 'pass')
  await stoppedHeartbeat(heartbeat)
})

test('timeout cleans detached child and grandchild process groups', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), heartbeat = join(root, 'heartbeat')
  const result = await execute(root, 'detached', detachedTreeSource(heartbeat), { suite: { timeoutMs: 400 } })
  assert.equal(result.status, 'timeout')
  await stoppedHeartbeat(heartbeat)
})

test('immediate parent exit still cleans its reparented detached child', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), heartbeat = join(root, 'heartbeat')
  await writeFile(heartbeat, '')
  const writer = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`
  const source = `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }); child.unref(); console.log('PASS immediate exit'); process.exit(0)`
  const result = await execute(root, 'immediate-orphan', source)
  assert.equal(result.status, 'pass')
  await stoppedHeartbeat(heartbeat)
})

test('SIGINT cancels the suite, kills its descendants, writes reports and returns 130', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), heartbeat = join(root, 'heartbeat')
  const suite = await script(root, 'signal', treeSource(heartbeat))
  const runnerUrl = new URL('./runner.mjs', import.meta.url).href
  const harness = join(root, 'harness.mjs')
  await writeFile(harness, `import { main } from ${JSON.stringify(runnerUrl)}; process.exitCode = await main({ suites: [${JSON.stringify(suite)}], args: ['--no-prepare'], repoRoot: ${JSON.stringify(root)} });`)
  const child = spawn(process.execPath, [harness], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  let output = ''
  const finished = new Promise((resolveFinish, reject) => { child.once('error', reject); child.once('close', code => resolveFinish(code)) })
  const ready = new Promise(resolveReady => child.stdout.on('data', chunk => { output += chunk; if (output.includes('PASS ready')) resolveReady() }))
  child.stderr.on('data', chunk => { output += chunk })
  await Promise.race([ready, delay(2_000).then(() => { throw new Error(`No fixture readiness: ${output}`) })])
  // Let the descendant start its heartbeat before interrupting the runner.
  await delay(80)
  child.kill('SIGINT')
  assert.equal(await finished, 130, output)
  const runs = await readdir(join(root, '.test-results'))
  const report = JSON.parse(await readFile(join(root, '.test-results', runs[0], 'results.json'), 'utf8'))
  assert.equal(report.results[0].status, 'interrupted')
  await stoppedHeartbeat(heartbeat)
})

test('reports retain unique run directories, record every outcome, escape XML and never delete user files', async t => {
  const root = await fixture(t)
  const suites = [await script(root, 'report-pass', `console.log('PASS fixture')`), await script(root, 'report-skip', `console.log('[SKIP] missing <adapter> & "key"')`), await script(root, 'report-fail', `console.error('<failure> & \\"quote\\"'); process.exitCode=1`)]
  const reportRoot = join(root, 'existing reports')
  await mkdir(reportRoot)
  await writeFile(join(reportRoot, 'user-file.txt'), 'retained')
  const options = parseArgs(['--no-prepare', '--report-dir', reportRoot])
  const first = await runTests({ suites, options, repoRoot: root, output: () => {} })
  const second = await runTests({ suites: [suites[0]], options, repoRoot: root, output: () => {} })
  assert.equal(first.exitCode, 1)
  assert.equal(second.exitCode, 0)
  assert.notEqual(first.runDir, second.runDir)
  assert.deepEqual(first.report.totals, { total: 3, pass: 1, partial: 0, skip: 1, fail: 1, timeout: 0, interrupted: 0 })
  assert.equal(await readFile(join(reportRoot, 'user-file.txt'), 'utf8'), 'retained')
  const json = JSON.parse(await readFile(join(first.runDir, 'results.json'), 'utf8'))
  assert.deepEqual(json.selection, suites.map(suite => suite.id))
  assert.equal(json.platform, process.platform)
  assert.equal(json.nodeVersion, process.version)
  assert.equal(json.coverage.byArea.fixture.pass, 1)
  const xml = await readFile(join(first.runDir, 'junit.xml'), 'utf8')
  assert.match(xml, /failures="1" skipped="1"/)
  assert.match(xml, /&lt;adapter&gt; &amp; &quot;key&quot;/)
  assert.doesNotMatch(xml, /<adapter>/)
  const strict = junitReport({ ...first.report, strictSkips: true })
  assert.match(strict, /failures="2" skipped="0"/)
  assert.match(strict, /type="skip"/)
  const partial = junitReport({ startedAt: 'now', durationMs: 1, strictSkips: false, preparation: [], results: [{ id: 'a<&"', status: 'partial', durationMs: 1, passCount: 3, skipCount: 1, reason: 'reason\u0000\ufffe\uffff\ud800<&😀' }] })
  assert.match(partial, /status" value="partial/)
  assert.match(partial, /<skipped/)
  assert.doesNotMatch(partial, /[\u0000\ufffe\uffff\ud800]/)
  assert.match(partial, /😀/)
})

test('failed preparation stops build and suites, persists reports, and fails the run', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { typecheck: 'node -e "process.exit(7)"', build: 'node -e "require(\'node:fs\').writeFileSync(\'built\',\'bad\')"' } }))
  const suite = await script(root, 'must-not-run', `throw new Error('must not run')`, { layer: 'ui' })
  const result = await runTests({ suites: [suite], options: parseArgs([]), repoRoot: root, output: () => {} })
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.preparation.length, 1)
  assert.equal(result.report.preparation[0].exitCode, 7)
  assert.equal(result.report.results[0].status, 'skip')
  assert.match(result.report.results[0].reason, /Preparation failed/)
  assert.ok(!(await readdir(root)).includes('built'))
  assert.ok((await readdir(result.runDir)).includes('results.json'))
})

test('no-prepare verifies required built entry points without rebuilding or running suites', async t => {
  const root = await fixture(t)
  const suite = await script(root, 'built-app', `console.log('PASS built fixture')`, { requiresBuild: true })
  const options = parseArgs(['--no-prepare'])
  const missing = await runTests({ suites: [suite], options, repoRoot: root, output: () => {} })
  assert.equal(missing.exitCode, 1)
  assert.equal(missing.report.preparation[0].status, 'fail')
  assert.match(missing.report.preparation[0].reason, /out\/renderer\/index.html.*npm run typecheck && npm run build/)
  assert.equal(missing.report.results[0].status, 'skip')
  assert.ok(!(await readdir(missing.runDir)).includes('built-app.stdout.log'))
  for (const file of ['main/index.mjs', 'preload/index.mjs', 'renderer/index.html']) {
    await mkdir(join(root, 'out', file.split('/')[0]), { recursive: true })
    await writeFile(join(root, 'out', file), '')
  }
  const prepared = await runTests({ suites: [suite], options, repoRoot: root, output: () => {} })
  assert.equal(prepared.exitCode, 0)
  assert.equal(prepared.report.preparation[0].status, 'pass')
  assert.equal(prepared.report.results[0].status, 'pass')
})
