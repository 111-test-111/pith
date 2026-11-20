import { memo, useMemo, useState } from 'react'
import { Clock } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import {
  DateRangePicker,
  DateRangePickerCalendar,
  DateRangePickerGrid,
  DateRangePickerHeader,
  type DateRange,
} from '@/components/motion/date-range-picker'
import { MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { TimeGrid, padTimePart, timeParts } from './TimePicker'

/**
 * The `once` schedule's date-time field. The calendar is beUI's native
 * DateRangePicker: it speaks UTC calendar dates (YYYY-MM-DD) while this field
 * keeps an ISO instant in local wall time, and it picks ranges while the
 * schedule needs one day — so the field controls it with a complete one-day
 * range and every click starts (and becomes) the next one-day range. The
 * two-phase clock stays app glue: beUI ships no time picker. Past days are
 * disabled through `min`.
 */

interface DateTimeFieldProps {
  value: string | null
  onChange: (iso: string) => void
  /** Marks the field invalid (validator owns the message below it). */
  invalid?: boolean
}

/** Local wall date → the picker's UTC calendar date key (YYYY-MM-DD). */
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`
}

export const DateTimeField = memo(function DateTimeField({ value, onChange, invalid }: DateTimeFieldProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'date' | 'time'>('date')
  const [phase, setPhase] = useState<'hour' | 'minute'>('hour')
  const selected = value ? new Date(value) : null
  const valid = selected && Number.isFinite(selected.getTime())
  const today = useMemo(() => new Date(), [])

  // A complete one-day range: with `to` set, the controller starts a fresh
  // range on the next pick instead of completing a span, so each click
  // replaces the date.
  const range: DateRange | null = valid ? { from: dateKey(selected), to: dateKey(selected) } : null

  const pickDay = (next: DateRange | null) => {
    // `null` is the footer Clear action; this composition omits the footer.
    if (!next) return
    const [year, month, day] = next.from.split('-').map(Number)
    const base = valid ? selected : new Date(year, month - 1, day, 9, 0)
    onChange(new Date(year, month - 1, day, base.getHours(), base.getMinutes()).toISOString())
    setTab('time')
  }

  const setTime = (time: string) => {
    const base = valid ? new Date(selected) : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0)
    const [hour, minute] = timeParts(time)
    base.setHours(hour, minute, 0, 0)
    onChange(base.toISOString())
  }

  const time = valid ? `${padTimePart(selected.getHours())}:${padTimePart(selected.getMinutes())}` : '09:00'

  return (
    <div data-scheduled-datetime>
      <DateRangePicker
        value={range}
        onValueChange={pickDay}
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setTab('date')
            setPhase('hour')
          }
        }}
        min={dateKey(today)}
        locale={locale}
        label={t('scheduledTasks.editor.at')}
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
        <MorphPopoverContent align="start" radius="var(--app-radius-card)" className="w-[21rem] p-2">
          <Tabs value={tab} onValueChange={value => setTab(value as 'date' | 'time')} variant="underline" className="mb-2">
            <TabsList className="flex h-9 w-full border-border/60">
              <TabsTrigger value="date" className="h-9 min-h-0 px-2 text-xs" data-scheduled-datetime-tab="date">{t('scheduledTasks.editor.date')}</TabsTrigger>
              <TabsTrigger value="time" className="h-9 min-h-0 px-2 text-xs" data-scheduled-datetime-tab="time">{t('scheduledTasks.editor.time')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === 'date' ? (
            <DateRangePickerCalendar className="w-full rounded-none border-0 p-0" data-scheduled-calendar>
              <DateRangePickerHeader />
              <DateRangePickerGrid />
            </DateRangePickerCalendar>
          ) : <TimeGrid value={time} phase={phase} onPhaseChange={setPhase} onChange={setTime} onComplete={() => setOpen(false)} />}
        </MorphPopoverContent>
      </DateRangePicker>
    </div>
  )
})
