import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { ShieldCheck } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useToast } from './ToastProvider'
import { SANDBOX_MODES, type SandboxMode, type SandboxStatusDTO, type SessionSnapshotDTO } from '../../../../shared/types'
import type { MessageKey } from '@/i18n/locales/en'

const MODE_LABEL: Record<SandboxMode, MessageKey> = {
  'read-only': 'sandbox.readOnly',
  'workspace-write': 'sandbox.workspaceWrite',
  'danger-full-access': 'sandbox.fullAccess'
}

const MODE_DESCRIPTION: Record<SandboxMode, MessageKey> = {
  'read-only': 'sandbox.readOnlyDesc',
  'workspace-write': 'sandbox.workspaceWriteDesc',
  'danger-full-access': 'sandbox.fullAccessDesc'
}

/**
 * The session's DSH file-sandbox mode, at the bottom of the composer next to the
 * model picker.
 *
 * Switching records the mode on the session's branch and returns the refreshed
 * snapshot. The tools read the live value, so the change applies from the next
 * tool call onward — which includes a steered turn that is already running.
 */
export function SandboxModePicker({
  mode,
  status,
  sessionPath,
  disabled,
  onSnapshot
}: {
  mode: SandboxMode
  status: SandboxStatusDTO | null
  sessionPath: string | null
  disabled?: boolean
  onSnapshot: (snapshot: SessionSnapshotDTO) => void
}) {
  const { t } = useI18n()
  const toast = useToast()

  const switchMode = (next: string) => {
    if (!sessionPath || next === mode) return
    void window.pi
      .setSessionSandboxMode(sessionPath, next as SandboxMode)
      .then(onSnapshot, () => toast.error({ title: t('sandbox.saveFailed') }))
  }

  // Only a mode that can actually be enforced is worth offering as safe; the
  // status line stays in Settings, where there is room to explain the host.
  const unenforceable = status?.support === 'dependencies-missing'

  return (
    <Select
      value={mode}
      onValueChange={switchMode}
      disabled={disabled || !sessionPath}
      className="w-auto"
    >
      <SelectTrigger
        aria-label={t('sandbox.modeLabel')}
        className="h-8 w-auto gap-1.5 rounded-control border-0 bg-transparent px-2.5 text-xs hover:bg-muted"
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <ShieldCheck
            aria-hidden="true"
            className={unenforceable ? 'size-3.5 shrink-0 text-destructive' : 'size-3.5 shrink-0'}
          />
          <span className="max-w-44 truncate">{t(MODE_LABEL[mode])}</span>
        </span>
      </SelectTrigger>
      <SelectContent className="left-0 right-auto w-72">
        {SANDBOX_MODES.map((option) => (
          <SelectItem key={option} value={option} className="py-1.5">
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{t(MODE_LABEL[option])}</span>
              <span className="text-[10px] leading-4 text-muted-foreground">
                {t(MODE_DESCRIPTION[option])}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
