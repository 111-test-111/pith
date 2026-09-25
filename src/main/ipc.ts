import { app, ipcMain, dialog, session, shell, webContents, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerPlanIpc } from './pi/plan-ipc'
import { PiManager } from './pi/manager'
import { ScheduledTaskError } from './pi/scheduled-tasks/service'
import type { JevSettingsUpdate, ScheduledTaskResult } from '../shared/types'
import { TerminalManager } from './terminal/manager'
import { registerQuitHandler } from './shutdown'
import { isDefaultWorkspace } from './pi/default-workspace'
import { loadSettings, saveSettings } from './settings'
import { getBrowserService, initBrowserService } from './browser/service'
import { setAppShortcutIdentities } from './browser/wiring.ts'
import { getCdpPort } from './browser/cdp-port'
import {
  browserImportRecordPath,
  clearImportedCookies,
  discoverChrome,
  importChromeCookies,
  makeSessionApply,
  readImportStatus
} from './browser/import-cookies'
import { BROWSER_PARTITION, HUMAN_OWNER } from '../shared/browser'
import type { BrowserFocusGuestPayload, BrowserSeenPayload } from '../shared/browser'
import { sandboxStatus } from './sandbox/broker'
import { setWindowTheme } from './window-chrome'
import { listFileDirectory, readFileDocument, readFileGitDiff } from './file-browser'
import { readPdfRange, readPdfStat } from './pdf'
import { readFontData } from './font'
import { htmlPreviews } from './html-preview'
import { readTableRange, readTableSlice, readTableStat } from './table'
import { saveFileCopy } from './file-actions'
import { MAX_CONCURRENT_SUBAGENTS_DEFAULT } from './pi/subagents/runtime'
import type { AskUserAnswer } from '../shared/ask-user'
import type {
  AppInfoDTO,
  BrowserImportDiscoveryDTO,
  BrowserImportResultDTO,
  BrowserImportStatusDTO,
  BrowserStatusDTO,
  FileBrowserRequest,
  RewindRequest,
  RewindStatsTargetDTO,
  BashTaskRequest,
  SubagentActionPayload,
  SubagentProfileCreatePayload,
  CustomModelDTO,
  ModelsConfigDTO,
  McpUpsertServerPayload,
  PromptPayload,
  QueueActionPayload,
  ResendPayload,
  ContinuePayload,
  SessionSnapshotDTO,
  SessionSearchRequest,
  SandboxEscalationDecision,
  SandboxMode,
  SideChatAskPayload,
  StartupSessionMode,
  ThinkingLevel,
  UsageStatsDTO,
  WindowTheme
} from '../shared/types'

/** Renderer broadcast shared by every main-process emitter (PiManager's event
 * sink and the browser wiring alike): events reach every window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function createPiManager(): PiManager {
  const notifyError = (message: string) => broadcast('pi:event', { type: 'pi_error', message })
  return new PiManager(broadcast, notifyError)
}

export function registerIpc(pi: PiManager): () => boolean {
  ipcMain.handle('files:saveCopy', (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? saveFileCopy(win, path) : { status: 'error' }
  })
  ipcMain.on('window:setTheme', (event, theme: WindowTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) setWindowTheme(win, theme)
  })
  const terminals = new TerminalManager(pi.checkoutCoordinator)
  ipcMain.handle('terminal:create', (event, payload) => terminals.create(event.sender, payload))
  ipcMain.on('terminal:command', (event, command) => terminals.command(event.sender, command))
  const isQuitting = registerQuitHandler(app, [async () => { pi.stopScheduledTasks() }, () => terminals.dispose(), () => pi.dispose(), async () => getBrowserService()?.dispose(), () => htmlPreviews.dispose()])

  // Embedded browser singleton: one per app, owned here and by the quit
  // cleanup above (runs before the window exists — registerIpc is called from
  // index.ts ahead of createWindow). Nothing connects at startup: the CDP
  // connect is lazy behind consent — target discovery rides the service's own
  // 1s reconcile poll plus the renderer's explicit pulls (pane createPage,
  // consent), never a status read.
  // Agent 键盘动作前的「请渲染层聚焦 guest」握手：待应答表 + 序号 + ack 超时（见下方 focusGuest）。
  const pendingGuestFocus = new Map<number, () => void>()
  const GUEST_FOCUS_ACK_TIMEOUT_MS = 1_000
  let focusGuestSeq = 0

  const browser = initBrowserService({
    cdpPort: getCdpPort(),
    // The shell window's own document, mirroring index.ts's loadURL/loadFile
    // decision (same expression, same compiled __dirname): reconcile and the
    // page-event path exclude it from the registry by exact match. registerIpc
    // runs before createWindow, but the loaded URL is deterministic from these
    // two inputs; exact matching (not a localhost prefix) is what keeps agent
    // pages like the user's dev server on http://localhost:3000/ registrable.
    shellDocumentUrl: process.env.ELECTRON_RENDERER_URL
      ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
    consent: {
      get: () => loadSettings().browserConsent,
      grant: () => saveSettings({ ...loadSettings(), browserConsent: true })
    },
    // The service coalesces registry changes (~30ms) into this callback, which
    // runs from a setTimeout — a throwing consumer would crash main, so it
    // stays best-effort like every other broadcast in this file.
    onStateChange: () => {
      try {
        broadcast('browser:state', getBrowserService()?.getStatus())
      } catch {
        /* best-effort */
      }
    },
    // 键盘输入前把焦点交给 guest——**必须由渲染层把 `<webview>` 元素 focus**。
    // 实测：壳窗口持焦点时，派给 guest 的按键会同时落到壳窗口 DOM，于是 agent 按一次
    // Escape 就把本轮停掉（Escape 是 Composer 的停止键）；而 `webviewElement.focus()`
    // 之后同样的按键壳窗口一个也收不到。main 侧 `webContents.focus()` 与 playwright 的
    // `Page.bringToFront` 都**不动壳窗口的 DOM 焦点**（实测 activeElement 始终是 BUTTON），
    // 所以这里发请求 + 等 ack（带超时兜底：页被关掉/面板未挂载时不会卡住键盘动作）。
    focusGuest: async (webContentsId: number) => {
      const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
      if (!target) return
      webContents.fromId(webContentsId)?.focus()
      const requestId = ++focusGuestSeq
      const acked = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pendingGuestFocus.delete(requestId)
          resolve()
        }, GUEST_FOCUS_ACK_TIMEOUT_MS)
        timer.unref?.()
        pendingGuestFocus.set(requestId, () => {
          clearTimeout(timer)
          resolve()
        })
      })
      const payload: BrowserFocusGuestPayload = { webContentsId, requestId }
      target.webContents.send('browser:focus-guest', payload)
      await acked
    }
  })

  // 渲染层聚焦完 guest 后的 ack（main 等到它才派按键，见 BrowserFocusGuestPayload）。
  ipcMain.handle('browser:focus-guest-done', (_event, requestId: number) => {
    pendingGuestFocus.get(requestId)?.()
    pendingGuestFocus.delete(requestId)
  })
  // ---- Embedded browser: the renderer's only control surface for the service ----
  ipcMain.handle('browser:status', (): BrowserStatusDTO => browser.getStatus())
  // The renderer's shortcut catalogue (lib/shortcuts) pushes its current
  // binding identities here; a focused guest's matching keydown is relayed
  // back as browser:guest-app-shortcut (see wiring.ts). Fire-and-forget:
  // minimal fixture mains simply have no listener (a silent no-op).
  ipcMain.on('browser:setAppShortcuts', (_event, identities: unknown) => {
    setAppShortcutIdentities(identities)
  })
  // Local-row restore (open-pages snapshot) needs the service's CDP connection
  // to EXIST before its marker guests spawn (iron 7: a guest predating the
  // connection is invisible to it — state-only forever, no runtime, so the
  // pendingNavigate goto and the theme emulation never reach it). Cheap and
  // idempotent: ensureStarted memoizes the connection; reconcile is the same
  // pass the 1s tick runs.
  ipcMain.handle('browser:ensureService', async (): Promise<void> => {
    await browser.reconcileElectronTargets()
  })
  ipcMain.handle('browser:consent', (): BrowserStatusDTO => {
    browser.grantConsent()
    return browser.getStatus()
  })
  ipcMain.handle('browser:createPage', (_event, url?: string) => browser.createPage(HUMAN_OWNER, url))
  ipcMain.handle('browser:closePage', (_event, id: string) => browser.closePage(id))
  // Toolbar reload: the service drives it with goto(currentUrl) for a page it
  // owns (the CDP Page.reload command kills the guest); false means the row has
  // no runtime and the renderer falls back to the element's own API.
  ipcMain.handle('browser:reload', (_event, id: string) => browser.reloadPageForId(id))
  // Renderer reports a guest the service does not know yet; the returned row
  // is irrelevant to it (fresh state arrives on browser:state).
  ipcMain.handle('browser:seen', (_event, payload: BrowserSeenPayload) => {
    if (!payload || typeof payload !== 'object') return
    browser.registerExternalPage(payload)
  })
  ipcMain.handle('browser:elementAt', (_event, id: string, x: number, y: number) => browser.resolveElementAt(id, x, y))
  // Theme follow is cosmetic: a failure (no CDP yet, guest mid-navigation)
  // must not surface as a rejected invoke.
  ipcMain.handle('browser:theme', async (_event, colorScheme: 'dark' | 'light') => {
    try {
      await browser.setColorScheme(colorScheme)
    } catch {
      /* best-effort */
    }
  })
  // Wipe the browser partition's storage (cookies/localStorage/indexDB/cache —
  // login states included; the renderer menu confirms twice). Errors propagate
  // as a rejected invoke.
  ipcMain.handle('browser:clearData', async () => {
    const ses = session.fromPartition(BROWSER_PARTITION)
    await ses.clearStorageData({
      // pi-web's list minus appcache/websql: Chromium removed both long ago and
      // this Electron's typings reject them — clearing them is a no-op today.
      storages: ['cachestorage', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'shadercache']
    })
    await ses.clearCache()
    await ses.clearAuthCache()
  })

  // ---- Chrome 登录态导入（Settings → Browser）。逻辑全在 import-cookies.ts；
  // 这里只把 partition session 接进去（解密/读取永不触碰渲染层）。 ----
  ipcMain.handle('browser:importSources', (): BrowserImportDiscoveryDTO => ({
    ...discoverChrome(),
    // 两条引导路：dev/preview（未打包，进程是仓库里的 Electron.app，FDA 列表
    // 看不见）→ 授启动终端即可；正式安装（已打包，FDA 列表可见）→ 直接勾选 app。
    devMode: !app.isPackaged
  }))
  // discovery 把根目录分类：blocked（macOS 应用数据保护拦住了读取，引导用户去授
  // 「完全磁盘访问」）/ none / absent / ok —— 渲染层据此显示引导而非误导性的「未找到」。
  ipcMain.handle('browser:openPrivacySettings', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })
  ipcMain.handle('browser:importCookies', (_event, profileId: unknown): Promise<BrowserImportResultDTO> => {
    const ses = session.fromPartition(BROWSER_PARTITION)
    return importChromeCookies({
      profileId: typeof profileId === 'string' ? profileId : '',
      recordPath: browserImportRecordPath(app.getPath('userData')),
      apply: makeSessionApply((detail) => ses.cookies.set(detail))
    }).then(({ result }) => result)
  })
  ipcMain.handle('browser:importStatus', (): BrowserImportStatusDTO =>
    readImportStatus(browserImportRecordPath(app.getPath('userData')))
  )
  ipcMain.handle('browser:clearImported', async (): Promise<{ removed: number; failed: number }> => {
    const ses = session.fromPartition(BROWSER_PARTITION)
    return clearImportedCookies(browserImportRecordPath(app.getPath('userData')), (url, name) =>
      ses.cookies.remove(url, name)
    )
  })

  ipcMain.handle('app:info', (): AppInfoDTO => {
    const settings = loadSettings()
    return {
      cwd: settings.cwd && !isDefaultWorkspace(settings.cwd) ? settings.cwd : null,
      folders: settings.folders.filter((f) => typeof f === 'string' && !isDefaultWorkspace(f)),
      contextFiles: settings.contextFiles !== false,
      bashMaxWaitMs: settings.bashMaxWaitMs,
      sandboxMode: settings.sandboxMode,
      sandbox: sandboxStatus(settings.sandboxMode),
      checkpointsEnabled: settings.checkpointsEnabled !== false,
      startup: settings.startup,
      subagentsEnabled: settings.subagentsEnabled !== false,
      subagentMaxConcurrent: settings.subagentMaxConcurrent ?? MAX_CONCURRENT_SUBAGENTS_DEFAULT,
      subagentReuseEnabled: settings.subagentReuseEnabled === true,
      subagentCommsEnabled: settings.subagentCommsEnabled === true,
      askUserTimeoutSeconds: settings.askUserTimeoutSeconds,
      responseTimeoutSeconds: settings.responseTimeoutSeconds,
      browserConsent: settings.browserConsent === true,
      browserAgentToolsEnabled: settings.browserAgentToolsEnabled === true,
      version: app.getVersion()
    }
  })

  ipcMain.handle('rewind:list', (_event, path: string) => pi.rewindList(path))
  ipcMain.handle('rewind:preview', (_event, path: string, checkpoint: string, action?: 'undo' | 'redo') => pi.rewindPreview(path, checkpoint, action))
  ipcMain.handle('rewind:preview-file', (_event, path: string, token: string, file: string) => pi.rewindPreviewFile(path, token, file))
  ipcMain.handle('rewind:stats', (_event, path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number) => pi.rewindStats(path, token, file, area, stage))
  ipcMain.handle('rewind:stats-batch', (_event, path: string, token: string, targets: RewindStatsTargetDTO[]) => pi.rewindStatsBatch(path, token, targets))
  ipcMain.handle('rewind:patch', (_event, path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number) => pi.rewindPatch(path, token, file, area, stage))
  ipcMain.handle('rewind:restore', (_event, request: RewindRequest) => pi.rewindRestore(request))
  ipcMain.handle('rewind:recover', (_event, path: string, operationId: string) => pi.rewindRecover(path, operationId))

  // Scheduled tasks: handlers forward arguments only and keep
  // ScheduledTaskError's status across the boundary; prose is the renderer's.
  const scheduledCall = <T>(work: () => Promise<T>): Promise<ScheduledTaskResult<T>> =>
    work()
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({
        ok: false as const,
        status: error instanceof ScheduledTaskError ? error.status : 500,
        error: error instanceof Error ? error.message : String(error)
      }))
  ipcMain.handle('scheduled:snapshot', () => scheduledCall(() => pi.scheduledTasksSnapshot()))
  ipcMain.handle('scheduled:runOutput', (_event, runId: string) => scheduledCall(() => pi.scheduledRunOutput(runId)))
  ipcMain.handle('scheduled:get', (_event, id: string) => scheduledCall(() => pi.scheduledTasks.get(id)))
  ipcMain.handle('scheduled:create', (_event, input: unknown) => scheduledCall(() => pi.scheduledTasks.create(input)))
  ipcMain.handle('scheduled:update', (_event, id: string, patch: Record<string, unknown>, revision?: number) =>
    scheduledCall(() => pi.scheduledTasks.update(id, patch, revision)))
  ipcMain.handle('scheduled:delete', (_event, id: string, revision?: number) => scheduledCall(() => pi.scheduledTasks.delete(id, revision)))
  ipcMain.handle('scheduled:runNow', (_event, id: string, revision?: number) => scheduledCall(() => pi.scheduledTasks.runNow(id, revision)))
  ipcMain.handle('scheduled:cancelRun', (_event, runId: string) => scheduledCall(() => pi.scheduledTasks.cancelRun(runId)))
  ipcMain.handle('scheduled:markRead', (_event, runId: string) => scheduledCall(() => pi.scheduledTasks.markRead(runId)))
  ipcMain.handle('scheduled:deleteRuns', (_event, ids: unknown) => scheduledCall(() => pi.scheduledTasks.deleteRuns(ids)))
  ipcMain.handle('app:setCheckpointsEnabled', (_event, enabled: boolean) => pi.setCheckpointsEnabled(enabled))
  ipcMain.handle('app:setStartup', (_event, mode: StartupSessionMode) => pi.setStartupMode(mode))
  ipcMain.handle('app:setBashMaxWaitMs', (_event, value: number) => pi.setBashMaxWaitMs(value))
  ipcMain.handle('app:setAskUserTimeoutSeconds', (_event, value: number) => pi.setAskUserTimeoutSeconds(value))
  ipcMain.handle('app:setResponseTimeoutSeconds', (_event, value: number) => pi.setResponseTimeoutSeconds(value))
  ipcMain.handle('app:setSandboxMode', (_event, mode: SandboxMode) => pi.setSandboxMode(mode))
  // The preference is persisted here like the other app:set* switches; the
  // manager applies the flag to sessions (build-time registration + live reload).
  ipcMain.handle('app:setBrowserAgentTools', (_event, enabled: boolean) => {
    saveSettings({ ...loadSettings(), browserAgentToolsEnabled: enabled })
    return pi.setBrowserAgentTools(enabled)
  })
  ipcMain.handle('jev:settings', () => pi.jevSettings())
  ipcMain.handle('jev:updateSettings', (_event, update: JevSettingsUpdate) => pi.updateJevSettings(update))
  ipcMain.handle('jev:test', () => pi.testJev())
  ipcMain.handle('jev:traces', (_event, path: string, cursor?: string) => pi.jevTraces(path, cursor))
  ipcMain.handle('jev:trace', (_event, path: string, id: string) => pi.jevTrace(path, id))
  // The live mode belongs to a session, not to the app: the composer switches
  // this session's mode and gets the refreshed snapshot back.
  registerPlanIpc(pi)
  ipcMain.handle('sandbox:setMode', (_event, sessionPath: string, mode: SandboxMode) =>
    pi.setSessionSandboxMode(sessionPath, mode))
  // Manual compaction, the app's equivalent of `/compact`.
  ipcMain.handle('pi:compact', (_event, sessionPath: string) => pi.compactSession(sessionPath))
  // Manual resource reload, the app's equivalent of `/reload`.
  ipcMain.handle('pi:reload', (_event, sessionPath: string) => pi.reloadSession(sessionPath))
  // The session's current effective system prompt, read live off the SDK; the
  // active session answers when no path is given.
  ipcMain.handle('pi:systemPrompt', (_event, sessionPath?: string) => pi.systemPrompt(sessionPath))
  // Answer one pending sandbox escalation. The session path travels with the id
  // so an answer cannot settle another session's question.
  ipcMain.handle(
    'sandbox:respondEscalation',
    (_event, requestId: string, sessionPath: string, decision: SandboxEscalationDecision) =>
      pi.respondEscalation(requestId, sessionPath, decision)
  )
  // Answer (or dismiss) one pending ask_user_question set. Answers are
  // validated against the pending entry's own question list in main.
  ipcMain.handle(
    'askUser:respond',
    (_event, requestId: string, ownerPath: string, payload: { answers?: AskUserAnswer[]; cancelled?: boolean }) =>
      pi.respondAskUser(requestId, ownerPath, payload)
  )
  // The user's first real interaction with a question panel: main cancels the
  // auto-settle countdown and republishes so every view hides it.
  ipcMain.handle(
    'askUser:engage',
    (_event, requestId: string, ownerPath: string) => pi.engageAskUser(requestId, ownerPath)
  )
  ipcMain.handle('bash:list', (_event, sessionPath: string) => pi.listBashTasks(sessionPath))
  ipcMain.handle('bash:output', (_event, request: BashTaskRequest) => pi.bashTaskOutput(request))
  ipcMain.handle('bash:stop', (_event, request: BashTaskRequest) => pi.stopBashTask(request))
  ipcMain.handle('subagents:list', (_event, sessionPath: string) => pi.listSubagents(sessionPath))
  ipcMain.handle('pi:peekSession', (_event, path: string) => pi.peekSession(path))
  ipcMain.handle('subagents:action', (_event, payload: SubagentActionPayload) => pi.subagentAction(payload))
  ipcMain.handle('subagents:setEnabled', (_event, enabled: boolean) => pi.setSubagentsEnabled(enabled))
  ipcMain.handle('subagents:setMaxConcurrent', (_event, value: number) => pi.setSubagentMaxConcurrent(value))
  ipcMain.handle('subagents:setReuseEnabled', (_event, enabled: boolean) => pi.setSubagentReuseEnabled(enabled))
  ipcMain.handle('subagents:setCommsEnabled', (_event, enabled: boolean) => pi.setSubagentCommsEnabled(enabled))
  ipcMain.handle('subagents:profiles', () => pi.subagentProfiles())
  ipcMain.handle(
    'subagents:createProfile',
    (_event, payload: SubagentProfileCreatePayload) => pi.createSubagentProfile(payload)
  )
  ipcMain.handle(
    'subagents:setProfileTools',
    (_event, filePath: string, tools: 'all' | string[]) => pi.setSubagentProfileTools(filePath, tools)
  )

  ipcMain.handle('app:setContextFiles', (_event, enabled: boolean): Promise<boolean> =>
    pi.setContextFilesEnabled(enabled)
  )

  ipcMain.handle('app:pickDirectory', async (): Promise<{ cwd: string } | { cancelled: true }> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    const cwd = result.filePaths[0]
    saveSettings({ ...loadSettings(), cwd })
    return { cwd }
  })

  ipcMain.handle('pi:init', (_event, cwd?: string): Promise<SessionSnapshotDTO> => pi.init(cwd))
  ipcMain.handle('pi:newSession', (_event, cwd?: string): Promise<SessionSnapshotDTO> => pi.newSession(cwd))
  ipcMain.handle('pi:openSession', (_event, path: string, cwd?: string) => pi.openSession(path, cwd))
  ipcMain.handle('pi:listSessions', () => pi.listSessions())
  ipcMain.handle('pi:searchSessions', (_event, request: SessionSearchRequest) => pi.searchSessions(request))
  ipcMain.handle('pi:usageStats', (): Promise<UsageStatsDTO> => pi.usageStats())
  ipcMain.handle('pi:contextDetail', (_event, sessionPath?: string) => pi.contextDetail(sessionPath))
  ipcMain.handle('pi:deleteSession', (_event, path: string) => pi.deleteSession(path))
  ipcMain.handle('pi:renameSession', (_event, path: string, name: string) =>
    pi.renameSession(path, name)
  )
  ipcMain.handle('pi:deleteFolder', (_event, cwd: string) => pi.deleteFolderSessions(cwd))
  ipcMain.handle('pi:prompt', (_event, payload: PromptPayload) => {
    pi.prompt(payload)
    return { accepted: true }
  })
  ipcMain.handle('pi:sideChatAsk', (_event, payload: SideChatAskPayload) => pi.sideChatAsk(payload))
  ipcMain.handle('pi:sideChatAbort', (_event, exchangeId: string) => {
    pi.sideChatAbort(exchangeId)
    return { accepted: true }
  })
  ipcMain.handle('pi:clearQueue', (_event, stopping?: boolean) => pi.clearQueue(stopping))
  ipcMain.handle('pi:queueAction', (_event, payload: QueueActionPayload) => {
    pi.queueAction(payload)
    return { accepted: true }
  })
  ipcMain.handle('pi:abort', () => {
    pi.abort()
    return { accepted: true }
  })
  ipcMain.handle('pi:resendMessage', (_event, payload: ResendPayload) => pi.resendMessage(payload))
  ipcMain.handle('pi:continueMessage', (_event, payload: ContinuePayload) => pi.continueMessage(payload))
  ipcMain.handle('pi:forkFromMessage', (_event, timestamp: number) => pi.forkFromMessage(timestamp))
  ipcMain.handle('pi:setModel', (_event, providerId: string, modelId: string) =>
    pi.setModel(providerId, modelId)
  )
  ipcMain.handle('pi:setThinkingLevel', (_event, level: ThinkingLevel) =>
    pi.setThinkingLevel(level)
  )
  ipcMain.handle('pi:providers', () => pi.providers())
  ipcMain.handle('pi:models', () => pi.models())
  ipcMain.handle('pi:login', (_event, providerId: string, kind: 'api_key' | 'oauth') =>
    pi.login(providerId, kind)
  )
  ipcMain.handle('pi:loginCancel', (_event, providerId: string) => pi.cancelLogin(providerId))
  ipcMain.handle('pi:logout', (_event, providerId: string) => pi.logout(providerId))

  ipcMain.handle('pi:modelsConfig', () => pi.modelsConfig())
  ipcMain.handle('pi:saveModelsConfig', (_event, config: ModelsConfigDTO) =>
    pi.saveModelsConfig(config)
  )
  ipcMain.handle('pi:providerModels', (_event, providerId: string) => pi.providerModels(providerId))
  ipcMain.handle('pi:discoverModels', (_event, providerId: string) =>
    pi.discoverProviderModels(providerId)
  )
  ipcMain.handle('pi:testModel', (_event, providerId: string, model: CustomModelDTO) =>
    pi.testProviderModel(providerId, model)
  )
  ipcMain.handle('pi:defaultModel', () => pi.defaultModel())
  ipcMain.handle('pi:setDefaultModel', (_event, providerId: string, modelId: string) =>
    pi.setDefaultModel(providerId, modelId)
  )
  ipcMain.handle('pi:catalogPreset', (_event, providerId: string, modelId: string) =>
    pi.catalogPreset(providerId, modelId)
  )
  ipcMain.handle('pi:configuredModels', () => pi.configuredModelSources())

  ipcMain.handle('pi:appendPrompt', () => pi.appendPrompt())
  ipcMain.handle('pi:setAppendPrompt', (_event, text: string) => pi.setAppendPrompt(text))

  ipcMain.handle('pi:toolsCatalog', () => pi.catalog())
  ipcMain.handle('pi:mcpState', () => pi.mcpState())
  ipcMain.handle('pi:mcpWriteConfig', (_event, scope: 'global' | 'project', content: string) =>
    pi.writeMcpConfig(scope, content)
  )
  ipcMain.handle('pi:mcpSetServerDisabled', (_event, name: string, disabled: boolean) =>
    pi.setMcpServerDisabled(name, disabled)
  )
  ipcMain.handle('pi:mcpServerDetail', (_event, name: string) => pi.mcpServerDetail(name))
  ipcMain.handle('pi:setExtensionEnabled', (_event, id: string, enabled: boolean) =>
    pi.setExtensionEnabled(id, enabled)
  )
  ipcMain.handle('pi:updateExtension', (_event, source: string) => pi.updateExtension(source))
  ipcMain.handle('pi:removeExtension', (_event, source: string) => pi.removeExtension(source))
  ipcMain.handle('pi:installExtension', (_event, source: string) => pi.installExtension(source))
  ipcMain.handle(
    'pi:setSkillModelInvocation',
    (_event, filePath: string, disableModelInvocation: boolean) =>
      pi.setSkillModelInvocation(filePath, disableModelInvocation)
  )
  ipcMain.handle('pi:readSkill', (_event, filePath: string) => pi.readSkill(filePath))

  ipcMain.handle('files:search', (_event, query: string) => pi.searchFiles(query))
  ipcMain.handle('files:read', (_event, path: string) => pi.readFile(path))
  ipcMain.handle('files:directory', (_event, request: FileBrowserRequest, offset?: number) => listFileDirectory(request, offset))
  ipcMain.handle('files:document', (_event, request: FileBrowserRequest) => readFileDocument(request))
  ipcMain.handle('files:htmlPreview', (event, request: FileBrowserRequest) => {
    // Only our top-level shell can mint a filesystem grant, never a guest/frame.
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) return { error: 'unreadable' }
    return htmlPreviews.open(request)
  })
  ipcMain.handle('files:gitDiff', (_event, request: FileBrowserRequest) => readFileGitDiff(request))
  ipcMain.handle('files:pdfStat', (_event, request: FileBrowserRequest) => readPdfStat(request))
  ipcMain.handle('files:pdfRange', (_event, request: FileBrowserRequest, begin: number, end: number) => readPdfRange(request, begin, end))
  ipcMain.handle('files:fontData', (_event, request: FileBrowserRequest) => readFontData(request))
  ipcMain.handle('files:tableStat', (_event, request: FileBrowserRequest) => readTableStat(request))
  ipcMain.handle('files:tableSlice', (_event, request: FileBrowserRequest, offset: number, maxBytes?: number) => readTableSlice(request, offset, maxBytes))
  ipcMain.handle('files:tableRange', (_event, request: FileBrowserRequest, begin: number, end: number) => readTableRange(request, begin, end))
  ipcMain.handle('files:readImage', (_event, path: string) => pi.readImage(path))

  ipcMain.handle('shell:openPath', (_event, path: string) => shell.openPath(path))
  ipcMain.handle('shell:showInFolder', (_event, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  ipcMain.on('pi:auth-reply', (_event, payload: { requestId: string; value: string | null }) => {
    pi.resolveAuthPrompt(payload)
  })
  return isQuitting
}
