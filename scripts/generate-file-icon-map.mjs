#!/usr/bin/env node
/**
 * Imports Bearded Icons' file associations and original SVG artwork from a
 * pinned upstream release. Only available file artwork is vendored; folder
 * and toolbar glyphs stay with the UI adapter.
 *
 * This networked maintenance command is NOT part of install/dev/build. Run
 * `npm run icons:file-types`, then commit the map and upstream source files in
 * `resources/bearded-icons/`. Preparation copies them into the ignored public
 * directory, so ordinary builds and the packaged app need no network access.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledLanguagesInfo } from 'shiki'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REF = process.env.BEARDED_ICONS_REF || '8807eb4562da44eeaf0a6b24e028d67d4e461d7b'
const BASE = `https://raw.githubusercontent.com/BeardedBear/bearded-icons/${REF}`
const OUT = join(root, 'src/renderer/src/lib/file-icons.map.json')
const SOURCE_DIR = join(root, 'resources/bearded-icons')

async function fetchText(path) {
  const response = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.text()
}

const [theme, pkg, license] = await Promise.all([
  fetchText('icons.json').then(JSON.parse),
  fetchText('package.json').then(JSON.parse),
  fetchText('LICENSE')
])

// Resolve definition IDs to original asset names rather than assuming they
// match (the generic file, for example, is defined as `_file`). Upstream also
// declares some IDs without artwork: omit those associations so a filename
// can still fall through to its extension instead of displaying a broken SVG.
const unavailable = new Set()
function iconName(id) {
  const path = theme.iconDefinitions[id]?.iconPath
  const name = /^\.\/icons\/([\w-]+)\.svg$/.exec(path ?? '')?.[1]
  if (!name) unavailable.add(id)
  return name
}

function associations(raw) {
  const result = {}
  for (const [key, id] of Object.entries(raw)) {
    const icon = iconName(id)
    if (icon) result[key.toLowerCase().replace(/^\./, '')] = icon
  }
  return result
}

const names = {}
for (const [name, id] of Object.entries(theme.fileNames)) {
  const icon = iconName(id)
  if (icon) names[name.toLowerCase()] = icon
}

// VS Code supplies language detection; file rows only have a path. Translate
// language IDs and Shiki's conventional aliases into lower-priority extension
// fallbacks. Explicit Bearded associations (tests, definitions, JSX, etc.) win.
const languageExtensions = associations(theme.languageIds)
for (const language of bundledLanguagesInfo) {
  const id = theme.languageIds[language.id]
  if (!id) continue
  const icon = iconName(id)
  if (!icon) continue
  for (const alias of language.aliases ?? []) languageExtensions[alias.toLowerCase()] = icon
}

const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
const defaultIcon = iconName(theme.file)
if (!defaultIcon) throw new Error('Bearded Icons has no generic file definition')
const table = {
  source: `Bearded Icons ${pkg.version} (${REF}), GPL-3.0`,
  generated: new Date().toISOString().slice(0, 10),
  default: defaultIcon,
  names: sorted(names),
  globs: [],
  extensions: sorted({ ...languageExtensions, ...associations(theme.fileExtensions) })
}
const wanted = [...new Set([table.default, ...Object.values(table.names), ...Object.values(table.extensions)])].sort()

// Fetch before changing the snapshot. A failed download must leave the current
// map and source artwork usable. Bound concurrency for upstream requests.
const artwork = new Map()
let next = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < wanted.length) {
    const name = wanted[next++]
    artwork.set(name, await fetchText(`icons/${name}.svg`))
  }
}))

await mkdir(SOURCE_DIR, { recursive: true })
for (const name of wanted) {
  const path = join(SOURCE_DIR, `${name}.svg`)
  const svg = artwork.get(name)
  if (await readFile(path, 'utf8').catch(() => null) !== svg) await writeFile(path, svg)
}
for (const name of await readdir(SOURCE_DIR)) {
  if (name.endsWith('.svg') && !artwork.has(name.slice(0, -4))) await rm(join(SOURCE_DIR, name))
}
await writeFile(join(SOURCE_DIR, 'LICENSE.txt'), license)
await writeFile(join(SOURCE_DIR, 'NOTICE.txt'),
  `Bearded Icons by BeardedBear\nVersion: ${pkg.version}\nRevision: ${REF}\n` +
  `Source: https://github.com/BeardedBear/bearded-icons/tree/${REF}\n` +
  'Original file-type SVGs from icons/ are vendored unchanged.\n' +
  'Filename and extension associations are adapted from icons.json.\n' +
  'Distributed under GPL-3.0; see LICENSE.txt.\n')
await writeFile(OUT, JSON.stringify(table) + '\n')
console.log(`file-icons.map.json: ${Object.keys(table.names).length} names, ${Object.keys(table.extensions).length} extensions, ${wanted.length} Bearded SVGs (${unavailable.size} unavailable upstream IDs omitted)`)
