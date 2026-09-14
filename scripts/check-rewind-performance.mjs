/** Reproducible large Git corpus; reports real work instead of a mocked timer. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const temporary = await mkdtemp(join(tmpdir(), 'pith-rewind-perf-'))
const count = Number(process.env.PI_REWIND_PERF_FILES ?? 10000)
const measurements = {}
const timed = async (label, work) => { const start = performance.now(); const result = await work(); measurements[label] = Math.round(performance.now() - start); return result }
try {
  const root = join(temporary, 'project'), data = join(temporary, 'data')
  await mkdir(root)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false')
  for (let folder = 0; folder < Math.ceil(count / 100); folder++) {
    const directory = join(root, String(folder)); await mkdir(directory)
    await Promise.all(Array.from({ length: Math.min(100, count - folder * 100) }, (_, file) => writeFile(join(directory, `${file}.txt`), `File ${folder * 100 + file}\r\n` + 'code content '.repeat(80))))
  }
  git('add', '.'); git('commit', '-m', 'fixture')
  const outfile = join(temporary, 'engine.mjs')
  await build({ entryPoints: [resolve('src/main/rewind/engine.ts')], outfile, platform: 'node', format: 'esm', bundle: true })
  const { RewindEngine } = await import(pathToFileURL(outfile))
  const engine = new RewindEngine(data)
  const checkpoint = entryId => engine.checkpoint(root, { sessionId: 'performance', trigger: 'before-turn', entryId })
  const first = await timed('coldCheckpointMs', () => checkpoint('first'))
  await timed('warmCheckpointMs', () => checkpoint('second'))
  for (let i = 0; i < 8; i++) await checkpoint(`entry-${i}`)
  const warmStart = performance.now()
  for (let i = 0; i < 10; i++) await engine.list(root, 'performance')
  measurements.listAverageMs = Math.round((performance.now() - warmStart) / 10)
  await writeFile(join(root, '0/0.txt'), 'changed\r\n')
  const preview = await timed('oneFilePreviewMs', () => engine.preview(root, 'performance', first.id))
  assert.equal(preview.changes.filter(change => change.area === 'worktree').length, 1)
  await timed('oneFileStatsMs', () => engine.stats(root, 'performance', preview.token, '0/0.txt', 'worktree'))
  await timed('oneFilePatchMs', () => engine.patch(root, 'performance', preview.token, '0/0.txt', 'worktree'))
  const reopened = new RewindEngine(data)
  await timed('reopenedListMs', () => reopened.list(root, 'performance'))
  const reopenedPreview = await timed('reopenedPreviewMs', () => reopened.preview(root, 'performance', first.id))
  await timed('reopenedPatchMs', () => reopened.patch(root, 'performance', reopenedPreview.token, '0/0.txt', 'worktree'))
  const subset = await timed('singleFilePreviewMs', () => engine.previewFile(root, 'performance', preview.token, '0/0.txt'))
  await timed('oneFileRestoreMs', async () => {
    const op = await engine.prepare(root, 'performance', subset.token, 'files', randomUUID(), 'latest', 'latest')
    await engine.finish(root, 'performance', op.id, true)
  })
  const list = await engine.list(root, 'performance')
  const directory = (await engine.directory(root)).dir
  const transactionSize = (await stat(join(directory, 'transactions', `${list.operations[0].id}.json`))).size
  assert(transactionSize < count * 1500, 'transaction storage scales with index and changed paths')
  const usage = await timed('maintenanceMs', () => engine.maintenance())
  const objectCount = (await Promise.all((await readdir(join(data, 'objects'))).filter(name => /^[a-f0-9]{2}$/.test(name)).map(prefix => readdir(join(data, 'objects', prefix))))).reduce((sum, files) => sum + files.length, 0)
  assert(objectCount < count + 20, 'unchanged checkpoints share raw blobs')
  console.log(JSON.stringify({ files: count, checkpoints: list.checkpoints.length, objectCount, bytes: usage.bytes, transactionSize, ...measurements }, null, 2))
  if (process.env.PI_REWIND_PERF_OUTPUT) await writeFile(process.env.PI_REWIND_PERF_OUTPUT, JSON.stringify({ files: count, checkpoints: list.checkpoints.length, objectCount, bytes: usage.bytes, transactionSize, ...measurements }, null, 2))
} finally { await rm(temporary, { recursive: true, force: true }) }
