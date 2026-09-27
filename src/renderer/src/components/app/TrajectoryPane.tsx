import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useReducedMotion } from 'motion/react'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { Input } from '@/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { ChevronLeft, ChevronRight, Copy, Download, RefreshCw } from '@/lib/icons'
import { StatusRing } from '@/lib/status-ring'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { PiStore } from '@/state/pi-store'
import type { TrajectoryDetail, TrajectoryKind, TrajectoryNodePage, TrajectoryPage, TrajectoryRecord, TrajectoryStatus, SubagentRunDTO } from '../../../../shared/types'
import { FadeScroll } from './FadeScroll'

const KINDS: TrajectoryKind[] = ['run', 'user', 'request', 'assistant', 'tool', 'compaction', 'retry', 'notification']
const STATUSES: TrajectoryStatus[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unavailable']
const duration = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)} s`

function TimingOverview({ records, onSelect }: { records: TrajectoryRecord[]; onSelect(record: TrajectoryRecord): void }) {
  const { t, locale } = useI18n()
  const spans = records.filter(record => record.kind === 'request' || record.kind === 'tool')
  if (!spans.length) return null
  const start = Math.min(...spans.map(record => record.startedAt))
  const end = Math.max(...spans.map(record => record.finishedAt ?? record.startedAt))
  const range = Math.max(1, end - start)
  return <div data-trajectory-timing className="shrink-0 border-b border-border px-3 py-2">
    <p className="mb-1 text-xs text-muted-foreground">{t('trajectory.overview')}</p>
    {(['request', 'tool'] as const).map(kind => <div key={kind} className="flex h-6 items-center gap-2">
      <span className="w-16 shrink-0 truncate text-xs text-muted-foreground">{t(`trajectory.kind.${kind}`)}</span>
      <div className="relative h-4 flex-1">
        {spans.filter(record => record.kind === kind).map(record => {
          const width = Math.max(1, ((record.finishedAt ?? record.startedAt) - record.startedAt) * 100 / range)
          const waiting = record.firstTokenAt === undefined || record.finishedAt === undefined ? 0
            : Math.min(100, Math.max(0, (record.firstTokenAt - record.startedAt) * 100 / Math.max(1, record.finishedAt - record.startedAt)))
          return <Button key={record.id} variant="ghost" size="sm" className="absolute h-4 min-w-1 overflow-hidden rounded-inner bg-primary/30 p-0 hover:bg-primary/50"
            style={{ left: `${Math.min(99, (record.startedAt - start) * 100 / range)}%`, width: `${width}%` }}
            aria-label={t('trajectory.span', { name: record.name, time: new Date(record.startedAt).toLocaleTimeString(locale), duration: record.finishedAt === undefined ? t(`trajectory.status.${record.status}`) : duration(record.finishedAt - record.startedAt) })}
            title={t('trajectory.span', { name: record.name, time: new Date(record.startedAt).toLocaleTimeString(locale), duration: record.finishedAt === undefined ? t(`trajectory.status.${record.status}`) : duration(record.finishedAt - record.startedAt) })}
            onClick={() => onSelect(record)}>
            {waiting > 0 ? <span className="absolute inset-y-0 left-0 bg-primary/40" style={{ width: `${waiting}%` }} /> : null}
          </Button>
        })}
      </div>
    </div>)}
    <p className="mt-1 text-xs text-muted-foreground">{t('trajectory.timingHint')}</p>
  </div>
}

function RecordInspector({ path, record, revision }: { path: string; record: TrajectoryRecord; revision: number }) {
  const { t, locale } = useI18n()
  const [detail, setDetail] = useState<TrajectoryDetail | null>(null)
  const [location, setLocation] = useState<{ trail: string[]; keys: string[]; offset: number } | null>(null)
  const [node, setNode] = useState<TrajectoryNodePage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [exporting, setExporting] = useState(false)
  const current = useRef({ path, id: record.id })
  current.current = { path, id: record.id }
  useEffect(() => {
    let active = true
    void window.pi.trajectoryDetail(path, record.id).then(value => {
      if (!active) return
      setDetail(value); setError(false)
      setLocation(previous => {
        const owner = previous && value.documents.find(doc => doc.node.id === previous.trail[0])
        if (previous && owner) {
          const label = t(`trajectory.doc.${owner.kind}`)
          return label === previous.keys[0] ? previous : { ...previous, keys: [label, ...previous.keys.slice(1)] }
        }
        const doc = value.documents.find(doc => doc.kind === 'payload') ?? value.documents[0]
        return doc ? { trail: [doc.node.id], keys: [t(`trajectory.doc.${doc.kind}`)], offset: 0 } : null
      })
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [path, record.id, record.status, revision, t])
  useEffect(() => {
    if (!location) return
    let active = true
    setBusy(true); setNode(null)
    void window.pi.trajectoryNode({ sessionPath: path, recordId: record.id, trail: location.trail, offset: location.offset })
      .then(value => { if (active) { setNode(value); setError(false) } })
      .catch(() => { if (active) setError(true) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [path, record.id, location])
  const exportRecord = async () => {
    setExporting(true)
    try {
      const result = await window.pi.exportTrajectory(path, record.id)
      if (current.current.path === path && current.current.id === record.id) setError(result.status === 'error')
    } catch { setError(true) }
    finally { setExporting(false) }
  }
  const shown = detail?.record ?? record
  const facts: Array<[string, string]> = [
    [t('trajectory.started'), new Date(shown.startedAt).toLocaleString(locale)],
    [t('trajectory.duration'), shown.finishedAt === undefined ? '—' : duration(shown.finishedAt - shown.startedAt)],
    [t('trajectory.firstToken'), shown.firstTokenAt === undefined ? '—' : duration(shown.firstTokenAt - shown.startedAt)],
    ...(shown.provider ? [[t('trajectory.model'), `${shown.provider} / ${shown.model}`] as [string, string]] : []),
    ...(shown.httpStatus ? [[t('trajectory.http'), String(shown.httpStatus)] as [string, string]] : []),
    ...(shown.stopReason ? [[t('trajectory.stopReason'), shown.stopReason] as [string, string]] : []),
    ...(shown.usage ? [
      [t('trajectory.tokens'), `${shown.usage.input.toLocaleString(locale)} / ${shown.usage.output.toLocaleString(locale)}`] as [string, string],
      [t('trajectory.cache'), `${shown.usage.cacheRead.toLocaleString(locale)} / ${shown.usage.cacheWrite.toLocaleString(locale)}`] as [string, string],
      [t('trajectory.cost'), shown.usage.cost.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })] as [string, string],
      ...(shown.firstTokenAt !== undefined && shown.finishedAt !== undefined && shown.finishedAt > shown.firstTokenAt
        ? [[t('trajectory.speed'), `${(shown.usage.output * 1000 / (shown.finishedAt - shown.firstTokenAt)).toFixed(1)} token/s`] as [string, string]] : [])
    ] : [])
  ]
  return <div data-trajectory-inspector className="flex min-h-0 flex-1 flex-col border-t border-border">
    <div className="flex items-center gap-2 px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{shown.kind === 'run' || shown.kind === 'user' || shown.kind === 'assistant' ? t(`trajectory.kind.${shown.kind}`) : shown.name}</p>
      <Button variant="ghost" size="icon" className="size-7" disabled={exporting} onClick={() => void exportRecord()} title={t('trajectory.export')} aria-label={t('trajectory.export')}><Download className="size-4" /></Button>
    </div>
    <FadeScroll className="min-h-0 flex-1 px-3 pb-3">
      {shown.captureError ? <p className="mb-2 text-xs text-destructive">{t('trajectory.captureError')}</p> : null}
      {!shown.captured ? <p className="mb-2 text-xs text-muted-foreground">{t('trajectory.reconstructed')}</p> : null}
      {shown.kind === 'request' && detail && !detail.documents.some(doc => doc.kind === 'payload') ? <p className="mb-2 text-xs text-muted-foreground">{t('trajectory.noPayload')}</p> : null}
      <div className="grid grid-cols-3 gap-2 text-xs">
        {facts.filter(([key]) => [t('trajectory.duration'), t('trajectory.firstToken'), t('trajectory.tokens')].includes(key)).map(([key, value]) =>
          <div key={key}><p className="truncate text-muted-foreground">{key}</p><p className="mt-0.5 tabular-nums">{value}</p></div>)}
      </div>
      <MorphPopover className="mt-2">
        <MorphPopoverTrigger><Button variant="ghost" size="sm" className="h-6 px-1 text-xs">{t('trajectory.metadata')}</Button></MorphPopoverTrigger>
        <MorphPopoverContent align="start" radius="var(--app-radius-card)">
          <FadeScroll className="max-h-[60vh] w-[min(26rem,calc(100vw-2rem))] p-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              {facts.map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="min-w-0 break-words tabular-nums">{value}</dd></div>)}
              <dt className="text-muted-foreground">{t('trajectory.status')}</dt><dd>{t(`trajectory.status.${shown.status}`)}</dd>
              {shown.parentId ? <><dt className="text-muted-foreground">{t('trajectory.parent')}</dt><dd className="break-all font-mono">{shown.parentId}</dd></> : null}
            </dl>
          </FadeScroll>
        </MorphPopoverContent>
      </MorphPopover>
      <div className="my-3 flex flex-wrap gap-1">
        {detail?.documents.map(doc => <Button key={doc.kind} variant={location?.trail[0] === doc.node.id ? 'secondary' : 'ghost'} size="sm" disabled={busy}
          onClick={() => setLocation({ trail: [doc.node.id], keys: [t(`trajectory.doc.${doc.kind}`)], offset: 0 })}>
          {t(`trajectory.doc.${doc.kind}`)}<span className="text-muted-foreground">{formatBytes(doc.node.bytes)}</span>
        </Button>)}
      </div>
      {location ? <div className="mb-2 flex items-center gap-1">
        <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label={t('trajectory.up')} disabled={busy || location.trail.length === 1}
          onClick={() => setLocation({ trail: location.trail.slice(0, -1), keys: location.keys.slice(0, -1), offset: 0 })}><ChevronLeft className="size-3.5" /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={location.keys.join(' / ')}>{location.keys.join(' / ')}</span>
        {node?.text !== null && node?.text !== undefined ? <Button size="icon" variant="ghost" className="size-6" aria-label={t('trajectory.copyFragment')} title={t('trajectory.copyFragment')}
          onClick={() => { void navigator.clipboard.writeText(node.text!).catch(() => setError(true)) }}><Copy className="size-3.5" /></Button> : null}
      </div> : null}
      {busy ? <p className="py-2 text-xs text-muted-foreground">{t('trajectory.loading')}</p> : null}
      {error ? <p role="alert" className="py-2 text-xs text-destructive">{t('trajectory.error')}</p> : null}
      {node && location ? <>
        {node.text !== null ? <pre data-trajectory-value className="whitespace-pre-wrap break-all rounded-item border border-border bg-muted/30 p-2 font-mono text-xs">{node.text}</pre> :
          <div className="space-y-0.5" data-trajectory-fields>
            {node.children.map((child, index) => <Button key={`${location.offset}:${index}`} variant="ghost" size="sm" className="h-auto w-full justify-start gap-2 px-1 py-1.5 text-xs" disabled={busy}
              onClick={() => setLocation({ trail: [...location.trail, child.node.id], keys: [...location.keys, child.key], offset: 0 })}>
              <ChevronRight className="size-3 shrink-0" /><span className="max-w-[40%] truncate font-mono" title={child.key}>{child.key}</span>
              <span className="min-w-0 flex-1 truncate text-left font-mono text-muted-foreground">{child.node.preview}</span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(child.node.bytes)}</span>
            </Button>)}
          </div>}
        {(location.offset > 0 || node.nextOffset !== null) ? <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <Button variant="ghost" size="sm" disabled={busy || location.offset === 0} onClick={() => setLocation({ ...location, offset: Math.max(0, location.offset - (node.text === null ? 40 : 16384)) })}>{t('trajectory.previous')}</Button>
          <span className="tabular-nums text-muted-foreground">{location.offset.toLocaleString(locale)}</span>
          <Button variant="ghost" size="sm" disabled={busy || node.nextOffset === null} onClick={() => setLocation({ ...location, offset: node.nextOffset! })}>{t('trajectory.next')}</Button>
        </div> : null}
      </> : null}
    </FadeScroll>
  </div>
}

/** One page (80 summaries), one inspector (40 fields / 16 Ki characters), no
 * body cache or background polling. Capture notifications coalesce at 1 Hz. */
export function TrajectoryPane({ store, agentRuns }: { store: PiStore; agentRuns?: ReadonlyMap<string, SubagentRunDTO> }) {
  const { t, locale } = useI18n()
  const reduce = useReducedMotion() ?? false
  const parentPath = useSyncExternalStore(store.subscribe, () => store.getShell().sessionPath)
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => { setSource(null) }, [parentPath])
  const path = source && agentRuns?.has(source) ? source : parentPath
  const [page, setPage] = useState<TrajectoryPage | null>(null)
  const [selected, setSelected] = useState<TrajectoryRecord | null>(null)
  const [kind, setKind] = useState<TrajectoryKind | 'all'>('all')
  const [status, setStatus] = useState<TrajectoryStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<{ before?: number; after?: number }>({})
  const [epoch, setEpoch] = useState(0)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const rerun = useRef(false)
  const generation = useRef(0)
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => { setCursor({}); setPage(null); setSelected(null); generation.current++ }, [path, kind, status, query])
  const load = useCallback(async () => {
    if (!path) return
    if (inFlight.current) { rerun.current = true; return }
    const token = ++generation.current
    inFlight.current = true; setBusy(true)
    try {
      const value = await window.pi.trajectoryPage({ sessionPath: path, ...cursor, ...(kind !== 'all' ? { kind } : {}), ...(status !== 'all' ? { status } : {}), query })
      if (token !== generation.current) return
      setPage(value); setError(false)
      setSelected(previous => previous ? value.items.find(item => item.id === previous.id) ?? previous : value.items.at(-1) ?? null)
      setRevision(value => value + 1)
    } catch { if (token === generation.current) setError(true) }
    finally {
      inFlight.current = false
      setBusy(false)
      if (rerun.current) { rerun.current = false; setEpoch(value => value + 1) }
    }
  }, [path, cursor, kind, status, query])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load, epoch])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (event: { sessionPath: string }) => {
      if (event.sessionPath !== path || timer) return
      timer = setTimeout(() => { timer = undefined; setEpoch(value => value + 1) }, 1000)
    }
    const off = window.pi.onTrajectoryChanged(changed)
    const offRewind = window.pi.onRewind(event => { if (event.sessionPath === path) { setSelected(null); setCursor({}); changed(event) } })
    return () => { off(); offRewind(); if (timer) clearTimeout(timer) }
  }, [path])
  return <div data-trajectory-pane className="flex h-full min-h-0 flex-col text-foreground">
    <div className="space-y-2 border-b border-border px-3 py-2">
      {agentRuns?.size ? <Select value={path ?? ''} onValueChange={value => setSource(value === parentPath ? null : value)}><SelectTrigger className="w-full text-xs" aria-label={t('trajectory.source')}><SelectValue /></SelectTrigger><SelectContent portal>
        {parentPath ? <SelectItem value={parentPath}>{t('trajectory.currentSession')}</SelectItem> : null}
        {[...agentRuns].map(([path, run]) => <SelectItem key={path} value={path}>{run.description || run.profile}</SelectItem>)}
      </SelectContent></Select> : null}
      <div className="flex items-center gap-2"><Input value={search} onChange={setSearch} maxLength={200} aria-label={t('trajectory.search')} placeholder={t('trajectory.search')} className="min-w-0 flex-1" />
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('trajectory.refresh')} title={t('trajectory.refresh')} disabled={busy} onClick={() => setEpoch(value => value + 1)}><RefreshCw className="size-4" /></Button>
      </div>
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={value => setKind(value as TrajectoryKind | 'all')}><SelectTrigger className="min-w-0 flex-1 text-xs" aria-label={t('trajectory.kind')}><SelectValue /></SelectTrigger><SelectContent portal><SelectItem value="all">{t('trajectory.allKinds')}</SelectItem>{KINDS.map(kind => <SelectItem key={kind} value={kind}>{t(`trajectory.kind.${kind}`)}</SelectItem>)}</SelectContent></Select>
        <Select value={status} onValueChange={value => setStatus(value as TrajectoryStatus | 'all')}><SelectTrigger className="min-w-0 flex-1 text-xs" aria-label={t('trajectory.status')}><SelectValue /></SelectTrigger><SelectContent portal><SelectItem value="all">{t('trajectory.allStatuses')}</SelectItem>{STATUSES.map(status => <SelectItem key={status} value={status}>{t(`trajectory.status.${status}`)}</SelectItem>)}</SelectContent></Select>
      </div>
    </div>
    {page ? <TimingOverview records={page.items} onSelect={setSelected} /> : null}
    <FadeScroll className={cn('min-h-0 px-2 py-1', selected ? 'h-[30%] shrink-0' : 'flex-1')}>
      {page?.items.map(record => <Button data-trajectory-record={record.id} key={record.id} size="sm" variant={selected?.id === record.id ? 'secondary' : 'ghost'} className="h-10 w-full justify-start gap-2 px-1.5 text-xs" onClick={() => setSelected(record)}>
        <StatusRing className="size-3.5" reduce={reduce} status={record.status === 'running' ? 'running' : record.status === 'failed' ? 'error' : record.status === 'completed' ? 'success' : 'cancelled'} />
        <span className="min-w-0 flex-1 truncate text-left"><span className="text-muted-foreground">{t(`trajectory.kind.${record.kind}`)}</span>{record.kind === 'run' || record.kind === 'user' || record.kind === 'assistant' ? null : <> · {record.name}</>}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{record.finishedAt === undefined ? t(`trajectory.status.${record.status}`) : duration(record.finishedAt - record.startedAt)}</span>
      </Button>)}
      {busy && !page ? <p className="p-2 text-xs text-muted-foreground">{t('trajectory.loading')}</p> : null}
      {!busy && !page?.items.length ? <p className="p-2 text-xs text-muted-foreground">{t('trajectory.empty')}</p> : null}
      {error ? <p role="alert" className="p-2 text-xs text-destructive">{t('trajectory.error')}</p> : null}
    </FadeScroll>
    <div className="flex shrink-0 items-center justify-between gap-1 px-2 py-1 text-xs">
      <Button size="sm" variant="ghost" disabled={busy || !page?.older} onClick={() => { setSelected(null); setCursor({ before: page!.older! }) }}>{t('trajectory.older')}</Button>
      <span className="text-muted-foreground">{t('trajectory.count', { count: (page?.total ?? 0).toLocaleString(locale) })}</span>
      <Button size="sm" variant="ghost" disabled={busy || !page?.newer} onClick={() => { setSelected(null); setCursor({ after: page!.newer! }) }}>{t('trajectory.newer')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || (!cursor.before && !cursor.after)} onClick={() => { setSelected(null); setCursor({}) }}>{t('trajectory.latest')}</Button>
    </div>
    {selected && path ? <RecordInspector key={`${path}:${selected.id}`} path={path} record={selected} revision={revision} /> : null}
  </div>
}
