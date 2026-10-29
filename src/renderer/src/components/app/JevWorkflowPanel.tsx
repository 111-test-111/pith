import { useEffect, useRef, useState } from 'react'
import type { JevTraceDTO, JevTracePageDTO, JevTraceSummaryDTO, JevWorkflowDTO } from '../../../../shared/types'
import { Button } from '@/components/motion/button'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { ToolIcon } from '@/lib/tool-icons'
import { useI18n } from '@/i18n'
import { FadeScroll } from './FadeScroll'
import { JevWorkflowStatus } from './JevWorkflowStatus'

function Judgment({ summary, sessionPath }: { summary: JevTraceSummaryDTO; sessionPath: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<JevTraceDTO | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!open) return
    let active = true
    setError(false)
    void window.pi.jevTrace(sessionPath, summary.id).then(value => {
      if (active) { setDetail(value); setError(!value) }
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [open, sessionPath, summary.id, summary.status])
  return <div className="px-1.5" data-jev-judgment={summary.id}>
    <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
      title={t(`jev.stage.${summary.stage}`)} icon={<ToolIcon name="jev_decide" />}
      status={summary.status === 'running' ? 'running' : summary.status === 'completed' ? 'success' : summary.status === 'interrupted' ? 'cancelled' : 'error'}
      meta={`${new Date(summary.timestamp).toLocaleTimeString()} · ${summary.effectiveChoice ?? t(`jev.trace.${summary.status}`)}`}
      collapseOnComplete={false}>
      {open ? <div className="space-y-2 text-xs">
        {error ? <p role="status">{t('jev.traceError')}</p> : !detail ? <p>{t('jev.traceLoading')}</p> : <>
          <p>{t('jev.traceNotice')}</p>
          {detail.override ? <p>{t(`jev.override.${detail.override}`)}</p> : null}
          {detail.target ? <><p className="font-medium">{t('jev.traceTarget')}</p><ToolResultOutput language="json" highlight={false}>{JSON.stringify(detail.target, null, 2)}</ToolResultOutput></> : null}
          {detail.error ? <p>{t(`jev.error.${detail.error}`)}</p> : null}
          {detail.evaluation ? <>
            <p>{t('jev.traceUsage', { model: detail.evaluation.model, ms: detail.evaluation.elapsedMs, input: detail.evaluation.inputTokens, output: detail.evaluation.outputTokens })}</p>
            <p className="font-medium">{t('jev.traceOutput')}</p>
            <ToolResultOutput language="json" highlight={false}>{JSON.stringify(detail.evaluation.answers, null, 2)}</ToolResultOutput>
          </> : null}
          <p className="font-medium">{t('jev.traceInput')}</p>
          <ToolResultOutput language="json" highlight={false}>{JSON.stringify({ ...detail.request, state: parseState(detail.request.state) }, null, 2)}</ToolResultOutput>
        </>}
      </div> : null}
    </ToolResult>
  </div>
}
function parseState(state: string): unknown {
  try { return JSON.parse(state) } catch { return state }
}

export function JevWorkflowPanel({ state, sessionPath }: { state: JevWorkflowDTO | null; sessionPath: string }) {
  const { t } = useI18n()
  const [page, setPage] = useState<JevTracePageDTO | null>(null)
  const [error, setError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const version = ++generation.current
    setLoadingMore(false)
    let active = true
    // Coalesce usage/stage metadata updates; no polling or per-token requests.
    const timer = setTimeout(() => {
      void window.pi.jevTraces(sessionPath).then(value => {
        if (active && version === generation.current) { setPage(value); setError(false) }
      }).catch(() => { if (active) setError(true) })
    }, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [sessionPath, state?.seq])
  const more = async () => {
    if (!page?.nextCursor || loadingMore) return
    const version = generation.current
    setLoadingMore(true)
    try {
      const next = await window.pi.jevTraces(sessionPath, page.nextCursor)
      if (version === generation.current) setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor })
    } catch { if (version === generation.current) setError(true) }
    finally { if (version === generation.current) setLoadingMore(false) }
  }
  return <FadeScroll className="max-h-[16.5rem] p-1">
    <JevWorkflowStatus state={state} />
    <div className="space-y-2">
      {page?.items.map(summary => <Judgment key={summary.id} summary={summary} sessionPath={sessionPath} />)}
      {error ? <p role="status" className="px-2 text-xs text-destructive">{t('jev.traceError')}</p> : !page ? <p className="px-2 text-xs">{t('jev.traceLoading')}</p> : !page.items.length ? <p className="px-2 pb-2 text-xs text-muted-foreground">{t('jev.traceEmpty')}</p> : null}
      {page?.nextCursor ? <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void more()}>{t('jev.traceMore')}</Button> : null}
    </div>
  </FadeScroll>
}
