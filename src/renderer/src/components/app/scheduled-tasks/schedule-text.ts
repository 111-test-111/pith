/**
 * Display formatting for scheduled tasks. Pure functions fed by i18n `t()` —
 * no prose literals here beyond data formats (HH:mm, ISO dates).
 */
import type { ScheduledTask, ScheduledTaskSchedule } from '../../../../../shared/scheduled-tasks'
import type { MessageKey } from '@/i18n/locales/en'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** "2026-09-22 14:30" in the app's locale, short and unambiguous. */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatTime(iso: string, locale: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)
}

export function weekdayNames(days: readonly number[], t: Translate): string {
  return days.map((day) => t(`scheduledTasks.weekday.${day}` as MessageKey)).join(' ')
}

/** One-line human schedule: "Every 15 min" / "Daily at 07:00" / "Mon Wed at 09:30" / "Once". */
export function scheduleText(schedule: ScheduledTaskSchedule, t: Translate): string {
  switch (schedule.type) {
    case 'once':
      return t('scheduledTasks.schedule.once')
    case 'interval':
      return t('scheduledTasks.schedule.interval', { minutes: schedule.minutes })
    case 'daily':
      return t('scheduledTasks.schedule.daily', { time: schedule.time })
    case 'weekly':
      return t('scheduledTasks.schedule.weekly', { days: weekdayNames(schedule.weekdays, t), time: schedule.time })
  }
}

/** Secondary line: target kind and (for one-shot) the absolute time. */
export function scheduleDetailText(task: ScheduledTask, t: Translate, locale: string): string {
  const parts: string[] = [t(task.target.type === 'existing_session' ? 'scheduledTasks.target.existing' : 'scheduledTasks.target.new')]
  if (task.schedule.type === 'once') parts.push(formatDateTime(task.schedule.at, locale))
  else if (task.schedule.type === 'daily' || task.schedule.type === 'weekly') parts.push(scheduleTimeZoneShort(task.schedule.timeZone))
  return parts.join(' · ')
}

/** "UTC+8" style short zone label for schedule detail lines. */
export function scheduleTimeZoneShort(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(0)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}

export function taskNextRunText(task: ScheduledTask, t: Translate, locale: string): string | null {
  if (task.status !== 'active' || !task.nextRunAt) return null
  return t('scheduledTasks.nextRun', { time: formatDateTime(task.nextRunAt, locale) })
}

/** IANA zones for the editor dropdown; the local zone always leads. */
export function timeZoneOptions(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  return [local, ...zones.filter((zone) => zone !== local)]
}
