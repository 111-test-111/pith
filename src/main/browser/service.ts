/** Singleton CDP service for renderer-owned Electron webview guests.
 * Only marker/seen handshakes register panel pages; never create CDP targets.
 * Keep real input events, bounded page calls and snapshot provenance intact.
 * Disposal drops references; Browser.close() can terminate the Electron shell.
 * Host constraints and measured exceptions: docs/architecture/embedded-browser.md.
 * Structural interfaces below support the same implementation in offline mocks. */
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

// Minimal DOM types describe guest evaluate scripts without importing DOM into main.
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

  body: DomElementLike | null
  readyState: string

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

export class SnapshotScopeError extends Error { constructor(msg: string) { super(msg); this.name = 'SnapshotScopeError' } }

export class FilePickerInsteadOfClickError extends Error {

  readonly target: string
  constructor(target: string) {
    super(`${target} opens a file picker and a click cannot choose files`)
    this.name = 'FilePickerInsteadOfClickError'
    this.target = target
  }
}

export class NoFilePickerError extends Error {
  readonly target: string
  constructor(target: string, reason: string) {
    super(`${target} is not a file input and clicking it did not open a file picker${reason ? ` (${reason})` : ''}`)
    this.name = 'NoFilePickerError'
    this.target = target
  }
}

export class TypeTextTooLongError extends Error {
  readonly length: number
  constructor(length: number) {
    super(`${length} characters is over the keyboard-replay limit`)
    this.name = 'TypeTextTooLongError'
    this.length = length
  }
}

type BoundedEvaluation<T> = { status: 'ok'; value: T } | { status: 'timeout' } | { status: 'error' }

export type AxTarget = { name: string; role?: string }
export type TargetSpec =
  | { kind: 'ref'; ref: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'ax'; ax: AxTarget }

export class SelectorTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorTargetError'
  }
}

export class AxTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AxTargetError'
  }
}

function targetLabel(target: TargetSpec): string {
  if (target.kind === 'ref') return `ref ${target.ref}`
  if (target.kind === 'selector') return `selector ${target.selector}`
  const role = target.ax.role ? `role ${target.ax.role}, ` : ''
  return `accessible ${role}name "${target.ax.name}"`
}

const MAX_TARGET_FRAMES = 20

const AX_POINT_GRID: Array<[number, number]> = [
  [0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75],
  [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
]

const AX_ACTIONABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton',
  'listbox', 'treeitem', 'gridcell',
])

const AX_MAX_CANDIDATES = 8

const AX_ANCESTOR_HOPS = 6

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

function frameWhere(frame: FrameLike, index: number): string {
  const url = (() => {
    try { return frame.url() } catch { return '' }
  })()
  const short = url.length > 140 ? `${url.slice(0, 140)}…` : url
  return index === 0 ? `main frame (${short})` : `frame #${index} (${short})`
}

/** null means observation was incomplete; zero means a completed sample saw no mutations. */
interface SettleOutcome {

  mutations: number | null

  navigating: boolean
}

export class BrowserHostUnavailableError extends Error {

  readonly retryable: boolean
  constructor(retryable = true) {
    super('no renderer available to host the browser page (browser tab not open)')
    this.name = 'BrowserHostUnavailableError'
    this.retryable = retryable
  }
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0]
}

export interface SettleTimings {

  warmupMs: number

  sampleMs: number

  budgetMs: number

  navLoadStateMs: number
}
const DEFAULT_SETTLE_TIMINGS: SettleTimings = { warmupMs: 120, sampleMs: 120, budgetMs: 1_500, navLoadStateMs: 5_000 }

export interface SnapshotWindowOpts {
  maxChars?: number
  offset?: number
}

type TargetWindowOpts = SnapshotWindowOpts & { notes?: Array<string | null | undefined> }

/** snapshot is exactly the delivered text window; page-authored values remain untrusted. */
export interface AgentActionResult {
  pageId: string

  snapshot: string

  windowPopups: string[]

  url?: string
  title?: string

  unmet?: string[]

  snapshotNote?: string
  window?: { offset: number; nextOffset: number | null; totalChars: number; cap: number; truncated: boolean; eof: boolean; diff: boolean }
}

const MAX_RETIRED_IDS = 100
const ELECTRON_RECONCILE_INTERVAL_MS = 1_000

// Renderer mounting and the reconciliation poll need a bounded handshake window.
const ELECTRON_CREATE_TIMEOUT_MS = 15_000

const ELECTRON_CREATE_ATTEMPTS = 2

const ELECTRON_CREATE_REDRIVE_MS = 1_000

const PENDING_CREATE_TTL_MS = 30_000

const MAX_PAGE_ISSUES = 8

const PAGE_ISSUE_TEXT_MAX = 200

const AGENT_ACTION_TIMEOUT_MS = 8_000

const AGENT_NAV_TIMEOUT_MS = 20_000

const AGENT_SNAPSHOT_TIMEOUT_MS = 20_000

const CLICK_PICKER_GUARD_MS = 1_500

const MEASURE_TIMEOUT_MS = 1_000

const STATE_NOTIFY_COALESCE_MS = 30

/** Use real keyboard events: Input.insertText/fill silently fail on non-visible guests. */
export interface LocatorLike {
  click(options?: { timeout?: number; force?: boolean }): Promise<void>

  setInputFiles(files: string[], options?: { timeout?: number }): Promise<void>

  pressSequentially(text: string, options?: { timeout?: number }): Promise<void>
  press(key: string): Promise<void>
  hover(options?: { timeout?: number; force?: boolean }): Promise<void>
  selectOption(values: string[], options?: { timeout?: number; force?: boolean }): Promise<unknown>
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>

  evaluate(fn: unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>
  ariaSnapshot(options?: { mode?: 'ai' | 'default'; timeout?: number }): Promise<string>

  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>
  first(): LocatorLike

  count(): Promise<number>
  filter(options: { visible?: boolean }): LocatorLike
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>
}

export interface FileChooserLike {
  setFiles(files: string[], options?: { timeout?: number }): Promise<void>
}

export interface FrameLike {

  url(): string
  locator(selector: string): LocatorLike
}

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

  on(event: 'pageerror', cb: (error: unknown) => void): void
  on(event: 'console', cb: (message: ConsoleMessageLike) => void): void

  waitForEvent(event: 'filechooser', options?: { timeout?: number }): Promise<FileChooserLike>
  ariaSnapshot(options?: { mode?: 'ai' | 'default'; timeout?: number }): Promise<string>

  frames(): FrameLike[]
  locator(selector: string): LocatorLike
  getByText(text: string): LocatorLike
  keyboard: { press(key: string): Promise<void> }
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> }
  screenshot(options?: { type?: 'jpeg'; quality?: number; timeout?: number }): Promise<Uint8Array>
  waitForTimeout(ms: number): Promise<void>
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>

  evaluate(fn: unknown, arg?: unknown): Promise<unknown>

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

  pages(): PageLike[]
  newCDPSession(page: PageLike): Promise<CdpSessionLike>
  close(): Promise<void>
}

export interface ElectronBrowserLike {
  contexts(): BrowserContextLike[]
  on(event: 'disconnected', cb: () => void): void
  close(): Promise<void>
}
export type ConnectElectronFn = (port: number) => Promise<ElectronBrowserLike>

function contextPagesOf(context: BrowserContextLike): PageLike[] {
  const raw: unknown = context.pages
  if (typeof raw === 'function') return raw.call(context) as PageLike[]
  return Array.isArray(raw) ? (raw as PageLike[]) : []
}

interface PageIssueWithSeq extends PageIssueLike {
  seq: number
}

/** Cache exact delivered snapshot text and bounded incremental page-error observations. */
interface PageRuntime {
  page: PageLike
  cdp: CdpSessionLike | null

  cdpPromise: Promise<CdpSessionLike> | null
  actionChain: Promise<void>

  lastSnapshotText: string | null

  pageIssues: PageIssueWithSeq[]

  reportedIssueSeq: number

  lastFocusTag: string | null
}

async function defaultConnectElectron(port: number): Promise<ElectronBrowserLike> {
  const { chromium } = await import('playwright-core')
  return await chromium.connectOverCDP(`http://127.0.0.1:${port}`) as unknown as ElectronBrowserLike
}

export interface BrowserServiceDeps {

  cdpPort: number

  consent: { get(): boolean; grant(): void }

  connectElectronFn?: ConnectElectronFn

  createTimeoutMs?: number

  settle?: Partial<SettleTimings>

  onStateChange?: () => void

  focusGuest?: (webContentsId: number) => void | Promise<void>

  shellDocumentUrl?: string
}

export class BrowserService {
  private state: BrowserPagesState = EMPTY_BROWSER_PAGES
  private runtime = new Map<string, PageRuntime>()
  private context: BrowserContextLike | null = null
  private startPromise: Promise<BrowserContextLike> | null = null
  private retiredIds: string[] = []

  private windowPopups = new Map<string, string[]>()
  private readonly deps: BrowserServiceDeps
  private readonly connectElectronFn: ConnectElectronFn
  private readonly createTimeoutMs: number

  private electronBrowser: ElectronBrowserLike | null = null

  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  private pendingCreates: Array<{ id: string; owner: string; url?: string; createdAt: number }> = []

  private readonly registrationWaiters = new Map<string, { resolve: (meta: BrowserPageMeta) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  private readonly mediaResetDone = new WeakSet<object>()

  private readonly closingTargetIds = new Set<string>()

  private readonly ownerChains = new Map<string, Promise<void>>()
  private readonly settleTimings: SettleTimings

  private emulatedColorScheme: 'dark' | 'light' | null = null

  private stateDirty = false
  private stateNotifyTimer: ReturnType<typeof setTimeout> | null = null

  private pageIssueSeq = 0

  private disposed = false

  constructor(deps: BrowserServiceDeps) {
    this.deps = deps
    this.connectElectronFn = deps.connectElectronFn ?? defaultConnectElectron
    this.createTimeoutMs = deps.createTimeoutMs ?? ELECTRON_CREATE_TIMEOUT_MS
    this.settleTimings = { ...DEFAULT_SETTLE_TIMINGS, ...deps.settle }
  }

  private hasConsent(): boolean {
    return this.deps.consent.get()
  }

  grantConsent(): void {
    this.deps.consent.grant()
  }

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

  // Pure read: reconciliation here would create a title-change notification feedback loop.
  getStatus() {

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

  /** Capture download provenance before a guest closes or changes owners. */
  ownerForWebContents(webContentsId: number): string | undefined {
    return this.state.pages.find(page => page.webContentsId === webContentsId)?.owner
  }

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

  // Attach to the existing shell; never close the remote Browser to dispose this service.
  private async connectElectron(port: number): Promise<BrowserContextLike> {
    const browser = await this.connectElectronFn(port)
    const context = browser.contexts()[0]
    if (!context) {

      throw new Error('electron browser exposes no default context')
    }
    this.electronBrowser = browser
    this.context = context
    context.on('page', (page) => {

      try { this.skipForeignTarget(page) } catch {   }
    })
    browser.on('disconnected', () => this.handleProcessExit())

    this.reconcileTimer = setInterval(() => {
      const current = this.context
      if (!current) return
      try { this.reconcile(current) } catch {   }
    }, ELECTRON_RECONCILE_INTERVAL_MS)
    this.reconcileTimer.unref()
    try { this.reconcile(context) } catch {   }
    return context
  }

  async reconcileElectronTargets(): Promise<void> {
    const context = await this.ensureStarted()
    try { this.reconcile(context) } catch {   }
  }

  private isShellWindowUrl(url: string): boolean {
    const shellDocumentUrl = this.deps.shellDocumentUrl
    if (shellDocumentUrl !== undefined && isSameDocumentUrl(url, shellDocumentUrl)) return true
    return url.startsWith('file://')
  }

  // Register only marker/seen pages; exclude the shell, foreign popups and closing targets.
  private reconcile(context: BrowserContextLike): void {
    const present = contextPagesOf(context)

    for (const [id, rt] of [...this.runtime]) {
      if (!present.includes(rt.page)) this.handlePageClosed(id)
    }

    for (const page of present) {
      let known = false
      for (const rt of this.runtime.values()) if (rt.page === page) { known = true; break }
      if (known) continue
      const url = page.url()
      if (this.isShellWindowUrl(url)) { this.resetForeignPageEmulation(page); continue }
      const marker = parseMarkerUrl(url)

      if (!marker || this.closingTargetIds.has(marker.pageId) || this.retiredIds.includes(marker.pageId)) { this.resetForeignPageEmulation(page); continue }
      if (pageById(this.state, marker.pageId) && this.runtime.has(marker.pageId)) continue
      this.registerRuntimePage(page, marker.owner, marker.pageId)
    }

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

        if (title === null) return
        if (this.runtime.get(id)?.page !== rt.page) return
        const cur = pageById(this.state, id)
        if (cur && cur.title !== title) {
          this.state = updatePageNav(this.state, id, cur.url, title)
          this.notifyState()
        }
      }).catch(() => {   })
    }
  }

  // Register before pending navigation so the renderer cannot race away from the marker.
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

    page.on('pageerror', (error) => {
      this.recordPageIssue(id, 'error', error instanceof Error ? error.message : String(error))
    })
    page.on('console', (message) => {
      try {
        if (message?.type?.() === 'error') this.recordPageIssue(id, 'console', String(message.text?.() ?? ''))
      } catch {   }
    })

    this.resetForeignPageEmulation(page)
    if (this.emulatedColorScheme) void this.applyColorSchemeTo(this.runtime.get(id)!).catch(() => {})

    const pending = pageById(this.state, id)?.pendingNavigate
    if (pending) {
      this.state = setPendingNavigate(this.state, id, null)
      this.notifyState()
      void page.goto(pending, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => {   })
    }

    const waiter = this.registrationWaiters.get(id)
    if (waiter) {
      this.registrationWaiters.delete(id)
      clearTimeout(waiter.timer)
      this.pendingCreates = this.pendingCreates.filter((p) => p.id !== id)
      waiter.resolve(pageMeta(pageById(this.state, id)!))
    }
    return pageMeta(pageById(this.state, id)!)
  }

  // Clear Playwright media overrides for foreign targets; panel pages retain app-owned emulation.
  private skipForeignTarget(page: PageLike): void {
    for (const rt of this.runtime.values()) {
      if (rt.page === page) return
    }
    if (page.isClosed()) return
    this.resetForeignPageEmulation(page)
  }

  // A renderer seen report can arrive before its CDP target; reconciliation completes the binding.
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

    const navigateTo = entry.navigateTo && isAllowedNavigationUrl(entry.navigateTo) ? entry.navigateTo : undefined
    // Handshake latency: a seen report IS the guest's dom-ready — when a
    // createPage waiter is parked on a marker page, reconcile NOW instead of
    // waiting for the 1s tick (the marker target is already in
    // context.pages()). Gated on waiters so ordinary seen refreshes add no
    // reconcile load.
    if (this.registrationWaiters.size > 0) void this.reconcileElectronTargets().catch(() => {})
    const existing = pageById(this.state, id)
    if (existing) {

      if (webContentsId !== undefined) {
        this.state = setPageWebContentsId(this.state, id, webContentsId)
        this.notifyState()
      }
      if (navigateTo) {
        const rt = this.runtime.get(id)

        if (rt) void rt.page.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => {})
        else {
          this.state = setPendingNavigate(this.state, id, navigateTo)
          this.notifyState()
        }
      }

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

  // Page creation is a renderer handshake, never context.newPage or Target.createTarget.
  async createPage(owner: string, url?: string): Promise<BrowserPageMeta> {
    await this.ensureStarted()
    if (url !== undefined && !isAllowedNavigationUrl(url)) throw new NavigationBlockedError(url)
    let lastError: unknown = null
    for (let attempt = 1; attempt <= ELECTRON_CREATE_ATTEMPTS; attempt++) {
      try {
        const meta = await this.awaitHostHandshake(owner, url)

        const rt = this.requireRuntime(meta.id)
        if (url && url !== 'about:blank') await rt.page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS })
        return pageMeta(pageById(this.state, meta.id)!)
      } catch (error) {
        lastError = error

        if (!(error instanceof BrowserHostUnavailableError) || !error.retryable) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new BrowserHostUnavailableError()
  }

  // Retry a fresh marker only after timeout; retired IDs must never re-enter the registry.
  private awaitHostHandshake(owner: string, url?: string): Promise<BrowserPageMeta> {

    const id = createBrowserPageId()
    return new Promise<BrowserPageMeta>((resolve, reject) => {

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

  bumpInteractionByWebContentsId(webContentsId: number): void {
    if (this.disposed) return
    const rec = this.state.pages.find((p) => p.webContentsId === webContentsId)
    if (rec) {
      this.state = bumpInteraction(this.state, rec.id)
      this.notifyState()
    }
  }

  noteWindowPopup(openerWebContentsId: number, url: string): void {
    if (this.disposed) return
    const opener = this.state.pages.find((p) => p.webContentsId === openerWebContentsId)
    if (!opener || opener.owner === HUMAN_OWNER) return
    const list = this.windowPopups.get(opener.owner) ?? []
    list.push(url)
    this.windowPopups.set(opener.owner, list)
  }

  private drainWindowPopups(owner: string): string[] {
    const list = this.windowPopups.get(owner)
    if (!list || list.length === 0) return []
    this.windowPopups.delete(owner)
    return list
  }

  async closePage(id: string): Promise<void> {
    // A row can close before its guest registers. Cancel that handshake too:
    // leaving it pending would materialize the closed page on the next pane mount.
    const waiter = this.registrationWaiters.get(id)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.registrationWaiters.delete(id)
      this.pendingCreates = this.pendingCreates.filter((page) => page.id !== id)
      waiter.reject(new PageGoneError(id))
      this.notifyState()
    }
    this.closingTargetIds.add(id)
    this.handlePageClosed(id)

    if (pageById(this.state, id)) {
      this.state = removePage(this.state, id)
      this.notifyState()
    }
    // Include unregistered rows so late seen/marker arrivals stay closed.
    if (!this.retiredIds.includes(id)) this.retire(id)

    const timer = setTimeout(() => this.closingTargetIds.delete(id), ELECTRON_RECONCILE_INTERVAL_MS * 2)
    timer.unref()
  }

  // Reload in the guest context. CDP Page.reload can destroy a guest or hit the shell.
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

      waiter.reject(new BrowserHostUnavailableError(false))
    }
    this.pendingCreates = []
    this.closingTargetIds.clear()

    this.windowPopups.clear()
    for (const rt of this.runtime.values()) void rt.cdp?.detach().catch(() => { /* connection gone */ })
    for (const id of this.runtime.keys()) this.retire(id)
    this.ownerChains.clear()
    this.runtime.clear()
    this.state = clearAllPages()
    this.notifyState()
    this.context = null

    this.electronBrowser = null
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  // Memoize concurrent session creation; clear a rejected attempt so a later call can retry.
  private ensureCdp(rt: PageRuntime): Promise<CdpSessionLike> {
    if (rt.cdp) return Promise.resolve(rt.cdp)
    if (rt.cdpPromise) return rt.cdpPromise
    const promise = (async () => {

      const context = this.context
      if (!context) throw new BrowserHostUnavailableError()
      const cdp = await context.newCDPSession(rt.page)
      rt.cdp = cdp
      return cdp
    })()
    rt.cdpPromise = promise

    promise.catch(() => {
      if (rt.cdpPromise === promise) rt.cdpPromise = null
    })
    return promise
  }

  // Clear connection defaults once per Page identity, without touching registered panel themes.
  private resetForeignPageEmulation(page: PageLike): void {
    if (this.mediaResetDone.has(page) || typeof page.emulateMedia !== 'function') return
    this.mediaResetDone.add(page)
    void page.emulateMedia({ colorScheme: null, reducedMotion: null, forcedColors: null }).catch(() => {   })
  }

  // Replay app color-scheme media after connection defaults and for newly registered guests.
  private async applyColorSchemeTo(rt: PageRuntime): Promise<void> {
    if (!this.emulatedColorScheme || !this.context) return
    const cdp = await this.ensureCdp(rt)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: this.emulatedColorScheme }],
    })
  }

  async setColorScheme(scheme: 'dark' | 'light'): Promise<void> {
    if (scheme !== 'dark' && scheme !== 'light') return
    this.emulatedColorScheme = scheme
    if (!this.context) return
    await Promise.all([...this.runtime.values()].map((rt) => this.applyColorSchemeTo(rt).catch(() => {})))
  }

  // Serialize actions per page and clear agentBusy in finally, including failures.
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

  // Serialize owner page creation so concurrent getOrCreate calls cannot duplicate guests.
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

  /** Observe quiet mutation windows or navigation under a shared deadline.
   * A hung sample returns null, never reuses an earlier zero as a completed result. */
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
      try { url = page.url() } catch {   }
      if (url !== startedUrl) {
        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return { mutations, navigating: true }
      }

      const outcome = await this.sampleMutations(page, sampleMs, Math.max(1, deadline - Date.now()))
      if (outcome.status === 'error') {

        await page.waitForLoadState('domcontentloaded', { timeout: navLoadStateMs }).catch(() => {})
        return { mutations, navigating: true }
      }
      if (outcome.status === 'timeout' || !Number.isFinite(outcome.value)) {

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

  private recordPageIssue(id: string, kind: PageIssueLike['kind'], text: string): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, PAGE_ISSUE_TEXT_MAX)
    if (!clean) return
    if (rt.pageIssues.some((issue) => issue.kind === kind && issue.text === clean)) return
    rt.pageIssues.push({ seq: ++this.pageIssueSeq, kind, text: clean })
    if (rt.pageIssues.length > MAX_PAGE_ISSUES) rt.pageIssues.shift()
  }

  private drainNewPageIssues(rt: PageRuntime): PageIssueWithSeq[] {
    const fresh = rt.pageIssues.filter((issue) => issue.seq > rt.reportedIssueSeq)
    if (fresh.length > 0) rt.reportedIssueSeq = fresh[fresh.length - 1].seq
    return fresh
  }

  private pageIssueNotes(rt: PageRuntime): string[] {
    const issues = this.drainNewPageIssues(rt)
    return issues.length > 0 ? [pageIssuesNote(issues)] : []
  }

  /** Separate timeout from destroyed-document errors; consume late rejections
   * so a hung page cannot retain the page lock indefinitely. */
  private async evaluateWithBudget<T>(
    page: PageLike,

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

  private async evaluateBounded<T>(
    page: PageLike,
    script: (...args: never[]) => T | Promise<T>,
    arg?: unknown,
    budgetMs = AGENT_ACTION_TIMEOUT_MS,
  ): Promise<T | null> {
    const outcome = await this.evaluateWithBudget<T>(page, script, arg, budgetMs)
    return outcome.status === 'ok' ? outcome.value : null
  }

  // title, keyboard.press and locator.count may have no native timeout; bound them here.
  private async withBudget<T>(run: () => Promise<T>, budgetMs = MEASURE_TIMEOUT_MS): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {

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

  // null means unavailable; registry refreshes must not replace a title with a timeout-derived empty value.
  private async readTitle(page: PageLike): Promise<string | null> {
    const title = await this.evaluateBounded<string>(page, () => document.title, undefined, MEASURE_TIMEOUT_MS)
    return typeof title === 'string' ? title : null
  }

  // Keep invalid syntax distinct from an unresponsive page: callers need different recovery actions.
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

  private async pressKeyBounded(page: PageLike, key: string, budgetMs = AGENT_ACTION_TIMEOUT_MS): Promise<void> {
    const pressed = await this.withBudget(() => page.keyboard.press(key).then(() => true), budgetMs)
    if (!pressed) {
      throw new Error(`keyboard.press("${key}") did not complete within ${budgetMs}ms — the page may be unresponsive`)
    }
  }

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

  private async emptySnapshotNotes(page: PageLike): Promise<string[]> {
    const diagnostics = await this.measureEmptySnapshot(page)
    return diagnostics ? [emptySnapshotNote(diagnostics)] : []
  }

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

  // Only tag names are trusted observations; labels/placeholders/text are authored by the page.
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

  /** Settle, synchronize navigation, register all raw refs, then deliver one text window.
   * The diff baseline is exactly that window. No-change requires both a complete
   * zero-mutation observation and an unchanged delivered accessibility snapshot. */
  private async captureAgentSnapshot(
    owner: string,
    pageId: string,
    opts: { maxChars?: number; offset?: number; expectChange?: boolean } = {},
  ): Promise<{ ingested: IngestedSnapshot; url: string; title: string; windowPopups: string[]; extraNotes: string[] }> {
    const rt = this.requireRuntime(pageId)

    const settled = await this.settleForSnapshot(rt.page).catch(() => ({ mutations: null, navigating: false }) as SettleOutcome)

    const url = (() => {
      try { return rt.page.url() } catch { return '' }
    })()
    const title = (await this.readTitle(rt.page)) ?? ''
    this.state = updatePageNav(this.state, pageId, url, title)
    this.notifyState()
    const raw = await rt.page.ariaSnapshot({ mode: 'ai', timeout: AGENT_SNAPSHOT_TIMEOUT_MS })

    this.state = recordSnapshot(this.state, pageId, [...parseSnapshotRefs(raw)])
    this.notifyState()
    const previousVisible = rt.lastSnapshotText
    const ingested = ingestSnapshot(raw, opts.maxChars, opts.offset)

    rt.lastSnapshotText = ingested.visible

    const treeChanged = previousVisible === null || previousVisible !== ingested.visible

    const extraNotes: string[] = [
      ...(raw.trim() === '' ? await this.emptySnapshotNotes(rt.page) : []),
      ...this.pageIssueNotes(rt),
      ...(opts.expectChange && settled.mutations === 0 && !treeChanged ? [noDomChangeNote()] : []),
    ]
    return { ingested, url, title, windowPopups: this.drainWindowPopups(owner), extraNotes }
  }

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

  private truncationNotes(ingested: IngestedSnapshot, diff: boolean): string[] {

    if (ingested.totalChars > 0 && ingested.visible.length === 0 && ingested.offset >= ingested.totalChars) {
      return [snapshotOffsetPastEndNote(ingested.offset, ingested.totalChars)]
    }
    if (!ingested.truncated) return []
    return [diff ? snapshotBeyondCapNote(ingested) : snapshotTruncationNote(ingested)]
  }

  private async resolveScopedLocator(page: PageLike, selector: string): Promise<LocatorLike> {
    const base = page.locator(selector)

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

  // Validate ref syntax, ownership, snapshot generation and membership before calling Playwright.
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

  private async resolveTarget(
    owner: string,
    target: TargetSpec,
  ): Promise<{ pageId: string; locator: LocatorLike; note: string | null }> {
    if (target.kind === 'ref') {
      const { pageId, locator } = this.resolveRef(owner, target.ref)
      return { pageId, locator, note: null }
    }
    if (target.kind === 'ax') {

      throw new AxTargetError('ax targets are resolved through the accessibility tree, not through a locator')
    }
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    const page = this.requireRuntime(pageId).page
    const found = await this.resolveSelectorTarget(page, target.selector)
    return { pageId, locator: found.locator, note: found.note }
  }

  /** Search bounded frames, preferring a unique visible match, then a unique hidden
   * match (for file inputs). Ambiguity is an error; closed shadow roots require AX. */
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

  /** Read AX nodes and fresh layout boxes, then verify each candidate point before
   * dispatching real pointer events. Occluded controls fail without a click.
   * Closed shadow-root typing still requires the ref/selector path. */
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

  private async tryCdp<T>(
    cdp: CdpSessionLike,
    method: string,
    params: Record<string, unknown> = {},
    budgetMs = MEASURE_TIMEOUT_MS,
  ): Promise<T | null> {
    return await this.withBudget(() => cdp.send(method, params) as Promise<T>, budgetMs)
  }

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

  // The sole DOM.getNodeForLocation use verifies AX hits inside closed shadow roots; coordinates are integers.
  private async cdpNodeAt(cdp: CdpSessionLike, x: number, y: number): Promise<number | null> {
    const hit = await this.tryCdp<CdpNodeLocation>(cdp, 'DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true }, MEASURE_TIMEOUT_MS)
    if (!hit) return null
    if (typeof hit.backendNodeId === 'number') return hit.backendNodeId
    return typeof hit.nodeId === 'number' ? hit.nodeId : null
  }

  // A hit on the control or an internal child is valid; climb a bounded ancestor chain.
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

  // In-guest location.reload avoids the unsafe CDP Page.reload path.
  private async reloadGuest(page: PageLike): Promise<void> {
    const url = page.url()
    if (url && isAllowedNavigationUrl(url) && !parseMarkerUrl(url)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: AGENT_NAV_TIMEOUT_MS }).catch(() => {})
      return
    }
    await this.evaluateBounded(page, () => { location.reload() }, undefined, MEASURE_TIMEOUT_MS)
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  }

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

    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {

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

      const prev = opts?.diff ? this.requireRuntime(pageId).lastSnapshotText : null
      const captured = await this.captureAgentSnapshot(owner, pageId, { maxChars: opts?.maxChars, offset: opts?.offset })

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

          ...(notes.length > 0 ? { snapshotNote: notes.join('\n') } : { snapshotNote: undefined }),
        }
      }
      return base
    })
  }

  async agentClickRef(owner: string, ref: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickTarget(owner, { kind: 'ref', ref }, window)
  }

  async agentClickSelector(owner: string, selector: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickTarget(owner, { kind: 'selector', selector }, window)
  }

  private async clickTarget(owner: string, target: TargetSpec, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    const label = targetLabel(target)
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page

      const guard = this.armPickerGuard(page)
      const click = locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      const winner = await Promise.race([
        click.then(() => 'click' as const),
        guard.done.then(() => (guard.opened() ? 'picker' as const : 'click' as const)),
      ])
      if (winner === 'picker') {

        click.catch(() => { /* replaced by FilePickerInsteadOfClickError */ })
        throw new FilePickerInsteadOfClickError(label)
      }
      await click
      const result = await this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })

      if (guard.opened()) throw new FilePickerInsteadOfClickError(label)
      return result
    })
  }

  async agentClickAx(owner: string, ax: AxTarget, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.clickAxTarget(owner, ax, window)
  }

  private async clickAxTarget(owner: string, ax: AxTarget, window?: TargetWindowOpts): Promise<AgentActionResult> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const resolved = await this.resolveAxTarget(rt, ax, 'click')

      const guard = this.armPickerGuard(rt.page)
      await this.dispatchPointer(rt, resolved.point, 'click')
      const result = await this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), resolved.note] })
      if (guard.opened()) throw new FilePickerInsteadOfClickError(targetLabel({ kind: 'ax', ax }))
      return result
    })
  }

  // Subscribe before clicking to enable interception; an opened chooser cannot select files for a click tool.
  private armPickerGuard(page: PageLike): { opened: () => boolean; done: Promise<void> } {
    let opened = false
    const done = page.waitForEvent('filechooser', { timeout: CLICK_PICKER_GUARD_MS })
      .then(() => { opened = true }, () => {   })
    return { opened: () => opened, done }
  }

  async agentUpload(owner: string, ref: string, files: string[], window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.uploadTarget(owner, { kind: 'ref', ref }, files, window)
  }

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

        await locator.setInputFiles(files, { timeout: AGENT_ACTION_TIMEOUT_MS })
      } else {
        await this.uploadViaFilePicker(page, locator, label, files)
      }
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), uploadNote(files), note] })
    })
  }

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

  // Filechooser subscription enables CDP interception; arm it before the real click.
  private async uploadViaFilePicker(
    page: PageLike,
    locator: LocatorLike,
    label: string,
    files: string[],
  ): Promise<void> {
    const chooser = page.waitForEvent('filechooser', { timeout: AGENT_ACTION_TIMEOUT_MS })

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

  async agentTypeSelector(owner: string, selector: string, text: string, submit = false, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.typeTarget(owner, { kind: 'selector', selector }, text, submit, window)
  }

  // Focus and select all through real events, then pressSequentially; never use fill.
  private async typeTarget(
    owner: string,
    target: TargetSpec,
    text: string,
    submit: boolean,
    window?: TargetWindowOpts,
  ): Promise<AgentActionResult> {

    if (text.length > TYPE_TEXT_MAX_CHARS) throw new TypeTextTooLongError(text.length)
    const { pageId, locator, note } = await this.resolveTarget(owner, target)
    return this.withPageLock(pageId, async () => {

      await this.focusGuestForKeys(pageId)

      const page = this.requireRuntime(pageId).page
      await locator.click({ timeout: AGENT_ACTION_TIMEOUT_MS, force: true })
      await this.pressKeyBounded(page, 'ControlOrMeta+A')
      if (text) await locator.pressSequentially(text, { timeout: AGENT_ACTION_TIMEOUT_MS })
      if (submit) await this.pressKeyBounded(page, 'Enter')
      return this.finishAgentAction(owner, pageId, { ...window, notes: [...(window?.notes ?? []), note] })
    })
  }

  async agentHoverRef(owner: string, ref: string, window?: SnapshotWindowOpts): Promise<AgentActionResult> {
    return this.hoverTarget(owner, { kind: 'ref', ref }, window)
  }

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

  // CDP pointer coordinates use main-frame viewport CSS pixels, independent of host CSS zoom.
  private async dispatchPointer(rt: PageRuntime, point: PointLike, kind: 'click' | 'hover'): Promise<void> {
    const cdp = await this.ensureCdp(rt)
    const base = { x: point.x, y: point.y, button: 'left' }
    const events = kind === 'hover'
      ? [{ type: 'mouseMoved', ...base }]

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

      const focusNote = await this.readFocusChange(rt)
      return this.finishAgentAction(owner, pageId, { ...window, notes: [focusNote] })
    })
  }

  // Use CDP wheel input; verify movement and fall back to guest scrollBy when the wheel has no effect.
  async agentScroll(owner: string, opts: { deltaX?: number; deltaY?: number; ref?: string } & SnapshotWindowOpts): Promise<AgentActionResult> {
    if (opts.ref !== undefined) {
      const { pageId, locator } = this.resolveRef(owner, opts.ref)
      return this.withPageLock(pageId, async () => {
        await locator.scrollIntoViewIfNeeded({ timeout: AGENT_ACTION_TIMEOUT_MS })

        const position = await this.readScrollPosition(this.requireRuntime(pageId).page)

        return this.finishAgentAction(owner, pageId, { ...opts, notes: [position ? scrollPositionNote(position) : null], expectChange: false })
      })
    }
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const rt = this.requireRuntime(pageId)
      const cdp = await this.ensureCdp(rt)

      const before = await this.evaluateBounded<number[]>(rt.page, () => [window.scrollX, window.scrollY], undefined, MEASURE_TIMEOUT_MS)
      const size = await this.evaluateBounded<number[]>(rt.page, () => [window.innerWidth, window.innerHeight], undefined, MEASURE_TIMEOUT_MS)

      if (size && Number.isFinite(size[0]) && Number.isFinite(size[1])) {

        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(size[0] / 2), y: Math.round(size[1] / 2),
          deltaX: opts.deltaX ?? 0, deltaY: opts.deltaY ?? 0,
        })
        await rt.page.waitForTimeout(150)
      }
      const after = await this.evaluateBounded<number[]>(rt.page, () => [window.scrollX, window.scrollY], undefined, MEASURE_TIMEOUT_MS)
      if (before && after && after[0] === before[0] && after[1] === before[1]) {

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

      const condTimeoutMs = Math.min(Math.max((opts.timeout ?? 5) * 1000, 500), 30_000)
      if (typeof opts.delay === 'number' && Number.isFinite(opts.delay)) {

        await page.waitForTimeout(Math.max(0, Math.min(opts.delay, 30)) * 1000)
      }

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

  // Annotation is optional and bounded; any measurement/composition failure returns the original JPEG.
  async agentScreenshot(owner: string, opts?: { annotate?: boolean }): Promise<{ pageId: string; jpegBase64: string; labels: number; annotated: boolean }> {
    const pageId = this.agentActivePageId(owner)
    if (!pageId) throw new StaleSnapshotError('no active page; call browser_navigate first')
    return this.withPageLock(pageId, async () => {
      const page = this.requireRuntime(pageId).page

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
      const refs = (rec?.snapshot?.refs ?? []).slice(0, 50)
      const items: Array<{ ref: string; x: number; y: number; width: number; height: number }> = []

      const annotateDeadline = Date.now() + AGENT_ACTION_TIMEOUT_MS
      for (const ref of refs) {
        const remaining = annotateDeadline - Date.now()
        if (remaining <= 0) break
        const box = await page.locator(`aria-ref=${ref}`).boundingBox({ timeout: remaining }).catch(() => null)
        if (box && box.width > 0 && box.height > 0) items.push({ ref, ...box })
      }
      if (items.length === 0) return fallback()

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

  // Human annotation uses in-guest elementFromPoint; CDP hit testing is unreliable after guest navigation.
  async resolveElementAt(id: string, x: number, y: number): Promise<ElementAtInfo | null> {
    const rt = this.requireRuntime(id)

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

  // Intentionally do not call electronBrowser.close(): it can send CDP Browser.close and exit the shell.
  dispose(): void {
    this.disposed = true
    this.handleProcessExit()
    this.clearStateNotify()

  }
}

let instance: BrowserService | null = null

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
