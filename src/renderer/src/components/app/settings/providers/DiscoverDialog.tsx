import { useEffect, useState } from 'react'
import { AlertCircle, Download, Loader2 } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import type { CustomProviderDTO, DiscoveredModelDTO } from '../../../../../../shared/types'
import type { ModelsConfigMutate } from './use-models-config'

const MAX_SHOWN = 300

/**
 * Fetches the provider's /models endpoint and imports the selected ids as
 * bare `{id, name?}` carriers — the registry/composition layer fills in the
 * wire details, and the model editor can refine any single row afterwards.
 */
export function DiscoverDialog({
  open,
  providerId,
  providerName,
  entry,
  flush,
  mutate,
  onClose
}: {
  open: boolean
  providerId: string
  providerName: string
  entry: CustomProviderDTO | undefined
  flush: () => Promise<void>
  mutate: ModelsConfigMutate
  onClose: () => void
}) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<DiscoveredModelDTO[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setModels(null)
    setSelected(new Set())
    void (async () => {
      try {
        await flush()
        setModels(await window.pi.discoverModels(providerId))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
    // Re-fetch every time the dialog opens, never on config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId])

  if (!open) return null

  const existing = new Set(
    (entry?.models ?? [])
      .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean)
  )
  const shown = (models ?? []).slice(0, MAX_SHOWN)
  const importCount = [...selected].filter((id) => !existing.has(id)).length

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const importSelected = () => {
    if (importCount === 0) return
    mutate(
      (draft) => {
        const provider = draft.providers[providerId] ?? {}
        const models = [...(provider.models ?? [])]
        const known = new Set(
          models.map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
        )
        for (const id of selected) {
          if (known.has(id)) continue
          const found = shown.find((m) => m.id === id)
          models.push(found?.name ? { id, name: found.name } : { id })
        }
        return { ...draft, providers: { ...draft.providers, [providerId]: { ...provider, models } } }
      },
      true
    )
    onClose()
  }

  return (
    <MorphingModal viewId={open ? 'discover' : null} onClose={onClose} placement="center" className="max-w-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            {t('settings.discoverTitle', { name: providerName })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.discoverHint')}</p>
        </div>
        <Download className="size-4 shrink-0 text-muted-foreground" />
      </div>

      {loading ? (
        <div className="mt-8 mb-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.discoverLoading')}
        </div>
      ) : error ? (
        <div className="mt-4 flex items-start gap-1.5 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : models && models.length > 0 ? (
        <div className="mt-3 max-h-72 space-y-0.5 overflow-y-auto pr-1">
          {shown.map((model) => {
            const added = existing.has(model.id)
            return (
              <div
                key={model.id}
                className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 ${
                  added ? 'opacity-50' : 'hover:bg-muted'
                }`}
              >
                <Checkbox
                  checked={selected.has(model.id)}
                  onCheckedChange={() => toggle(model.id)}
                  disabled={added}
                  label={model.name ?? model.id}
                  className="min-w-0 flex-1 [&>span:last-child]:truncate"
                />
                <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                  {added ? t('settings.discoverAlreadyAdded') : model.id}
                </span>
              </div>
            )
          })}
          {models.length > MAX_SHOWN ? (
            <p className="px-2 pt-1 text-[11px] text-muted-foreground">
              {t('settings.discoverCapped', { shown: MAX_SHOWN, total: models.length })}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-6 mb-6 text-center text-sm text-muted-foreground">
          {t('settings.discoverEmpty')}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={importCount === 0} onClick={importSelected}>
          {t('settings.discoverImport', { count: importCount })}
        </Button>
      </div>
    </MorphingModal>
  )
}
