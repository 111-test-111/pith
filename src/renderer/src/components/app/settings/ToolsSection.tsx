import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, RefreshCw } from '@/lib/icons'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { Button } from '@/components/motion/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { FadeScroll } from '@/components/app/FadeScroll'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { refreshCatalog, useToolCatalog } from '@/lib/extensions-catalog'
import { buildToolList, extensionLabelOf, groupPrefixOf } from '@/lib/tool-groups'
import { getToolParameterFields } from '@/lib/tool-schema'
import { ToolIcon } from '@/lib/tool-icons'
import { cn } from '@/lib/utils'
import type { ToolInfoDTO } from '../../../../../shared/types'

const BASH_PARAMETERS: Record<string, MessageKey> = {
  command: 'bashTask.parameterCommand', mode: 'bashTask.parameterMode', waitMs: 'bashTask.parameterWait',
  timeout: 'bashTask.parameterTimeout', action: 'bashTask.parameterAction', taskId: 'bashTask.parameterId',
  cursor: 'bashTask.parameterCursor', maxChars: 'bashTask.parameterMaxChars'
}

/** `active` is the model-facing declaration set, not the SDK's callable set.
 * Native MCP defaults to codemode exposure and is callable while inactive. */
function toolAccess(tool: ToolInfoDTO): { key: MessageKey; available: boolean; state: string } {
  if (tool.disabledByExtension) return { key: 'settings.toolInactive', available: false, state: 'inactive' }
  if (tool.active) return { key: 'settings.toolActive', available: true, state: 'active' }
  if (tool.exposure === 'codemode') return { key: 'settings.toolCodemode', available: true, state: 'codemode' }
  if (tool.exposure === 'deferred') return { key: 'settings.toolDeferred', available: true, state: 'deferred' }
  return { key: 'settings.toolInactive', available: false, state: 'inactive' }
}

/**
 * Settings → Tools: every tool the agent can call — the SDK's built-ins plus
 * whatever the installed extensions register. Selecting one shows its full
 * description, source and JSON-Schema parameters. Tools whose owning extension
 * is switched off in Settings → Extensions stay listed, marked inactive.
 *
 * Namespaced families collapse into one group row so a large extension cannot
 * bury the built-ins. A tool folds under the family the registry declares —
 * native MCP tools and historical adapter names, `ctx_*`, `browser_*` — and
 * otherwise under the extension that registers it, so a
 * package whose tools share no name prefix (pi-lens: `lens_*`, `ast_grep_*`,
 * `read_symbol`, `lsp_navigation`) is still one row instead of several. The
 * group holding the selected tool is the one left open, and an explicit toggle
 * always wins over that default.
 *
 * beUI-native: the list/detail split is a `Tabs` (list on the left, detail on
 * the right), the group headers are `Button`s with `AgentDisclosure` reveals,
 * and the app's `FadeScroll` bounds a long description with a gradient edge.
 */
export function ToolsSection() {
  const { t } = useI18n()
  const { status, data, error } = useToolCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => {
    void refreshCatalog()
  }, [])

  // Active tools first; disabled-extension tools sink to the bottom. Grouping
  // then lifts every family to the head of the list.
  const ordered = useMemo(
    () =>
      [...data.tools].sort(
        (a, b) => Number(a.disabledByExtension) - Number(b.disabledByExtension)
      ),
    [data.tools]
  )
  const entries = useMemo(() => buildToolList(ordered, { extensionOf: extensionLabelOf }), [ordered])
  const current = ordered.find((tool) => tool.name === selected) ?? ordered[0]
  const openPrefix = groupPrefixOf(entries, current?.name)

  if (status === 'loading' && data.tools.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.toolsLoading')}</p>
  }
  if (status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.toolsLoadFailed')}</p>
        {error ? <p className="text-xs text-muted-foreground/70">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => void refreshCatalog()}>
          <RefreshCw className="size-3.5" />
          {t('settings.toolsRetry')}
        </Button>
      </div>
    )
  }
  if (data.tools.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.toolsEmpty')}</p>
  }

  return (
    <Tabs
      value={current.name}
      onValueChange={setSelected}
      variant="pill"
      className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-start"
    >
      <div className="flex h-max flex-col gap-2 sm:sticky sm:top-0">
        <TabsList className="flex flex-col items-stretch gap-1 rounded-2xl p-1.5">
          {entries.map((entry) => {
            if (entry.kind === 'tool') return <ToolTab key={entry.tool.name} tool={entry.tool} />

            const open = openOverrides[entry.prefix] ?? entry.prefix === openPrefix
            const allDisabled = entry.tools.every((tool) => tool.disabledByExtension)
            const panelId = `tool-group-${entry.prefix}`
            return (
              <div key={`group:${entry.prefix}`} className="flex flex-col gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-controls={panelId}
                  aria-label={t('settings.toolGroupAria', {
                    prefix: entry.prefix,
                    count: entry.tools.length
                  })}
                  onClick={() =>
                    setOpenOverrides((prev) => ({ ...prev, [entry.prefix]: !open }))
                  }
                  className="w-full justify-start gap-1.5 px-2"
                >
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
                      open && 'rotate-90'
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0 truncate font-mono text-xs',
                      allDisabled && 'line-through opacity-50'
                    )}
                  >
                    {entry.prefix}
                  </span>
                  <span className="ml-auto shrink-0 rounded-item bg-muted px-1.5 text-micro font-medium tabular-nums text-muted-foreground" data-tool-group-count>
                    {entry.tools.length}
                  </span>
                </Button>
                <AgentDisclosure id={panelId} open={open} className="flex flex-col gap-1 pl-2">
                  {entry.tools.map((tool) => (
                    <ToolTab key={tool.name} tool={tool} />
                  ))}
                </AgentDisclosure>
              </div>
            )
          })}
        </TabsList>
        {/* One line, because the list is genuinely incomplete on a fresh launch:
            an extension's tools can be registered on its first agent turn
            (`before_agent_start`), so nothing here can list them yet. */}
        <p data-tools-lazy-hint className="px-1 text-caption leading-ui-tight text-muted-foreground/70">
          {t('settings.toolsLazyHint')}
        </p>
      </div>

      {ordered.map((tool) =>
        tool.name === current.name ? (
          <TabsContent key={tool.name} value={tool.name} className="mt-0 min-w-0">
            <ToolDetail tool={tool} />
          </TabsContent>
        ) : null
      )}
    </Tabs>
  )
}

/** One tool row: standalone, or indented by its group's disclosure wrapper. */
function ToolTab({ tool }: { tool: ToolInfoDTO }) {
  const access = toolAccess(tool)
  return (
    <div data-tool={tool.name}>
      <TabsTrigger
        value={tool.name}
        className="w-full justify-between gap-2 rounded-control py-2 pl-3 pr-3"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ToolIcon
            name={tool.name}
            className={cn('size-3.5 shrink-0', tool.disabledByExtension && 'opacity-50')}
          />
          <span
            className={cn(
              'truncate font-mono text-xs',
              tool.disabledByExtension && 'line-through decoration-muted-foreground/60'
            )}
          >
            {tool.name}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            access.available ? 'bg-primary' : 'bg-muted-foreground/40'
          )}
        />
      </TabsTrigger>
    </div>
  )
}

function ToolDetail({ tool }: { tool: ToolInfoDTO }) {
  const { t } = useI18n()
  const access = toolAccess(tool)
  const managedBash = tool.source.kind === 'builtin' && (tool.name === 'bash' || tool.name === 'bash_task')
  const description = tool.source.kind === 'builtin' && tool.name === 'todo_write' ? t('todo.toolDescription') : managedBash ? t(tool.name === 'bash' ? 'bashTask.toolDescription' : 'bashTask.controlDescription') : tool.description
  const fields = getToolParameterFields(tool.parameters).map((field) =>
    managedBash && BASH_PARAMETERS[field.name] ? { ...field, description: t(BASH_PARAMETERS[field.name]) } : field)
  const sourceLabel =
    tool.source.kind === 'builtin' ? t('settings.toolSourceBuiltin') : tool.source.label

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <code
          data-tool-detail-name
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground"
        >
          {tool.name}
        </code>
        <span className="rounded-control bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
          {sourceLabel}
        </span>
        <span
          data-tool-access={access.state}
          className={cn(
            'rounded-control px-2 py-0.5 text-caption font-medium',
            access.available ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          )}
        >
          {t(access.key)}
        </span>
      </div>

      {description ? (
        <section>
          <p
            data-tool-description-label
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('settings.toolDescription')}
          </p>
          <div
            data-tool-description
            className="rounded-xl border border-border/70 bg-card px-3 py-2.5"
          >
            <FadeScroll className="max-h-44">
              <p className="text-sm leading-ui text-muted-foreground">{description}</p>
            </FadeScroll>
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.toolParameters')}
          </p>
          <span className="text-caption text-muted-foreground/70">
            {t('settings.toolParameterCount', { count: fields.length })}
          </span>
        </div>
        {fields.length > 0 ? (
          <div data-tool-parameters className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
            {fields.map((field) => (
              <div
                key={field.name}
                className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <code className="break-words font-mono text-xs text-foreground">
                    {field.name}
                  </code>
                  <p
                    className={cn(
                      'mt-0.5 text-micro',
                      field.required ? 'text-primary' : 'text-muted-foreground'
                    )}
                  >
                    {field.required ? t('settings.toolRequired') : t('settings.toolOptional')}
                  </p>
                </div>
                <div className="min-w-0 space-y-1">
                  <code className="block break-words font-mono text-caption text-foreground/80">
                    {field.type}
                  </code>
                  {field.description ? (
                    <p className="text-xs leading-ui-tight text-muted-foreground">{field.description}</p>
                  ) : null}
                  {field.allowedValues ? (
                    <p className="text-caption text-muted-foreground/70">
                      {t('settings.toolAllowedValues')}:{' '}
                      <code className="font-mono">{field.allowedValues}</code>
                    </p>
                  ) : null}
                  {field.defaultValue !== undefined ? (
                    <p className="text-caption text-muted-foreground/70">
                      {t('settings.toolDefaultValue')}:{' '}
                      <code className="font-mono">{field.defaultValue}</code>
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">{t('settings.toolNoParameters')}</p>
        )}
      </section>

      {tool.promptGuidelines && tool.promptGuidelines.length > 0 ? (
        <section>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.toolGuidelines')}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs leading-ui-tight text-muted-foreground">
            {tool.promptGuidelines.map((guideline, index) => (
              <li key={`${tool.name}:${index}`}>{guideline}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
