#!/usr/bin/env node
/**
 * Regenerates the flat filename/extension → icon lookup used by every file row:
 * `file-icons.map.json` from Catppuccin Icons, the app's only file-type family.
 *
 * The artwork package ships drawings and names, but not the VS Code theme's
 * associations, so the table is derived from the upstream theme source.
 * `scripts/prepare-file-icons.mjs` then writes only the referenced artwork.
 *
 * This script needs network access; it is NOT part of install/dev/build. Run it
 * by hand (`npm run icons:file-types`) when you want to pick up upstream
 * additions, then commit the regenerated JSON — including `source`, which
 * records the exact revision the table came from.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CATPPUCCIN_RAW = 'https://raw.githubusercontent.com/catppuccin/vscode-icons'
const CATPPUCCIN_REF = process.env.CATPPUCCIN_ICONS_REF || 'main'
const OUT = resolve('src/renderer/src/lib/file-icons.map.json')

/** Catppuccin source ids whose Iconify names use kebab case instead. */
const ICONIFY_ALIASES = { deno_lock: 'deno-lock' }

const cleanExtension = (value) => value.replace(/^\./, '').toLowerCase()

async function fetchText(base, ref, path) {
  const response = await fetch(`${base}/${ref}/${path}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  const etag = response.headers.get('etag')
  const revision = etag?.replace(/^W\//, '').replace(/^"|"$/g, '').slice(0, 8) || ref
  return { text: await response.text(), revision }
}

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const source = await fetchText(CATPPUCCIN_RAW, CATPPUCCIN_REF, 'src/defaults/fileIcons.ts')
const objectSource = /const fileIcons: FileIcons = (\{[\s\S]*?\n\})\n\nconst \{ languageIds/.exec(source.text)?.[1]
if (!objectSource) throw new Error('Could not find Catppuccin fileIcons object')
const icons = new Function(`return (${objectSource})`)()

const names = {}
const extensions = {}
const languageExtensions = {}
for (const [sourceIcon, associations] of Object.entries(icons)) {
  const icon = ICONIFY_ALIASES[sourceIcon] ?? sourceIcon
  // Catppuccin's reducer lets later definitions win; assignment in source
  // order mirrors that behavior for contested names and extensions.
  for (const name of associations.fileNames ?? []) names[name.toLowerCase()] = icon
  for (const extension of associations.fileExtensions ?? []) extensions[cleanExtension(extension)] = icon
  // The renderer has a path but no VS Code language service. A few upstream
  // icons (notably `diff`) are associated only through languageIds, whose
  // literal value is also the conventional extension. Keep these as a lower-
  // priority fallback so every explicit fileExtension still wins.
  for (const languageId of associations.languageIds ?? []) languageExtensions[cleanExtension(languageId)] = icon
}

const table = {
  source: `Catppuccin vscode-icons ${CATPPUCCIN_REF} (${source.revision}), MIT`,
  generated: new Date().toISOString().slice(0, 10),
  default: 'file',
  names: sorted(names),
  globs: [],
  extensions: sorted({ ...languageExtensions, ...extensions })
}

await writeFile(OUT, JSON.stringify(table, null, 0) + '\n')
console.log(
  `file-icons.map.json: ${Object.keys(table.names).length} names, ` +
    `${Object.keys(table.extensions).length} extensions (${(JSON.stringify(table).length / 1024).toFixed(0)} KiB)`
)
