/**
 * The SDK appends `<read-files>`/`<modified-files>` to every summary it
 * generates (`formatFileOperations`) — a convention between the SDK and the
 * model that markdown cannot render. `splitSummaryFiles` takes those sections
 * out so `SummaryRow` can draw them as file links; this checks the pure split,
 * plus a real compacted summary from disk. No Electron.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Built inside the repo so the bundle resolves this project's node_modules.
const scratch = join(repo, 'node_modules', '.cache', 'pith-summary-files')
try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'summary-files.mjs')
  await build({
    entryPoints: [join(repo, 'src/renderer/src/lib/summary-files.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle
  })
  const { splitSummaryFiles } = await import(bundle)

  // A plain summary is returned untouched: the split must never reformat prose
  // (blank lines are markdown structure, and the body is rendered as markdown).
  const prose = '## Goal\n\nShip the rewind fix.\n\n- one item\n- two items\n'
  assert.deepEqual(
    splitSummaryFiles(prose),
    { body: prose.trimEnd(), read: [], modified: [] },
    'a summary without sections is unchanged'
  )

  // The exact shape the SDK writes: two sections, one path per line, sections
  // separated from the body and from each other by a blank line.
  const generated = [
    '## Goal',
    '',
    'Ship the rewind fix.',
    '',
    '<read-files>',
    'src/a.ts',
    'src/b.ts',
    '',
    '</read-files>',
    '',
    '<modified-files>',
    'AGENTS.md',
    'src/main/ipc.ts',
    '</modified-files>'
  ].join('\n')
  const split = splitSummaryFiles(generated)
  assert.equal(split.body, '## Goal\n\nShip the rewind fix.', 'the body keeps the prose and drops the sections')
  assert.deepEqual(split.read, ['src/a.ts', 'src/b.ts'], 'read paths keep their order and skip blanks')
  assert.deepEqual(split.modified, ['AGENTS.md', 'src/main/ipc.ts'], 'modified paths keep their order')

  // CRLF, a single section, and paths with spaces or odd characters survive.
  const crlf = splitSummaryFiles(
    '# Title\r\n\r\n<modified-files>\r\nsrc/with space.ts\r\nsrc/ünïcode.ts\r\n</modified-files>\r\n'
  )
  assert.equal(crlf.body, '# Title')
  assert.deepEqual(crlf.read, [])
  assert.deepEqual(crlf.modified, ['src/with space.ts', 'src/ünïcode.ts'], 'awkward paths are kept verbatim')

  // A summary may quote a file that itself contains the tags: a fenced block is
  // off limits, or the quote would be rewritten.
  const quoted = [
    'The generated summary ends with:',
    '',
    '```',
    '<read-files>',
    'src/not-a-section.ts',
    '</read-files>',
    '```',
    '',
    '<modified-files>',
    'src/real.ts',
    '</modified-files>'
  ].join('\n')
  const fenced = splitSummaryFiles(quoted)
  assert.ok(fenced.body.includes('<read-files>'), 'a quoted section inside a fence stays in the body')
  assert.deepEqual(fenced.read, [], 'and is not read as a section')
  assert.deepEqual(fenced.modified, ['src/real.ts'], 'while the real section after the fence still is')

  // A tildes fence counts too.
  assert.deepEqual(
    splitSummaryFiles('~~~\n<read-files>\nx.ts\n</read-files>\n~~~').read,
    [],
    'tilde fences are fences'
  )

  // Unterminated: leave it alone rather than dropping the paths it wraps.
  const unterminated = '<read-files>\nsrc/a.ts\n'
  const dangling = splitSummaryFiles(unterminated)
  assert.deepEqual(dangling.read, [], 'an unterminated block contributes nothing')
  assert.equal(dangling.body, unterminated.trimEnd(), 'and its text is not lost')

  // Real data: the newest compacted summary on this machine, if there is one.
  const sessionsRoot = join(process.env.HOME ?? '', '.pi', 'agent', 'sessions')
  const files = []
  const walk = async (dir, depth = 0) => {
    if (depth > 3) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(sessionsRoot)
  let verified = 0
  for (const file of files.slice(0, 400)) {
    const raw = await readFile(file, 'utf8').catch(() => '')
    if (!raw.includes('"type":"compaction"')) continue
    for (const line of raw.split('\n')) {
      if (!line.includes('"type":"compaction"') && !line.includes('<read-files>')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const summary = entry?.type === 'compaction' ? entry.summary : undefined
      if (typeof summary !== 'string' || !summary.includes('<read-files>')) continue
      const real = splitSummaryFiles(summary)
      assert.ok(real.read.length > 0 || real.modified.length > 0, `the real summary yields paths: ${file}`)
      assert.ok(!real.body.includes('<read-files>'), `the tags are gone from the body: ${file}`)
      assert.ok(!real.body.includes('<modified-files>'), `nor are the other tags left behind: ${file}`)
      assert.ok(real.body.length > 0, `the summarised prose survives: ${file}`)
      verified++
      break
    }
    if (verified === 2) break
  }
  console.log(
    `PASS: summary file sections (body preserved, fences and unterminated blocks untouched` +
      `${verified ? `, ${verified} real compacted summar${verified === 1 ? 'y' : 'ies'} on this machine verified` : ', no real compacted summary on this machine to check'})`
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
