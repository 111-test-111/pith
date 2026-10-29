import type { RewindPatchDTO, RewindStatsDTO, RewindStatsTargetDTO, RewindUncoveredPathDTO } from '../../shared/types'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, lstat, rename, unlink, rmdir, symlink, chmod, link } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { RewindCheckpointDTO, RewindChangeDTO, RewindMode, RewindOperationDTO, RewindPreviewDTO } from '../../shared/types'
import { capture, checkParents, diskPath, gitEnvironment, scope } from './capture'
import { PathIndex } from './paths'
import { coveragePaths } from './coverage'
import { importLegacy, legacyDTO, legacyList } from './legacy'
import { BlobStore, atomicJson, digest, names, readJson, syncDirectory, validId } from './storage'
import { RewindFailure, nodeEqual, type Checkpoint, type NodeState, type PathChange, type RestorePlan, type Snapshot, type Transaction } from './types'

const PLAN_TTL = 15 * 60_000
const depth = (path: string): number => path.split('/').length
const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
const exists = async (path: string): Promise<boolean> => !!await lstat(path).catch(error => { if (isMissing(error)) return null; throw error })
function changes(before: Snapshot, after: Snapshot): PathChange[] {
  return [...new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])].sort().flatMap(path =>
    nodeEqual(before.nodes[path], after.nodes[path]) ? [] : [{ path, before: before.nodes[path] ?? null, after: after.nodes[path] ?? null }])
}
function checkpointDTO(cp: Checkpoint): RewindCheckpointDTO { const { version: _, snapshot: __, ...dto } = cp; return dto }
function operationDTO(tx: Transaction): RewindOperationDTO {
  const { version: _, plan: __, quarantine: ___, ...dto } = tx
  return { ...dto, ...(!['committed', 'rolled-back'].includes(tx.status) ? { recoveryPath: tx.quarantine } : {}) }
}

/** Pure Node engine, hosted off the Electron main thread. Durable records are
 * the authority: a returned git exit code alone never implies restoration. */
export class RewindEngine {
  readonly blobs: BlobStore
  private legacyCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof legacyList>> }>()
  private async legacy(root: string, sessionId: string) {
    const key = `${root}:${sessionId}`, cached = this.legacyCache.get(key)
    if (cached && Date.now() - cached.at < 30_000) return cached.value
    const value = await legacyList(root, sessionId)
    if (this.legacyCache.size > 100) this.legacyCache.clear()
    this.legacyCache.set(key, { at: Date.now(), value }); return value
  }
  private activeLocks = new Set<string>()
  constructor(readonly dataDir: string, private fault?: (phase: string, transaction: Transaction) => Promise<void>, private owner = randomUUID()) {
    this.blobs = new BlobStore(join(dataDir, 'objects'))
  }
  async directory(cwd: string): Promise<{ root: string; dir: string }> {
    const { root } = await scope(cwd)
    const dir = join(this.dataDir, 'checkouts', digest(root))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.reapLock(dir)
    return { root, dir }
  }
  private async reapLock(dir: string): Promise<void> {
    const path = join(dir, 'restore.lock')
    if (this.activeLocks.has(path)) return
    const owner = await readJson<{ owner: string; pid: number }>(path).catch(error => { if (error instanceof RewindFailure && error.code === 'missing') return null; throw error })
    if (!owner) return
    let dead = owner.owner === this.owner
    if (!dead && Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' } }
    if (dead) { await unlink(path); await syncDirectory(dir) }
  }
  private async records<T>(dir: string): Promise<T[]> {
    const result: T[] = []
    for (const name of await names(dir)) if (name.endsWith('.json')) result.push(await readJson<T>(join(dir, name)))
    return result
  }
  private async headers<T, H>(directory: string, project: (record: T) => H): Promise<H[]> {
    const result: H[] = []
    const headerDir = join(dirname(directory), `${basename(directory)}-headers`)
    for (const name of await names(directory)) {
      if (!name.endsWith('.json')) continue
      const path = join(directory, name), headerPath = join(headerDir, name)
      const stamp = await lstat(path, { bigint: true })
      const identity = [stamp.ino, stamp.size, stamp.mtimeNs, stamp.ctimeNs].join(':')
      const saved = await readJson<{ identity: string; value: H }>(headerPath).catch(() => null)
      if (saved?.identity === identity) result.push(saved.value)
      else {
        const value = project(await readJson<T>(path))
        await atomicJson(headerPath, { identity, value }); result.push(value)
      }
    }
    return result
  }
  private async omissions(dir: string): Promise<Set<string>> {
    return new Set([...(await this.headers<Transaction, RewindOperationDTO>(join(dir, 'transactions'), operationDTO)).map(tx => `.pith-rewind-${tx.id}`), ...(await names(join(dir, 'archives'))).filter(name => name.endsWith('.json')).map(name => `.pith-rewind-${name.slice(0, -5)}`)])
  }
  async list(cwd: string, sessionId: string): Promise<{ checkpoints: RewindCheckpointDTO[]; operations: RewindOperationDTO[]; pending: RewindOperationDTO[]; bytes: number }> {
    const { root, dir } = await this.directory(cwd)
    const all = await this.headers<Checkpoint, RewindCheckpointDTO & { stateDigest: string }>(join(dir, 'checkpoints'), cp => ({ ...checkpointDTO(cp), stateDigest: cp.snapshot.digest }))
    const transactions = await this.headers<Transaction, RewindOperationDTO>(join(dir, 'transactions'), operationDTO)
    const sorted = transactions.sort((a, b) => b.timestamp - a.timestamp)
    if (!sorted.some(tx => !['committed', 'rolled-back'].includes(tx.status)) && !await exists(join(dir, 'restore.lock'))) {
      await unlink(join(dir, 'recovery.json')).catch(error => { if (!isMissing(error)) throw error })
    }
    const committed = sorted.filter(tx => tx.status === 'committed')
    const latest = committed[0]
    const operations = sorted.filter(tx => tx.sessionId === sessionId).map(tx => ({ ...tx,
      canUndo: tx === latest && !tx.undoOf,
      canRedo: tx === latest && !!tx.undoOf
    }))
    const ids = new Set(all.map(cp => cp.id))
    const checkpoints = [...all.filter(cp => cp.sessionId === sessionId).map(({ stateDigest: _, ...cp }) => cp), ...(await this.legacy(root, sessionId)).filter(cp => !ids.has(cp.id)).map(legacyDTO)].sort((a, b) => b.timestamp - a.timestamp)
    return { checkpoints, operations, pending: sorted.filter(tx => !['committed', 'rolled-back'].includes(tx.status)), bytes: all.reduce((sum, cp) => sum + cp.bytes, 0) }
  }
  checkpoint(...args: Parameters<RewindEngine['checkpointStored']>): Promise<RewindCheckpointDTO> { return this.withStorage(() => this.checkpointStored(...args)) }
  private async checkpointStored(cwd: string, options: { sessionId: string; trigger: RewindCheckpointDTO['trigger']; messageTimestamp?: number; entryId: string | null; description?: string }): Promise<RewindCheckpointDTO> {
    if (options.trigger !== 'before-turn') throw new RewindFailure('unsupported')
    const { root, dir } = await this.directory(cwd)
    await this.assertNoPending(dir)
    const snapshot = await capture(root, this.blobs, dir, false, await this.omissions(dir))
    const existing = (await this.headers<Checkpoint, RewindCheckpointDTO & { stateDigest: string }>(join(dir, 'checkpoints'), cp => ({ ...checkpointDTO(cp), stateDigest: cp.snapshot.digest }))).filter(cp => cp.sessionId === options.sessionId).sort((a, b) => b.timestamp - a.timestamp)
    // Every user turn keeps its own anchor, even when bytes are unchanged.
    // CAS dedupes bytes; timepoints must not be deduped across messages.
    const cp: Checkpoint = { version: 1, id: randomUUID(), ...options, timestamp: Date.now(), description: options.description?.slice(0, 200) ?? '',
      branch: snapshot.git?.branch?.replace(/^refs\/heads\//, '') ?? null, files: Object.values(snapshot.nodes).filter(n => n.kind !== 'directory').length,
      bytes: Object.values(snapshot.nodes).reduce((sum, node) => sum + node.size, 0), excluded: snapshot.excluded, snapshot }
    await this.blobs.flush()
    await atomicJson(join(dir, 'checkpoints', `${cp.id}.json`), cp)
    for (const old of existing.slice(49)) await unlink(join(dir, 'checkpoints', `${old.id}.json`))
    return checkpointDTO(cp)
  }
  bindMessage(cwd: string, sessionId: string, checkpointId: string, entryId: string): Promise<void> {
    return this.withStorage(async () => {
      if (!validId(entryId)) throw new RewindFailure('missing')
      const { root, dir } = await this.directory(cwd)
      const cp = await this.loadCheckpoint(dir, sessionId, checkpointId, root)
      if (cp.trigger !== 'before-turn' || (cp.messageEntryId && cp.messageEntryId !== entryId)) throw new RewindFailure('changed')
      cp.messageEntryId = entryId
      await atomicJson(join(dir, 'checkpoints', `${cp.id}.json`), cp)
    })
  }
  private async assertNoPending(dir: string): Promise<void> {
    const pending = (await this.headers<Transaction, RewindOperationDTO>(join(dir, 'transactions'), operationDTO)).find(tx => !['committed', 'rolled-back'].includes(tx.status))
    if (pending) throw new RewindFailure('recovery', [], pending.id)
    if (await exists(join(dir, 'restore.lock'))) throw new RewindFailure('busy')
  }
  private async loadCheckpoint(dir: string, sessionId: string, id: string, root: string): Promise<Checkpoint> {
    if (!validId(id)) throw new RewindFailure('missing')
    const cp = await readJson<Checkpoint>(join(dir, 'checkpoints', `${id}.json`)).catch(async error => {
      if (!(error instanceof RewindFailure) || error.code !== 'missing' || !id.startsWith('legacy-')) throw error
      const source = (await this.legacy(root, sessionId)).find(cp => cp.id === id)
      if (!source) throw new RewindFailure('missing')
      const imported = await importLegacy(root, source, this.blobs, dir)
      await this.blobs.flush()
      await atomicJson(join(dir, 'checkpoints', `${id}.json`), imported)
      return imported
    })
    if (cp.sessionId !== sessionId || cp.version !== 1) throw new RewindFailure('missing')
    return cp
  }
  preview(...args: Parameters<RewindEngine['previewStored']>): Promise<RewindPreviewDTO> { return this.withStorage(() => this.previewStored(...args)) }
  private async previewStored(cwd: string, sessionId: string, targetId: string, action?: 'undo' | 'redo'): Promise<RewindPreviewDTO> {
    const { root, dir } = await this.directory(cwd)
    await this.assertNoPending(dir)
    let target: Snapshot; let undoOf: string | undefined; let redoOf: string | undefined; let actionTx: Transaction | undefined; let selected: Checkpoint | undefined
    if (action) {
      if (!validId(targetId)) throw new RewindFailure('missing')
      const tx = await readJson<Transaction>(join(dir, 'transactions', `${targetId}.json`))
      const list = await this.list(root, sessionId)
      const candidate = list.operations.find(op => op.id === tx.id)
      if (tx.sessionId !== sessionId || !(action === 'undo' ? candidate?.canUndo : candidate?.canRedo)) throw new RewindFailure('changed')
      target = tx.plan.before
      actionTx = tx
      if (action === 'undo') undoOf = tx.id; else redoOf = tx.id
    } else { selected = await this.loadCheckpoint(dir, sessionId, targetId, root); target = selected.snapshot }
    const before = await capture(root, this.blobs, dir, false, await this.omissions(dir))
    // Restoring never changes HEAD; a newer commit on the same branch stays put.
    let after: Snapshot = { ...target, git: target.git && before.git ? { ...target.git, head: before.git.head, branch: before.git.branch } : target.git }
    if (actionTx) {
      const nodes = { ...before.nodes }
      if (actionTx.mode !== 'conversation') for (const change of actionTx.plan.changes) {
        if (change.before) nodes[change.path] = change.before
        else delete nodes[change.path]
      }
      const restoreIndex = actionTx.mode !== 'conversation' && !nodeEqual(actionTx.plan.before.git?.index, actionTx.plan.after.git?.index)
      after = { ...after, nodes, git: restoreIndex ? after.git : before.git }
    }
    const protectedPaths = [...target.excluded, ...before.excluded]
    const protectedIndex = new PathIndex(protectedPaths.map(item => item.path))
    const protectedNodes = { ...after.nodes }
    for (const path of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
      if (!protectedIndex.contains(path)) continue
      if (before.nodes[path]) protectedNodes[path] = before.nodes[path]; else delete protectedNodes[path]
    }
    after = { ...after, nodes: protectedNodes }
    const plan: RestorePlan = { version: 1, token: randomUUID(), created: Date.now(), sessionId, targetId, before, after, changes: changes(before, after), undoOf, redoOf, file: actionTx?.file, skipped: actionTx?.skipped, conversationUnavailable: selected?.conversationUnavailable }
    let blocked: RewindPreviewDTO['blocked']
    if (target.root !== root || target.git?.branch !== before.git?.branch || target.git?.gitDir !== before.git?.gitDir) blocked = { code: 'branch' }
    const targetFiles = new PathIndex(Object.entries(target.nodes).filter(([, node]) => node.kind !== 'directory').map(([path]) => path))
    const destructive = new PathIndex(plan.changes.filter(change => change.after?.kind !== 'directory').map(change => change.path))
    const collisions = before.excluded.filter(item => targetFiles.atOrBelow(item.path) || destructive.overlaps(item.path)).map(item => item.path)
    if (collisions.length) blocked = { code: 'unsupported', paths: collisions }
    // A gitlink's working checkout is intentionally outside this snapshot.
    if (JSON.stringify(target.git?.entries.filter(e => e.mode === '160000')) !== JSON.stringify(before.git?.entries.filter(e => e.mode === '160000'))) blocked = { code: 'unsupported', paths: target.excluded.filter(e => e.reason === 'submodule').map(e => e.path) }
    plan.blocked = blocked
    const rows: RewindChangeDTO[] = []
    for (const change of plan.changes) {
      rows.push({ path: change.path, area: 'worktree', kind: !change.before ? 'added' : !change.after ? 'deleted' : 'modified',
        singleFile: !action && change.before?.kind !== 'directory' && change.after?.kind !== 'directory',
        binary: await this.binary(change.before, change.after), beforeMode: change.before?.mode, afterMode: change.after?.mode, bytes: Math.max(change.before?.size ?? 0, change.after?.size ?? 0) })
    }
    const oldEntries = new Map(before.git?.entries.map(e => [`${e.stage}:${e.path}`, e]) ?? [])
    const newEntries = new Map(after.git?.entries.map(e => [`${e.stage}:${e.path}`, e]) ?? [])
    for (const key of new Set([...oldEntries.keys(), ...newEntries.keys()])) {
      const old = oldEntries.get(key), next = newEntries.get(key)
      if (old?.oid === next?.oid && old?.mode === next?.mode) continue
      rows.push({ path: (next ?? old)!.path, stage: (next ?? old)!.stage, area: 'index', kind: !old ? 'added' : !next ? 'deleted' : 'modified', binary: false, bytes: 0,
        beforeMode: old ? parseInt(old.mode, 8) : undefined, afterMode: next ? parseInt(next.mode, 8) : undefined })
    }
    if (!nodeEqual(before.git?.index, after.git?.index) && !rows.some(row => row.area === 'index')) rows.push({ path: '', area: 'index', kind: 'modified', binary: true, bytes: 0 })
    await this.savePreview(dir, plan)
    return { file: plan.file, scopeRoot: root, uncovered: plan.skipped, token: plan.token, checkpointId: targetId, conversationUnavailable: plan.conversationUnavailable, changes: rows, excluded: [...new Map(protectedPaths.map(item => [`${item.path}:${item.reason}`, item])).values()], blocked, action, ...(action ? { operationId: targetId } : {}) }
  }
  private async savePreview(dir: string, plan: RestorePlan): Promise<void> {
    await this.blobs.flush()
    await atomicJson(join(dir, 'previews', `${plan.token}.json`), plan)
    const previews = await this.records<RestorePlan>(join(dir, 'previews'))
    for (const old of previews.sort((a, b) => b.created - a.created).filter((p, i) => i >= 24 || Date.now() - p.created > PLAN_TTL)) await unlink(join(dir, 'previews', `${old.token}.json`)).catch(() => {})
  }
  /** Derive from the reviewed immutable bytes, never rescan into a different
   * implicit target. Only absent directory parents may join the selected leaf. */
  previewFile(cwd: string, sessionId: string, token: string, file: string): Promise<RewindPreviewDTO> {
    return this.withStorage(async () => {
      const { root, dir } = await this.directory(cwd)
      await this.assertNoPending(dir)
      const source = await this.plan(dir, sessionId, token)
      if (source.file || source.undoOf || source.redoOf) throw new RewindFailure('unsupported')
      if (source.blocked) throw new RewindFailure(source.blocked.code, source.blocked.paths)
      const selected = source.changes.find(change => change.path === file)
      if (!selected || selected.before?.kind === 'directory' || selected.after?.kind === 'directory') throw new RewindFailure('unsupported', [file])
      const nodes = { ...source.before.nodes }
      if (selected.after) {
        nodes[file] = selected.after
        for (let parent = dirname(file); parent !== '.'; parent = dirname(parent)) {
          const current = nodes[parent], desired = source.after.nodes[parent]
          if (current?.kind === 'directory') continue
          if (current || desired?.kind !== 'directory') throw new RewindFailure('unsupported', [parent])
          nodes[parent] = desired
        }
      } else delete nodes[file]
      const after = { ...source.before, nodes }
      const plan: RestorePlan = { ...source, token: randomUUID(), created: Date.now(), file, after, changes: changes(source.before, after) }
      await this.savePreview(dir, plan)
      return { token: plan.token, file, scopeRoot: root, checkpointId: plan.targetId,
        changes: [{ path: file, area: 'worktree', kind: !selected.before ? 'added' : !selected.after ? 'deleted' : 'modified',
          binary: await this.binary(selected.before, selected.after), beforeMode: selected.before?.mode, afterMode: selected.after?.mode,
          bytes: Math.max(selected.before?.size ?? 0, selected.after?.size ?? 0) }], excluded: [] }
    })
  }
  private async binary(...nodes: (NodeState | null)[]): Promise<boolean> {
    for (const node of nodes) if (node?.hash) {
      const bytes = await this.blobs.prefix(node.hash)
      if (bytes.includes(0)) return true
      try { new TextDecoder('utf8', { fatal: true }).decode(bytes, { stream: true }) } catch { return true }
    }
    return false
  }
  private async plan(dir: string, sessionId: string, token: string): Promise<RestorePlan> {
    if (!validId(token)) throw new RewindFailure('expired')
    const plan = await readJson<RestorePlan>(join(dir, 'previews', `${token}.json`)).catch(() => { throw new RewindFailure('expired') })
    if (plan.version !== 1 || plan.sessionId !== sessionId || Date.now() - plan.created > PLAN_TTL) throw new RewindFailure('expired')
    return plan
  }
  patch(...args: Parameters<RewindEngine['patchStored']>): Promise<RewindPatchDTO> { return this.withStorage(() => this.patchStored(...args)) }
  private async patchStored(cwd: string, sessionId: string, token: string, path: string, area: 'worktree' | 'index', stage = 0): Promise<RewindPatchDTO> {
    const { dir } = await this.directory(cwd); const plan = await this.plan(dir, sessionId, token)
    const [old, next] = this.diffNodes(plan, path, area, stage)
    if (await this.binary(old, next)) return { patch: '', truncated: false, binary: true }
    const [oldHash, newHash] = await this.diffHashes(old, next)
    // No filters, external diff programs or pathname interpretation. Raw blobs
    // are immutable; output is loaded only for the requested visible file.
    const result = await this.gitInput(plan.before.root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', this.blobs.path(oldHash), this.blobs.path(newHash)], undefined, true)
    const lines = result.output.split('\n')
    let inHunk = false
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) inHunk = true
      if (inHunk) continue
      if (lines[i].startsWith('diff --git ')) lines[i] = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}`
      else if (lines[i].startsWith('--- ')) lines[i] = old ? `--- ${JSON.stringify(`a/${path}`)}` : '--- /dev/null'
      else if (lines[i].startsWith('+++ ')) lines[i] = next ? `+++ ${JSON.stringify(`b/${path}`)}` : '+++ /dev/null'
    }
    return { patch: lines.join('\n'), truncated: result.truncated }
  }
  /** Exact Git numstat, independent of the bounded/possibly truncated patch.
   * This small response is safe to request for a collapsed visible header. */
  stats(cwd: string, sessionId: string, token: string, path: string, area: 'worktree' | 'index', stage = 0): Promise<RewindStatsDTO> {
    return this.withStorage(async () => {
      const { dir } = await this.directory(cwd), plan = await this.plan(dir, sessionId, token)
      return this.countStats(plan, { path, area, stage })
    })
  }
  /** Small batches amortize manifest/scope reads. Returning between batches
   * lets visible diffs and restore commands use the same worker promptly. */
  statsBatch(cwd: string, sessionId: string, token: string, targets: RewindStatsTargetDTO[]): Promise<RewindStatsDTO[]> {
    return this.withStorage(async () => {
      if (!Array.isArray(targets) || targets.length > 16 || targets.some(target => !target || typeof target.path !== 'string'
        || !['worktree', 'index'].includes(target.area) || !Number.isInteger(target.stage ?? 0) || (target.stage ?? 0) < 0 || (target.stage ?? 0) > 3)) throw new RewindFailure('missing')
      const { dir } = await this.directory(cwd), plan = await this.plan(dir, sessionId, token)
      const results: RewindStatsDTO[] = []
      for (let start = 0; start < targets.length; start += 4) results.push(...await Promise.all(targets.slice(start, start + 4).map(target => this.countStats(plan, target))))
      return results
    })
  }
  private async countStats(plan: RestorePlan, target: RewindStatsTargetDTO): Promise<RewindStatsDTO> {
    const [old, next] = this.diffNodes(plan, target.path, target.area, target.stage ?? 0)
    if (await this.binary(old, next)) return { added: 0, removed: 0, binary: true }
    const [oldHash, newHash] = await this.diffHashes(old, next)
    if (oldHash === newHash) return { added: 0, removed: 0, binary: false }
    const result = await this.gitInput(plan.before.root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--', this.blobs.path(oldHash), this.blobs.path(newHash)], undefined, true)
    if (result.output.startsWith('-\t-\t')) return { added: 0, removed: 0, binary: true }
    const counts = /^(\d+)\t(\d+)\t/.exec(result.output)
    if (!counts || result.truncated) throw new RewindFailure('storage')
    return { added: Number(counts[1]), removed: Number(counts[2]), binary: false }
  }
  private diffNodes(plan: RestorePlan, path: string, area: 'worktree' | 'index', stage: number): [NodeState | null, NodeState | null] {
    let old: NodeState | null, next: NodeState | null
    if (area === 'worktree') {
      const change = plan.changes.find(c => c.path === path)
      if (!change) throw new RewindFailure('missing')
      old = change.before; next = change.after
    } else {
      const a = plan.before.git?.entries.find(e => e.path === path && e.stage === stage), b = plan.after.git?.entries.find(e => e.path === path && e.stage === stage)
      old = a?.blob ? { kind: 'file', hash: a.blob, mode: parseInt(a.mode, 8), size: 0 } : null
      next = b?.blob ? { kind: 'file', hash: b.blob, mode: parseInt(b.mode, 8), size: 0 } : null
    }
    return [old, next]
  }
  private async diffHashes(old: NodeState | null, next: NodeState | null): Promise<[string, string]> {
    const oldHash = old?.hash || (await this.blobs.buffer(Buffer.alloc(0))).hash
    const newHash = next?.hash || (await this.blobs.buffer(Buffer.alloc(0))).hash
    await this.blobs.verify(oldHash); await this.blobs.verify(newHash)
    return [oldHash, newHash]
  }
  private async gitInput(root: string, args: string[], input?: AsyncIterable<Buffer>, diff = false): Promise<{ output: string; truncated: boolean }> {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; let truncated = false
    const decoder = new StringDecoder('utf8')
    child.stdout.on('data', chunk => { const text = decoder.write(chunk); if (output.length < 2 * 1024 * 1024) output += text; else truncated = true })
    child.stderr.resume()
    const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 || (diff && code === 1) ? resolve() : reject(new RewindFailure('storage'))) })
    void done.catch(() => {})
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      if (input) for await (const chunk of input) { if (!child.stdin.write(chunk)) await new Promise<void>((resolve, reject) => { child.stdin.once('drain', resolve); child.stdin.once('error', reject) }) }
      child.stdin.end(); await done; if (!truncated) output += decoder.end()
      return { output, truncated }
    } finally { clearTimeout(timer); child.kill() }
  }
  private async lock(dir: string, operationId: string, recover = false): Promise<() => Promise<void>> {
    const path = join(dir, 'restore.lock')
    if (recover) await this.reapLock(dir)
    const candidate = join(dir, `.lock-${randomUUID()}.json`)
    await atomicJson(candidate, { owner: this.owner, pid: process.pid, operationId })
    try { await link(candidate, path); await syncDirectory(dir); this.activeLocks.add(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RewindFailure('busy'); throw error }
    finally { await unlink(candidate) }
    return async () => { this.activeLocks.delete(path); await unlink(path); await syncDirectory(dir) }
  }
  private async withStorage<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const release = await this.lock(this.dataDir, 'storage', true)
    try { return await operation() } finally { await release() }
  }
  /** Mark/sweep shares the admission lock with every backup writer, including
   * writers in another application process. Only old, unreferenced CAS files
   * are removed. Pending operations and live previews are always roots. */
  maintenance(now = Date.now(), graceMs = 24 * 60 * 60_000): Promise<{ bytes: number; removed: number }> {
    return this.withStorage(async () => {
      const reachable = new Set<string>()
      const mark = (snapshot: Snapshot, includeIndex = true): void => {
        for (const node of Object.values(snapshot.nodes)) if (node.hash) reachable.add(node.hash)
        if (!includeIndex) return
        if (snapshot.git?.index?.hash) reachable.add(snapshot.git.index.hash)
        for (const node of Object.values(snapshot.git?.sharedIndexes ?? {})) if (node.hash) reachable.add(node.hash)
        for (const entry of snapshot.git?.entries ?? []) if (entry.blob) reachable.add(entry.blob)
      }
      for (const checkout of await names(join(this.dataDir, 'checkouts'))) {
        if (!/^[a-f0-9]{64}$/.test(checkout)) continue
        const dir = join(this.dataDir, 'checkouts', checkout)
        for (const cp of await this.records<Checkpoint>(join(dir, 'checkpoints'))) mark(cp.snapshot)
        for (const plan of await this.records<RestorePlan>(join(dir, 'previews'))) {
          if (now - plan.created > PLAN_TTL) await unlink(join(dir, 'previews', `${plan.token}.json`))
          else { mark(plan.before); mark(plan.after) }
        }
        const transactions = (await this.records<Transaction>(join(dir, 'transactions'))).sort((a, b) => b.timestamp - a.timestamp)
        let retained = 0
        for (const tx of transactions) {
          const terminal = ['committed', 'rolled-back'].includes(tx.status)
          if (terminal) await this.cleanup(tx)
          if (terminal && ++retained > 100) {
            // Retain the result and token binding for idempotent old requests;
            // old history does not need full copies of the file manifests.
            await atomicJson(join(dir, 'archives', `${tx.id}.json`), { ...operationDTO(tx), token: tx.plan.token })
            await unlink(join(dir, 'transactions', `${tx.id}.json`))
          } else {
            const indexChanged = !nodeEqual(tx.plan.before.git?.index, tx.plan.after.git?.index)
            mark(tx.plan.before, indexChanged); mark(tx.plan.after, indexChanged)
          }
        }
        for (const area of ['checkpoints', 'transactions']) {
          const live = new Set(await names(join(dir, area)))
          for (const name of await names(join(dir, `${area}-headers`))) if (!live.has(name) && name.endsWith('.json')) await unlink(join(dir, `${area}-headers`, name))
        }
      }
      let bytes = 0, removed = 0
      for (const prefix of await names(this.blobs.directory)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue
        const directory = join(this.blobs.directory, prefix)
        for (const suffix of await names(directory)) {
          if (!/^[a-f0-9]{62}$/.test(suffix)) continue
          const path = join(directory, suffix), info = await lstat(path)
          if (!info.isFile() || info.isSymbolicLink()) throw new RewindFailure('corrupt')
          if (!reachable.has(prefix + suffix) && now - info.mtimeMs > graceMs) { await unlink(path); removed++ }
          else bytes += info.size
        }
        await syncDirectory(directory)
      }
      this.blobs.invalidate()
      await atomicJson(join(this.dataDir, 'usage.json'), { bytes, removed, timestamp: now })
      return { bytes, removed }
    })
  }
  private async save(dir: string, tx: Transaction): Promise<void> {
    const marker = join(dir, 'recovery.json')
    const terminal = ['committed', 'rolled-back'].includes(tx.status)
    // Admission marker precedes the first journal and every workspace write.
    // A crash between the terminal journal and marker removal only blocks
    // admission conservatively; list() can reconcile that harmless remnant.
    if (!terminal) await atomicJson(marker, { root: tx.plan.before.root, operationId: tx.id })
    await atomicJson(join(dir, 'transactions', `${tx.id}.json`), tx)
    if (terminal) { await unlink(marker).catch(error => { if (!isMissing(error)) throw error }); await syncDirectory(dir) }
  }
  async prepare(...args: Parameters<RewindEngine['prepareStored']>): Promise<RewindOperationDTO> {
    try { return await this.withStorage(() => this.prepareStored(...args)) }
    catch (error) {
      // Unknown I/O errors can also occur while releasing a durable lock,
      // after files have changed. Fence admission until the journal is read.
      if (error instanceof RewindFailure) throw error
      throw new RewindFailure('recovery', [], args[4])
    }
  }
  private async prepareStored(cwd: string, sessionId: string, token: string, mode: RewindMode, operationId: string, beforeEntryId: string | null, afterEntryId: string | null, sessionPath?: string,
    coverage?: { uncovered: RewindUncoveredPathDTO[]; confirmed: boolean }): Promise<RewindOperationDTO> {
    if (!validId(operationId)) throw new RewindFailure('missing')
    const { root, dir } = await this.directory(cwd)
    const saved = await readJson<Transaction>(join(dir, 'transactions', `${operationId}.json`)).catch(error => { if (error instanceof RewindFailure && error.code === 'missing') return null; throw error })
    if (saved) {
      if (saved.sessionId !== sessionId || saved.plan.token !== token || saved.mode !== mode) throw new RewindFailure('changed')
      if (saved.status === 'committed' || saved.status === 'files-applied') return operationDTO(saved)
      throw new RewindFailure('recovery', [], saved.id)
    }
    const archive = await readJson<RewindOperationDTO & { token: string }>(join(dir, 'archives', `${operationId}.json`)).catch(error => { if (error instanceof RewindFailure && error.code === 'missing') return null; throw error })
    if (archive) {
      if (archive.sessionId !== sessionId || archive.token !== token || archive.mode !== mode || archive.status !== 'committed') throw new RewindFailure('changed')
      const { token: _, ...dto } = archive; return dto
    }
    await this.assertNoPending(dir)
    const release = await this.lock(dir, operationId)
    let tx: Transaction | undefined
    try {
      const plan = await this.plan(dir, sessionId, token)
      if (plan.file && mode !== 'files') throw new RewindFailure('unsupported')
      if (plan.undoOf || plan.redoOf) {
        const latest = (await this.headers<Transaction, RewindOperationDTO>(join(dir, 'transactions'), operationDTO)).filter(tx => tx.status === 'committed').sort((a, b) => b.timestamp - a.timestamp)[0]
        if (latest?.id !== (plan.undoOf ?? plan.redoOf)) throw new RewindFailure('changed')
      }
      if (mode !== 'files' && plan.conversationUnavailable) throw new RewindFailure('unsupported')
      const skipped = mode === 'conversation' ? [] : plan.skipped ?? coverage?.uncovered ?? []
      if (skipped.length) {
        if (coverage?.confirmed !== true) throw new RewindFailure('uncovered', skipped.map(item => item.path))
        // Consent permits leaving known missing originals alone, never adding
        // them to the immutable write set or changing their Git index entries.
        const touched = plan.changes.map(change => change.path)
        if (!nodeEqual(plan.before.git?.index, plan.after.git?.index)) {
          // The raw index is replaced as a whole, including flags/stat caches;
          // equal OIDs alone cannot prove a skipped entry stays untouched.
          for (const snapshot of [plan.before, plan.after]) for (const entry of snapshot.git?.entries ?? []) touched.push(entry.path)
        }
        const paths = new PathIndex(touched)
        for (const item of skipped) if ((await coveragePaths(root, item.path)).some(path => path === '' ? touched.length > 0 : paths.overlaps(path))) throw new RewindFailure('unsupported', [item.path])
        if (mode === 'files' && !plan.changes.length && nodeEqual(plan.before.git?.index, plan.after.git?.index)) throw new RewindFailure('uncovered', skipped.map(item => item.path))
      }
      const current = await capture(root, this.blobs, dir, true, await this.omissions(dir))
      if (mode !== 'conversation' && (current.root !== plan.before.root || current.git?.gitDir !== plan.before.git?.gitDir || current.git?.indexPath !== plan.before.git?.indexPath)) throw new RewindFailure('changed')
      if (mode !== 'conversation' && current.digest !== plan.before.digest) throw new RewindFailure('changed')
      if (mode === 'conversation') { plan.before = current; plan.after = current; plan.changes = [] }
      if (mode !== 'conversation' && plan.blocked) throw new RewindFailure(plan.blocked.code, plan.blocked.paths)
      if (plan.before.root !== root || plan.after.root !== root || plan.before.git?.gitDir !== plan.after.git?.gitDir) throw new RewindFailure('branch')
      const destructive = new PathIndex(plan.changes.filter(change => change.after?.kind !== 'directory').map(change => change.path))
      const collisions = current.excluded.filter(item => destructive.overlaps(item.path))
      if (mode !== 'conversation' && collisions.length) throw new RewindFailure('unsupported', collisions.map(c => c.path))
      if (mode !== 'conversation') await this.verifyBackup(plan)
      const metadataOnDisk = current.git && (await lstat(current.git.gitDir)).dev === (await lstat(root)).dev
      const quarantineParent = metadataOnDisk ? join(current.git!.gitDir, 'pith-rewind') : root
      if (metadataOnDisk) await mkdir(quarantineParent, { recursive: true, mode: 0o700 })
      const quarantine = join(quarantineParent, `.pith-rewind-${operationId}`)
      if (await exists(quarantine)) throw new RewindFailure('changed', [quarantine])
      const touched = new Set(plan.changes.map(change => change.path))
      plan.before = { ...plan.before, nodes: Object.fromEntries(Object.entries(plan.before.nodes).filter(([path]) => touched.has(path))) }
      plan.after = { ...plan.after, nodes: Object.fromEntries(Object.entries(plan.after.nodes).filter(([path]) => touched.has(path))) }
      tx = { version: 1, id: operationId, timestamp: Date.now(), sessionId, targetId: plan.targetId, mode, status: 'prepared', beforeEntryId, afterEntryId, sessionPath,
        plan, quarantine, file: plan.file, skipped: skipped.length ? skipped : undefined, undoOf: plan.undoOf, redoOf: plan.redoOf }
      await this.blobs.flush()
      await this.save(dir, tx)
      await mkdir(quarantine, { mode: 0o700 }); await syncDirectory(quarantineParent)
      await atomicJson(join(quarantine, 'owner.json'), { id: tx.id, root })
      await this.fault?.('prepared', tx)
      if (mode !== 'conversation') await this.apply(tx)
      tx.status = 'files-applied'; await this.save(dir, tx)
      await this.fault?.('files-applied', tx)
      return operationDTO(tx)
    } catch (error) {
      if (tx) {
        try { await this.rollbackFiles(tx); tx.status = 'rolled-back'; await this.save(dir, tx); await this.cleanup(tx) }
        catch (rollback) {
          tx.status = 'conflict'; tx.conflicts = rollback instanceof RewindFailure ? rollback.paths : []
          await this.save(dir, tx)
          throw Object.assign(new RewindFailure('recovery', tx.conflicts, tx.id), { cause: error, rollback })
        }
      }
      throw error
    } finally { await release() }
  }
  private async verifyBackup(plan: RestorePlan): Promise<void> {
    const hashes = new Set<string>()
    for (const change of plan.changes) for (const node of [change.before, change.after]) if (node?.hash) hashes.add(node.hash)
    if (!nodeEqual(plan.before.git?.index, plan.after.git?.index)) for (const snapshot of [plan.before, plan.after]) {
      if (snapshot.git?.index?.hash) hashes.add(snapshot.git.index.hash)
      for (const node of Object.values(snapshot.git?.sharedIndexes ?? {})) if (node.hash) hashes.add(node.hash)
      for (const entry of snapshot.git?.entries ?? []) if (entry.blob) hashes.add(entry.blob)
    }
    for (const hash of hashes) await this.blobs.verify(hash)
  }
  private async stageNode(path: string, node: NodeState): Promise<void> {
    if (node.kind === 'directory') { await mkdir(path, { recursive: false, mode: node.mode }); await chmod(path, node.mode); await syncDirectory(path); return }
    if (node.kind === 'symlink') { await symlink(await this.blobs.read(node.hash, 64 * 1024), path); return }
    const fd = await open(path, 'wx', node.mode)
    try {
      for await (const chunk of this.blobs.chunks(node.hash)) { let offset = 0; while (offset < chunk.length) offset += (await fd.write(chunk, offset)).bytesWritten }
      await fd.chmod(node.mode); await fd.sync()
    } finally { await fd.close() }
  }
  private async apply(tx: Transaction): Promise<void> {
    const { root } = tx.plan.before
    // Remove leaves before directories. Renaming a directory with unknown
    // descendants is forbidden; rmdir fails closed if an external file appeared.
    const removed = [...tx.plan.changes].sort((a, b) => depth(b.path) - depth(a.path))
    for (const change of removed) {
      if (!change.before) continue
      await checkParents(root, change.path)
      const path = diskPath(root, change.path)
      const current = await this.blobs.capture(path, true)
      if (!nodeEqual(current, change.before)) throw new RewindFailure('changed', [change.path])
      if (!current) continue
      if (current.kind === 'directory') {
        if (change.after?.kind !== 'directory') { await rmdir(path); await syncDirectory(dirname(path)) }
        continue
      }
      const slot = join(tx.quarantine, digest(change.path))
      await rename(path, slot); await syncDirectory(dirname(path)); await syncDirectory(tx.quarantine)
      const displaced = await this.blobs.capture(slot, true)
      if (!nodeEqual(displaced, change.before)) throw new RewindFailure('changed', [change.path])
      await this.fault?.('quarantined', tx)
    }
    for (const change of [...tx.plan.changes].sort((a, b) => depth(a.path) - depth(b.path))) {
      if (!change.after) continue
      await checkParents(root, change.path)
      const path = diskPath(root, change.path)
      if (change.after.kind === 'directory' && change.before?.kind === 'directory') { await chmod(path, change.after.mode); await syncDirectory(path); continue }
      if (await exists(path)) throw new RewindFailure('changed', [change.path])
      if (change.after.kind !== 'file') await this.stageNode(path, change.after)
      else {
        const temp = join(tx.quarantine, `output-${digest(change.path)}`)
        await this.stageNode(temp, change.after); await syncDirectory(tx.quarantine)
        await this.fault?.('file-staged', tx)
        // link is an atomic no-replace publish on supported local filesystems.
        // A concurrently created destination can never be overwritten.
        await link(temp, path); await syncDirectory(dirname(path))
        await this.fault?.('file-linked', tx)
        await unlink(temp); await syncDirectory(tx.quarantine)
      }
      await syncDirectory(dirname(path)); await this.fault?.('installed', tx)
    }
    if (!nodeEqual(tx.plan.before.git?.index, tx.plan.after.git?.index)) await this.installIndex(tx, false)
    await this.verifyApplied(tx, false)
  }
  private async installIndex(tx: Transaction, backwards: boolean): Promise<void> {
    await this.clearIndexStaging(tx)
    const target = (backwards ? tx.plan.before : tx.plan.after).git
    const expected = (backwards ? tx.plan.after : tx.plan.before).git
    if (!target || !expected) { if (target !== expected) throw new RewindFailure('unsupported'); return }
    const current = await this.blobs.capture(target.indexPath, true)
    if (!nodeEqual(current, expected.index) && !nodeEqual(current, target.index)) throw new RewindFailure('changed', ['.git/index'])
    if (nodeEqual(current, target.index)) return
    const indexLock = `${target.indexPath}.lock`
    const staged = join(target.gitDir, `.pith-rewind-index-${tx.id}`)
    const lock = await open(staged, 'wx', 0o600)
    let claimed = false
    try {
      await lock.writeFile(`pith-rewind ${tx.id}\n`); await lock.sync()
      // The retained hardlink proves ownership even if the process dies in
      // the gap between acquiring index.lock and writing its first bytes.
      await link(staged, indexLock); claimed = true; await syncDirectory(target.gitDir)
      await this.fault?.('index-locked', tx)
      if (!nodeEqual(await this.blobs.capture(target.indexPath, true), expected.index)) throw new RewindFailure('changed', ['.git/index'])
      for (const [name, node] of Object.entries(target.sharedIndexes)) {
        const path = join(target.gitDir, name)
        const existing = await this.blobs.capture(path, true)
        if (existing && !nodeEqual(existing, node)) throw new RewindFailure('changed', [name])
        if (!existing) await this.stageNode(path, node)
      }
      // CAS holds staged-only blobs too; rehydrate any objects collected by Git.
      const unique = new Map(target.entries.filter(e => e.blob).map(e => [e.oid, e.blob!]))
      const objectIds = [...unique.keys()]
      for (let offset = 0; offset < objectIds.length; offset += 4096) {
        const batch = objectIds.slice(offset, offset + 4096)
        const check = await this.gitInput(tx.plan.before.root, ['cat-file', '--batch-check'], (async function* () { yield Buffer.from(batch.join('\n') + '\n') })())
        if (check.truncated || check.output.trim().split('\n').length !== batch.length) throw new RewindFailure('corrupt')
        for (const line of check.output.trim().split('\n')) if (line.endsWith(' missing')) {
          const oid = line.split(' ')[0]; const hash = unique.get(oid)
          if (!hash) throw new RewindFailure('corrupt')
          const stored = await this.gitInput(tx.plan.before.root, ['hash-object', '-w', '--no-filters', '--stdin'], this.blobs.chunks(hash))
          if (stored.output.trim() !== oid) throw new RewindFailure('corrupt')
        }
      }
      if (target.index) {
        await lock.truncate(0); let position = 0
        for await (const chunk of this.blobs.chunks(target.index.hash)) { let offset = 0; while (offset < chunk.length) { const n = (await lock.write(chunk, offset, chunk.length - offset, position)).bytesWritten; offset += n; position += n } }
        await lock.chmod(target.index.mode); await lock.sync(); await lock.close()
        await this.fault?.('index-staged', tx)
        await rename(indexLock, target.indexPath)
      } else { await lock.close(); await unlink(target.indexPath).catch(error => { if (!isMissing(error)) throw error }); await unlink(indexLock) }
      await unlink(staged)
      await syncDirectory(dirname(target.indexPath)); await this.fault?.('index-installed', tx)
    } finally { await lock.close().catch(() => {}); if (claimed) await this.clearIndexStaging(tx); else await unlink(staged).catch(() => {}) }
  }
  private async clearIndexStaging(tx: Transaction): Promise<void> {
    const git = tx.plan.before.git
    if (!git) return
    const staged = join(git.gitDir, `.pith-rewind-index-${tx.id}`)
    const info = await lstat(staged).catch(error => { if (isMissing(error)) return null; throw error })
    if (!info) return
    const lockPath = `${git.indexPath}.lock`
    const lock = await lstat(lockPath).catch(error => { if (isMissing(error)) return null; throw error })
    if (lock) {
      if (info.ino !== lock.ino || info.dev !== lock.dev) throw new RewindFailure('busy', ['.git/index.lock'], tx.id)
      await unlink(lockPath)
    }
    await unlink(staged); await syncDirectory(git.gitDir)
  }
  private async verifyApplied(tx: Transaction, backwards: boolean): Promise<void> {
    if (!backwards) {
      const actualScope = await scope(tx.plan.before.root)
      if (actualScope.root !== tx.plan.before.root || (actualScope.gitDir ?? undefined) !== tx.plan.before.git?.gitDir || (actualScope.indexPath ?? undefined) !== tx.plan.before.git?.indexPath) throw new RewindFailure('changed', ['.git'], tx.id)
    }
    for (const change of tx.plan.changes) {
      const actual = await this.observePath(tx.plan.before.root, change.path)
      if (!nodeEqual(actual, backwards ? change.before : change.after)) throw new RewindFailure('changed', [change.path], tx.id)
    }
    const target = (backwards ? tx.plan.before : tx.plan.after).git
    if (!nodeEqual(tx.plan.before.git?.index, tx.plan.after.git?.index) && target && !nodeEqual(await this.blobs.capture(target.indexPath, true), target.index)) throw new RewindFailure('changed', ['.git/index'], tx.id)
  }
  private async observePath(root: string, path: string): Promise<NodeState | null> {
    // An absent child beneath a restored file/symlink is absent in this
    // worktree. Never traverse that symlink to inspect an unrelated directory.
    const parts = path.split('/'); parts.pop(); let cursor = root
    for (const part of parts) {
      cursor = join(cursor, part)
      const info = await lstat(cursor).catch(error => { if (isMissing(error)) return null; throw error })
      if (!info?.isDirectory() || info.isSymbolicLink()) return null
    }
    return this.blobs.capture(diskPath(root, path), true)
  }
  /** A retained hardlink is our durable ownership proof for no-replace
   * publishing. Remove that extra link before the raw observer enforces its
   * normal hardlink exclusion, including a crash during rollback itself. */
  private async clearPublishedLinks(tx: Transaction): Promise<void> {
    for (const change of tx.plan.changes) {
      if (change.before?.kind !== 'file' && change.after?.kind !== 'file') continue
      try { await checkParents(tx.plan.before.root, change.path) } catch (error) { if (error instanceof RewindFailure && error.code === 'changed') continue; throw error }
      const destination = diskPath(tx.plan.before.root, change.path)
      const actual = await lstat(destination).catch(error => { if (isMissing(error)) return null; throw error })
      if (!actual) continue
      for (const name of [digest(change.path), `output-${digest(change.path)}`]) {
        const retained = join(tx.quarantine, name)
        const info = await lstat(retained).catch(error => { if (isMissing(error)) return null; throw error })
        if (info && actual.ino === info.ino && actual.dev === info.dev && info.isFile()) {
          await unlink(retained); await syncDirectory(tx.quarantine)
        }
      }
    }
  }
  private async rollbackFiles(tx: Transaction): Promise<void> {
    if (tx.mode === 'conversation') return
    await this.clearIndexStaging(tx)
    await this.clearPublishedLinks(tx)
    const { root } = tx.plan.before
    // Delete only verified output of this transaction. External replacement
    // bytes are never overwritten by compensation; quarantine stays available.
    for (const change of [...tx.plan.changes].sort((a, b) => depth(b.path) - depth(a.path))) {
      const path = diskPath(root, change.path), slot = join(tx.quarantine, digest(change.path))
      const actual = await this.observePath(root, change.path)
      if (!actual || nodeEqual(actual, change.before)) continue
      if (!nodeEqual(actual, change.after)) throw new RewindFailure('changed', [change.path], tx.id)
      if (actual.kind === 'directory') {
        if (change.before?.kind !== 'directory') { await rmdir(path); await syncDirectory(dirname(path)) }
        else { await chmod(path, change.before.mode); await syncDirectory(path) }
      }
      else {
        const discarded = join(tx.quarantine, `rollback-${digest(change.path)}`)
        if (await exists(discarded)) throw new RewindFailure('changed', [change.path], tx.id)
        await rename(path, discarded); await syncDirectory(dirname(path)); await syncDirectory(tx.quarantine)
        if (!nodeEqual(await this.blobs.capture(discarded, true), change.after)) throw new RewindFailure('changed', [change.path], tx.id)
      }
      // The displaced original remains in slot until the operation is resolved.
      if (await exists(slot)) await this.blobs.capture(slot, true)
    }
    for (const change of [...tx.plan.changes].sort((a, b) => depth(a.path) - depth(b.path))) {
      if (!change.before) continue
      await checkParents(root, change.path)
      const path = diskPath(root, change.path), slot = join(tx.quarantine, digest(change.path))
      const actual = await this.blobs.capture(path, true)
      if (actual) {
        if (!nodeEqual(actual, change.before)) throw new RewindFailure('changed', [change.path], tx.id)
        continue
      }
      if (await exists(slot)) {
        // A raced preimage is retained in quarantine rather than being replaced
        // by the older backup. Report the conflict instead of claiming rollback.
        const displaced = await this.blobs.capture(slot, true)
        if (!nodeEqual(displaced, change.before)) throw new RewindFailure('changed', [change.path], tx.id)
        if (displaced!.kind === 'symlink') await this.stageNode(path, displaced!)
        else { await link(slot, path); await syncDirectory(dirname(path)); await this.fault?.('rollback-linked', tx) }
        await unlink(slot); await syncDirectory(tx.quarantine)
      } else await this.stageNode(path, change.before)
      await syncDirectory(dirname(path))
    }
    if (!nodeEqual(tx.plan.before.git?.index, tx.plan.after.git?.index)) await this.installIndex(tx, true)
    await this.verifyApplied(tx, true)
  }
  finish(...args: Parameters<RewindEngine['finishStored']>): Promise<RewindOperationDTO> { return this.withStorage(() => this.finishStored(...args)) }
  private async finishStored(cwd: string, sessionId: string, operationId: string, commit: boolean): Promise<RewindOperationDTO> {
    if (!validId(operationId)) throw new RewindFailure('missing')
    const { dir } = await this.directory(cwd)
    const release = await this.lock(dir, operationId, true)
    try {
      const tx = await readJson<Transaction>(join(dir, 'transactions', `${operationId}.json`))
      if (tx.sessionId !== sessionId) throw new RewindFailure('missing')
      if (['committed', 'rolled-back'].includes(tx.status)) { await this.cleanup(tx); return operationDTO(tx) }
      if (commit) {
        if (tx.status !== 'files-applied') throw new RewindFailure('recovery', [], tx.id)
        if (tx.mode !== 'conversation') await this.verifyApplied(tx, false)
        tx.status = 'committed'
      } else {
        await this.rollbackFiles(tx); tx.status = 'rolled-back'
      }
      await this.save(dir, tx)
      await this.fault?.('committed', tx)
      // Quarantine deletion happens only after durable verification. Keep it
      // through crashes and conflicts; removing it never drives state changes.
      await this.cleanup(tx)
      return operationDTO(tx)
    } finally { await release() }
  }
  private async cleanup(tx: Transaction): Promise<void> {
    try {
      const owner = await readJson<{ id: string; root: string }>(join(tx.quarantine, 'owner.json'))
      if (owner.id !== tx.id || owner.root !== tx.plan.before.root) return
      for (const name of await names(tx.quarantine)) await unlink(join(tx.quarantine, name))
      await rmdir(tx.quarantine); await syncDirectory(dirname(tx.quarantine))
    } catch { /* Verified terminal record remains authoritative; GC retries cleanup. */ }
  }
  navigation(...args: Parameters<RewindEngine['navigationStored']>): Promise<{ before?: string | null; after: string | null }> { return this.withStorage(() => this.navigationStored(...args)) }
  private async navigationStored(cwd: string, sessionId: string, token: string): Promise<{ before?: string | null; after: string | null }> {
    const { dir } = await this.directory(cwd), plan = await this.plan(dir, sessionId, token)
    if (plan.undoOf || plan.redoOf) {
      const tx = await readJson<Transaction>(join(dir, 'transactions', `${plan.undoOf ?? plan.redoOf}.json`))
      return { before: tx.afterEntryId, after: tx.beforeEntryId }
    }
    return { after: (await this.loadCheckpoint(dir, sessionId, plan.targetId, plan.before.root)).entryId }
  }
}
