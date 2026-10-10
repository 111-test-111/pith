import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

const statuses = {
  M: { color: 'text-amber-600 dark:text-amber-400', key: 'modified' },
  A: { color: 'text-emerald-600 dark:text-emerald-400', key: 'added' },
  '?': { color: 'text-emerald-600 dark:text-emerald-400', key: 'untracked' },
  D: { color: 'text-rose-600 dark:text-rose-400', key: 'deleted' },
  R: { color: 'text-sky-600 dark:text-sky-400', key: 'renamed' },
  C: { color: 'text-sky-600 dark:text-sky-400', key: 'copied' },
  T: { color: 'text-violet-600 dark:text-violet-400', key: 'typeChanged' },
  U: { color: 'text-destructive', key: 'conflicted' },
} as const
export function GitStatus({ status, conflict = false }: { status: string; conflict?: boolean }) {
  const { t } = useI18n(), item = statuses[(conflict ? 'U' : status[0]) as keyof typeof statuses]
  return <span data-git-status={status} className={cn('shrink-0 font-mono text-xs', item?.color ?? 'text-muted-foreground')} title={item ? t(`git.status.${item.key}`) : status}>{status}</span>
}
