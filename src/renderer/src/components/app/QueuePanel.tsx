import { useId, useState } from 'react'
import { ArrowBigRightDash, ArrowLeftFromLine, ChevronDown, Clock, Image as ImageIcon, LinkSimple, Minimize2, X, Zap } from '@/lib/icons'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { FadeScroll } from './FadeScroll'
import { basename } from '@/lib/format'
import { extractUserDisplay } from '@/lib/user-message'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { QueuedItemDTO, QueueItemPayload } from '../../../../shared/types'

interface QueuePanelProps {
  steering: QueuedItemDTO[]
  followUp: QueuedItemDTO[]
  compactionQueued?: boolean
  onPromote: (index: number) => void
  onRemove: (kind: QueueItemPayload['kind'], index: number) => void
  onRecall: () => void
}

/** Start each newly populated queue folded. Disappearing rows release the
 * composer's top edge in the same render. */
export function QueuePanel(props: QueuePanelProps) {
  return props.steering.length || props.followUp.length || props.compactionQueued
    ? <QueuedMessages {...props} />
    : null
}

function QueuedMessages({ steering, followUp, compactionQueued = false, onPromote, onRemove, onRecall }: QueuePanelProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const rows: (QueuedItemDTO & QueueItemPayload & { key: string; preview: string })[] = []
  const occurrences = new Map<string, number>()
  const addRow = (kind: QueueItemPayload['kind'], item: QueuedItemDTO, index: number) => {
    const identity = `${kind}:${item.text}`
    const occurrence = (occurrences.get(identity) ?? 0) + 1
    occurrences.set(identity, occurrence)
    const text = extractUserDisplay(item.originalText || item.text).text.replace(/\s+/g, ' ').trim()
    const preview = text || item.filePaths.map(basename).join(', ') || (item.imageCount ? t('composer.queuedImage') : '')
    rows.push({ ...item, kind, index, key: JSON.stringify([identity, occurrence]), preview })
  }
  steering.forEach((item, index) => addRow('steering', item, index))
  followUp.forEach((item, index) => addRow('followUp', item, index))
  const preview = rows[0]?.preview ?? t('composer.compactionQueued')

  return (
    <div data-queue-panel className="flex w-full min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-queue-toggle
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="h-8 min-w-0 flex-1 justify-start gap-2.5 rounded-inner px-2.5"
        >
          <span className="shrink-0 font-medium tabular-nums text-foreground/85">
            {t('composer.queuedTitle', { count: rows.length + Number(compactionQueued) })}
          </span>
          <span data-queue-preview className="min-w-0 flex-1 truncate text-left font-normal text-muted-foreground" title={preview}>
            {preview}
          </span>
          <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </Button>
        {rows.length > 0 ? (
          <Tooltip content={t('composer.recallQueueTitle')} side="top">
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0"
              aria-label={t('composer.recallQueue')} onClick={onRecall}>
              <ArrowLeftFromLine aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        ) : null}
      </div>

      <AgentDisclosure id={bodyId} open={open}>
        <FadeScroll className="max-h-[min(15rem,30dvh)] overscroll-contain border-t border-border/60 py-1 pl-1.5 pr-0.5">
          {/* Row actions share the header control's right edge and size: the
              body's own inset is tuned (2px + FadeScroll's inner 4px) to match the
              header's 6px, and a row keeps no right padding of its own. */}
          {rows.map(row => (
            <div key={row.key} data-queue-row className="flex min-w-0 items-center gap-2 rounded-inner py-1 pl-2.5 pr-0 transition-colors hover:bg-muted/60 focus-within:bg-muted/60">
              <Tooltip content={t(row.kind === 'steering' ? 'composer.kindSteer' : 'composer.kindFollowUp')} side="bottom">
                <span className="grid size-4 shrink-0 place-items-center">
                  {row.kind === 'steering' ? <Zap aria-hidden="true" className="size-4 text-primary" />
                    : <Clock aria-hidden="true" className="size-4 text-muted-foreground" />}
                </span>
              </Tooltip>
              <span data-queue-row-text className="min-w-0 flex-1 truncate text-sm text-foreground" title={row.preview}>{row.preview}</span>
              {row.imageCount > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
                  <ImageIcon aria-hidden="true" className="size-3.5" />{row.imageCount}
                </span>
              ) : null}
              {row.filePaths.length > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
                  <LinkSimple aria-hidden="true" className="size-3.5" />{row.filePaths.length}
                </span>
              ) : null}
              <div className="flex shrink-0 items-center gap-0.5">
                {row.kind === 'followUp' ? (
                  <Tooltip content={t('composer.steerNow')} side="top">
                    <Button type="button" variant="ghost" size="icon" className="size-7 text-primary hover:text-primary"
                      aria-label={t('composer.steerNow')} onClick={() => onPromote(row.index)}>
                      <ArrowBigRightDash aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                ) : null}
                <Tooltip content={t('composer.removeQueued')} side="top">
                  <Button type="button" variant="ghost" size="icon" className="size-7"
                    aria-label={t('composer.removeQueued')} onClick={() => onRemove(row.kind, row.index)}>
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          ))}
          {compactionQueued ? (
            <div data-queue-compaction role="status" className="flex min-w-0 items-start gap-2 px-2.5 py-1.5">
              <Minimize2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-foreground">{t('composer.compactionQueued')}</p>
                <p className="text-xs text-muted-foreground">{t('composer.compactionQueuedHint')}</p>
              </div>
            </div>
          ) : null}
        </FadeScroll>
      </AgentDisclosure>
    </div>
  )
}
