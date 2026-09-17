#!/usr/bin/env node
/**
 * Writes the file-type icon SVGs the renderer loads as images.
 *
 * Artwork comes from `@iconify-json/vscode-icons` (the vscode-icons drawings as
 * Iconify data). Only the icons `file-icons.map.json` can actually resolve to
 * are written — the full set is ~1600 icons / 3.7 MB of path data, and bundling
 * it would cost every session; written as files, an icon loads when a row that
 * uses it is painted, and nothing sits in the renderer bundle.
 *
 * Output goes to the renderer's public directory (`src/renderer/public`) and is
 * generated, not committed — `npm run prepare:file-icons` runs on install, dev
 * and build. Delete the directory to force a rewrite.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAP_FILE = join(root, 'src/renderer/src/lib/file-icons.map.json')
const OUT_DIR = join(root, 'src/renderer/public/file-icons')
const MARKER = join(OUT_DIR, '.generated.json')

const require = createRequire(import.meta.url)
const map = JSON.parse(await readFile(MAP_FILE, 'utf8'))
const collection = require('@iconify-json/vscode-icons/icons.json')
const packageVersion = require('@iconify-json/vscode-icons/package.json').version

const wanted = [...new Set([map.default, ...Object.values(map.names), ...Object.values(map.extensions), ...map.globs.map((glob) => glob.i)])].sort()
const fingerprint = createHash('sha1').update(`${packageVersion}\n${wanted.join('\n')}`).digest('hex').slice(0, 16)

/** The renderer only ever asks for a name the map produced, so an icon the
 * package does not carry falls back to the generic file drawing rather than
 * leaving a broken image. */
const markupFor = (name) => {
  const icon = collection.icons[name]
  if (!icon) return null
  const width = icon.width ?? collection.width
  const height = icon.height ?? collection.height
  const body = Array.isArray(icon.body) ? icon.body.join('') : icon.body
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

const current = await readFile(MARKER, 'utf8').catch(() => null)
if (current && JSON.parse(current).fingerprint === fingerprint) {
  console.log(`file icons: up to date (${wanted.length} icons)`)
  process.exit(0)
}

const fallback = markupFor(map.default)
if (!fallback) throw new Error(`default icon "${map.default}" is missing from @iconify-json/vscode-icons`)

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

const missing = []
await Promise.all(
  wanted.map(async (name) => {
    const markup = markupFor(name)
    if (!markup) missing.push(name)
    await writeFile(join(OUT_DIR, `${name}.svg`), markup ?? fallback)
  })
)
await writeFile(MARKER, JSON.stringify({ fingerprint, package: packageVersion, icons: wanted.length }, null, 2) + '\n')

const written = (await readdir(OUT_DIR)).length - 1
console.log(
  `file icons: ${written} SVGs from vscode-icons ${packageVersion}` +
    (missing.length ? ` (${missing.length} without artwork, using the generic file icon: ${missing.join(', ')})` : '')
)
