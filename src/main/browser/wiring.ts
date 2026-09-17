/**
 * 内嵌浏览器的主进程接线：popup 路由 / guest 输入中继 / 下载接管 / 权限白名单。
 * 移植自 pi-web electron/main.cjs 的 installPopupRouting / installInputRelay /
 * attachDownloadHandler（browser 分区）与权限白名单，按 pi-app 宿主形态精确改造：
 * - Electron 43 起 setWindowOpenHandler 只剩 webContents 级——经 web-contents-created
 *   给每个 contents 挂 handler，按 contents 身份分流；壳窗口自身的 contents 在 install
 *   时已存在（created 事件已错过），显式补挂同一逻辑（保持既有 openExternal 行为逐字不变，
 *   壳窗口不得再有第二个 window-open handler）。
 * - 输入中继不经服务器：经 getBrowserService() 惰性取单例后 bump interaction
 *   generation（guest 的旧 snapshot ref 失效）；service 初始化前为设计的 no-op。
 * - 下载只接管 browser 分区：自动落系统「下载」目录，重名 (n) 去重，完成/失败经 emit
 *   通知渲染层工具条。
 * 纯函数（decideBrowserPermission / classifyGuestPopup）与安装器分离——检查脚本在
 * 纯 node 下导入断言，electron 只能在 Electron 路径内惰性 require（同 cdp-port.ts）。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { BROWSER_PARTITION, parseMarkerUrl } from '../../shared/browser.ts'
import { getBrowserService } from './service.ts'

const requireElectron = createRequire(import.meta.url)
function electron(): typeof import('electron') {
  return requireElectron('electron') as typeof import('electron')
}

/** browser 分区放行的权限（media/geolocation/notifications/midi/serial/usb/bluetooth 等一律拒绝）。 */
const BROWSER_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

/** 纯函数：browser 分区权限请求的 allowlist 判定（集合之外一律 false）。 */
export function decideBrowserPermission(permission: string): boolean {
  return BROWSER_ALLOWED_PERMISSIONS.has(permission)
}

/** 壳文档前缀（与 service 的 isShellWindowUrl 同一集合：dev 由 vite 加载 localhost，打包后 file://）。 */
function isShellDocumentUrl(url: string): boolean {
  return url.startsWith('http://localhost:') || url.startsWith('file://')
}

/** 纯函数：webview guest 弹窗 URL 的分类（marker 前缀 / 壳文档 / 普通页）。 */
export function classifyGuestPopup(url: string): 'marker' | 'shell' | 'guest' {
  if (parseMarkerUrl(url) !== null) return 'marker'
  if (isShellDocumentUrl(url)) return 'shell'
  return 'guest'
}

/** 渲染层通知：ipc.ts 同款全窗口广播（index.ts 传入）。 */
export type BrowserEmit = (channel: string, payload: unknown) => void

// ---- 安装器状态（模块级）：web-contents-created 监听与会话接线只装一次；窗口/emit
// 随每次 install 刷新——macOS 的 activate 路径会以新窗口再次走 createWindow，先装的
// 监听闭包必须经模块变量读到当前值，而不是捕获首次的旧窗口。 ----
let wiringInstalled = false
let sessionWired = false
let shellWin: BrowserWindow | null = null
let activeEmit: BrowserEmit | null = null

/** 伪造 marker 丢弃只记一次日志（恶意页面可能刷屏）。 */
let markerDropLogged = false
function dropForgedMarker(url: string): void {
  if (markerDropLogged) return
  markerDropLogged = true
  console.error(`[browser] dropped marker URL from window.open: ${url} (further drops silent)`)
}

/** 输入中继的每 contents 节流：webContentsId → 最近一次中继时刻（每手势前沿）。 */
const relayedAt = new Map<number, number>()
const INPUT_RELAY_THROTTLE_MS = 300

/** 每个 contents 一份的接线：window-open 路由 + webview guest 的输入中继。 */
function wireContents(contents: WebContents): void {
  // 1. popup 路由：marker 一律 deny（伪造的记一次日志——marker 命名空间只用于 renderer
  // 建页的初始 src，不是 popup 通道）；壳窗口按既有行为 openExternal + deny（任何 URL）；
  // webview guest 一律 deny，URL 连同 opener 的 webContentsId 转发渲染层（BrowserTab 按
  // marker 流程建页，owner 经 opener 映射继承）。其余（pi-app 无 devtools 窗口）deny。
  contents.setWindowOpenHandler(({ url }) => {
    const kind = contents === shellWin?.webContents
      ? 'shell'
      : contents.getType() === 'webview' ? classifyGuestPopup(url) : 'other'
    if (kind === 'marker') {
      dropForgedMarker(url)
      return { action: 'deny' }
    }
    if (kind === 'shell') {
      void electron().shell.openExternal(url)
      return { action: 'deny' }
    }
    if (kind === 'guest') {
      activeEmit?.('browser:popup', { url, openerWebContentsId: contents.id })
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
  // 2. 输入中继：webview guest 的 keyDown/mouseDown/mouseWheel 节流 300ms 后 bump——
  // 人在 agent 页上的原生输入使旧 snapshot ref 失效（bump 按 webContentsId 找注册表行）。
  // service 经 getBrowserService() 惰性取：调用点的单例是运行时读取的模块变量，
  // 初始化前为设计的 no-op（不存在可被 tree-shaking 常量折叠的空参数）。
  if (contents.getType() !== 'webview') return
  contents.on('input-event', (_event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'mouseDown' && input.type !== 'mouseWheel') return
    const now = Date.now()
    if (now - (relayedAt.get(contents.id) ?? 0) < INPUT_RELAY_THROTTLE_MS) return
    relayedAt.set(contents.id, now)
    getBrowserService()?.bumpInteractionByWebContentsId(contents.id)
  })
  contents.once('destroyed', () => relayedAt.delete(contents.id))
}

/** browser 分区的会话接线（只装一次）：下载接管 + 权限白名单。 */
function wireBrowserSession(): void {
  if (sessionWired) return
  sessionWired = true
  const { app, session } = electron()
  const ses = session.fromPartition(BROWSER_PARTITION)
  // 3. 下载：自动落系统「下载」目录，重名 (n) 去重（setSavePath 只能在本回调内同步调用，
  // 异步保存对话框来不及）；完成 emit { path, filename }，失败附 error 形状（渲染层工具条指示）。
  ses.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads')
    const filename = item.getFilename() || 'download'
    const ext = extname(filename)
    const base = basename(filename, ext)
    let target = join(dir, filename)
    let seq = 1
    while (existsSync(target)) {
      target = join(dir, `${base} (${seq})${ext}`)
      seq += 1
    }
    item.setSavePath(target)
    item.once('done', (_e, state) => {
      if (state === 'completed') activeEmit?.('browser:download', { path: target, filename })
      else activeEmit?.('browser:download', { path: target, filename, error: state })
    })
  })
  // 4. 权限：browser 分区的请求按纯函数判定（fullscreen/clipboard-sanitized-write/pointerLock
  // 之外一律拒绝）。
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(decideBrowserPermission(permission))
  })
}

/**
 * 内嵌浏览器接线入口（createWindow 内调用），无条件安装：popup 路由 / 下载接管 /
 * 权限白名单本就不依赖 service；输入中继经 getBrowserService() 惰性取单例——service
 * 未初始化（唯一初始化点在 ipc.ts）时中继为设计的 no-op，调用点没有可被 tree-shaking
 * 常量折叠的空参数。
 * 幂等：重复 install 只刷新窗口/emit 引用，监听与会话接线不重复挂。
 */
export function installBrowserWiring(win: BrowserWindow, emit: BrowserEmit): void {
  shellWin = win
  activeEmit = emit
  if (!wiringInstalled) {
    wiringInstalled = true
    const { app } = electron()
    app.on('web-contents-created', (_event, contents) => wireContents(contents))
  }
  // 壳窗口自身的 contents 已在 new BrowserWindow 时创建（created 事件已错过）——显式补挂。
  // activate 路径重复调用时 setWindowOpenHandler 是 setter：后挂的（读到当前 shellWin）生效。
  wireContents(win.webContents)
  wireBrowserSession()
}
