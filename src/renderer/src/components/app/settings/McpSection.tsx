import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  ChevronRight,
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
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { cn } from '@/lib/utils'
import { FadeScroll } from '@/components/app/FadeScroll'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import {
  MCP_DOCS_URL,
  MCP_EXPOSURES,
  createEmptyMcpServerForm,
  formToServerEntry,
  parseMcpConfigJson,
  parseMcpServerSnippet,
  serverEntryToForm,
  unsupportedMcpField,
  validateMcpServerEntry,
  validateMcpServerForm,
  validateMcpConfigDocument,
  type McpKeyValue,
  type McpServerForm,
  type McpTransportKind
} from '@/lib/mcp-config'
import {
  clearMcpActionError,
  deleteMcpServer,
  fetchMcpServerDetail,
  peekMcpServerDetail,
  refreshMcpState,
  setMcpServerDisabled,
  upsertMcpServer,
  useMcpStore,
  writeMcpConfig
} from '@/lib/mcp-store'
import { getToolParameterFields } from '@/lib/tool-schema'
import { FORM_CHOICE_TEXT, FORM_FIELD_HEADING, FORM_INPUT_LABEL } from '@/lib/form-standard'
import type {
  McpConfigFileDTO,
  McpConfigIssueDTO,
  McpExposure,
  McpRuntimeStatus,
  McpServerDTO,
  McpServerDetailDTO
} from '../../../../../shared/types'
import { ConfirmDialog } from '../ConfirmDialog'
import { LabelTooltip } from '../LabelTooltip'
import { SettingsGroup } from './SettingsRow'

/**
 * Settings → MCP: Pi's built-in configuration, at the native global and
 * trusted-project paths. Tool metadata comes from the active SDK session.
 */

const JSON_SAVE_DEBOUNCE_MS = 800

interface JsonDraft {
  text: string
  savedText: string
  parseError: string | null
}

interface EditorState {
  form: McpServerForm
  /** Existing server: its defining file. New server: absent (uses scope). */
  targetPath?: string
  scope: 'global' | 'project'
  /** Adding offers a paste-a-snippet mode beside the visual form. */
  mode: 'visual' | 'json'
  snippet: string
}

const STATUS_META: Record<McpRuntimeStatus, { dot: string; labelKey: MessageKey }> = {
  configured: { dot: 'border border-muted-foreground/50', labelKey: 'mcp.status.configured' },
  connecting: { dot: 'bg-sky-500', labelKey: 'mcp.status.connecting' },
  connected: { dot: 'bg-emerald-500', labelKey: 'mcp.status.connected' },
  disconnected: { dot: 'border border-muted-foreground/50', labelKey: 'mcp.status.disconnected' },
  failed: { dot: 'bg-destructive', labelKey: 'mcp.status.failed' },
  'needs-auth': { dot: 'bg-amber-500', labelKey: 'mcp.status.needsAuth' },
  disabled: { dot: 'bg-muted-foreground/40', labelKey: 'mcp.status.disabled' }
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

export function McpSection() {
  const { t } = useI18n()
  const { status, data, error, busy, actionError } = useMcpStore()
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

  const startNew = () => {
    setEditorError(null)
    setEditor({ form: createEmptyMcpServerForm(), scope: 'global', mode: 'visual', snippet: '' })
  }

  const startEdit = (server: McpServerDTO) => {
    if (!server.editable || !server.sourcePath) return
    setEditorError(null)
    setEditor({
      form: serverEntryToForm(server.name, server.entry),
      targetPath: server.sourcePath,
      scope: server.scope === 'project' ? 'project' : 'global',
      mode: 'visual',
      snippet: ''
    })
  }

  const saveEditor = async () => {
    if (!editor || busy) return
    if (editor.mode === 'json') {
      const parsed = parseMcpServerSnippet(editor.snippet)
      if (!parsed.ok) {
        setEditorError(
          parsed.issue === 'json'
            ? `${t('mcp.error.snippetJson')} ${parsed.detail ?? ''}`.trim()
            : parsed.issue === 'multiple'
              ? t('mcp.error.snippetMultiple', { count: parsed.count ?? 0 })
              : t('mcp.error.snippetShape')
        )
        return
      }
      // The raw snippet entry is the payload (extras survive untouched); the
      // form round-trip only reuses the validator's name/endpoint rules. A new
      // server has no rename source, so originalName must stay empty — else
      // the duplicate check exempts the pasted name against itself.
      const snippetForm = serverEntryToForm(parsed.name, parsed.entry)
      delete snippetForm.originalName
      const snippetIssues = validateMcpServerForm(snippetForm, existingNames, editor.scope)
      const invalidNativeField = validateMcpServerEntry(parsed.name, parsed.entry, editor.scope)
      if (snippetIssues.length > 0 && snippetIssues[0] !== 'legacyField') {
        setEditorError(t(`mcp.error.${snippetIssues[0]}` as MessageKey, { name: parsed.name }))
        return
      }
      if (invalidNativeField) {
        setEditorError(t(unsupportedMcpField(parsed.entry) ? 'mcp.error.legacyField' : 'mcp.error.configField', { field: invalidNativeField }))
        return
      }
      const ok = await upsertMcpServer({
        scope: editor.scope,
        originalName: null,
        name: parsed.name,
        entry: parsed.entry
      })
      if (ok) setEditor(null)
      return
    }
    const issues = validateMcpServerForm(editor.form, existingNames, editor.scope)
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
      {data.configIssues.length > 0 ? <ConfigIssues issues={data.configIssues} /> : null}

      {actionError ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings.extensionDismissError')}
            onClick={clearMcpActionError}
            className="size-5 shrink-0"
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted-foreground/70">{t('mcp.native')}</p>
        <div className="flex items-center gap-1">
          <Tooltip content={t('mcp.docs')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('mcp.docs')}
              onClick={() => void window.pi.openExternal(MCP_DOCS_URL)}
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
      <div className="flex justify-center">
        <Button variant="outline" size="sm" onClick={startNew}>
          <Plus className="size-3.5" />
          {t('mcp.add')}
        </Button>
      </div>

      <JsonConfigCard scope="global" file={data.global} />
      {data.project ? <JsonConfigCard scope="project" file={data.project} trusted={data.projectTrusted} /> : null}

      <ServerEditorDialog
        editor={editor}
        error={editorError ?? actionError}
        saving={busy !== null && busy.startsWith('upsert:')}
        projectAvailable={Boolean(data.project && data.projectTrusted)}
        onChange={(form) => {
          setEditorError(null)
          setEditor((prev) => (prev ? { ...prev, form } : prev))
        }}
        onModeChange={(mode) => {
          setEditorError(null)
          setEditor((prev) => (prev ? { ...prev, mode } : prev))
        }}
        onScopeChange={(scope) => {
          setEditor((prev) => (prev ? { ...prev, scope } : prev))
        }}
        onSnippetChange={(snippet) => {
          setEditorError(null)
          setEditor((prev) => (prev ? { ...prev, snippet } : prev))
        }}
        onClose={() => setEditor(null)}
        onSave={() => void saveEditor()}
      />
      <ServerToolsDialog
        name={toolsTarget}
        sessionPath={data.sessionPath}
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

// ---- native config diagnostics ----

function ConfigIssues({ issues }: { issues: McpConfigIssueDTO[] }) {
  const { t } = useI18n()
  return (
    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <p className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Info className="size-3.5 shrink-0" />{t('mcp.configIssuesTitle')}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
        {issues.map((issue, index) => (
          <li key={index}>
            {t(issue.scope === 'global' ? 'mcp.scope.global' : 'mcp.scope.project')}: {' '}
            {t(issue.code === 'legacyField' && !issue.name
              ? 'mcp.issue.legacyRootField'
              : issue.code === 'invalidField' && !issue.name
                ? 'mcp.issue.invalidRootField'
                : `mcp.issue.${issue.code}` as MessageKey, {
              name: issue.name ?? '',
              field: issue.field ?? '',
              detail: issue.detail ?? ''
            })}
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-700 dark:text-amber-400">{t('mcp.configIssuesHint')}</p>
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
      : server.transport === 'registered'
        ? t('mcp.type.registered')
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
          <span className="shrink-0 rounded-control bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground">
            {transportLabel}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-control px-1.5 py-px text-micro font-medium',
              server.scope === 'external'
                ? 'border border-border text-muted-foreground/70'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {scopeLabel}
          </span>
          <span className="shrink-0 rounded-control bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground">
            {t(`mcp.exposure.${server.exposure}` as MessageKey)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs leading-ui-tight text-muted-foreground">
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
        {server.editable ? (
          <Checkbox
            mark="square"
            className="ml-1.5"
            checked={!server.disabled}
            disabled={toggling}
            onCheckedChange={onToggle}
            aria-label={t('mcp.toggleServer', { name: server.name })}
          />
        ) : null}
      </div>
    </div>
  )
}

// ---- raw JSON editor for one config file ----

function JsonConfigCard({ file, scope, trusted = true }: { file: McpConfigFileDTO; scope: 'global' | 'project'; trusted?: boolean }) {
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
    const parsed = parseMcpConfigJson(current.text)
    if (!parsed.ok || validateMcpConfigDocument(parsed.config, scope)) return
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

  const title = t(scope === 'global' ? 'mcp.globalConfigTitle' : 'mcp.projectConfigTitle')
  const hint = t(scope === 'global' ? 'mcp.globalConfigHint' : 'mcp.projectConfigHint')

  return (
    <section>
      <div className="px-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
          <LabelTooltip content={file.path} wrap wrapperClassName="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              className="truncate text-caption text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => void window.pi.showInFolder(file.path)}
            >
              {shortenPath(file.path)}
            </Button>
          </LabelTooltip>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/70">{hint}</p>
      </div>
      <Input
        multiline
        rows={10}
          disabled={!trusted}
          value={draft.text}
          aria-label={title}
          placeholder='{\n  "mcpServers": {}\n}'
          spellCheck={false}
          autoComplete="off"
          classNames={{ input: 'font-mono text-xs leading-ui' }}
          error={draft.parseError ? `${t('mcp.parseError')}: ${draft.parseError}` : undefined}
          onChange={(text) => {
            const parsed = parseMcpConfigJson(text)
            const unsupported = parsed.ok ? validateMcpConfigDocument(parsed.config, scope) : null
            setDraft((prev) => ({ ...prev, text, parseError: parsed.ok ? (unsupported ? t('mcp.error.configField', { field: unsupported }) : null) : parsed.error }))
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
    </section>
  )
}

// ---- visual server editor dialog ----


function ServerEditorDialog({
  editor,
  error,
  saving,
  projectAvailable,
  onChange,
  onModeChange,
  onScopeChange,
  onSnippetChange,
  onClose,
  onSave
}: {
  editor: EditorState | null
  error: string | null
  saving: boolean
  projectAvailable: boolean
  onChange: (form: McpServerForm) => void
  onModeChange: (mode: 'visual' | 'json') => void
  onScopeChange: (scope: 'global' | 'project') => void
  onSnippetChange: (snippet: string) => void
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useI18n()
  const form = editor?.form ?? null
  const [oauthExpanded, setOauthExpanded] = useState(false)
  const hasOauthSettings = Boolean(form && (
    form.oauthClientId || form.oauthClientSecret || form.oauthCallbackPort || form.oauthCallbackUrl || form.oauthScope || form.oauthClientName || form.oauthAuthServerMetadataUrl
  ))
  const oauthOpen = oauthExpanded || hasOauthSettings
  const set = (patch: Partial<McpServerForm>) => {
    if (form) onChange({ ...form, ...patch })
  }

  return (
    <MorphingModal viewId={editor ? 'mcp-server-editor' : null} onClose={onClose} placement="center" className="w-[min(52rem,calc(100vw-3rem))] max-w-none">
      {form && editor ? (
        <div role="dialog" aria-modal="true" aria-label={t('mcp.editTitle')} className="flex max-h-[calc(100vh-6rem)] flex-col">
          <h2 className="text-base font-semibold text-foreground">
            {form.originalName ? t('mcp.editTitle') : t('mcp.addTitle')}
          </h2>
          <div data-form-items className="mt-3 grid min-h-0 flex-1 gap-5 overflow-y-auto overscroll-contain p-1 md:grid-cols-2">
            {!editor.targetPath ? (
              <div className="grid gap-5 md:col-span-2 md:grid-cols-2">
                <div>
                  <p className={FORM_FIELD_HEADING}>{t('mcp.mode')}</p>
              <RadioGroup
                value={editor.mode}
                onValueChange={(mode) => onModeChange(mode as 'visual' | 'json')}
                orientation="horizontal"
                className="w-full"
              >
                <RadioGroupItem value="visual" label={t('mcp.modeVisual')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
                <RadioGroupItem value="json" label={t('mcp.modeJson')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
              </RadioGroup>
                </div>
                {projectAvailable ? (
                  <div>
                    <p className={FORM_FIELD_HEADING}>{t('mcp.saveScope')}</p>
                    <RadioGroup
                      value={editor.scope}
                      onValueChange={(scope) => onScopeChange(scope as 'global' | 'project')}
                      orientation="horizontal"
                      className="w-full"
                    >
                      <RadioGroupItem value="global" label={t('mcp.scope.global')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
                      <RadioGroupItem value="project" label={t('mcp.scope.project')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
                    </RadioGroup>
                  </div>
                ) : null}
              </div>
            ) : null}

            {editor.mode === 'json' ? (
              <div className="md:col-span-2">
                <Input
                  multiline
                  rows={12}
                  label={t('mcp.snippetLabel')}
                  value={editor.snippet}
                  placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'}
                  spellCheck={false}
                  autoComplete="off"
                  // Monospace belongs to the textarea, not the label above it.
                  classNames={{ ...FORM_INPUT_LABEL, input: 'font-mono text-sm leading-ui' }}
                  onChange={onSnippetChange}
                />
                <p className="mt-1.5 text-caption leading-ui-tight text-muted-foreground/70">
                  {t('mcp.snippetHint')}
                </p>
              </div>
            ) : (
              <>
            <Input
              label={t('mcp.name')}
              value={form.name}
              placeholder={t('mcp.namePlaceholder')}
              spellCheck={false}
              autoComplete="off"
              classNames={FORM_INPUT_LABEL}
              onChange={(name) => set({ name })}
            />

            <div>
              <p className={FORM_FIELD_HEADING}>{t('mcp.type')}</p>
              <RadioGroup
                value={form.transport}
                onValueChange={(transport) => set({ transport: transport as McpTransportKind })}
                orientation="horizontal"
                className="w-full"
              >
                <RadioGroupItem value="stdio" label={t('mcp.type.stdio')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
                <RadioGroupItem value="http" label={t('mcp.type.http')} className={cn('flex-1', FORM_CHOICE_TEXT)} />
              </RadioGroup>
            </div>

            <Input
              label={t('mcp.description')}
              value={form.description}
              placeholder={t('mcp.descriptionPlaceholder')}
              classNames={FORM_INPUT_LABEL}
              onChange={(description) => set({ description })}
            />

            {form.transport === 'stdio' ? (
              <>
                <Input
                  label={t('mcp.command')}
                  value={form.command}
                  placeholder={t('mcp.commandPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
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
                  classNames={FORM_INPUT_LABEL}
                  onChange={(cwd) => set({ cwd })}
                />
              </>
            ) : (
              <>
                <Input
                  label={t('mcp.url')}
                  value={form.url}
                  placeholder={t('mcp.urlPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
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
                  <Input
                    label={t('mcp.authProvider')}
                    value={form.authProvider}
                    placeholder={t('mcp.authProviderPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    classNames={FORM_INPUT_LABEL}
                    onChange={(authProvider) => set({ authProvider })}
                  />
                  <p className="mt-1.5 text-xs leading-ui-tight text-muted-foreground">{t('mcp.authProviderHint')}</p>
                </div>
                <div className="md:col-span-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start gap-1.5 text-sm"
                    aria-expanded={oauthOpen}
                    aria-controls="mcp-oauth-options"
                    onClick={() => setOauthExpanded((open) => !open)}
                  >
                    {t('mcp.oauthOptions')}
                    <ChevronRight className={cn('size-3.5 transition-transform', oauthOpen && 'rotate-90')} />
                  </Button>
                  <AgentDisclosure id="mcp-oauth-options" open={oauthOpen} className="grid gap-5 pt-2 md:grid-cols-2">
                <Input
                  label={t('mcp.oauthClientName')}
                  value={form.oauthClientName}
                  placeholder={t('mcp.oauthClientNamePlaceholder')}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthClientName) => set({ oauthClientName })}
                />
                <Input
                  label={t('mcp.oauthMetadataUrl')}
                  value={form.oauthAuthServerMetadataUrl}
                  placeholder={t('mcp.oauthMetadataUrlPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthAuthServerMetadataUrl) => set({ oauthAuthServerMetadataUrl })}
                />
                <Input
                  label={t('mcp.oauthClientId')}
                  value={form.oauthClientId}
                  placeholder={t('mcp.oauthClientIdPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthClientId) => set({ oauthClientId })}
                />
                <Input
                  label={t('mcp.oauthClientSecret')}
                  type="password"
                  value={form.oauthClientSecret}
                  placeholder={t('mcp.oauthClientSecretPlaceholder')}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthClientSecret) => set({ oauthClientSecret })}
                />
                <Input
                  label={t('mcp.oauthCallbackPort')}
                  value={form.oauthCallbackPort}
                  inputMode="numeric"
                  placeholder={t('mcp.oauthCallbackPortPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthCallbackPort) => set({ oauthCallbackPort })}
                />
                <Input
                  label={t('mcp.oauthCallbackUrl')}
                  value={form.oauthCallbackUrl}
                  placeholder={t('mcp.oauthCallbackUrlPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthCallbackUrl) => set({ oauthCallbackUrl })}
                />
                <Input
                  label={t('mcp.oauthScope')}
                  value={form.oauthScope}
                  placeholder={t('mcp.oauthScopePlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  classNames={FORM_INPUT_LABEL}
                  onChange={(oauthScope) => set({ oauthScope })}
                />
                <p className="self-end text-xs leading-ui-tight text-muted-foreground md:col-span-2">{t('mcp.oauthHint')}</p>
                  </AgentDisclosure>
                </div>
              </>
            )}

            <ExposureField value={form.exposure} onChange={(exposure) => set({ exposure })} />
            <ToolExposureEditor rows={form.toolExposure} onChange={(toolExposure) => set({ toolExposure })} />
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                mark="square"
                checked={!form.enabled}
                onCheckedChange={(disabled) => set({ enabled: !disabled })}
                aria-label={t('mcp.disabledOnSave')}
              />
              {t('mcp.disabledOnSave')}
            </label>
              </>
            )}
          </div>

          {error ? <p className="mt-2 break-words text-xs text-destructive">{error}</p> : null}
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

function ExposureField({ value, onChange }: { value: McpExposure; onChange: (value: McpExposure) => void }) {
  const { t } = useI18n()
  return (
    <div>
      <p className={FORM_FIELD_HEADING}>{t('mcp.exposure')}</p>
      <Select value={value} onValueChange={(next) => onChange(next as McpExposure)}>
        <SelectTrigger className="w-full text-xs" aria-label={t('mcp.exposure')}><SelectValue /></SelectTrigger>
        <SelectContent portal>
          {MCP_EXPOSURES.map((exposure) => (
            <SelectItem key={exposure} value={exposure} className="text-xs">
              {t(`mcp.exposure.${exposure}` as MessageKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-caption leading-ui-tight text-muted-foreground">{t(`mcp.exposureHint.${value}` as MessageKey)}</p>
    </div>
  )
}

function ToolExposureEditor({ rows, onChange }: { rows: McpKeyValue[]; onChange: (rows: McpKeyValue[]) => void }) {
  const { t } = useI18n()
  return (
    <div className="md:col-span-2">
      <p className={FORM_FIELD_HEADING}>{t('mcp.toolExposure')}</p>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              className="min-w-0 flex-1"
              value={row.key}
              placeholder={t('mcp.toolExposureName')}
              aria-label={t('mcp.toolExposureName')}
              spellCheck={false}
              autoComplete="off"
              onChange={(key) => onChange(rows.map((item, i) => i === index ? { ...item, key } : item))}
            />
            <Select
              value={MCP_EXPOSURES.includes(row.value as McpExposure) ? row.value : 'codemode'}
              onValueChange={(value) => onChange(rows.map((item, i) => i === index ? { ...item, value } : item))}
            >
              <SelectTrigger className="w-44 text-xs" aria-label={t('mcp.toolExposure')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent portal>
                {MCP_EXPOSURES.map((exposure) => (
                  <SelectItem key={exposure} value={exposure} className="text-xs">
                    {t(`mcp.exposure.${exposure}` as MessageKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" aria-label={t('common.delete')}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => onChange([...rows, { key: '', value: 'codemode' }])}>
          <Plus className="size-3.5" />{t('mcp.addToolExposure')}
        </Button>
      </div>
      <p className="mt-1.5 text-caption leading-ui-tight text-muted-foreground">{t('mcp.toolExposureHint')}</p>
    </div>
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
      <p className={FORM_FIELD_HEADING}>{label}</p>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              className="min-w-0 flex-1"
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
      <p className={FORM_FIELD_HEADING}>{label}</p>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              className="min-w-0 flex-1"
              value={row.key}
              placeholder={keyPlaceholder}
              aria-label={keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(key) => onChange(rows.map((item, i) => (i === index ? { ...item, key } : item)))}
            />
            <Input
              className="min-w-0 flex-1"
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
  sessionPath,
  server,
  onClose
}: {
  name: string | null
  sessionPath: string | null
  server: McpServerDTO | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<McpServerDetailDTO | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!name) return
    let cancelled = false
    // The store cache renders instantly — reopening or switching servers never
    // blanks the panel; the fresh read then replaces the content silently.
    const cached = peekMcpServerDetail(name)
    setDetail(cached)
    setFailed(false)
    fetchMcpServerDetail(name)
      .then((result) => {
        if (!cancelled) setDetail(result)
      })
      .catch(() => {
        // A failure with no cache to fall back on is the only error state.
        if (!cancelled && !cached) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [name, sessionPath, server?.status, server?.toolCount])

  const statusMeta = server?.status ? STATUS_META[server.status] : null

  return (
    <MorphingModal viewId={name ? 'mcp-server-tools' : null} onClose={onClose} placement="center" className="max-w-xl">
      {name ? (
        <div role="dialog" aria-modal="true" aria-label={name} className="flex max-h-[74vh] flex-col">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 max-w-[40%] items-center gap-2">
              {statusMeta ? <span className={cn('size-1.5 shrink-0 rounded-full', statusMeta.dot)} /> : null}
              <h2 className="truncate text-base font-semibold text-foreground">{name}</h2>
            </div>
            <div className="flex min-w-0 max-w-[60%] items-center justify-end gap-3">
              {statusMeta ? (
                <Tooltip content={t(statusMeta.labelKey)} wrapperClassName="min-w-0 max-w-[60%] shrink-0">
                  <span className="truncate text-xs text-muted-foreground">{t(statusMeta.labelKey)}</span>
                </Tooltip>
              ) : null}
              {server?.sourcePath ? (
                <LabelTooltip content={server.sourcePath} wrap wrapperClassName="min-w-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 max-w-full p-0 text-caption font-normal text-muted-foreground/60 hover:text-muted-foreground"
                    onClick={() => void window.pi.showInFolder(server.sourcePath!)}
                  >
                    <span className="truncate">{shortenPath(server.sourcePath)}</span>
                  </Button>
                </LabelTooltip>
              ) : null}
            </div>
          </div>

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
                    <ul className="space-y-2">
                      {detail.tools.map((tool) => (
                        <ToolDetailBlock key={tool.name} tool={tool} />
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
                          <p className="mt-0.5 truncate text-caption leading-ui-tight text-muted-foreground">
                            {resource.uri}
                          </p>
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
                    <ul className="space-y-2">
                      {detail.prompts.map((prompt) => (
                        <li key={prompt.name} className="min-w-0 rounded-xl border border-border/60 bg-card px-3 py-2.5">
                          <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                            {prompt.name}
                          </code>
                          {prompt.description ? (
                            <p className="mt-1.5 text-xs leading-ui-tight text-muted-foreground">{prompt.description}</p>
                          ) : null}
                          {prompt.arguments && prompt.arguments.length > 0 ? (
                            <div className="mt-2 border-t border-border/60 pt-2">
                              <p className="mb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
                                {t('mcp.promptArguments')}
                              </p>
                              <ul className="space-y-1">
                                {prompt.arguments.map((argument) => (
                                  <li key={argument.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                                    <code className="font-mono text-foreground">{argument.name}</code>
                                    <span className={argument.required ? 'text-primary' : 'text-muted-foreground/70'}>
                                      {argument.required ? t('settings.toolRequired') : t('settings.toolOptional')}
                                    </span>
                                    {argument.description ? (
                                      <span className="min-w-0 flex-1 text-muted-foreground">{argument.description}</span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
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

/** One SDK-registered tool with its JSON-Schema parameters. */
function ToolDetailBlock({ tool }: { tool: McpServerDetailDTO['tools'][number] }) {
  const { t } = useI18n()
  const fields = getToolParameterFields(tool.inputSchema ?? {})
  return (
    <li className="min-w-0 rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <code className="rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
          {tool.name}
        </code>
        {tool.exposure ? (
          <span className="rounded-control bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
            {t(`mcp.exposure.${tool.exposure}` as MessageKey)}
          </span>
        ) : null}
      </div>
      {tool.description ? (
        // Long server-provided prose (context7's instructions are infamous)
        // scrolls inside a bounded area instead of stretching the dialog.
        <FadeScroll className="mt-1.5 max-h-44">
          <p className="text-xs leading-ui-tight text-muted-foreground">{tool.description}</p>
        </FadeScroll>
      ) : null}
      {fields.length > 0 ? (
        <div className="mt-2 divide-y divide-border/60 border-t border-border/60">
          {fields.map((field) => (
            <div key={field.name} className="grid gap-2 py-2 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
              <div className="min-w-0">
                <code className="break-words font-mono text-xs text-foreground">{field.name}</code>
                <p className={cn('mt-0.5 text-micro', field.required ? 'text-primary' : 'text-muted-foreground')}>
                  {field.required ? t('settings.toolRequired') : t('settings.toolOptional')}
                </p>
              </div>
              <div className="min-w-0 space-y-1">
                <code className="block break-words font-mono text-caption text-foreground/80">{field.type}</code>
                {field.description ? (
                  <p className="text-xs leading-ui-tight text-muted-foreground">{field.description}</p>
                ) : null}
                {field.allowedValues ? (
                  <p className="text-caption text-muted-foreground/70">
                    {t('settings.toolAllowedValues')}: <code className="font-mono">{field.allowedValues}</code>
                  </p>
                ) : null}
                {field.defaultValue !== undefined ? (
                  <p className="text-caption text-muted-foreground/70">
                    {t('settings.toolDefaultValue')}: <code className="font-mono">{field.defaultValue}</code>
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-caption text-muted-foreground/70">{t('settings.toolNoParameters')}</p>
      )}
    </li>
  )
}
