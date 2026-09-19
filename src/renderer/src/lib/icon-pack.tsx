import { createContext, useContext, type ReactNode } from 'react'
import type { IconPack } from './ui-style'

/**
 * Which pack `lib/icons.tsx` renders. The adapter is the single funnel for
 * every glyph in the app, so a pack switch is a context change and one
 * re-render — no reload, no remount, and no per-call-site conditionals.
 *
 * Defaults to the square style's pack so an isolated render (a check fixture,
 * a preview) never needs the provider.
 */
const IconPackContext = createContext<IconPack>('carbon')

export function IconPackProvider({ pack, children }: { pack: IconPack; children: ReactNode }) {
  return <IconPackContext.Provider value={pack}>{children}</IconPackContext.Provider>
}

export function useIconPack(): IconPack {
  return useContext(IconPackContext)
}
