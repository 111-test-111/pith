import { cn } from '@/lib/utils'

/**
 * Shared frosted-glass material for the title row and session sidebar
 * (Settings → Appearance, default on — `lib/sidebar-glass.ts` owns the
 * preference). The shared surface classes keep both regions in step.
 *
 * The glass is REAL transparency: on macOS the window itself is a vibrancy
 * surface (window-chrome.ts) and the page background steps aside
 * (`html[data-platform='darwin'] body` in styles.css), so whatever sits behind
 * the window shows through the title row and sidebar; elsewhere the layers sit
 * over the app's own opaque background. The neutral veil carries the material
 * and keeps the list readable; a faint theme tint (`color-mix` of `--primary`
 * with `transparent`) only accents the corners.
 *
 * Glass works in two layers, deliberately: the wash is a *sibling* painted
 * behind the panel (through `AnimatedSidebar`'s backdrop slot), not a child of
 * the panel — a child would sit above the panel's own translucent background,
 * which is a tinted panel, not glass.
 */

/** The faint corner tint painted behind the sidebar panel; see the
 * `.window-glass-wash` rule in `styles.css` for the alpha-based gradients. */
export function SidebarGlassWash() {
  return (
    <div
      aria-hidden="true"
      data-sidebar-glass-wash=""
      className="window-glass-wash pointer-events-none absolute inset-0"
    />
  )
}

/**
 * The panel surface: translucent and frosted when on — `cn` resolves the veil
 * over the vendored panel's own `bg-background` — and the plain opaque column
 * when off. The veil stays light (`/20`): the window's own material is the
 * frosting, the veil only keeps the list readable. Preserve the backdrop's
 * saturation so the subtle accent tint does not become a colored panel.
 */
export function windowGlassSurfaceClassName(glass: boolean): string {
  return glass ? 'bg-background/20 backdrop-blur-2xl' : 'bg-background'
}

export function sidebarGlassPanelClassName(glass: boolean): string {
  return cn(
    'h-full border-border/50',
    windowGlassSurfaceClassName(glass)
  )
}
