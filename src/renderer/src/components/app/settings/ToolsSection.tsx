import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/motion/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import { refreshCatalog, useToolCatalog } from '@/lib/extensions-catalog'
import { getToolParameterFields } from '@/lib/tool-schema'
import { ToolIcon } from '@/lib/tool-icons'
import { cn } from '@/lib/utils'
import type { ToolInfoDTO } from '../../../../../shared/types'

/**
 * Settings → Tools: every tool the agent can call — the SDK's built-ins plus
 * whatever the installed extensions register. Selecting one shows its full
 * description, source and JSON-Schema parameters. Tools whose owning extension
 * is switched off in Settings → Extensions stay listed, marked inactive.
 *
 * beUI-native: the list/detail split is a `Tabs` (list on the left, detail on
 * the right), with the app's own token-styled markup for the schema body.
 */
export function ToolsSection() {
  const { t } = useI18n()
  const { status, data, error } = useToolCatalog()
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void refreshCatalog()
  }, [])

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

  // Active tools first; disabled-extension tools sink to the bottom.
  const ordered = [...data.tools].sort(
    (a, b) => Number(a.disabledByExtension) - Number(b.disabledByExtension)
  )
  const current = ordered.find((tool) => tool.name === selected) ?? ordered[0]

  return (
    <Tabs
      value={current.name}
      onValueChange={setSelected}
      variant="pill"
      className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start"
    >
      <TabsList className="flex h-max flex-col items-stretch gap-1 rounded-2xl p-1.5 sm:sticky sm:top-0">
        {ordered.map((tool) => (
          <TabsTrigger
            key={tool.name}
            value={tool.name}
            className="w-full justify-between gap-2 rounded-control px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <ToolIcon
                name={tool.name}
                className={cn('size-3.5', tool.disabledByExtension && 'opacity-50')}
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
                tool.active ? 'bg-primary' : 'bg-muted-foreground/40'
              )}
            />
          </TabsTrigger>
        ))}
      </TabsList>

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

function ToolDetail({ tool }: { tool: ToolInfoDTO }) {
  const { t } = useI18n()
  const fields = getToolParameterFields(tool.parameters)
  const sourceLabel =
    tool.source.kind === 'builtin' ? t('settings.toolSourceBuiltin') : tool.source.label

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
            {tool.name}
          </code>
          <span className="rounded-control bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {sourceLabel}
          </span>
          {tool.disabledByExtension ? (
            <span className="rounded-control bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t('settings.toolInactive')}
            </span>
          ) : (
            <span
              className={cn(
                'rounded-control px-2 py-0.5 text-[11px] font-medium',
                tool.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
              )}
            >
              {tool.active ? t('settings.toolActive') : t('settings.toolInactive')}
            </span>
          )}
        </div>
        {tool.description ? (
          <p className="text-sm leading-5 text-muted-foreground">{tool.description}</p>
        ) : null}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.toolParameters')}
          </p>
          <span className="text-[11px] text-muted-foreground/70">
            {t('settings.toolParameterCount', { count: fields.length })}
          </span>
        </div>
        {fields.length > 0 ? (
          <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
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
                      'mt-0.5 text-[10px]',
                      field.required ? 'text-primary' : 'text-muted-foreground'
                    )}
                  >
                    {field.required ? t('settings.toolRequired') : t('settings.toolOptional')}
                  </p>
                </div>
                <div className="min-w-0 space-y-1">
                  <code className="block break-words font-mono text-[11px] text-foreground/80">
                    {field.type}
                  </code>
                  {field.description ? (
                    <p className="text-xs leading-4 text-muted-foreground">{field.description}</p>
                  ) : null}
                  {field.allowedValues ? (
                    <p className="text-[11px] text-muted-foreground/70">
                      {t('settings.toolAllowedValues')}:{' '}
                      <code className="font-mono">{field.allowedValues}</code>
                    </p>
                  ) : null}
                  {field.defaultValue !== undefined ? (
                    <p className="text-[11px] text-muted-foreground/70">
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
          <ul className="list-disc space-y-1 pl-5 text-xs leading-4 text-muted-foreground">
            {tool.promptGuidelines.map((guideline, index) => (
              <li key={`${tool.name}:${index}`}>{guideline}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
