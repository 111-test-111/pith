#!/usr/bin/env node
/**
 * beui-add — fetch beUI registry components into the renderer tree.
 *
 *   node scripts/beui-add.mjs number animated-badge
 *   node scripts/beui-add.mjs --check number      # report only, write nothing
 *
 * Why a script instead of the shadcn CLI: this repo vendors beUI by hand
 * (AGENTS.md "Local patches to vendored beUI"). The CLI happily overwrites
 * files that carry `// local patch (pi-app):` edits, so this installer is
 * deliberately additive — a target that already exists is reported and left
 * untouched, never rewritten.
 *
 * Registry payload: https://beui.dev/r/<slug> → { slug, dependencies, files[] }.
 * Files with type "preview" are skipped: they land under components/previews/
 * and are never imported by the app.
 *
 * Icons: registry lucide-react imports are routed through the app's semantic
 * adapter (Hugeicons Stroke Rounded). New vendored files carry a local-patch
 * comment, and existing files still remain untouched.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'renderer', 'src')
const REGISTRY = 'https://beui.dev/r'

/** Dependencies the app already provides (or that are not npm packages). */
const PROVIDED_DEPS = new Set(['react', 'react-dom', 'clsx', 'tailwind-merge', 'lucide-react'])

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const slugs = args.filter((a) => !a.startsWith('--'))

if (slugs.length === 0) {
  console.error('usage: node scripts/beui-add.mjs [--check] <slug> [slug...]')
  process.exit(2)
}

const exists = (p) => access(p).then(() => true, () => false)

async function fetchComponent(slug) {
  const res = await fetch(`${REGISTRY}/${slug}`)
  if (!res.ok) throw new Error(`${slug}: registry responded ${res.status}`)
  return res.json()
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const installed = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))

let written = 0
let skipped = 0
const missingDeps = new Set()

for (const slug of slugs) {
  let payload
  try {
    payload = await fetchComponent(slug)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 1
    continue
  }

  console.log(`\n▸ ${slug} — ${payload.name ?? slug}`)
  for (const dep of payload.dependencies ?? []) {
    if (!PROVIDED_DEPS.has(dep) && !installed.has(dep)) missingDeps.add(dep)
  }

  for (const file of payload.files ?? []) {
    if (file.type === 'preview') {
      console.log(`  · skip preview  ${file.path}`)
      continue
    }
    const target = join(SRC, file.path)
    const original = file.content ?? ''
    const usesRegistryIcons = /from\s*['"]lucide-react['"]/.test(original)
    const content = usesRegistryIcons
      ? '// local patch (pi-app): use the shared Hugeicons icon adapter.\n' + original
        .replace(/(from\s*)['"]lucide-react['"]/g, '$1"@/lib/icons"')
        .replace(/\bLucideIcon\b/g, 'IconComponent')
        .replace(/\bLucideProps\b/g, 'IconProps')
      : original

    // The one thing that must never happen: clobbering a locally patched
    // vendored file (or an app-owned helper that happens to share a path).
    if (await exists(target)) {
      const current = await readFile(target, 'utf8')
      const same = current === content
      const patched = current.includes('local patch (pi-app)')
      console.log(
        `  · keep existing ${file.path}${same ? ' (identical)' : patched ? ' — has a pi-app patch' : ' — DIFFERS, review manually'}`,
      )
      skipped += 1
      continue
    }

    if (checkOnly) {
      console.log(`  · would write   ${file.path}`)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    console.log(`  + ${file.path}`)
    written += 1
  }
}

console.log(`\n${checkOnly ? 'check' : 'done'}: ${written} written, ${skipped} kept`)
if (missingDeps.size > 0) {
  console.log(`\n⚑ npm dependencies not in package.json: ${[...missingDeps].join(', ')}`)
}
