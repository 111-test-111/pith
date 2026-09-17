/** 内嵌浏览器共享纯模块（同构，无 node 依赖——main/preload/renderer 共用）。
 *  marker 编解码：renderer 建 guest webview 时把 owner/pageId 编进初始 URL fragment，
 *  主进程经 CDP 发现 target 时据此登记归属与 id。 */

export const BROWSER_PARTITION = 'persist:pith-browser'
export const BROWSER_MARKER_PREFIX = 'about:blank#pith/'
export const HUMAN_OWNER = 'human'

export function agentOwner(sessionId: string): string {
  return `agent:${sessionId}`
}

export function buildMarkerUrl(owner: string, pageId: string): string {
  return `${BROWSER_MARKER_PREFIX}${owner}/${pageId}`
}

export function parseMarkerUrl(url: string): { owner: string; pageId: string } | null {
  if (!url.startsWith(BROWSER_MARKER_PREFIX)) return null
  const rest = url.slice(BROWSER_MARKER_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  const owner = rest.slice(0, slash)
  const pageId = rest.slice(slash + 1)
  if (!owner || !pageId) return null
  return { owner, pageId }
}

/** 页面 id：`p-<8位36进制>`（Math.random）；marker 物化端共用。 */
export function createBrowserPageId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`
}

/** 裸 host:port 输入：hostname:port、IPv4:port、[v6]:port（本地 dev server 多为 http）。 */
const BARE_HOST_PORT_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\d+)([/?#].*)?$/
const BARE_IPV4_PORT_RE = /^\d{1,3}(\.\d{1,3}){3}:\d+([/?#].*)?$/
const BARE_IPV6_PORT_RE = /^\[[0-9a-fA-F:]+\]:\d+([/?#].*)?$/

function looksLikeBareHostPort(trimmed: string): boolean {
  return BARE_HOST_PORT_RE.test(trimmed) || BARE_IPV4_PORT_RE.test(trimmed) || BARE_IPV6_PORT_RE.test(trimmed)
}

/** 用户输入 → 规范 URL；无法解析返回 null。裸域名补 https://，裸 host:port 补 http://。 */
export function normalizeNavigationUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed === 'about:blank') return 'about:blank'
  const withScheme = looksLikeBareHostPort(trimmed)
    ? `http://${trimmed}`
    : /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).toString()
  } catch {
    return null
  }
}

/**
 * 主 frame 导航白名单：http:、https:、about:blank（可带 fragment，marker 用）。
 * 弹窗（window.open）不经过这里做 scheme 门控，这是有意的：Chrome 自身会阻止
 * 网页内容把标签页导航到 file:/chrome:/javascript:，而所有用户/agent 驱动的
 * 入口（URL 栏、browser_navigate、goto）都已在此收口。
 */
export function isAllowedNavigationUrl(url: string): boolean {
  if (url === 'about:blank' || url.startsWith('about:blank#')) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export interface BrowserPageMeta {
  id: string
  owner: string
  url: string
  title: string
  agentBusy: boolean
  crashed: boolean
}

/** 坐标点选元素的解析结果（人类批注）。 */
export interface ElementAtInfo {
  tag: string
  text: string
  path: string
  box: { x: number; y: number; width: number; height: number }
}

/** 归一化比较两个文档 URL：剥 hash 与 query、去尾斜杠后比较。
 *  dev 壳文档以无尾斜杠形态传入（ELECTRON_RENDERER_URL），而 page.url() 恒带尾斜杠——
 *  字符串精确匹配永不命中（navigation.ts 的 isOwnDocument 同陷阱同解法）。 */
export function isSameDocumentUrl(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value)
      url.hash = ''
      url.search = ''
      return url.href.replace(/\/$/, '')
    } catch {
      return value.split('#')[0]
    }
  }
  return normalize(a) === normalize(b)
}
