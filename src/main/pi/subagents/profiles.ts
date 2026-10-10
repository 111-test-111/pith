import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { SUBAGENT_PROFILE_NAME_PATTERN, SUBAGENT_READ_ONLY_TOOLS, type SubagentProfileCreatePayload, type SubagentProfileDefaultsPayload, type SubagentProfileDTO, type ThinkingLevel } from '../../../shared/types.ts'

/**
 * Subagent profiles: Markdown files with a flat YAML-ish frontmatter, body is
 * the profile's system prompt. Every profile is an ordinary editable file —
 * there is no builtin/custom split; the four starters are just files seeded
 * once on first run. Scopes (later shadows earlier):
 *   global `${agentDir}/agents` < project `<cwd>/.pi/agents`
 * Same-name profiles in a later scope override earlier ones wholesale.
 *
 * Tool sets come from one of three sources, in order: an explicit `tools:` CSV
 * (what Settings → Subagents edits), a `tool_preset` resolved through the
 * preset file pi-web shares from the same agent dir
 * (`pi-web-tool-presets.json`), or — when neither resolves — the conservative
 * read-only default. An unknown restriction must never silently become full
 * access: the `piweb-agent-*` profiles on a machine that also has pi-web
 * installed declare their tools only as a preset, and defaulting those to
 * `all` made a profile named `explore` perfectly able to write files.
 */

export type SubagentProfileScope = 'global' | 'project'

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
  /** Always set for a parsed/listed profile — every profile IS a file. */
  filePath: string
}

/** First-run templates. Written once as ordinary editable files — after the
 * first run they are indistinguishable from user files, and deleting one
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

const PROFILE_NAME_PATTERN = SUBAGENT_PROFILE_NAME_PATTERN
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
  // Keywords are case-insensitive; SDK tool identities (including MCP server
  // and tool names) are not. Never rewrite an explicit permission's identity.
  const raw = value?.trim()
  if (!raw) return undefined
  if (raw.toLowerCase() === 'all' || raw === '*') return 'all'
  if (raw.toLowerCase() === 'none') return []
  const tools = raw.split(',').map((tool) => tool.trim()).filter(Boolean)
  return tools.length ? tools : []
}

function parseProfileFile(filePath: string, scope: SubagentProfileScope): SubagentProfile | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  return parseProfileSource(filePath, raw, scope)
}

/** Parse profile text without touching the disk, so an in-memory edit can be
 * validated before it is written. */
function parseProfileSource(filePath: string, raw: string, scope: SubagentProfileScope): SubagentProfile | null {
  const name = filePath.split(/[\\/]/).pop()!.replace(/\.md$/i, '')
  if (!PROFILE_NAME_PATTERN.test(name)) return null
  const { data, body } = parseFrontmatter(raw)
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

/** The frontmatter block of a profile file, located the same way the skill
 * frontmatter editor locates its block: between the leading `---` fence and
 * the first line that closes it. */
function findFrontmatterBlock(content: string): { openingEnd: number; closingStart: number; newline: string } | undefined {
  const NEWLINE = '\r\n|\n|\r'
  const opening = new RegExp(`^\uFEFF?---[ \t]*(${NEWLINE})`).exec(content)
  if (!opening) return undefined
  const rest = content.slice(opening[0].length)
  const closing = new RegExp(`(^|${NEWLINE})---`).exec(rest)
  if (!closing) return undefined
  return {
    openingEnd: opening[0].length,
    closingStart: opening[0].length + closing.index + closing[1].length,
    newline: opening[1]
  }
}

/** Surgical `tools:` edit: replace the existing line inside the frontmatter
 * (or insert one right after the opening fence) while preserving the original
 * formatting of every other line — the same discipline the skill frontmatter
 * editor follows. The key is detected by presence, not value, so an explicit
 * `tools: all` is updated in place instead of duplicated. */
export function setProfileToolsLine(content: string, tools: 'all' | string[]): string {
  const value = tools === 'all' ? 'all' : tools.join(',')
  const block = findFrontmatterBlock(content)
  if (!block) {
    // No frontmatter block at all — create one (unreachable for a file that
    // parsed as a profile, but the function stays total for tests).
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    const body = bom ? content.slice(1) : content
    return `${bom}---\ntools: ${value}\n---\n${body}`
  }
  const head = content.slice(block.openingEnd, block.closingStart)
  const keyLine = /(^|\r\n|\n|\r)([ \t]*(?:"tools"|'tools'|tools)[ \t]*:)[^\r\n]*/
  if (keyLine.test(head)) {
    return content.slice(0, block.openingEnd) + head.replace(keyLine, `$1$2 ${value}`) + content.slice(block.closingStart)
  }
  return content.slice(0, block.openingEnd) + `tools: ${value}${block.newline}` + content.slice(block.openingEnd)
}

/** Rewrite one profile's `tools:` line. The caller (PiManager) has already
 * verified the file is a currently listed profile, so this cannot be turned
 * into an arbitrary file write; the edit is still re-parsed before it is
 * committed, and a result that stops parsing as the SAME profile (name,
 * description, body) is refused instead of written. */
export function writeSubagentProfileTools(filePath: string, tools: 'all' | string[]): SubagentProfile {
  const raw = readFileSync(filePath, 'utf8')
  const before = parseProfileFile(filePath, 'global')
  if (!before) throw new Error('Not a subagent profile')
  let next: 'all' | string[] = 'all'
  if (tools === 'all') {
    next = 'all'
  } else {
    const names = [...new Set(tools.map((name) => name.trim()).filter((name) => name.length > 0))]
    if (!names.length) throw new Error('A subagent profile needs at least one enabled tool')
    if (names.some((name) => /[\r\n,]/.test(name))) throw new Error('Invalid tool name in profile tools')
    next = names
  }
  const updated = setProfileToolsLine(raw, next)
  const reparsed = parseProfileSource(filePath, updated, before.scope)
  if (!reparsed || reparsed.description !== before.description || reparsed.systemPrompt !== before.systemPrompt) {
    throw new Error('The tools edit would invalidate the profile')
  }
  if (JSON.stringify(reparsed.tools) !== JSON.stringify(next)) {
    throw new Error('The tools edit did not round-trip')
  }
  writeFileSync(filePath, updated, 'utf8')
  return reparsed
}

/** Edit only these four default keys; preserve tools, prompt, annotations and
 * line endings, and refuse ambiguous duplicate keys before touching disk. */
export function writeSubagentProfileDefaults(filePath: string, payload: SubagentProfileDefaultsPayload): SubagentProfile {
  if (!payload || (payload.model !== null && typeof payload.model !== 'string') ||
    typeof payload.inheritContext !== 'boolean' || typeof payload.runInBackground !== 'boolean') {
    throw new Error('Invalid subagent defaults')
  }
  const model = payload.model?.trim() || null
  if (model && !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error('Invalid subagent model spec')
  const thinking = payload.thinking
  if (thinking !== null && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
    throw new Error('Invalid subagent thinking level')
  }
  const raw = readFileSync(filePath, 'utf8')
  const before = parseProfileSource(filePath, raw, 'global')
  const block = findFrontmatterBlock(raw)
  if (!before || !block) throw new Error('Not a subagent profile')
  let head = raw.slice(block.openingEnd, block.closingStart)
  const edits: Array<[string, string | null]> = [
    ['model', model], ['thinking', thinking],
    ['inherit_context', String(payload.inheritContext)], ['run_in_background', String(payload.runInBackground)]
  ]
  for (const [key, value] of edits) {
    const pattern = new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*:[^\\r\\n]*`, 'gm')
    const matches = [...head.matchAll(pattern)]
    if (matches.length > 1) throw new Error(`Duplicate ${key} keys in profile`)
    const match = matches[0]
    if (match) {
      let end = match.index! + match[0].length
      if (value === null) end += head.slice(end).startsWith('\r\n') ? 2 : /^[\r\n]/.test(head.slice(end)) ? 1 : 0
      const indent = /^[ \t]*/.exec(match[0])![0]
      head = head.slice(0, match.index) + (value === null ? '' : `${indent}${key}: ${value}`) + head.slice(end)
    } else if (value !== null) {
      // Saving unrelated fields must not turn omitted boolean defaults into
      // new choices; their parser defaults already describe the saved value.
      if ((key === 'inherit_context' && payload.inheritContext === before.inheritContext) ||
        (key === 'run_in_background' && payload.runInBackground === before.runInBackground)) continue
      head += `${key}: ${value}${block.newline}`
    }
  }
  const updated = raw.slice(0, block.openingEnd) + head + raw.slice(block.closingStart)
  const parsed = parseProfileSource(filePath, updated, before.scope)
  if (!parsed || parsed.description !== before.description || parsed.systemPrompt !== before.systemPrompt ||
    parsed.model !== (model ?? undefined) || parsed.thinking !== (thinking ?? undefined) ||
    parsed.inheritContext !== payload.inheritContext ||
    parsed.runInBackground !== payload.runInBackground) throw new Error('The defaults edit did not round-trip')
  writeFileSync(filePath, updated, 'utf8')
  return parsed
}

/** Create one new profile file in `dir`. Validation mirrors the loader's own
 * rules — the name must be a valid profile name, the description a non-empty
 * single line (a profile without one cannot be chosen by the model and would
 * be invisible) — an existing file is never overwritten, and the content is
 * re-parsed before it is committed. The new file deliberately declares NO
 * `tools:` line: least privilege, the same rule a hand-written file follows. */
export function createSubagentProfileFile(dir: string, payload: SubagentProfileCreatePayload): SubagentProfile {
  const name = payload.name.trim()
  if (!PROFILE_NAME_PATTERN.test(name)) throw new Error('Invalid subagent profile name')
  // Newlines cannot live in a flat one-line frontmatter value.
  const description = payload.description.replace(/[\r\n]+/g, ' ').trim()
  if (!description) throw new Error('A subagent profile needs a description')
  const systemPrompt = payload.systemPrompt.trim()
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${name}.md`)
  if (existsSync(filePath)) throw new Error('A profile with this name already exists')
  const content = `---\ndescription: ${description}\n---\n\n${systemPrompt}${systemPrompt ? '\n' : ''}`
  const parsed = parseProfileSource(filePath, content, payload.scope)
  if (!parsed || parsed.description !== description || parsed.systemPrompt !== systemPrompt) {
    throw new Error('The new profile does not round-trip')
  }
  writeFileSync(filePath, content, 'utf8')
  return parsed
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

/** Serialization for Settings → Subagents: the profile exactly as parsed, with
 * optional fields omitted rather than null/undefined-populated. */
export function toSubagentProfileDTO(profile: SubagentProfile): SubagentProfileDTO {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools === 'all' ? 'all' : [...profile.tools],
    ...(profile.toolsSource ? { toolsSource: profile.toolsSource } : {}),
    ...(profile.toolPreset ? { toolPreset: profile.toolPreset } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    enabled: profile.enabled,
    scope: profile.scope,
    filePath: profile.filePath
  }
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
      // Written as an ordinary global file — nothing distinguishes a starter
      // from a user profile once it is on disk.
      scope: 'global',
      filePath
    }), 'utf8')
  }
  writeMarkers()
}
