import { useEffect, useState } from 'react'
import type { CompactionProcessDTO, CompactionStatus } from '../../../../shared/compaction'
import { useI18n } from '@/i18n'
import { Circle, ArrowRight } from '@/lib/icons'
import { StatusRing } from '@/lib/status-ring'
import { formatTokenCount, formatCost } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useReduceMotion, useSystemReducedMotion } from '@/lib/reduce-motion'

type StepStatus = CompactionStatus | 'pending'

/** Only mounted inside an open disclosure. The timer never updates transcript
 * state; the existing result viewport remains dedicated to the final summary. */
export function CompactionProcessView({ process, detail }: { process?: CompactionProcessDTO; detail?: string }) {
  const { t } = useI18n()
  const appReduce = useReduceMotion()
  const systemReduce = useSystemReducedMotion()
  const reduce = appReduce || systemReduce
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!process || process.status !== 'running') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [process?.id, process?.status])

  const settled = process?.status !== 'running'
  const ended = process?.status === 'error' || process?.status === 'cancelled' ? process.status : 'pending'
  const preparing: StepStatus = process?.range || process?.status === 'success' ? 'success' : process ? settled ? ended : 'running' : 'pending'
  const generating: StepStatus = process?.status === 'success' || process?.phase === 'applying' ? 'success'
    : process?.phase === 'summarizing' ? settled ? ended : 'running' : 'pending'
  const applying: StepStatus = process?.status === 'success' ? 'success'
    : process?.phase === 'applying' ? settled ? ended : 'running' : 'pending'
  const steps: Array<{ key: 'prepare' | 'generate' | 'apply'; status: StepStatus; detail?: string }> = [
    { key: 'prepare', status: preparing, detail: process?.range ? t('chat.compactionRange', {
      summarized: process.range.summarizedMessages, kept: process.range.keptMessages
    }) : undefined },
    { key: 'generate', status: generating, detail: process?.retry ? t('chat.compactionRetry', {
      attempt: process.retry.attempt, maxAttempts: process.retry.maxAttempts,
      seconds: Math.ceil(process.retry.delayMs / 1000)
    }) : process?.extensionGenerated ? t('chat.compactionExtensionSummary') : process?.range?.splitTurn ? t('chat.compactionSplitTurn')
      : process?.range?.previousSummary ? t('chat.compactionUpdateSummary') : undefined },
    { key: 'apply', status: applying }
  ]
  const requests = process?.requests ?? []
  const input = process?.usage?.inputTokens ?? requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0)
  const output = process?.usage?.outputTokens ?? requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0)
  const cost = process?.usage?.cost ?? requests.reduce((sum, request) => sum + (request.cost ?? 0), 0)
  const before = process?.tokensBefore
  const after = process?.tokensAfter
  const scale = Math.max(before ?? 0, after ?? 0, 1)

  return <section data-compaction-process aria-label={t('chat.compactionProcess')} className="p-3 text-xs">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="font-medium text-foreground/80">{t('chat.compactionProcess')}</h3>
      {process ? <span className="text-muted-foreground">
        {t(`chat.compactionReason.${process.reason}`)}
        <span className="ml-2 tabular-nums">{t('chat.compactionDuration', {
          seconds: (Math.max(0, (process.endedAt ?? now) - process.startedAt) / 1000).toFixed(1)
        })}</span>
      </span> : null}
    </div>
    {process ? <>
      <ol className="mt-3 flex flex-col gap-2" aria-label={t('chat.compactionStages')}>
        {steps.map(step => <li key={step.key} data-compaction-step={step.key} data-state={step.status} className="flex items-start gap-2">
          <span aria-hidden="true" className={cn('mt-px shrink-0', step.status === 'success' ? 'text-emerald-600 dark:text-emerald-400'
            : step.status === 'error' ? 'text-rose-600 dark:text-rose-400' : step.status === 'running' ? 'text-primary' : 'text-muted-foreground/50')}>
            {step.status === 'pending' ? <Circle className="size-3.5" /> : <StatusRing status={step.status} reduce={reduce} className="size-3.5" />}
          </span>
          <span className="min-w-0">
            <span className="text-foreground/80">{t(`chat.compactionStage.${step.key}`)}</span>
            <span className="sr-only"> · {t(`chat.compactionStatus.${step.status}`)}</span>
            {step.detail ? <span className="mt-0.5 block text-muted-foreground">{step.detail}</span> : null}
          </span>
        </li>)}
      </ol>
      {before !== undefined ? <div data-compaction-context className="mt-3 border-t border-border/50 pt-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{t('chat.compactionContext')}</span>
          <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground/80">
            <span>{t('chat.compactionTokens', { tokens: formatTokenCount(before) })}</span>
            {after !== undefined ? <><ArrowRight aria-hidden="true" className="size-3" /><span>{t('chat.compactionTokens', { tokens: formatTokenCount(after) })}</span></> : null}
          </span>
        </div>
        <div aria-hidden="true" className="mt-1.5 flex flex-col gap-1">
          <div className="h-1 rounded-capsule bg-muted-foreground/25" style={{ width: `${before / scale * 100}%` }} />
          {after !== undefined ? <div className="h-1 rounded-capsule bg-primary/70" style={{ width: `${after / scale * 100}%` }} /> : null}
        </div>
      </div> : null}
      {requests.length ? <div data-compaction-requests className="mt-3 border-t border-border/50 pt-2.5">
        <p className="text-muted-foreground">{t('chat.compactionRequests', { count: process.requestCount })}</p>
        {requests.slice(-4).map((request, index) => <div key={request.id} data-compaction-request={request.id} data-state={request.status}
          className="mt-1.5 flex min-w-0 items-center gap-2">
          <span aria-hidden="true"><StatusRing status={request.status} reduce={reduce} className="size-3" /></span>
          <span className="min-w-0 flex-1 truncate text-foreground/80" title={[request.provider, request.model].filter(Boolean).join(' / ')}>
            {t('chat.compactionRequest', { index: process.requestCount - Math.min(4, requests.length) + index + 1 })}
            {request.model ? <> · {request.model}</> : null}
          </span>
          <span className="sr-only">{t(`chat.compactionStatus.${request.status}`)}</span>
          {request.endedAt !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{t('chat.compactionDuration', {
            seconds: (Math.max(0, request.endedAt - request.startedAt) / 1000).toFixed(1)
          })}</span> : null}
        </div>)}
        {requests.some(request => request.inputTokens !== undefined) ? <p data-compaction-usage className="mt-2 text-muted-foreground">
          {t('chat.compactionUsage', { input: formatTokenCount(input), output: formatTokenCount(output) })}
          {cost > 0 ? <> · {formatCost(cost)}</> : null}
        </p> : null}
      </div> : null}
    </> : <p className="mt-2 text-muted-foreground">{t('chat.compactionProcessUnavailable')}</p>}
    {detail ? <p data-compaction-error className="mt-2 whitespace-pre-wrap break-words text-rose-600 dark:text-rose-400">{detail}</p> : null}
  </section>
}
