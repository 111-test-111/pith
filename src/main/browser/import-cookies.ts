/** Import Chrome cookies into the embedded browser on macOS.
 * Electron writes, Keychain access and paths are injected for offline checks.
 * Copy the database and WAL before reading; convert WebKit microseconds to
 * Unix seconds in SQL to avoid unsafe JavaScript int64 conversion.
 * Keep a deduplicated manifest of successful writes for selective removal.
 * Native Node type stripping requires erasable TypeScript syntax here. */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  BrowserImportErrorCode,
  BrowserImportResultDTO,
  BrowserImportSourceDTO,
  BrowserImportStatusDTO
} from '../../shared/types'

const SAFE_STORAGE_SERVICE = 'Chrome Safe Storage'
const SAFE_STORAGE_SALT = 'saltysalt'
const SAFE_STORAGE_ITERATIONS = 1003

const LEGACY_IV = Buffer.alloc(16, 0x20)

/** SHA-256 host binding used by newer macOS Chrome cookie values. */
const DOMAIN_HASH_BYTES = 32

/** Apply this epoch offset in SQL; never read raw microseconds as a JS number. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11644473600

const APPLY_CONCURRENCY = 24

const KEYCHAIN_TIMEOUT_MS = 120_000

export class BrowserImportError extends Error {
  readonly code: BrowserImportErrorCode
  constructor(code: BrowserImportErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface ImportedCookieDetail {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export type CookieIdentity = [host: string, name: string, path: string, secure: number]

export function defaultChromeRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

export function browserImportRecordPath(userDataDir: string): string {
  return join(userDataDir, 'browser-import.json')
}

function readProfileLabels(chromeRoot: string): Map<string, string> {
  const labels = new Map<string, string>()
  try {
    const raw = JSON.parse(readFileSync(join(chromeRoot, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> }
    }
    const cache = raw.profile?.info_cache
    if (cache && typeof cache === 'object') {
      for (const [dir, info] of Object.entries(cache)) {
        const name = info?.name
        if (typeof name === 'string' && name.trim()) labels.set(dir, name.trim())
      }
    }
  } catch {

  }
  return labels
}

function profileOrder(a: BrowserImportSourceDTO, b: BrowserImportSourceDTO): number {
  if (a.id === 'Default') return b.id === 'Default' ? 0 : -1
  if (b.id === 'Default') return 1
  const na = /^Profile (\d+)$/.exec(a.id)?.[1]
  const nb = /^Profile (\d+)$/.exec(b.id)?.[1]
  if (na && nb) return Number(na) - Number(nb)
  return a.id.localeCompare(b.id)
}

/** Prefer Network/Cookies over the legacy profile-root database. */
function cookiesFileFor(profileDir: string): string | null {

  const modern = join(profileDir, 'Network', 'Cookies')
  if (existsSync(modern)) return modern
  const legacy = join(profileDir, 'Cookies')
  if (existsSync(legacy)) return legacy
  return null
}

export type ChromeRootStatus = 'ok' | 'blocked' | 'none' | 'absent'

export type ReaddirImpl = (path: string, options: { withFileTypes: true }) => Dirent[]

/** TCC may report EPERM on directory reads but ENOENT on file opens. */
export function chromeRootStatus(
  chromeRoot = defaultChromeRoot(),
  readdirImpl: ReaddirImpl = readdirSync
): ChromeRootStatus {
  if (process.platform !== 'darwin') return 'absent'
  let entries: Dirent[]
  try {
    entries = readdirImpl(chromeRoot, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'EPERM' || code === 'EACCES' ? 'blocked' : 'absent'
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (cookiesFileFor(join(chromeRoot, entry.name))) return 'ok'
  }
  return 'none'
}

export function listChromeProfiles(chromeRoot = defaultChromeRoot()): BrowserImportSourceDTO[] {
  if (chromeRootStatus(chromeRoot) !== 'ok') return []
  let entries: Dirent[]
  try {
    entries = readdirSync(chromeRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const labels = readProfileLabels(chromeRoot)
  const profiles: BrowserImportSourceDTO[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!cookiesFileFor(join(chromeRoot, entry.name))) continue
    profiles.push({ id: entry.name, label: labels.get(entry.name) ?? entry.name })
  }
  return profiles.sort(profileOrder)
}

export interface ChromeDiscovery {
  status: ChromeRootStatus
  profiles: BrowserImportSourceDTO[]
}

export function discoverChrome(
  chromeRoot = defaultChromeRoot(),
  readdirImpl?: ReaddirImpl
): ChromeDiscovery {
  const status = chromeRootStatus(chromeRoot, readdirImpl)
  if (status !== 'ok') return { status, profiles: [] }
  return { status, profiles: listChromeProfiles(chromeRoot) }
}

export function readChromeSafeStorageKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-w', '-s', SAFE_STORAGE_SERVICE],
      { timeout: KEYCHAIN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 },
      (error, stdout) => {
        const key = stdout.trim()
        if (error || !key) {
          reject(new BrowserImportError('keychain', 'Chrome Safe Storage key unavailable'))
          return
        }
        resolve(key)
      }
    )
  })
}

export function deriveMacOsCryptKey(passphrase: string): Buffer {
  return pbkdf2Sync(passphrase, SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, 16, 'sha1')
}

export type CookieDecrypt =
  | { status: 'ok'; value: string }

  | { status: 'unsupported' }
  | { status: 'failed' }

/** Accept v10/v11 CBC values; strip a host hash only when it matches exactly. */
export function decryptCookieValue(
  encrypted: Uint8Array | null | undefined,
  key: Buffer,
  hostKey = ''
): CookieDecrypt {
  if (!encrypted || encrypted.length === 0) return { status: 'ok', value: '' }
  const buf = Buffer.from(encrypted)
  if (buf.length < 3) return { status: 'unsupported' }
  const prefix = buf.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return { status: 'unsupported' }
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, LEGACY_IV)
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])

    if (hostKey && plain.length >= DOMAIN_HASH_BYTES) {
      const expected = createHash('sha256').update(hostKey, 'utf8').digest()
      if (expected.equals(plain.subarray(0, DOMAIN_HASH_BYTES))) {
        plain = plain.subarray(DOMAIN_HASH_BYTES)
      }
    }
    return { status: 'ok', value: plain.toString('utf8') }
  } catch {

    return { status: 'failed' }
  }
}

interface CookieRow {
  host_key: string
  name: string
  value: string
  path: string
  encrypted_value?: Uint8Array | null
  is_secure: number
  is_httponly: number
  is_persistent: number
  samesite: number | null

  expires_unix: number
}

function readCookieRows(dbFile: string): CookieRow[] {
  const db = new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const columns = new Set(
      (db.prepare('PRAGMA table_info(cookies)').all() as { name?: unknown }[]).map((c) =>
        typeof c.name === 'string' ? c.name : ''
      )
    )
    for (const required of [
      'host_key',
      'name',
      'value',
      'path',
      'encrypted_value',
      'is_secure',
      'is_httponly',
      'is_persistent',
      'expires_utc'
    ]) {
      if (!columns.has(required)) {
        throw new BrowserImportError('database', `cookies table missing column ${required}`)
      }
    }

    const sameSiteExpr = columns.has('samesite') ? 'samesite' : '-1'
    return db
      .prepare(
        `SELECT host_key, name, value, path, encrypted_value, is_secure, is_httponly, is_persistent,
                ${sameSiteExpr} AS samesite,
                CAST(expires_utc / 1000000 AS INTEGER) - ${WEBKIT_EPOCH_OFFSET_SECONDS} AS expires_unix
         FROM cookies`
      )
      .all() as unknown as CookieRow[]
  } finally {
    db.close()
  }
}

function mapSameSite(raw: number | null, secure: boolean): ImportedCookieDetail['sameSite'] {

  if (raw == null) return 'unspecified'
  if (raw === 1) return 'lax'
  if (raw === 2) return 'strict'
  if (raw === 0) return secure ? 'no_restriction' : 'unspecified'
  return 'unspecified'
}

export type MappedCookie =
  | { kind: 'detail'; detail: ImportedCookieDetail; identity: CookieIdentity }
  | { kind: 'skipped'; reason: 'expired' | 'invalid' }

/** Preserve host-only/domain semantics and enforce __Host-/__Secure- requirements. */
export function mapCookieRow(row: CookieRow, value: string, nowSec: number): MappedCookie {
  const host = typeof row.host_key === 'string' ? row.host_key : ''
  const name = typeof row.name === 'string' ? row.name : ''
  if (!host || !name) return { kind: 'skipped', reason: 'invalid' }

  const persistent = !!row.is_persistent
  const expiresUnix = Number(row.expires_unix) || 0
  if (persistent && expiresUnix > 0 && expiresUnix <= nowSec) {
    return { kind: 'skipped', reason: 'expired' }
  }

  const isDomainCookie = host.startsWith('.')
  const hostOnlyHost = isDomainCookie ? host.slice(1) : host

  const secure = !!row.is_secure || name.startsWith('__Secure-') || name.startsWith('__Host-')
  const isHostPrefix = name.startsWith('__Host-')
  const path = isHostPrefix ? '/' : row.path?.startsWith('/') ? row.path : '/'
  const scheme = secure ? 'https' : 'http'

  const detail: ImportedCookieDetail = {
    url: `${scheme}://${hostOnlyHost}${path}`,
    name,
    value,

    domain: isHostPrefix || !isDomainCookie ? undefined : host,
    path,
    secure,
    httpOnly: !!row.is_httponly,
    sameSite: mapSameSite(row.samesite, secure)
  }
  if (persistent && expiresUnix > 0) detail.expirationDate = expiresUnix

  return { kind: 'detail', detail, identity: [host, name, path, secure ? 1 : 0] }
}

/** Reconstruct a removal URL from the stored secure flag, host and path. */
export function removalUrlFor(identity: CookieIdentity): string {
  const [host, , path, secure] = identity
  const hostOnlyHost = host.startsWith('.') ? host.slice(1) : host
  const safePath = path?.startsWith('/') ? path : '/'
  return `${secure ? 'https' : 'http'}://${hostOnlyHost}${safePath}`
}

interface ImportEvent {
  source: 'chrome'
  profileId: string
  profileLabel: string
  at: number
  imported: number
}

interface ImportRecord {
  version: 1
  imports: ImportEvent[]

  cookies: CookieIdentity[]
}

function identityKey(identity: CookieIdentity): string {
  return `${identity[3]}|${identity[0]}|${identity[1]}|${identity[2]}`
}

function emptyRecord(): ImportRecord {
  return { version: 1, imports: [], cookies: [] }
}

export function readImportRecord(recordPath: string): ImportRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as ImportRecord
    if (!raw || raw.version !== 1 || !Array.isArray(raw.imports) || !Array.isArray(raw.cookies)) {
      return null
    }
    return raw
  } catch {
    return null
  }
}

async function writeImportRecord(recordPath: string, record: ImportRecord): Promise<void> {
  const tmp = `${recordPath}.tmp`
  await writeFile(tmp, JSON.stringify(record), 'utf8')
  await rename(tmp, recordPath)
}

export function readImportStatus(recordPath: string): BrowserImportStatusDTO {
  const record = readImportRecord(recordPath)
  if (!record || record.cookies.length === 0) return { present: false, cookieCount: 0 }
  const latest = record.imports[record.imports.length - 1]
  return {
    present: true,
    source: 'chrome',
    profileLabel: latest?.profileLabel,
    importedAt: latest?.at,
    cookieCount: record.cookies.length
  }
}

function resolveProfileCookiesFile(chromeRoot: string, profileId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 .()_-]*$/.test(profileId)) {
    throw new BrowserImportError('profile-not-found', `invalid profile id: ${profileId}`)
  }
  const file = cookiesFileFor(join(chromeRoot, profileId))
  if (!file) throw new BrowserImportError('profile-not-found', `no Cookies db for ${profileId}`)
  return file
}

/** Copy WAL with the database; SQLite recreates the shared-memory index. */
async function stageCookiesCopy(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pith-chrome-cookies-'))
  const target = join(dir, 'Cookies')
  await copyFile(source, target)
  if (existsSync(`${source}-wal`)) await copyFile(`${source}-wal`, `${target}-wal`)
  return dir
}

/** Reject inaccessible profiles before Keychain prompts; record only applied cookies. */
export async function importChromeCookies(options: {
  profileId: string
  chromeRoot?: string
  recordPath: string
  profileLabel?: string
  getKey?: () => Promise<string>
  apply?: (details: ImportedCookieDetail[]) => Promise<ApplyReport>
  readdirImpl?: ReaddirImpl
}): Promise<{ result: BrowserImportResultDTO; status: BrowserImportStatusDTO }> {
  const { profileId, recordPath } = options
  const chromeRoot = options.chromeRoot ?? defaultChromeRoot()
  const counts = {
    total: 0,
    imported: 0,
    failed: 0,
    skippedExpired: 0,
    skippedUndecryptable: 0
  }

  const discoveryStatus = chromeRootStatus(chromeRoot, options.readdirImpl)
  if (discoveryStatus === 'blocked') {

    return {
      result: { ok: false, code: 'permission', ...counts },
      status: readImportStatus(recordPath)
    }
  }
  if (discoveryStatus !== 'ok') {

    return {
      result: { ok: false, code: 'chrome-not-found', ...counts },
      status: readImportStatus(recordPath)
    }
  }

  let staged: string | null = null
  try {
    const cookiesFile = resolveProfileCookiesFile(chromeRoot, profileId)
    staged = await stageCookiesCopy(cookiesFile)

    const passphrase = await (options.getKey ?? readChromeSafeStorageKey)()
    const key = deriveMacOsCryptKey(passphrase)

    const rows = readCookieRows(join(staged, 'Cookies'))
    counts.total = rows.length

    const nowSec = Math.floor(Date.now() / 1000)
    const details: ImportedCookieDetail[] = []
    const identities: CookieIdentity[] = []
    let skippedInvalid = 0
    for (const row of rows) {
      const decrypted = decryptCookieValue(row.encrypted_value, key, row.host_key)
      if (decrypted.status === 'unsupported') {
        counts.skippedUndecryptable += 1
        continue
      }
      if (decrypted.status === 'failed') {
        counts.failed += 1
        continue
      }

      const value = row.encrypted_value && row.encrypted_value.length > 0 ? decrypted.value : row.value ?? ''
      const mapped = mapCookieRow(row, value, nowSec)
      if (mapped.kind === 'skipped') {
        if (mapped.reason === 'expired') counts.skippedExpired += 1
        else skippedInvalid += 1
        continue
      }
      details.push(mapped.detail)
      identities.push(mapped.identity)
    }

    if (counts.total > 0 && counts.failed === counts.total) {
      return {
        result: { ok: false, code: 'keychain', ...counts },
        status: readImportStatus(recordPath)
      }
    }

    const apply = options.apply ?? ((_details: ImportedCookieDetail[]) => Promise.resolve<ApplyReport>({ results: [] }))

    const report = await apply(details)
    let applyFailed = 0
    const appliedIdentities: CookieIdentity[] = []
    details.forEach((_detail, index) => {
      if (report.results[index] === false) {
        applyFailed += 1
        return
      }
      appliedIdentities.push(identities[index])
    })
    counts.imported = appliedIdentities.length
    counts.failed += applyFailed

    if (appliedIdentities.length > 0) {
      const record = readImportRecord(recordPath) ?? emptyRecord()
      const seen = new Set(record.cookies.map(identityKey))
      for (const identity of appliedIdentities) {
        const keyStr = identityKey(identity)
        if (seen.has(keyStr)) continue
        seen.add(keyStr)
        record.cookies.push(identity)
      }
      const label =
        options.profileLabel ?? listChromeProfiles(chromeRoot).find((p) => p.id === profileId)?.label ?? profileId
      record.imports.push({
        source: 'chrome',
        profileId,
        profileLabel: label,
        at: Date.now(),
        imported: counts.imported
      })
      await mkdir(dirname(recordPath), { recursive: true })
      await writeImportRecord(recordPath, record)
    }

    return {
      result: {
        ok: true,
        imported: counts.imported,
        failed: counts.failed,
        firstError: report.firstError,
        skippedExpired: counts.skippedExpired,

        skippedUndecryptable: counts.skippedUndecryptable + skippedInvalid,
        total: counts.total
      },
      status: readImportStatus(recordPath)
    }
  } catch (error) {
    if (error instanceof BrowserImportError) {
      return { result: { ok: false, code: error.code, ...counts }, status: readImportStatus(recordPath) }
    }
    return { result: { ok: false, code: 'database', ...counts }, status: readImportStatus(recordPath) }
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {})
  }
}

export async function clearImportedCookies(
  recordPath: string,
  remove: (url: string, name: string) => Promise<unknown>
): Promise<{ removed: number; failed: number }> {
  const record = readImportRecord(recordPath)
  if (!record) return { removed: 0, failed: 0 }
  let removed = 0
  let failed = 0
  for (const identity of record.cookies) {
    const [host, name] = identity
    if (!host || !name) continue
    try {
      await remove(removalUrlFor(identity), name)
      removed += 1
    } catch {
      failed += 1
    }
  }
  await rm(recordPath, { force: true })
  return { removed, failed }
}

/** Per-cookie application outcomes plus the first technical error for diagnostics. */
export interface ApplyReport {
  results: boolean[]
  firstError?: string
}

export function makeSessionApply(cookiesSet: (detail: ImportedCookieDetail) => Promise<unknown>) {
  return async (details: ImportedCookieDetail[]): Promise<ApplyReport> => {
    const results = new Array<boolean>(details.length).fill(true)
    let firstError: string | undefined
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < details.length) {
        const index = cursor++
        try {
          await cookiesSet(details[index])
        } catch (error) {
          results[index] = false
          firstError ??= String((error as Error | undefined)?.message ?? error)
        }
      }
    }
    const lanes = Math.min(APPLY_CONCURRENCY, Math.max(details.length, 1))
    await Promise.all(Array.from({ length: lanes }, worker))
    return { results, firstError }
  }
}
