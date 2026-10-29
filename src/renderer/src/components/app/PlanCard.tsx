import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Markdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { FadeScroll } from './FadeScroll'
import { useI18n } from '@/i18n'
import { planErrorKey } from '@/lib/plan-submissions'
import type { PlanDocumentDTO, PlanStateDTO, PlanSubmissionRef } from '../../../../shared/types'

export interface PlanCardProps {
  sessionPath: string; reference: PlanSubmissionRef; state: PlanStateDTO; onRefine?: () => void
  /** Open the review pane on the turn that executed this plan. Present only
   *  while that turn exists and actually changed files. */
  onReviewExecution?: () => void
}

/** Footer controls are deliberately shorter than beUI's `sm` (h-8): the plan
 *  body is the card's content, so the action row stays a thin strip under it. */
const FOOTER_CONTROL = 'h-6 px-2.5'
/** The card's own box: the TOP padding keeps the header's breathing room, the
 *  bottom one only has to hold the action strip — 16px there plus the strip's
 *  own `mt-2` read as an empty band under the buttons. */
const CARD_BOX = 'px-4 pt-4 pb-2'
/** The plan body's scroll cap. Every pixel the footer's chrome gives back is
 *  added here, so a thinner footer shows MORE plan at the same card height
 *  (`28rem` + the 16px the footer lost). */
const PLAN_BODY_CAP = 'max-h-[29rem]'
export const PlanPresentationContext = createContext<Omit<PlanCardProps, 'reference'> | null>(null)
export function SubmissionCard({ reference }: { reference: PlanSubmissionRef }) {
  // Context updates reach the card even when its surrounding assistant group is memoized.
  const context = useContext(PlanPresentationContext)
  return context ? <PlanCard {...context} reference={reference} /> : null
}
const sameRef = (a: PlanSubmissionRef | null, b: PlanSubmissionRef) => a?.submissionEntryId === b.submissionEntryId &&
  a.planId === b.planId && a.revision === b.revision && a.hash === b.hash && a.planningTurnEntryId === b.planningTurnEntryId
export function PlanCard({ sessionPath, reference, state, onRefine, onReviewExecution }: PlanCardProps) {
  const { t } = useI18n()
  const key = `${sessionPath}:${reference.submissionEntryId}:${reference.hash}`
  const activeKey = useRef(key)
  activeKey.current = key
  const [loaded, setLoaded] = useState<{ key: string; document: PlanDocumentDTO } | null>(null)
  const [failure, setFailure] = useState<{ key: string; code: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let disposed = false
    setPending(false); setFailure(null); setCopied(false)
    void window.pi.readPlanDocument({ sessionPath, ...reference }).then(async result => {
      if (!result.ok) throw new Error(result.code)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.value.markdown)))].map(n => n.toString(16).padStart(2, '0')).join('')
      if (hash !== reference.hash || !sameRef(result.value.ref, reference)) throw new Error('stale-submission')
      if (!disposed) setLoaded({ key, document: result.value })
    }).catch(error => { if (!disposed) setFailure({ key, code: error instanceof Error ? error.message : 'unknown' }) })
    return () => { disposed = true }
  }, [key])
  const document = loaded?.key === key ? loaded.document : null
  const error = failure?.key === key ? failure.code : null
  const latest = sameRef(state.latest, reference)
  const approval = state.approval && sameRef(state.approval.ref, reference) ? state.approval : null
  const interrupted = approval?.status === 'interrupted'
  const revising = latest && state.mode === 'plan' && state.revisionPending
  const current = latest && state.mode === 'plan' && !interrupted && !revising
  const approve = async () => {
    if (pending) return
    setPending(true); setFailure(null)
    try {
      const request = { sessionPath, ...reference }
      const result = interrupted ? await window.pi.resetPlanApproval(request) : await window.pi.approvePlan(request)
      if (!result.ok) setFailure({ key, code: result.code })
    } catch { setFailure({ key, code: 'unknown' }) }
    finally { if (activeKey.current === key) setPending(false) }
  }
  return <section data-plan-card={reference.submissionEntryId} data-transcript-gap-before="roomy" className={cn('w-full min-w-0 rounded-card border border-border bg-card', CARD_BOX)}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-sm font-medium">{t('plan.cardTitle', { revision: reference.revision })}</span>
      <span className="text-xs text-muted-foreground">{t(interrupted ? 'plan.interrupted' : approval?.status === 'started' ? 'plan.started' : revising ? 'plan.revising' : current ? 'plan.awaiting' : 'plan.historical')}</span>
    </div>
    {document ? <FadeScroll className={cn(PLAN_BODY_CAP, 'p-1 text-sm')}><Markdown>{document.markdown}</Markdown></FadeScroll>
      : !error ? <p role="status" className="text-sm text-muted-foreground">{t('plan.loading')}</p> : null}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{t(planErrorKey(error))}</p>}
    {current && state.blockers.approve.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{t(planErrorKey(state.blockers.approve[0]))}</p>}
    {approval?.status === 'failed' && <p className="mt-2 text-xs text-destructive">{t('plan.startFailed')}</p>}
    <div data-plan-actions className="mt-2 flex flex-wrap items-center gap-1.5">
      {(current || interrupted) && <Button size="sm" className={FOOTER_CONTROL} onClick={() => void approve()} disabled={pending || !document || (!interrupted && state.blockers.approve.length > 0) || (interrupted && state.blockers.switch.some(b => b !== 'recovery'))}>{t(interrupted ? 'plan.reset' : 'plan.execute')}</Button>}
      {current && onRefine && <Button variant="ghost" size="sm" className={FOOTER_CONTROL} onClick={onRefine}>{t('plan.refine')}</Button>}
      {approval?.status === 'started' && onReviewExecution && <Button variant="ghost" size="sm" className={FOOTER_CONTROL} onClick={onReviewExecution}>{t('plan.reviewChanges')}</Button>}
      <Button variant="ghost" size="sm" className={FOOTER_CONTROL} disabled={!document} onClick={() => {
        if (document) void navigator.clipboard.writeText(document.markdown).then(() => setCopied(true), () => setFailure({ key, code: 'unknown' }))
      }}>{t(copied ? 'plan.copied' : 'plan.copy')}</Button>
      <Button variant="ghost" size="sm" className={FOOTER_CONTROL} disabled={!document || pending} onClick={() => {
        void window.pi.exportPlan({ sessionPath, ...reference }).then(result => { if (!result.ok) setFailure({ key, code: result.code }) }, () => setFailure({ key, code: 'unknown' }))
      }}>{t('plan.export')}</Button>
    </div>
  </section>
}
