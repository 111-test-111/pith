import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { RESOURCE_STORAGE_CATEGORIES } from '../../shared/resources'
import type { ResourceStorageCategory, ResourceStorageDTO, ResourceStorageEntryDTO, ResourceStorageIssueDTO, ResourceStorageRootDTO, ResourceStorageRootKind } from '../../shared/resources'

export interface StorageScanOptions {
  roots: { kind: ResourceStorageRootKind; path: string }[]
  /** Supplied by the owning main service, never by a renderer path argument. */
  appData: string
  agentData: string
  library: string
  sessionData: string
}

export const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel))
}

/** All files are included; categories are presentation and do not gate walking.
 * Unknown/new persisted data falls into Other rather than disappearing. */
function classifier(options: StorageScanOptions): (path: string) => ResourceStorageCategory {
  const candidates: { root: string; category: ResourceStorageCategory }[] = [
    { root: options.appData, category: 'other' }, { root: options.agentData, category: 'configuration' },
    { root: options.sessionData, category: 'browser' }, { root: options.library, category: 'library' },
    { root: join(options.appData, 'library'), category: 'library' },
    { root: join(options.appData, 'rewind'), category: 'rewind' },
    { root: join(options.appData, 'bash-tasks'), category: 'logs' },
    { root: join(options.appData, 'workspace'), category: 'workspace' },
    { root: join(options.agentData, 'sessions'), category: 'sessions' },
    ...['skills', 'extensions', 'npm', 'packages', 'git', 'bin', 'debug-adapters'].map(name => ({ root: join(options.agentData, name), category: 'extensions' as const })),
    ...options.roots.filter(root => root.kind === 'logs' || root.kind === 'crashes').map(root => ({ root: root.path, category: 'logs' as const }))
  ]
  // sessionData commonly equals userData. It must not label unrelated data as
  // browser storage merely because Chromium shares the same directory.
  if (options.sessionData === options.appData) candidates.splice(2, 1)
  candidates.sort((a, b) => b.root.length - a.root.length)
  return path => {
  const match = candidates.find(rule => isWithin(path, rule.root))
  if (match && !['other', 'browser', 'configuration'].includes(match.category)) return match.category
  const base = match?.root ?? options.appData
  const segments = relative(base, path).split(sep), first = segments[0], name = basename(path)
  if (base === options.appData) {
    if (/^trajectory\.sqlite(?:-(?:wal|shm|journal))?$/.test(first)) return 'trajectory'
    if (/^library\.sqlite(?:-(?:wal|shm|journal))?$/.test(first)) return 'library'
    if (/^(?:session-search\.sqlite(?:-(?:wal|shm|journal))?|session-list-cache\.json)$/.test(first)) return 'indexes'
    if (/^(?:app-settings\.json|jev-auth\.json|browser-import\.json|subagents|runtime\.lock)$/.test(first)) return 'configuration'
  }
  if (segments.some(segment => /^(?:Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|GraphiteDawnCache|ShaderCache|cache)$/i.test(segment))) return 'cache'
  if (/^(?:logs|Crashpad|Crash Reports|crashDumps)$/i.test(first) || /\.log$/.test(name)) return 'logs'
  if (match?.category === 'browser' || /^(?:Partitions|Local Storage|Session Storage|IndexedDB|Service Worker|blob_storage|databases|File System|Network|Cookies|Cookies-journal|DIPS|DIPS-wal|DIPS-shm|WebStorage|Shared Dictionary|SharedStorage|SharedStorage-wal|SharedStorage-shm|Preferences|Local State|TransportSecurity|Network Persistent State|Reporting and NEL|Trust Tokens|Trust Tokens-journal)$/i.test(first)) return 'browser'
  return match?.category ?? 'other'
  }
}

export function storageCategory(path: string, options: StorageScanOptions): ResourceStorageCategory { return classifier(options)(path) }

export async function scanStorage(input: StorageScanOptions, allocationSupported = process.platform !== 'win32'): Promise<ResourceStorageDTO> {
  const startedAt = Date.now(), issues: ResourceStorageIssueDTO[] = []
  let issueCount = 0
  const issue = (path: string, reason: ResourceStorageIssueDTO['reason']) => {
    issueCount++
    if (issues.length < 32) issues.push({ path, reason })
  }
  const canonical = new Map<string, string>()
  const roots: ResourceStorageRootDTO[] = []
  for (const root of input.roots) {
    try {
      const path = await realpath(root.path)
      canonical.set(resolve(root.path), path)
      roots.push({ ...root, path, status: 'ok' })
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      roots.push({ ...root, path: resolve(root.path), status: missing ? 'missing' : 'unreadable' })
      if (!missing) issue(root.path, 'unreadable')
    }
  }
  const pathFor = (path: string): string => canonical.get(resolve(path)) ?? resolve(path)
  const options: StorageScanOptions = { appData: pathFor(input.appData), agentData: pathFor(input.agentData),
    library: pathFor(input.library), sessionData: pathFor(input.sessionData), roots }
  const entries: ResourceStorageEntryDTO[] = RESOURCE_STORAGE_CATEGORIES.map(category => ({ category,
    logicalBytes: 0, allocatedBytes: allocationSupported ? 0 : null, files: 0 }))
  const byCategory = new Map(entries.map(entry => [entry.category, entry]))
  const categorize = classifier(options)
  const seen = new Map<string, { entry: ResourceStorageEntryDTO; logical: number; allocated: number; file: boolean }>(), directories: string[] = []
  // Broader roots cover nested roots. Keep all descriptors to explain scope.
  const starts: string[] = []
  for (const root of roots.filter(root => root.status === 'ok').sort((a, b) => a.path.length - b.path.length)) {
    if (!starts.some(parent => isWithin(root.path, parent))) starts.push(root.path)
  }
  const add = (entry: ResourceStorageEntryDTO, key: 'logicalBytes' | 'allocatedBytes', value: bigint, path: string): void => {
    if (entry[key] === null) return
    const number = Number(value)
    if (value < 0n || !Number.isSafeInteger(number) || !Number.isSafeInteger(entry[key]! + number)) { issue(path, 'overflow'); return }
    entry[key]! += number
  }
  const inspect = async (path: string): Promise<void> => {
    try {
      const info = await lstat(path, { bigint: true })
      // Hard links and overlapping physical roots count once. An inode of 0
      // means the filesystem did not provide an identity; keep the path then.
      const identity = info.ino === 0n ? path : `${info.dev}:${info.ino}`
      const entry = byCategory.get(categorize(path))!, before = seen.get(identity)
      if (before) {
        // Stable attribution when a hard link crosses categories: the category
        // registry's order wins, regardless of concurrent stat completion.
        if (before.file && entries.indexOf(entry) < entries.indexOf(before.entry)) {
          before.entry.logicalBytes -= before.logical; entry.logicalBytes += before.logical
          if (allocationSupported) { before.entry.allocatedBytes! -= before.allocated; entry.allocatedBytes! += before.allocated }
          before.entry.files--; entry.files++; before.entry = entry
        }
        return
      }
      const file = info.isFile() || info.isSymbolicLink()
      const logical = file ? Number(info.size) : 0, allocated = allocationSupported ? Number(info.blocks * 512n) : 0
      if (!Number.isSafeInteger(logical) || !Number.isSafeInteger(allocated)) { issue(path, 'overflow'); return }
      seen.set(identity, { entry, logical, allocated, file })
      if (allocationSupported) add(entry, 'allocatedBytes', info.blocks * 512n, path)
      if (info.isDirectory()) { directories.push(path); return }
      if (file) { add(entry, 'logicalBytes', info.size, path); entry.files++ }
      // lstat deliberately measures the link itself and never follows it into
      // projects, other applications or symlink cycles.
    } catch (error) { issue(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'changed' : 'unreadable') }
  }
  for (const path of starts) await inspect(path)
  while (directories.length) {
    const path = directories.pop()!, pending = new Set<Promise<void>>()
    try {
      // A directory replaced by a symlink since lstat must not expand scope.
      if (await realpath(path) !== path) { issue(path, 'changed'); continue }
      const directory = await opendir(path)
      let unchanged: boolean
      try { unchanged = await realpath(path) === path }
      catch (error) { await directory.close(); throw error }
      if (!unchanged) { await directory.close(); issue(path, 'changed'); continue }
      for await (const child of directory) {
        const work = inspect(join(path, child.name))
        pending.add(work)
        void work.finally(() => pending.delete(work))
        if (pending.size >= 16) await Promise.race(pending)
      }
    } catch (error) { issue(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'changed' : 'unreadable') }
    await Promise.all(pending)
  }
  const logicalBytes = entries.reduce((sum, entry) => sum + entry.logicalBytes, 0)
  const allocatedBytes = allocationSupported ? entries.reduce((sum, entry) => sum + entry.allocatedBytes!, 0) : null
  if (!Number.isSafeInteger(logicalBytes) || (allocatedBytes !== null && !Number.isSafeInteger(allocatedBytes))) throw new Error('storage-overflow')
  return { startedAt, completedAt: Date.now(), logicalBytes, allocatedBytes, files: entries.reduce((sum, entry) => sum + entry.files, 0),
    entries, roots, partial: issueCount > 0, issueCount, issues }
}
