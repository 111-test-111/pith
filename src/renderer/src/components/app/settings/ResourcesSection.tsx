import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import { resourceBytes } from '@/lib/resource-format'
import { cn } from '@/lib/utils'
import { useResourceUsage } from '@/lib/hooks/use-resource-usage'
import type { ResourceProcessDTO, ResourceStorageCategory, ResourceStorageRootKind } from '../../../../../shared/resources'
import type { MessageKey } from '@/i18n/locales/en'
import { SettingsGroup, SettingsRow } from './SettingsRow'

const CATEGORY_KEYS: Record<ResourceStorageCategory, MessageKey> = {
  sessions: 'resources.storage.sessions', rewind: 'resources.storage.rewind', trajectory: 'resources.storage.trajectory',
  library: 'resources.storage.library', browser: 'resources.storage.browser', cache: 'resources.storage.cache',
  indexes: 'resources.storage.indexes', logs: 'resources.storage.logs', workspace: 'resources.storage.workspace',
  extensions: 'resources.storage.extensions', configuration: 'resources.storage.configuration', other: 'resources.storage.other'
}
const ROOT_KEYS: Record<ResourceStorageRootKind, MessageKey> = {
  app: 'resources.root.app', pi: 'resources.root.pi', library: 'resources.root.library', browser: 'resources.root.browser',
  logs: 'resources.root.logs', crashes: 'resources.root.crashes'
}
const PROCESS_KEYS: Record<ResourceProcessDTO['kind'], MessageKey> = {
  main: 'resources.process.main', renderer: 'resources.process.renderer', gpu: 'resources.process.gpu',
  utility: 'resources.process.utility', other: 'resources.process.other', child: 'resources.process.child'
}

/** This page's groups read as report headings, not muted fieldset labels. */
const GROUP_TITLE = 'text-sm text-foreground'

function ByteValue({ bytes, compact = false }: { bytes: number | null; compact?: boolean }) {
  const { t, locale } = useI18n()
  if (bytes === null) return <span className="text-xs text-muted-foreground">{t('resources.unavailable')}</span>
  const exact = t('resources.exactBytes', { count: new Intl.NumberFormat(locale).format(bytes) })
  return <span className="inline-flex flex-col items-end tabular-nums" title={exact}>
    <span className={compact ? 'text-xs text-foreground' : 'text-sm font-medium text-foreground'}>{resourceBytes(bytes, locale)}</span>
    <span className="mt-0.5 text-micro text-muted-foreground">{exact}</span>
  </span>
}

export function ResourcesSection({ active }: { active: boolean }) {
  const { t, locale } = useI18n()
  const { runtime, runtimeError, storage, storageError, scanning, scan } = useResourceUsage(active)
  const [showProcesses, setShowProcesses] = useState(false), [showPaths, setShowPaths] = useState(false)
  const [showStorage, setShowStorage] = useState(false)
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
  const percent = (value: number | null | undefined) => value == null ? t('resources.sampling') : `${number(value)}%`
  const stamp = (time: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(time)
  const processes = runtime?.processes ?? []
  // A pending or unavailable sample is a status line, not a value: it takes the
  // rescan button's 12px label size while a real percentage keeps the value size.
  const cpuPending = !runtime || runtime.partial || runtime.cpuPercent == null
  const paths = storage?.roots.filter((root, index, roots) => roots.findIndex(other => other.path === root.path) === index) ?? []
  return (
    <div data-resource-settings className="space-y-6">
      <SettingsGroup title={t('resources.runtime')} titleClassName={GROUP_TITLE} description={t('resources.refreshHint')}>
        <SettingsRow label={t('resources.cpu')} description={runtime ? t('resources.cpuHint', { cores: runtime.logicalCores }) : t('resources.loading')}>
          <div className="flex flex-col items-end tabular-nums" data-resource-cpu>
            <span className={cn('font-medium text-foreground', cpuPending ? 'text-xs' : 'text-sm')}>{runtime?.partial ? t('resources.unavailable') : percent(runtime?.cpuPercent)}</span>
            {runtime?.cpuPercent != null ? <span className="mt-0.5 text-micro text-muted-foreground">{t('resources.systemCpu', { percent: number(runtime.cpuPercent / runtime.logicalCores) })}</span> : null}
          </div>
        </SettingsRow>
        <SettingsRow label={t('resources.memory')} description={t('resources.memoryHint')}>
          <span data-resource-memory>{runtime ? <ByteValue bytes={runtime.residentBytes} /> : <span className="text-xs text-muted-foreground">{t('resources.loading')}</span>}</span>
        </SettingsRow>
        <SettingsRow label={t('resources.processes')} description={t('resources.processScope')}>
          {runtime ? <span className="mr-1 text-sm tabular-nums text-foreground">{number(processes.length)}</span> : null}
          <Button variant="ghost" size="sm" aria-expanded={showProcesses} aria-controls="resource-process-details" onClick={() => setShowProcesses(value => !value)}>
            {showProcesses ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{t('resources.details')}
          </Button>
        </SettingsRow>
        {showProcesses ? <div id="resource-process-details" className="overflow-x-auto p-1">
          <table className="w-full text-left text-xs" data-resource-processes>
            <caption className="sr-only">{t('resources.processes')}</caption>
            <thead><tr className="text-muted-foreground"><th scope="col" className="px-3 py-2 font-medium">{t('resources.processName')}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t('resources.pid')}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t('resources.cpu')}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t('resources.memory')}</th></tr></thead>
            <tbody>{processes.map(row => <tr key={`${row.pid}:${row.creationTime}`} className="border-t border-border/60" data-resource-pid={row.pid}>
              <th scope="row" className="px-3 py-2.5 font-medium text-foreground"><span>{t(PROCESS_KEYS[row.kind])}</span>{row.name ? <span className="mt-0.5 block max-w-64 break-words text-micro font-normal text-muted-foreground">{row.name}</span> : null}</th>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{row.pid}</td><td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-foreground">{percent(row.cpuPercent)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right"><ByteValue bytes={row.residentBytes} compact /></td>
            </tr>)}</tbody>
          </table>
        </div> : null}
      </SettingsGroup>
      {runtime ? <p className="text-xs leading-ui text-muted-foreground">{t('resources.runtimeStamp', { time: stamp(runtime.sampledAt) })}{runtime.intervalMs ? ` · ${t('resources.interval', { seconds: number(runtime.intervalMs / 1000) })}` : null}</p> : null}
      {runtimeError || runtime?.partial ? <p role="alert" className="text-xs text-destructive">{t(runtime?.partial ? 'resources.runtimePartial' : 'resources.runtimeError')}</p> : null}

      <SettingsGroup title={t('resources.disk')} titleClassName={GROUP_TITLE} description={t('resources.diskHint')}>
        <SettingsRow label={t('resources.localData')} description={storage ? t('resources.scanStamp', { time: stamp(storage.completedAt), count: number(storage.files) }) : t(scanning ? 'resources.scanning' : 'resources.diskPending')}>
          <Button variant="outline" size="sm" disabled={scanning} onClick={() => void scan()}>
            <RefreshCw className="size-3.5" />{t(scanning ? 'resources.scanning' : 'resources.rescan')}
          </Button>
        </SettingsRow>
        {storage?.partial ? <div role="alert" className="space-y-1 px-4 py-3 text-xs text-destructive"><p>{t('resources.diskPartial', { count: number(storage.issueCount) })}</p>{storage.issues.map((issue, index) => <p key={index} className="break-all">{issue.path} · {t(issue.reason === 'changed' ? 'resources.issueChanged' : issue.reason === 'overflow' ? 'resources.issueOverflow' : 'resources.pathUnreadable')}</p>)}</div> : null}
        {storage ? <>
          <SettingsRow label={t('resources.allocated')} description={t('resources.allocationHint')}><span data-resource-allocated><ByteValue bytes={storage.allocatedBytes} /></span></SettingsRow>
          <SettingsRow label={t('resources.fileSize')} description={t('resources.fileSizeHint')}><span data-resource-logical><ByteValue bytes={storage.logicalBytes} /></span></SettingsRow>
          <SettingsRow label={t('resources.categories')}>
            <Button variant="ghost" size="sm" aria-expanded={showStorage} aria-controls="resource-storage-details" onClick={() => setShowStorage(value => !value)}>
              {showStorage ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{t('resources.details')}
            </Button>
          </SettingsRow>
          {showStorage ? <div id="resource-storage-details" className="overflow-x-auto p-1">
            <table className="w-full text-left text-xs" data-resource-storage>
              <caption className="sr-only">{t('resources.categories')}</caption>
              <thead><tr className="text-muted-foreground"><th scope="col" className="px-3 py-2 font-medium">{t('resources.categories')}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t('resources.fileSize')}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t('resources.allocated')}</th></tr></thead>
              <tbody>{storage.entries.map(row => <tr key={row.category} className="border-t border-border/60" data-resource-category={row.category}>
                <th scope="row" className="px-3 py-2.5 font-medium text-foreground">{t(CATEGORY_KEYS[row.category])}<span className="mt-0.5 block text-micro font-normal text-muted-foreground">{t('resources.fileCount', { count: number(row.files) })}</span></th>
                <td className="whitespace-nowrap px-3 py-2.5 text-right"><ByteValue bytes={row.logicalBytes} compact /></td><td className="whitespace-nowrap px-3 py-2.5 text-right"><ByteValue bytes={row.allocatedBytes} compact /></td>
              </tr>)}</tbody>
            </table>
          </div> : null}
          <SettingsRow label={t('resources.scanPaths')} description={t('resources.pathHint')}>
            <Button variant="ghost" size="sm" aria-expanded={showPaths} aria-controls="resource-storage-paths" onClick={() => setShowPaths(value => !value)}>
              {showPaths ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{t('resources.details')}
            </Button>
          </SettingsRow>
          {showPaths ? <div id="resource-storage-paths">{paths.map(root => <SettingsRow key={root.path} label={t(ROOT_KEYS[root.kind])} description={<span className="break-all">{root.path}</span>}>
            <span className="text-xs text-muted-foreground">{t(root.status === 'ok' ? 'resources.pathIncluded' : root.status === 'missing' ? 'resources.pathMissing' : 'resources.pathUnreadable')}</span>
          </SettingsRow>)}</div> : null}
        </> : null}
      </SettingsGroup>
      {storageError ? <p role="alert" className="text-xs text-destructive">{t('resources.diskError')}</p> : null}
      <p className="text-xs leading-ui text-muted-foreground">{t('resources.scopeHint')}</p>
    </div>
  )
}
