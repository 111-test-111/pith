import map from './file-icons.map.json'
import { basename } from './format'

/**
 * File-type artwork is the one deliberate exception to the Lucide-only glyph
 * rule: vscode-icons draws a distinct mark per language, framework and config
 * file, which is what makes a file tree scannable.
 *
 * The drawings themselves are generated into the renderer's public directory by
 * `scripts/prepare-file-icons.mjs` (see AGENTS.md); this module owns the lookup
 * that turns a path into one of their names. `file-icons.map.json` is generated
 * from vscode-icons' own manifest by `scripts/generate-file-icon-map.mjs`.
 */
type IconMap = {
  source: string
  generated: string
  default: string
  names: Record<string, string>
  globs: { n: string[]; e: string[]; i: string }[]
  extensions: Record<string, string>
}

const icons = map as IconMap

/** Glob entries by the name they match, so looking one up is not a scan. */
const globsByName = new Map<string, { extensions: Set<string>; icon: string }[]>()
for (const glob of icons.globs) {
  for (const name of glob.n) {
    const entries = globsByName.get(name)
    const entry = { extensions: new Set(glob.e), icon: glob.i }
    if (entries) entries.push(entry)
    else globsByName.set(name, [entry])
  }
}

/**
 * The most specific match wins, mirroring how VS Code resolves an icon theme:
 * an exact file name (`Dockerfile`, `package.json`), then a known name pattern
 * (`vite.config.ts`), then the longest extension that matches (`tar.gz` before
 * `gz`), and finally the generic file.
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

/** Public-directory URL of the icon for `path`. Relative on purpose: the
 * packaged renderer is loaded from `file://`, where an absolute path would
 * resolve against the filesystem root instead of the app. */
export function fileIconSource(path: string): string {
  return `./file-icons/${fileIconName(path)}.svg`
}
