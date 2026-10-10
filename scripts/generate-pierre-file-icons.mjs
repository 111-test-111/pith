#!/usr/bin/env node
/**
 * Imports the file artwork, complete-set associations and palette from the
 * @pierre/trees release used by Codex. Networked maintenance only; install,
 * dev and build prepare assets from the checked-in snapshot offline.
 * An unpacked package directory can be supplied for an offline refresh.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '1.0.0-beta.4'
const TARBALL = `https://registry.npmjs.org/@pierre/trees/-/trees-${VERSION}.tgz`
const INTEGRITY = 'OfT1yk9ne8Te5+GB5zUY8yqE6B8BqjBHQJleH4lu8ltwNpoocZl4vXt1AzlEExpxI/pp+AFX5QG+lR3JjtTEag=='
const SOURCE_DIR = join(root, 'resources/pierre-icons')
let temporary

try {
  let packageDir = process.argv[2] && resolve(process.argv[2])
  if (!packageDir) {
    const response = await fetch(TARBALL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Pierre Icons: HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    if (createHash('sha512').update(archive).digest('base64') !== INTEGRITY) throw new Error('Pierre Icons: upstream archive integrity mismatch')
    temporary = await mkdtemp(join(tmpdir(), 'pith-pierre-icons-'))
    const tarball = join(temporary, 'trees.tgz')
    await writeFile(tarball, archive)
    execFileSync('tar', ['-xzf', tarball, '-C', temporary])
    packageDir = join(temporary, 'package')
  }
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  if (pkg.name !== '@pierre/trees' || pkg.version !== VERSION) throw new Error(`Expected @pierre/trees ${VERSION}`)
  const source = await readFile(join(packageDir, 'dist/builtInIcons.js'), 'utf8')
  const css = JSON.parse(await readFile(join(packageDir, 'dist/style.js.map'), 'utf8')).sourcesContent[0]

  // The pinned module declares flat string dictionaries. Reject format drift
  // instead of evaluating downloaded JavaScript or silently losing rules.
  function dictionary(name) {
    const contents = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(source)?.[1]
    if (!contents) throw new Error(`Pierre Icons: missing ${name}`)
    const result = {}
    for (const line of contents.trim().split('\n')) {
      const match = /^\s*(?:"([^"]+)"|(\w+)):\s*"([^"]+)",?\s*$/.exec(line)
      if (!match) throw new Error(`Pierre Icons: unsupported ${name} entry ${line}`)
      result[match[1] ?? match[2]] = match[3]
    }
    return result
  }
  const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const map = {
    source: `Pierre Icons (@pierre/trees ${VERSION}), Apache-2.0`,
    default: 'default',
    names: sorted(dictionary('BUILT_IN_FILE_NAME_TOKENS')),
    extensions: sorted({ ...dictionary('BUILT_IN_FILE_EXTENSION_TOKENS'), ...dictionary('COMPLETE_EXTENSION_OVERRIDES') })
  }
  const artwork = new Map()
  for (const [, token, viewport, contents] of source.matchAll(/<symbol id="file-tree-builtin-([\w-]+)" (viewBox="[^"]+")>([\s\S]*?)<\/symbol>/g)) {
    artwork.set(token, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ${viewport}>${contents}</svg>\n`)
  }
  const palette = Object.fromEntries([...css.matchAll(/--trees-icon-([\w-]+):\s*light-dark\((#[\da-f]+),\s*(#[\da-f]+)\);/g)].map(([, name, light, dark]) => [name, { light, dark }]))
  const colors = Object.fromEntries([...css.matchAll(/--trees-file-icon-color-([\w-]+):\s*var\([^;]*?var\(--trees-icon-([\w-]+)\)\s*\);/g)].map(([, token, color]) => [token, color]))
  if (!palette.gray || !colors.typescript || !colors.react) throw new Error('Pierre Icons: missing upstream color definitions')
  for (const token of new Set([map.default, ...Object.values(map.names), ...Object.values(map.extensions)])) {
    if (!artwork.has(token)) throw new Error(`Pierre Icons: missing ${token} artwork`)
    colors[token] ??= 'gray'
    if (!palette[colors[token]]) throw new Error(`Pierre Icons: missing ${token} palette color`)
  }

  // Finish all validation before replacing the checked-in source snapshot.
  await mkdir(SOURCE_DIR, { recursive: true })
  for (const [token, svg] of artwork) await writeFile(join(SOURCE_DIR, `${token}.svg`), svg)
  for (const name of await readdir(SOURCE_DIR)) {
    if (name.endsWith('.svg') && !artwork.has(name.slice(0, -4))) await rm(join(SOURCE_DIR, name))
  }
  await copyFile(join(packageDir, 'LICENSE.md'), join(SOURCE_DIR, 'LICENSE.txt'))
  const notice = await readFile(join(packageDir, 'NOTICE.md'), 'utf8')
  await writeFile(join(SOURCE_DIR, 'NOTICE.txt'),
    `Pierre file-type icons — Pierre Computer Company\nSource: @pierre/trees ${VERSION}\nArchive: ${TARBALL}\n` +
    'SVG paths, viewports and opacity are retained from dist/builtInIcons.js.\n' +
    'Symbols are wrapped as standalone SVGs; complete-set associations and\n' +
    'light/dark colors are adapted from builtInIcons.js and src/style.css.\n' +
    'Distributed under Apache-2.0; see LICENSE.txt.\n\n' + notice)
  await writeFile(join(SOURCE_DIR, 'palette.json'), JSON.stringify({ source: map.source, palette, colors: sorted(colors) }, null, 2) + '\n')
  await writeFile(join(root, 'src/renderer/src/lib/pierre-file-icons.map.json'), JSON.stringify(map, null, 2) + '\n')
  console.log(`Pierre Icons: ${artwork.size} SVGs, ${Object.keys(map.names).length} names, ${Object.keys(map.extensions).length} extensions`)
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
