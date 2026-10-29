/** Pure browser helpers shared by main, preload and renderer. Guest markers encode owner/pageId in the initial URL fragment for CDP target registration. */
import { parse as parseDomain } from 'tldts'

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

/** Page IDs use p- followed by eight base-36 digits; both marker materializers share this generator. */
export function createBrowserPageId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`
}

/** Bare host:port input: hostname, IPv4 or bracketed IPv6; local development servers normally use HTTP. */
const BARE_HOST_PORT_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\d+)([/?#].*)?$/
const BARE_IPV4_PORT_RE = /^\d{1,3}(\.\d{1,3}){3}:\d+([/?#].*)?$/
const BARE_IPV6_PORT_RE = /^\[[0-9a-fA-F:]+\]:\d+([/?#].*)?$/

function looksLikeBareHostPort(trimmed: string): boolean {
  return BARE_HOST_PORT_RE.test(trimmed) || BARE_IPV4_PORT_RE.test(trimmed) || BARE_IPV6_PORT_RE.test(trimmed)
}

/** Normalize user input, or return null. Bare domains default to HTTPS; bare host:port defaults to HTTP. */
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

/** Main-frame navigation permits HTTP, HTTPS and about:blank fragments. Chrome gates window.open schemes separately; every user/agent URL entry passes this allowlist. */
export function isAllowedNavigationUrl(url: string): boolean {
  if (url === 'about:blank' || url.startsWith('about:blank#')) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export const BROWSER_SEARCH_ENGINES = ['google', 'bing', 'duckduckgo', 'baidu'] as const
export type BrowserSearchEngine = typeof BROWSER_SEARCH_ENGINES[number]
export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = 'google'

export function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
  return BROWSER_SEARCH_ENGINES.some((engine) => engine === value)
}

const SEARCH_ENDPOINTS: Record<BrowserSearchEngine, { url: string; parameter: string }> = {
  google: { url: 'https://www.google.com/search', parameter: 'q' },
  bing: { url: 'https://www.bing.com/search', parameter: 'q' },
  duckduckgo: { url: 'https://duckduckgo.com/', parameter: 'q' },
  baidu: { url: 'https://www.baidu.com/s', parameter: 'wd' }
}

function browserSearchUrl(query: string, engine: BrowserSearchEngine): string {
  const endpoint = SEARCH_ENDPOINTS[isBrowserSearchEngine(engine) ? engine : DEFAULT_BROWSER_SEARCH_ENGINE]
  const url = new URL(endpoint.url)
  url.searchParams.set(endpoint.parameter, query)
  return url.toString()
}

/** Human omnibox input only. Agent navigation and links retain URL-only semantics.
 * Explicit URL schemes still pass the navigation allowlist; search operators
 * are queries. Bare domains, IPs, localhost and development host:port stay URLs. */
export function resolveBrowserInput(input: string, engine: BrowserSearchEngine = DEFAULT_BROWSER_SEARCH_ENGINE): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Omnibox's explicit search escape makes domain-shaped queries unambiguous.
  if (trimmed.startsWith('?')) {
    const query = trimmed.slice(1).trim()
    return query ? browserSearchUrl(query, engine) : null
  }
  const searchOperator = /^(?:site|inurl|allinurl|intitle|allintitle|intext|allintext|filetype|before|after|related|cache):/i.test(trimmed)
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  const explicitScheme = scheme && !searchOperator &&
    (/^(?:https?|about|file|data|javascript|view-source|blob|ftp|mailto|tel|chrome(?:-extension)?|devtools|wss?|vbscript)$/i.test(scheme[1]) || trimmed.slice(scheme[0].length).startsWith('//'))
  const bareHostPort = !searchOperator && looksLikeBareHostPort(trimmed)
  const authority = trimmed.split(/[/?#]/, 1)[0]
  const candidate = normalizeNavigationUrl(/^localhost(?:[/?#]|$)/i.test(trimmed) ? `http://${trimmed}` : trimmed)
  if (explicitScheme || bareHostPort) {
    return candidate && isAllowedNavigationUrl(candidate) ? candidate : null
  }
  if (!searchOperator && candidate && !/\s/.test(authority)) {
    const parsed = new URL(candidate)
    // The Public Suffix List avoids interpreting code-like text such as
    // console.log as a domain; IDNs, IPs and special-use hosts stay supported.
    const host = parseDomain(parsed.hostname, { detectSpecialUse: true })
    const recognizedHost = host.isIp ||
      (parsed.hostname.includes('.') && (host.isIcann || host.isSpecialUse)) ||
      parsed.hostname === 'localhost'
    if (!parsed.username && !parsed.password && recognizedHost) {
      return isAllowedNavigationUrl(candidate) ? candidate : null
    }
  }
  return browserSearchUrl(trimmed, engine)
}

export interface BrowserPageMeta {
  id: string
  owner: string
  url: string
  title: string
  agentBusy: boolean
  crashed: boolean
}

/** Coordinate-selected element metadata for human annotations. */
export interface ElementAtInfo {
  tag: string
  text: string
  path: string
  box: { x: number; y: number; width: number; height: number }
}

// Shared browser event and reverse-report payloads prevent main/renderer type drift.
// Main emits these events and the renderer consumes them.

/** Tab popups inherit opener ownership and arrive through browser:popup. Window-feature popups become real BrowserWindows outside the pane registry and event surface. */
export interface BrowserPopupInfo {
  url: string
  openerWebContentsId: number
}

/** Browser-partition download completion/failure. Main supplies diagnostic error data; the pane displays a localized failure message instead of passing it through. */
export interface BrowserDownloadInfo {
  path: string
  filename: string
  error?: string
}

/** Browser-owned keys intercepted while the guest has focus (⌘±/0, ⌘F, ⌘P). */
export interface BrowserGuestShortcutInfo {
  key: string
  /** Full shortcut identity in renderer bindingIdentity form. An overlapping app binding may forward to the app dispatcher when the pane is inactive. */
  identity?: string
}

/** App shortcuts intercepted during guest focus. The renderer publishes binding identities through browser:setAppShortcuts; matches forward to its dispatcher. */
export interface BrowserGuestAppShortcutInfo {
  identity: string
  repeat: boolean
}

/** browser:seen reports an unknown guest for state registration, wcId mapping and pending agent-popup navigation. */
export interface BrowserSeenPayload {
  id: string
  owner: string
  url: string
  webContentsId?: number
  navigateTo?: string
}

/** Main requests renderer <webview> focus and waits for browser:focus-guest-done before sending keys. Only element focus prevents CDP input from leaking to shell shortcuts; webContents.focus() and Page.bringToFront do not change shell DOM focus. */
export interface BrowserFocusGuestPayload {
  webContentsId: number
  requestId: number
}

/** Compare document URLs without query, fragment or trailing slash. The development shell URL lacks the trailing slash that page.url() adds; navigation.ts uses the same normalization. */
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
