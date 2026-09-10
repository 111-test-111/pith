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
    <div className={cn('flex items-center justify-between gap-4 px-4 py-3', className)}>
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

/** A titled group of settings, rendered as a divided card. */
export function SettingsGroup({
  title,
  children,
  description
}: {
  title: ReactNode
  children: ReactNode
  description?: ReactNode
}) {
  return (
    <section>
      <div className="px-1 pb-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        {description ? <p className="mt-1 text-xs text-muted-foreground/70">{description}</p> : null}
      </div>
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
        {children}
      </div>
    </section>
  )
}
