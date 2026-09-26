import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
  DebugBreakpointDTO,
  DebugOutputPageDTO,
  DebugScopeDTO,
  DebugSessionDTO,
  DebugStackFrameDTO,
  DebugThreadDTO,
  DebugVariableDTO
} from '../../../../shared/types'
import { ArrowDownToLine, ArrowUpFromLine, Bug, ChevronDown, ChevronRight, Pause, Play, Square, StepForward, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { MiddleEllipsis } from './MiddleEllipsis'
import { LabelTooltip } from './LabelTooltip'
import { useFileNavigation } from '@/lib/file-navigation'
import type { PiStore } from '@/state/pi-store'
import type { DebugStore } from '@/state/debug-store'

/**
 * The right-rail debug surface. It mirrors the DebugManager's DTO stream and
 * pulls detail (threads, frames, scopes, variables, console pages) on demand.
 * The user and the model's `debug` tool drive the SAME live session — the
 * hand-back convention is the embedded browser's: whoever is looking acts.
 */

const LIVE = new Set<DebugSessionDTO['status']>(['starting', 'running', 'stopped'])

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
  const navigation = useFileNavigation()
  const sessionPath = useSyncExternalStore(store.subscribe, () => store.getShell().sessionPath)
  const snapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot)
  const sessions = sessionPath ? snapshot.sessions.filter((item) => item.sessionPath === sessionPath) : []
  const session = sessions[sessions.length - 1]

  // Seed from main: events that fired before this pane mounted are not in the
  // store (a renderer reload drops every subscription).
  useEffect(() => { if (sessionPath) void debug.refresh(sessionPath) }, [debug, sessionPath])

  const [threads, setThreads] = useState<DebugThreadDTO[]>([])
  const [frames, setFrames] = useState<DebugStackFrameDTO[]>([])
  const [selectedThread, setSelectedThread] = useState<number | undefined>()
  const [selectedFrame, setSelectedFrame] = useState<number | undefined>()
  const [scopes, setScopes] = useState<DebugScopeDTO[]>([])
  const [variables, setVariables] = useState<ReadonlyMap<number, DebugVariableDTO[]>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [breakpoints, setBreakpoints] = useState<DebugBreakpointDTO[]>([])
  const [output, setOutput] = useState('')
  const [outputTruncated, setOutputTruncated] = useState(false)
  const outputCursor = useRef(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState(false)

  const sessionId = session?.id
  const status = session?.status
  const activeThreadId = session?.activeThreadId

  // A new session resets every detail pane.
  useEffect(() => {
    setThreads([]); setFrames([]); setScopes([])
    setVariables(new Map()); setExpanded(new Set())
    setSelectedThread(undefined); setSelectedFrame(undefined)
    setOutput(''); setOutputTruncated(false); outputCursor.current = 0
    setActionError(false)
  }, [sessionId])

  // Stop → refresh threads and the active thread's frames.
  useEffect(() => {
    if (!sessionPath || status !== 'stopped') return
    let alive = true
    void (async () => {
      try {
        const threadList = await window.pi.debugAction({ sessionPath, action: 'threads' }) as DebugThreadDTO[]
        if (!alive) return
        setThreads(threadList)
        const threadId = activeThreadId ?? threadList[0]?.id
        if (threadId === undefined) return
        setSelectedThread(threadId)
        const frameList = await window.pi.debugAction({ sessionPath, action: 'stack', threadId }) as DebugStackFrameDTO[]
        if (!alive) return
        setFrames(frameList)
        const top = frameList[0]
        if (top) {
          setSelectedFrame((current) => current ?? top.id)
          const scopeList = await window.pi.debugAction({ sessionPath, action: 'scopes', frameId: top.id }) as DebugScopeDTO[]
          if (alive) setScopes(scopeList)
        }
      } catch { /* session ended mid-fetch; the next event redraws */ }
    })()
    return () => { alive = false }
  }, [sessionPath, status, activeThreadId])

  // Scopes follow the selected frame.
  useEffect(() => {
    if (!sessionPath || status !== 'stopped' || selectedFrame === undefined) return
    let alive = true
    void window.pi.debugAction({ sessionPath, action: 'scopes', frameId: selectedFrame })
      .then((scopeList) => { if (alive) setScopes(scopeList as DebugScopeDTO[]) })
      .catch(() => {})
    return () => { alive = false }
  }, [sessionPath, status, selectedFrame])

  // Breakpoints and console tail follow the session's revision heartbeat.
  const revision = session?.revision
  useEffect(() => {
    if (!sessionPath || !sessionId) return
    let alive = true
    void window.pi.debugAction({ sessionPath, action: 'breakpoints' })
      .then((list) => { if (alive) setBreakpoints(list as DebugBreakpointDTO[]) })
      .catch(() => {})
    void window.pi.debugAction({ sessionPath, action: 'output', cursor: outputCursor.current })
      .then((page) => {
        if (!alive) return
        const next = page as DebugOutputPageDTO
        if (next.cursor === outputCursor.current) return
        // A truncated page means the ring dropped bytes the pane still shows.
        setOutput((previous) => next.truncated ? next.output : previous + next.output)
        setOutputTruncated(next.truncated)
        outputCursor.current = next.cursor
      })
      .catch(() => {})
    return () => { alive = false }
  }, [sessionPath, sessionId, revision])

  const runAction = (name: string, work: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(name)
    setActionError(false)
    void work().catch(() => setActionError(true)).finally(() => setBusy(null))
  }

  const control = (kind: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut'): void => {
    if (!sessionPath) return
    runAction(kind, () => window.pi.debugAction({ sessionPath, action: 'control', control: kind, threadId: selectedThread }))
  }

  const toggleVariables = (reference: number): void => {
    if (!sessionPath) return
    if (expanded.has(reference)) {
      setExpanded((current) => { const next = new Set(current); next.delete(reference); return next })
      return
    }
    setExpanded((current) => new Set(current).add(reference))
    if (!variables.has(reference)) {
      void window.pi.debugAction({ sessionPath, action: 'variables', variablesReference: reference })
        .then((list) => setVariables((current) => new Map(current).set(reference, list as DebugVariableDTO[])))
        .catch(() => {})
    }
  }

  const openSource = (file: string | undefined): void => {
    if (file) navigation.open(file)
  }

  const renderVariable = (variable: DebugVariableDTO, depth: number): ReactNode => {
    const expandable = variable.variablesReference > 0
    const isOpen = expanded.has(variable.variablesReference)
    const children = variables.get(variable.variablesReference)
    return (
      <div key={`${variable.variablesReference}:${variable.name}`} role="treeitem" aria-expanded={expandable ? isOpen : undefined}>
        <div
          className={cn('flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 font-mono text-xs', expandable && 'cursor-pointer hover:bg-muted/60')}
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
        </div>
        {isOpen && children ? children.map((child) => renderVariable(child, depth + 1)) : null}
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background px-6 text-center" data-debug-pane>
        <Bug aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm text-foreground">{t('debug.empty')}</p>
        <p className="text-xs text-muted-foreground">{t('debug.emptyHint')}</p>
      </div>
    )
  }

  const stopped = status === 'stopped'
  const running = status === 'running'
  const live = LIVE.has(session.status)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-debug-pane>
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
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.pause')} disabled={busy !== null} onClick={() => control('pause')}>
              <Pause aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={t('debug.continue')}>
            <span>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.continue')} disabled={!stopped || busy !== null} onClick={() => control('continue')}>
                <Play aria-hidden="true" className="size-3.5" />
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip content={t('debug.next')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.next')} disabled={!stopped || busy !== null} onClick={() => control('next')}>
              <StepForward aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={t('debug.stepIn')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.stepIn')} disabled={!stopped || busy !== null} onClick={() => control('stepIn')}>
              <ArrowDownToLine aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={t('debug.stepOut')}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('debug.stepOut')} disabled={!stopped || busy !== null} onClick={() => control('stepOut')}>
              <ArrowUpFromLine aria-hidden="true" className="size-3.5" />
            </Button>
          </span>
        </Tooltip>
        <div className="flex-1" />
        {live ? (
          <Tooltip content={t('debug.stop')}>
            <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label={t('debug.stop')} disabled={busy !== null}
              onClick={() => sessionPath && runAction('stop', () => window.pi.debugAction({ sessionPath, action: 'stop' }))}>
              <Square aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        ) : null}
      </div>

      {actionError ? <p role="alert" className="shrink-0 px-3 py-1 text-xs text-destructive">{t('debug.actionFailed')}</p> : null}
      {session.error ? <p role="alert" className="shrink-0 whitespace-pre-wrap px-3 py-1 text-xs text-destructive">{session.error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Stop location */}
        {stopped && session.location ? (
          <button
            type="button"
            onClick={() => openSource(session.location?.file)}
            className="flex w-full min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left hover:bg-muted/50"
          >
            <span className="shrink-0 rounded-item bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              {session.stopReason ?? 'stopped'}
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-foreground">
              {session.location.name ?? ''}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {session.location.file}:{session.location.line}
            </span>
          </button>
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
                  <button type="button" onClick={() => openSource(bp.file)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-control px-1 py-0.5 text-left hover:bg-muted/50">
                    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', bp.verified ? 'bg-destructive' : 'bg-muted-foreground/40')} />
                    <MiddleEllipsis name={bp.file} className="min-w-0 flex-1 font-mono text-xs text-foreground" />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{bp.line}</span>
                    {!bp.verified ? <span className="shrink-0 text-[11px] text-muted-foreground/70">{t('debug.unverified')}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Threads + call stack (stopped only) */}
        {stopped ? (
          <section aria-label={t('debug.stack')} className="border-b border-border/60 px-3 py-2">
            {threads.length > 1 ? (
              <div className="mb-1.5 flex flex-wrap gap-1" role="listbox" aria-label={t('debug.threads')}>
                {threads.map((thread) => (
                  <button key={thread.id} type="button" role="option" aria-selected={thread.id === selectedThread}
                    onClick={() => {
                      setSelectedThread(thread.id)
                      setSelectedFrame(undefined)
                      if (sessionPath) {
                        void window.pi.debugAction({ sessionPath, action: 'stack', threadId: thread.id })
                          .then((list) => setFrames(list as DebugStackFrameDTO[]))
                          .catch(() => {})
                      }
                    }}
                    className={cn('rounded-item px-1.5 py-0.5 text-xs',
                      thread.id === selectedThread ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60')}>
                    {thread.name}
                  </button>
                ))}
              </div>
            ) : null}
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.stack')}</h3>
            <ul className="space-y-0.5">
              {frames.map((frame) => (
                <li key={frame.id}>
                  <button type="button"
                    onClick={() => { setSelectedFrame(frame.id); openSource(frame.file) }}
                    className={cn('flex w-full min-w-0 items-center gap-2 rounded-control px-1 py-0.5 text-left',
                      frame.id === selectedFrame ? 'bg-accent' : 'hover:bg-muted/50')}>
                    <span className="shrink-0 font-mono text-xs text-foreground">{frame.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {frame.file ? `${frame.file}${frame.line !== undefined ? `:${frame.line}` : ''}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Variables of the selected frame (stopped only) */}
        {stopped ? (
          <section aria-label={t('debug.variables')} className="border-b border-border/60 px-3 py-2">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.variables')}</h3>
            <div role="tree">
              {scopes.map((scope) => (
                <div key={scope.variablesReference}>
                  <button type="button"
                    onClick={() => toggleVariables(scope.variablesReference)}
                    className="flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left text-xs font-medium text-foreground hover:bg-muted/50">
                    {expanded.has(scope.variablesReference)
                      ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
                      : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}
                    {scope.name}
                  </button>
                  {expanded.has(scope.variablesReference)
                    ? (variables.get(scope.variablesReference) ?? []).map((variable) => renderVariable(variable, 1))
                    : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Debug console */}
        <section aria-label={t('debug.output')} className="px-3 py-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('debug.output')}</h3>
          {outputTruncated ? (
            <p className="mb-1 text-[11px] text-muted-foreground/70">{t('debug.outputTruncated')}</p>
          ) : null}
          {output ? (
            <pre className="whitespace-pre-wrap break-all rounded-item bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground">{output}</pre>
          ) : (
            <p className="text-xs text-muted-foreground/70">{t('debug.noOutput')}</p>
          )}
        </section>
      </div>
    </div>
  )
}
