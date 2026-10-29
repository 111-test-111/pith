/** Real filesystem + SDK-shaped JSONL + SQLite archive, without provider calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, readdir, stat, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { Resvg } from '@resvg/resvg-js'
import { defineTool, createCodemodeExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pith-library-'))
const modulePath = join(temp, 'library.mjs')
let store
let fixture
try {
  await build({ stdin: { contents: "export {LibraryStore} from './src/main/library/store'; export * from './src/main/library/extract'; export * from './src/main/library/web-snapshot'; export * from './src/shared/library';", resolveDir: repo }, outfile: modulePath, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'absolute-dependencies', setup(builder) { builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$|^proper-lockfile$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })) } }] })
  const { LibraryStore, collectTool, collectMessage, libraryDownload, libraryWebSnapshotBytes, LIBRARY_WEB_SNAPSHOT_SCHEMA, normalizeLibraryPreferences } = await import(pathToFileURL(modulePath))
  const sessionsDir = join(temp, 'sessions'), project = join(temp, 'a', 'project'), otherProject = join(temp, 'b', 'project'), workspace = join(temp, 'workspace'), directory = join(temp, 'archive')
  for (const path of [project, otherProject, workspace, join(sessionsDir, 'one'), join(sessionsDir, 'two')]) await mkdir(path, { recursive: true })
  const options = { databasePath: join(temp, 'index.sqlite'), sessionsDir, defaultWorkspace: workspace, directory, defaultDirectory: directory, preferences: { enabled: true, directory: null, maxBytes: 1024 ** 2 } }
  assert.equal(normalizeLibraryPreferences({ enabled: false, maxBytes: -1 }).enabled, false)
  assert.equal(normalizeLibraryPreferences({ directory: '../escape' }).directory, null)
  store = await LibraryStore.open(options)
  await assert.rejects(LibraryStore.open(options), /lock/i, 'only one archive writer may hold the database')
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="56"><rect width="32" height="56" fill="#6852e4"/></svg>').render().asPng()
  const image = { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }
  const attachment = join(project, 'input " notes.txt'), delivery = join(project, 'report.txt'), missing = join(project, 'missing.pdf')
  const textBytes = Buffer.from('Full original bytes\n' + 'data\n'.repeat(2000))
  await writeFile(attachment, textBytes); await writeFile(delivery, textBytes)
  const sessionPath = join(sessionsDir, 'one', 'chat.jsonl')
  const entries = [
    { type: 'session', id: 'chat-one', cwd: project, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', message: { role: 'user', timestamp: 10, content: [image, { type: 'text', text: 'Research material\n<file path="input " notes.txt">text</file>\n<file path="failed.txt">(could not be read: missing)</file>' }] } },
    { type: 'message', id: 'a1', message: { role: 'assistant', timestamp: 20, stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'deliver', name: 'present', arguments: { files: [{ path: delivery }] } },
      { type: 'toolCall', id: 'search', name: 'web_search', arguments: { query: 'photos 100%' } },
      { type: 'toolCall', id: 'fetch', name: 'web_fetch', arguments: { url: 'https://example.org/doc' } },
      { type: 'toolCall', id: 'missing', name: 'present', arguments: { files: [{ path: missing }] } }
    ] } },
    { type: 'message', id: 't1', message: { role: 'toolResult', toolCallId: 'deliver', toolName: 'present', timestamp: 21, isError: false, content: [], details: { kind: 'pith-present-v1', files: [{ path: delivery, size: textBytes.length, description: 'Delivered report' }] } } },
    { type: 'message', id: 't2', message: { role: 'toolResult', toolCallId: 'search', toolName: 'web_search', timestamp: 22, isError: false, content: [], details: { data: { results: [{ url: 'https://example.org/photos', title: 'Photo source', snippet: 'Useful source text' }] } } } },
    { type: 'message', id: 't3', message: { role: 'toolResult', toolCallId: 'fetch', toolName: 'web_fetch', timestamp: 23, isError: false, content: [{ type: 'text', text: 'Saved website body\nSecond line' }] } },
    { type: 'message', id: 't4', message: { role: 'toolResult', toolCallId: 'missing', toolName: 'present', timestamp: 24, isError: false, content: [], details: { kind: 'pith-present-v1', files: [{ path: missing, size: 100 }] } } },
    { type: 'message', id: 't5', message: { role: 'toolResult', toolCallId: 'bad', toolName: 'web_fetch', timestamp: 25, isError: true, content: [{ type: 'text', text: 'https://failed.example.org/' }] } },
    { type: 'message', id: 't6', message: { role: 'toolResult', toolCallId: 'screenshot', toolName: 'browser_screenshot', timestamp: 26, isError: false, content: [image] } },
    { type: 'session_info', name: 'Material collection' }
  ]
  await writeFile(sessionPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await store.scanFile(sessionPath)
  assert.equal(store.status().total, 7, 'attachments, deliveries, websites, missing originals and screenshots are captured; failed tools are excluded')
  const first = store.page({}).items
  assert(first.every(item => item.sessionTitle === 'Material collection'))
  const imageItems = store.page({ kind: 'image' }).items
  assert.equal(imageItems.length, 2)
  assert.equal(imageItems[0].archivedPath, imageItems[1].archivedPath, 'identical image bytes share one object across sources')
  assert.deepEqual(await readFile(imageItems[0].archivedPath), Buffer.from(png), 'validation preserves exact image bytes')
  assert(imageItems.every(item => item.imageWidth === 32 && item.imageHeight === 56), 'image dimensions are published before renderer decoding')
  const files = store.page({ kind: 'file' }).items
  const savedFiles = files.filter(item => item.storage === 'saved')
  assert.equal(savedFiles[0].archivedPath, savedFiles[1].archivedPath, 'attachment and delivery share one copy')
  assert(files.some(item => item.originalPath === missing && item.storage === 'missing'))
  assert.equal(store.page({ kind: 'file', hideUnavailable: true }).total, 2, 'unavailable filtering applies to the indexed count and page, retaining readable copies')
  assert.equal(store.page({ query: '100%' }).total, 1, 'search remains literal rather than interpreting SQL wildcards')
  assert.equal(store.page({ query: 'example.org/photos' }).items[0].name, 'Photo source', 'URL traversal retains structured titles and excerpts')
  const fetch = store.page({ query: 'example.org/doc' }).items[0]
  assert(fetch.archivedPath.endsWith('.json'), 'web sources route through the structured JSON preview')
  const fetchSnapshot = JSON.parse(await readFile(fetch.archivedPath, 'utf8'))
  assert.equal(fetchSnapshot.schema, LIBRARY_WEB_SNAPSHOT_SCHEMA)
  assert.equal(fetchSnapshot.id, fetch.id)
  assert.equal(fetchSnapshot.title, 'example.org')
  assert.equal(fetchSnapshot.url, 'https://example.org/doc')
  assert.equal(fetchSnapshot.excerpt, 'Saved website body\nSecond line')
  assert.equal(fetchSnapshot.source, 'fetch')
  assert.equal(fetchSnapshot.toolName, 'web_fetch')
  assert.equal(fetchSnapshot.capturedAt, new Date(23).toISOString())
  assert.equal(fetchSnapshot.provenance.project, project)
  assert.equal(fetchSnapshot.provenance.sessionId, 'chat-one')
  assert.equal(fetchSnapshot.provenance.sessionPath, sessionPath)
  assert.equal(fetchSnapshot.provenance.entryId, 't3')
  const searchSnapshot = JSON.parse(await readFile(store.page({ query: 'example.org/photos' }).items[0].archivedPath, 'utf8'))
  assert.equal(searchSnapshot.query, 'photos 100%')
  assert.equal(searchSnapshot.excerpt, 'Useful source text')
  await rm(attachment); await rm(delivery)
  assert.deepEqual(await readFile(savedFiles[0].archivedPath), textBytes, 'original deletion cannot invalidate the copy')
  assert.deepEqual(await store.previewText(savedFiles[0].id), { text: textBytes.toString('utf8'), truncated: false }, 'thumbnails decode actual retained bytes after the source is removed')
  assert.equal(await store.previewText(files.find(item => item.storage === 'missing').id), null, 'unavailable copies never fall back to reading a source path')
  assert.equal(await store.previewText(imageItems[0].id), null, 'image bytes never enter a text thumbnail')
  const used = store.status().usedBytes
  await store.scanFile(sessionPath, true)
  assert.equal(store.status().usedBytes, used)
  assert.equal(store.status().total, first.length, 'repeated history scans are idempotent')
  const unknownPresent = collectMessage({ id: 'fake', path: '', cwd: project, title: '' }, 'entry', { role: 'toolResult', toolName: 'present', toolCallId: 'unmatched', content: [], details: { kind: 'pith-present-v1', files: [{ path: missing, size: 100 }] } }, new Map())
  assert.deepEqual(unknownPresent, [], 'an unmatched present result cannot invent a delivery')
  const refSession = { id: 'ref', path: sessionPath, cwd: project, title: 'References' }
  const references = collectMessage(refSession, 'references', { role: 'assistant', timestamp: 25, content: [{ type: 'text', text: '[Code](<' + delivery + ':1886>) [File](<' + delivery + '>) [Source](https://source.example.org/)' }] }, new Map())
  assert.equal(references.length, 1, 'local reply links with or without line anchors never become library files')
  assert.equal(references[0].kind, 'web')
  assert.deepEqual(collectTool(refSession, 'read-image', 25, 'read', { path: 'image.png' }, { content: [{ type: 'text', text: 'Read output' }, image] }), [], 'ordinary image inspection creates no duplicate library image')
  assert.deepEqual(collectTool(refSession, 'edited', 25, 'edit', {}, { details: { path: delivery }, content: [] }), [], 'editing alone does not deliver a file')
  const unnamed = collectMessage(refSession, 'inline', { role: 'user', timestamp: 26, content: [{ type: 'text', text: 'Two pictures' }, image, { type: 'text', text: 'More prose' }, image] }, new Map())
  assert.deepEqual(unnamed.map(item => [item.imageLabel, item.imageNumber]), [['attachment', 1], ['attachment', 2]], 'unnamed pictures use source labels and image-only numbering')
  assert.equal(collectMessage(refSession, 'named', { role: 'user', content: [{ ...image, name: 'sample photo.png' }] }, new Map())[0].name, 'sample photo.png')
  const fetched = collectTool(refSession, 'fetch-links', 27, 'web_fetch', { url: 'https://packages.example.org/' }, { content: [{ type: 'text', text: '[natives](packages/natives) [walker](crates/pi-walker) [report](<' + delivery + '>)' }], details: { path: delivery, files: [delivery] } })
  assert(fetched.length && fetched.every(item => item.kind === 'web'), 'fetch result paths and relative repository links never declare local files')
  assert.deepEqual(collectTool(refSession, 'generated-path', 27, 'image_gen', {}, { details: { path: delivery }, content: [] }), [], 'an arbitrary generated file path needs an explicit delivery or attachment')
  const urlOnly = libraryDownload(refSession, delivery, 'https://downloads.example.org/report', 28, 'receipt')
  assert.equal(urlOnly[0].kind, 'web'); assert(!urlOnly[0].originalPath, 'browser downloads retain their URL, without becoming local library files')
  const presented = (session, entryId, path, timestamp) => collectTool(session, entryId, timestamp, 'present', { files: [{ path }] }, { content: [], details: { kind: 'pith-present-v1', files: [{ path, size: 0 }] } })

  const otherSession = { id: 'chat-two', path: join(sessionsDir, 'two', 'chat.jsonl'), cwd: otherProject, title: 'Other project' }
  const sameBytes = join(otherProject, 'different-extension.bin')
  await writeFile(sameBytes, textBytes)
  await store.collect(presented(otherSession, 'same', sameBytes, 30))
  assert.equal(store.status().usedBytes, used, 'content deduplication crosses filename extensions and projects')
  assert.equal(store.page({ project: otherProject }).total, 1)
  assert.equal(store.page({ project }).total, first.length)
  assert.equal(store.status().projects.length, 2, 'same project basename never merges distinct full paths')
  const thumbnailText = join(otherProject, 'thumbnail text.txt'), thumbnailPdf = join(otherProject, 'same text.pdf')
  const longText = Buffer.from('Content preview\n' + '\u4e2d'.repeat(20000))
  await writeFile(thumbnailText, longText); await writeFile(thumbnailPdf, longText)
  await store.collect(presented(otherSession, 'thumbnail-text', thumbnailText, 30))
  await store.collect(presented(otherSession, 'thumbnail-pdf', thumbnailPdf, 30))
  const textItem = store.page({ query: 'thumbnail text.txt' }).items[0], pdfItem = store.page({ query: 'same text.pdf' }).items[0]
  assert.equal(textItem.archivedPath, pdfItem.archivedPath, 'thumbnail dispatch respects original format even when content dedup shares a different suffix')
  const thumbnail = await store.previewText(textItem.id)
  assert(thumbnail.truncated && Buffer.byteLength(thumbnail.text) <= 16 * 1024)
  assert(thumbnail.text.startsWith('Content preview\n') && !thumbnail.text.includes('\ufffd'), 'a capped UTF-8 preview never appends a broken partial character')
  assert.equal(await store.previewText(pdfItem.id), null, 'the shared routing gate excludes PDFs even if their retained object has a text suffix')
  await store.remove(textItem.id); await store.remove(pdfItem.id)
  assert.equal(await store.previewText(textItem.id), null, 'removed resources cannot re-read a retained thumbnail')
  const big = join(otherProject, 'large.pdf'), bigBytes = Buffer.alloc(1024 ** 2 + 1, 42)
  await writeFile(big, bigBytes)
  const largeDelivery = presented(otherSession, 'big', big, 31)
  await store.collect(largeDelivery)
  assert.equal(store.page({ query: 'large.pdf' }).items[0].storage, 'limit')
  assert(store.status().usedBytes <= options.preferences.maxBytes)
  await store.configure({ ...options.preferences, maxBytes: 3 * 1024 ** 2 }, directory)
  await store.retryUnsaved()
  const bigItem = store.page({ query: 'large.pdf' }).items[0]
  assert.equal(bigItem.storage, 'saved', 'delivered files retry after quota increases')
  assert.deepEqual(await readFile(bigItem.archivedPath), bigBytes)
  await store.configure(options.preferences, directory)
  assert(store.status().usedBytes > options.preferences.maxBytes, 'lowering quota retains existing copies')
  const invalid = collectTool(otherSession, 'invalid-image', 32, 'image_gen', {}, { content: [{ type: 'image', data: 'not-base64', mimeType: 'image/png' }] })
  await store.collect(invalid)
  assert.equal(store.page({ query: 'image_gen' }).items[0].storage, 'invalid')
  assert(!store.page({ kind: 'image', hideUnavailable: true }).items.some(item => item.storage !== 'saved'), 'invalid and missing images are hidden by the same indexed filter')
  const nested = collectTool(otherSession, 'nested:parent/1', 33, 'web_fetch', { url: 'https://nested.example.org/' }, { content: [{ type: 'text', text: 'Nested tool returned text' }] })
  await store.configure({ ...options.preferences, maxBytes: 4 * 1024 ** 2 }, directory)
  await store.collect(nested)
  assert.equal(store.page({ query: 'nested.example.org' }).items[0].storage, 'saved')
  const pathImage = join(otherProject, 'path attachment.png'), vectorImage = join(otherProject, 'delivered drawing.svg')
  await writeFile(pathImage, png)
  await writeFile(vectorImage, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 210"><rect width="90" height="210"/></svg>')
  await store.collect(collectMessage(otherSession, 'path-image', { role: 'user', timestamp: 34, content: [{ type: 'text', text: '<file path="' + pathImage + '">Attached image</file>' }] }, new Map()))
  await store.collect(presented(otherSession, 'vector-image', vectorImage, 35))
  assert.deepEqual([store.page({ query: 'path attachment.png' }).items[0].imageWidth, store.page({ query: 'path attachment.png' }).items[0].imageHeight], [32, 56], 'local image attachments also reserve their intrinsic dimensions')
  assert.deepEqual([store.page({ query: 'delivered drawing.svg' }).items[0].imageWidth, store.page({ query: 'delivered drawing.svg' }).items[0].imageHeight], [90, 210], 'delivered vector images reserve a viewBox-based frame before decoding')
  const namedImage = collectTool(otherSession, 'named-image', 36, 'browser_screenshot', {}, { content: [{ ...image, name: 'browser_screenshot-homepage.png' }] })[0]
  await store.collect([namedImage])

  const projectlessPath = join(sessionsDir, 'two', 'projectless.jsonl')
  await writeFile(projectlessPath, [{ type: 'session', id: 'projectless', cwd: workspace }, { type: 'message', id: 'user', message: { role: 'user', timestamp: 40, content: [image] } }].map(v => JSON.stringify(v)).join('\n') + '\n')
  await store.scanFile(projectlessPath)
  assert.equal(store.page({ project: null }).total, 1)
  assert(!store.status().projects.some(item => item.path === workspace), 'the internal workspace never becomes a project')
  const appended = { type: 'message', id: 'a2', message: { role: 'assistant', timestamp: 41, stopReason: 'stop', content: [{ type: 'text', text: '[Reference](https://reference.example.org/)' }] } }
  await appendFile(sessionPath, JSON.stringify(appended).slice(0, -1))
  await store.scanFile(sessionPath)
  assert.equal(store.page({ query: 'reference.example.org' }).total, 0, 'an in-flight JSONL tail is not indexed')
  await appendFile(sessionPath, '}\n')
  await store.scanFile(sessionPath)
  assert.equal(store.page({ query: 'reference.example.org' }).total, 1, 'the completed tail is captured on the next append')
  const batch = Array.from({ length: 150 }, (_, index) => collectTool(otherSession, 'query-' + index, 50, 'web_search', { query: 'term ' + index }, { content: [] })[0])
  await store.collect(batch)
  const ids = new Set(); let before
  do {
    const page = store.page({ query: 'term', hideUnavailable: true, limit: 17, ...(before ? { before } : {}) })
    for (const item of page.items) { assert(!ids.has(item.id)); ids.add(item.id) }
    before = page.next
  } while (before)
  assert.equal(ids.size, 150, 'query-only records have a saved JSON source record even without returned text or a URL')
  const queryOnly = store.page({ query: 'term 149' }).items[0]
  const querySnapshot = JSON.parse(await readFile(queryOnly.archivedPath, 'utf8'))
  assert.equal(querySnapshot.query, 'term 149'); assert.equal(querySnapshot.excerpt, '')
  assert.equal(querySnapshot.url, undefined, 'a saved query never invents a result URL')
  await store.collect(Array.from({ length: 150 }, (_, index) => collectTool(otherSession, 'reachable-' + index, 50, 'web_fetch', { url: 'https://term.example.org/' + index }, { content: [] })[0]))
  before = undefined; ids.clear()
  do {
    const page = store.page({ query: 'term', hideUnavailable: true, limit: 17, ...(before ? { before } : {}) })
    for (const item of page.items) { assert(!ids.has(item.id)); ids.add(item.id) }
    before = page.next
  } while (before)
  assert.equal(ids.size, 300, 'source records and usable URLs remain visible; filtered cursor pagination loses no timestamp ties')
  await assert.rejects(async () => store.page({ kind: 'unknown' }))
  await assert.rejects(async () => store.page({ hideUnavailable: 'yes' }))

  const moved = join(temp, 'moved', 'pith-library')
  const occupied = join(temp, 'occupied')
  await mkdir(occupied); await writeFile(join(occupied, 'keep.txt'), 'user file')
  await assert.rejects(store.configure(options.preferences, occupied), /directory/)
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'user file')
  const copiedReport = store.page({ query: 'report.txt' }).items.find(item => item.storage === 'saved').archivedPath
  const damaged = Buffer.from(textBytes); damaged[0] ^= 1
  await writeFile(copiedReport, damaged)
  const failedTarget = join(temp, 'failed-move')
  await assert.rejects(store.configure(options.preferences, failedTarget), /source-changed/, 'a bad digest aborts migration before switching directories')
  assert.equal(store.status().directory, await realpath(directory))
  assert.equal((await readdir(join(failedTarget, 'objects'))).length, 0, 'failed migration reclaims incomplete target copies')
  await writeFile(copiedReport, textBytes)
  await store.configure({ ...options.preferences, maxBytes: 4 * 1024 ** 2 }, moved)
  const movedItem = store.page({ query: 'large.pdf' }).items[0]
  assert(movedItem.archivedPath.startsWith(await realpath(moved)))
  assert.deepEqual(await readFile(movedItem.archivedPath), bigBytes)
  assert.equal((await readdir(join(directory, 'objects'))).length, 0, 'successful migration releases old copies')
  await store.remove(movedItem.id)
  assert.equal(await store.archivedFile(movedItem.id), null)
  assert.deepEqual(await readFile(big), bigBytes, 'deletion never touches source files')
  await store.collect(largeDelivery)
  assert.equal(store.page({ query: 'large.pdf' }).total, 0, 'deletion tombstones survive replay')
  await store.configure({ ...options.preferences, enabled: false }, moved)
  await store.collect(collectTool(otherSession, 'paused', 80, 'web_search', { query: 'not collected' }, { content: [] }))
  assert.equal(store.page({ query: 'not collected' }).total, 0)
  const total = store.status().total, finalBytes = store.status().usedBytes
  await store.close(); store = null
  // Simulate the initial collector's persisted mistakes. Upgrades must remove
  // those records, retain shared objects and invalidate unchanged history.
  const oldDb = new DatabaseSync(options.databasePath)
  const oldImage = imageItems[0], obsoleteIds = ['old-citation', 'old-read', 'old-only', 'old-download', 'old-download-image'].map(key => createHash('sha256').update(key).digest('hex'))
  const oldOnlyBytes = Buffer.from('obsolete local citation copy'), oldOnlyName = createHash('sha256').update(oldOnlyBytes).digest('hex') + '.ts'
  await writeFile(join(moved, 'objects', oldOnlyName), oldOnlyBytes)
  oldDb.prepare('INSERT INTO blobs VALUES (?,?)').run(oldOnlyName, oldOnlyBytes.length)
  for (const [index, id] of obsoleteIds.entries()) {
    const metadata = { ...oldImage, id, source: index === 1 ? 'tool-image' : index >= 3 ? 'download' : 'link', kind: index === 1 || index === 4 ? 'image' : 'file', toolName: index === 1 ? 'read' : undefined, name: index === 1 ? 'read-2.png' : index >= 3 ? 'natives' : 'report.ts:1886' }
    oldDb.prepare('INSERT INTO resources(id,kind,project,session_path,timestamp,metadata,search,blob,storage,size) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, metadata.kind, metadata.project, metadata.sessionPath, metadata.timestamp, JSON.stringify(metadata), metadata.name, index === 2 ? oldOnlyName : oldImage.archivedPath.split('/').at(-1), 'saved', index === 2 ? oldOnlyBytes.length : oldImage.size)
  }
  oldDb.prepare("UPDATE meta SET value='2' WHERE key='collectionVersion'").run()
  oldDb.prepare("UPDATE resources SET metadata=json_remove(json_set(metadata,'$.name','image-2.png'),'$.imageLabel','$.imageWidth','$.imageHeight') WHERE id=?").run(imageItems.find(item => item.source === 'attachment').id)
  oldDb.prepare("UPDATE resources SET metadata=json_remove(metadata,'$.imageWidth','$.imageHeight') WHERE id=?").run(namedImage.id)
  oldDb.close()
  store = await LibraryStore.open({ ...options, preferences: { ...options.preferences, enabled: false } })
  assert.equal(store.status().total, total)
  assert.equal(store.status().usedBytes, finalBytes)
  assert.equal(store.page({ kind: 'image' }).items.find(item => item.sessionId === 'chat-one' && item.source === 'attachment').imageLabel, 'attachment', 'old unnamed images receive source labels even while collection is paused')
  assert.equal(store.page({ kind: 'image' }).items.find(item => item.sessionId === 'chat-one' && item.source === 'attachment').imageHeight, 56, 'legacy archived images obtain dimensions without needing their original session or file')
  assert.equal(store.page({ query: 'browser_screenshot-homepage.png' }).items[0].imageLabel, undefined, 'collection upgrades retain real inline filenames that happen to start with a tool name')
  assert(!store.page({}).items.some(item => obsoleteIds.includes(item.id)), 'obsolete code citations and read images are removed from existing libraries')
  await assert.rejects(stat(join(moved, 'objects', oldOnlyName)), /ENOENT/, 'only an unreferenced managed copy is reclaimed')
  assert.deepEqual(await readFile(store.page({ kind: 'image' }).items.find(item => item.toolName === 'browser_screenshot').archivedPath), Buffer.from(png), 'a shared screenshot copy survives removal of read records')
  assert.equal(store.status().directory, await realpath(moved), 'migration recovery uses its durable location pointer')
  for (const name of await readdir(join(moved, 'objects'))) {
    const bytes = await readFile(join(moved, 'objects', name))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), name.slice(0, 64))
    assert((await stat(join(moved, 'objects', name))).isFile())
  }
  await store.close(); store = null
  const offline = join(temp, 'offline-archive')
  await rename(moved, offline)
  try {
    await assert.rejects(LibraryStore.open(options), /ENOENT/, 'an unavailable existing archive does not become an empty replacement')
    await assert.rejects(stat(moved), /ENOENT/)
  } finally { await rename(offline, moved) }
  store = await LibraryStore.open(options)
  assert.equal(store.status().usedBytes, finalBytes, 'reconnecting the archive preserves retained references')
  await assert.rejects(store.clear('invalid-kind'), /library-invalid/)
  await assert.rejects(store.clear(undefined), /library-invalid/)
  await store.configure({ ...options.preferences, maxBytes: 4 * 1024 ** 2 }, moved)
  const sharedImageFile = join(otherProject, 'shared image.bin')
  await writeFile(sharedImageFile, png)
  const sharedImageDelivery = presented(otherSession, 'shared-image-file', sharedImageFile, 90)
  await store.collect(sharedImageDelivery)
  const imageCopy = store.page({kind:'image'}).items.find(item => item.toolName === 'browser_screenshot').archivedPath
  const categories = {file:store.page({kind:'file'}).total,image:store.page({kind:'image'}).total,web:store.page({kind:'web'}).total}
  assert(categories.file>0&&categories.image>0&&categories.web>0)
  assert.equal(await store.clear('file'),categories.file,'bulk clear covers every project and unavailable record')
  assert.equal(store.page({kind:'file'}).total,0)
  assert.equal(store.page({kind:'image'}).total,categories.image)
  assert.equal(store.page({kind:'web'}).total,categories.web)
  assert.deepEqual(await readFile(imageCopy),Buffer.from(png),'a copy shared with another category survives clear')
  assert.deepEqual(await readFile(sharedImageFile),Buffer.from(png),'clear never touches source files')
  await store.collect(sharedImageDelivery);await store.scanFile(sessionPath,true)
  assert.equal(store.page({kind:'file'}).total,0,'bulk deletion tombstones prevent replay')
  const webCount=store.page({kind:'web'}).total
  assert.equal(await store.clear('web'),webCount)
  assert.equal(store.page({kind:'image'}).total,categories.image)
  assert.equal(await store.clear('image'),categories.image)
  assert.equal(store.status().total,0)
  assert.equal(store.status().usedBytes,0,'the final category releases all unshared objects')
  assert.equal((await readdir(join(moved,'objects'))).length,0)
  await store.close();store=await LibraryStore.open(options)
  await store.scanFile(sessionPath,true)
  assert.equal(store.status().total,0,'bulk tombstones remain durable across restart and recollection')
  await store.close(); store = null

  // Rebuild existing Web records using index fields only. The JSON archive
  // also works when collection is paused and the source session has vanished.
  const structuredDirectory = join(temp, 'structured-archive')
  const structuredOptions = { ...options, databasePath: join(temp, 'structured.sqlite'), directory: structuredDirectory, defaultDirectory: structuredDirectory }
  store = await LibraryStore.open(structuredOptions)
  const sourceSession = { id: 'structured', path: join(temp, 'deleted-source.jsonl'), cwd: null, title: 'Structured sources' }
  const source = collectTool(sourceSession, 'source', 100, 'web_fetch', { url: 'https://user:password@safe.example.org/path#anchor', headers: { authorization: 'request-secret' } }, {
    content: [{ type: 'text', text: 'Quotes: "hello"\nTraditional: 網路資料\n' + 'x'.repeat(20_000) }],
    details: { headers: { authorization: 'response-secret' }, auth: { token: 'auth-secret' } }
  })[0]
  const snapshotBytes = libraryWebSnapshotBytes(source)
  const sameSnapshotText = join(otherProject, 'snapshot-copy.txt')
  await writeFile(sameSnapshotText, snapshotBytes)
  await store.collect(presented(otherSession, 'same-snapshot', sameSnapshotText, 101))
  await store.collect([{ ...source, excerpt: '' }])
  const referenceFirstPath = store.page({ kind: 'web' }).items[0].archivedPath
  await store.collect([source])
  const sourceItem = store.page({ kind: 'web' }).items[0]
  assert(sourceItem.archivedPath.endsWith('.json'), 'deduplication with a text attachment cannot change the web snapshot format')
  const sourceSnapshot = JSON.parse(await readFile(sourceItem.archivedPath, 'utf8'))
  assert.equal(sourceSnapshot.url, 'https://safe.example.org/path')
  assert.equal(sourceSnapshot.excerpt.length, 16_384, 'the JSON snapshot retains the bounded excerpt')
  assert(sourceSnapshot.excerpt.startsWith('Quotes: "hello"\nTraditional: 網路資料\n'), 'JSON round-trips quotes, newlines and Unicode')
  assert.equal(sourceSnapshot.provenance.project, null, 'projectless provenance never exposes an internal workspace as the project')
  assert(!/request-secret|response-secret|auth-secret|password/.test(snapshotBytes.toString('utf8')), 'raw request/result credentials are excluded')
  await assert.rejects(stat(referenceFirstPath), /ENOENT/, 'a returned body replaces a reference-only snapshot and releases its unshared object')
  await store.collect([{ ...source, excerpt: '' }])
  assert.deepEqual(await readFile(store.page({ kind: 'web' }).items[0].archivedPath), snapshotBytes, 'parameter-only replay cannot erase returned evidence')
  const reference = libraryDownload(sourceSession, 'report.pdf', 'https://download.example.org/report', 102, 'source')[0]
  await store.collect([reference])
  const removed = collectTool(sourceSession, 'removed', 103, 'web_fetch', { url: 'https://removed.example.org/' }, {})[0]
  await store.collect([removed]); await store.remove(removed.id)
  await store.close(); store = null
  const structuredDb = new DatabaseSync(structuredOptions.databasePath)
  // These bytes are deliberately not in the old layout: there is no text
  // compatibility parser. Retained index fields supply the new document.
  const oldText = Buffer.from('Unstructured old snapshot'), oldTextName = createHash('sha256').update(oldText).digest('hex') + '.txt'
  await writeFile(join(structuredDirectory, 'objects', oldTextName), oldText)
  structuredDb.prepare('INSERT INTO blobs VALUES (?,?)').run(oldTextName, oldText.length)
  structuredDb.prepare('UPDATE resources SET blob=?,storage=\'saved\',size=? WHERE id=?').run(oldTextName, oldText.length, source.id)
  structuredDb.prepare('UPDATE resources SET blob=NULL,storage=\'metadata\',size=0 WHERE id=?').run(reference.id)
  structuredDb.prepare("DELETE FROM meta WHERE key='webSnapshotSchema'").run()
  structuredDb.close()
  store = await LibraryStore.open({ ...structuredOptions, preferences: { ...options.preferences, enabled: false } })
  const rebuilt = store.page({ kind: 'web' }).items
  assert.equal(rebuilt.length, 2, 'format rebuild preserves deletion tombstones')
  assert(rebuilt.every(item => item.storage === 'saved' && item.archivedPath.endsWith('.json')), 'every existing web source adopts JSON, including references without text')
  assert.deepEqual(JSON.parse(await readFile(rebuilt.find(item => item.id === source.id).archivedPath, 'utf8')), sourceSnapshot, 'rebuild works from retained fields without a session or text parser')
  const referenceSnapshot = JSON.parse(await readFile(rebuilt.find(item => item.id === reference.id).archivedPath, 'utf8'))
  assert.equal(referenceSnapshot.url, 'https://download.example.org/report'); assert.equal(referenceSnapshot.excerpt, '')
  await assert.rejects(stat(join(structuredDirectory, 'objects', oldTextName)), /ENOENT/, 'unreferenced text snapshots are released')
  assert.deepEqual(await readFile(store.page({ kind: 'file' }).items[0].archivedPath), snapshotBytes, 'rebuild retains objects referenced by another category')
  const rebuiltBytes = store.status().usedBytes
  await store.close(); store = await LibraryStore.open(structuredOptions)
  assert.equal(store.status().usedBytes, rebuiltBytes, 'JSON source records and byte accounting remain stable across restart')
  // Query-only sources participate in quota and retry just like excerpts.
  const pendingSource = collectTool(sourceSession, 'pending-body', 104, 'web_fetch', { url: 'https://pending.example.org/' }, {})[0]
  await store.collect([pendingSource])
  const pendingCopy = store.page({ query: 'pending.example.org' }).items[0].archivedPath
  const pendingBytes = await readFile(pendingCopy)
  const quotaFill = join(otherProject, 'quota-fill.bin')
  await writeFile(quotaFill, Buffer.alloc(options.preferences.maxBytes - store.status().usedBytes, 42))
  await store.collect(presented(otherSession, 'quota-fill', quotaFill, 104))
  assert.equal(store.status().usedBytes, options.preferences.maxBytes)
  await store.collect([{ ...pendingSource, excerpt: 'Returned later while the archive is full' }])
  assert.equal(store.page({ query: 'pending.example.org' }).items[0].storage, 'limit')
  assert.deepEqual(await readFile(pendingCopy), pendingBytes, 'quota failure keeps the preceding physical copy until its replacement succeeds')
  const limitSource = collectTool(sourceSession, 'query-limit', 104, 'web_search', { query: 'capacity source' }, {})
  await store.collect(limitSource)
  assert.equal(store.page({ query: 'capacity source' }).items[0].storage, 'limit')
  await store.configure({ ...options.preferences, maxBytes: 2 * options.preferences.maxBytes }, structuredDirectory); await store.retryUnsaved()
  assert.equal(store.page({ query: 'capacity source' }).items[0].storage, 'saved', 'metadata-only source JSON retries after increasing capacity')
  const completedSource = store.page({ query: 'pending.example.org' }).items[0]
  assert.equal(JSON.parse(await readFile(completedSource.archivedPath, 'utf8')).excerpt, 'Returned later while the archive is full', 'retry archives the returned evidence retained in the index')
  await assert.rejects(stat(pendingCopy), /ENOENT/)
  await store.close(); store = null

  // Exercise production PiManager subscriptions, including result bodies that
  // the SDK deliberately omits from its historical nested-call records.
  fixture = await createPlanFixture({ withLibrary: true, extensionFactories: [createCodemodeExtension(), pi => {
    pi.registerTool(defineTool({ name: 'web_fetch', label: 'Web fetch', description: 'Offline web fixture', parameters: Type.Object({ url: Type.String() }),
      async execute(_id, args) { return { content: [{ type: 'text', text: 'Nested returned source content' }, image], details: { url: args.url } } } }))
  }] })
  await fixture.managed.lifecyclePromise; await fixture.library.status()
  fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), 'codemode', 'web_fetch'])
  const liveFile = join(fixture.project, 'live report.txt')
  await writeFile(liveFile, 'Live delivered bytes')
  const canonicalLiveFile = await realpath(liveFile)
  const firstRequest = fixture.requests.length + 1
  fixture.setRespond(index => index === firstRequest ? [
    { type: 'toolCall', id: 'live-present', name: 'present', arguments: { files: [{ path: liveFile }] } },
    { type: 'toolCall', id: 'live-code', name: 'codemode', arguments: { code: 'const r = await tools.web_fetch({url: "https://live.example.org/"}); text(r);' } }
  ] : [{ type: 'text', text: 'Complete' }])
  await fixture.session.prompt('Collect live resources', { images: [image] })
  let live
  for (let attempt = 0; attempt < 200; attempt++) {
    live = await fixture.library.page({})
    if (live.items.some(item => item.originalPath === canonicalLiveFile) && live.items.some(item => item.toolName === 'web_fetch' && item.kind === 'image') && live.items.some(item => item.source === 'attachment')) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const delivered = live.items.find(item => item.originalPath === canonicalLiveFile)
  assert(delivered && delivered.storage === 'saved', 'committed production present results are archived live')
  await rm(liveFile)
  assert.equal(await readFile(delivered.archivedPath, 'utf8'), 'Live delivered bytes')
  assert(live.items.some(item => item.kind === 'image' && item.toolName === 'web_fetch'), 'nested images are collected from actual successful SDK events')
  assert(live.items.some(item => item.url === 'https://live.example.org/' && item.excerpt.includes('Nested returned source content')), 'nested fetch bodies remain available rather than only their arguments')
  assert(live.items.some(item => item.source === 'attachment'), 'production committed user images enter the same library')
  // A generated vector's inline PNG is a preview: the archived delivery must
  // retain the original vector, its filename and its tool-result identity.
  const generatedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="56"><rect width="32" height="56" fill="red"/></svg>'
  const generatedPath = join(project, 'generated original.svg')
  await writeFile(generatedPath, generatedSvg)
  store = await LibraryStore.open({ ...options, databasePath:join(temp,'generated.sqlite'), directory:join(temp,'generated-archive'), defaultDirectory:join(temp,'generated-archive') })
  const receipt = { isError:true, content:[{type:'text',text:'Second output failed'}, image], details:{
    kind:'pi-app-image', action:'generate', model:'fixture/image', protocol:'native', prompt:'a rectangle', error:'Second output failed',
    files:[{path:generatedPath,mimeType:'image/svg+xml',size:Buffer.byteLength(generatedSvg),width:32,height:56}]
  } }
  const generated = collectTool(sourceSession,'generated-receipt',200,'image',{},receipt)
  await store.collect(generated)
  const archivedGenerated=store.page({kind:'image'}).items[0]
  assert.equal(archivedGenerated.originalPath,generatedPath)
  assert.equal(archivedGenerated.name,'generated original.svg')
  assert.equal(archivedGenerated.imageLabel,'generated')
  assert.equal(await readFile(archivedGenerated.archivedPath,'utf8'),generatedSvg)
  const legacy=collectTool(sourceSession,'generated-receipt',200,'image',{}, {content:[{type:'text',text:'done'},image]})
  assert.equal(generated[0].id,legacy[0].id,'receipt enrichment preserves historical inline-image identity')
  await store.remove(generated[0].id)
  await store.collect(generated)
  assert.equal(store.page({kind:'image'}).items.length,0,'recollection preserves user deletion')
  console.log('PASS library: real SDK capture, explicit delivery policy, image labels, JSON web sources and index rebuild, nested results, exact copies, deduplication, projects, quotas, retry, deletion and category tombstones, pagination, migration and restart')
} finally { await fixture?.close(); await store?.close(); await rm(temp, { recursive: true, force: true }) }
