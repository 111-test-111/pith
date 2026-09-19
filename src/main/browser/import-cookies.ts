/**
 * Chrome → 内嵌浏览器「登录态导入」：读 Chrome 的 cookie 库、解密、转成 Electron
 * `cookies.set` 明细；另维护一份导入清单（`browser-import.json`）支撑「清除已导入」。
 *
 * 该模块刻意不 import electron（可被检查脚本在纯 Node 下驱动）：所有会碰到
 * Electron session / userData / Keychain 的边界都以注入点形式暴露——
 * - `apply`：真正写 cookie 的函数（ipc.ts 传入 partition session 的批量 setter）；
 * - `getKey`：取 Chrome Safe Storage 口令（默认 spawn `security`，会弹一次钥匙串授权）；
 * - `chromeRoot` / `recordPath`：路径根，测试注入 fixture。
 *
 * 平台：macOS only。Windows 的 cookie 是 App-Bound 加密（v20，第三方不可解），
 * Linux 是硬编码口令 `peanuts`（以后要支持很容易，同一条链路换个口令）。
 *
 * 格式事实（2026-09 核实）：macOS Chrome 的 `encrypted_value` 仍是
 * Keychain「Chrome Safe Storage」口令 + PBKDF2-HMAC-SHA1(saltysalt, 1003 轮, 16 字节)
 * 派生的 AES-128-CBC，IV 固定 16×0x20，前缀 `v10`/`v11`，PKCS5 填充。
 * 值在 SQL 里取：`node:sqlite` 读超出 2^53 的 int64 列会直接抛错，Chrome 的
 * WebKit 微秒时间戳（~1.3e16）必然越界，所以 expires_utc 必须在 SQL 里降成 unix 秒。
 * cookie 库文件位置：现代 Chrome 是 `<profile>/Network/Cookies`，旧档案是
 * `<profile>/Cookies`，两处都认。
 */
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

// ---- Chrome os_crypt 常量 ----
const SAFE_STORAGE_SERVICE = 'Chrome Safe Storage'
const SAFE_STORAGE_SALT = 'saltysalt'
const SAFE_STORAGE_ITERATIONS = 1003
/** 固定 IV：16 个 0x20（空格）。 */
const LEGACY_IV = Buffer.alloc(16, 0x20)
/** Chrome ≥152（macOS）的域绑定前缀长度：sha256(host_key)。 */
const DOMAIN_HASH_BYTES = 32
/** 微秒(1601 纪元) → unix 秒 的 SQL 偏移，只在 SQL 里用，别在 JS 里碰原始值。 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11644473600
/** 一次 `cookies.set` 批量写入的并发上限（每条都是一次到网络服务的 IPC）。 */
const APPLY_CONCURRENCY = 24
/** Keychain 授权框可能等用户很久；给一个宽限但不挂死 IPC。 */
const KEYCHAIN_TIMEOUT_MS = 120_000

// 注意：本模块被 scripts/check-browser-import.mjs 以 Node 原生 type-stripping 直接
// import，只能用可擦除语法（无 parameter property / enum 等）。
export class BrowserImportError extends Error {
  readonly code: BrowserImportErrorCode
  constructor(code: BrowserImportErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 写入 partition 的 cookie 明细（结构同 Electron CookiesSetDetails 的子集）。 */
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

/** 清单里的 cookie 身份（紧凑元组：host_key / name / path / secure）。 */
export type CookieIdentity = [host: string, name: string, path: string, secure: number]

export function defaultChromeRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

export function browserImportRecordPath(userDataDir: string): string {
  return join(userDataDir, 'browser-import.json')
}

// ---- profile 发现 ----

/** `Local State` → `profile.info_cache[dir].name` 的显示名映射；读不了就退回目录名。 */
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
    /* Local State 缺失/损坏 → 显示名退回目录名 */
  }
  return labels
}

/** 档案目录排序：Default 永远第一，其余 Profile N 按号、再按名字。 */
function profileOrder(a: BrowserImportSourceDTO, b: BrowserImportSourceDTO): number {
  if (a.id === 'Default') return b.id === 'Default' ? 0 : -1
  if (b.id === 'Default') return 1
  const na = /^Profile (\d+)$/.exec(a.id)?.[1]
  const nb = /^Profile (\d+)$/.exec(b.id)?.[1]
  if (na && nb) return Number(na) - Number(nb)
  return a.id.localeCompare(b.id)
}

function cookiesFileFor(profileDir: string): string | null {
  // 现代 Chrome 在 Network/ 子目录；旧档案在档案根。Network 优先（两者同存时它才是活的）。
  const modern = join(profileDir, 'Network', 'Cookies')
  if (existsSync(modern)) return modern
  const legacy = join(profileDir, 'Cookies')
  if (existsSync(legacy)) return legacy
  return null
}

/** 根目录四种状态。`blocked` = macOS 26 的应用数据保护（TCC/com.apple.macl）把
 *  `~/Library/Application Support/Google/Chrome` 藏起来了：readdir 直接 EPERM，
 *  open 会伪装成 ENOENT —— 数据明明在（父目录 stat 可见 55 个条目），只是不许
 *  别的进程读。解法：系统设置里给 pi-app 勾「完全磁盘访问权限」后重启应用。 */
export type ChromeRootStatus = 'ok' | 'blocked' | 'none' | 'absent'

/** 可注入的 readdir（检查脚本用拋 EPERM 的假实现复现 TCC 形状）。 */
export type ReaddirImpl = (path: string, options: { withFileTypes: true }) => Dirent[]

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

/** 发现入口：状态 + 可导入档案（status !== 'ok' 时 profiles 恒为空）。 */
export function discoverChrome(
  chromeRoot = defaultChromeRoot(),
  readdirImpl?: ReaddirImpl
): ChromeDiscovery {
  const status = chromeRootStatus(chromeRoot, readdirImpl)
  if (status !== 'ok') return { status, profiles: [] }
  return { status, profiles: listChromeProfiles(chromeRoot) }
}

// ---- 解密 ----

/** 读取 macOS Keychain 里 Chrome 的 os_crypt 口令。首次会弹系统授权框。 */
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
  /** v20 / 未知前缀：mac 上不该出现，出现只计数跳过。 */
  | { status: 'unsupported' }
  | { status: 'failed' }

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
    // Chrome ≥152（macOS）把 Windows v20 的域绑定方案下沉到了 mac：v10 明文变成了
    // sha256(host_key) || value（实测 1575/1575 命中，原像 = host_key 原样含前导点）。
    // 不剥掉它，每个值都带着 32 字节哈希，cookies.set 以「ASCII control characters」
    // 拒收 —— 实测 1314/1328 失败，剩下的“成功”值本身也是错的（哈希字节碰巧干净）。
    // 哈希命中即剥；未命中的旧格式值（无前缀）原样通过，向后兼容。
    if (hostKey && plain.length >= DOMAIN_HASH_BYTES) {
      const expected = createHash('sha256').update(hostKey, 'utf8').digest()
      if (expected.equals(plain.subarray(0, DOMAIN_HASH_BYTES))) {
        plain = plain.subarray(DOMAIN_HASH_BYTES)
      }
    }
    return { status: 'ok', value: plain.toString('utf8') }
  } catch {
    // 填充校验失败 ≈ 口令不对或数据损坏
    return { status: 'failed' }
  }
}

// ---- SQLite 读取 ----

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
  /** SQL 里已降成 unix 秒（int64 原始微秒列绝不能裸读，node:sqlite 会抛错）。 */
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
    // samesite 列是后来加的；老档案没有时按 unspecified。
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

// ---- 行 → Electron 明细 ----

function mapSameSite(raw: number | null, secure: boolean): ImportedCookieDetail['sameSite'] {
  // Chromium 落库值：-1 unspecified / 0 none / 1 lax / 2 strict；NULL 是老行，按 unspecified。
  if (raw == null) return 'unspecified'
  if (raw === 1) return 'lax'
  if (raw === 2) return 'strict'
  if (raw === 0) return secure ? 'no_restriction' : 'unspecified'
  return 'unspecified'
}

export type MappedCookie =
  | { kind: 'detail'; detail: ImportedCookieDetail; identity: CookieIdentity }
  | { kind: 'skipped'; reason: 'expired' | 'invalid' }

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
  // __Secure- / __Host- 前缀按 Chromium 语义必须 secure；导入时兜底补上，
  // 否则 cookies.set 直接拒绝。
  const secure = !!row.is_secure || name.startsWith('__Secure-') || name.startsWith('__Host-')
  const isHostPrefix = name.startsWith('__Host-')
  const path = isHostPrefix ? '/' : row.path?.startsWith('/') ? row.path : '/'
  const scheme = secure ? 'https' : 'http'

  const detail: ImportedCookieDetail = {
    url: `${scheme}://${hostOnlyHost}${path}`,
    name,
    value,
    // __Host- 必须 host-only（不带 domain）；其余按 Chrome 的域 cookie 点号语义。
    domain: isHostPrefix || !isDomainCookie ? undefined : host,
    path,
    secure,
    httpOnly: !!row.is_httponly,
    sameSite: mapSameSite(row.samesite, secure)
  }
  if (persistent && expiresUnix > 0) detail.expirationDate = expiresUnix

  return { kind: 'detail', detail, identity: [host, name, path, secure ? 1 : 0] }
}

/** 清除时由身份重建 removal URL：scheme 跟着 secure 走，host 去点，path 用原值。 */
export function removalUrlFor(identity: CookieIdentity): string {
  const [host, , path, secure] = identity
  const hostOnlyHost = host.startsWith('.') ? host.slice(1) : host
  const safePath = path?.startsWith('/') ? path : '/'
  return `${secure ? 'https' : 'http'}://${hostOnlyHost}${safePath}`
}

// ---- 导入清单（browser-import.json） ----

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
  /** 身份元组，按 `host|name|path|secure` 去重合并。 */
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

// ---- 编排 ----

/** 校验档案 id，返回 cookie 库绝对路径；找不到抛 profile-not-found。 */
function resolveProfileCookiesFile(chromeRoot: string, profileId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 .()_-]*$/.test(profileId)) {
    throw new BrowserImportError('profile-not-found', `invalid profile id: ${profileId}`)
  }
  const file = cookiesFileFor(join(chromeRoot, profileId))
  if (!file) throw new BrowserImportError('profile-not-found', `no Cookies db for ${profileId}`)
  return file
}

/** 把库里一行复制到临时目录（Chrome 正在运行会锁库；副本避免争用，WAL 一并带上。
 *  -shm 不复制：那只是索引，SQLite 打开副本时会自己重建。 */
async function stageCookiesCopy(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pith-chrome-cookies-'))
  const target = join(dir, 'Cookies')
  await copyFile(source, target)
  if (existsSync(`${source}-wal`)) await copyFile(`${source}-wal`, `${target}-wal`)
  return dir
}

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
    // 被 TCC 拦住：尽早拒绝并给出引导码，不去碰钥匙串（省掉一次无意义的授权弹框）。
    return {
      result: { ok: false, code: 'permission', ...counts },
      status: readImportStatus(recordPath)
    }
  }
  if (discoveryStatus !== 'ok') {
    // absent：没装 Chrome；none：装了但没有带 cookie 库的档案 —— 都按「未找到档案」报。
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
      // encrypted_value 为空的行：value 列本来就是明文。
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

    // 一条都没解开 = 口令不对（钥匙串给了别的值/数据整体损坏），别谎报 0 条成功。
    if (counts.total > 0 && counts.failed === counts.total) {
      return {
        result: { ok: false, code: 'keychain', ...counts },
        status: readImportStatus(recordPath)
      }
    }

    const apply = options.apply ?? ((_details: ImportedCookieDetail[]) => Promise.resolve<ApplyReport>({ results: [] }))
    // apply 返回逐条写入结果；只有真正写进去的身份才进导入清单（否则「清除已导入」
    // 会把从未落地的 cookie 也计入 —— 上线首日 1313 对 14 的谎报就是这么来的）。
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
        // UI 把 unsupported/invalid 合并展示为「跳过」。
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

/** 默认 apply：限并发写 partition session。 */
/** apply 的返回：逐条写入结果 + 第一条失败的技术性错误消息（仅诊断展示）。 */
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
