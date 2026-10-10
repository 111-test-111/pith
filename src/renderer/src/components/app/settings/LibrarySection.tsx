import { useEffect, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import { useLibraryStatus } from '@/lib/hooks/use-library-status'
import { formatBytes } from '@/lib/format'
import type { LibrarySettingsUpdate, LibraryStatus } from '../../../../../shared/library'
import { LIBRARY_MAX_MAX_BYTES, LIBRARY_MIN_MAX_BYTES } from '../../../../../shared/library'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export function LibrarySection() {
  const { t } = useI18n()
  const { status, setStatus, error: loadError, refresh } = useLibraryStatus()
  const [limit, setLimit] = useState('2048')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'directory' | 'unavailable' | null>(null)
  useEffect(() => { if (status) setLimit(String(status.preferences.maxBytes / 1024 ** 2)) }, [status?.preferences.maxBytes])
  const bytes = Number(limit) * 1024 ** 2
  const valid = limit.trim() !== '' && Number.isSafeInteger(bytes) && bytes >= LIBRARY_MIN_MAX_BYTES && bytes <= LIBRARY_MAX_MAX_BYTES
  const run = async (work: () => Promise<{ ok: true; value: LibraryStatus | null } | { ok: false; code: string }>) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await work()
      if (!result.ok) setError(result.code === 'directory' ? 'directory' : 'unavailable')
      else if (result.value) setStatus(result.value)
    } catch { setError('unavailable') }
    finally { setBusy(false) }
  }
  const save = (update: LibrarySettingsUpdate) => run(() => window.pi.setLibraryPreferences(update))
  if (!status) return <div role="status" className="text-sm text-muted-foreground">{t(loadError ? 'library.loadError' : 'library.loading')}{loadError ? <Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('library.retry')}</Button> : null}</div>
  return (
    <div data-library-settings className="space-y-6">
      <SettingsGroup title={t('library.collection')}>
        <SettingsRow label={t('library.autoCollect')} description={t('library.autoCollectHint')}>
          <Checkbox mark="square" checked={status.preferences.enabled} disabled={busy} aria-label={t('library.autoCollect')} onCheckedChange={value => void save({ enabled: value })} />
        </SettingsRow>
        <SettingsRow label={t('library.history')} description={t('library.historyHint')}>
          <Button variant="outline" size="sm" disabled={busy || status.scanning || !status.preferences.enabled} onClick={() => void run(() => window.pi.libraryRescan())}>{t(status.scanning ? 'library.scanning' : 'library.rescan')}</Button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('library.archive')}>
        <SettingsRow label={t('library.directory')} description={<span className="break-all">{status.directory}</span>}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => window.pi.libraryChooseDirectory())}>{t('library.chooseDirectory')}</Button>
          {status.preferences.directory ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => window.pi.libraryChooseDirectory(true))}>{t('library.defaultDirectory')}</Button> : null}
        </SettingsRow>
        <SettingsRow label={t('library.maxSpace')} description={t('library.capacityHint')}>
          <Input value={limit} onChange={value => setLimit(value.replace(/[^0-9.]/g, '').slice(0, 12))} inputMode="decimal" disabled={busy} aria-label={t('library.maxSpace')} className="w-24" classNames={{ input: 'text-center' }} />
          <span className="text-xs text-muted-foreground">MiB</span>
          <Button variant="ghost" size="sm" disabled={busy || !valid || bytes === status.preferences.maxBytes} onClick={() => void save({ maxBytes: bytes })}>{t('library.apply')}</Button>
        </SettingsRow>
        <SettingsRow label={t('library.usedSpace')} description={t('library.usage', { used: formatBytes(status.usedBytes), max: formatBytes(status.preferences.maxBytes) })}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void window.pi.showInFolder(status.directory).catch(() => setError('unavailable'))}>{t('library.showDirectory')}</Button>
        </SettingsRow>
        {status.usedBytes > status.preferences.maxBytes ? <p className="px-4 pb-3 text-xs text-amber-600 dark:text-amber-400">{t('library.overLimit')}</p> : null}
      </SettingsGroup>
      <p className="text-xs leading-ui text-muted-foreground">{t('library.collectionHint')}</p>
      {error || loadError ? <p role="alert" className="text-xs text-destructive">{t(error === 'directory' ? 'library.directoryError' : 'library.actionError')}</p> : null}
    </div>
  )
}
