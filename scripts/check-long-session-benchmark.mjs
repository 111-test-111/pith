/** Offline checks for the benchmark's reporting/gating policy, not app mocks. */
import assert from 'node:assert/strict'
import { aggregate, compareReports } from './lib/long-session/report.mjs'

const samples = [30, 10, 20].map(value => ({ node: { metrics: { loadMs: value } }, renderer: { metrics: { renderMs: value * 2 } } }))
const measured = aggregate(samples)
assert.deepEqual(measured['node.loadMs'], { unit: 'ms', samples: [30, 10, 20], min: 10, median: 20, p95: 30, max: 30 })
assert.equal(aggregate(samples.slice(0, 2))['node.loadMs'].median, 20)
assert.throws(() => aggregate([{ node: { metrics: { loadMs: NaN } }, renderer: { metrics: {} } }]))
const base = { schemaVersion: 1, benchmark: 'pith-long-session', workloadVersion: 1, passed: true, failures: [], sdkVersion: 'fixture',
  machine: { platform: 'fixture', arch: 'fixture', osRelease: 'fixture', cpuModel: 'fixture', logicalCpus: 4, totalMemoryBytes: 1000, node: 'fixture' },
  config: { rendererBuild: 'production', reducedMotion: true, appearance: 'square-light', viewport: [1220, 800] },
  cases: [{ turns: 100, complete: true, workload: { sha256: 'fixed' }, samples: [{ renderer: { runtime: { electron: 'fixture', chrome: 'fixture' } } }],
    metrics: { 'node.loadMs': { median: 100 }, 'renderer.renderMs': { median: 0.1 } } }] }
const policy = { maxRegression: 1.5, minDeltaMs: 5, baselinePath: 'fixture.json' }
assert.equal(compareReports(base, base, policy).passed, true)
const fastNoise = structuredClone(base)
fastNoise.cases[0].metrics['renderer.renderMs'].median = 0.3
assert.equal(compareReports(fastNoise, base, policy).passed, true, 'sub-ms metrics need an absolute noise floor')
const regressed = structuredClone(base)
regressed.cases[0].metrics['node.loadMs'].median = 151
assert.equal(compareReports(regressed, base, policy).passed, false, 'same-machine regression fails')
const ratioBoundary = structuredClone(base)
ratioBoundary.cases[0].metrics['node.loadMs'].median = 150
assert.equal(compareReports(ratioBoundary, base, policy).passed, true)
for (const mutate of [report => { report.machine.arch = 'other' }, report => { report.sdkVersion = 'other' },
  report => { report.config.viewport = [800, 600] }, report => { report.cases[0].workload.sha256 = 'other' },
  report => { delete report.cases[0].metrics['node.loadMs'] }, report => { report.cases[0].samples[0].renderer.runtime.chrome = 'other' },
  report => { report.passed = false }, report => { report.cases[0].complete = false }]) {
  const incompatible = structuredClone(base); mutate(incompatible)
  assert.throws(() => compareReports(base, incompatible, policy), 'incompatible baseline must not silently pass')
}
console.log('PASS long-session reporting: raw statistics, ratio/noise gates, malformed/environment/workload/runtime baseline rejection')
