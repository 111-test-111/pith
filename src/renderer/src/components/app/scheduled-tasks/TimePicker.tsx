import { memo, useState } from 'react'
import { Clock } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

type TimePart = 'hour' | 'minute'

export function padTimePart(value: number): string {
  return String(value).padStart(2, '0')
}

export function timeParts(value: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2])] : [9, 0]
}

/** One beUI Button grid for both parts; its height stays fixed as phases change. */
export function TimeGrid({
  value,
  phase,
  onPhaseChange,
  onChange,
  onComplete
}: {
  value: string
  phase: TimePart
  onPhaseChange: (phase: TimePart) => void
  onChange: (value: string) => void
  onComplete?: () => void
}) {
  const { t } = useI18n()
  const [hour, minute] = timeParts(value)
  const count = phase === 'hour' ? 24 : 60
  const selected = phase === 'hour' ? hour : minute

  return (
    <div className="flex flex-col gap-2" data-time-picker-phase={phase}>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-1">
          <Button variant={phase === 'hour' ? 'secondary' : 'ghost'} size="sm" className={cn('h-7 px-2 text-xs', phase === 'hour' && 'bg-primary/15 hover:bg-primary/25')} aria-pressed={phase === 'hour'} onClick={() => onPhaseChange('hour')}>
            {t('scheduledTasks.editor.hour')}
          </Button>
          <Button variant={phase === 'minute' ? 'secondary' : 'ghost'} size="sm" className={cn('h-7 px-2 text-xs', phase === 'minute' && 'bg-primary/15 hover:bg-primary/25')} aria-pressed={phase === 'minute'} onClick={() => onPhaseChange('minute')}>
            {t('scheduledTasks.editor.minute')}
          </Button>
        </div>
        <span className="text-xs font-medium tabular-nums text-foreground">{padTimePart(hour)}:{padTimePart(minute)}</span>
      </div>
      <div className={cn('grid min-h-48 gap-1', phase === 'hour' ? 'grid-cols-6 content-center' : 'grid-cols-10 content-start')} data-time-picker-grid={phase}>
        {Array.from({ length: count }, (_, value_) => (
          <Button
            key={value_}
            variant="ghost"
            size="icon"
            aria-label={`${t(phase === 'hour' ? 'scheduledTasks.editor.hour' : 'scheduledTasks.editor.minute')} ${padTimePart(value_)}`}
            aria-pressed={selected === value_}
            className={cn(
              'h-7 w-full rounded-detail text-caption font-normal tabular-nums',
              selected === value_ ? 'bg-primary/15 text-foreground hover:bg-primary/25 hover:text-foreground' : 'text-foreground'
            )}
            onClick={() => {
              onChange(phase === 'hour' ? `${padTimePart(value_)}:${padTimePart(minute)}` : `${padTimePart(hour)}:${padTimePart(value_)}`)
              if (phase === 'hour') onPhaseChange('minute')
              else onComplete?.()
            }}
          >
            {padTimePart(value_)}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Recurring schedules choose HH:mm in one portalled, two-phase control. */
export const TimeOfDayField = memo(function TimeOfDayField({
  value,
  onChange,
  invalid
}: {
  value: string
  onChange: (value: string) => void
  invalid?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<TimePart>('hour')

  return (
    <div data-scheduled-time>
      <MorphPopover open={open} onOpenChange={(next) => { setOpen(next); if (next) setPhase('hour') }} className="w-full">
        <MorphPopoverTrigger>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('scheduledTasks.editor.time')}
            aria-invalid={invalid || undefined}
            className={cn('h-9 w-full justify-start gap-2 rounded-control border border-transparent bg-transparent px-2.5 text-sm font-normal', invalid && 'text-destructive hover:bg-destructive/10')}
          >
            <Clock aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="tabular-nums">{value}</span>
          </Button>
        </MorphPopoverTrigger>
        <MorphPopoverContent align="start" radius="var(--app-radius-card)" className="w-[21rem] p-2">
          <TimeGrid value={value} phase={phase} onPhaseChange={setPhase} onChange={onChange} onComplete={() => setOpen(false)} />
        </MorphPopoverContent>
      </MorphPopover>
    </div>
  )
})
