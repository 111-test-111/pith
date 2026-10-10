import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import { useOpenLinksInBrowserPref } from '@/lib/browser/open-link'
import { useBrowserKeepAlivePref } from '@/lib/browser/keep-alive'
import { useBrowserRestoreTabsPref } from '@/lib/browser/restore-tabs'
import { useBrowserSearchEngine } from '@/lib/browser/search-engine'
import { BROWSER_SEARCH_ENGINES, isBrowserSearchEngine } from '../../../../../shared/browser'
import { useToast } from '../ToastProvider'
import type {
  BrowserImportDiscoveryDTO,
  BrowserImportResultDTO,
  BrowserImportStatusDTO
} from '../../../../../shared/types'
import { SettingsRow } from './SettingsRow'

/** Reset two-step confirmation if the second click does not arrive within five seconds. */
const CLEAR_CONFIRM_TIMEOUT_MS = 5000

/** Map import failure codes to localized messages; unknown uses the database-read failure. */
function importErrorMessage(t: ReturnType<typeof useI18n>['t'], code?: string): string {
  if (code === 'keychain') return t('settings.browserImportErrKeychain')
  if (code === 'permission') return t('settings.browserImportErrPermission')
  if (code === 'chrome-not-found') return t('settings.browserImportErrNoChrome')
  if (code === 'profile-not-found') return t('settings.browserImportErrProfile')
  return t('settings.browserImportErrDb')
}

/**
 * Settings → Browser. Grouped preference and data rows:
 *
 * - the agent browser tools toggle — initial value from AppInfoDTO, persisted
 *   app-wide through `app:setBrowserAgentTools`; a save re-reads appInfo so
 *   the box settles on the authoritative value (the one-time consent lives in
 *   the Browser pane, only referenced here);
 * - the open-links-in-the-embedded-browser preference — localStorage only,
 *   shared with the markdown link router, effective immediately;
 * - the keep-alive preference — localStorage only, shared with SidebarPanel:
 *   on, a folded rail keeps the browser pane mounted (webviews survive the
 *   fold; page activity is never interrupted) instead of unloading it;
 * - restore tabs after closing the browser — localStorage only, applied by
 *   Workspace on explicit tab close; rail folds always retain their snapshot;
 * - the search engine — AppSettings-backed, shared live with both URL inputs;
 * - import login state from Chrome — decrypts Chrome's cookie DB in main and
 *   writes it into the shared browser partition (a Select picks the Chrome
 *   profile; the result is counts only, cookie values never cross IPC);
 * - clear imported login state — removes exactly what past imports recorded
 *   (`browser-import.json`), behind the same two-step confirm as clear-data;
 * - clear browsing data behind a two-step confirm: the first click arms a
 *   destructive confirm state with a 5s revert timer, the second click wipes
 *   the browser partition's storage (login states included) and reports a
 *   localized done/error note.
 */
export function BrowserSection() {
  const { t } = useI18n()
  const toast = useToast()
  const { browserSearchEngine, setBrowserSearchEngine } = useBrowserSearchEngine()
  const [savingSearch, setSavingSearch] = useState(false)
  const changeSearchEngine = (value: string) => {
    if (savingSearch || !isBrowserSearchEngine(value)) return
    setSavingSearch(true)
    void setBrowserSearchEngine(value)
      .catch(() => toast.error({ title: t('settings.browserSearchSaveFailed') }))
      .finally(() => setSavingSearch(false))
  }

  // Agent browser tools.
  const [toolsEnabled, setToolsEnabled] = useState(false)
  const [savingTools, setSavingTools] = useState(false)

  useEffect(() => {
    let alive = true
    void window.pi
      .appInfo()
      .then((info) => {
        if (alive) setToolsEnabled(info.browserAgentToolsEnabled)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const toggleTools = (value: boolean) => {
    setSavingTools(true)
    void window.pi
      .setBrowserAgentTools(value)
      // Read authoritative appInfo after main persists the setting, as with other app:set preferences.
      .then(() => window.pi.appInfo())
      .then(
        (info) => setToolsEnabled(info.browserAgentToolsEnabled),
        () => {}
      )
      .finally(() => setSavingTools(false))
  }

  // Open links in the embedded browser: immediate localStorage preference.
  const { openLinksInBrowser, setOpenLinksInBrowser } = useOpenLinksInBrowserPref()

  // Keep pages alive while the rail is folded: immediate localStorage preference.
  const { browserKeepAlive, setBrowserKeepAlive } = useBrowserKeepAlivePref()
  const { browserRestoreTabs, setBrowserRestoreTabs } = useBrowserRestoreTabsPref()

  // Import Chrome login state.
  const [discovery, setDiscovery] = useState<BrowserImportDiscoveryDTO>({
    status: 'absent',
    profiles: [],
    devMode: false
  })
  const sources = discovery.profiles
  const [profileId, setProfileId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const refreshImportStatus = (): Promise<BrowserImportStatusDTO> =>
    window.pi.browserImportStatus().catch(() => ({ present: false, cookieCount: 0 }))

  const [importStatus, setImportStatus] = useState<BrowserImportStatusDTO>({ present: false, cookieCount: 0 })

  useEffect(() => {
    let alive = true
    void window.pi
      .browserImportSources()
      .then((found) => {
        if (!alive) return
        setDiscovery(found)
        if (found.profiles.length > 0) setProfileId((current) => current ?? found.profiles[0].id)
      })
      .catch(() => {})
    void refreshImportStatus().then((status) => {
      if (alive) setImportStatus(status)
    })
    return () => {
      alive = false
    }
  }, [])

  // Import/clear outcomes use ToastProvider/beUI AnimatedToastStack only. Settings retains profile/count metadata and status guidance, without lingering action results.
  const runImport = () => {
    if (importing || !profileId) return
    setImporting(true)
    void window.pi
      .browserImportCookies(profileId)
      .then((result: BrowserImportResultDTO) => {
        if (result.ok) {
          const notes: string[] = []
          if (result.skippedExpired + result.skippedUndecryptable > 0) {
            notes.push(
              t('settings.browserImportSkipped', {
                count: result.skippedExpired + result.skippedUndecryptable
              })
            )
          }
          if (result.failed > 0) {
            notes.push(
              t('settings.browserImportFailedNote', {
                count: result.failed,
                error: (result.firstError ?? '').slice(0, 90)
              })
            )
          }
          toast.success({
            title: t('settings.browserImportDone', { count: result.imported }),
            description: notes.length > 0 ? notes.join(' ') : undefined
          })
        } else {
          toast.error({ title: importErrorMessage(t, result.code) })
        }
      })
      .catch(() => toast.error({ title: t('settings.browserImportErrDb') }))
      .then(() => refreshImportStatus())
      .then((status) => setImportStatus(status))
      .finally(() => setImporting(false))
  }

  // Clear imported login state with two-step confirmation.
  const [confirmingClearImport, setConfirmingClearImport] = useState(false)
  const [clearingImport, setClearingImport] = useState(false)
  const clearImportTimer = useRef<number | null>(null)

  const stopClearImportTimer = () => {
    if (clearImportTimer.current !== null) {
      window.clearTimeout(clearImportTimer.current)
      clearImportTimer.current = null
    }
  }

  useEffect(() => stopClearImportTimer, [])

  const clearImported = () => {
    if (clearingImport || !importStatus.present) return
    if (!confirmingClearImport) {
      setConfirmingClearImport(true)
      stopClearImportTimer()
      clearImportTimer.current = window.setTimeout(() => {
        clearImportTimer.current = null
        setConfirmingClearImport(false)
      }, CLEAR_CONFIRM_TIMEOUT_MS)
      return
    }
    stopClearImportTimer()
    setConfirmingClearImport(false)
    setClearingImport(true)
    void window.pi
      .browserClearImported()
      .then(
        (res) => toast.success({ title: t('settings.browserClearImportDone', { count: res.removed }) }),
        () => toast.error({ title: t('settings.browserClearImportFailed') })
      )
      .then(() => refreshImportStatus())
      .then((status) => setImportStatus(status))
      .finally(() => setClearingImport(false))
  }

  // Clear browser data with two-step confirmation.
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearDone, setClearDone] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)
  const confirmTimer = useRef<number | null>(null)

  const stopConfirmTimer = () => {
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = null
    }
  }

  // Confirmation is UI-only; clear its reset timer on unmount.
  useEffect(() => stopConfirmTimer, [])

  const clearData = () => {
    if (clearing) return
    setClearDone(false)
    setClearFailed(false)
    if (!confirmingClear) {
      // The first click enters confirmation; reset after five seconds without another click.
      setConfirmingClear(true)
      stopConfirmTimer()
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null
        setConfirmingClear(false)
      }, CLEAR_CONFIRM_TIMEOUT_MS)
      return
    }
    stopConfirmTimer()
    setConfirmingClear(false)
    setClearing(true)
    void window.pi
      .browserClearData()
      .then(
        () => {
          setClearDone(true)
          // Clearing the whole partition also invalidates the import manifest.
          setImportStatus({ present: false, cookieCount: 0 })
        },
        () => setClearFailed(true)
      )
      .finally(() => setClearing(false))
  }

  return (
    <div className="space-y-6" data-browser-section>
      {/* The section heading already supplies the title; start directly with untitled grouped rows. */}
      <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
        <SettingsRow label={t('settings.browserSearchEngine')} description={t('settings.browserSearchEngineHint')}>
          <span data-browser-search-engine className="contents">
            <Select value={browserSearchEngine} onValueChange={changeSearchEngine} disabled={savingSearch}>
              <SelectTrigger aria-label={t('settings.browserSearchEngine')} className="h-8 w-40 rounded-control px-3 text-sm">
                {t(`browser.searchEngine.${browserSearchEngine}`)}
              </SelectTrigger>
              <SelectContent portal className="w-40">
                {BROWSER_SEARCH_ENGINES.map((engine) => (
                  <SelectItem key={engine} value={engine}>{t(`browser.searchEngine.${engine}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        </SettingsRow>
        <SettingsRow
          label={t('settings.browserAgentTools')}
          description={t('settings.browserAgentToolsHint')}
        >
          <Checkbox
            mark="square"
            checked={toolsEnabled}
            disabled={savingTools}
            onCheckedChange={toggleTools}
            aria-label={t('settings.browserAgentTools')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.browserOpenLinks')}
          description={t('settings.browserOpenLinksHint')}
        >
          <Checkbox
            mark="square"
            checked={openLinksInBrowser}
            onCheckedChange={(value) => setOpenLinksInBrowser(value)}
            aria-label={t('settings.browserOpenLinks')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.browserRestoreTabs')}
          description={t('settings.browserRestoreTabsHint')}
        >
          <Checkbox
            mark="square"
            checked={browserRestoreTabs}
            onCheckedChange={setBrowserRestoreTabs}
            aria-label={t('settings.browserRestoreTabs')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.browserKeepAlive')}
          description={t('settings.browserKeepAliveHint')}
        >
          <Checkbox
            mark="square"
            checked={browserKeepAlive}
            onCheckedChange={(value) => setBrowserKeepAlive(value)}
            aria-label={t('settings.browserKeepAlive')}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.browserImport')} description={t('settings.browserImportHint')}>
          {sources.length > 0 ? (
            <span data-browser-import-profile className="contents">
              <Select value={profileId ?? sources[0].id} onValueChange={setProfileId} disabled={importing}>
                <SelectTrigger
                  aria-label={t('settings.browserImportProfiles')}
                  className="h-8 w-auto max-w-56 rounded-control px-3 text-xs"
                >
                  <span className="truncate">
                    {sources.find((s) => s.id === (profileId ?? sources[0].id))?.label ?? sources[0].label}
                  </span>
                </SelectTrigger>
                <SelectContent className="left-auto right-0 w-56">
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={source.id} className="py-1.5">
                      <span className="truncate text-sm text-foreground">{source.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            data-browser-import={importing ? 'busy' : 'idle'}
            disabled={importing || sources.length === 0 || !profileId}
            onClick={runImport}
          >
            {t('settings.browserImportAction')}
          </Button>
        </SettingsRow>
        {discovery.status === 'blocked' ? (
          <div className="px-4 py-3" data-browser-import-permission>
            <p className="text-xs leading-ui-tight text-muted-foreground">
              {t('settings.browserImportBlocked')}
            </p>
            {/* Full Disk Access guidance differs by launch: dev/preview uses the repository Electron.app, so grant the launching terminal; installed apps are listed directly. Keep one concise instruction per path. */}
            <p
              data-browser-import-fda-guide={discovery.devMode ? 'dev' : 'installed'}
              className="mt-1.5 text-xs leading-ui-tight text-muted-foreground"
            >
              {t(
                discovery.devMode
                  ? 'settings.browserImportFdaDev'
                  : 'settings.browserImportFdaInstalled'
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void window.pi.browserOpenPrivacySettings()}
              >
                {t('settings.browserOpenPrivacySettings')}
              </Button>
            </div>
          </div>
        ) : null}
        {discovery.status === 'absent' ? (
          <p role="status" data-browser-import-status="absent" className="px-4 py-3 text-xs text-muted-foreground">
            {t('settings.browserImportAbsent')}
          </p>
        ) : null}
        {discovery.status === 'none' ? (
          <p role="status" data-browser-import-status="none" className="px-4 py-3 text-xs text-muted-foreground">
            {t('settings.browserImportNone')}
          </p>
        ) : null}
        <SettingsRow
          label={t('settings.browserClearImport')}
          description={
            importStatus.present && importStatus.profileLabel
              ? t('settings.browserClearImportHintActive', {
                  profile: importStatus.profileLabel,
                  count: importStatus.cookieCount
                })
              : t('settings.browserClearImportHint')
          }
        >
          <Button
            variant="destructive"
            size="sm"
            data-browser-clear-import={confirmingClearImport ? 'confirm' : 'idle'}
            disabled={clearingImport || !importStatus.present}
            className={confirmingClearImport ? 'hover:bg-destructive hover:text-white' : undefined}
            onClick={clearImported}
          >
            {confirmingClearImport
              ? t('settings.browserClearImportConfirm')
              : t('settings.browserClearImport')}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('settings.browserClearData')}
          description={t('settings.browserClearDataHint')}
        >
          <Button
            variant="destructive"
            size="sm"
            data-browser-clear={confirmingClear ? 'confirm' : 'idle'}
            disabled={clearing}
            className={confirmingClear ? 'hover:bg-destructive hover:text-white' : undefined}
            onClick={clearData}
          >
            {confirmingClear ? t('settings.browserClearDataConfirm') : t('settings.browserClearData')}
          </Button>
        </SettingsRow>
        {clearDone ? (
          <p
            role="status"
            data-browser-clear-status="done"
            className="px-4 py-3 text-xs text-muted-foreground"
          >
            {t('settings.browserClearDataDone')}
          </p>
        ) : null}
        {clearFailed ? (
          <p
            role="alert"
            data-browser-clear-status="failed"
            className="px-4 py-3 text-xs text-destructive"
          >
            {t('settings.browserClearDataFailed')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
