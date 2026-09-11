import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices
} from '@earendil-works/pi-coding-agent'
import { shell } from 'electron'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FileIndex, readAttachment } from './files'
import {
  builtinProviderBaseUrls,
  builtinProviderIds,
  configuredModels,
  discoverModels,
  providerInventory,
  readModelsConfig,
  recommendCatalogPreset,
  supportsModelDiscovery,
  testModel,
  writeModelsConfig
} from './models-config'
import { loadSettings, saveSettings } from '../settings'
import type {
  CatalogRecommendationDTO,
  ChatMessage,
  ContextUsageDTO,
  CustomModelDTO,
  DefaultModelDTO,
  DiscoveredModelDTO,
  FilePreviewDTO,
  ForkResultDTO,
  ImageContent,
  ModelConfigSourceDTO,
  ModelDTO,
  ModelRefDTO,
  ModelsConfigDTO,
  PiEvent,
  ProviderDTO,
  ProviderModelDTO,
  PromptPayload,
  ResendPayload,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  TestModelResultDTO,
  ThinkingLevel,
  ToolRunDTO
} from '../../shared/types'

/** How many opened folders to keep in the sidebar/settings list. */
const MAX_FOLDERS = 12

/**
 * Streaming updates (`message_update` carries the FULL accumulated partial
 * message, `tool_execution_update` the partial tool output) can arrive dozens
 * of times per second from fast models. Coalesce them per session (latest wins
 * per key) so full accumulated messages cross IPC at most 20 times per second.
 * Ordered events always flush that session's pending updates first.
 */
const STREAM_FLUSH_MS = 50
/** Tool output is normally collapsed; a lower live cadence avoids repeatedly
 * cloning and reconciling large cumulative terminal/diff payloads. */
const TOOL_STREAM_FLUSH_MS = 150

/** Drop functions/symbols and turn Dates into ISO strings before IPC. */
function serialize(value: unknown): any {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function' || typeof val === 'symbol') return undefined
      if (val instanceof Date) return val.toISOString()
      return val
    })
  )
}

function modelRef(model: any): ModelRefDTO | null {
  if (!model) return null
  return {
    providerId: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning)
  }
}

interface ManagedSession {
  session: AgentSession
  path: string
  cwd: string
  unsubscribe: () => void
  pendingStreamEvents: Map<string, PiEvent>
  streamFlushTimer: ReturnType<typeof setTimeout> | null
  streaming: ChatMessage | null
  toolRuns: Record<string, ToolRunDTO>
  queue: { steering: string[]; followUp: string[] }
  eventSequence: number
}

export class PiManager {
  private modelRuntime: ModelRuntime | null = null
  /** Lazily created; reads/writes ~/.pi/agent/settings.json (default model). */
  private settingsManagerInstance: SettingsManager | null = null
  /** Resource discovery is cwd-bound but session-independent; sharing these
   * services avoids rescanning extensions/skills/context on every switch. */
  private sessionServices = new Map<string, Promise<AgentSessionServices>>()
  /** Every currently active or background-running SDK session, keyed by file. */
  private sessions = new Map<string, ManagedSession>()
  private activeSession: ManagedSession | null = null
  /** Invalidates slower session creations when a newer navigation wins. */
  private navigationEpoch = 0
  private fileIndex: FileIndex | null = null
  private pendingAuth = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()

  cwd: string | null = null
  /** Folders the user has opened, most recent first — sessions of all of
   * them stay listed; `cwd` is the active workspace. */
  folders: string[] = loadSettings().folders.filter((f) => typeof f === 'string')

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private notifyError: (message: string) => void
  ) {}

  /** Move a folder to the front of the known list and persist it. */
  private rememberFolder(cwd: string): void {
    this.folders = [cwd, ...this.folders.filter((f) => f !== cwd)].slice(0, MAX_FOLDERS)
    saveSettings({ ...loadSettings(), cwd: this.cwd, folders: this.folders })
  }

  /** Switch the active workspace folder (file index, session dir context). */
  private activateFolder(cwd: string): void {
    if (this.cwd !== cwd || !this.fileIndex) {
      this.fileIndex = new FileIndex(cwd)
      void this.fileIndex.refresh(true).catch(() => {})
    }
    this.cwd = cwd
    this.rememberFolder(cwd)
  }

  private async runtime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create({
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 10_000
      })
    }
    return this.modelRuntime
  }

  private async servicesFor(cwd: string): Promise<AgentSessionServices> {
    const cached = this.sessionServices.get(cwd)
    if (cached) return cached
    const pending = (async () =>
      createAgentSessionServices({ cwd, modelRuntime: await this.runtime() }))()
    this.sessionServices.set(cwd, pending)
    try {
      return await pending
    } catch (error) {
      this.sessionServices.delete(cwd)
      throw error
    }
  }

  private disposeManaged(managed: ManagedSession): void {
    managed.unsubscribe()
    if (managed.streamFlushTimer) clearTimeout(managed.streamFlushTimer)
    managed.pendingStreamEvents.clear()
    managed.session.dispose()
    this.sessions.delete(managed.path)
    if (this.activeSession === managed) this.activeSession = null
  }

  /**
   * Switch the visible session without disposing the old AgentSession. The SDK
   * disposer's contract is to abort its agent, so disposal is reserved for
   * deletion and application shutdown.
   */
  private activateSession(managed: ManagedSession, remember = true): void {
    this.activeSession = managed
    if (remember) {
      this.activateFolder(managed.cwd)
      return
    }
    if (this.cwd !== managed.cwd || !this.fileIndex) {
      this.fileIndex = new FileIndex(managed.cwd)
      void this.fileIndex.refresh(true).catch(() => {})
    }
    this.cwd = managed.cwd
  }

  private routeEvent(managed: ManagedSession, event: AgentSessionEvent): void {
    managed.eventSequence += 1
    const routed = {
      ...event,
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      eventSequence: managed.eventSequence
    } as PiEvent

    // Usage (and cost) move on completed messages and compaction boundaries —
    // the composer ring rides along instead of polling.
    if (event.type === 'message_end' || event.type === 'compaction_end') {
      ;(routed as any).contextUsage = this.contextUsageOf(managed)
    }
    // Compaction rewrites the session's message list (the summary replaces the
    // summarized tail). Ship the new list with the event so the transcript
    // collapses at the same moment the notice appears instead of keeping a
    // pre-compaction view until the next session switch.
    if (event.type === 'compaction_end' && !(event as any).aborted) {
      ;(routed as any).messages = serialize(managed.session.messages)
    }

    if (event.type === 'message_start' || event.type === 'message_update') {
      if ((event as any).message?.role === 'assistant') managed.streaming = (event as any).message
    } else if (event.type === 'message_end') {
      if ((event as any).message?.role === 'assistant') managed.streaming = null
    } else if (event.type === 'tool_execution_start') {
      managed.toolRuns[(event as any).toolCallId] = {
        toolCallId: (event as any).toolCallId,
        toolName: (event as any).toolName,
        args: (event as any).args,
        status: 'running',
        partial: undefined,
        startedAt: Date.now()
      }
    } else if (event.type === 'tool_execution_update') {
      const run = managed.toolRuns[(event as any).toolCallId]
      if (run) managed.toolRuns[(event as any).toolCallId] = { ...run, partial: (event as any).partialResult }
    } else if (event.type === 'tool_execution_end') {
      const run = managed.toolRuns[(event as any).toolCallId]
      if (run) {
        managed.toolRuns[(event as any).toolCallId] = {
          ...run,
          status: (event as any).isError ? 'error' : 'success',
          endedAt: Date.now(),
          partial: (event as any).result ?? run.partial
        }
      }
    } else if (event.type === 'queue_update') {
      managed.queue = { steering: [...(event as any).steering], followUp: [...(event as any).followUp] }
    } else if (event.type === 'agent_end') {
      managed.streaming = null
    }

    if (event.type !== 'message_update' && event.type !== 'tool_execution_update') {
      this.flushStreamEvents(managed)
      this.emit('pi:event', serialize(routed))
      return
    }
    const key = event.type === 'message_update' ? 'message_update' : `tool_execution_update:${(event as any).toolCallId}`
    managed.pendingStreamEvents.set(key, routed)
    if (!managed.streamFlushTimer) {
      const assistantUpdateType =
        event.type === 'message_update' ? (event as any).assistantMessageEvent?.type : undefined
      const toolHeavyUpdate =
        event.type === 'tool_execution_update' ||
        (typeof assistantUpdateType === 'string' && assistantUpdateType.startsWith('toolcall_'))
      managed.streamFlushTimer = setTimeout(() => {
        managed.streamFlushTimer = null
        this.flushStreamEvents(managed)
      }, toolHeavyUpdate ? TOOL_STREAM_FLUSH_MS : STREAM_FLUSH_MS)
    }
  }

  private flushStreamEvents(managed: ManagedSession): void {
    if (managed.streamFlushTimer) {
      clearTimeout(managed.streamFlushTimer)
      managed.streamFlushTimer = null
    }
    for (const event of managed.pendingStreamEvents.values()) {
      // Background sessions keep running, but their cumulative hot snapshots
      // stay in the main process until selected. This avoids wasting IPC and
      // renderer work on output the user cannot currently see.
      if (managed !== this.activeSession) continue
      if (event.type === 'message_update') delete event.assistantMessageEvent
      this.emit('pi:event', serialize(event))
    }
    managed.pendingStreamEvents.clear()
  }

  private emitSessionError(managed: ManagedSession, message: string): void {
    managed.streaming = null
    this.emit('pi:event', {
      type: 'pi_error',
      message,
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      eventSequence: ++managed.eventSequence
    })
  }

  private disposeAllSessions(): void {
    for (const managed of [...this.sessions.values()]) this.disposeManaged(managed)
  }

  /**
   * `SessionManager.create()` keeps a brand-new session in memory until the
   * first assistant message is appended (the `hasAssistant` gate in its
   * private `_persist`), so it stays invisible to `SessionManager.list*()` and
   * would be lost the moment the user switches to another session. Write the
   * header to disk up front and reload it through the manager, which marks the
   * session flushed so later appends are incremental.
   */
  private materializeSession(sessionManager: SessionManager): void {
    const file = sessionManager.getSessionFile()
    const header = sessionManager.getHeader()
    if (!file || !header || existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx' })
    sessionManager.setSessionFile(file)
  }

  private async buildSession(
    sessionManager: SessionManager,
    /** `false` after a project deletion, where an empty session file should
     * not immediately resurface the folder just removed. */
    materialize = true,
    navigationEpoch = this.navigationEpoch
  ): Promise<AgentSession> {
    const shouldActivate = () => navigationEpoch === this.navigationEpoch
    if (materialize) this.materializeSession(sessionManager)
    const requestedPath = sessionManager.getSessionFile()
    if (requestedPath) {
      const existing = this.sessions.get(requestedPath)
      if (existing) {
        if (shouldActivate()) this.activateSession(existing)
        return existing.session
      }
    }
    const services = await this.servicesFor(sessionManager.getCwd())
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
    })
    const path = session.sessionFile ?? requestedPath ?? `memory:${session.sessionId}`
    const managed: ManagedSession = {
      session,
      path,
      cwd: sessionManager.getCwd(),
      unsubscribe: () => {},
      pendingStreamEvents: new Map(),
      streamFlushTimer: null,
      streaming: null,
      toolRuns: {},
      queue: { steering: [], followUp: [] },
      eventSequence: 0
    }
    managed.unsubscribe = session.subscribe((event: AgentSessionEvent) => this.routeEvent(managed, event))
    this.sessions.set(path, managed)
    if (shouldActivate()) this.activateSession(managed, materialize)
    return session
  }

  snapshot(): SessionSnapshotDTO {
    const managed = this.activeSession
    if (!managed || !this.cwd) throw new Error('Pi session is not initialized')
    this.flushStreamEvents(managed)
    const messages = serialize(managed.session.messages) as ChatMessage[]
    const live = managed.streaming as ChatMessage | null
    if (live?.role === 'assistant') {
      const index = messages.findLastIndex(
        (message) => message.role === 'assistant' && message.timestamp === live.timestamp
      )
      if (index >= 0) messages.splice(index, 1)
    }
    return {
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      messages,
      streaming: serialize(managed.streaming) as any,
      toolRuns: serialize(managed.toolRuns),
      queue: managed.queue,
      model: modelRef(managed.session.model),
      thinkingLevel: (managed.session.thinkingLevel ?? 'medium') as ThinkingLevel,
      availableThinkingLevels: managed.session.getAvailableThinkingLevels() as ThinkingLevel[],
      isStreaming: managed.session.isStreaming,
      contextUsage: this.contextUsageOf(managed),
      eventSequence: managed.eventSequence
    }
  }

  /**
   * SDK-authoritative context usage plus the session's true running totals.
   * `getSessionStats()` aggregates every session entry — messages compacted out
   * of the context and tool-result usage included — which summing
   * `session.messages` alone would undercount.
   */
  private contextUsageOf(managed: ManagedSession): ContextUsageDTO | null {
    const stats = managed.session.getSessionStats()
    const usage = stats.contextUsage
    if (!usage || !usage.contextWindow) return null
    const cacheable = stats.tokens.cacheRead + stats.tokens.input
    return {
      tokens: usage.tokens ?? null,
      contextWindow: usage.contextWindow,
      percent: usage.percent ?? null,
      sessionCost: stats.cost,
      cacheHitRate: cacheable > 0 ? Math.min(stats.tokens.cacheRead / cacheable, 1) : null
    }
  }

  /** Initialize (or re-initialize for a new cwd) with the most recent session. */
  async init(cwd: string): Promise<SessionSnapshotDTO> {
    const navigationEpoch = ++this.navigationEpoch
    const sessions = await SessionManager.list(cwd).catch(() => [])
    const latest = sessions[0]
    const sessionManager = latest
      ? SessionManager.open(latest.path)
      : SessionManager.create(cwd)
    await this.buildSession(sessionManager, true, navigationEpoch)
    return this.snapshot()
  }

  /** New session. `cwd` targets a specific folder; omitted uses the active one. */
  async newSession(cwd?: string): Promise<SessionSnapshotDTO> {
    const navigationEpoch = ++this.navigationEpoch
    const target = cwd ?? this.cwd
    if (!target) throw new Error('No working directory selected')
    await this.buildSession(SessionManager.create(target), true, navigationEpoch)
    return this.snapshot()
  }

  /**
   * Open a session file. `cwd` is the folder the sidebar item belongs to; when
   * omitted the session header's own cwd is used. Switches the active
   * workspace folder if the session belongs to a different one.
   */
  async openSession(path: string, cwd?: string): Promise<SessionSnapshotDTO> {
    const navigationEpoch = ++this.navigationEpoch
    const existing = this.sessions.get(path)
    if (existing) {
      this.activateSession(existing)
      return this.snapshot()
    }
    const sessionManager = SessionManager.open(path)
    const folder = cwd ?? sessionManager.getHeader()?.cwd ?? this.cwd
    if (!folder) throw new Error('No working directory selected')
    await this.buildSession(sessionManager, true, navigationEpoch)
    return this.snapshot()
  }

  /**
   * Sessions of every known folder (opened in the app, or seen in the session
   * store), newest first within each folder. Each entry carries its folder so
   * the sidebar can group them.
   */
  async listSessions(): Promise<SessionSummaryDTO[]> {
    const infos = await SessionManager.listAll().catch(() => [])
    const byFolder = new Map<string, typeof infos>()
    for (const info of infos) {
      if (!info.cwd) continue
      const list = byFolder.get(info.cwd) ?? []
      list.push(info)
      byFolder.set(info.cwd, list)
    }
    const folderRecency = (sessions: typeof infos) =>
      sessions.reduce((max, s) => Math.max(max, s.modified.getTime()), 0)
    const orderedFolders = [
      ...(this.cwd ? [this.cwd] : []),
      ...this.folders.filter((f) => f !== this.cwd),
      // Folders with sessions but never opened here (e.g. pi CLI projects),
      // most recently modified first.
      ...[...byFolder.entries()]
        .filter(([folder]) => folder !== this.cwd && !this.folders.includes(folder))
        .sort(([, a], [, b]) => folderRecency(b) - folderRecency(a))
        .map(([folder]) => folder)
    ]
    const seen = new Set<string>()
    const summaries: SessionSummaryDTO[] = []
    for (const folder of orderedFolders) {
      if (seen.has(folder)) continue
      seen.add(folder)
      const sessions = (byFolder.get(folder) ?? []).slice().sort((a, b) => b.modified.getTime() - a.modified.getTime())
      for (const s of sessions) {
        // A freshly materialized session has a header but no messages yet; keep
        // it off the sidebar until its first user message exists to name it.
        if (s.messageCount === 0) continue
        summaries.push({
          path: s.path,
          id: s.id,
          // No prose here: an empty session carries `null` so the renderer can
          // label it in the active locale.
          label: s.name?.trim() || (s.messageCount > 0 ? s.firstMessage?.trim().slice(0, 80) || null : null),
          modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
          messageCount: s.messageCount,
          cwd: folder,
          running: this.sessions.get(s.path)?.session.isStreaming ?? false
        })
      }
    }
    return summaries
  }

  /** Drop a folder from the known list (and stop treating it as active). */
  private forgetFolder(cwd: string): void {
    this.folders = this.folders.filter((f) => f !== cwd)
    saveSettings({
      ...loadSettings(),
      folders: this.folders,
      ...(this.cwd === cwd ? { cwd: null } : {})
    })
  }

  /**
   * Set (or clear) a session's display name — the `session_info` entry the
   * sidebar reads and the pi CLI shares. A live session appends through its
   * AgentSession so the change lands in its transcript; an inactive file is
   * opened just to append the entry.
   */
  async renameSession(path: string, name: string): Promise<void> {
    // Empty names clear the title (SessionManager.getSessionName treats them
    // as an explicit clear).
    const managed = this.sessions.get(path)
    if (managed) {
      managed.session.setSessionName(name)
      return
    }
    SessionManager.open(path).appendSessionInfo(name)
  }

  /**
   * Move a session file to the OS trash. If it was the open session, fall
   * back to the folder's most recent remaining session (or a fresh one).
   * Returns the snapshot to re-apply, or null when nothing is open anymore.
   */
  async deleteSession(path: string): Promise<SessionSnapshotDTO | null> {
    ++this.navigationEpoch
    const managed = this.sessions.get(path)
    if (managed) this.disposeManaged(managed)
    await shell.trashItem(path).catch(() => {})
    if (!this.activeSession && this.cwd) {
      const sessions = await SessionManager.list(this.cwd).catch(() => [])
      const latest = sessions[0]
      await this.buildSession(latest ? SessionManager.open(latest.path) : SessionManager.create(this.cwd))
    }
    return this.activeSession ? this.snapshot() : null
  }

  /**
   * Trash every session belonging to a folder and forget the folder. If it is
   * the active workspace, a fresh empty session is opened there so the
   * workspace keeps running — but the folder still leaves the known list, so
   * the sidebar only shows it again once a session in it exists.
   */
  async deleteFolderSessions(cwd: string): Promise<SessionSnapshotDTO | null> {
    ++this.navigationEpoch
    const infos = await SessionManager.listAll().catch(() => [])
    const targets = infos.filter((info) => info.cwd === cwd)
    const managedTargets = [...this.sessions.values()].filter((managed) => managed.cwd === cwd)
    const wasActive = this.activeSession?.cwd === cwd
    for (const managed of managedTargets) this.disposeManaged(managed)
    const paths = new Set([...targets.map((info) => info.path), ...managedTargets.map((managed) => managed.path)])
    await Promise.all([...paths].map((path) => shell.trashItem(path).catch(() => {})))
    this.forgetFolder(cwd)
    if (wasActive) {
      await this.buildSession(SessionManager.create(cwd), false)
    }
    return this.activeSession ? this.snapshot() : null
  }

  /**
   * Send a prompt. Image attachments go straight to the model; referenced
   * local files are read here and inlined as `<file path>` blocks.
   */
  prompt(payload: PromptPayload): void {
    const managed = this.activeSession
    const session = managed?.session
    if (!managed || !session) {
      this.notifyError('Pi session is not initialized. Pick a working directory first.')
      return
    }
    void (async () => {
      try {
        // A replacement session kept after project deletion intentionally has
        // no file yet. The first real prompt makes it durable and restores the
        // project to the known-folder list before any asynchronous work.
        if (!existsSync(managed.path)) {
          this.materializeSession(session.sessionManager)
          this.rememberFolder(managed.cwd)
        }
        const fileBlocks = await this.readFileBlocks(payload.files)
        const text = fileBlocks ? `${payload.text}\n\n${fileBlocks}` : payload.text
        // streamingBehavior only matters while streaming (AgentSession.prompt
        // decides atomically: idle → new run, busy → steer/followUp queue), so
        // a queue request that races a settling run still lands as a prompt.
        await session.prompt(text, {
          images: payload.images,
          streamingBehavior: session.isStreaming ? (payload.streamingBehavior ?? 'steer') : undefined
        })
      } catch (error) {
        this.emitSessionError(managed, error instanceof Error ? error.message : String(error))
      }
    })()
  }

  private async readFileBlocks(paths: string[]): Promise<string> {
    const fileIndex = this.fileIndex
    if (!paths.length || !fileIndex) return ''
    const blocks: string[] = []
    for (const path of paths.slice(0, 12)) {
      try {
        const preview: FilePreviewDTO = await readAttachment(fileIndex, path)
        if (preview.kind === 'image') {
          blocks.push(`<file path="${preview.relPath}">(image attachment, ${Math.round(preview.size / 1024)} KB)</file>`)
        } else if (preview.kind === 'text' && preview.text !== undefined) {
          const note = preview.truncated ? '\n(truncated)' : ''
          blocks.push(`<file path="${preview.relPath}">\n${preview.text}${note}\n</file>`)
        } else {
          blocks.push(`<file path="${preview.relPath}">(binary file, ${Math.round(preview.size / 1024)} KB)</file>`)
        }
      } catch (error) {
        blocks.push(`<file path="${path}">(could not be read: ${error instanceof Error ? error.message : 'unknown error'})</file>`)
      }
    }
    return blocks.join('\n\n')
  }

  /**
   * Clear the active session's queued steering/follow-up messages and return
   * their texts so the renderer can put them back into the composer. SDK
   * clearQueue() empties both queue layers, emits `queue_update` (which
   * refreshes managed.queue through the event route) and is the only dequeue.
   */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const managed = this.activeSession
    if (!managed) return { steering: [], followUp: [] }
    return managed.session.clearQueue()
  }

  /**
   * The `message`-type session entry on the current branch whose message has
   * the given role and timestamp. The entry id is what navigateTree and
   * createBranchedSession address; timestamps are unique per session message.
   */
  private findMessageEntry(
    managed: ManagedSession,
    role: 'user' | 'assistant',
    timestamp: number
  ): { id: string; parentId: string | null; message: { role: string; timestamp: number; content: any } } | null {
    for (const entry of managed.session.sessionManager.buildContextEntries()) {
      if (entry.type !== 'message') continue
      const message = entry.message as { role?: string; timestamp?: number }
      if (message.role === role && message.timestamp === timestamp) {
        return { id: entry.id, parentId: entry.parentId, message: entry.message as any }
      }
    }
    return null
  }

  /**
   * Resend a user message — also the engine of "retry this response": rewind
   * the session to just before the message (navigateTree stays in the same
   * file; the abandoned branch remains in the session tree) and immediately
   * re-prompt with the stored text and image attachments. A message that never
   * persisted (a failed send left only the renderer's optimistic echo) is
   * simply re-prompted without rewinding.
   */
  async resendMessage(payload: ResendPayload): Promise<SessionSnapshotDTO> {
    const managed = this.activeSession
    const session = managed?.session
    if (!managed || !session) throw new Error('No active session')
    if (session.isStreaming) throw new Error('Wait for the current response to finish')

    let text = payload.text
    let images = payload.images
    const entry = this.findMessageEntry(managed, 'user', payload.timestamp)
    if (entry) {
      const content = Array.isArray(entry.message.content) ? entry.message.content : []
      images = content.filter((part): part is ImageContent => part.type === 'image')
      const sessionManager = session.sessionManager
      if (sessionManager.getLeafId() === entry.id) {
        // The user message is already the leaf — its run died before any
        // assistant output — so navigateTree(targetId) would no-op. Rewind by
        // hand the way it does internally: move the leaf to the parent (or
        // reset to an empty root) and rebuild the agent's message list.
        if (entry.parentId) sessionManager.branch(entry.parentId)
        else sessionManager.resetLeaf()
        session.agent.state.messages = sessionManager.buildSessionContext().messages
      } else {
        const result = await session.navigateTree(entry.id)
        if (result.cancelled) throw new Error('Resend cancelled')
        if (result.editorText) text = result.editorText
      }
      // navigateTree (and the manual rewind) emit no AgentSession event; bump
      // the sequence so the renderer cannot mistake the returned snapshot for
      // one it already rendered.
      managed.eventSequence += 1
    }
    if (!text && !images.length) throw new Error('Nothing to resend')

    void session.prompt(text, { images }).catch((error) =>
      this.emitSessionError(managed, error instanceof Error ? error.message : String(error))
    )
    return this.snapshot()
  }

  /**
   * Fork the active session at an assistant message: the new file contains the
   * branch up to and including that message, is opened as the active session
   * and shows up in the sidebar like any other session. The fork keeps the
   * source's label (name or first user message) so the renderer can compose
   * the "Fork of …" title.
   */
  async forkFromMessage(timestamp: number): Promise<ForkResultDTO> {
    const managed = this.activeSession
    if (!managed) throw new Error('No active session')
    const entry = this.findMessageEntry(managed, 'assistant', timestamp)
    if (!entry) throw new Error('Message not found')
    const sessionManager = managed.session.sessionManager
    const file = sessionManager.getSessionFile()
    if (!file || !existsSync(file)) throw new Error('The session has not been saved yet')

    const forkedPath = sessionManager.createBranchedSession(entry.id)
    if (!forkedPath) throw new Error('Failed to create the forked session')

    let baseLabel = managed.session.sessionName?.trim() || null
    if (!baseLabel) {
      for (const candidate of sessionManager.buildContextEntries()) {
        if (candidate.type !== 'message') continue
        const message = candidate.message as { role?: string; content?: unknown }
        if (message.role !== 'user') continue
        const content = message.content
        baseLabel =
          (typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? (content as { type: string; text?: string }[])
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
                  .join('\n')
              : ''
          )
            ?.trim()
            .slice(0, 80) || null
        break
      }
    }

    const navigationEpoch = ++this.navigationEpoch
    await this.buildSession(SessionManager.open(forkedPath), true, navigationEpoch)
    return { snapshot: this.snapshot(), baseLabel }
  }

  abort(): void {
    void this.activeSession?.session.abort().catch(() => {})
  }

  async setModel(providerId: string, modelId: string): Promise<SessionSnapshotDTO> {
    const managed = this.activeSession
    const runtime = await this.runtime()
    const model = runtime.getModel(providerId, modelId)
    if (!model) throw new Error(`Unknown model ${providerId}/${modelId}`)
    if (managed) {
      await managed.session.setModel(model)
      return this.snapshot()
    }
    throw new Error('No active session')
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionSnapshotDTO> {
    if (!this.activeSession) throw new Error('No active session')
    this.activeSession.session.setThinkingLevel(level)
    return this.snapshot()
  }

  async providers(): Promise<ProviderDTO[]> {
    const runtime = await this.runtime()
    const config = readModelsConfig()
    const builtinIds = await builtinProviderIds()
    const builtinBaseUrls = await builtinProviderBaseUrls()
    const providers: ProviderDTO[] = []
    const seen = new Set<string>()
    for (const provider of runtime.getProviders()) {
      const auth = provider.auth as any
      const authTypes: ('api_key' | 'oauth')[] = []
      if (auth?.apiKey) authTypes.push('api_key')
      if (auth?.oauth) authTypes.push('oauth')
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      const api = (provider.getModels()[0] as any)?.api as string | undefined
      const custom = Object.prototype.hasOwnProperty.call(config.providers, provider.id)
      providers.push({
        id: provider.id,
        name: provider.name,
        authTypes,
        authenticated: Boolean(check),
        authSource: check?.source,
        canLogin: Boolean(auth?.apiKey?.login) || Boolean(auth?.oauth?.login),
        builtin: builtinIds.has(provider.id),
        custom,
        api,
        baseUrl: builtinBaseUrls.get(provider.id),
        discoverable: custom
          ? supportsModelDiscovery(config.providers[provider.id]?.api ?? api)
          : supportsModelDiscovery(api)
      })
      seen.add(provider.id)
    }
    // models.json entries that did not compose (brand-new, or not yet valid
    // enough for the runtime) still need a row so the user can finish or fix
    // them in the editor.
    for (const [providerId, entry] of Object.entries(config.providers)) {
      if (seen.has(providerId)) continue
      providers.push({
        id: providerId,
        name: entry.name || providerId,
        authTypes: [],
        authenticated: false,
        canLogin: false,
        builtin: builtinIds.has(providerId),
        custom: true,
        api: entry.api,
        baseUrl: entry.baseUrl ?? builtinBaseUrls.get(providerId),
        discoverable: Boolean(entry.baseUrl) && supportsModelDiscovery(entry.api)
      })
    }
    return providers
  }

  // ---- models.json editing (Settings → Providers) ----

  modelsConfig(): ModelsConfigDTO {
    return readModelsConfig()
  }

  /** Persist the edited config and reload the shared runtime in place, so
   * every session built on it sees new providers/models immediately. */
  async saveModelsConfig(config: ModelsConfigDTO): Promise<ModelsConfigDTO> {
    const written = writeModelsConfig(config)
    await (await this.runtime()).refresh()
    return written
  }

  async providerModels(providerId: string): Promise<ProviderModelDTO[]> {
    return providerInventory(await this.runtime(), providerId)
  }

  async discoverProviderModels(providerId: string): Promise<DiscoveredModelDTO[]> {
    return discoverModels(providerId, await this.runtime())
  }

  async testProviderModel(providerId: string, model: CustomModelDTO): Promise<TestModelResultDTO> {
    return testModel(providerId, model)
  }

  /** models.dev parameter preset for a model id, matched to this provider. */
  async catalogPreset(providerId: string, modelId: string): Promise<CatalogRecommendationDTO> {
    const entry = readModelsConfig().providers[providerId]
    const baseUrl = entry?.baseUrl ?? (await this.runtime()).getProvider(providerId)?.getModels()[0]?.baseUrl ?? ''
    return recommendCatalogPreset(modelId, providerId, baseUrl ?? '')
  }

  /** Composed models of configured providers — the copy-config source list. */
  async configuredModelSources(): Promise<ModelConfigSourceDTO[]> {
    return configuredModels(await this.runtime())
  }

  // ---- default model (~/.pi/agent/settings.json, shared with the pi CLI) ----

  private settingsManager(): SettingsManager {
    this.settingsManagerInstance ??= SettingsManager.create(this.cwd ?? homedir())
    return this.settingsManagerInstance
  }

  defaultModel(): DefaultModelDTO | null {
    const manager = this.settingsManager()
    const providerId = manager.getDefaultProvider()
    const modelId = manager.getDefaultModel()
    return providerId && modelId ? { providerId, modelId } : null
  }

  async setDefaultModel(providerId: string, modelId: string): Promise<void> {
    const manager = this.settingsManager()
    manager.setDefaultModelAndProvider(providerId, modelId)
    await manager.flush()
  }

  async models(): Promise<ModelDTO[]> {
    const runtime = await this.runtime()
    const available = new Set(
      (await runtime.getAvailable().catch(() => [])).map((m: any) => `${m.provider}/${m.id}`)
    )
    const providerName = new Map(runtime.getProviders().map((p) => [p.id, p.name]))
    const models: ModelDTO[] = []
    for (const provider of runtime.getProviders()) {
      for (const model of provider.getModels()) {
        const anyModel = model as any
        models.push({
          providerId: anyModel.provider,
          providerName: providerName.get(anyModel.provider) ?? anyModel.provider,
          id: anyModel.id,
          name: anyModel.name ?? anyModel.id,
          reasoning: Boolean(anyModel.reasoning),
          input: (anyModel.input ?? ['text']) as string[],
          contextWindow: anyModel.contextWindow ?? 0,
          maxTokens: anyModel.maxTokens ?? 0,
          available: available.has(`${anyModel.provider}/${anyModel.id}`),
          costInputPerM: (anyModel.cost?.input ?? 0) * 1_000_000,
          costOutputPerM: (anyModel.cost?.output ?? 0) * 1_000_000
        })
      }
    }
    return models
  }

  /**
   * Interactive login bridged to the renderer: pi asks questions through
   * `pi:auth-prompt` events and the renderer answers via `pi:auth-reply`.
   */
  async login(providerId: string, kind: 'api_key' | 'oauth'): Promise<void> {
    const runtime = await this.runtime()
    const provider = runtime.getProviders().find((p) => p.id === providerId)
    if (!provider) throw new Error(`Unknown provider ${providerId}`)

    const interaction = {
      prompt: async (prompt: any): Promise<string> => {
        const requestId = `${providerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
        const normalizedKind =
          prompt.type === 'text'
            ? 'text'
            : prompt.type === 'secret'
              ? 'secret'
              : prompt.type === 'select'
                ? 'select'
                : 'manual_code'
        this.emit('pi:auth-prompt', {
          requestId,
          providerId,
          kind: normalizedKind,
          message: prompt.message,
          placeholder: prompt.placeholder,
          options: prompt.options
        })
        return new Promise<string>((resolve, reject) => {
          const signal: AbortSignal | undefined = prompt.signal
          const dismiss = () => this.emit('pi:auth-dismiss', { requestId })
          let timer: ReturnType<typeof setTimeout>
          const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            this.pendingAuth.delete(requestId)
          }
          // The SDK can settle a prompt out of band (a manual-code prompt losing
          // a race to its callback server) — close the dialog then too.
          const onAbort = () => {
            cleanup()
            dismiss()
            reject(new Error('Login prompt cancelled'))
          }
          timer = setTimeout(() => {
            cleanup()
            dismiss()
            reject(new Error('Login timed out'))
          }, 5 * 60_000)
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          this.pendingAuth.set(requestId, {
            resolve: (value) => {
              cleanup()
              resolve(value)
            },
            reject: (error) => {
              cleanup()
              reject(error)
            }
          })
        })
      },
      notify: (event: any) => {
        this.emit('pi:auth-notify', { providerId, ...event })
      }
    }

    try {
      await runtime.login(providerId, kind, interaction as any)
    } finally {
      for (const pending of this.pendingAuth.values()) {
        pending.reject(new Error('Login cancelled'))
      }
      this.pendingAuth.clear()
    }
  }

  /** Called by the IPC layer when the renderer answers a login prompt. */
  resolveAuthPrompt(reply: { requestId: string; value: string | null }): void {
    const pending = this.pendingAuth.get(reply.requestId)
    if (!pending) return
    if (reply.value === null || reply.value === undefined) {
      pending.reject(new Error('Login cancelled'))
    } else {
      pending.resolve(reply.value)
    }
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.runtime()
    await runtime.logout(providerId)
  }

  async searchFiles(query: string) {
    if (!this.fileIndex) return []
    await this.fileIndex.refresh().catch(() => {})
    return this.fileIndex.search(query)
  }

  async readFile(path: string): Promise<FilePreviewDTO> {
    if (!this.fileIndex) throw new Error('No working directory selected')
    return readAttachment(this.fileIndex, path)
  }

  readImage(path: string): Promise<ImageContent | null> {
    return this.readFile(path).then((preview) =>
      preview.kind === 'image' && preview.base64 && preview.mimeType
        ? { type: 'image', data: preview.base64, mimeType: preview.mimeType }
        : null
    )
  }

  dispose(): void {
    this.disposeAllSessions()
  }
}
