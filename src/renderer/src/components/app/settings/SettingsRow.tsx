import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared row layout for settings sections: a labelled line with an optional
 * description on the left and a control on the right. Pure composition of
 * theme tokens — every interactive control stays a beUI primitive.
 */
export function SettingsRow({
  label,
  description,
  children,
  className
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-3 py-2.5', className)}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
    </div>
  )
}

/** A titled group of SettingsRows. */
export function SettingsGroup({
  title,
  children,
  description
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="px-3 pb-1.5 pt-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        {description ? <p className="mt-1 text-xs text-muted-foreground/70">{description}</p> : null}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  )
}
