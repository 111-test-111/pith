/** Offline skill discovery, reversible adaptation and executable native examples. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { loadSkillsFromDir, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent'
import { adaptTypesafeSkill } from './adapt-typesafe-skill.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-jev-skill-'))
try {
  const skills = join(temporary, 'skills'), target = join(skills, 'typesafe-ai')
  await mkdir(target, { recursive: true })
  // Pass an installed skill to validate its actual upstream body without editing it.
  const installed = process.argv[2] && resolve(process.argv[2])
  const original = installed
    ? await readFile(join(installed, '.pi-app-original.md'), 'utf8')
    : '---\nname: typesafe-ai\nlicense: MIT\ndescription: >\n  Build TypeSafe workflows.\n---\n\n# Build with TypeSafe\n\nOriginal SDK workflow.\n'
  await writeFile(join(target, 'SKILL.md'), original)
  await adaptTypesafeSkill(target)
  const once = await readFile(join(target, 'SKILL.md'), 'utf8')
  await adaptTypesafeSkill(target)
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), once, 'reapplying does not accumulate edits')
  assert.equal(await readFile(join(target, '.pi-app-original.md'), 'utf8'), original, 'upstream body remains recoverable')
  const note = '\nLocal project note to preserve.\n'
  await writeFile(join(target, 'SKILL.md'), once + note)
  await adaptTypesafeSkill(target)
  assert((await readFile(join(target, 'SKILL.md'), 'utf8')).endsWith(note), 'unrelated local edits survive')
  const loaded = loadSkillsFromDir({ dir: skills, source: 'user' })
  assert.equal(loaded.skills.length, 1, 'reference and backup do not become duplicate skills')
  assert.deepEqual(loaded.diagnostics, [])
  assert.equal(loaded.skills[0].name, 'typesafe-ai')
  assert.equal(loaded.skills[0].disableModelInvocation, false)
  assert(formatSkillsForPrompt(loaded.skills).includes(join(target, 'SKILL.md')), 'Pi can discover the skill by path')
  assert(!formatSkillsForPrompt([{ ...loaded.skills[0], disableModelInvocation: true }]).includes('typesafe-ai'), 'normal skill visibility control is respected')
  if (installed) {
    const actual = loadSkillsFromDir({ dir: installed, source: 'user' })
    assert.equal(actual.skills.length, 1); assert.deepEqual(actual.diagnostics, [])
    assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), once, 'installed adaptation matches the maintained bridge')
    assert.equal(await readFile(join(installed, 'references/pi-app.md'), 'utf8'), await readFile(join(repo, 'docs/jev-tool-reference.md'), 'utf8'))
  }
  const module = join(temporary, 'jev.mjs')
  await build({ entryPoints: [join(repo, 'src/main/pi/jev/protocol.ts')], outfile: module, bundle: true, platform: 'node', format: 'esm' })
  const { parseJevRequest } = await import(pathToFileURL(module).href)
  const reference = await readFile(join(target, 'references/pi-app.md'), 'utf8')
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))
  assert(examples.length >= 2)
  for (const example of examples) {
    const parsed = parseJevRequest(example, { mode: 'tools', choice: true, score: true, noul: true })
    assert.deepEqual(parsed, example, 'documented calls match the actual native schema')
    assert.doesNotThrow(() => JSON.parse(parsed.state), 'structured evidence is correctly JSON-encoded as a string')
  }
  console.log('PASS: Pi skill discovery, idempotent adaptation, preserved upstream/local edits, visibility and native examples')
} finally { await rm(temporary, { recursive: true, force: true }) }
