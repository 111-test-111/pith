import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import { useOpenLinksInBrowserPref } from '@/lib/browser/open-link'
import { SettingsRow } from './SettingsRow'

/** 两步确认的回退时限：第一次点击后 5s 未再点则回到常态。 */
const CLEAR_CONFIRM_TIMEOUT_MS = 5000

/**
 * Settings → Browser. Three rows in one card:
 *
 * - the agent browser tools toggle — initial value from AppInfoDTO, persisted
 *   app-wide through `app:setBrowserAgentTools`; a save re-reads appInfo so
 *   the box settles on the authoritative value (the one-time consent lives in
 *   the Browser pane, only referenced here);
 * - the open-links-in-the-embedded-browser preference — localStorage only,
 *   shared with the markdown link router, effective immediately;
 * - clear browsing data behind a two-step confirm: the first click arms a
 *   destructive confirm state with a 5s revert timer, the second click wipes
 *   the browser partition's storage (login states included) and reports a
 *   localized done/error note.
 */
export function BrowserSection() {
  const { t } = useI18n()

  // --- 代理浏览器工具 ---
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
      // 主进程持久化后回读 appInfo，落定到权威值（与其他 app:set* 开关一致）
      .then(() => window.pi.appInfo())
      .then(
        (info) => setToolsEnabled(info.browserAgentToolsEnabled),
        () => {}
      )
      .finally(() => setSavingTools(false))
  }

  // --- 链接在内置浏览器打开（localStorage 偏好，即时生效） ---
  const { openLinksInBrowser, setOpenLinksInBrowser } = useOpenLinksInBrowserPref()

  // --- 清除浏览数据：两步确认 ---
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

  // 确认态是纯 UI 状态：卸载时清掉回退定时器，不留活儿
  useEffect(() => stopConfirmTimer, [])

  const clearData = () => {
    if (clearing) return
    setClearDone(false)
    setClearFailed(false)
    if (!confirmingClear) {
      // 第一次点击：进入确认态，5s 未再点回退
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
        () => setClearDone(true),
        () => setClearFailed(true)
      )
      .finally(() => setClearing(false))
  }

  return (
    <div className="space-y-6" data-browser-section>
      {/* 无标题卡片：页头 h2 已是该区的标题，行组直接从卡片开始 */}
      <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
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
          label={t('settings.browserClearData')}
          description={t('settings.browserClearDataHint')}
        >
          <Button
            variant={confirmingClear ? 'primary' : 'outline'}
            size="sm"
            data-browser-clear={confirmingClear ? 'confirm' : 'idle'}
            disabled={clearing}
            className={
              confirmingClear ? 'bg-destructive text-white hover:bg-destructive/90' : undefined
            }
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
