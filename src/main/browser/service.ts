/**
 * 单例浏览器服务：Electron 壳 CDP 连接 + page 注册表 + agent 直驱（webview guest）。
 * 移植自 pi-web lib/browser-service.ts（逐成员照抄，仅按 pi-app 的宿主形态做精确改造）。
 * human/agent 页均为壳内原生 webview——guest 由 renderer 托管（marker URL 物化），
 * 服务端经 CDP 发现 target 并驱动；服务端不能自建 target。
 * playwright 对象只经 PageLike/ContextLike 结构接口访问，测试注入 mock。
 * 生命周期由 ipc.ts / shutdown.ts 拥有：dispose 只丢引用，绝不 browser.close()
 * （CDP Browser.close 可能直接退出 Electron 壳）。
 */
import {
  activePageForOwner, addPage, bumpInteraction, clearAllPages, pageById, pageMeta,
  pagesForOwner, recordSnapshot, removePage, setActivePage, setAgentBusy, setCrashed,
  setPageWebContentsId, setPendingNavigate, updatePageNav,
  EMPTY_BROWSER_PAGES,
  type BrowserPagesState,
} from './pages.ts'
import {
  createBrowserPageId, isAllowedNavigationUrl, isSameDocumentUrl, parseMarkerUrl,
  type BrowserPageMeta, type ElementAtInfo,
} from '../../shared/browser.ts'
import { diffSnapshotLines, isAiRef, parseSnapshotRefs } from './tools-core.ts'

// ---- 页内 evaluate 脚本的 DOM 类型面（最小 shim）----
// countMutations / annotate canvas 合成 / elementFromPoint 等脚本体在 guest 页内执行，
// 其中的 DOM 全局在 main 进程的编译目标（lib ES2023，无 DOM）里不存在——这里只补
// 脚本体引用到的名字的最小类型；脚本字符串本身逐字保留，任何改动都有回归风险。
interface DomRectLike { x: number; y: number; width: number; height: number }
interface DomElementLike {
  nodeType: number
  tagName: string
  id: string
  innerText: string
  classList: ArrayLike<string>
  children: ArrayLike<DomElementLike>
  parentElement: DomElementLike | null
  getBoundingClientRect(): DomRectLike
  getAttribute(name: string): string | null
}
interface DomImageLike {
  naturalWidth: number
  naturalHeight: number
  onload: (() => void) | null
  onerror: (() => void) | null
  src: string
}
type Element = DomElementLike
type HTMLElement = DomElementLike
declare const document: {
  documentElement: DomElementLike
  createElement(tag: string): {
    width: number
    height: number
    getContext(kind: '2d'): {
      font: string
      strokeStyle: string
      lineWidth: number
      fillStyle: string
      textBaseline: string
      drawImage(image: DomImageLike, x: number, y: number): void
      strokeRect(x: number, y: number, w: number, h: number): void
      fillRect(x: number, y: number, w: number, h: number): void
      measureText(text: string): { width: number }
      fillText(text: string, x: number, y: number): void
    } | null
    toDataURL(type: string, quality?: number): string
  }
  elementFromPoint(x: number, y: number): DomElementLike | null
}
declare const window: {
  innerWidth: number
  innerHeight: number
  scrollX: number
  scrollY: number
  scrollBy(x: number, y: number): void
}
declare const location: { reload(): void }
declare const CSS: { escape(value: string): string }
declare const Image: { new (): DomImageLike }
declare const MutationObserver: {
  new (callback: (list: unknown[]) => void): { observe(target: unknown, options: unknown): void; disconnect(): void }
}

export class ConsentRequiredError extends Error { constructor() { super('browser consent required'); this.name = 'ConsentRequiredError' } }
export class PageNotFoundError extends Error { constructor(id: string) { super(`unknown page: ${id}`); this.name = 'PageNotFoundError' } }
export class PageGoneError extends Error { constructor(id: string) { super(`page is gone: ${id}`); this.name = 'PageGoneError' } }
export class StaleSnapshotError extends Error { constructor(msg?: string) { super(msg); this.name = 'StaleSnapshotError' } }
export class InvalidRefError extends Error { constructor(ref: unknown) { super(`invalid ref: ${String(ref)}`); this.name = 'InvalidRefError' } }
export class NavigationBlockedError extends Error { constructor(url: string) { super(`navigation blocked: ${url}`); this.name = 'NavigationBlockedError' } }
/** browser_snapshot 的 selector 无匹配/多匹配/语法错误。 */
export class SnapshotScopeError extends Error { constructor(msg: string) { super(msg); this.name = 'SnapshotScopeError' } }
/** agent 建页握手超时：没有 renderer（浏览器标签页）在物化 pendingCreate。 */
export class BrowserHostUnavailableError extends Error { constructor() { super('no renderer available to host the browser page (browser tab not open)'); this.name = 'BrowserHostUnavailableError' } }

/** 动作 → 快照的落定等待（详见 settleForSnapshot）；测试可注入缩短。 */
export interface SettleTimings {
  /** 预热延迟：给异步 handler / 导航启动留时间。 */
  warmupMs: number
  /** 单次 DOM mutation 采样窗口。 */
  sampleMs: number
  /** 落定等待总预算（持续繁忙页面按此截断）。 */
  budgetMs: number
  /** 检测到导航（URL 变化/文档撕毁）后等 domcontentloaded 的上限。 */
  navLoadStateMs: number
}
const DEFAULT_SETTLE_TIMINGS: SettleTimings = { warmupMs: 120, sampleMs: 120, budgetMs: 1_500, navLoadStateMs: 5_000 }

export interface AgentActionResult {
  pageId: string
  snapshot: string
  newPages: BrowserPageMeta[]
  /** 动作后的页面导航信息（展示用）。 */
  url?: string
  title?: string
  /** wait_for 显式上报的未满足条件（超时）；空/缺省 = 全部满足。 */
  unmet?: string[]
}

const MAX_RETIRED_IDS = 100
const ELECTRON_RECONCILE_INTERVAL_MS = 1_000
/** 建页握手超时：renderer 轮询 + webview 挂载 + reconcile（1s）需数秒，放宽到 15s。 */
const ELECTRON_CREATE_TIMEOUT_MS = 15_000
/** pendingCreate 在 status 里的展示 TTL（waiter 超时后残留的条目清扫用）。 */
const PENDING_CREATE_TTL_MS = 30_000
// ---- playwright 结构接口（真实对象天然满足；测试注入 mock）----
/** agent 交互超时：Playwright 默认 30s actionability 重试会把一轮卡死（被遮挡元素尤甚）。 */
const AGENT_ACTION_TIMEOUT_MS = 8_000
/** agent 导航超时：慢站点 domcontentloaded 可超 8s，但绝不容 Playwright 默认 30s 挂死。 */
const AGENT_NAV_TIMEOUT_MS = 20_000
/** 注册表变更通知的合并窗：state 高频赋值（agent 动作/reconcile 轮询）只触发一次回调。 */
const STATE_NOTIFY_COALESCE_MS = 30

export interface LocatorLike {
  click(options?: { timeout?: number; force?: boolean }): Promise<void>
  /** 逐键输入（键盘事件链）；fill 的 Input.insertText 在非可见 webview guest 上静默无效，禁用。 */
  pressSequentially(text: string, options?: { timeout?: number }): Promise<void>
  press(key: string): Promise<void>
  hover(options?: { timeout?: number; force?: boolean }): Promise<void>
  selectOption(values: string[], options?: { timeout?: number; force?: boolean }): Promise<unknown>
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>
  ariaSnapshot(options?: { mode?: 'ai' | 'default' }): Promise<string>
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>
  first(): LocatorLike
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>
}
export interface PageLike {
  url(): string
  title(): Promise<string>
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  goBack(options?: { timeout?: number }): Promise<unknown>
  goForward(options?: { timeout?: number }): Promise<unknown>
  reload(): Promise<unknown>
  close(): Promise<void>
  isClosed(): boolean
  on(event: 'close' | 'crash', cb: () => void): void
  opener(): Promise<PageLike | null>
  ariaSnapshot(options?: { mode?: 'ai' | 'default' }): Promise<string>
  locator(selector: string): LocatorLike
  getByText(text: string): LocatorLike
  keyboard: { press(key: string): Promise<void> }
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> }
  screenshot(options?: { type?: 'jpeg'; quality?: number; timeout?: number }): Promise<Uint8Array>
  waitForTimeout(ms: number): Promise<void>
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>
  /** 页面上下文求值（settle 的 DOM 采样 + annotate 的离屏 canvas 合成）；真实 page.evaluate(fn, arg)。 */
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>
  /** 清除 playwright 连接时强加的默认媒体仿真（真实 page.emulateMedia）；测试 mock 可缺省。 */
  emulateMedia?(options: {
    colorScheme?: 'dark' | 'light' | 'no-preference' | null
    reducedMotion?: 'reduce' | 'no-preference' | null
    forcedColors?: 'active' | 'none' | null
  }): Promise<void>
}
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, cb: (params: unknown) => void): void
  detach(): Promise<void>
}
export interface BrowserContextLike {
  newPage(): Promise<PageLike>
  on(event: 'page', cb: (page: PageLike) => void): void
  /** 当前所有 page（target 发现用）；playwright 真实对象已有此方法。 */
  pages(): PageLike[]
  newCDPSession(page: PageLike): Promise<CdpSessionLike>
  close(): Promise<void>
}
/** connectOverCDP 拿到的 Electron 浏览器（真实 playwright Browser 结构子集）。 */
export interface ElectronBrowserLike {
  contexts(): BrowserContextLike[]
  on(event: 'disconnected', cb: () => void): void
  close(): Promise<void>
}
export type ConnectElectronFn = (port: number) => Promise<ElectronBrowserLike>

/** context 的全部 page：playwright 是 `pages()` 方法；测试 mock 直接暴露数组属性——两种形态都接受。 */
function contextPagesOf(context: BrowserContextLike): PageLike[] {
  const raw: unknown = context.pages
  if (typeof raw === 'function') return raw.call(context) as PageLike[]
  return Array.isArray(raw) ? (raw as PageLike[]) : []
}

interface PageRuntime {
  page: PageLike
  cdp: CdpSessionLike | null
  /** 建链中的 CDP 会话（memoize 防并发双建）；拒绝后清空以允许重试。 */
  cdpPromise: Promise<CdpSessionLike> | null
  actionChain: Promise<void>
  /** 最近一次 agent 快照全文（diff snapshot 的基线）。 */
  lastSnapshotText: string | null
}

async function defaultConnectElectron(port: number): Promise<ElectronBrowserLike> {
  const { chromium } = await import('playwright-core')
  return await chromium.connectOverCDP(`http://127.0.0.1:${port}`) as unknown as ElectronBrowserLike
}

export interface BrowserServiceDeps {
  /** Electron 壳 CDP 端口（main 进程恒持有）。 */
  cdpPort: number
  /** consent 读写（manager 接 app-settings.json；测试注入内存布尔）。 */
  consent: { get(): boolean; grant(): void }
  /** 测试注入连接函数；缺省 playwright chromium.connectOverCDP。 */
  connectElectronFn?: ConnectElectronFn
  /** 建页握手超时（默认 ELECTRON_CREATE_TIMEOUT_MS；测试可缩短）。 */
  createTimeoutMs?: number
  /** 动作后快照的落定等待计时（测试注入缩短；语义见 settleForSnapshot）。 */
  settle?: Partial<SettleTimings>
  /** 注册表变更时通知（service 内部 ~30ms 合并；ipc.ts 传入的 emit 走 browser:state）。 */
  onStateChange?: () => void
  /** 壳窗口自身文档的 URL（dev: ELECTRON_RENDERER_URL；打包: file:// 的渲染入口），
   *  由 ipc.ts 与 index.ts 的 loadURL/loadFile 同一表达式传入。reconcile/registerPopup
   *  据此把壳窗口精确排除在注册表外（file:// 前缀兜底打包形态）。不能按 localhost
   *  前缀泛配——agent 打开的本地 dev server 页（编码代理的一等用例）会被当成壳窗口，
   *  永远拿不到 runtime。 */
  shellDocumentUrl?: string
}

export class BrowserService {
  private state: BrowserPagesState = EMPTY_BROWSER_PAGES
  private runtime = new Map<string, PageRuntime>()
  private context: BrowserContextLike | null = null
  private startPromise: Promise<BrowserContextLike> | null = null
  private retiredIds: string[] = []
  private popupLog: Array<{ id: string; owner: string }> = []
  private readonly deps: BrowserServiceDeps
  private readonly connectElectronFn: ConnectElectronFn
  private readonly createTimeoutMs: number
  /** connectOverCDP 拿到的 Electron 浏览器（断开即清空）。 */
  private electronBrowser: ElectronBrowserLike | null = null
  /** target 发现轮询（仅连接存活期间）。 */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  /** agent 建页握手：等待 renderer 物化的 pendingCreate 队列（getStatus 暴露给渲染端）。 */
  private pendingCreates: Array<{ id: string; owner: string; url?: string; createdAt: number }> = []
  /** 等待某 id 完成 runtime 登记的 waiter（createPage 挂起处；登记即放行）。 */
  private readonly registrationWaiters = new Map<string, { resolve: (meta: BrowserPageMeta) => void; timer: ReturnType<typeof setTimeout> }>()
  /** 已清除 playwright 默认媒体仿真的 Page（按对象身份 memo——每次连接每个 page 清一次）。 */
  private readonly mediaResetDone = new WeakSet<object>()
  /** close 在途的 page id：target 尚未从 CDP 摘除期间，reconcile 不得按 marker 重登。 */
  private readonly closingTargetIds = new Set<string>()
  /** 同 owner 的建页串行化（防并行 getOrCreate 双开页）。 */
  private readonly ownerChains = new Map<string, Promise<void>>()
  private readonly settleTimings: SettleTimings
  /** app 主题（light/dark）：经 CDP Emulation.setEmulatedMedia 注入每个 guest 的
   *  prefers-color-scheme——webview guest 缺省跟 OS 而非 app 主题走。新页注册时重放。 */
  private emulatedColorScheme: 'dark' | 'light' | null = null
  /** 注册表变更通知：stateDirty + 合并窗（timer unref；dispose 清理）。 */
  private stateDirty = false
  private stateNotifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: BrowserServiceDeps) {
    this.deps = deps
    this.connectElectronFn = deps.connectElectronFn ?? defaultConnectElectron
    this.createTimeoutMs = deps.createTimeoutMs ?? ELECTRON_CREATE_TIMEOUT_MS
    this.settleTimings = { ...DEFAULT_SETTLE_TIMINGS, ...deps.settle }
  }

  // ---- 状态与 consent ----
  private hasConsent(): boolean {
    return this.deps.consent.get()
  }

  grantConsent(): void {
    this.deps.consent.grant()
  }

  /** 注册表变更通知：合并窗内的多次 state 赋值只回调一次（onStateChange 无则零成本）。 */
  private notifyState(): void {
    this.stateDirty = true
    if (this.stateNotifyTimer !== null) return
    this.stateNotifyTimer = setTimeout(() => {
      this.stateNotifyTimer = null
      if (!this.stateDirty) return
      this.stateDirty = false
      this.deps.onStateChange?.()
    }, STATE_NOTIFY_COALESCE_MS)
    this.stateNotifyTimer.unref()
  }

  private clearStateNotify(): void {
    if (this.stateNotifyTimer !== null) {
      clearTimeout(this.stateNotifyTimer)
      this.stateNotifyTimer = null
    }
    this.stateDirty = false
  }

  getStatus() {
    // 纯读：不在这里踢 reconcile——标题会变的页面（未读计数/时钟）会让
    // notify→broadcast→getStatus→reconcile→title 变化→notify 以 ~30ms 合并节奏自持
    // 循环（每轮对每个注册页各做一次 title()）。target 发现由 1s reconcile 轮询与
    // 渲染层的显式拉取路径（面板建页/consent 后的首次调用）覆盖。
    // 陈旧 pendingCreate 清扫：waiter 已超时的条目超过 TTL 后不再展示
    //（waiter 未超时的保留——renderer 可能正在挂载）。
    const cutoff = Date.now() - PENDING_CREATE_TTL_MS
    this.pendingCreates = this.pendingCreates.filter(
      (p) => p.createdAt >= cutoff || this.registrationWaiters.has(p.id),
    )
    return {
      available: true as const,
      consentRequired: !this.hasConsent(),
      pages: this.listPages(),
      pendingCreates: this.pendingCreates.map(({ id, owner, createdAt }) => ({ id, owner, createdAt })),
    }
  }

  listPages(): BrowserPageMeta[] {
    return this.state.pages.map(pageMeta)
  }

  // ---- 启动（single-flight）：Electron 壳暴露了 CDP 端口——连接壳内 Chromium ----
  private ensureStarted(): Promise<BrowserContextLike> {
    if (this.context) return Promise.resolve(this.context)
    if (!this.hasConsent()) return Promise.reject(new ConsentRequiredError())
    if (this.startPromise) return this.startPromise
    const port = this.deps.cdpPort
    this.startPromise = this.connectElectron(port).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  // ---- 连接 Electron 壳的 CDP ----
  private async connectElectron(port: number): Promise<BrowserContextLike> {
    const browser = await this.connectElectronFn(port)
    const context = browser.contexts()[0]
    if (!context) {
      // 不调 browser.close()：connectOverCDP 的 Browser.close 会发 CDP Browser.close，
      // 可能直接退出 Electron 壳。
      throw new Error('electron browser exposes no default context')
    }
    this.electronBrowser = browser
    this.context = context
    context.on('page', (page) => {
      void this.registerPopup(page)
    })
    browser.on('disconnected', () => this.handleProcessExit())
    // CDP 对 guest target 的 page 事件与 marker 首 URL 的时序不可靠——
    // 1s 轮询 reconcile 兜底（unref；异常静默，壳重启后经重连自然恢复）。
    this.reconcileTimer = setInterval(() => {
      const current = this.context
      if (!current) return
      try { this.reconcile(current) } catch { /* 壳重启后自然恢复 */ }
    }, ELECTRON_RECONCILE_INTERVAL_MS)
    this.reconcileTimer.unref()
    try { this.reconcile(context) } catch { /* 连接时的一次性对齐尽力而为 */ }
    return context
  }

  /** 公开：对齐 context.pages() 与注册表（marker 登记 / 消失注销）。 */
  async reconcileElectronTargets(): Promise<void> {
    const context = await this.ensureStarted()
    try { this.reconcile(context) } catch { /* 与轮询路径同样静默 */ }
  }

  /** pi-app 壳自身窗口的 URL（壳窗口永不进注册表；reconcile 与 registerPopup 共用）。
   *  打包壳加载 file://（前缀判定）；dev 壳文档按构造时传入的 shellDocumentUrl 归一化
   *  匹配（isSameDocumentUrl：无尾斜杠的 ELECTRON_RENDERER_URL vs 带尾斜杠的
   *  page.url()，字符串精确匹配永不命中）——不能按 http://localhost: 前缀泛配，
   *  否则 agent 打开的本地 dev server 页（http://localhost:3000/）会被当成壳窗口，
   *  永远拿不到 runtime。 */
  private isShellWindowUrl(url: string): boolean {
    const shellDocumentUrl = this.deps.shellDocumentUrl
    if (shellDocumentUrl !== undefined && isSameDocumentUrl(url, shellDocumentUrl)) return true
    return url.startsWith('file://')
  }

  private reconcile(context: BrowserContextLike): void {
    const present = contextPagesOf(context)
    // 消失注销：注册表中的 Page 已不在 context.pages() → 按关闭处理。
    for (const [id, rt] of [...this.runtime]) {
      if (!present.includes(rt.page)) this.handlePageClosed(id)
    }
    // marker 登记：新 Page 且 URL 携带 marker → 按 marker 的 owner/pageId 登记
    // （id 用 marker 的 pageId，非 idGen）。无 marker 的一律跳过——壳窗口
    // （shellDocumentUrl 归一化/file://）、裸 about:blank 与其他外部 target 的归属不猜。
    // closingTargetIds 里的 id 是 close 在途的页——target 摘除有延迟，不得重登。
    // 仅有 state 登记（renderer 上报）而无 runtime 的同 id 页：target 浮现后在此升级。
    for (const page of present) {
      let known = false
      for (const rt of this.runtime.values()) if (rt.page === page) { known = true; break }
      if (known) continue
      const url = page.url()
      if (this.isShellWindowUrl(url)) { this.resetForeignPageEmulation(page); continue } // 壳窗口永不登记（与 registerPopup 同一判定）
      const marker = parseMarkerUrl(url)
      if (!marker || this.closingTargetIds.has(marker.pageId)) { this.resetForeignPageEmulation(page); continue }
      if (pageById(this.state, marker.pageId) && this.runtime.has(marker.pageId)) continue
      this.registerRuntimePage(page, marker.owner, marker.pageId)
    }
    // 已登记页的 url/title 刷新：marker URL 只是登记占位，guest 导航后把真实值刷进注册表
    // （strip 的 server 兜底数据源）。url 变化时 updatePageNav 清 snapshot——导航本就会使
    // 旧 ref 失效，语义正确。真实 URL 不被 marker 回盖（renderer 上报可能先到了更准的 URL）。
    // title 只能异步取，应用前复查身份/变化，只对变化的落盘。
    for (const [id, rt] of [...this.runtime]) {
      if (!present.includes(rt.page)) continue
      const rec = pageById(this.state, id)
      if (!rec) continue
      const url = rt.page.url()
      const markerDowngrade = parseMarkerUrl(url) !== null && parseMarkerUrl(rec.url) === null
      if (rec.url !== url && !markerDowngrade) {
        this.state = updatePageNav(this.state, id, url, rec.title)
        this.notifyState()
      }
      void rt.page.title().then((title) => {
        if (this.runtime.get(id)?.page !== rt.page) return
        const cur = pageById(this.state, id)
        if (cur && cur.title !== title) {
          this.state = updatePageNav(this.state, id, cur.url, title)
          this.notifyState()
        }
      }).catch(() => { /* 导航中/崩溃的 target 取不到 title——下轮再说 */ })
    }
  }

  // ---- 页面注册 ----
  private registerRuntimePage(page: PageLike, owner: string, id: string = createBrowserPageId()): BrowserPageMeta {
    this.state = addPage(this.state, { id, owner, url: page.url() })
    this.notifyState()
    this.runtime.set(id, {
      page, cdp: null, cdpPromise: null,
      actionChain: Promise.resolve(),
      lastSnapshotText: null,
    })
    page.on('close', () => this.handlePageClosed(id))
    page.on('crash', () => this.handlePageCrashed(id))
    // 先清 playwright 连接时强加的默认媒体仿真，再重放当前 app 主题
    //（新页 / 重连恢复的 guest 也要跟随亮暗；无主题偏好时 guest 回归跟随 OS）。
    this.resetForeignPageEmulation(page)
    if (this.emulatedColorScheme) void this.applyColorSchemeTo(this.runtime.get(id)!).catch(() => {})
    // agent popup 页的待导航：renderer 声明的 pendingNavigate 在 runtime 就位后由服务端 goto
    //（renderer 自己 dom-ready 即导航会输掉与 reconcile 的 marker 竞态——guest 驶离
    //  marker 就登记不上 runtime，agent 永远拿不到这页）。
    const pending = pageById(this.state, id)?.pendingNavigate
    if (pending) {
      this.state = setPendingNavigate(this.state, id, null)
      this.notifyState()
      void page.goto(pending, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => { /* 失败页由 webview 自身呈现 */ })
    }
    // 建页握手放行（createPage 的调用方在等）
    const waiter = this.registrationWaiters.get(id)
    if (waiter) {
      this.registrationWaiters.delete(id)
      clearTimeout(waiter.timer)
      this.pendingCreates = this.pendingCreates.filter((p) => p.id !== id)
      waiter.resolve(pageMeta(pageById(this.state, id)!))
    }
    return pageMeta(pageById(this.state, id)!)
  }

  private async registerPopup(page: PageLike): Promise<void> {
    // 显式注册（createBackgroundPage 的 marker 登记）可能与新 target 的 page 事件竞态——
    // 让一个宏任务过去，等显式注册落地后按 Page 身份去重。
    await new Promise((r) => setTimeout(r, 0))
    for (const rt of this.runtime.values()) {
      if (rt.page === page) return
    }
    // marker 页归 reconcile/显式登记；空白页可能是 marker 尚未可见的新 guest——同样留给
    // reconcile，避免按 idGen 错登；壳窗口（auto-attach 也会对已存在 target 触发
    // page 事件）永不登记——但不属注册表的 target 都要清掉 playwright 的默认仿真。
    const url = page.url()
    if (parseMarkerUrl(url) !== null || url === '' || url === 'about:blank' || this.isShellWindowUrl(url)) {
      this.resetForeignPageEmulation(page)
      return
    }
    let owner = 'human'
    try {
      const opener = await page.opener()
      if (opener) {
        for (const [id, rt] of this.runtime) {
          if (rt.page === opener) {
            owner = pageById(this.state, id)?.owner ?? 'human'
            break
          }
        }
      }
    } catch { /* opener 已销毁则按 human 归属 */ }
    const meta = this.registerRuntimePage(page, owner)
    this.popupLog.push({ id: meta.id, owner })
  }

  /**
   * 兜底：CDP connect 前已存在的 webview guest 不进 pages()（Electron 43 实测
   * ——/json/list 可见但 playwright 不 auto-attach；window.open target 与 post-connect
   * 的 webview 都正常浮现）——renderer 把服务端不知道的本地页上报登记。
   * 只登记 state（无 runtime/PageLike：不能流式/输入，但 human 页在 Electron 下本就原生
   * webview 渲染）；target 若随后浮现（如重连后新建连接），reconcile 按同 id 升级为完整登记。
   * 幂等：已退休/关闭在途的 id 不复活；已登记 id 的重复上报只在 state-only 状态下刷新 URL
   *（popup 页驶离 marker 太快、reconcile 升级赶不上时，这是 server 行收敛到真实 URL 的途径）。
   */
  registerExternalPage(entry: { id: string; owner: string; url: string; webContentsId?: number; navigateTo?: string }): BrowserPageMeta | null {
    const { id, owner, url } = entry
    if (!id || !owner) return null
    if (!isAllowedNavigationUrl(url) && parseMarkerUrl(url) === null) return null
    const webContentsId = typeof entry.webContentsId === 'number' ? entry.webContentsId : undefined
    // navigateTo 走同一 scheme 白名单（它是 renderer 替 agent popup 页声明的待导航 URL）
    const navigateTo = entry.navigateTo && isAllowedNavigationUrl(entry.navigateTo) ? entry.navigateTo : undefined
    // Handshake latency: a seen report IS the guest's dom-ready — when a
    // createPage waiter is parked on a marker page, reconcile NOW instead of
    // waiting for the 1s tick (the marker target is already in
    // context.pages()). Gated on waiters so ordinary seen refreshes add no
    // reconcile load.
    if (this.registrationWaiters.size > 0) void this.reconcileElectronTargets().catch(() => {})
    const existing = pageById(this.state, id)
    if (existing) {
      // wcId 上报不受 runtime 状态限制（reconcile 只刷 url/title，不管这个字段——
      // 它是主进程 input-event 中继的映射键）。
      if (webContentsId !== undefined) {
        this.state = setPageWebContentsId(this.state, id, webContentsId)
        this.notifyState()
      }
      if (navigateTo) {
        const rt = this.runtime.get(id)
        // runtime 已就位：立即导航；否则存 pendingNavigate，等 registerRuntimePage 消费
        if (rt) void rt.page.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => {})
        else {
          this.state = setPendingNavigate(this.state, id, navigateTo)
          this.notifyState()
        }
      }
      // state-only 登记（target 从未浮现——popup 页毫秒内就驶离 marker URL，reconcile
      // 的 marker 匹配赶不上）才跟随重复上报刷新 URL；有 runtime 的页由 reconcile 的
      // F3 刷新负责，双写会互相覆盖。
      if (!this.runtime.has(id) && url !== existing.url) {
        this.state = updatePageNav(this.state, id, url, existing.title)
        this.notifyState()
        return pageMeta(pageById(this.state, id)!)
      }
      return null
    }
    if (this.retiredIds.includes(id) || this.closingTargetIds.has(id)) return null
    this.state = addPage(this.state, { id, owner, url })
    this.notifyState()
    if (webContentsId !== undefined) {
      this.state = setPageWebContentsId(this.state, id, webContentsId)
      this.notifyState()
    }
    if (navigateTo) {
      this.state = setPendingNavigate(this.state, id, navigateTo)
      this.notifyState()
    }
    return pageMeta(pageById(this.state, id)!)
  }

  private requireRuntime(id: string): PageRuntime {
    const rt = this.runtime.get(id)
    if (rt) return rt
    if (this.retiredIds.includes(id)) throw new PageGoneError(id)
    throw new PageNotFoundError(id)
  }

  private retire(id: string): void {
    this.retiredIds.push(id)
    if (this.retiredIds.length > MAX_RETIRED_IDS) this.retiredIds.shift()
  }

  async createPage(owner: string, url?: string): Promise<BrowserPageMeta> {
    await this.ensureStarted()
    if (url !== undefined && !isAllowedNavigationUrl(url)) throw new NavigationBlockedError(url)
    // agent 页由 renderer 托管（webview guest）——服务端不能自建 target（Target.createTarget
    // 未实现、window.open 隐藏窗口方案已被 webview 取代）：入队 pendingCreate，等 renderer
    // 挂载 webview（marker URL）后由 reconcile 登记 runtime，waiter 放行。
    const id = createBrowserPageId()
    const meta = await new Promise<BrowserPageMeta>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registrationWaiters.delete(id)
        this.pendingCreates = this.pendingCreates.filter((p) => p.id !== id)
        // Handshake latency: pendingCreates is NOT part of `state`, so without
        // this the pane would only learn the timeout via its 2.5s poll.
        this.notifyState()
        reject(new BrowserHostUnavailableError())
      }, this.createTimeoutMs)
      timer.unref()
      this.registrationWaiters.set(id, { resolve, timer })
      this.pendingCreates.push({ id, owner, url, createdAt: Date.now() })
      // Handshake latency: push the queue change immediately — the renderer
      // materializes the marker webview on the browser:state event, not on
      // its next poll (this is the 2.5s the blank page used to wait out).
      this.notifyState()
    })
    // 登记完成（waiter resolve 时 runtime 已就位）后再按 url 导航——顺序安全
    const rt = this.requireRuntime(meta.id)
    if (url && url !== 'about:blank') await rt.page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
    return pageMeta(pageById(this.state, meta.id)!)
  }

  /** 主进程 input-event 中继：人在 guest 里的原生输入使旧 snapshot ref 失效。 */
  bumpInteractionByWebContentsId(webContentsId: number): void {
    const rec = this.state.pages.find((p) => p.webContentsId === webContentsId)
    if (rec) {
      this.state = bumpInteraction(this.state, rec.id)
      this.notifyState()
    }
  }

  async closePage(id: string): Promise<void> {
    // webview guest 的 page.close() 挂死（electron-webview-spike 实测，永不返回）——
    // 关闭路径是 renderer 看到注册表移除后卸载 <webview>（guest 随之销毁）；
    // renderer 缺席时由 reconcile 的消失清扫兜底（guest 已死/壳退出场景）。
    // 先从注册表/runtime 摘除：target 从 CDP 摘除有延迟，在途期间 reconcile 会撞见
    // 一个"未登记但带 marker 的存活 target"——closingTargetIds 挡住重登（F4）。
    this.closingTargetIds.add(id)
    this.handlePageClosed(id)
    // state-only 登记（renderer 上报的页）：没有 runtime，handlePageClosed 不动它，这里显式摘除。
    if (pageById(this.state, id)) {
      this.state = removePage(this.state, id)
      this.notifyState()
      this.retire(id)
    }
    // 宽限两个轮询周期后放行该 id；若 renderer 卸载失败 guest 尚存，宽限期后被 reconcile 重登反而是自愈。
    const timer = setTimeout(() => this.closingTargetIds.delete(id), ELECTRON_RECONCILE_INTERVAL_MS * 2)
    timer.unref()
  }

  private handlePageClosed(id: string): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    this.runtime.delete(id)
    this.state = removePage(this.state, id)
    this.notifyState()
    this.retire(id)
  }

  private handlePageCrashed(id: string): void {
    if (!this.runtime.has(id)) return
    this.state = setCrashed(this.state, id)
    this.notifyState()
  }

  private handleProcessExit(): void {
    for (const id of this.runtime.keys()) this.retire(id)
    this.runtime.clear()
    this.state = clearAllPages()
    this.notifyState()
    this.context = null
    // 断开即视为壳退出，下次 ensureStarted 重新 connect（壳可能已重启）。
    this.electronBrowser = null
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  private ensureCdp(rt: PageRuntime): Promise<CdpSessionLike> {
    if (rt.cdp) return Promise.resolve(rt.cdp)
    if (rt.cdpPromise) return rt.cdpPromise
    const promise = (async () => {
      const cdp = await this.context!.newCDPSession(rt.page)
      rt.cdp = cdp
      return cdp
    })()
    rt.cdpPromise = promise
    // 建链失败清掉 memo（仅当没被更新的 memo 顶替），后续调用可重试。
    promise.catch(() => {
      if (rt.cdpPromise === promise) rt.cdpPromise = null
    })
    return promise
  }

  // ---- 页面亮暗自适应 ----

  /**
   * 清除 playwright connectOverCDP 强加在既有 target 上的默认媒体仿真。
   * playwright 接管已有 context 时会把默认 context 仿真（colorScheme 'light' 等）
   * 应用到每个 target——包括壳窗口（实测：连接后壳内 matchMedia
   * prefers-color-scheme 被钉死在 light，"跟随系统"失效；emulateMedia(null)
   * 经同一 session 清除后恢复 OS 跟随）。必须走 playwright 自身 API 而非裸 CDP
   * session——裸会话的覆盖压不过 playwright 已写的会话状态。
   * 按 Page 身份 memoize（attach 时只应用一次；壳重启后的新 page 对象会再清）。
   */
  private resetForeignPageEmulation(page: PageLike): void {
    if (this.mediaResetDone.has(page) || typeof page.emulateMedia !== 'function') return
    this.mediaResetDone.add(page)
    void page.emulateMedia({ colorScheme: null, reducedMotion: null, forcedColors: null }).catch(() => { /* 已关闭/撕毁的 target 无所谓 */ })
  }

  /** 把 app 主题注入单个 guest 的 prefers-color-scheme（matchMedia 与 CSS 媒体查询一并生效）。 */
  private async applyColorSchemeTo(rt: PageRuntime): Promise<void> {
    if (!this.emulatedColorScheme || !this.context) return
    const cdp = await this.ensureCdp(rt)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: this.emulatedColorScheme }],
    })
  }

  /**
   * 全部 guest 跟随 app 主题（渲染端主题变化时经 IPC 通知）。
   * 先记住偏好：CDP 未连接（consent 前等）时无页可应用，后续页面注册时重放。
   */
  async setColorScheme(scheme: 'dark' | 'light'): Promise<void> {
    if (scheme !== 'dark' && scheme !== 'light') return
    this.emulatedColorScheme = scheme
    if (!this.context) return
    await Promise.all([...this.runtime.values()].map((rt) => this.applyColorSchemeTo(rt).catch(() => {})))
  }

  // ---- agent 侧（per-page 串行化 + agentBusy）----
  private withPageLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.requireRuntime(id)
    this.state = setAgentBusy(this.state, id, true)
    this.notifyState()
    const run = rt.actionChain.then(fn, fn)
    rt.actionChain = run.then(() => undefined, () => undefined)
    return run.finally(() => {
      if (this.runtime.has(id)) {
        this.state = setAgentBusy(this.state, id, false)
        this.notifyState()
      }
    })
  }

  private agentActivePageId(owner: string): string | null {
    return activePageForOwner(this.state, owner)?.id ?? null
  }

  private withOwnerLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ownerChains.get(owner) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.ownerChains.set(owner, run.then(() => undefined, () => undefined))
    return run
  }

  private async getOrCreateAgentPage(owner: string): Promise<string> {
    return this.withOwnerLock(owner, async () => {
      const existing = this.agentActivePageId(owner)
      if (existing && this.runtime.has(existing)) return existing
      const meta = await this.createPage(owner)
      return meta.id
    })
  }

  private drainPopups(owner: string): BrowserPageMeta[] {
    const drained: BrowserPageMeta[] = []
    this.popupLog = this.popupLog.filter((entry) => {
      if (entry.owner !== owner) return true
      const rec = pageById(this.state, entry.id)
      if (rec) drained.push(pageMeta(rec))
      return false
    })
    return drained
  }

  /** 单采样窗口内的 DOM mutation 数（页内 MutationObserver）；文档撕毁时 evaluate 抛错。 */
  private countMutations(page: PageLike, windowMs: number): Promise<number> {
    return page.evaluate(
      (ms: number) => new Promise<number>((resolve) => {
        let count = 0;
        const obs = new MutationObserver((list) => { count += list.length; });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        setTimeout(() => { obs.disconnect(); resolve(count); }, ms);
      }),
      windowMs,
    ) as Promise<number>
  }

  /**
   * 动作 → 快照之间的落定等待（消除「返回的快照滞后于动作效果」）：
   * - 预热窗给异步 handler / 导航启动留时间；
   * - URL 变化或 evaluate 失败（文档撕毁）= 导航中 → 等 domcontentloaded；
   * - 其余以 MutationObserver 采样，连续静默视为稳定（SPA 渐进渲染、懒加载）。
   * 页面持续繁忙（动画/轮询）时按预算截断——落定是尽力而为，不是硬同步点。
   */
  private async settleForSnapshot(page: PageLike): Promise<void> {
    const { warmupMs, sampleMs, budgetMs, navLoadStateMs } = this.settleTimings
    if (warmupMs > 0) await new Promise((r) => setTimeout(r, warmupMs))
    const startedUrl = (() => {
      try { return page.url() } catch { return '' }
    })()
    const deadline = Date.now() + budgetMs
    let quiet = 0
    while (Date.now() < deadline) {
      let url = startedUrl
      try { url = page.url() } catch { /* 导航中文档可能不可及 */ }
      if (url !== startedUrl) {
        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return
      }
      let mutations: number
      try {
        mutations = await this.countMutations(page, sampleMs)
      } catch {
        // evaluate 失败：文档正在撕毁（导航进行中）→ 等 loadstate 而非继续采样。
        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return
      }
      if (mutations > 0) { quiet = 0; continue }
      quiet += 1
      if (quiet >= 2) return
    }
  }

  private async finishAgentAction(owner: string, pageId: string): Promise<AgentActionResult> {
    const rt = this.requireRuntime(pageId)
    // 动作效果落定后再快照：异步 DOM 更新/导航未完成时立即快照会返回旧状态。
    await this.settleForSnapshot(rt.page).catch(() => {})
    // 无 viewer 时 CDP nav 事件不会到来，这里把 URL/title 同步进注册表。
    // URL 变化会清空旧 snapshot——随后 recordSnapshot 立即重录，顺序安全。
    const url = (() => {
      try { return rt.page.url() } catch { return '' }
    })()
    const title = await rt.page.title().catch(() => '')
    this.state = updatePageNav(this.state, pageId, url, title)
    this.notifyState()
    const snapshot = await rt.page.ariaSnapshot({ mode: 'ai' })
    this.state = recordSnapshot(this.state, pageId, [...parseSnapshotRefs(snapshot)])
    this.notifyState()
    rt.lastSnapshotText = snapshot
    return { pageId, snapshot, newPages: this.drainPopups(owner), url, title }
  }

  /** ref 解析：形态 → 快照存在 → generation 匹配 → allow-list。任何失败都是明确错误。 */
  private resolveRef(owner: string, ref: string): { pageId: string; locator: LocatorLike } {
    if (!isAiRef(ref)) throw new InvalidRefError(ref)
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    const rec = pageById(this.state, pageId)!
    if (!rec.snapshot) throw new StaleSnapshotError('no snapshot; call browser_snapshot first')
    if (rec.snapshot.interactionGeneration !== rec.interactionGeneration) {
      throw new StaleSnapshotError('页面已由用户操作，请重新 browser_snapshot')
    }
    if (!rec.snapshot.refs.includes(ref)) {
      throw new StaleSnapshotError(`ref ${ref} 已失效，请重新 browser_snapshot`)
    }
    return { pageId, locator: this.requireRuntime(pageId).page.locator(`aria-ref=${ref}`) }
  }

  async agentNavigate(owner: string, url: string, opts?: { newPage?: boolean }): Promise<AgentActionResult> {
    if (!isAllowedNavigationUrl(url)) throw new NavigationBlockedError(url)
    if (opts?.newPage) {
      return this.withOwnerLock(owner, async () => {
        const pageId = (await this.createPage(owner)).id
        return this.withPageLock(pageId, async () => {
          await this.requireRuntime(pageId).page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
          return this.finishAgentAction(owner, pageId)
        })
      })
    }
    const pageId = await this.getOrCreateAgentPage(owner)
    return this.withPageLock(pageId, async () => {
      await this.requireRuntime(pageId).page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
      return this.finishAgentAction(owner, pageId)
    })
  }

  /**
   * 刷新 guest。禁止 page.reload()：Electron webview 上 CDP Page.reload 会销毁 guest
   *（Playwright Page 从 context.pages() 消失 → reconcile 记 page is gone），
   * 更糟时命令打到壳窗口，整个 renderer 刷新，看起来像应用重启。
   * 已证实可用的路径是 page.goto（与 browser_navigate 相同）。
   */
  private async reloadGuest(page: PageLike): Promise<void> {
    const url = page.url()
    if (url && isAllowedNavigationUrl(url) && !parseMarkerUrl(url)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => {})
      return
    }
    await page.evaluate(() => { location.reload(); }).catch(() => {})
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  }

  /** 历史导航：无历史/超时等失败不致命——仍返回当前页面快照。 */
  async agentHistory(owner: string, action: 'back' | 'forward' | 'reload'): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      if (action === 'back') await page.goBack({ timeout: AGENT_ACTION_TIMEOUT_MS }).catch(() => {})
      else if (action === 'forward') await page.goForward({ timeout: AGENT_ACTION_TIMEOUT_MS }).catch(() => {})
      else await this.reloadGuest(page)
      return this.finishAgentAction(owner, pageId)
    })
  }

  agentPages(owner: string) {
    const pages = pagesForOwner(this.state, owner).map(pageMeta)
    return { pages, activePageId: this.agentActivePageId(owner) }
  }

  async agentFocus(owner: string, pageId: string): Promise<AgentActionResult> {
    const rec = pageById(this.state, pageId)
    if (!rec || rec.owner !== owner) throw new PageNotFoundError(pageId)
    this.state = setActivePage(this.state, owner, pageId)
    this.notifyState()
    return this.withPageLock(pageId, () => this.finishAgentAction(owner, pageId))
  }

  async agentSnapshot(owner: string, opts?: { selector?: string; diff?: boolean }): Promise<AgentActionResult> {
    // 与 click/history 等一致：无活动页时报错引导 navigate——而不是静默建一个空白页
    //（旧实现走 getOrCreateAgentPage，会在 pages 里凭空多出 about:blank marker 页）。
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      // selector 作用域：对子树做 AI 快照（locator.ariaSnapshot 会刷新该 frame 的
      // aria-ref 查询缓存，子树内的 ref 之后仍可 click/type——与整页快照同一机制）。
      if (opts?.selector) {
        const rt = this.requireRuntime(pageId)
        const url = rt.page.url()
        const title = await rt.page.title().catch(() => '')
        this.state = updatePageNav(this.state, pageId, url, title)
        this.notifyState()
        let snapshot: string
        try {
          snapshot = await rt.page.locator(opts.selector).ariaSnapshot({ mode: 'ai' })
        } catch (error) {
          throw new SnapshotScopeError(`selector 快照失败（无匹配/多匹配/语法错误）: ${opts.selector} — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
        this.state = recordSnapshot(this.state, pageId, [...parseSnapshotRefs(snapshot)])
        this.notifyState()
        rt.lastSnapshotText = snapshot
        return { pageId, snapshot, newPages: this.drainPopups(owner), url, title }
      }
      // diff 形态：以上一次快照全文为基线，只返回行级差异（基线缺失时返回全量）。
      const prev = opts?.diff ? this.requireRuntime(pageId).lastSnapshotText : null
      const result = await this.finishAgentAction(owner, pageId)
      if (opts?.diff && prev !== null) {
        return { ...result, snapshot: `相对上一次快照的差异（- 消失 / + 新增）：\n${diffSnapshotLines(prev, result.snapshot)}` }
      }
      return result
    })
  }

  async agentClickRef(owner: string, ref: string): Promise<AgentActionResult> {
    const { pageId, locator } = this.resolveRef(owner, ref)
    return this.withPageLock(pageId, async () => {
      await locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      return this.finishAgentAction(owner, pageId)
    })
  }

  async agentTypeRef(owner: string, ref: string, text: string, submit = false): Promise<AgentActionResult> {
    const { pageId, locator } = this.resolveRef(owner, ref)
    return this.withPageLock(pageId, async () => {
      // locator.fill 的 Input.insertText 在非可见 webview guest 上静默无效
      //（electron-webview-spike 实测）——清空/输入统一走键盘事件链（全宿主形态可用）。
      const page = this.requireRuntime(pageId).page
      await locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true }) // 聚焦（真实事件链）
      await page.keyboard.press('ControlOrMeta+A') // 全选=清空语义（pressSequentially 只追加）
      if (text) await locator.pressSequentially(text, { timeout: AGENT_ACTION_TIMEOUT_MS })
      if (submit) await page.keyboard.press('Enter')
      return this.finishAgentAction(owner, pageId)
    })
  }

  async agentHoverRef(owner: string, ref: string): Promise<AgentActionResult> {
    const { pageId, locator } = this.resolveRef(owner, ref)
    return this.withPageLock(pageId, async () => {
      await locator.hover({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      return this.finishAgentAction(owner, pageId)
    })
  }

  async agentSelectRef(owner: string, ref: string, values: string[]): Promise<AgentActionResult> {
    const { pageId, locator } = this.resolveRef(owner, ref)
    return this.withPageLock(pageId, async () => {
      await locator.selectOption(values, { timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      return this.finishAgentAction(owner, pageId)
    })
  }

  async agentPressKey(owner: string, key: string): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      await this.requireRuntime(pageId).page.keyboard.press(key)
      return this.finishAgentAction(owner, pageId)
    })
  }

  /**
   * 滚动：deltaX/deltaY 走鼠标滚轮（可双轴）；ref 形态把该元素滚动到可见区域。
   * 两种形态互斥，ref 优先（extension 层保证至少给一种）。
   */
  async agentScroll(owner: string, opts: { deltaX?: number; deltaY?: number; ref?: string }): Promise<AgentActionResult> {
    if (opts.ref !== undefined) {
      const { pageId, locator } = this.resolveRef(owner, opts.ref)
      return this.withPageLock(pageId, async () => {
        await locator.scrollIntoViewIfNeeded({ timeout: AGENT_ACTION_TIMEOUT_MS })
        return this.finishAgentAction(owner, pageId)
      })
    }
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const cdp = await this.ensureCdp(rt)
      const before = (await rt.page.evaluate(() => [window.scrollX, window.scrollY])) as [number, number]
      const [vw, vh] = (await rt.page.evaluate(() => [window.innerWidth, window.innerHeight])) as [number, number]
      // 真实 wheel 事件（部分站点按 wheel 门控懒加载）；锚定真实视口中心。
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(vw / 2), y: Math.round(vh / 2),
        deltaX: opts.deltaX ?? 0, deltaY: opts.deltaY ?? 0,
      })
      await rt.page.waitForTimeout(150) // 等滚动落地再校验
      const after = (await rt.page.evaluate(() => [window.scrollX, window.scrollY])) as [number, number]
      if (after[0] === before[0] && after[1] === before[1]) {
        // 合成 wheel 在 webview guest 上非确定性地被吞（probe 实测；隐藏 BrowserWindow
        // 无此问题）——scrollBy 兜底保证进度（scroll 事件照发，懒加载不受影响）。
        await rt.page.evaluate(([dx, dy]: [number, number]) => window.scrollBy(dx, dy), [opts.deltaX ?? 0, opts.deltaY ?? 0])
      }
      return this.finishAgentAction(owner, pageId)
    })
  }

  async agentWaitFor(
    owner: string,
    opts: { text?: string; textGone?: string; time?: number; selector?: string; load?: string; timeout?: number },
  ): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      const unmet: string[] = []
      // 条件等待上限：显式 timeout（秒）优先，缺省 5s；钻在 [0.5, 30] 内。
      const condTimeoutMs = Math.min(Math.max((opts.timeout ?? 5) * 1000, 500), 30_000)
      if (typeof opts.time === 'number') await page.waitForTimeout(Math.min(opts.time, 30) * 1000)
      // 超时不是错误：未满足的条件显式上报（unmet），由工具层呈现给模型。
      if (opts.text) {
        await page.getByText(opts.text).first().waitFor({ state: 'visible', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`text 未出现: ${opts.text}`) })
      }
      if (opts.textGone) {
        await page.getByText(opts.textGone).first().waitFor({ state: 'hidden', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`text 仍在页面: ${opts.textGone}`) })
      }
      if (opts.selector) {
        await page.locator(opts.selector).first().waitFor({ state: 'visible', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`selector 不可见: ${opts.selector}`) })
      }
      if (opts.load === 'load' || opts.load === 'domcontentloaded' || opts.load === 'networkidle') {
        await page.waitForLoadState(opts.load, { timeout: 10_000 })
          .then(() => undefined, () => { unmet.push(`load 状态未到达: ${opts.load}`) })
      }
      const result = await this.finishAgentAction(owner, pageId)
      return { ...result, unmet }
    })
  }

  /**
   * 截图。annotate 时先拍原图，再在页内离屏 canvas 上合成 ref 标签（canvas 不进 DOM：
   * 人类不可见、无闪烁、无残留），标签文本即 ref——多模态模型可凭图选 ref 再 click/type。
   * 合成失败静默回退原图；首次捕获失败重试一次（大视口/瞬时争用偶发超时）。
   */
  async agentScreenshot(owner: string, opts?: { annotate?: boolean }): Promise<{ pageId: string; jpegBase64: string; newPages: BrowserPageMeta[]; labels: number; annotated: boolean }> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      // timeout：display:none/垂死 guest 的 captureScreenshot 永不返回（spike 实测）——
      // 不能让一次截图把 withPageLock 永久挂住。
      const shoot = (timeout: number) => page.screenshot({ type: 'jpeg', quality: 60, timeout })
      let jpeg: Uint8Array
      try {
        jpeg = await shoot(5_000)
      } catch {
        jpeg = await shoot(8_000)
      }
      const base64 = Buffer.from(jpeg).toString('base64')
      const fallback = () => ({ pageId, jpegBase64: base64, newPages: this.drainPopups(owner), labels: 0, annotated: false })
      if (!opts?.annotate) return fallback()
      const rec = pageById(this.state, pageId)
      const refs = (rec?.snapshot?.refs ?? []).slice(0, 50) // 标签过密会失去可读性
      const items: Array<{ ref: string; x: number; y: number; width: number; height: number }> = []
      for (const ref of refs) {
        const box = await page.locator(`aria-ref=${ref}`).boundingBox().catch(() => null)
        if (box && box.width > 0 && box.height > 0) items.push({ ref, ...box })
      }
      if (items.length === 0) return fallback()
      // 离屏 canvas 合成：boundingBox 是视口 CSS 坐标，按 naturalWidth/innerWidth 缩放对齐 DPR/缩放。
      const annotatedB64 = await page.evaluate((payload: { b64: string; items: Array<{ ref: string; x: number; y: number; width: number; height: number }> }) => {
        return new Promise<string | null>((resolve) => {
          const img = new Image();
          img.onload = () => {
            try {
              const scale = img.naturalWidth / window.innerWidth;
              const c = document.createElement("canvas");
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              const ctx = c.getContext("2d");
              if (!ctx) return resolve(null);
              ctx.drawImage(img, 0, 0);
              const fs = Math.max(12, Math.round(12 * scale));
              ctx.font = `${fs}px monospace`;
              for (const it of payload.items) {
                const x = it.x * scale, y = it.y * scale, w = it.width * scale, h = it.height * scale;
                ctx.strokeStyle = "#e53935"; // ui-color-guard: allow data-palette: browser screenshot annotations
                ctx.lineWidth = Math.max(2, 2 * scale);
                ctx.strokeRect(x, y, w, h);
                const tw = ctx.measureText(it.ref).width + 8;
                const ty = y - fs - 6 >= 0 ? y - fs - 6 : y + 2;
                ctx.fillStyle = "#e53935"; // ui-color-guard: allow data-palette: browser screenshot annotations
                ctx.fillRect(x - 1, ty, tw, fs + 6);
                ctx.fillStyle = "#fff"; // ui-color-guard: allow data-palette: browser screenshot annotations
                ctx.textBaseline = "top";
                ctx.fillText(it.ref, x + 3, ty + 3);
              }
              resolve(c.toDataURL("image/jpeg", 0.6).split(",")[1] ?? null);
            } catch {
              resolve(null);
            }
          };
          img.onerror = () => resolve(null);
          img.src = "data:image/jpeg;base64," + payload.b64;
        });
      }, { b64: base64, items }).catch(() => null) as string | null
      if (!annotatedB64) return fallback()
      return { pageId, jpegBase64: annotatedB64, newPages: this.drainPopups(owner), labels: items.length, annotated: true }
    })
  }

  /**
   * 坐标点选元素解析（人类批注用）：x/y 是视口 CSS 坐标（webview guest 视口 == 宿主元素尺寸）。
   * DOM.getNodeForLocation 在跨进程导航后的 guest 上不可靠（"No node found"，probe 实测）——
   * 改用页面内 elementFromPoint + getBoundingClientRect/cssPath，全宿主形态可用。
   */
  async resolveElementAt(id: string, x: number, y: number): Promise<ElementAtInfo | null> {
    const rt = this.requireRuntime(id)
    return await rt.page.evaluate(([px, py]: [number, number]) => {
      const el = document.elementFromPoint(px, py);
      if (!el || el.nodeType !== 1) return null;
      const rect = el.getBoundingClientRect();
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift(part + "#" + CSS.escape(cur.id)); break; }
        const cls = Array.from(cur.classList).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
        const parent = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
        }
        parts.unshift(part + cls);
        cur = cur.parentElement;
      }
      const raw = (el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("href") || "";
      return {
        tag: el.tagName.toLowerCase(),
        text: String(raw).trim().slice(0, 120),
        path: parts.join(" > "),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }, [Math.round(x), Math.round(y)]) as ElementAtInfo | null
  }

  async agentClose(owner: string): Promise<void> {
    const pageId = this.agentActivePageId(owner)
    if (pageId) await this.closePage(pageId)
  }

  async closePagesForOwner(owner: string): Promise<void> {
    for (const rec of pagesForOwner(this.state, owner)) await this.closePage(rec.id)
  }

  dispose(): void {
    this.handleProcessExit()
    this.clearStateNotify()
    // 刻意不调 electronBrowser.close()：Playwright 经 connectOverCDP 拿到的
    // Browser.close() 会发 CDP Browser.close，可能直接退出 Electron 壳。
    // 生命周期由 ipc.ts / shutdown.ts 拥有——dispose 只丢引用，CDP websocket 随进程退出关闭。
  }
}

// ---- 模块级单例（生命周期由 ipc.ts / shutdown.ts 拥有；测试可注入替换）----
let instance: BrowserService | null = null

/** 幂等初始化：已初始化则返回现有实例（deps 仅首次生效）。 */
export function initBrowserService(deps: BrowserServiceDeps): BrowserService {
  if (!instance) instance = new BrowserService(deps)
  return instance
}

export function getBrowserService(): BrowserService | null {
  return instance
}

export function __setBrowserServiceForTests(service: BrowserService | null): void {
  instance = service
}
