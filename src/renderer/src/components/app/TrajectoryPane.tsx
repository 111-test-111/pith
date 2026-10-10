import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useReducedMotion } from 'motion/react'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { Input } from '@/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { ChevronLeft, ChevronRight, Copy, Download, RefreshCw } from '@/lib/icons'
import { formatBytes } from '@/lib/format'
import { useI18n } from '@/i18n'
import type { PiStore } from '@/state/pi-store'
import type { TrajectoryDetail, TrajectoryNodePage, TrajectoryPage, TrajectoryQuery, TrajectoryRecord, TrajectoryStatus, SubagentRunDTO } from '../../../../shared/types'
import { FadeScroll } from './FadeScroll'
import { PanelResizeHandle } from './PanelResizeHandle'
import { TrajectoryRecordRow } from './TrajectoryRecordRow'
import type { TrajectoryPresentationKind } from '../../../../shared/trajectory'

const KINDS: TrajectoryPresentationKind[] = ['run', 'user', 'request', 'tool', 'compaction', 'retry', 'notification']
const STATUSES: TrajectoryStatus[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unavailable']
const duration = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)} s`
const SPLIT_STORAGE_KEY = 'pi-app:trajectory-split'
type SplitSizes = { narrow?: number; wide?: number }
function readSplitSizes(): SplitSizes {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object') return {}
    const sizes = value as SplitSizes
    return Object.fromEntries((['narrow', 'wide'] as const).filter(key =>
      typeof sizes[key] === 'number' && Number.isFinite(sizes[key]) && sizes[key] > 0 && sizes[key] < 10000
    ).map(key => [key, sizes[key]])) as SplitSizes
  } catch { return {} }
}
type NodeLocation = { trail: string[]; keys: string[]; offset: number }
type NodeView = { location: NodeLocation; node: TrajectoryNodePage }
type InspectorSeed = { path: string; record: TrajectoryRecord; detail: TrajectoryDetail | null; view: NodeView | null; error?: boolean }

function RecordInspector({ path, record, revision, initial }: { path: string; record: TrajectoryRecord; revision: number; initial: InspectorSeed }) {
  const { t, locale } = useI18n()
  const [detail, setDetail] = useState<TrajectoryDetail | null>(initial.detail)
  const [view, setView] = useState<NodeView | null>(initial.view)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(Boolean(initial.error))
  const [exporting, setExporting] = useState(false)
  const skipInitialLoad = useRef(Boolean(initial.detail))
  const viewRef = useRef(view)
  viewRef.current = view
  const destination = useRef<NodeLocation | null>(null)
  const nodeRequest = useRef(0)
  const current = useRef({ path, id: record.id })
  current.current = { path, id: record.id }
  const navigate = useCallback((location: NodeLocation) => {
    destination.current = location
    const request = ++nodeRequest.current
    setBusy(true)
    void window.pi.trajectoryNode({ sessionPath: path, recordId: record.id, trail: location.trail, offset: location.offset })
      .then(node => {
        if (request !== nodeRequest.current) return
        // Change the breadcrumb and its contents in one commit. Keeping the
        // previous view visible while loading avoids a blank-list flash.
        setView({ location, node }); setError(false)
      })
      .catch(() => { if (request === nodeRequest.current) setError(true) })
      .finally(() => { if (request === nodeRequest.current) setBusy(false) })
  }, [path, record.id])
  useEffect(() => () => { nodeRequest.current++ }, [path, record.id])
  useEffect(() => {
    if (skipInitialLoad.current) { skipInitialLoad.current = false; return }
    let active = true
    void window.pi.trajectoryDetail(path, record.id).then(value => {
      if (!active) return
      setDetail(value); setError(false)
      const previous = destination.current ?? viewRef.current?.location
      const owner = previous && value.documents.find(doc => doc.node.id === previous.trail[0])
      if (previous && owner) {
        const label = t(`trajectory.doc.${owner.kind}`)
        navigate(label === previous.keys[0] ? previous : { ...previous, keys: [label, ...previous.keys.slice(1)] })
      } else {
        const doc = value.documents.find(doc => doc.kind === 'payload') ?? value.documents[0]
        if (doc) navigate({ trail: [doc.node.id], keys: [t(`trajectory.doc.${doc.kind}`)], offset: 0 })
      }
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [path, record.id, record.status, revision, t, navigate])
  const exportRecord = async () => {
    setExporting(true)
    try {
      const result = await window.pi.exportTrajectory(path, record.id)
      if (current.current.path === path && current.current.id === record.id) setError(result.status === 'error')
    } catch { setError(true) }
    finally { setExporting(false) }
  }
  const shown = detail?.record ?? record
  const location = view?.location ?? null
  const node = view?.node ?? null
  const modelName = shown.kind === 'request' ? (shown.model ?? shown.name) : shown.model
  const title = shown.kind === 'request' || shown.kind === 'assistant'
    ? [t('trajectory.kind.request'), modelName].filter(Boolean).join(' · ')
    : shown.kind === 'run' || shown.kind === 'user' ? t(`trajectory.kind.${shown.kind}`) : shown.name
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
  return <div data-trajectory-inspector={record.id} className="pane-detail flex flex-col">
    <div className="flex h-10 shrink-0 items-center gap-2 px-3">
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
      <Button variant="ghost" size="icon" className="size-7" disabled={exporting} onClick={() => void exportRecord()} title={t('trajectory.export')} aria-label={t('trajectory.export')}><Download className="size-4" /></Button>
    </div>
    <FadeScroll className="min-h-0 flex-1 p-3 pt-1">
      <div className="pane-data">
      {shown.captureError ? <p className="mb-2 text-xs text-destructive">{t('trajectory.captureError')}</p> : null}
      {!shown.captured ? <p className="mb-2 text-xs text-muted-foreground">{t('trajectory.reconstructed')}</p> : null}
      {shown.kind === 'request' && detail && !detail.documents.some(doc => doc.kind === 'payload') ? <p className="mb-2 text-xs text-muted-foreground">{t('trajectory.noPayload')}</p> : null}
      <div className="trajectory-facts text-xs">
        {facts.filter(([key]) => [t('trajectory.duration'), t('trajectory.firstToken'), t('trajectory.tokens')].includes(key)).map(([key, value]) =>
          <div key={key} className="min-w-0"><p className="truncate text-muted-foreground">{key}</p><p className="mt-0.5 break-words tabular-nums">{value}</p></div>)}
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
        {detail?.documents.map(doc => <Button key={doc.kind} data-trajectory-document={doc.kind} variant="ghost" size="sm" className="trajectory-choice" aria-pressed={location?.trail[0] === doc.node.id}
          onClick={() => navigate({ trail: [doc.node.id], keys: [t(`trajectory.doc.${doc.kind}`)], offset: 0 })}>
          {t(`trajectory.doc.${doc.kind}`)}<span className="text-muted-foreground">{formatBytes(doc.node.bytes)}</span>
        </Button>)}
      </div>
      {location ? <div className="mb-2 flex items-center gap-1">
        <Button data-trajectory-up size="icon" variant="ghost" className="size-6 shrink-0" aria-label={t('trajectory.up')} disabled={location.trail.length === 1}
          onClick={() => navigate({ trail: location.trail.slice(0, -1), keys: location.keys.slice(0, -1), offset: 0 })}><ChevronLeft className="size-3.5" /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={location.keys.join(' / ')}>{location.keys.join(' / ')}</span>
        {node?.text !== null && node?.text !== undefined ? <Button size="icon" variant="ghost" className="size-6" aria-label={t('trajectory.copyFragment')} title={t('trajectory.copyFragment')}
          onClick={() => { void navigator.clipboard.writeText(node.text!).catch(() => setError(true)) }}><Copy className="size-3.5" /></Button> : null}
      </div> : null}
      {busy && !view ? <p className="py-2 text-xs text-muted-foreground">{t('trajectory.loading')}</p> : null}
      {error ? <p role="alert" className="py-2 text-xs text-destructive">{t('trajectory.error')}</p> : null}
      {node && location ? <>
        {node.text !== null ? <pre data-trajectory-value className="whitespace-pre-wrap break-all rounded-control bg-muted px-1 py-1.5 font-mono text-code">{node.text}</pre> :
          <div className="space-y-0.5" data-trajectory-fields>
            {node.children.map((child, index) => <Button key={`${location.offset}:${index}`} variant="ghost" size="sm" className="h-auto w-full justify-start gap-2 px-1 py-1.5 text-xs"
              onClick={() => navigate({ trail: [...location.trail, child.node.id], keys: [...location.keys, child.key], offset: 0 })}>
              <ChevronRight className="size-3 shrink-0" /><span className="max-w-[40%] truncate font-mono text-code-inline" title={child.key}>{child.key}</span>
              <span className="min-w-0 flex-1 truncate text-left font-mono text-code-inline text-muted-foreground">{child.node.preview}</span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(child.node.bytes)}</span>
            </Button>)}
          </div>}
        {(location.offset > 0 || node.nextOffset !== null) ? <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <Button variant="ghost" size="sm" disabled={location.offset === 0} onClick={() => navigate({ ...location, offset: Math.max(0, location.offset - (node.text === null ? 40 : 16384)) })}>{t('trajectory.previous')}</Button>
          <span className="tabular-nums text-muted-foreground">{location.offset.toLocaleString(locale)}</span>
          <Button variant="ghost" size="sm" disabled={node.nextOffset === null} onClick={() => navigate({ ...location, offset: node.nextOffset! })}>{t('trajectory.next')}</Button>
        </div> : null}
      </> : null}
      </div>
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
  const [inspected, setInspected] = useState<InspectorSeed | null>(null)
  const inspectedRef = useRef(inspected)
  inspectedRef.current = inspected
  const [kind, setKind] = useState<TrajectoryPresentationKind | 'all'>('all')
  const [status, setStatus] = useState<TrajectoryStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<Pick<TrajectoryQuery, 'before' | 'after' | 'toolCall'>>({})
  const [epoch, setEpoch] = useState(0)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const rerun = useRef(false)
  const generation = useRef(0)
  const toolJump = useRef(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const savedSplit = useRef<SplitSizes | null>(null)
  savedSplit.current ??= readSplitSizes()
  const [wide, setWide] = useState(false)
  const [splitValue, setSplitValue] = useState<number>()
  const splitDrag = useRef<{ start: number; min: number; max: number; value: number; axis: 'width' | 'height' } | null>(null)
  useLayoutEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    if (savedSplit.current?.narrow) workspace.style.setProperty('--trajectory-master-height', `${savedSplit.current.narrow}px`)
    if (savedSplit.current?.wide) workspace.style.setProperty('--trajectory-master-width', `${savedSplit.current.wide}px`)
    const measure = () => {
      const isWide = workspace.clientWidth >= 48 * parseFloat(getComputedStyle(document.documentElement).fontSize)
      setWide(isWide)
      const master = workspace.querySelector<HTMLElement>('[data-trajectory-master]')
      if (master) setSplitValue(master.getBoundingClientRect()[isWide ? 'width' : 'height'])
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const master = workspaceRef.current?.querySelector<HTMLElement>('[data-trajectory-master]')
    if (master) setSplitValue(master.getBoundingClientRect()[wide ? 'width' : 'height'])
  }, [selected?.id, wide])
  const startSplitResize = () => {
    const workspace = workspaceRef.current
    const master = workspace?.querySelector<HTMLElement>('[data-trajectory-master]')
    if (!workspace || !master) return
    const axis = wide ? 'width' : 'height'
    const em = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const start = master.getBoundingClientRect()[axis]
    const min = (wide ? 14 : 8) * em
    const max = Math.max(min, workspace.getBoundingClientRect()[axis] - (wide ? 20 : 10) * em - 6)
    splitDrag.current = { start, min, max, value: start, axis }
  }
  const resizeSplit = (delta: number) => {
    const drag = splitDrag.current
    if (!drag) return
    drag.value = Math.min(drag.max, Math.max(drag.min, drag.start + delta))
    workspaceRef.current?.style.setProperty(drag.axis === 'width' ? '--trajectory-master-width' : '--trajectory-master-height', `${drag.value}px`)
  }
  const endSplitResize = () => {
    if (splitDrag.current) {
      const key = splitDrag.current.axis === 'width' ? 'wide' : 'narrow'
      savedSplit.current![key] = splitDrag.current.value
      try { localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(savedSplit.current)) } catch { /* layout still works if storage is unavailable */ }
      setSplitValue(splitDrag.current.value)
    }
    splitDrag.current = null
  }
  useEffect(() => {
    if (!selected || !path) { setInspected(null); return }
    if (inspectedRef.current?.path === path && inspectedRef.current.record.id === selected.id) return
    let active = true
    if (inspectedRef.current?.path !== path) setInspected(null)
    void (async () => {
      const detail = await window.pi.trajectoryDetail(path, selected.id)
      const doc = detail.documents.find(item => item.kind === 'payload') ?? detail.documents[0]
      const location = doc ? { trail: [doc.node.id], keys: [t(`trajectory.doc.${doc.kind}`)], offset: 0 } : null
      const node = location ? await window.pi.trajectoryNode({ sessionPath: path, recordId: selected.id, trail: location.trail, offset: 0 }) : null
      if (active) setInspected({ path, record: selected, detail, view: location && node ? { location, node } : null })
    })().catch(() => { if (active) setInspected({ path, record: selected, detail: null, view: null, error: true }) })
    return () => { active = false }
  }, [path, selected?.id, t])
  // A tool-call jump must reveal its row inside this list only. Never
  // scroll the inspector or the covered chat along with it.
  useLayoutEffect(() => {
    const row = paneRef.current?.querySelector<HTMLElement>('[data-trajectory-record][aria-pressed="true"]')
    const viewport = row?.closest<HTMLElement>('[data-trajectory-list]')
    if (!row || !viewport) return
    const item = row.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    if (item.top < bounds.top) viewport.scrollTop += item.top - bounds.top - 4
    else if (item.bottom > bounds.bottom) viewport.scrollTop += item.bottom - bounds.bottom + 4
  }, [selected?.id, page])
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => { toolJump.current = false; setCursor({}); setPage(null); setSelected(null); generation.current++ }, [path])
  useEffect(() => {
    // Jumping clears filters in the same render as its destination cursor.
    // Let that cursor load instead of resetting it back to the latest page.
    if (toolJump.current && kind === 'all' && status === 'all' && !query) return
    toolJump.current = false; setCursor({}); setPage(null); setSelected(null); generation.current++
  }, [kind, status, query])
  const jumpTool = useCallback((call: NonNullable<TrajectoryQuery['toolCall']>) => {
    const visible = page?.items.find(record => record.kind === 'tool' && record.parentId === call.recordId && record.toolCallId === call.callId)
    if (visible) { setSelected(visible); return }
    toolJump.current = true
    setKind('all'); setStatus('all'); setSearch(''); setQuery('')
    setCursor({ toolCall: call })
  }, [page])
  const load = useCallback(async () => {
    if (!path) return
    if (inFlight.current) { rerun.current = true; return }
    const token = ++generation.current
    inFlight.current = true; setBusy(true)
    try {
      const value = await window.pi.trajectoryPage({ sessionPath: path, ...cursor, ...(kind !== 'all' ? { kind } : {}), ...(status !== 'all' ? { status } : {}), query })
      if (token !== generation.current) return
      setPage(value); setError(false)
      const jumping = toolJump.current
      setSelected(previous => jumping ? value.items.find(item => item.id === value.targetId) ?? null : previous ? value.items.find(item => item.id === previous.id) ?? previous : value.items.at(-1) ?? null)
      toolJump.current = false
      setRevision(value => value + 1)
    } catch { if (token === generation.current) { toolJump.current = false; setError(true) } }
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
  const hasInspector = Boolean(selected && inspected && inspected.path === path)
  return <div ref={paneRef} data-trajectory-pane className="sidebar-pane-container flex h-full min-h-0 min-w-0 flex-col text-foreground">
    <div data-trajectory-toolbar className="trajectory-toolbar shrink-0 border-b border-border px-3 py-2">
      {agentRuns?.size ? <div className="trajectory-source"><Select value={path ?? ''} onValueChange={value => setSource(value === parentPath ? null : value)}><SelectTrigger className="h-8 w-full text-xs" aria-label={t('trajectory.source')}><SelectValue className="min-w-0 truncate" /></SelectTrigger><SelectContent portal>
        {parentPath ? <SelectItem value={parentPath}>{t('trajectory.currentSession')}</SelectItem> : null}
        {[...agentRuns].map(([path, run]) => <SelectItem key={path} value={path}>{run.description || run.profile}</SelectItem>)}
      </SelectContent></Select></div> : null}
      <div className="trajectory-search flex items-center gap-2"><Input value={search} onChange={setSearch} maxLength={200} aria-label={t('trajectory.search')} placeholder={t('trajectory.search')} className="min-w-0 flex-1"  />
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('trajectory.refresh')} title={t('trajectory.refresh')} disabled={busy} onClick={() => setEpoch(value => value + 1)}><RefreshCw className="size-4" /></Button>
      </div>
      <div className="trajectory-filters flex items-center gap-2">
        <Select value={kind} onValueChange={value => setKind(value as TrajectoryPresentationKind | 'all')}><SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label={t('trajectory.kind')}><SelectValue /></SelectTrigger><SelectContent portal><SelectItem value="all">{t('trajectory.allKinds')}</SelectItem>{KINDS.map(kind => <SelectItem key={kind} value={kind}>{t(`trajectory.kind.${kind}`)}</SelectItem>)}</SelectContent></Select>
        <Select value={status} onValueChange={value => setStatus(value as TrajectoryStatus | 'all')}><SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label={t('trajectory.status')}><SelectValue /></SelectTrigger><SelectContent portal><SelectItem value="all">{t('trajectory.allStatuses')}</SelectItem>{STATUSES.map(status => <SelectItem key={status} value={status}>{t(`trajectory.status.${status}`)}</SelectItem>)}</SelectContent></Select>
      </div>
    </div>
    <div ref={workspaceRef} data-trajectory-workspace data-has-detail={hasInspector} className="pane-workspace">
    <div data-trajectory-master className="pane-master">
    <FadeScroll data-trajectory-list className="min-h-0 flex-1 px-2 py-1">
      {page?.items.map(record => <TrajectoryRecordRow key={record.id} record={record} selected={selected?.id === record.id} reduce={reduce} onSelect={setSelected} onToolSelect={jumpTool} />)}
      {busy && !page ? <p className="p-2 text-xs text-muted-foreground">{t('trajectory.loading')}</p> : null}
      {!busy && !page?.items.length ? <p className="p-2 text-xs text-muted-foreground">{t('trajectory.empty')}</p> : null}
      {error ? <p role="alert" className="p-2 text-xs text-destructive">{t('trajectory.error')}</p> : null}
    </FadeScroll>
    <div data-trajectory-pagination className="trajectory-pagination shrink-0 px-2 py-1 text-xs">
      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" disabled={busy || !page?.older} onClick={() => { setSelected(null); setCursor({ before: page!.older! }) }}>{t('trajectory.older')}</Button>
      <span className="trajectory-pagination-count text-muted-foreground">{t('trajectory.count', { count: (page?.total ?? 0).toLocaleString(locale) })}</span>
      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" disabled={busy || !page?.newer} onClick={() => { setSelected(null); setCursor({ after: page!.newer! }) }}>{t('trajectory.newer')}</Button>
      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" disabled={busy || (!cursor.before && !cursor.after && !cursor.toolCall)} onClick={() => { setSelected(null); setCursor({}) }}>{t('trajectory.latest')}</Button>
    </div>
    </div>
    {hasInspector ? <PanelResizeHandle grow={wide ? 'right' : 'down'} inset={false} className="trajectory-split-handle block" label={t('trajectory.resizeSplit')}
      value={splitValue} onResizeStart={startSplitResize} onResize={resizeSplit} onResizeEnd={endSplitResize}
      onStep={delta => { startSplitResize(); resizeSplit(delta); endSplitResize() }} /> : null}
    {hasInspector && inspected ? <RecordInspector key={`${inspected.path}:${inspected.record.id}`} path={inspected.path} record={inspected.record} revision={revision} initial={inspected} /> : null}
    </div>
  </div>
}
