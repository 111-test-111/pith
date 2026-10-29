import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Loader2 } from '@/lib/icons'
import {
  CenterMorphModal,
  CenterMorphModalContent
} from '@/components/motion/center-morph-modal'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import type { SubagentRunDTO } from '../../../../shared/types'

export type SubagentHumanAction = 'steer' | 'resume'

export interface SubagentActionTarget {
  action: SubagentHumanAction
  sessionId: string
  runId: string
  description: string
}

/**
 * Human control for one subagent run. The target records the run that opened
 * the dialog while `run` is the latest roster value, so a sequence-free roster
 * update can make the form stale without silently changing Steer into Resume.
 */
export function SubagentActionDialog({
  target,
  run,
  sessionPath,
  onClose
}: {
  target: SubagentActionTarget
  run: SubagentRunDTO | null
  sessionPath: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const descriptionId = useId()
  const feedbackId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)

  const stale = !run || run.runId !== target.runId || (
    target.action === 'steer' ? run.status !== 'running' : run.status === 'running'
  )
  const feedback = stale
    ? t('subagent.actionStale')
    : failed
      ? t('subagent.operationFailed')
      : null
  const canSubmit = message.trim().length > 0 && !stale && !submitting
  const title = t(target.action === 'steer' ? 'subagent.steerTitle' : 'subagent.resumeTitle')
  const description = t(
    target.action === 'steer' ? 'subagent.steerDescription' : 'subagent.resumeDescription',
    { description: target.description }
  )

  // CenterMorphModal portals after its first mounted effect. Its generic
  // initial-focus frame can therefore race the portal's first commit; retry
  // only until this dialog's textarea exists, then leave focus ownership to
  // the modal trap and the user.
  useEffect(() => {
    let frame = 0
    const focusInput = () => {
      if (inputRef.current) inputRef.current.focus({ preventScroll: true })
      else frame = requestAnimationFrame(focusInput)
    }
    frame = requestAnimationFrame(focusInput)
    return () => cancelAnimationFrame(frame)
  }, [])

  const submit = async () => {
    const nextMessage = message.trim()
    if (!nextMessage || stale || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setFailed(false)
    try {
      await window.pi.subagentAction({
        sessionPath,
        sessionId: target.sessionId,
        expectedRunId: target.runId,
        action: target.action,
        message: nextMessage
      })
      onClose()
    } catch {
      setFailed(true)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <CenterMorphModal
      open
      onOpenChange={(open) => {
        if (!open && !submittingRef.current) onClose()
      }}
    >
      <CenterMorphModalContent
        ariaLabel={title}
        ariaDescribedBy={`${descriptionId}${feedback ? ` ${feedbackId}` : ''}`}
        closeButtonLabel={t('subagent.actionClose')}
        initialFocusRef={inputRef}
        dismissible={!submitting}
        showCloseButton={!submitting}
        className="max-w-lg"
      >
        <div data-subagent-action-dialog={target.action} className="p-6">
          <h2 className="pr-10 text-base font-semibold text-foreground">{title}</h2>
          <p id={descriptionId} className="mt-1.5 text-sm leading-ui text-muted-foreground">
            {description}
          </p>

          <div className="mt-4">
            <Input
              ref={inputRef}
              multiline
              rows={5}
              value={message}
              disabled={submitting}
              onChange={(value) => {
                setMessage(value)
                setFailed(false)
              }}
              onKeyDown={handleKeyDown}
              aria-label={t('subagent.actionMessageAria')}
              placeholder={t('subagent.actionPlaceholder')}
              classNames={{ input: 'text-sm' }}
            />
          </div>

          {feedback ? (
            <p id={feedbackId} role="alert" className="mt-2 text-xs leading-ui text-destructive">
              {feedback}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <Button data-subagent-action-cancel="" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              data-subagent-action={target.action}
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
              {submitting
                ? t('subagent.actionSending')
                : t(target.action === 'steer' ? 'subagent.steer' : 'subagent.resume')}
            </Button>
          </div>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}
