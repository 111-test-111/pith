import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from '@/lib/icons'
import { Input } from '@/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import type { ProviderDTO } from '../../../../../../shared/types'
import { FadeScroll } from '../../FadeScroll'
import { ProviderIcon } from '../../ProviderIcon'
import { PROVIDER_INPUT_CLASS_NAMES } from './ProviderUi'

const CUSTOM_PROVIDER = '$custom'

/** Searchable provider chooser, followed by the same connection editor for every provider. */
export function AddProviderMenu({
  providers, onSelect, onCustom
}: {
  providers: ProviderDTO[]
  onSelect: (providerId: string) => void
  onCustom: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const keyword = query.trim().toLocaleLowerCase()
  const shown = providers.filter(provider =>
    !keyword || (provider.name + ' ' + provider.id).toLocaleLowerCase().includes(keyword)
  )

  useEffect(() => {
    if (!open) return
    // The portalled select becomes visible after its placement is measured.
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Select value="" open={open} onOpenChange={next => { if (next) setQuery(''); setOpen(next) }}
      onValueChange={value => value === CUSTOM_PROVIDER ? onCustom() : onSelect(value)}>
      <SelectTrigger aria-label={t('settings.addProvider')} className="gap-2 border-border/70 bg-card py-1.5 text-xs">
        <span className="flex items-center gap-1.5"><Plus className="size-3.5" />{t('settings.addProvider')}</span>
      </SelectTrigger>
      <SelectContent portal portalAlign="end" portalWidth={320}>
        <div className="border-b border-border/60 px-2 pb-2 pt-1">
          <Input ref={searchRef} value={query} onChange={setQuery}
            classNames={PROVIDER_INPUT_CLASS_NAMES}
            placeholder={t('settings.addProviderSearch')} aria-label={t('settings.addProviderSearch')}
            leftIcon={<Search />} />
        </div>
        <FadeScroll className="max-h-[min(20rem,calc(100dvh-12rem))] p-1">
          {shown.map(provider => (
            <SelectItem key={provider.id} value={provider.id} className="text-xs">
              <span data-provider-option={provider.id} className="flex min-w-0 flex-1 items-center gap-2">
                <ProviderIcon providerId={provider.id} name={provider.name} size={18} />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{provider.name}</span>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {provider.authTypes.map(kind => t(kind === 'oauth' ? 'settings.oauth' : 'settings.apiKey')).join(' · ')}
                </span>
              </span>
            </SelectItem>
          ))}
          {shown.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t(providers.length === 0 ? 'settings.allProvidersConfigured' : 'settings.addProviderEmpty')}
            </p>
          ) : null}
        </FadeScroll>
        <div className="border-t border-border/60 pt-1">
          <SelectItem value={CUSTOM_PROVIDER} className="text-xs">
            <span className="flex items-center gap-2"><Plus className="size-3.5" />{t('settings.addCustomProvider')}</span>
          </SelectItem>
        </div>
      </SelectContent>
    </Select>
  )
}
