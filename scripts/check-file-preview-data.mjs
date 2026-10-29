/** Bounded binary readers, real worker cancellation, structured grammars and
 * legacy decoding. Fixtures are private and their original bytes are checked. */
import assert from 'node:assert/strict'
import { mkdtemp, symlink, writeFile, readFile, readdir, rm, mkdir, copyFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { previewFixtures, zipFixture, tarFixture, gbkBytes, big5Bytes, gbkText, big5Text, gbkArchiveFolder, gbkArchiveImage, gbkImageBytes, big5ArchiveFolder } from './lib/file-preview-fixtures.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'pith-file-data-'))
const project = join(temp, 'project')
let service
try {
  await previewFixtures(project)
  await symlink(join(repo, 'node_modules'), join(temp, 'node_modules'))
  await build({ entryPoints: { reader: join(repo, 'src/main/file-preview/worker.ts'), service: join(repo, 'src/main/file-preview/service.ts'), text: join(repo, 'src/main/file-browser.ts'), table: join(repo, 'src/main/table.ts') }, outdir: temp, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  await build({ entryPoints: [join(repo, 'src/renderer/src/lib/structured-parse.ts')], outfile: join(temp, 'parse.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { readBinaryPreview } = await import(pathToFileURL(join(temp, 'reader.mjs')))
  const { FilePreviewService } = await import(pathToFileURL(join(temp, 'service.mjs')))
  const { readFileDocument, listFileDirectory } = await import(pathToFileURL(join(temp, 'text.mjs')))
  const { readTableStat, readTableSlice } = await import(pathToFileURL(join(temp, 'table.mjs')))
  const { parseStructured } = await import(pathToFileURL(join(temp, 'parse.mjs')))
  const originals = new Map(await Promise.all((await readdir(project)).map(async name => [name, await readFile(join(project, name))])))
  const read = (name, query) => readBinaryPreview({ path: join(project, name), query })
  const value = result => { assert.ok(result.value, JSON.stringify(result)); return result.value }
  for (const name of ['bundle.zip', 'bundle.tar', 'bundle.tar.gz', 'note.txt.gz']) {
    const index = value(await read(name, { type: 'archive-index' }))
    const entry = index.entries.find(item => item.readable && item.kind === 'file')
    const preview = value(await read(name, { type: 'archive-entry', entry: entry.id, revision: index.revision }))
    assert.match(preview.text, name === 'note.txt.gz' ? /compressed text/ : /answer = 42/)
    if (name.includes('tar')) {
      assert.equal(index.entries.find(item => item.name === '../escape.txt').readable, false)
      assert.equal(index.entries.find(item => item.name === 'shortcut').readable, false)
    }
  }
  const zip = value(await read('bundle.zip', { type: 'archive-index' }))
  const image = zip.entries.find(item => item.name === '图片.png')
  assert.equal(value(await read('bundle.zip', { type: 'archive-entry', entry: image.id, revision: zip.revision })).image.mimeType, 'image/png')
  const link = zip.entries.find(item => item.name === 'pointer')
  assert.equal(link.readable, false)
  assert.equal((await read('bundle.zip', { type: 'archive-entry', entry: link.id, revision: zip.revision })).error, 'unsupported')
  const corrupt = value(await read('corrupt.zip', { type: 'archive-index' }))
  assert.equal((await read('corrupt.zip', { type: 'archive-entry', entry: '0', revision: corrupt.revision })).error, 'invalid')
  const encrypted = value(await read('encrypted.zip', { type: 'archive-index' }))
  assert.equal(encrypted.entries[0].readable, false)
  assert.equal((await read('encrypted.zip', { type: 'archive-entry', entry: '0', revision: encrypted.revision })).error, 'unsupported')
  for (const [file, names] of [
    ['legacy-utf8.zip', [gbkArchiveFolder + '/', gbkArchiveFolder + '/' + gbkArchiveImage, gbkArchiveFolder + '/data/数据.csv']],
    ['legacy-gbk.zip', [gbkArchiveFolder + '/', gbkArchiveFolder + '/' + gbkArchiveImage, gbkArchiveFolder + '/data/数据.csv', '短.txt', '图.txt', 'ͼ.txt', 'ͼ-field.txt']],
    ['legacy-big5.zip', [big5ArchiveFolder + '/教學操作說明與設定資料.txt', big5ArchiveFolder + '/許功蓋.txt']]
  ]) {
    const index = value(await read(file, { type: 'archive-index' }))
    assert.deepEqual(index.entries.map(entry => entry.name), names, 'legacy names decode before separators')
    for (const entry of index.entries.filter(entry => entry.readable)) {
      const preview = value(await read(file, { type: 'archive-entry', entry: entry.id, revision: index.revision }))
      assert.equal(preview.name, entry.name, 'index and content share filename decoding')
      if (entry.name.endsWith('.png')) assert.equal(preview.image.mimeType, 'image/png')
      if (entry.name.includes('教學')) assert.equal(preview.text, big5Text)
    }
  }
  const nameCases = [
    { name: '未标记UTF-8.txt', utf8: false, expected: '未标记UTF-8.txt' },
    { name: 'café-λ.txt', utf8: false, expected: 'café-λ.txt' },
    { nameBytes: gbkImageBytes, utf8: false, expected: gbkArchiveImage },
    { nameBytes: Buffer.from('d6d02e747874', 'hex'), utf8: false, expected: '中.txt' },
    { nameBytes: Buffer.from('636166822e747874', 'hex'), utf8: false, expected: 'café.txt' },
    { nameBytes: Buffer.from('82a082a02e747874', 'hex'), utf8: false, expected: 'éáéá.txt' },
    { name: 'old.txt', utf8: false, unicodeName: '新文件名.txt', expected: '新文件名.txt' },
    { name: 'original.txt', utf8: false, unicodeName: '错误字段.txt', badNameCrc: true, expected: 'original.txt' },
    { name: 'raw.txt', utf8: false, unicodeName: Buffer.from([0xff]), expected: 'raw.txt' },
    { name: 'unsafe.txt', utf8: false, unicodeName: '../越界.txt', expected: '../越界.txt', unreadable: true },
    { nameBytes: Buffer.concat([Buffer.from('../'), gbkImageBytes]), utf8: false, expected: '../' + gbkArchiveImage, unreadable: true }
  ]
  // Isolate ambiguous short names from unrelated encoding evidence.
  for (const [i, entry] of nameCases.entries()) {
    const file = `name-${i}.zip`
    await writeFile(join(project, file), zipFixture([{ ...entry, data: 'name fixture' }]))
    const index = value(await read(file, { type: 'archive-index' }))
    assert.equal(index.entries[0].name, entry.expected)
    assert.equal(index.entries[0].readable, !entry.unreadable)
    const preview = await read(file, { type: 'archive-entry', entry: '0', revision: index.revision })
    if (entry.unreadable) assert.equal(preview.error, 'unsupported')
    else assert.equal(value(preview).name, entry.expected)
  }
  await writeFile(join(project, 'invalid-name.zip'), zipFixture([{ nameBytes: Buffer.from([0xff]), data: '' }]))
  assert.equal((await read('invalid-name.zip', { type: 'archive-index' })).error, 'invalid', 'declared UTF-8 never silently replaces invalid bytes')
  await mkdir(join(project, '作业資料夾'))
  const directory = await listFileDirectory({ cwd: project, path: project })
  assert.ok(directory.entries.some(entry => entry.name === gbkArchiveImage && entry.path === join(project, gbkArchiveImage)))
  assert.ok(directory.entries.some(entry => entry.name === '作业資料夾' && entry.directory), 'native directory names preserve Unicode')
  console.log('PASS: ZIP UTF-8/Unicode extra fields, GBK/Big5 paths and short basenames, CP437 fallback and native Unicode tree names')
  await writeFile(join(project, 'large.zip'), zipFixture([{ name: 'big.txt', data: 'a'.repeat(600000) }]))
  const large = value(await read('large.zip', { type: 'archive-index' }))
  const limited = value(await read('large.zip', { type: 'archive-entry', entry: '0', revision: large.revision }))
  assert.equal(limited.text.length, 512 * 1024); assert.equal(limited.truncated, true)
  await writeFile(join(project, 'large.tar'), await tarFixture([{ name: 'big.txt', data: 'a'.repeat(600000) }]))
  const tar = value(await read('large.tar', { type: 'archive-index' }))
  assert.equal(value(await read('large.tar', { type: 'archive-entry', entry: '0', revision: tar.revision })).truncated, true)
  await writeFile(join(project, 'many.zip'), zipFixture(Array.from({ length: 5001 }, (_, i) => ({ name: `entry-${i}.txt`, data: '' }))))
  const many = value(await read('many.zip', { type: 'archive-index' }))
  assert.equal(many.entries.length, 5000); assert.equal(many.truncated, true)
  await writeFile(join(project, 'invalid.db'), 'ordinary text, not SQLite')
  assert.equal((await read('invalid.db', { type: 'data-index' })).error, 'invalid')
  assert.equal((await read('absent.zip', { type: 'archive-index' })).error, 'missing')
  await mkdir(join(project, 'directory.zip'))
  assert.equal((await read('directory.zip', { type: 'archive-index' })).error, 'directory')
  await writeFile(join(project, 'changing.zip'), originals.get('bundle.zip'))
  const changing = value(await read('changing.zip', { type: 'archive-index' }))
  await writeFile(join(project, 'changing.zip'), originals.get('corrupt.zip'))
  assert.equal((await read('changing.zip', { type: 'archive-entry', entry: '0', revision: changing.revision })).error, 'changed')
  assert.equal(await readFile(resolve(project, '../escape.txt')).then(() => true, () => false), false, 'archive paths are never extracted')
  console.log('PASS: real ZIP/TAR/TGZ/GZ, image bytes, unsafe/link/encrypted entries, CRC errors, caps and stale revisions')

  for (const name of ['people.sqlite', 'people.parquet']) {
    const index = value(await read(name, { type: 'data-index' }))
    const table = index.tables.find(item => item.id === (name.endsWith('sqlite') ? 'people' : 'parquet'))
    assert.deepEqual(table.columns.map(item => item.name), name.endsWith('sqlite') ? ['id', 'name', 'payload'] : ['id', 'name', 'active'])
    if (name.endsWith('sqlite')) assert.ok(!index.tables.some(item => item.name === 'hidden_view'))
    else assert.equal(table.totalRows, 901)
    const first = value(await read(name, { type: 'data-rows', table: table.id, offset: 0, revision: index.revision }))
    assert.equal(first.rows.length, 300); assert.equal(first.eof, false)
    assert.equal(first.rows[0][0], '9007199254740993', '64-bit integers retain precision')
    const next = value(await read(name, { type: 'data-rows', table: table.id, offset: 300, revision: index.revision }))
    assert.equal(next.rows[0][1], 'Person 300')
    const last = value(await read(name, { type: 'data-rows', table: table.id, offset: 900, revision: index.revision }))
    assert.equal(last.rows.length, 1); assert.equal(last.eof, true)
    assert.equal((await read(name, { type: 'data-rows', table: 'unknown', offset: 0, revision: index.revision })).error, 'missing')
  }
  const widePath = join(project, 'wide.sqlite'), wide = new DatabaseSync(widePath)
  wide.exec('CREATE TABLE wide(' + Array.from({ length: 100 }, (_, i) => 'c' + i + ' TEXT').join(',') + ')')
  const insert = wide.prepare('INSERT INTO wide VALUES(' + Array(100).fill('?').join(',') + ')')
  for (let i = 0; i < 60; i++) insert.run(...Array(100).fill('x'.repeat(2000)))
  wide.close()
  const wideIndex = value(await read('wide.sqlite', { type: 'data-index' }))
  const wideRows = value(await read('wide.sqlite', { type: 'data-rows', table: 'wide', offset: 0, revision: wideIndex.revision }))
  assert.ok(wideRows.rows.length > 0 && wideRows.rows.length < 60)
  assert.ok(wideRows.rows.flat().reduce((sum, item) => sum + item.length, 0) <= 1024 * 1024)
  assert.equal(wideRows.eof, false)
  const walPath = join(project, 'wal.sqlite'), wal = new DatabaseSync(walPath)
  try {
    wal.exec('PRAGMA journal_mode=WAL; CREATE TABLE committed(value TEXT); INSERT INTO committed VALUES(\'WAL row\')')
    const before = await readFile(walPath + '-wal')
    const shm = await readFile(walPath + '-shm')
    const index = value(await read('wal.sqlite', { type: 'data-index' }))
    assert.equal(value(await read('wal.sqlite', { type: 'data-rows', table: 'committed', offset: 0, revision: index.revision })).rows[0][0], 'WAL row')
    assert.deepEqual(await readFile(walPath + '-wal'), before)
    assert.deepEqual(await readFile(walPath + '-shm'), shm, 'original shared memory remains untouched')
    await copyFile(walPath, join(project, 'detached.sqlite'))
    await copyFile(walPath + '-wal', join(project, 'detached.sqlite-wal'))
    const detached = value(await read('detached.sqlite', { type: 'data-index' }))
    assert.equal(value(await read('detached.sqlite', { type: 'data-rows', table: 'committed', offset: 0, revision: detached.revision })).rows[0][0], 'WAL row')
    assert.ok(!(await readdir(project)).includes('detached.sqlite-shm'), 'no new sidecar beside the input')
    wal.exec('INSERT INTO committed VALUES(\'next\')')
    assert.equal((await read('wal.sqlite', { type: 'data-rows', table: 'committed', offset: 0, revision: index.revision })).error, 'changed')
  } finally { wal.close() }
  await copyFile(join(project, 'people.sqlite'), join(project, 'oversize.sqlite'))
  await truncate(join(project, 'oversize.sqlite'), 128 * 1024 * 1024 + 1)
  assert.equal((await read('oversize.sqlite', { type: 'data-index' })).error, 'tooLarge')
  await copyFile(join(project, 'people.sqlite'), join(project, 'recovering.sqlite'))
  await writeFile(join(project, 'recovering.sqlite-journal'), Buffer.from('d9d505f920a163d7', 'hex'))
  assert.equal((await read('recovering.sqlite', { type: 'data-index' })).error, 'busy', 'hot rollback journals never expose uncommitted pages')
  await writeFile(join(project, 'recovering.sqlite-journal'), Buffer.alloc(32))
  assert.ok((await read('recovering.sqlite', { type: 'data-index' })).value, 'cleared persistent journals are allowed')
  console.log('PASS: SQLite table/schema selection, WAL revisions, Parquet row groups, BigInt fidelity and bounded pages')

  assert.deepEqual(parseStructured('{ // comment\n "x": 1, }', 'jsonc', false).value, { x: 1 })
  assert.deepEqual(parseStructured('{"a":1}\n{"a":2}\n{"broken":', 'jsonl', true), { value: [{ a: 1 }, { a: 2 }], records: 2, truncated: true })
  assert.deepEqual(parseStructured('{"a":1}\nbad\n', 'jsonl', false), { error: 'invalid', line: 2 })
  assert.deepEqual(parseStructured('a: 1\n---\na: 2\n', 'yaml', false).value, [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseStructured('[a]\nx = true\n', 'toml', false).value, { a: { x: true } })
  assert.deepEqual(parseStructured('<root id="2">text &amp; more</root>', 'xml', false).value, { root: { '#text': 'text & more', '@id': '2' } })
  assert.equal(parseStructured('<!DOCTYPE a [<!ENTITY x "bomb">]><a>&x;</a>', 'xml', false).error, 'invalid')
  assert.equal(parseStructured('a: &a [*a]', 'yaml', false).error, 'invalid')
  assert.equal(parseStructured('a: [bad', 'yaml', false).error, 'invalid')
  assert.equal(parseStructured('x = 1', 'toml', true).error, 'tooLarge')
  assert.equal(parseStructured('{"x":' + '['.repeat(150) + '1' + ']'.repeat(150) + '}', 'jsonc', false).error, 'tooLarge')
  for (const [name, text, encoding] of [['gbk.txt', gbkText, 'gb18030'], ['big5.txt', big5Text, 'big5']]) {
    const explicit = await readFileDocument({ cwd: project, path: name, encoding })
    assert.equal(explicit.text, text); assert.equal(explicit.encoding, encoding)
    const automatic = await readFileDocument({ cwd: project, path: name })
    assert.equal(automatic.text, text); assert.equal(automatic.encoding, encoding)
    assert.equal((await readFileDocument({ cwd: project, path: name, encoding: 'utf-8' })).error, 'binary')
  }
  await writeFile(join(project, 'short.txt'), gbkBytes.subarray(0, 2))
  assert.equal((await readFileDocument({ cwd: project, path: 'short.txt', encoding: 'gb18030' })).text, '这')
  await writeFile(join(project, 'binary.txt'), Buffer.from([0, 255, 0, 255, 2, 3, 4]))
  assert.equal((await readFileDocument({ cwd: project, path: 'binary.txt' })).error, 'binary')
  const csvRequest = { cwd: project, path: 'legacy.csv', encoding: 'gb18030' }
  assert.equal((await readTableStat(csvRequest)).size, (await readFile(join(project, 'legacy.csv'))).length)
  assert.match((await readTableSlice(csvRequest, 0)).text, /这是一个中文/)
  console.log('PASS: JSONC/JSONL/YAML/TOML/XML grammars, partial records, parser limits, GBK/Big5 auto/override and legacy CSV')

  service = new FilePreviewService(pathToFileURL(join(temp, 'reader.mjs')))
  const request = { cwd: project, path: 'bundle.zip', id: 'read', query: { type: 'archive-index' } }
  const job = service.read(1, request)
  assert.equal((await service.read(1, request)).error, 'busy')
  service.cancel(2, 'read')
  assert.equal(value(await job).type, 'archive-index', 'other owners cannot cancel a preview')
  const cancelled = service.read(1, { ...request, id: 'cancel' }); service.cancel(1, 'cancel')
  assert.equal((await cancelled).error, 'cancelled')
  const reused = service.read(1, { ...request, id: 'cancel' })
  assert.equal(value(await reused).type, 'archive-index', 'old worker teardown cannot cancel a reused request ID')
  assert.equal((await service.read(1, { ...request, id: 'invalid', query: { type: 'archive-entry', entry: 1, revision: 'x' } })).error, 'invalid')
  await service.dispose()
  const scratchBefore = (await readdir(tmpdir())).filter(name => name.startsWith('pith-file-preview-'))
  service = new FilePreviewService(pathToFileURL(join(temp, 'reader.mjs')))
  value(await service.read(4, { ...request, path: 'people.sqlite', id: 'sqlite', query: { type: 'data-index' } }))
  const opening = service.read(4, { ...request, path: 'people.sqlite', id: 'opening', query: { type: 'data-index' } })
  await service.dispose()
  assert.equal((await opening).error, 'cancelled')
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('pith-file-preview-')), scratchBefore, 'dispose reclaims private SQLite snapshots')
  assert.equal((await service.read(1, request)).error, 'cancelled')
  await writeFile(join(temp, 'slow.mjs'), 'setInterval(() => {}, 1000)')
  service = new FilePreviewService(pathToFileURL(join(temp, 'slow.mjs')))
  const jobs = Array.from({ length: 24 }, (_, i) => service.read(3, { ...request, id: 'queued-' + i }))
  assert.equal((await service.read(3, { ...request, id: 'overflow' })).error, 'busy')
  service.cancelOwner(3)
  assert.ok((await Promise.all(jobs)).every(result => result.error === 'cancelled'))
  await service.dispose()
  for (const [name, bytes] of originals) assert.deepEqual(await readFile(join(project, name)), bytes, 'preview preserves original: ' + name)
  console.log('PASS: worker IPC, scoped cancellation, admission/disposal and unchanged original bytes')
} finally {
  await service?.dispose()
  await rm(temp, { recursive: true, force: true })
}
