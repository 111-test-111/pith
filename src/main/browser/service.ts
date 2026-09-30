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
  createBrowserPageId, isAllowedNavigationUrl, isSameDocumentUrl, parseMarkerUrl, HUMAN_OWNER,
  type BrowserPageMeta, type BrowserSeenPayload, type ElementAtInfo,
} from '../../shared/browser.ts'
import { diffSnapshotLines, emptySnapshotNote, focusChangedNote, ingestSnapshot, isAiRef, noDomChangeNote, pageIssuesNote, parseSnapshotRefs, scrollPositionNote, snapshotBeyondCapNote, snapshotOffsetPastEndNote, snapshotTruncationNote, TYPE_TEXT_MAX_CHARS, uploadNote, type EmptySnapshotDiagnostics, type IngestedSnapshot, type PageIssueLike, type ScrollPosition } from './tools-core.ts'
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
  documentElement: DomElementLike & { scrollWidth: number; scrollHeight: number }
  /** 页面标题（readTitle 用；与 page.title() 同源，但走预算求值）。 */
  title: string
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
  /** 空快照诊断用：body 子树规模 + 文档就绪态。 */
  body: DomElementLike | null
  readyState: string
  /** 按键后的焦点回报（只取 tagName，不取页面自写文本）。 */
  activeElement: DomElementLike | null
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
export class RefNotInSnapshotError extends StaleSnapshotError {
  constructor(ref: string) { super(`ref ${ref} is not in the current snapshot; it may be stale or mistyped. Read browser_snapshot and use one of its refs`); this.name = 'RefNotInSnapshotError' }
}
export class InvalidRefError extends Error { constructor(ref: unknown) { super(`invalid ref: ${String(ref)}`); this.name = 'InvalidRefError' } }
export class NavigationBlockedError extends Error { constructor(url: string) { super(`navigation blocked: ${url}`); this.name = 'NavigationBlockedError' } }
/** browser_snapshot 的 selector 无匹配/多匹配/语法错误。 */
export class SnapshotScopeError extends Error { constructor(msg: string) { super(msg); this.name = 'SnapshotScopeError' } }
/**
 * browser_click 点到了会打开文件选择器的元素（file input，或触发它的按钮/label）。
 * 点击无法选择文件：旧行为是原生面板挂在 guest 上、这一轮点击 8s 超时。
 */
export class FilePickerInsteadOfClickError extends Error {
  /** 给人看的目标标签（`ref e5` / `selector button.upload`）。 */
  readonly target: string
  constructor(target: string) {
    super(`${target} opens a file picker and a click cannot choose files`)
    this.name = 'FilePickerInsteadOfClickError'
    this.target = target
  }
}

/** browser_upload 的目标既不是 file input，点它也没有打开文件选择器。 */
export class NoFilePickerError extends Error {
  readonly target: string
  constructor(target: string, reason: string) {
    super(`${target} is not a file input and clicking it did not open a file picker${reason ? ` (${reason})` : ''}`)
    this.name = 'NoFilePickerError'
    this.target = target
  }
}

/** browser_type 的文本超过键盘重放预算（铁律 4 禁用 fill，长文本只能一键一键打）。 */
export class TypeTextTooLongError extends Error {
  readonly length: number
  constructor(length: number) {
    super(`${length} characters is over the keyboard-replay limit`)
    this.name = 'TypeTextTooLongError'
    this.length = length
  }
}

/**
 * 带预算的页面求值结果。**超时与「页面里报错 / 文档撕毁」必须可区分**：settle 正是靠
 * 后者判「导航中」，把两者合成一个 null 会让导航检测失效（旧实现只有裸 page.evaluate，
 * 代价是：求值没有超时参数，页面卡住就把 withPageLock 永远占住）。
 */
type BoundedEvaluation<T> = { status: 'ok'; value: T } | { status: 'timeout' } | { status: 'error' }

/**
 * 动作目标。三种形态，互斥（工具层强制）：
 *
 * - `ref`：来自最近一次快照（带 generation / allow-list 校验）；
 * - `selector`：Playwright 选择器，**跨 frame 查找**——iframe 内的控件、微前端、隐藏的
 *   file input 这类拿不到 ref 的元素；
 * - `ax`：可访问角色 + 名字，走**原生 Accessibility 域**。选择器进不去的地方只有它到得了：
 *   闭合阴影根（实测小红书创作平台的 `<XHS-PUBLISH-BTN>` 把「暂存离开/发布」放在 closed
 *   shadow root 里，Playwright 连 locator 带 aria 快照都看不见，而 CDP 的 pierced DOM 与
 *   原生 AX 树都看得见），以及只暴露在 a11y 树里的自绘控件。
 */
export type AxTarget = { name: string; role?: string }
export type TargetSpec =
  | { kind: 'ref'; ref: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'ax'; ax: AxTarget }

/** selector 形态的目标解析失败：没匹配、多个 frame 命中、或单个 frame 内不唯一。 */
export class SelectorTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorTargetError'
  }
}

/**
 * `ax` 形态的目标解析失败：没有那个「角色 + 名字」、匹配到多个、节点没有布局盒，
 * 或者盒内每个候选点命中的都是别的元素（被浮层盖住）。
 * **盖住时必须报错，不能点下去**：真实页面上邻居常常是不可撤销的动作——实测小红书
 * 「暂存离开」与「发布」两个按钮中心只差 144px。
 */
export class AxTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AxTargetError'
  }
}

/** 目标的给人看的标签（错误文本里用；三种形态共用一套文案）。 */
function targetLabel(target: TargetSpec): string {
  if (target.kind === 'ref') return `ref ${target.ref}`
  if (target.kind === 'selector') return `selector ${target.selector}`
  const role = target.ax.role ? `role ${target.ax.role}, ` : ''
  return `accessible ${role}name "${target.ax.name}"`
}

/** 选择器形态最多扫多少个 frame（广告页可以塞几十个 iframe；扫到上限就在错误里说明）。 */
const MAX_TARGET_FRAMES = 20

/**
 * `ax` 形态的候选点（盒内相对坐标）：中心优先，再看四分之一与边中点。
 * 不能只试中心——真实浮层常常只盖住一部分（实测小红书底部栏那两个点的最顶层元素
 * 是 `d-new-menu` 菜单容器）。
 */
const AX_POINT_GRID: Array<[number, number]> = [
  [0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75],
  [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
]
/** 不给 role 时优先取这些角色：同一个标签在 AX 树里还有 StaticText 文本节点，
 *  不先收窄就会把「一个按钮」变成「多个同名元素」。 */
const AX_ACTIONABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton',
  'listbox', 'treeitem', 'gridcell',
])
/** 同名候选最多试几个布局盒（AX 树里的同名元素可以很多，探测是有预算的往返）。 */
const AX_MAX_CANDIDATES = 8
/** 命中校验时最多往上找几层祖先（点到按钮内部的文字节点同样算命中）。 */
const AX_ANCESTOR_HOPS = 6

/** ax 形态读到的结构（CDP 应答里我们只声明用到的那几个字段）。 */
interface BoxLike { x: number; y: number; width: number; height: number }
interface PointLike { x: number; y: number }
interface CdpAxNode {
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  backendDOMNodeId?: number
}
interface CdpBoxModel { model?: { border?: number[] } }
interface CdpNodeLocation { backendNodeId?: number; nodeId?: number }
interface CdpNodeInfo { node?: { nodeName?: string; parentId?: number; backendNodeId?: number; attributes?: string[] } }

/** frame 的可读定位（诊断文本用；只取 url，不含页面自写文本）。 */
function frameWhere(frame: FrameLike, index: number): string {
  const url = (() => {
    try { return frame.url() } catch { return '' }
  })()
  const short = url.length > 140 ? `${url.slice(0, 140)}…` : url
  return index === 0 ? `main frame (${short})` : `frame #${index} (${short})`
}

/** settleForSnapshot 的观察结果：动作到底有没有改变 DOM。 */
interface SettleOutcome {
  /** 采样到的 mutation 总数；null = 一次都没采完（预算为 0 或未采即超时）。
   *  「没测过」与「测了是 0」必须分开：混为一谈会把零预算路径误报成「页面没变」。 */
  mutations: number | null
  /** 判定为导航中（此时 mutations 无意义）。 */
  navigating: boolean
}

/** agent 建页握手超时：没有 renderer（浏览器标签页）在物化 pendingCreate。 */
export class BrowserHostUnavailableError extends Error {
  /**
   * 是否值得重试。握手超时值得我们自己再来一次（renderer 晚挂载/竞态）；宿主已断线、
   * dispose 之后则不值得——重试只会让调用方多等一个完整的建页超时。
   */
  readonly retryable: boolean
  constructor(retryable = true) {
    super('no renderer available to host the browser page (browser tab not open)')
    this.name = 'BrowserHostUnavailableError'
    this.retryable = retryable
  }
}

/** 错误首行：Playwright 的多行报错里只有首行对调用者有意义。 */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0]
}

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

/**
 * 快照交付窗口。`maxChars` 与 `offset` 必须成对传递（两个相邻的数字位置参数太容易写反），
 * 工具层直接透传。
 */
export interface SnapshotWindowOpts {
  maxChars?: number
  offset?: number
}

/**
 * 目标动作（click/type/hover/select/upload）的窗口参数：与快照窗口相同，外加 app 自产说明
 *（选择器形态命中在哪个 frame）。说明与截断说明同属边界之外。
 */
type TargetWindowOpts = SnapshotWindowOpts & { notes?: Array<string | null | undefined> }

export interface AgentActionResult {
  pageId: string
  /** 交付模型的页面文本（已按上限裁剪；不含截断说明行与页头）。
   *  `browser_snapshot diff` 的基线就是它——必须与模型所见同源。 */
  snapshot: string
  /** 动作后新开的**真弹窗窗口**的 URL（窗口不属面板注册表——模型不可驱使，只能告知）。 */
  windowPopups: string[]
  /** 动作后的页面导航信息（展示用）。 */
  url?: string
  title?: string
  /** wait_for 显式上报的未满足条件（超时）；空/缺省 = 全部满足。 */
  unmet?: string[]
  /** app 自产说明（截断/窗口外改动），工具层放在不可信边界之外。 */
  snapshotNote?: string
  window?: { offset: number; nextOffset: number | null; totalChars: number; cap: number; truncated: boolean; eof: boolean; diff: boolean }
}

const MAX_RETIRED_IDS = 100
const ELECTRON_RECONCILE_INTERVAL_MS = 1_000
/** 建页握手超时：renderer 轮询 + webview 挂载 + reconcile（1s）需数秒，放宽到 15s。 */
const ELECTRON_CREATE_TIMEOUT_MS = 15_000
/**
 * 建页握手的尝试次数。冷启动的第一次握手会输掉竞态（renderer 尚未挂载宿主 /
 * marker target 尚未对 CDP 可见），而工具文案已经在叫模型重试——这件事必须由服务
 * 自己做完：否则每个会话的第一个浏览器动作都要先失败一次（实测首个 browser_navigate
 * 必失败，重试即成功）。
 */
const ELECTRON_CREATE_ATTEMPTS = 2
/** 握手在途时重推 browser:state 的间隔：renderer 漏掉首次推送时自愈。 */
const ELECTRON_CREATE_REDRIVE_MS = 1_000
/** pendingCreate 在 status 里的展示 TTL（waiter 超时后残留的条目清扫用）。 */
const PENDING_CREATE_TTL_MS = 30_000
/** 每页保留的页面自报问题条数上限（内存有界）。 */
const MAX_PAGE_ISSUES = 8
/** 单条 issue 进快照说明前的截断长度。 */
const PAGE_ISSUE_TEXT_MAX = 200
// ---- playwright 结构接口（真实对象天然满足；测试注入 mock）----
/** agent 交互超时：Playwright 默认 30s actionability 重试会把一轮卡死（被遮挡元素尤甚）。 */
const AGENT_ACTION_TIMEOUT_MS = 8_000
/** agent 导航超时：慢站点 domcontentloaded 可超 8s，但绝不容 Playwright 默认 30s 挂死。 */
const AGENT_NAV_TIMEOUT_MS = 20_000
/**
 * aria snapshot 超时：导航类预算。
 * locator/page.ariaSnapshot 同样吃 Playwright 的默认 30s（`DEFAULT_PLAYWRIGHT_TIMEOUT`），
 * 而它们跑在 withPageLock 里——一个卡住的快照会把页面锁死 30s。大页面合法耗时也在秒级，
 * 所以用导航类预算而不是交互类 8s（宁可慢一点，也不误杀一个正在渲染的大页面）。
 */
const AGENT_SNAPSHOT_TIMEOUT_MS = 20_000
/**
 * browser_click 的文件选择器防护窗。订阅 filechooser 期间 playwright 会打开 CDP 的
 * 选择器拦截，原生面板不会弹出；留一段窗口是因为选择器事件可能在点击派发**之后**才到。
 * 窗口结束后拦截随之关闭，人在 guest 上的正常上传不受影响（窗口只有 1.5s）。
 */
const CLICK_PICKER_GUARD_MS = 1_500
/**
 * 页内量测预算（纯读 window/document 的求值：滚动位置、视口、焦点标签、空树诊断、
 * 人工批注的坐标解析）。这些值的语义就是「量得到就报，量不到就不出声」，所以不能揄用
 * 动作的 8s：一个卡住的页面会让一串量测把 withPageLock 占上几十秒。1s 答不上来即卡住。
 */
const MEASURE_TIMEOUT_MS = 1_000
/** 注册表变更通知的合并窗：state 高频赋值（agent 动作/reconcile 轮询）只触发一次回调。 */
const STATE_NOTIFY_COALESCE_MS = 30

export interface LocatorLike {
  click(options?: { timeout?: number; force?: boolean }): Promise<void>
  /**
   * 上传：把本地路径挂到 file input 上（真实实现 = DOM.setFileInputFiles）。
   * label / 包装元素会被 playwright 自己 retarget 到其控件；不要求元素可见——
   * 真实站点最常见的形态正是把 input 藏起来、只暴露一个样式化按钮。
   */
  setInputFiles(files: string[], options?: { timeout?: number }): Promise<void>
  /** 逐键输入（键盘事件链）；fill 的 Input.insertText 在非可见 webview guest 上静默无效，禁用。 */
  pressSequentially(text: string, options?: { timeout?: number }): Promise<void>
  press(key: string): Promise<void>
  hover(options?: { timeout?: number; force?: boolean }): Promise<void>
  selectOption(values: string[], options?: { timeout?: number; force?: boolean }): Promise<unknown>
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>
  /**
   * 元素形状探测（真实 locator.evaluate）。timeout 只管可判定性阶段，协议调用仍可能被卡住的
   * 页面拖住，所以调用方要在外面再夹一层预算（见 withBudget）。
   */
  evaluate(fn: unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>
  ariaSnapshot(options?: { mode?: 'ai' | 'default'; timeout?: number }): Promise<string>
  /** timeout 必须显式给：不给就是 Playwright 的默认 30s，而调用点在 withPageLock 内。 */
  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>
  first(): LocatorLike
  /** selector 作用域的可判定性（strict 单匹配失败后才有用；见 resolveScopedLocator）。 */
  count(): Promise<number>
  filter(options: { visible?: boolean }): LocatorLike
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>
}
/** playwright FileChooser 的结构子集（上传的通用路径用）。 */
export interface FileChooserLike {
  setFiles(files: string[], options?: { timeout?: number }): Promise<void>
}
/**
 * playwright Frame 的结构子集（仅用于选择器形态的目标解析）。
 */
export interface FrameLike {
  /** frame 的 URL（诊断与「落在哪个 frame」说明用）。 */
  url(): string
  locator(selector: string): LocatorLike
}
/** playwright ConsoleMessage 的结构子集（只用到类型与文本）。 */
export interface ConsoleMessageLike {
  type(): string
  text(): string
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
  /** 页面自报错误：脚本挂掉时 a11y 树可能整个是空的，这是模型唯一的线索。 */
  on(event: 'pageerror', cb: (error: unknown) => void): void
  on(event: 'console', cb: (message: ConsoleMessageLike) => void): void
  /**
   * 事件等待（真实 page.waitForEvent）。上传依赖 'filechooser'：
   * **订阅本身就是机制**——playwright 只在有 filechooser 监听时才发
   * `Page.setInterceptFileChooserDialog{enabled:true}`，所以面板被拦下、事件交给我们。
   */
  waitForEvent(event: 'filechooser', options?: { timeout?: number }): Promise<FileChooserLike>
  ariaSnapshot(options?: { mode?: 'ai' | 'default'; timeout?: number }): Promise<string>
  /**
   * 全部 frame（主 frame 在前，含嵌套子 frame；真实对象即 `page.frames()`）。
   * **选择器形态的目标解析靠它逐帧查找**：`page.locator()` 只在主 frame 里找，而微前端/
   * 第三方编辑器（实测小红书创作平台的编辑器）把控件放在子 frame 里——实测那个页面的
   * 底部「存草稿/发布」栏既不在 a11y 快照里，也用选择器在主 frame 匹配不到。
   */
  frames(): FrameLike[]
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

/** 页面自报问题 + 单调序号（只回报上次快照之后的新增量）。 */
interface PageIssueWithSeq extends PageIssueLike {
  seq: number
}

interface PageRuntime {
  page: PageLike
  cdp: CdpSessionLike | null
  /** 建链中的 CDP 会话（memoize 防并发双建）；拒绝后清空以允许重试。 */
  cdpPromise: Promise<CdpSessionLike> | null
  actionChain: Promise<void>
  /** 最近一次交付给模型的快照文本（`browser_snapshot diff` 的基线）。 */
  lastSnapshotText: string | null
  /** 页面自报的异常/console.error（有界环形）。 */
  pageIssues: PageIssueWithSeq[]
  /** 已回报进快照的最大 issue 序号——只报增量。 */
  reportedIssueSeq: number
  /** 上次观察到的焦点标签名：按键回报只在真正变化时出声。 */
  lastFocusTag: string | null
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
  /**
   * 键盘输入前把焦点交给 guest（渲染层把 `<webview>` 元素 focus，main 等 ack）。
   *
   * 必须由渲染层做，且必须在按键派发前完成：Chromium 把派给 guest 的按键先交给窗口当前
   * 聚焦的 widget——壳窗口持焦点时它会同时出现在壳窗口 DOM，于是应用自己的快捷键（`Escape`
   * = 停本轮）被 agent 的按键触发。实测：`webviewElement.focus()` 之后同样的按键壳窗口一个
   * 也收不到；而 main 侧 `webContents.focus()`、playwright 的 `Page.bringToFront` 都**不动壳
   * 窗口的 DOM 焦点**，按键照漏。认不出 webContentsId 时幂等无焦点可给。
   */
  focusGuest?: (webContentsId: number) => void | Promise<void>
  /** 壳窗口自身文档的 URL（dev: ELECTRON_RENDERER_URL；打包: file:// 的渲染入口），
   *  由 ipc.ts 与 index.ts 的 loadURL/loadFile 同一表达式传入。reconcile/skipForeignTarget
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
  /**
   * agent 页弹出的真弹窗窗口 URL（owner → 待告知）。
   * 弹窗是独立 BrowserWindow，不进面板注册表，browser_* 工具到不了它；但发起动作的模型
   * 必须知道屏幕上多了一个窗口（否则它会以为点击什么都没发生而反复重试）。每次快照类
   * 动作取走一次，交付时明确说明它不可驱使。
   */
  private windowPopups = new Map<string, string[]>()
  private readonly deps: BrowserServiceDeps
  private readonly connectElectronFn: ConnectElectronFn
  private readonly createTimeoutMs: number
  /** connectOverCDP 拿到的 Electron 浏览器（断开即清空）。 */
  private electronBrowser: ElectronBrowserLike | null = null
  /** target 发现轮询（仅连接存活期间）。 */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  /** agent 建页握手：等待 renderer 物化的 pendingCreate 队列（getStatus 暴露给渲染端）。 */
  private pendingCreates: Array<{ id: string; owner: string; url?: string; createdAt: number }> = []
  /** 等待某 id 完成 runtime 登记的 waiter（createPage 挂起处；登记即放行）。
   *  reject 与 timer 一并持有：断线/退出时必须立即失败，不能让每个 createPage
   *  干等满建页超时（重连后新 context 不可能兑现旧 waiter）。 */
  private readonly registrationWaiters = new Map<string, { resolve: (meta: BrowserPageMeta) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
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
  /** 页面自报问题的单调序号（跨页共享；只用于「上次快照之后的新增量」判定）。 */
  private pageIssueSeq = 0
  /** dispose() 之后不再连 CDP、不再登记页：退出后迟到的 `browser:*` 调用
   *  （或仍在跑的工具）不得把 CDP 连接重新拉起来。 */
  private disposed = false

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
    // After dispose() no new CDP connection may be opened: the app is quitting
    // (or has quit), and a late browser:* call must not restart work.
    if (this.disposed) return Promise.reject(new BrowserHostUnavailableError(false))
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
      // 只是把新 target 当外部窗口清一遍默认仿真；登不登记由 marker/seen 决定。
      // 同步且不抛（旧实现是 async + 被丢弃的 promise）。
      try { this.skipForeignTarget(page) } catch { /* target 在事件与处理之间已死 */ }
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

  /** pi-app 壳自身窗口的 URL（壳窗口永不进注册表；reconcile 与页事件路径共用）。
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
      if (this.isShellWindowUrl(url)) { this.resetForeignPageEmulation(page); continue } // 壳窗口永不登记
      const marker = parseMarkerUrl(url)
      // 无 marker = 真弹窗窗口（wiring 的 allow 路径）或其他外部 target：永远不是面板页。
      // 面板行只由 marker 握手（renderer 物化）与 renderer 的 seen 上报而来。
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
      void this.readTitle(rt.page).then((title) => {
        // 量不到就跳过这轮：不能把「页面没应答」当成「标题是空字符串」写进注册表。
        if (title === null) return
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
      pageIssues: [],
      reportedIssueSeq: 0,
      lastFocusTag: null,
    })
    page.on('close', () => this.handlePageClosed(id))
    page.on('crash', () => this.handlePageCrashed(id))
    // 页面自报错误：a11y 树为空时，「页面确实没有内容」与「把页面建出来的脚本挂了」
    // 对模型必须可分辨——旧实现只给一个空块，只能猜（实测：body 里只有 fetch() 的页）。
    page.on('pageerror', (error) => {
      this.recordPageIssue(id, 'error', error instanceof Error ? error.message : String(error))
    })
    page.on('console', (message) => {
      try {
        if (message?.type?.() === 'error') this.recordPageIssue(id, 'console', String(message.text?.() ?? ''))
      } catch { /* 已销毁的 page：忽略 */ }
    })
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

  /**
   * 新浮现的 target 一律当**外部窗口**处理：真弹窗窗口（wiring 的 allow 路径）、壳窗口与
   * 未命名 target 都不是面板页。面板行只由 marker 握手（renderer 物化）与 renderer 的
   * `browser:seen` 上报登记——page 事件里绝不登记任何东西（旧实现按 opener 猜 owner 把
   * 弹窗登记成面板页，于是在 allow 弹窗后每条弹窗都会长出一个指向窗口的幽灵标签）。
   *
   * 这里主动清掉 playwright 连接时强加给已有 context 的默认媒体仿真（colorScheme 'light'
   * 等，见 resetForeignPageEmulation）：清晚了弹窗会先按 light 画一帧。reconcile 每秒也会
   * 对同一批 target 走一遍兜底。
   */
  private skipForeignTarget(page: PageLike): void {
    for (const rt of this.runtime.values()) {
      if (rt.page === page) return // 已登记的面板页：它的主题仿真归 applyColorSchemeTo，不得清
    }
    if (page.isClosed()) return
    this.resetForeignPageEmulation(page)
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
  registerExternalPage(entry: BrowserSeenPayload): BrowserPageMeta | null {
    const { id, owner, url } = entry
    if (!id || !owner) return null
    if (this.disposed) return null
    // The renderer is the only sender, but these two fields stay self-consistent
    // anyway: `owner` decides which session's pages a row joins, and
    // webContentsId is the key the human-input relay bumps to invalidate refs.
    if (owner !== HUMAN_OWNER && !/^agent:.+$/.test(owner)) return null
    const rawWcId = entry.webContentsId
    const webContentsId = typeof rawWcId === 'number' && Number.isInteger(rawWcId) && rawWcId > 0 ? rawWcId : undefined
    if (!isAllowedNavigationUrl(url) && parseMarkerUrl(url) === null) return null
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

  /**
   * 建页：入队 pendingCreate → renderer 物化 marker webview → reconcile 登记 runtime。
   *
   * 冷启动的第一次握手会输掉竞态（renderer 尚未挂载宿主 / marker target 尚未对 CDP
   * 可见）。旧实现只等一次就抛 BrowserHostUnavailableError，把重试推给模型（工具文案
   * 里写着「retry once」）——实测每个会话的第一个 browser_navigate 都要先失败一次。
   * 现在：握手在途时按 1s 重推 browser:state（renderer 漏掉首次推送即自愈，面板被
   * 折叠/晚挂载也能收敛），超时后换一个新 pendingCreate 重试一次，两次都失败才上报。
   */
  async createPage(owner: string, url?: string): Promise<BrowserPageMeta> {
    await this.ensureStarted()
    if (url !== undefined && !isAllowedNavigationUrl(url)) throw new NavigationBlockedError(url)
    let lastError: unknown = null
    for (let attempt = 1; attempt <= ELECTRON_CREATE_ATTEMPTS; attempt++) {
      try {
        const meta = await this.awaitHostHandshake(owner, url)
        // 登记完成（waiter resolve 时 runtime 已就位）后再按 url 导航——顺序安全
        const rt = this.requireRuntime(meta.id)
        if (url && url !== 'about:blank') await rt.page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
        return pageMeta(pageById(this.state, meta.id)!)
      } catch (error) {
        lastError = error
        // 只有「没有宿主且值得重试」才再试一手；导航/策略类错误与断线原样上报。
        if (!(error instanceof BrowserHostUnavailableError) || !error.retryable) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new BrowserHostUnavailableError()
  }

  /** 一次 pendingCreate 握手（含在途重推）；超时抛 BrowserHostUnavailableError。 */
  private awaitHostHandshake(owner: string, url?: string): Promise<BrowserPageMeta> {
    // agent 页由 renderer 托管（webview guest）——服务端不能自建 target（Target.createTarget
    // 未实现、window.open 隐藏窗口方案已被 webview 取代）：入队 pendingCreate，等 renderer
    // 挂载 webview（marker URL）后由 reconcile 登记 runtime，waiter 放行。
    const id = createBrowserPageId()
    return new Promise<BrowserPageMeta>((resolve, reject) => {
      // 在途重推：renderer 可能错过第一次 browser:state（订阅尚未建立/面板正在挂载/
      // store 浅比较认为无变化）。pendingCreates 不属于 state，重推的就是整份状态快照，
      // 幂等——auto-open 侧按 id 去重，已开的面板不会被反复顶开。
      const redrive = setInterval(() => {
        if (!this.registrationWaiters.has(id)) {
          clearInterval(redrive)
          return
        }
        this.notifyState()
      }, ELECTRON_CREATE_REDRIVE_MS)
      redrive.unref()
      const timer = setTimeout(() => {
        clearInterval(redrive)
        this.registrationWaiters.delete(id)
        this.pendingCreates = this.pendingCreates.filter((p) => p.id !== id)
        // Handshake latency: pendingCreates is NOT part of `state`, so without
        // this the pane would only learn the timeout via its 2.5s poll.
        this.notifyState()
        reject(new BrowserHostUnavailableError())
      }, this.createTimeoutMs)
      timer.unref()
      // 成功/失败/断线三条路径都会清掉重推定时器（resolve/reject 包装）。
      this.registrationWaiters.set(id, {
        resolve: (meta) => { clearInterval(redrive); resolve(meta) },
        reject: (error) => { clearInterval(redrive); reject(error) },
        timer,
      })
      this.pendingCreates.push({ id, owner, url, createdAt: Date.now() })
      // Handshake latency: push the queue change immediately — the renderer
      // materializes the marker webview on the browser:state event, not on
      // its next poll (this is the 2.5s the blank page used to wait out).
      this.notifyState()
    })
  }

  /** 主进程 input-event 中继：人在 guest 里的原生输入使旧 snapshot ref 失效。 */
  bumpInteractionByWebContentsId(webContentsId: number): void {
    if (this.disposed) return
    const rec = this.state.pages.find((p) => p.webContentsId === webContentsId)
    if (rec) {
      this.state = bumpInteraction(this.state, rec.id)
      this.notifyState()
    }
  }

  /**
   * guest 的 window.open 建出了真弹窗窗口（wiring 的 allow 路径）。窗口不进面板注册表
   * ——它是独立 BrowserWindow，browser_* 工具到不了它，browser_pages 也不会列它——
   * 但 owner 是 agent 页时模型必须知道：否则它会以为这个点击什么都没发生而反复重试。
   * owner 由 opener 的 webContentsId 反查注册表（renderer 上报的字段）；human 页或无主
   * 的 opener 不记（人在屏幕上自己看得见）。
   */
  noteWindowPopup(openerWebContentsId: number, url: string): void {
    if (this.disposed) return
    const opener = this.state.pages.find((p) => p.webContentsId === openerWebContentsId)
    if (!opener || opener.owner === HUMAN_OWNER) return
    const list = this.windowPopups.get(opener.owner) ?? []
    list.push(url)
    this.windowPopups.set(opener.owner, list)
  }

  /** 取走并清空该 owner 待告知的弹窗窗口（快照类动作的 app 自产说明；只交付一次）。 */
  private drainWindowPopups(owner: string): string[] {
    const list = this.windowPopups.get(owner)
    if (!list || list.length === 0) return []
    this.windowPopups.delete(owner)
    return list
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

  /**
   * 工具条 reload：对服务端驱动的页走 `reloadGuest`（= goto(currentUrl)），
   *  **绝不**发 CDP `Page.reload`（铁律 6：它会杀死 guest，甚至打到壳窗口）。
   *  返回 false 只在一种情况下出现：这行页没有 runtime（renderer 上报的
   *  state-only 登记，服务端从未 attach），此时唯一可用的驱动器就是 webview
   *  元素自身——由调用方显式回退，而不是服务端默默什么都不做。
   */
  async reloadPageForId(id: string): Promise<boolean> {
    const rt = this.runtime.get(id)
    if (!rt) return false
    await this.reloadGuest(rt.page)
    return true
  }

  private handlePageClosed(id: string): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    this.runtime.delete(id)
    // Explicit release: the target is gone anyway, but a session left attached
    // would linger across a reconnect (and detach() is the only owner-side
    // cleanup the CDP interface gives us).
    void rt.cdp?.detach().catch(() => { /* target already gone */ })
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
    // A disconnect invalidates every parked handshake: a reconnect exposes NEW
    // targets, so those waiters can never be fulfilled. Fail them now instead of
    // letting each createPage park for the full create timeout, and drop the
    // queue/grace state that describes the dead host.
    for (const [id, waiter] of [...this.registrationWaiters]) {
      clearTimeout(waiter.timer)
      this.registrationWaiters.delete(id)
      // 断线/退出不得重试（retryable:false）：宿主已经没了，重试只会再等一个超时。
      waiter.reject(new BrowserHostUnavailableError(false))
    }
    this.pendingCreates = []
    this.closingTargetIds.clear()
    // 弹窗窗口的待告知也描述已死的 host：清掉，别让重连后的会话收到早已不存在的窗口。
    this.windowPopups.clear()
    for (const rt of this.runtime.values()) void rt.cdp?.detach().catch(() => { /* connection gone */ })
    for (const id of this.runtime.keys()) this.retire(id)
    this.ownerChains.clear()
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
      // 连接可能在这两步之间断掉（断线/退出）：显式报宿主不可用，而不是让
      // `this.context!` 变成一个看不懂的 TypeError。
      const context = this.context
      if (!context) throw new BrowserHostUnavailableError()
      const cdp = await context.newCDPSession(rt.page)
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

  /**
   * 单采样窗口内的 DOM mutation 数（页内 MutationObserver）。
   * 三态与预算都由调用方给：求值失败 = 文档撕毁（导航中），超时 = 页面主线程卡住。
   */
  private sampleMutations(page: PageLike, windowMs: number, budgetMs: number): Promise<BoundedEvaluation<number>> {
    return this.evaluateWithBudget<number>(
      page,
      (ms: number) => new Promise<number>((resolve) => {
        let count = 0;
        const obs = new MutationObserver((list) => { count += list.length; });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        setTimeout(() => { obs.disconnect(); resolve(count); }, ms);
      }),
      windowMs,
      budgetMs,
    )
  }

  /**
   * 动作 → 快照之间的落定等待（消除「返回的快照滞后于动作效果」）：
   * - 预热窗给异步 handler / 导航启动留时间；
   * - URL 变化或 evaluate 失败（文档撕毁）= 导航中 → 等 domcontentloaded；
   * - 其余以 MutationObserver 采样，连续静默视为稳定（SPA 渐进渲染、懒加载）。
   * 页面持续繁忙（动画/轮询）时按预算截断——落定是尽力而为，不是硬同步点。
   * **单次采样也受预算约束**（剩余预算）：页面主线程卡住时，这一轮必须还能退出，
   * 而不是把 withPageLock 永远占住（裸 page.evaluate 没有超时参数）。
   */
  private async settleForSnapshot(page: PageLike): Promise<SettleOutcome> {
    const { warmupMs, sampleMs, budgetMs, navLoadStateMs } = this.settleTimings
    if (warmupMs > 0) await new Promise((r) => setTimeout(r, warmupMs))
    const startedUrl = (() => {
      try { return page.url() } catch { return '' }
    })()
    const deadline = Date.now() + budgetMs
    let quiet = 0
    let mutations: number | null = null
    while (Date.now() < deadline) {
      let url = startedUrl
      try { url = page.url() } catch { /* 导航中文档可能不可及 */ }
      if (url !== startedUrl) {
        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return { mutations, navigating: true }
      }
      // 单次采样不超过 settle 的剩余预算：卡死的页面只能拖到预算用尽，而不是更久。
      const outcome = await this.sampleMutations(page, sampleMs, Math.max(1, deadline - Date.now()))
      if (outcome.status === 'error') {
        // evaluate 失败：文档正在撕毁（导航进行中）→ 等 loadstate 而非继续采样。
        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return { mutations, navigating: true }
      }
      if (outcome.status === 'timeout' || !Number.isFinite(outcome.value)) {
        // 预算用尽/量不到：不能把已经采到的 0 当成「整轮都采完了」——SettleOutcome 的契约
        // 是「没测过 = null」（复核发现：样本 1 采到 0、样本 2 超时，会谎报「无变化」）。
        return { mutations: null, navigating: false }
      }
      const sampled = outcome.value
      mutations = (mutations ?? 0) + sampled
      if (sampled > 0) { quiet = 0; continue }
      quiet += 1
      if (quiet >= 2) return { mutations, navigating: false }
    }
    return { mutations, navigating: false }
  }

  /**
   * 记录页面自报的问题（有界 + 同文本去重）。
   * 去重是必需的：一条常驻错误可能在每个 rAF 里重报，不去重缓冲会被它一条刷满。
   * 不 notifyState——这不是注册表变更。
   */
  private recordPageIssue(id: string, kind: PageIssueLike['kind'], text: string): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, PAGE_ISSUE_TEXT_MAX)
    if (!clean) return
    if (rt.pageIssues.some((issue) => issue.kind === kind && issue.text === clean)) return
    rt.pageIssues.push({ seq: ++this.pageIssueSeq, kind, text: clean })
    if (rt.pageIssues.length > MAX_PAGE_ISSUES) rt.pageIssues.shift()
  }

  /** 取走「上次快照之后新报的」问题（调用即标记已回报，长会话不反复刷屏）。 */
  private drainNewPageIssues(rt: PageRuntime): PageIssueWithSeq[] {
    const fresh = rt.pageIssues.filter((issue) => issue.seq > rt.reportedIssueSeq)
    if (fresh.length > 0) rt.reportedIssueSeq = fresh[fresh.length - 1].seq
    return fresh
  }

  /** 页面自报问题的增量说明（页面自写文本 → 说明内部自带不可信边界）。 */
  private pageIssueNotes(rt: PageRuntime): string[] {
    const issues = this.drainNewPageIssues(rt)
    return issues.length > 0 ? [pageIssuesNote(issues)] : []
  }

  /**
   * 带预算的求值（核心）。铁律：不容 Playwright 默认超时把 `withPageLock` 挂死——普娃的
   * `page.evaluate` 没有超时参数，且下载/撕毁/卡住的页面会让它一直等。预算用尽返回
   * `timeout`（「量不到」），求值抛错返回 `error`，两者分开报给调用方。
   * 注意：失败的 evaluate 也预先接了 catch（race 已结束时，迟到的拒绝会变成 unhandled）。
   */
  private async evaluateWithBudget<T>(
    page: PageLike,
    // `never[]` 形参 + `T | Promise<T>` 返回：页内脚本可以带参数（采样窗口/坐标/标注载荷）
    // 也可以不带，可以返回值也可以返回 Promise（playwright 自己会解包）。
    script: (...args: never[]) => T | Promise<T>,
    arg?: unknown,
    budgetMs = AGENT_ACTION_TIMEOUT_MS,
  ): Promise<BoundedEvaluation<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const evaluation = page.evaluate(script as unknown, arg).then(
        (value) => ({ status: 'ok', value } as BoundedEvaluation<T>),
        () => ({ status: 'error' } as BoundedEvaluation<T>),
      )
      const budget = new Promise<BoundedEvaluation<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), budgetMs)
        timer.unref?.()
      })
      return await Promise.race([evaluation, budget])
    } catch {
      return { status: 'error' }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 只要值：超时/求值失败都当「量不到」（measure 类调用方本来就把 null 当作「不出声」）。 */
  private async evaluateBounded<T>(
    page: PageLike,
    script: (...args: never[]) => T | Promise<T>,
    arg?: unknown,
    budgetMs = AGENT_ACTION_TIMEOUT_MS,
  ): Promise<T | null> {
    const outcome = await this.evaluateWithBudget<T>(page, script, arg, budgetMs)
    return outcome.status === 'ok' ? outcome.value : null
  }

  /**
   * 带预算的「页面侧调用」——不只有 `page.evaluate`：实测 coreBundle，playwright 的
   * `page.title()` 是 `title({}, kNoTimeout)`、`keyboard.press` 是 `keyboardPress({…}, kNoTimeout)`
   *（kNoTimeout = `{ timeout: 0 }`，即永不超时），`locator.count()` 也不接受 timeout 参数。
   * 这些调用只要在 withPageLock 里裸等一次，卡住的页面就能把锁与 agentBusy 永远占住。
   * 超时/抛错都返回 null，由调用方决定「量不到」怎么表现（复核发现）。
   */
  private async withBudget<T>(run: () => Promise<T>, budgetMs = MEASURE_TIMEOUT_MS): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // 失败的调用预先接住拒绝：race 已结束时，迟到的拒绝会变成 unhandled。
      const raced = run().then((value) => ({ value }), () => null)
      const budget = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([raced, budget])
      return outcome ? outcome.value : null
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 页面标题：走预算求值，而不是 `page.title()`。
   * 标题在每个动作的 captureAgentSnapshot 里都要取一次，而 `page.title()` 是 kNoTimeout
   * （见 withBudget）——卡住的页面会让一次动作把 withPageLock 与 agentBusy 永远占住。
   * 返回 null = 量不到：调用方自己决定「空标题」还是「跳过这轮」（侧边栏同步就该跳过，
   * 否则一次超时会把页面标题刷成空）。
   */
  private async readTitle(page: PageLike): Promise<string | null> {
    const title = await this.evaluateBounded<string>(page, () => document.title, undefined, MEASURE_TIMEOUT_MS)
    return typeof title === 'string' ? title : null
  }

  /**
   * selector 计数：`locator.count()` 没有可传的超时，只能在外面夹预算。
   * 非法选择器与「页面不应答」必须分开报：前者是模型能改的语法问题，后者是页面卡住。
   */
  private async countSelector(locator: LocatorLike, selector: string): Promise<number> {
    const outcome = await this.withBudget<{ count: number } | { error: string }>(async () => {
      try {
        return { count: await locator.count() }
      } catch (error) {
        return { error: firstLine(error) }
      }
    }, MEASURE_TIMEOUT_MS)
    if (outcome === null) {
      throw new SnapshotScopeError(`selector could not be evaluated: ${selector} (the page did not answer within ${MEASURE_TIMEOUT_MS}ms)`)
    }
    if ('error' in outcome) throw new SnapshotScopeError(`selector is invalid: ${selector} — ${outcome.error}`)
    return outcome.count
  }

  /**
   * 键盘按键带预算：`keyboard.press` 是 kNoTimeout（见 withBudget），而它跑在 withPageLock
   * 里。超时给一句明确的错（与 pressSequentially 的超时同族），不把锁挂死。
   */
  private async pressKeyBounded(page: PageLike, key: string, budgetMs = AGENT_ACTION_TIMEOUT_MS): Promise<void> {
    const pressed = await this.withBudget(() => page.keyboard.press(key).then(() => true), budgetMs)
    if (!pressed) {
      throw new Error(`keyboard.press("${key}") did not complete within ${budgetMs}ms — the page may be unresponsive`)
    }
  }

  /** 空 a11y 树时量一下文档规模：只取数字/枚举，不含页面自写文本。 */
  private async measureEmptySnapshot(page: PageLike): Promise<EmptySnapshotDiagnostics | null> {
    const info = await this.evaluateBounded<EmptySnapshotDiagnostics>(page, () => {
      const body = document.body
      return {
        readyState: String(document.readyState ?? ''),
        childElements: body ? body.children.length : -1,
        textChars: body && typeof body.innerText === 'string' ? body.innerText.trim().length : -1,
      }
    }, undefined, MEASURE_TIMEOUT_MS)
    if (!info || typeof info !== 'object') return null
    return info
  }

  /** 空树诊断说明（子树快照为空时同样适用）。 */
  private async emptySnapshotNotes(page: PageLike): Promise<string[]> {
    const diagnostics = await this.measureEmptySnapshot(page)
    return diagnostics ? [emptySnapshotNote(diagnostics)] : []
  }

  /** 滚动位置（量不到就返回 null——宁可不出声，也不编数字）。 */
  private async readScrollPosition(page: PageLike): Promise<ScrollPosition | null> {
    const info = await this.evaluateBounded<number[]>(page, () => [
      window.scrollX, window.scrollY, window.innerWidth, window.innerHeight,
      document.documentElement.scrollWidth, document.documentElement.scrollHeight,
    ], undefined, MEASURE_TIMEOUT_MS)
    if (!Array.isArray(info) || info.length !== 6) return null
    if (info.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    const [x, y, viewportWidth, viewportHeight, scrollWidth, scrollHeight] = info
    return { x, y, viewportWidth, viewportHeight, scrollWidth, scrollHeight }
  }

  /**
   * 按键后的焦点回报（只在变化时出声）。
   * 只取标签名：标签名来自固定词汇表；aria-label/placeholder/innerText 都是页面自写
   * 文本，要报就得再开一层不可信边界——不值当。
   */
  private async readFocusChange(rt: PageRuntime): Promise<string | null> {
    const info = await this.evaluateBounded<{ tag?: string }>(rt.page, () => {
      const el = document.activeElement
      return { tag: el && el.tagName ? String(el.tagName).toLowerCase() : '' }
    }, undefined, MEASURE_TIMEOUT_MS)
    const tag = info && typeof info.tag === 'string' ? info.tag : ''
    if (!tag || tag === rt.lastFocusTag) return null
    rt.lastFocusTag = tag
    return focusChangedNote(tag)
  }

  /**
   * 动作 → 快照的统一收尾：落定 → 取 url/title → 登记 ref 全集 → 裁剪交付。
   * 同时交出未裁剪原文与裁剪结果：diff 路径只有拿到「是否被截断」才能把窗口外的
   * 改动说清楚。
   */
  private async captureAgentSnapshot(
    owner: string,
    pageId: string,
    opts: { maxChars?: number; offset?: number; expectChange?: boolean } = {},
  ): Promise<{ ingested: IngestedSnapshot; url: string; title: string; windowPopups: string[]; extraNotes: string[] }> {
    const rt = this.requireRuntime(pageId)
    // 动作效果落定后再快照：异步 DOM 更新/导航未完成时立即快照会返回旧状态。
    // settle 顺带回报 mutation 数：只有「采到了而且是 0」才能说「没观察到变化」（F6）。
    const settled = await this.settleForSnapshot(rt.page).catch(() => ({ mutations: null, navigating: false }) as SettleOutcome)
    // 无 viewer 时 CDP nav 事件不会到来，这里把 URL/title 同步进注册表。
    // URL 变化会清空旧 snapshot——随后 recordSnapshot 立即重录，顺序安全。
    const url = (() => {
      try { return rt.page.url() } catch { return '' }
    })()
    const title = (await this.readTitle(rt.page)) ?? ''
    this.state = updatePageNav(this.state, pageId, url, title)
    this.notifyState()
    const raw = await rt.page.ariaSnapshot({ mode: 'ai', timeout: AGENT_SNAPSHOT_TIMEOUT_MS })
    // ref 全集按未裁剪原文登记：被截掉区域的 ref 依旧可 click/type。
    this.state = recordSnapshot(this.state, pageId, [...parseSnapshotRefs(raw)])
    this.notifyState()
    const previousVisible = rt.lastSnapshotText
    const ingested = ingestSnapshot(raw, opts.maxChars, opts.offset)
    // 基线 = 模型实际看到的内容，不是未裁剪全文：拿全文当基线会把模型从未见过的
    // 下半页当作它已知的状态，于是一个开在那一带的模态框会被 diff 报成
    // `(no snapshot change)`——对工具自身正确，对模型是谎话（实测）。
    rt.lastSnapshotText = ingested.visible
    // 交付给模型的 a11y 文本有没有变。缺了这条，「没采到 mutation」会大面积误报：
    // 勾选框真的勾上了（无 mutation）、导航换了整篇文档（文档在采样前就换完了），
    // 都曾被报成「无变化」（实测）。没基线（新页/首次）也不出声。
    const treeChanged = previousVisible === null || previousVisible !== ingested.visible
    // F5/F6：空 a11y 树、页面自报错误、以及「真的什么都没变」都必须显式说出来。
    const extraNotes: string[] = [
      ...(raw.trim() === '' ? await this.emptySnapshotNotes(rt.page) : []),
      ...this.pageIssueNotes(rt),
      ...(opts.expectChange && settled.mutations === 0 && !treeChanged ? [noDomChangeNote()] : []),
    ]
    return { ingested, url, title, windowPopups: this.drainWindowPopups(owner), extraNotes }
  }

  /** 快照结果组装（交付文本 = 裁剪后的可见部分；说明属 app 自产 → 交给工具层放边界外）。 */
  private resultOf(
    pageId: string,
    url: string,
    title: string,
    windowPopups: string[],
    ingested: IngestedSnapshot,
    notes: Array<string | null | undefined> = [],
  ): AgentActionResult {
    const kept = notes.filter((note): note is string => typeof note === 'string' && note.length > 0)
    return {
      pageId,
      snapshot: ingested.visible,
      window: { offset: ingested.offset, nextOffset: ingested.truncated && ingested.visible.length ? ingested.offset + ingested.visible.length : null,
        totalChars: ingested.totalChars, cap: ingested.cap, truncated: ingested.truncated, eof: !ingested.truncated, diff: false },
      windowPopups,
      url,
      title,
      ...(kept.length > 0 ? { snapshotNote: kept.join('\n') } : {}),
    }
  }

  /**
   * 截断说明：整页快照用「被截断」语气，diff 用「窗口外」语气。
   * 语气必须跟着「有没有拿它做比较」走，否则模型会把「你看到的窗口没变」读成
   * 「页面没变」（F1）。
   */
  private truncationNotes(ingested: IngestedSnapshot, diff: boolean): string[] {
    // offset 超过结尾：必须有话，不能只给一个空块（与空 a11y 树同一个道理）。
    if (ingested.totalChars > 0 && ingested.visible.length === 0 && ingested.offset >= ingested.totalChars) {
      return [snapshotOffsetPastEndNote(ingested.offset, ingested.totalChars)]
    }
    if (!ingested.truncated) return []
    return [diff ? snapshotBeyondCapNote(ingested) : snapshotTruncationNote(ingested)]
  }

  /**
   * selector 作用域解析。strict 单匹配优先；多匹配时退到「唯一可见的那一个」：
   * 真实站点常把整组 dialog/menu 常驻 DOM（实测 GitHub 设置页 `dialog` 命中 5 个），
   * 而 strict 违例原文对模型毫无指导性。既非唯一也不唯一可见时，报出两个计数与两条
   * 可执行的出路（收紧选择器 / Playwright 语法）。
   */
  private async resolveScopedLocator(page: PageLike, selector: string): Promise<LocatorLike> {
    const base = page.locator(selector)
    // count 与「页面不应答」分开报（countSelector 有预算）——两者对模型的出路不同。
    const direct = await this.countSelector(base, selector)
    if (direct === 1) return base
    const visible = base.filter({ visible: true })
    const visibleCount = await this.countSelector(visible, selector)
    if (visibleCount === 1) return visible
    if (direct === 0) throw new SnapshotScopeError(`selector matched nothing: ${selector}`)
    throw new SnapshotScopeError(
      `selector matched ${direct} elements (${visibleCount} visible); it must be unambiguous. ` +
      `Narrow it, or use Playwright syntax such as "${selector}:visible" or "${selector} >> nth=0".`,
    )
  }

  private async finishAgentAction(
    owner: string,
    pageId: string,
    window: SnapshotWindowOpts & { notes?: Array<string | null | undefined>; expectChange?: boolean } = {},
  ): Promise<AgentActionResult> {
    const captured = await this.captureAgentSnapshot(owner, pageId, {
      maxChars: window.maxChars,
      offset: window.offset,
      expectChange: window.expectChange ?? true,
    })
    return this.resultOf(pageId, captured.url, captured.title, captured.windowPopups, captured.ingested, [
      ...captured.extraNotes,
      ...this.truncationNotes(captured.ingested, false),
      ...(window.notes ?? []),
    ])
  }

  /** ref 解析：形态 → 快照存在 → generation 匹配 → allow-list。任何失败都是明确错误。 */
  private resolveRef(owner: string, ref: string): { pageId: string; locator: LocatorLike } {
    if (!isAiRef(ref)) throw new InvalidRefError(ref)
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    const rec = pageById(this.state, pageId)!
    if (!rec.snapshot) throw new StaleSnapshotError('no snapshot; call browser_snapshot first')
    if (rec.snapshot.interactionGeneration !== rec.interactionGeneration) {
      throw new StaleSnapshotError('the page was driven by the user; call browser_snapshot again')
    }
    if (!rec.snapshot.refs.includes(ref)) {
      throw new RefNotInSnapshotError(ref)
    }
    return { pageId, locator: this.requireRuntime(pageId).page.locator(`aria-ref=${ref}`) }
  }

  /**
   * 目标解析：ref 走快照校验，selector 走跨 frame 查找。
   * 返回的 note 是 app 自产说明（交给工具层放在不可信边界之外），告诉模型选择器落在哪个
   * frame——多 frame 页面上这是它事后唯一能知道「刚才点的是哪一份」的信息。
   */
  private async resolveTarget(
    owner: string,
    target: TargetSpec,
  ): Promise<{ pageId: string; locator: LocatorLike; note: string | null }> {
    if (target.kind === 'ref') {
      const { pageId, locator } = this.resolveRef(owner, target.ref)
      return { pageId, locator, note: null }
    }
    if (target.kind === 'ax') {
      // ax 形态不经过这里：它需要 CDP 会话，由 resolveAxTarget 解析（见 clickAxTarget/hoverAxTarget）。
      throw new AxTargetError('ax targets are resolved through the accessibility tree, not through a locator')
    }
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    const page = this.requireRuntime(pageId).page
    const found = await this.resolveSelectorTarget(page, target.selector)
    return { pageId, locator: found.locator, note: found.note }
  }

  /**
   * 跨 frame 解析选择器。规则（与 `browser_snapshot` 的 selector 语义一致，只是多了 frame 维度）：
   *
   * 1. 先收「唯一可见」的候选——同一控件常在多个 frame 里各留一份，隐藏的那些不算数；
   * 2. 再看「唯一匹配」（唯一但不可见也接受：hidden `<input type=file>` 正是上传要的形态）；
   * 3. 多个 frame 同时命中 → 报错并逐 frame 列出，让模型把选择器写得更具体；
   * 4. 同一个 frame 里匹配到多个且都不唯一可见 → 给 `:visible` / `>> nth=0` 这两条出路。
   *
   * 每个 frame 一律**只查一次 count**（多余的计数是每个 frame 一次 CDP 往返），且全部
   * 走 `countSelector` 的预算——卡住的 frame 不能把 withPageLock 拖住。
   * 局限写清楚：**闭阴影根（closed shadow root）Playwright 进不去**，那种控件这条路也找不到，
   * 错误文本会直接说这条路与另外两条出路。
   */
  private async resolveSelectorTarget(page: PageLike, selector: string): Promise<{ locator: LocatorLike; note: string }> {
    const frames = page.frames().slice(0, MAX_TARGET_FRAMES)
    const visibleSingle: Array<{ locator: LocatorLike; where: string }> = []
    const single: Array<{ locator: LocatorLike; where: string }> = []
    const ambiguous: string[] = []
    let answered = 0
    let failure: string | null = null
    for (const [index, frame] of frames.entries()) {
      const where = frameWhere(frame, index)
      const base = frame.locator(selector)
      let count: number
      try {
        count = await this.countSelector(base, `${selector} (in ${where})`)
        answered += 1
      } catch (error) {
        // 认不出的选择器在每个 frame 都会抛；先记下第一句原文，最后再决定报什么。
        failure ??= error instanceof Error ? error.message : String(error)
        continue
      }
      if (count === 0) continue
      const visible = base.filter({ visible: true })
      let visibleCount = 0
      try {
        visibleCount = await this.countSelector(visible, `${selector} (visible, in ${where})`)
      } catch {
        visibleCount = 0
      }
      if (visibleCount === 1) visibleSingle.push({ locator: visible, where })
      else if (count === 1) single.push({ locator: base, where })
      else ambiguous.push(`${where}: ${count} elements (${visibleCount} visible)`)
    }

    const candidates = visibleSingle.length > 0 ? visibleSingle : single
    if (candidates.length === 1) {
      return {
        locator: candidates[0].locator,
        note: `[Targeted by selector \`${selector}\` in ${candidates[0].where}.]`,
      }
    }
    if (candidates.length > 1) {
      const where = candidates.map((candidate) => candidate.where).join('; ')
      throw new SelectorTargetError(
        `selector matched in ${candidates.length} frames: ${where}. It must be unambiguous — make it specific `
        + `(an id, a unique attribute, or a :has-text() form), because a selector cannot be scoped to a frame.`,
      )
    }
    if (ambiguous.length > 0) {
      throw new SelectorTargetError(
        `selector matched multiple elements: ${ambiguous.join('; ')}. Narrow it, or use Playwright syntax such as `
        + `"${selector}:visible" or "${selector} >> nth=0".`,
      )
    }
    if (answered === 0 && failure) {
      throw new SelectorTargetError(`selector could not be evaluated in any frame: ${selector} — ${failure}`)
    }
    const cap = frames.length === MAX_TARGET_FRAMES ? ` (first ${MAX_TARGET_FRAMES} frames scanned)` : ''
    throw new SelectorTargetError(
      `selector matched nothing in ${frames.length} frame(s)${cap}: ${selector}. A control inside a closed shadow root cannot `
      + `be reached by any selector (Playwright cannot pierce it), and it is normally missing from the snapshot too — `
      + `if it is visible on screen, target it by its accessible name instead: ax: { name: "<the visible label>" }. `
      + `Otherwise locate it with browser_screenshot.`,
    )
  }

  /**
   * `ax` 形态的目标解析：**原生 AX 树**定位，再由 CDP 的 pierced DOM 取布局盒，最后在盒内
   * 找一个「确实压在目标上」的点。链路的每一步都实测过（fixture 的闭合阴影根 + 小红书真实
   * 页面的 `<XHS-PUBLISH-BTN>`）：
   *
   *   Accessibility.getFullAXTree → backendDOMNodeId（闭合根里的按钮也在）
   *     → DOM.getBoxModel（120×40 @ 57,758）
   *     → DOM.getNodeForLocation 命中校验（这个点上到底是不是它）
   *     → Input.dispatchMouseEvent（真实指针事件，不是 .click()）
   *
   * 为什么必须有命中校验：目标常被浮层盖住（实测小红书那两个点的最顶层元素是菜单容器），
   * 而旁边往往就是不可撤销的动作。盖住就报错，绝不点下去。
   * 局限：闭合阴影根里的**输入框**仍要靠 ref/selector——本形态只承担 click/hover 两种真实指针动作。
   */
  private async resolveAxTarget(rt: PageRuntime, ax: AxTarget, kind: 'click' | 'hover'): Promise<{ point: PointLike; note: string }> {
    const cdp = await this.ensureCdp(rt)
    await this.tryCdp(cdp, 'DOM.enable', {}, MEASURE_TIMEOUT_MS)
    await this.tryCdp(cdp, 'Accessibility.enable', {}, MEASURE_TIMEOUT_MS)
    const tree = await this.tryCdp<{ nodes?: CdpAxNode[] }>(cdp, 'Accessibility.getFullAXTree', {}, AGENT_ACTION_TIMEOUT_MS)
    if (!tree) {
      throw new AxTargetError(`the accessibility tree did not answer within ${AGENT_ACTION_TIMEOUT_MS}ms — the page may be unresponsive`)
    }
    const nodes = (tree.nodes ?? []).filter((node) => !node.ignored && typeof node.backendDOMNodeId === 'number')
    const nameOf = (node: CdpAxNode) => String(node.name?.value ?? '').trim()
    const roleOf = (node: CdpAxNode) => String(node.role?.value ?? '').trim().toLowerCase()
    const wantName = ax.name.trim()
    const wantRole = ax.role ? ax.role.trim().toLowerCase() : null
    // 名字大小写严格优先；拿不到再用大小写不敏感兜一次（页面标签常被排版成大写）。
    const strict = nodes.filter((node) => nameOf(node) === wantName)
    const loose = strict.length > 0 ? strict : nodes.filter((node) => nameOf(node).toLowerCase() === wantName.toLowerCase())
    let candidates = wantRole ? loose.filter((node) => roleOf(node) === wantRole) : loose
    if (!wantRole) {
      const actionable = candidates.filter((node) => AX_ACTIONABLE_ROLES.has(roleOf(node)))
      if (actionable.length > 0) candidates = actionable
    }
    if (candidates.length === 0) {
      const roleText = wantRole ? ` with role ${wantRole}` : ''
      const rolesWithName = [...new Set(loose.map((node) => roleOf(node) || 'unknown role'))].slice(0, 4)
      throw new AxTargetError(
        `no element with the accessible name "${wantName}"${roleText} in the page`
        + (rolesWithName.length > 0
          ? ` — that name exists, but only on: ${rolesWithName.join(', ')}. Drop role, or correct it.`
          : ' — the name must be the element\'s accessible name (its visible label) exactly as assistive tech sees it.'),
      )
    }
    // 同名候选常有隐藏/重影的那一份：能用布局盒量出来的才算「渲染中」。
    const rendered: Array<{ backend: number; box: BoxLike; role: string }> = []
    for (const candidate of candidates.slice(0, AX_MAX_CANDIDATES)) {
      const box = await this.readNodeBox(cdp, candidate.backendDOMNodeId as number)
      if (box) rendered.push({ backend: candidate.backendDOMNodeId as number, box, role: roleOf(candidate) })
    }
    if (rendered.length === 0) {
      throw new AxTargetError(
        `${candidates.length} element(s) named "${wantName}" were found, but none has a layout box — they are hidden or detached. `
        + 'Open the surface that contains the control (or take a fresh snapshot) and retry.',
      )
    }
    if (rendered.length > 1) {
      throw new AxTargetError(
        `${rendered.length} rendered elements share the name "${wantName}" (roles: ${rendered.map((item) => item.role).join(', ')}). `
        + 'Add `role` to pick one, or target it with ref/selector instead.',
      )
    }
    const target = rendered[0]
    let point: PointLike | null = null
    let blocker: string | null = null
    let answered = 0
    for (const [fx, fy] of AX_POINT_GRID) {
      const px = Math.round(target.box.x + target.box.width * fx)
      const py = Math.round(target.box.y + target.box.height * fy)
      const hit = await this.cdpNodeAt(cdp, px, py)
      if (hit !== null) answered += 1
      if (hit !== null && await this.nodeCoversTarget(cdp, hit, target.backend)) {
        point = { x: px, y: py }
        break
      }
      if (hit !== null && blocker === null) blocker = await this.describeNodeAt(cdp, hit)
    }
    if (!point) {
      const where = `"${wantName}" (${target.role}) is a ${Math.round(target.box.width)}×${Math.round(target.box.height)} box at `
        + `${Math.round(target.box.x)},${Math.round(target.box.y)}`
      const untouched = kind === 'click' ? 'Nothing was clicked.' : 'Nothing was hovered.'
      // 「命中测试根本没回答」与「回答了但是别人」必须分开：前者是布局/坐标已失效
      // （该重新取盒），后者是它真的被东西盖住了（该关浮层）——两条出路不同。
      throw new AxTargetError(
        answered === 0
          ? `${where}, but the hit test answered nothing at any point inside it — the layout may have changed under it. `
            + `Take a fresh snapshot and retry. ${untouched}`
          : `${where}, but every point inside it resolves to ${blocker ?? 'another element'} instead — the control is behind `
            + `an overlay. Close the overlay and retry. ${untouched}`,
      )
    }
    const roleText = target.role ? ` (role ${target.role})` : ''
    return {
      point,
      note: `[Targeted by accessible name "${wantName}"${roleText} — ${kind === 'click' ? 'clicked' : 'hovered'} at ${point.x},${point.y} inside its `
        + `${Math.round(target.box.width)}×${Math.round(target.box.height)} box.]`,
    }
  }

  /** CDP 往返带预算：卡住的会话不能把 withPageLock 陪葬（失败与超时都返回 null）。 */
  private async tryCdp<T>(
    cdp: CdpSessionLike,
    method: string,
    params: Record<string, unknown> = {},
    budgetMs = MEASURE_TIMEOUT_MS,
  ): Promise<T | null> {
    return await this.withBudget(() => cdp.send(method, params) as Promise<T>, budgetMs)
  }

  /** 节点的布局盒（border quad → 外接矩形）；隐藏/未挂载（没有布局盒）返回 null。 */
  private async readNodeBox(cdp: CdpSessionLike, backendNodeId: number): Promise<BoxLike | null> {
    const model = await this.tryCdp<CdpBoxModel>(cdp, 'DOM.getBoxModel', { backendNodeId }, MEASURE_TIMEOUT_MS)
    const quad = model?.model?.border
    if (!quad || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) return null
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const width = Math.max(...xs) - x
    const height = Math.max(...ys) - y
    return width > 0 && height > 0 ? { x, y, width, height } : null
  }

  /**
   * 视口上某点最顶层的节点（backendNodeId）。
   * CDP 的命中测试**会穿透阴影根**（fixture 实测：闭合根里的按钮能被点到），这是它相对
   * `document.elementFromPoint` 的全部价值；坐标必须是整数，小数会被 CDP 直接拒掉。
   */
  private async cdpNodeAt(cdp: CdpSessionLike, x: number, y: number): Promise<number | null> {
    const hit = await this.tryCdp<CdpNodeLocation>(cdp, 'DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true }, MEASURE_TIMEOUT_MS)
    if (!hit) return null
    if (typeof hit.backendNodeId === 'number') return hit.backendNodeId
    return typeof hit.nodeId === 'number' ? hit.nodeId : null
  }

  /**
   * 命中点上是不是目标本身（或它的祖先）——点到按钮内部的文字节点同样算命中。
   * 「不是同一个节点」才逐层上溯，所以常见情况只有一次往返。
   */
  private async nodeCoversTarget(cdp: CdpSessionLike, hit: number, target: number): Promise<boolean> {
    if (hit === target) return true
    let cursor = hit
    for (let hop = 0; hop < AX_ANCESTOR_HOPS; hop += 1) {
      const info = await this.tryCdp<CdpNodeInfo>(cdp, 'DOM.describeNode', { backendNodeId: cursor }, MEASURE_TIMEOUT_MS)
      const parentId = info?.node?.parentId
      if (typeof parentId !== 'number') return false
      const parent = await this.tryCdp<CdpNodeInfo>(cdp, 'DOM.describeNode', { nodeId: parentId }, MEASURE_TIMEOUT_MS)
      const backend = parent?.node?.backendNodeId
      if (typeof backend !== 'number') return false
      if (backend === target) return true
      cursor = backend
    }
    return false
  }

  /** 覆盖层的结构说明（标签 + class）：结构性标识，不含页面文案。 */
  private async describeNodeAt(cdp: CdpSessionLike, backendNodeId: number): Promise<string> {
    const info = await this.tryCdp<CdpNodeInfo>(cdp, 'DOM.describeNode', { backendNodeId }, MEASURE_TIMEOUT_MS)
    const node = info?.node
    if (!node) return 'another element'
    const tag = String(node.nodeName ?? '').toLowerCase() || 'element'
    const attrs = node.attributes ?? []
    const index = attrs.indexOf('class')
    const cls = index >= 0 ? String(attrs[index + 1] ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    return cls ? `${tag}.${cls}` : tag
  }

  async agentNavigate(owner: string, url: string, opts?: { newPage?: boolean } & SnapshotWindowOpts): Promise<AgentActionResult> {
    if (!isAllowedNavigationUrl(url)) throw new NavigationBlockedError(url)
    if (opts?.newPage) {
      return this.withOwnerLock(owner, async () => {
        const pageId = (await this.createPage(owner)).id
        return this.withPageLock(pageId, async () => {
          await this.requireRuntime(pageId).page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
          return this.finishAgentAction(owner, pageId, opts)
        })
      })
    }
    const pageId = await this.getOrCreateAgentPage(owner)
    return this.withPageLock(pageId, async () => {
      await this.requireRuntime(pageId).page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
      return this.finishAgentAction(owner, pageId, opts)
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
    await this.evaluateBounded(page, () => { location.reload() }, undefined, MEASURE_TIMEOUT_MS)
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  }

  /** 历史导航：无历史/超时等失败不致命——仍返回当前页面快照。 */
  async agentHistory(owner: string, action: 'back' | 'forward' | 'reload', window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      if (action === 'back') await page.goBack({ timeout: AGENT_ACTION_TIMEOUT_MS }).catch(() => {})
      else if (action === 'forward') await page.goForward({ timeout: AGENT_ACTION_TIMEOUT_MS }).catch(() => {})
      else await this.reloadGuest(page)
      return this.finishAgentAction(owner, pageId, window)
    })
  }

  agentPages(owner: string) {
    const pages = pagesForOwner(this.state, owner).map(pageMeta)
    return { pages, activePageId: this.agentActivePageId(owner) }
  }

  async agentFocus(owner: string, pageId: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    const rec = pageById(this.state, pageId)
    if (!rec || rec.owner !== owner) throw new PageNotFoundError(pageId)
    this.state = setActivePage(this.state, owner, pageId)
    this.notifyState()
    return this.withPageLock(pageId, () => this.finishAgentAction(owner, pageId, window))
  }

  async agentSnapshot(owner: string, opts?: { selector?: string; diff?: boolean; maxChars?: number; offset?: number }): Promise<AgentActionResult> {
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
        const title = (await this.readTitle(rt.page)) ?? ''
        this.state = updatePageNav(this.state, pageId, url, title)
        this.notifyState()
        const target = await this.resolveScopedLocator(rt.page, opts.selector)
        let raw: string
        try {
          raw = await target.ariaSnapshot({ mode: 'ai', timeout: AGENT_SNAPSHOT_TIMEOUT_MS })
        } catch (error) {
          throw new SnapshotScopeError(`selector snapshot failed: ${opts.selector} — ${firstLine(error)}`)
        }
        this.state = recordSnapshot(this.state, pageId, [...parseSnapshotRefs(raw)])
        this.notifyState()
        const ingested = ingestSnapshot(raw, opts.maxChars, opts.offset)
        rt.lastSnapshotText = ingested.visible
        return this.resultOf(pageId, url, title, this.drainWindowPopups(owner), ingested, [
          ...this.truncationNotes(ingested, false),
          ...(raw.trim() === '' ? await this.emptySnapshotNotes(rt.page) : []),
          ...this.pageIssueNotes(rt),
        ])
      }
      // diff 形态：以上一次「交付给模型的文本」为基线，只返回行级差异（基线缺失时返回全量）。
      const prev = opts?.diff ? this.requireRuntime(pageId).lastSnapshotText : null
      const captured = await this.captureAgentSnapshot(owner, pageId, { maxChars: opts?.maxChars, offset: opts?.offset })
      // base 必须带上 captured.extraNotes（空树诊断 / 页面自报错误）与截断说明：
      // 漏掉它们时，整页快照成了唯一不附说明的路径（旧实现把它放在 resultOf 里才没露出来）。
      const base = this.resultOf(pageId, captured.url, captured.title, captured.windowPopups, captured.ingested, [
        ...captured.extraNotes,
        ...this.truncationNotes(captured.ingested, false),
      ])
      if (opts?.diff && prev !== null) {
        const notes = [...captured.extraNotes, ...this.truncationNotes(captured.ingested, true)]
        return {
          ...base,
          window: { ...base.window!, diff: true },
          snapshot: `Diff from the previous snapshot (- removed / + added):\n${diffSnapshotLines(prev, captured.ingested.visible)}`,
          // 语气换掉 base 的整页截断说明：diff 只比较可见窗口，窗口外的改动不会出现在
          // 这里，必须显式说出来。（无说明时显式清掉 base 的那条。）
          ...(notes.length > 0 ? { snapshotNote: notes.join('\n') } : { snapshotNote: undefined }),
        }
      }
      return base
    })
  }

  async agentClickRef(owner: string, ref: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickTarget(owner, { kind: 'ref', ref }, window)
  }

  /**
   * selector 形态的点击：用于**快照里没有 ref 的元素**——iframe 内的控件、微前端、闭合
   * 阴影外的可穿透子集。目标候选的挑选规则见 resolveSelectorTarget。
   */
  async agentClickSelector(owner: string, selector: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickTarget(owner, { kind: 'selector', selector }, window)
  }

  private async clickTarget(owner: string, target: TargetSpec, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    const label = targetLabel(target)
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      // 订阅先于点击（选择器在点击派发过程中就打开），订阅期间 playwright 的 CDP 拦截生效，
      // 所以原生面板根本不会出现。
      const guard = this.armPickerGuard(page)
      const click = locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      const winner = await Promise.race([
        click.then(() => 'click' as const),
        guard.done.then(() => (guard.opened() ? 'picker' as const : 'click' as const)),
      ])
      if (winner === 'picker') {
        // 点击已被定向错误取代：它的迟到拒绝不能变成 unhandled rejection。
        click.catch(() => { /* replaced by FilePickerInsteadOfClickError */ })
        throw new FilePickerInsteadOfClickError(label)
      }
      await click
      const result = await this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })
      // 事件与点击是两个异步消息，选择器事件可能晚于点击完成才到；settle 这段时间足够
      // 它到达，所以返回结果前再判一次——漏报会让模型以为点成功了，实际上什么都没发生。
      if (guard.opened()) throw new FilePickerInsteadOfClickError(label)
      return result
    })
  }

  /**
   * `ax` 形态的点击：选择器进不去的地方（闭合阴影根、只在 a11y 树里的自绘控件）。
   * 解析、命中校验、真实指针事件、落定——与 ref/selector 同一套收尾与护栏。
   */
  async agentClickAx(owner: string, ax: AxTarget, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickAxTarget(owner, ax, window)
  }

  private async clickAxTarget(owner: string, ax: AxTarget, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const resolved = await this.resolveAxTarget(rt, ax, 'click')
      // 与 selector 形态同一条护栏：闭合阴影根里的上传按钮同样不得弹出原生文件面板。
      const guard = this.armPickerGuard(rt.page)
      await this.dispatchPointer(rt, resolved.point, 'click')
      const result = await this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), resolved.note] })
      if (guard.opened()) throw new FilePickerInsteadOfClickError(targetLabel({ kind: 'ax', ax }))
      return result
    })
  }

  /**
   * 点击的文件选择器防护。`opened()` 只在事件真的到达后为 true；超时（没打开选择器）
   * 不是错误，必须吞掉——否则一次普通点击的 race 会变成 unhandled rejection。
   */
  private armPickerGuard(page: PageLike): { opened: () => boolean; done: Promise<void> } {
    let opened = false
    const done = page.waitForEvent('filechooser', { timeout: CLICK_PICKER_GUARD_MS })
      .then(() => { opened = true }, () => { /* 超时 = 没打开选择器 */ })
    return { opened: () => opened, done }
  }

  /**
   * 上传本地文件到 target 指向的上传控件（ref 或 selector）。两条路径都必要：
   *
   * 1. ref 就是 `<input type=file>` → 直接 `setInputFiles`。真实站点最常见的形态是把
   *    input 藏起来只暴露一个按钮，而直连路径不要求元素可见。
   * 2. ref 是那个按钮 / 自定义上传控件 → 订阅 filechooser、真点它，再把文件交给 chooser。
   *
   * **先判形状再决定走哪条**（而不是「直连失败就当不是 input」）：playwright 在两种失败上
   * 都会抛——元素不是 input（`Node is not an HTMLInputElement`）与文件列表不合法（多个文件
   * 给了 `multiple=false` 的 input、目录给了普通 input）。把后者当成「不是 input」去回退点击，
   * 得到的是自相矛盾的错（"is not a file input … Element is not visible"）并把模型指回同一个
   * ref 原地打转（复核发现）；所以现在是：形状探测 → 是 input 就直连（错误原样抛）→ 不是就
   * 走选择器路径。
   */
  async agentUpload(owner: string, ref: string, files: string[], window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.uploadTarget(owner, { kind: 'ref', ref }, files, window)
  }

  /** selector 形态的上传目标：隐藏的文件 input 常常拿不到 ref（它不在 a11y 树里）。 */
  async agentUploadSelector(owner: string, selector: string, files: string[], window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.uploadTarget(owner, { kind: 'selector', selector }, files, window)
  }

  private async uploadTarget(owner: string, target: TargetSpec, files: string[], window?: TargetWindowOpts): Promise<AgentActionResult> {
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    const label = targetLabel(target)
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      const isFileInput = await this.locatorIsFileInput(locator)
      if (isFileInput === null) {
        throw new NoFilePickerError(label, 'the element could not be inspected: the page did not answer')
      }
      if (isFileInput) {
        // 直连：错误原样抛（文件列表不合法、路径读不到都是真原因，不得伪装成「不是 input」）。
        await locator.setInputFiles(files, { timeout: AGENT_ACTION_TIMEOUT_MS })
      } else {
        await this.uploadViaFilePicker(page, locator, label, files)
      }
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), uploadNote(files), note] })
    })
  }

  /**
   * ref 是不是 `<input type=file>`（`label` → 控件的 retarget 由 setInputFiles 自己做，
   * 所以指向 label 的 ref 会回 false 并走选择器路径——那条路也成立）。
   * 返回 null = 探测不出来（页面不应答）：不能猜，否则会给出一句假的错。
   * 探测本身也在预算内：`locator.evaluate` 的 timeout 只管可判定性阶段，协议调用仍可能被
   * 卡住的页面拖住（locator.evaluate 不接受这个 timeout 之外的约束）。
   */
  private async locatorIsFileInput(locator: LocatorLike): Promise<boolean | null> {
    const shape = await this.withBudget(
      () => locator.evaluate(
        (el: DomElementLike) => el.tagName === 'INPUT' && String(el.getAttribute('type') ?? '').toLowerCase() === 'file',
        undefined,
        { timeout: MEASURE_TIMEOUT_MS },
      ),
      MEASURE_TIMEOUT_MS + 250,
    )
    return typeof shape === 'boolean' ? shape : null
  }

  /** 通用上传：点目标，等它打开文件选择器，把文件交给选择器（原生面板已被拦下）。 */
  private async uploadViaFilePicker(
    page: PageLike,
    locator: LocatorLike,
    label: string,
    files: string[],
  ): Promise<void> {
    const chooser = page.waitForEvent('filechooser', { timeout: AGENT_ACTION_TIMEOUT_MS })
    // 点击可能先失败，而选择器要等到超时才拒绝：先接住拒绝，真正的处理在下面。
    chooser.catch(() => { /* handled below */ })
    try {
      await locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
    } catch (error) {
      throw new NoFilePickerError(label, firstLine(error))
    }
    let picked: FileChooserLike
    try {
      picked = await chooser
    } catch {
      throw new NoFilePickerError(label, 'clicking it did not open a file chooser')
    }
    await picked.setFiles(files, { timeout: AGENT_ACTION_TIMEOUT_MS })
  }

  async agentTypeRef(owner: string, ref: string, text: string, submit = false, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.typeTarget(owner, { kind: 'ref', ref }, text, submit, window)
  }

  /** selector 形态的输入（快照里没有 ref 的输入框）。 */
  async agentTypeSelector(owner: string, selector: string, text: string, submit = false, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.typeTarget(owner, { kind: 'selector', selector }, text, submit, window)
  }

  private async typeTarget(
    owner: string,
    target: TargetSpec,
    text: string,
    submit: boolean,
    window?: TargetWindowOpts,
  ): Promise<AgentActionResult> {
    // 铁律 4：只能用键盘事件链，所以长度就是预算问题——超限时给一句能懂的错，
    // 而不是让 pressSequentially 跑到 8s 超时再抛 Playwright 的超时原文。
    if (text.length > TYPE_TEXT_MAX_CHARS) throw new TypeTextTooLongError(text.length)
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    return this.withPageLock(pageId, async () => {
      // 键盘链路开始前先拿焦点：这一次输入里的每个字符都不能漏到壳窗口（见 focusGuestForKeys）。
      await this.focusGuestForKeys(pageId)
      // locator.fill 的 Input.insertText 在非可见 webview guest 上静默无效
      //（electron-webview-spike 实测）——清空/输入统一走键盘事件链（全宿主形态可用）。
      const page = this.requireRuntime(pageId).page
      await locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true }) // 聚焦（真实事件链）
      await this.pressKeyBounded(page, 'ControlOrMeta+A') // 全选=清空语义（pressSequentially 只追加）
      if (text) await locator.pressSequentially(text, { timeout: AGENT_ACTION_TIMEOUT_MS })
      if (submit) await this.pressKeyBounded(page, 'Enter')
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })
    })
  }

  async agentHoverRef(owner: string, ref: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.hoverTarget(owner, { kind: 'ref', ref }, window)
  }

  /** selector 形态的悬停（快照里没有 ref 的元素）。 */
  async agentHoverSelector(owner: string, selector: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.hoverTarget(owner, { kind: 'selector', selector }, window)
  }

  private async hoverTarget(owner: string, target: TargetSpec, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    return this.withPageLock(pageId, async () => {
      await locator.hover({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })
    })
  }

  /** ax 形态的悬停（同点击：AX 定位 + 命中校验 + 真实指针事件）。 */
  async agentHoverAx(owner: string, ax: AxTarget, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.hoverAxTarget(owner, ax, window)
  }

  private async hoverAxTarget(owner: string, ax: AxTarget, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const resolved = await this.resolveAxTarget(rt, ax, 'hover')
      await this.dispatchPointer(rt, resolved.point, 'hover')
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), resolved.note] })
    })
  }

  /**
   * 真实指针事件（`Input.dispatchMouseEvent`）。坐标是**主 frame 视口的 CSS 像素**，
   * 与滚轮走同一条 CDP 路径（webview guest 上合成指针事件实测有效）。
   * 不走 `.click()`：那个只能作用在已经拿到的 node 上，而这里的目标本来就没有 locator。
   */
  private async dispatchPointer(rt: PageRuntime, point: PointLike, kind: 'click' | 'hover'): Promise<void> {
    const cdp = await this.ensureCdp(rt)
    const base = { x: point.x, y: point.y, button: 'left' }
    const events = kind === 'hover'
      ? [{ type: 'mouseMoved', ...base }]
      // 先移动再按下：真实点击前指针先进入该点（hover 态/命中态先成立）。
      : [{ type: 'mouseMoved', ...base }, { type: 'mousePressed', ...base, clickCount: 1 }, { type: 'mouseReleased', ...base, clickCount: 1 }]
    for (const event of events) {
      const sent = await this.withBudget(() => cdp.send('Input.dispatchMouseEvent', event).then(() => true), AGENT_ACTION_TIMEOUT_MS)
      if (!sent) {
        throw new AxTargetError(
          `the pointer event "${event.type}" did not complete within ${AGENT_ACTION_TIMEOUT_MS}ms — the page may be unresponsive`,
        )
      }
    }
  }

  async agentSelectRef(owner: string, ref: string, values: string[], window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.selectTarget(owner, { kind: 'ref', ref }, values, window)
  }

  /** selector 形态的下拉选择（快照里没有 ref 的 combobox/listbox）。 */
  async agentSelectSelector(owner: string, selector: string, values: string[], window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.selectTarget(owner, { kind: 'selector', selector }, values, window)
  }

  private async selectTarget(owner: string, target: TargetSpec, values: string[], window?: TargetWindowOpts): Promise<AgentActionResult> {
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    return this.withPageLock(pageId, async () => {
      await locator.selectOption(values, { timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })
    })
  }

  /**
   * 键盘输入前把焦点交给 guest 页。
   *
   * **这是正确性要求，不是礼貌**。CDP 派给 guest 的按键会先经过 embedder：壳窗口持焦点时，
   * 向 guest 目标派 `Input.dispatchKeyEvent` 的按键**同时出现在壳窗口的 DOM 里**（实测
   * Electron 44：壳窗口的 keydown 探针收到了我派给 guest 的 F24/Shift），于是应用自身的
   * 快捷键也被触发——`Escape` 正是 Composer 的「停止运行」，agent 往页面里按 Esc 就会把这
   * 一轮停掉（用户可见的现象）。三条件实测：
   *
   * - 键当焦点在壳窗口（`document.activeElement` 不是 `<webview>`）时，泄漏发生；
   * - 让 `<webview>` 拿到 DOM 焦点后，同样的按键壳窗口**一个都收不到**（实测两次）；
   * - `Page.bringToFront` 与 **main 侧 `webContents.focus()` 都不顶用**（实测：壳窗口
   *   `activeElement` 始终是 BUTTON，按键照漏），所以聚焦必须由**渲染层**对
   *   `<webview>` 元素做（ipc.ts 发请求、等 ack，见 `BrowserFocusGuestPayload`）；
   * - 鼠标事件本来就不漏。
   *
   * 所以每次键盘动作前都重新确保焦点（不是只做一次：中间用户点回提问框、页面导航都能把它
   * 拿回去）。认不出 webContentsId（state-only 页）时什么都不做，退回旧行为。
   */
  private async focusGuestForKeys(pageId: string): Promise<void> {
    const webContentsId = pageById(this.state, pageId)?.webContentsId
    if (typeof webContentsId === 'number') await this.deps.focusGuest?.(webContentsId)
  }

  async agentPressKey(owner: string, key: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      await this.focusGuestForKeys(pageId)
      await this.pressKeyBounded(rt.page, key)
      // 按键在快照无差异时完全不可验证（Tab/方向键）：焦点变化要显式回报（F6）。
      const focusNote = await this.readFocusChange(rt)
      return this.finishAgentAction(owner, pageId, { ...window, notes: [focusNote] })
    })
  }

  /**
   * 滚动：deltaX/deltaY 走鼠标滚轮（可双轴）；ref 形态把该元素滚动到可见区域。
   * 两种形态互斥，ref 优先（extension 层保证至少给一种）。
   */
  async agentScroll(owner: string, opts: { deltaX?: number; deltaY?: number; ref?: string } & SnapshotWindowOpts): Promise<AgentActionResult> {
    if (opts.ref !== undefined) {
      const { pageId, locator } = this.resolveRef(owner, opts.ref)
      return this.withPageLock(pageId, async () => {
        await locator.scrollIntoViewIfNeeded({ timeout: AGENT_ACTION_TIMEOUT_MS })
        // 滚动是唯一「快照里看不出效果」的动作（快照是**文档序**前缀，不随视口移动）：
        // 不给位置/总量，模型无法判断到底有没有滚动、还能不能继续滚（F6）。
        const position = await this.readScrollPosition(this.requireRuntime(pageId).page)
        // 滚动不期望改变 DOM（它自己的位置说明已经足够）：expectChange:false，
        // 免得每次滚动都附一句「无变化」噪声。
        return this.finishAgentAction(owner, pageId, { ...opts, notes: [position ? scrollPositionNote(position) : null], expectChange: false })
      })
    }
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const cdp = await this.ensureCdp(rt)
      // 三个量测都走预算求值（滚动是高频动作，页面卡住时不能把 withPageLock 占死）。
      const before = await this.evaluateBounded<number[]>(rt.page, () => [window.scrollX, window.scrollY], undefined, MEASURE_TIMEOUT_MS)
      const size = await this.evaluateBounded<number[]>(rt.page, () => [window.innerWidth, window.innerHeight], undefined, MEASURE_TIMEOUT_MS)
      // 量不到视口就无法把滚轮锚到视口中心：直接走 scrollBy 兜底（它本来就不需要坐标）。
      if (size && Number.isFinite(size[0]) && Number.isFinite(size[1])) {
        // 真实 wheel 事件（部分站点按 wheel 门控懒加载）；锚定真实视口中心。
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(size[0] / 2), y: Math.round(size[1] / 2),
          deltaX: opts.deltaX ?? 0, deltaY: opts.deltaY ?? 0,
        })
        await rt.page.waitForTimeout(150) // 等滚动落地再校验
      }
      const after = await this.evaluateBounded<number[]>(rt.page, () => [window.scrollX, window.scrollY], undefined, MEASURE_TIMEOUT_MS)
      if (before && after && after[0] === before[0] && after[1] === before[1]) {
        // 合成 wheel 在 webview guest 上非确定性地被吞（probe 实测；隐藏 BrowserWindow
        // 无此问题）——scrollBy 兜底保证进度（scroll 事件照发，懒加载不受影响）。
        // 只有在量到了前后位置、且确实没动时才兜底：量不到就宁可不动作，也不冒双滚的风险。
        await this.evaluateBounded(rt.page, ([dx, dy]: [number, number]) => window.scrollBy(dx, dy), [opts.deltaX ?? 0, opts.deltaY ?? 0], MEASURE_TIMEOUT_MS)
      }
      const position = await this.readScrollPosition(rt.page)
      return this.finishAgentAction(owner, pageId, { ...opts, notes: [position ? scrollPositionNote(position) : null], expectChange: false })
    })
  }

  async agentWaitFor(
    owner: string,
    opts: { text?: string; textGone?: string; delay?: number; selector?: string; load?: string; timeout?: number } & SnapshotWindowOpts,
  ): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page
      const unmet: string[] = []
      // 条件等待上限：显式 timeout（秒）优先，缺省 5s；钻在 [0.5, 30] 内。
      // **所有**条件都吃它（load 状态在内）——“每个条件的上限” 就是这个参数的全部含义，
      // 旧实现给 load 单开一个硬编码 10s，参数描述与行为对不上。
      const condTimeoutMs = Math.min(Math.max((opts.timeout ?? 5) * 1000, 500), 30_000)
      if (typeof opts.delay === 'number' && Number.isFinite(opts.delay)) {
        // delay = 先固定睡这么多秒再判条件（与上面那个上限无关，两者可叠加）。
        // 负数/NaN 直接丢给 Playwright 会被它拒绝（变成工具错误）。夹进 [0, 30]。
        await page.waitForTimeout(Math.max(0, Math.min(opts.delay, 30)) * 1000)
      }
      // 超时不是错误：未满足的条件显式上报（unmet），由工具层呈现给模型。
      if (opts.text) {
        await page.getByText(opts.text).first().waitFor({ state: 'visible', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`text never appeared: ${opts.text}`) })
      }
      if (opts.textGone) {
        await page.getByText(opts.textGone).first().waitFor({ state: 'hidden', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`text still on the page: ${opts.textGone}`) })
      }
      if (opts.selector) {
        await page.locator(opts.selector).first().waitFor({ state: 'visible', timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`selector not visible: ${opts.selector}`) })
      }
      if (opts.load === 'load' || opts.load === 'domcontentloaded' || opts.load === 'networkidle') {
        await page.waitForLoadState(opts.load, { timeout: condTimeoutMs })
          .then(() => undefined, () => { unmet.push(`load state not reached: ${opts.load}`) })
      }
      const result = await this.finishAgentAction(owner, pageId, opts)
      return { ...result, unmet }
    })
  }

  /**
   * 截图。annotate 时先拍原图，再在页内离屏 canvas 上合成 ref 标签（canvas 不进 DOM：
   * 人类不可见、无闪烁、无残留），标签文本即 ref——多模态模型可凭图选 ref 再 click/type。
   * 合成失败静默回退原图；首次捕获失败重试一次（大视口/瞬时争用偶发超时）。
   */
  async agentScreenshot(owner: string, opts?: { annotate?: boolean }): Promise<{ pageId: string; jpegBase64: string; labels: number; annotated: boolean }> {
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
      const fallback = () => ({ pageId, jpegBase64: base64, labels: 0, annotated: false })
      if (!opts?.annotate) return fallback()
      const rec = pageById(this.state, pageId)
      const refs = (rec?.snapshot?.refs ?? []).slice(0, 50) // 标签过密会失去可读性
      const items: Array<{ ref: string; x: number; y: number; width: number; height: number }> = []
      // 每个 ref 一次 boundingBox，而 Playwright 的默认超时是 30s：一个失效 ref 就会阻塞
      // 30s，50 个 ref 最坏 ~25 分钟，全程占着 withPageLock（agentBusy 卡住、后续动作排队）。
      // 整段给一个 8s 总预算，单次不超过剩余预算——标注是装饰，超预算就退回原图。
      const annotateDeadline = Date.now() + AGENT_ACTION_TIMEOUT_MS
      for (const ref of refs) {
        const remaining = annotateDeadline - Date.now()
        if (remaining <= 0) break
        const box = await page.locator(`aria-ref=${ref}`).boundingBox({ timeout: remaining }).catch(() => null)
        if (box && box.width > 0 && box.height > 0) items.push({ ref, ...box })
      }
      if (items.length === 0) return fallback()
      // 离屏 canvas 合成：boundingBox 是视口 CSS 坐标，按 naturalWidth/innerWidth 缩放对齐 DPR/缩放。
      // 合成与框选共用同一个预算（annotateDeadline）：标注是装饰，超预算就退回原图，
      // 不让一次「卡住的页面」把 withPageLock 占死（裸 evaluate 没有超时参数）。
      const annotatedB64 = await this.evaluateBounded<string | null>(page, (payload: { b64: string; items: Array<{ ref: string; x: number; y: number; width: number; height: number }> }) => {
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
      }, { b64: base64, items }, Math.max(1, annotateDeadline - Date.now()))
      if (!annotatedB64) return fallback()
      return { pageId, jpegBase64: annotatedB64, labels: items.length, annotated: true }
    })
  }

  /**
   * 坐标点选元素解析（人类批注用）：x/y 是视口 CSS 坐标（webview guest 视口 == 宿主元素尺寸）。
   * DOM.getNodeForLocation 在跨进程导航后的 guest 上不可靠（"No node found"，probe 实测）——
   * 改用页面内 elementFromPoint + getBoundingClientRect/cssPath，全宿主形态可用。
   */
  async resolveElementAt(id: string, x: number, y: number): Promise<ElementAtInfo | null> {
    const rt = this.requireRuntime(id)
    // 人工批注的坐标解析：同样带预算（页面卡住时面板不能挂着一个永不返回的 IPC）。
    return await this.evaluateBounded<ElementAtInfo | null>(rt.page, ([px, py]: [number, number]) => {
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
    }, [Math.round(x), Math.round(y)], MEASURE_TIMEOUT_MS)
  }

  /** 关页：给了 pageId 就关它（校验归属），否则关当前活动页（F7：不再必须 focus 先切过去）。 */
  async agentClose(owner: string, pageId?: string): Promise<void> {
    const target = pageId ?? this.agentActivePageId(owner)
    if (!target) return
    const rec = pageById(this.state, target)
    if (!rec || rec.owner !== owner) throw new PageNotFoundError(target)
    await this.closePage(target)
  }

  async closePagesForOwner(owner: string): Promise<void> {
    for (const rec of pagesForOwner(this.state, owner)) await this.closePage(rec.id)
    // The owner's serialization chain is a monotonic map; with no pages left it
    // describes nothing and would otherwise live for the process's lifetime.
    if (pagesForOwner(this.state, owner).length === 0) this.ownerChains.delete(owner)
  }

  dispose(): void {
    this.disposed = true
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
