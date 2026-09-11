import { Loader } from '@/components/motion/loader'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export interface TurnStatusProps {
  className?: string
}

/**
 * The one "turn in progress" indicator: a single spinner row, strictly one line
 * tall, always rendered below the turn's output. It replaces the earlier
 * per-phase text shimmers ("Thinking…", "Working…", "…") and the elapsed-time
 * label, which could surface mid-round — above the tool calls that same round
 * emitted.
 */
export function TurnStatus({ className }: TurnStatusProps) {
  const { t } = useI18n()

  return (
    <div className={cn('flex h-6 items-center gap-2', className)}>
      <Loader
        variant="spinner"
        size={16}
        label={t('chat.working')}
        className="shrink-0 text-primary"
      />
    </div>
  )
}
