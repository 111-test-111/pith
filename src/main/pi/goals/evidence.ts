import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GoalCriterion, GoalCriterionDTO, GoalEvidenceDTO, GoalEvidenceRef, GoalRecord } from '../../../shared/goal'
import { collectJevEvidence, type EvidenceItem, type WorkflowEvidence } from '../jev/evidence'
import { GOAL_ENTRY, GOAL_EVIDENCE, GOAL_GET, GOAL_UPDATE, parseGoalReceipt, type GoalBranch } from './protocol'

export const goalHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export interface GoalEvidenceStamp {
  id: string
  hash: string
  key: string
  generation: number
  /** File results survive changes to unrelated files; checks cover the observed workspace. */
  scope: 'file' | 'workspace'
  versions: Record<string, string>
  unstable?: boolean
}
export interface GoalEvidenceState {
  evidence: WorkflowEvidence
  stamps: Map<string, GoalEvidenceStamp & { stampId: string; index: number }>
  branch: GoalBranch
  goalId: string
}
export function goalEvidenceStart(branch: GoalBranch, goalId: string): number {
  const definition = branch.findIndex(e => e.type === 'custom' && e.customType === GOAL_ENTRY && (e.data as { id?: string })?.id === goalId)
  const user = branch.findIndex((e, i) => i > definition && e.type === 'message' && e.message.role === 'user')
  return user < 0 ? branch.length : user
}
const itemHash = (item: EvidenceItem, branch: GoalBranch) => goalHash(JSON.stringify({
  source: branch.find(e => e.id === item.id || item.id.startsWith(`${e.id}:`)),
  identity: [item.id, item.key, item.kind, item.tool, item.path, item.command, item.status, item.generation]
}))
const readable = (hash: string | undefined) => !!hash && /^[a-f0-9]{64}$/.test(hash)
export async function readGoalVersions(paths: string[], cwd: string): Promise<Record<string, string>> {
  const versions = await Promise.all([...new Set(paths.map(path => resolve(cwd, path)))].slice(0, 64).map(async path => {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return [path, 'unavailable'] as const
      return [path, goalHash(await readFile(path))] as const
    } catch { return [path, 'unavailable'] as const }
  }))
  return Object.fromEntries(versions)
}
export async function collectGoalEvidence(branch: GoalBranch, cwd: string, goal: GoalRecord, preferredIds: string[] = []): Promise<GoalEvidenceState> {
  const evidence = await collectJevEvidence(branch, cwd, { start: goalEvidenceStart(branch, goal.id), canonicalPaths: true, fileHash: goalHash,
    excludedTools: [GOAL_GET, GOAL_UPDATE], retainReferences: true,
    preferredIds: [...preferredIds, ...goal.criteria.flatMap(c => c.proof?.sources.map(s => s.id) ?? [])] })
  const stamps: GoalEvidenceState['stamps'] = new Map()
  const start = branch.findIndex(e => e.type === 'custom' && e.customType === GOAL_ENTRY && (e.data as { id?: string })?.id === goal.id)
  for (let i = Math.max(0, start); i < branch.length; i++) {
    const e = branch[i]
    if (e.type !== 'custom' || e.customType !== GOAL_EVIDENCE) continue
    const data = e.data as { version?: number; goalId?: string; items?: GoalEvidenceStamp[] }
    if (data?.version !== 1 || data.goalId !== goal.id || !Array.isArray(data.items) || data.items.length > 48) continue
    for (const s of data.items) {
      if (!s || typeof s.id !== 'string' || s.id.length > 160 || typeof s.key !== 'string' || s.key.length > 4200 || !readable(s.hash) ||
        !Number.isSafeInteger(s.generation) || s.generation < 0 || !['file', 'workspace'].includes(s.scope) || (s.unstable !== undefined && typeof s.unstable !== 'boolean') ||
        !s.versions || typeof s.versions !== 'object' || Array.isArray(s.versions) || Object.keys(s.versions).length > 64 ||
        Object.entries(s.versions).some(([path, hash]) => !path || path.length > 4096 || typeof hash !== 'string' || hash.length > 100)) continue
      // First observation is immutable: re-reading disk later must never repair
      // an old check's version binding after an external edit or restart.
      if (!stamps.has(s.id)) stamps.set(s.id, { ...s, stampId: e.id, index: i })
    }
  }
  return { evidence, stamps, branch, goalId: goal.id }
}
export function makeGoalStamps(state: GoalEvidenceState, sourceId: string): GoalEvidenceStamp[] {
  return state.evidence.items.filter(item => (item.id === sourceId || item.id.startsWith(`${sourceId}:`)) && !state.stamps.has(item.id)).map(item => {
    const scope = item.path && ['change', 'inspection'].includes(item.kind) ? 'file' : 'workspace'
    const versions = scope === 'file' ? { [item.path!]: state.evidence.versions[item.path!] ?? 'unavailable' } : { ...state.evidence.versions }
    return { id: item.id, hash: itemHash(item, state.branch), key: item.key, generation: item.generation, scope, versions }
  })
}
export function currentGoalSource(state: GoalEvidenceState, ref: GoalEvidenceRef, successfulOnly = true): boolean {
  const item = state.evidence.items.find(i => i.id === ref.id) ?? state.evidence.references?.find(i => i.id === ref.id)
  const stamp = state.stamps.get(ref.id)
  if (!item || !stamp || stamp.unstable || state.evidence.supersededIds?.includes(ref.id) || successfulOnly && item.status !== 'success' || stamp.stampId !== ref.stampId || stamp.hash !== ref.hash || itemHash(item, state.branch) !== ref.hash) return false
  const sourceIndex = state.branch.findIndex(e => e.id === item.id || item.id.startsWith(`${e.id}:`))
  if (sourceIndex < 0 || sourceIndex >= stamp.index) return false
  if (stamp.scope === 'workspace' && stamp.generation !== state.evidence.generation) return false
  if (item.kind === 'change' && item.path && state.evidence.externalChanges.includes(item.path)) return false
  return Object.entries(stamp.versions).every(([path, hash]) => readable(hash) && state.evidence.versions[path] === hash)
}
export function currentGoalCriterion(state: GoalEvidenceState, criterion: GoalCriterion): boolean {
  const proof = criterion.proof
  if (!proof || proof.revision !== criterion.revision) return false
  const receiptIndex = state.branch.findIndex(e => e.id === proof.receiptId)
  const entry = state.branch[receiptIndex]
  if (entry?.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.toolName !== GOAL_UPDATE || entry.message.isError) return false
  const receipt = parseGoalReceipt(entry.message.details)
  const claim = receipt?.claims.find(c => c.criterionId === criterion.id && c.revision === criterion.revision)
  if (!receipt || receipt.goalId !== state.goalId || !claim || claim.summary !== proof.summary || JSON.stringify(claim.sources) !== JSON.stringify(proof.sources)) return false
  return proof.sources.every(ref => (state.stamps.get(ref.id)?.index ?? Infinity) < receiptIndex && currentGoalSource(state, ref))
}
export function goalEvidenceView(state: GoalEvidenceState, goal: GoalRecord): { criteria: GoalCriterionDTO[]; results: GoalEvidenceDTO[]; blocked: boolean } {
  return { criteria: goal.criteria.map(c => ({ ...c, state: !c.proof ? 'pending' : currentGoalCriterion(state, c) ? 'verified' : 'stale',
    ...(c.proof ? { files: Object.assign({}, ...c.proof.sources.map(s => state.stamps.get(s.id)?.versions ?? {})) } : {}) })),
    results: state.evidence.items.map(item => {
      const stamp = state.stamps.get(item.id)
      return { id: item.id, tool: item.tool, kind: item.kind, status: item.status !== 'success' ? item.status :
        stamp && currentGoalSource(state, { id: item.id, stampId: stamp.stampId, hash: stamp.hash }) ? 'success' : 'stale',
        excerpt: item.excerpt, ...(item.path ? { path: item.path } : {}), ...(item.command ? { command: item.command } : {}) }
    }), blocked: (state.evidence.unresolvedChecks ?? 0) > 0 }
}
