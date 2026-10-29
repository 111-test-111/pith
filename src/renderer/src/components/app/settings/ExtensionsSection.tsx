import { useEffect, useState, type ReactNode } from 'react'
import { Download, Info, Plus, RefreshCw, Trash2, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Checkbox } from '@/components/motion/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import {
  clearActionError,
  installExtension,
  refreshCatalog,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
  useToolCatalog
} from '@/lib/extensions-catalog'
import { cn } from '@/lib/utils'
import type { MessageKey } from '@/i18n/locales/en'
import type {
  ExtensionInfoDTO,
  ExtensionResourceKind
} from '../../../../../shared/types'
import { ConfirmDialog } from '../ConfirmDialog'
import { LabelTooltip } from '../LabelTooltip'

const RESOURCE_LABEL: Record<ExtensionResourceKind, MessageKey> = {
  extension: 'settings.resourceExtension',
  skill: 'settings.resourceSkill',
  prompt: 'settings.resourcePrompt',
  theme: 'settings.resourceTheme'
}

const RESOURCE_ORDER: ExtensionResourceKind[] = ['extension', 'skill', 'prompt', 'theme']

/**
 * Settings → Extensions: installed extensions as a list/detail split. The
 * detail shows what the owning package ships (tools plus bundled skills,
 * prompts, themes and extensions), where it is installed, and the package
 * actions — update and remove — while the switch enables/disables it.
 *
 * beUI-native: `Tabs` for the split, `Checkbox`/`Button`/`Input`/`Tooltip` and
 * the app's `MorphingModal`-based dialogs for install and removal.
 */
export function ExtensionsSection() {
  const { t } = useI18n()
  const { status, data, error, busy, actionError } = useToolCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ExtensionInfoDTO | null>(null)

  useEffect(() => {
    void refreshCatalog()
  }, [])

  if (status === 'loading' && data.extensions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.extensionsLoading')}</p>
  }
  if (status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.extensionsLoadFailed')}</p>
        {error ? <p className="text-xs text-muted-foreground/70">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => void refreshCatalog()}>
          <RefreshCw className="size-3.5" />
          {t('settings.toolsRetry')}
        </Button>
      </div>
    )
  }
  if (data.extensions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.extensionsEmpty')}</p>
        <Button variant="outline" size="sm" onClick={() => setInstallOpen(true)}>
          <Plus className="size-3.5" />
          {t('settings.extensionInstall')}
        </Button>
        <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
      </div>
    )
  }

  const current = data.extensions.find((entry) => entry.id === selected) ?? data.extensions[0]

  return (
    <div className="space-y-4">
      {actionError ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {t('settings.extensionActionFailed')}: {actionError}
          </span>
          <button
            type="button"
            aria-label={t('settings.extensionDismissError')}
            onClick={clearActionError}
            className="grid size-4 shrink-0 place-items-center rounded-icon transition-colors hover:bg-destructive/10"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      <Tabs
        value={current.id}
        onValueChange={setSelected}
        variant="pill"
        className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start"
      >
        <div className="flex flex-col gap-2 sm:sticky sm:top-0">
          <TabsList className="flex h-max flex-col items-stretch gap-1 rounded-2xl p-1.5">
            {data.extensions.map((extension) => (
              <TabsTrigger
                key={extension.id}
                value={extension.id}
                className="w-full justify-between gap-2 rounded-control px-3 py-2"
              >
                <span className="truncate text-xs">{extension.name}</span>
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    extension.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
              </TabsTrigger>
            ))}
          </TabsList>
          <Button variant="outline" size="sm" className="w-full" onClick={() => setInstallOpen(true)}>
            <Plus className="size-3.5" />
            {t('settings.extensionInstall')}
          </Button>
        </div>

        {data.extensions.map((extension) =>
          extension.id === current.id ? (
            <TabsContent key={extension.id} value={extension.id} className="mt-0 min-w-0">
              <ExtensionDetail
                extension={extension}
                busy={busy}
                onToggle={(enabled) => void setExtensionEnabled(extension.id, enabled)}
                onUpdate={() => void updateExtension(extension.source)}
                onRemove={() => setRemoveTarget(extension)}
              />
            </TabsContent>
          ) : null
        )}
      </Tabs>

      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
      <ConfirmDialog
        open={removeTarget !== null}
        title={t('settings.extensionConfirmRemoveTitle')}
        message={t('settings.extensionConfirmRemoveMessage', { name: removeTarget?.name ?? '' })}
        confirmLabel={t('settings.extensionRemove')}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) void removeExtension(removeTarget.source)
        }}
      />
    </div>
  )
}

function ExtensionDetail({
  extension,
  busy,
  onToggle,
  onUpdate,
  onRemove
}: {
  extension: ExtensionInfoDTO
  busy: string | null
  onToggle: (enabled: boolean) => void
  onUpdate: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const updating = busy === `update:${extension.source}`
  const removing = busy === `remove:${extension.source}`
  const working = updating || removing

  return (
    <div className="min-w-0 space-y-5">
      <div className="min-w-0 space-y-2">
        {/* Name row and action row are separate lines: a long package name plus
            a wide "Updating…" button can't fit one row in the settings column,
            and keeping them separate means the name truncates instead of
            pushing the switch out of the panel. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {extension.name}
          </span>
          {extension.version ? (
            <span className="shrink-0 rounded-control bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
              v{extension.version}
            </span>
          ) : null}
          {extension.configuredVersion && extension.configuredVersion !== extension.version ? (
            <span className="shrink-0 rounded-control bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
              {t('settings.extensionConfiguredVersion', { version: extension.configuredVersion })}
            </span>
          ) : null}
          {!extension.manageable ? (
            <Checkbox
              mark="square"
              className="ml-auto"
              checked={extension.enabled}
              onCheckedChange={onToggle}
              disabled={working}
              aria-label={t('settings.extensionToggle', { name: extension.name })}
            />
          ) : null}
        </div>
        {extension.manageable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={working} onClick={onUpdate}>
              <Download className="size-3.5" />
              {updating ? t('settings.extensionUpdating') : t('settings.extensionUpdate')}
            </Button>
            <Button variant="ghost" size="sm" disabled={working} onClick={onRemove}>
              <Trash2 className="size-3.5" />
              {removing ? t('settings.extensionRemoving') : t('settings.extensionRemove')}
            </Button>
            <Checkbox
              mark="square"
              className="ml-auto"
              checked={extension.enabled}
              onCheckedChange={onToggle}
              disabled={working}
              aria-label={t('settings.extensionToggle', { name: extension.name })}
            />
          </div>
        ) : null}
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
        <MetaRow label={t('settings.extensionScope')}>
          <Tooltip content={scopeHint(extension, t)}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              {scopeLabel(extension, t)}
            </span>
          </Tooltip>
        </MetaRow>
        <MetaRow label={t('settings.extensionSource')}>
          <code className="break-all font-mono text-caption text-muted-foreground">
            {extension.source}
          </code>
        </MetaRow>
        {extension.installedPath ? (
          <MetaRow label={t('settings.extensionPath')}>
            <span className="break-all font-mono text-caption text-muted-foreground">
              {extension.installedPath}
            </span>
          </MetaRow>
        ) : null}
      </dl>

      <section>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('settings.extensionToolsLabel')}
        </p>
        {extension.toolNames.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {extension.toolNames.map((name) => (
              <code
                key={name}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground"
              >
                {name}
              </code>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">{t('settings.extensionNoTools')}</p>
        )}
      </section>

      <section>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('settings.extensionResources')}
        </p>
        {extension.resources.length > 0 ? (
          <div className="space-y-3">
            {RESOURCE_ORDER.map((kind) => {
              const items = extension.resources.filter((resource) => resource.kind === kind)
              if (items.length === 0) return null
              return (
                <div key={kind}>
                  <p className="mb-1 text-caption font-medium text-muted-foreground/70">
                    {t(RESOURCE_LABEL[kind])}
                  </p>
                  <ul className="space-y-0.5">
                    {items.map((resource) => (
                      <li
                        key={`${resource.kind}:${resource.path}`}
                        className="truncate text-xs text-muted-foreground"
                      >
                        <LabelTooltip
                          content={resource.path}
                          wrap
                          wrapperClassName="inline align-baseline"
                        >
                          <span>{resource.name}</span>
                        </LabelTooltip>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            {t('settings.extensionNoResources')}
          </p>
        )}
      </section>
    </div>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className="min-w-0 text-foreground/90">{children}</dd>
    </>
  )
}

function scopeLabel(
  extension: ExtensionInfoDTO,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (extension.scope === 'project') return t('settings.extensionScopeProject')
  if (extension.scope === 'temporary') return t('settings.extensionScopeTemporary')
  return t('settings.extensionScopeUser')
}

function scopeHint(extension: ExtensionInfoDTO, t: ReturnType<typeof useI18n>['t']): string {
  if (extension.scope === 'project') return t('settings.extensionScopeProjectHint')
  if (extension.scope === 'temporary') return t('settings.extensionScopeTemporaryHint')
  return t('settings.extensionScopeUserHint')
}

function InstallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const { busy, actionError } = useToolCatalog()
  const [source, setSource] = useState('')
  const installing = busy !== null && busy.startsWith('install:')

  const submit = async () => {
    const value = source.trim()
    if (!value) return
    const ok = await installExtension(value)
    if (ok) {
      setSource('')
      onClose()
    }
  }

  useEffect(() => {
    if (open) clearActionError()
  }, [open])

  return (
    <MorphingModal
      viewId={open ? 'extension-install' : null}
      onClose={onClose}
      placement="center"
      className="max-w-md"
    >
      <div role="dialog" aria-modal="true" aria-label={t('settings.extensionInstallTitle')}>
        <h2 className="text-base font-semibold text-foreground">
          {t('settings.extensionInstallTitle')}
        </h2>
        <p className="mt-1 text-sm leading-ui text-muted-foreground">
          {t('settings.extensionInstallDesc')}
        </p>
        <div className="mt-3">
          <Input
            value={source}
            onChange={setSource}
            aria-label={t('settings.extensionInstallTitle')}
            placeholder={t('settings.extensionInstallPlaceholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
        </div>
        {actionError ? (
          <p className="mt-2 break-words text-xs text-destructive">{actionError}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!source.trim() || installing} onClick={() => void submit()}>
            {installing ? t('settings.extensionInstalling') : t('settings.extensionInstallAction')}
          </Button>
        </div>
      </div>
    </MorphingModal>
  )
}
