import { AnimatePresence, motion } from 'motion/react'
import { ArrowBigRightDash, ArrowLeftFromLine, Clock, Image as ImageIcon, LinkSimple, X, Zap } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { EASE_OUT } from '@/lib/ease'
import { extractUserDisplay } from '@/lib/user-message'
import { useI18n } from '@/i18n'
import type { QueuedItemDTO } from '../../../../shared/types'

/**
 * Pending steer / follow-up messages, live from the main process's payload
 * mirror (queue_update → QueuedItemDTO). Rows show the user's prose with
 * attachment counts (inlined `<file>` blocks and images collapse into
 * badges), a follow-up can be promoted to steer mid-run, any row can be
 * dropped, and Recall merges everything back into the composer draft.
 */
export function QueuePanel({
  steering,
  followUp,
  onPromote,
  onRemove,
  onRecall
}: {
  steering: QueuedItemDTO[]
  followUp: QueuedItemDTO[]
  /** Promote follow-up `index` into the steering queue (deliver next turn). */
  onPromote: (index: number) => void
  /** Drop one queued message. */
  onRemove: (kind: 'steering' | 'followUp', index: number) => void
  /** Recall every queued message back into the composer draft. */
  onRecall: () => void
}) {
  const { t } = useI18n()

  const rows: (QueuedItemDTO & { kind: 'steering' | 'followUp'; key: string; index: number })[] = []
  const seenKeys = new Set<string>()
  const push = (kind: 'steering' | 'followUp', item: QueuedItemDTO, index: number) => {
    let key = `${kind}:${item.text}`
    let n = 2
    while (seenKeys.has(key)) key = `${kind}:${item.text}:${n++}`
    seenKeys.add(key)
    rows.push({ ...item, kind, key, index })
  }
  steering.forEach((item, index) => push('steering', item, index))
  followUp.forEach((item, index) => push('followUp', item, index))

  return (
    <AnimatePresence initial={false}>
      {rows.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-muted/40"
        >
          <div className="flex h-7 items-center justify-between pl-3 pr-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('composer.queuedTitle', { count: rows.length })}
            </span>
            <Tooltip content={t('composer.recallQueueTitle')} side="top">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                aria-label={t('composer.recallQueue')}
                onClick={onRecall}
              >
                <ArrowLeftFromLine className="size-3.5" />
              </Button>
            </Tooltip>
          </div>

          <AnimatePresence initial={false}>
            {rows.map((row) => {
              const display = extractUserDisplay(row.text)
              return (
                <motion.div
                  key={row.key}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.16, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  {/* A queued message reads at body size on a row tall enough
                      to centre it: the text keeps the app's 24px body line
                      (`text-sm leading-6`) and the symmetric padding puts the
                      line in the middle of the row on its own. */}
                  <div data-queue-row className="group flex min-w-0 items-center gap-2 rounded-lg py-1.5 pl-2 pr-1 transition-colors hover:bg-muted">
                    <Tooltip
                      content={t(row.kind === 'steering' ? 'composer.kindSteer' : 'composer.kindFollowUp')}
                      side="bottom"
                    >
                      <span className="grid size-4 shrink-0 place-items-center">
                        {row.kind === 'steering' ? (
                          <Zap aria-hidden="true" className="size-3.5 text-primary" />
                        ) : (
                          <Clock aria-hidden="true" className="size-3.5 text-muted-foreground" />
                        )}
                      </span>
                    </Tooltip>
                    <span data-queue-row-text className="min-w-0 flex-1 truncate text-sm leading-6 text-foreground/80">
                      {display.text}
                      {row.imageCount > 0 ? (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 align-baseline leading-4 text-muted-foreground">
                          <ImageIcon aria-hidden="true" className="size-3" />
                          {row.imageCount}
                        </span>
                      ) : null}
                      {row.filePaths.length > 0 ? (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 align-baseline leading-4 text-muted-foreground">
                          <LinkSimple aria-hidden="true" className="size-3" />
                          {row.filePaths.length}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {row.kind === 'followUp' ? (
                        <Tooltip content={t('composer.steerNow')} side="top">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-primary hover:text-primary"
                            aria-label={t('composer.steerNow')}
                            onClick={() => onPromote(row.index)}
                          >
                            <ArrowBigRightDash className="size-3.5" />
                          </Button>
                        </Tooltip>
                      ) : null}
                      <Tooltip content={t('composer.removeQueued')} side="top">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground hover:text-foreground"
                          aria-label={t('composer.removeQueued')}
                          onClick={() => onRemove(row.kind, row.index)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </Tooltip>
                    </span>
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
          <div className="h-1" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
