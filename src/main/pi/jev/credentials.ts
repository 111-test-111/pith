import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JevSettingsDTO } from '../../../shared/types'
import { JevError } from './protocol'

/** Separate from model-provider credentials; never returned to the renderer. */
export class JevCredentials {
  constructor(private path: string, private environment: () => string | undefined = () => process.env.TYPESAFE_API_KEY) {}
  private async saved(): Promise<string | undefined> {
    let content: string
    try { content = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const data = JSON.parse(content)
    if (!data || typeof data.key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(data.key)) throw new JevError('credentials')
    return data.key
  }
  async key(): Promise<string | undefined> {
    try {
      return await this.saved() || this.environment()?.trim() || undefined
    } catch { throw new JevError('credentials') }
  }
  async source(): Promise<JevSettingsDTO['keySource']> {
    try {
      if (await this.saved()) return 'saved'
      return this.environment()?.trim() ? 'environment' : 'missing'
    } catch { return 'unavailable' }
  }
  async save(value: unknown): Promise<void> {
    if (value !== null && (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value.trim()))) throw new JevError('invalid_input')
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      if (value === null) await rm(this.path, { force: true })
      else {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify({ key: (value as string).trim() }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
      }
    } catch { throw new JevError('storage') }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
}
