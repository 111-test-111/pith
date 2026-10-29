import pierreMap from './pierre-file-icons.map.json'
import pierreExtensions from './pierre-file-icons.extensions.json'
import { basename } from './format'
import type { UiStyle } from './ui-style'

/**
 * Square uses app-owned Pierre adaptations; squircle uses the native artwork.
 * Both share @pierre/trees' complete associations and the document/media additions.
 *
 * `scripts/prepare-file-icons.mjs` writes only the SVGs these maps can reach into
 * the generated, gitignored `src/renderer/public/file-icons/`; the renderer
 * loads them as relative-URL images instead of bundling the collection.
 */
type IconMap = {
  source: string
  default: string
  names: Record<string, string>
  globs?: { n: string[]; e: string[]; i: string }[]
  extensions: Record<string, string>
}

type PreparedMap = {
  icons: IconMap
  globsByName: Map<string, { extensions: Set<string>; icon: string }[]>
}

function prepareMap(raw: unknown): PreparedMap {
  const icons = raw as IconMap
  const globsByName = new Map<string, { extensions: Set<string>; icon: string }[]>()
  for (const glob of icons.globs ?? []) {
    for (const name of glob.n) {
      const entries = globsByName.get(name)
      const entry = { extensions: new Set(glob.e), icon: glob.i }
      if (entries) entries.push(entry)
      else globsByName.set(name, [entry])
    }
  }
  return { icons, globsByName }
}

const pierre = prepareMap({
  ...pierreMap,
  extensions: { ...pierreMap.extensions, ...pierreExtensions.extensions }
})

/**
 * The most specific match wins: an exact file name, then a known name pattern,
 * then the longest extension (`tar.gz` before `gz`), and finally the generic
 * file icon.
 */
export function fileIconName(path: string, _style: UiStyle = 'square'): string {
  const { icons, globsByName } = pierre
  const name = basename(path).toLowerCase()
  const named = Object.hasOwn(icons.names, name) ? icons.names[name] : undefined
  if (named) return named

  const parts = name.split('.')
  if (parts.length > 1) {
    const base = parts.slice(0, -1).join('.')
    const extension = parts[parts.length - 1]
    for (const glob of globsByName.get(base) ?? []) {
      if (glob.extensions.has(extension)) return glob.icon
    }
    for (let index = 1; index < parts.length; index++) {
      const candidate = parts.slice(index).join('.')
      const found = Object.hasOwn(icons.extensions, candidate) ? icons.extensions[candidate] : undefined
      if (found) return found
    }
  }
  return icons.default
}

/** Relative on purpose: the packaged renderer is loaded from `file://`, where
 * an absolute path would resolve against the filesystem root instead of the app. */
export function fileIconSource(path: string, style: UiStyle = 'square'): string {
  const directory = style === 'squircle' ? 'pierre/' : 'pierre-square/'
  return `./file-icons/${directory}${fileIconName(path, style)}.svg`
}
