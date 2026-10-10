import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { BASH_COMPLETION_TYPE } from '../task-notifications'
import { SUBAGENT_COMPLETION_TYPE } from '../subagents/protocol'
import { ASK_USER_ANSWER_TYPE, ASK_USER_TOOL_NAME, isAskUserToolDetails } from '../../../shared/ask-user'

type Entry = ReturnType<AgentSession['sessionManager']['getBranch']>[number]
type Message = AgentSession['agent']['state']['messages'][number]
const COMPLETIONS = new Set([BASH_COMPLETION_TYPE, SUBAGENT_COMPLETION_TYPE, ASK_USER_ANSWER_TYPE])
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex').slice(0, 20)
export function jevExcerpt(value: string, limit: number): string {
  const redacted = value.replace(/apikey_[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, '$1[redacted]')
  if (redacted.length <= limit) return redacted
  const half = Math.max(0, Math.floor((limit - 24) / 2))
  return `${redacted.slice(0, half)}\n[excerpt truncated]\n${redacted.slice(-half)}`
}
export function textOf(message: Message): string {
  if (!('content' in message)) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.filter(p => p.type === 'text').map(p => 'text' in p ? p.text : '').join('\n')
}
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
function json(value: string): Record<string, any> | undefined {
  try { return record(JSON.parse(value)) } catch { return undefined }
}
export interface EvidenceItem {
  id: string
  kind: 'change' | 'inspection' | 'check' | 'result'
  tool: string
  path?: string
  command?: string
  status: 'success' | 'failure' | 'pending'
  exitCode?: number | null
  excerpt: string
  /** Current text, when readable, outranks a historical patch after shell or external edits. */
  currentSource?: string
  imageOmitted?: boolean
  /** The branch generation when this evidence was collected. */
  generation: number
  /** Same command/path has one latest result, not dozens of duplicate entries. */
  key: string
  versions?: Record<string, string>
  /** Goal's committed-source validator supplies file-scoped freshness. */
  current?: boolean
}
export interface WorkflowEvidence {
  request: string
  priorContext: Array<{ role: string; text: string }>
  attachmentsOmitted: boolean
  revision: string
  versions: Record<string, string>
  generation: number
  items: EvidenceItem[]
  changedFiles: string[]
  externalChanges: string[]
  omitted: number
  /** Computed before bounding so an omitted failing check cannot disappear. */
  unresolvedChecks?: number
  /** Private controller references, separate from the bounded public result view. */
  references?: EvidenceItem[]
  supersededIds?: string[]
}

/** Preserve compact evidence by identity across the complete selected branch.
 * Never slice a bash envelope full of IDs: extract its command, exit and output.
 * Mutations advance a generation; inspections/checks from before it are labeled
 * stale, while the actual edit patches remain available. */
export interface EvidenceOptions {
  start?: number
  excludedTools?: readonly string[]
  canonicalPaths?: boolean
  fileHash?: (value: string | Uint8Array) => string
  /** Keep existing criterion references ahead of inspection noise, within the same bounds. */
  preferredIds?: readonly string[]
  retainReferences?: boolean
}
export async function collectJevEvidence(branch: Entry[], cwd: string, options: EvidenceOptions = {}): Promise<WorkflowEvidence> {
  const start = options.start ?? branch.findLastIndex(e => e.type === 'message' && e.message.role === 'user')
  const fileHash = options.fileHash ?? digest
  const filePath = (path: string) => options.canonicalPaths ? resolve(cwd, path) : path
  const preferred = new Set(options.preferredIds)
  const user = start >= 0 && branch[start]?.type === 'message' ? (branch[start] as Extract<Entry, { type: 'message' }>).message : undefined
  const priorContext: WorkflowEvidence['priorContext'] = []
  for (let i = start - 1; i >= 0 && priorContext.length < 2; i--) {
    const e = branch[i]
    if (e.type === 'message' && ['user', 'assistant'].includes(e.message.role)) {
      const text = jevExcerpt(textOf(e.message), 800)
      if (text) priorContext.unshift({ role: e.message.role, text })
    }
  }
  const calls = new Map<string, { name: string; args: Record<string, any> }>()
  const items = new Map<string, EvidenceItem>()
  const references = new Map<string, EvidenceItem>()
  const files = new Map<string, { expected?: string; generation: number }>()
  const mutations: string[] = []
  const childChanges = new Set<string>()
  const stamped = new Map<string, Record<string, string>>()
  for (const e of branch.slice(Math.max(0, start))) {
    if (e.type !== 'custom' || e.customType !== 'pith_jev_evidence_v2') continue
    const data = record(e.data)
    if (!data || !Array.isArray(data.ids) || !record(data.versions)) continue
    for (const id of data.ids) if (typeof id === 'string') stamped.set(id, data.versions)
  }
  let generation = 0
  const add = (item: EvidenceItem) => {
    items.delete(item.key); items.set(item.key, item)
    if (options.retainReferences && preferred.has(item.id)) references.set(item.id, item)
  }
  for (const e of branch.slice(Math.max(0, start))) {
    if (e.type === 'message' && e.message.role === 'assistant') {
      for (const c of e.message.content) if (c.type === 'toolCall') calls.set(c.id, { name: c.name, args: record(c.arguments) ?? {} })
      continue
    }
    let tool: string, output: string, details: Record<string, any> | undefined, args: Record<string, any>, isError = false
    if (e.type === 'message' && e.message.role === 'toolResult') {
      tool = e.message.toolName; output = textOf(e.message); details = record(e.message.details)
      args = calls.get(e.message.toolCallId)?.args ?? {}; isError = e.message.isError
    } else if (e.type === 'custom_message' && COMPLETIONS.has(e.customType)) {
      tool = e.customType; output = typeof e.content === 'string' ? e.content : e.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      details = record(e.details); args = {}
    } else continue
    if (tool === 'todo_write' || options.excludedTools?.includes(tool)) continue
    const parsed = json(output) ?? (tool === BASH_COMPLETION_TYPE ? json(output.slice(output.indexOf('\n') + 1)) : undefined)
    const task = record(details?.bashTask) ?? record(parsed?.task) ?? (typeof parsed?.command === 'string' ? parsed : undefined)
    const path = typeof args.path === 'string' ? filePath(args.path) : undefined
    const command = typeof task?.command === 'string' ? task.command : typeof args.command === 'string' ? args.command : undefined
    const changed = !isError && ['edit', 'write'].includes(tool)
    if (changed) {
      generation++; mutations.push(e.id)
      if (path) files.set(path, { generation, ...(tool === 'write' && typeof args.content === 'string' ? { expected: fileHash(args.content) } : {}) })
    }
    // Child change evidence is preserved even if a delegation itself failed.
    const childRun = record(details?.subagent)
    const childFiles = Array.isArray(childRun?.writtenFiles) ? childRun.writtenFiles : []
    for (const child of childFiles) {
      if (!child || typeof child.filePath !== 'string') continue
      const identity = `${childRun?.runId}:${child.filePath}:${digest(JSON.stringify([child.patch, child.added, child.removed]))}`
      if (childChanges.has(identity)) continue
      childChanges.add(identity)
      const childPath = filePath(child.filePath)
      generation++; mutations.push(identity); files.set(childPath, { generation })
      add({ id: `${e.id}:${digest(child.filePath)}`, key: `change:${childPath}`, kind: 'change', tool, path: childPath,
        status: 'success', generation, excerpt: jevExcerpt(typeof child.patch === 'string' ? child.patch : 'Child recorded a file change.', 2400) })
    }
    const ask = tool === ASK_USER_TOOL_NAME && isAskUserToolDetails(details) ? details :
      tool === ASK_USER_ANSWER_TYPE && isAskUserToolDetails(details?.askUser) ? details.askUser : undefined
    const status: EvidenceItem['status'] = task && ['running', 'stopping'].includes(task.status) || ask?.status === 'pending' ? 'pending'
      : isError || ask?.status === 'cancelled' || (task && !['succeeded', 'running', 'stopping'].includes(task.status)) ? 'failure' : 'success'
    const body = typeof parsed?.output === 'string' ? parsed.output : output
    const patch = typeof details?.patch === 'string' ? details.patch : typeof details?.diff === 'string' ? details.diff : undefined
    const inspection = ['read', 'grep', 'find', 'ls'].includes(tool)
    const key = changed ? `change:${path ?? e.id}` : command ? `command:${digest(command)}`
      : inspection ? `${tool}:${digest(JSON.stringify(args))}` : `${tool}:${digest(output)}`
    if (path && !files.has(path)) files.set(path, { generation })
    add({ id: e.id, key, kind: changed ? 'change' : command ? 'check' : inspection ? 'inspection' : 'result', tool,
      ...(path ? { path } : {}), ...(command ? { command: jevExcerpt(command, 1400) } : {}), status, generation,
      ...(typeof task?.exitCode === 'number' || task?.exitCode === null ? { exitCode: task.exitCode } : {}),
      ...(e.type === 'message' && e.message.role === 'toolResult' && e.message.content.some(c => c.type === 'image') ? { imageOmitted: true } : {}),
      excerpt: jevExcerpt(changed ? patch ?? (tool === 'write' && typeof args.content === 'string' ? args.content : output) : body, changed ? 3200 : 1600) })
  }
  // Current contents, not timestamps, identify the revision: repeated reads,
  // builds and screenshots must not buy another verification of unchanged code.
  // Reads are bounded and cancellation is rechecked by the controller afterward.
  const changedFiles = [...items.values()].filter(i => i.kind === 'change' && i.path).map(i => i.path!)
  const changedPaths = new Set(changedFiles)
  const currentSources = new Map<string, string>()
  const candidates = [...files].sort(([a], [b]) => Number(changedPaths.has(b)) - Number(changedPaths.has(a))).slice(0, 64)
  const versions = await Promise.all(candidates.map(async ([path, expected]) => {
    try {
      const file = resolve(cwd, path), info = await stat(file)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return [path, `unread:${info.size}:${info.mtimeMs}`, false] as const
      const content = await readFile(file), hash = fileHash(content)
      if (changedPaths.has(path) && !content.includes(0) && isUtf8(content)) currentSources.set(path, jevExcerpt(content.toString('utf8'), 1600))
      return [path, hash, !!expected.expected && expected.expected !== hash] as const
    } catch { return [path, 'unavailable', !!expected.expected] as const }
  }))
  const revision = digest(JSON.stringify({ mutations, versions: versions.map(([path, hash]) => [path, hash]) }))
  // Changes + check outcomes survive inspection noise. Every omitted item is
  // explicit; inability to fit evidence must never imply a passing assertion.
  const all = [...items.values()].map(item => ({ ...item,
    ...(stamped.has(item.id) ? { versions: stamped.get(item.id) } : {}),
    ...(item.kind === 'change' && item.path && currentSources.has(item.path) ? { currentSource: currentSources.get(item.path) } : {}) }))
  const ranked = [...all.filter(i => i.kind === 'change').reverse(), ...all.filter(i => i.kind === 'check').reverse(),
    ...all.filter(i => i.kind === 'result').reverse(), ...all.filter(i => i.kind === 'inspection').reverse()]
  ranked.sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)))
  const selected: EvidenceItem[] = []
  let bytes = 0
  for (const item of ranked) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (selected.length >= 48 || bytes + size > 33_000) continue
    selected.push(item); bytes += size
  }
  return { request: jevExcerpt(user ? textOf(user) : 'Continue the current task.', 3500), priorContext,
    attachmentsOmitted: !!user && 'content' in user && typeof user.content !== 'string' && user.content.some(p => p.type === 'image'),
    revision, versions: Object.fromEntries(versions.map(([path, hash]) => [path, hash])), generation, items: selected, changedFiles: [...new Set(changedFiles)], externalChanges: versions.filter(v => v[2]).map(v => v[0]),
    omitted: all.length - selected.length, unresolvedChecks: all.filter(i => i.kind === 'check' && i.status !== 'success').length,
    ...(options.retainReferences ? { references: [...references.values()], supersededIds: [...references.values()].filter(item => {
      const latest = items.get(item.key)!
      return latest.id !== item.id && !(item.path && ['change', 'inspection'].includes(item.kind) && latest.status === 'success')
    }).map(item => item.id) } : {}) }
}

export function evidenceIsCurrent(item: EvidenceItem, evidence: WorkflowEvidence, paths: string[]): boolean {
  if (item.current !== undefined) return item.current
  if (item.kind === 'change') {
    const version = item.path ? evidence.versions[item.path] : undefined
    if (!item.path || !version || version === 'unavailable' || version.startsWith('unread:')) return false
    if (evidence.externalChanges.includes(item.path)) return false
    return !item.versions || item.versions[item.path] === evidence.versions[item.path]
  }
  if (item.versions && paths.length) return paths.every(path => item.versions![path] !== undefined && item.versions![path] === evidence.versions[path])
  return item.generation === evidence.generation && !evidence.externalChanges.length
}

/** Do not ask a semantic judge to mentally undo old passing output while it
 * reads current contradictory code. Retain the reference and stale marker, but
 * exclude superseded prose from the submitted proof. Current source is an
 * independent disk observation and remains visible beside historical changes. */
export function reviewEvidenceItems(evidence: WorkflowEvidence, paths: string[]) {
  return evidence.items.map(item => {
    const { key: _key, versions: _versions, ...visible } = item
    const stale = !evidenceIsCurrent(item, evidence, paths)
    return { ...visible, isError: item.status === 'failure', stale,
      ...(stale ? { status: 'stale', originalStatus: item.status, excerpt: '[Historical evidence omitted because it does not establish the current file version. Use currentSource when present.]' } : {}) }
  })
}
