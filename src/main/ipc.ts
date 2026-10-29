import { registerTrajectoryIpc } from './pi/trajectory/ipc'
import { registerGitIpc } from './git/ipc'
import { app, ipcMain, dialog, session, shell, webContents, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ImageReplayRequest } from '../shared/image-replay'
import type { GoalActionRequest } from '../shared/goal'
import { registerPlanIpc } from './pi/plan-ipc'
import { PiManager } from './pi/manager'
import { registerResourceIpc } from './resources/service'
import { installImageSkill } from './pi/image-skill'
import { ScheduledTaskError } from './pi/scheduled-tasks/service'
import type { JevSettingsUpdate, PictureInPicturePreferencesDTO, ScheduledTaskResult } from '../shared/types'
import { TerminalManager } from './terminal/manager'
import { buildDebugCommandLine } from './debug/terminal'
import { registerQuitHandler } from './shutdown'
import { isDefaultWorkspace } from './pi/default-workspace'
import { loadSettings, saveSettings, updatePictureInPicturePreferences } from './settings'
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
import { BROWSER_PARTITION, HUMAN_OWNER, isBrowserSearchEngine } from '../shared/browser'
import type { BrowserFocusGuestPayload, BrowserSeenPayload } from '../shared/browser'
import { sandboxStatus } from './sandbox/broker'
import { setWindowTheme } from './window-chrome'
import { listFileDirectory, readFileDocument, readFileGitDiff } from './file-browser'
import { readPdfRange, readPdfStat } from './pdf'
import { readFontData } from './font'
import { htmlPreviews } from './html-preview'
import { readTableRange, readTableSlice, readTableStat } from './table'
import { filePreviews } from './file-preview/service'
import type { BinaryPreviewRequest } from '../shared/file-preview'
import { saveFileCopy } from './file-actions'
import { resolveFilePath } from './file-path'
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
  SubagentProfileDefaultsPayload,
  CustomModelDTO,
  DebugPanelRequest,
  DebugTerminalRequest,
  DebugTerminalResult,
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
  const skills = app.isPackaged ? join(process.resourcesPath, 'skills') : join(app.getAppPath(), 'resources', 'skills')
  const imageSkillPath = installImageSkill(join(skills, 'openrouter-image'), join(getAgentDir(), 'skills', 'openrouter-image'))
  return new PiManager(broadcast, notifyError, imageSkillPath)
}

export function registerIpc(
  pi: PiManager,
  mainWindow: () => BrowserWindow | null,
  onPictureInPicturePreferencesChanged: (preferences: PictureInPicturePreferencesDTO) => void
): () => boolean {
  ipcMain.handle('files:saveCopy', (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      return win ? saveFileCopy(win, resolveFilePath({ cwd: pi.cwd ?? homedir(), path })) : { status: 'error' }
    } catch { return { status: 'error' } }
  })
  ipcMain.on('window:setTheme', (event, theme: WindowTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) setWindowTheme(win, theme)
  })
  ipcMain.handle('window:setAlwaysOnTop', (event, flag: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    win.setAlwaysOnTop(flag === true)
    return win.isAlwaysOnTop()
  })
  ipcMain.handle('window:pipPreferences', () => loadSettings().pictureInPicture)
  ipcMain.handle('window:pipSetPreferences', (_event, update: Partial<PictureInPicturePreferencesDTO>) => {
    const next = updatePictureInPicturePreferences(update)
    onPictureInPicturePreferencesChanged(next)
    return next
  })
  const git = registerGitIpc(pi)
  const resources = registerResourceIpc()
  const terminals = new TerminalManager(pi.checkoutCoordinator)
  ipcMain.handle('terminal:create', (event, payload) => terminals.create(event.sender, payload))
  ipcMain.on('terminal:command', (event, command) => terminals.command(event.sender, command))

  // DAP runInTerminal: the adapter asks for a real terminal to host the
  // debuggee. Terminals are renderer-owned, so main relays the request to a
  // window and waits for its answer; the bridge is what makes the debug tool
  // advertise supportsRunInTerminalRequest at all.
  const cancelledDebugTerminals = new Map<string, number>()
  const pendingDebugTerminal = new Map<string, {
    owner: number
    command: string
    resolve: (value: { shellProcessId: number; terminalId: string; dispose: () => Promise<void> }) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>()
  ipcMain.on('debug:terminal-response', (event, result: DebugTerminalResult) => {
    const pending = pendingDebugTerminal.get(result.requestId)
    if (!pending) {
      if (cancelledDebugTerminals.get(result.requestId) === event.sender.id) {
        cancelledDebugTerminals.delete(result.requestId)
        if ('terminalId' in result) terminals.command(event.sender, { type: 'close', id: result.terminalId })
      }
      return
    }
    if (pending.owner !== event.sender.id) return
    pending.cleanup()
    if ('error' in result) pending.reject(new Error(result.error))
    else {
      // Main rechecks admission before any executable text reaches the shell.
      terminals.command(event.sender, { type: 'input', id: result.terminalId, data: `${pending.command}\r` })
      pending.resolve({ shellProcessId: result.shellProcessId, terminalId: result.terminalId, dispose: () => terminals.closeAndWait(event.sender, result.terminalId) })
    }
  })
  pi.debugTerminalBridge = (input) => new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(new Error('Debug terminal cancelled')); return }
    const win = mainWindow()
    if (!win || win.isDestroyed()) { reject(new Error('No window can host the debug terminal')); return }
    const command = buildDebugCommandLine(input.args, input.env)
    if (command.length > 65_535) { reject(new Error('Debug terminal command is too large')); return }
    const requestId = randomUUID()
    const owner = win.webContents
    const ownerId = owner.id
    const cleanup = () => {
      pendingDebugTerminal.delete(requestId)
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', cancel)
      owner.removeListener('destroyed', cancel)
    }
    const cancel = () => {
      cleanup()
      cancelledDebugTerminals.set(requestId, ownerId)
      if (cancelledDebugTerminals.size > 256) cancelledDebugTerminals.delete(cancelledDebugTerminals.keys().next().value!)
      reject(new Error('Debug terminal cancelled or timed out'))
    }
    const timer = setTimeout(cancel, 15_000)
    pendingDebugTerminal.set(requestId, { owner: ownerId, command, resolve, reject, cleanup })
    input.signal?.addEventListener('abort', cancel, { once: true })
    owner.once('destroyed', cancel)
    owner.send('debug:terminal-request', { requestId, title: input.title, cwd: input.cwd } satisfies DebugTerminalRequest)
  })
  const isQuitting = registerQuitHandler(app, [async () => { pi.stopScheduledTasks() }, () => resources.dispose(), () => git.dispose(), () => terminals.dispose(), () => pi.dispose(), async () => getBrowserService()?.dispose(), () => htmlPreviews.dispose(), () => filePreviews.dispose()])

  // Embedded browser singleton: one per app, owned here and by the quit
  // cleanup above (runs before the window exists — registerIpc is called from
  // index.ts ahead of createWindow). Nothing connects at startup: the CDP
  // connect is lazy behind consent — target discovery rides the service's own
  // 1s reconcile poll plus the renderer's explicit pulls (pane createPage,
  // consent), never a status read.
  // Guest-focus handshake before agent keyboard actions: pending acknowledgements, sequence IDs and timeout (see focusGuest).
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
    // Keyboard input requires the renderer to focus the guest <webview> element.
    // With shell focus, guest keyboard events also reach the shell DOM.
    // An agent Escape would therefore stop the run through the Composer shortcut.
    // webviewElement.focus() contains subsequent keys in the guest. Main webContents.focus() and
    // Playwright Page.bringToFront leave the shell DOM focus unchanged.
    // Wait for the renderer acknowledgement, with a timeout for closed pages or unmounted panes.
    focusGuest: async (webContentsId: number) => {
      const target = mainWindow()
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

  // The renderer acknowledges guest focus before main dispatches keys (BrowserFocusGuestPayload).
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

  // Chrome login-state import (Settings → Browser) is implemented in import-cookies.ts.
  // Only pass the partition session here; reading and decryption never reach the renderer.
  ipcMain.handle('browser:importSources', (): BrowserImportDiscoveryDTO => ({
    ...discoverChrome(),
    // In dev/preview, grant Full Disk Access to the launching terminal because the repository Electron.app
    // is absent from the permission list. Installed builds instead grant access to the app itself.
    devMode: !app.isPackaged
  }))
  // Discovery distinguishes blocked (macOS data protection), none, absent and ok,
  // so the renderer can offer access guidance instead of a misleading not-found message.
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
      subagentTurnLimitOverrideEnabled: settings.subagentTurnLimitOverrideEnabled === true,
      subagentMaxTurns: settings.subagentMaxTurns,
      askUserTimeoutSeconds: settings.askUserTimeoutSeconds,
      responseTimeoutSeconds: settings.responseTimeoutSeconds,
      allowMidRunChanges: settings.allowMidRunChanges === true,
      browserConsent: settings.browserConsent === true,
      browserAgentToolsEnabled: settings.browserAgentToolsEnabled === true,
      browserSearchEngine: settings.browserSearchEngine,
      debugEnabled: settings.debugEnabled === true,
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
  // A folder chosen for a scheduled task is only a value in the editor, so this
  // is the dialog alone: unlike app:pickDirectory it must not move the app's
  // current folder (that handler persists the pick as the session folder).
  ipcMain.handle('scheduled:pickDirectory', async (): Promise<{ path: string } | { cancelled: true }> => {
    const win = mainWindow()
    if (!win) return { cancelled: true }
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    return { path: result.filePaths[0] }
  })
  ipcMain.handle('app:setCheckpointsEnabled', (_event, enabled: boolean) => pi.setCheckpointsEnabled(enabled))
  ipcMain.handle('app:setStartup', (_event, mode: StartupSessionMode) => pi.setStartupMode(mode))
  ipcMain.handle('app:setBashMaxWaitMs', (_event, value: number) => pi.setBashMaxWaitMs(value))
  ipcMain.handle('app:setAskUserTimeoutSeconds', (_event, value: number) => pi.setAskUserTimeoutSeconds(value))
  ipcMain.handle('app:setResponseTimeoutSeconds', (_event, value: number) => pi.setResponseTimeoutSeconds(value))
  ipcMain.handle('app:setAllowMidRunChanges', (_event, enabled: boolean) => pi.setAllowMidRunChanges(enabled))
  ipcMain.handle('app:setSandboxMode', (_event, mode: SandboxMode) => pi.setSandboxMode(mode))
  // The preference is persisted here like the other app:set* switches; the
  // manager applies the flag to sessions (build-time registration + live reload).
  ipcMain.handle('app:setBrowserAgentTools', (_event, enabled: boolean) => {
    saveSettings({ ...loadSettings(), browserAgentToolsEnabled: enabled })
    return pi.setBrowserAgentTools(enabled)
  })
  ipcMain.handle('app:setBrowserSearchEngine', (_event, engine: unknown) => {
    if (!isBrowserSearchEngine(engine)) throw new TypeError('Invalid browser search engine')
    saveSettings({ ...loadSettings(), browserSearchEngine: engine })
    broadcast('browser:searchEngineChanged', engine)
    return engine
  })
  ipcMain.handle('app:setDebugEnabled', (_event, enabled: boolean) => {
    saveSettings({ ...loadSettings(), debugEnabled: enabled })
    return pi.setDebugEnabled(enabled)
  })
  ipcMain.handle('debug:source', (_event, request: import('../shared/types').DebugSourceRequest) => pi.debugSource(request))
  ipcMain.handle('debug:list', (_event, sessionPath: string) => pi.listDebugSessions(sessionPath))
  ipcMain.handle('debug:action', (_event, request: DebugPanelRequest) => pi.debugPanelAction(request))
  ipcMain.handle('jev:settings', () => pi.jevSettings())
  ipcMain.handle('jev:updateSettings', (_event, update: JevSettingsUpdate) => pi.updateJevSettings(update))
  ipcMain.handle('jev:test', () => pi.testJev())
  registerTrajectoryIpc(pi)
  ipcMain.handle('jev:traces', (_event, path: string, cursor?: string) => pi.jevTraces(path, cursor))
  ipcMain.handle('jev:trace', (_event, path: string, id: string) => pi.jevTrace(path, id))
  // The live mode belongs to a session, not to the app: the composer switches
  // this session's mode and gets the refreshed snapshot back.
  registerPlanIpc(pi)
  ipcMain.handle('goal:action', (_event, request: GoalActionRequest) => pi.goalAction(request))
  ipcMain.handle('sandbox:setMode', (_event, sessionPath: string, mode: SandboxMode) =>
    pi.setSessionSandboxMode(sessionPath, mode))
  // Manual compaction; the promise waits for a live session's safe boundary.
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
  ipcMain.handle('subagents:setTurnLimitOverrideEnabled', (_event, enabled: boolean) => pi.setSubagentTurnLimitOverrideEnabled(enabled))
  ipcMain.handle('subagents:setMaxTurns', (_event, value: number | null) => pi.setSubagentMaxTurns(value))
  ipcMain.handle('subagents:setProfileDefaults', (_event, filePath: string, defaults: SubagentProfileDefaultsPayload) => pi.setSubagentProfileDefaults(filePath, defaults))
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
    const win = mainWindow()
    if (!win) return { cancelled: true }
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
  ipcMain.handle('pi:imageReplays', (_event, sessionPath: string) => pi.imageReplays(sessionPath))
  ipcMain.handle('pi:retryPresentedImage', (_event, request: ImageReplayRequest) => pi.retryPresentedImage(request))
  ipcMain.handle('pi:cancelImageReplay', (_event, sessionPath: string, id: string) => pi.cancelImageReplay(sessionPath, id))
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
  ipcMain.handle('files:resolvePath', (_event, request: FileBrowserRequest) => resolveFilePath(request))
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
  const previewOwners = new Set<number>()
  ipcMain.handle('files:binaryPreview', (event, request: BinaryPreviewRequest) => {
    if (!previewOwners.has(event.sender.id)) {
      const owner = event.sender.id
      previewOwners.add(owner)
      event.sender.once('destroyed', () => { previewOwners.delete(owner); filePreviews.cancelOwner(owner) })
    }
    return filePreviews.read(event.sender.id, request)
  })
  ipcMain.on('files:cancelBinaryPreview', (event, id: string) => { if (typeof id === 'string') filePreviews.cancel(event.sender.id, id) })
  ipcMain.handle('files:readImage', (_event, path: string) => pi.readImage(path))

  ipcMain.handle('shell:openPath', (_event, path: string) => shell.openPath(resolveFilePath({ cwd: pi.cwd ?? homedir(), path })))
  ipcMain.handle('shell:showInFolder', (_event, path: string) => shell.showItemInFolder(resolveFilePath({ cwd: pi.cwd ?? homedir(), path })))
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  ipcMain.on('pi:auth-reply', (_event, payload: { requestId: string; value: string | null }) => {
    pi.resolveAuthPrompt(payload)
  })
  return isQuitting
}
