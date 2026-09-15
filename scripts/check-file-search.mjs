import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const directory = await mkdtemp(join(tmpdir(), 'pith-file-search-'))
try {
  await build({ entryPoints: [resolve(import.meta.dirname, '../src/renderer/src/lib/file-search.ts')], outfile: join(directory, 'search.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { searchFile, MAX_FILE_MATCHES } = await import(pathToFileURL(join(directory, 'search.mjs')))
  const defaults = { matchCase: false, wholeWord: false, regex: false }
  const search = (text, query, options = {}) => searchFile(text, query, { ...defaults, ...options })
  assert.deepEqual(search('SDK SDK sdk SDKish', 'SDK').matches.map(match => match.start), [0, 4, 8, 12])
  assert.equal(search('SDK SDK sdk SDKish', 'SDK', { matchCase: true, wholeWord: true }).matches.length, 2)
  assert.deepEqual(search('😀\r\n中文 SDK', 'SDK').matches, [{ start: 7, end: 10, line: 2, column: 3 }])
  assert.equal(search('中文 中文文 a中文 文中文', '中文', { wholeWord: true }).matches.length, 1)
  assert.equal(search('e\u0301 e', 'e', { wholeWord: true }).matches.length, 1, 'combining marks are word characters')
  assert.equal(search('𝒜𝒜 𝒜', '𝒜', { wholeWord: true }).matches.length, 1, 'astral letters retain boundaries')
  for (const query of ['foo.bar', '[SDK]', '(a+)+$', '$5', '\\']) assert.equal(search(`${query} other ${query}`, query).matches.length, 2, 'literal query escapes: ' + query)
  assert.equal(search('SDK\nsdk\nother', '^SDK$', { regex: true }).matches.length, 2)
  assert.equal(search('SDK\nsdk', 'SDK\\s+sdk', { regex: true }).matches[0].end, 7)
  assert.equal(search('abc', '[', { regex: true }).error, 'invalidRegex')
  assert.equal(search('😀a', '(?:)', { regex: true }).matches.length, 0, 'empty Unicode matches terminate')
  assert.equal(search('a'.repeat(MAX_FILE_MATCHES), 'a').limited, false)
  const limited = search('a'.repeat(MAX_FILE_MATCHES + 1), 'a')
  assert.equal(limited.matches.length, MAX_FILE_MATCHES); assert.equal(limited.limited, true)
  assert.equal(search('SDK', '').matches.length, 0)
  console.log('PASS: occurrence offsets/counts, Unicode/case/whole-word, literal escaping, multiline/invalid/empty regex and bounded results')
} finally { await rm(directory, { recursive: true, force: true }) }
