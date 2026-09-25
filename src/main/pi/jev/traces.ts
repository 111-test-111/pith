import { randomUUID } from 'node:crypto'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { JevTraceDTO, JevTracePageDTO, JevTraceSummaryDTO } from '../../../shared/types'
import type { JevRequest } from './protocol'

const RECORD = 'pith_jev_judgment_v1'

/** Requests/results are separate from frequent status snapshots and invisible to
 * the model. The complete selected branch is authoritative after compaction or
 * rewind. Each call is sealed with its actual result (including failed calls). */
export class JevTraces {
  private running = new Set<string>()
  constructor(private session: AgentSession) {}

  start(stage: JevTraceDTO['stage'], request: JevRequest): JevTraceDTO {
    const trace: JevTraceDTO = { id: randomUUID(), stage, timestamp: Date.now(), status: 'running', request }
    this.session.sessionManager.appendCustomEntry(RECORD, trace)
    this.running.add(trace.id)
    return trace
  }
  finish(trace: JevTraceDTO): void {
    this.session.sessionManager.appendCustomEntry(RECORD, trace)
    this.running.delete(trace.id)
  }
  private *records(): Generator<JevTraceDTO> {
    const branch = this.session.sessionManager.getBranch(), seen = new Set<string>()
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]
      if (entry.type !== 'custom' || entry.customType !== RECORD) continue
      const trace = entry.data as JevTraceDTO | undefined
      if (!trace || typeof trace.id !== 'string' || !['router', 'verifier'].includes(trace.stage)
        || !Number.isFinite(trace.timestamp) || !trace.request || typeof trace.request.state !== 'string'
        || !['running', 'completed', 'failed'].includes(trace.status) || seen.has(trace.id)) continue
      seen.add(trace.id)
      yield trace.status === 'running' && !this.running.has(trace.id) ? { ...trace, status: 'interrupted' } : trace
    }
  }
  page(cursor?: string): JevTracePageDTO {
    const items: JevTraceSummaryDTO[] = []
    let found = !cursor
    for (const trace of this.records()) {
      if (!found) { if (trace.id === cursor) found = true; continue }
      if (items.length === 30) return { items, nextCursor: items.at(-1)!.id }
      const { request: _request, evaluation: _evaluation, ...summary } = trace
      items.push(summary)
    }
    return { items, nextCursor: null }
  }
  detail(id: string): JevTraceDTO | null {
    for (const trace of this.records()) if (trace.id === id) return trace
    return null
  }
}
