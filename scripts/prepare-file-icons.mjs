#!/usr/bin/env node
/**
 * Writes the file-type icon SVG subset the renderer loads as images, from
 * Catppuccin Icons — the app's only file-type family.
 *
 * Only icons reachable through the committed map are written. Keeping them as
 * public files lets the browser load artwork on demand instead of bundling a
 * complete Iconify collection into every renderer session.
 *
 * Output is generated and gitignored. This script runs on install, dev and
 * build; delete `src/renderer/public/file-icons` to force a rewrite.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'src/renderer/public/file-icons')
const MARKER = join(OUT_DIR, '.generated.json')
const require = createRequire(import.meta.url)

const PACKAGE = '@iconify-json/catppuccin'
const map = JSON.parse(await readFile(join(root, 'src/renderer/src/lib/file-icons.map.json'), 'utf8'))
const collection = require(`${PACKAGE}/icons.json`)
const version = require(`${PACKAGE}/package.json`).version
const wanted = [...new Set([
  map.default,
  ...Object.values(map.names),
  ...Object.values(map.extensions),
  ...(map.globs ?? []).map((glob) => glob.i)
])].sort()

const fingerprint = createHash('sha1')
  .update(`${version}\n${wanted.join('\n')}`)
  .digest('hex')
  .slice(0, 16)

function markupFor(name) {
  const icon = collection.icons[name]
  if (!icon) return null
  const width = icon.width ?? collection.width ?? 16
  const height = icon.height ?? collection.height ?? 16
  const body = Array.isArray(icon.body) ? icon.body.join('') : icon.body
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

const current = await readFile(MARKER, 'utf8').catch(() => null)
if (current && JSON.parse(current).fingerprint === fingerprint) {
  console.log(`file icons: up to date (${wanted.length} catppuccin)`)
  process.exit(0)
}

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

const fallback = markupFor(map.default)
if (!fallback) throw new Error(`default icon "${map.default}" is missing from ${PACKAGE}`)

const missing = []
await Promise.all(
  wanted.map(async (name) => {
    const markup = markupFor(name)
    if (!markup) missing.push(name)
    await writeFile(join(OUT_DIR, `${name}.svg`), markup ?? fallback)
  })
)

await writeFile(
  MARKER,
  JSON.stringify({ fingerprint, pack: { package: PACKAGE, version, icons: wanted.length } }, null, 2) + '\n'
)
console.log(
  `file icons: ${(await readdir(OUT_DIR)).length - 1} SVGs from Catppuccin Icons ${version}` +
    (missing.length ? ` (${missing.length} missing, using generic file: ${missing.join(', ')})` : '')
)
