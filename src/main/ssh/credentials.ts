import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConnectConfig } from 'ssh2'

export interface SshCredentialSource {
  credentialsFile?: string
  privateKeyPath?: string
  passwordEnv?: string
  passphraseEnv?: string
  agent?: boolean
}

/** Secret bytes never occur in public tool arguments, DTOs or diagnostic logs. */
async function boundedFile(path: string, cwd: string): Promise<Buffer> {
  const file = await open(resolve(cwd, path), 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('SSH credentials must be a regular file')
    const buffer = Buffer.alloc(256 * 1024 + 1)
    let length = 0, bytesRead = 0
    do { ({ bytesRead } = await file.read(buffer, length, buffer.length - length, null)); length += bytesRead } while (bytesRead && length < buffer.length)
    if (length > 256 * 1024) throw new Error('SSH credentials exceed 256 KiB')
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

export async function loadSshCredentials(source: SshCredentialSource, cwd: string): Promise<Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent'>> {
  let saved: Record<string, unknown> = {}
  if (source.credentialsFile) {
    try {
      saved = JSON.parse((await boundedFile(source.credentialsFile, cwd)).toString('utf8'))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error()
    } catch { throw new Error('Could not read SSH credentials JSON file') }
    if (Object.keys(saved).some(key => !['password', 'privateKey', 'privateKeyPath', 'passphrase'].includes(key))) {
      throw new Error('SSH credentials file accepts password, privateKey, privateKeyPath and passphrase only')
    }
    for (const value of Object.values(saved)) if (typeof value !== 'string' || value.length > 256 * 1024) throw new Error('Invalid SSH credentials file')
  }
  const environment = (name: string | undefined): string | undefined => {
    if (!name) return undefined
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !process.env[name]) throw new Error('SSH credential environment variable is unavailable')
    return process.env[name]
  }
  const keyPath = source.privateKeyPath ?? saved.privateKeyPath as string | undefined
  const password = environment(source.passwordEnv) ?? saved.password as string | undefined
  const passphrase = environment(source.passphraseEnv) ?? saved.passphrase as string | undefined
  const privateKey = keyPath ? await boundedFile(keyPath, cwd) : saved.privateKey as string | undefined
  const agent = source.agent !== false && !password && !privateKey ? process.env.SSH_AUTH_SOCK : undefined
  if (!password && !privateKey && !agent) throw new Error('Supply credentialsFile, privateKeyPath, passwordEnv or an available SSH agent')
  return { ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}), ...(passphrase ? { passphrase } : {}), ...(agent ? { agent } : {}) }
}
