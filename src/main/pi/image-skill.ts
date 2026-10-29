import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { setDisableModelInvocation } from './skill-frontmatter'

/** Keep the working copy editable by the existing Settings → Skills actions.
 * Packaged resources are only the upstream source, never the toggle target. */
const FILES = ['SKILL.md', 'references/models.md', 'references/parameters.md'] as const
const HASH_FILE = '.bundled-hashes.json'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function publish(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, { flag: 'wx' })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** Install/update only unmodified app-owned content. Local edits and the
 * model-invocation preference survive restart and upstream skill updates. */
export function installImageSkill(sourceDirectory: string, directory: string): string {
  const manifestPath = join(directory, HASH_FILE)
  let previous: Record<string, string> = {}
  try {
    const parsed = JSON.parse(readOptional(manifestPath) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed
  } catch { /* A lost baseline must never authorize replacing a local edit. */ }
  const next: Record<string, string> = {}
  for (const relative of FILES) {
    const source = readFileSync(join(sourceDirectory, relative), 'utf8')
    const path = join(directory, relative)
    const current = readOptional(path)
    next[relative] = hash(source)
    if (current === undefined) {
      publish(path, source)
      continue
    }
    let comparable = current
    let disabled = false
    if (relative === 'SKILL.md') {
      try {
        comparable = setDisableModelInvocation(current, false)
        disabled = parseFrontmatter(current).frontmatter['disable-model-invocation'] === true
      } catch { continue } // Keep malformed user edits visible to loader diagnostics.
    }
    if (hash(comparable) !== previous[relative] && comparable !== source) continue
    const updated = disabled ? setDisableModelInvocation(source, true) : source
    if (updated !== current) publish(path, updated)
  }
  const manifest = `${JSON.stringify(next, null, 2)}\n`
  if (manifest !== readOptional(manifestPath)) publish(manifestPath, manifest)
  return join(directory, 'SKILL.md')
}
