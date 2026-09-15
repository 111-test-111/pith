import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import type { ThinkingLevel } from '../../../shared/types'

/**
 * Subagent profiles: Markdown files with a flat YAML-ish frontmatter, body is
 * the profile's system prompt. Scopes (later shadows earlier):
 *   builtin < global `${agentDir}/agents` < project `<cwd>/.pi/agents`
 * Same-name profiles in a later scope override earlier ones wholesale.
 *
 * v1 keeps pi-web/main's direct `tools:` CSV (the worktree's tool-preset
 * indirection has no pi-app counterpart); children never load extensions, so
 * the CSV only addresses built-in + app tools.
 */

export type SubagentProfileScope = 'builtin' | 'global' | 'project'

export interface SubagentProfile {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  /** 'all' resolves against the parent's active tools at dispatch time. */
  tools: 'all' | string[]
  model?: string
  thinking?: ThinkingLevel
  maxTurns?: number
  inheritContext: boolean
  runInBackground: boolean
  enabled: boolean
  scope: SubagentProfileScope
  filePath?: string
}

/** First-run templates. Written once as ordinary editable files; deleting one
 * deletes it (the marker never resurrects them). */
const DEFAULT_PROFILES: Array<Pick<SubagentProfile, 'name' | 'displayName' | 'description' | 'systemPrompt' | 'tools'>> = [
  {
    name: 'general-purpose',
    displayName: 'General Purpose',
    description: 'Versatile assistant for research, analysis and multi-step tasks with full tool access.',
    systemPrompt: 'You are a general-purpose subagent. Complete the delegated task independently and report a concise, self-contained result. Prefer verifiable facts: read files and run commands instead of guessing. Surface blockers instead of silently working around them.',
    tools: 'all'
  },
  {
    name: 'explore',
    displayName: 'Explorer',
    description: 'Read-only codebase and documentation researcher; answers questions with citations.',
    systemPrompt: 'You are a research subagent. Explore the codebase read-only: locate code, trace calls, summarize architecture, answer questions precisely with file paths and line references. You do not modify files. Report findings densely; no preamble.',
    tools: ['read', 'grep', 'find', 'ls']
  },
  {
    name: 'implementer',
    displayName: 'Implementer',
    description: 'Focused coding subagent that edits and writes files to implement a well-specified change.',
    systemPrompt: 'You are an implementation subagent. Implement exactly the specified change: minimal diffs, matching surrounding style, no unrelated refactoring. Verify your work by reading back what you wrote and running cheap checks where possible. Report the files you changed and anything left open.',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  },
  {
    name: 'reviewer',
    displayName: 'Reviewer',
    description: 'Reviews diffs and changes for correctness, regressions and style; proposes concrete fixes.',
    systemPrompt: 'You are a code-review subagent. Review the given changes for correctness, edge cases, regressions and consistency with the surrounding code. Verify claims by reading the actual files. Report issues ordered by severity with concrete suggestions; say clearly when the change looks good.',
    tools: ['read', 'bash', 'grep', 'find', 'ls']
  }
]

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

function profileDirectories(cwd: string | null): Array<{ dir: string; scope: SubagentProfileScope }> {
  return [
    { dir: join(getAgentDir(), 'agents'), scope: 'global' },
    ...(cwd ? [{ dir: join(cwd, '.pi', 'agents'), scope: 'project' as const }] : [])
  ]
}

/** Parse a flat frontmatter block: `key: value` scalars only. Unknown keys are
 * ignored so hand-edited files with extra annotations still load. */
function parseFrontmatter(raw: string): { data: Record<string, string | boolean | number>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data: Record<string, string | boolean | number> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!entry) continue
    const [, key, value] = entry
    if (value === 'true') data[key] = true
    else if (value === 'false') data[key] = false
    else if (value !== '' && !Number.isNaN(Number(value))) data[key] = Number(value)
    else data[key] = value
  }
  return { data, body: match[2] }
}

function parseTools(value: string | undefined): 'all' | string[] | undefined {
  const raw = value?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'all' || raw === '*') return 'all'
  if (raw === 'none' || raw === '') return []
  const tools = raw.split(',').map((tool) => tool.trim()).filter(Boolean)
  return tools.length ? tools : []
}

function parseProfileFile(filePath: string, scope: SubagentProfileScope): SubagentProfile | null {
  const name = filePath.split(/[\\/]/).pop()!.replace(/\.md$/i, '')
  if (!PROFILE_NAME_PATTERN.test(name)) return null
  let parsed: { data: Record<string, string | boolean | number>; body: string }
  try {
    parsed = parseFrontmatter(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
  const { data, body } = parsed
  const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null
  if (!description) return null // A profile without a description cannot be chosen by the model.
  const tools = parseTools(typeof data.tools === 'string' ? data.tools : undefined)
  const maxTurns = typeof data.max_turns === 'number' ? data.max_turns : undefined
  const thinking = typeof data.thinking === 'string'
    ? (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(data.thinking) ? data.thinking as ThinkingLevel : undefined)
    : undefined
  return {
    name,
    displayName: typeof data.display_name === 'string' && data.display_name.trim() ? data.display_name.trim() : name,
    description,
    systemPrompt: body.trim(),
    tools: tools ?? 'all',
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined,
    thinking,
    ...(maxTurns !== undefined && Number.isInteger(maxTurns) && maxTurns >= 0 ? { maxTurns } : {}),
    inheritContext: data.inherit_context !== false,
    runInBackground: data.run_in_background === true,
    enabled: data.enabled !== false,
    scope,
    filePath
  }
}

/** All profiles visible in `cwd`, shadowed by scope; disabled ones included
 * (the tool description filters them). */
export function listSubagentProfiles(cwd: string | null): SubagentProfile[] {
  const byName = new Map<string, SubagentProfile>()
  for (const { dir, scope } of profileDirectories(cwd)) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.md'))
    } catch {
      continue
    }
    for (const file of files) {
      const profile = parseProfileFile(join(dir, file), scope)
      if (profile) byName.set(profile.name, profile)
    }
  }
  return [...byName.values()]
}

export function serializeProfile(profile: SubagentProfile): string {
  const lines = [
    `description: ${profile.description}`,
    `display_name: ${profile.displayName}`,
    `tools: ${profile.tools === 'all' ? 'all' : profile.tools.join(',') || 'none'}`,
    ...(profile.model ? [`model: ${profile.model}`] : []),
    ...(profile.thinking ? [`thinking: ${profile.thinking}`] : []),
    ...(profile.maxTurns !== undefined ? [`max_turns: ${profile.maxTurns}`] : []),
    `inherit_context: ${profile.inheritContext}`,
    `run_in_background: ${profile.runInBackground}`,
    `enabled: ${profile.enabled}`
  ]
  return `---\n${lines.join('\n')}\n---\n\n${profile.systemPrompt}\n`
}

/** Write the starter profiles once. Never overwrites same-named user files and
 * never re-adds files the user deleted (marker in app userData). */
export function ensureDefaultProfiles(stateDir: string): void {
  const marker = join(stateDir, 'subagent-defaults-v1.json')
  if (existsSync(marker)) return
  const globalDir = join(getAgentDir(), 'agents')
  mkdirSync(globalDir, { recursive: true })
  for (const template of DEFAULT_PROFILES) {
    const filePath = join(globalDir, `${template.name}.md`)
    if (existsSync(filePath)) continue
    writeFileSync(filePath, serializeProfile({
      ...template,
      inheritContext: true,
      runInBackground: false,
      enabled: true,
      scope: 'builtin'
    }), 'utf8')
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(marker, JSON.stringify({ writtenAt: new Date().toISOString() }), 'utf8')
}
