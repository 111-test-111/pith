import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { AlertTriangle, ArrowLeftFromLine, Check, ChevronRight } from '@/lib/icons'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { Button } from '@/components/motion/button'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { RewindPatchCache, type RewindTotals } from '@/lib/rewind-preview'
import { refreshViewportVisibility, useViewportVisibility } from '@/lib/hooks/use-viewport-visibility'
import { ReviewCollapseButton, ReviewFileHeader, ReviewDiffBody } from './ReviewDiff'
import { RewindActions } from './RewindActions'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { RewindChangeDTO, RewindCommitDTO, RewindErrorDTO, RewindListDTO, RewindMode, RewindOperationDTO, RewindPreviewDTO, RewindStatsDTO, RewindUncoveredPathDTO } from '../../../../shared/types'

function ErrorMessage({ error, message }: { error: RewindErrorDTO; message?: string }) {
  const { t } = useI18n()
  return <div role="alert" data-rewind-error={error.code} className="space-y-1 rounded-card bg-destructive/5 p-3 text-sm text-destructive">
    <p>{message ?? t(`rewind.error.${error.code}`)}</p>
    {error.paths?.length ? <p className="max-h-28 overflow-auto break-all text-xs">{error.paths.join('\n')}</p> : null}
  </div>
}

function UncoveredFiles({ paths }: { paths: RewindUncoveredPathDTO[] }) {
  const { t } = useI18n()
  const [visible, setVisible] = useState(100)
  return <div className="max-h-36 space-y-1 overflow-auto p-1 text-xs">
    {paths.slice(0, visible).map(item => <p key={item.path} className="break-all">{item.path} <span className="text-muted-foreground">· {t(`rewind.uncovered.${item.reason}`)}</span></p>)}
    {paths.length > visible ? <Button variant="ghost" size="sm" onClick={() => setVisible(count => count + 100)}>{t('rewind.moreUncovered', { count: paths.length - visible })}</Button> : null}
  </div>
}

function SkippedHistory({ paths }: { paths: RewindUncoveredPathDTO[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div data-rewind-skipped>
    <Button variant="ghost" size="sm" className="h-auto px-0 py-1 text-xs text-amber-600 dark:text-amber-400" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><AlertTriangle className="size-3.5 shrink-0" />{t('rewind.skippedCount', { count: paths.length })}</Button>
    <AgentDisclosure id={id} open={open}>{open ? <UncoveredFiles paths={paths} /> : null}</AgentDisclosure>
  </div>
}

function HistoryRow({ operation, selected, disabled, dates, onPreview }: {
  operation: RewindOperationDTO
  selected: boolean
  disabled: boolean
  dates: Intl.DateTimeFormat
  onPreview: () => void
}) {
  const { t } = useI18n()
  const available = operation.canUndo || operation.canRedo
  const file = operation.file
  const slash = file?.lastIndexOf('/') ?? -1
  const subject = file ?? t(`rewind.mode.${operation.mode}`)
  const timestamp = dates.format(operation.timestamp)
  const status = operation.status === 'committed'
    ? t(operation.undoOf ? 'rewind.historyUndone' : operation.redoOf ? 'rewind.historyRedone' : 'rewind.historyRestored')
    : t(`rewind.status.${operation.status}`)
  const needsRecovery = !['committed', 'rolled-back'].includes(operation.status)
  const content = <>
    <span className="flex min-w-0 items-center gap-2">
      <span data-rewind-history-subject className="flex min-w-0 flex-1 text-sm font-medium text-foreground">
        {file ? <><span className="min-w-0 truncate font-normal text-muted-foreground">{slash >= 0 ? file.slice(0, slash + 1) : ''}</span><span className="max-w-full shrink-0 truncate">{file.slice(slash + 1)}</span></> : <span className="truncate">{subject}</span>}
      </span>
      {selected ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : available ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </span>
    <span className="flex items-center justify-between gap-2 text-xs">
      <span data-rewind-history-status className={cn('flex min-w-0 items-center gap-1.5', needsRecovery ? 'text-destructive' : 'text-muted-foreground')}>
        {needsRecovery ? <AlertTriangle aria-hidden="true" className="size-3 shrink-0" /> : null}{status}
      </span>
      {available ? <span className="shrink-0 text-primary">{t(operation.canRedo ? 'rewind.historyCanRedo' : 'rewind.historyCanUndo')}</span> : null}
    </span>
    <time dateTime={new Date(operation.timestamp).toISOString()} className="text-caption tabular-nums text-muted-foreground">{timestamp}</time>
  </>
  const rowClass = 'flex h-auto w-full flex-col items-stretch gap-1.5 px-3 py-2.5 text-left font-normal'
  return <li data-rewind-history-entry={operation.id} className={cn('rounded-control border border-transparent', selected && 'bg-primary/10')}>
    {available ? <Button data-rewind-history-preview={operation.canRedo ? 'redo' : 'undo'} variant="ghost" disabled={disabled} aria-current={selected ? 'true' : undefined}
      aria-label={t('rewind.historyPreview', { action: t(operation.canRedo ? 'rewind.redo' : 'rewind.undo'), subject, time: timestamp })}
      className={rowClass} onClick={onPreview}>{content}</Button>
      : <div className={rowClass}>{content}</div>}
    {!!operation.skipped?.length ? <div className="px-3 pb-2"><SkippedHistory paths={operation.skipped} /></div> : null}
  </li>
}

const changeKey = (change: RewindChangeDTO) => `${change.area}:${change.stage ?? 0}:${change.path}`
const patchKey = (preview: RewindPreviewDTO, change: RewindChangeDTO) => `${preview.token}:${changeKey(change)}`
function readPatch(cache: RewindPatchCache, path: string, preview: RewindPreviewDTO, change: RewindChangeDTO, prefetch = false, needed?: () => boolean) {
  return cache.read(patchKey(preview, change), async () => {
    const reply = await window.pi.rewindPatch(path, preview.token, change.path, change.area, change.stage)
    if ('error' in reply) throw reply.error
    return reply.value
  }, prefetch, needed)
}

function PreviewTotals({ path, preview, cache }: { path: string; preview: RewindPreviewDTO; cache: RewindPatchCache }) {
  const { t } = useI18n()
  const [totals, setTotals] = useState<RewindTotals | undefined>(cache.totals)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (cache.totals) { setTotals(cache.totals); return }
    let cancelled = false
    setFailed(false)
    void (async () => {
      const total: RewindTotals = { added: 0, removed: 0, binary: 0 }
      for (let offset = 0; offset < preview.changes.length; offset += 16) {
        // Let visible rows schedule first, and check cancellation between
        // bounded batches instead of holding the worker for the whole repo.
        await new Promise(resolve => setTimeout(resolve, 0))
        if (cancelled) return
        const chunk = preview.changes.slice(offset, offset + 16)
        const stats = await cache.readStatsBatch(chunk.map(change => patchKey(preview, change)), async indices => {
          const reply = await window.pi.rewindStatsBatch(path, preview.token, indices.map(index => chunk[index]))
          if ('error' in reply) throw reply.error
          return reply.value
        })
        for (const value of stats) {
          if (value.binary) total.binary++
          else { total.added += value.added; total.removed += value.removed }
        }
      }
      if (!cancelled) { cache.totals = total; setTotals(total) }
    })().catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [path, preview, cache, retry])
  return <span data-rewind-totals aria-busy={!totals && !failed} className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
    <span className="hidden text-muted-foreground @min-[500px]:inline">{t('rewind.total')}</span>
    {totals ? <span aria-label={t('rewind.totalLines', { added: totals.added, removed: totals.removed })} className="flex gap-1.5 font-mono tabular-nums"><span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span><span className="text-rose-600 dark:text-rose-400">−{totals.removed}</span></span>
      : failed ? <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setRetry(value => value + 1)}>{t('rewind.totalRetry')}</Button>
      : <span className="text-muted-foreground">{t('rewind.totalLoading')}</span>}
    {totals?.binary ? <span className="text-muted-foreground">{t('rewind.totalBinary', { count: totals.binary })}</span> : null}
  </span>
}

function DiffRow({ path, preview, change, neighbors, collapsed, layoutKey, onToggle, scrollRootRef, cache, onRestore, restoreDisabled }: {
  path: string; preview: RewindPreviewDTO; change: RewindChangeDTO; collapsed: boolean; onToggle: () => void
  scrollRootRef: RefObject<HTMLElement | null>; cache: RewindPatchCache
  onRestore?: () => void; restoreDisabled?: boolean
  neighbors: RewindChangeDTO[]; layoutKey: unknown
}) {
  const { t } = useI18n()
  const { ref, visible, checkVisibility } = useViewportVisibility<HTMLElement>(scrollRootRef)
  const wantsBody = useRef(!collapsed)
  wantsBody.current = !collapsed
  const canRead = useCallback(() => wantsBody.current && checkVisibility(), [checkVisibility])
  const key = patchKey(preview, change)
  const subscribe = useCallback((listener: () => void) => cache.subscribe(key, listener), [cache, key])
  const snapshot = useCallback(() => cache.peek(key), [cache, key])
  const result = useSyncExternalStore(subscribe, snapshot)
  const [error, setError] = useState<RewindErrorDTO>()
  const bodyHeight = useRef(100)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentId = useId()
  const [stats, setStats] = useState<RewindStatsDTO>()
  const [statsFailed, setStatsFailed] = useState(false)
  useEffect(() => {
    if (!visible || change.binary) return
    let cancelled = false
    void cache.readStats(`${preview.token}:${change.area}:${change.stage ?? 0}:${change.path}`, async () => {
      const reply = await window.pi.rewindStats(path, preview.token, change.path, change.area, change.stage)
      if ('error' in reply) throw reply.error
      return reply.value
    }).then(value => { if (!cancelled) { setStats(value); setStatsFailed(false) } }, () => { if (!cancelled) setStatsFailed(true) })
    return () => { cancelled = true }
  }, [visible, path, preview.token, change, cache])
  useLayoutEffect(() => {
    if (visible && !collapsed && bodyRef.current) bodyHeight.current = bodyRef.current.offsetHeight
  }, [visible, collapsed, result, error])
  useLayoutEffect(() => visible && !collapsed ? cache.pin(key) : undefined, [visible, collapsed, cache, key])
  useEffect(() => {
    if (collapsed || !visible) return
    if (change.binary) return
    let cancelled = false
    setError(undefined)
    void readPatch(cache, path, preview, change, false, canRead).catch(failure => {
      if (failure?.code === 'cancelled') return
      if (!cancelled) setError(failure && typeof failure === 'object' && 'code' in failure ? failure : { code: 'storage' })
    })
    return () => { cancelled = true }
  }, [collapsed, visible, path, preview.token, change, cache, canRead])
  useEffect(() => {
    if (!visible || collapsed) return
    // Adjacent bodies are ready when a tall diff above them is collapsed;
    // prefetch bytes only, leaving offscreen parsing and DOM unmounted.
    for (const neighbor of neighbors) if (!neighbor.binary) void readPatch(cache, path, preview, neighbor, true, canRead).catch(() => {})
  }, [visible, collapsed, path, preview, neighbors, cache, canRead])
  return <section ref={ref}>
    <ReviewFileHeader pathTooltip={false} displayPath={change.path || t('rewind.indexMetadata')} collapsed={collapsed} onToggle={onToggle} contentId={contentId} added={stats?.added} removed={stats?.removed} showZeroStats={!!stats}
      statsLabel={change.binary || stats?.binary ? t('rewind.binaryLabel') : statsFailed ? t('rewind.statsUnavailable') : !stats ? t('rewind.statsLoading') : undefined}
      detail={<span className="shrink-0 text-xs text-muted-foreground">{change.stage ? t('rewind.indexStage', { stage: change.stage }) : t(`rewind.area.${change.area}`)}</span>}
      action={onRestore ? <Button data-rewind-file-restore={change.path} variant="ghost" size="icon" className="size-6 shrink-0" disabled={restoreDisabled} aria-label={t('rewind.restoreFile', { path: change.path })} onClick={onRestore}><ArrowLeftFromLine aria-hidden="true" className="size-3.5" /></Button> : null} />
    {collapsed ? null : !visible ? <div id={contentId} data-rewind-placeholder aria-hidden="true" style={{ height: bodyHeight.current }} /> : <div id={contentId} ref={bodyRef}>
      {change.beforeMode !== change.afterMode || change.binary || (result && !result.patch) ? <p className="px-3 py-2 text-xs text-muted-foreground">{t(`rewind.change.${change.kind}`)} · {t('rewind.fileMetadata', { bytes: change.bytes, before: change.beforeMode?.toString(8) ?? '—', after: change.afterMode?.toString(8) ?? '—' })}</p> : null}
      {change.binary ? <p className="px-3 pb-2 text-xs text-muted-foreground">{t('rewind.binary')}</p> : error ? <ErrorMessage error={error} /> : result ? <>
        {result.patch ? <ReviewDiffBody patch={result.patch} displayPath={change.path} scrollRootRef={scrollRootRef} layoutKey={layoutKey} /> : <p className="px-3 pb-2 text-xs text-muted-foreground">{t(result.binary ? 'rewind.binary' : 'rewind.metadataOnly')}</p>}
        {result.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('rewind.truncated')}</p> : null}
      </> : <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">{t('rewind.loading')}</p>}
    </div>}
  </section>
}

/** The preview is the confirmation surface. Its token identifies the exact
 * disk plan; changing a mode never silently refreshes that plan.
 *
 * An anchored open (`messageEntryId` names one user turn) lands ON that turn's
 * before-turn checkpoint instead of listing it for a second click, and
 * `initialMode` preselects the restore mode the entry point stands for — the
 * user bubble's Rewind is conversation-only, the changed-files list's Undo is
 * files-only. The preference rides only that first automatic selection; a
 * manual click afterwards keeps the ordinary defaults, and the user can still
 * switch modes in the toolbar. */
export function RewindDialog({ sessionPath, messageTimestamp, messageEntryId, initialMode, onClose, onCommitted }: {
  sessionPath: string | null
  messageTimestamp?: number
  messageEntryId?: string
  initialMode?: RewindMode
  onClose: () => void
  onCommitted: (value: RewindCommitDTO) => void
}) {
  const { t, locale } = useI18n()
  const [list, setList] = useState<RewindListDTO>()
  const [preview, setPreview] = useState<RewindPreviewDTO>()
  const [filePreview, setFilePreview] = useState<RewindPreviewDTO>()
  const [mode, setMode] = useState<RewindMode>('conversation')
  const [error, setError] = useState<RewindErrorDTO>()
  const [loading, setLoading] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [success, setSuccess] = useState<RewindOperationDTO>()
  const [confirming, setConfirming] = useState(false)
  const cancelConfirmRef = useRef<HTMLButtonElement>(null)
  const restoreButtonRef = useRef<HTMLButtonElement>(null)
  const cancelConfirm = () => {
    const file = filePreview?.file
    setConfirming(false); setFilePreview(undefined)
    requestAnimationFrame(() => {
      const button = file ? [...document.querySelectorAll<HTMLButtonElement>('[data-rewind-file-restore]')].find(node => node.dataset.rewindFileRestore === file) : undefined
      ;(button ?? restoreButtonRef.current)?.focus({ preventScroll: true })
    })
  }
  const [visibleRows, setVisibleRows] = useState(100)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const bodyRef = useRef<HTMLDivElement>(null)
  const cache = useMemo(() => new RewindPatchCache(), [sessionPath, preview?.token])
  useEffect(() => cache.retain(), [cache])
  useLayoutEffect(() => refreshViewportVisibility(bodyRef.current), [collapsed, preview])
  const allCollapsed = !!preview?.changes.length && preview.changes.every(change => collapsed[changeKey(change)])
  const epoch = useRef(0)
  const operation = useRef<{ key: string; id: string } | undefined>(undefined)
  /** One automatic selection per anchored open; the interval reloads `list`
   * with a fresh identity, so the guard is a ref and not a dep comparison. */
  const autoSelected = useRef(false)
  const busy = useRef(false)
  busy.current = executing
  useLayoutEffect(() => {
    if (!sessionPath) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      // The opener can be the title-row checkpoint action, whose pocket
      // unmounts as the dialog opens: then the chevron that owns that pocket
      // takes the focus, so it never drops to the body.
      const target = (opener?.isConnected ? opener : null)
        ?? document.querySelector<HTMLElement>('[data-titlebar-action="rewind"], [data-titlebar-more]')
      target?.focus()
    }
  }, [sessionPath])
  const descriptionId = useId()
  const confirmDescriptionId = useId()
  const confirmation = useRef({ confirming, cancelConfirm })
  confirmation.current = { confirming, cancelConfirm }
  // Both beUI contexts stay stable so cancelling the child preserves the
  // mounted preview and returns focus without restarting the parent modal.
  const changeOpen = useCallback((next: boolean) => { if (!next && !busy.current) { if (confirmation.current.confirming) confirmation.current.cancelConfirm(); else onClose() } }, [onClose])
  const changeConfirmOpen = useCallback((next: boolean) => { if (!next && !busy.current) confirmation.current.cancelConfirm() }, [])
  const load = useCallback(async () => {
    if (!sessionPath) return
    const generation = epoch.current
    try {
      const reply = await window.pi.rewindList(sessionPath)
      if (generation !== epoch.current) return
      if ('error' in reply) setError(reply.error); else setList(reply.value)
    } catch { if (generation === epoch.current) setError({ code: 'storage' }) }
  }, [sessionPath])
  useEffect(() => {
    ++epoch.current; setConfirming(false); setFilePreview(undefined); setLoading(false); setFileLoading(false); setList(undefined); setPreview(undefined); setError(undefined); setSuccess(undefined); setMode(initialMode ?? 'conversation')
    autoSelected.current = false
    operation.current = undefined
    if (!sessionPath) return
    void load()
    const unsubscribe = window.pi.onRewind(event => { if (event.sessionPath === sessionPath && !busy.current) void load() })
    const timer = setInterval(() => { if (!busy.current) void load() }, 2000)
    return () => { ++epoch.current; unsubscribe(); clearInterval(timer) }
  }, [sessionPath, messageEntryId, initialMode, load])
  const select = async (id: string, action?: 'undo' | 'redo', actionMode?: RewindMode) => {
    if (!sessionPath || executing) return
    const generation = ++epoch.current
    setLoading(true); setPreview(undefined); setFilePreview(undefined); setError(undefined); setSuccess(undefined); setVisibleRows(100); setCollapsed({})
    operation.current = undefined
    try {
      const reply = await window.pi.rewindPreview(sessionPath, id, action)
      if (generation !== epoch.current) return
      if ('error' in reply) setError(reply.error)
      else { setPreview(reply.value); setMode(actionMode ?? (reply.value.conversationUnavailable ? 'files' : 'conversation')) }
    } catch { if (generation === epoch.current) setError({ code: 'storage' }) }
    finally { if (generation === epoch.current) setLoading(false) }
  }
  // The anchored open selects its checkpoint by itself. `files`/`all` ride
  // along as the preselected mode; `conversation` is the ordinary default and
  // stays unnamed so `conversationUnavailable` can still fall back to `files`.
  useEffect(() => {
    if (!sessionPath || messageEntryId === undefined || autoSelected.current || !list) return
    const target = list.checkpoints.find(cp => cp.trigger === 'before-turn' && cp.messageEntryId === messageEntryId)
    if (!target) return
    autoSelected.current = true
    void select(target.id, undefined, initialMode === 'files' || initialMode === 'all' ? initialMode : undefined)
  }, [sessionPath, messageEntryId, initialMode, list])
  const requestFile = async (file: string) => {
    if (!sessionPath || !preview || loading || fileLoading || executing) return
    const generation = ++epoch.current
    setFileLoading(true); setError(undefined); setFilePreview(undefined)
    try {
      const reply = await window.pi.rewindPreviewFile(sessionPath, preview.token, file)
      if (generation !== epoch.current) return
      if ('error' in reply) setError(reply.error)
      else { setFilePreview(reply.value); setConfirming(true) }
    } catch { if (generation === epoch.current) setError({ code: 'storage' }) }
    finally { if (generation === epoch.current) setFileLoading(false) }
  }
  const commit = async (recoveryId?: string, skipUncovered = false) => {
    if (!sessionPath || executing || (!preview && !recoveryId)) return
    const singlePreview = recoveryId ? undefined : filePreview
    setConfirming(false); setFilePreview(undefined); setExecuting(true); setError(undefined); setSuccess(undefined)
    const generation = epoch.current
    try {
      const selected = singlePreview ?? preview, selectedMode = singlePreview ? 'files' : mode
      const key = `${selected?.token}:${selectedMode}`
      if (!operation.current || operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }
      const reply = recoveryId ? await window.pi.rewindRecover(sessionPath, recoveryId) : await window.pi.rewindRestore({ sessionPath, token: selected!.token, mode: selectedMode, operationId: operation.current.id, ...(skipUncovered ? { skipUncovered: true } : {}) })
      if ('error' in reply) { if (generation === epoch.current) setError(reply.error) }
      else {
        onCommitted(reply.value)
        if (generation === epoch.current) { setSuccess(reply.value.operation); setPreview(undefined); setFilePreview(undefined) }
        if (singlePreview && preview) {
          try {
            const refreshed = await window.pi.rewindPreview(sessionPath, preview.checkpointId)
            if (generation === epoch.current) {
              if ('error' in refreshed) setError(refreshed.error)
              else setPreview(refreshed.value)
            }
          } catch { if (generation === epoch.current) setError({ code: 'storage' }) }
        }
      }
      await load()
    } catch { if (generation === epoch.current) setError({ code: 'recovery', operationId: operation.current?.id }) }
    finally { setExecuting(false) }
  }
  const dates = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const checkpoints = messageTimestamp === undefined ? list?.checkpoints : list?.checkpoints.filter(cp => messageEntryId !== undefined && cp.messageEntryId === messageEntryId && cp.trigger === 'before-turn')
  // The banner names the one fact that refuses the restore. No reason (an older
  // payload) keeps the generic busy sentence rather than guessing at one.
  const busyReason = list?.busy ? list.busyReason : undefined
  const blocked = list?.busy ? { code: 'busy' as const } : mode !== 'conversation' ? preview?.blocked : undefined
  const excluded = preview?.excluded ?? []
  const partialPaths = !filePreview && mode !== 'conversation' ? preview?.uncovered ?? [] : []
  const emptyPartialFiles = mode === 'files' && !!partialPaths.length && !preview?.changes.length
  const confirmTitle = partialPaths.length ? 'rewind.partialTitle' : 'rewind.forceTitle'
  const requestCommit = () => {
    setFilePreview(undefined)
    if (mode !== 'conversation' && (preview?.changes.length || preview?.uncovered?.length)) setConfirming(true)
    else void commit()
  }
  const needsRefresh = error?.code === 'changed' || error?.code === 'expired'
  return <>
    <CenterMorphModal open={!!sessionPath} onOpenChange={changeOpen}>
      <CenterMorphModalContent ariaLabel={t('rewind.title')} ariaDescribedBy={descriptionId} closeButtonLabel={t('rewind.close')} showCloseButton={!executing} dismissible={!executing} suspended={confirming} className="max-w-5xl">
      <div data-rewind-panel className="flex h-[min(760px,calc(100dvh-96px))] min-h-0 flex-col">
        <div className="shrink-0 border-b border-border px-5 py-4 pr-14">
          <h2 className="flex items-center gap-2 text-base font-semibold"><ArrowLeftFromLine className="size-4" />{t('rewind.title')}</h2>
          <p id={descriptionId} className="mt-1.5 text-xs leading-ui text-muted-foreground">{t('rewind.description')}</p>
        </div>
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
          <div data-rewind-sidebar className="w-64 shrink-0 space-y-4 overflow-auto border-r border-border p-3 max-sm:max-h-36 max-sm:w-full max-sm:border-r-0 max-sm:border-b">
            {!list ? <p role="status" className="p-2 text-xs text-muted-foreground">{t('rewind.loading')}</p> : <>
              {!list.enabled ? <p className="p-2 text-xs text-muted-foreground">{t('rewind.disabled')}</p> : null}
              <div className="space-y-2">
                <h3 className="px-2 text-xs font-medium text-muted-foreground">{t('rewind.checkpoints')}</h3>
                {!checkpoints?.length ? <p className="p-2 text-xs text-muted-foreground">{t(messageTimestamp === undefined ? (list?.error ? 'rewind.emptyFailed' : 'rewind.empty') : 'rewind.noMessageCheckpoint')}</p> : checkpoints.map(cp => <Button key={cp.id} data-rewind-checkpoint variant="ghost" disabled={loading || fileLoading || executing} aria-pressed={preview?.checkpointId === cp.id} onClick={() => void select(cp.id)} className={cn('h-auto w-full flex-col items-stretch gap-2.5 border border-transparent px-3 py-3 text-left', preview?.checkpointId === cp.id && 'bg-primary/10')}>
                  <span className="flex items-start gap-2">
                    <span data-rewind-checkpoint-title className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-medium leading-ui text-foreground">{cp.description || t('rewind.untitledTurn')}</span>
                    {preview?.checkpointId === cp.id ? <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
                    <time dateTime={new Date(cp.timestamp).toISOString()}>{dates.format(cp.timestamp)}</time>
                    {!cp.legacy ? <span className="text-caption tabular-nums">{t('rewind.backupFileCount', { count: cp.files })}</span> : null}
                  </span>
                  {cp.legacy ? <span className="text-xs text-muted-foreground">{t('rewind.legacy')}</span> : null}
                </Button>)}
              </div>
              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="px-2 text-xs font-medium text-muted-foreground">{t('rewind.history')}</h3>
                {!list.operations.length ? <p className="p-2 text-xs text-muted-foreground">{t('rewind.noHistory')}</p> : <ol className="space-y-1">
                  {list.operations.map(op => <HistoryRow key={op.id} operation={op} selected={!!preview?.action && preview.operationId === op.id} dates={dates} disabled={loading || fileLoading || executing}
                    onPreview={() => void select(op.id, op.canRedo ? 'redo' : 'undo', op.mode)} />)}
                </ol>}
              </div>
            </>}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div data-rewind-toolbar role="toolbar" aria-label={t('rewind.toolbar')} className="@container shrink-0 border-b border-border px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                {preview ? <>
                  <span data-rewind-change-count aria-label={t('rewind.changeCount', { count: preview.changes.length })} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"><span className="hidden @min-[500px]:inline">{t('rewind.changeCount', { count: preview.changes.length })}</span><span className="@min-[500px]:hidden">{preview.changes.length}</span></span>
                  <PreviewTotals key={preview.token} path={sessionPath!} preview={preview} cache={cache} />
                  <ReviewCollapseButton allCollapsed={allCollapsed} onClick={() => setCollapsed(Object.fromEntries(preview.changes.map(change => [changeKey(change), !allCollapsed])))} />
                </> : null}
                <RewindActions key={preview?.token} mode={mode} onModeChange={setMode} onRestore={requestCommit} actionRef={restoreButtonRef}
                  actionLabel={executing ? t('rewind.executing') : preview?.action === 'undo' ? t('rewind.confirmUndo') : preview?.action === 'redo' ? t('rewind.confirmRedo') : undefined}
                  disabled={!preview || loading || fileLoading || executing || !!blocked || emptyPartialFiles || !!list?.pending.length || needsRefresh}
                  modeDisabled={!preview || loading || fileLoading || executing || confirming || !!preview.action} conversationUnavailable={preview?.conversationUnavailable}
                  fileWarning={!!preview?.changes.length || !!preview?.blocked || !!preview?.uncovered?.length} infoDisabled={!preview || confirming}
                  information={<>
                    {preview?.scopeRoot ? <p className="break-all font-medium text-foreground">{t('rewind.scopeRoot', { path: preview.scopeRoot })}</p> : null}
                    <p className="leading-ui">{t('rewind.coverageDescription')}</p>
                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">{t('rewind.coveragePaths')} ({excluded.length})</p>
                      <p className="leading-ui">{t('rewind.coverageDynamic')}</p>
                      {!excluded.length ? <p>{t('rewind.coverageEmpty')}</p> : excluded.slice(0, 200).map((item, index) => <p key={index} className="break-all">{item.path} · {t(`rewind.excluded.${item.reason}`)}</p>)}
                      {excluded.length > 200 ? <p>{t('rewind.moreExcluded', { count: excluded.length - 200 })}</p> : null}
                    </div>
                    <p className="leading-ui">{t('rewind.totalExplanation')}</p>
                  </>} />
              </div>
            </div>
            {/* Padding stays inside the scrollport so sticky file headers meet
                its top edge; the controls above never participate in scrolling. */}
            <div ref={bodyRef} data-rewind-scroll className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
              {error || success || list?.error || list?.pending.length || !preview || loading ? <div className="space-y-4 p-5">
                {error ? <ErrorMessage error={error} /> : null}
                {needsRefresh && preview ? <Button variant="outline" size="sm" onClick={() => void select(preview.checkpointId, preview.action, mode)}>{t('rewind.refreshPreview')}</Button> : null}
                {list?.error && !error ? <ErrorMessage error={list.error} /> : null}
                {success ? <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4 shrink-0 text-primary" />{success.status === 'committed' && success.skipped?.length ? t('rewind.partialSuccess', { count: success.skipped.length }) : t('rewind.success')}</p> : null}
                {list?.pending.map(op => <div key={op.id} className="space-y-3 rounded-card border border-destructive/30 p-4">
                  <p className="text-sm font-medium">{t('rewind.recovery')}</p><p className="text-xs leading-ui text-muted-foreground">{t('rewind.recoveryDescription')}</p>
                  {op.conflicts?.length ? <p className="break-all text-xs">{op.conflicts.join('\n')}</p> : null}
                  {op.recoveryPath ? <Button variant="ghost" size="sm" onClick={() => void window.pi.openPath(op.recoveryPath!)}>{t('rewind.openRecovery')}</Button> : null}
                  <Button variant="outline" size="sm" disabled={executing} onClick={() => void commit(op.id)}>{t('rewind.recover')}</Button>
                </div>)}
                {loading ? <p role="status" className="text-sm text-muted-foreground">{t('rewind.loading')}</p> : !preview && !success && !list?.pending.length ? <p className="text-sm text-muted-foreground">{t('rewind.select')}</p> : null}
              </div> : null}
              {preview && !loading ? <>
                <div className="space-y-3 px-4 py-3">
                  <p className="text-xs leading-ui text-muted-foreground">{preview.file ? t('rewind.explain.singleFile', { path: preview.file }) : t(`rewind.explain.${mode}`)}</p>
                  {!!preview.uncovered?.length ? <div data-rewind-uncovered role="alert" className="space-y-2 rounded-card border border-destructive/25 bg-destructive/5 p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0 text-destructive" />{t('rewind.uncoveredTitle', { count: preview.uncovered.length })}</p>
                    <p className="text-xs leading-ui text-muted-foreground">{t('rewind.uncoveredDescription')}</p>
                    <UncoveredFiles paths={preview.uncovered} />
                  </div> : null}
                  {blocked && blocked.code !== 'uncovered' && blocked.code !== error?.code && blocked.code !== list?.error?.code ? <ErrorMessage error={blocked} message={busyReason ? t(`rewind.busy.${busyReason}`) : undefined} /> : null}
                </div>
                {/* Mode controls the restore action, never the file preview. */}
                <>
                  {!preview.changes.length ? <p className="px-4 py-3 text-xs text-muted-foreground">{t(preview.uncovered?.length ? 'rewind.noCoveredChanges' : 'rewind.noChanges')}</p> : preview.changes.slice(0, visibleRows).map((change, index) => <DiffRow key={`${preview.token}:${changeKey(change)}`} path={sessionPath!} preview={preview} change={change} neighbors={preview.changes.slice(index + 1, index + 3)} collapsed={!!collapsed[changeKey(change)]} layoutKey={collapsed} onToggle={() => setCollapsed(previous => ({ ...previous, [changeKey(change)]: !previous[changeKey(change)] }))} scrollRootRef={bodyRef} cache={cache}
                    onRestore={change.singleFile && !preview.action ? () => void requestFile(change.path) : undefined}
                    restoreDisabled={executing || loading || fileLoading || !!list?.busy || !!list?.pending.length || needsRefresh || (!!preview.blocked && preview.blocked.code !== 'uncovered')} />)}
                  {visibleRows < preview.changes.length ? <div className="p-4"><Button variant="ghost" size="sm" onClick={() => setVisibleRows(value => value + 100)}>{t('rewind.showMore')}</Button></div> : null}
                </>
              </> : null}
            </div>
          </div>
        </div>
      </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
    <CenterMorphModal open={!!sessionPath && confirming} onOpenChange={changeConfirmOpen}>
      <CenterMorphModalContent ariaLabel={t(confirmTitle)} ariaDescribedBy={confirmDescriptionId} closeButtonLabel={t('rewind.close')} initialFocusRef={cancelConfirmRef} className="max-w-lg">
      <div className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold"><AlertTriangle className="size-5 text-destructive" />{t(confirmTitle)}</h2>
        <p id={confirmDescriptionId} className="mt-3 text-sm leading-ui-loose text-muted-foreground">{filePreview ? t('rewind.forceFileDescription') : t('rewind.forceDescription', { count: preview?.changes.length ?? 0 })}</p>
        {partialPaths.length ? <div data-rewind-partial-confirm className="mt-3 space-y-3 text-sm">
          <p className="text-xs leading-ui text-muted-foreground">{t(`rewind.explain.${mode}`)}</p>
          <p className="font-medium">{t('rewind.partialDescription', { count: partialPaths.length })}</p>
          <UncoveredFiles paths={partialPaths} />
        </div> : null}
        {filePreview?.file ? <p className="mt-3 break-all rounded-control bg-muted/40 p-3 text-sm font-medium">{filePreview.file}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelConfirmRef} variant="outline" size="sm" onClick={cancelConfirm}>{t('common.cancel')}</Button>
          <Button variant="destructive" size="sm" className="hover:bg-destructive hover:text-white" onClick={() => void commit(undefined, !!partialPaths.length)}>{t(partialPaths.length ? 'rewind.partialConfirm' : 'rewind.forceConfirm')}</Button>
        </div>
      </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  </>
}
