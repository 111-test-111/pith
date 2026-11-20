import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type { DiffLayout } from '@/lib/diff-layout'
import { DiffSideBySide, DiffStacked, WrapText } from '@/lib/icons'
import { cn } from '@/lib/utils'

export function DiffLayoutButton({ layout, onChange, className }: {
  layout: DiffLayout
  onChange: (layout: DiffLayout) => void
  className?: string
}) {
  const { t } = useI18n()
  const split = layout === 'side-by-side'
  const Icon = split ? DiffSideBySide : DiffStacked
  return <Tooltip content={t(split ? 'diff.showStacked' : 'diff.showSideBySide')} wrapperClassName="shrink-0">
    <Button type="button" variant="ghost" size="icon" className={cn('size-7', className)} data-diff-layout-toggle
      aria-label={t('diff.sideBySide')} aria-pressed={split} onClick={() => onChange(split ? 'stacked' : 'side-by-side')}>
      <Icon aria-hidden className="size-4" />
    </Button>
  </Tooltip>
}

export function DiffWrapButton({ wrap, onChange, className }: {
  wrap: boolean; onChange: (wrap: boolean) => void; className?: string
}) {
  const { t } = useI18n()
  const label = t('files.wrap')
  return <Tooltip content={label} wrapperClassName="shrink-0">
    <Button type="button" variant="ghost" size="icon" className={cn('size-7', wrap && 'bg-muted text-primary', className)}
      aria-label={label} aria-pressed={wrap} onClick={() => onChange(!wrap)}>
      <WrapText aria-hidden className="size-4" />
    </Button>
  </Tooltip>
}
