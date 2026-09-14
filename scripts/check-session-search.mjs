// Deterministic integration/benchmark harness; no SDK sessions or credentials
// are touched. Run: node scripts/check-session-search.mjs (after npm run build).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'pith-search-check-'))
const root = join(temp, 'sessions')
const folder = join(root, 'project')
const databasePath = join(temp, 'index.sqlite')
await mkdir(folder, { recursive: true })
const bundle = join(temp, 'index.mjs')
await build({
  stdin: { contents: `export * from './src/main/pi/session-search-index'; export * from './src/main/pi/session-search-text'`, resolveDir: resolve('.') },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle
})
const { SessionSearchIndex, highlightSearchText, searchTerms } = await import(pathToFileURL(bundle).href)
const header = (id) => ({ type: 'session', version: 3, id, cwd: '/fixture/project', timestamp: '2026-01-01T00:00:00Z' })
const message = (role, text, timestamp = 1000) => ({ type: 'message', timestamp: new Date(timestamp).toISOString(), message: { role, timestamp, content: [{ type: 'text', text }] } })
const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
const create = async (id, entries) => {
  const path = join(folder, `${id}.jsonl`)
  await writeFile(path, lines([header(id), ...entries]))
  return path
}
let index
let worker
try {
  const primary = await create('primary', [
    message('user', 'Original title'),
    { type: 'custom_message', customType: 'bash_task_completion', display: true, content: 'backgroundonlysecret' },
    { type: 'session_info', name: '中文搜索 café ＦＯＯ' },
    message('assistant', 'old history before compaction: yellow submarine'),
    message('toolResult', 'src/foo.ts C++ a*b 100% _underscore_ 单字'),
    { type: 'compaction', summary: 'compactunique summary', firstKeptEntryId: 'unused' },
    { type: 'branch_summary', summary: 'branchunique summary' },
    message('user', 'alpha'), message('assistant', 'beta'),
    message('assistant', 'phraseunique   exact\nphrase'),
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'thinkingunique' },
      { type: 'thinking', redacted: true, thinking: 'redactedsecret' },
      { type: 'toolCall', name: 'write', arguments: { content: 'codeunique\nfunction 中文' } }
    ] } },
    { type: 'message', message: { role: 'bashExecution', command: 'bashunique', output: 'outputunique' } },
    { type: 'custom_message', display: true, content: 'customunique' },
    { type: 'custom_message', display: false, content: 'hiddensecret' },
    { type: 'custom', data: 'metadatasecret' },
    { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'imagesecret', mimeType: 'image/png' }] } }
  ])
  await create('decoy', [message('user', 'Decoy', 5000), message('assistant', 'ab zz bc zz cd cafe f00')])
  await create('exact', [message('user', '中文搜索', 500)])
  await create('unicode', [message('user', 'Unicode'), message('assistant', 'ＡＢＣ Cafe\u0301 ﬁle 👩‍💻 🚀')])
  // A v1 cache contains flattened content with no provenance. Never reuse it.
  const legacy = new DatabaseSync(databasePath)
  legacy.exec("CREATE TABLE documents (legacy TEXT); INSERT INTO documents VALUES ('legacy-pollution'); CREATE VIRTUAL TABLE grams USING fts5(tokens, content='', detail=none); PRAGMA user_version = 1;")
  legacy.close()
  index = await SessionSearchIndex.open(root, databasePath)
  await index.sync()
  const query = (query, offset = 0, sort) => index.search({ query, offset, sort, includeDetails: true })
  const conversationQuery = (query) => index.search({ query })
  assert.equal(conversationQuery('legacy-pollution').total, 0)
  const has = (queryText, expected = 'primary') => assert(query(queryText).hits.some((hit) => hit.id === expected), queryText)
  for (const term of ['中文', '搜', 'src/foo.ts', 'C++', 'a*b', '100%', '_underscore_', 'yellow submarine',
    'compactunique', 'branchunique', 'alpha beta', '"exact phrase"', 'thinkingunique', 'codeunique', 'bashunique', 'outputunique', 'customunique']) has(term)
  for (const term of ['imagesecret', 'hiddensecret', 'redactedsecret', 'metadatasecret', 'abcd', '"alpha beta"']) assert.equal(query(term).total, 0, term)
  assert.equal(conversationQuery('C++').total, 0, 'tool-only content remains opt-in')
  assert.equal(query('中文搜索').hits[0].id, 'primary', 'newest activity precedes exact title match')
  has('foo café', 'primary')
  const mixed = conversationQuery('foo submarine')
  assert.equal(mixed.hits[0].id, 'primary', 'terms may match the title and message together')
  assert(mixed.hits[0].title.ranges.length > 0)
  assert(mixed.hits[0].snippet.text.includes('submarine'))
  has('abc café file 👩‍💻 🚀', 'unicode')
  assert.deepEqual(searchTerms(' Foo "EXACT phrase" 中文 foo'), ['foo', 'exact phrase', '中文'])
  const highlighted = highlightSearchText('ＡＢＣ Cafe\u0301 ﬁle 👩‍💻', ['abc', 'café', 'file', '👩‍💻'])
  assert.deepEqual(highlighted.ranges.map(([a, b]) => highlighted.text.slice(a, b)), ['ＡＢＣ', 'Cafe\u0301', 'ﬁle', '👩‍💻'])
  assert.deepEqual(highlightSearchText('ΟΣ', ['ος']).ranges, [[0, 2]])
  assert(query('src/foo.ts').hits[0].snippet.ranges.length > 0)

  // Reproduce a DOM inspection that quotes the next session's title. This is
  // tool content in the inspecting session, not that conversation's own words.
  const quoted = '在改动文件列表中来回切换时会出现闪烁抖动'
  const inspector = await create('inspector', [message('user', 'Align the search button'),
    { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: `Actions for ${quoted}` }] } }])
  const genuine = await create('genuine', [message('user', quoted)])
  const lateProse = await create('late-prose', [message('user', 'Fix preview'),
    message('toolResult', `Actions for ${quoted}`), message('assistant', '已修复闪烁，预览保持稳定。')])
  const blocks = await create('blocks', [{ type: 'message', message: { role: 'assistant', content: [
    { type: 'text', text: 'blockunique alpha' }, { type: 'text', text: 'beta blockunique' },
    { type: 'thinking', thinking: 'thoughtonlysecret' },
    { type: 'toolCall', name: 'read', arguments: { path: 'callonlysecret' } }
  ] } }])
  const attachment = await create('attachment', [message('user', 'Review this file\n\n<file path="notes.md">attachmentonlysecret</file>')])
  const missingHeader = await create('missing-header', [])
  await writeFile(missingHeader, lines([message('user', 'orphansecret')]))
  await index.sync()
  const defaultHits = conversationQuery('闪烁').hits
  assert.deepEqual(new Set(defaultHits.map((hit) => hit.id)), new Set(['genuine', 'late-prose']))
  assert.equal(defaultHits.find((hit) => hit.id === 'genuine').snippetSource, 'user')
  assert.equal(defaultHits.find((hit) => hit.id === 'late-prose').snippetSource, 'assistant')
  const expanded = query('闪烁').hits
  assert.equal(expanded.find((hit) => hit.id === 'inspector').snippetSource, 'tool')
  assert.equal(expanded.find((hit) => hit.id === 'inspector').snippetToolName, 'bash')
  assert.equal(expanded.find((hit) => hit.id === 'late-prose').snippetSource, 'assistant', 'prefer conversation prose to earlier tool echoes')
  for (const term of ['thoughtonlysecret', 'callonlysecret', 'thinkingunique', 'codeunique', 'outputunique', 'attachmentonlysecret', 'backgroundonlysecret']) {
    assert.equal(conversationQuery(term).total, 0, term)
    assert(query(term).total > 0, term)
  }
  assert.equal(query('thoughtonlysecret').hits[0].snippetSource, 'thinking')
  assert.equal(query('attachmentonlysecret').hits[0].snippetSource, 'attachment')
  assert.equal(query('backgroundonlysecret').hits[0].snippetSource, 'tool')
  assert.equal(query('backgroundonlysecret').hits[0].snippetToolName, 'bash')
  assert.equal(query('"alpha beta"').total, 0, 'phrases cannot span content blocks')
  assert.equal(query('"blockunique alpha beta blockunique"').total, 0)
  assert.equal(conversationQuery('" "').total, 0)
  assert.equal(conversationQuery('orphansecret').total, 0)
  assert.equal(query('闪烁').incomplete, 1)
  index.close()
  index = await SessionSearchIndex.open(root, databasePath)
  let rereads = 0
  const indexFile = index.indexFile.bind(index)
  index.indexFile = (...args) => { rereads++; return indexFile(...args) }
  await index.sync()
  assert.equal(rereads, 0, 'unchanged invalid headers are cached, not reparsed on every keystroke')
  assert.equal(query('闪烁').incomplete, 1, 'cached failures still report incompleteness')
  await writeFile(missingHeader, lines([header('missing-header'), message('user', 'recovered orphan')]))
  await index.sync()
  assert.equal(conversationQuery('recovered orphan').total, 1)
  assert.equal(query('闪烁').incomplete, 0)
  index.indexFile = indexFile
  for (const path of [inspector, genuine, lateProse, blocks, attachment, missingHeader]) await rm(path)
  await index.sync()

  // Folder identity is the full cwd (these projects deliberately share a
  // basename). Group the entire match set before slicing pages; title-match
  // scores must not change the requested conversation-time order.
  const groupPaths = []
  for (let n = 0; n < 45; n++) {
    const id = `group-${n}`
    const path = join(folder, `${id}.jsonl`)
    const cwd = n < 42 ? '/fixture/one/project' : '/fixture/two/project'
    const timestamp = n === 0 ? 9000 : n < 42 ? 5000 - n : 8000 - n
    await writeFile(path, lines([{ ...header(id), cwd }, message('user', 'groupneedle', timestamp)]))
    groupPaths.push(path)
  }
  await index.sync()
  const groupedFirst = query('groupneedle')
  const groupedSecond = query('groupneedle', 40)
  assert.equal(groupedFirst.total, 45)
  assert(groupedFirst.hits.every((hit) => hit.cwd === '/fixture/one/project'))
  assert.deepEqual(groupedSecond.hits.map((hit) => hit.cwd), [
    '/fixture/one/project', '/fixture/one/project',
    '/fixture/two/project', '/fixture/two/project', '/fixture/two/project'
  ])
  const grouped = [...groupedFirst.hits, ...groupedSecond.hits]
  assert.equal(new Set(grouped.map((hit) => hit.path)).size, 45)
  for (let n = 1; n < grouped.length; n++) {
    if (grouped[n].cwd === grouped[n - 1].cwd) assert(grouped[n - 1].modified >= grouped[n].modified)
  }
  // The opposite direction is the same whole-set grouping read backwards:
  // folder groups keep their complete ordering and sessions ascend inside one.
  const oldestFirst = query('groupneedle', 0, 'oldest')
  const oldestSecond = query('groupneedle', 40, 'oldest')
  assert.deepEqual(oldestSecond.hits.map((hit) => hit.cwd), [
    '/fixture/one/project', '/fixture/one/project',
    '/fixture/two/project', '/fixture/two/project', '/fixture/two/project'
  ])
  const oldest = [...oldestFirst.hits, ...oldestSecond.hits]
  for (let n = 1; n < oldest.length; n++) {
    if (oldest[n].cwd === oldest[n - 1].cwd) assert(oldest[n - 1].modified <= oldest[n].modified)
  }
  // Each folder reads the other way round; the folder blocks themselves stay
  // whole (one folder's matches are never split by another's).
  for (const cwd of ['/fixture/one/project', '/fixture/two/project']) {
    assert.deepEqual(
      oldest.filter((hit) => hit.cwd === cwd).map((hit) => hit.path),
      grouped.filter((hit) => hit.cwd === cwd).map((hit) => hit.path).reverse()
    )
  }
  await Promise.all(groupPaths.map((path) => rm(path)))
  await index.sync()

  await appendFile(primary, lines([{ type: 'session_info', name: 'Renamed target' }, message('assistant', 'appendedunique')]))
  await index.sync()
  has('Renamed', 'primary')
  assert(!query('café').hits.some((hit) => hit.id === 'primary'), 'renamed title stops matching')
  has('appendedunique')
  await appendFile(primary, '{"type":"message"')
  await index.sync()
  assert.equal(query('appendedunique').incomplete, 1)
  await appendFile(primary, ',"message":{"role":"assistant","content":"repairedunique"}}\n')
  await index.sync()
  has('repairedunique')
  assert.equal(query('repairedunique').incomplete, 0)
  const rewritten = await create('rewrite', [message('user', 'beforeword')])
  await index.sync()
  const before = await stat(rewritten)
  await writeFile(rewritten, lines([header('rewrite'), message('user', 'afterwords')]))
  await utimes(rewritten, before.atime, before.mtime)
  await index.sync()
  assert.equal(query('beforeword').total, 0)
  has('afterwords', 'rewrite')
  await rm(rewritten)
  await index.sync()
  assert.equal(query('afterwords').total, 0)
  // A malformed/replaced file must not leave old matches in the index.
  await writeFile(primary, 'broken header\n')
  await index.sync()
  assert.equal(query('repairedunique').total, 0)
  await rm(primary)
  await index.sync()

  // Deterministic bilingual/code corpus with varying token distributions.
  const count = Number(process.env.SEARCH_BENCH_SESSIONS ?? 1000)
  let bytes = 0
  for (let start = 0; start < count; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - start) }, async (_, n) => {
      const id = start + n
      const text = Array.from({ length: 180 }, (_, line) =>
        `Session ${id} step ${line}: function handler_${(id * 971 + line * 37) % 100003}(request) { return cache.get('/src/project-${id % 43}/file-${line}.ts'); } 中文搜索性能及准确性 ${line % 7 ? 'completed' : 'retry'}\n`).join('')
      bytes += Buffer.byteLength(text)
      await create(`bench-${id}`, [message('user', `Benchmark ${id}`, 10000 + id), message('toolResult', text)])
    }))
  }
  const late = 'x'.repeat(2_000_000) + ' lateunique 中文终点'
  await create('long', [message('user', 'Long output'), message('toolResult', late)])
  const coldStart = performance.now()
  await index.sync()
  const coldMs = performance.now() - coldStart
  const first = query('Benchmark')
  assert.equal(first.total, count)
  assert.equal(first.hits.length, Math.min(count, 40))
  if (count > 40) {
    const second = query('Benchmark', 40)
    assert(!first.hits.some((a) => second.hits.some((b) => a.path === b.path)))
  }
  has('lateunique 中文终点', 'long')
  const samples = []
  for (const term of ['中文', '搜', 'handler_971', 'file-179.ts', '"return cache.get"', 'lateunique', 'notfoundxyz']) {
    for (let n = 0; n < 4; n++) {
      const start = performance.now()
      query(term)
      samples.push(performance.now() - start)
    }
  }
  const conversationSamples = []
  for (const term of ['Benchmark', '中文', 'Long output', 'notfoundxyz']) {
    for (let n = 0; n < 4; n++) {
      const start = performance.now()
      conversationQuery(term)
      conversationSamples.push(performance.now() - start)
    }
  }
  conversationSamples.sort((a, b) => a - b)
  const warmStart = performance.now()
  await index.sync()
  const warmSyncMs = performance.now() - warmStart
  index.close()
  index = await SessionSearchIndex.open(root, databasePath)
  const reopenStart = performance.now()
  await index.sync()
  has('lateunique', 'long')
  const reopenMs = performance.now() - reopenStart
  index.close()
  index = null

  // Test the production worker artifact and main-thread responsiveness during
  // cold indexing. The UI/main event loop must keep ticking throughout.
  let ticks = 0
  const interval = setInterval(() => { ticks++ }, 10)
  try {
    worker = new Worker(pathToFileURL(resolve('out/main/session-search-worker.mjs')), {
      workerData: { sessionsDir: root, databasePath: join(temp, 'worker.sqlite') }
    })
    const reply = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.postMessage({ id: 1, request: { query: 'lateunique', includeDetails: true } })
    })
    assert.equal(reply.result.hits[0].id, 'long')
    assert(ticks > 5, 'worker must leave the parent event loop responsive')
  } finally { clearInterval(interval) }
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({
    assertions: 'passed', sessions: count + 3, corpusMB: +((bytes + late.length) / 1e6).toFixed(1),
    coldIndexMs: +coldMs.toFixed(1), warmSyncMs: +warmSyncMs.toFixed(1), persistedReopenMs: +reopenMs.toFixed(1),
    conversationQueryP95Ms: +conversationSamples[Math.floor(conversationSamples.length * 0.95)].toFixed(1),
    queryP50Ms: +samples[Math.floor(samples.length * 0.5)].toFixed(1),
    queryP95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(1),
    queryMaxMs: +samples.at(-1).toFixed(1), mainThreadTicksDuringColdIndex: ticks
  }, null, 2))
} finally {
  index?.close()
  await worker?.terminate()
  await rm(temp, { recursive: true, force: true })
}
