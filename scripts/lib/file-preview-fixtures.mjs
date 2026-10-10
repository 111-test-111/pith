/** Real binary fixtures shared by the preview regressions, not a test suite. */
import { Buffer } from 'node:buffer'
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pack } from 'tar-stream'
import { parquetWriteBuffer } from 'hyparquet-writer'

export function zipFixture(entries) {
  const parts = [], directory = []
  let offset = 0
  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name), raw = Buffer.from(entry.data ?? '')
    const data = deflateRawSync(raw), crc = entry.badCrc ? 123 : crc32(raw)
    const flags = (entry.utf8 === false ? 0 : 0x800) | (entry.encrypted ? 1 : 0)
    let extra = Buffer.alloc(0)
    if (entry.unicodeName !== undefined) {
      const unicode = Buffer.from(entry.unicodeName)
      extra = Buffer.alloc(9 + unicode.length)
      extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5 + unicode.length, 2); extra[4] = 1
      extra.writeUInt32LE(entry.badNameCrc ? 123 : crc32(name), 5); unicode.copy(extra, 9)
    }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26)
    parts.push(header, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 << 8 | 20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(((entry.link ? 0xa1ff : 0x81a4) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    directory.push(central, name, extra); offset += header.length + name.length + data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.reduce((size, part) => size + part.length, 0), 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...directory, end])
}
export async function tarFixture(entries) {
  const archive = pack(), chunks = []
  const reading = (async () => { for await (const chunk of archive) chunks.push(chunk) })()
  for (const entry of entries) await new Promise((resolve, reject) => archive.entry({ name: entry.name, type: entry.type ?? 'file', linkname: entry.linkname }, Buffer.from(entry.data ?? ''), error => error ? reject(error) : resolve()))
  archive.finalize(); await reading
  return Buffer.concat(chunks)
}
export const gbkText = '这是一个中文源码文件，用来检查编码识别。文件预览应该显示完整内容，包括配置、数据和文本。\n'
export const big5Text = '這是一個中文原始碼檔案，用來檢查編碼識別。檔案預覽應該顯示完整內容，包括設定、資料和文字。\n'
export const gbkBytes = Buffer.from('d5e2cac7d2bbb8f6d6d0cec4d4b4c2ebcec4bcfea3acd3c3c0b4bcecb2e9b1e0c2ebcab6b1f0a1a3cec4bcfed4a4c0c0d3a6b8c3cfd4cabecdead5fbc4dac8dda3acb0fcc0a8c5e4d6c3a1a2cafdbeddbacdcec4b1bea1a30a', 'hex')
export const big5Bytes = Buffer.from('b36fac4fa440add3a4a4a4e5adeca96cbd58c0c9aed7a141a5cea8d3c0cbac64bd73bd58c3d1a74fa143c0c9aed7b977c4fdc0b3b8d3c5e3a5dca7b9bee3a4baae65a141a55dac41b35da977a142b8eaaec6a94da4e5a672a1430a', 'hex')
export const gbkArchiveFolder = 'RStudio作业完整流程（看里面教程操作）'
export const gbkArchiveImage = '「教程」.png'
export const gbkFolderBytes = Buffer.from('5253747564696fd7f7d2b5cdead5fbc1f7b3cca3a8bfb4c0efc3e6bdccb3ccb2d9d7f7a3a9', 'hex')
export const gbkImageBytes = Buffer.from('a1b8bdccb3cca1b92e706e67', 'hex')
export const big5ArchiveFolder = '原始碼資料夾'
export async function previewFixtures(project) {
  await mkdir(project, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XzS8AAAAASUVORK5CYII=', 'base64')
  const entries = [{ name: 'src/main.ts', data: 'export const answer = 42\n' }, { name: 'settings.jsonc', data: '{ // comment\n "name": "Pith", "enabled": true,\n}' }, { name: '图片.png', data: png }, { name: 'pointer', data: 'src/main.ts', link: true }, { name: 'short.txt', data: gbkBytes.subarray(0, 2) }, { name: 'src/nested/util.ts', data: 'export const utility = true\n' }, { name: 'src/' }]
  await writeFile(join(project, 'bundle.zip'), zipFixture(entries))
  await writeFile(join(project, gbkArchiveImage), png)
  // The screenshot's πÇ/Σ glyphs reproduce UTF-8 names without ZIP's UTF-8 bit.
  await writeFile(join(project, 'legacy-utf8.zip'), zipFixture([
    { name: gbkArchiveFolder + '/', utf8: false },
    { name: gbkArchiveFolder + '/' + gbkArchiveImage, utf8: false, data: png },
    { name: gbkArchiveFolder + '/data/数据.csv', utf8: false, data: 'id,note\n1,example\n' }
  ]))
  await writeFile(join(project, 'legacy-gbk.zip'), zipFixture([
    { nameBytes: Buffer.concat([gbkFolderBytes, Buffer.from('/')]), utf8: false },
    { nameBytes: Buffer.concat([gbkFolderBytes, Buffer.from('/'), gbkImageBytes]), utf8: false, data: png },
    { nameBytes: Buffer.concat([gbkFolderBytes, Buffer.from('/data/'), Buffer.from('cafdbedd2e637376', 'hex')]), utf8: false, data: 'id,note\n1,example\n' },
    { nameBytes: Buffer.from('b6cc2e747874', 'hex'), utf8: false, data: 'short basename\n' },
    { nameBytes: Buffer.from('cdbc2e747874', 'hex'), utf8: false, data: 'ambiguous UTF-8 bytes\n' },
    { name: 'ͼ.txt', data: 'declared UTF-8\n' },
    { name: 'old.txt', utf8: false, unicodeName: 'ͼ-field.txt', data: 'declared Unicode path\n' }
  ]))
  await writeFile(join(project, 'legacy-big5.zip'), zipFixture([
    { nameBytes: Buffer.from('adeca96cbd58b8eaaec6a7a82fb1d0bec7bedea740bba1a9fabb50b35da977b8eaaec62e747874', 'hex'), utf8: false, data: big5Bytes },
    { nameBytes: Buffer.from('adeca96cbd58b8eaaec6a7a82fb35ca55cbb5c2e747874', 'hex'), utf8: false, data: 'Big5 backslash trail bytes\n' }
  ]))
  const tar = await tarFixture([{ name: 'src/main.ts', data: entries[0].data }, { name: '../escape.txt', data: 'unsafe name' }, { name: 'shortcut', type: 'symlink', linkname: 'src/main.ts' }])
  await writeFile(join(project, 'bundle.tar'), tar); await writeFile(join(project, 'bundle.tar.gz'), gzipSync(tar))
  await writeFile(join(project, 'note.txt.gz'), gzipSync('compressed text\n'))
  await writeFile(join(project, 'corrupt.zip'), zipFixture([{ name: 'bad.txt', data: 'broken crc', badCrc: true }]))
  await writeFile(join(project, 'encrypted.zip'), zipFixture([{ name: 'secret.txt', data: 'opaque', encrypted: true }]))
  await writeFile(join(project, 'config.jsonc'), '{ // comment\n "name": "Pith", "enabled": true,\n}')
  await writeFile(join(project, 'events.jsonl'), '{"event":"opened"}\n{"event":"saved","count":2}\n')
  await writeFile(join(project, 'config.yaml'), 'app:\n  name: Pith\n  enabled: true\n')
  await writeFile(join(project, 'config.toml'), '[app]\nname = "Pith"\nenabled = true\n')
  await writeFile(join(project, 'config.xml'), '<app enabled="true"><name>Pith</name></app>')
  await writeFile(join(project, 'bad.yaml'), 'a: [unclosed')
  await writeFile(join(project, 'gbk.txt'), gbkBytes); await writeFile(join(project, 'big5.txt'), big5Bytes)
  await writeFile(join(project, 'legacy.csv'), Buffer.concat([Buffer.from('id,note\n1,'), gbkBytes]))
  const database = new DatabaseSync(join(project, 'people.sqlite'))
  try {
    database.exec('CREATE TABLE people(id INTEGER, name TEXT, payload BLOB); CREATE TABLE notes(title TEXT); CREATE VIEW hidden_view AS SELECT 1;')
    const insert = database.prepare('INSERT INTO people VALUES(?,?,?)')
    database.exec('BEGIN')
    for (let i = 0; i < 901; i++) insert.run(i === 0 ? 9007199254740993n : i, 'Person ' + i, new Uint8Array([1, 2, 3]))
    database.prepare('INSERT INTO notes VALUES(?)').run('second table'); database.exec('COMMIT')
  } finally { database.close() }
  const rows = 901
  await writeFile(join(project, 'people.parquet'), Buffer.from(parquetWriteBuffer({ rowGroupSize: 400, columnData: [
    { name: 'id', type: 'INT64', data: Array.from({ length: rows }, (_, i) => 9007199254740993n + BigInt(i)) },
    { name: 'name', type: 'STRING', data: Array.from({ length: rows }, (_, i) => 'Person ' + i) },
    { name: 'active', type: 'BOOLEAN', data: Array.from({ length: rows }, (_, i) => i % 2 === 0) }
  ] })))
}
