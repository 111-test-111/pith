import { useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { ArrowDown, ArrowUp, Settings2, X } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FileSearchOptions, FileSearchResult } from '@/lib/file-search'

const modes = ['matchCase', 'wholeWord', 'regex'] as const

export function FileFindBar({ inputRef, query, options, result, current, searching, onQuery, onOptions, onMove, onClose }: {
  inputRef: RefObject<HTMLInputElement | null>; query: string; options: FileSearchOptions
  result: FileSearchResult; current: number; searching: boolean
  onQuery: (value: string) => void; onOptions: (value: FileSearchOptions) => void; onMove: (direction: number) => void; onClose: () => void
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState(false)
  const settingsRef = useRef<HTMLButtonElement>(null)
  const error = result.error ? t(`files.searchError.${result.error}`) : undefined
  const symbol = (mode: typeof modes[number]) => <span aria-hidden className={mode === 'wholeWord' ? 'underline underline-offset-2' : undefined}>{t(`files.findSymbol.${mode}`)}</span>
  const toggle = (mode: typeof modes[number]) => onOptions({ ...options, [mode]: !options[mode] })
  const controls = modes.map(mode => <Tooltip key={mode} content={t(`files.${mode}`)}><Button variant="ghost" size="icon" className={cn('size-5 rounded-detail text-caption font-medium', options[mode] && 'bg-muted text-primary')} aria-label={t(`files.${mode}`)} aria-pressed={options[mode]} onClick={() => toggle(mode)}>{symbol(mode)}</Button></Tooltip>)
  const count = t('files.matches', { current: result.matches.length ? current + 1 : 0, total: `${result.matches.length}${result.limited ? '+' : ''}` })
  return <div data-file-find className="@container/find flex min-h-9 shrink-0 items-center gap-0.5 border-b border-border/40 px-1 py-0.5" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (settings) { setSettings(false); settingsRef.current?.focus({ preventScroll: true }) } else onClose() }
    if (event.key === 'Enter' && event.target === inputRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); onMove(event.shiftKey ? -1 : 1) }
  }}>
    <Input ref={inputRef} value={query} onChange={onQuery} aria-label={t('files.find')} placeholder={t('files.findPlaceholder')} error={!!error} spellCheck={false} autoComplete="off" className="min-w-0 flex-1" classNames={{ input: '@min-[360px]/find:pr-[4.25rem]', rightIcon: 'right-1 [&_button]:size-5' }}
      rightIcon={<div className="hidden items-center gap-0.5 @min-[360px]/find:flex">{controls}</div>} />
    <div className="shrink-0 @min-[360px]/find:hidden">
      <MorphPopover open={settings} onOpenChange={setSettings}>
        <MorphPopoverTrigger><Button ref={settingsRef} size="icon" variant="ghost" className={cn('size-5', modes.some(mode => options[mode]) && 'text-primary')} aria-label={t('files.findOptions')}><Settings2 aria-hidden className="size-3" /></Button></MorphPopoverTrigger>
        <MorphPopoverContent align="end" radius="var(--app-radius-card)" className="w-44 bg-card p-1">
          {modes.map(mode => <Button key={mode} variant="ghost" size="sm" className={cn('h-8 w-full justify-start gap-2 text-xs font-normal', options[mode] && 'bg-muted text-primary')} aria-pressed={options[mode]} onClick={() => toggle(mode)}><span className="w-5 text-center">{symbol(mode)}</span>{t(`files.${mode}`)}</Button>)}
        </MorphPopoverContent>
      </MorphPopover>
    </div>
    <Tooltip content={error ?? count}><span data-file-find-count role="status" aria-live="polite" className={cn('block w-16 shrink-0 truncate whitespace-nowrap px-1 text-center text-micro tabular-nums text-muted-foreground', error && 'text-destructive')}>
      {error ? <span aria-label={error}>!</span> : count}
    </span></Tooltip>
    {([{ key: 'previousMatch', icon: ArrowUp, move: -1 }, { key: 'nextMatch', icon: ArrowDown, move: 1 }] as const).map(({ key, icon: Icon, move }) => <Tooltip key={key} content={t(`files.${key}`)}><Button variant="ghost" size="icon" className="size-5" disabled={searching || !result.matches.length} aria-label={t(`files.${key}`)} onClick={() => onMove(move)}><Icon aria-hidden className="size-3" /></Button></Tooltip>)}
    <Tooltip content={t('files.closeFind')}><Button variant="ghost" size="icon" className="size-5" aria-label={t('files.closeFind')} onClick={onClose}><X aria-hidden className="size-3" /></Button></Tooltip>
  </div>
}
