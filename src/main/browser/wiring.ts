/** Electron guest wiring: popup routing, downloads, permissions and input relay.
 * Native popups share browser cookies but receive no preload or Node bridge.
 * Panel ownership follows marker/seen handshakes; forged marker popups are denied.
 * Host constraints and measured exceptions: docs/architecture/embedded-browser.md. */
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

const BROWSER_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

export function decideBrowserPermission(permission: string): boolean {
  return BROWSER_ALLOWED_PERMISSIONS.has(permission)
}

/** Packaged shells use file://; localhost must remain available for project dev servers. */
function isShellDocumentUrl(url: string): boolean {
  return url.startsWith('file://')
}

export function classifyGuestPopup(url: string): 'marker' | 'shell' | 'guest' {
  if (parseMarkerUrl(url) !== null) return 'marker'
  if (isShellDocumentUrl(url)) return 'shell'
  return 'guest'
}

// Relationship-only features such as noopener do not request a native window.
const WINDOW_POPUP_FEATURES = new Set([
  'popup', 'dialog', 'dependent', 'alwaysontop', 'alwaysraised',
  'width', 'height', 'innerwidth', 'innerheight', 'outerwidth', 'outerheight',
  'left', 'top', 'screenx', 'screeny',
  'menubar', 'toolbar', 'location', 'status', 'resizable', 'scrollbars', 'titlebar',
  'minimizable', 'maximizable', 'closable', 'fullscreen',
])

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

/** Native-window disposition wins; default uses window features, other cases open tabs. */
export function popupOpensWindow(disposition: string, features: string): boolean {
  if (disposition === 'new-window') return true
  if (disposition === 'default') return hasWindowFeatures(features)
  return false
}

const POPUP_DEFAULT_SIZE = { width: 800, height: 600 }
const POPUP_MIN_SIZE = { width: 320, height: 240 }

/** Respect bounded sizes, but center in the shell display and ignore requested positions. */
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

/** Share the cookie partition without preload or Node. Popups remain independent
 * top-level windows. sandbox/nativeWindowOpen cannot separate an opener-linked
 * initial about:blank process; the measured CDP auto-attach flash remains documented. */
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

export type BrowserEmit = (channel: string, payload: unknown) => void
/** Capture provenance when a download starts; the returned receipt runs only
 * after completion. Wiring stays independent of archive/settings ownership. */
export type BrowserDownloadCollector = (owner?: string) => ((path: string, url: string) => void) | undefined

// Install listeners once; refresh window/emit references after macOS window recreation.
let wiringInstalled = false
let sessionWired = false
let shellWin: BrowserWindow | null = null
let activeEmit: BrowserEmit | null = null
let activeDownloadCollector: BrowserDownloadCollector | undefined

let markerDropLogged = false
function dropForgedMarker(url: string): void {
  if (markerDropLogged) return
  markerDropLogged = true
  console.error(`[browser] dropped marker URL from window.open: ${url} (further drops silent)`)
}

// Track native popup contents so nested popups inherit guest routing and cleanup.
const popupContents = new Set<number>()

const relayedAt = new Map<number, number>()
const INPUT_RELAY_THROTTLE_MS = 300

// Modified bindings use ordered modifiers plus physical code; bare Escape stays in the page.
let appShortcutIdentities = new Set<string>()

export function setAppShortcutIdentities(identities: unknown): void {
  appShortcutIdentities = new Set(
    Array.isArray(identities)
      ? identities.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
  )
}

function guestInputIdentity(input: { control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string }): string {
  return [
    input.control && 'Control',
    input.alt && 'Alt',
    input.shift && 'Shift',
    input.meta && 'Meta',
    input.code
  ].filter(Boolean).join('+')
}

/** Route native popups separately from renderer-materialized panel tabs. */
function wireContents(contents: WebContents): void {
  // HTML file guests have their own navigation, permissions and shortcuts.
  // They must never inherit the browser's popup or signed-in session behavior.
  if (contents.session === electron().session.fromPartition(HTML_PREVIEW_PARTITION)) return

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

  if (contents.getType() === 'webview' || popupContents.has(contents.id)) {
    // Bind native popup lifetime to its opener and report its URL to the agent service.
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

  // Browser zoom/find/print shortcuts take precedence over guest keydown handlers.
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

      activeEmit?.('browser:guest-shortcut', { key, identity })
      return
    }

    if (appShortcutIdentities.size === 0 || !appShortcutIdentities.has(identity)) return
    event.preventDefault()
    activeEmit?.('browser:guest-app-shortcut', { identity, repeat: !!input.isAutoRepeat })
  })
  contents.once('destroyed', () => {

    contents.removeAllListeners('before-input-event')
    relayedAt.delete(contents.id)
  })
}

/** Downloads require synchronous setSavePath; permissions use a strict allowlist. */
function wireBrowserSession(): void {
  if (sessionWired) return
  sessionWired = true
  const { app, session } = electron()
  const ses = session.fromPartition(BROWSER_PARTITION)

  ses.on('will-download', (_event, item, contents) => {
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
    const owner = contents ? getBrowserService()?.ownerForWebContents(contents.id) : undefined
    const onCompleted = activeDownloadCollector?.(owner)
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        activeEmit?.('browser:download', { path: target, filename })
        onCompleted?.(target, item.getURL())
      }
      else activeEmit?.('browser:download', { path: target, filename, error: state })
    })
  })

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(decideBrowserPermission(permission))
  })
}

/** Install independently of service initialization; lazy input relay is a no-op until ready. */
export function installBrowserWiring(win: BrowserWindow, emit: BrowserEmit, collectDownload?: BrowserDownloadCollector): void {
  shellWin = win
  activeEmit = emit
  activeDownloadCollector = collectDownload
  if (!wiringInstalled) {
    wiringInstalled = true
    const { app } = electron()
    app.on('web-contents-created', (_event, contents) => wireContents(contents))
  }

  wireContents(win.webContents)
  wireBrowserSession()
}
