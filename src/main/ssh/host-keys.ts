import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Trust first use, then pin; an explicit fingerprint also pins the first use. */
export class SshHostKeys {
  constructor(private path: string) {}
  verify(host: string, port: number, key: Buffer, expected?: string): string {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    if (expected && expected !== fingerprint) throw new Error(`SSH host key does not match the supplied fingerprint (${fingerprint})`)
    let keys: Record<string, string> = {}
    try {
      const fd = openSync(this.path, 'r')
      try {
        if (!fstatSync(fd).isFile()) throw new Error('invalid')
        const raw = Buffer.alloc(1024 * 1024 + 1)
        let length = 0, read = 0
        do { read = readSync(fd, raw, length, raw.length - length, null); length += read } while (read && length < raw.length)
        if (length > 1024 * 1024) throw new Error('oversized')
        keys = JSON.parse(raw.subarray(0, length).toString('utf8'))
      } finally { closeSync(fd) }
      if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some(v => typeof v !== 'string')) throw new Error('invalid')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('SSH host-key store is unreadable')
    }
    const identity = JSON.stringify([host.toLowerCase(), port])
    if (keys[identity] && keys[identity] !== fingerprint) throw new Error(`SSH host key changed (${fingerprint}); verify the server before updating the host-key store`)
    if (!keys[identity]) {
      if (Object.keys(keys).length >= 4096) throw new Error('SSH host-key store is full')
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      let fd: number | undefined
      try {
        fd = openSync(temporary, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ ...keys, [identity]: fingerprint }))
        fsyncSync(fd); closeSync(fd); fd = undefined
        renameSync(temporary, this.path)
      } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }) }
    }
    return fingerprint
  }
}
