/** Reproducible offline performance samples, without a new test framework. */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpus, totalmem, platform, arch, release } from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { dirname, join, extname, resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { electronSample } from './lib/long-session/electron-sample.mjs'
import { WORKLOAD_VERSION } from './lib/long-session/workload.mjs'
import { aggregate, compareReports } from './lib/long-session/report.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const help = `node scripts/benchmark-long-session.mjs [options]
  --full                    100, 1000 and 10000 turns (default: 100)
  --sizes=100,1000           Select supported scales
  --samples=3               Fresh processes per scale, 1–10 (default: 3)
  --output=report.json       Also save the JSON printed to stdout
  --baseline=baseline.json  Compare same-machine metric medians
  --max-regression=1.5       Maximum ratio (default: 1.5)
  --min-delta-ms=5           Ignore timing deltas below this noise floor
  --timeout-ms=180000        Bound each Node/Electron sample
  --help                    Show usage
Exit: 0 passed; 1 baseline regression; 2 invalid options/baseline;
      3 measurement failure or deterministic bound violation.
`
function options(args) {
  const config = { sizes: [100], samples: 3, maxRegression: 1.5, minDeltaMs: 5, timeoutMs: 180000 }
  for (const arg of args) {
    if (arg === '--help') { process.stdout.write(help); process.exit(0) }
    if (arg === '--full') { config.sizes = [100, 1000, 10000]; continue }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Unknown option: ${arg}`)
    const [, key, value] = match
    if (key === 'sizes') config.sizes = value.split(',').map(Number)
    else if (key === 'samples') config.samples = Number(value)
    else if (key === 'max-regression') config.maxRegression = Number(value)
    else if (key === 'min-delta-ms') config.minDeltaMs = Number(value)
    else if (key === 'timeout-ms') config.timeoutMs = Number(value)
    else if (key === 'output' || key === 'baseline') config[key] = resolve(value)
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!config.sizes.length || config.sizes.some(size => ![100, 1000, 10000].includes(size)) || new Set(config.sizes).size !== config.sizes.length) throw new Error('Sizes must be unique members of 100, 1000, 10000')
  config.sizes.sort((a, b) => a - b)
  if (!Number.isSafeInteger(config.samples) || config.samples < 1 || config.samples > 10) throw new Error('samples must be 1–10')
  if (!Number.isFinite(config.maxRegression) || config.maxRegression <= 1) throw new Error('max-regression must exceed 1')
  if (!Number.isFinite(config.minDeltaMs) || config.minDeltaMs < 0) throw new Error('min-delta-ms must be nonnegative')
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000) throw new Error('timeout-ms must be 1000–600000')
  return config
}
let config
try { config = options(process.argv.slice(2)) }
catch (error) { process.stderr.write(error.message + '\n' + help); process.exit(2) }
const cpu = cpus()
const machine = { platform: platform(), arch: arch(), osRelease: release(), cpuModel: cpu[0]?.model ?? 'unknown',
  logicalCpus: cpu.length, totalMemoryBytes: totalmem(), node: process.version }
const packageInfo = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const sdkInfo = JSON.parse(await readFile(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'))
const revision = () => {
  try { return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) } }
  catch { return { commit: null, dirty: null } }
}
const report = { schemaVersion: 1, benchmark: 'pith-long-session', workloadVersion: WORKLOAD_VERSION,
  startedAt: new Date().toISOString(), appVersion: packageInfo.version, sdkVersion: sdkInfo.version, revision: revision(), machine,
  config: { ...config, rendererBuild: 'production', viewport: [1220, 800], reducedMotion: true,
    appearance: 'square-light',
    coldness: 'Fresh Node/Electron processes and fixture worlds per sample; OS file cache is not cleared. SQLite first import is empty; subsequent page queries are warm.' },
  cases: [], failures: [], comparison: null }
let temp, server, exitCode = 0
function child(file, args, timeoutMs) {
  return new Promise((resolveChild, reject) => {
    const processChild = spawn(process.execPath, ['--expose-gc', file, ...args], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostics = '', timedOut = false
    processChild.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-16000) })
    const timer = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL') }, timeoutMs)
    processChild.once('error', error => { clearTimeout(timer); reject(error) })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveChild()
      else reject(new Error(`${timedOut ? 'Sample timeout' : `Sample exited ${code ?? signal}`}\n${diagnostics}`))
    })
  })
}
async function serve(directory) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
  const http = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const file = resolve(directory, '.' + (path === '/' ? '/index.html' : path))
      const within = relative(directory, file)
      if (within.startsWith('..' + sep) || isAbsolute(within)) { response.writeHead(403).end(); return }
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(await readFile(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise((resolveServer, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolveServer) })
  return { server: http, url: `http://127.0.0.1:${http.address().port}/` }
}
try {
  await stat(join(repo, 'out/preload/index.mjs')).catch(() => { throw new Error('Run npm run build first: built preload is required') })
  // Owned temp root inside this checkout, always removed even after failure.
  temp = await mkdtemp(join(repo, '.long-session-benchmark-'))
  const modulesPath = join(temp, 'modules.mjs')
  await esbuild({ stdin: { resolveDir: repo, contents: `
    export {PiStore} from './src/renderer/src/state/pi-store';
    export {buildTurns,collectChangeScopes} from './src/renderer/src/lib/chat-turns';
    export {TrajectoryClient} from './src/main/pi/trajectory/client';
    export {selectedBranchHasMessages} from './src/main/pi/session-branch';
    export {TRAJECTORY_PAGE_SIZE,TRAJECTORY_CHILDREN_SIZE,TRAJECTORY_TEXT_SIZE} from './src/shared/trajectory';` },
    outfile: modulesPath, bundle: true, format: 'esm', platform: 'node' })
  await esbuild({ entryPoints: [join(repo, 'src/main/pi/trajectory-worker.ts')], outfile: join(temp, 'trajectory-worker.mjs'), bundle: true, format: 'esm', platform: 'node' })
  const rendererRoot = join(temp, 'renderer'), rendererOut = join(temp, 'built-renderer')
  await mkdir(rendererRoot)
  await writeFile(join(rendererRoot, 'index.html'), `<html><body><div id="root"></div><script type="module" src="${join(repo, 'scripts/lib/long-session/renderer.jsx').replaceAll('\\', '/')}"></script></body></html>`)
  await viteBuild({ configFile: false, root: rendererRoot, logLevel: 'error',
    publicDir: join(repo, 'src/renderer/public'), resolve: { alias: { '@': join(repo, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()], build: { outDir: rendererOut, emptyOutDir: true, chunkSizeWarningLimit: 10000 } })
  const serving = await serve(rendererOut); server = serving.server
  for (const turns of config.sizes) {
    const samples = [], partialSamples = []
    for (let sample = 0; sample < config.samples; sample++) {
      process.stderr.write(`Long session: ${turns} turns, sample ${sample + 1}/${config.samples}\n`)
      const directory = join(temp, `${turns}-${sample}`); await mkdir(directory)
      let node
      try {
        await child(join(repo, 'scripts/lib/long-session/node-sample.mjs'), [repo, modulesPath, directory, String(turns)], config.timeoutMs)
        node = JSON.parse(await readFile(join(directory, 'node-result.json'), 'utf8'))
        const renderer = await electronSample({ repo, modulesPath, directory, url: serving.url, turns, workload: node.workload, timeoutMs: config.timeoutMs })
        samples.push({ node, renderer })
      } catch (error) {
        report.failures.push({ turns, sample: sample + 1, stage: node ? 'renderer' : 'node', message: error.message })
        partialSamples.push({ sample: sample + 1, ...(node ? { node } : {}),
          ...(error.measurement ? { renderer: error.measurement } : {}) })
        exitCode = 3; break
      }
    }
    report.cases.push({ turns, complete: samples.length === config.samples,
      workload: samples[0]?.node.workload ?? partialSamples[0]?.node?.workload ?? null,
      samples, partialSamples, metrics: samples.length ? aggregate(samples) : {} })
  }
  if (!exitCode && config.baseline) {
    try {
      report.comparison = compareReports(report, JSON.parse(await readFile(config.baseline, 'utf8')),
        { maxRegression: config.maxRegression, minDeltaMs: config.minDeltaMs, baselinePath: config.baseline })
      if (!report.comparison.passed) exitCode = 1
    } catch (error) { report.failures.push({ stage: 'baseline', message: error.message }); exitCode = 2 }
  }
} catch (error) { report.failures.push({ stage: 'setup', message: error.message }); exitCode = 3 }
finally {
  if (server) await new Promise(resolveServer => server.close(resolveServer))
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
report.finishedAt = new Date().toISOString()
report.passed = exitCode === 0
report.exitCode = exitCode
const json = JSON.stringify(report, null, 2) + '\n'
if (config.output) { await mkdir(dirname(config.output), { recursive: true }); await writeFile(config.output, json) }
process.stdout.write(json)
process.exitCode = exitCode
