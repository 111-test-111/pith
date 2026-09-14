import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PathIndex } from './paths'
import { BlobStore, atomicJson, digest, names, readJson } from './storage'
import { nodeEqual, RewindFailure, type GitState, type IndexEntry, type Snapshot } from './types'

const execute = promisify(execFile)
const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '.env', 'dist', 'build', '.pytest_cache', '.mypy_cache', '.cache', '.tox', '__pycache__'])
export function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...extra }
}
export async function git(root: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execute('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    env: gitEnvironment(extra), timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer'
  })
  try { return new TextDecoder('utf8', { fatal: true }).decode(stdout) }
  catch { throw new RewindFailure('unsupported') }
}
const outputLine = (value: string): string => value.endsWith('\n') ? value.slice(0, -1) : value
export async function scope(cwd: string): Promise<{ root: string; gitDir: string | null; indexPath: string | null }> {
  const canonical = await realpath(cwd)
  let top: string
  try { top = outputLine(await git(canonical, ['rev-parse', '--show-toplevel'])) }
  catch (error) {
    for (let cursor = canonical; ; cursor = dirname(cursor)) {
      const marker = await lstat(join(cursor, '.git')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (marker) throw new RewindFailure('storage')
      if (dirname(cursor) === cursor) break
    }
    if (error instanceof RewindFailure || !String((error as { stderr?: string }).stderr ?? '').includes('not a git repository')) throw new RewindFailure('storage')
    return { root: canonical, gitDir: null, indexPath: null }
  }
  const root = await realpath(top)
  const gitDir = await realpath(resolve(root, outputLine(await git(root, ['rev-parse', '--absolute-git-dir']))))
  const reportedIndex = resolve(root, outputLine(await git(root, ['rev-parse', '--git-path', 'index'])))
  const indexPath = join(await realpath(dirname(reportedIndex)), basename(reportedIndex))
  return { root, gitDir, indexPath }
}
export function safeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\0') && !path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
    && (process.platform !== 'win32' || (!path.includes('\\') && !path.includes(':')))
}
export function diskPath(root: string, path: string): string {
  if (!safeRelative(path)) throw new RewindFailure('corrupt', [path])
  const full = resolve(root, path)
  if (!relative(root, full) || relative(root, full).startsWith(`..${sep}`)) throw new RewindFailure('corrupt', [path])
  return full
}
export async function checkParents(root: string, path: string): Promise<void> {
  const parts = path.split('/'); parts.pop(); let cursor = root
  for (const part of parts) {
    cursor = join(cursor, part)
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new RewindFailure('changed', [path]) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
}
async function head(root: string): Promise<{ branch: string | null; head: string }> {
  const branch = await git(root, ['symbolic-ref', '--quiet', 'HEAD']).then(x => x.trim()).catch(() => null)
  const commit = await git(root, ['rev-parse', '--verify', 'HEAD']).then(x => x.trim()).catch(() => '')
  return { branch, head: commit }
}

/** One cat-file process for all new index objects, with streamed bodies. The
 * persistent oid→raw blob map avoids re-reading unchanged staging on each turn. */
export async function indexBlobs(root: string, entries: IndexEntry[], store: BlobStore, stateDir: string): Promise<void> {
  const cachePath = join(stateDir, 'git-blobs.json')
  const cache = await readJson<Record<string, string>>(cachePath).catch(() => ({} as Record<string, string>))
  const needed = new Set<string>()
  for (const entry of entries) {
    if (entry.mode === '160000' || entry.mode === '040000') continue
    if (cache[entry.oid] && await access(store.path(cache[entry.oid])).then(() => true, () => false)) entry.blob = cache[entry.oid]
    else { delete cache[entry.oid]; needed.add(entry.oid) }
  }
  if (needed.size) {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-C', root, 'cat-file', '--batch'], { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
    let childError: Error | null = null; child.on('error', error => { childError = error })
    const iterator = child.stdout[Symbol.asyncIterator]()
    let buffer = Buffer.alloc(0)
    async function fill(): Promise<void> {
      const next = await iterator.next()
      if (next.done) throw childError ?? new RewindFailure('corrupt')
      buffer = Buffer.from(next.value)
    }
    async function line(): Promise<string> {
      const parts: Buffer[] = []; let size = 0
      while (true) {
        if (!buffer.length) await fill()
        const end = buffer.indexOf(10)
        if (end >= 0) { parts.push(buffer.subarray(0, end)); buffer = buffer.subarray(end + 1); return Buffer.concat(parts).toString('ascii') }
        parts.push(buffer); size += buffer.length; buffer = Buffer.alloc(0)
        if (size > 1024) throw new RewindFailure('corrupt')
      }
    }
    const timer = setTimeout(() => child.kill(), 120_000)
    let pending: Promise<void>[] = []
    try {
      for (const oid of needed) {
        child.stdin.write(`${oid}\n`)
        const header = (await line()).split(' ')
        if (header[0] !== oid || header[1] !== 'blob' || !/^\d+$/.test(header[2] ?? '')) throw new RewindFailure('corrupt')
        let remaining = Number(header[2])
        const content = (async function* () {
          while (remaining) {
            if (!buffer.length) await fill()
            const n = Math.min(remaining, buffer.length); const part = buffer.subarray(0, n)
            buffer = buffer.subarray(n); remaining -= n; yield part
          }
        })()
        if (remaining <= 128 * 1024) {
          const chunks: Buffer[] = []
          for await (const chunk of content) chunks.push(chunk)
          const bytes = Buffer.concat(chunks)
          const write = store.buffer(bytes).then(saved => { cache[oid] = saved.hash })
          void write.catch(() => {})
          pending.push(write)
        } else {
          await Promise.all(pending); pending = []
          const saved = await store.put(content); cache[oid] = saved.hash
        }
        if (!buffer.length) await fill()
        if (buffer[0] !== 10) throw new RewindFailure('corrupt')
        buffer = buffer.subarray(1)
        // At most 2 MiB of buffered objects; concurrent fd syncs avoid a
        // serial flush for every tiny tracked file on the first snapshot.
        if (pending.length >= 16) { await Promise.all(pending); pending = [] }
      }
      await Promise.all(pending)
      child.stdin.end()
      if (childError || stderr.includes('fatal:')) throw new RewindFailure('corrupt')
      await atomicJson(cachePath, cache)
    } finally { clearTimeout(timer); child.kill(); await Promise.allSettled(pending) }
  }
  for (const entry of entries) if (cache[entry.oid]) entry.blob = cache[entry.oid]
}

export async function capture(cwd: string, store: BlobStore, stateDir: string, fresh = false, omit = new Set<string>()): Promise<Snapshot> {
  const location = await scope(cwd)
  const omitted = new PathIndex(omit)
  const { root } = location
  const nodes: Snapshot['nodes'] = Object.create(null)
  const excluded: Snapshot['excluded'] = []
  const missingPaths = new Set<string>()
  const candidates = new Set<string>(); const tracked = new Set<string>()
  let gitUntracked = ''; let gitIgnored = ''
  const directories = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true, encoding: 'buffer' })).map(entry => {
      let name: string
      try { name = new TextDecoder('utf8', { fatal: true }).decode(entry.name) } catch { throw new RewindFailure('unsupported') }
      return { name, directory: entry.isDirectory() }
    })
    directories.set(dir, entries.map(e => e.name).sort().join('\0'))
    for (const entry of entries) {
      const path = relative(root, join(dir, entry.name)).split(sep).join('/')
      if (omitted.contains(path)) continue
      if (IGNORED.has(entry.name)) { excluded.push({ path, reason: 'ignored' }); continue }
      candidates.add(path)
      if (entry.directory) await walk(join(dir, entry.name))
    }
  }
  let gitState: GitState | null = null
  if (location.gitDir && location.indexPath) {
    if ((await names(dirname(location.indexPath))).includes('index.lock')) throw new RewindFailure('busy')
    const initialHead = await head(root)
    const index = await store.capture(location.indexPath, fresh)
    if (index && index.kind !== 'file') throw new RewindFailure('unsupported', ['.git/index'])
    const stage = await git(root, ['ls-files', '--stage', '-z'])
    const entries: IndexEntry[] = stage.split('\0').filter(Boolean).map(record => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record)
      if (!match || !safeRelative(match[4])) throw new RewindFailure('unsupported')
      return { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] }
    })
    const submodules = new Set(entries.filter(e => e.mode === '160000').map(e => e.path))
    for (const path of submodules) excluded.push({ path, reason: 'submodule' })
    for (const entry of entries) if (!submodules.has(entry.path)) { tracked.add(entry.path); candidates.add(entry.path) }
    gitUntracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    const untracked = gitUntracked.split('\0').filter(Boolean)
    gitIgnored = await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'])
    const ignored = gitIgnored.split('\0').filter(Boolean)
    for (const path of ignored) excluded.push({ path: path.replace(/\/$/, ''), reason: 'ignored' })
    for (const path of untracked) if (!submodules.has(path.replace(/\/$/, ''))) candidates.add(path)
    const flags = await git(root, ['ls-files', '-v', '-z'])
    await indexBlobs(root, entries, store, stateDir)
    const sharedIndexes: GitState['sharedIndexes'] = Object.create(null)
    // Split-index links remain valid after GC; their bytes belong to the backup.
    for (const file of await names(location.gitDir)) if (/^sharedindex\.[a-f0-9]+$/.test(file)) {
      const node = await store.capture(join(location.gitDir, file), fresh)
      if (node && node.kind !== 'file') throw new RewindFailure('unsupported', [file])
      if (node) sharedIndexes[file] = node
    }
    gitState = { ...location, gitDir: location.gitDir, indexPath: location.indexPath, index, sharedIndexes, entries, flags, ...initialHead }
  } else {
    await walk(root)
  }
  const untrackedCounts = new Map<string, number>()
  for (const path of candidates) if (!tracked.has(path)) { const dir = dirname(path); untrackedCounts.set(dir, (untrackedCounts.get(dir) ?? 0) + 1) }
  for (const path of [...candidates].sort()) {
    if (omitted.contains(path)) continue
    if (!safeRelative(path)) throw new RewindFailure('unsupported', [path])
    if (!tracked.has(path)) {
      if (path.split('/').some(p => IGNORED.has(p))) { excluded.push({ path, reason: 'ignored' }); continue }
      if (dirname(path) !== '.' && (untrackedCounts.get(dirname(path)) ?? 0) >= 200) { excluded.push({ path, reason: 'directory-limit' }); continue }
      const info = await lstat(diskPath(root, path)).catch(() => null)
      if (info?.isFile() && info.size > 10 * 1024 * 1024) { excluded.push({ path, reason: 'large' }); continue }
    }
    let inaccessible = false
    const parts = path.split('/'); parts.pop(); let parentPath = ''
    for (const part of parts) {
      parentPath = parentPath ? `${parentPath}/${part}` : part
      const node = await store.capture(diskPath(root, parentPath), fresh)
      if (node) nodes[parentPath] = node
      if (!node || node.kind !== 'directory') { inaccessible = true; break }
    }
    if (inaccessible) continue
    try {
      const node = await store.capture(diskPath(root, path), fresh)
      if (node) nodes[path] = node; else missingPaths.add(path)
      let parent = dirname(path)
      while (parent !== '.') { if (!nodes[parent]) { const node = await store.capture(diskPath(root, parent), fresh); if (node) nodes[parent] = node }; parent = dirname(parent) }
    } catch (error) {
      if (error instanceof RewindFailure && error.code === 'unsupported') excluded.push({ path, reason: 'special' })
      else throw error
    }
  }
  const identities = new Map<string, string>()
  for (const path of Object.keys(nodes)) {
    const identity = store.identity(diskPath(root, path))
    if (!identity) throw new RewindFailure('changed', [path])
    const other = identities.get(identity)
    if (other && other !== path) throw new RewindFailure('unsupported', [other, path])
    identities.set(identity, path)
  }
  // Detect writes during the scan, including rename/addition and unchanged-size
  // edits. This is a consistency check, not a claim to freeze external writers.
  for (const path of Object.keys(nodes)) if (!await store.unchanged(diskPath(root, path))) throw new RewindFailure('changed', [path])
  for (const path of missingPaths) {
    const exists = await lstat(diskPath(root, path)).then(() => true, error => { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error })
    if (exists) throw new RewindFailure('changed', [path])
  }
  for (const [path, inventory] of directories) if ((await readdir(path)).sort().join('\0') !== inventory) throw new RewindFailure('changed', [path])
  if (gitState) {
    if (gitUntracked !== await git(root, ['ls-files', '--others', '--exclude-standard', '-z']) || gitIgnored !== await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'])) throw new RewindFailure('changed')
    if (!nodeEqual(gitState.index, await store.capture(gitState.indexPath, fresh)) || JSON.stringify(await head(root)) !== JSON.stringify({ branch: gitState.branch, head: gitState.head })) throw new RewindFailure('changed')
  }
  const sortedNodes = Object.fromEntries(Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b, 'en')))
  return { version: 1, root, nodes: sortedNodes, git: gitState, excluded,
    digest: digest(JSON.stringify({ nodes: sortedNodes, git: gitState && { index: gitState.index, head: gitState.head, branch: gitState.branch, flags: gitState.flags } })) }
}
