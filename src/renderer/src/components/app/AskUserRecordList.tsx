import { useState } from 'react'
import { ToolResult, type ToolResultStatus } from '@/components/agents/tool-result'
import { CircleHelp } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/format'
import { useCappedListFade } from '@/lib/hooks/use-capped-list-fade'
import { useI18n } from '@/i18n'
import { ASK_USER_KIND, askUserRecordKind } from '../../../../shared/ask-user'
import type { AskUserRecordDTO, AskUserRecordKind, AskUserToolDetails } from '../../../../shared/ask-user'
import type { MessageKey } from '@/i18n/locales/en'
import { AskUserResultCard } from './AskUserPanel'

/**
 * Every ask_user_question this session asked, newest first — the transcript no
 * longer carries the Q&A, so this is where a question, its answer and the way
 * it ended are reviewed.
 *
 * A record's own outcome decides its chip: answered, dismissed, timed out,
 * interrupted or still awaiting an answer, with the async ones marked as such.
 * Rows are the SAME shape the bash and subagent panels use — a `ToolResult`
 * inset 6px on top of the list's own 4px, which is the todo rows' 10px icon
 * line — and carry no frame of their own: the hover surface is the row.
 */
const KIND_LABEL: Record<AskUserRecordKind, MessageKey> = {
  answered: 'askUser.answered',
  dismissed: 'askUser.cancelled',
  timeout: 'askUser.timedOut',
  aborted: 'askUser.aborted',
  pending: 'askUser.awaiting'
}

/** Waiting spins, answered checks, the three cancels stop — the outcome glyph. */
const KIND_STATUS: Record<AskUserRecordKind, ToolResultStatus> = {
  answered: 'success',
  dismissed: 'cancelled',
  timeout: 'cancelled',
  aborted: 'cancelled',
  pending: 'running'
}

const KIND_TONE: Record<AskUserRecordKind, string> = {
  answered: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  dismissed: 'bg-muted text-muted-foreground',
  timeout: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  aborted: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground'
}

/**
 * The outcome chip, shared by the record row and the transcript's compact row:
 * one vocabulary for "how did this question end".
 */
export function AskUserKindChip({ kind }: { kind: AskUserRecordKind }) {
  const { t } = useI18n()
  return (
    <span
      data-ask-user-kind={kind}
      className={cn('shrink-0 rounded-control px-1.5 py-0.5 text-caption font-semibold', KIND_TONE[kind])}
    >
      {t(KIND_LABEL[kind])}
    </span>
  )
}

export function AskUserRecordList({ records }: { records: readonly AskUserRecordDTO[] }) {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<string | null>(null)
  // Newest first: the question just answered is the one being looked for.
  const ordered = [...records].reverse()
  const { list, mask } = useCappedListFade(ordered.map((record) => record.toolCallId).join('\n'))
  return (
    <div
      ref={list}
      data-ask-user-records=""
      // The drawer's list frame, shared with the todo, bash and subagent panels:
      // a 4 + 6*36 + 5*8 + 4 = 264px (16.5rem) cap, 4px edge padding, 8px gaps.
      className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {ordered.map((record) => {
        const kind = askUserRecordKind(record)
        const open = openId === record.toolCallId
        const details: AskUserToolDetails = {
          kind: ASK_USER_KIND,
          status: record.status,
          questions: record.questions,
          answers: record.answers,
          ...(record.mode ? { mode: record.mode } : {}),
          ...(record.reason ? { reason: record.reason } : {})
        }
        return (
          <div
            key={record.toolCallId}
            className="px-1.5"
            data-ask-user-record={record.toolCallId}
            data-ask-user-record-kind={kind}
          >
            <ToolResult
              animateChanges={false}
              lazyContent
              open={open}
              onOpenChange={(next) => setOpenId(next ? record.toolCallId : null)}
              title={record.questions[0]?.question ?? ''}
              status={KIND_STATUS[kind]}
              icon={<CircleHelp aria-hidden="true" className="size-4" />}
              meta={
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  {record.mode === 'async' ? (
                    <span className="rounded-control border border-border px-1.5 py-0.5 text-caption font-semibold text-muted-foreground">
                      {t('askUser.asyncBadge')}
                    </span>
                  ) : null}
                  <AskUserKindChip kind={kind} />
                </span>
              }
              collapseOnComplete={false}
            >
              {open ? (
                <>
                  <div className="px-0.5 pb-1 text-caption tabular-nums text-muted-foreground">
                    {formatTime(record.at)}
                  </div>
                  <AskUserResultCard details={details} />
                </>
              ) : null}
            </ToolResult>
          </div>
        )
      })}
    </div>
  )
}
