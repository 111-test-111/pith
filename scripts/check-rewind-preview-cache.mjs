/** Queue admission, immutable stats, memory bounds and StrictMode lifetimes. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const temporary = await mkdtemp(join(tmpdir(), 'pith-rewind-cache-'))
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
try {
  const outfile = join(temporary, 'cache.mjs')
  await build({ entryPoints: [resolve('src/renderer/src/lib/rewind-preview.ts')], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { RewindPatchCache } = await import(pathToFileURL(outfile))
  const patch = { patch: '+content', truncated: false }
  const stats = { added: 1, removed: 2, binary: false }
  const cache = new RewindPatchCache(), order = [], releases = []
  let active = 0, peak = 0
  const blockers = Array.from({ length: 3 }, (_, index) => cache.read('block-'+index, async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => releases.push(resolve)); active--; return patch
  }))
  await tick(); assert.equal(releases.length, 3)
  const totals = cache.readStatsBatch(['totals'], async () => { order.push('totals'); return [stats] })
  const away = cache.read('away', async () => { throw Error('offscreen work reached IPC') }, true, () => false).catch(error => error.code)
  const prefetched = cache.read('next', async () => { order.push('visible'); return patch }, true, () => false)
  const visible = cache.read('next', async () => { throw Error('duplicate read') }, false, () => true)
  const header = cache.readStats('header', async () => { order.push('header'); return stats })
  releases.forEach(resolve => resolve())
  await Promise.all([...blockers, prefetched, visible, header, totals])
  assert.equal(await away, 'cancelled')
  assert.equal(peak, 3); assert.deepEqual(order, ['visible', 'header', 'totals'])
  assert.strictEqual(cache.peek('next'), patch, 'fulfilled bodies are synchronously readable')

  let fetches = 0
  assert.deepEqual(await cache.readStatsBatch(['header','new'], async indices => {
    fetches++; assert.deepEqual(indices,[1]); return [{ added: 30, removed: 40, binary: false }]
  }), [stats,{ added: 30, removed: 40, binary: false }])
  await cache.readStats('new', async () => { throw Error('batch value was not reused') })
  assert.equal(fetches, 1)
  await assert.rejects(cache.readStatsBatch(['failed'], async () => { throw { code: 'storage' } }), error => error.code === 'storage')
  assert.deepEqual(await cache.readStatsBatch(['failed'], async () => [stats]),[stats], 'failed batches remain retryable')

  const unpin = cache.pin('next')
  let notifications = 0
  const unsubscribe = cache.subscribe('first', () => notifications++)
  await cache.read('first', async () => patch)
  for (let index=0; index<80; index++) await cache.read('small-'+index, async () => patch)
  assert(cache.peek('next')); assert.equal(cache.peek('first'),undefined)
  assert.equal(notifications,2,'both fulfillment and eviction notify synchronous snapshots')
  assert(Array.from({length:80},(_,index)=>cache.peek('small-'+index)).filter(Boolean).length<=63)
  for (let index=0; index<10; index++) await cache.read('large-'+index, async () => ({patch:'x'.repeat(1024*1024),truncated:false}))
  assert(Array.from({length:10},(_,index)=>cache.peek('large-'+index)).filter(Boolean).length<=3,'UTF-16 text stays within its byte budget beside a pinned body')
  unpin();unsubscribe()

  const release = cache.retain();release()
  const releaseAgain = cache.retain();await tick()
  await cache.read('strict',async()=>patch)
  releaseAgain();await tick()
  await assert.rejects(cache.read('closed',async()=>patch),error=>error.code==='cancelled')
  console.log('PASS: visible priority, prefetch handoff, offscreen admission, 3-request concurrency, shared exact stats, retry, bounded synchronous cache and StrictMode cleanup')
} finally { await rm(temporary,{recursive:true,force:true}) }
