/**
 * 内嵌浏览器的主进程接线：popup 路由 / guest 输入中继 / 浏览器级快捷键拦截 / 下载接管 / 权限白名单。
 * 移植自 pi-web electron/main.cjs 的 installPopupRouting / installInputRelay /
 * attachDownloadHandler（browser 分区）与权限白名单，按 pi-app 宿主形态精确改造：
 * - popup 按**系统浏览器语义**分流（见 popupOpensWindow）：窗口形态的 window.open 直接
 *   `allow` 出真 BrowserWindow 弹窗（同分区、真实 opener 关系、随 opener 销毁），标签形态
 *   的（target=_blank / ⌘点击 / 裸 window.open）才 deny 后经 `browser:popup` 收口成面板
 *   标签页。弹窗窗口不在面板注册表里——它是浏览器自己的窗口，host/agent 都按窗口对待。
 * - Electron 43 起 setWindowOpenHandler 只剩 webContents 级——经 web-contents-created
 *   给每个 contents 挂 handler，按 contents 身份分流；壳窗口自身的 contents 在 install
 *   时已存在（created 事件已错过），显式补挂同一逻辑（保持既有 openExternal 行为逐字不变，
 *   壳窗口不得再有第二个 window-open handler）。
 * - 输入中继不经服务器：经 getBrowserService() 惰性取单例后 bump interaction
 *   generation（guest 的旧 snapshot ref 失效）；service 初始化前为设计的 no-op。
 * - 浏览器级快捷键拦截：guest 持焦点时按键到不了壳窗口，⌘/Ctrl ± / 0 / F / P
 *   六键（均为浏览器 chrome 所有，见 wireContents 内的 allowlist 注释）在
 *   before-input-event 拦下（preventDefault 挡 guest 原生行为）并经
 *   browser:guest-shortcut 广播渲染层，由 BrowserPane 分流到 zoom 阶梯 /
 *   查找条 / 打印。
 * - 下载只接管 browser 分区：自动落系统「下载」目录，重名 (n) 去重，完成/失败经 emit
 *   通知渲染层工具条。
 * 纯函数（decideBrowserPermission / classifyGuestPopup）与安装器分离——检查脚本在
 * 纯 node 下导入断言，electron 只能在 Electron 路径内惰性 require（同 cdp-port.ts）。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron'
import { BROWSER_PARTITION, parseMarkerUrl } from '../../shared/browser.ts'
import { HTML_PREVIEW_PARTITION } from '../../shared/html-preview.ts'
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

/** 壳文档判定（弹窗分类只认 file:// 前缀——打包壳加载 file://，而导航白名单本就禁止 file: 的
 *  guest 页，不会误分类）。dev 的 localhost 壳文档不能按前缀认：那会把 agent 打开的本地
 *  dev server（http://localhost:3000/ 是编码代理的一等用例）错路由到 openExternal 而不是
 *  面板。壳窗口自身的弹窗按 contents 身份分流（contents === shellWin），不经过本函数；
 *  dev 壳窗口在注册表侧的排除由 service 的 shellDocumentUrl 精确匹配负责。 */
function isShellDocumentUrl(url: string): boolean {
  return url.startsWith('file://')
}

/** 纯函数：webview guest 弹窗 URL 的分类（marker 前缀 / 壳文档 / 普通页）。 */
export function classifyGuestPopup(url: string): 'marker' | 'shell' | 'guest' {
  if (parseMarkerUrl(url) !== null) return 'marker'
  if (isShellDocumentUrl(url)) return 'shell'
  return 'guest'
}

/**
 * features 串里出现任一「窗口形态」特性即为窗口。noopener / noreferrer /
 * attributionsrc 只描述引用关系，不代表网站要一个窗口——它们单独出现时 Chromium 也按
 * 标签页处理。
 */
const WINDOW_POPUP_FEATURES = new Set([
  'popup', 'dialog', 'dependent', 'alwaysontop', 'alwaysraised',
  'width', 'height', 'innerwidth', 'innerheight', 'outerwidth', 'outerheight',
  'left', 'top', 'screenx', 'screeny',
  'menubar', 'toolbar', 'location', 'status', 'resizable', 'scrollbars', 'titlebar',
  'minimizable', 'maximizable', 'closable', 'fullscreen',
])

/** features 串 → 小写名值表（`window.open` 的窗口特性；裸名给空串）。 */
function parseWindowFeatures(features: string): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const raw of features.split(',')) {
    const [name, value] = raw.split('=')
    const key = name?.trim().toLowerCase()
    if (key) parsed.set(key, (value ?? '').trim())
  }
  return parsed
}

function hasWindowFeatures(features: string): boolean {
  for (const name of parseWindowFeatures(features).keys()) {
    if (WINDOW_POPUP_FEATURES.has(name)) return true
  }
  return false
}

/**
 * 纯函数：guest 的 window.open 该出**真窗口**还是面板标签页（系统浏览器语义）。
 * - `new-window`（window.open 带窗口 features；Chromium 对 shift+点击/带 features 的
 *   调用给这个 disposition）→ 真窗口
 * - `foreground-tab` / `background-tab`（target=_blank、⌘/Ctrl+点击）→ 面板标签页
 * - `default`（裸 window.open、部分渲染器路径）→ 看 features：带窗口 features 才是窗口，
 *   否则按标签页——Chromium 自己对不带 features 的 window.open 也是开标签页
 * - `other` → 标签页（未知形态不开新窗口）
 * disposition 取值与 Electron HandlerDetails 的并集一致。
 */
export function popupOpensWindow(disposition: string, features: string): boolean {
  if (disposition === 'new-window') return true
  if (disposition === 'default') return hasWindowFeatures(features)
  return false
}

/**
 * 真弹窗窗口的 BrowserWindow 选项。
 * Electron 已按 features 串解析出尺寸/位置，并把安全类 webPreferences 从 opener 继承下来，
 * 所以这里只钉三件必须显式的事：
 * - **分区**：弹窗必须与面板页共用 cookie 罐，否则登录弹窗登完了 opener 依然未登录
 *   （pollution：partition 只是 webPreferences 的一个字段，不显式给就有落进默认分区的风险）。
 * - **纯网页 surface**：无 preload、无 Node、开 contextIsolation——弹窗是外部网站，
 *   绝不能拿到 app 的桥。
 * - 尺寸下限：features 里的小尺寸不得把窗口压成不可用（Chromium 同样有下限）。
 * 不设 parent：真弹窗是独立顶层窗口，不是吸附在壳窗口上的子窗（Chrome 的弹窗也不需要
 * 永远在壳窗口之上）。
 */
const POPUP_DEFAULT_SIZE = { width: 800, height: 600 }
const POPUP_MIN_SIZE = { width: 320, height: 240 }

/**
 * 纯函数：真弹窗窗口的几何——尺寸取 features（缺省 800×600，夹在 [下限, 工作区] 之间），
 * 位置一律**居中**在给定工作区，**忽略 features 的 left/top/screenX/screenY**。
 *
 * 忽略站点给的位置是刻意的：不少站点写 `left=0,top=0`（Apple 的 SIWA 弹窗就是），于是窗口
 * 停在屏幕左上角；另一个站点不写位置、落在别处——同一个 app 里两种落点。尺寸（那是弹窗
 * 存在的理由：登录框必须小）照旧尊重，位置由宿主统一决定。
 */
export function popupWindowGeometry(
  features: string,
  workArea: { x: number; y: number; width: number; height: number },
): { width: number; height: number; x: number; y: number } {
  const parsed = parseWindowFeatures(features)
  const size = (name: string, fallback: number, floor: number, ceiling: number): number => {
    const asked = Number(parsed.get(name))
    const value = Number.isFinite(asked) && asked > 0 ? Math.round(asked) : fallback
    return Math.max(floor, Math.min(value, Math.max(floor, ceiling)))
  }
  const width = size('width', POPUP_DEFAULT_SIZE.width, POPUP_MIN_SIZE.width, workArea.width)
  const height = size('height', POPUP_DEFAULT_SIZE.height, POPUP_MIN_SIZE.height, workArea.height)
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  }
}

/**
 * 真弹窗窗口的 BrowserWindow 选项。
 * Electron 会把安全类 webPreferences 从 opener 继承下来，所以这里只钉三件必须显式的事：
 * - **分区**：弹窗必须与面板页共用 cookie 罐，否则登录弹窗登完了 opener 依然未登录
 *   （partition 只是 webPreferences 的一个字段，不显式给就有落进默认分区的风险）。
 * - **纯网页 surface**：无 preload、无 Node、开 contextIsolation——弹窗是外部网站，
 *   绝不能拿到 app 的桥。**不要**为「分进程」加 `sandbox: true`：实测（2026-09 最小复现台）
 *   带 opener 关系的弹窗初始 about:blank 必然继承 guest 的渲染进程（同 OS pid）——弹窗侧或
 *   guest 侧的 sandbox 都不改变这一点，guest 侧 `nativeWindowOpen` 在 Electron 44 也已无效。
 * - **闪帧（已接受，不改行为）**：弹窗诞生会让 guest 掉一帧内容（用户可见的「原页面闪一下」）。
 *   根因是 BrowserService 的 playwright 连接对弹窗 target 的 auto-attach（waitForDebuggerOnStart
 *   暂停 + 初始化批次）命中弹窗诞生窗口，共进程 guest 主线程冻结 16-33ms——与这里的弹窗选项、
 *   分区、显示时机均无关；全部已证伪修复见 embedded-browser.md 的闪帧条目。
 * - **几何**：尺寸取 features（夹取）、位置居中到壳窗口所在显示器的工作区（见
 *   popupWindowGeometry）——handler 给的选项优先级最高，能压过 features 解析出的 left/top
 *   （实测：features 写 left=0,top=0 时窗口仍落在居中坐标）。
 * 不设 parent：真弹窗是独立顶层窗口，不是吸附在壳窗口上的子窗（Chrome 的弹窗也不需要
 * 永远在壳窗口之上）。
 */
function popupWindowOptions(features: string): BrowserWindowConstructorOptions {
  const { screen } = electron()
  const shell = shellWin && !shellWin.isDestroyed() ? shellWin : null
  const display = shell ? screen.getDisplayMatching(shell.getBounds()) : screen.getPrimaryDisplay()
  return {
    ...popupWindowGeometry(features, display.workArea),
    autoHideMenuBar: true,
    minWidth: POPUP_MIN_SIZE.width,
    minHeight: POPUP_MIN_SIZE.height,
    webPreferences: {
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
    },
  }
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

/**
 * 由 guest 的 window.open 真的建出来的弹窗窗口的 contents id（嵌套弹窗也按 guest 语义分流：
 * 弹窗自己再 window.open 时同样该开窗口就开窗口）；窗口销毁即摘除。
 */
const popupContents = new Set<number>()

/** 输入中继的每 contents 节流：webContentsId → 最近一次中继时刻（每手势前沿）。 */
const relayedAt = new Map<number, number>()
const INPUT_RELAY_THROTTLE_MS = 300

/** 渲染层推送的应用级快捷键 identities（lib/shortcuts 的 bindingIdentity 形式：
 *  Control/Alt/Shift/Meta 排序后 + 物理 code）。guest 持焦点时壳窗口收不到 keydown，
 *  命中的组合键在这里拦下（preventDefault 挡 guest 原生行为）并转发渲染层 dispatcher。
 *  只含带修饰键的绑定——裸键（如停止键 Escape）永不中继，页面自己的 Escape 归页面。 */
let appShortcutIdentities = new Set<string>()

export function setAppShortcutIdentities(identities: unknown): void {
  appShortcutIdentities = new Set(
    Array.isArray(identities)
      ? identities.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
  )
}

/** before-input 的组合键 → bindingIdentity 同一形式（修饰键固定序 + 物理 code）。 */
function guestInputIdentity(input: { control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string }): string {
  return [
    input.control && 'Control',
    input.alt && 'Alt',
    input.shift && 'Shift',
    input.meta && 'Meta',
    input.code
  ].filter(Boolean).join('+')
}

/** 每个 contents 一份的接线：window-open 路由 + webview guest 的输入中继。 */
function wireContents(contents: WebContents): void {
  // HTML file guests have their own navigation, permissions and shortcuts.
  // They must never inherit the browser's popup or signed-in session behavior.
  if (contents.session === electron().session.fromPartition(HTML_PREVIEW_PARTITION)) return
  // 1. popup 路由：marker 一律 deny（伪造的记一次日志——marker 命名空间只用于 renderer
  // 建页的初始 src，不是 popup 通道）；壳窗口按既有行为 openExternal + deny（任何 URL）；
  // webview guest 与弹窗窗口按系统浏览器语义分流——窗口形态 `allow` 出真 BrowserWindow，
  // 标签形态 deny 并把 URL 连同 opener 的 webContentsId 转发渲染层（BrowserPane 按 marker
  // 流程物化为面板标签页，owner 经 opener 映射继承）。其余（pi-app 无 devtools 窗口）deny。
  contents.setWindowOpenHandler((details) => {
    const { url } = details
    const kind = contents === shellWin?.webContents
      ? 'shell'
      : (contents.getType() === 'webview' || popupContents.has(contents.id))
        ? classifyGuestPopup(url)
        : 'other'
    if (kind === 'marker') {
      dropForgedMarker(url)
      return { action: 'deny' }
    }
    if (kind === 'shell') {
      void electron().shell.openExternal(url)
      return { action: 'deny' }
    }
    if (kind === 'guest') {
      if (popupOpensWindow(details.disposition, details.features)) {
        return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) }
      }
      activeEmit?.('browser:popup', { url, openerWebContentsId: contents.id })
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
  // 2. 弹窗窗口的诞生：登记其 contents id（它自己再弹窗时也按 guest 分流），并把生命周期
  //    钉在 opener 上——面板折叠/关页/会话结束都会销毁 guest，屏幕上不该留下指向已死
  //    opener 的窗口（Chromium 的默认也是随 opener 关闭，这里显式钉住不靠默认值）。
  //    同时告知 service：agent 页弹出的窗口模型必须知道（它进不了面板注册表）。
  if (contents.getType() === 'webview' || popupContents.has(contents.id)) {
    contents.on('did-create-window', (window, details) => {
      const popupId = window.webContents.id
      popupContents.add(popupId)
      window.webContents.once('destroyed', () => popupContents.delete(popupId))
      contents.once('destroyed', () => {
        if (!window.isDestroyed()) window.close()
      })
      getBrowserService()?.noteWindowPopup(contents.id, details.url)
    })
  }
  // 3. 输入中继 + 浏览器级快捷键拦截：只对面板 guest。真弹窗是普通浏览器窗口，缩放/查找/
  //    打印由它自己的原生 chrome 与 Chromium 默认行为负责，不走面板的 zoom 阶梯与查找条。
  if (contents.getType() !== 'webview') return
  contents.on('input-event', (_event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'mouseDown' && input.type !== 'mouseWheel') return
    // A guest pointer press never reaches the host DOM (separate process) —
    // forward it unthrottled so host-side overlays (the ⋮ popover) can treat
    // it as an outside press. One message per physical click.
    if (input.type === 'mouseDown') activeEmit?.('browser:guest-pointer', {})
    const now = Date.now()
    if (now - (relayedAt.get(contents.id) ?? 0) < INPUT_RELAY_THROTTLE_MS) return
    relayedAt.set(contents.id, now)
    getBrowserService()?.bumpInteractionByWebContentsId(contents.id)
  })
  // 4. 浏览器级快捷键拦截：guest 持焦点时按键不会到达壳窗口（渲染层的 window keydown
  // 收不到），Chromium 又会让 guest 自行处理这些键（⌘±/0 原生缩放，与渲染层的 zoom
  // 阶梯 desync）。before-input-event 在 guest 处理之前拦下 ⌘/Ctrl + = / + / - / 0 /
  // f / p——这六键是浏览器 chrome 所有（Ruling M）：真实浏览器的 ⌘F 查找条与 ⌘P 打印
  // 也从不转发给页面自己的 keydown 处理器，即使焦点在页面里——浏览器惯例优先于页面
  // 的自留快捷键。preventDefault 挡住 guest 原生行为，把按键广播给渲染层，
  // BrowserPane 经 onBrowserGuestShortcut 订阅后分流到 setBrowserZoom 阶梯 / 查找条 /
  // 打印。
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (!(input.meta || input.control)) return
    // Match by key OR physical code: non-US layouts report other `key`
    // spellings for the same physical keys — the renderer's window listener
    // carries the same code fallback, so both paths stay layout-independent.
    const GUEST_SHORTCUT_CODES: Record<string, string> = {
      Equal: '=', Minus: '-', Digit0: '0', KeyF: 'f', KeyP: 'p'
    }
    const key = GUEST_SHORTCUT_CODES[input.code ?? ''] ?? input.key
    const identity = guestInputIdentity(input)
    if (key === '=' || key === '+' || key === '-' || key === '0' || key === 'f' || key === 'p') {
      event.preventDefault()
      // identity 随行：该键同时绑了应用级命令（默认 ⌘P → files 面板）时，
      // 面板不活跃的 BrowserPane 把它转发给应用 dispatcher。
      activeEmit?.('browser:guest-shortcut', { key, identity })
      return
    }
    // 应用级快捷键：渲染层推送的 identities 命中即转发其 dispatcher（lib/shortcuts）。
    if (appShortcutIdentities.size === 0 || !appShortcutIdentities.has(identity)) return
    event.preventDefault()
    activeEmit?.('browser:guest-app-shortcut', { identity, repeat: !!input.isAutoRepeat })
  })
  contents.once('destroyed', () => {
    // 与输入中继同一处清理：before-input 监听随 emitter 销毁，这里再显式摘除 + 清节流表。
    contents.removeAllListeners('before-input-event')
    relayedAt.delete(contents.id)
  })
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
