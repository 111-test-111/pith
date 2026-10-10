import { memo, useMemo, useState } from 'react'
import { ChevronDown } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'

// The reference editor offers these common zones first while accepting any
// valid IANA zone as text. Keeping this list bounded avoids mounting hundreds
// of animated SelectItem nodes whenever the editor opens.
const COMMON_TIME_ZONES = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
  'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai', 'UTC',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'Pacific/Honolulu',
  'Africa/Cairo', 'Africa/Johannesburg'
] as const

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export const TimeZoneField = memo(function TimeZoneField({
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
  const zones = useMemo(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    return [local, ...COMMON_TIME_ZONES.filter((zone) => zone !== local)]
  }, [])

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        value={value}
        onChange={onChange}
        aria-label={t('scheduledTasks.editor.timeZone')}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        className="min-w-0 flex-1"

      />
      <MorphPopover open={open} onOpenChange={setOpen}>
        <MorphPopoverTrigger>
          <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label={t('scheduledTasks.editor.timeZone')}>
            <ChevronDown aria-hidden="true" className="size-4" />
          </Button>
        </MorphPopoverTrigger>
        <MorphPopoverContent align="end" radius="var(--app-radius-card)" className="w-64 p-1">
          <div className="max-h-64 overflow-y-auto p-1">
            {zones.map((zone) => (
              <Button
                key={zone}
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start truncate px-2 text-sm"
                onClick={() => { onChange(zone); setOpen(false) }}
              >
                {zone}
              </Button>
            ))}
          </div>
        </MorphPopoverContent>
      </MorphPopover>
    </div>
  )
})
