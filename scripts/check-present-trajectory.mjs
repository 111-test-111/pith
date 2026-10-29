/** Offline real-SDK integration plus bounded storage/resource checks. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, symlink, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { createPlanFixture, planRepoRoot } from './lib/plan-fixture.mjs'

const temp = await mkdtemp(join(tmpdir(), 'pith-trajectory-check-'))
const outfile = join(temp, 'checks.mjs')
// Bundled TypeBox/SDK resolution is relative to the repo, not the temp folder.
await build({ stdin: { contents: `export {createPresentTool} from './src/main/pi/present';`, resolveDir: planRepoRoot },
  outfile: join(temp, 'present.mjs'), bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true })) } }] })
// Storage/extraction have no external package imports.
await build({ stdin: { contents: `export {TrajectoryStorage} from './src/main/pi/trajectory/storage';
export {TrajectoryClient} from './src/main/pi/trajectory/client';
export {trajectoryLines} from './src/main/pi/trajectory/jsonl';
export {parsePresentResult} from './src/shared/present';
export {presentedFiles} from './src/renderer/src/lib/presented-files';`, resolveDir: planRepoRoot },
  outfile, bundle: true, platform: 'node', format: 'esm' })
await build({ entryPoints: [join(planRepoRoot, 'src/main/pi/trajectory-worker.ts')], outfile: join(temp, 'trajectory-worker.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { TrajectoryStorage, TrajectoryClient, trajectoryLines, parsePresentResult, presentedFiles } = await import(pathToFileURL(outfile).href)
const { createPresentTool } = await import(pathToFileURL(join(temp, 'present.mjs')).href)
let storage, fixture, toolFixture, client
try {
  const artifact = join(temp, 'report # 你好.txt')
  await writeFile(artifact, 'delivered')
  const tool = createPresentTool({ cwd: temp, canStart: () => true })
  const result = await tool.execute('p', { files: [{ path: 'report # 你好.txt', description: 'Report' }, { path: artifact }] })
  assert.equal(result.details.files.length, 1)
  assert.equal(result.details.files[0].size, 9)
  await assert.rejects(tool.execute('p', { files: [{ path: 'missing' }] }))
  await assert.rejects(tool.execute('p', { files: [{ path: temp }] }))
  await symlink(artifact, join(temp, 'link'))
  await assert.rejects(tool.execute('p', { files: [{ path: 'link' }] }))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(tool.execute('p', { files: [{ path: artifact }] }, abort.signal))
  const closed = createPresentTool({ cwd: temp, canStart: () => false })
  await assert.rejects(closed.execute('p', { files: [{ path: artifact }] }))
  const messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'p', name: 'present', arguments: {} }] }]
  const results = new Map([['p', { role: 'toolResult', toolName: 'present', isError: false, details: result.details }]])
  assert.equal(presentedFiles(messages, results).length, 1)
  results.get('p').isError = true
  assert.equal(presentedFiles(messages, results).length, 0)
  assert.equal(presentedFiles([{ role: 'assistant', content: [{ type: 'text', text: artifact }] }], results).length, 0)
  for (const path of ['/tmp/report.txt', 'C:\\reports\\report.txt', '\\\\server\\share\\report.txt']) {
    assert.equal(parsePresentResult({ kind: 'pith-present-v1', files: [{ path, size: 1 }] })?.files[0].path, path)
  }
  for (const path of ['report.txt', 'C:report.txt', '\\report.txt']) {
    assert.equal(parsePresentResult({ kind: 'pith-present-v1', files: [{ path, size: 1 }] }), null)
  }
  console.log('PASS present: regular files, exact paths, deduplication, failures, cancellation, successful call/result only')

  const partialPath = join(temp, 'partial.jsonl')
  const partial = JSON.stringify({ type: 'message', id: 'partial', parentId: null, timestamp: '2026-09-27T00:00:00Z', message: { role: 'user', content: '你好😀' } })
  await writeFile(partialPath, partial + '\r\n' + partial.slice(0, 10))
  const parsed = []
  for await (const item of trajectoryLines(partialPath, 0, (await stat(partialPath)).size)) parsed.push(item)
  assert.equal(parsed.length, 1); assert.equal(parsed[0].offset, Buffer.byteLength(partial + '\r\n'))
  await writeFile(partialPath, partial + '\r\n' + partial + '\n')
  const suffix = []
  for await (const item of trajectoryLines(partialPath, parsed[0].offset, (await stat(partialPath)).size)) suffix.push(item)
  assert.equal(suffix.length, 1); assert.equal(suffix[0].entry.message.content, '你好😀')
  const oversized = { type: 'message', id: 'large', parentId: 'partial', timestamp: '2026-09-27T00:00:00Z', message: { role: 'assistant', content: 'x'.repeat(17 * 1024 * 1024) } }
  await writeFile(partialPath, JSON.stringify(oversized) + '\n')
  const largeRows = []
  for await (const item of trajectoryLines(partialPath, 0, (await stat(partialPath)).size)) largeRows.push(item.entry)
  assert.equal(largeRows[0].id, 'large'); assert.equal(largeRows[0].parentId, 'partial'); assert.equal(largeRows[0].trajectoryOmitted, true)
  assert.equal(largeRows[0].message, undefined)
  console.log('PASS JSONL: exact Unicode/CRLF offsets, partial-append retry, bounded oversized envelope/ancestry')
  const database = join(temp, 'trace.sqlite'), sessionPath = join(temp, 'session.jsonl')
  const lines = [
    { type: 'session', id: 's', version: 3 },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'first', timestamp: 1 } },
    { type: 'message', id: 'old', parentId: 'u', message: { role: 'assistant', content: [], timestamp: 2 } },
    { type: 'custom', id: 'rewind', parentId: 'u', customType: 'pith_rewind_selection' },
    { type: 'message', id: 'new', parentId: 'rewind', message: { role: 'assistant', content: [], timestamp: 3 } }
  ]
  await writeFile(sessionPath, lines.map(x => JSON.stringify(x)).join('\n') + '\n')
  storage = await TrajectoryStorage.open(database)
  const access = { sessionPath, sessionId: 's' }
  await storage.history(access)
  assert.deepEqual(storage.page(access, {}).items.map(x => x.name), ['user', 'assistant'])
  assert.deepEqual(storage.page(access, { kind: 'request' }).items.map(x => x.kind), ['assistant'], 'model-request filter includes assistant output restored from older sessions')
  assert(!storage.page(access, {}).items.some(x => x.id.endsWith(':old')))
  assert.equal(storage.page({ ...access, leafId: 'old' }, {}).total, 2)
  assert.equal(storage.page(access, {}).items[0].preview, 'first', 'older SDK messages expose text excerpts')
  const previewRecord = (id, kind, documents, metadata = {}) => storage.write({ sessionId: 's', anchor: 'new',
    record: { id, kind, name: kind === 'tool' ? 'bash' : kind, startedAt: 4, status: 'completed', captured: true, ...metadata }, documents })
  previewRecord('preview-command', 'tool', { context: { command: 'git status\n--short', apiKey: 'do-not-show' } })
  previewRecord('preview-command', 'tool', { output: { content: [{ type: 'text', text: 'result' }] } })
  assert.equal(storage.detail(access, 'preview-command').record.preview, 'git status --short', 'settling a tool retains its useful invocation')
  previewRecord('preview-path', 'tool', { context: { path: 'src/main.ts', offset: 10, limit: 20 } })
  assert.equal(storage.detail(access, 'preview-path').record.preview, 'src/main.ts · offset: 10 · limit: 20')
  previewRecord('preview-output', 'request', { output: { content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: '模型输出\n已经完成。' }] } })
  assert.equal(storage.detail(access, 'preview-output').record.preview, '模型输出 已经完成。', 'visible output precedes reasoning')
  const calls = Array.from({ length: 20 }, (_, index) => ({ type: 'toolCall', id: 'call-' + index, name: 'read', arguments: { path: `file-${index}.txt` } }))
  previewRecord('preview-call', 'request', { output: { content: [{ type: 'text', text: 'Let me read these files' }, ...Array.from({ length: 13 }, () => ({ type: 'thinking', thinking: 'reasoning' })), ...calls] } })
  const callSummary = storage.detail(access, 'preview-call').record
  assert.equal(callSummary.preview, '', 'tool-bearing model responses do not duplicate the invocation details or text')
  assert.deepEqual(callSummary.toolCalls, calls.map(({ id, name }) => ({ id, name })), 'every call has a compact identity, including blocks beyond the text preview limit')
  previewRecord('preview-wrong-parent', 'tool', {}, { parentId: 'another-request', toolCallId: 'call-1' })
  for (let index = 0; index < calls.length; index++) previewRecord('preview-tool-' + index, 'tool', { output: { toolCallId: calls[index].id, content: [{ type: 'text', text: `result-${index}` }] } }, { name: 'read', parentId: 'preview-call', toolCallId: calls[index].id })
  for (let index = 0; index < 100; index++) previewRecord('preview-padding-' + index, 'notification', {})
  assert(!storage.page(access, {}).items.some(record => record.id === 'preview-tool-1'), 'destination is outside the loaded page')
  const reveal = storage.page(access, { toolCall: { recordId: 'preview-call', callId: 'call-1' }, kind: 'request', query: 'hidden-by-filter' })
  assert.equal(reveal.targetId, 'preview-tool-1', 'jump reveals the exact call despite repeated tool names, another request using the same ID, filters and pagination')
  assert(reveal.items.some(record => record.id === reveal.targetId) && reveal.items.some(record => record.id === 'preview-call'), 'target and surrounding model context stay in the revealed page')
  assert(reveal.items.length === 80 && reveal.newer, 'jump fills the bounded page and remains normally pageable')
  assert.throws(() => storage.page(access, { toolCall: { recordId: 'preview-call', callId: 'not-an-output-call' } }), /unavailable/)
  assert.throws(() => storage.page({ ...access, leafId: 'old' }, { toolCall: { recordId: 'preview-call', callId: 'call-1' } }), /unavailable/, 'off-branch sources cannot be used to reveal records')
  previewRecord('preview-debug', 'tool', { context: { request: { action: 'stack', file: '/workspace/main.ts' }, debugId: 'opaque' } })
  assert.equal(storage.detail(access, 'preview-debug').record.preview, 'stack · /workspace/main.ts')
  previewRecord('preview-reconstructed-tool', 'tool', { event: { content: [{ type: 'text', text: 'historical tool output' }] } })
  assert.equal(storage.detail(access, 'preview-reconstructed-tool').record.preview, 'historical tool output')
  previewRecord('preview-compaction', 'compaction', { output: { compaction: { summary: 'Work so far' } } })
  assert.equal(storage.detail(access, 'preview-compaction').record.preview, 'Work so far')
  previewRecord('preview-bounded', 'assistant', { output: { content: [{ type: 'image', data: 'secret-image'.repeat(10000) }, { type: 'text', text: ('文字😀\\\"\n').repeat(3000) }] } })
  const boundedPreview = storage.detail(access, 'preview-bounded').record.preview
  assert(boundedPreview.length <= 512 && boundedPreview.startsWith('文字😀'), 'large Unicode/escaped text stays bounded and decoded')
  assert(!boundedPreview.includes('secret-image') && !/[\ud800-\udbff]$/.test(boundedPreview), 'images and incomplete surrogate pairs never enter the excerpt')
  const legacy = new DatabaseSync(database)
  legacy.prepare("UPDATE records SET data=json_set(json_remove(data,'$.previewVersion','$.toolCalls'),'$.preview','read · duplicated arguments') WHERE id=?").run('preview-call')
  legacy.prepare("UPDATE records SET data=json_remove(data,'$.previewVersion','$.toolCallId') WHERE id=?").run('preview-tool-1')
  assert.equal(storage.page(access, { toolCall: { recordId: 'preview-call', callId: 'call-1' } }).targetId, 'preview-tool-1', 'old captures resolve exact calls from lazy graph metadata')
  assert.equal(storage.detail(access, 'preview-call').record.preview, '', 'old duplicate previews are replaced on demand')
  legacy.prepare("UPDATE records SET data=json_remove(data,'$.preview') WHERE id=?").run('preview-bounded')
  assert.equal(storage.page(access, { kind: 'assistant' }).items.find(record => record.id === 'preview-bounded').preview, boundedPreview, 'existing capture databases backfill excerpts on a bounded page read')
  assert.equal(JSON.parse(legacy.prepare('SELECT data FROM records WHERE id=?').get('preview-bounded').data).preview, boundedPreview, 'backfilled previews are reused')
  legacy.prepare("DELETE FROM records WHERE id LIKE 'preview-%'").run()
  legacy.close()
  const historicalPath = join(temp, 'historical-calls.jsonl')
  const historicalEntries = [
    { type: 'session', id: 'historical' },
    { type: 'message', id: 'hu', parentId: null, message: { role: 'user', content: [], timestamp: 1 } },
    { type: 'message', id: 'hm', parentId: 'hu', message: { role: 'assistant', content: [...calls.slice(0, 2), { type: 'toolCall', id: 'not-executed', name: 'read', arguments: {} }], timestamp: 2 } },
    { type: 'message', id: 'ht0', parentId: 'hm', message: { role: 'toolResult', toolCallId: 'call-0', toolName: 'read', content: [], timestamp: 3 } },
    { type: 'message', id: 'ht1', parentId: 'ht0', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [], timestamp: 4 } },
    { type: 'message', id: 'hm2', parentId: 'ht1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'not-executed', name: 'read', arguments: {} }], timestamp: 5 } },
    { type: 'message', id: 'ht2', parentId: 'hm2', message: { role: 'toolResult', toolCallId: 'not-executed', toolName: 'read', content: [], timestamp: 6 } }
  ]
  await writeFile(historicalPath, historicalEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const historicalAccess = { sessionPath: historicalPath, sessionId: 'historical' }
  await storage.history(historicalAccess)
  assert(storage.page(historicalAccess, { kind: 'request' }).items.some(record => record.id === 'entry:historical:hm'), 'historical assistant tool-use appears under the same model-request filter')
  assert.equal(storage.page(historicalAccess, { toolCall: { recordId: 'entry:historical:hm', callId: 'call-1' } }).targetId, 'entry:historical:ht1', 'historical assistant calls reveal their corresponding SDK results')
  assert.throws(() => storage.page(historicalAccess, { toolCall: { recordId: 'entry:historical:hm', callId: 'not-executed' } }), /unavailable/, 'a reused ID in a later model response cannot substitute for an unexecuted historical call')
  storage.write({ sessionId: 'historical', anchor: 'hm', entryId: 'hm', record: { id: 'hybrid-request', kind: 'request', name: 'model', startedAt: 2, status: 'completed', captured: true }, documents: { output: historicalEntries[2].message } })
  assert.equal(storage.page(historicalAccess, { toolCall: { recordId: 'hybrid-request', callId: 'call-1' } }).targetId, 'entry:historical:ht1', 'a captured request can still reveal SDK-recovered tool records after a missing tool capture')
  assert.throws(() => storage.page(historicalAccess, { toolCall: { recordId: 'hybrid-request', callId: 'not-executed' } }), /unavailable/, 'hybrid recovery stops at the next model response too')
  console.log('PASS excerpts/call links: all output identities, exact same-name navigation across pages/filters, branch/request ownership, historical messages, bounded Unicode and lazy old-database backfill')
  const large = '你好😀'.repeat(300000)
  const body = { system: 'prompt'.repeat(8000), image: large, apiKey: 'secret', messages: Array.from({ length: 100 }, (_, n) => ({ role: 'user', text: `message ${n}` })) }
  const start = performance.now(), rss = process.memoryUsage().rss
  for (let n = 0; n < 500; n++) storage.write({ sessionId: 's', anchor: 'new',
    record: { id: `request-${n}`, kind: 'request', name: 'model', provider: 'fixture', model: 'fixture', startedAt: 100 + n, finishedAt: 101 + n, status: 'completed', captured: true },
    documents: { payload: body } })
  const elapsed = performance.now() - start
  const page = storage.page(access, { kind: 'request' })
  assert.equal(page.total, 501); assert.equal(page.items.length, 80)
  assert(page.older); assert.equal(page.newer, null)
  const older = storage.page(access, { kind: 'request', before: page.older })
  assert.equal(older.items.length, 80)
  assert.equal(new Set([...older.items, ...page.items].map(x => x.id)).size, 160)
  assert.deepEqual(storage.page(access, { kind: 'request', after: older.newer }).items.map(x => x.id), page.items.map(x => x.id))
  const detail = storage.detail(access, page.items[0].id), root = detail.documents[0].node
  const fields = storage.readNode(access, { recordId: detail.record.id, trail: [root.id] })
  const image = fields.children.find(x => x.key === 'image').node
  let offset = 0, text = ''
  do {
    const value = storage.readNode(access, { recordId: detail.record.id, trail: [root.id, image.id], offset })
    assert([...value.text].length <= 16384)
    text += value.text; offset = value.nextOffset
  } while (offset !== null)
  assert.equal(JSON.parse(text), large)
  assert.throws(() => storage.readNode({ ...access, leafId: 'old' }, { recordId: detail.record.id, trail: [root.id] }))
  assert.throws(() => storage.readNode(access, { recordId: detail.record.id, trail: [root.id, '0'.repeat(64)] }))
  const out = join(temp, 'export.json')
  await storage.export(access, detail.record.id, out)
  const exported = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(exported.documents.payload.image, large)
  assert.equal(exported.documents.payload.apiKey, '[redacted]')
  const disk = (await stat(database)).size + (await stat(database + '-wal')).size
  const growth = process.memoryUsage().rss - rss
  assert(disk < 25 * 1024 * 1024, `dedup disk ${disk}`)
  assert(growth < 160 * 1024 * 1024, `unbounded resident growth ${growth}`)
  console.log(`PASS storage: 500 repeated 3 MB requests, ${(disk / 1048576).toFixed(1)} MiB disk, ${elapsed.toFixed(0)} ms writes, ${(growth / 1048576).toFixed(1)} MiB RSS growth; pagination, branch isolation, Unicode fragments, redaction, export`)
  const contextStats = id => ({ id, startedAt: 1000, provider: 'fixture', model: 'fixture', payloadCaptured: true,
    inputTokens: 10, breakdown: { user: 10, assistant: 0, toolResults: 0, other: 0, total: 10 }, categories: [] })
  assert.equal(storage.context(access), null, 'uncaptured older histories have no invented request statistics')
  storage.write({ sessionId: 's', anchor: 'new', record: { id: 'context-new', kind: 'request', name: 'model', startedAt: 1000,
    status: 'completed', captured: true, contextStats: contextStats('context-new') } })
  storage.write({ sessionId: 's', anchor: 'old', record: { id: 'context-old', kind: 'request', name: 'model', startedAt: 1001,
    status: 'completed', captured: true, contextStats: contextStats('context-old') } })
  assert.equal(storage.context(access).id, 'context-new', 'newer abandoned requests cannot override selected-branch statistics')
  assert.equal(storage.context({ ...access, leafId: 'old' }).id, 'context-old')
  assert(!storage.page(access, {}).items.some(record => record.contextStats), 'normal timeline pages do not duplicate composition metadata')
  storage.write({ sessionId: 's', anchor: 'new', record: { id: 'crash', kind: 'tool', name: 'bash', startedAt: 999, status: 'running', captured: true } })
  storage.close(); storage = await TrajectoryStorage.open(database)
  assert.equal(storage.detail(access, 'crash').record.status, 'interrupted')
  assert.equal(storage.context(access).id, 'context-new', 'statistics survive storage restart')
  storage.close(); storage = null
  client = new TrajectoryClient(join(temp, 'worker.sqlite'))
  for (let n = 0; n < 120; n++) await client.write({ sessionId: 's', anchor: 'new',
    record: { id: `worker-${n}`, kind: 'request', name: 'model', startedAt: n, status: 'completed', captured: true }, documents: { payload: body } })
  assert.equal((await client.page(access, {})).items.length, 80)
  let exportDone = false
  const exporting = client.export(access, 'worker-0', out).then(() => { exportDone = true })
  await client.write({ sessionId: 's', anchor: 'new', record: { id: 'during-export', kind: 'tool', name: 'write', startedAt: 999, status: 'completed', captured: true } })
  assert(!exportDone, 'capture is admitted before a long export finishes')
  await exporting
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).documents.payload, { ...body, apiKey: '[redacted]' })
  const writes = []
  for (let n = 0; n < 40; n++) writes.push(client.write({ sessionId: 's', anchor: 'new', record: { id: 'ordered', kind: 'tool', name: 'bash', startedAt: 1000, status: n === 39 ? 'completed' : 'running', captured: true } }))
  await Promise.all(writes)
  assert.equal((await client.detail(access, 'ordered')).record.status, 'completed')
  await client.dispose(); client = null
  console.log('PASS worker: 120 large structured clones, bounded heap/queue, FIFO settlements, capture during export, complete nested export')

  fixture = await createPlanFixture({ providerCallbacks: true,
    extensionFactories: [pi => {
      let request = 0
      pi.on('context', event => ({ messages: [...event.messages,
        { role: 'user', content: 'request-extra: ' + 'x'.repeat(++request * 300), timestamp: 900000 + request }] }))
    }], respond: n => n === 1
    ? [{ type: 'toolCall', id: 'present-sdk', name: 'present', arguments: { files: [{ path: 'final.txt' }] } }]
    : [{ type: 'text', text: 'Delivered' }] })
  await fixture.managed.lifecyclePromise
  await writeFile(join(fixture.project, 'final.txt'), 'report')
  await fixture.session.prompt('Create a report')
  await fixture.managed.trajectory.flush()
  const trace = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path })
  assert.equal(trace.items.filter(x => x.kind === 'request').length, 2)
  assert.equal(trace.items.filter(x => x.kind === 'assistant').length, 0, 'no duplicate history fallback')
  assert.equal(trace.items.filter(x => x.kind === 'user').length, 1)
  assert.equal(trace.items.filter(x => x.kind === 'tool' && x.name === 'present').length, 1)
  const sdkCallRequest = trace.items.find(record => record.toolCalls?.length)
  assert.deepEqual(sdkCallRequest.toolCalls, [{ id: 'present-sdk', name: 'present' }])
  const sdkTool = trace.items.find(record => record.kind === 'tool')
  assert.equal(sdkTool.toolCallId, 'present-sdk')
  assert.equal((await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, toolCall: { recordId: sdkCallRequest.id, callId: 'present-sdk' } })).targetId, sdkTool.id, 'real SDK provider/tool identity survives worker IPC and navigation')
  assert(trace.items.every(x => x.status === 'completed'))
  for (const request of trace.items.filter(x => x.kind === 'request')) {
    assert.equal(request.httpStatus, 200); assert(request.firstTokenAt); assert.equal(request.usage.output, 1)
    const detail = await fixture.app.trajectoryDetail(fixture.managed.path, request.id)
    assert(detail.documents.some(x => x.kind === 'payload'))
    await fixture.app.exportTrajectory(fixture.managed.path, request.id, out)
    const exported = await readFile(out, 'utf8')
    assert(!exported.includes('fixture-secret')); assert.equal(JSON.parse(exported).documents.payload.authorization, '[redacted]', JSON.stringify(Object.keys(JSON.parse(exported).documents.payload ?? {})))
    const documents = JSON.parse(exported).documents
    assert(documents.context?.messages.length > 0, 'SDK context survives worker structured cloning')
    assert(documents.options?.api, 'options are captured alongside context')
    const declaredTools = documents.context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? [])
    assert(declaredTools.some(tool => tool.name === 'present'))
    assert(declaredTools.every(tool => Object.keys(tool).every(key => ['name', 'description', 'parameters', 'constrainedSampling'].includes(key))))
    assert(!request.captureError, 'tool execution closures do not cause incomplete capture')
  }
  assert(fixture.session.agent.state.tools.every(tool => typeof tool.execute === 'function'), 'capture does not mutate live tools')
  const context = await fixture.app.contextDetail(fixture.managed.path)
  const latestRequest = trace.items.filter(record => record.kind === 'request').at(-1)
  assert.equal(context.request.id, latestRequest.id)
  assert.equal(context.request.inputTokens, 1)
  const extras = fixture.requests.map(request => request.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('request-extra: ')))
  assert(extras[1].content.length > extras[0].content.length)
  assert.equal(context.categories.find(category => category.kind === 'requestOnly').tokens, Math.ceil(extras[1].content.length / 4), 'request modifications are measured again on every round')
  const original = fixture.manager.getLeafId()
  const user = fixture.manager.getBranch().find(x => x.type === 'message' && x.message.role === 'user')
  fixture.manager.branch(user.id)
  const rewound = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path })
  assert.equal(rewound.items.filter(x => x.kind === 'request').length, 0)
  assert.equal((await fixture.app.contextDetail(fixture.managed.path)).request, null, 'rewinding invalidates both the in-memory and persisted capture')
  fixture.manager.branch(original)
  assert.equal((await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path })).items.filter(x => x.kind === 'request').length, 2)
  const fork = fixture.manager.constructor.forkFrom(fixture.managed.path, fixture.project, join(fixture.temporary, 'sessions'))
  const forkTrace = await fixture.app.trajectoryPage({ sessionPath: fork.getSessionFile() })
  assert.equal(forkTrace.items.filter(x => x.kind === 'request').length, 2)
  assert.equal(forkTrace.items.filter(x => x.kind === 'assistant').length, 0)
  assert.equal((await fixture.app.contextDetail(fork.getSessionFile())).request.id, latestRequest.id, 'cold fork statistics recover the authorized parent capture')
  const previous = fixture.managed.trajectory.previous
  fixture.managed.trajectory.previous = (model, context, options) => previous(model, context, { ...options,
    onPayload: async (payload, requestModel) => {
      await options.onPayload(payload, requestModel)
      return options.onPayload({ ...payload, attempt: 2 }, requestModel)
    }
  })
  const beforeAttempts = fixture.manager.getLeafId()
  await fixture.session.prompt('provider retry')
  await fixture.managed.trajectory.flush()
  const attemptedTrace = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })
  assert.equal(attemptedTrace.total, 4)
  assert.equal(attemptedTrace.items.filter(x => x.status === 'failed').length, 1)
  assert.equal((await fixture.app.contextDetail(fixture.managed.path)).request.id, attemptedTrace.items.at(-1).id, 'provider retry has its own latest-request identity')
  const afterAttempts = fixture.manager.getLeafId()
  fixture.manager.branch(beforeAttempts)
  assert.equal((await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })).total, 2)
  fixture.manager.branch(afterAttempts)
  const existingRequests = new Set(attemptedTrace.items.map(x => x.id))
  fixture.managed.trajectory.previous = async (model, context, options) => {
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Final text without streamed output' }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 1, output: 1000, cacheRead: 10, cacheWrite: 20, totalTokens: 1031, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() {
      await options.onPayload({ model: model.id, messages: context.messages }, model)
      yield { type: 'text_delta', contentIndex: 0, delta: '', partial: message }
      yield { type: 'thinking_delta', contentIndex: 0, delta: '', partial: message }
      yield { type: 'done', message }
    }, result: async () => message }
  }
  await fixture.session.prompt('empty deltas are not first output')
  await fixture.managed.trajectory.flush()
  const emptyTrace = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })
  const emptyRequests = emptyTrace.items.filter(x => !existingRequests.has(x.id))
  assert.equal(emptyRequests.length, 1)
  assert.equal(emptyRequests[0].firstTokenAt, undefined)
  assert.equal((await fixture.app.contextDetail(fixture.managed.path)).request.inputTokens, 31, 'reported input includes cache reads/writes and excludes output')
  let started
  const starting = new Promise(resolve => { started = resolve })
  fixture.managed.trajectory.previous = (model, context, options) => {
    const message = { role: 'assistant', content: [{ type: 'text', text: 'partial' }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'aborted', errorMessage: 'Aborted',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    const done = new Promise(resolve => { options.signal.addEventListener('abort', () => resolve(message), { once: true }) })
    return { async *[Symbol.asyncIterator]() {
      await options.onPayload({ model: model.id, messages: context.messages }, model)
      yield { type: 'text_delta', contentIndex: 0, delta: 'partial', partial: message }
      started()
      yield { type: 'error', error: await done }
    }, result: () => done }
  }
  const interrupted = fixture.session.prompt('cancel this request')
  await starting
  assert.equal((await fixture.app.contextDetail(fixture.managed.path)).request.inputTokens, null, 'running requests do not invent provider usage')
  await fixture.session.abort(); await interrupted
  await fixture.managed.trajectory.flush()
  const stoppedTrace = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, status: 'cancelled' })
  assert.equal(stoppedTrace.items.filter(x => x.kind === 'request').length, 1)
  assert.equal(stoppedTrace.items.filter(x => x.kind === 'run').length, 1)
  assert.equal((await fixture.app.contextDetail(fixture.managed.path)).request.inputTokens, null, 'zero-usage aborted requests remain unknown')
  fixture.session.settingsManager.setRetryEnabled(true)
  fixture.managed.trajectory.previous = (model, context, options) => {
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: 'error', errorMessage: '503 service unavailable',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() {
      await options.onPayload({ model: model.id, messages: context.messages }, model)
      yield { type: 'error', error: message }
    }, result: async () => message }
  }
  const cancelRetry = fixture.session.subscribe(event => {
    if (event.type === 'auto_retry_start') queueMicrotask(() => fixture.session.abortRetry())
  })
  try { await fixture.session.prompt('cancel while waiting for retry') }
  finally { cancelRetry(); fixture.session.settingsManager.setRetryEnabled(false) }
  await fixture.managed.trajectory.flush()
  const retryCancelled = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'retry' })
  assert.equal(retryCancelled.items.at(-1).status, 'cancelled')
  const retryRun = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'run' })
  assert.equal(retryRun.items.at(-1).status, 'cancelled')
  assert(!(await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, status: 'running' })).total, 'settled retry leaves no running records')
  let toolReady
  const toolStarted = new Promise(resolve => { toolReady = resolve })
  toolFixture = await createPlanFixture({ providerCallbacks: true,
    respond: n => n === 1 ? [{ type: 'toolCall', id: 'cancel-tool', name: 'wait_for_cancel', arguments: {} }] : [{ type: 'text', text: 'unexpected continuation' }],
    extensionFactories: [pi => pi.registerTool({ name: 'wait_for_cancel', label: 'Wait', description: 'Wait for cancellation',
      parameters: { type: 'object', properties: {} }, execute: async (_id, _args, signal) => {
        await new Promise(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
          toolReady()
        })
        return { content: [{ type: 'text', text: 'Stopped' }] }
      } })] })
  await toolFixture.managed.lifecyclePromise
  const toolInterrupted = toolFixture.session.prompt('cancel during tool execution')
  await toolStarted
  await toolFixture.session.abort(); await toolInterrupted
  await toolFixture.managed.trajectory.flush()
  const toolTrace = await toolFixture.app.trajectoryPage({ sessionPath: toolFixture.managed.path })
  assert.equal(toolTrace.items.find(x => x.kind === 'run').status, 'cancelled')
  console.log('PASS real SDK: present persistence, callbacks, usage/timing, empty deltas, payload, committed records, branch isolation, stream/tool/backoff abort settlement')
} finally {
  storage?.close()
  await client?.dispose()
  await fixture?.close()
  await toolFixture?.close()
  await rm(temp, { recursive: true, force: true })
}
