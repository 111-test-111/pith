import map from './file-icons.map.json'
import { basename } from './format'

/**
 * File-type artwork is Catppuccin Icons for the whole app: the interface style
 * preference changes corners, not icons, so square and squircle draw the same set.
 *
 * `scripts/prepare-file-icons.mjs` writes only the SVGs this map can reach into
 * the generated, gitignored `src/renderer/public/file-icons/`; the renderer
 * loads them as relative-URL images instead of bundling the collection.
 */
type IconMap = {
  source: string
  generated: string
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

const { icons, globsByName } = prepareMap(map)

/**
 * The most specific match wins: an exact file name, then a known name pattern,
 * then the longest extension (`tar.gz` before `gz`), and finally the generic
 * file icon.
 */
export function fileIconName(path: string): string {
  const name = basename(path).toLowerCase()
  const named = icons.names[name]
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
      const found = icons.extensions[candidate]
      if (found) return found
    }
  }
  return icons.default
}

/** Relative on purpose: the packaged renderer is loaded from `file://`, where
 * an absolute path would resolve against the filesystem root instead of the app. */
export function fileIconSource(path: string): string {
  return `./file-icons/${fileIconName(path)}.svg`
}
