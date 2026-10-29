import { AlertTriangle } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'

/**
 * Destructive-action confirmation on beUI's MorphingModal. Two-step safety:
 * the caller opens it only from an explicit user action, and nothing runs
 * until Confirm is pressed.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <MorphingModal
      viewId={open ? 'confirm' : null}
      onClose={onClose}
      placement="center"
      className="max-w-sm"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-4.5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm leading-ui text-muted-foreground">{message}</p>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="hover:bg-destructive hover:text-white"
          onClick={() => {
            onClose()
            onConfirm()
          }}
        >
          {confirmLabel ?? t('common.delete')}
        </Button>
      </div>
    </MorphingModal>
  )
}
