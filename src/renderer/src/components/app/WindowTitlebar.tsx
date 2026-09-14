import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Layout only. Native window buttons occupy the platform-specific safe area;
 * all app controls are beUI components supplied by the caller. */
export function WindowTitlebar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header data-window-titlebar className={cn('window-titlebar flex shrink-0 items-center gap-3 bg-background', className)}>
      {children}
    </header>
  )
}
