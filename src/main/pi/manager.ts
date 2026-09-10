import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent
} from '@earendil-works/pi-coding-agent'
import { shell } from 'electron'
import { FileIndex, readAttachment } from './files'
import { loadSettings, saveSettings } from '../settings'
import type {
  ChatMessage,
  FilePreviewDTO,
  ImageContent,
  ModelDTO,
  ModelRefDTO,
  ProviderDTO,
  PromptPayload,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  ThinkingLevel
} from '../../shared/types'

/** How many opened folders to keep in the sidebar/settings list. */
const MAX_FOLDERS = 12

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

export class PiManager {
  private modelRuntime: ModelRuntime | null = null
  private session: AgentSession | null = null
  private unsubscribe: (() => void) | null = null
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
    this.cwd = cwd
    this.fileIndex = new FileIndex(cwd)
    void this.fileIndex.refresh(true).catch(() => {})
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

  private teardownSession(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session?.dispose()
    this.session = null
  }

  private async buildSession(sessionManager: SessionManager): Promise<AgentSession> {
    const modelRuntime = await this.runtime()
    this.teardownSession()
    const { session } = await createAgentSession({
      cwd: this.cwd ?? undefined,
      sessionManager,
      modelRuntime,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
    })
    this.session = session
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.emit('pi:event', serialize(event))
    })
    return session
  }

  snapshot(): SessionSnapshotDTO {
    const session = this.session
    if (!session || !this.cwd) {
      throw new Error('Pi session is not initialized')
    }
    return {
      sessionId: session.sessionId,
      sessionPath: session.sessionFile,
      cwd: this.cwd,
      messages: serialize(session.messages) as ChatMessage[],
      model: modelRef(session.model),
      thinkingLevel: (session.thinkingLevel ?? 'medium') as ThinkingLevel,
      isStreaming: session.isStreaming
    }
  }

  /** Initialize (or re-initialize for a new cwd) with the most recent session. */
  async init(cwd: string): Promise<SessionSnapshotDTO> {
    this.activateFolder(cwd)
    const sessions = await SessionManager.list(cwd).catch(() => [])
    const latest = sessions[0]
    const sessionManager = latest
      ? SessionManager.open(latest.path)
      : SessionManager.create(cwd)
    await this.buildSession(sessionManager)
    return this.snapshot()
  }

  async newSession(): Promise<SessionSnapshotDTO> {
    if (!this.cwd) throw new Error('No working directory selected')
    await this.buildSession(SessionManager.create(this.cwd))
    return this.snapshot()
  }

  /**
   * Open a session file. `cwd` is the folder the sidebar item belongs to; when
   * omitted the session header's own cwd is used. Switches the active
   * workspace folder if the session belongs to a different one.
   */
  async openSession(path: string, cwd?: string): Promise<SessionSnapshotDTO> {
    const sessionManager = SessionManager.open(path)
    const folder = cwd ?? sessionManager.getHeader()?.cwd ?? this.cwd
    if (!folder) throw new Error('No working directory selected')
    if (folder !== this.cwd) this.activateFolder(folder)
    await this.buildSession(sessionManager)
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
        summaries.push({
          path: s.path,
          id: s.id,
          label: s.name?.trim() || s.firstMessage?.trim().slice(0, 80) || 'Untitled session',
          modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
          messageCount: s.messageCount,
          cwd: folder
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
   * Move a session file to the OS trash. If it was the open session, fall
   * back to the folder's most recent remaining session (or a fresh one).
   * Returns the snapshot to re-apply, or null when nothing is open anymore.
   */
  async deleteSession(path: string): Promise<SessionSnapshotDTO | null> {
    await shell.trashItem(path).catch(() => {})
    if (this.session?.sessionFile === path && this.cwd) {
      const sessions = await SessionManager.list(this.cwd).catch(() => [])
      const latest = sessions[0]
      await this.buildSession(latest ? SessionManager.open(latest.path) : SessionManager.create(this.cwd))
    }
    return this.session ? this.snapshot() : null
  }

  /**
   * Trash every session belonging to a folder and forget the folder. If it is
   * the active workspace, a fresh empty session is opened there so the
   * workspace keeps running — but the folder still leaves the known list, so
   * the sidebar only shows it again once a session in it exists.
   */
  async deleteFolderSessions(cwd: string): Promise<SessionSnapshotDTO | null> {
    const infos = await SessionManager.listAll().catch(() => [])
    const targets = infos.filter((info) => info.cwd === cwd)
    await Promise.all(targets.map((info) => shell.trashItem(info.path).catch(() => {})))
    this.forgetFolder(cwd)
    if (this.cwd === cwd) {
      await this.buildSession(SessionManager.create(cwd))
    }
    return this.session ? this.snapshot() : null
  }

  /**
   * Send a prompt. Image attachments go straight to the model; referenced
   * local files are read here and inlined as `<file path>` blocks.
   */
  prompt(payload: PromptPayload): void {
    const session = this.session
    if (!session) {
      this.notifyError('Pi session is not initialized. Pick a working directory first.')
      return
    }
    void (async () => {
      try {
        const fileBlocks = await this.readFileBlocks(payload.files)
        const text = fileBlocks ? `${payload.text}\n\n${fileBlocks}` : payload.text
        await session.prompt(text, {
          images: payload.images,
          streamingBehavior: session.isStreaming ? 'steer' : undefined
        })
      } catch (error) {
        this.notifyError(error instanceof Error ? error.message : String(error))
        this.emit('pi:event', { type: 'agent_end', messages: [], willRetry: false })
      }
    })()
  }

  private async readFileBlocks(paths: string[]): Promise<string> {
    if (!paths.length || !this.fileIndex) return ''
    const blocks: string[] = []
    for (const path of paths.slice(0, 12)) {
      try {
        const preview: FilePreviewDTO = await readAttachment(this.fileIndex, path)
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

  steer(text: string): void {
    const session = this.session
    if (!session) return
    void session.steer(text).catch((error) =>
      this.notifyError(error instanceof Error ? error.message : String(error))
    )
  }

  abort(): void {
    void this.session?.abort().catch(() => {})
  }

  async setModel(providerId: string, modelId: string): Promise<SessionSnapshotDTO> {
    const runtime = await this.runtime()
    const model = runtime.getModel(providerId, modelId)
    if (!model) throw new Error(`Unknown model ${providerId}/${modelId}`)
    if (this.session) {
      await this.session.setModel(model)
      return this.snapshot()
    }
    throw new Error('No active session')
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionSnapshotDTO> {
    if (!this.session) throw new Error('No active session')
    this.session.setThinkingLevel(level)
    return this.snapshot()
  }

  async providers(): Promise<ProviderDTO[]> {
    const runtime = await this.runtime()
    const available = new Set(
      (await runtime.getAvailable().catch(() => [])).map((m: any) => `${m.provider}/${m.id}`)
    )
    const providers: ProviderDTO[] = []
    for (const provider of runtime.getProviders()) {
      const auth = provider.auth as any
      const authTypes: ('api_key' | 'oauth')[] = []
      if (auth?.apiKey) authTypes.push('api_key')
      if (auth?.oauth) authTypes.push('oauth')
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      providers.push({
        id: provider.id,
        name: provider.name,
        authTypes,
        authenticated: Boolean(check),
        authSource: check?.source,
        canLogin: Boolean(auth?.apiKey?.login) || Boolean(auth?.oauth?.login)
      })
    }
    return providers
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
          const timer = setTimeout(() => {
            this.pendingAuth.delete(requestId)
            reject(new Error('Login timed out'))
          }, 5 * 60_000)
          this.pendingAuth.set(requestId, {
            resolve: (value) => {
              clearTimeout(timer)
              this.pendingAuth.delete(requestId)
              resolve(value)
            },
            reject: (error) => {
              clearTimeout(timer)
              this.pendingAuth.delete(requestId)
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
    this.teardownSession()
  }
}
