import { TypeSafeClient, APIError, APITimeoutError, APIUserAbortError, type Questions, type Fetch } from '@typesafe-ai/sdk'
import { randomUUID } from 'node:crypto'
import type { JevAnswerDTO, JevEvaluationDTO, JevPreferences } from '../../../shared/types'
import { JevError, JEV_MODEL, parseJevRequest, type JevRequest } from './protocol'

const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Copy only verified fields; SDK types alone cannot validate a remote response. */
export function readJevResult(raw: unknown, request: JevRequest, elapsedMs: number): JevEvaluationDTO {
  if (!record(raw) || typeof raw.model !== 'string' || !/^jev-[\w.-]{1,64}$/.test(raw.model) || !record(raw.answers) || !record(raw.usage)) throw new JevError('invalid_response')
  const usage = raw.usage
  if (![usage.input_tokens, usage.output_tokens].every(v => Number.isSafeInteger(v) && v >= 0)) throw new JevError('invalid_response')
  if (Object.keys(raw.answers).length !== Object.keys(request.questions).length) throw new JevError('invalid_response')
  const answers: Record<string, JevAnswerDTO> = Object.create(null)
  for (const [id, question] of Object.entries(request.questions)) {
    if (!Object.hasOwn(raw.answers, id)) throw new JevError('invalid_response')
    const answer = raw.answers[id]
    if (!record(answer) || answer.type !== question.type) throw new JevError('invalid_response')
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new JevError('invalid_response')
      answers[id] = { type: 'noul', noul: answer.noul }
      continue
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i))
    if (!probability(answer.confidence) || !record(answer.probabilities) || Object.keys(answer.probabilities).length !== keys.length) throw new JevError('invalid_response')
    const probabilities: Record<string, number> = Object.create(null)
    for (const key of keys) {
      if (!Object.hasOwn(answer.probabilities, key) || !probability(answer.probabilities[key])) throw new JevError('invalid_response')
      probabilities[key] = answer.probabilities[key]
    }
    if (Math.abs(Object.values(probabilities).reduce((sum, n) => sum + n, 0) - 1) > 0.01) throw new JevError('invalid_response')
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)) throw new JevError('invalid_response')
      answers[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities }
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) throw new JevError('invalid_response')
      answers[id] = { type: 'score', score: answer.score, confidence: answer.confidence, probabilities, legend: Object.fromEntries(question.criteria.map((label, i) => [String(i), label])) }
    }
  }
  return { model: raw.model, answers, elapsedMs, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
}

export interface JevServiceOptions {
  preferences: () => JevPreferences
  apiKey: () => Promise<string | undefined>
  fetch?: Fetch
  timeoutMs?: number
  /** Capture ownership before credential lookup; claim only at actual dispatch. */
  accounting?: (owner: string) => ((requestId: string, callId?: string) => {
    record(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, providerRequestId?: string): void
    uncertain(): void
  }) | undefined
}

/** One application service; requests retain their owning session and abort independently. */
export class JevService {
  private requests = new Map<AbortController, string>()
  private closed = false
  constructor(private options: JevServiceOptions) {}

  enabledQuestionTypes(): Array<'choice' | 'score' | 'noul'> {
    const prefs = this.options.preferences()
    return prefs.mode === 'tools' ? (['choice', 'score', 'noul'] as const).filter(type => prefs[type]) : []
  }

  cancel(owner?: string): void {
    for (const [controller, path] of this.requests) if (owner === undefined || path === owner) controller.abort()
  }
  dispose(): void { this.closed = true; this.cancel() }

  async evaluate(input: unknown, options: { owner: string; signal?: AbortSignal; canStart?: () => boolean; probe?: boolean; workflow?: boolean; callId?: string }): Promise<JevEvaluationDTO> {
    const allowed = () => !this.closed && (options.canStart?.() ?? true)
    if (!allowed() || options.signal?.aborted) throw new JevError('cancelled')
    const prefs = this.options.preferences()
    if (!options.probe && prefs.mode !== (options.workflow ? 'workflow' : 'tools')) throw new JevError('disabled')
    const request = parseJevRequest(input, options.probe || options.workflow ? { mode: prefs.mode, choice: true, score: true, noul: true } : prefs)
    let accounting: ReturnType<NonNullable<JevServiceOptions['accounting']>>
    try { accounting = options.probe ? undefined : this.options.accounting?.(options.owner) }
    catch { throw new JevError('storage') }
    if (this.requests.size >= 4) throw new JevError('busy')
    const controller = new AbortController()
    this.requests.set(controller, options.owner)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? 10_000)
    const signal = AbortSignal.any([controller.signal, timeout.signal, ...(options.signal ? [options.signal] : [])])
    const started = performance.now()
    let ticket: ReturnType<NonNullable<typeof accounting>> | undefined
    try {
      const apiKey = await this.options.apiKey()
      if (signal.aborted || !allowed()) throw new JevError('cancelled')
      if (!apiKey) throw new JevError('missing_key')
      // Pin transport and logging: SDK environment overrides must not redirect keys or log request bodies.
      const client = new TypeSafeClient({ apiKey, baseURL: 'https://api.typesafe.ai', defaultModel: JEV_MODEL,
        timeout: this.options.timeoutMs ?? 10_000, retry: { maxRetries: 0 }, logLevel: 'off',
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}) })
      try { ticket = accounting?.(randomUUID(), options.callId) } catch { throw new JevError('storage') }
      const response = await client.systemOne({ state: request.state, questions: request.questions as Questions }, { signal }).withResponse()
      const raw = response.data
      // Reported usage survives cancellation and invalid semantic answers.
      // Never discard a billed response because Stop won the publication race.
      if (ticket) {
        const u = raw?.usage
        try {
          if (u && [u.input_tokens, u.output_tokens, u.input_tokens + u.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
            ticket.record({ input: u.input_tokens, output: u.output_tokens, cacheRead: 0, cacheWrite: 0 }, response.requestId)
          } else ticket.uncertain()
        } catch { throw new JevError('storage') }
      }
      if (signal.aborted || !allowed()) throw new JevError('cancelled')
      return readJevResult(raw, request, Math.round(performance.now() - started))
    } catch (error) {
      try { ticket?.uncertain() } catch { throw new JevError('storage') }
      if (timeout.signal.aborted) throw new JevError('timeout')
      if (signal.aborted || error instanceof APIUserAbortError) throw new JevError('cancelled')
      if (error instanceof JevError) throw error
      if (error instanceof APITimeoutError) throw new JevError('timeout')
      if (error instanceof APIError) {
        if (error.status === 401 || error.status === 403) throw new JevError('authentication')
        if (error.status === 429 || error.status === 529) throw new JevError('rate_limit')
        if (error.status === 422 || error.status === 400) throw new JevError('invalid_input')
      }
      // Never propagate SDK messages, headers, response bodies or credentials into IPC/history.
      throw new JevError('network')
    } finally { clearTimeout(timer); this.requests.delete(controller) }
  }

  probe(): Promise<JevEvaluationDTO> {
    return this.evaluate({ state: 'A developer reports that the application crashes every time they open Settings.', questions: {
      category: { type: 'choice', instructions: 'Classify this report.', criteria: { bug: 'An existing feature fails.', feature: 'A request for new functionality.' } },
      severity: { type: 'score', instructions: 'Rate the impact described in the report.', criteria: ['Cosmetic issue', 'Feature unavailable', 'Application crashes'] },
      reproducible: { type: 'noul', instructions: 'Does the developer explicitly report that the problem happens every time?' }
    } }, { owner: 'settings:jev', probe: true })
  }
}
