import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { browserOwnerSessionId } from '../../../../shared/browser'
import type { BrowserStatusDTO, SessionSummaryDTO } from '../../../../shared/types'
import type { PiStore } from '@/state/pi-store'
import { paneSessionKey, type WorkspacePaneSession, type WorkspacePanes } from '@/state/workspace-panes'
import { useBrowserKeepAlivePref } from './keep-alive'
import { subscribeBrowserDownloads } from './downloads'
import { BROWSER_OPEN_LINK_EVENT, drainPendingBrowserOpenLinks } from './open-link'
import { subscribeBrowserPopups } from './popup'
import { getBrowserRestoreTabsPref } from './restore-tabs'
import { closeOpenBrowserPages } from './session'
import type { BrowserStore } from './store'
import { BrowserWorkspaces } from './workspaces'

export function useWorkspaceBrowsers(
  store: PiStore, panes: WorkspacePanes, scope: WorkspacePaneSession,
  sessions: SessionSummaryDTO[], hasBrowserTab: boolean, railOpen: boolean
) {
  const { browserKeepAlive } = useBrowserKeepAlivePref()
  const [browsers] = useState(() => new BrowserWorkspaces())
  const hosts = useSyncExternalStore(browsers.subscribe, browsers.getSnapshot)
  const shell = store.getShell()
  const current = browsers.get(shell.sessionId)
  const sessionKeys = useRef(new Map<string, string>())
  const attached = hasBrowserTab && (railOpen || browserKeepAlive)
  const previous = useRef<{ browser: BrowserStore; attached: boolean } | null>(null)

  useLayoutEffect(() => {
    for (const { id, path } of sessions) sessionKeys.current.set(id, path)
    for (const run of shell.subagents) sessionKeys.current.set(run.sessionId, run.sessionPath)
    if (shell.sessionId) sessionKeys.current.set(shell.sessionId, scope.key)
  }, [sessions, scope.key, shell.sessionId, shell.subagents])

  useLayoutEffect(() => {
    if (attached) browsers.host(current)
    // Folding the visible rail follows the browser keep-alive preference. A
    // change of conversation leaves the previous host in place.
    else if (previous.current?.browser === current && previous.current.attached && hasBrowserTab) {
      browsers.unhost(current)
    }
    previous.current = { browser: current, attached }
    // A background tool may have created a host before its chat was listed.
    if (!hasBrowserTab && browsers.getSnapshot().includes(current)) scope.open('browser', false)
  }, [attached, browsers, current, hasBrowserTab, hosts, scope])

  const ownerScope = useCallback((browser: BrowserStore) => {
    const key = browser.sessionId ? sessionKeys.current.get(browser.sessionId) : paneSessionKey(store.getShell())
    return key ? panes.forSession(key) : undefined
  }, [panes, store])

  const reveal = useCallback((browser: BrowserStore, foreground: boolean) => {
    const scope = ownerScope(browser)
    if (!scope?.getSnapshot().tabs.includes('browser') && !getBrowserRestoreTabsPref()) {
      closeOpenBrowserPages(false, browser.sessionId)
    }
    scope?.open('browser', foreground)
    browsers.host(browser)
  }, [browsers, ownerScope])

  const applyStatus = useCallback((status: BrowserStatusDTO) => {
    browsers.applyStatus(status, browser => {
      const owner = ownerScope(browser)
      if (owner?.getSnapshot().tabs.includes('browser')) {
        browsers.host(browser)
        return
      }
      reveal(browser, browser.sessionId === store.getShell().sessionId)
    })
  }, [browsers, ownerScope, reveal, store])

  useEffect(() => {
    let alive = true
    const currentForEvent = (owner: string | undefined) => browsers.get(browserOwnerSessionId(owner) ?? store.getShell().sessionId)
    const offState = window.pi.onBrowserState(applyStatus)
    const offPopup = subscribeBrowserPopups(currentForEvent, browser => {
      if (!ownerScope(browser)?.getSnapshot().tabs.includes('browser')) reveal(browser, browser.sessionId === store.getShell().sessionId)
      else browsers.host(browser)
    })
    const offDownload = subscribeBrowserDownloads(currentForEvent)
    // A hidden agent guest still needs DOM focus for CDP keyboard actions.
    const offFocus = window.pi.onBrowserFocusGuest?.(({ webContentsId, requestId }) => {
      const views = document.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>('webview')
      const guest = Array.from(views).find(view => {
        try { return view.getWebContentsId?.() === webContentsId } catch { return false }
      })
      guest?.focus()
      void window.pi.browserFocusGuestDone(requestId)
    })
    const openLinks = () => {
      const browser = browsers.get(store.getShell().sessionId)
      const urls = drainPendingBrowserOpenLinks()
      if (urls.length) browser.pushLinks(urls)
      reveal(browser, true)
    }
    window.addEventListener(BROWSER_OPEN_LINK_EVENT, openLinks)
    if (window.pi.browserStatus) void window.pi.browserStatus().then(status => { if (alive) applyStatus(status) }).catch(() => {})
    return () => {
      alive = false
      offState()
      offPopup()
      offDownload()
      offFocus?.()
      window.removeEventListener(BROWSER_OPEN_LINK_EVENT, openLinks)
    }
  }, [applyStatus, browsers, ownerScope, reveal, store])

  const hasHosts = hosts.length > 0
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    if (hasHosts && resolvedTheme) void window.pi.browserTheme(resolvedTheme === 'dark' ? 'dark' : 'light').catch(() => {})
  }, [hasHosts, resolvedTheme])

  useEffect(() => {
    if (!hasHosts) return
    let alive = true
    const poll = () => void window.pi.browserStatus().then(status => { if (alive) applyStatus(status) }).catch(() => {})
    poll()
    const timer = setInterval(poll, 2500)
    return () => { alive = false; clearInterval(timer) }
  }, [applyStatus, hasHosts])

  const close = useCallback((browser: BrowserStore) => {
    browsers.close(browser, getBrowserRestoreTabsPref())
  }, [browsers])

  const onEmpty = useCallback((browser: BrowserStore) => {
    close(browser)
    ownerScope(browser)?.close(['browser'])
  }, [close, ownerScope])

  const forget = useCallback((sessionId: string) => {
    sessionKeys.current.delete(sessionId)
    browsers.forget(sessionId)
  }, [browsers])

  const open = useCallback(() => reveal(current, true), [current, reveal])
  return { current, hosts, open, close, onEmpty, forget }
}
