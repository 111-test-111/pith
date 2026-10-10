import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
  DebugBreakpointDTO,
  DebugOutputPageDTO,
  DebugScopeDTO,
  DebugSessionDTO,
  DebugStackFrameDTO,
  DebugThreadDTO,
  DebugVariableDTO,
  DebugVariablesPageDTO,
  DebugSteppingGranularity
} from '../../../../shared/types'
import { ArrowDownToLine, ArrowUpFromLine, Bug, ChevronDown, ChevronRight, Pause, Play, Plus, RotateCcw, Square, StepForward, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/motion/select'
import { DebugNativeView } from './DebugNativeView'
import { FadeScroll } from './FadeScroll'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { MiddleEllipsis } from './MiddleEllipsis'
import { LabelTooltip } from './LabelTooltip'
import { useFileNavigation } from '@/lib/file-navigation'
import type { PiStore } from '@/state/pi-store'
import type { DebugStore } from '@/state/debug-store'
import { useDebugTargets } from '@/lib/hooks/use-debug-targets'
import { useWidePaneSplit } from '@/lib/hooks/use-wide-pane-split'
import { PanelResizeHandle } from './PanelResizeHandle'

/**
 * The right-rail debug surface. It mirrors the DebugManager's DTO stream and
 * pulls detail (threads, frames, scopes, variables, console pages) on demand.
 * The user and the model's `debug` tool drive the SAME live session — the
 * hand-back convention is the embedded browser's: whoever is looking acts.
 */

const LIVE = new Set<DebugSessionDTO['status']>(['starting', 'running', 'stopped'])
const SPLIT_STORAGE_KEY = 'pi-app:debug-split'
function readSplitWidth(): number | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY) ?? 'null')
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000 ? value : undefined
  } catch { return undefined }
}

function statusTone(status: DebugSessionDTO['status']): string {
  switch (status) {
    case 'running': return 'bg-emerald-500'
    case 'stopped': return 'bg-amber-500'
    case 'starting': return 'bg-sky-500 animate-pulse'
    case 'failed': return 'bg-destructive'
    default: return 'bg-muted-foreground'
  }
}

export function DebugPane({ store, debug }: { store: PiStore; debug: DebugStore }) {
  const { t } = useI18n()
  const shell = useSyncExternalStore(store.subscribe, store.getShell)
  const { sessionPath } = shell
  const { sessions, session, select } = useDebugTargets(debug, shell)
  const [splitWidth, setSplitWidth] = useState(readSplitWidth)
  const split = useWidePaneSplit({ preferred: splitWidth, scope: 'debug', onCommit: width => {
    width = Math.round(width)
    setSplitWidth(width)
    try { localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(width)) } catch { /* Keep the current layout when storage is unavailable. */ }
  } })
  const children = new Map(shell.subagents.map(run => [run.sessionPath, run]))
  const ownerLabel = (target: DebugSessionDTO): string => {
    const child = children.get(target.sessionPath)
    return child ? t('debug.subagentSession', { profile: child.profile, task: child.description }) : t('debug.mainSession')
  }
  if (!session || !sessionPath) return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background px-6 text-center" data-debug-pane>
      <Bug aria-hidden="true" className="size-5 text-muted-foreground" />
      <p className="text-sm">{t('debug.empty')}</p><p className="text-xs text-muted-foreground">{t('debug.emptyHint')}</p>
    </div>
  )
  return <div className="sidebar-pane-container flex h-full min-h-0 min-w-0 flex-col">
    <div className="shrink-0 border-b border-border/60 p-2" data-debug-selector>
      <Select value={session.id} onValueChange={select}>
        <SelectTrigger aria-label={t('debug.sessions')} className="h-8 min-w-0 text-xs"><SelectValue className="min-w-0 flex-1 truncate text-left" /></SelectTrigger>
        <SelectContent><FadeScroll className="max-h-[min(24rem,calc(100vh-8rem))] p-1">{sessions.map(target => <SelectItem key={target.id} value={target.id} className="text-xs [overflow-wrap:anywhere]">
          {`${children.size ? ownerLabel(target) + ' · ' : ''}${target.kind === 'core' ? t('debug.core') + ' · ' : target.parentId ? t('debug.child') + ' · ' : ''}${target.name ?? target.target} · ${t(`debug.status.${target.status}`)} · ${target.id.slice(0, 6)}`}
        </SelectItem>)}</FadeScroll></SelectContent>
      </Select>
    </div>
    <DebugDetails key={`${session.id}:${session.stopId}:${session.status}`} session={session} debug={debug} cwd={shell.cwd ?? ""} split={split} />
  </div>
}

function DebugDetails({ session, debug, cwd, split }: { session: DebugSessionDTO; debug: DebugStore; cwd: string; split: ReturnType<typeof useWidePaneSplit> }) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  useSyncExternalStore(debug.subscribe, debug.getSnapshot)
  const { sessionPath, id: debugId, stopId, status, activeThreadId } = session
  const target = { sessionPath, debugId, stopId }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [threads, setThreads] = useState<DebugThreadDTO[]>([])
  const [frames, setFrames] = useState<DebugStackFrameDTO[]>([])
  const [selectedThread, setSelectedThread] = useState<number | undefined>()
  const [selectedFrame, setSelectedFrame] = useState<number | undefined>()
  const [scopes, setScopes] = useState<DebugScopeDTO[]>([])
  const [variables, setVariables] = useState<ReadonlyMap<number, DebugVariableDTO[]>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  /** References whose children came back truncated (another page exists). */
  const [truncatedRefs, setTruncatedRefs] = useState<ReadonlySet<number>>(new Set())
  const [breakpoints, setBreakpoints] = useState<DebugBreakpointDTO[]>([])
  const [output, setOutput] = useState('')
  const [outputTruncated, setOutputTruncated] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState(false)
  const [frameVisit, setFrameVisit] = useState(0)
  const [memorySelection, setMemorySelection] = useState<{ reference: string; serial: number }>()
  const granularity = debug.steppingFor(session)
  const [watchDraft, setWatchDraft] = useState('')
  const [watchResults, setWatchResults] = useState<ReadonlyMap<string, { result?: string; error?: boolean }>>(new Map())

  useEffect(() => {
    if (status !== 'stopped') return
    let alive = true
    void window.pi.debugAction({ ...target, action: 'threads' }).then(list => {
      if (!alive) return
      const entries = list as DebugThreadDTO[]
      setThreads(entries); setSelectedThread(activeThreadId ?? entries[0]?.id)
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionPath, debugId, stopId, status, activeThreadId])

  useEffect(() => {
    setFrames([]); setSelectedFrame(undefined)
    if (status !== 'stopped' || selectedThread === undefined) return
    let alive = true
    void window.pi.debugAction({ ...target, action: 'stack', threadId: selectedThread }).then(list => {
      if (!alive) return
      const entries = list as DebugStackFrameDTO[]
      setFrames(entries); setSelectedFrame(entries[0]?.id)
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionPath, debugId, stopId, status, selectedThread, session.sourceVersion])

  const frameEpoch = useRef(0)
  useEffect(() => {
    frameEpoch.current++
    setScopes([]); setVariables(new Map()); setExpanded(new Set()); setTruncatedRefs(new Set())
    if (status !== 'stopped' || selectedFrame === undefined) return
    let alive = true
    void window.pi.debugAction({ ...target, action: 'scopes', frameId: selectedFrame })
      .then(list => { if (alive) setScopes(list as DebugScopeDTO[]) }).catch(() => {})
    return () => { alive = false; frameEpoch.current++ }
  }, [sessionPath, debugId, stopId, status, selectedFrame])

  const revision = session.revision
  useEffect(() => {
    let alive = true
    void window.pi.debugAction({ ...target, action: 'breakpoints' })
      .then(list => { if (alive) setBreakpoints(list as DebugBreakpointDTO[]) }).catch(() => {})
    // Fetch the entire bounded ring, including a terminal event's final burst.
    // Replacing the tail keeps renderer retention at the same 64 KiB bound.
    void window.pi.debugAction({ ...target, action: 'output', maxChars: 65_536 })
      .then(result => {
        if (!alive) return
        const page = result as DebugOutputPageDTO
        setOutput(page.output); setOutputTruncated(page.truncated)
      }).catch(() => {})
    return () => { alive = false }
  }, [sessionPath, debugId, revision])

  const runAction = (name: string, work: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(name)
    setActionError(false)
    void work().catch(() => setActionError(true)).finally(() => setBusy(null))
  }

  const control = (kind: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut'): void => {
    if (!sessionPath) return
    runAction(kind, () => window.pi.debugAction({ ...target, action: 'control', control: kind, threadId: selectedThread, ...((session.capabilities?.supportsSteppingGranularity || granularity !== 'statement') && !['continue', 'pause'].includes(kind) ? { granularity } : {}) }))
  }

  const loadingVariables = useRef(new Map<number, number>())
  const [pendingVariables, setPendingVariables] = useState<ReadonlySet<number>>(new Set())
  const loadVariables = (reference: number, start = 0): void => {
    const epoch = frameEpoch.current
    if (loadingVariables.current.get(reference) === epoch) return
    loadingVariables.current.set(reference, epoch); setPendingVariables(new Set(loadingVariables.current.keys()))
    void window.pi.debugAction({ ...target, action: 'variables', variablesReference: reference, start })
      .then(page => {
        if (!mounted.current || epoch !== frameEpoch.current) return
        const result = page as DebugVariablesPageDTO
        setVariables(current => new Map(current).set(reference, start ? [...(current.get(reference) ?? []), ...result.variables] : result.variables))
        setTruncatedRefs(current => {
          const next = new Set(current)
          if (result.truncated && result.variables.length) next.add(reference); else next.delete(reference)
          return next
        })
      }).catch(() => { if (mounted.current && epoch === frameEpoch.current) setActionError(true) })
      .finally(() => {
        if (loadingVariables.current.get(reference) === epoch) loadingVariables.current.delete(reference)
        if (mounted.current) setPendingVariables(new Set(loadingVariables.current.keys()))
      })
  }
  const toggleVariables = (reference: number): void => {
    if (expanded.has(reference)) {
      setExpanded(current => { const next = new Set(current); next.delete(reference); return next })
    } else {
      setExpanded(current => new Set(current).add(reference))
      if (!variables.has(reference)) loadVariables(reference)
    }
  }
  const moreVariables = (reference: number) => truncatedRefs.has(reference) ? <Button variant="ghost" className="h-6 px-2 text-caption" disabled={pendingVariables.has(reference)} onClick={() => loadVariables(reference, variables.get(reference)?.length ?? 0)}>{t('debug.loadMoreVariables')}</Button> : null

  // Watch expressions evaluate at every stop (and right after being added
  // while stopped). The store's list identity drives re-evaluation.
  const watchExpressions = debug.watchList(debugId)
  useEffect(() => {
    if (status !== 'stopped' || session.kind === 'core' || selectedFrame === undefined) return
    let alive = true
    void (async () => {
      const results = new Map<string, { result?: string; error?: boolean }>()
      for (const expression of watchExpressions) {
        if (!alive) return
        try {
          const evaluated = await window.pi.debugAction({ ...target, action: 'evaluate', expression, frameId: selectedFrame, context: 'watch' }) as { result: string }
          results.set(expression, { result: evaluated.result })
        } catch (error) {
          results.set(expression, { result: error instanceof Error ? error.message : String(error), error: true })
        }
      }
      if (alive) setWatchResults(results)
    })()
    return () => { alive = false }
  }, [sessionPath, debugId, stopId, status, selectedFrame, watchExpressions, session.kind])

  const addWatch = (): void => {
    if (!sessionPath || !watchDraft.trim()) return
    debug.addWatch(debugId, watchDraft)
    setWatchDraft('')
  }

  const openSource = (file: string | undefined, line?: number): void => {
    if (file) navigation.openPath(file, line)
  }

  const renderVariable = (variable: DebugVariableDTO, depth: number, ancestors: ReadonlySet<number> = new Set()): ReactNode => {
    const expandable = variable.variablesReference > 0 && !ancestors.has(variable.variablesReference) && depth < 50
    const isOpen = expandable && expanded.has(variable.variablesReference)
    const children = variables.get(variable.variablesReference)
    return (
      <div key={`${variable.variablesReference}:${variable.name}`}>
        <div className="flex min-w-0 items-center">
        <Button variant="ghost" aria-expanded={expandable ? isOpen : undefined} disabled={!expandable}
          className={cn('h-auto w-full justify-start disabled:opacity-100', 'flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 font-mono text-code', expandable && 'cursor-pointer hover:bg-muted/60')}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={expandable ? () => toggleVariables(variable.variablesReference) : undefined}
        >
          {expandable ? (
            isOpen ? <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              : <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          ) : <span className="inline-block size-3 shrink-0" />}
          <span className="shrink-0 text-foreground">{variable.name}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {variable.value}{variable.type ? ` : ${variable.type}` : ''}
          </span>
        </Button>
        {variable.memoryReference && session.capabilities?.supportsReadMemoryRequest ? <Button variant="ghost" className="h-6 shrink-0 px-1 text-caption" aria-label={t('debug.variableMemory', { name: variable.name })} onClick={() => setMemorySelection({ reference: variable.memoryReference!, serial: Date.now() })}>{t('debug.memory')}</Button> : null}
        </div>
        {isOpen && children ? children.map((child) => renderVariable(child, depth + 1, new Set(ancestors).add(variable.variablesReference))) : null}
        {isOpen ? moreVariables(variable.variablesReference) : null}
      </div>
    )
  }

  const core = session.kind === 'core'
  const launcher = session.adapterId === 'js-debug' && !session.parentId
  const stopped = status === 'stopped'
  const running = status === 'running'
  const live = LIVE.has(session.status)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-debug-pane data-debug-id={debugId} data-debug-stop={stopId}>
      {/* Header: adapter, target, status, and the stepping controls. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusTone(session.status))} />
        <span className="shrink-0 text-xs font-medium text-foreground">{session.adapterLabel}</span>
        <LabelTooltip content={session.target} wrapperClassName="min-w-0 flex-1">
          <MiddleEllipsis name={session.target} className="text-xs text-muted-foreground" />
        </LabelTooltip>
        <span className="shrink-0 text-xs text-muted-foreground">{t(`debug.status.${session.status}`)}</span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-2 py-1.5" role="toolbar" aria-label={t('debug.controls')}>
        {running ? (
          <Tooltip content={t('debug.pause')}>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.pause')} disabled={launcher || busy !== null} onClick={() => control('pause')}>
              <Pause aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={t('debug.continue')}>
            <span>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.continue')} disabled={core || !stopped || busy !== null} onClick={() => control('continue')}>
                <Play aria-hidden="true" className="size-3.5" />
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip content={t('debug.next')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.next')} disabled={core || !stopped || busy !== null || granularity !== 'statement' && !session.capabilities?.supportsSteppingGranularity} onClick={() => control('next')}>
              <StepForward aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={t('debug.stepIn')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.stepIn')} disabled={core || !stopped || busy !== null || granularity !== 'statement' && !session.capabilities?.supportsSteppingGranularity} onClick={() => control('stepIn')}>
              <ArrowDownToLine aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={t('debug.stepOut')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.stepOut')} disabled={core || !stopped || busy !== null || granularity !== 'statement' && !session.capabilities?.supportsSteppingGranularity} onClick={() => control('stepOut')}>
              <ArrowUpFromLine aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={t('debug.restartHint')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.restart')}
              disabled={core || !!session.parentId || session.status === 'starting' || busy !== null}
              onClick={() => sessionPath && runAction('restart', async () => {
                const replacement = await window.pi.debugAction({ ...target, action: 'restart' }) as DebugSessionDTO
                debug.acceptRestart(replacement)
              })}>
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <div className="flex-1" />
        {live ? (
          <Tooltip content={t('debug.stop')}>
            <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label={t('debug.stop')} disabled={busy !== null}
              onClick={() => sessionPath && runAction('stop', () => window.pi.debugAction({ ...target, action: 'stop' }))}>
              <Square aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        ) : null}
      </div>

      {stopped && !core && (session.capabilities?.supportsSteppingGranularity || granularity !== 'statement') ? <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{t('debug.steppingMode')}</span>
        <Select value={granularity} onValueChange={value => debug.setStepping(debugId, value as DebugSteppingGranularity)}>
          <SelectTrigger aria-label={t('debug.steppingMode')} className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="statement">{t('debug.stepStatement')}</SelectItem>
            <SelectItem value="line" disabled={!session.capabilities?.supportsSteppingGranularity}>{t('debug.stepLine')}</SelectItem>
            <SelectItem value="instruction" disabled={!session.capabilities?.supportsSteppingGranularity}>{t('debug.stepInstruction')}</SelectItem>
          </SelectContent>
        </Select>
      </div> : null}

      {actionError ? <p role="alert" className="shrink-0 px-3 py-1 text-xs text-destructive">{t('debug.actionFailed')}</p> : null}
      {session.error ? <p role="alert" className="shrink-0 whitespace-pre-wrap px-3 py-1 text-xs text-destructive">{session.error}</p> : null}

      <FadeScroll className="min-h-0 flex-1 p-1">
        <div ref={split.ref} data-debug-columns data-resizable="true" className="pane-columns">
        <div data-debug-navigation data-pane-master className="pane-master">
        {core ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('debug.coreHint')}</p> : null}
        {stopped && (session.stopDescription || session.stopText || session.stopDiagnostics) ? (
          <div className="space-y-1 px-3 py-2 text-xs" role={session.conditionError ? 'alert' : undefined}>
            {session.conditionError ? <p className="text-destructive">{t('debug.conditionError')}</p> : null}
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{[session.stopDescription, session.stopText, session.stopDiagnostics].filter(Boolean).join('\n')}</p>
            {session.conditionError && session.adapterId === 'lldb-dap' ? <p className="text-muted-foreground">{t('debug.lldbConditionHint')}</p> : null}
          </div>
        ) : null}
        {/* Stop location */}
        {stopped && session.location ? (
          <Button variant="ghost"
            type="button"
            onClick={() => { setSelectedThread(activeThreadId ?? selectedThread); setSelectedFrame(frames[0]?.id); setMemorySelection(undefined); setFrameVisit(visit => visit + 1); openSource(session.location?.file, session.location?.line) }}
            className="h-auto justify-start flex w-full min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left hover:bg-muted/50"
          >
            <span className="shrink-0 rounded-item bg-amber-500/15 px-1.5 py-0.5 text-caption text-amber-600 dark:text-amber-400">
              {session.stopReason ?? t('debug.status.stopped')}
            </span>
            <span className="min-w-0 truncate font-mono text-code-inline text-foreground">
              {session.location.name ?? ''}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {session.location.file ? `${session.location.file}:${session.location.line}` : session.location.instructionPointerReference ?? session.location.source?.name}
            </span>
          </Button>
        ) : null}

        {/* Breakpoints */}
        <section aria-label={t('debug.breakpoints')} className="border-b border-border/60 px-3 py-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.breakpoints')}</h3>
          {breakpoints.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">{t('debug.noBreakpoints')}</p>
          ) : (
            <ul className="space-y-0.5">
              {breakpoints.map((bp, index) => (
                <li key={`${bp.file}:${bp.line}:${index}`}>
                  <Button variant="ghost" type="button" onClick={() => openSource(bp.file, bp.line)}
                    className="h-auto justify-start flex w-full min-w-0 items-center gap-2 rounded-control px-1 py-0.5 text-left hover:bg-muted/50">
                    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', bp.verified ? 'bg-destructive' : 'bg-muted-foreground/40')} />
                    <MiddleEllipsis name={bp.file} className="min-w-0 flex-1 font-mono text-xs text-foreground" />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{bp.line}</span>
                    {!bp.verified ? <span className="shrink-0 text-caption text-muted-foreground/70">{t('debug.unverified')}</span> : null}
                  </Button>
                  {bp.message ? <p className="whitespace-pre-wrap break-words px-1 text-xs text-muted-foreground">{bp.message}</p> : null}
                  {bp.condition ? <p className="break-words px-1 font-mono text-code text-muted-foreground">{bp.condition}</p> : null}
                  {bp.conditionStatus ? <p className={cn('px-1 text-caption', bp.conditionStatus === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                    {t(bp.conditionStatus === 'error' ? 'debug.conditionError' : 'debug.conditionUnvalidated')}
                  </p> : null}
                  {bp.conditionError ? <p className="whitespace-pre-wrap break-words px-1 text-xs text-destructive">{bp.conditionError}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Threads + call stack (stopped only) */}
        {stopped ? (
          <section aria-label={t('debug.stack')} className="border-b border-border/60 px-3 py-2">
            {threads.length > 1 ? (
              <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label={t('debug.threads')}>
                {threads.map((thread) => (
                  <Button variant="ghost" key={thread.id} type="button" aria-pressed={thread.id === selectedThread}
                    onClick={() => {
                      setSelectedThread(thread.id)
                      setSelectedFrame(undefined)

                    }}
                    className={cn('rounded-item px-1.5 py-0.5 text-xs',
                      thread.id === selectedThread ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60')}>
                    {thread.name}
                  </Button>
                ))}
              </div>
            ) : null}
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.stack')}</h3>
            <ul className="space-y-0.5">
              {frames.map((frame) => (
                <li key={frame.id}>
                  <Button variant="ghost" type="button"
                    onClick={() => { setSelectedFrame(frame.id); setMemorySelection(undefined); setFrameVisit(visit => visit + 1); openSource(frame.file, frame.line) }}
                    className={cn('h-auto justify-start flex w-full min-w-0 items-center gap-2 rounded-control px-1 py-0.5 text-left',
                      frame.id === selectedFrame ? 'bg-accent' : 'hover:bg-muted/50')}>
                    <span className="shrink-0 font-mono text-code-inline text-foreground">{frame.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
                      {frame.file ? `${frame.file}${frame.line !== undefined ? `:${frame.line}` : ''}` : frame.instructionPointerReference ?? frame.source?.name ?? ''}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        </div>
        <PanelResizeHandle {...split.handleProps} label={t('debug.resizeSplit')} />
        <div data-debug-inspection className="pane-detail">
        <div className="pane-data">
        {stopped && selectedFrame !== undefined ? <DebugNativeView key={`${selectedFrame}:${session.sourceVersion ?? 0}:${frameVisit}`} session={session} frame={frames.find(frame => frame.id === selectedFrame)} cwd={cwd} memorySelection={memorySelection} /> : null}

        {/* Variables of the selected frame (stopped only) */}
        {stopped ? (['variables', 'registers'] as const).map(group => {
          const entries = scopes.filter(scope => (scope.presentationHint === 'registers' || scope.name.toLowerCase() === 'registers') === (group === 'registers'))
          if (group === 'registers' && !entries.length) return null
          return <section key={group} aria-label={t(group === 'registers' ? 'debug.registers' : 'debug.variables')} className="border-b border-border/60 px-3 py-2">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t(group === 'registers' ? 'debug.registers' : 'debug.variables')}</h3>
            <div>
              {entries.map((scope) => (
                <div key={scope.variablesReference}>
                  <Button variant="ghost" type="button"
                    aria-expanded={expanded.has(scope.variablesReference)}
                    onClick={() => toggleVariables(scope.variablesReference)}
                    className="h-auto justify-start flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left text-xs font-medium text-foreground hover:bg-muted/50">
                    {expanded.has(scope.variablesReference)
                      ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
                      : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}
                    {scope.name}
                  </Button>
                  {expanded.has(scope.variablesReference)
                    ? (variables.get(scope.variablesReference) ?? []).map((variable) => renderVariable(variable, 1))
                    : null}
                  {expanded.has(scope.variablesReference) ? moreVariables(scope.variablesReference) : null}
                </div>
              ))}
            </div>
          </section>
        }) : null}

        {/* Watch expressions */}
        {!core ? <section aria-label={t('debug.watch')} className="border-b border-border/60 px-3 py-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.watch')}</h3>
          <form className="mb-1.5 flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); addWatch() }}>
            <Input
              value={watchDraft}
              onChange={(value) => setWatchDraft(value)}
              placeholder={t('debug.watchPlaceholder')}
              aria-label={t('debug.watchPlaceholder')}
              className="min-w-0 flex-1"
              classNames={{ input: 'font-mono' }}
            />
            <Button type="submit" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('debug.watchAdd')} disabled={!watchDraft.trim()}>
              <Plus aria-hidden="true" className="size-4" />
            </Button>
          </form>
          {watchExpressions.length > 0 ? (
            <ul className="space-y-0.5">
              {watchExpressions.map((expression) => {
                const result = watchResults.get(expression)
                return (
                  <li key={expression} className="group flex min-w-0 items-center gap-1.5 rounded-control px-1 py-0.5">
                    <span className="shrink-0 font-mono text-code-inline text-foreground">{expression}</span>
                    <span className={cn('min-w-0 flex-1 truncate font-mono text-code-inline', result?.error ? 'text-destructive' : 'text-muted-foreground')}>
                      {result?.result ?? (stopped ? '…' : '—')}
                    </span>
                    <Button
                      variant="ghost" size="icon"
                      className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={t('debug.watchRemove', { expression })}
                      onClick={() => sessionPath && debug.removeWatch(debugId, expression)}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </section> : null}

        {/* Debug console */}
        <section aria-label={t('debug.output')} className="px-3 py-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.output')}</h3>
          {outputTruncated ? (
            <p className="mb-1 text-caption text-muted-foreground/70">{t('debug.outputTruncated')}</p>
          ) : null}
          {output ? (
            <pre className="whitespace-pre-wrap break-all rounded-item bg-muted/40 p-2 font-mono text-code text-foreground">{output}</pre>
          ) : (
            <p className="text-xs text-muted-foreground/70">{t('debug.noOutput')}</p>
          )}
        </section>
        </div>
        </div>
        </div>
      </FadeScroll>
    </div>
  )
}
