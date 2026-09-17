#!/usr/bin/env node
/**
 * Regenerates `src/renderer/src/lib/file-icons.map.json` — the flat
 * filename/extension → icon lookup the renderer resolves with.
 *
 * The table is derived from vscode-icons' own manifest, because that is the
 * only place the icon-to-file associations exist: the icon artwork package
 * (`@iconify-json/vscode-icons`) ships drawings and names, no associations.
 * Icon ids are stored as their Iconify name (`docker` → `file-type-docker`),
 * which is what `scripts/prepare-file-icons.mjs` writes out as SVG.
 *
 * This script needs network access; it is NOT part of install/dev/build. Run it
 * by hand (`npm run icons:file-types`) when you want to pick up upstream
 * additions, then commit the regenerated JSON — including `source`, which
 * records the exact revision the table came from.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const RAW = 'https://raw.githubusercontent.com/vscode-icons/vscode-icons'
const REF = process.env.VSI_REF || 'master'
const OUT = resolve('src/renderer/src/lib/file-icons.map.json')

/** Icon ids whose Iconify name does not follow the `file-type-<id>` convention. */
const ICONIFY_ALIASES = { pdf: 'file-type-pdf2' }

/**
 * Contested language keys whose winner the ranking below gets wrong. `.yml`
 * belongs to the `yaml` language; the `manifest-yaml` language that also claims
 * it is for Cloud Foundry manifests, which the manifest already maps by name.
 */
const LANGUAGE_KEY_OVERRIDES = { yml: 'file-type-yaml' }

const iconifyName = (id) => ICONIFY_ALIASES[id] || `file-type-${id.toLowerCase().replace(/_/g, '-')}`

/** The manifest files are TypeScript modules of plain data; strip the few type
 * constructs and language references so they can be evaluated as data. */
function asData(source, exportName) {
  const body = source
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
    .replace(/:\s*I[A-Za-z]+Collection/g, '')
    .replace(/\bsatisfies\s+[A-Za-z][\w.<>,\s]*;/g, ';')
    .replace(/FileFormat\.(\w+)/g, (_, value) => JSON.stringify(value))
    .replace(/languages\.([A-Za-z0-9_$]+)/g, (_, value) => JSON.stringify(value))
  return new Function(`${body}\nreturn ${exportName}`)()
}

const cleanExtension = (value) => value.replace(/^\./, '').toLowerCase()

async function fetchText(path) {
  const response = await fetch(`${RAW}/${REF}/${path}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return { text: await response.text(), revision: response.headers.get('etag')?.slice(1, 9) || REF }
}

const manifest = await fetchText('src/iconsManifest/supportedExtensions.ts')
const languageManifest = await fetchText('src/iconsManifest/languages.ts')
const { supported } = asData(manifest.text, 'extensions')
const languages = asData(languageManifest.text, 'languages')

/** Exact file names (lower-cased; dotfiles keep their leading dot). */
const names = {}
/** Extension → icon, explicit manifest entries. */
const extensions = {}
/** Name glob × extension list, e.g. `vite.config` × `[js,ts]`. */
const globs = []
/** Extensions and names reached through a language id, i.e. `python` → `py` and
 * `dockerfile` → `Dockerfile`. Kept apart from the explicit tables because the
 * manifest declares them at a lower priority. */
const languageExtensions = {}
const languageNames = {}

/**
 * Language-declared keys need their own tie-break: several languages claim the
 * same key, and VS Code picks by the editor's language id, which we cannot know.
 * Two rules stand in for it: a language named after the key wins outright
 * (`html` beats `django` for `html`), and otherwise the language claiming the
 * fewest keys wins (`javascriptreact` beats `javascript` for `jsx`, `postcss`
 * beats `css` for `pcss`). Remaining ties keep manifest order.
 */
const claim = (table, key, icon, rank) => {
  const current = table[key]
  if (!current || rank < current.rank) table[key] = { icon, rank }
}
const rank = (key, language, values) => {
  const named = language === key || (Array.isArray(language) ? language.includes(key) : false) ? 0 : 1
  return named * 1e6 + values.length * 100
}

for (const entry of supported) {
  if (entry.disabled) continue
  const icon = iconifyName(entry.icon)
  // First entry wins a contested key: vscode-icons' own generated manifest
  // resolves `ods` to `excel` and `otf` to `font`, i.e. the earlier entry, even
  // though later ones claim the same extension.
  if (entry.filename) {
    for (const name of entry.extensions || []) if (!(name.toLowerCase() in names)) names[name.toLowerCase()] = icon
  } else {
    for (const extension of entry.extensions || []) {
      const key = cleanExtension(extension)
      if (!(key in extensions)) extensions[key] = icon
    }
  }
  if (entry.filenamesGlob?.length && entry.extensionsGlob?.length) {
    globs.push({
      n: entry.filenamesGlob.map((name) => name.toLowerCase()),
      e: entry.extensionsGlob.map(cleanExtension),
      i: icon
    })
  }
  for (const id of entry.languages || []) {
    const language = languages[id]
    if (!language) continue
    // `knownExtensions` and `knownFilenames` are separate on purpose: the former
    // holds extensions, the latter whole names (`Dockerfile`, `docker-compose.yml`).
    for (const extension of language.knownExtensions || []) {
      const key = cleanExtension(extension)
      claim(languageExtensions, key, icon, rank(key, language.ids, language.knownExtensions))
    }
    for (const name of language.knownFilenames || []) {
      const key = name.toLowerCase()
      claim(languageNames, key, icon, rank(key, language.ids, language.knownFilenames))
    }
  }
}

for (const [key, icon] of Object.entries(LANGUAGE_KEY_OVERRIDES)) languageExtensions[key] = { icon, rank: -1 }

// An explicit manifest entry always outranks a language-derived one.
const merge = (explicit, derived) => {
  const merged = Object.fromEntries(Object.entries(derived).map(([key, value]) => [key, value.icon]))
  return { ...merged, ...explicit }
}

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
const table = {
  // Provenance for the generated table below.
  source: `vscode-icons ${REF} (${manifest.revision}/${languageManifest.revision}), MIT`,
  generated: new Date().toISOString().slice(0, 10),
  default: 'default-file',
  names: sorted(merge(names, languageNames)),
  globs: globs.map(({ n, e, i }) => ({ n, e, i })),
  extensions: sorted(merge(extensions, languageExtensions))
}

await writeFile(OUT, JSON.stringify(table, null, 0) + '\n')
const size = JSON.stringify(table).length
console.log(
  `file-icons.map.json: ${Object.keys(table.names).length} names, ` +
    `${Object.keys(table.extensions).length} extensions, ${table.globs.length} globs (${(size / 1024).toFixed(0)} KiB)`
)
