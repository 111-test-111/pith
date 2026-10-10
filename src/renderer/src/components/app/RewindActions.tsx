import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AlertTriangle, ArrowLeftFromLine, ChevronDown, Info } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import type { RewindMode } from '../../../../shared/types'

/** One restore action with an explicit mode choice; choosing never executes. */
export function RewindActions({ mode, onModeChange, onRestore, actionLabel, disabled, modeDisabled, conversationUnavailable, fileWarning, information, infoDisabled, actionRef }: {
  mode: RewindMode; onModeChange: (mode: RewindMode) => void; onRestore: () => void
  actionLabel?: string; disabled: boolean; modeDisabled: boolean; conversationUnavailable?: boolean
  fileWarning: boolean; information: ReactNode; infoDisabled: boolean; actionRef: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState<'mode' | 'info' | null>(null)
  const modeRef = useRef<HTMLButtonElement>(null), infoRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if ((open === 'mode' && modeDisabled) || (open === 'info' && infoDisabled)) setOpen(null)
  }, [open, modeDisabled, infoDisabled])
  const close = () => {
    ;(open === 'mode' ? modeRef : infoRef).current?.focus()
    setOpen(null)
  }
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      if (open === 'mode') menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
      else contentRef.current?.focus()
    })
    // The parent modal also owns Escape. A nested popover must dismiss first,
    // including when focus is on its trigger or portalled content.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      ;(open === 'mode' ? modeRef : infoRef).current?.focus()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  return <div className="ml-auto flex shrink-0 items-center gap-1">
    <div className="flex items-center gap-0.5">
      <Button ref={actionRef} data-rewind-restore data-rewind-selected-mode={mode} variant="primary" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" disabled={disabled} aria-label={actionLabel ?? t(`rewind.restoreMode.${mode}`)} onClick={onRestore}>
        <ArrowLeftFromLine aria-hidden="true" className="hidden size-3.5 @min-[500px]:block" />
        {actionLabel ?? <><span className="hidden @min-[500px]:inline">{t(`rewind.restoreMode.${mode}`)}</span><span className="@min-[500px]:hidden">{t(`rewind.shortMode.${mode}`)}</span></>}
      </Button>
      <MorphPopover open={open === 'mode'} onOpenChange={value => setOpen(value ? 'mode' : null)}>
        <MorphPopoverTrigger><Button ref={modeRef} data-rewind-mode-trigger variant="primary" size="icon" className="size-8" disabled={modeDisabled} aria-label={t('rewind.chooseMode')}><ChevronDown aria-hidden="true" className="size-3.5" /></Button></MorphPopoverTrigger>
        <MorphPopoverContent align="end" radius="var(--app-radius-card)" className="w-max max-w-[calc(100vw-4rem)] p-1.5">
          <div ref={menuRef} data-rewind-mode-options className="flex flex-col gap-1" onKeyDown={event => {
            if (event.key === 'Tab') { event.preventDefault(); close(); return }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[index]?.focus()
          }}>
            {(['conversation', 'all', 'files'] as const).filter(value => value !== mode).map(value => <Button key={value} data-rewind-mode={value} variant={fileWarning && value !== 'conversation' ? 'destructive' : 'ghost'} size="sm" className="w-full justify-start gap-3 px-2.5 text-sm font-normal" disabled={conversationUnavailable && value !== 'files'} onClick={() => { onModeChange(value); setOpen(null); actionRef.current?.focus() }}>
              <span className="flex-1 text-left">{t(`rewind.mode.${value}`)}</span>
              {fileWarning && value !== 'conversation' ? <AlertTriangle data-rewind-mode-warning role="img" aria-label={t('rewind.modeConflict')} className="size-4 shrink-0 text-destructive" /> : null}
            </Button>)}
          </div>
        </MorphPopoverContent>
      </MorphPopover>
    </div>
    <MorphPopover open={open === 'info'} onOpenChange={value => setOpen(value ? 'info' : null)}>
      <MorphPopoverTrigger><Button ref={infoRef} data-rewind-info-trigger variant="ghost" size="icon" className="size-8 shrink-0" disabled={infoDisabled} aria-label={t('rewind.backupInfo')}><Info aria-hidden="true" className="size-4" /></Button></MorphPopoverTrigger>
      <MorphPopoverContent align="end" radius="var(--app-radius-card)" className="w-[min(22rem,calc(100vw-4rem))]">
        <div ref={contentRef} tabIndex={0} data-rewind-coverage className="max-h-[min(26rem,calc(100dvh-10rem))] space-y-3 overflow-auto p-4 text-xs text-muted-foreground outline-none" onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); close() } }}>
          <h3 className="text-sm font-semibold text-foreground">{t('rewind.backupInfo')}</h3>
          {information}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  </div>
}
