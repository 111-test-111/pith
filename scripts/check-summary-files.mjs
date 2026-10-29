/**
 * The SDK appends `<read-files>`/`<modified-files>` to every summary it
 * generates (`formatFileOperations`) — a convention between the SDK and the
 * model that markdown cannot render. `splitSummaryFiles` takes those sections
 * out so `SummaryRow` can draw them as file links. Deterministic fixtures check
 * prose fidelity, file paths, fences and incomplete sections. No Electron.
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
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

  console.log('PASS: summary file sections (body preserved, file paths intact, fences and unterminated blocks untouched)')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
