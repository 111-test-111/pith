#!/usr/bin/env node
/**
 * Prepares native/square Pierre Icons, plus the retained Bearded snapshot.
 * Upstream artwork/licenses live in resources/bearded-icons/ and pierre-icons/;
 * app additions/overrides and square drawings live outside refreshable snapshots.
 * only icons reachable through the committed maps are copied into public assets.
 *
 * Output is generated and gitignored. Install, dev and build run this offline;
 * delete src/renderer/public/file-icons to force a rewrite.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = join(root, 'resources/bearded-icons')
const OUT_DIR = join(root, 'src/renderer/public/file-icons')
const MARKER = join(OUT_DIR, '.generated.json')
const map = JSON.parse(await readFile(join(root, 'src/renderer/src/lib/file-icons.map.json'), 'utf8'))
const pierreMap = JSON.parse(await readFile(join(root, 'src/renderer/src/lib/pierre-file-icons.map.json'), 'utf8'))
const pierreExtensions = JSON.parse(await readFile(join(root, 'src/renderer/src/lib/pierre-file-icons.extensions.json'), 'utf8'))
const pierrePalette = JSON.parse(await readFile(join(root, 'resources/pierre-icons/palette.json'), 'utf8'))
const reachable = icons => [...new Set([
  icons.default,
  ...Object.values(icons.names),
  ...Object.values(icons.extensions),
  ...(icons.globs ?? []).map(glob => glob.i)
])].sort()
const wanted = reachable(map)
const pierreWanted = reachable({
  ...pierreMap,
  extensions: { ...pierreMap.extensions, ...pierreExtensions.extensions }
})

function markupFor(svg, name) {
  // Several original 16px SVGs omit viewBox. Supply the intrinsic viewport so
  // the whole drawing scales when an attachment card renders it at 18px.
  const tag = /<svg\b[^>]*>/.exec(svg)?.[0]
  if (!tag) throw new Error(`${name}: no SVG root`)
  if (/\bviewBox=/.test(tag)) return svg
  const width = /\bwidth="([\d.]+)(?:px)?"/.exec(tag)?.[1]
  const height = /\bheight="([\d.]+)(?:px)?"/.exec(tag)?.[1]
  if (!(Number(width) > 0 && Number(height) > 0)) throw new Error(`${name}: no SVG viewport`)
  return svg.replace(tag, tag.replace(/>$/, ` viewBox="0 0 ${width} ${height}">`))
}

// Validate every source before replacing output: a missing asset is a broken
// snapshot, not a reason to silently disguise the file with another drawing.
const files = await Promise.all(wanted.map(async name => {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid file icon name: ${name}`)
  const svg = await readFile(join(SOURCE_DIR, `${name}.svg`), 'utf8')
  return [`${name}.svg`, markupFor(svg, name)]
}))
for (const name of ['LICENSE.txt', 'NOTICE.txt']) files.push([name, await readFile(join(SOURCE_DIR, name), 'utf8')])
const pierreFiles = await Promise.all(pierreWanted.flatMap(name => ['pierre', 'pierre-square'].map(async family => {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid Pierre file icon name: ${name}`)
  const customArtwork = Object.hasOwn(pierreExtensions.colors, name)
  const sourceDir = family === 'pierre-square' ? 'pierre-icons-square' : customArtwork ? 'pierre-icons-extensions' : 'pierre-icons'
  const svg = markupFor(await readFile(join(root, 'resources', sourceDir, `${name}.svg`), 'utf8'), name)
  const color = pierrePalette.palette[customArtwork ? pierreExtensions.colors[name] : pierrePalette.colors[name]]
  if (!color || !/^#[\da-f]{6}$/i.test(color.light) || !/^#[\da-f]{6}$/i.test(color.dark)) throw new Error(`${name}: missing Pierre colors`)
  // Embedded SVG media queries follow the embedding element's color-scheme,
  // so the existing light/dark/system theme works without an extra subscription.
  const themed = svg.replace(/<svg\b[^>]*>/, tag =>
    tag.replace(/>$/, ' fill="currentColor">') +
    `\n  <style>:root{color:${color.light}}@media(prefers-color-scheme:dark){:root{color:${color.dark}}}</style>`)
  return [`${family}/${name}.svg`, themed]
})))
files.push(...pierreFiles)
for (const name of ['LICENSE.txt', 'NOTICE.txt']) files.push([`pierre/${name}`, await readFile(join(root, 'resources/pierre-icons', name), 'utf8')])
files.push(['pierre/EXTENSIONS-NOTICE.txt', await readFile(join(root, 'resources/pierre-icons-extensions/NOTICE.txt'), 'utf8')])
for (const name of ['LICENSE.txt', 'NOTICE.txt', 'UPSTREAM-NOTICE.txt', 'EXTENSIONS-NOTICE.txt']) {
  files.push([`pierre-square/${name}`, await readFile(join(root, 'resources/pierre-icons-square', name), 'utf8')])
}
const hash = createHash('sha256').update(map.source).update(pierreMap.source).update(pierreExtensions.source)
for (const [name, contents] of files) hash.update(`\0${name}\0${contents}`)
const fingerprint = hash.digest('hex')
const current = await readFile(MARKER, 'utf8').then(JSON.parse).catch(() => null)
if (current?.fingerprint === fingerprint) {
  console.log(`file icons: up to date (${wanted.length} Bearded, ${pierreWanted.length} Pierre per style)`)
  process.exit(0)
}

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
await mkdir(join(OUT_DIR, 'pierre'), { recursive: true })
await mkdir(join(OUT_DIR, 'pierre-square'), { recursive: true })
await Promise.all(files.map(([name, contents]) => writeFile(join(OUT_DIR, name), contents)))
await writeFile(MARKER, JSON.stringify({ fingerprint, source: [map.source, pierreMap.source, pierreExtensions.source], icons: wanted.length + 2 * pierreWanted.length }, null, 2) + '\n')
console.log(`file icons: ${wanted.length} retained Bearded SVGs, ${pierreWanted.length} Pierre SVGs per style`)
