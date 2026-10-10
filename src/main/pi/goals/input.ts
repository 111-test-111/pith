import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, unlink, rm } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import type { GoalInput, GoalPendingInputDTO } from '../../../shared/goal'
import { resolveFilePath } from '../../file-path'
import { fileKindOf } from '../files'
import { validateGeneratedImage } from '../image-output'

const MAX_FILE = 12 * 1024 * 1024
const MAX_TOTAL = 32 * 1024 * 1024
const MAX_TEXT = 512 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
interface Ref { hash: string; bytes: number; extension?: string }
interface Receipt {
  version: 1; goalId: string; sessionId: string; cwd: string
  status: 'pending' | 'accepted' | 'superseded'
  files: Array<Ref & { path: string }>; images: Array<Ref & { mimeType: string }>; blocks: Ref
}
export interface PreparedGoalInput extends GoalInput { fileBlocks: string }
export class GoalInputError extends Error {}
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new GoalInputError('goal-input-cancelled') }
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, 'r'); try { await fd.sync() } finally { await fd.close() }
}
async function atomic(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const fd = await open(temporary, 'wx', 0o600)
    try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
    await rename(temporary, path); await syncDirectory(dirname(path))
  } finally { await unlink(temporary).catch(() => {}) }
}
/** Private immutable bytes. Events/snapshots carry only bounded path/count metadata. */
export class GoalInputStorage {
  private root: string
  constructor(userData: string, private sessionId: string) { this.root = join(userData, 'goals', 'input') }
  private directory(id: string): string { return join(this.root, digest(Buffer.from(`${this.sessionId}\0${id}`))) }
  private receipt(id: string): Receipt {
    const path = join(this.directory(id), 'receipt.json')
    if (statSync(path).size > 64 * 1024) throw new GoalInputError('goal-input-invalid')
    const r: Receipt = JSON.parse(readFileSync(path, 'utf8'))
    const validRef = (ref: Ref) => ref && /^[a-f0-9]{64}$/.test(ref.hash) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= MAX_FILE &&
      (ref.extension === undefined || /^\.[a-z0-9]{1,20}$/.test(ref.extension))
    if (r.version !== 1 || r.goalId !== id || r.sessionId !== this.sessionId || !isAbsolute(r.cwd) || r.cwd.includes('\0') ||
      !['pending', 'accepted', 'superseded'].includes(r.status) || !Array.isArray(r.files) || r.files.length > 12 ||
      !Array.isArray(r.images) || r.images.length > 8 || !validRef(r.blocks) ||
      r.files.some(f => !validRef(f) || typeof f.path !== 'string' || !isAbsolute(f.path) || f.path.includes('\0') || f.path.length > 8192) ||
      r.images.some(i => !validRef(i) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(i.mimeType)) ||
      [...r.files, ...r.images].reduce((sum, ref) => sum + ref.bytes, 0) > MAX_TOTAL) throw new GoalInputError('goal-input-invalid')
    return r
  }
  private consumed(id: string): boolean { return existsSync(join(this.directory(id), 'consumed.json')) }
  inspect(id: string): GoalPendingInputDTO {
    try {
      const r = this.receipt(id)
      const available = r.status === 'pending' && !this.consumed(id) && [...r.files, ...r.images, r.blocks].every(ref => {
        try { return statSync(join(this.directory(id), ref.hash + (ref.extension ?? ''))).size === ref.bytes } catch { return false }
      })
      return { cwd: r.cwd, files: r.files.map(f => f.path), imageCount: r.images.length, available }
    } catch { return { cwd: '', files: [], imageCount: 0, available: false } }
  }
  acceptedWithoutAttachments(id: string, cwd: string): boolean {
    try { const r = this.receipt(id); return (r.status === 'accepted' || this.consumed(id)) && r.cwd === cwd && !r.files.length && !r.images.length }
    catch { return false }
  }
  async discard(id: string): Promise<void> { await rm(this.directory(id), { recursive: true, force: true }) }
  async capture(id: string, cwd: string, input: GoalInput, signal: AbortSignal): Promise<PreparedGoalInput> {
    if ((input.files?.length ?? 0) > 12 || (input.images?.length ?? 0) > 8) throw new GoalInputError('goal-input-limit')
    const directory = this.directory(id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Persist every newly created parent before the goal definition can reference it.
    for (const path of [dirname(dirname(this.root)), dirname(this.root), this.root, directory]) await syncDirectory(path)
    let total = 0
    const put = async (bytes: Buffer, extension?: string): Promise<Ref> => {
      check(signal)
      const ref = { hash: digest(bytes), bytes: bytes.length, ...(extension ? { extension } : {}) }
      await atomic(join(directory, ref.hash + (extension ?? '')), bytes)
      check(signal); return ref
    }
    const bounded = (bytes: number) => {
      total += bytes
      if (bytes > MAX_FILE || total > MAX_TOTAL) throw new GoalInputError('goal-input-limit')
    }
    const files: Receipt['files'] = [], images: Receipt['images'] = [], blocks: string[] = []
    for (const path of input.files ?? []) {
      check(signal)
      const absolute = resolveFilePath({ cwd, path })
      if (absolute.length > 8192) throw new GoalInputError('goal-input-invalid')
      const fd = await open(absolute, 'r').catch(() => { throw new GoalInputError('goal-input-file') })
      let bytes: Buffer
      try {
        const before = await fd.stat()
        if (!before.isFile()) throw new GoalInputError('goal-input-file')
        bounded(before.size)
        // Bounded read even if another process grows this file while it is open.
        bytes = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < bytes.length) { check(signal); const read = await fd.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
        const after = await fd.stat()
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new GoalInputError('goal-input-changed')
        bytes = bytes.subarray(0, offset)
      } finally { await fd.close() }
      const suffix = extname(absolute).toLowerCase()
      const ref = await put(bytes, /^\.[a-z0-9]{1,20}$/.test(suffix) ? suffix : undefined)
      files.push({ path: absolute, ...ref })
      const snapshot = join(directory, ref.hash + (ref.extension ?? ''))
      const name = relative(cwd, absolute), kind = fileKindOf(absolute)
      const copy = `Saved input copy for inspection: ${JSON.stringify(snapshot)}. The original path remains the working file.`
      blocks.push(kind === 'text' ? `<file path="${name}">\n${bytes.subarray(0, MAX_TEXT).toString('utf8')}${bytes.length > MAX_TEXT ? `\n(truncated)\n${copy}` : ''}\n</file>` :
        `<file path="${name}">(${kind === 'image' ? 'image attachment' : 'binary file'}, ${Math.round(bytes.length / 1024)} KB)\n${copy}</file>`)
    }
    const validated: NonNullable<GoalInput['images']> = []
    for (const image of input.images ?? []) {
      check(signal)
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || image.data.length > Math.ceil(MAX_FILE / 3) * 4) throw new GoalInputError('goal-input-image')
      const value = await validateGeneratedImage(image).catch(() => { throw new GoalInputError('goal-input-image') })
      bounded(value.bytes.length)
      images.push({ ...await put(value.bytes), mimeType: value.mimeType })
      validated.push({ type: 'image', data: value.bytes.toString('base64'), mimeType: value.mimeType })
    }
    const fileBlocks = blocks.join('\n\n')
    const receipt: Receipt = { version: 1, sessionId: this.sessionId, goalId: id, cwd, status: 'pending', files, images, blocks: await put(Buffer.from(fileBlocks)) }
    check(signal)
    await atomic(join(directory, 'receipt.json'), Buffer.from(JSON.stringify(receipt)))
    check(signal)
    return { files: files.map(f => f.path), images: validated, fileBlocks }
  }
  async load(id: string, cwd: string, signal: AbortSignal): Promise<PreparedGoalInput> {
    const receipt = this.receipt(id)
    if (receipt.cwd !== cwd || receipt.status !== 'pending' || this.consumed(id)) throw new GoalInputError('goal-input-consumed')
    const get = async (ref: Ref) => {
      check(signal)
      const path = join(this.directory(id), ref.hash + (ref.extension ?? '')), fd = await open(path, 'r')
      try {
        if ((await fd.stat()).size !== ref.bytes) throw new GoalInputError('goal-input-invalid')
        const bytes = Buffer.alloc(ref.bytes + 1)
        let offset = 0
        while (offset < bytes.length) { check(signal); const read = await fd.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
        if (offset !== ref.bytes || digest(bytes.subarray(0, offset)) !== ref.hash) throw new GoalInputError('goal-input-invalid')
        check(signal); return bytes.subarray(0, offset)
      } finally { await fd.close() }
    }
    for (const file of receipt.files) await get(file)
    const images: NonNullable<GoalInput['images']> = []
    for (const image of receipt.images) {
      const bytes = await get(image)
      await validateGeneratedImage({ data: bytes.toString('base64'), mimeType: image.mimeType })
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: image.mimeType })
    }
    return { files: receipt.files.map(f => f.path), images, fileBlocks: (await get(receipt.blocks)).toString('utf8') }
  }
  consume(id: string, status: 'accepted' | 'superseded'): void {
    // The tombstone must survive even if the pending receipt itself is missing
    // or corrupt. A new explicit user message can supersede that bad input.
    // Unknown/corrupt tombstones also refuse replay; they never grant input.
    if (this.consumed(id)) return
    mkdirSync(this.directory(id), { recursive: true, mode: 0o700 })
    const path = join(this.directory(id), 'consumed.json'), temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, goalId: id, sessionId: this.sessionId, status }), { mode: 0o600, flag: 'wx' })
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path)
      const fdDir = openSync(dirname(path), 'r'); try { fsyncSync(fdDir) } finally { closeSync(fdDir) }
      for (const path of [this.root, dirname(this.root)]) {
        const parent = openSync(path, 'r'); try { fsyncSync(parent) } finally { closeSync(parent) }
      }
    } finally { try { unlinkSync(temporary) } catch { /* renamed or not written */ } }
  }
}
