import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  ExternalLink,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  X
} from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { cn } from '@/lib/utils'
import {
  MCP_ADAPTER_DOCS_URL,
  createEmptyMcpServerForm,
  formToServerEntry,
  parseMcpConfigJson,
  serverEntryToForm,
  validateMcpServerForm,
  type McpAuthKind,
  type McpKeyValue,
  type McpServerForm,
  type McpTransportKind
} from '@/lib/mcp-config'
import {
  clearMcpActionError,
  deleteMcpServer,
  fetchMcpServerDetail,
  refreshMcpState,
  setMcpServerDisabled,
  upsertMcpServer,
  useMcpStore,
  writeMcpConfig
} from '@/lib/mcp-store'
import { installExtension, useToolCatalog } from '@/lib/extensions-catalog'
import type {
  McpConfigFileDTO,
  McpConfigScope,
  McpRuntimeStatus,
  McpServerDTO,
  McpServerDetailDTO
} from '../../../../../shared/types'
import { ConfirmDialog } from '../ConfirmDialog'
import { LabelTooltip } from '../LabelTooltip'
import { SettingsGroup } from './SettingsRow'

/**
 * Settings → MCP: the pi-mcp-adapter's home. One merged server roster (all
 * config layers, with provenance + live/cache status and the enable switch),
 * the visual per-server editor, a read-only tools viewer fed by the adapter's
 * metadata cache, and the raw JSON editors for the two app-editable files
 * (global `<agentDir>/mcp.json`, project `<cwd>/.mcp.json`). All writes go
 * through the main process, which validates the target file and reloads the
 * live sessions so the adapter re-reads its config.
 */

const JSON_SAVE_DEBOUNCE_MS = 800

interface JsonDraft {
  text: string
  savedText: string
  parseError: string | null
}

interface EditorState {
  form: McpServerForm
  /** Existing server: its defining file. New server: absent — scope decides. */
  targetPath?: string
  scope: McpConfigScope
}

const STATUS_META: Record<McpRuntimeStatus, { dot: string; labelKey: MessageKey }> = {
  connected: { dot: 'bg-emerald-500', labelKey: 'mcp.status.connected' },
  cached: { dot: 'bg-sky-500', labelKey: 'mcp.status.cached' },
  failed: { dot: 'bg-destructive', labelKey: 'mcp.status.failed' },
  'needs-auth': { dot: 'bg-amber-500', labelKey: 'mcp.status.needsAuth' },
  'not-connected': { dot: 'border border-muted-foreground/50', labelKey: 'mcp.status.notConnected' },
  disabled: { dot: 'bg-muted-foreground/40', labelKey: 'mcp.status.disabled' }
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

export function McpSection() {
  const { t } = useI18n()
  const { status, data, error, busy, actionError } = useMcpStore()
  const catalog = useToolCatalog()
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [toolsTarget, setToolsTarget] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<McpServerDTO | null>(null)

  useEffect(() => {
    void refreshMcpState()
  }, [])

  useEffect(() => {
    if (actionError) clearMcpActionError()
  }, [editor, toolsTarget, deleteTarget]) // eslint-disable-line react-hooks/exhaustive-deps -- a fresh dialog starts clean

  if (status === 'loading' && !data) {
    return <p className="text-sm text-muted-foreground">{t('mcp.loading')}</p>
  }
  if (status === 'error' && !data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('mcp.loadFailed')}</p>
        {error ? <p className="text-xs text-muted-foreground/70">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => void refreshMcpState()}>
          <RefreshCw className="size-3.5" />
          {t('settings.toolsRetry')}
        </Button>
      </div>
    )
  }
  if (!data) return null

  const existingNames = data.servers.map((server) => server.name)

  const startNew = (scope: McpConfigScope) => {
    setEditorError(null)
    setEditor({ form: createEmptyMcpServerForm(), scope })
  }

  const startEdit = (server: McpServerDTO) => {
    if (!server.editable || !server.sourcePath) return
    setEditorError(null)
    setEditor({
      form: serverEntryToForm(server.name, server.entry),
      targetPath: server.sourcePath,
      scope: server.scope === 'project' ? 'project' : 'global'
    })
  }

  const saveEditor = async () => {
    if (!editor || busy) return
    const issues = validateMcpServerForm(editor.form, existingNames)
    if (issues.length > 0) {
      setEditorError(t(`mcp.error.${issues[0]}` as MessageKey, { name: editor.form.name.trim() }))
      return
    }
    const ok = await upsertMcpServer({
      targetPath: editor.targetPath,
      scope: editor.targetPath ? undefined : editor.scope,
      originalName: editor.form.originalName ?? null,
      name: editor.form.name.trim(),
      entry: formToServerEntry(editor.form)
    })
    if (ok) setEditor(null)
  }

  return (
    <div className="space-y-6">
      {!data.adapterInstalled ? <AdapterBanner /> : null}

      {actionError ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <button
            type="button"
            aria-label={t('settings.extensionDismissError')}
            onClick={clearMcpActionError}
            className="grid size-4 shrink-0 place-items-center rounded-capsule transition-colors hover:bg-destructive/10"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted-foreground/70">
          {data.adapterInstalled && data.adapterVersion
            ? t('mcp.adapterVersion', { version: data.adapterVersion })
            : null}
        </p>
        <div className="flex items-center gap-1">
          <Tooltip content={t('mcp.docs')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('mcp.docs')}
              onClick={() => void window.pi.openExternal(MCP_ADAPTER_DOCS_URL)}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={t('mcp.refresh')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('mcp.refresh')}
              disabled={status === 'loading'}
              onClick={() => void refreshMcpState()}
            >
              <RefreshCw className={cn('size-3.5', status === 'loading' && 'animate-spin')} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <SettingsGroup title={t('mcp.serversTitle')} description={t('mcp.serversDesc')}>
        {data.servers.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('mcp.empty')}</p>
        ) : (
          data.servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              busy={busy}
              onToggle={(enabled) => void setMcpServerDisabled(server.name, !enabled)}
              onShowTools={() => setToolsTarget(server.name)}
              onEdit={() => startEdit(server)}
              onDelete={() => setDeleteTarget(server)}
            />
          ))
        )}
      </SettingsGroup>
      <div className="flex justify-center gap-2">
        <Button variant="outline" size="sm" onClick={() => startNew('global')}>
          <Plus className="size-3.5" />
          {t('mcp.addGlobal')}
        </Button>
        {data.projectCwd ? (
          <Button variant="outline" size="sm" onClick={() => startNew('project')}>
            <Plus className="size-3.5" />
            {t('mcp.addProject')}
          </Button>
        ) : null}
      </div>

      <JsonConfigCard scope="global" file={data.global} />
      {data.project ? (
        <JsonConfigCard scope="project" file={data.project} />
      ) : (
        <section>
          <div className="px-1 pb-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('mcp.projectConfigTitle')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('mcp.projectNeedsCwd')}</p>
          </div>
        </section>
      )}

      <ServerEditorDialog
        editor={editor}
        error={editorError ?? actionError}
        saving={busy !== null && busy.startsWith('upsert:')}
        allowScope={!editor?.targetPath && data.projectCwd !== null}
        onChange={(form) => {
          setEditorError(null)
          setEditor((prev) => (prev ? { ...prev, form } : prev))
        }}
        onScopeChange={(scope) => setEditor((prev) => (prev ? { ...prev, scope } : prev))}
        onClose={() => setEditor(null)}
        onSave={() => void saveEditor()}
      />
      <ServerToolsDialog
        name={toolsTarget}
        server={data.servers.find((server) => server.name === toolsTarget) ?? null}
        onClose={() => setToolsTarget(null)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('mcp.deleteTitle')}
        message={t('mcp.deleteMessage', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget?.sourcePath) void deleteMcpServer(deleteTarget.sourcePath, deleteTarget.name)
        }}
      />
    </div>
  )
}

// ---- adapter install banner ----

function AdapterBanner() {
  const { t } = useI18n()
  const { busy, actionError } = useToolCatalog()
  const installing = busy === 'install:npm:pi-mcp-adapter'
  return (
    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 leading-4.5">{t('mcp.adapterMissing')}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={installing}
          onClick={() => {
            void installExtension('npm:pi-mcp-adapter').then((ok) => {
              if (ok) void refreshMcpState()
            })
          }}
        >
          {installing ? t('mcp.adapterInstalling') : t('mcp.adapterInstall')}
        </Button>
      </div>
      {actionError ? <p className="break-words text-xs text-destructive">{actionError}</p> : null}
    </div>
  )
}

// ---- server roster row ----

function ServerRow({
  server,
  busy,
  onToggle,
  onShowTools,
  onEdit,
  onDelete
}: {
  server: McpServerDTO
  busy: string | null
  onToggle: (enabled: boolean) => void
  onShowTools: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const statusMeta = server.status ? STATUS_META[server.status] : null
  const toggling = busy === `toggle:${server.name}`
  const transportLabel =
    server.transport === 'http'
      ? t('mcp.type.http')
      : server.transport === 'socket'
        ? t('mcp.type.socket')
        : t('mcp.type.stdio')
  const scopeLabel =
    server.scope === 'global'
      ? t('mcp.scope.global')
      : server.scope === 'project'
        ? t('mcp.scope.project')
        : t('mcp.scope.external')

  return (
    <div className="flex items-center gap-3 px-4 py-3" data-mcp-server={server.name}>
      {statusMeta ? (
        <Tooltip content={t(statusMeta.labelKey)}>
          <span
            aria-label={t(statusMeta.labelKey)}
            data-mcp-status
            className={cn('size-1.5 shrink-0 rounded-full', statusMeta.dot)}
          />
        </Tooltip>
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
          <span className="shrink-0 rounded-control bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {transportLabel}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-control px-1.5 py-px text-[10px] font-medium',
              server.scope === 'external'
                ? 'border border-border text-muted-foreground/70'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {scopeLabel}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
          {server.summary}
          {server.toolCount !== null ? (
            <span className="text-muted-foreground/60"> · {t('mcp.toolCount', { count: server.toolCount })}</span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t('mcp.showTools')}>
          <Button variant="ghost" size="icon" aria-label={t('mcp.showTools')} onClick={onShowTools}>
            <Wrench className="size-3.5" />
          </Button>
        </Tooltip>
        {server.editable ? (
          <>
            <Tooltip content={t('mcp.edit')}>
              <Button variant="ghost" size="icon" aria-label={t('mcp.edit')} onClick={onEdit}>
                <Pencil className="size-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content={t('common.delete')}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('common.delete')}
                className="hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </Tooltip>
          </>
        ) : (
          <Tooltip content={t('mcp.externalHint')}>
            <span className="grid size-8 place-items-center text-muted-foreground/50">
              <Info className="size-3.5" />
            </span>
          </Tooltip>
        )}
        <Checkbox
          mark="square"
          className="ml-1.5"
          checked={!server.disabled}
          disabled={toggling}
          onCheckedChange={onToggle}
          aria-label={t('mcp.toggleServer', { name: server.name })}
        />
      </div>
    </div>
  )
}

// ---- raw JSON editor for one config file ----

function JsonConfigCard({ scope, file }: { scope: McpConfigScope; file: McpConfigFileDTO }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<JsonDraft>({
    text: file.content,
    savedText: file.content,
    parseError: file.parseError
  })
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(async () => {
    const current = draftRef.current
    if (current.text === current.savedText) return
    if (!parseMcpConfigJson(current.text).ok) return
    const ok = await writeMcpConfig(scope, current.text)
    if (ok && draftRef.current.text === current.text) {
      setDraft((prev) => ({ ...prev, savedText: current.text }))
    }
  }, [scope])

  const saveRef = useRef(save)
  saveRef.current = save

  // Adopt external file changes (a toggle/upsert rewrote the file) only while
  // the draft is clean; a dirty draft keeps editing and rebases its baseline.
  useEffect(() => {
    setDraft((prev) =>
      prev.text === prev.savedText
        ? { text: file.content, savedText: file.content, parseError: file.parseError }
        : { ...prev, savedText: file.content }
    )
  }, [file.content, file.parseError])

  // Flush a pending debounce on unmount (valid drafts only).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void saveRef.current()
    }
  }, [])

  const title = scope === 'global' ? t('mcp.globalConfigTitle') : t('mcp.projectConfigTitle')
  const hint = scope === 'global' ? t('mcp.globalConfigHint') : t('mcp.projectConfigHint')

  return (
    <section>
      <div className="px-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
          <LabelTooltip content={file.path} wrap wrapperClassName="min-w-0">
            <button
              type="button"
              className="truncate text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => void window.pi.showInFolder(file.path)}
            >
              {shortenPath(file.path)}
            </button>
          </LabelTooltip>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/70">{hint}</p>
      </div>
      <div className="rounded-xl border border-border/70 bg-card p-3">
        <Input
          multiline
          rows={10}
          value={draft.text}
          aria-label={title}
          placeholder='{\n  "mcpServers": {}\n}'
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs leading-5"
          error={draft.parseError ? `${t('mcp.parseError')}: ${draft.parseError}` : undefined}
          onChange={(text) => {
            const parsed = parseMcpConfigJson(text)
            setDraft((prev) => ({ ...prev, text, parseError: parsed.ok ? null : parsed.error }))
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => void saveRef.current(), JSON_SAVE_DEBOUNCE_MS)
          }}
          onBlur={() => {
            if (timerRef.current) clearTimeout(timerRef.current)
            void save()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
              event.preventDefault()
              if (timerRef.current) clearTimeout(timerRef.current)
              void save()
            }
          }}
        />
      </div>
    </section>
  )
}

// ---- visual server editor dialog ----

function ServerEditorDialog({
  editor,
  error,
  saving,
  allowScope,
  onChange,
  onScopeChange,
  onClose,
  onSave
}: {
  editor: EditorState | null
  error: string | null
  saving: boolean
  allowScope: boolean
  onChange: (form: McpServerForm) => void
  onScopeChange: (scope: McpConfigScope) => void
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useI18n()
  const form = editor?.form ?? null
  const set = (patch: Partial<McpServerForm>) => {
    if (form) onChange({ ...form, ...patch })
  }

  return (
    <MorphingModal viewId={editor ? 'mcp-server-editor' : null} onClose={onClose} placement="center" className="max-w-lg">
      {form && editor ? (
        <div role="dialog" aria-modal="true" aria-label={t('mcp.editTitle')} className="flex max-h-[70vh] flex-col">
          <h2 className="text-base font-semibold text-foreground">
            {form.originalName ? t('mcp.editTitle') : t('mcp.addTitle')}
          </h2>
          <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-1">
            {!form.originalName && allowScope ? (
              <Tabs value={editor.scope} onValueChange={(scope) => onScopeChange(scope as McpConfigScope)} variant="pill">
                <TabsList className="flex w-full gap-1 rounded-control p-0.5">
                  <TabsTrigger value="global" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                    {t('mcp.scope.global')}
                  </TabsTrigger>
                  <TabsTrigger value="project" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                    {t('mcp.scope.project')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}

            <Input
              label={t('mcp.name')}
              value={form.name}
              placeholder={t('mcp.namePlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(name) => set({ name })}
            />

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('mcp.type')}</p>
              <Tabs
                value={form.transport}
                onValueChange={(transport) => set({ transport: transport as McpTransportKind })}
                variant="pill"
              >
                <TabsList className="flex w-full gap-1 rounded-control p-0.5">
                  <TabsTrigger value="stdio" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                    {t('mcp.type.stdio')}
                  </TabsTrigger>
                  <TabsTrigger value="http" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                    {t('mcp.type.http')}
                  </TabsTrigger>
                  <TabsTrigger value="socket" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                    {t('mcp.type.socket')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {form.transport === 'stdio' ? (
              <>
                <Input
                  label={t('mcp.command')}
                  value={form.command}
                  placeholder={t('mcp.commandPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(command) => set({ command })}
                />
                <StringListEditor
                  label={t('mcp.args')}
                  rows={form.args}
                  placeholder={t('mcp.argPlaceholder')}
                  addLabel={t('mcp.addArg')}
                  onChange={(args) => set({ args })}
                />
                <KeyValueListEditor
                  label={t('mcp.env')}
                  rows={form.env}
                  keyPlaceholder={t('mcp.envKey')}
                  valuePlaceholder={t('mcp.envValue')}
                  addLabel={t('mcp.addEnv')}
                  onChange={(env) => set({ env })}
                />
                <Input
                  label={t('mcp.cwd')}
                  value={form.cwd}
                  placeholder={t('mcp.cwdPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(cwd) => set({ cwd })}
                />
              </>
            ) : form.transport === 'http' ? (
              <>
                <Input
                  label={t('mcp.url')}
                  value={form.url}
                  placeholder={t('mcp.urlPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(url) => set({ url })}
                />
                <KeyValueListEditor
                  label={t('mcp.headers')}
                  rows={form.headers}
                  keyPlaceholder={t('mcp.headerKey')}
                  valuePlaceholder={t('mcp.headerValue')}
                  addLabel={t('mcp.addHeader')}
                  onChange={(headers) => set({ headers })}
                />
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('mcp.auth')}</p>
                  <Tabs value={form.auth} onValueChange={(auth) => set({ auth: auth as McpAuthKind })} variant="pill">
                    <TabsList className="flex w-full gap-1 rounded-control p-0.5">
                      <TabsTrigger value="none" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                        {t('mcp.auth.none')}
                      </TabsTrigger>
                      <TabsTrigger value="bearer" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                        {t('mcp.auth.bearer')}
                      </TabsTrigger>
                      <TabsTrigger value="oauth" className="flex-1 rounded-control px-3 py-1.5 text-xs">
                        {t('mcp.auth.oauth')}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {form.auth === 'bearer' ? (
                  <Input
                    label={t('mcp.bearerToken')}
                    type="password"
                    value={form.bearerToken}
                    placeholder={t('mcp.bearerTokenPlaceholder')}
                    autoComplete="off"
                    onChange={(bearerToken) => set({ bearerToken })}
                  />
                ) : null}
              </>
            ) : (
              <Input
                label={t('mcp.socket')}
                value={form.socket}
                placeholder={t('mcp.socketPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onChange={(socket) => set({ socket })}
              />
            )}

            <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox
                mark="square"
                checked={form.disabled}
                onCheckedChange={(disabled) => set({ disabled })}
                aria-label={t('mcp.disabledOnSave')}
              />
              {t('mcp.disabledOnSave')}
            </label>
          </div>

          {error ? <p className="mt-2 break-words px-1 text-xs text-destructive">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={onSave}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </MorphingModal>
  )
}

function StringListEditor({
  label,
  rows,
  placeholder,
  addLabel,
  onChange
}: {
  label: string
  rows: string[]
  placeholder: string
  addLabel: string
  onChange: (rows: string[]) => void
}) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              value={row}
              placeholder={placeholder}
              aria-label={placeholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(value) => onChange(rows.map((item, i) => (i === index ? value : item)))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.delete')}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => onChange([...rows, ''])}>
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}

function KeyValueListEditor({
  label,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onChange
}: {
  label: string
  rows: McpKeyValue[]
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  onChange: (rows: McpKeyValue[]) => void
}) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              value={row.key}
              placeholder={keyPlaceholder}
              aria-label={keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(key) => onChange(rows.map((item, i) => (i === index ? { ...item, key } : item)))}
            />
            <Input
              value={row.value}
              placeholder={valuePlaceholder}
              aria-label={valuePlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(value) => onChange(rows.map((item, i) => (i === index ? { ...item, value } : item)))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.delete')}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}

// ---- read-only tools viewer ----

function ServerToolsDialog({
  name,
  server,
  onClose
}: {
  name: string | null
  server: McpServerDTO | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<McpServerDetailDTO | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!name) return
    let cancelled = false
    setDetail(null)
    setFailed(false)
    fetchMcpServerDetail(name)
      .then((result) => {
        if (!cancelled) setDetail(result)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [name])

  const statusMeta = server?.status ? STATUS_META[server.status] : null

  return (
    <MorphingModal viewId={name ? 'mcp-server-tools' : null} onClose={onClose} placement="center" className="max-w-lg">
      {name ? (
        <div role="dialog" aria-modal="true" aria-label={name} className="flex max-h-[70vh] flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {statusMeta ? <span className={cn('size-1.5 shrink-0 rounded-full', statusMeta.dot)} /> : null}
            <h2 className="truncate text-base font-semibold text-foreground">{name}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {statusMeta ? t(statusMeta.labelKey) : null}
            {detail?.cachedAt
              ? ` · ${t('mcp.cachedAt', { time: new Date(detail.cachedAt).toLocaleString() })}`
              : null}
          </p>
          {server?.sourcePath ? (
            <button
              type="button"
              className="mt-0.5 self-start truncate text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => void window.pi.showInFolder(server.sourcePath!)}
            >
              {shortenPath(server.sourcePath)}
            </button>
          ) : null}

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {failed ? (
              <div className="flex items-center gap-2 text-xs text-destructive">
                <CircleAlert className="size-3.5" />
                {t('mcp.toolsLoadFailed')}
              </div>
            ) : !detail ? (
              <p className="text-xs text-muted-foreground">{t('mcp.loading')}</p>
            ) : detail.tools.length + detail.resources.length + detail.prompts.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('mcp.toolsEmpty')}</p>
            ) : (
              <div className="space-y-4">
                {detail.tools.length > 0 ? (
                  <section>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('mcp.toolsSection', { count: detail.tools.length })}
                    </p>
                    <ul className="space-y-1.5">
                      {detail.tools.map((tool) => (
                        <li key={tool.name} className="min-w-0">
                          <p className="truncate font-mono text-xs text-foreground">{tool.name}</p>
                          {tool.description ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                              {tool.description}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {detail.resources.length > 0 ? (
                  <section>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('mcp.resourcesSection', { count: detail.resources.length })}
                    </p>
                    <ul className="space-y-1.5">
                      {detail.resources.map((resource) => (
                        <li key={resource.uri} className="min-w-0">
                          <p className="truncate font-mono text-xs text-foreground">{resource.name}</p>
                          <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{resource.uri}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {detail.prompts.length > 0 ? (
                  <section>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('mcp.promptsSection', { count: detail.prompts.length })}
                    </p>
                    <ul className="space-y-1.5">
                      {detail.prompts.map((prompt) => (
                        <li key={prompt.name} className="min-w-0">
                          <p className="truncate font-mono text-xs text-foreground">{prompt.name}</p>
                          {prompt.description ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                              {prompt.description}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </MorphingModal>
  )
}
