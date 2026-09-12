import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Copy, Loader2, Search } from 'lucide-react'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import type { ModelConfigSourceDTO } from '../../../../../../shared/types'
import { ProviderIcon } from '../../ProviderIcon'

const SHOWN_LIMIT = 300

/**
 * Source picker behind the model editor's "copy from model": the composed
 * models of every configured provider, searchable across provider/id/name.
 * Clicking a row replicates its parameter config onto the edited model.
 */
export function CopyConfigDialog({
  open,
  providerId,
  excludeModelId,
  onPick,
  onClose
}: {
  open: boolean
  /** Provider of the edited model — its group is listed first. */
  providerId: string
  /** The edited model's id, hidden within its own provider's group. */
  excludeModelId?: string
  onPick: (source: ModelConfigSourceDTO) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelConfigSourceDTO[] | null>(null)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setModels(null)
    setQuery('')
    void (async () => {
      try {
        const sources = await window.pi.configuredModels()
        setModels(sources)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  useEffect(() => {
    if (open && models) setTimeout(() => searchRef.current?.focus(), 60)
  }, [open, models])

  const matched = useMemo(() => {
    if (!models) return []
    const normalized = query.trim().toLocaleLowerCase()
    return models.filter(
      (model) =>
        !(model.providerId === providerId && model.id === excludeModelId) &&
        (!normalized ||
          model.id.toLocaleLowerCase().includes(normalized) ||
          model.name?.toLocaleLowerCase().includes(normalized) ||
          model.providerName.toLocaleLowerCase().includes(normalized) ||
          model.providerId.toLocaleLowerCase().includes(normalized))
    )
  }, [models, query, providerId, excludeModelId])

  // The edited model's own provider leads; the rest keep provider-name order.
  const ordered = useMemo(
    () => [
      ...matched.filter((model) => model.providerId === providerId),
      ...matched.filter((model) => model.providerId !== providerId)
    ],
    [matched, providerId]
  )
  const shown = ordered.slice(0, SHOWN_LIMIT)

  return (
    <MorphingModal viewId={open ? 'copy-config' : null} onClose={onClose} placement="center" className="max-w-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{t('settings.copyFromModel')}</h2>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{t('settings.copyFromModelHint')}</p>
        </div>
        <Copy className="size-4 shrink-0 text-muted-foreground" />
      </div>

      {models && models.length > 0 ? (
        <div className="mt-3">
          <Input
            ref={searchRef}
            value={query}
            onChange={setQuery}
            placeholder={t('settings.copySearchPlaceholder', { count: models.length })}
            aria-label={t('settings.copyFromModel')}
            leftIcon={<Search />}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="my-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.loadingModels')}
        </div>
      ) : error ? (
        <div className="mt-4 flex items-start gap-1.5 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {t('settings.copyLoadFailed')} · {error}
          </span>
        </div>
      ) : shown.length === 0 ? (
        <p className="my-8 text-center text-sm text-muted-foreground">{t('settings.copyNoMatches')}</p>
      ) : (
        <div className="mt-3 max-h-72 overflow-y-auto pr-1">
          {shown.map((model, index) => {
            const newGroup = index === 0 || shown[index - 1].providerId !== model.providerId
            return (
              <div key={`${model.providerId}/${model.id}`}>
                {newGroup ? (
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <ProviderIcon providerId={model.providerId} name={model.providerName} size={12} />
                    <span className="truncate">{model.providerName}</span>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => onPick(model)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{model.name || model.id}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{model.id}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {model.contextWindow
                      ? t('model.contextK', { k: Math.round(model.contextWindow / 1000) })
                      : ''}
                    {model.cost ? (
                      <span className="ml-2 font-mono">
                        ${model.cost.input}/${model.cost.output}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            )
          })}
          {matched.length > shown.length ? (
            <p className="px-2 pt-1 text-[11px] text-muted-foreground">
              {t('settings.discoverCapped', { shown: shown.length, total: matched.length })}
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </MorphingModal>
  )
}
