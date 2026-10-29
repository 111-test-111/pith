import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, Search } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import type { CustomProviderDTO, DiscoveredModelDTO } from '../../../../../../shared/types'
import type { ModelsConfigMutate } from './use-models-config'
import { ProviderDialog, ProviderNotice, PROVIDER_INPUT_CLASS_NAMES } from './ProviderUi'

const MAX_SHOWN = 300

/** A visible searchable selection list; selected ids survive changing the search. */
export function DiscoverDialog({
  open, providerId, providerName, entry, flush, mutate, onClose
}: {
  open: boolean
  providerId: string
  providerName: string
  entry: CustomProviderDTO | undefined
  flush: () => Promise<boolean>
  mutate: ModelsConfigMutate
  onClose: () => void
}) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [models, setModels] = useState<DiscoveredModelDTO[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const entryRef = useRef(entry)
  entryRef.current = entry
  const epochRef = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const epoch = ++epochRef.current
    setLoading(true)
    setError(null)
    setSaveBlocked(false)
    try {
      if (!await flush()) { if (epoch === epochRef.current) setSaveBlocked(true); return }
      const fetched = await window.pi.discoverModels(providerId)
      if (epoch === epochRef.current) {
        // A provider may repeat an id; one id must correspond to one selectable model.
        setModels([...new Map(fetched.map(model => [model.id, model])).values()])
      }
    } catch (err) {
      if (epoch === epochRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (epoch === epochRef.current) setLoading(false)
    }
  }, [flush, providerId])

  useEffect(() => {
    if (!open) return
    setModels([])
    setSelected([])
    setQuery('')
    setExisting(new Set((entryRef.current?.models ?? []).map(model => model.id?.trim()).filter(Boolean)))
    void load()
    return () => { epochRef.current++ }
  }, [open, load])

  const keyword = query.trim().toLocaleLowerCase()
  const matched = models.filter(model => !keyword || (model.id + ' ' + (model.name ?? '')).toLocaleLowerCase().includes(keyword))
  const shown = matched.slice(0, MAX_SHOWN)
  const selectable = shown.filter(model => !existing.has(model.id)).map(model => model.id)
  const selectedSet = new Set(selected)
  const importCount = selected.filter(id => !existing.has(id)).length
  const allShownSelected = selectable.length > 0 && selectable.every(id => selectedSet.has(id))
  const toggle = (id: string, checked: boolean) =>
    setSelected(current => checked ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id))

  const importSelected = async () => {
    if (importCount === 0 || importing) return
    setImporting(true)
    setSaveBlocked(false)
    mutate(draft => {
      const provider = draft.providers[providerId] ?? {}
      const carriers = [...(provider.models ?? [])]
      const known = new Set(carriers.map(model => model.id?.trim()))
      for (const id of selected) {
        if (known.has(id)) continue
        const found = models.find(model => model.id === id)
        carriers.push(found?.name ? { id, name: found.name } : { id })
        known.add(id)
      }
      return { ...draft, providers: { ...draft.providers, [providerId]: { ...provider, models: carriers } } }
    })
    if (await flush()) onClose()
    else setSaveBlocked(true)
    setImporting(false)
  }

  return (
    <ProviderDialog open={open} onClose={onClose}
      busy={importing}
      title={t('settings.discoverTitle', { name: providerName })}
      description={t('settings.discoverHint')}
      initialFocusRef={searchRef}
      toolbar={<div className="space-y-2">
        <Input ref={searchRef} value={query} onChange={setQuery} leftIcon={<Search />}
          placeholder={t('settings.discoverSearch')} aria-label={t('settings.discoverSearch')} classNames={PROVIDER_INPUT_CLASS_NAMES} />
        {models.length > 0 ? <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t('settings.providerModelCount', { count: matched.length })}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={selectable.length === 0 || importing} onClick={() => setSelected(current => allShownSelected
              ? current.filter(id => !selectable.includes(id)) : [...new Set([...current, ...selectable])])}>
              {t(allShownSelected ? 'settings.providerDeselectResults' : 'settings.providerSelectResults')}
            </Button>
            <Button variant="ghost" size="sm" disabled={selected.length === 0 || importing} onClick={() => setSelected([])}>{t('settings.providerClearSelection')}</Button>
          </div>
        </div> : null}
      </div>}
      footer={<div className="flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="text-xs text-muted-foreground">{t('settings.providerSelectedCount', { count: importCount })}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={importing} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={importCount === 0 || importing || loading} onClick={() => void importSelected()}>
            {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t('settings.discoverImport', { count: importCount })}
          </Button>
        </div>
      </div>}
    >
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{t('settings.discoverLoading')}
          </div>
        ) : error || saveBlocked ? (
          <ProviderNotice tone="error">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{error ?? t('settings.providerSaveBeforeContinue')}</span>
              <Button variant="ghost" size="sm" disabled={importing} onClick={() => void (models.length ? importSelected() : load())}>{t('settings.providerRetry')}</Button>
            </div>
          </ProviderNotice>
        ) : null}
        {!loading && models.length > 0 ? <>
          <div role="group" aria-label={t('settings.discoverList')} className="divide-y divide-border/60 rounded-item border border-border/60 p-1">
            {shown.map(model => {
              const added = existing.has(model.id)
              return (
                <div key={model.id} data-discovered-model={model.id} className="flex min-w-0 items-center gap-3 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Checkbox checked={added || selectedSet.has(model.id)} disabled={added || importing}
                      label={model.name ?? model.id}
                      className="w-full min-w-0 [&>span]:truncate [&>span]:text-xs"
                      aria-label={t('settings.providerSelectModel', { name: model.name ?? model.id })}
                      onCheckedChange={checked => toggle(model.id, checked)} />
                    {model.name && model.name !== model.id ? <p className="mt-0.5 truncate pl-6.5 font-mono text-caption text-muted-foreground">{model.id}</p> : null}
                  </div>
                  {added ? <span className="shrink-0 text-caption text-muted-foreground">{t('settings.discoverAlreadyAdded')}</span> : null}
                </div>
              )
            })}
            {shown.length === 0 ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('settings.discoverNoMatch')}</p> : null}
          </div>
          {matched.length > MAX_SHOWN ? <p className="text-caption text-muted-foreground">{t('settings.discoverCapped', { shown: MAX_SHOWN, total: matched.length })}</p> : null}
        </> : !loading && !error && !saveBlocked ? <p className="py-8 text-center text-xs text-muted-foreground">{t('settings.discoverEmpty')}</p> : null}
      </div>
    </ProviderDialog>
  )
}
