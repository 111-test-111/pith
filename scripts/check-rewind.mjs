/** Raw bytes and staging oracle against real Git. Every mutation is isolated. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const temporary = await mkdtemp(join(tmpdir(), 'pith-rewind-check-'))
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const present = async path => !!await stat(path).catch(() => null)
let count = 0
try {
  const outfile = join(temporary, 'engine.mjs')
  await build({ stdin: { contents: "export * from './src/main/rewind/engine'; export * from './src/main/rewind/paths'", resolveDir: resolve('.') }, outfile, bundle: true, platform: 'node', format: 'esm' })
  const { RewindEngine, PathIndex } = await import(pathToFileURL(outfile))
  const engine = new RewindEngine(join(temporary, 'data'))
  async function repo(name, attrs) {
    const root = join(temporary, name); await mkdir(root)
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'config', 'core.autocrlf', 'false')
    if (attrs) await writeFile(join(root, '.gitattributes'), attrs)
    await writeFile(join(root, 'a.txt'), 'BASE\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base'); return root
  }
  const checkpoint = (root, owner = engine) => owner.checkpoint(root, { sessionId: 'fixture', trigger: 'before-turn', entryId: 'entry-1' })
  async function restore(root, id, { action, owner = engine, token, operationId = randomUUID(), commit = true } = {}) {
    const preview = token ? { token } : await owner.preview(root, 'fixture', id, action)
    assert.equal(preview.blocked, undefined)
    const operation = await owner.prepare(root, 'fixture', preview.token, 'files', operationId, 'entry-2', 'entry-1')
    if (commit) return owner.finish(root, 'fixture', operation.id, true)
    return operation
  }
  async function check(name, fn) { await fn(); count++; console.log(`PASS ${count}: ${name}`) }
  await check('protected-path segment lookup matches the literal oracle and scales to 160,000 paths', async () => {
    const protectedPaths = ['a', 'literal\\name/file', '中文/记录', 'line\nbreak/child', 'similar-prefix']
    const index = new PathIndex(protectedPaths)
    for (const path of ['', 'a', 'a/b', 'ab', 'literal\\name', 'literal/name', '中文', '中文/记录/后续', 'line\nbreak', 'similar-prefixes']) {
      assert.equal(index.contains(path), protectedPaths.some(p => path === p || path.startsWith(p + '/')), path)
      assert.equal(index.atOrBelow(path), protectedPaths.some(p => path === p || p.startsWith(path + '/')), path)
      assert.equal(index.overlaps(path), protectedPaths.some(p => path === p || path.startsWith(p + '/') || p.startsWith(path + '/')), path)
    }
    const start = performance.now()
    const many = new PathIndex(Array.from({ length: 160000 }, (_, i) => `dependencies/package-${i}/file`))
    for (let i = 0; i < 2000; i++) { assert(many.overlaps(`dependencies/package-${i}`)); assert(!many.overlaps(`src/file-${i}`)) }
    assert(performance.now() - start < 10000, 'bounded segment lookup must not regress to a Cartesian scan')
  })
  await check('raw CRLF, independent staging, HEAD, persistent Undo and Redo', async () => {
    const root = await repo('raw', '*.txt text eol=lf\n'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED\n'); git(root, 'add', 'a.txt')
    const bytes = Buffer.from('USER\r\nEDIT\r\n'); await writeFile(join(root, 'a.txt'), bytes)
    const index = await readFile(join(root, '.git/index')), head = git(root, 'rev-parse', 'HEAD')
    const operation = await restore(root, cp.id)
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'BASE\n')
    const restarted = new RewindEngine(join(temporary, 'data'))
    const undo = await restore(root, operation.id, { action: 'undo', owner: restarted })
    assert.deepEqual(await readFile(join(root, 'a.txt')), bytes)
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
    await restore(root, undo.id, { action: 'redo', owner: restarted })
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'BASE\n')
    assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  })
  await check('assume-unchanged worktree edits survive restore/undo', async () => {
    const root = await repo('assume'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'LATER\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'later'); git(root, 'update-index', '--assume-unchanged', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'UNSAVED\n')
    const operation = await restore(root, cp.id)
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'UNSAVED\n')
    assert.match(git(root, 'ls-files', '-v', 'a.txt'), /^h /)
  })
  await check('partial consent preserves omissions, rejects index/alias overlap and survives rollback', async () => {
    const root = await repo('partial-guards'), cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED ONLY\n');git(root, 'add', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'BASE\n')
    const index = await readFile(join(root, '.git/index'))
    const preview = await engine.preview(root, 'fixture', cp.id)
    assert(preview.changes.length>0&&preview.changes.every(row=>row.area==='index'))
    const alias = join(temporary, 'partial-alias');await symlink(root, alias)
    for (const path of [join(root, 'a.txt'), join(alias, 'a.txt')]) {
      await assert.rejects(engine.prepare(root, 'fixture', preview.token, 'files', randomUUID(), 'entry-2', 'entry-2', undefined,
        { uncovered: [{ path, reason: 'excluded' }], confirmed: true }), error=>error.code==='unsupported', 'skip consent cannot modify a skipped index entry, including through an alias')
      assert.deepEqual(await readFile(join(root, '.git/index')), index)
    }
    // Equal OIDs still carry user-visible index flags. Skip must not undo them.
    git(root, 'reset', '-q', 'HEAD', '--', 'a.txt');git(root, 'update-index', '--assume-unchanged', 'a.txt')
    const flagsOnly = await engine.preview(root, 'fixture', cp.id)
    assert(flagsOnly.changes.some(row=>row.area==='index'&&row.path===''))
    await assert.rejects(engine.prepare(root, 'fixture', flagsOnly.token, 'files', randomUUID(), 'entry-2', 'entry-2', undefined,
      { uncovered: [{ path: join(root, 'a.txt'), reason: 'excluded' }], confirmed: true }), error=>error.code==='unsupported')
    assert.match(git(root, 'ls-files', '-v', 'a.txt'), /^h /)
    // Resume the earlier immutable staged plan with its exact reviewed index.
    await writeFile(join(root, '.git/index'), index)
    const external = join(temporary, 'partial-external.txt');await writeFile(external, 'KEEP EXTERNAL\n')
    const uncovered = [{ path: external, reason: 'outside-workspace' }], coverage = { uncovered, confirmed: true }
    await assert.rejects(engine.prepare(root, 'fixture', preview.token, 'files', randomUUID(), 'entry-2', 'entry-2', undefined,
      { uncovered, confirmed: false }), error=>error.code==='uncovered')
    const failedId = randomUUID()
    const failing = new RewindEngine(join(temporary, 'data'), async phase=>{if(phase==='files-applied')throw new Error('Injected after partial application')})
    await assert.rejects(failing.prepare(root, 'fixture', preview.token, 'files', failedId, 'entry-2', 'entry-2', undefined, coverage))
    assert.deepEqual(await readFile(join(root, '.git/index')), index, 'failed partial restore rolls back raw staging')
    const failed = (await engine.list(root, 'fixture')).operations.find(op=>op.id===failedId)
    assert.equal(failed.status, 'rolled-back');assert.deepEqual(failed.skipped, uncovered)
    const prepared = await engine.prepare(root, 'fixture', preview.token, 'files', randomUUID(), 'entry-2', 'entry-2', undefined, coverage)
    const committed = await engine.finish(root, 'fixture', prepared.id, true)
    assert.deepEqual(committed.skipped, uncovered)
    const undo = await engine.preview(root, 'fixture', committed.id, 'undo')
    assert.deepEqual(undo.uncovered, uncovered)
    await assert.rejects(engine.prepare(root, 'fixture', undo.token, 'files', randomUUID(), 'entry-2', 'entry-2'), error=>error.code==='uncovered', 'durable Undo cannot drop partial consent at the worker boundary')
    const undone = await engine.prepare(root, 'fixture', undo.token, 'files', randomUUID(), 'entry-2', 'entry-2', undefined, { uncovered: [], confirmed: true })
    await engine.finish(root, 'fixture', undone.id, true)
    assert.deepEqual(undone.skipped, uncovered, 'caller cannot erase inherited skipped paths')
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
    assert.equal(await readFile(external, 'utf8'), 'KEEP EXTERNAL\n')
  })
  await check('single working-file restore preserves other files, raw staging, mode and persistent Undo/Redo', async () => {
    const root = await repo('single-file')
    await writeFile(join(root, 'other.txt'), 'OTHER BEFORE\n')
    const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED\n'); git(root, 'add', 'a.txt')
    const index = await readFile(join(root, '.git/index'))
    await writeFile(join(root, 'a.txt'), 'CURRENT\r\nSECOND\r\n'); await chmod(join(root, 'a.txt'), 0o755)
    await writeFile(join(root, 'other.txt'), 'KEEP OTHER\n')
    const full = await engine.preview(root, 'fixture', cp.id)
    assert.deepEqual(await engine.stats(root, 'fixture', full.token, 'a.txt', 'worktree'), { added: 1, removed: 2, binary: false })
    assert.deepEqual(await engine.stats(root, 'fixture', full.token, 'a.txt', 'index'), { added: 1, removed: 1, binary: false })
    assert.deepEqual(await engine.statsBatch(root, 'fixture', full.token, [{ path: 'a.txt', area: 'worktree' }, { path: 'a.txt', area: 'index' }, { path: 'other.txt', area: 'worktree' }]), [
      { added: 1, removed: 2, binary: false }, { added: 1, removed: 1, binary: false }, { added: 1, removed: 1, binary: false }
    ], 'batch totals include separate worktree/staging entries in the requested order')
    await assert.rejects(engine.statsBatch(root, 'fixture', full.token, Array.from({ length: 17 }, () => ({ path: 'a.txt', area: 'worktree' }))), error => error.code === 'missing')
    const selected = await engine.previewFile(root, 'fixture', full.token, 'a.txt')
    assert.deepEqual(selected.changes.map(c => [c.path, c.area]), [['a.txt', 'worktree']])
    await assert.rejects(engine.prepare(root, 'fixture', selected.token, 'all', randomUUID(), 'a', 'b'), error => error.code === 'unsupported')
    await assert.rejects(engine.previewFile(root, 'fixture', full.token, '../outside'), error => error.code === 'unsupported')
    const op = await restore(root, cp.id, { token: selected.token })
    assert.equal(op.file, 'a.txt')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'BASE\n')
    assert.equal((await stat(join(root, 'a.txt'))).mode & 0o777, 0o644)
    assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'KEEP OTHER\n')
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
    const restarted = new RewindEngine(join(temporary, 'data'))
    const undo = await restore(root, op.id, { action: 'undo', owner: restarted })
    assert.equal(undo.file, 'a.txt')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'CURRENT\r\nSECOND\r\n')
    assert.equal((await stat(join(root, 'a.txt'))).mode & 0o777, 0o755)
    await restore(root, undo.id, { action: 'redo', owner: restarted })
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
    assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'KEEP OTHER\n')
  })
  await check('single file creates only needed parents, deletes only its leaf and rejects stale bytes', async () => {
    const root = await repo('single-parents')
    await mkdir(join(root, 'nested/deeper'), { recursive: true }); await writeFile(join(root, 'nested/deeper/old.txt'), 'BEFORE\n')
    const cp = await checkpoint(root)
    await rm(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'new.txt'), 'AFTER\n')
    const full = await engine.preview(root, 'fixture', cp.id)
    const selected = await engine.previewFile(root, 'fixture', full.token, 'nested/deeper/old.txt')
    const op = await restore(root, cp.id, { token: selected.token })
    assert.equal(await readFile(join(root, 'nested/deeper/old.txt'), 'utf8'), 'BEFORE\n')
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'AFTER\n')
    await restore(root, op.id, { action: 'undo' })
    assert.equal(await present(join(root, 'nested')), false)
    const deleteFull = await engine.preview(root, 'fixture', cp.id)
    const deleteOne = await engine.previewFile(root, 'fixture', deleteFull.token, 'new.txt')
    await writeFile(join(root, 'new.txt'), 'EXTERNAL CHANGE\n')
    await assert.rejects(restore(root, cp.id, { token: deleteOne.token }), error => error.code === 'changed')
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'EXTERNAL CHANGE\n')
    const fresh = await engine.preview(root, 'fixture', cp.id)
    const remove = await engine.previewFile(root, 'fixture', fresh.token, 'new.txt')
    const removed = await restore(root, cp.id, { token: remove.token })
    assert.equal(await present(join(root, 'new.txt')), false)
    assert.equal(await present(join(root, 'nested')), false, 'unselected deleted files remain deleted')
    await restore(root, removed.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'EXTERNAL CHANGE\n')
    await writeFile(join(root, 'nested'), 'KEEP BLOCKING PARENT\n')
    const collision = await engine.preview(root, 'fixture', cp.id)
    await assert.rejects(engine.previewFile(root, 'fixture', collision.token, 'nested/deeper/old.txt'), error => error.code === 'unsupported')
    assert.equal(await readFile(join(root, 'nested'), 'utf8'), 'KEEP BLOCKING PARENT\n', 'restoring a leaf must never replace an unrelated ancestor file')
  })
  await check('collapsed-header counts stay exact beyond the patch limit and for binary/metadata changes', async () => {
    const root = await repo('numstat'), cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), ('changed line '.repeat(8) + '\n').repeat(40000))
    const preview = await engine.preview(root, 'fixture', cp.id)
    const patch = await engine.patch(root, 'fixture', preview.token, 'a.txt', 'worktree')
    assert.equal(patch.truncated, true)
    assert.deepEqual(await engine.stats(root, 'fixture', preview.token, 'a.txt', 'worktree'), { added: 1, removed: 40000, binary: false })
    assert.deepEqual(await engine.statsBatch(root, 'fixture', preview.token, [{ path: 'a.txt', area: 'worktree' }]), [{ added: 1, removed: 40000, binary: false }])
    await writeFile(join(root, 'a.txt'), Buffer.from([0, 255, 128]))
    const binary = await engine.preview(root, 'fixture', cp.id)
    assert.equal((await engine.stats(root, 'fixture', binary.token, 'a.txt', 'worktree')).binary, true)
    await writeFile(join(root, 'a.txt'), 'BASE\n'); await chmod(join(root, 'a.txt'), 0o755)
    const metadata = await engine.preview(root, 'fixture', cp.id)
    assert.deepEqual(await engine.stats(root, 'fixture', metadata.token, 'a.txt', 'worktree'), { added: 0, removed: 0, binary: false })
  })
  await check('staging-only change is visible and restorable', async () => {
    const root = await repo('staging'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED\n'); git(root, 'add', '.'); await writeFile(join(root, 'a.txt'), 'BASE\n')
    const preview = await engine.preview(root, 'fixture', cp.id)
    assert(preview.changes.some(c => c.area === 'index' && c.path === 'a.txt'))
    await restore(root, cp.id, { token: preview.token })
    assert.equal(git(root, 'show', ':a.txt'), 'BASE')
    await writeFile(join(root, 'a.txt'), Buffer.from([0, 1, 2, 255])); git(root, 'add', '.')
    const binaryPreview = await engine.preview(root, 'fixture', cp.id)
    const binaryPatch = await engine.patch(root, 'fixture', binaryPreview.token, 'a.txt', 'index')
    assert.equal(binaryPatch.binary, true, 'binary staging changes are never described as metadata-only')
  })
  await check('stale preview rejects before any worktree mutation', async () => {
    const root = await repo('stale'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'LIVE\n'); const preview = await engine.preview(root, 'fixture', cp.id)
    await writeFile(join(root, 'new.txt'), 'EXTERNAL\n')
    await assert.rejects(restore(root, cp.id, { token: preview.token }), e => e.code === 'changed')
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'EXTERNAL\n')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'LIVE\n')
  })
  await check('external file added after backup never joins the cleanup plan', async () => {
    const root = await repo('late'); const cp = await checkpoint(root)
    const injected = new RewindEngine(join(temporary, 'data'), async phase => { if (phase === 'prepared') await writeFile(join(root, 'late.txt'), 'KEEP\n') })
    await writeFile(join(root, 'a.txt'), 'LIVE\n')
    const operation = await restore(root, cp.id, { owner: injected })
    assert.equal(await readFile(join(root, 'late.txt'), 'utf8'), 'KEEP\n')
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'late.txt'), 'utf8'), 'KEEP\n')
  })
  await check('file/directory transitions, symbolic links and binary bytes', async () => {
    const root = await repo('types'); await mkdir(join(root, 'dir')); await writeFile(join(root, 'dir/bytes.bin'), Buffer.from([0, 255, 128, 1])); await symlink('a.txt', join(root, 'link'))
    const cp = await checkpoint(root)
    await rm(join(root, 'dir'), { recursive: true }); await writeFile(join(root, 'dir'), 'file now'); await rm(join(root, 'link')); await symlink('missing', join(root, 'link'))
    const operation = await restore(root, cp.id)
    assert.deepEqual(await readFile(join(root, 'dir/bytes.bin')), Buffer.from([0, 255, 128, 1]))
    assert.equal(await readlink(join(root, 'link')), 'a.txt')
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'dir'), 'utf8'), 'file now'); assert.equal(await readlink(join(root, 'link')), 'missing')
  })
  await check('failed apply rolls back exact bytes and allows a later retry', async () => {
    const root = await repo('failure'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'LIVE\r\n')
    let fail = true
    const injected = new RewindEngine(join(temporary, 'data'), async phase => { if (phase === 'installed' && fail) { fail = false; throw new Error('injected EIO') } })
    await assert.rejects(restore(root, cp.id, { owner: injected }))
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'LIVE\r\n')
    assert((await injected.list(root, 'fixture')).operations.some(op => op.status === 'rolled-back'))
    await restore(root, cp.id, { owner: injected })
  })
  await check('non-Git/projectless files use the same reversible engine', async () => {
    const root = join(temporary, 'no-git'); await mkdir(root); await writeFile(join(root, 'note.txt'), 'OLD')
    const cp = await checkpoint(root); await writeFile(join(root, 'note.txt'), 'NEW')
    const operation = await restore(root, cp.id)
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'OLD')
    await restore(root, operation.id, { action: 'undo' }); assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'NEW')
    assert.equal(await present(join(root, '.git')), false)
  })
  await check('SIGKILL at each durable phase leaves a recoverable operation', async () => {
    const childPath = join(temporary, 'crash-child.mjs')
    await writeFile(childPath, `import { RewindEngine } from ${JSON.stringify(pathToFileURL(outfile).href)};
const input = JSON.parse(process.argv[2]);
const engine = new RewindEngine(input.data, async phase => { if (phase === input.phase) process.kill(process.pid, 'SIGKILL'); if (input.phase === 'rollback-linked' && phase === 'installed') throw Object.assign(new Error('injected apply failure'), { code: 'EIO' }) });
await engine.prepare(input.root, 'fixture', input.token, 'files', input.id, 'entry-2', 'entry-1');
await engine.finish(input.root, 'fixture', input.id, true);`)
    for (const phase of ['prepared', 'quarantined', 'file-staged', 'file-linked', 'installed', 'index-locked', 'index-staged', 'index-installed', 'files-applied', 'committed', 'rollback-linked']) {
      const root = await repo(`crash-${phase}`); const cp = await checkpoint(root)
      await writeFile(join(root, 'a.txt'), 'CURRENT STAGING\n'); git(root, 'add', '.'); await writeFile(join(root, 'a.txt'), 'CURRENT WORKTREE\r\n')
      const index = await readFile(join(root, '.git/index'))
      const preview = await engine.preview(root, 'fixture', cp.id); const id = randomUUID()
      assert.throws(() => execFileSync(process.execPath, [childPath, JSON.stringify({ data: join(temporary, 'data'), root, phase, token: preview.token, id })], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }), error => error.signal === 'SIGKILL', phase)
      const restarted = new RewindEngine(join(temporary, 'data'))
      const list = await restarted.list(root, 'fixture')
      if (phase === 'committed') {
        assert(list.operations.some(op => op.id === id && op.status === 'committed'))
        await restore(root, id, { action: 'undo', owner: restarted })
      } else {
        assert(list.pending.some(op => op.id === id), phase)
        await restarted.finish(root, 'fixture', id, false)
      }
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'CURRENT WORKTREE\r\n', phase)
      assert.deepEqual(await readFile(join(root, '.git/index')), index, phase)
      assert.equal((await restarted.list(root, 'fixture')).pending.length, 0, phase)
    }
  })
  await check('Git GC cannot collect staged-only contents needed by Undo', async () => {
    const root = await repo('gc'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED ONLY\n'); git(root, 'add', '.'); await writeFile(join(root, 'a.txt'), 'WORKTREE ONLY\n')
    const operation = await restore(root, cp.id)
    git(root, 'reflog', 'expire', '--expire=now', '--all'); git(root, 'gc', '--prune=now')
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(git(root, 'show', ':a.txt'), 'STAGED ONLY')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'WORKTREE ONLY\n')
  })

  await check('split index, skip-worktree and permission bits survive Undo', async () => {
    const root = await repo('split-index'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'STAGED ONLY\n'); git(root, 'add', '.')
    git(root, 'update-index', '--split-index'); git(root, 'update-index', '--skip-worktree', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'SKIPPED EDIT\r\n'); await chmod(join(root, 'a.txt'), 0o755)
    const index = await readFile(join(root, '.git/index'))
    const operation = await restore(root, cp.id); await restore(root, operation.id, { action: 'undo' })
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'SKIPPED EDIT\r\n')
    assert.equal((await stat(join(root, 'a.txt'))).mode & 0o777, 0o755)
    assert.match(git(root, 'ls-files', '-v', 'a.txt'), /^S /)
  })
  await check('unmerged index stages have separate correct previews and exact Undo', async () => {
    const root = await repo('unmerged'); const cp = await checkpoint(root)
    const hash = text => execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim()
    const entries = ['BASE STAGE\n', 'OURS STAGE\n', 'THEIRS STAGE\n'].map((text, index) => `100644 ${hash(text)} ${index + 1}\ta.txt\n`).join('')
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: entries })
    const index = await readFile(join(root, '.git/index'))
    const preview = await engine.preview(root, 'fixture', cp.id)
    for (const stage of [1, 2, 3]) {
      assert(preview.changes.some(change => change.area === 'index' && change.stage === stage))
      const patch = await engine.patch(root, 'fixture', preview.token, 'a.txt', 'index', stage)
      assert.match(patch.patch, new RegExp(['', 'BASE STAGE', 'OURS STAGE', 'THEIRS STAGE'][stage]))
      assert(!patch.patch.includes(temporary), 'diff headers do not leak storage implementation paths')
    }
    const operation = await restore(root, cp.id, { token: preview.token }); await restore(root, operation.id, { action: 'undo' })
    assert.deepEqual(await readFile(join(root, '.git/index')), index)
  })
  await check('raw non-UTF8 symlink target bytes are preserved', async () => {
    if (process.platform === 'win32') return
    const root = await repo('raw-link'), target = Buffer.from([102, 111, 255])
    await symlink(target, join(root, 'raw-link')); const cp = await checkpoint(root)
    await rm(join(root, 'raw-link')); await writeFile(join(root, 'raw-link'), 'REGULAR FILE')
    const operation = await restore(root, cp.id)
    assert.deepEqual(await readlink(join(root, 'raw-link'), { encoding: 'buffer' }), target)
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'raw-link'), 'utf8'), 'REGULAR FILE')
  })
  await check('external replacement during apply is retained alongside its quarantined preimage', async () => {
    const root = await repo('external-replacement'); const cp = await checkpoint(root)
    await writeFile(join(root, 'a.txt'), 'PREIMAGE\r\n')
    let injected = false
    const owner = new RewindEngine(join(temporary, 'data'), async phase => {
      if (phase === 'quarantined' && !injected) { injected = true; await writeFile(join(root, 'a.txt'), 'EXTERNAL REPLACEMENT\r\n') }
    })
    await assert.rejects(restore(root, cp.id, { owner }), error => error.code === 'recovery')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'EXTERNAL REPLACEMENT\r\n')
    const operation = (await owner.list(root, 'fixture')).pending[0]
    const slot = createHash('sha256').update('a.txt').digest('hex')
    assert.equal(await readFile(join(operation.recoveryPath, slot), 'utf8'), 'PREIMAGE\r\n')
    await assert.rejects(owner.finish(root, 'fixture', operation.id, false))
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'EXTERNAL REPLACEMENT\r\n')
  })
  await check('corrupt blobs, corrupt manifests and backup ENOSPC fail before workspace mutation', async () => {
    for (const kind of ['blob', 'manifest', 'space']) {
      const root = await repo('corrupt-' + kind), owner = new RewindEngine(join(temporary, 'bad-data-' + kind)), cp = await checkpoint(root, owner)
      await writeFile(join(root, 'a.txt'), 'USER SAFE\r\n')
      if (kind === 'manifest') {
        const file = join((await owner.directory(root)).dir, 'checkpoints', cp.id + '.json')
        const record = JSON.parse(await readFile(file, 'utf8')); record.payload.description = 'flipped metadata'
        await writeFile(file, JSON.stringify(record))
        await assert.rejects(owner.preview(root, 'fixture', cp.id), error => error.code === 'corrupt')
      } else {
        const preview = await owner.preview(root, 'fixture', cp.id)
        if (kind === 'blob') await writeFile(owner.blobs.path(createHash('sha256').update('BASE\n').digest('hex')), 'BAD!\n')
        else { owner.blobs.put = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } }
        await assert.rejects(owner.prepare(root, 'fixture', preview.token, 'files', randomUUID(), null, null))
      }
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'USER SAFE\r\n', kind)
      assert.equal((await owner.list(root, 'fixture').catch(() => ({ pending: [] }))).pending.length, 0)
    }
  })
  await check('pi-web refs import lazily and explicitly disable absent conversation anchors', async () => {
    const root = await repo('legacy'), tree = git(root, 'write-tree'), head = git(root, 'rev-parse', 'HEAD')
    const metadata = `pi-checkpoint:legacy-fixture\nsessionId fixture\ntrigger turn\nturn 1\nbranch main\nhead ${head}\nindex-tree ${tree}\nworktree-tree ${tree}\ncreated 2025-01-01T00:00:00.000Z\nlargeFiles []\nlargeDirs []\n`
    const commit = execFileSync('git', ['-C', root, 'commit-tree', tree], { input: metadata, encoding: 'utf8' }).trim()
    git(root, 'update-ref', 'refs/pi-checkpoints/legacy-fixture', commit)
    const cp = (await engine.list(root, 'fixture')).checkpoints.find(cp => cp.legacy)
    assert(cp?.conversationUnavailable)
    await writeFile(join(root, 'a.txt'), 'LIVE LEGACY\r\n')
    const preview = await engine.preview(root, 'fixture', cp.id)
    assert.equal(preview.conversationUnavailable, true)
    await assert.rejects(engine.prepare(root, 'fixture', preview.token, 'all', randomUUID(), 'a', 'b'), error => error.code === 'unsupported')
    const operation = await restore(root, cp.id, { token: preview.token })
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'BASE\n')
    await restore(root, operation.id, { action: 'undo' })
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'LIVE LEGACY\r\n')
    assert.equal(git(root, 'rev-parse', 'refs/pi-checkpoints/legacy-fixture'), commit)
  })
  await check('retention and GC preserve live backups and pending recovery while removing unreachable data', async () => {
    const root = join(temporary, 'retention'), owner = new RewindEngine(join(temporary, 'retention-data'))
    await mkdir(root)
    for (let i = 0; i < 55; i++) { await writeFile(join(root, 'note'), 'VERSION-' + i); await owner.checkpoint(root, { sessionId: 'fixture', trigger: 'before-turn', entryId: 'entry-' + i }) }
    assert.equal((await owner.list(root, 'fixture')).checkpoints.length, 50)
    const garbage = await owner.blobs.buffer(Buffer.from('UNREFERENCED-GARBAGE')); await owner.blobs.flush()
    const latest = (await owner.list(root, 'fixture')).checkpoints[0]
    await writeFile(join(root, 'note'), 'PENDING PREIMAGE')
    const preview = await owner.preview(root, 'fixture', latest.id), id = randomUUID()
    await owner.prepare(root, 'fixture', preview.token, 'files', id, 'old', 'new')
    const usage = await owner.maintenance(Date.now() + 2 * 24 * 60 * 60_000)
    assert(usage.removed > 0)
    assert.equal(await present(owner.blobs.path(garbage.hash)), false)
    await owner.finish(root, 'fixture', id, false)
    assert.equal(await readFile(join(root, 'note'), 'utf8'), 'PENDING PREIMAGE')
    assert.equal((await owner.list(root, 'fixture')).pending.length, 0)
  })
  console.log(`Rewind kernel: ${count} scenarios passed.`)
} finally { if (process.env.PI_REWIND_KEEP_TEST) console.log(`Rewind artifacts: ${temporary}`); else await rm(temporary, { recursive: true, force: true }) }
