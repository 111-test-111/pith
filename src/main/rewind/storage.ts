import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, rename, unlink, link, lstat, readlink, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { RewindFailure, type NodeState } from './types'

export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)
export async function syncDirectory(path: string): Promise<void> {
  let fd: FileHandle | undefined
  try { fd = await open(path, 'r'); await fd.sync() }
  catch (error) { if (!['EINVAL', 'ENOTSUP', ...(process.platform === 'win32' ? ['EPERM', 'EISDIR'] : [])].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  finally { await fd?.close() }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  let fd: FileHandle | undefined
  try {
    fd = await open(temp, 'wx', 0o600)
    const payload = JSON.stringify(value)
    await fd.writeFile(JSON.stringify({ rewindFormat: 1, checksum: digest(payload), payload: value })); await fd.sync(); await fd.close(); fd = undefined
    await rename(temp, path); await syncDirectory(dirname(path))
  } finally { await fd?.close(); await unlink(temp).catch(() => {}) }
}
export async function readJson<T>(path: string): Promise<T> {
  try { const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const record = JSON.parse(await fd.readFile('utf8')); if (record.rewindFormat !== 1 || typeof record.checksum !== 'string' || digest(JSON.stringify(record.payload)) !== record.checksum) throw new RewindFailure('corrupt'); return record.payload as T } finally { await fd.close() } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RewindFailure('missing'); throw new RewindFailure('corrupt') }
}
export async function names(path: string): Promise<string[]> {
  try { return await readdir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export class BlobStore {
  private pendingDirectories = new Set<string>()
  private observed = new Map<string, { stamp: string; node: NodeState }>()
  constructor(readonly directory: string) {}
  path(hash: string): string { if (!/^[a-f0-9]{64}$/.test(hash)) throw new RewindFailure('corrupt'); return join(this.directory, hash.slice(0, 2), hash.slice(2)) }
  async put(chunks: AsyncIterable<Buffer>): Promise<{ hash: string; size: number }> {
    // Small source files dominate real repositories. Hash them before opening
    // a staging file, so existing content never incurs another write/fsync.
    const iterator = chunks[Symbol.asyncIterator](), prefix: Buffer[] = []
    let size = 0
    while (size <= 128 * 1024) {
      const item = await iterator.next()
      if (item.done) return this.buffer(Buffer.concat(prefix))
      const copy = Buffer.from(item.value); prefix.push(copy); size += copy.length
    }
    return this.writeChunks((async function* () {
      try {
        for (const chunk of prefix) yield chunk
        while (true) { const item = await iterator.next(); if (item.done) break; yield item.value }
      } finally { await iterator.return?.() }
    })())
  }
  private async writeChunks(chunks: AsyncIterable<Buffer>): Promise<{ hash: string; size: number }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = join(this.directory, `.${randomUUID()}.tmp`)
    const fd = await open(temp, 'wx', 0o600)
    const hasher = createHash('sha256'); let size = 0
    try {
      for await (const chunk of chunks) {
        hasher.update(chunk); size += chunk.length
        let offset = 0
        while (offset < chunk.length) { const { bytesWritten } = await fd.write(chunk, offset); offset += bytesWritten }
      }
      await fd.sync(); const hash = hasher.digest('hex'); const destination = this.path(hash)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      try {
        await link(temp, destination)
        for (const directory of [dirname(destination), this.directory, dirname(this.directory)]) this.pendingDirectories.add(directory)
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      return { hash, size }
    } finally { await fd.close(); await unlink(temp).catch(() => {}) }
  }
  async buffer(value: Buffer): Promise<{ hash: string; size: number }> {
    const hash = digest(value)
    const info = await lstat(this.path(hash)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.size !== value.length) throw new RewindFailure('corrupt')
      return { hash, size: value.length }
    }
    return this.writeChunks((async function* () { yield value })())
  }
  /** Every object fd is synced before publication. Batch directory durability
   * at the manifest boundary, before returning a checkpoint or writing a
   * prepared transaction. A crash before that boundary publishes no backup. */
  async flush(): Promise<void> {
    for (const path of this.pendingDirectories) { await syncDirectory(path); this.pendingDirectories.delete(path) }
  }
  async *chunks(hash: string): AsyncGenerator<Buffer> {
    const fd = await open(this.path(hash), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const hasher = createHash('sha256')
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024)
      while (true) { const { bytesRead } = await fd.read(buffer); if (!bytesRead) break; const chunk = Buffer.from(buffer.subarray(0, bytesRead)); hasher.update(chunk); yield chunk }
      if (hasher.digest('hex') !== hash) throw new RewindFailure('corrupt')
    } finally { await fd.close() }
  }
  async read(hash: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
    const buffers: Buffer[] = []; let size = 0
    for await (const chunk of this.chunks(hash)) { size += chunk.length; if (size > limit) throw new RewindFailure('unsupported'); buffers.push(chunk) }
    return Buffer.concat(buffers)
  }
  async verify(hash: string): Promise<void> { for await (const _chunk of this.chunks(hash)) { /* Streaming checksum, bounded memory. */ } }
  async prefix(hash: string, limit = 64 * 1024): Promise<Buffer> {
    const fd = await open(this.path(hash), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { const buffer = Buffer.allocUnsafe(limit); const { bytesRead } = await fd.read(buffer); return buffer.subarray(0, bytesRead) }
    finally { await fd.close() }
  }
  identity(path: string): string | undefined { return this.observed.get(path)?.stamp.split(':').slice(0, 2).join(':') }
  invalidate(): void { this.observed.clear() }
  async unchanged(path: string): Promise<boolean> {
    const info = await lstat(path, { bigint: true }).catch(error => { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error })
    const cached = this.observed.get(path)
    return !!info && cached?.stamp === [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(':')
  }
  async capture(path: string, fresh = false): Promise<NodeState | null> {
    let info
    try { info = await lstat(path, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null; throw error }
    const mode = Number(info.mode & 0o7777n)
    const stamp = [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(':')
    const cached = this.observed.get(path)
    if (!fresh && cached?.stamp === stamp) return cached.node
    let node: NodeState
    if (info.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(path, { encoding: 'buffer' }))
      node = { kind: 'symlink', ...await this.buffer(bytes), mode }
    } else if (info.isDirectory()) node = { kind: 'directory', hash: '', mode, size: 0 }
    else if (info.isFile() && info.nlink === 1n) {
      const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const actual = await fd.stat({ bigint: true })
        if (actual.dev !== info.dev || actual.ino !== info.ino) throw new RewindFailure('changed', [path])
        const stored = await this.put((async function* () {
          const buffer = Buffer.allocUnsafe(256 * 1024)
          while (true) { const { bytesRead } = await fd.read(buffer); if (!bytesRead) break; yield buffer.subarray(0, bytesRead) }
        })())
        const after = await fd.stat({ bigint: true })
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new RewindFailure('changed', [path])
        node = { kind: 'file', ...stored, mode }
      } finally { await fd.close() }
    } else throw new RewindFailure('unsupported', [path])
    const after = await lstat(path, { bigint: true })
    if (after.ino !== info.ino || after.ctimeNs !== info.ctimeNs) throw new RewindFailure('changed', [path])
    if (this.observed.size >= 100_000) this.observed.clear()
    this.observed.set(path, { stamp, node })
    return node
  }
}
