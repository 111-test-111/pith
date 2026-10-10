import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { FORM_FIELD_HEADING, FORM_INPUT_LABEL, FORM_PANEL_TITLE } from '@/lib/form-standard'
import { FadeScroll } from '../../FadeScroll'

// Provider settings use compact interface text while retaining the shared form geometry.
export const PROVIDER_INPUT_CLASS_NAMES = {
  ...FORM_INPUT_LABEL,
  label: cn(FORM_INPUT_LABEL.label, 'text-xs')
} as const
export const PROVIDER_FIELD_HEADING = cn(FORM_FIELD_HEADING, 'text-xs')
export const PROVIDER_CHOICE_TEXT = '[&>span]:text-xs'

/** App compositions: the same section/card rhythm throughout provider settings. */
export function ProviderPanel({
  title, description, actions, children, className
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? <p className="mt-1 text-caption leading-ui text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function ProviderCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-w-0 rounded-item border border-border/70 bg-card', className)}>{children}</div>
}

export function ProviderNotice({
  children, tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'error'
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-control px-3 py-2.5 text-xs leading-ui',
        tone === 'error' ? 'bg-destructive/10 text-destructive'
          : tone === 'success' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-muted/60 text-muted-foreground'
      )}
    >
      {tone === 'error' ? <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        : tone === 'success' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : null}
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  )
}

/** One beUI dialog frame; its body scrolls only when the viewport needs it. */
export function ProviderDialog({
  open, onClose, title, description, children, footer, suspended = false,
  initialFocusRef, className, busy = false, toolbar
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  toolbar?: ReactNode
  suspended?: boolean
  busy?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}) {
  const { t } = useI18n()
  const descriptionId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // A stable context callback keeps typing from re-running beUI's initial focus.
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) closeRef.current()
  }, [])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open])

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      <CenterMorphModalContent
        ariaLabel={title}
        ariaDescribedBy={description ? descriptionId : undefined}
        closeButtonLabel={t('common.close')}
        suspended={suspended}
        dismissible={!busy}
        showCloseButton={!busy}
        initialFocusRef={initialFocusRef}
        className={cn('flex max-h-[calc(100dvh-4rem)] max-w-xl flex-col text-xs', className)}
      >
        <div className="shrink-0 border-b border-border/60 px-5 py-4 pr-16">
          <h2 className={FORM_PANEL_TITLE}>{title}</h2>
          {description ? <div id={descriptionId} className="mt-1 text-caption leading-ui text-muted-foreground">{description}</div> : null}
        </div>
        {toolbar ? <div className="shrink-0 border-b border-border/60 px-5 py-3">{toolbar}</div> : null}
        <FadeScroll className="min-h-0 px-5 py-4">{children}</FadeScroll>
        {footer ? <div className="shrink-0 border-t border-border/60 px-5 py-3">{footer}</div> : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}
