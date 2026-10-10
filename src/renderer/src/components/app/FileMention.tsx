import { useEffect, useRef } from 'react'
import { FileText, Image as ImageIcon, Search } from '@/lib/icons'
import type { FileHitDTO } from '../../../../shared/types'
import { formatBytes } from '@/lib/format'
import { useI18n } from '@/i18n'

export interface MentionState {
  query: string
  /** Index of the `@` in the composer value. */
  triggerIndex: number
}

interface FileMentionProps {
  hits: FileHitDTO[]
  loading: boolean
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (hit: FileHitDTO) => void
  onClose: () => void
}

/** Floating file picker triggered by `@` in the composer. */
export function FileMention({
  hits,
  loading,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onClose
}: FileMentionProps) {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!listRef.current?.parentElement?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-md overflow-hidden rounded-card border border-border bg-popover shadow-overlay">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <Search className="size-3.5" />
        {loading ? t('mention.searching') : t('mention.filesCount', { count: hits.length })}
        <span className="ml-auto">{t('mention.hints')}</span>
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {hits.length === 0 && !loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('mention.noMatches')}</p>
        ) : null}
        {hits.map((hit, index) => (
          <button
            key={hit.path}
            type="button"
            onMouseEnter={() => onActiveIndexChange(index)}
            onClick={() => onSelect(hit)}
            className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
              index === activeIndex ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted/60'
            }`}
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              {hit.kind === 'image' ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{hit.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {hit.dir ? `${hit.dir}/` : ''} · {formatBytes(hit.size)}
              </span>
            </span>
            {hit.kind === 'image' ? (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                {t('mention.image')}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
