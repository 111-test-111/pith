import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { AlertTriangle, Eye, FilePen, type IconComponent } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useToast } from './ToastProvider'
import { cn } from '@/lib/utils'
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

/** One glyph per mode: look, write here, run unconfined. */
const MODE_ICON: Record<SandboxMode, IconComponent> = {
  'read-only': Eye,
  'workspace-write': FilePen,
  'danger-full-access': AlertTriangle
}

/** The one mode that runs unconfined, and so wears the warning colour. */
const FULL_ACCESS: SandboxMode = 'danger-full-access'
const WARNING_TONE = 'text-amber-600 dark:text-amber-400'

/**
 * Full access is the mode that runs on the host, so its glyph — in the trigger
 * and in the list — keeps the warning tone. A host with no runner refuses the
 * two confined modes instead, which is what their destructive tint says.
 */
function modeTone(mode: SandboxMode, unenforceable: boolean): string {
  if (mode === FULL_ACCESS) return WARNING_TONE
  return unenforceable ? 'text-destructive' : ''
}

/**
 * The session's DSH file-sandbox mode, in the composer's bottom-right cluster
 * beside the context ring — the permission the next submitted turn runs under.
 *
 * A dropdown, but every entry leads with a glyph of its own: the eye, the file
 * and pen, the warning triangle. The trigger shows the selected mode's glyph so
 * the current permission is readable without opening the list, and the one mode
 * that runs unconfined carries the warning colour everywhere.
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
  planRestricted,
  onSnapshot,
  onModeChange,
  portal = false,
  textClassName = 'text-xs',
  inheritLabel
}: {
  mode: SandboxMode | null
  status: SandboxStatusDTO | null
  sessionPath: string | null
  disabled?: boolean
  planRestricted?: boolean
  onSnapshot?: (snapshot: SessionSnapshotDTO) => void
  /** Draft mode for the scheduled-task editor; no session mutation. */
  onModeChange?: (mode: SandboxMode | null) => void
  /** Keep this shared picker visible outside a modal's clipped content. */
  portal?: boolean
  /** Trigger type scale. The composer keeps its 12px control type; the
   * scheduled-task form passes the form's own scale (14px). */
  textClassName?: string
  /** Scheduled tasks can reset a saved override to the app default. */
  inheritLabel?: string
}) {
  const { t } = useI18n()
  const toast = useToast()

  const switchMode = (next: string) => {
    if (onModeChange) {
      onModeChange(next === '__inherit__' ? null : next as SandboxMode)
      return
    }
    if (!sessionPath || next === mode) return
    void window.pi
      .setSessionSandboxMode(sessionPath, next as SandboxMode)
      .then((snapshot) => onSnapshot?.(snapshot), () => toast.error({ title: t('sandbox.saveFailed') }))
  }

  // Only a mode that can actually be enforced is worth offering as safe; the
  // status line stays in Settings, where there is room to explain the host.
  const unenforceable = status?.support === 'dependencies-missing'
  const CurrentIcon = mode ? MODE_ICON[mode] : null

  return (
    <Select
      value={mode ?? '__inherit__'}
      onValueChange={switchMode}
      disabled={disabled || planRestricted || (!sessionPath && !onModeChange)}
      className="w-auto"
    >
      <SelectTrigger
        aria-label={t('sandbox.modeLabel')}
        className={cn("h-8 w-auto gap-1.5 rounded-control border-0 bg-transparent px-2.5 hover:bg-muted", textClassName)}
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {mode && CurrentIcon ? <CurrentIcon
            aria-hidden="true"
            data-sandbox-mode-icon={mode}
            className={cn('size-3.5 shrink-0', modeTone(mode, unenforceable))}
          /> : null}
          <span className={cn('max-w-44 truncate', mode === FULL_ACCESS && WARNING_TONE)}>
            {mode ? t(MODE_LABEL[mode]) : inheritLabel ?? t('sandbox.modeLabel')}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent className="right-0 left-auto w-72" portal={portal} portalAlign="end" portalWidth={288}>
        {onModeChange && inheritLabel ? <SelectItem value="__inherit__" className="py-1.5">{inheritLabel}</SelectItem> : null}
        {SANDBOX_MODES.map((option) => {
          const OptionIcon = MODE_ICON[option]
          return (
            <SelectItem key={option} value={option} className="py-1.5">
              <span
                data-sandbox-mode-option={option}
                className="flex min-w-0 items-start gap-2"
              >
                <OptionIcon
                  aria-hidden="true"
                  className={cn('mt-0.5 size-4 shrink-0', modeTone(option, unenforceable))}
                />
                <span className="flex min-w-0 flex-col">
                  <span className={cn('truncate', option === FULL_ACCESS && WARNING_TONE)}>
                    {t(MODE_LABEL[option])}
                  </span>
                  <span className="text-micro leading-ui-tight text-muted-foreground">
                    {t(MODE_DESCRIPTION[option])}
                  </span>
                </span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
