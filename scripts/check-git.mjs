/** Real Git repositories/remotes; never operates on the user's checkout. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, readlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-git-'))
const original = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
process.env.GIT_CONFIG_GLOBAL = join(temporary, 'global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
await writeFile(process.env.GIT_CONFIG_GLOBAL, '')
const services = []
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const rejected = (result, code) => { assert.equal(result.ok, false); assert.equal(result.code, code, JSON.stringify(result)) }
try {
  const bundle = join(temporary, 'git.mjs')
  await build({ stdin: { contents: `export { GitWorkbench } from './src/main/git/service'; export { CheckoutCoordinator } from './src/main/rewind/coordinator'; export { GitRunner } from './src/main/git/runner'; export { parseStatus, parseHistory } from './src/main/git/parse'; export { parseNumstat } from './src/main/git/statistics'; export { GitStore } from './src/renderer/src/state/git-store'; export { layoutGitGraph } from './src/renderer/src/components/app/git/graph-layout';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle })
  const { GitWorkbench, CheckoutCoordinator, GitRunner, GitStore, parseNumstat, layoutGitGraph } = await import(pathToFileURL(bundle).href)
  assert.deepEqual(parseNumstat('2\t3\tliteral\tname\n.txt\0').get('literal\tname\n.txt'), { added: 2, removed: 3, binary: false })
  assert.deepEqual(parseNumstat('-\t-\tbinary\0').get('binary'), { added: 0, removed: 0, binary: true })
  assert.throws(() => parseNumstat('-\t1\tfile\0'), error => error.code === 'unsupported')
  const project = join(temporary, 'project'), nested = join(project, 'nested'), other = join(temporary, 'other')
  await mkdir(nested, { recursive: true }); await mkdir(other)
  let active = nested, writable = true, trashCount = 0
  const coordinator = new CheckoutCoordinator()
  const service = new GitWorkbench({ coordinator, workspace: () => ({ cwd: active, writable }), trash: path => rename(path, join(temporary, `trash-${++trashCount}`)) }); services.push(service)
  const status = async (cwd = active) => ok(await service.status({ cwd }))
  const request = async (action, fields = {}) => ({ cwd: active, id: randomUUID(), revision: action === 'init' ? '' : (await status()).revision, action, ...fields })
  const execute = async (action, fields = {}) => ok(await service.execute(await request(action, fields)))
  rejected(await service.status({ cwd: nested }), 'not-repository')
  // Init acts on the explicit active project. Open a nested workspace later.
  active = project
  await execute('init')
  git(project, 'config', 'user.name', 'Git Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid'); git(project, 'config', 'commit.gpgsign', 'false')
  active = nested
  assert.equal((await status()).root, await import('node:fs/promises').then(fs => fs.realpath(project)))
  assert.equal((await status()).head, null)
  assert.deepEqual(ok(await service.graph({ cwd: active })).commits, [], 'unborn graphs are empty')
  await writeFile(join(project, 'README.md'), 'original\n'); await writeFile(join(nested, 'file.txt'), 'nested\n')
  await execute('stage', { paths: ['README.md', 'nested/file.txt'] })
  assert.equal((await status()).files.length, 2)
  await writeFile(join(project, 'README.md'), 'modified after staging\n')
  await execute('unstage', { paths: ['README.md'] })
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'modified after staging\n')
  assert((await status()).files.find(file => file.path === 'README.md').untracked)
  await writeFile(join(project, 'README.md'), 'original\n'); await execute('stage', { paths: ['README.md'] })
  const commitRequest = await request('commit', { message: 'Initial fixture\n\nBody with newlines.' })
  await Promise.all([service.execute(commitRequest), service.execute(commitRequest)]).then(results => results.forEach(ok))
  assert.equal(git(project, 'rev-list', '--count', 'HEAD'), '1', 'same operation id never commits twice')
  rejected(await service.execute({ ...commitRequest, message: 'different' }), 'invalid')
  assert.equal((await status()).blocked, null, 'a receipt does not retain its own exclusive blocker')
  const history = ok(await service.history({ cwd: active }))
  assert.equal(history.commits[0].subject, 'Initial fixture'); assert(history.commits[0].body.includes('Body with newlines.')); assert.deepEqual(history.commits[0].parents, [])
  const firstCommit = history.commits[0].id
  assert.deepEqual(ok(await service.commitFiles({ cwd: active, commit: firstCommit })).map(file => file.path), ['README.md', 'nested/file.txt'])
  assert(ok(await service.diff({ cwd: active, revision: (await status()).revision, area: 'commit', path: 'README.md', commit: firstCommit })).patch.includes('+original'))
  await writeFile(join(project, 'README.md'), 'staged\n'); await execute('stage', { paths: ['README.md'] }); await writeFile(join(project, 'README.md'), 'working\n')
  let repo = await status()
  assert.equal(repo.files.find(file => file.path === 'README.md').index, 'M'); assert.equal(repo.files.find(file => file.path === 'README.md').worktree, 'M')
  assert.deepEqual(repo.files.find(file => file.path === 'README.md').stagedStats, { added: 1, removed: 1, binary: false })
  assert.deepEqual(repo.files.find(file => file.path === 'README.md').worktreeStats, { added: 1, removed: 1, binary: false }, 'MM layers have separate line counts')
  assert(ok(await service.diff({ cwd: active, revision: repo.revision, path: 'README.md', area: 'staged' })).patch.includes('+staged'))
  assert(ok(await service.diff({ cwd: active, revision: repo.revision, path: 'README.md', area: 'unstaged' })).patch.includes('+working'))
  const staleStage = await request('stage', { paths: ['README.md'] })
  await writeFile(join(project, 'README.md'), 'changed\n')
  rejected(await service.diff({ cwd: active, revision: repo.revision, path: 'README.md', area: 'unstaged' }), 'stale')
  rejected(await service.execute(staleStage), 'stale')
  assert.equal(git(project, 'show', ':README.md'), 'staged', 'stale staging does not touch the index')
  let preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['README.md'] }))
  await writeFile(join(project, 'README.md'), 'newer!\n')
  rejected(await service.execute(await request('discard', { token: preview.token })), 'stale')
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'newer!\n')
  preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['README.md'] }))
  await execute('discard', { token: preview.token })
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'staged\n'); assert.equal(git(project, 'show', ':README.md'), 'staged')
  await writeFile(join(project, 'README.md'), 'keep unstaged\n')
  await execute('commit', { message: 'Only staged files' })
  assert.equal(git(project, 'show', 'HEAD:README.md'), 'staged'); assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'keep unstaged\n')
  preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['README.md'] })); await execute('discard', { token: preview.token })
  const countFiles = { 'count-lines.txt': 'one\ntwo', 'empty.txt': '', 'unicode-count.txt': '中文\n末行', 'count-binary.dat': Buffer.from([1, 0, 2]) }
  for (const [path, text] of Object.entries(countFiles)) await writeFile(join(project, path), text)
  repo = await status()
  for (const [path, added] of [['count-lines.txt', 2], ['empty.txt', 0], ['unicode-count.txt', 2]]) assert.deepEqual(repo.files.find(file => file.path === path).worktreeStats, { added, removed: 0, binary: false })
  assert.equal(repo.files.find(file => file.path === 'count-binary.dat').worktreeStats.binary, true)
  await writeFile(join(project, 'count-lines.txt'), 'onetwo\n') // Same byte length, different line count.
  const changedCounts = await status(); assert.notEqual(changedCounts.revision, repo.revision)
  assert.equal(changedCounts.files.find(file => file.path === 'count-lines.txt').worktreeStats.added, 1, 'metadata change invalidates untracked counts')
  await execute('stage', { paths: Object.keys(countFiles) })
  assert.equal((await status()).files.find(file => file.path === 'count-binary.dat').stagedStats.binary, true)
  await execute('unstage', { paths: Object.keys(countFiles) }); for (const path of Object.keys(countFiles)) await rm(join(project, path))
  const weird = process.platform === 'win32' ? ['a space.txt', '中文.txt', '-option.txt'] : ['a space.txt', '中文.txt', 'line\nbreak.txt', 'tab\tname.txt', ':(glob)*.txt', '-option.txt', 'back\\slash.txt', 'literal\\..']
  for (const path of weird) await writeFile(join(project, path), path + '\n')
  if (process.platform !== 'win32') {
    const patch = ok(await service.diff({ cwd: active, revision: (await status()).revision, area: 'unstaged', path: 'line\nbreak.txt' })).patch
    assert(patch.includes('+++ "b/line\\nbreak.txt"\n@@')); assert(patch.includes('+line\n+break.txt'))
  }
  await execute('stage', { paths: weird })
  repo = await status(); for (const path of weird) assert.equal(repo.files.find(file => file.path === path).stagedStats.added, path.split('\n').length)
  await execute('commit', { message: 'Literal filenames' })
  for (const path of weird) assert.equal(git(project, 'show', `HEAD:${path}`), path)
  await rename(join(project, 'a space.txt'), join(project, 'renamed space.txt')); git(project, 'add', '-A')
  repo = await status(); const renamed = repo.files.find(file => file.path === 'renamed space.txt'); assert.equal(renamed.oldPath, 'a space.txt')
  assert.deepEqual(renamed.stagedStats, { added: 1, removed: 1, binary: false }, 'rename counts agree with the two-file no-renames preview')
  await execute('unstage', { paths: [renamed.path] })
  assert.equal(git(project, 'diff', '--cached'), '', 'unstaging a rename handles both paths')
  await execute('stage', { paths: (await status()).files.map(file => file.path) }); await execute('commit', { message: 'Rename' })
  rejected(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['../outside'] }), 'stale')
  rejected(await service.diff({ cwd: active, revision: (await status()).revision, path: '.git/config', area: 'unstaged' }), 'invalid')
  await writeFile(join(project, 'trash me.txt'), 'trash bytes\n')
  preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['trash me.txt'] })); assert.deepEqual(preview.untracked, ['trash me.txt'])
  await execute('discard', { token: preview.token }); assert.equal(await readFile(join(temporary, `trash-${trashCount}`), 'utf8'), 'trash bytes\n')
  // A staged deletion and an untracked replacement can share the exact same path.
  git(project, 'rm', '--cached', 'README.md'); await writeFile(join(project, 'README.md'), 'replacement\n')
  repo = await status(); assert.equal(repo.files.filter(file => file.path === 'README.md').length, 2)
  assert(ok(await service.diff({ cwd: active, revision: repo.revision, path: 'README.md', area: 'staged' })).patch.includes('-staged'))
  assert(ok(await service.diff({ cwd: active, revision: repo.revision, path: 'README.md', area: 'unstaged' })).patch.includes('+replacement'))
  preview = ok(await service.prepareDiscard({ cwd: active, revision: repo.revision, paths: ['README.md'] })); assert.deepEqual(preview.untracked, ['README.md'])
  await execute('discard', { token: preview.token }); assert.equal(git(project, 'diff', '--cached', '--name-only'), 'README.md')
  await execute('unstage', { paths: ['README.md'] }); preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['README.md'] })); await execute('discard', { token: preview.token })
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'staged\n')
  if (process.platform !== 'win32') {
    await writeFile(join(other, 'outside.txt'), 'outside\n'); await symlink(join(other, 'outside.txt'), join(project, 'link'))
    assert.equal((await status()).files.find(file => file.path === 'link').worktreeStats, null, 'untracked symlinks never read their target to count lines')
    await execute('stage', { paths: ['link'] }); await execute('commit', { message: 'Symlink entry' })
    await rm(join(project, 'link')); await symlink('elsewhere', join(project, 'link'))
    preview = ok(await service.prepareDiscard({ cwd: active, revision: (await status()).revision, paths: ['link'] })); await execute('discard', { token: preview.token })
    assert.equal(await readlink(join(project, 'link')), join(other, 'outside.txt')); assert.equal(await readFile(join(other, 'outside.txt'), 'utf8'), 'outside\n')
    await symlink(other, join(project, 'escape')); await writeFile(join(other, 'not-tracked.txt'), 'outside\n')
    rejected(await service.diff({ cwd: active, revision: (await status()).revision, path: 'escape/not-tracked.txt', area: 'unstaged' }), 'invalid')
    await rm(join(project, 'escape'))
  }
  await writeFile(join(project, 'binary.dat'), Buffer.from([1, 0, 2]))
  assert.equal(ok(await service.diff({ cwd: active, revision: (await status()).revision, path: 'binary.dat', area: 'unstaged' })).binary, true)
  await execute('stage', { paths: ['binary.dat'] }); await execute('commit', { message: 'Binary' })
  for (const kind of ['run', 'tool', 'process', 'subagent', 'terminal']) {
    const release = coordinator.acquire(project, kind)
    const blocked = await status(); assert.equal(blocked.blocked, kind === 'terminal' ? 'terminal' : 'busy')
    rejected(await service.execute({ cwd: active, id: randomUUID(), revision: blocked.revision, action: 'fetch' }), kind === 'terminal' ? 'terminal' : 'busy'); release()
  }
  const otherTerminal = coordinator.acquire(other, 'terminal'); assert.equal((await status()).blocked, 'terminal'); otherTerminal()
  coordinator.setRecovery(project, 'fixture'); rejected(await service.execute(await request('fetch')), 'recovery'); coordinator.setRecovery(project)
  await coordinator.withExclusive(project, 'git', async () => { assert.equal(coordinator.canStart(project), false); assert.throws(() => coordinator.acquire(nested, 'run')); assert.throws(() => coordinator.acquire(other, 'terminal')); rejected(await service.execute(await request('fetch')), 'busy') })
  const uncertain = new CheckoutCoordinator(); uncertain.fence(project)
  assert.equal(uncertain.canStart(nested), false); assert.throws(() => uncertain.acquire(nested, 'run')); assert.throws(() => uncertain.acquire(other, 'terminal'))
  await assert.rejects(uncertain.withExclusive(project, 'git', async () => assert.fail('must remain fenced')), error => error.code === 'busy')
  writable = false; rejected(await service.execute(await request('branch', { branch: 'readonly' })), 'readonly'); writable = true
  active = other; rejected(await service.status({ cwd: nested }), 'stale'); active = nested
  await execute('branch', { branch: 'feature/fixture' }); assert.equal((await status()).branch, 'feature/fixture')
  await writeFile(join(project, 'dirty.txt'), 'dirty\n'); rejected(await service.execute(await request('switch', { branch: 'master' })), 'dirty'); await rm(join(project, 'dirty.txt'))
  const branches = ok(await service.branches({ cwd: active })); assert(branches.some(branch => branch.name === 'feature/fixture' && branch.current))
  const baseBranch = branches.find(branch => !branch.current).name
  await execute('switch', { branch: baseBranch })
  const worktree = join(temporary, process.platform === 'win32' ? 'linked' : 'linked\nworktree'); git(project, 'worktree', 'add', worktree, 'feature/fixture')
  assert.equal(ok(await service.branches({ cwd: active })).find(branch => branch.name === 'feature/fixture').worktree, await import('node:fs/promises').then(fs => fs.realpath(worktree)))
  rejected(await service.execute(await request('switch', { branch: 'feature/fixture' })), 'command')
  active = worktree; assert.equal((await status()).root, await import('node:fs/promises').then(fs => fs.realpath(worktree))); active = nested
  const remote = join(temporary, 'remote.git'); await mkdir(remote); git(remote, 'init', '--bare'); git(project, 'remote', 'add', 'origin', remote)
  await execute('push', { remote: 'origin' }); assert((await status()).upstream); assert.equal(git(remote, 'rev-parse', `refs/heads/${baseBranch}`), git(project, 'rev-parse', 'HEAD'))
  const clone = join(temporary, 'clone'); git(temporary, 'clone', '--branch', baseBranch, remote, clone); git(clone, 'config', 'user.name', 'Remote Fixture'); git(clone, 'config', 'user.email', 'remote@example.invalid'); git(clone, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(clone, 'remote.txt'), 'remote\n'); git(clone, 'add', 'remote.txt'); git(clone, 'commit', '-m', 'Remote addition'); git(clone, 'push')
  await execute('fetch'); assert.equal((await status()).behind, 1); await execute('pull'); assert.equal(await readFile(join(project, 'remote.txt'), 'utf8'), 'remote\n')
  await writeFile(join(clone, 'remote.txt'), 'remote two\n'); git(clone, 'add', 'remote.txt'); git(clone, 'commit', '-m', 'Remote ahead'); git(clone, 'push')
  await writeFile(join(project, 'local.txt'), 'local\n'); await execute('stage', { paths: ['local.txt'] }); await execute('commit', { message: 'Local divergence' })
  const divergentHead = git(project, 'rev-parse', 'HEAD'), remoteHead = git(remote, 'rev-parse', `refs/heads/${baseBranch}`)
  rejected(await service.execute(await request('push')), 'command'); rejected(await service.execute(await request('pull')), 'command')
  assert.equal(git(project, 'rev-parse', 'HEAD'), divergentHead); assert.equal(git(remote, 'rev-parse', `refs/heads/${baseBranch}`), remoteHead, 'no force push or merge on divergence')
  // Conflict state remains visible; only explicit stage resolves a file.
  git(project, 'checkout', '-b', 'conflict-side'); await writeFile(join(project, 'README.md'), 'side\n'); git(project, 'add', 'README.md'); git(project, 'commit', '-m', 'Side')
  git(project, 'checkout', baseBranch); await writeFile(join(project, 'README.md'), 'main\n'); git(project, 'add', 'README.md'); git(project, 'commit', '-m', 'Main')
  assert.throws(() => git(project, 'merge', 'conflict-side'))
  repo = await status(); assert(repo.files.find(file => file.path === 'README.md').conflict)
  assert.equal(repo.files.find(file => file.path === 'README.md').worktreeStats, null)
  rejected(await service.execute(await request('commit', { message: 'Unresolved' })), 'conflict')
  rejected(await service.prepareDiscard({ cwd: active, revision: repo.revision, paths: ['README.md'] }), 'unsupported')
  await writeFile(join(project, 'README.md'), 'resolved\n'); await execute('stage', { paths: ['README.md'] }); assert(!(await status()).files.some(file => file.conflict)); git(project, 'merge', '--abort')
  // Process cancellation retains checkout exclusion until a real hook exits.
  if (process.platform !== 'win32') {
    const hook = join(project, '.git', 'hooks', 'pre-commit'), marker = join(temporary, 'hook-started')
    await writeFile(hook, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 })
    await writeFile(join(project, 'cancel.txt'), 'cancel\n'); await execute('stage', { paths: ['cancel.txt'] })
    const command = await request('commit', { message: 'Must cancel' }), running = service.execute(command)
    for (let i = 0; i < 200; i++) { if (await stat(marker).catch(() => false)) break; await new Promise(resolve => setTimeout(resolve, 20)) }
    // Bounded receipt eviction must never lose an in-flight operation or its cancel owner.
    await Promise.all(Array.from({ length: 270 }, () => service.execute({ ...command, id: randomUUID(), action: 'fetch' }))).then(results => results.forEach(result => rejected(result, 'busy')))
    assert.equal(service.execute(command), running, 'pending receipts survive cache pressure')
    assert.equal(coordinator.canStart(project), false); ok(await service.cancel({ cwd: active, id: command.id })); rejected(await running, 'cancelled'); assert.equal(coordinator.canStart(project), true)
    await rm(hook); await execute('unstage', { paths: ['cancel.txt'] }); await rm(join(project, 'cancel.txt'))
  }
  // Pagination rejects an old frontier, rather than repeating/skipping commits after HEAD moves.
  let parent = git(project, 'rev-parse', 'HEAD')
  const tree = git(project, 'rev-parse', 'HEAD^{tree}')
  for (let i = 0; i < 55; i++) parent = git(project, 'commit-tree', tree, '-p', parent, '-m', `History ${i}`)
  git(project, 'update-ref', 'HEAD', parent)
  const firstPage = ok(await service.history({ cwd: active })); assert.equal(firstPage.commits.length, 50); assert.equal(firstPage.next, 50)
  rejected(await service.history({ cwd: active, offset: 50 }), 'invalid')
  const secondPage = ok(await service.history({ cwd: active, offset: 50, head: firstPage.head }))
  const ids = [...firstPage.commits, ...secondPage.commits].map(commit => commit.id)
  assert.equal(new Set(ids).size, ids.length); assert.deepEqual(ids, git(project, 'log', '--format=%H').split('\n')); assert.equal(secondPage.next, null)
  parent = git(project, 'commit-tree', tree, '-p', parent, '-m', 'External change'); git(project, 'update-ref', 'HEAD', parent)
  rejected(await service.history({ cwd: active, offset: 50, head: firstPage.head }), 'stale')
  const beforeConfig = await request('fetch'); git(project, 'config', 'user.name', 'Updated identity')
  rejected(await service.execute(beforeConfig), 'stale')
  // Ambient shell Git variables cannot redirect repository or index ownership.
  const ambient = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, tree: process.env.GIT_WORK_TREE }
  try {
    process.env.GIT_DIR = join(remote); process.env.GIT_INDEX_FILE = join(temporary, 'redirected-index'); process.env.GIT_WORK_TREE = other
    assert.equal((await status()).root, await import('node:fs/promises').then(fs => fs.realpath(project)))
    await writeFile(join(project, 'ambient.txt'), 'owned\n'); await execute('stage', { paths: ['ambient.txt'] }); assert.equal(await stat(join(temporary, 'redirected-index')).catch(() => null), null)
    await execute('unstage', { paths: ['ambient.txt'] }); await rm(join(project, 'ambient.txt'))
  } finally {
    for (const [key, value] of [['GIT_DIR', ambient.dir], ['GIT_INDEX_FILE', ambient.index], ['GIT_WORK_TREE', ambient.tree]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  // A real DAG: merges, disconnected public tips, annotated/nested tags and private refs.
  const graphProject = join(temporary, 'graph'); await mkdir(graphProject)
  git(graphProject, 'init', '-b', 'main'); git(graphProject, 'config', 'user.name', 'Graph Fixture'); git(graphProject, 'config', 'user.email', 'graph@example.invalid'); git(graphProject, 'config', 'commit.gpgsign', 'false'); git(graphProject, 'config', 'tag.gpgsign', 'false')
  await writeFile(join(graphProject, 'root.txt'), 'graph root\n'); git(graphProject, 'add', 'root.txt'); git(graphProject, 'commit', '-m', 'Graph root')
  const graphBase = git(graphProject, 'rev-parse', 'HEAD'), graphTree = git(graphProject, 'rev-parse', 'HEAD^{tree}')
  let graphTip = graphBase
  for (let i = 0; i < 60; i++) graphTip = git(graphProject, 'commit-tree', graphTree, '-p', graphTip, '-m', `Graph ${i}`)
  const sideTip = git(graphProject, 'commit-tree', graphTree, '-p', graphBase, '-m', 'Feature tip'), mergeTip = git(graphProject, 'commit-tree', graphTree, '-p', graphTip, '-p', sideTip, '-m', 'Merged feature', '-m', 'Lazy commit body')
  const remoteTip = git(graphProject, 'commit-tree', graphTree, '-m', 'Remote orphan'), privateTip = git(graphProject, 'commit-tree', graphTree, '-m', 'Private checkpoint')
  git(graphProject, 'update-ref', 'HEAD', mergeTip); git(graphProject, 'update-ref', 'refs/heads/feature', sideTip); git(graphProject, 'update-ref', 'refs/remotes/origin/orphan', remoteTip); git(graphProject, 'update-ref', 'refs/pith/checkpoints/private', privateTip)
  git(graphProject, 'tag', '-a', 'v1', graphBase, '-m', 'Annotated'); git(graphProject, 'tag', '-a', 'nested-tag', 'v1', '-m', 'Nested'); git(graphProject, 'tag', 'blob-tag', git(graphProject, 'hash-object', 'root.txt'))
  active = graphProject
  rejected(await service.graph({ cwd: active, offset: 50 }), 'invalid'); rejected(await service.graph({ cwd: active, offset: 5000, revision: 'a'.repeat(64) }), 'invalid')
  const graphFirst = ok(await service.graph({ cwd: active })); assert.equal(graphFirst.commits.length, 50); assert.equal(graphFirst.next, 50)
  const graphSecond = ok(await service.graph({ cwd: active, offset: graphFirst.next, revision: graphFirst.revision })), graphRows = [...graphFirst.commits, ...graphSecond.commits]
  assert.equal(graphSecond.next, null); assert.equal(graphRows.length, 64); assert.equal(new Set(graphRows.map(row => row.id)).size, graphRows.length)
  assert(!graphRows.some(row => row.id === privateTip), 'private checkpoint roots are excluded'); assert(graphRows.some(row => row.id === remoteTip), 'disconnected remote tips are included')
  for (const [i, row] of graphRows.entries()) for (const parent of row.parents) { const at = graphRows.findIndex(candidate => candidate.id === parent); assert(at === -1 || at > i, 'parents follow children in topological order') }
  const merged = graphRows.find(row => row.id === mergeTip); assert.deepEqual(merged.parents, [graphTip, sideTip]); assert.equal(merged.body, '', 'graph pages omit bodies')
  assert(merged.refs.some(ref => ref.kind === 'head')); assert(merged.refs.some(ref => ref.kind === 'branch' && ref.name === 'main'))
  assert(graphRows.find(row => row.id === graphBase).refs.some(ref => ref.kind === 'tag' && ref.name === 'nested-tag'))
  assert(!graphRows.flatMap(row => row.refs).some(ref => ref.name === 'blob-tag'))
  assert.equal(ok(await service.commitDetails({ cwd: active, commit: mergeTip })).commit.body, 'Lazy commit body\n')
  assert.deepEqual(ok(await service.commitDetails({ cwd: active, commit: graphBase })).files, [{ path: 'root.txt', status: 'A' }])
  const rootSnapshot = await status(); assert.match(ok(await service.diff({ cwd: active, revision: rootSnapshot.revision, area: 'commit', commit: graphBase, path: 'root.txt' })).patch, /\+graph root/)
  const geometry = layoutGitGraph(graphRows), graphPositions = new Map(geometry.rows.map(row => [row.commit.id, row]))
  assert(geometry.laneCount > 1); assert.equal(geometry.edges.filter(edge => edge.fromHash === mergeTip).length, 2)
  for (const edge of geometry.edges) { assert.equal(edge.truncated, false); assert(graphPositions.get(edge.toHash).y > graphPositions.get(edge.fromHash).y) }
  assert.equal(layoutGitGraph([merged]).edges.filter(edge => edge.truncated).length, 2, 'page-boundary parents remain explicit')
  const startLayout = performance.now(), longChain = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), parents: i < 4999 ? [String(i + 1)] : [], refs: [], subject: '', author: '', date: '', body: '' }))
  const longLayout = layoutGitGraph(longChain); assert.equal(longLayout.rows.length, 5000); assert.equal(longLayout.paths.length, 4999); assert(performance.now() - startLayout < 2000, 'a 5,000-row linear layout stays bounded')
  for (const change of ['branch', 'remote', 'tag']) {
    const pinned = ok(await service.graph({ cwd: active })), ref = change === 'branch' ? 'refs/heads/feature' : change === 'remote' ? 'refs/remotes/origin/orphan' : 'refs/tags/new-tag'
    git(graphProject, 'update-ref', ref, graphTip)
    assert.equal(git(graphProject, 'rev-parse', 'HEAD'), mergeTip)
    rejected(await service.graph({ cwd: active, offset: 50, revision: pinned.revision }), 'stale')
  }
  const beforeShallow = ok(await service.graph({ cwd: active })); await writeFile(join(graphProject, '.git', 'shallow'), graphBase + '\n')
  rejected(await service.graph({ cwd: active, offset: 50, revision: beforeShallow.revision }), 'stale'); await rm(join(graphProject, '.git', 'shallow'))
  const beforeReplace = ok(await service.graph({ cwd: active })); git(graphProject, 'replace', sideTip, graphTip)
  rejected(await service.graph({ cwd: active, offset: 50, revision: beforeReplace.revision }), 'stale'); git(graphProject, 'replace', '-d', sideTip)
  git(graphProject, 'checkout', '--detach', mergeTip)
  const detachedGraph = ok(await service.graph({ cwd: active })); assert.equal(detachedGraph.branch, null); assert.equal(detachedGraph.head, mergeTip); assert(detachedGraph.commits.some(row => row.refs.some(ref => ref.kind === 'head')))
  active = nested
  // Renderer drops delayed status/diff from another workspace and preserves drafts.
  globalThis.window = { pi: {}, addEventListener() {}, removeEventListener() {} }
  const store = new GitStore(), delayed = []
  window.pi.gitStatus = ({ cwd }) => new Promise(resolve => delayed.push({ cwd, resolve }))
  window.pi.gitHistory = async () => ({ ok: true, value: { head: null, commits: [], next: null } }); window.pi.gitBranches = async () => ({ ok: true, value: [] })
  store.bind('A'); const readA = store.refresh(); store.setDraft('draft A'); store.bind('B'); const readB = store.refresh()
  const sample = await status()
  delayed.find(item => item.cwd === 'B').resolve({ ok: true, value: { ...sample, root: 'B' } }); await readB
  delayed.find(item => item.cwd === 'A').resolve({ ok: true, value: { ...sample, root: 'A' } }); await readA
  assert.equal(store.getState().repository.root, 'B'); store.bind('A'); assert.equal(store.getState().draft, 'draft A')
  store.setSplitWidth('changes', 500); store.setSplitWidth('history', 560); store.setSplitWidth('graph', 630)
  store.bind('B'); assert.deepEqual(store.getState().splitWidths, {})
  store.setSplitWidth('changes', 520, 'A'); assert.deepEqual(store.getState().splitWidths, {}, 'a finishing drag cannot change the newly active workspace')
  store.bind('A'); assert.deepEqual(store.getState().splitWidths, { changes: 520, history: 560, graph: 630 })
  for (const value of [NaN, Infinity, -1, 0, 10001]) store.setSplitWidth('changes', value)
  assert.equal(store.getState().splitWidths.changes, 520)
  window.pi.gitDiff = ({ path }) => new Promise(resolve => delayed.push({ path, resolve }))
  const diffA = store.select({ area: 'unstaged', path: 'old' }), diffB = store.select({ area: 'unstaged', path: 'new' })
  delayed.find(item => item.path === 'new').resolve({ ok: true, value: { patch: 'new', binary: false, truncated: false } }); await diffB
  delayed.find(item => item.path === 'old').resolve({ ok: true, value: { patch: 'old', binary: false, truncated: false } }); await diffA
  assert.equal(store.getState().diff.patch, 'new')
  const readsBeforeCache = delayed.length
  const cachedSelect = store.select({ area: 'unstaged', path: 'old' })
  assert.equal(store.getState().diff.patch, 'old'); assert.equal(store.getState().diffLoading, false); await cachedSelect
  assert.equal(delayed.length, readsBeforeCache, 'warm selection does not repeat IPC')
  const sameA = store.select({ area: 'unstaged', path: 'shared' }), sameB = store.select({ area: 'unstaged', path: 'shared' })
  assert.equal(delayed.filter(item => item.path === 'shared').length, 1, 'in-flight diff reads are shared')
  delayed.find(item => item.path === 'shared').resolve({ ok: true, value: { patch: 'shared', binary: false, truncated: false } }); await Promise.all([sameA, sameB])
  window.pi.gitStatus = async () => ({ ok: true, value: { ...sample, revision: 'cache-invalidated' } }); await store.refresh()
  const fresh = store.select({ area: 'unstaged', path: 'old' })
  assert.equal(delayed.filter(item => item.path === 'old').length, 2)
  delayed.filter(item => item.path === 'old').at(-1).resolve({ ok: true, value: { patch: 'fresh', binary: false, truncated: false } }); await fresh
  assert.equal(store.getState().diff.patch, 'fresh', 'a new repository revision cannot display cached old bytes')
  let failureReads = 0
  window.pi.gitDiff = async () => ++failureReads === 1 ? { ok: false, code: 'command' } : { ok: true, value: { patch: 'retried', binary: false, truncated: false } }
  await store.select({ area: 'unstaged', path: 'retry' }); assert.equal(store.getState().diffError.code, 'command')
  await store.select({ area: 'unstaged', path: 'retry' }); assert.equal(failureReads, 2); assert.equal(store.getState().diff.patch, 'retried'); store.dispose()
  // An old status read cannot overwrite a successful write, nor reset newer history navigation.
  const mutationStore = new GitStore(), reads = [], updated = { ...sample, revision: 'new-revision', files: [] }
  window.pi.gitStatus = async () => ({ ok: true, value: sample }); mutationStore.bind('C'); await mutationStore.refresh(); mutationStore.setDraft('Retain until committed')
  window.pi.gitStatus = () => new Promise(resolve => reads.push(resolve))
  window.pi.gitExecute = async () => ({ ok: true, value: { repository: updated, output: 'committed' } })
  window.pi.gitCommitFiles = async () => ({ ok: true, value: [{ path: 'README.md', status: 'A' }] })
  const oldRefresh = mutationStore.refresh(), mutation = mutationStore.execute('commit', { message: 'Retain until committed' })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(mutationStore.getState().repository.revision, 'new-revision'); assert(mutationStore.getState().busy)
  await mutationStore.selectCommit(history.commits[0])
  reads.shift()({ ok: true, value: sample }); await oldRefresh
  for (let i = 0; !reads.length && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  assert(reads.length); reads.shift()({ ok: true, value: updated }); await mutation
  assert.equal(mutationStore.getState().repository.revision, 'new-revision'); assert.equal(mutationStore.getState().commit.id, history.commits[0].id); assert.equal(mutationStore.getState().busy, null); assert.equal(mutationStore.getState().draft, ''); mutationStore.dispose()
  // A file selected while a write runs must be re-read at the resulting revision.
  const readingStore = new GitStore(), diffReads = [], makeFile = path => ({ path, index: '.', worktree: 'M', untracked: false, conflict: false, submodule: false })
  let readingRepo = { ...sample, revision: 'before-write', files: ['first', 'choice'].map(makeFile) }, settleWrite
  window.pi.gitStatus = async () => ({ ok: true, value: readingRepo })
  window.pi.gitDiff = request => new Promise(resolve => diffReads.push({ ...request, resolve }))
  window.pi.gitExecute = () => new Promise(resolve => { settleWrite = resolve })
  readingStore.bind('D'); await readingStore.refresh()
  const firstRead = readingStore.select({ area: 'unstaged', path: 'first' })
  const writing = readingStore.execute('stage', { paths: ['first'] })
  const duringWrite = readingStore.select({ area: 'unstaged', path: 'choice' })
  readingRepo = { ...readingRepo, revision: 'after-write' }
  settleWrite({ ok: true, value: { repository: readingRepo, output: '' } }); await writing
  assert(diffReads.some(read => read.path === 'choice' && read.revision === 'after-write'), 'the current file is refreshed even when a mutation receipt already published the new repository revision')
  for (const read of diffReads) read.resolve({ ok: true, value: { patch: read.revision, binary: false, truncated: false } })
  await Promise.all([firstRead, duringWrite]); await new Promise(resolve => setImmediate(resolve))
  assert.equal(readingStore.getState().selection.path, 'choice'); assert.equal(readingStore.getState().diff.patch, 'after-write'); assert.equal(readingStore.getState().diffLoading, false); readingStore.dispose()
  // Cached branches stay present while a read is pending; a write invalidates old flags.
  const branchStore = new GitStore(), branchPending = []
  let branchRepo = { ...sample, root: 'F', branch: 'main', revision: 'branch-main', files: [] }, delayBranches = false
  window.pi.gitStatus = async () => ({ ok: true, value: branchRepo })
  window.pi.gitBranches = () => delayBranches ? new Promise(resolve => branchPending.push(resolve)) : Promise.resolve({ ok: true, value: [{ name: 'main', current: true, worktree: 'F' }, { name: 'feature', current: false, worktree: null }, { name: 'occupied', current: false, worktree: 'elsewhere' }] })
  branchStore.bind('F'); await branchStore.refresh(); await branchStore.loadBranches(); delayBranches = true
  const cachedBranches = branchStore.loadBranches(); assert.equal(branchStore.getState().branches.length, 3); assert.equal(branchStore.getState().branchesLoading, true)
  window.pi.gitExecute = async () => { branchRepo = { ...branchRepo, branch: 'feature', revision: 'branch-feature' }; return { ok: true, value: { repository: branchRepo, output: '' } } }
  await branchStore.execute('switch', { branch: 'feature' })
  assert.equal(branchStore.getState().branches.find(row => row.name === 'main').worktree, null)
  assert.equal(branchStore.getState().branches.find(row => row.name === 'feature').current, true)
  assert.equal(branchStore.getState().branches.find(row => row.name === 'occupied').worktree, 'elsewhere')
  for (const resolve of branchPending) resolve({ ok: true, value: [{ name: 'main', current: true, worktree: 'F' }, { name: 'feature', current: false, worktree: null }] })
  await cachedBranches; await new Promise(resolve => setImmediate(resolve)); assert.equal(branchStore.getState().branches.find(row => row.name === 'feature').current, true); branchStore.dispose()
  // Graph requests are deduplicated, frontier changes restart pagination, and cwd races drop results.
  const graphStore = new GitStore(), graphReads = []
  window.pi.gitStatus = async ({ cwd }) => ({ ok: true, value: { ...sample, root: cwd } })
  window.pi.gitBranches = async () => ({ ok: true, value: [] })
  window.pi.gitGraph = request => new Promise(resolve => graphReads.push({ ...request, resolve }))
  graphStore.bind('G'); await graphStore.refresh(); graphStore.setDraft('Retained graph draft'); graphStore.setView('history'); graphStore.toggleGraph()
  const initialGraphRead = graphStore.loadGraph(); assert.equal(graphReads.length, 1)
  graphReads[0].resolve({ ok: true, value: graphFirst }); await initialGraphRead
  const graphIdentity = graphStore.getState().graph, backgroundGraph = graphStore.loadGraph(); graphReads[1].resolve({ ok: true, value: graphFirst }); await backgroundGraph
  assert.equal(graphStore.getState().graph, graphIdentity)
  const moreGraph = graphStore.loadGraph(true); assert.equal(graphReads[2].revision, graphFirst.revision); graphReads[2].resolve({ ok: false, code: 'stale' }); await moreGraph
  assert.equal(graphReads[3].offset, 0); graphReads[3].resolve({ ok: true, value: detachedGraph }); await graphStore.loadGraph()
  window.pi.gitCommitDetails = async () => ({ ok: true, value: { commit: { ...merged, body: 'Loaded lazily' }, files: [] } })
  await graphStore.selectCommit(merged); assert.equal(graphStore.getState().commit.body, 'Loaded lazily')
  const oldGraph = graphStore.loadGraph(); graphStore.bind('H'); await graphStore.refresh(); graphReads[4].resolve({ ok: true, value: graphFirst }); await oldGraph
  assert.equal(graphStore.getState().graph, null); graphStore.bind('G'); graphStore.toggleGraph(); assert.equal(graphStore.getState().view, 'history'); assert.equal(graphStore.getState().draft, 'Retained graph draft'); graphStore.dispose()
  // Simultaneous list/inspector surfaces keep their loading and failure ownership separate.
  const inspectorStore = new GitStore()
  window.pi.gitStatus = async () => ({ ok: true, value: sample })
  window.pi.gitHistory = async () => ({ ok: true, value: { ...history, head: sample.head } })
  window.pi.gitCommitFiles = async () => ({ ok: false, code: 'unsupported' })
  inspectorStore.bind('I'); await inspectorStore.refresh(); await inspectorStore.loadHistory()
  window.pi.gitHistory = async () => ({ ok: false, code: 'timeout' }); await inspectorStore.loadHistory()
  await inspectorStore.selectCommit(history.commits[0]); assert.equal(inspectorStore.getState().commitError.code, 'unsupported'); assert.equal(inspectorStore.getState().historyError.code, 'timeout')
  window.pi.gitCommitFiles = async () => ({ ok: true, value: [{ path: 'README.md', status: 'A' }] }); await inspectorStore.selectCommit(history.commits[0])
  assert.equal(inspectorStore.getState().commitError, null); assert.equal(inspectorStore.getState().historyError.code, 'timeout')
  window.pi.gitCommitFiles = async () => ({ ok: false, code: 'unsupported' }); await inspectorStore.selectCommit(history.commits[0])
  window.pi.gitHistory = async () => ({ ok: true, value: { ...history, head: sample.head } }); await inspectorStore.loadHistory()
  assert.equal(inspectorStore.getState().historyError, null); assert.equal(inspectorStore.getState().commitError.code, 'unsupported'); assert.equal(inspectorStore.getState().commit.id, history.commits[0].id)
  const listBeforeClose = inspectorStore.getState().history; await inspectorStore.selectCommit(null); assert.equal(inspectorStore.getState().history, listBeforeClose); assert.equal(inspectorStore.getState().commitError, null); inspectorStore.dispose()
  await writeFile(join(project, 'oversize.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
  assert.equal((await status()).files.find(file => file.path === 'oversize.txt').worktreeStats, null, 'unavailable counts do not fail the entire status')
  rejected(await service.diff({ cwd: active, revision: (await status()).revision, path: 'oversize.txt', area: 'unstaged' }), 'output-limit'); await rm(join(project, 'oversize.txt'))
  const runner = new GitRunner(); await assert.rejects(runner.run(project, ['log', '--format=%H'], { limit: 32 }), error => error.code === 'output-limit')
  if (process.platform !== 'win32') {
    const hook = join(project, '.git', 'hooks', 'pre-commit'), beforeTimeout = git(project, 'rev-parse', 'HEAD')
    await writeFile(hook, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n', { mode: 0o755 })
    await assert.rejects(runner.run(project, ['commit', '--allow-empty', '--file=-'], { input: 'Must time out', timeoutMs: 150 }), error => error.code === 'timeout')
    assert.equal(git(project, 'rev-parse', 'HEAD'), beforeTimeout); await rm(hook)
  }
  await runner.dispose()
  console.log('Git workbench: repository/staging/discard/history/graph/branches/remotes/conflicts/admission/cancellation/races passed')
} finally {
  await Promise.allSettled(services.map(service => service.dispose()))
  if (original.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = original.global
  if (original.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = original.system
  await rm(temporary, { recursive: true, force: true })
}
