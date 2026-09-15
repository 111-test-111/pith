import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { SUBAGENT_READ_ONLY_TOOLS, type ThinkingLevel } from '../../../shared/types.ts'

/**
 * Subagent profiles: Markdown files with a flat YAML-ish frontmatter, body is
 * the profile's system prompt. Scopes (later shadows earlier):
 *   builtin < global `${agentDir}/agents` < project `<cwd>/.pi/agents`
 * Same-name profiles in a later scope override earlier ones wholesale.
 *
 * Tool sets come from one of three sources, in order: an explicit `tools:` CSV,
 * a `tool_preset` resolved through the preset file pi-web shares from the same
 * agent dir (`pi-web-tool-presets.json`), or — when neither resolves — the
 * conservative read-only default. An unknown restriction must never silently
 * become full access: the `piweb-agent-*` profiles on a machine that also has
 * pi-web installed declare their tools only as a preset, and defaulting those
 * to `all` made a profile named `explore` perfectly able to write files.
 */

export type SubagentProfileScope = 'builtin' | 'global' | 'project'

export interface SubagentProfile {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  /** 'all' resolves against the parent's active tools at dispatch time. */
  tools: 'all' | string[]
  /** Where `tools` came from — an unresolved preset is flagged so the tool
   * description can say why the set is only read-only. */
  toolsSource?: 'explicit' | 'preset' | 'unresolved-preset' | 'default'
  /** The `tool_preset` id when the profile declared one (diagnostics). */
  toolPreset?: string
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
/** Marker written NEXT TO the starter files it guards (the legacy one lives in
 * app userData and cannot see a drifted agent directory). */
const DIR_MARKER = '.pi-app-defaults-v1.json'

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

/** Frontmatter scalars lose their quotes, so `description: 42` parses as the
 * NUMBER 42 — which used to silently drop an otherwise usable profile. Text
 * fields therefore accept numeric values as their text form. */
function asText(value: string | boolean | number | undefined): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** pi-web's shared preset file, read from the same agent dir: a list of
 * `{ id, name, selection: { mode: 'allow', names } }`. Only an `allow` list can
 * be expressed as this app's tool ceiling; anything else stays unresolved and
 * therefore read-only. */
function readPresetTools(): Map<string, string[]> {
  const presets = new Map<string, string[]>()
  let raw: string
  try { raw = readFileSync(join(getAgentDir(), 'pi-web-tool-presets.json'), 'utf8') } catch { return presets }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return presets }
  if (!Array.isArray(parsed)) return presets
  for (const entry of parsed as Array<{ id?: unknown; selection?: { mode?: unknown; names?: unknown } }>) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    const names = entry?.selection?.names
    if (!id || entry?.selection?.mode !== 'allow' || !Array.isArray(names)) continue
    const tools = names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    if (tools.length) presets.set(id, tools)
  }
  return presets
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
  const description = asText(data.description) || null
  if (!description) return null // A profile without a description cannot be chosen by the model.
  const explicitTools = parseTools(typeof data.tools === 'string' ? data.tools : undefined)
  const toolPreset = asText(data.tool_preset) || undefined
  const presetTools = toolPreset ? readPresetTools().get(toolPreset) : undefined
  let tools: 'all' | string[]
  let toolsSource: NonNullable<SubagentProfile['toolsSource']>
  if (explicitTools !== undefined) { tools = explicitTools; toolsSource = 'explicit' }
  else if (presetTools) { tools = presetTools; toolsSource = 'preset' }
  else if (toolPreset) {
    // A preset this app cannot resolve (unknown id, a `deny` selection, a
    // missing preset file) must not silently grant write/bash.
    console.warn(`[subagents] profile "${name}" declares tool_preset "${toolPreset}", which cannot be resolved; falling back to read-only tools`)
    tools = [...SUBAGENT_READ_ONLY_TOOLS]; toolsSource = 'unresolved-preset'
  } else {
    // No explicit tool set at all: least privilege, and the tool description
    // says so. Profiles that want more must say so in frontmatter.
    tools = [...SUBAGENT_READ_ONLY_TOOLS]; toolsSource = 'default'
  }
  const maxTurns = typeof data.max_turns === 'number' ? data.max_turns : undefined
  const thinking = typeof data.thinking === 'string'
    ? (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(data.thinking) ? data.thinking as ThinkingLevel : undefined)
    : undefined
  return {
    name,
    displayName: asText(data.display_name) || name,
    description,
    systemPrompt: body.trim(),
    tools,
    toolsSource,
    ...(toolPreset ? { toolPreset } : {}),
    model: asText(data.model) || undefined,
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
 * never re-adds files the user deleted (marker beside the files, plus the
 * legacy userData marker). A marker WITHOUT its files — a fresh HOME, a moved
 * agent dir, files removed outside the app — heals instead: the old
 * marker-only guard returned early and left the app with zero profiles, so the
 * `agent` tool stayed enabled while every dispatch failed. */
export function ensureDefaultProfiles(stateDir: string): void {
  const globalDir = join(getAgentDir(), 'agents')
  const legacyMarker = join(stateDir, 'subagent-defaults-v1.json')
  const marker = join(globalDir, DIR_MARKER)
  const profileFiles = (): string[] => {
    try { return readdirSync(globalDir).filter((file) => file.toLowerCase().endsWith('.md')) } catch { return [] }
  }
  const writeMarkers = (): void => {
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ writtenAt: new Date().toISOString() }), 'utf8')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(legacyMarker, JSON.stringify({ writtenAt: new Date().toISOString() }), 'utf8')
  }
  const existing = profileFiles()
  if (existing.length === 0) {
    // A marker BESIDE an empty directory is a deliberate removal (the user
    // deleted every profile); a legacy marker alone means the files and the
    // marker drifted apart, which must heal.
    if (existsSync(marker)) return
  } else if (existsSync(marker) || existsSync(legacyMarker)) {
    // Keep the marker beside the files for the next start's decision.
    if (!existsSync(marker)) writeMarkers()
    return
  }
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
  writeMarkers()
}
