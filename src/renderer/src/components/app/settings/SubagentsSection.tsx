import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText, FolderOpen, Plus, RefreshCw } from '@/lib/icons'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { FORM_FIELD_TITLE, FORM_PANEL_TITLE } from '@/lib/form-standard'
import { Checkbox } from '@/components/motion/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Tooltip } from '@/components/motion/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import { refreshCatalog, useToolCatalog } from '@/lib/extensions-catalog'
import { Markdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { FadeScroll } from '../FadeScroll'
import {
  canonicalToolNames,
  sameTools,
  subagentToolGroups,
  type SubagentToolEntry,
  type SubagentToolGroups,
  type SubagentToolOption
} from '@/lib/subagent-tools'
import {
  SUBAGENT_MAX_TURNS_LIMIT,
  SUBAGENT_PROFILE_NAME_PATTERN,
  type SubagentProfileCreatePayload,
  type SubagentProfileDTO,
  type SubagentProfilesDTO
} from '../../../../../shared/types'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Mirrors the main-process guard for `subagents:setMaxConcurrent`. */
const SUBAGENT_MIN_CONCURRENT = 1
const SUBAGENT_MAX_CONCURRENT = 16

/** The in-progress tool edit for one profile. `null` means the editor shows
 * the profile's saved state. */
interface ToolsDraft {
  mode: 'all' | 'explicit'
  selected: Set<string>
}

/**
 * Settings → Subagents. Two things live here:
 *
 * - the delegation switch and the per-parent concurrency limit (moved here
 *   from General, because this tab is the subagents' home);
 * - every profile as an ordinary editable file — prompt and the enabled
 *   tool set, the one thing edited in place (written back as a surgical
 *   `tools:` line). Every other frontmatter field — model, thinking, even
 *   the path — belongs to the file alone (the open-file button's tooltip
 *   names the target), and granting the debugger rides the same tools list:
 *   `all`, or an explicit `debug` entry. The picker lists SDK built-ins and
 *   every extension tool from the shared catalog, with the whole MCP
 *   section collapsed into one family row, exactly like an extension family.
 *
 * beUI-native: Tabs for the list/detail split, RadioGroup + Checkbox, Input
 * for the limit, Button rows, FadeScroll to bound the picker, and the app's
 * Markdown renderer for the system prompt preview.
 */
export function SubagentsSection() {
  const { t } = useI18n()

  // --- delegation switch + concurrency limit (moved from General) ---
  const [subagentsEnabled, setSubagentsEnabled] = useState(true)
  const [savingSubagents, setSavingSubagents] = useState(false)
  const [subagentConcurrent, setSubagentConcurrent] = useState(4)
  // Free text only while the field is being edited; `null` shows the saved
  // number, so a failed save or a blur always lands on a real value.
  const [concurrentDraft, setConcurrentDraft] = useState<string | null>(null)
  const [savingConcurrent, setSavingConcurrent] = useState(false)
  const [concurrentError, setConcurrentError] = useState(false)
  // --- reuse + communication switches (default off; both need delegation) ---
  const [reuseEnabled, setReuseEnabled] = useState(false)
  const [savingReuse, setSavingReuse] = useState(false)
  const [commsEnabled, setCommsEnabled] = useState(false)
  const [savingComms, setSavingComms] = useState(false)
  const [turnLimitOverrideEnabled, setTurnLimitOverrideEnabled] = useState(false)
  const [savingTurnLimitOverride, setSavingTurnLimitOverride] = useState(false)
  const [turnLimitOverrideError, setTurnLimitOverrideError] = useState(false)
  const [maxTurns, setMaxTurns] = useState<number | null>(null)
  const [maxTurnsDraft, setMaxTurnsDraft] = useState<string | null>(null)
  const [savingMaxTurns, setSavingMaxTurns] = useState(false)
  const [maxTurnsError, setMaxTurnsError] = useState(false)
  const saveConcurrent = (value: number) => {
    setSubagentConcurrent(value)
    setSavingConcurrent(true)
    setConcurrentError(false)
    void window.pi
      .setSubagentMaxConcurrent(value)
      .then(setSubagentConcurrent, () => setConcurrentError(true))
      .finally(() => setSavingConcurrent(false))
  }
  // Leaving the field clamps whatever was typed into 1–16 and saves only a real
  // change, so keystrokes never race the setter.
  const commitConcurrent = () => {
    const parsed = Number.parseInt(concurrentDraft ?? '', 10)
    const next = Number.isFinite(parsed)
      ? Math.min(SUBAGENT_MAX_CONCURRENT, Math.max(SUBAGENT_MIN_CONCURRENT, parsed))
      : subagentConcurrent
    setConcurrentDraft(null)
    if (next !== subagentConcurrent) saveConcurrent(next)
  }
  const commitMaxTurns = () => {
    const text = maxTurnsDraft ?? (maxTurns === null ? '' : String(maxTurns))
    const parsed = Number.parseInt(text, 10)
    const next = text === '' ? null : Number.isFinite(parsed)
      ? Math.min(SUBAGENT_MAX_TURNS_LIMIT, Math.max(1, parsed))
      : maxTurns
    setMaxTurnsDraft(null)
    if (next === maxTurns) return
    setSavingMaxTurns(true)
    setMaxTurnsError(false)
    void window.pi
      .setSubagentMaxTurns(next)
      .then(setMaxTurns, () => setMaxTurnsError(true))
      .finally(() => setSavingMaxTurns(false))
  }

  // --- profiles: one ordinary file each ---
  const [profiles, setProfiles] = useState<SubagentProfileDTO[] | null>(null)
  const [globalDir, setGlobalDir] = useState('')
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [profilesError, setProfilesError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const applyList = (next: SubagentProfilesDTO) => {
    setProfiles(next.profiles)
    setGlobalDir(next.globalDir)
    setProjectDir(next.projectDir)
  }
  const loadProfiles = () => {
    void window.pi.subagentProfiles().then(
      (next) => {
        applyList(next)
        setProfilesError(false)
      },
      () => setProfilesError(true)
    )
  }

  const [draft, setDraft] = useState<ToolsDraft | null>(null)
  const [savingTools, setSavingTools] = useState(false)
  const [toolsError, setToolsError] = useState(false)

  useEffect(() => {
    void window.pi
      .appInfo()
      .then(
        (info) => {
          setSubagentsEnabled(info.subagentsEnabled !== false)
          setSubagentConcurrent(info.subagentMaxConcurrent ?? 4)
          setReuseEnabled(info.subagentReuseEnabled === true)
          setCommsEnabled(info.subagentCommsEnabled === true)
          setTurnLimitOverrideEnabled(info.subagentTurnLimitOverrideEnabled === true)
          setMaxTurns(info.subagentMaxTurns ?? null)
        },
        () => {}
      )
    loadProfiles()
    // The picker's universe is the shared tools catalog — one read feeds
    // Tools, Extensions and this tab.
    void refreshCatalog()
  }, [])

  const current =
    profiles?.find((profile) => profile.filePath === selected) ?? profiles?.[0] ?? null
  const { data: catalog } = useToolCatalog()
  const groups = useMemo(
    () => (current ? subagentToolGroups(catalog.tools, current.tools) : null),
    [catalog.tools, current]
  )
  // Switching profiles (or a save landing its fresh list) restarts the editor
  // from that profile's saved state; a plain refresh keeps an edit in progress.
  useEffect(() => {
    setDraft(null)
    setToolsError(false)
  }, [current?.filePath])

  const savedMode: 'all' | 'explicit' = current?.tools === 'all' ? 'all' : 'explicit'
  // The editor's live state: an explicit draft, or the saved state derived.
  const active: ToolsDraft | null = draft ?? (current && groups
    ? {
        mode: savedMode,
        selected:
          savedMode === 'all'
            ? new Set(canonicalToolNames(groups))
            : new Set(current.tools)
      }
    : null)
  const csv = groups && active ? canonicalToolNames(groups).filter((name) => active.selected.has(name)) : []
  const savedTools = current && current.tools !== 'all' ? current.tools : null
  const dirty =
    draft !== null &&
    current !== null &&
    (draft.mode !== savedMode ||
      (draft.mode === 'explicit' && savedTools !== null && !sameTools(csv, savedTools)))
  const emptySelection = active?.mode === 'explicit' && csv.length === 0

  const chooseMode = (mode: 'all' | 'explicit') => {
    if (!active || !groups) return
    // "All" is honest as an explicit starting point too: switching a saved
    // `tools: all` profile to the explicit list starts from everything.
    const next =
      mode === 'explicit' && savedMode === 'all' && draft === null
        ? new Set(canonicalToolNames(groups))
        : new Set(active.selected)
    setDraft({ mode, selected: next })
  }
  const toggleOptions = (options: SubagentToolOption[], on: boolean) => {
    if (!active) return
    const next = new Set(active.selected)
    for (const option of options) {
      for (const name of option.names) {
        if (on) next.add(name)
        else next.delete(name)
      }
    }
    setDraft({ mode: active.mode, selected: next })
  }
  const toggleOption = (option: SubagentToolOption, on: boolean) => toggleOptions([option], on)
  const saveTools = () => {
    if (!current || !dirty || emptySelection) return
    setSavingTools(true)
    setToolsError(false)
    void window.pi
      .setSubagentProfileTools(
        current.filePath,
        active?.mode === 'all' ? 'all' : csv
      )
      .then(
        (next) => {
          applyList(next)
          setSelected(current.filePath)
          setDraft(null)
        },
        () => setToolsError(true)
      )
      .finally(() => setSavingTools(false))
  }

  // Creating a profile writes an ordinary file; on success the fresh list
  // lands and the new profile becomes the selected detail.
  const createProfile = (payload: SubagentProfileCreatePayload): Promise<boolean> =>
    window.pi.createSubagentProfile(payload).then(
      (next) => {
        applyList(next)
        setCreating(false)
        setSelected(
          next.profiles.find((profile) => profile.name === payload.name.trim())?.filePath ?? null
        )
        return true
      },
      () => false
    )

  return (
    <div className="space-y-6" data-subagents-section>
      <SettingsGroup title={t('subagent.delegationGroup')}>
        <SettingsRow label={t('subagent.settingsTitle')} description={t('subagent.settingsDesc')}>
          <Checkbox
            mark="square"
            checked={subagentsEnabled}
            disabled={savingSubagents}
            onCheckedChange={(value) => {
              setSavingSubagents(true)
              void window.pi
                .setSubagentsEnabled(value)
                .then(setSubagentsEnabled, () => {})
                .finally(() => setSavingSubagents(false))
            }}
            aria-label={t('subagent.settingsTitle')}
          />
        </SettingsRow>
        <SettingsRow label={t('subagent.concurrency')} description={t('subagent.concurrencyDesc')}>
          <Input
            value={concurrentDraft ?? String(subagentConcurrent)}
            onChange={(value) => setConcurrentDraft(value.replace(/\D/g, '').slice(0, 2))}
            onBlur={commitConcurrent}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            inputMode="numeric"
            disabled={!subagentsEnabled || savingSubagents || savingConcurrent}
            aria-label={t('subagent.concurrency')}
            className="w-16"
            classNames={{ input: 'text-center' }}
          />
        </SettingsRow>
        {concurrentError ? (
          <p role="alert" className="px-4 text-xs text-destructive">{t('subagent.concurrencyFailed')}</p>
        ) : null}
        <div data-subagent-max-turns-row>
          <SettingsRow label={t('subagent.maxTurns')} description={t('subagent.maxTurnsDesc')}>
            <Input
              value={maxTurnsDraft ?? (maxTurns === null ? '' : String(maxTurns))}
              onChange={(value) => setMaxTurnsDraft(value.replace(/\D/g, '').slice(0, 3))}
              onBlur={commitMaxTurns}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
              inputMode="numeric"
              placeholder={t('subagent.maxTurnsUnlimited')}
              disabled={!subagentsEnabled || savingSubagents || savingMaxTurns}
              aria-label={t('subagent.maxTurns')}
              className="w-28"
              classNames={{ input: 'text-center' }}
            />
          </SettingsRow>
          {maxTurnsError ? (
            <p role="alert" className="px-4 text-xs text-destructive">{t('subagent.maxTurnsFailed')}</p>
          ) : null}
        </div>
        <div data-subagent-turn-limit-override-row>
          <SettingsRow label={t('subagent.turnLimitOverrideTitle')} description={t('subagent.turnLimitOverrideDesc')}>
            <Checkbox
              mark="square"
              checked={turnLimitOverrideEnabled}
              disabled={!subagentsEnabled || savingSubagents || savingTurnLimitOverride}
              onCheckedChange={(value) => {
                setSavingTurnLimitOverride(true)
                setTurnLimitOverrideError(false)
                void window.pi
                  .setSubagentTurnLimitOverrideEnabled(value)
                  .then(setTurnLimitOverrideEnabled, () => setTurnLimitOverrideError(true))
                  .finally(() => setSavingTurnLimitOverride(false))
              }}
              aria-label={t('subagent.turnLimitOverrideTitle')}
            />
          </SettingsRow>
          {turnLimitOverrideError ? (
            <p role="alert" className="px-4 text-xs text-destructive">{t('subagent.turnLimitOverrideFailed')}</p>
          ) : null}
        </div>
        <div data-subagent-reuse-row>
          <SettingsRow label={t('subagent.reuseTitle')} description={t('subagent.reuseDesc')}>
            <Checkbox
              mark="square"
              checked={reuseEnabled}
              disabled={!subagentsEnabled || savingReuse}
              onCheckedChange={(value) => {
                setSavingReuse(true)
                void window.pi
                  .setSubagentReuseEnabled(value)
                  .then(setReuseEnabled, () => {})
                  .finally(() => setSavingReuse(false))
              }}
              aria-label={t('subagent.reuseTitle')}
            />
          </SettingsRow>
        </div>
        <div data-subagent-comms-row>
          <SettingsRow label={t('subagent.commsTitle')} description={t('subagent.commsDesc')}>
            <Checkbox
              mark="square"
              checked={commsEnabled}
              disabled={!subagentsEnabled || savingComms}
              onCheckedChange={(value) => {
                setSavingComms(true)
                void window.pi
                  .setSubagentCommsEnabled(value)
                  .then(setCommsEnabled, () => {})
                  .finally(() => setSavingComms(false))
              }}
              aria-label={t('subagent.commsTitle')}
            />
          </SettingsRow>
        </div>
      </SettingsGroup>

      <section>
        <div className="flex items-start justify-between gap-3 px-1 pb-2">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('subagent.profilesGroup')}
            </p>
            <p className="mt-1 text-xs leading-ui-tight text-muted-foreground/70">
              {t('subagent.profilesDesc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            {profiles ? (
              <span className="text-xs text-muted-foreground">
                {t('subagent.profileCount', { count: profiles.length })}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              data-subagent-new
              aria-label={t('subagent.newProfile')}
              disabled={creating}
              onClick={() => setCreating(true)}
            >
              <Plus className="size-3.5" />
              {t('subagent.newProfile')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('subagent.refresh')}
              onClick={() => {
                loadProfiles()
                void refreshCatalog()
              }}
            >
              <RefreshCw className="size-3.5" />
              {t('subagent.refresh')}
            </Button>
          </div>
        </div>

        {profiles === null && !profilesError ? (
          <p className="text-sm text-muted-foreground">{t('subagent.profilesLoading')}</p>
        ) : null}
        {profilesError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('subagent.profilesFailed')}</p>
            <Button variant="outline" size="sm" onClick={loadProfiles}>
              <RefreshCw className="size-3.5" />
              {t('subagent.refresh')}
            </Button>
          </div>
        ) : null}
        {profiles !== null && !profilesError && profiles.length === 0 && !creating ? (
          <p className="text-sm text-muted-foreground">{t('subagent.profilesEmpty')}</p>
        ) : null}
        {/* The creation form replaces the detail column while open (and stands
            alone when there is no profile to show beside it); picking another
            profile closes it. */}
        {(() => {
          const createForm = creating ? (
            <CreateProfileForm
              globalDir={globalDir}
              projectDir={projectDir}
              profiles={profiles ?? []}
              onCreate={createProfile}
              onCancel={() => setCreating(false)}
            />
          ) : null
          return current && groups ? (
            <Tabs
              value={current.filePath}
              onValueChange={(next) => {
                setSelected(next)
                setCreating(false)
              }}
              variant="pill"
              className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start"
            >
            <TabsList className="flex h-max flex-col items-stretch gap-1 rounded-2xl p-1.5 sm:sticky sm:top-0">
              {profiles?.map((profile) => (
                // TabsTrigger does not forward arbitrary props, so the profile
                // marker rides a wrapper div around each trigger.
                <div key={profile.filePath} data-subagent-profile={profile.name}>
                  <TabsTrigger
                    value={profile.filePath}
                    className="w-full justify-between gap-2 rounded-control px-3 py-2"
                  >
                    <span className="truncate text-xs">{profile.displayName}</span>
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        profile.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                      )}
                    />
                  </TabsTrigger>
                </div>
              ))}
            </TabsList>
            <TabsContent key={current.filePath} value={current.filePath} className="mt-0 min-w-0">
              {createForm ?? (
                <ProfileDetail
                  profile={current}
                  groups={groups}
                  universeEmpty={catalog.tools.length === 0}
                  active={active}
                  dirty={dirty}
                  emptySelection={emptySelection}
                  saving={savingTools}
                  error={toolsError}
                  hasDraft={draft !== null}
                  onMode={chooseMode}
                  onToggle={toggleOption}
                  onToggleMany={toggleOptions}
                  onSave={saveTools}
                  onReset={() => setDraft(null)}
                />
              )}
            </TabsContent>
            </Tabs>
          ) : (
            <div className="max-w-2xl">{createForm}</div>
          )
        })()}
      </section>
    </div>
  )
}

function ProfileDetail({
  profile,
  groups,
  universeEmpty,
  active,
  dirty,
  emptySelection,
  saving,
  error,
  hasDraft,
  onMode,
  onToggle,
  onToggleMany,
  onSave,
  onReset
}: {
  profile: SubagentProfileDTO
  groups: SubagentToolGroups
  universeEmpty: boolean
  active: ToolsDraft | null
  dirty: boolean
  emptySelection: boolean
  saving: boolean
  error: boolean
  /** An edit is in progress (Reset discards it; the derived saved state has nothing to reset). */
  hasDraft: boolean
  onMode: (mode: 'all' | 'explicit') => void
  onToggle: (option: SubagentToolOption, on: boolean) => void
  /** One whole family in one gesture (the family row's checkbox). */
  onToggleMany: (options: SubagentToolOption[], on: boolean) => void
  onSave: () => void
  onReset: () => void
}) {
  const { t } = useI18n()

  const source =
    profile.toolsSource === 'preset' ? { kind: 'preset' as const, tone: 'muted' }
    : profile.toolsSource === 'unresolved-preset' ? { kind: 'unresolved' as const, tone: 'destructive' }
    : profile.toolsSource === 'default' ? { kind: 'default' as const, tone: 'muted' }
    : profile.toolPreset ? { kind: 'overridden' as const, tone: 'muted' }
    : null

  return (
    <div className="min-w-0 space-y-5">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {profile.displayName}
          </span>
          <code className="shrink-0 rounded-control bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
            {profile.name}
          </code>
          <span className="shrink-0 rounded-control bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
            {profile.scope === 'project' ? t('subagent.scopeProject') : t('subagent.scopeGlobal')}
          </span>
          <span
            data-subagent-enabled={profile.enabled}
            className={cn(
              'shrink-0 rounded-control px-2 py-0.5 text-caption font-medium',
              profile.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            )}
          >
            {profile.enabled ? t('subagent.enabledOn') : t('subagent.enabledOff')}
          </span>
        </div>
        <p className="text-sm leading-ui text-muted-foreground">{profile.description}</p>
      </div>

      {/* Frontmatter fields — model, thinking, even the path — belong to
          the file alone; the open-file button's tooltip names the target. */}
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip content={profile.filePath} className="max-w-sm break-all">
          <Button variant="outline" size="sm" onClick={() => void window.pi.openPath(profile.filePath)}>
            <FileText className="size-3.5" />
            {t('subagent.openFile')}
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => void window.pi.showInFolder(profile.filePath)}>
          <FolderOpen className="size-3.5" />
          {t('subagent.reveal')}
        </Button>
      </div>

      <div data-subagent-tools-editor className="space-y-3 rounded-xl border border-border/70 bg-card px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('subagent.toolsTitle')}
        </p>
        {source ? (
          <p
            data-subagent-tools-source={source.kind}
            className={cn(
              'text-xs leading-ui-tight',
              source.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {source.kind === 'preset'
              ? t('subagent.sourcePreset', { id: profile.toolPreset ?? '' })
              : source.kind === 'unresolved'
                ? t('subagent.sourceUnresolvedPreset', { id: profile.toolPreset ?? '' })
                : source.kind === 'default'
                  ? t('subagent.sourceDefault')
                  : t('subagent.sourcePresetOverridden', { id: profile.toolPreset ?? '' })}
          </p>
        ) : null}
        <RadioGroup
          orientation="vertical"
          value={active?.mode ?? 'all'}
          onValueChange={(next) => onMode(next as 'all' | 'explicit')}
          className="gap-2"
        >
          <RadioGroupItem value="all" disabled={saving} label={t('subagent.toolsAll')} />
          <RadioGroupItem value="explicit" disabled={saving} label={t('subagent.toolsExplicit')} />
        </RadioGroup>
        {active?.mode === 'explicit' ? (
          <div className="space-y-3">
            {universeEmpty ? (
              <p className="text-xs leading-ui-tight text-muted-foreground/70">
                {t('subagent.toolsBuiltinOnly')}
              </p>
            ) : null}
            <FadeScroll className="max-h-64">
              <div className="space-y-3 pr-1">
                <ToolGroup
                  id="mcp"
                  title={t('tool.categoryMcp')}
                  entries={groups.mcp}
                  meta={groups.mcp.length ? t('subagent.toolsMcpMeta') : undefined}
                  selected={active.selected}
                  disabled={saving}
                  onToggle={onToggle}
                  onToggleMany={onToggleMany}
                />
                <ToolGroup
                  id="builtin"
                  title={t('subagent.toolsGroupBuiltin')}
                  entries={groups.builtin}
                  selected={active.selected}
                  disabled={saving}
                  onToggle={onToggle}
                  onToggleMany={onToggleMany}
                />
                <ToolGroup
                  id="extension"
                  title={t('subagent.toolsGroupExtension')}
                  entries={groups.extension}
                  selected={active.selected}
                  disabled={saving}
                  onToggle={onToggle}
                  onToggleMany={onToggleMany}
                />
                <ToolGroup
                  id="unknown"
                  title={t('subagent.toolsGroupUnknown')}
                  entries={groups.unknown}
                  selected={active.selected}
                  disabled={saving}
                  onToggle={onToggle}
                  onToggleMany={onToggleMany}
                />
              </div>
            </FadeScroll>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-subagent-tools-save
            disabled={!dirty || emptySelection || saving}
            onClick={onSave}
          >
            {t('subagent.toolsSave')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-subagent-tools-reset
            disabled={!hasDraft || saving}
            onClick={onReset}
          >
            {t('subagent.toolsReset')}
          </Button>
          {emptySelection ? (
            <span role="status" className="text-xs text-destructive">
              {t('subagent.toolsEmptyHint')}
            </span>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {t('subagent.toolsSaveFailed')}
            </p>
          ) : null}
        </div>
      </div>

      <section>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('subagent.systemPrompt')}
        </p>
        <div className="max-h-96 overflow-y-auto rounded-xl border border-border/70 bg-card px-4 py-3">
          {profile.systemPrompt ? (
            <Markdown>{profile.systemPrompt}</Markdown>
          ) : (
            <p className="text-xs text-muted-foreground/70">{t('subagent.notSet')}</p>
          )}
        </div>
      </section>
    </div>
  )
}

/** The inline creation form: name, description, system prompt and the scope
 * that decides which directory the ordinary Markdown file lands in. It
 * validates exactly what the loader will parse — the shared name pattern and
 * a non-empty description (without one the file would be invisible) — and
 * previews the target path. A new profile starts least-privileged (no
 * `tools:` line); the tool editor beside the list widens it from there. */
function CreateProfileForm({
  globalDir,
  projectDir,
  profiles,
  onCreate,
  onCancel
}: {
  globalDir: string
  projectDir: string | null
  profiles: SubagentProfileDTO[]
  onCreate: (payload: SubagentProfileCreatePayload) => Promise<boolean>
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // Validation text appears live for a typed-bad name; the rest reveals after
  // the first Create attempt (the button stays clickable so the click can
  // show what is missing instead of just going dead).
  const [attempted, setAttempted] = useState(false)

  const trimmedName = name.trim()
  const nameInvalid = trimmedName !== '' && !SUBAGENT_PROFILE_NAME_PATTERN.test(trimmedName)
  const nameTaken =
    trimmedName !== '' &&
    !nameInvalid &&
    profiles.some((profile) => profile.name === trimmedName && profile.scope === scope)
  const descriptionEmpty = description.trim() === ''
  const valid = trimmedName !== '' && !nameInvalid && !nameTaken && !descriptionEmpty
  const targetDir = scope === 'project' ? projectDir : globalDir

  const submit = () => {
    if (!valid || busy) return
    setBusy(true)
    setFailed(false)
    void onCreate({ name: trimmedName, description, systemPrompt: prompt, scope }).then(
      (ok) => {
        if (!ok) setFailed(true)
      },
      () => setFailed(true)
    ).finally(() => setBusy(false))
  }

  return (
    <div data-subagent-create-form className="grid gap-5 rounded-xl border border-border/70 bg-card px-4 py-3 md:grid-cols-2">
      <p className={`${FORM_PANEL_TITLE} md:col-span-2`}>
        {t('subagent.createTitle')}
      </p>

      <label className="flex flex-col gap-1.5">
        <span className={FORM_FIELD_TITLE}>{t('subagent.nameLabel')}</span>
        <Input
          value={name}
          onChange={setName}
          aria-label={t('subagent.nameLabel')}
          disabled={busy}
        />
        {nameInvalid || (attempted && trimmedName === '') ? (
          <p data-subagent-name-error className="text-xs text-destructive">{t('subagent.nameInvalid')}</p>
        ) : nameTaken ? (
          <p data-subagent-name-error className="text-xs text-destructive">{t('subagent.nameTaken')}</p>
        ) : null}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={FORM_FIELD_TITLE}>{t('subagent.descriptionLabel')}</span>
        <Input
          value={description}
          onChange={setDescription}
          aria-label={t('subagent.descriptionLabel')}
          disabled={busy}
        />
        {attempted && descriptionEmpty ? (
          <p className="text-xs text-destructive">{t('subagent.descriptionRequired')}</p>
        ) : null}
      </label>

      <label className="flex flex-col gap-1.5 md:col-span-2">
        <span className={FORM_FIELD_TITLE}>{t('subagent.systemPrompt')}</span>
        <Input
          value={prompt}
          onChange={setPrompt}
          multiline
          rows={4}
          aria-label={t('subagent.systemPrompt')}
          disabled={busy}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <p className={FORM_FIELD_TITLE}>{t('subagent.scopeLabel')}</p>
        <RadioGroup
          orientation="horizontal"
          value={scope}
          onValueChange={(next) => setScope(next as 'global' | 'project')}
          className="gap-4"
        >
          <RadioGroupItem value="global" disabled={busy} label={t('subagent.scopeGlobal')} />
          <RadioGroupItem
            value="project"
            disabled={!projectDir || busy}
            label={t('subagent.scopeProject')}
          />
        </RadioGroup>
        {targetDir ? (
          <p className="break-all text-xs text-muted-foreground/70">
            {t('subagent.targetFile', {
              path: `${targetDir}/${trimmedName || '‹name›'}.md`
            })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-subagent-create
          disabled={busy}
          onClick={() => {
            if (!valid) {
              setAttempted(true)
              return
            }
            submit()
          }}
        >
          {t('subagent.createAction')}
        </Button>
        <Button variant="ghost" size="sm" data-subagent-cancel disabled={busy} onClick={onCancel}>
          {t('subagent.cancel')}
        </Button>
        {failed ? (
          <p role="alert" className="text-xs text-destructive">{t('subagent.createFailed')}</p>
        ) : null}
      </div>
    </div>
  )
}

/** The row wrapper keeps each option a flex item so the meta note (an
 * extension's package label) sits on the same line as the name, and the
 * group's own shared note rides under the title.
 *
 * An option that belongs to a tool family is replaced by ONE family row: a
 * tri-state checkbox that selects or clears the whole family in one gesture,
 * beside a quiet disclosure that opens the individual checkboxes. Selecting
 * members one by one is the same path as before, one click deeper; the
 * collapsed form is what keeps a 14-tool family from burying the rest of the
 * picker. The MCP section is ONE family row like any extension family — a
 * tri-state checkbox for every server beside the disclosure of individual
 * grants — rather than a flat list that buries the sections below it. */
function ToolGroup({
  id,
  title,
  entries,
  meta,
  selected,
  disabled,
  onToggle,
  onToggleMany
}: {
  id: 'mcp' | 'builtin' | 'extension' | 'unknown'
  title: string
  entries: SubagentToolEntry[]
  /** One shared meta line for the whole group's entries (the MCP note). */
  meta?: string
  selected: Set<string>
  disabled: boolean
  onToggle: (option: SubagentToolOption, on: boolean) => void
  onToggleMany: (options: SubagentToolOption[], on: boolean) => void
}) {
  if (!entries.length) return null
  return (
    <div data-subagent-tool-group={id}>
      <p className="mb-1 text-caption font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </p>
      <div className="space-y-0.5">
        {entries.map((entry) =>
          entry.kind === 'family' ? (
            <ToolFamily
              key={`${id}:${entry.prefix}`}
              id={`${id}:${entry.prefix}`}
              prefix={entry.prefix}
              options={entry.options}
              selected={selected}
              disabled={disabled}
              onToggle={onToggle}
              onToggleMany={onToggleMany}
            />
          ) : (
            <ToolOption key={entry.option.label} option={entry.option} selected={selected} disabled={disabled} onToggle={onToggle} />
          )
        )}
      </div>
      {meta ? (
        <p className="mt-1 px-1 text-caption leading-ui-tight text-muted-foreground/70">{meta}</p>
      ) : null}
    </div>
  )
}

/** One tool row: a checkbox with its name, plus the extension label when the
 * catalog knows one. */
function ToolOption({
  option,
  selected,
  disabled,
  onToggle
}: {
  option: SubagentToolOption
  selected: Set<string>
  disabled: boolean
  onToggle: (option: SubagentToolOption, on: boolean) => void
}) {
  const checked = option.names.every((name) => selected.has(name))
  return (
    <div data-subagent-tool={option.label} className="flex items-center gap-2 py-0.5">
      <Checkbox
        mark="square"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(option, value === true)}
        aria-label={option.label}
        label={option.label}
      />
      {option.meta ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{option.meta}</span>
      ) : null}
    </div>
  )
}

/** A tool family: selection for the whole series beside its disclosure. */
function ToolFamily({
  id,
  prefix,
  options,
  selected,
  disabled,
  onToggle,
  onToggleMany
}: {
  id: string
  prefix: string
  options: SubagentToolOption[]
  selected: Set<string>
  disabled: boolean
  onToggle: (option: SubagentToolOption, on: boolean) => void
  onToggleMany: (options: SubagentToolOption[], on: boolean) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const total = options.length
  const chosen = options.filter((option) => option.names.every((name) => selected.has(name))).length
  const all = chosen === total
  const panelId = `subagent-tool-family-${id.replace(/[^a-z0-9]+/gi, '-')}`
  // Only a label every member agrees on can speak for the family — and a
  // family that IS an extension already says its name in `prefix`.
  const shared = options.every((option) => option.meta === options[0].meta) ? options[0].meta : undefined
  const meta = shared === prefix ? undefined : shared
  return (
    <div data-subagent-tool-family={prefix} data-family-state={all ? 'all' : chosen > 0 ? 'some' : 'none'}>
      <div className="flex items-center gap-2 py-0.5">
        <Checkbox
          mark="square"
          checked={all}
          indeterminate={!all && chosen > 0}
          disabled={disabled}
          onCheckedChange={(value) => onToggleMany(options, value === true)}
          aria-label={t('subagent.toolsFamilyAria', { prefix, count: total })}
        />
        <Button
          variant="ghost"
          size="sm"
          data-subagent-tool-family-toggle
          aria-expanded={open}
          aria-controls={panelId}
          disabled={disabled}
          // A quiet toggle: the vendored press/hover spring reads as a bounce on
          // a row whose whole job is to reveal the rows below it, so both are
          // cancelled (the same treatment the task panels' toggles use).
          onClick={() => setOpen((prev) => !prev)}
          className="min-w-0 flex-1 justify-start gap-1.5 px-1"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
              open && 'rotate-90'
            )}
          />
          {/* The family name wears the UI font, exactly like the tool rows it
              collapses — the leaf rows' own labels are UI-font too, and a
              monospace prefix beside them read as a different kind of row. */}
          <span data-subagent-tool-family-label className="min-w-0 truncate text-xs">{prefix}</span>
          {meta ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span>
          ) : null}
          <span
            data-subagent-tool-family-count
            className="ml-auto shrink-0 rounded-item bg-muted px-1.5 text-micro font-medium tabular-nums text-muted-foreground"
          >
            {chosen}/{total}
          </span>
        </Button>
      </div>
      <AgentDisclosure
        id={panelId}
        open={open}
        // The reveal is instant on purpose: a picker row that slides its
        // neighbours around while the pointer is still on it reads as a jump.
        transition={{ duration: 0 }}
        className="space-y-0.5 pl-3"
        data-subagent-tool-family-members={prefix}
      >
        {options.map((option) => (
          <ToolOption key={option.label} option={option} selected={selected} disabled={disabled} onToggle={onToggle} />
        ))}
      </AgentDisclosure>
    </div>
  )
}
