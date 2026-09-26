import { memo, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { TimeGrid, padTimePart, timeParts } from './TimePicker'

/**
 * The `once` schedule's date-time field. beUI ships no date picker (verified
 * against the registry), so this is app glue: an Input-styled trigger opening
 * a vendored MorphPopover whose month grid is composed from Button + theme
 * tokens (content grid, like FileTable — not a hand-rolled primitive).
 *
 * The value is an ISO instant; the calendar and two-phase clock work in LOCAL
 * wall time inside one portalled picker. Past days are disabled.
 */

interface DateTimeFieldProps {
  value: string | null
  onChange: (iso: string) => void
  /** Marks the field invalid (validator owns the message below it). */
  invalid?: boolean
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export const DateTimeField = memo(function DateTimeField({ value, onChange, invalid }: DateTimeFieldProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'date' | 'time'>('date')
  const [phase, setPhase] = useState<'hour' | 'minute'>('hour')
  const selected = value ? new Date(value) : null
  const valid = selected && Number.isFinite(selected.getTime())
  const today = useMemo(() => new Date(), [])
  const [viewYear, setViewYear] = useState(() => (valid ? selected.getFullYear() : today.getFullYear()))
  const [viewMonth, setViewMonth] = useState(() => (valid ? selected.getMonth() : today.getMonth()))

  const days = useMemo(() => {
    // Month grid starting Sunday; leading cells from the previous month are
    // rendered muted and stay clickable (they jump the view).
    const first = new Date(viewYear, viewMonth, 1)
    const start = new Date(viewYear, viewMonth, 1 - first.getDay())
    return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
  }, [viewYear, viewMonth])

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(viewYear, viewMonth, 1)),
    [viewYear, viewMonth, locale]
  )

  const moveMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1)
    setViewYear(next.getFullYear())
    setViewMonth(next.getMonth())
  }

  const pickDay = (day: Date) => {
    const base = valid ? selected : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0)
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), base.getHours(), base.getMinutes())
    onChange(next.toISOString())
    setTab('time')
    if (day.getMonth() !== viewMonth) {
      setViewYear(day.getFullYear())
      setViewMonth(day.getMonth())
    }
  }

  const setTime = (time: string) => {
    const base = valid ? new Date(selected) : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0)
    const [hour, minute] = timeParts(time)
    base.setHours(hour, minute, 0, 0)
    onChange(base.toISOString())
  }

  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const time = valid ? `${padTimePart(selected.getHours())}:${padTimePart(selected.getMinutes())}` : '09:00'

  return (
    <div data-scheduled-datetime>
      <MorphPopover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setTab('date')
            setPhase('hour')
            if (valid) { setViewYear(selected.getFullYear()); setViewMonth(selected.getMonth()) }
          }
        }}
        className="w-full"
      >
        <MorphPopoverTrigger>
          <Button
            variant="ghost"
            size="sm"
            aria-invalid={invalid || undefined}
            aria-label={t('scheduledTasks.editor.at')}
            className={cn(
              'h-9 w-full justify-start gap-2 rounded-control border border-transparent bg-transparent px-2.5 text-sm font-normal',
              invalid && 'text-destructive hover:bg-destructive/10',
              !valid && 'text-muted-foreground'
            )}
          >
            <Clock aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{valid
              ? `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(selected)} · ${time}`
              : t('scheduledTasks.editor.at')}</span>
          </Button>
        </MorphPopoverTrigger>
        <MorphPopoverContent align="start" radius="var(--app-radius-card)" className="w-[21rem] p-2" instant>
          <div className="mb-2 flex items-center gap-1 border-b border-border/60 pb-2">
            <Button variant={tab === 'date' ? 'secondary' : 'ghost'} size="sm" className={cn('h-7 px-2 text-xs', tab === 'date' && 'bg-muted')} aria-pressed={tab === 'date'} data-scheduled-datetime-tab="date" onClick={() => setTab('date')}>
              {t('scheduledTasks.editor.date')}
            </Button>
            <Button variant={tab === 'time' ? 'secondary' : 'ghost'} size="sm" className={cn('h-7 px-2 text-xs', tab === 'time' && 'bg-muted')} aria-pressed={tab === 'time'} data-scheduled-datetime-tab="time" onClick={() => setTab('time')}>
              {t('scheduledTasks.editor.time')}
            </Button>
          </div>
          {tab === 'date' ? (
            <>
              <div className="flex items-center justify-between pb-1">
                <Button variant="ghost" size="icon" className="size-7" aria-label={t('scheduledTasks.editor.monthPrev')} onClick={() => moveMonth(-1)}>
                  <ChevronLeft aria-hidden="true" className="size-3.5" />
                </Button>
                <span className="text-xs font-medium text-foreground">{monthLabel}</span>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t('scheduledTasks.editor.monthNext')} onClick={() => moveMonth(1)}>
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-7 gap-px pb-1">
                {([0, 1, 2, 3, 4, 5, 6] as const).map((day) => (
                  <span key={day} className="py-0.5 text-center text-[10px] font-medium text-muted-foreground">
                    {t(`scheduledTasks.weekday.${day}`)}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px" data-scheduled-calendar>
                {days.map((day) => {
                  const inMonth = day.getMonth() === viewMonth
                  const isToday = sameDay(day, today)
                  const isSelected = valid ? sameDay(day, selected) : false
                  const past = day < dayStart && !isToday
                  return (
                    <Button
                      key={day.getTime()}
                      variant="ghost"
                      size="icon"
                      disabled={past}
                      onClick={() => pickDay(day)}
                      className={cn(
                        'h-7 w-full rounded-detail text-xs tabular-nums transition-colors',
                        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-1 focus-visible:outline-ring',
                        !inMonth && 'text-muted-foreground/50',
                        past && 'cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40',
                        isToday && !isSelected && 'font-semibold text-primary',
                        isSelected && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
                      )}
                    >
                      {day.getDate()}
                    </Button>
                  )
                })}
              </div>
            </>
          ) : <TimeGrid value={time} phase={phase} onPhaseChange={setPhase} onChange={setTime} onComplete={() => setOpen(false)} />}
        </MorphPopoverContent>
      </MorphPopover>
    </div>
  )
})
