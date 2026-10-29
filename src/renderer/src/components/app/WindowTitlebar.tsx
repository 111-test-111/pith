import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useSidebarGlass } from '@/lib/sidebar-glass'
import { windowGlassSurfaceClassName } from './SidebarGlass'

/** Shared chrome material and layout. Native window buttons occupy the safe
 * area; all app controls are beUI components supplied by the caller. */
export function WindowTitlebar({ children, className, inert }: { children?: ReactNode; className?: string; inert?: boolean }) {
  const [glass] = useSidebarGlass()
  return (
    <header data-window-titlebar inert={inert} className={cn(
      'window-titlebar flex shrink-0 items-center gap-3',
      windowGlassSurfaceClassName(glass),
      glass && 'window-glass-wash',
      className
    )}>
      {children}
    </header>
  )
}
