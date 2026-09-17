/**
 * 内嵌浏览器面板状态（useSyncExternalStore 源）。window.pi 的 browser:state/popup/download
 * 订阅在组件挂载时接线（popup.ts / Task 7），本类只收敛状态：同一个 state 对象在两次
 * 通知之间保持引用稳定（useSyncExternalStore 的要求），变更时整体替换。
 * popups/downloads 队列与本地乐观页语义照 pi-web BrowserTab 的 popup 队列/localPages
 * （乐观页 = createPage 往返期间的本地占位行，服务端列表覆盖后由面板派生时剔除），
 * 收进 store 便于 node 直测。无模块级 window 访问——全部惰性到调用点。
 */
import { buildMarkerUrl, HUMAN_OWNER } from '../../../../shared/browser.ts'
import type { BrowserPageMeta } from '../../../../shared/browser.ts'
import type { BrowserStatusDTO } from '../../../../shared/types.ts'

/** 面板行：服务端页 meta + 本地占位标记（pending = createPage 往返/pendingCreate 物化中）。 */
export interface BrowserPanePage extends BrowserPageMeta { pending?: boolean }

export interface BrowserPopupInfo {
  url: string
  openerWebContentsId: number
}

export interface BrowserDownloadInfo {
  path: string
  filename: string
  /** 下载失败完成时的原因（main 侧数据；面板只显示本地化文案，不透传该串）。 */
  error?: string
}

export interface BrowserPaneState {
  status: BrowserStatusDTO | null
  popups: BrowserPopupInfo[]
  downloads: BrowserDownloadInfo[]
  /** 本地乐观占位页（createPage 往返期间的行；不在服务端列表里）。 */
  optimistic: BrowserPanePage[]
}

/** 下载条目环形容量：面板只关心最近几条完成提示。 */
export const BROWSER_DOWNLOADS_LIMIT = 5

const EMPTY_STATE: BrowserPaneState = { status: null, popups: [], downloads: [], optimistic: [] }

function optimisticPage(id: string): BrowserPanePage {
  return {
    id,
    owner: HUMAN_OWNER,
    url: buildMarkerUrl(HUMAN_OWNER, id),
    title: '',
    agentBusy: false,
    crashed: false,
    pending: true,
  }
}

export class BrowserStore {
  private state: BrowserPaneState = EMPTY_STATE
  private listeners = new Set<() => void>()

  // 绑定且稳定的引用（TerminalStore 同款的类字段箭头函数）：面板把
  // store.subscribe / store.getState 直接交给 useSyncExternalStore——内联
  // 箭头包装每次渲染都是新函数，React 会随之退订再重订。
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getState = (): BrowserPaneState => this.state

  /** 服务端状态推送：同一引用（轮询反复派生的同值）不通知。 */
  applyStatus(status: BrowserStatusDTO): void {
    if (this.state.status === status) return
    this.replace({ status })
  }

  pushPopup(p: BrowserPopupInfo): void {
    this.replace({ popups: [...this.state.popups, p] })
  }

  /** 取走并清空 popup 队列（面板挂载时与事件触发时各 drain 一次）。 */
  drainPopups(): BrowserPopupInfo[] {
    if (this.state.popups.length === 0) return []
    const drained = this.state.popups
    this.replace({ popups: [] })
    return drained
  }

  /** 环形 ≤5：保留最新 BROWSER_DOWNLOADS_LIMIT 条。 */
  pushDownload(d: BrowserDownloadInfo): void {
    this.replace({ downloads: [...this.state.downloads, d].slice(-BROWSER_DOWNLOADS_LIMIT) })
  }

  // ---- 本地乐观页（createPage 往返期间的占位）----

  /** 新增占位行；同 id 重复添加保持原状（不通知）。 */
  addOptimistic(id: string): void {
    if (this.state.optimistic.some((p) => p.id === id)) return
    this.replace({ optimistic: [...this.state.optimistic, optimisticPage(id)] })
  }

  /** createPage 往返完成（服务端注册表已收下该页）：占位行解除 pending 标记。 */
  resolveOptimistic(id: string): void {
    const idx = this.state.optimistic.findIndex((p) => p.id === id)
    if (idx === -1 || !this.state.optimistic[idx].pending) return
    const next = [...this.state.optimistic]
    next[idx] = { ...next[idx], pending: false }
    this.replace({ optimistic: next })
  }

  /** 移除占位行（createPage 失败/被关闭；服务端列表覆盖后由面板派生时剔除）。 */
  removeOptimistic(id: string): void {
    if (!this.state.optimistic.some((p) => p.id === id)) return
    this.replace({ optimistic: this.state.optimistic.filter((p) => p.id !== id) })
  }

  private replace(patch: Partial<BrowserPaneState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb()
  }
}
