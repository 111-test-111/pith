import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { RewindCheckpointDTO, RewindErrorDTO } from '../../shared/types'
import type { RewindClient } from './client'
import { CheckoutCoordinator } from './coordinator'
import { failure } from './types'

/** Capture is awaited at real SDK admission/next-turn boundaries. An observer
 * queued after a tool cannot bind an old entry to files written later. */
export class RewindRecorder {
  error?: RewindErrorDTO
  private disposed = false
  private unsubscribeAgent?: () => void
  private label = ''
  private messageTimestamp?: number
  private messageCheckpoints = new WeakMap<object, string>()
  private releases = new Map<string, () => void>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private options: {
    session: AgentSession
    sessionPath: string
    cwd: string
    client: RewindClient
    coordinator: CheckoutCoordinator
    enabled: () => boolean
    changed: () => void
  }) { this.install() }

  /**
   * `ctx.executeTool()` uses the SDK's private nested pipeline rather than
   * agent.beforeToolCall. Its extension hook calls this before a nested tool
   * can run; the matching tool_execution_end (or disposal) releases the lease.
   */
  async beginNestedToolCall(toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('The session is closing')
    const { coordinator, cwd, sessionPath } = this.options
    const release = await coordinator.enter(cwd, 'tool', sessionPath, signal)
    if (this.disposed || signal?.aborted) {
      release()
      throw new Error(this.disposed ? 'The session is closing' : 'Operation aborted')
    }
    this.releases.set(toolCallId, release)
  }

  endNestedToolCall(toolCallId: string): void {
    this.releases.get(toolCallId)?.()
    this.releases.delete(toolCallId)
  }

  private install(): void {
    const { session, coordinator, cwd, sessionPath } = this.options
    const agent = session.agent
    const before = agent.beforeToolCall, after = agent.afterToolCall
    agent.beforeToolCall = async (context, signal) => {
      // bash_task can stop a long-lived process while a checkpoint is pending.
      // It never starts processes or writes the workspace itself.
      const release = context.toolCall.name === 'bash_task' ? () => {} : await coordinator.enter(cwd, 'tool', sessionPath, signal)
      this.releases.set(context.toolCall.id, release)
      try {
        const result = await before?.(context, signal)
        if (result?.block) { release(); this.releases.delete(context.toolCall.id) }
        return result
      } catch (error) { release(); this.releases.delete(context.toolCall.id); throw error }
    }
    agent.afterToolCall = async (context, signal) => {
      try { return await after?.(context, signal) }
      finally { this.releases.get(context.toolCall.id)?.(); this.releases.delete(context.toolCall.id) }
    }
    // Unlike session.subscribe(), agent listeners are awaited by the SDK.
    // User admission covers ordinary prompts, steers and follow-ups alike;
    // Tools and continuations within that turn do not add more timepoints.
    this.unsubscribeAgent = agent.subscribe(async event => {
      if (event.type === 'message_start' && event.message.role === 'user') {
        const user = event.message
        this.messageTimestamp = user.timestamp
        this.label = (typeof user.content === 'string' ? user.content : user.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).slice(0, 200)
        const checkpoint = await this.capture()
        if (checkpoint) this.messageCheckpoints.set(user, checkpoint.id)
      } else if (event.type === 'message_end' && event.message.role === 'user') {
        const checkpointId = this.messageCheckpoints.get(event.message)
        const entry = session.sessionManager.getLeafEntry()
        if (checkpointId && entry?.type === 'message' && entry.message === event.message) {
          try { await this.options.client.call('bindMessage', cwd, session.sessionId, checkpointId, entry.id) }
          catch (error) { this.error = failure(error) }
          this.options.changed()
        }
      }
    })
    const prompt = agent.prompt.bind(agent) as (...args: any[]) => Promise<void>, resume = agent.continue.bind(agent)
    agent.prompt = (...args: any[]) => this.run(() => prompt(...args))
    agent.continue = () => this.run(() => resume())
    // Keep ownership across extension input/before_agent_start hooks, retries,
    // compaction and queued continuations, beyond an individual agent loop.
    for (const name of ['prompt', 'sendCustomMessage', 'compact', 'reload'] as const) {
      const original = session[name].bind(session) as (...args: any[]) => Promise<any>
      ;(session as any)[name] = async (...args: any[]) => {
        const release = await coordinator.enter(cwd, 'run', sessionPath)
        try { return await original(...args) } finally { release() }
      }
    }
    // Extension-driven shell execution writes workspace files outside any
    // tool admission, so it carries the process lease that snapshots and
    // restores wait for — a plain run lease no longer fences snapshots.
    const executeBash = session.executeBash.bind(session) as (...args: any[]) => Promise<any>
    ;(session as any).executeBash = async (...args: any[]) => {
      const release = await coordinator.enter(cwd, 'process', sessionPath)
      try { return await executeBash(...args) } finally { release() }
    }
  }
  private async run(operation: () => Promise<void>): Promise<void> {
    const { coordinator, cwd, sessionPath } = this.options
    const release = await coordinator.enter(cwd, 'run', sessionPath)
    try {
      await operation()
    } finally {
      release()
      for (const release of this.releases.values()) release()
      this.releases.clear()
    }
  }
  private async capture(): Promise<RewindCheckpointDTO | undefined> {
    const task = this.pending.then(async () => {
      const { session, cwd, client, coordinator } = this.options
      if (this.disposed || !this.options.enabled()) return
      let checkpoint: RewindCheckpointDTO | undefined
      try {
        await coordinator.withExclusive(cwd, 'snapshot', async () => {
          // Resolve the exact selected leaf inside the barrier. Capturing and
          // deduplicating a checkpoint must not append hidden session entries.
          const entryId = session.sessionManager.getLeafId()
          checkpoint = await client.call('checkpoint', cwd, { sessionId: session.sessionId, trigger: 'before-turn',
            entryId, description: this.label, messageTimestamp: this.messageTimestamp })
        }, false)
        this.error = undefined
      } catch (error) {
        this.error = failure(error)
        if (this.error.code === 'recovery' && this.error.operationId) coordinator.setRecovery(cwd, this.error.operationId)
      }
      this.options.changed()
      return checkpoint
    })
    this.pending = task
    return await task
  }
  observe(event: AgentSessionEvent): void {
    if (event.type === 'tool_execution_end') this.endNestedToolCall(event.toolCallId)
  }
  async idle(): Promise<void> { await this.pending }
  dispose(): void { this.disposed = true; this.unsubscribeAgent?.(); for (const release of this.releases.values()) release(); this.releases.clear() }
}
