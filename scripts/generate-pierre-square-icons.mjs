#!/usr/bin/env node
/**
 * App-owned square adaptations of the pinned Pierre file artwork. Drawings are
 * intentional straight-line constructions, including their interior marks.
 * Selected language/brand icons retain the complete native SVGs in both
 * interface styles; upstream snapshots are never rewritten.
 * Run manually after reviewing an upstream refresh, then commit these SVGs.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'resources/pierre-icons-square')
const path = (d, opacity = 1) => `<path fill="currentColor" fill-rule="evenodd" d="${d}"${opacity === 1 ? '' : ` opacity="${opacity}"`}/>`
const stroke = (d, width = 1, opacity = 1) => `<path fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="butt" stroke-linejoin="miter" d="${d}"${opacity === 1 ? '' : ` opacity="${opacity}"`}/>`
const rect = (x, y, width, height, opacity = 1) => path(`M${x} ${y}h${width}v${height}h-${width}z`, opacity)
const tile = rect(1, 1, 14, 14, .2)
const sheet = path('M2 1h6v6h6v8H2z', .4) + path('M9 1l5 5H9z')
const grid = path('M4 8h8v5H4zM5 9v1h2.5V9zm3.5 0v1H11V9zM5 11v1h2.5v-1zm3.5 0v1H11v-1z')

// Flat-ended lettering shares the same small grid as the document marks.
function letter(name, x, y, width = 3, height = 5, weight = 1) {
  const right = x + width, bottom = y + height, mid = y + height / 2
  const d = {
    A: `M${x} ${bottom}V${y}H${right}V${bottom}M${x} ${mid}H${right}`,
    B: `M${x} ${bottom}V${y}H${right}V${mid}H${x}M${right} ${mid}V${bottom}H${x}`,
    C: `M${right} ${y}H${x}V${bottom}H${right}`,
    D: `M${x} ${y}H${right}V${bottom}H${x}z`,
    F: `M${x} ${bottom}V${y}H${right}M${x} ${mid}H${right - .5}`,
    G: `M${right} ${y}H${x}V${bottom}H${right}V${mid}H${x + width / 2}`,
    J: `M${right} ${y}V${bottom}H${x}V${bottom - 1.5}`,
    O: `M${x} ${y}H${right}V${bottom}H${x}z`,
    P: `M${x} ${bottom}V${y}H${right}V${mid}H${x}`,
    R: `M${x} ${bottom}V${y}H${right}V${mid}H${x}M${x + width / 2} ${mid}L${right} ${bottom}`,
    // Free ends meet the stems' outer edges, including at thinner CSS weights.
    S: `M${right + weight / 2} ${y}H${x}V${mid}H${right}V${bottom}H${x - weight / 2}`,
    T: `M${x} ${y}H${right}M${x + width / 2} ${y}V${bottom}`,
    a: `M${x} ${y}H${right}V${bottom}H${x}V${mid}H${right}`
  }[name]
  if (!d) throw new Error(`Unknown square letter: ${name}`)
  return stroke(d, weight)
}

const drawings = {
  default: sheet,
  text: sheet + rect(5, 9, 6, 1) + rect(5, 11, 4, 1),
  table: sheet + grid,
  'pith-spreadsheet': sheet + grid,
  'pith-document': sheet + path('M4 8h1.2l.8 3.4L7.2 8h1.6l1.2 3.4.8-3.4H12l-1.4 5H9.2L8 9.5 6.8 13H5.4z'),
  'pith-pdf': sheet + path('M3 8h3v3H4v2H3zm1 1v1h1V9zM7 8h3v5H7zm1 1v3h1V9zM11 8h2.5v1H12v1h1.25v1H12v2h-1z'),
  'pith-presentation': sheet + rect(4, 10, 2, 3) + rect(7, 8, 2, 5) + rect(10, 9, 2, 4),
  'pith-audio': sheet + path('M8.5 7.5l3.5 1.25v1.5L9.5 9.4V13H6v-2h2.5z'),
  'pith-video': sheet + path('M6 8l5 2.5L6 13z'),
  javascript: tile + letter('J', 4, 5.5, 2.3, 5) + letter('S', 8.5, 5.5, 3, 5),
  typescript: tile + letter('T', 3.5, 5.5, 4, 5) + letter('S', 9, 5.5, 3, 5),
  css: tile + letter('C', 3, 6, 2, 4, .8) + letter('S', 7, 6, 2, 4, .8) + letter('S', 11, 6, 2, 4, .8),
  html: tile + stroke('M7 4l-1.5 8M10.5 4 9 12M4 6.5h8M3.5 9.5h8'),
  bash: tile + stroke('M8 5H4.5v3H8v3H4.5M6.25 3.5v9M9 11.5h3'),
  image: rect(1, 2, 14, 12, .3) + path('M1 11l3-3 3 2 4-4 4 4.5V14H1z') + rect(5, 4, 3, 3),
  database: path('M5 1h6l3 2v2l-3 2H5L2 5V3z') +
    path('M2 6.5l3 2h6l3-2v3l-3 2H5L2 9.5z') + path('M2 11l3 2h6l3-2v2l-3 2H5L2 13z'),
  svg: rect(5, 5, 10, 10) + path('M1 1h9v3H4v6H1z', .5),
  yml: stroke('M1.5 2.5h7v5h-7zM8 9.5h6.5v5H8zM5 7.5v4H8'),
  zip: path('M0 2h5l2.5 1.5H14V5H0z', .5) + path('M0 6h14v8H0zM0 9.75v1h1v-1zm1-1v1h1v-1zm1 1v1h1v-1zm1-1v1h1v-1zm1 1v1h1v-1zm1-1v1h1v-1zm1 1v1h1v-1zm1-1v1h1v-1zm1 0v2.5h3.5v-2.5zm1 1v.5h1.5v-.5z'),
  git: path('M8 1l7 7-7 7-7-7zM5.5 3.5l-1 1L7.5 7v3h-1v2h3v-2h-1V8l1.5 1.5H12V7h-2v.5L8.5 6H9V4H7v.5z'),
  graphql: stroke('M8 2.5l5 3v5l-5 3-5-3v-5zM8 2.5l5 8H3z', 1) +
    [[7, 1], [12, 4.5], [12, 9.5], [7, 13], [2, 9.5], [2, 4.5]].map(([x, y]) => rect(x, y, 2, 2)).join(''),
  c: path('M8 1l6 3.5v7L8 15l-6-3.5v-7zM11 4.5H5v7h6V10H6.5V6H11z'),
  cpp: path('M8 1l6 3.5v7L8 15l-6-3.5v-7zM9.5 4.5H5v7h4.5V10h-3V6h3zM10 7.5H9v1h1v1h1v-1h1v-1h-1v-1h-1zM12.5 7.5H12v1h.5v1h1v-1h.5v-1h-.5v-1h-1z'),
  go: letter('G', 2, 5, 5, 6, 1.4) + letter('O', 10, 5, 4, 6, 1.4),
  font: path('M0 13 3.5 2h2L9 13H7.5l-1-3H2.5l-1 3zm3-4h3L4.5 4z') + letter('a', 10.5, 5.5, 4.5, 7, 1),
  babel: path('M6 1h7v4l-3 2h1.5v3L3 15H1zM7.5 2.5l-1 3.5H9l2.5-1.5v-2zM5.5 8l-2 4.5L10 9.5V8z'),
  bootstrap: path('M2 1.5h12v5L16 8l-2 1.5v5H2v-5L0 8l2-1.5z', .2) + letter('B', 6, 5, 4, 6, 1.1),
  bun: path('M8 2l3 2 3 2 1 3-1 3-3 2H5l-3-2-1-3 1-3 3-2zM5 7v2h2V7zm4 0v2h2V7zM6.5 10v1.5h3V10zM7.5 2.5 6 5h1l1-1.5L9 5h1L8.5 2.5z'),
  eslint: path('M4 1h8l4 7-4 7H4L0 8zM3 5v6l5 3 5-3V5L8 2z') + path('M8 4.5 11 6v4l-3 1.5L5 10V6z', .5),
  mcp: stroke('M1.5 7.5 8 1h3l1 1v2M6 9l6-6h2l1 1v3l-7 7 1.5 1.5M9.5 2.5l-6 6v2l1 1h2l6-6', 1.1),
  nextjs: '<defs><linearGradient id="a" x1="4.5" y1="4" x2="14" y2="16" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
    rect(3, 2, 1.5, 9) + '<path fill="url(#a)" d="M4.5 2 15 15l-1.2 1L4.5 4z"/>' + rect(10.5, 2, 1.5, 9),
  oxc: stroke('M6.5 1.5h3v2h4l-3.5 4v2h2l2.5 2L12 13.5H4l-2.5-2L4 9.5h2v-2l-3.5-4h4z'),
  postcss: stroke('M1 1h14v14H1z', 1) + path('M8 2l6 11H2zM8 4 4 12h8zM6 6h4v4H6zM7 7v2h2V7z'),
  ruby: path('M4 2h8l3 5-7 7-7-7zM3 7h10V6H9.5L12 4l-1-1-3 3-3-3-1 1 2.5 2H3z'),
  rust: path('M6 1h4v2h2V2h2v2h-1v2h2v4h-2v2h1v2h-2v-1h-2v2H6v-2H4v1H2v-2h1v-2H1V6h2V4H2V2h2v1h2zM4 4v8h8V4z') +
    path('M5 5h5v3H8l3 3H9l-2-2v2H5zM7 6v1h2V6z'),
  // Both Sass variants stand upright and share central symmetry about (8, 8).
  sass: letter('S', 3.5, 2.5, 9, 11, 1.65),
  stylelint: path('M4 3v3.5l1.5-1L7 15 .5 6l1-1.5L0 3l2.5-2h1zm12 0-1.5 1.5 1 1.5L9 15l1.5-9.5 1.5 1V3l.5-2h1z') +
    path('M6.5 2.5V4l-2 1.5v-4zm5 3L9.5 4V2.5l2-1zM9 4H7V2.5h2z') + [5.5, 8.5, 11.5].map(y => rect(7.5, y, 1, 1)).join(''),
  tailwind: path('M4.5 6.5 6.5 4H9l3.5 2.5H14L15 5l-1.5 3H11L7.5 5.5H6zM1 10.5 3 8h2.5L9 10.5h1.5l1-1.5-1.5 3H7.5L4 9.5H2.5z'),
  vite: path('M4.5 1h8L9 6h5.5L8 15v-5H4.5L7 6H1.5z'),
  vscode: path('M11.5 1 15 3v10l-3.5 2V1z') + path('M11.5 1 1 10l1.5 1.5L11.5 5z', .75) + path('M2.5 4.5 1 6l10.5 9v-4z', .65),
  wasm: path('M1 1h5v2h4V1h5v14H1z', .2) + path('M3 8h1l.75 3L5.5 8h1l.75 3L8 8h1l-1.25 5H6.5l-.5-2.5-.5 2.5H4.25zM10 8h3v5h-1v-1.5h-1V13h-1zm1 1v1.5h1V9z')
}
drawings.npm = tile + path('M10.5 13H13V3H3v10h5V5.5h2.5z')

// These upstream drawings already consist entirely of straight lines. Keep
// their exact native proportions and opacity rather than inventing new marks.
for (const name of ['markdown', 'prettier', 'terraform', 'vue', 'webpack', 'zig']) {
  const svg = await readFile(join(root, 'resources/pierre-icons', `${name}.svg`), 'utf8')
  drawings[name] = svg.replace(/^<svg[^>]*>\s*/, '').replace(/\s*<\/svg>\s*$/, '')
}

// Explicit native exceptions: copy entire SVGs so regeneration preserves
// the selected language/brand marks, including every path and opacity.
const nativeNames = ['astro', 'biome', 'browserslist', 'claude', 'docker', 'json', 'python', 'react', 'svelte', 'svgo', 'swift']
const nativeArtwork = new Map()
for (const name of nativeNames) {
  const svg = await readFile(join(root, 'resources/pierre-icons', `${name}.svg`), 'utf8')
  nativeArtwork.set(name, svg)
  drawings[name] = svg
}

const originalNames = (await readdir(join(root, 'resources/pierre-icons'))).filter(name => name.endsWith('.svg')).map(name => name.slice(0, -4))
const additionNames = (await readdir(join(root, 'resources/pierre-icons-extensions'))).filter(name => name.endsWith('.svg')).map(name => name.slice(0, -4))
const names = [...new Set([...originalNames, ...additionNames])].sort()
if (names.length !== Object.keys(drawings).length || names.some(name => !drawings[name])) throw new Error('Square artwork must cover every Pierre source and app addition')
const files = names.map(name => {
  if (nativeArtwork.has(name)) return [name, nativeArtwork.get(name)]
  const drawing = drawings[name]
  for (const [, d] of drawing.matchAll(/\bd="([^"]+)"/g)) {
    if (/[a-z]/i.test(d.replace(/[mlhvz]/gi, ''))) throw new Error(`${name}: square drawing contains a curved command`)
  }
  return [name, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">\n  <!-- Pith square adaptation (2026). Apache-2.0; see NOTICE.txt. -->\n  ${drawing}\n</svg>\n`]
})
await mkdir(destination, { recursive: true })
for (const [name, svg] of files) await writeFile(join(destination, `${name}.svg`), svg)
await copyFile(join(root, 'resources/pierre-icons/LICENSE.txt'), join(destination, 'LICENSE.txt'))
await copyFile(join(root, 'resources/pierre-icons/NOTICE.txt'), join(destination, 'UPSTREAM-NOTICE.txt'))
await copyFile(join(root, 'resources/pierre-icons-extensions/NOTICE.txt'), join(destination, 'EXTENSIONS-NOTICE.txt'))
await writeFile(join(destination, 'NOTICE.txt'),
  'Pith square file icons — adaptations of Pierre Icons\n' +
  'Derived from @pierre/trees 1.0.0-beta.4, Pierre Computer Company, Apache-2.0.\n' +
  'Modified by Pith contributors (2026): square outer geometry, flat-ended\n' +
  'lettering, angular symbols, square nodes, document folds and media marks.\n' +
  'The upstream light/dark palette and file associations are retained.\n' +
  'Includes square adaptations of the six Pith document/media additions.\n' +
  'Six already angular upstream drawings retain their original geometry.\n' +
  `Native artwork retained without changes: ${nativeNames.join(', ')}.\n` +
  'Sass uses a new Pith angular S monogram.\n' +
  'See LICENSE.txt; upstream attribution also ships as UPSTREAM-NOTICE.txt.\n')
console.log(`Pierre square: ${files.length} SVGs, including ${nativeArtwork.size} unchanged native exceptions`)
