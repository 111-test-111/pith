import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { CircleAlert, CircleCheck, CircleDashed, CircleX, LoaderCircle, Maximize2, PictureInPicture2, Pin, PinOff } from '@/lib/icons'
import { ToolIcon } from '@/lib/tool-icons'
import { applyAccent, useAccent, useCustomAccent } from '@/lib/accent'
import { applyUiStyle, useUiStyle } from '@/lib/ui-style'
import { useI18n } from '@/i18n'
import { PiStore, type PiState } from '@/state/pi-store'
import type { AssistantMsg, PictureInPictureStateDTO } from '../../../../shared/types'

function responseText(message: AssistantMsg | null): string {
  if (!message) return ''
  return message.content
    .filter((part): part is Extract<AssistantMsg['content'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function latestUserTimestamp(state: PiState): number {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]
    if (message.role === 'user') return message.timestamp
  }
  return 0
}

/** A bounded tail keeps streamed replies moving in this fixed-size window. */
function latestResponse(state: PiState, since: number): string {
  let text = responseText(state.streaming)
  if (!text) {
    for (let index = state.messages.length - 1; index >= 0; index--) {
      const message = state.messages[index]
      if (message.timestamp < since) break
      if (message.role !== 'assistant') continue
      text = responseText(message)
      if (text) break
    }
  }
  return text.length > 700 ? `…${text.slice(-700)}` : text
}

export function PictureInPicture() {
  const { t } = useI18n()
  const store = useMemo(() => new PiStore(), [])
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [windowState, setWindowState] = useState<PictureInPictureStateDTO | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pinPending, setPinPending] = useState(false)
  const [accent] = useAccent()
  const [customAccent] = useCustomAccent()
  const [uiStyle] = useUiStyle()

  useEffect(() => { applyAccent(accent, customAccent) }, [accent, customAccent])
  useEffect(() => { applyUiStyle(uiStyle) }, [uiStyle])

  useEffect(() => {
    let cancelled = false
    let path: string | null = null
    const refreshLabel = async (sessionPath: string) => {
      try {
        const sessions = await window.pi.listSessions()
        if (!cancelled) setLabel(sessions.find((session) => session.path === sessionPath)?.label ?? null)
      } catch { /* The localized new-chat label remains available. */ }
    }
    // Subscribe before the snapshot request. PiStore buffers any events that
    // overtake the IPC response, then reconciles them by eventSequence.
    const offEvent = window.pi.onEvent((event) => {
      store.dispatch(event)
      if (path && event.sessionPath === path && event.type === 'message_end' && event.message?.role === 'user') {
        void refreshLabel(path)
      }
    })
    void (async () => {
      try {
        const compact = await window.pi.pictureInPictureState()
        if (!compact) throw new Error('Missing picture-in-picture state')
        path = compact.sessionPath
        if (cancelled) return
        setWindowState(compact)
        const snapshot = await window.pi.peekSession(compact.sessionPath)
        if (cancelled) return
        store.applySnapshot(snapshot)
        setLoadState('ready')
        void refreshLabel(compact.sessionPath)
      } catch {
        if (!cancelled) setLoadState('error')
      }
    })()
    return () => { cancelled = true; offEvent() }
  }, [store])

  const attention = state.pendingAskUser.length > 0 || state.escalations.length > 0
  const lastUserAt = latestUserTimestamp(state)
  const status = attention ? 'attention' : state.error ? 'error' : state.isStreaming ? 'running'
    : state.messages.some((message) => message.role === 'assistant' && message.timestamp >= lastUserAt) ? 'finished' : 'ready'
  const statusKey = status === 'attention' ? 'pip.attention' : status === 'error' ? 'pip.error'
    : status === 'running' ? 'pip.running' : status === 'finished' ? 'pip.finished' : 'pip.ready'
  const items = state.todos?.items ?? []
  const done = items.filter((item) => item.status === 'completed').length
  const currentTask = items.find((item) => item.status === 'in_progress') ?? items.find((item) => item.status === 'pending')
  const runningTool = Object.values(state.toolRuns).reverse().find((run) => run.status === 'running')
  const response = latestResponse(state, lastUserAt)

  const togglePinned = async () => {
    if (!windowState || pinPending) return
    setPinPending(true)
    try {
      const next = await window.pi.setPictureInPicturePinned(!windowState.pinned)
      if (next) setWindowState(next)
    } finally { setPinPending(false) }
  }

  return (
    <div data-pip-window className="flex h-full flex-col overflow-hidden rounded-window border border-border bg-background text-foreground">
      <header data-pip-drag className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
          <PictureInPicture2 aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted-foreground">{t('pip.title')}</div>
          <div className="truncate text-sm font-semibold">{label ?? t('workspace.newChat')}</div>
        </div>
        <Tooltip content={t(windowState?.pinned ? 'pip.unpin' : 'pip.pin')}>
          <Button
            size="icon" variant="ghost" className="size-8 shrink-0"
            aria-label={t(windowState?.pinned ? 'pip.unpin' : 'pip.pin')}
            aria-pressed={windowState?.pinned ?? false}
            disabled={!windowState || pinPending}
            onClick={() => void togglePinned()}
          >
            {windowState?.pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
          </Button>
        </Tooltip>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        {loadState === 'ready' ? (
          <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-2 font-medium" aria-live="polite">
                {status === 'running' ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-primary" />
                  : status === 'attention' ? <CircleAlert aria-hidden="true" className="size-3.5 text-primary" />
                    : status === 'error' ? <CircleX aria-hidden="true" className="size-3.5 text-destructive" />
                      : status === 'finished' ? <CircleCheck aria-hidden="true" className="size-3.5 text-muted-foreground" />
                        : <CircleDashed aria-hidden="true" className="size-3.5 text-muted-foreground" />}
                {t(statusKey)}
              </span>
              {items.length > 0 ? <span className="tabular-nums text-muted-foreground">{t('pip.progress', { done, total: items.length })}</span> : null}
            </div>

            {currentTask ? (
              <section className="rounded-card border border-border bg-muted/40 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t('pip.currentTask')}</div>
                <p className="mt-1 line-clamp-2 text-xs font-medium leading-5">{currentTask.activeForm && state.isStreaming ? currentTask.activeForm : currentTask.content}</p>
              </section>
            ) : null}

            {state.isStreaming ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {runningTool ? <ToolIcon name={runningTool.toolName} className="size-3.5" /> : <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                <span className="truncate">{runningTool ? t('pip.tool', { name: runningTool.toolName }) : t('pip.generating')}</span>
              </div>
            ) : null}

            <section className="min-h-0 flex-1 overflow-hidden">
              <div className="mb-1 text-[11px] text-muted-foreground">{t('pip.latest')}</div>
              <p data-pip-response className="line-clamp-6 whitespace-pre-wrap break-words text-xs leading-5">
                {response || t('pip.empty')}
              </p>
            </section>
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-center text-xs text-muted-foreground">
            {t(loadState === 'error' ? 'pip.loadError' : 'pip.loading')}
          </div>
        )}
      </main>

      <footer className="flex h-12 shrink-0 items-center justify-end border-t border-border px-3">
        <Button size="sm" variant="ghost" className="gap-1.5 text-xs" onClick={() => void window.pi.restoreFromPictureInPicture()}>
          <Maximize2 aria-hidden="true" className="size-3.5" />
          {t('pip.restore')}
        </Button>
      </footer>
    </div>
  )
}
