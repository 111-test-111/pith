import { cn } from '@/lib/utils'

/**
 * Frosted-glass surface for the session sidebar (Settings → Appearance, default
 * on — `lib/sidebar-glass.ts` owns the preference). One module builds the
 * panel's surface classes, the wash painted behind it and the list-fade color,
 * so the workspace composition and `scripts/check-sidebar-glass.mjs` share the
 * same source of truth.
 *
 * Glass works in two layers, deliberately: the wash is a *sibling* painted
 * behind the panel (through `AnimatedSidebar`'s backdrop slot), not a child of
 * the panel — a child would sit above the panel's own translucent background,
 * which is a tinted panel, not glass. The panel surface is the one that goes
 * translucent and blurred (`bg-background/70 backdrop-blur-2xl`), so it frosts
 * whatever is painted underneath it, and that is exactly the wash.
 */

/** The accent-tinted wash painted behind the sidebar panel; see the
 * `.sidebar-glass-wash` rule in `styles.css` for the themed gradients. */
export function SidebarGlassWash() {
  return (
    <div
      aria-hidden="true"
      data-sidebar-glass-wash=""
      className="sidebar-glass-wash pointer-events-none absolute inset-0"
    />
  )
}

/**
 * The panel surface: translucent and frosted when on — `cn` resolves
 * `bg-background/70` over the vendored panel's own `bg-background` — and the
 * plain opaque column when off. `backdrop-saturate-150` gives the frosted wash
 * a little of the richness macOS vibrancy has.
 */
export function sidebarGlassPanelClassName(glass: boolean): string {
  return cn(
    'h-full border-border/50',
    glass ? 'bg-background/65 backdrop-blur-2xl backdrop-saturate-150' : 'bg-background'
  )
}

/**
 * The session list's bottom fade keeps the glass intact: its `from-` color
 * follows the panel surface, so the translucent column doesn't end in an
 * opaque band. Rows ghost slightly through the fade — the same trade every
 * frosted edge makes.
 */
export function sidebarGlassFadeClassName(glass: boolean): string {
  return cn(
    'pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent',
    glass ? 'from-background/65' : 'from-background'
  )
}
